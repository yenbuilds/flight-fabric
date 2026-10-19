
    use super::*;

    #[test]
    fn tug_mapping_uses_simconnect_names_without_rewriting_other_events() {
        assert_eq!(simconnect_event_name("TUG_HEADING"), "KEY_TUG_HEADING");
        assert_eq!(simconnect_event_name("TUG_SPEED"), "KEY_TUG_SPEED");
        for name in ["TUG_DISABLE", "TOGGLE_PUSHBACK", "AP_MASTER", "#70361"] {
            assert_eq!(simconnect_event_name(name), name);
        }
    }

    #[test]
    fn tug_heading_accepts_exact_unsigned_dword_without_widening_other_events() {
        for value in [0_u32, 0x40000000, 0x80000000, 0xc0000000, u32::MAX] {
            assert_eq!(bounded_named_event_data("TUG_HEADING", value as f64, 0), Some(value));
        }
        for value in [-1.0, 0.5, 4294967296.0, f64::NAN, f64::INFINITY] {
            assert_eq!(bounded_named_event_data("TUG_HEADING", value, 0), None);
        }
        assert_eq!(bounded_named_event_data("TUG_HEADING", 0.0, 1), None);
        assert_eq!(bounded_named_event_data("HEADING_BUG_SET", 2147483648.0, 0), None);
        for name in ["TUG_SPEED", "KEY_TUG_SPEED"] {
            for value in [-4.0, 1.0, 4294967292.0] {
                assert_eq!(bounded_named_event_data(name, value, 0), None);
            }
            assert_eq!(bounded_named_event_data(name, 0.0, 0), Some(0));
        }
    }

    #[test]
    fn com_hz_events_have_an_exact_channel_bounded_exception() {
        for name in ["COM_STBY_RADIO_SET_HZ", "COM2_STBY_RADIO_SET_HZ"] {
            for hz in [118_000_000, 118_005_000, 123_450_000, 136_990_000] {
                assert_eq!(bounded_named_event_data(name, f64::from(hz), 0), Some(hz));
                assert_eq!(bounded_named_event_data(name, f64::from(hz), 1), None);
            }
            for invalid in [
                0.0,
                117_995_000.0,
                137_000_000.0,
                123_020_000.0,
                123_005_001.0,
                123_005_000.5,
                f64::NAN,
                f64::INFINITY,
            ] {
                assert_eq!(bounded_named_event_data(name, invalid, 0), None);
            }
        }
        for name in [
            "AP_ALT_VAR_SET_ENGLISH",
            "COM_RADIO_SET_HZ",
            "COM1_RADIO_SWAP",
            "#12345",
        ] {
            assert_eq!(bounded_named_event_data(name, 123_005_000.0, 0), None);
        }
        assert_eq!(
            bounded_named_event_data("HEADING_BUG_SET", 275.0, 1),
            Some(275)
        );
    }

    #[test]
    fn rejects_unsafe_control_payload_tokens_and_extreme_values() {
        assert!(is_safe_control_name("AP_ALT_VAR_SET_ENGLISH"));
        assert!(is_safe_control_name("L:SDK_TEST_VAR"));
        assert!(!is_safe_control_name(""));
        assert!(!is_safe_control_name("BAD;Remove-Item"));
        assert!(!is_safe_control_unit("Feet; rm"));
        assert!(bounded_event_data(-9900.0).is_some());
        // Partial brake-axis values must keep their signed bit pattern through
        // the DWORD transport; they must never become zero or full braking.
        for value in [-16383, -15359, -12287, -8191, -4311, 0, 8191, 16383] {
            assert_eq!(bounded_event_data(value as f64).unwrap() as i32, value);
        }
        assert!(bounded_event_data(f64::NAN).is_none());
        assert!(bounded_event_data(1_000_001.0).is_none());
        assert_eq!(bounded_sdk_event_data(0x20000000 as f64), Some(0x20000000));
        assert_eq!(bounded_sdk_event_data(u32::MAX as f64), Some(u32::MAX));
        assert!(bounded_sdk_event_data(-1.0).is_none());
        assert!(bounded_sdk_event_data(1.5).is_none());
        assert!(is_safe_sdk_event_name("#70361"));
        assert!(!is_safe_sdk_event_name("AP_MASTER"));
    }
