//! Ordered Raw Input state, exclusively owned by the keyboard message loop.
use super::*;

const MAX_KEYBOARDS: usize = 32;
const MODIFIER_KEYS: [u32; 8] = [
    VK_LCONTROL,
    VK_RCONTROL,
    VK_LMENU,
    VK_RMENU,
    VK_LSHIFT,
    VK_RSHIFT,
    VK_LWIN,
    VK_RWIN,
];

#[derive(Clone, Copy, Default)]
pub(super) struct Snapshot {
    pub trigger_down: bool,
    pub modifiers: u8,
}

impl Snapshot {
    pub fn read(config: HookConfig) -> Self {
        let mut modifiers = 0;
        for (index, key) in MODIFIER_KEYS.iter().enumerate() {
            if is_pressed(*key as i32) {
                modifiers |= 1 << index;
            }
        }
        Self {
            trigger_down: is_pressed(config.key as i32),
            modifiers,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Device {
    id: usize,
    trigger_down: bool,
    must_release: bool,
    active: bool,
    modifiers: u8,
}

pub(super) struct KeyboardState {
    config: HookConfig,
    devices: [Option<Device>; MAX_KEYBOARDS],
    baseline: Snapshot,
    paused: bool,
    activated_at: u32,
    changed_at: u32,
    created_at: u32,
}

impl KeyboardState {
    pub fn new(config: HookConfig, baseline: Snapshot, now: u32) -> Self {
        Self {
            config,
            devices: [None; MAX_KEYBOARDS],
            baseline,
            paused: true,
            activated_at: now,
            changed_at: now,
            created_at: now,
        }
    }

    pub fn set_paused(&mut self, paused: bool, snapshot: Snapshot, now: u32) {
        self.paused = paused;
        self.activated_at = now;
        // An async zero may mean an inaccessible desktop. Only an observed
        // release may erase a known trigger-down, including across suspension.
        self.baseline.trigger_down |= snapshot.trigger_down;
        self.baseline.modifiers = snapshot.modifiers;
        for device in self.devices.iter_mut().flatten() {
            device.active = false;
            device.must_release |= snapshot.trigger_down;
            device.modifiers &= snapshot.modifiers;
        }
    }

    fn active(&self) -> bool {
        self.devices.iter().flatten().any(|device| device.active)
    }

    fn modifiers_match(&self) -> bool {
        let sides = self
            .devices
            .iter()
            .flatten()
            .fold(self.baseline.modifiers, |value, device| {
                value | device.modifiers
            });
        [
            (MOD_CONTROL, 3),
            (MOD_ALT, 12),
            (MOD_SHIFT, 48),
            (MOD_SUPER, 192),
        ]
        .iter()
        .all(|(group, mask)| self.config.modifiers & group == 0 || sides & mask != 0)
    }

    fn clear_unqualified_holds(&mut self) {
        if !self.modifiers_match() {
            for device in self.devices.iter_mut().flatten() {
                device.active = false;
            }
        }
    }

    pub fn observe(
        &mut self,
        id: usize,
        key: u32,
        down: bool,
        time: u32,
    ) -> Result<Option<OutputEvent>, Failure> {
        let modifier = MODIFIER_KEYS
            .iter()
            .position(|value| *value == key)
            .map(|index| 1 << index);
        if key != self.config.key && modifier.is_none() {
            return Ok(None);
        }
        let was_active = self.active();
        let index = self
            .devices
            .iter()
            .position(|value| value.is_some_and(|device| device.id == id))
            .or_else(|| self.devices.iter().position(Option::is_none))
            .ok_or(Failure::Runtime)?;
        let device = self.devices[index].get_or_insert(Device {
            id,
            // The startup snapshot has no device identity. A release from B
            // cannot arm a previously unseen A that was already held at start.
            must_release: self.baseline.trigger_down,
            ..Default::default()
        });
        let mut ambiguous_release = false;
        if let Some(mask) = modifier {
            if down {
                device.modifiers |= mask;
            } else {
                // We cannot tell which device supplied a pre-registration
                // modifier. Retire uncertain capture instead of submitting it.
                ambiguous_release = self.baseline.modifiers & mask != 0;
                self.baseline.modifiers &= !mask;
                device.modifiers &= !mask;
            }
        }
        let fresh_trigger =
            key == self.config.key && down && !device.trigger_down && !device.must_release;
        if key == self.config.key {
            device.trigger_down = down;
            if !down {
                device.must_release = false;
                device.active = false;
            }
        }
        // Posted control messages can overtake queued WM_INPUT. Old packets
        // update latches, but cannot start capture after readiness/resume.
        // Treat the same millisecond conservatively; subtraction handles wrap.
        let current = time.wrapping_sub(self.activated_at) as i32 > 0
            && time.wrapping_sub(self.changed_at) as i32 > 0;
        if fresh_trigger && current && !self.paused && self.modifiers_match() {
            self.devices[index].as_mut().unwrap().active = true;
        }
        self.clear_unqualified_holds();
        Ok(match (was_active, self.active()) {
            (false, true) => Some(OutputEvent::Down),
            (true, false) if ambiguous_release => Some(OutputEvent::KeyboardCancel("input-reset")),
            (true, false) => Some(OutputEvent::Up),
            _ => None,
        })
    }

    pub fn remove(&mut self, id: usize) -> Option<OutputEvent> {
        let index = self
            .devices
            .iter()
            .position(|value| value.is_some_and(|device| device.id == id));
        let was_active = self.active();
        if let Some(index) = index {
            self.devices[index] = None;
        }
        // Snapshot modifiers have no device identity; observed modifiers from
        // surviving devices remain valid and may keep their hold active.
        self.baseline.modifiers = 0;
        self.clear_unqualified_holds();
        (was_active && !self.active()).then_some(OutputEvent::KeyboardCancel("device-removed"))
    }

    pub fn device_change(
        &mut self,
        id: usize,
        arrived: bool,
        event_time: u32,
        now: u32,
    ) -> Result<Option<OutputEvent>, Failure> {
        // Posted device notifications can overtake older queued WM_INPUT too.
        // The fence prevents those packets from recreating a removed hold.
        self.changed_at = now;
        if !arrived {
            return Ok(self.remove(id));
        }
        let was_active = self.active();
        let index = self
            .devices
            .iter()
            .position(|value| value.is_some_and(|device| device.id == id))
            .or_else(|| self.devices.iter().position(Option::is_none))
            .ok_or(Failure::Runtime)?;
        self.devices[index] = Some(Device {
            id,
            // DEVNOTIFY may report existing devices during registration.
            // Those use the startup held snapshot, not the hotplug guard.
            must_release: self.baseline.trigger_down
                || event_time.wrapping_sub(self.created_at) as i32 > 0,
            ..Default::default()
        });
        self.clear_unqualified_holds();
        Ok((was_active && !self.active()).then_some(OutputEvent::KeyboardCancel("input-reset")))
    }

    pub fn reset(&mut self) -> Option<OutputEvent> {
        let active = self.active();
        // An overrun may have hidden the initial base-key make. Every device
        // must establish its own release before any subsequent make is fresh.
        self.baseline.trigger_down = true;
        self.baseline.modifiers = 0;
        for device in self.devices.iter_mut().flatten() {
            device.active = false;
            device.must_release = true;
            device.modifiers = 0;
        }
        active.then_some(OutputEvent::KeyboardCancel("input-reset"))
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/keyboard-tests.rs"));
}
