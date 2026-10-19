//! A tug command must keep arriving. Expiry stops motion and latches until an
//! explicit disable, so a delayed command cannot resume a stalled pushback.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub static ARMED: AtomicBool = AtomicBool::new(false);
static OWNER_EXITED: AtomicBool = AtomicBool::new(false);

pub fn owner_exited() -> bool { OWNER_EXITED.load(Ordering::SeqCst) }

pub fn before_owner_exit() {
    OWNER_EXITED.store(true, Ordering::SeqCst);
    if ARMED.load(Ordering::SeqCst) {
        // The normal 200 ms service loop gets a bounded chance to neutralize
        // the tug. The lifeline still kills a blocked native process.
        std::thread::sleep(Duration::from_millis(1500));
    }
}

#[derive(Default)]
pub struct TugLease { deadline: Option<Instant>, expired: bool }

impl TugLease {
    pub fn active(&self) -> bool { self.deadline.is_some() }
    pub fn due(&self, now: Instant) -> bool { self.deadline.is_some_and(|d| now >= d) }
    pub fn blocked(&self, now: Instant) -> bool { self.expired || self.due(now) }
    pub fn expire(&mut self) { self.expired = true; }
    pub fn stopped(&mut self) { self.deadline = None; }
    pub fn start(&mut self, now: Instant) -> bool {
        if self.active() || self.blocked(now) { return false; }
        self.deadline = Some(now + Duration::from_millis(1500));
        true
    }
    pub fn command(&mut self, name: &str, _data: u32, now: Instant) {
        if name == "TUG_DISABLE" {
            self.deadline = None; self.expired = false;
        } else if matches!(name, "TUG_HEADING" | "KEY_TUG_HEADING") && self.active() && !self.blocked(now) {
            self.deadline = Some(now + Duration::from_millis(1500));
        }
        // Speed zero alone does not disarm: disable may still fail afterwards.
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/tug_lease-tests.rs"));
}
