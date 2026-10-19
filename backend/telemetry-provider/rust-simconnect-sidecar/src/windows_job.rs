//! RAII wrapper for the Windows Job Object used by connection probes.
//!
//! An isolated probe can block in a native SimConnect open call. Assigning it
//! to a kill-on-close job guarantees that dropping the parent-held job handle
//! terminates the probe, including abrupt parent shutdown. This mechanism is
//! scoped to probe children; the normal backend lifecycle uses the explicit
//! owner lifeline and process guardian modules.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr;

type Bool = i32;
type Dword = u32;
type Handle = *mut c_void;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;

// These layouts mirror JOBOBJECT_EXTENDED_LIMIT_INFORMATION and its nested
// Win32 structs. Only `limit_flags` is set, but the full layout is required.
#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: Dword,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: Dword,
    affinity: usize,
    priority_class: Dword,
    scheduling_class: Dword,
}

#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(job_attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        information_class: i32,
        information: *const c_void,
        information_length: Dword,
    ) -> Bool;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
}

pub(crate) struct KillOnCloseJob {
    handle: Handle,
}

impl KillOnCloseJob {
    pub(crate) fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "connection probe job creation failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut information: JobObjectExtendedLimitInformation = unsafe { zeroed() };
        information.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                &information as *const JobObjectExtendedLimitInformation as *const c_void,
                size_of::<JobObjectExtendedLimitInformation>() as Dword,
            )
        } != 0;
        if !configured {
            let error = std::io::Error::last_os_error();
            let _ = unsafe { CloseHandle(handle) };
            return Err(format!(
                "connection probe job configuration failed: {error}"
            ));
        }

        Ok(Self { handle })
    }

    pub(crate) fn assign(&self, child: &Child) -> Result<(), String> {
        let assigned =
            unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as Handle) } != 0;
        if assigned {
            Ok(())
        } else {
            Err(format!(
                "connection probe job assignment failed: {}",
                std::io::Error::last_os_error()
            ))
        }
    }
}

// Closing the last job handle activates KILL_ON_JOB_CLOSE for every assigned
// process, so ownership of the native handle is the safety guarantee.
impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            let _ = unsafe { CloseHandle(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/windows_job-tests.rs"));
}
