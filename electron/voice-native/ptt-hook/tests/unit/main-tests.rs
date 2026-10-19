
    use std::sync::mpsc::sync_channel;

    use super::{
        Failure, MOD_ALT, MOD_CONTROL, OutputEvent, VK_CAPITAL, VK_SPACE, parse_arguments,
        parse_shortcut, try_queue_output, write_output_events,
    };

    fn arguments(parts: &[&str]) -> Result<String, String> {
        parse_arguments(parts.iter().map(|part| part.to_string()))
    }

    #[test]
    fn parses_modified_shortcut() {
        let shortcut = parse_shortcut("Control+Alt+Space").expect("shortcut parses");
        assert_eq!(shortcut.key, VK_SPACE);
        assert_eq!(shortcut.modifiers, MOD_CONTROL | MOD_ALT);
    }

    #[test]
    fn parses_single_keys_with_optional_modifiers() {
        for (text, expected) in [
            ("CapsLock", VK_CAPITAL),
            ("caps lock", VK_CAPITAL),
            ("Space", VK_SPACE),
            ("a", 0x41),
            ("5", 0x35),
            ("F8", 0x77),
        ] {
            let shortcut = parse_shortcut(text).expect("single key parses");
            assert_eq!(shortcut.key, expected);
            assert_eq!(shortcut.modifiers, 0);
        }
        let shortcut = parse_shortcut("Control+CapsLock").unwrap();
        assert_eq!(shortcut.key, VK_CAPITAL);
        assert_eq!(shortcut.modifiers, MOD_CONTROL);
        for invalid in ["", "Control", "Control+Alt", "A+B", "Ctrl+Ctrl+A", "F13"] {
            assert!(parse_shortcut(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn parses_left_and_right_modifiers_as_single_trigger_keys() {
        for (text, expected) in [
            ("LeftControl", super::VK_LCONTROL),
            ("RightControl", super::VK_RCONTROL),
            ("LeftAlt", super::VK_LMENU),
            ("RightAlt", super::VK_RMENU),
            ("LeftShift", super::VK_LSHIFT),
            ("RightShift", super::VK_RSHIFT),
            ("LeftSuper", super::VK_LWIN),
            ("RightSuper", super::VK_RWIN),
        ] {
            let shortcut = parse_shortcut(text).unwrap();
            assert_eq!(shortcut.key, expected);
            assert_eq!(shortcut.modifiers, 0);
        }
        assert_eq!(parse_shortcut("left alt").unwrap().key, super::VK_LMENU);
    }

    #[test]
    fn serializes_output_events_in_order() {
        let (sender, receiver) = sync_channel(3);
        sender.send(OutputEvent::Ready).expect("ready is queued");
        sender.send(OutputEvent::Down).expect("down is queued");
        sender.send(OutputEvent::Up).expect("up is queued");
        drop(sender);

        let mut output = Vec::new();
        write_output_events(&mut output, receiver).expect("events are written");
        assert_eq!(
            output,
            b"{\"type\":\"ready\"}\n{\"type\":\"down\"}\n{\"type\":\"up\"}\n",
        );
    }

    #[test]
    fn output_queue_is_bounded_and_distinguishes_full_from_closed() {
        let (sender, receiver) = sync_channel(super::OUTPUT_QUEUE_CAPACITY);
        for _ in 0..super::OUTPUT_QUEUE_CAPACITY {
            assert_eq!(try_queue_output(&sender, OutputEvent::Down), Ok(()));
        }
        assert_eq!(
            try_queue_output(&sender, OutputEvent::Up),
            Err(Failure::OutputQueueFull)
        );
        // A blocked writer cannot make the hook wait for queue space.
        drop(receiver);
        assert_eq!(
            try_queue_output(&sender, OutputEvent::Up),
            Err(Failure::OutputPipe)
        );
    }

    #[test]
    fn terminal_reason_is_fixed_and_precedes_clean_writer_shutdown() {
        let (sender, receiver) = sync_channel(3);
        sender.send(OutputEvent::Ready).unwrap();
        sender.send(OutputEvent::Stopped(Failure::Runtime)).unwrap();
        sender.send(OutputEvent::End).unwrap();
        let mut output = Vec::new();
        write_output_events(&mut output, receiver).unwrap();
        assert_eq!(
            output,
            b"{\"type\":\"ready\"}\n{\"type\":\"stopped\",\"reason\":\"runtime-failure\"}\n"
        );
        assert_eq!(Failure::Startup as i32, 10);
        assert_eq!(Failure::Runtime as i32, 11);
        assert_eq!(Failure::OutputQueueFull as i32, 12);
        assert_eq!(Failure::OutputPipe as i32, 13);
    }

    #[test]
    fn writer_propagates_broken_pipe_without_a_diagnostic_write() {
        struct BrokenPipe(usize);
        impl std::io::Write for BrokenPipe {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                self.0 += 1;
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                panic!("failed writes must stop immediately");
            }
        }
        let (sender, receiver) = sync_channel(2);
        sender.send(OutputEvent::Down).unwrap();
        sender.send(OutputEvent::Up).unwrap();
        let mut writer = BrokenPipe(0);
        assert_eq!(
            write_output_events(&mut writer, receiver)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::BrokenPipe
        );
        assert_eq!(writer.0, 1);
    }

    #[test]
    fn keeps_the_keyboard_only_invocation() {
        assert_eq!(
            arguments(&["--shortcut", "Control+Alt+Space"]),
            Ok("Control+Alt+Space".to_string()),
        );
    }

    #[test]
    fn rejects_incomplete_or_mixed_invocations() {
        assert!(arguments(&[]).is_err());
        assert!(arguments(&["--shortcut"]).is_err());
        assert!(
            arguments(&[
                "--shortcut",
                "Control+Alt+Space",
                "--shortcut",
                "Control+Alt+F1"
            ])
            .is_err()
        );
        assert!(arguments(&["--surprise"]).is_err());
    }

    #[test]
    fn rejects_retired_joystick_modes() {
        for invocation in [
            vec!["--learn-joystick"],
            vec!["--joystick", "044F:B10A", "--button", "5"],
            vec![
                "--shortcut",
                "Control+Alt+Space",
                "--joystick",
                "044F:B10A",
                "--button",
                "5",
            ],
        ] {
            assert!(arguments(&invocation).is_err());
        }
    }
