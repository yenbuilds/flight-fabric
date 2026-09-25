//! A blocked controller must never block the simulator/recovery dispatch loop.
use serde_json::Value;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const OUTPUT_QUEUE: usize = 8;
const MAX_MESSAGE_BYTES: usize = 4096;

pub(crate) struct ReplayOutput {
    sender: SyncSender<Vec<u8>>,
    failed: Arc<AtomicBool>,
    pending: Arc<AtomicUsize>,
}

impl ReplayOutput {
    pub fn stdout() -> Self {
        Self::with_writer(io::stdout())
    }

    fn with_writer(mut writer: impl Write + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_QUEUE);
        let failed = Arc::new(AtomicBool::new(false));
        let pending = Arc::new(AtomicUsize::new(0));
        let writer_failed = failed.clone();
        let writer_pending = pending.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = receiver.recv() {
                let result = writer.write_all(&bytes).and_then(|_| writer.flush());
                writer_pending.fetch_sub(1, Ordering::AcqRel);
                if result.is_err() {
                    writer_failed.store(true, Ordering::Release);
                    break;
                }
            }
        });
        Self { sender, failed, pending }
    }

    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    pub fn send(&self, value: Value) {
        if self.failed() { return; }
        let Ok(mut bytes) = serde_json::to_vec(&value) else {
            self.failed.store(true, Ordering::Release);
            return;
        };
        if bytes.len() >= MAX_MESSAGE_BYTES {
            self.failed.store(true, Ordering::Release);
            return;
        }
        bytes.push(b'\n');
        self.pending.fetch_add(1, Ordering::AcqRel);
        if self.sender.try_send(bytes).is_err() {
            self.pending.fetch_sub(1, Ordering::AcqRel);
            self.failed.store(true, Ordering::Release);
        }
    }
}

impl Drop for ReplayOutput {
    fn drop(&mut self) {
        // Give final status a bounded chance to drain after simulator work has
        // finished. Never join a writer potentially stuck in an OS pipe write.
        let deadline = Instant::now() + Duration::from_millis(100);
        while !self.failed() && self.pending.load(Ordering::Acquire) != 0
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct StalledWriter {
        entered: SyncSender<()>,
        release: mpsc::Receiver<()>,
    }
    impl Write for StalledWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let _ = self.entered.send(());
            let _ = self.release.recv();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }

    #[test]
    fn stalled_controller_cannot_block_dispatch_or_grow_output_without_bound() {
        let (entered, observed) = mpsc::sync_channel(1);
        let (release, wait) = mpsc::channel();
        let output = ReplayOutput::with_writer(StalledWriter { entered, release: wait });
        output.send(json!({"state":"playing"}));
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..OUTPUT_QUEUE { output.send(json!({"state":"playing"})); }
        assert!(!output.failed());
        output.send(json!({"state":"playing"}));
        assert!(output.failed());
        assert_eq!(output.pending.load(Ordering::Acquire), OUTPUT_QUEUE + 1);
        output.send(json!({"state":"ignored"}));
        assert_eq!(output.pending.load(Ordering::Acquire), OUTPUT_QUEUE + 1);
        drop(observed);
        drop(release);
    }

    #[test]
    fn broken_output_fails_closed_and_final_status_drains_on_clean_exit() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed controller"))
            }
            fn flush(&mut self) -> io::Result<()> { Ok(()) }
        }
        let output = ReplayOutput::with_writer(Broken);
        output.send(json!({"state":"playing"}));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !output.failed() && Instant::now() < deadline { std::thread::yield_now(); }
        assert!(output.failed());

        #[derive(Clone)]
        struct Capture(Arc<Mutex<Vec<u8>>>);
        impl Write for Capture {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> { Ok(()) }
        }
        let captured = Capture(Arc::new(Mutex::new(Vec::new())));
        let output = ReplayOutput::with_writer(captured.clone());
        output.send(json!({"state":"done"}));
        drop(output);
        assert_eq!(*captured.0.lock().unwrap(), b"{\"state\":\"done\"}\n");
    }
}
