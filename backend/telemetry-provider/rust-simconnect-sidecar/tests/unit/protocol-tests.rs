
    use super::*;

    #[test]
    fn command_deserialization_preserves_wire_names_and_defaults() {
        let command: Command = serde_json::from_str(
            r#"{
              "type":"setSimVars",
              "requestId":42,
              "subscriptions":[{"key":"ias","simvar":" AIRSPEED INDICATED ","unit":"knots","dataType":"float64"}],
              "pollIntervalMs":100,
              "chunkSize":8
            }"#,
        )
        .expect("command should parse");

        assert_eq!(command.command_type, "setSimVars");
        assert_eq!(command.request_id, Some(42));
        assert_eq!(command.subscription_generation, None);
        assert_eq!(command.poll_interval_ms, Some(100));
        assert_eq!(command.chunk_size, Some(8));
        assert_eq!(command.subscriptions.len(), 1);
        assert_eq!(command.subscriptions[0].reference(), "AIRSPEED INDICATED");
        assert_eq!(
            command.subscriptions[0].data_type.as_deref(),
            Some("float64")
        );
        assert!(command.name.is_none());
        assert!(command.code.is_none());
        assert!(command.value.is_none());
        assert!(command.parameters.is_empty());
        assert!(command.icao.is_none());
    }

    #[test]
    fn event_command_deserialization_preserves_additional_parameters() {
        let command: Command = serde_json::from_str(
            r#"{"type":"sendEvent","name":"HEADING_BUG_SET","value":275,"parameters":[0]}"#,
        )
        .expect("event command should parse");

        assert_eq!(command.command_type, "sendEvent");
        assert_eq!(command.name.as_deref(), Some("HEADING_BUG_SET"));
        assert_eq!(command.value, Some(275.0));
        assert_eq!(command.parameters, vec![0.0]);
    }

    #[test]
    fn subscription_generation_accepts_nonnegative_integers_and_rejects_negative_values() {
        let command: Command = serde_json::from_str(
            r#"{"type":"setSubscriptions","subscriptionGeneration":12,"subscriptions":[]}"#,
        )
        .expect("nonnegative subscription generation should parse");
        assert_eq!(command.subscription_generation, Some(12));

        let negative = serde_json::from_str::<Command>(
            r#"{"type":"setSubscriptions","subscriptionGeneration":-1,"subscriptions":[]}"#,
        );
        assert!(negative.is_err());
    }

    #[test]
    fn subscription_reference_prefers_expression_over_legacy_simvar() {
        let subscription = Subscription {
            key: "k".to_string(),
            expression: " (L:PRIMARY) ".to_string(),
            simvar: Some("SECONDARY".to_string()),
            unit: None,
            data_type: None,
            isolated: false,
        };
        assert_eq!(subscription.reference(), "(L:PRIMARY)");

        let legacy = Subscription {
            expression: " ".to_string(),
            simvar: Some(" LEGACY_SIMVAR ".to_string()),
            ..subscription
        };
        assert_eq!(legacy.reference(), "LEGACY_SIMVAR");
    }

    #[test]
    fn mobiflight_execution_command_preserves_code_and_request_id() {
        let command: Command = serde_json::from_str(
            r#"{"type":"executeMobiFlightCode","code":"1 (>K:ROTOR_BRAKE)","requestId":77}"#,
        )
        .expect("command should parse");

        assert_eq!(command.command_type, "executeMobiFlightCode");
        assert_eq!(command.code.as_deref(), Some("1 (>K:ROTOR_BRAKE)"));
        assert_eq!(command.request_id, Some(77));
    }

    #[test]
    fn stdin_reader_rejects_overlong_lines_without_unbounded_storage() {
        let mut reader = std::io::Cursor::new(b"{\"type\":\"probe\"}\n".to_vec());
        let line = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("line expected")
            .expect("line should be accepted");
        assert_eq!(line.trim(), "{\"type\":\"probe\"}");

        let mut reader = std::io::Cursor::new(b"0123456789\n{\"type\":\"stop\"}\n".to_vec());
        let first = read_limited_line(&mut reader, 4)
            .expect("read should succeed")
            .expect("first line expected");
        assert!(first
            .expect_err("first line should be rejected")
            .contains("input_line_too_long"));
        let second = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("second line expected")
            .expect("second line should remain readable");
        assert_eq!(second.trim(), "{\"type\":\"stop\"}");
    }

    #[test]
    fn stdin_reader_accepts_a_final_unterminated_command() {
        let mut reader = std::io::Cursor::new(b"{\"type\":\"stop\"}".to_vec());
        let line = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("final line expected")
            .expect("bounded final line should be accepted");
        assert_eq!(line, "{\"type\":\"stop\"}");
        assert!(read_limited_line(&mut reader, 64)
            .expect("subsequent EOF read should succeed")
            .is_none());
    }

    #[test]
    fn stdin_reader_reports_an_oversized_unterminated_line_once() {
        let mut reader = std::io::Cursor::new(vec![b'x'; 65]);
        let error = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("oversized final line expected")
            .expect_err("oversized final line should be rejected");
        assert_eq!(error, "input_line_too_long");
        assert!(read_limited_line(&mut reader, 64)
            .expect("subsequent EOF read should succeed")
            .is_none());
    }

    #[test]
    fn stdin_command_queue_is_bounded_and_batches_preserve_fifo_order() {
        let (sender, receiver) = stdin_command_channel();
        for index in 0..MAX_PENDING_STDIN_COMMANDS {
            let mut command = Command::stop();
            command.command_type = format!("command-{index}");
            sender
                .try_send(command)
                .expect("commands within the queue capacity should be accepted");
        }

        assert!(matches!(
            sender.try_send(Command::stop()),
            Err(mpsc::TrySendError::Full(_))
        ));

        let first_batch = receive_command_batch(&receiver, 7, Duration::ZERO);
        assert_eq!(first_batch.len(), 7);
        for (index, command) in first_batch.iter().enumerate() {
            assert_eq!(command.command_type, format!("command-{index}"));
        }
        assert_eq!(
            receiver
                .try_recv()
                .expect("the batch limit must leave later commands queued")
                .command_type,
            "command-7"
        );
    }

    #[test]
    fn serial_axis_commands_wake_the_wait_without_paying_each_poll_interval() {
        let (sender, receiver) = stdin_command_channel();
        let (ack_tx, ack_rx) = mpsc::sync_channel(0);
        let writer = thread::spawn(move || {
            for index in 0..5 {
                let mut command = Command::stop();
                command.request_id = Some(index);
                sender.send(command).unwrap();
                assert_eq!(ack_rx.recv_timeout(Duration::from_secs(2)).unwrap(), index);
            }
        });
        let start = std::time::Instant::now();
        for index in 0..5 {
            let batch =
                receive_command_batch(&receiver, MAX_COMMANDS_PER_TICK, Duration::from_secs(2));
            assert_eq!(batch.len(), 1);
            assert_eq!(batch[0].request_id, Some(index));
            ack_tx.send(index).unwrap();
        }
        writer.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        let (_sender, empty) = stdin_command_channel();
        assert!(receive_command_batch(&empty, 3, Duration::from_millis(1)).is_empty());
        assert!(receive_command_batch(&empty, 0, Duration::from_secs(2)).is_empty());
    }
