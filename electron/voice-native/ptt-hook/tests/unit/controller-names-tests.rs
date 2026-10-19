
    use super::*;

    #[test]
    fn rejects_malformed_or_oversized_property_strings() {
        let value = [b'A' as u16, 0];
        assert_eq!(
            property_string(&value, 4, DEVPROP_TYPE_STRING).as_deref(),
            Some("A")
        );
        for (bytes, kind) in [
            (0, DEVPROP_TYPE_STRING),
            (3, DEVPROP_TYPE_STRING),
            (6, DEVPROP_TYPE_STRING),
            (4, DEVPROP_TYPE_STRING_LIST),
        ] {
            assert!(property_string(&value, bytes, kind).is_none());
        }
        assert!(property_string(&[65, 66], 4, DEVPROP_TYPE_STRING).is_none());
        assert!(property_string(&[0xd800, 0], 4, DEVPROP_TYPE_STRING).is_none());
    }

    #[test]
    fn display_names_are_bounded_plain_text_and_optional() {
        assert_eq!(
            display_name("  T.16000M\t  Joystick\u{202e} ".into()).as_deref(),
            Some("T.16000M Joystick")
        );
        assert!(display_name("\n\t ".into()).is_none());
        assert_eq!(display_name("✈".repeat(500)).unwrap().chars().count(), 100);
    }
