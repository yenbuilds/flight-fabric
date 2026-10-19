
    use super::*;
    fn packet(key: u16, scan: u16, flags: u16) -> RAWKEYBOARD {
        RAWKEYBOARD {
            VKey: key,
            MakeCode: scan,
            Flags: flags,
            Message: if flags & RI_KEY_BREAK as u16 != 0 {
                WM_KEYUP
            } else {
                WM_KEYDOWN
            },
            ..Default::default()
        }
    }

    #[test]
    fn standalone_lifecycle_requires_both_power_and_session_resume() {
        let mut lifecycle = Lifecycle::default();
        let message = |kind, value| MSG {
            message: kind,
            wParam: value as usize,
            ..Default::default()
        };
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_SESSION, WTS_SESSION_UNLOCK)),
            None
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_SESSION, WTS_SESSION_LOCK)),
            Some(Transition::Pause("session-ended"))
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_POWER, PBT_APMSUSPEND)),
            Some(Transition::Pause("suspend"))
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_POWER, PBT_APMRESUMEAUTOMATIC)),
            None
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_SESSION, WTS_SESSION_UNLOCK)),
            Some(Transition::Resume)
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_POWER, PBT_APMRESUMESUSPEND)),
            None
        );
    }

    #[test]
    fn normalizes_left_right_modifiers_and_make_break_flags() {
        for (vk, scan, flags, key) in [
            (0x10, 0x2a, 0, VK_LSHIFT),
            (0x10, 0x36, 0, VK_RSHIFT),
            (0x11, 0x1d, 0, VK_LCONTROL),
            (0x11, 0x1d, 2, VK_RCONTROL),
            (0x12, 0x38, 0, VK_LMENU),
            (0x12, 0x38, 2, VK_RMENU),
        ] {
            assert_eq!(
                decode(packet(vk, scan, flags)).unwrap(),
                Packet::Key { key, down: true }
            );
            assert_eq!(
                decode(packet(vk, scan, flags | 1)).unwrap(),
                Packet::Key { key, down: false }
            );
        }
        assert_eq!(
            decode(packet(0x10, 0, 0)).unwrap(),
            Packet::Key {
                key: VK_LSHIFT,
                down: true
            }
        );
        assert_eq!(
            decode(packet(0x20, 0, 0)).unwrap(),
            Packet::Key {
                key: VK_SPACE,
                down: true
            }
        );
    }

    #[test]
    fn ignores_unmapped_fake_keys_and_cancels_overrun_without_a_release() {
        assert_eq!(decode(packet(255, 0x2a, 0)).unwrap(), Packet::Ignore);
        assert_eq!(decode(packet(0x10, 0x2a, 2)).unwrap(), Packet::Ignore);
        assert_eq!(decode(packet(0, 255, 0)).unwrap(), Packet::Reset);
        let mut invalid = packet(0x20, 0x39, 0);
        invalid.Message = WM_CHAR;
        assert_eq!(decode(invalid), Err(Failure::Runtime));
    }

    #[test]
    fn legacy_ime_release_without_break_flag_does_not_fail_keyboard_input() {
        // Representative Hankaku/Zenkaku packet with the Windows direction
        // mismatch documented in SDL commit dc6f0f0dcc06e9d282e949f19fad97e44468ceef.
        // This is a decoder fixture, not a locally recorded hardware packet.
        let mut release = packet(0xf3, 0x29, 0);
        release.Message = WM_KEYUP;
        assert_eq!(
            decode(release),
            Ok(Packet::Key {
                key: 0xf3,
                down: false,
            })
        );
        // Ordinary PTT input remains decodable after the unrelated IME key.
        assert_eq!(
            decode(packet(0x20, 0x39, 0)),
            Ok(Packet::Key {
                key: VK_SPACE,
                down: true,
            })
        );
    }

    #[test]
    fn rejects_truncated_wrong_type_or_inconsistent_packets_before_union_read() {
        let length = (size_of::<RAWINPUTHEADER>() + size_of::<RAWKEYBOARD>()) as u32;
        let mut raw = RAWINPUT::default();
        raw.header.dwType = RIM_TYPEKEYBOARD;
        raw.header.dwSize = length;
        raw.data.keyboard = packet(0x20, 0x39, 0);
        assert_eq!(
            validate_packet(&raw, length).unwrap(),
            Packet::Key {
                key: VK_SPACE,
                down: true
            }
        );
        assert_eq!(validate_packet(&raw, length - 1), Err(Failure::Runtime));
        raw.header.dwType = RIM_TYPEHID;
        assert_eq!(validate_packet(&raw, length), Err(Failure::Runtime));
        raw.header.dwType = RIM_TYPEKEYBOARD;
        raw.header.dwSize += 1;
        assert_eq!(validate_packet(&raw, length), Err(Failure::Runtime));
    }
