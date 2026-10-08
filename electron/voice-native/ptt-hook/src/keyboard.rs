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
    use super::*;
    fn state() -> KeyboardState {
        let mut state = KeyboardState::new(
            HookConfig {
                key: VK_SPACE,
                modifiers: MOD_CONTROL | MOD_ALT,
            },
            Snapshot::default(),
            0,
        );
        state.set_paused(false, Snapshot::default(), 0);
        state
    }
    fn send(state: &mut KeyboardState, device: usize, key: u32, down: bool) -> Option<OutputEvent> {
        state.observe(device, key, down, 100).unwrap()
    }
    fn modifiers(state: &mut KeyboardState, device: usize) {
        assert_eq!(send(state, device, VK_LCONTROL, true), None);
        assert_eq!(send(state, device, VK_RMENU, true), None);
    }

    #[test]
    fn repeated_commands_and_autorepeat_emit_one_down_and_up() {
        let mut state = state();
        modifiers(&mut state, 1);
        for _ in 0..32 {
            assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
            assert_eq!(send(&mut state, 1, VK_SPACE, true), None);
            assert_eq!(send(&mut state, 1, VK_SPACE, false), Some(OutputEvent::Up));
            assert_eq!(send(&mut state, 1, VK_SPACE, false), None);
        }
    }

    #[test]
    fn each_sided_modifier_is_a_hold_trigger_and_ignores_the_other_side() {
        for (key, other_side) in [
            (VK_LCONTROL, VK_RCONTROL),
            (VK_RCONTROL, VK_LCONTROL),
            (VK_LMENU, VK_RMENU),
            (VK_RMENU, VK_LMENU),
            (VK_LSHIFT, VK_RSHIFT),
            (VK_RSHIFT, VK_LSHIFT),
            (VK_LWIN, VK_RWIN),
            (VK_RWIN, VK_LWIN),
        ] {
            let mut state =
                KeyboardState::new(HookConfig { key, modifiers: 0 }, Snapshot::default(), 0);
            state.set_paused(false, Snapshot::default(), 0);
            assert_eq!(send(&mut state, 1, other_side, true), None);
            assert_eq!(send(&mut state, 1, other_side, false), None);
            for _ in 0..32 {
                assert_eq!(send(&mut state, 1, key, true), Some(OutputEvent::Down));
                assert_eq!(send(&mut state, 1, key, true), None);
                assert_eq!(send(&mut state, 1, other_side, true), None);
                assert_eq!(send(&mut state, 1, other_side, false), None);
                assert_eq!(send(&mut state, 1, key, false), Some(OutputEvent::Up));
                assert_eq!(send(&mut state, 1, key, false), None);
            }
            send(&mut state, 1, key, true);
            state.set_paused(true, Snapshot::default(), 0);
            state.set_paused(false, Snapshot::default(), 0);
            assert_eq!(send(&mut state, 1, key, true), None);
            assert_eq!(send(&mut state, 1, key, false), None);
            assert_eq!(send(&mut state, 1, key, true), Some(OutputEvent::Down));
            assert_eq!(
                state.remove(1),
                Some(OutputEvent::KeyboardCancel("device-removed"))
            );
            assert_eq!(send(&mut state, 2, key, true), Some(OutputEvent::Down));
            assert_eq!(send(&mut state, 2, key, false), Some(OutputEvent::Up));
        }
    }

    #[test]
    fn single_caps_lock_holds_repeat_release_and_recover_after_pause_or_removal() {
        let mut state = KeyboardState::new(
            parse_shortcut("CapsLock").unwrap(),
            Snapshot {
                trigger_down: true,
                modifiers: 0,
            },
            0,
        );
        state.set_paused(false, Snapshot::default(), 0);
        assert_eq!(send(&mut state, 1, VK_CAPITAL, true), None);
        assert_eq!(send(&mut state, 1, VK_CAPITAL, false), None);
        for _ in 0..32 {
            assert_eq!(
                send(&mut state, 1, VK_CAPITAL, true),
                Some(OutputEvent::Down)
            );
            assert_eq!(send(&mut state, 1, VK_CAPITAL, true), None);
            assert_eq!(send(&mut state, 1, VK_LCONTROL, true), None);
            assert_eq!(send(&mut state, 1, VK_LCONTROL, false), None);
            assert_eq!(
                send(&mut state, 1, VK_CAPITAL, false),
                Some(OutputEvent::Up)
            );
            assert_eq!(send(&mut state, 1, VK_CAPITAL, false), None);
        }
        assert_eq!(
            send(&mut state, 1, VK_CAPITAL, true),
            Some(OutputEvent::Down)
        );
        state.set_paused(true, Snapshot::default(), 0);
        state.set_paused(false, Snapshot::default(), 0);
        assert_eq!(send(&mut state, 1, VK_CAPITAL, true), None);
        assert_eq!(send(&mut state, 1, VK_CAPITAL, false), None);
        assert_eq!(
            send(&mut state, 1, VK_CAPITAL, true),
            Some(OutputEvent::Down)
        );
        assert_eq!(
            state.remove(1),
            Some(OutputEvent::KeyboardCancel("device-removed"))
        );
        // A different keyboard must establish a release before its first hold.
        assert_eq!(send(&mut state, 2, VK_CAPITAL, false), None);
        assert_eq!(
            send(&mut state, 2, VK_CAPITAL, true),
            Some(OutputEvent::Down)
        );
        assert_eq!(
            send(&mut state, 2, VK_CAPITAL, false),
            Some(OutputEvent::Up)
        );
    }

    #[test]
    fn releasing_modifier_cannot_restart_on_trigger_autorepeat() {
        let mut state = state();
        modifiers(&mut state, 1);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
        assert_eq!(
            send(&mut state, 1, VK_LCONTROL, false),
            Some(OutputEvent::Up)
        );
        send(&mut state, 1, VK_LCONTROL, true);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), None);
        send(&mut state, 1, VK_SPACE, false);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
    }

    #[test]
    fn both_modifier_sides_and_cross_keyboard_chords_are_aggregated() {
        let mut state = state();
        modifiers(&mut state, 1);
        send(&mut state, 2, VK_RCONTROL, true);
        assert_eq!(send(&mut state, 2, VK_SPACE, true), Some(OutputEvent::Down));
        assert_eq!(send(&mut state, 1, VK_LCONTROL, false), None);
        assert_eq!(
            send(&mut state, 2, VK_RCONTROL, false),
            Some(OutputEvent::Up)
        );
    }

    #[test]
    fn multiple_trigger_devices_release_only_when_the_last_hold_ends() {
        let mut state = state();
        modifiers(&mut state, 1);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
        assert_eq!(send(&mut state, 2, VK_SPACE, true), None);
        assert_eq!(send(&mut state, 2, VK_SPACE, false), None);
        assert_eq!(send(&mut state, 1, VK_SPACE, false), Some(OutputEvent::Up));
    }

    #[test]
    fn device_loss_cancels_without_submitting_or_ending_a_surviving_hold() {
        let mut state = state();
        modifiers(&mut state, 1);
        modifiers(&mut state, 2);
        send(&mut state, 1, VK_SPACE, true);
        send(&mut state, 2, VK_SPACE, true);
        assert_eq!(state.remove(1), None);
        assert_eq!(
            state.remove(2),
            Some(OutputEvent::KeyboardCancel("device-removed"))
        );
        assert_eq!(state.remove(2), None);
        modifiers(&mut state, 3);
        assert_eq!(send(&mut state, 3, VK_SPACE, true), Some(OutputEvent::Down));
    }

    #[test]
    fn removal_of_the_only_required_modifier_cancels_the_other_keyboard_hold() {
        let mut state = state();
        modifiers(&mut state, 1);
        send(&mut state, 2, VK_SPACE, true);
        assert_eq!(
            state.remove(1),
            Some(OutputEvent::KeyboardCancel("device-removed"))
        );
        modifiers(&mut state, 3);
        assert_eq!(send(&mut state, 2, VK_SPACE, true), None);
        send(&mut state, 2, VK_SPACE, false);
        assert_eq!(send(&mut state, 2, VK_SPACE, true), Some(OutputEvent::Down));
    }

    #[test]
    fn startup_and_pause_keep_observed_down_despite_false_async_state() {
        let mut state = KeyboardState::new(
            state().config,
            Snapshot {
                trigger_down: true,
                modifiers: 0,
            },
            0,
        );
        state.set_paused(false, Snapshot::default(), 0);
        modifiers(&mut state, 1);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), None);
        send(&mut state, 1, VK_SPACE, false);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
        state.set_paused(true, Snapshot::default(), 0);
        state.set_paused(false, Snapshot::default(), 0);
        modifiers(&mut state, 1);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), None);
        send(&mut state, 1, VK_SPACE, false);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
    }

    #[test]
    fn release_while_paused_arms_fresh_press_but_paused_presses_are_not_replayed() {
        let mut state = state();
        modifiers(&mut state, 1);
        send(&mut state, 1, VK_SPACE, true);
        state.set_paused(true, Snapshot::default(), 0);
        assert_eq!(send(&mut state, 1, VK_SPACE, false), None);
        send(&mut state, 1, VK_SPACE, true);
        state.set_paused(false, Snapshot::default(), 0);
        modifiers(&mut state, 1);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), None);
        send(&mut state, 1, VK_SPACE, false);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
    }

    #[test]
    fn delayed_paused_packets_and_same_millisecond_do_not_replay_after_resume() {
        let mut state = state();
        state.set_paused(false, Snapshot::default(), 100);
        for time in [99, 100] {
            state.observe(1, VK_LCONTROL, true, time).unwrap();
            state.observe(1, VK_RMENU, true, time).unwrap();
            assert_eq!(state.observe(1, VK_SPACE, true, time).unwrap(), None);
            assert_eq!(state.observe(1, VK_SPACE, true, 101).unwrap(), None);
            assert_eq!(state.observe(1, VK_SPACE, false, 102).unwrap(), None);
        }
        assert_eq!(
            state.observe(1, VK_SPACE, true, 103).unwrap(),
            Some(OutputEvent::Down)
        );
        state.set_paused(false, Snapshot::default(), u32::MAX - 1);
        modifiers(&mut state, 1);
        state.observe(1, VK_SPACE, false, 0).unwrap();
        assert_eq!(
            state.observe(1, VK_SPACE, true, 1).unwrap(),
            Some(OutputEvent::Down)
        );
    }

    #[test]
    fn overrun_cancels_and_device_state_is_bounded_until_removal() {
        let mut state = state();
        modifiers(&mut state, 0);
        send(&mut state, 0, VK_SPACE, true);
        assert_eq!(
            state.reset(),
            Some(OutputEvent::KeyboardCancel("input-reset"))
        );
        modifiers(&mut state, 0);
        assert_eq!(send(&mut state, 0, VK_SPACE, true), None);
        send(&mut state, 0, VK_SPACE, false);
        assert_eq!(send(&mut state, 0, VK_SPACE, true), Some(OutputEvent::Down));
        send(&mut state, 0, VK_SPACE, false);
        for id in 1..1000 {
            send(&mut state, id, VK_LSHIFT, true);
            send(&mut state, id, VK_LSHIFT, false);
            state.remove(id);
        }
        for id in 1..MAX_KEYBOARDS {
            send(&mut state, id, VK_LSHIFT, true);
        }
        assert_eq!(
            state.observe(MAX_KEYBOARDS, VK_LSHIFT, true, 100),
            Err(Failure::Runtime)
        );
    }

    #[test]
    fn another_keyboard_release_cannot_arm_an_unseen_startup_hold() {
        let mut state = KeyboardState::new(
            state().config,
            Snapshot {
                trigger_down: true,
                modifiers: 0,
            },
            0,
        );
        state.set_paused(false, Snapshot::default(), 0);
        modifiers(&mut state, 2);
        assert_eq!(send(&mut state, 2, VK_SPACE, true), None);
        assert_eq!(send(&mut state, 2, VK_SPACE, false), None);
        // A's first report is autorepeat from its pre-registration hold.
        assert_eq!(send(&mut state, 1, VK_SPACE, true), None);
        send(&mut state, 1, VK_SPACE, false);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
    }

    #[test]
    fn startup_modifier_allows_fresh_trigger_but_ambiguous_release_never_submits() {
        let mut state = state();
        let snapshot = Snapshot {
            trigger_down: false,
            modifiers: 1 | 4,
        };
        state.set_paused(false, snapshot, 0);
        assert_eq!(send(&mut state, 2, VK_SPACE, true), Some(OutputEvent::Down));
        assert_eq!(send(&mut state, 2, VK_LCONTROL, true), None);
        // B releasing Ctrl cannot be interpreted as A's initial Ctrl release.
        assert_eq!(
            send(&mut state, 2, VK_LCONTROL, false),
            Some(OutputEvent::KeyboardCancel("input-reset"))
        );
        assert_eq!(send(&mut state, 2, VK_SPACE, false), None);
        modifiers(&mut state, 2);
        assert_eq!(send(&mut state, 2, VK_SPACE, true), Some(OutputEvent::Down));
    }

    #[test]
    fn untracked_keyboard_removal_invalidates_anonymous_modifiers() {
        let mut state = state();
        state.set_paused(
            false,
            Snapshot {
                trigger_down: false,
                modifiers: 1 | 4,
            },
            0,
        );
        assert_eq!(send(&mut state, 2, VK_SPACE, true), Some(OutputEvent::Down));
        assert_eq!(
            state.remove(1),
            Some(OutputEvent::KeyboardCancel("device-removed"))
        );
        send(&mut state, 2, VK_SPACE, false);
        assert_eq!(send(&mut state, 2, VK_SPACE, true), None);
    }

    #[test]
    fn removal_fences_queued_packets_and_arrival_requires_its_own_fresh_release() {
        let mut state = state();
        modifiers(&mut state, 1);
        modifiers(&mut state, 2);
        send(&mut state, 1, VK_SPACE, true);
        assert_eq!(state.device_change(2, false, 100, 100).unwrap(), None);
        assert_eq!(state.observe(2, VK_SPACE, true, 99).unwrap(), None);
        // A delayed repeat cannot make the removed device an active source.
        assert_eq!(state.observe(2, VK_SPACE, true, 101).unwrap(), None);
        assert_eq!(
            state.observe(1, VK_SPACE, false, 102).unwrap(),
            Some(OutputEvent::Up)
        );
        state.device_change(2, true, 110, 110).unwrap();
        state.observe(2, VK_LCONTROL, true, 111).unwrap();
        state.observe(2, VK_RMENU, true, 111).unwrap();
        assert_eq!(state.observe(2, VK_SPACE, true, 112).unwrap(), None);
        state.observe(2, VK_SPACE, false, 113).unwrap();
        assert_eq!(
            state.observe(2, VK_SPACE, true, 114).unwrap(),
            Some(OutputEvent::Down)
        );
    }

    #[test]
    fn initial_device_notifications_do_not_swallow_an_ordinary_first_press() {
        let mut state = state();
        state.device_change(1, true, 0, 10).unwrap();
        modifiers(&mut state, 1);
        assert_eq!(send(&mut state, 1, VK_SPACE, true), Some(OutputEvent::Down));
    }
}
