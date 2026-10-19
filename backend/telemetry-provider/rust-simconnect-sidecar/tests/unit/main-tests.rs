
        use super::*;

        #[test]
        fn subscription_cleanup_stops_streams_but_only_clears_one_shot_definitions() {
            let mut requests = [RequestMode::PollOnce, RequestMode::SimFrame]
                .into_iter()
                .enumerate()
                .map(|(index, mode)| ActiveRequest {
                    request_id: index as Dword + 10,
                    definition_id: index as Dword + 20,
                    mode,
                    poll_interval: Duration::from_millis(200),
                    last_requested_at: Instant::now(),
                })
                .collect();
            let calls = std::cell::RefCell::new(Vec::new());
            for _ in 0..2 {
                clear_subscription_requests(
                    &mut requests,
                    |request, definition| calls.borrow_mut().push(("stop", request, definition)),
                    |definition| calls.borrow_mut().push(("clear", 0, definition)),
                );
                assert!(requests.is_empty(), "retired requests must never be polled again");
            }
            assert_eq!(
                *calls.borrow(),
                vec![("clear", 0, 20), ("stop", 11, 21), ("clear", 0, 21)]
            );
        }

        fn test_subscription(key: &str, expression: &str) -> Subscription {
            Subscription {
                key: key.to_string(),
                expression: expression.to_string(),
                simvar: None,
                unit: Some("Number".to_string()),
                data_type: Some("float64".to_string()),
                isolated: false,
            }
        }

        fn test_command(command_type: &str, subscriptions: Vec<Subscription>) -> Command {
            Command {
                command_type: command_type.to_string(),
                request_id: Some(7),
                subscription_generation: None,
                subscriptions,
                aircraft: None,
                icao: None,
                region: None,
                name: None,
                code: None,
                unit: None,
                value: None,
                parameters: Vec::new(),
                data_type: None,
                poll_interval_ms: None,
                chunk_size: None,
            }
        }

        fn test_dispatch_context() -> DispatchContext {
            DispatchContext {
                definitions: HashMap::new(),
                values: HashMap::new(),
                value_updated_at: HashMap::new(),
                telemetry_sequence: 0,
                telemetry_updated_at: None,
                telemetry_updated_instant: None,
                connected: false,
                quit: false,
                sdk_aircraft: None,
                sdk_adapter: None,
                sdk_subscribed: false,
                mobiflight: None,
                library_spec: "test-simconnect".to_string(),
                facility_airport_requests: HashMap::new(),
                pending_messages: Vec::new(),
                input_event_write: None,
            }
        }

        fn aligned_callback_storage(byte_len: usize) -> Vec<u64> {
            vec![0; byte_len.div_ceil(size_of::<u64>())]
        }

        fn callback_bytes_mut(storage: &mut [u64]) -> &mut [u8] {
            // SAFETY: the returned byte slice covers the same initialized allocation,
            // and u8 has no alignment or invalid-bit-pattern requirements.
            unsafe {
                slice::from_raw_parts_mut(
                    storage.as_mut_ptr() as *mut u8,
                    std::mem::size_of_val(storage),
                )
            }
        }

        struct TestCommandState {
            subscriptions: Vec<Subscription>,
            subscription_kind: SubscriptionKind,
            simvar_chunk_size: usize,
            simvar_poll_interval: Duration,
            sdk_aircraft: Option<String>,
            subscription_generation: Option<u64>,
            last_sdk_subscribe_attempt: Instant,
        }

        impl TestCommandState {
            fn seeded() -> Self {
                Self {
                    subscriptions: vec![test_subscription("old", "(L:OLD)")],
                    subscription_kind: SubscriptionKind::Lvar,
                    simvar_chunk_size: 20,
                    simvar_poll_interval: Duration::from_millis(200),
                    sdk_aircraft: Some("test-clientdata".to_string()),
                    subscription_generation: Some(4),
                    last_sdk_subscribe_attempt: Instant::now(),
                }
            }

            fn handle(&mut self, command: Command) -> bool {
                handle_command(
                    command,
                    None,
                    &mut self.subscriptions,
                    &mut self.subscription_kind,
                    &mut self.simvar_chunk_size,
                    &mut self.simvar_poll_interval,
                    &mut self.sdk_aircraft,
                    &mut self.subscription_generation,
                    &mut self.last_sdk_subscribe_attempt,
                )
            }

            fn assert_seeded(&self) {
                assert_eq!(self.subscriptions.len(), 1);
                assert_eq!(self.subscriptions[0].key, "old");
                assert!(matches!(self.subscription_kind, SubscriptionKind::Lvar));
                assert_eq!(self.simvar_chunk_size, 20);
                assert_eq!(self.simvar_poll_interval, Duration::from_millis(200));
                assert_eq!(self.sdk_aircraft.as_deref(), Some("test-clientdata"));
                assert_eq!(self.subscription_generation, Some(4));
            }
        }

        #[test]
        fn input_event_callbacks_enforce_bounds_and_preserve_full_hashes() {
            use input_events::{Operation, PendingWrite, ENUMERATE_RECV, PARAMS_RECV};
            let mut context = test_dispatch_context();
            let mut write = PendingWrite::new("KNOB".into(), -1.0, Some(7), 100, Instant::now());
            write.expected_aircraft = Some("aircraft.cfg".into());
            assert_eq!(write.next_operation(Instant::now()), Some(Operation::Identity(100)));
            context.input_event_write = Some(write);
            let context_ptr = &mut context as *mut DispatchContext as *mut c_void;
            let mut identity: SimConnectRecvSystemState = unsafe { std::mem::zeroed() };
            identity.dw_id = SIMCONNECT_RECV_ID_SYSTEM_STATE;
            identity.dw_request_id = 100;
            for (dst, src) in identity.sz_string.iter_mut().zip(b"aircraft.cfg") {
                *dst = *src as _;
            }
            // SAFETY: complete initialized headers; the short length must be ignored.
            unsafe {
                dispatch_proc((&mut identity as *mut SimConnectRecvSystemState).cast(),
                    (size_of::<SimConnectRecvSystemState>() - 1) as Dword, context_ptr);
            }
            assert_eq!(context.input_event_write.as_mut().unwrap().next_operation(Instant::now()), None);
            unsafe {
                dispatch_proc((&mut identity as *mut SimConnectRecvSystemState).cast(),
                    size_of::<SimConnectRecvSystemState>() as Dword, context_ptr);
            }
            assert_eq!(context.input_event_write.as_mut().unwrap().next_operation(Instant::now()), Some(Operation::Enumerate(101)));
            let hash = 18_277_121_765_366_520_672_u64;
            let mut storage = aligned_callback_storage(104);
            let bytes = callback_bytes_mut(&mut storage);
            for (offset, value) in [(8, ENUMERATE_RECV), (12, 101), (16, 1), (24, 1)] {
                bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
            bytes[28..32].copy_from_slice(b"KNOB");
            bytes[92..100].copy_from_slice(&hash.to_le_bytes());
            // SAFETY: aligned allocation contains the entire declared callback payload.
            unsafe { dispatch_proc(storage.as_mut_ptr().cast(), 104, context_ptr); }
            assert_eq!(context.input_event_write.as_mut().unwrap().next_operation(Instant::now()), Some(Operation::Parameters(hash)));
            let mut storage = aligned_callback_storage(29);
            let bytes = callback_bytes_mut(&mut storage);
            bytes[8..12].copy_from_slice(&PARAMS_RECV.to_le_bytes());
            bytes[12..20].copy_from_slice(&hash.to_le_bytes());
            bytes[20..29].copy_from_slice(b";FLOAT64\0");
            unsafe { dispatch_proc(storage.as_mut_ptr().cast(), 29, context_ptr); }
            assert_eq!(context.input_event_write.as_mut().unwrap().next_operation(Instant::now()), Some(Operation::Identity(102)));
            identity.dw_request_id = 102;
            unsafe {
                dispatch_proc((&mut identity as *mut SimConnectRecvSystemState).cast(),
                    size_of::<SimConnectRecvSystemState>() as Dword, context_ptr);
            }
            assert_eq!(context.input_event_write.as_mut().unwrap().next_operation(Instant::now()), Some(Operation::Write(hash, -1.0)));
        }

        #[test]
        fn callback_rejects_null_and_short_common_headers() {
            let mut context = test_dispatch_context();
            let mut message = SimConnectRecv {
                dw_size: size_of::<SimConnectRecv>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_OPEN,
            };

            // SAFETY: this deliberately exercises the callback's documented null guards.
            unsafe {
                dispatch_proc(
                    ptr::null_mut(),
                    size_of::<SimConnectRecv>() as Dword,
                    &mut context as *mut DispatchContext as *mut c_void,
                );
                dispatch_proc(
                    &mut message,
                    size_of::<SimConnectRecv>() as Dword,
                    ptr::null_mut(),
                );
            }
            assert!(!context.connected);

            // SAFETY: message and context remain live for the call; cb_data is
            // intentionally one byte short to characterize the size guard.
            unsafe {
                dispatch_proc(
                    &mut message,
                    (size_of::<SimConnectRecv>() - 1) as Dword,
                    &mut context as *mut DispatchContext as *mut c_void,
                );
            }
            assert!(!context.connected);

            // SAFETY: both pointers reference complete, live values for the call.
            unsafe {
                dispatch_proc(
                    &mut message,
                    size_of::<SimConnectRecv>() as Dword,
                    &mut context as *mut DispatchContext as *mut c_void,
                );
            }
            assert!(context.connected);
        }

        #[test]
        fn fixed_callback_variants_require_complete_headers() {
            let mut context = test_dispatch_context();
            let context_ptr = &mut context as *mut DispatchContext as *mut c_void;
            let mut exception = SimConnectRecvException {
                dw_size: size_of::<SimConnectRecvException>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_EXCEPTION,
                dw_exception: 5,
                dw_send_id: 17,
                dw_index: 3,
            };

            // SAFETY: the backing value is complete; the shorter cb_data is intentional.
            unsafe {
                dispatch_proc(
                    &mut exception as *mut SimConnectRecvException as *mut SimConnectRecv,
                    (size_of::<SimConnectRecvException>() - 1) as Dword,
                    context_ptr,
                );
            }
            assert!(context.pending_messages.is_empty());

            // SAFETY: exception and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut exception as *mut SimConnectRecvException as *mut SimConnectRecv,
                    size_of::<SimConnectRecvException>() as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages[0]["type"], "exception");
            assert_eq!(context.pending_messages[0]["sendId"], 17);

            let mut event = SimConnectRecvEvent {
                dw_size: size_of::<SimConnectRecvEvent>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_EVENT,
                u_group_id: 0,
                u_event_id: EVENT_SIM_START,
                dw_data: 9,
            };
            // SAFETY: event and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut event as *mut SimConnectRecvEvent as *mut SimConnectRecv,
                    size_of::<SimConnectRecvEvent>() as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages[1]["type"], "systemEvent");
            assert_eq!(context.pending_messages[1]["name"], "SimStart");

            let mut state = SimConnectRecvSystemState {
                dw_size: size_of::<SimConnectRecvSystemState>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_SYSTEM_STATE,
                dw_request_id: SYSTEM_REQUEST_AIRCRAFT_LOADED,
                dw_integer: 1,
                f_float: 2.5,
                sz_string: [0; 260],
            };
            for (slot, byte) in state.sz_string.iter_mut().zip(b"  C172  \0") {
                *slot = *byte as std::ffi::c_char;
            }
            // SAFETY: state and context are complete and live for both calls.
            unsafe {
                dispatch_proc(
                    &mut state as *mut SimConnectRecvSystemState as *mut SimConnectRecv,
                    (size_of::<SimConnectRecvSystemState>() - 1) as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages.len(), 2);

            // SAFETY: state and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut state as *mut SimConnectRecvSystemState as *mut SimConnectRecv,
                    size_of::<SimConnectRecvSystemState>() as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages[2]["type"], "systemState");
            assert_eq!(context.pending_messages[2]["string"], "C172");
        }

        #[test]
        fn simobject_callback_requires_complete_payload_and_decodes_supported_types() {
            let definition_id = 41;
            let mut context = test_dispatch_context();
            context.definitions.insert(
                definition_id,
                vec![
                    DefinitionItem {
                        key: "integer".to_string(),
                        data_type: SIMCONNECT_DATATYPE_INT32,
                    },
                    DefinitionItem {
                        key: "float32".to_string(),
                        data_type: SIMCONNECT_DATATYPE_FLOAT32,
                    },
                    DefinitionItem {
                        key: "text".to_string(),
                        data_type: SIMCONNECT_DATATYPE_STRING256,
                    },
                    DefinitionItem {
                        key: "float64".to_string(),
                        data_type: SIMCONNECT_DATATYPE_FLOAT64,
                    },
                ],
            );

            let mut payload = Vec::new();
            payload.extend_from_slice(&(-7_i32).to_ne_bytes());
            payload.extend_from_slice(&(1.25_f32).to_ne_bytes());
            let mut text = [0_u8; 256];
            text[..10].copy_from_slice(b"  hello  \0");
            payload.extend_from_slice(&text);
            payload.extend_from_slice(&(42.5_f64).to_ne_bytes());

            let callback_len = simobject_data_offset() + payload.len();
            let mut storage = aligned_callback_storage(callback_len);
            {
                // SAFETY: u64 storage is sufficiently aligned and large enough for
                // the fixed callback header.
                let message =
                    unsafe { &mut *(storage.as_mut_ptr() as *mut SimConnectRecvSimObjectData) };
                message.dw_size = callback_len as Dword;
                message.dw_version = 0;
                message.dw_id = SIMCONNECT_RECV_ID_SIMOBJECT_DATA;
                message.dw_request_id = 11;
                message.dw_object_id = SIMCONNECT_OBJECT_ID_USER;
                message.dw_define_id = definition_id;
                message.dw_flags = 0;
                message.dw_entry_number = 0;
                message.dw_out_of = 1;
                message.dw_define_count = 4;
            }
            callback_bytes_mut(&mut storage)
                [simobject_data_offset()..simobject_data_offset() + payload.len()]
                .copy_from_slice(&payload);

            let context_ptr = &mut context as *mut DispatchContext as *mut c_void;
            // SAFETY: storage contains a complete callback header and payload;
            // cb_data is intentionally one byte short for the first call.
            unsafe {
                dispatch_proc(
                    storage.as_mut_ptr() as *mut SimConnectRecv,
                    (callback_len - 1) as Dword,
                    context_ptr,
                );
            }
            assert!(context.values.is_empty());
            assert_eq!(context.telemetry_sequence, 0);

            // SAFETY: storage contains the complete callback bytes described by cb_data.
            unsafe {
                dispatch_proc(
                    storage.as_mut_ptr() as *mut SimConnectRecv,
                    callback_len as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.values["integer"], json!(-7));
            assert_eq!(context.values["float32"], json!(1.25));
            assert_eq!(context.values["text"], json!("hello"));
            assert_eq!(context.values["float64"], json!(42.5));
            assert_eq!(context.value_updated_at.len(), 4);
            let received_at = context.value_updated_at["float64"].clone();
            context.mark_telemetry_update();
            assert_eq!(
                context.value_updated_at["float64"], received_at,
                "unrelated telemetry must not refresh a cached field"
            );
            assert_eq!(context.telemetry_sequence, 2);
            assert!(context.telemetry_updated_at.is_some());
            assert!(context.telemetry_updated_instant.is_some());
            context.reset_telemetry_stream();
            assert!(context.value_updated_at.is_empty());
        }

        #[test]
        fn facility_end_callback_requires_full_header_before_completion() {
            let request_id = 53;
            let mut context = test_dispatch_context();
            context.facility_airport_requests.insert(
                request_id,
                facilities::AirportFacilityRequest::new(700, "YSCB", "AU"),
            );
            let mut message = SimConnectRecvFacilityDataEnd {
                dw_size: size_of::<SimConnectRecvFacilityDataEnd>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_FACILITY_DATA_END,
                request_id,
            };
            let context_ptr = &mut context as *mut DispatchContext as *mut c_void;

            // SAFETY: the backing value is complete; cb_data is intentionally short.
            unsafe {
                dispatch_proc(
                    &mut message as *mut SimConnectRecvFacilityDataEnd as *mut SimConnectRecv,
                    (size_of::<SimConnectRecvFacilityDataEnd>() - 1) as Dword,
                    context_ptr,
                );
            }
            assert!(context.facility_airport_requests.contains_key(&request_id));
            assert!(context.pending_messages.is_empty());

            // SAFETY: message and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut message as *mut SimConnectRecvFacilityDataEnd as *mut SimConnectRecv,
                    size_of::<SimConnectRecvFacilityDataEnd>() as Dword,
                    context_ptr,
                );
            }
            assert!(!context.facility_airport_requests.contains_key(&request_id));
            assert_eq!(context.pending_messages.len(), 1);
            assert_eq!(context.pending_messages[0]["type"], "facilityAirport");
            assert_eq!(context.pending_messages[0]["requestId"], 700);
        }

        #[test]
        fn stop_command_is_the_only_false_result_and_preserves_state() {
            let mut state = TestCommandState::seeded();
            assert!(!state.handle(test_command("stop", Vec::new())));
            state.assert_seeded();
        }

        #[test]
        fn unknown_command_is_ignored_without_mutating_state() {
            let mut state = TestCommandState::seeded();
            assert!(state.handle(test_command("futureCommand", Vec::new())));
            state.assert_seeded();
        }

        #[test]
        fn inactive_disconnect_clears_only_sdk_stream_state() {
            let mut state = TestCommandState::seeded();
            assert!(state.handle(test_command("disconnect", Vec::new())));
            assert!(state.subscriptions.is_empty());
            assert!(matches!(state.subscription_kind, SubscriptionKind::Lvar));
            assert_eq!(state.simvar_chunk_size, 20);
            assert_eq!(state.simvar_poll_interval, Duration::from_millis(200));
            assert_eq!(state.sdk_aircraft, None);
            assert_eq!(state.subscription_generation, None);
        }

        #[test]
        fn unsupported_sdk_connect_preserves_existing_state() {
            let mut state = TestCommandState::seeded();
            let target = "__missing_characterization_target__";
            assert!(sdk::resolve_clientdata_adapter(target).is_none());
            let mut command = test_command("connect", Vec::new());
            command.aircraft = Some(target.to_string());

            assert!(state.handle(command));
            state.assert_seeded();
        }

        #[test]
        fn successful_dynamic_load_is_reused_across_connection_attempts() {
            let mut cached = None;
            let mut load_attempts = 0usize;

            let first = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Ok::<_, &'static str>(17u32)
            })
            .expect("initial load should succeed");
            let first_identity = Rc::downgrade(&first);
            drop(first); // Mirrors a failed connection attempt releasing its API reference.
            let second = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Ok::<_, &'static str>(23u32)
            })
            .expect("cached load should succeed");

            assert_eq!(load_attempts, 1);
            assert_eq!(*second, 17);
            assert!(first_identity
                .upgrade()
                .is_some_and(|first| Rc::ptr_eq(&first, &second)));
        }

        #[test]
        fn failed_dynamic_load_remains_retryable() {
            let mut cached: Option<Rc<u32>> = None;
            let mut load_attempts = 0usize;

            let first = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Err::<u32, _>("not ready")
            });
            assert_eq!(first.expect_err("initial load should fail"), "not ready");
            assert!(cached.is_none());

            let second = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Ok::<_, &'static str>(29u32)
            })
            .expect("later load should be retried");

            assert_eq!(load_attempts, 2);
            assert_eq!(*second, 29);
            assert!(cached.is_some());
        }

        #[test]
        fn connection_probe_polling_is_bounded_and_stops_on_success() {
            let mut polls = 0usize;
            let mut waits = 0usize;
            let timed_out = poll_connection_probe(
                3,
                Duration::from_millis(1),
                || {
                    polls += 1;
                    Ok::<_, &'static str>(None)
                },
                |_| waits += 1,
            )
            .expect("polling should not fail");
            assert_eq!(timed_out, None);
            assert_eq!(polls, 3);
            assert_eq!(waits, 2);

            let completed = poll_connection_probe(
                3,
                Duration::from_millis(1),
                || Ok::<_, &'static str>(Some(true)),
                |_| panic!("completed probe must not wait"),
            )
            .expect("completed probe should be observed");
            assert_eq!(completed, Some(true));
        }

        #[test]
        fn dispatch_failures_require_a_sustained_grace_period_and_reset_on_success() {
            let start = Instant::now();
            let mut guard = DispatchFailureGuard::default();

            assert!(!guard.record_failure(start));
            assert!(
                !guard.record_failure(start + DISPATCH_FAILURE_GRACE - Duration::from_millis(1))
            );
            guard.record_success();
            assert!(!guard.record_failure(start + DISPATCH_FAILURE_GRACE));
            assert!(guard.record_failure(start + DISPATCH_FAILURE_GRACE * 2));
        }

        #[test]
        fn telemetry_silence_requires_a_real_prior_update_and_full_grace_period() {
            let start = Instant::now();

            assert!(!telemetry_silence_expired(
                None,
                start + TELEMETRY_SILENCE_GRACE
            ));
            assert!(!telemetry_silence_expired(
                Some(start),
                start + TELEMETRY_SILENCE_GRACE - Duration::from_millis(1),
            ));
            assert!(telemetry_silence_expired(
                Some(start),
                start + TELEMETRY_SILENCE_GRACE,
            ));
        }

        #[test]
        fn sdk_client_data_waits_for_publisher_updates_and_retries_only_failed_subscriptions() {
            assert_eq!(
                sdk_client_data_period(sdk::ClientDataPeriod::OnSet),
                SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET
            );
            assert_eq!(
                sdk_client_data_period(sdk::ClientDataPeriod::VisualFrame),
                SIMCONNECT_CLIENT_DATA_PERIOD_VISUAL_FRAME
            );

            let start = Instant::now();
            assert!(!sdk_subscription_retry_due(
                true,
                false,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL - Duration::from_millis(1),
            ));
            assert!(sdk_subscription_retry_due(
                true,
                false,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL,
            ));
            assert!(!sdk_subscription_retry_due(
                true,
                true,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL,
            ));
            assert!(!sdk_subscription_retry_due(
                false,
                false,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL,
            ));

            let attempted_at = start + Duration::from_secs(30);
            let mut last_attempt = start;
            let mut connect_calls = 0usize;
            let result = attempt_sdk_subscription(&mut last_attempt, attempted_at, || {
                connect_calls += 1;
                Err("synchronous_failure".to_string())
            });
            assert_eq!(result, Err("synchronous_failure".to_string()));
            assert_eq!(connect_calls, 1);
            assert_eq!(last_attempt, attempted_at);
            assert!(!sdk_subscription_retry_due(
                true,
                false,
                last_attempt,
                attempted_at + SDK_SUBSCRIBE_RETRY_INTERVAL - Duration::from_millis(1),
            ));
        }

        #[test]
        fn replacement_stream_is_not_touched_when_sdk_disconnect_fails() {
            #[derive(Default)]
            struct ReplacementProbe {
                disconnect_calls: usize,
                replacement_calls: usize,
            }

            let mut failed = ReplacementProbe::default();
            let result = replace_stream_after_sdk_disconnect(
                &mut failed,
                |probe| {
                    probe.disconnect_calls += 1;
                    Err("stop_failed".to_string())
                },
                |probe| {
                    probe.replacement_calls += 1;
                },
            );
            assert_eq!(result, Err("stop_failed".to_string()));
            assert_eq!(failed.disconnect_calls, 1);
            assert_eq!(failed.replacement_calls, 0);

            let mut succeeded = ReplacementProbe::default();
            let result = replace_stream_after_sdk_disconnect(
                &mut succeeded,
                |probe| {
                    probe.disconnect_calls += 1;
                    Ok(())
                },
                |probe| {
                    probe.replacement_calls += 1;
                    42
                },
            );
            assert_eq!(result, Ok(42));
            assert_eq!(succeeded.disconnect_calls, 1);
            assert_eq!(succeeded.replacement_calls, 1);
        }

        #[test]
        fn sdk_same_adapter_connect_is_idempotent_only_with_its_registered_definition() {
            assert!(sdk_subscription_is_current(
                true,
                Some("clientdata-manifest:test-one"),
                "CLIENTDATA-MANIFEST:TEST-ONE",
                true,
            ));
            assert!(!sdk_subscription_is_current(
                false,
                Some("clientdata-manifest:test-one"),
                "clientdata-manifest:test-one",
                true,
            ));
            assert!(!sdk_subscription_is_current(
                true,
                Some("clientdata-manifest:test-two"),
                "clientdata-manifest:test-one",
                true,
            ));
            assert!(!sdk_subscription_is_current(
                true,
                Some("clientdata-manifest:test-one"),
                "clientdata-manifest:test-one",
                false,
            ));
        }

        #[test]
        fn sdk_clientdata_mapping_is_registered_once_and_rejects_remaps() {
            let mut mappings = HashMap::new();
            assert_eq!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "TEST_SDK_Data"),
                Ok(true),
            );

            mappings.insert(0x5445_5354, "TEST_SDK_Data".to_string());
            assert_eq!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "TEST_SDK_Data"),
                Ok(false),
            );
            assert_eq!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "test_sdk_data"),
                Ok(false),
                "SimConnect ClientData names are compared case-insensitively",
            );
            assert!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "TEST_OTHER_Data",)
                    .is_err()
            );
            assert!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5355, "test_sdk_data",)
                    .is_err()
            );
        }

        #[test]
        fn sdk_clientdata_ids_are_sidecar_owned_stable_and_distinct() {
            let mut allocations = HashMap::new();
            let mut next_slot = 1;
            let first = allocate_sdk_client_data_ids(
                &mut allocations,
                &mut next_slot,
                "VENDOR_SDK_Data",
            )
            .expect("first allocation");
            let repeated = allocate_sdk_client_data_ids(
                &mut allocations,
                &mut next_slot,
                "vendor_sdk_data",
            )
            .expect("case-insensitive repeat");
            let second = allocate_sdk_client_data_ids(
                &mut allocations,
                &mut next_slot,
                "OTHER_SDK_Data",
            )
            .expect("second allocation");

            assert_eq!(first, repeated);
            assert_ne!(first.data_id, second.data_id);
            assert_ne!(first.define_id, second.define_id);
            assert_ne!(first.request_id, second.request_id);
            assert_eq!(first.data_id, SDK_CLIENT_DATA_ID_BASE + 1);
            assert_eq!(first.define_id, SDK_CLIENT_DATA_DEFINITION_ID_BASE + 1);
            assert_eq!(first.request_id, SDK_CLIENT_DATA_REQUEST_ID_BASE + 1);
        }

        #[test]
        fn hresult_success_uses_the_canonical_windows_sign_test() {
            assert!(hresult_ok(S_OK as Hresult));
            assert!(
                hresult_ok(1),
                "non-negative success statuses must be accepted"
            );
            assert!(hresult_ok(i32::MAX));
            assert!(!hresult_ok(0x8000_4005_u32 as Hresult));
            assert!(!hresult_ok(i32::MIN));
        }

        #[test]
        fn snapshots_require_a_new_real_telemetry_sequence_and_receive_timestamp() {
            assert!(!has_unemitted_telemetry_update(
                4,
                4,
                Some("2026-07-15T00:00:00Z")
            ));
            assert!(!has_unemitted_telemetry_update(5, 4, None));
            assert!(has_unemitted_telemetry_update(
                5,
                4,
                Some("2026-07-15T00:00:00Z"),
            ));
        }

        #[test]
        fn nested_connection_probe_is_bound_to_the_exact_spawning_sidecar_pid() {
            assert_eq!(
                connection_probe_owner_arg(4242),
                "--ff-owner-pid=4242"
            );
        }

        #[test]
        fn invalid_subscription_command_preserves_existing_sidecar_state() {
            let mut subscriptions = vec![test_subscription("old", "(L:OLD)")];
            let mut subscription_kind = SubscriptionKind::Lvar;
            let mut simvar_chunk_size = 20usize;
            let mut simvar_poll_interval = Duration::from_millis(200);
            let mut sdk_aircraft = Some("test-clientdata".to_string());
            let mut subscription_generation = Some(4);
            let mut last_sdk_subscribe_attempt = Instant::now();
            let command = test_command(
                "setSimVars",
                vec![test_subscription("bad key", "AIRSPEED INDICATED")],
            );

            assert!(handle_command(
                command,
                None,
                &mut subscriptions,
                &mut subscription_kind,
                &mut simvar_chunk_size,
                &mut simvar_poll_interval,
                &mut sdk_aircraft,
                &mut subscription_generation,
                &mut last_sdk_subscribe_attempt,
            ));
            assert_eq!(subscriptions.len(), 1);
            assert_eq!(subscriptions[0].key, "old");
            assert!(matches!(subscription_kind, SubscriptionKind::Lvar));
            assert_eq!(simvar_chunk_size, 20);
            assert_eq!(simvar_poll_interval, Duration::from_millis(200));
            assert_eq!(sdk_aircraft.as_deref(), Some("test-clientdata"));
            assert_eq!(subscription_generation, Some(4));
        }

        #[test]
        fn valid_simvar_command_updates_inactive_state_and_clamps_poll_settings() {
            let mut subscriptions = Vec::new();
            let mut subscription_kind = SubscriptionKind::Lvar;
            let mut simvar_chunk_size = 20usize;
            let mut simvar_poll_interval = Duration::from_millis(200);
            let mut sdk_aircraft = Some("test-clientdata".to_string());
            let mut subscription_generation = Some(4);
            let mut last_sdk_subscribe_attempt = Instant::now();
            let mut command = test_command(
                "setSimVars",
                vec![test_subscription("ias", "AIRSPEED INDICATED")],
            );
            command.chunk_size = Some(500);
            command.poll_interval_ms = Some(1);

            assert!(handle_command(
                command,
                None,
                &mut subscriptions,
                &mut subscription_kind,
                &mut simvar_chunk_size,
                &mut simvar_poll_interval,
                &mut sdk_aircraft,
                &mut subscription_generation,
                &mut last_sdk_subscribe_attempt,
            ));
            assert_eq!(subscriptions.len(), 1);
            assert_eq!(subscriptions[0].key, "ias");
            assert!(matches!(subscription_kind, SubscriptionKind::Simvar));
            assert_eq!(simvar_chunk_size, 64);
            assert_eq!(simvar_poll_interval, Duration::from_millis(50));
            assert_eq!(sdk_aircraft, None);
            assert_eq!(subscription_generation, None);
        }

        #[test]
        fn lvar_command_stores_generation_and_stream_helpers_scope_it_to_lvars() {
            let mut subscriptions = Vec::new();
            let mut subscription_kind = SubscriptionKind::Simvar;
            let mut simvar_chunk_size = 20usize;
            let mut simvar_poll_interval = Duration::from_millis(200);
            let mut sdk_aircraft = Some("test-clientdata".to_string());
            let mut subscription_generation = None;
            let mut last_sdk_subscribe_attempt = Instant::now();
            let mut command = test_command(
                "setSubscriptions",
                vec![test_subscription("switch", "(L:SWITCH)")],
            );
            command.subscription_generation = Some(9);

            assert!(handle_command(
                command,
                None,
                &mut subscriptions,
                &mut subscription_kind,
                &mut simvar_chunk_size,
                &mut simvar_poll_interval,
                &mut sdk_aircraft,
                &mut subscription_generation,
                &mut last_sdk_subscribe_attempt,
            ));
            assert_eq!(subscription_generation, Some(9));
            assert!(matches!(subscription_kind, SubscriptionKind::Lvar));
            assert_eq!(
                lvar_snapshot_subscription_generation(
                    SubscriptionKind::Lvar,
                    false,
                    subscription_generation,
                ),
                Some(9)
            );
            assert_eq!(
                lvar_snapshot_subscription_generation(
                    SubscriptionKind::Simvar,
                    false,
                    subscription_generation,
                ),
                None
            );
            assert_eq!(
                lvar_snapshot_subscription_generation(
                    SubscriptionKind::Lvar,
                    true,
                    subscription_generation,
                ),
                None
            );

            let payload = status_payload(
                "subscriptions_updated",
                None,
                Some(1),
                None,
                subscription_generation,
            );
            assert_eq!(payload["subscriptionGeneration"], json!(9));
        }

        #[test]
        fn facility_identifiers_are_bounded_ascii_tokens() {
            assert_eq!(normalize_facility_icao(" yscb ").as_deref(), Some("YSCB"));
            assert_eq!(normalize_facility_region("us-ca").as_deref(), Some("US-CA"));
            assert_eq!(normalize_facility_icao(""), None);
            assert_eq!(normalize_facility_icao("TOO-LONG-ICAO"), None);
            assert_eq!(normalize_facility_icao("BAD/ICAO"), None);
            assert_eq!(normalize_facility_region("REGION_TOO_LONG"), None);
        }

        #[test]
        fn session_collection_limits_preserve_normal_capacity_and_reject_excess() {
            let mut messages = Vec::new();
            assert!(push_bounded(&mut messages, json!(1), 2));
            assert!(push_bounded(&mut messages, json!(2), 2));
            assert!(!push_bounded(&mut messages, json!(3), 2));
            assert_eq!(messages, vec![json!(1), json!(2)]);

            let mut facility_requests = HashMap::new();
            for request_id in 0..MAX_CONCURRENT_FACILITY_REQUESTS as Dword {
                facility_requests.insert(
                    request_id,
                    facilities::AirportFacilityRequest::new(
                        u64::from(request_id),
                        "TEST",
                        "",
                    ),
                );
            }
            assert!(!can_start_facility_request(&facility_requests));

            let mapped_events = (0..MAX_MAPPED_EVENTS as Dword)
                .map(|event_id| (format!("EVENT_{event_id}"), event_id))
                .collect();
            assert!(!can_map_event(&mapped_events));
        }
