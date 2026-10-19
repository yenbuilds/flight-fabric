//! Standalone process-guardian mode for supervising a backend child.
//!
//! The guardian opens stable Windows handles for an owner and a target, then
//! waits for whichever exits first. A normal target exit releases the guardian;
//! an owner exit force-terminates the target so a blocked backend cannot become
//! orphaned. `main.rs` selects this mode with `--process-guardian`; the
//! supervising launcher waits for `READY_MARKER` before treating startup as
//! complete.

use std::ffi::c_void;
use std::io::{self, Write};
use std::ptr;

type Bool = i32;
type Dword = u32;
type Handle = *mut c_void;

const SYNCHRONIZE: Dword = 0x0010_0000;
const PROCESS_TERMINATE: Dword = 0x0000_0001;
const INFINITE: Dword = 0xffff_ffff;
const WAIT_OBJECT_0: Dword = 0x0000_0000;
const WAIT_TIMEOUT: Dword = 0x0000_0102;
const WAIT_FAILED: Dword = 0xffff_ffff;
const TARGET_EXIT_TIMEOUT_MS: Dword = 5_000;

pub(crate) const READY_MARKER: &str = "[FF_PROCESS_GUARDIAN_READY]";

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
    fn WaitForMultipleObjects(
        count: Dword,
        handles: *const Handle,
        wait_all: Bool,
        milliseconds: Dword,
    ) -> Dword;
    fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
    fn TerminateProcess(process: Handle, exit_code: u32) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
}

// PIDs can be reused, so all later operations use the exact process handle
// opened here rather than looking the PID up again.
struct ProcessHandle {
    handle: Handle,
    process_id: Dword,
}

impl ProcessHandle {
    fn open(process_id: Dword, desired_access: Dword, label: &str) -> Result<Self, String> {
        let handle = unsafe { OpenProcess(desired_access, 0, process_id) };
        if handle.is_null() {
            return Err(format!(
                "could not open {label} PID {process_id}: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self { handle, process_id })
    }

    fn is_signaled(&self) -> Result<bool, String> {
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(format!(
                "could not query PID {}: {}",
                self.process_id,
                io::Error::last_os_error()
            )),
            status => Err(format!(
                "query for PID {} returned unexpected status 0x{status:08x}",
                self.process_id
            )),
        }
    }

    fn terminate_and_wait(&self) -> Result<(), String> {
        if self.is_signaled()? {
            return Ok(());
        }
        if unsafe { TerminateProcess(self.handle, 0) } == 0 {
            if self.is_signaled()? {
                return Ok(());
            }
            return Err(format!(
                "could not terminate guarded target PID {}: {}",
                self.process_id,
                io::Error::last_os_error()
            ));
        }
        match unsafe { WaitForSingleObject(self.handle, TARGET_EXIT_TIMEOUT_MS) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(format!(
                "guarded target PID {} did not exit after termination",
                self.process_id
            )),
            WAIT_FAILED => Err(format!(
                "waiting for guarded target PID {} failed: {}",
                self.process_id,
                io::Error::last_os_error()
            )),
            status => Err(format!(
                "waiting for guarded target PID {} returned unexpected status 0x{status:08x}",
                self.process_id
            )),
        }
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            let _ = unsafe { CloseHandle(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}

struct ProcessGuardian {
    owner: ProcessHandle,
    target: ProcessHandle,
}

impl ProcessGuardian {
    fn open(owner_pid: Dword, target_pid: Dword) -> Result<Self, String> {
        if owner_pid == target_pid {
            return Err("process guardian owner and target PIDs must be different".to_string());
        }
        // Open the exact target first. If the supervisor disappears in the
        // narrow interval between spawning the backend and starting this
        // guardian, failing to open the owner must still fail closed by
        // terminating the backend handle we already secured.
        let target = ProcessHandle::open(
            target_pid,
            SYNCHRONIZE | PROCESS_TERMINATE,
            "guardian target",
        )?;
        let owner = match ProcessHandle::open(owner_pid, SYNCHRONIZE, "guardian owner") {
            Ok(owner) => owner,
            Err(owner_error) => {
                return match target.terminate_and_wait() {
                    Ok(()) => Err(format!(
                        "{owner_error}; guarded target PID {target_pid} was terminated"
                    )),
                    Err(target_error) => Err(format!(
                        "{owner_error}; additionally failed to terminate guarded target PID {target_pid}: {target_error}"
                    )),
                };
            }
        };
        Ok(Self { owner, target })
    }

    fn enforce(self) -> Result<(), String> {
        let handles = [self.owner.handle, self.target.handle];
        match unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) } {
            WAIT_OBJECT_0 => self.terminate_target_after_owner_exit(),
            status if status == WAIT_OBJECT_0 + 1 => Ok(()),
            WAIT_FAILED => Err(format!(
                "process guardian wait failed: {}",
                io::Error::last_os_error()
            )),
            status => Err(format!(
                "process guardian wait returned unexpected status 0x{status:08x}"
            )),
        }
    }

    fn terminate_target_after_owner_exit(&self) -> Result<(), String> {
        self.target.terminate_and_wait()
    }
}

// Readiness is emitted only after both exact handles are secured. From this
// point, `enforce` owns the supervision lifecycle until one process exits.
pub(crate) fn run(owner_pid: Dword, target_pid: Dword) -> Result<(), String> {
    let guardian = ProcessGuardian::open(owner_pid, target_pid)?;
    println!("{READY_MARKER}");
    io::stdout()
        .flush()
        .map_err(|error| format!("could not flush process guardian readiness: {error}"))?;
    guardian.enforce()
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/process_guardian-tests.rs"));
}
