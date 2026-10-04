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
    use super::*;

    fn button(report_id: u8, collection: u16, usage: u16) -> Button {
        Button {
            report_id,
            collection,
            usage,
        }
    }

    fn set(buttons: &[Button]) -> BTreeSet<Button> {
        buttons.iter().copied().collect()
    }

    #[test]
    fn splits_every_report_in_a_packet() {
        let mut packet = [2_u32.to_le_bytes(), 3_u32.to_le_bytes()].concat();
        packet.extend([1, 0, 1, 1, 1, 0]);
        assert_eq!(
            split_reports(&packet).unwrap().collect::<Vec<_>>(),
            [&[1, 0], &[1, 1], &[1, 0]]
        );
    }

    #[test]
    fn rejects_truncated_zero_and_excessive_lengths() {
        for (size, count) in [
            (0_u32, 1_u32),
            (1, 0),
            (65536, 1),
            (1, 4097),
            (u32::MAX, u32::MAX),
            (8, 2),
        ] {
            let packet = [size.to_le_bytes(), count.to_le_bytes()].concat();
            assert!(split_reports(&packet).is_err());
        }
        assert!(split_reports(&[0; 7]).is_err());
        assert!(split_reports(&vec![0; MAX_PACKET_BYTES + 1]).is_err());
    }

    #[test]
    fn held_startup_needs_release_then_new_press() {
        let key = button(0, 0, 1);
        let mut holds = Holds::default();
        assert_eq!(
            holds.observe(0, set(&[key])),
            [Transition::Baseline {
                report_id: 0,
                held: 1
            }]
        );
        assert!(holds.observe(0, set(&[key])).is_empty());
        assert!(holds.observe(0, set(&[])).is_empty());
        assert_eq!(holds.observe(0, set(&[key])), [Transition::Press(key)]);
        assert!(holds.observe(0, set(&[key])).is_empty());
        assert_eq!(holds.observe(0, set(&[])), [Transition::Release(key)]);
    }

    #[test]
    fn reports_collections_and_high_usages_remain_independent() {
        let a = button(1, 2, 300);
        let b = button(1, 3, 300);
        let c = button(2, 2, 300);
        let map = BTreeMap::from([(0, a), (1, b), (2, c)]);
        assert_eq!(
            pressed_buttons(&map, 1, [(0, true), (1, true), (7, true)]).unwrap(),
            set(&[a, b])
        );
        assert!(pressed_buttons(&map, 1, [(2, true)]).is_err());
        let mut holds = Holds::default();
        holds.observe(1, set(&[]));
        holds.observe(2, set(&[]));
        assert_eq!(
            holds.observe(1, set(&[a, b])),
            [Transition::Press(a), Transition::Press(b)]
        );
        assert!(holds.observe(2, set(&[])).is_empty());
        assert_eq!(holds.observe(1, set(&[b])), [Transition::Release(a)]);
    }

    #[test]
    fn cancellation_does_not_release_and_disarms_until_a_fresh_press() {
        let key = button(1, 0, 5);
        let mut holds = Holds::default();
        holds.observe(1, set(&[]));
        holds.observe(1, set(&[key]));
        holds.cancel();
        assert_eq!(
            holds.observe(1, set(&[key])),
            [Transition::Baseline {
                report_id: 1,
                held: 1
            }]
        );
        assert!(holds.observe(1, set(&[])).is_empty());
        assert_eq!(holds.observe(1, set(&[key])), [Transition::Press(key)]);
    }

    #[test]
    fn batched_rapid_tap_keeps_both_transitions() {
        let key = button(1, 0, 1);
        let map = BTreeMap::from([(0, key)]);
        let mut holds = Holds::default();
        let mut packet = [2_u32.to_le_bytes(), 3_u32.to_le_bytes()].concat();
        packet.extend([1, 0, 1, 1, 1, 0]);
        let events: Vec<_> = split_reports(&packet)
            .unwrap()
            .flat_map(|report| {
                holds.observe(
                    report[0],
                    pressed_buttons(&map, report[0], [(0, report[1] != 0)]).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            events,
            [
                Transition::Baseline {
                    report_id: 1,
                    held: 0
                },
                Transition::Press(key),
                Transition::Release(key)
            ]
        );
    }

    #[test]
    fn sustained_reports_keep_state_bounded_and_preserve_transitions() {
        let key = button(0, 0, 15);
        let mut holds = Holds::default();
        holds.observe(0, set(&[]));
        let mut presses = 0;
        let mut releases = 0;
        for index in 0..200_000 {
            let down = index % 100 < 50;
            let pressed = if down { set(&[key]) } else { set(&[]) };
            for event in holds.observe(0, pressed) {
                match event {
                    Transition::Press(value) => {
                        assert_eq!(value, key);
                        presses += 1;
                    }
                    Transition::Release(value) => {
                        assert_eq!(value, key);
                        releases += 1;
                    }
                    Transition::Baseline { .. } => panic!("unexpected new baseline"),
                }
            }
            assert_eq!(holds.previous.len(), 1);
            assert_eq!(holds.previous[&0].len(), usize::from(down));
            assert_eq!(holds.active.len(), usize::from(down));
        }
        assert_eq!((presses, releases), (2000, 2000));
        holds.cancel();
        assert!(holds.previous.is_empty() && holds.active.is_empty());
    }
}
