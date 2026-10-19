
    use super::*;
    const HASH: u64 = 18_277_121_765_366_520_672;
    fn pending() -> PendingWrite {
        let mut write = PendingWrite::new("KNOB".into(), -1.0, Some(7), 100, Instant::now());
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Identity(100))
        );
        write.identity(100, "aircraft.cfg");
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Enumerate(101))
        );
        write
    }
    fn page(index: u32, total: u32, names: &[(&str, u32)]) -> Vec<u8> {
        let mut packet = vec![0; 28 + names.len() * 76 + 76]; // SDK trailing slot
        for (offset, value) in [
            (12, 101),
            (16, names.len() as u32),
            (20, index),
            (24, total),
        ] {
            packet[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, (name, kind)) in names.iter().enumerate() {
            let start = 28 + index * 76;
            packet[start..start + name.len()].copy_from_slice(name.as_bytes());
            packet[start + 64..start + 72].copy_from_slice(&HASH.to_le_bytes());
            packet[start + 72..start + 76].copy_from_slice(&kind.to_le_bytes());
        }
        packet
    }
    fn params(text: &str) -> Vec<u8> {
        let mut packet = vec![0; 20];
        packet[12..20].copy_from_slice(&HASH.to_le_bytes());
        packet.extend_from_slice(text.as_bytes());
        packet.push(0);
        packet
    }
    #[test]
    fn inventory_preserves_full_hash_and_never_produces_a_write() {
        let mut read = PendingWrite::inventory(Some(7), 100, Instant::now());
        assert_eq!(
            read.next_operation(Instant::now()),
            Some(Operation::Identity(100))
        );
        read.identity(100, "aircraft.cfg");
        assert_eq!(
            read.next_operation(Instant::now()),
            Some(Operation::Enumerate(101))
        );
        read.packet(ENUMERATE_RECV, &page(1, 2, &[("KNOB", 0)]));
        assert_eq!(read.next_operation(Instant::now()), None);
        read.packet(ENUMERATE_RECV, &page(0, 2, &[("STRING_EVENT", 1)]));
        assert_eq!(
            read.next_operation(Instant::now()),
            Some(Operation::Identity(102))
        );
        read.identity(102, "aircraft.cfg");
        assert_eq!(read.next_operation(Instant::now()), None);
        assert!(read.inventory_complete());
        assert_eq!(
            read.inventory.unwrap()[0],
            ("KNOB".into(), HASH.to_string(), 0)
        );
    }
    #[test]
    fn inventory_rejects_duplicate_names_and_identity_changes() {
        for changed in [false, true] {
            let mut read = PendingWrite::inventory(None, 100, Instant::now());
            read.next_operation(Instant::now());
            read.identity(100, "aircraft.cfg");
            read.next_operation(Instant::now());
            if changed {
                read.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0)]));
                read.next_operation(Instant::now());
                read.identity(102, "other.cfg");
            } else {
                read.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0), ("KNOB", 0)]));
            }
            assert!(read.error.is_some());
            assert!(!read.inventory_complete());
            assert_eq!(read.next_operation(Instant::now()), None);
        }
    }
    #[test]
    fn resolves_all_pages_and_params_then_rechecks_aircraft_before_write() {
        let mut write = pending();
        write.packet(ENUMERATE_RECV, &page(1, 2, &[("KNOB", 0)]));
        assert_eq!(write.next_operation(Instant::now()), None);
        write.packet(ENUMERATE_RECV, &page(0, 2, &[("OTHER", 0)]));
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Parameters(HASH))
        );
        write.packet(PARAMS_RECV, &params(";FLOAT64"));
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Identity(102))
        );
        write.identity(100, "aircraft.cfg"); // stale preflight response cannot authorize a write
        assert_eq!(write.next_operation(Instant::now()), None);
        write.identity(102, "aircraft.cfg");
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Write(HASH, -1.0))
        );
        assert_eq!(write.next_operation(Instant::now()), None);
    }
    #[test]
    fn rejects_unknown_ambiguous_string_and_truncated_descriptors() {
        for (packet, error) in [
            (page(0, 1, &[("OTHER", 0)]), "input_event_not_found"),
            (
                page(0, 1, &[("KNOB", 0), ("KNOB", 0)]),
                "input_event_ambiguous_name",
            ),
            (page(0, 1, &[("KNOB", 1)]), "input_event_unsupported_type"),
            (
                page(0, 1, &[("KNOB", 0)])[..103].to_vec(),
                "input_event_invalid_enumeration",
            ),
        ] {
            let mut write = pending();
            write.packet(ENUMERATE_RECV, &packet);
            assert_eq!(write.error.as_deref(), Some(error));
            assert_eq!(write.next_operation(Instant::now()), None);
        }
    }
    #[test]
    fn rejects_duplicate_pages_wrong_parameters_aircraft_change_and_timeout() {
        let mut duplicate = pending();
        duplicate.packet(ENUMERATE_RECV, &page(0, 2, &[("KNOB", 0)]));
        duplicate.packet(ENUMERATE_RECV, &page(0, 2, &[("KNOB", 0)]));
        assert!(duplicate.error.is_some());
        for contract in [";FLOAT64;FLOAT64", ";STRING", ""] {
            let mut write = pending();
            write.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0)]));
            write.next_operation(Instant::now());
            write.packet(PARAMS_RECV, &params(contract));
            assert_eq!(
                write.error.as_deref(),
                Some("input_event_unsupported_parameters")
            );
        }
        let mut write = pending();
        write.packet(ENUMERATE_RECV, &page(0, 1, &[("KNOB", 0)]));
        write.next_operation(Instant::now());
        write.packet(PARAMS_RECV, &params(";FLOAT64"));
        write.next_operation(Instant::now());
        write.identity(102, "other.cfg");
        assert_eq!(write.next_operation(Instant::now()), None);
        assert_eq!(write.error.as_deref(), Some("input_event_aircraft_changed"));
        let mut timeout = pending();
        assert_eq!(
            timeout.next_operation(Instant::now() + Duration::from_secs(3)),
            None
        );
        assert_eq!(
            timeout.error.as_deref(),
            Some("input_event_resolution_timeout")
        );
    }
    #[test]
    fn rejects_a_different_requested_aircraft_before_enumeration() {
        let mut write = PendingWrite::new("KNOB".into(), 1.0, Some(7), 100, Instant::now());
        write.expected_aircraft = Some("expected/aircraft.cfg".into());
        assert_eq!(
            write.next_operation(Instant::now()),
            Some(Operation::Identity(100))
        );
        write.identity(100, "other/aircraft.cfg");
        assert_eq!(write.error.as_deref(), Some("input_event_aircraft_changed"));
        assert_eq!(write.next_operation(Instant::now()), None);
    }

    #[test]
    fn rejects_matching_exceptions_and_lifecycle_changes() {
        let mut write = pending();
        write.record_packet(77);
        write.exception(76);
        assert!(write.error.is_none());
        write.exception(77);
        assert_eq!(write.next_operation(Instant::now()), None);
        let mut write = pending();
        write.invalidate();
        assert_eq!(write.next_operation(Instant::now()), None);
    }
