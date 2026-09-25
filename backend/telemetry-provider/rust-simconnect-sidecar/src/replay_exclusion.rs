//! A shared lease for live bridges, exclusive lease for the replay proof.
//! The durable journal also blocks live bridges after a replay process crash.
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const GENERIC_READ: u32 = 0x8000_0000;
const FILE_SHARE_READ: u32 = 1;
const ERROR_SHARING_VIOLATION: i32 = 32;

pub(crate) fn directory() -> Result<PathBuf, String> {
    let root = std::env::var_os("APPDATA")
        .filter(|v| !v.is_empty())
        .ok_or("APPDATA is unavailable")?;
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err("APPDATA must be an absolute path".into());
    }
    Ok(root.join("Flight Fabric").join("Replay"))
}
pub(crate) fn journal_path() -> Result<PathBuf, String> {
    Ok(directory()?.join("recovery.json"))
}

pub(crate) fn acquire(exclusive: bool) -> Result<File, String> {
    acquire_in(&directory()?, exclusive)
}

fn open_lease(path: &Path, exclusive: bool) -> io::Result<File> {
    // OPEN_ALWAYS creates or opens the file AND acquires its sharing mode in
    // one operation. A temporary write handle followed by a read-only reopen
    // can reject another live bridge during the creation/reopen window.
    // Rust requires write(true) for create(true), but access_mode overrides
    // actual Windows access: even the creating handle is read-only. Existing
    // read-only files therefore still work, and no writer/delete sharing is
    // introduced. Never truncate, unlink or replace an active lease file.
    OpenOptions::new()
        .write(true)
        .create(true)
        .access_mode(GENERIC_READ)
        .share_mode(if exclusive { 0 } else { FILE_SHARE_READ })
        .open(path)
}

fn lease_error(error: io::Error, exclusive: bool) -> String {
    if error.raw_os_error() != Some(ERROR_SHARING_VIOLATION) {
        return format!("Open simulator lease: {error}");
    }
    if exclusive {
        "Another simulator helper holds the lease; close FlightFabric and any replay worker before retrying".into()
    } else {
        "Simulator lease is in use; finish dedicated replay recovery or close the conflicting process before reconnecting".into()
    }
}

fn acquire_in(dir: &Path, exclusive: bool) -> Result<File, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Replay lease directory: {e}"))?;
    let path = dir.join("simulator.lease");
    let lease = open_lease(&path, exclusive).map_err(|e| lease_error(e, exclusive))?;
    if !exclusive
        && dir
            .join("recovery.json")
            .try_exists()
            .map_err(|e| format!("Replay recovery state is unreadable: {e}"))?
    {
        return Err("Replay recovery is required: run the replay tool with --recover, then reload a parked flight".into());
    }
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ff-replay-exclusion-{}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creating_handle_is_read_only_and_does_not_block_live_startup() {
        let dir = TestDirectory::new();
        let path = dir.0.join("simulator.lease");
        assert!(!path.exists());
        // Hold the actual handle that CREATES the file, not a subsequent
        // reopen. A write-capable creator causes the reproduced startup race.
        let mut creator = open_lease(&path, false).unwrap();
        let live = acquire_in(&dir.0, false).unwrap();
        assert!(creator.write_all(b"must not write").is_err());
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        assert!(acquire_in(&dir.0, true).is_err());
        drop(creator);
        assert!(acquire_in(&dir.0, true).is_err());
        drop(live);
        assert!(acquire_in(&dir.0, true).is_ok());
    }

    #[test]
    fn concurrent_first_live_starts_share_one_empty_file() {
        let dir = TestDirectory::new();
        let barrier = Arc::new(Barrier::new(8));
        let (tx, rx) = mpsc::channel();
        let mut threads = Vec::new();
        for _ in 0..8 {
            let directory = dir.0.clone();
            let start = Arc::clone(&barrier);
            let sender = tx.clone();
            threads.push(std::thread::spawn(move || {
                start.wait();
                sender.send(acquire_in(&directory, false)).unwrap();
            }));
        }
        drop(tx);
        let leases: Vec<File> = (0..8)
            .map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap())
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(acquire_in(&dir.0, true).is_err());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        assert_eq!(
            fs::metadata(dir.0.join("simulator.lease")).unwrap().len(),
            0
        );
        drop(leases);
        assert!(acquire_in(&dir.0, true).is_ok());
    }

    #[test]
    fn replay_first_start_excludes_both_modes_and_drop_releases_ownership() {
        let dir = TestDirectory::new();
        let replay = acquire_in(&dir.0, true).unwrap();
        assert!(acquire_in(&dir.0, false).is_err());
        assert!(acquire_in(&dir.0, true).is_err());
        assert!(fs::remove_file(dir.0.join("simulator.lease")).is_err());
        drop(replay);
        let live = acquire_in(&dir.0, false).unwrap();
        // Remain compatible with existing read-only live bridge handles.
        let existing = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(dir.0.join("simulator.lease"))
            .unwrap();
        drop(live);
        assert!(acquire_in(&dir.0, true).is_err());
        drop(existing);
        assert!(acquire_in(&dir.0, true).is_ok());
    }

    #[test]
    fn existing_read_only_lease_is_not_truncated_or_rewritten() {
        let dir = TestDirectory::new();
        let path = dir.0.join("simulator.lease");
        fs::write(&path, b"existing contents").unwrap();
        let original = fs::metadata(&path).unwrap().permissions();
        let mut read_only = original.clone();
        read_only.set_readonly(true);
        fs::set_permissions(&path, read_only).unwrap();
        let result = acquire_in(&dir.0, false)
            .map(drop)
            .and_then(|_| acquire_in(&dir.0, true).map(drop));
        fs::set_permissions(&path, original).unwrap();
        result.unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"existing contents");
    }

    #[test]
    fn recovery_marker_still_blocks_live_mode_and_failed_acquire_leaks_no_handle() {
        let dir = TestDirectory::new();
        let journal = dir.0.join("recovery.json");
        for data in [b"".as_slice(), b"invalid journal", b"{\"version\":1}"] {
            fs::write(&journal, data).unwrap();
            assert!(acquire_in(&dir.0, false)
                .unwrap_err()
                .contains("Replay recovery is required"));
            let recovery = acquire_in(&dir.0, true).unwrap();
            assert_eq!(fs::read(&journal).unwrap(), data);
            drop(recovery);
        }
        fs::remove_file(journal).unwrap();
        assert!(acquire_in(&dir.0, false).is_ok());
    }

    #[test]
    fn storage_failures_are_not_misreported_as_an_active_replay() {
        let dir = TestDirectory::new();
        let path = dir.0.join("simulator.lease");
        fs::create_dir(&path).unwrap();
        for exclusive in [false, true] {
            assert!(acquire_in(&dir.0, exclusive)
                .unwrap_err()
                .starts_with("Open simulator lease:"));
            let denied = lease_error(io::Error::from_raw_os_error(5), exclusive);
            assert!(denied.starts_with("Open simulator lease:"));
            assert!(!denied.contains("close FlightFabric"));
        }
        fs::remove_dir(&path).unwrap();
        assert!(acquire_in(&dir.0, false).is_ok());
    }

    #[test]
    fn windows_shared_and_exclusive_leases_exclude_each_other() {
        let path =
            std::env::temp_dir().join(format!("ff-replay-lease-test-{}", std::process::id()));
        fs::write(&path, b"").unwrap();
        let a = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let b = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .is_err());
        drop(a);
        drop(b);
        let x = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .is_err());
        drop(x);
        fs::remove_file(path).unwrap();
    }
}
