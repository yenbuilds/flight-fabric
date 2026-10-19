
    use super::*;

    fn parse(parts: &[&str]) -> Result<Options, &'static str> {
        options(parts.iter().map(|s| s.to_string()))
    }

    #[test]
    fn diagnostics_require_explicit_mode_and_bounded_duration() {
        assert_eq!(
            parse(&["--list"]),
            Ok(Options {
                seconds: None,
                device_path: None
            })
        );
        assert_eq!(
            parse(&["--watch", "--seconds", "5"]),
            Ok(Options {
                seconds: Some(5),
                device_path: None
            })
        );
        for args in [
            vec![],
            vec!["--watch"],
            vec!["--watch", "--seconds", "0"],
            vec!["--watch", "--seconds", "61"],
            vec!["--watch", "--seconds", "-1"],
            vec!["--list", "--watch"],
            vec!["--watch", "--seconds", "1", "--seconds", "2"],
            vec!["--watch", "--seconds", "1", "--device-path", "bad\npath"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn stalled_output_is_an_error_not_a_dropped_transition() {
        let (sender, _receiver) = sync_channel(1);
        let mut output = Output {
            sender,
            started: Instant::now(),
            sequence: 0,
        };
        output.emit("\"type\":\"press\"").unwrap();
        assert!(output.emit("\"type\":\"release\"").is_err());
    }

    #[test]
    fn device_strings_cannot_inject_output_lines() {
        assert_eq!(json_string("a\n\"\\\u{7f}"), "\"a\\u000a\\\"\\\\\\u007f\"");
    }
