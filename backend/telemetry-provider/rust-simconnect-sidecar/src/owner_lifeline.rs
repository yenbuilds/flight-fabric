//! In-process lifetime coupling between the sidecar and the process that owns it.
//!
//! Every non-probe sidecar mode receives an exact owner PID. A dedicated thread
//! waits on that Windows process handle and terminates this process immediately
//! when the owner exits, even if the main thread is blocked inside SimConnect.
//! This is intentionally smaller than `process_guardian.rs`, whose separate
//! process mode watches and can terminate a different target process.

use std::ffi::c_void;
use std::ptr;
use std::thread;

type Bool = i32;
type Dword = u32;
type Handle = *mut c_void;

const SYNCHRONIZE: Dword = 0x0010_0000;
const INFINITE: Dword = 0xffff_ffff;
const WAIT_OBJECT_0: Dword = 0x0000_0000;
const WAIT_TIMEOUT: Dword = 0x0000_0102;
const WAIT_FAILED: Dword = 0xffff_ffff;

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
    fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
    fn CloseHandle(handle: Handle) -> Bool;
}

#[derive(Debug, PartialEq, Eq)]
enum WaitOutcome {
    Signaled,
    TimedOut,
}

// The raw handle is wrapped so every startup/error path closes it via `Drop`.
struct OwnerProcessHandle {
    handle: Handle,
    process_id: Dword,
}

// A process HANDLE can be waited on from any thread. This wrapper exclusively owns the handle
// and closes it when dropped.
unsafe impl Send for OwnerProcessHandle {}

impl OwnerProcessHandle {
    fn open(process_id: Dword) -> Result<Self, String> {
        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, process_id) };
        if handle.is_null() {
            return Err(format!(
                "could not open owner process PID {process_id} for synchronization: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self { handle, process_id })
    }

    fn wait(&self, milliseconds: Dword) -> Result<WaitOutcome, String> {
        match unsafe { WaitForSingleObject(self.handle, milliseconds) } {
            WAIT_OBJECT_0 => Ok(WaitOutcome::Signaled),
            WAIT_TIMEOUT => Ok(WaitOutcome::TimedOut),
            WAIT_FAILED => Err(format!(
                "waiting for owner process PID {} failed: {}",
                self.process_id,
                std::io::Error::last_os_error()
            )),
            status => Err(format!(
                "waiting for owner process PID {} returned unexpected status 0x{status:08x}",
                self.process_id
            )),
        }
    }
}

impl Drop for OwnerProcessHandle {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            let _ = unsafe { CloseHandle(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}

// Starting the watcher transfers the owned handle to the named background
// thread. A broken infinite wait fails closed instead of leaving an orphan.
pub(crate) fn start(process_id: Dword) -> Result<(), String> {
    let owner = OwnerProcessHandle::open(process_id)?;
    thread::Builder::new()
        .name("ff-owner-lifeline".to_string())
        .spawn(move || match owner.wait(INFINITE) {
            Ok(WaitOutcome::Signaled) => {
                // Terminate the entire sidecar even if its main thread is blocked in SimConnect.
                std::process::exit(0);
            }
            Ok(WaitOutcome::TimedOut) => {
                // INFINITE cannot time out. Treat any unexpected wait result as a broken
                // lifeline and fail closed.
                std::process::exit(3);
            }
            Err(error) => {
                eprintln!("[ff-rust-simconnect-sidecar] owner lifeline failed: {error}");
                std::process::exit(3);
            }
        })
        .map(|_| ())
        .map_err(|error| {
            format!("could not start owner-process watcher for PID {process_id}: {error}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    const CREATE_NO_WINDOW: Dword = 0x0800_0000;

    #[test]
    fn opened_owner_handle_signals_after_that_exact_process_exits() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("owner test process should start");
        let owner = OwnerProcessHandle::open(child.id())
            .expect("owner process should be openable with SYNCHRONIZE access");

        let initial = owner.wait(0);
        if initial != Ok(WaitOutcome::TimedOut) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("live owner process handle should not be signaled: {initial:?}");
        }

        child.kill().expect("owner test process should terminate");
        child.wait().expect("owner test process should be reaped");
        assert_eq!(
            owner.wait(Duration::from_secs(2).as_millis() as Dword),
            Ok(WaitOutcome::Signaled)
        );
    }
}
