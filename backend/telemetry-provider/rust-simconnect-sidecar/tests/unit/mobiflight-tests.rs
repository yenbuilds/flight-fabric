
    use super::*;

    #[test]
    fn commands_are_fixed_size_printable_ascii_and_bounded() {
        let command = execution_command("1 (>K:ROTOR_BRAKE)").expect("valid RPN");
        assert_eq!(command, "MF.SimVars.Set.1 (>K:ROTOR_BRAKE)");
        let encoded = encode_command(&command).expect("command should encode");
        assert_eq!(decode_message(&encoded), command);
        assert_eq!(encoded.len(), MESSAGE_SIZE);

        assert_eq!(execution_command(" \n "), Err("empty_code"));
        assert_eq!(
            execution_command("1\n2"),
            Err("command_must_be_printable_ascii")
        );
        assert_eq!(
            execution_command("é"),
            Err("command_must_be_printable_ascii")
        );
        assert!(execution_command(&"X".repeat(MAX_EXECUTION_CODE_SIZE)).is_ok());
        assert_eq!(
            execution_command(&"X".repeat(MAX_EXECUTION_CODE_SIZE + 1)),
            Err("command_too_long")
        );
        assert_eq!(
            encode_command(&"X".repeat(MESSAGE_SIZE)),
            Err("command_too_long")
        );
    }

    #[test]
    fn request_ids_reserve_mobiflight_responses_without_claiming_sdk_packets() {
        assert_ne!(INIT_COMMAND_DEFINE_ID, INIT_RESPONSE_DEFINE_ID);
        assert_ne!(RUNTIME_COMMAND_DEFINE_ID, RUNTIME_RESPONSE_DEFINE_ID);
        assert_ne!(INIT_COMMAND_DEFINE_ID, RUNTIME_COMMAND_DEFINE_ID);
        assert!(owns_response_packet(
            INIT_RESPONSE_REQUEST_ID,
            INIT_RESPONSE_DEFINE_ID
        ));
        assert!(owns_response_packet(
            RUNTIME_RESPONSE_REQUEST_ID,
            RUNTIME_RESPONSE_DEFINE_ID
        ));
        assert!(!owns_response_packet(3, 2));
        assert!(!owns_response_packet(INIT_RESPONSE_REQUEST_ID, 2));
    }

    #[test]
    fn handshake_requires_pong_and_unique_client_confirmation() {
        let start = Instant::now();
        let mut client = ClientState::new("Client_FlightFabric_123".to_string());
        client.start(start);
        assert_eq!(client.take_action(), Some(Action::ProbeInit));
        client.action_succeeded(Action::ProbeInit, start);
        assert!(!client.is_available());

        client.handle_response(INIT_RESPONSE_REQUEST_ID, "MF.Pong", start);
        assert_eq!(client.take_action(), Some(Action::RegisterRuntime));
        client.action_succeeded(Action::RegisterRuntime, start);
        client.handle_response(
            INIT_RESPONSE_REQUEST_ID,
            "MF.Clients.Add.Client_FlightFabric_123.Finished",
            start,
        );
        assert_eq!(client.take_action(), Some(Action::ConfigureRuntime));
        client.action_succeeded(Action::ConfigureRuntime, start);
        assert!(client.is_available());
        assert!(client
            .drain_statuses()
            .iter()
            .any(|status| status.state == "connected" && status.available));
    }

    #[test]
    fn handshake_rejects_partial_or_malformed_registration_responses() {
        let start = Instant::now();
        let mut client = ClientState::new("Client_FlightFabric_123".to_string());
        client.start(start);
        client.take_action();
        client.action_succeeded(Action::ProbeInit, start);
        client.handle_response(INIT_RESPONSE_REQUEST_ID, "MF.Pong", start);
        client.take_action();
        client.action_succeeded(Action::RegisterRuntime, start);

        for response in [
            "MF.Clients.Added.Client_FlightFabric_123",
            "MF.Clients.Add.Client_FlightFabric_123.Finished.extra",
            "MF.Clients.Add.Other_Client_FlightFabric_123.Finished",
        ] {
            client.handle_response(INIT_RESPONSE_REQUEST_ID, response, start);
            assert_eq!(client.take_action(), None);
            assert!(!client.is_available());
        }
    }

    #[test]
    fn handshake_timeout_marks_unavailable_and_schedules_retry() {
        let start = Instant::now();
        let mut client = ClientState::new("Client_FlightFabric_123".to_string());
        client.start(start);
        assert_eq!(client.take_action(), Some(Action::ProbeInit));
        client.action_succeeded(Action::ProbeInit, start);

        client.tick(start + HANDSHAKE_TIMEOUT + Duration::from_millis(1));
        assert!(!client.is_available());
        assert!(client
            .drain_statuses()
            .iter()
            .any(|status| status.error.as_deref() == Some("mobiflight_wasm_handshake_timeout")));

        client.tick(start + HANDSHAKE_TIMEOUT + RETRY_DELAY + Duration::from_millis(2));
        assert_eq!(client.take_action(), Some(Action::ProbeInit));
    }

    #[test]
    fn ready_client_stays_available_during_health_probe_and_drops_on_timeout() {
        let start = Instant::now();
        let mut client = ClientState::new("Client_FlightFabric_123".to_string());
        client.action_succeeded(Action::ConfigureRuntime, start);
        assert!(client.is_available());

        client.tick(start + HEALTH_CHECK_INTERVAL + Duration::from_millis(1));
        assert_eq!(client.take_action(), Some(Action::ProbeRuntime));
        client.action_succeeded(Action::ProbeRuntime, start + HEALTH_CHECK_INTERVAL);
        assert!(client.is_available());

        client.tick(start + HEALTH_CHECK_INTERVAL + HANDSHAKE_TIMEOUT + Duration::from_millis(1));
        assert!(!client.is_available());
        assert!(client
            .drain_statuses()
            .iter()
            .any(|status| status.error.as_deref() == Some("mobiflight_wasm_handshake_timeout")));
    }
