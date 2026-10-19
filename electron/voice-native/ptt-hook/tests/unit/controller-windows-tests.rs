
    use super::*;

    #[test]
    fn busy_input_progress_emits_rate_limited_heartbeats_without_timer_delivery() {
        let start = Instant::now();
        let mut heartbeat = Heartbeat::new(start);
        let emitted: Vec<_> = (0..=6000)
            .filter(|millis| heartbeat.due(start + Duration::from_millis(*millis)))
            .collect();
        assert_eq!(emitted, [1000, 2000, 3000, 4000, 5000, 6000]);
        // After a delayed/suspended loop, the first completed iteration emits
        // once. Subsequent busy iterations cannot flood the bounded output.
        assert!(heartbeat.due(start + Duration::from_secs(60)));
        assert!(!heartbeat.due(start + Duration::from_secs(60)));
        assert!(!heartbeat.due(start + Duration::from_millis(60_999)));
        assert!(heartbeat.due(start + Duration::from_secs(61)));
    }

    #[derive(Default)]
    struct CapturedOutput(Vec<String>);

    impl Output for CapturedOutput {
        fn emit(&mut self, fields: &str) -> Result<(), String> {
            self.0.push(fields.into());
            Ok(())
        }
    }

    fn held_device(path: &str) -> Device {
        let button = Button {
            report_id: 0,
            collection: 0,
            usage: 1,
        };
        let mut holds = Holds::default();
        holds.observe(0, BTreeSet::new());
        holds.observe(0, BTreeSet::from([button]));
        Device {
            path: path.into(),
            name: String::new(),
            vendor: 0,
            product: 0,
            preparsed: Vec::new(),
            report_length: 1,
            button_count: 1,
            map: BTreeMap::from([(0, button)]),
            data: Vec::new(),
            holds,
        }
    }

    #[test]
    fn unknown_handle_discovery_failure_preserves_the_owned_held_device() {
        let mut output = CapturedOutput::default();
        let mut controllers = Controllers {
            devices: HashMap::from([(1, held_device("selected-controller"))]),
            packet: Vec::new(),
            selected: Some("selected-controller".into()),
            button: None,
            output: &mut output,
        };
        // An invalid/new handle models a device disappearing during discovery;
        // it has no trusted identity and cannot own the tracked held button.
        controllers.arrive(ptr::null_mut()).unwrap();
        assert_eq!(controllers.devices.len(), 1);
        assert!(controllers.devices[&1].holds.is_pressed(Button {
            report_id: 0,
            collection: 0,
            usage: 1,
        }));
        drop(controllers);
        assert_eq!(output.0.len(), 1);
        assert!(output.0[0].contains("\"scope\":\"discovery\""));
        assert!(!output.0[0].contains("\"path\""));
        assert!(!output.0[0].contains("\"type\":\"cancel\""));
    }

    #[test]
    fn report_failure_cancels_and_quarantines_only_its_tracked_owner() {
        let mut output = CapturedOutput::default();
        let mut controllers = Controllers {
            devices: HashMap::from([
                (1, held_device("selected-controller")),
                (2, held_device("other-controller")),
            ]),
            packet: Vec::new(),
            selected: None,
            button: None,
            output: &mut output,
        };
        controllers
            .quarantine(1_usize as HANDLE, "Invalid report")
            .unwrap();
        assert!(!controllers.devices.contains_key(&1));
        assert!(controllers.devices[&2].holds.is_pressed(Button {
            report_id: 0,
            collection: 0,
            usage: 1,
        }));
        // Repeated input on the retired handle cannot emit another cancellation.
        controllers
            .quarantine(1_usize as HANDLE, "Invalid report")
            .unwrap();
        drop(controllers);
        assert_eq!(
            output.0,
            [
                "\"type\":\"cancel\",\"reason\":\"invalid-report\",\"path\":\"selected-controller\"",
                "\"type\":\"device-error\",\"scope\":\"device\",\"path\":\"selected-controller\",\"message\":\"Invalid report\"",
            ]
        );
    }

    #[test]
    fn discovery_budget_bounds_combined_devices_and_rejects_overflow() {
        assert!(within_discovery_budget(
            MAX_TOTAL_PREPARSED_BYTES - 8,
            MAX_TOTAL_BUTTONS - 1,
            8,
            1
        ));
        assert!(!within_discovery_budget(
            MAX_TOTAL_PREPARSED_BYTES - 8,
            0,
            16,
            1
        ));
        assert!(!within_discovery_budget(0, MAX_TOTAL_BUTTONS, 8, 1));
        assert!(!within_discovery_budget(usize::MAX, 0, 8, 1));
        assert!(!within_discovery_budget(0, usize::MAX, 8, 1));
        // One removed device frees its descriptor/button allowance immediately.
        assert!(within_discovery_budget(
            MAX_TOTAL_PREPARSED_BYTES - 1024,
            MAX_TOTAL_BUTTONS - 16,
            1024,
            16
        ));
    }

    #[test]
    fn input_buffer_rejects_untrusted_lengths_and_reuses_bounded_storage() {
        let mut buffer = Vec::new();
        for bytes in [
            0,
            size_of::<RAWINPUTHEADER>() - 1,
            MAX_PACKET_BYTES + 1,
            usize::MAX,
        ] {
            assert!(prepare_packet(&mut buffer, bytes).is_err());
            assert_eq!(buffer.capacity(), 0, "invalid sizes must not allocate");
        }
        prepare_packet(&mut buffer, MAX_PACKET_BYTES).unwrap();
        let pointer = buffer.as_ptr();
        let capacity = buffer.capacity();
        for index in 0..100_000 {
            prepare_packet(&mut buffer, size_of::<RAWINPUTHEADER>() + index % 1024).unwrap();
        }
        assert_eq!(buffer.as_ptr(), pointer, "steady input must not reallocate");
        assert_eq!(buffer.capacity(), capacity);
        assert_eq!(buffer.len() * 8, MAX_PACKET_BYTES);
    }

    fn range(report: u8, collection: u16, usage: u16, index: u16, count: u16) -> HIDP_BUTTON_CAPS {
        HIDP_BUTTON_CAPS {
            UsagePage: 9,
            ReportID: report,
            LinkCollection: collection,
            IsRange: true,
            IsAbsolute: true,
            Anonymous: HIDP_BUTTON_CAPS_0 {
                Range: HIDP_BUTTON_CAPS_0_0 {
                    UsageMin: usage,
                    UsageMax: usage + count - 1,
                    DataIndexMin: index,
                    DataIndexMax: index + count - 1,
                    ..Default::default()
                },
            },
            ..Default::default()
        }
    }

    #[test]
    fn descriptor_mapping_handles_large_ranges_and_separate_collections() {
        let map = button_map(&[range(1, 0, 1, 0, 400), range(2, 3, 1, 400, 4)]).unwrap();
        assert_eq!(map.len(), 404);
        assert_eq!(
            map[&399],
            Button {
                report_id: 1,
                collection: 0,
                usage: 400
            }
        );
        assert_eq!(
            map[&400],
            Button {
                report_id: 2,
                collection: 3,
                usage: 1
            }
        );
    }

    #[test]
    fn refuses_ambiguous_or_unsupported_descriptor_mappings() {
        assert!(button_map(&[range(1, 0, 1, 0, 2), range(2, 0, 1, 0, 2)]).is_err());
        assert!(button_map(&[range(1, 0, 1, 0, 2), range(1, 0, 1, 2, 2)]).is_err());
        assert!(button_map(&[range(1, 0, 1, 0, 4097)]).is_err());
        let mut relative = range(1, 0, 1, 0, 1);
        relative.IsAbsolute = false;
        assert!(button_map(&[relative]).is_err());
        let mut malformed = range(1, 0, 1, 0, 2);
        malformed.Anonymous.Range.DataIndexMax = 8;
        assert!(button_map(&[malformed]).is_err());
    }

    #[test]
    fn only_standard_controller_collections_are_eligible() {
        for usage in [4, 5, 8] {
            assert!(controller(1, usage));
        }
        for (page, usage) in [(1, 2), (1, 6), (12, 1), (0xff00, 4)] {
            assert!(!controller(page, usage));
        }
    }
