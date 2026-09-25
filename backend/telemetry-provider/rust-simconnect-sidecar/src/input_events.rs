//! Per-command Input Event resolution. Hashes are aircraft/session-specific and
//! deliberately never cached between writes. Layouts follow the installed
//! MSFS 2024 SimConnect.h (packed 64-byte name, UINT64 hash, DWORD type).
use std::collections::HashSet;
use std::time::{Duration, Instant};

pub(crate) const ENUMERATE_RECV: u32 = 34;
pub(crate) const PARAMS_RECV: u32 = 37;
const MAX_PAGES: u32 = 128;
const MAX_EVENTS: usize = 65_536;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Operation {
    Identity(u32),
    Enumerate(u32),
    Parameters(u64),
    Write(u64, f64),
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Before,
    Enumerate,
    Parameters,
    After,
    Ready,
    Sent,
}

pub(crate) struct PendingWrite {
    pub(crate) name: String,
    pub(crate) request_id: Option<u64>,
    pub(crate) error: Option<String>,
    value: f64,
    base_request: u32,
    deadline: Instant,
    stage: Stage,
    issued: bool,
    aircraft: Option<String>,
    pub(crate) expected_aircraft: Option<String>,
    pages: HashSet<u32>,
    total_pages: Option<u32>,
    event_count: usize,
    matched: Option<(u64, u32)>,
    packets: HashSet<u32>,
    // Read-only discovery shares identity, pagination and timeout validation.
    // It cannot enter Parameters or emit Operation::Write.
    pub(crate) inventory: Option<Vec<(String, String, u32)>>,
    inventory_names: HashSet<String>,
}

impl PendingWrite {
    pub(crate) fn new(
        name: String,
        value: f64,
        request_id: Option<u64>,
        base_request: u32,
        now: Instant,
    ) -> Self {
        Self {
            name,
            value,
            request_id,
            base_request,
            deadline: now + Duration::from_millis(2500),
            stage: Stage::Before,
            issued: false,
            aircraft: None,
            expected_aircraft: None,
            pages: HashSet::new(),
            total_pages: None,
            event_count: 0,
            matched: None,
            packets: HashSet::new(),
            error: None,
            inventory: None,
            inventory_names: HashSet::new(),
        }
    }

    pub(crate) fn inventory(request_id: Option<u64>, base_request: u32, now: Instant) -> Self {
        let mut pending = Self::new(String::new(), 0.0, request_id, base_request, now);
        pending.inventory = Some(Vec::new());
        pending
    }

    pub(crate) fn inventory_complete(&self) -> bool {
        self.inventory.is_some() && self.stage == Stage::Sent
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
        self.error = Some(error.into());
    }
    pub(crate) fn record_packet(&mut self, packet: u32) {
        self.packets.insert(packet);
    }
    pub(crate) fn exception(&mut self, packet: u32) {
        if self.packets.contains(&packet) {
            self.fail("input_event_simconnect_exception");
        }
    }
    pub(crate) fn invalidate(&mut self) {
        self.fail("input_event_aircraft_changed");
    }

    fn advance(&mut self, stage: Stage) {
        self.stage = stage;
        self.issued = false;
    }

    pub(crate) fn next_operation(&mut self, now: Instant) -> Option<Operation> {
        if now >= self.deadline {
            self.fail("input_event_resolution_timeout");
        }
        if self.error.is_some() || self.issued {
            return None;
        }
        self.issued = true;
        Some(match self.stage {
            Stage::Before => Operation::Identity(self.base_request),
            Stage::Enumerate => Operation::Enumerate(self.base_request + 1),
            Stage::Parameters => Operation::Parameters(self.matched?.0),
            Stage::After => Operation::Identity(self.base_request + 2),
            Stage::Ready => {
                self.stage = Stage::Sent;
                if self.inventory.is_some() {
                    return None;
                }
                Operation::Write(self.matched?.0, self.value)
            }
            Stage::Sent => return None,
        })
    }

    pub(crate) fn identity(&mut self, request: u32, path: &str) {
        if !self.issued || self.error.is_some() {
            return;
        }
        if self.stage == Stage::Before && request == self.base_request {
            if path.is_empty() {
                self.fail("input_event_aircraft_unavailable");
                return;
            }
            if self
                .expected_aircraft
                .as_deref()
                .is_some_and(|expected| expected != path)
            {
                self.invalidate();
                return;
            }
            self.aircraft = Some(path.to_owned());
            self.advance(Stage::Enumerate);
        } else if self.stage == Stage::After && request == self.base_request + 2 {
            if self.aircraft.as_deref() != Some(path) {
                self.invalidate();
                return;
            }
            self.advance(Stage::Ready);
        }
    }

    pub(crate) fn packet(&mut self, kind: u32, bytes: &[u8]) {
        if self.error.is_some() || !self.issued {
            return;
        }
        let result = if kind == ENUMERATE_RECV && self.stage == Stage::Enumerate {
            self.enumeration(bytes)
        } else if kind == PARAMS_RECV && self.stage == Stage::Parameters {
            self.parameters(bytes)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            self.fail(error);
        }
    }

    fn enumeration(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        let request = u32_at(bytes, 12).ok_or("input_event_invalid_packet")?;
        if request != self.base_request + 1 {
            return Ok(());
        }
        let count = u32_at(bytes, 16).ok_or("input_event_invalid_packet")? as usize;
        let page = u32_at(bytes, 20).ok_or("input_event_invalid_packet")?;
        let total = u32_at(bytes, 24).ok_or("input_event_invalid_packet")?;
        if total == 0
            || total > MAX_PAGES
            || page >= total
            || count > MAX_EVENTS
            || self.event_count + count > MAX_EVENTS
            || bytes.len() < 28 + count * 76
            || self.total_pages.is_some_and(|prior| prior != total)
            || !self.pages.insert(page)
        {
            return Err("input_event_invalid_enumeration");
        }
        self.total_pages = Some(total);
        self.event_count += count;
        for descriptor in bytes[28..28 + count * 76].chunks_exact(76) {
            let name = c_string(&descriptor[..64]).ok_or("input_event_invalid_descriptor")?;
            let hash = u64_at(descriptor, 64).ok_or("input_event_invalid_descriptor")?;
            let kind = u32_at(descriptor, 72).ok_or("input_event_invalid_descriptor")?;
            if kind > 1 || name.is_empty() {
                return Err("input_event_invalid_descriptor");
            }
            if let Some(events) = self.inventory.as_mut() {
                if !self.inventory_names.insert(name.to_owned()) {
                    return Err("input_event_ambiguous_name");
                }
                events.push((name.to_owned(), hash.to_string(), kind));
            }
            if name == self.name {
                if self.matched.is_some() {
                    return Err("input_event_ambiguous_name");
                }
                self.matched = Some((hash, kind));
            }
        }
        if self.pages.len() == total as usize {
            if self.inventory.is_some() {
                self.advance(Stage::After);
                return Ok(());
            }
            let (_, kind) = self.matched.ok_or("input_event_not_found")?;
            if kind != 0 {
                return Err("input_event_unsupported_type");
            }
            self.advance(Stage::Parameters);
        }
        Ok(())
    }

    fn parameters(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        let hash = u64_at(bytes, 12).ok_or("input_event_invalid_packet")?;
        if self.matched.map(|item| item.0) != Some(hash) {
            return Ok(());
        }
        let declaration = c_string(bytes.get(20..).ok_or("input_event_invalid_packet")?)
            .ok_or("input_event_invalid_packet")?;
        // A DOUBLE read value does not prove the write parameter contract.
        if declaration != ";FLOAT64" {
            return Err("input_event_unsupported_parameters");
        }
        self.advance(Stage::After);
        Ok(())
    }
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}
fn u64_at(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(offset..offset + 8)?.try_into().ok()?,
    ))
}
fn c_string(bytes: &[u8]) -> Option<&str> {
    let end = bytes.iter().position(|byte| *byte == 0)?;
    std::str::from_utf8(&bytes[..end]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    const HASH: u64 = 18_277_121_765_366_520_672;
    fn pending() -> PendingWrite {
        let mut write = PendingWrite::new("KNOB".into(), -1.0, Some(7), 100, Instant::now());
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Identity(100))
        );
        write.identity(100, "aircraft.cfg");
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Enumerate(101))
        );
        write
    }
    fn page(index: u32, total: u32, names: &[(&str, u32)]) -> Vec<u8> {
        let mut packet = vec![0; 28 + names.len() * 76 + 76]; // SDK trailing slot
        for (offset, value) in [
            (12, 101),
            (16, names.len() as u32),
            (20, index),
            (24, total),
        ] {
            packet[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, (name, kind)) in names.iter().enumerate() {
            let start = 28 + index * 76;
            packet[start..start + name.len()].copy_from_slice(name.as_bytes());
            packet[start + 64..start + 72].copy_from_slice(&HASH.to_le_bytes());
            packet[start + 72..start + 76].copy_from_slice(&kind.to_le_bytes());
        }
        packet
    }
    fn params(text: &str) -> Vec<u8> {
        let mut packet = vec![0; 20];
        packet[12..20].copy_from_slice(&HASH.to_le_bytes());
        packet.extend_from_slice(text.as_bytes());
        packet.push(0);
        packet
    }
    #[test]
    fn inventory_preserves_full_hash_and_never_produces_a_write() {
        let mut read = PendingWrite::inventory(Some(7), 100, Instant::now());
        assert_eq!(
            read.next_operation(Instant::now()),
            Some(Operation::Identity(100))
        );
        read.identity(100, "aircraft.cfg");
        assert_eq!(
            read.next_operation(Instant::now()),
            Some(Operation::Enumerate(101))
        );
        read.packet(ENUMERATE_RECV, &page(1, 2, &[("KNOB", 0)]));
        assert_eq!(read.next_operation(Instant::now()), None);
        read.packet(ENUMERATE_RECV, &page(0, 2, &[("STRING_EVENT", 1)]));
        assert_eq!(
            read.next_operation(Instant::now()),
            Some(Operation::Identity(102))
        );
        read.identity(102, "aircraft.cfg");
        assert_eq!(read.next_operation(Instant::now()), None);
        assert!(read.inventory_complete());
        assert_eq!(
            read.inventory.unwrap()[0],
            ("KNOB".into(), HASH.to_string(), 0)
        );
    }
    #[test]
    fn inventory_rejects_duplicate_names_and_identity_changes() {
        for changed in [false, true] {
            let mut read = PendingWrite::inventory(None, 100, Instant::now());
            read.next_operation(Instant::now());
            read.identity(100, "aircraft.cfg");
            read.next_operation(Instant::now());
            if changed {
                read.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0)]));
                read.next_operation(Instant::now());
                read.identity(102, "other.cfg");
            } else {
                read.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0), ("KNOB", 0)]));
            }
            assert!(read.error.is_some());
            assert!(!read.inventory_complete());
            assert_eq!(read.next_operation(Instant::now()), None);
        }
    }
    #[test]
    fn resolves_all_pages_and_params_then_rechecks_aircraft_before_write() {
        let mut write = pending();
        write.packet(ENUMERATE_RECV, &page(1, 2, &[("KNOB", 0)]));
        assert_eq!(write.next_operation(Instant::now()), None);
        write.packet(ENUMERATE_RECV, &page(0, 2, &[("OTHER", 0)]));
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Parameters(HASH))
        );
        write.packet(PARAMS_RECV, &params(";FLOAT64"));
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Identity(102))
        );
        write.identity(100, "aircraft.cfg"); // stale preflight response cannot authorize a write
        assert_eq!(write.next_operation(Instant::now()), None);
        write.identity(102, "aircraft.cfg");
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Write(HASH, -1.0))
        );
        assert_eq!(write.next_operation(Instant::now()), None);
    }
    #[test]
    fn rejects_unknown_ambiguous_string_and_truncated_descriptors() {
        for (packet, error) in [
            (page(0, 1, &[("OTHER", 0)]), "input_event_not_found"),
            (
                page(0, 1, &[("KNOB", 0), ("KNOB", 0)]),
                "input_event_ambiguous_name",
            ),
            (page(0, 1, &[("KNOB", 1)]), "input_event_unsupported_type"),
            (
                page(0, 1, &[("KNOB", 0)])[..103].to_vec(),
                "input_event_invalid_enumeration",
            ),
        ] {
            let mut write = pending();
            write.packet(ENUMERATE_RECV, &packet);
            assert_eq!(write.error.as_deref(), Some(error));
            assert_eq!(write.next_operation(Instant::now()), None);
        }
    }
    #[test]
    fn rejects_duplicate_pages_wrong_parameters_aircraft_change_and_timeout() {
        let mut duplicate = pending();
        duplicate.packet(ENUMERATE_RECV, &page(0, 2, &[("KNOB", 0)]));
        duplicate.packet(ENUMERATE_RECV, &page(0, 2, &[("KNOB", 0)]));
        assert!(duplicate.error.is_some());
        for contract in [";FLOAT64;FLOAT64", ";STRING", ""] {
            let mut write = pending();
            write.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0)]));
            write.next_operation(Instant::now());
            write.packet(PARAMS_RECV, &params(contract));
            assert_eq!(
                write.error.as_deref(),
                Some("input_event_unsupported_parameters")
            );
        }
        let mut write = pending();
        write.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0)]));
        write.next_operation(Instant::now());
        write.packet(PARAMS_RECV, &params(";FLOAT64"));
        write.next_operation(Instant::now());
        write.identity(102, "other.cfg");
        assert_eq!(write.next_operation(Instant::now()), None);
        assert_eq!(write.error.as_deref(), Some("input_event_aircraft_changed"));
        let mut timeout = pending();
        assert_eq!(
            timeout.next_operation(Instant::now() + Duration::from_secs(3)),
            None
        );
        assert_eq!(
            timeout.error.as_deref(),
            Some("input_event_resolution_timeout")
        );
    }
    #[test]
    fn rejects_a_different_requested_aircraft_before_enumeration() {
        let mut write = PendingWrite::new("KNOB".into(), 1.0, Some(7), 100, Instant::now());
        write.expected_aircraft = Some("expected/aircraft.cfg".into());
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Identity(100))
        );
        write.identity(100, "other/aircraft.cfg");
        assert_eq!(write.error.as_deref(), Some("input_event_aircraft_changed"));
        assert_eq!(write.next_operation(Instant::now()), None);
    }

    #[test]
    fn rejects_matching_exceptions_and_lifecycle_changes() {
        let mut write = pending();
        write.record_packet(77);
        write.exception(76);
        assert!(write.error.is_none());
        write.exception(77);
        assert_eq!(write.next_operation(Instant::now()), None);
        let mut write = pending();
        write.invalidate();
        assert_eq!(write.next_operation(Instant::now()), None);
    }
}
