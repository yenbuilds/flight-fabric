
    use super::*;
    use std::mem::offset_of;

    fn test_runway() -> DecodedRunway {
        DecodedRunway {
            latitude_deg: 0.0,
            longitude_deg: 0.0,
            altitude_m: 0.0,
            heading_deg: 0.0,
            length_m: 1000.0,
            width_m: 30.0,
            surface: 0,
            primary_number: 1,
            primary_designator: 0,
            secondary_number: 19,
            secondary_designator: 0,
            pavements: Vec::new(),
        }
    }

    fn c_char_array<const N: usize>(value: &str) -> [c_char; N] {
        let mut output = [0; N];
        for (slot, byte) in output.iter_mut().zip(value.bytes()) {
            *slot = byte as c_char;
        }
        output
    }

    #[test]
    fn facility_payload_reader_rejects_each_truncated_layout() {
        let message = SimConnectRecvFacilityData {
            dw_size: size_of::<SimConnectRecvFacilityData>() as Dword,
            dw_version: 0,
            dw_id: SIMCONNECT_RECV_ID_FACILITY_DATA,
            user_request_id: 1,
            unique_request_id: 2,
            parent_unique_request_id: 0,
            facility_type: FACILITY_DATA_AIRPORT,
            is_list_item: 0,
            item_index: 0,
            list_size: 1,
            data: 0,
        };

        // SAFETY: each call deliberately supplies a length smaller than T, so
        // the decoder must return before reading the trailing payload.
        unsafe {
            assert!(read_facility_payload::<AirportPayload>(
                &message,
                size_of::<AirportPayload>() - 1,
            )
            .is_none());
            assert!(read_facility_payload::<RunwayPayload>(
                &message,
                size_of::<RunwayPayload>() - 1,
            )
            .is_none());
            assert!(read_facility_payload::<PavementPayload>(
                &message,
                size_of::<PavementPayload>() - 1,
            )
            .is_none());
        }
    }

    #[test]
    fn airport_payload_decodes_at_the_exact_reported_size() {
        // Native fields occupy 100 bytes, with no Rust f64 tail padding.
        assert_eq!(size_of::<AirportPayload>(), 100);
        #[repr(C)]
        struct AirportCallbackFixture {
            header: SimConnectRecvFacilityData,
            tail: [u8; size_of::<AirportPayload>() - size_of::<Dword>()],
        }

        let mut fixture = AirportCallbackFixture {
            header: SimConnectRecvFacilityData {
                dw_size: (facility_data_offset() + size_of::<AirportPayload>()) as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_FACILITY_DATA,
                user_request_id: 1,
                unique_request_id: 2,
                parent_unique_request_id: 0,
                facility_type: FACILITY_DATA_AIRPORT,
                is_list_item: 0,
                item_index: 0,
                list_size: 1,
                data: 0,
            },
            tail: [0; size_of::<AirportPayload>() - size_of::<Dword>()],
        };
        let payload = AirportPayload {
            latitude_deg: -35.3069,
            longitude_deg: 149.195,
            altitude_m: 575.0,
            name: c_char_array("Canberra Airport"),
            icao: c_char_array("YSCB"),
            n_runways: 2,
        };

        // SAFETY: the fixture reserves the fixed header plus the entire trailing
        // AirportPayload, and the decoder intentionally supports unaligned payloads.
        unsafe {
            let payload_ptr = (&mut fixture as *mut AirportCallbackFixture as *mut u8)
                .add(facility_data_offset()) as *mut AirportPayload;
            ptr::write_unaligned(payload_ptr, payload);
        }

        let mut request = AirportFacilityRequest::new(77, "YSCB", "AU");
        request.handle_data(&fixture.header, size_of::<AirportPayload>());
        let decoded = request.to_json(Some("test-simconnect"));

        assert_eq!(decoded["requestId"], 77);
        assert_eq!(decoded["airport"]["icao"], "YSCB");
        assert_eq!(decoded["airport"]["name"], "Canberra Airport");
        assert_eq!(decoded["airport"]["nRunways"], 2);
        assert_eq!(decoded["airport"]["lat"], -35.3069);
        assert_eq!(decoded["airport"]["lon"], 149.195);
        assert!(decoded["airport"]["elevationFt"].as_f64().is_some());
        assert_eq!(decoded["runways"], json!([]));
    }

    #[test]
    fn runway_end_id_formats_number_and_designator() {
        assert_eq!(runway_end_id(1, 0).as_deref(), Some("01"));
        assert_eq!(runway_end_id(9, 1).as_deref(), Some("09L"));
        assert_eq!(runway_end_id(27, 2).as_deref(), Some("27R"));
        assert_eq!(runway_end_id(0, 0), None);
    }

    #[test]
    fn facility_data_type_values_match_msfs_sdk_order() {
        assert_eq!(FACILITY_DATA_AIRPORT, 0);
        assert_eq!(FACILITY_DATA_RUNWAY, 1);
        assert_eq!(FACILITY_DATA_PAVEMENT, 23);
        assert_eq!(FACILITY_DATA_TAXI_POINT, 14);
        assert_eq!(FACILITY_DATA_TAXI_PARKING, 15);
        assert_eq!(FACILITY_DATA_TAXI_PATH, 16);
    }

    #[test]
    fn taxi_parkings_decode_with_native_indices_and_gate_the_completeness_flag() {
        assert_eq!(size_of::<TaxiParkingPayload>(), 40);
        assert_eq!(offset_of!(TaxiParkingPayload, heading), 24);
        let p = TaxiPointPayload { kind: 1, orientation: 0, x: 0.0, z: 0.0 };
        let path = TaxiPathPayload { kind: 3, width: 18.0, start: 0, end: 1, number: 0, designator: 0 };
        let gate = TaxiParkingPayload { kind: 9, point_kind: 1, name: 15, suffix: 0, number: 12, orientation: 0, heading: 271.5, radius: 18.0, x: 120.0, z: -40.0 };
        let mut request = AirportFacilityRequest::new(1, "TEST", "");
        taxi_callback(&mut request, FACILITY_DATA_TAXI_POINT, 0, 1, p, false);
        taxi_callback(&mut request, FACILITY_DATA_TAXI_PATH, 0, 1, path, false);
        // No parking callbacks at all: an airport without stands is still complete.
        assert_eq!(request.to_json(None)["taxiways"]["complete"], true);
        assert_eq!(request.to_json(None)["taxiways"]["parkings"].as_array().map(Vec::len), Some(0));
        taxi_callback(&mut request, FACILITY_DATA_TAXI_PARKING, 1, 2, gate, false);
        assert_eq!(request.to_json(None)["taxiways"]["complete"], false, "one of two stands is missing");
        taxi_callback(&mut request, FACILITY_DATA_TAXI_PARKING, 0, 2, gate, false);
        let result = request.to_json(None);
        assert_eq!(result["taxiways"]["complete"], true);
        assert_eq!(result["taxiways"]["parkings"][1]["id"], 1);
        assert_eq!(result["taxiways"]["parkings"][1]["name"], 15);
        assert_eq!(result["taxiways"]["parkings"][1]["number"], 12);
        assert_eq!(result["taxiways"]["parkings"][1]["headingDeg"], 271.5);
        assert_eq!(result["taxiways"]["parkings"][0]["x"], 120.0);
        taxi_callback(&mut request, FACILITY_DATA_TAXI_PARKING, 0, 2, gate, true);
        assert_eq!(request.to_json(None)["taxiways"]["complete"], false, "a truncated record invalidates the list");
    }

    fn taxi_callback<T: Copy>(request: &mut AirportFacilityRequest, kind: Dword, index: Dword, count: Dword, payload: T, truncated: bool) {
        let bytes = facility_data_offset() + size_of::<T>();
        let mut storage = vec![0u32; bytes.div_ceil(4)];
        let header = storage.as_mut_ptr() as *mut SimConnectRecvFacilityData;
        // Storage is DWORD-aligned and reserves the entire variable-length payload.
        unsafe {
            ptr::write(header, SimConnectRecvFacilityData { dw_size: bytes as Dword, dw_version: 0, dw_id: SIMCONNECT_RECV_ID_FACILITY_DATA,
                user_request_id: 1, unique_request_id: 2, parent_unique_request_id: 1, facility_type: kind,
                is_list_item: 1, item_index: index, list_size: count, data: 0 });
            ptr::write_unaligned((storage.as_mut_ptr() as *mut u8).add(facility_data_offset()) as *mut T, payload);
            request.handle_data(&*header, size_of::<T>() - usize::from(truncated));
        }
    }

    #[test]
    fn taxi_lists_preserve_native_indices_and_reject_partial_duplicate_or_truncated_data() {
        assert_eq!(size_of::<TaxiPointPayload>(), 16);
        assert_eq!(size_of::<TaxiPathPayload>(), 24);
        assert_eq!(offset_of!(TaxiPathPayload, start), 8);
        assert_eq!(offset_of!(TaxiPointPayload, x), 8);
        let p = TaxiPointPayload { kind: 2, orientation: 1, x: 25.0, z: -60.0 };
        let path = TaxiPathPayload { kind: 2, width: 45.0, start: 0, end: 1, number: 16, designator: 1 };
        let mut request = AirportFacilityRequest::new(1, "TEST", "");
        taxi_callback(&mut request, FACILITY_DATA_TAXI_POINT, 1, 2, p, false);
        taxi_callback(&mut request, FACILITY_DATA_TAXI_PATH, 0, 1, path, false);
        assert_eq!(request.to_json(None)["taxiways"]["complete"], false);
        taxi_callback(&mut request, FACILITY_DATA_TAXI_POINT, 0, 2, p, false);
        let result = request.to_json(None);
        assert_eq!(result["taxiways"]["complete"], true);
        assert_eq!(result["taxiways"]["points"][0]["id"], 0);
        assert_eq!(result["taxiways"]["points"][1]["z"], -60.0);
        assert_eq!(result["taxiways"]["paths"][0]["runway"], "16L");
        taxi_callback(&mut request, FACILITY_DATA_TAXI_POINT, 0, 2, p, false);
        assert_eq!(request.to_json(None)["taxiways"]["complete"], false);
        let mut truncated = AirportFacilityRequest::new(1, "TEST", "");
        taxi_callback(&mut truncated, FACILITY_DATA_TAXI_POINT, 0, 1, p, true);
        assert!(truncated.taxi_invalid);
        assert!(truncated.taxi_points.is_empty());
        let mut oversized = AirportFacilityRequest::new(1, "TEST", "");
        taxi_callback(&mut oversized, FACILITY_DATA_TAXI_POINT, 0, MAX_TAXI_ITEMS as Dword + 1, p, false);
        assert!(oversized.taxi_invalid);
        assert!(oversized.taxi_points.is_empty());
    }

    #[test]
    fn airport_facility_definition_matches_the_documented_sdk_sequence() {
        assert_eq!(
            AIRPORT_FACILITY_FIELDS,
            [
                "OPEN AIRPORT",
                "LATITUDE",
                "LONGITUDE",
                "ALTITUDE",
                "NAME64",
                "ICAO",
                "N_RUNWAYS",
                "OPEN RUNWAY",
                "LATITUDE",
                "LONGITUDE",
                "ALTITUDE",
                "HEADING",
                "LENGTH",
                "WIDTH",
                "SURFACE",
                "PRIMARY_NUMBER",
                "PRIMARY_DESIGNATOR",
                "SECONDARY_NUMBER",
                "SECONDARY_DESIGNATOR",
                "OPEN PRIMARY_THRESHOLD",
                "LENGTH",
                "WIDTH",
                "ENABLE",
                "CLOSE PRIMARY_THRESHOLD",
                "OPEN SECONDARY_THRESHOLD",
                "LENGTH",
                "WIDTH",
                "ENABLE",
                "CLOSE SECONDARY_THRESHOLD",
                "CLOSE RUNWAY",
                "OPEN TAXI_POINT", "TYPE", "ORIENTATION", "BIAS_X", "BIAS_Z", "CLOSE TAXI_POINT",
                "OPEN TAXI_PARKING", "TYPE", "TAXI_POINT_TYPE", "NAME", "SUFFIX", "NUMBER", "ORIENTATION", "HEADING", "RADIUS", "BIAS_X", "BIAS_Z", "CLOSE TAXI_PARKING",
                "OPEN TAXI_PATH", "TYPE", "WIDTH", "START", "END", "RUNWAY_NUMBER", "RUNWAY_DESIGNATOR", "CLOSE TAXI_PATH",
                "CLOSE AIRPORT",
            ]
        );
    }

    #[test]
    fn facility_payload_field_offsets_and_wire_widths_match_the_sdk() {
        assert_eq!(offset_of!(AirportPayload, latitude_deg), 0);
        assert_eq!(offset_of!(AirportPayload, longitude_deg), 8);
        assert_eq!(offset_of!(AirportPayload, altitude_m), 16);
        assert_eq!(offset_of!(AirportPayload, name), 24);
        assert_eq!(offset_of!(AirportPayload, icao), 88);
        assert_eq!(offset_of!(AirportPayload, n_runways), 96);
        let airport_wire_bytes = offset_of!(AirportPayload, n_runways) + size_of::<i32>();
        assert_eq!(airport_wire_bytes, 100);
        // The wire record has no four-byte tail padding. Requiring 104 bytes
        // silently discarded valid airport callbacks (including their origin).
        assert_eq!(size_of::<AirportPayload>(), airport_wire_bytes);

        assert_eq!(offset_of!(RunwayPayload, latitude_deg), 0);
        assert_eq!(offset_of!(RunwayPayload, longitude_deg), 8);
        assert_eq!(offset_of!(RunwayPayload, altitude_m), 16);
        assert_eq!(offset_of!(RunwayPayload, heading_deg), 24);
        assert_eq!(offset_of!(RunwayPayload, length_m), 28);
        assert_eq!(offset_of!(RunwayPayload, width_m), 32);
        assert_eq!(offset_of!(RunwayPayload, surface), 36);
        assert_eq!(offset_of!(RunwayPayload, primary_number), 40);
        assert_eq!(offset_of!(RunwayPayload, primary_designator), 44);
        assert_eq!(offset_of!(RunwayPayload, secondary_number), 48);
        assert_eq!(offset_of!(RunwayPayload, secondary_designator), 52);
        assert_eq!(size_of::<RunwayPayload>(), 56);

        assert_eq!(offset_of!(PavementPayload, length_m), 0);
        assert_eq!(offset_of!(PavementPayload, width_m), 4);
        assert_eq!(offset_of!(PavementPayload, enable), 8);
        assert_eq!(size_of::<PavementPayload>(), 12);
    }

    #[test]
    fn facility_collection_limits_are_far_above_normal_airport_data() {
        let mut request = AirportFacilityRequest::new(1, "TEST", "");
        assert!(request.can_accept_runway());
        request.runways = vec![test_runway(); MAX_FACILITY_RUNWAYS];
        assert_eq!(request.runways.len(), 256);
        assert!(!request.can_accept_runway());

        request.runways[0].pavements = vec![
            DecodedPavement {
                length_m: 1.0,
                width_m: 1.0,
                enable: true,
            };
            MAX_FACILITY_PAVEMENTS_PER_RUNWAY
        ];
        assert_eq!(request.runways[0].pavements.len(), 64);
        assert!(!request.can_accept_pavement(0));
        assert!(!request.can_accept_pavement(MAX_FACILITY_RUNWAYS));
    }

    #[test]
    fn runway_records_use_physical_threshold_plus_displacement() {
        let runway = DecodedRunway {
            latitude_deg: 0.0,
            longitude_deg: 0.0,
            altitude_m: 10.0,
            heading_deg: 0.0,
            length_m: 304.8,
            width_m: 45.72,
            surface: 4,
            primary_number: 18,
            primary_designator: 0,
            secondary_number: 36,
            secondary_designator: 0,
            pavements: vec![
                DecodedPavement {
                    length_m: 30.48,
                    width_m: 45.72,
                    enable: true,
                },
                DecodedPavement {
                    length_m: 0.0,
                    width_m: 45.72,
                    enable: false,
                },
            ],
        };

        let records = runway_to_end_records(&runway, "TEST", "Test Airport", Some(33.0));
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["runway"], "18");
        assert_eq!(records[0]["surface"], "ASPHALT");
        assert_eq!(records[0]["elevationReference"], "runway");
        assert!((records[0]["elevation_ft"].as_f64().unwrap() - 32.8084).abs() < 0.01);
        assert!((records[0]["physicalLengthFt"].as_f64().unwrap() - 1000.0).abs() < 0.01);
        assert!((records[0]["displacedThresholdFt"].as_f64().unwrap() - 100.0).abs() < 0.01);
        assert!((records[0]["lengthFt"].as_f64().unwrap() - 900.0).abs() < 0.01);
        assert_ne!(
            records[0]["threshold"]["lat"].as_f64().unwrap(),
            records[0]["physicalThreshold"]["lat"].as_f64().unwrap()
        );

        let mut runway_without_elevation = runway.clone();
        runway_without_elevation.altitude_m = f64::NAN;
        let fallback_records = runway_to_end_records(
            &runway_without_elevation,
            "TEST",
            "Test Airport",
            Some(33.0),
        );
        assert_eq!(fallback_records[0]["elevationReference"], "airport");
        assert_eq!(fallback_records[0]["elevation_ft"], 33.0);
    }
