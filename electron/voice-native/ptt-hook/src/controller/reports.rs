//! Shared controller framing/hold logic. No device I/O.
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_PACKET_BYTES: usize = 1024 * 1024;
pub const MAX_BUTTONS: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Button {
    pub report_id: u8,
    pub collection: u16,
    pub usage: u16,
}

pub type ButtonMap = BTreeMap<u16, Button>;

/// RAWHID contains dwCount reports, not just one. Both lengths originate outside
/// this process. Validate before slicing, allocating or calling the HID parser.
pub fn split_reports(payload: &[u8]) -> Result<std::slice::ChunksExact<'_, u8>, &'static str> {
    if payload.len() < 8 || payload.len() > MAX_PACKET_BYTES {
        return Err("HID packet length is outside the diagnostic limits");
    }
    let size = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
    let count = u32::from_le_bytes(payload[4..8].try_into().unwrap()) as usize;
    if size == 0 || size > u16::MAX as usize || count == 0 || count > 4096 {
        return Err("HID report size/count is outside the diagnostic limits");
    }
    let bytes = size
        .checked_mul(count)
        .ok_or("HID report length overflow")?;
    let end = 8_usize
        .checked_add(bytes)
        .ok_or("HID packet length overflow")?;
    let reports = payload.get(8..end).ok_or("Truncated HID packet")?;
    Ok(reports.chunks_exact(size))
}

/// Resolve descriptor data indices into unambiguous report/collection/usages.
/// Values (axes, hats) are intentionally ignored. A report cannot affect another
/// report ID, even if it reuses the same visible button number.
pub fn pressed_buttons(
    map: &ButtonMap,
    report_id: u8,
    data: impl IntoIterator<Item = (u16, bool)>,
) -> Result<BTreeSet<Button>, &'static str> {
    let mut pressed = BTreeSet::new();
    for (index, on) in data {
        if let Some(button) = map.get(&index) {
            if button.report_id != report_id {
                return Err("HID button data belongs to a different report");
            }
            if on {
                pressed.insert(*button);
            }
        }
    }
    Ok(pressed)
}

#[derive(Debug, PartialEq)]
pub enum Transition {
    Baseline { report_id: u8, held: usize },
    Press(Button),
    Release(Button),
}

#[derive(Default)]
pub struct Holds {
    previous: BTreeMap<u8, BTreeSet<Button>>,
    active: BTreeSet<Button>,
}

impl Holds {
    pub fn is_pressed(&self, button: Button) -> bool {
        self.previous
            .get(&button.report_id)
            .is_some_and(|buttons| buttons.contains(&button))
    }

    pub fn observe(&mut self, report_id: u8, pressed: BTreeSet<Button>) -> Vec<Transition> {
        let Some(previous) = self.previous.get(&report_id) else {
            // A first report is evidence of state, never of a new press. This
            // also deliberately ignores a held button's first release.
            let baseline = Transition::Baseline {
                report_id,
                held: pressed.len(),
            };
            self.previous.insert(report_id, pressed);
            return vec![baseline];
        };
        let mut output = Vec::new();
        for button in previous.difference(&pressed) {
            if self.active.remove(button) {
                output.push(Transition::Release(*button));
            }
        }
        for button in pressed.difference(previous) {
            self.active.insert(*button);
            output.push(Transition::Press(*button));
        }
        self.previous.insert(report_id, pressed);
        output
    }

    pub fn cancel(&mut self) {
        // The caller emits cancellation, never synthesizes a normal release.
        // All reports require a fresh baseline after reconnect/recovery.
        self.previous.clear();
        self.active.clear();
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/controller-reports-tests.rs"));
}
