
    use super::*;
    use serde_json::json;

    fn test_connector_manifest() -> String {
        json!({
            "kind": "sdk-clientdata-connector",
            "schemaVersion": 1,
            "id": "test-clientdata",
            "displayName": "Test ClientData",
            "targets": ["test-aircraft", "test-clientdata"],
            "clientData": {
                "name": "TEST_Data",
                "dataId": 1,
                "defineId": 2,
                "requestId": 3,
                "size": 16
            },
            "fields": [
                { "name": "flag", "type": "bool", "offset": 0 },
                {
                    "name": "lever",
                    "type": "u8",
                    "offset": 1,
                    "map": {
                        "0": "STOWED",
                        "25": "ARMED"
                    },
                    "ranges": [
                        { "min": 26, "max": 100, "value": "EXTENDED" }
                    ]
                },
                {
                    "name": "speed",
                    "type": "f32le",
                    "offset": 4,
                    "round": 0,
                    "when": [{ "type": "f32le", "offset": 4, "gt": 1 }]
                },
                {
                    "name": "any_flag",
                    "op": "any",
                    "terms": [
                        { "type": "bool", "offset": 0 },
                        { "type": "bool", "offset": 2 }
                    ]
                }
            ],
            "normalized": [
                { "path": "lights.nav", "field": "flag" },
                { "path": "spoilers.state", "field": "lever" },
                { "path": "automation.ap.selected.speedKts", "field": "speed" },
                { "path": "automation.ap.engaged", "op": "any", "fields": ["flag", "any_flag"] }
            ]
        })
        .to_string()
    }

    #[test]
    fn byte_fields_preserve_cdu_payload_and_reject_invalid_bounds() {
        let manifests = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sdk-connectors");
        for name in ["pmdg-737-cdu-left", "pmdg-737-cdu-right", "pmdg-777-cdu-left", "pmdg-777-cdu-right"] {
            let text = fs::read_to_string(manifests.join(format!("{name}.json"))).unwrap();
            let adapter = parse_connector(&text).unwrap();
            // VISUAL_FRAME also delivers the existing
            // screen when a viewer opens after the last CDU update. ON_SET can
            // leave an already powered, unchanged CDU blank indefinitely.
            assert!(matches!(adapter.definition.request_period, ClientDataPeriod::VisualFrame));
            let raw: Vec<u8> = (0..1009).map(|i| (i % 256) as u8).collect();
            assert_eq!(adapter.decode(&raw).unwrap()["screen"], json!(raw));
            assert!(adapter.decode(&raw[..1008]).is_none());
            let mut spec: Value = serde_json::from_str(&text).unwrap();
            for length in [0, 1010, usize::MAX] {
                spec["fields"][0]["length"] = json!(length);
                assert!(parse_connector(&spec.to_string()).is_err());
            }
            spec["fields"][0]["length"] = json!(1009);
            spec["fields"][0]["map"] = json!({"0": true});
            assert!(parse_connector(&spec.to_string()).is_err());
        }
    }

    fn test_adapter() -> SdkClientDataAdapter {
        parse_connector(&test_connector_manifest()).expect("test connector should parse")
    }

    #[test]
    fn pmdg_efis_manifests_decode_native_aligned_payloads() {
        // Independent payload positions from the installed SDK headers, including
        // native alignment padding. No vendor header or binary is redistributed.
        let manifests = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sdk-connectors");
        let adapter = parse_connector(
            &fs::read_to_string(manifests.join("pmdg-737-ng3-clientdata.json")).unwrap(),
        ).unwrap();
        let mut raw = vec![0_u8; 916];
        raw[404] = 1;
        raw[405] = 0;
        raw[414] = 0;
        raw[415] = 7;
        raw[430..432].copy_from_slice(&12300_u16.to_le_bytes());
        let state = adapter.normalize(&adapter.decode(&raw).unwrap()).unwrap();
        assert_eq!(state["efis"]["captain"]["minimumsMode"], json!("baro"));
        assert_eq!(state["efis"]["firstOfficer"]["minimumsMode"], json!("radio"));
        assert_eq!(state["efis"]["captain"]["rangeNm"], json!("5"));
        assert_eq!(state["efis"]["firstOfficer"]["rangeNm"], json!("640"));
        assert_eq!(state["automation"]["ap"]["selected"]["altitudeFt"], json!(12300));

        let adapter = parse_connector(
            &fs::read_to_string(manifests.join("pmdg-777x-clientdata.json")).unwrap(),
        ).unwrap();
        let mut raw = vec![0_u8; 684];
        raw[268] = 1;
        raw[269] = 0;
        raw[278] = 0;
        raw[279] = 6;
        raw[513] = 1;
        raw[514] = 0;
        raw[516..520].copy_from_slice(&(-200_i32).to_le_bytes());
        raw[520..524].copy_from_slice(&420_i32.to_le_bytes());
        raw[524] = 0;
        raw[525] = 1;
        raw[528..532].copy_from_slice(&300_i32.to_le_bytes());
        raw[532..536].copy_from_slice(&210_i32.to_le_bytes());
        let state = adapter.normalize(&adapter.decode(&raw).unwrap()).unwrap();
        assert_eq!(state["efis"]["captain"]["rangeNm"], json!("10"));
        assert_eq!(state["efis"]["firstOfficer"]["rangeNm"], json!("640"));
        assert_eq!(state["efis"]["captain"]["minimumsMode"], json!("baro"));
        assert_eq!(state["efis"]["captain"]["baroMinimumsSet"], json!(true));
        assert_eq!(state["efis"]["captain"]["baroMinimumsFt"], json!(-200));
        assert_eq!(state["efis"]["firstOfficer"]["baroMinimumsSet"], json!(false));
        assert_eq!(state["efis"]["firstOfficer"]["radioMinimumsSet"], json!(true));
        assert_eq!(state["efis"]["firstOfficer"]["radioMinimumsFt"], json!(210));
    }

    #[test]
    fn has_no_builtin_clientdata_targets() {
        assert!(resolve_clientdata_adapter("test-aircraft").is_none());
        assert!(resolve_clientdata_adapter("not-real").is_none());
        assert!(unsupported_target_error("not-real").starts_with("unsupported_aircraft:not-real"));
    }

    #[test]
    fn manifest_decoder_rejects_short_snapshot() {
        let adapter = test_adapter();
        assert!(adapter.decode(&[0; 15]).is_none());
    }

    #[test]
    fn manifest_request_period_defaults_to_visual_frame_and_accepts_on_set() {
        let default_adapter = test_adapter();
        assert_eq!(
            default_adapter.definition.request_period,
            ClientDataPeriod::VisualFrame
        );

        let mut parsed: Value =
            serde_json::from_str(&test_connector_manifest()).expect("valid JSON");
        parsed["clientData"]["requestPeriod"] = json!("onSet");
        let adapter = parse_connector(
            &serde_json::to_string(&parsed).expect("manifest should serialize"),
        )
        .expect("onSet request period should parse");
        assert_eq!(adapter.definition.request_period, ClientDataPeriod::OnSet);
    }

    #[test]
    fn manifest_decoder_reads_representative_fields() {
        let adapter = test_adapter();
        let mut raw = vec![0_u8; adapter.definition.data_size];
        raw[0] = 1;
        raw[1] = 25;
        raw[4..8].copy_from_slice(&250.4_f32.to_le_bytes());

        let values = adapter.decode(&raw).expect("test payload should decode");
        assert_eq!(values.get("flag"), Some(&json!(true)));
        assert_eq!(values.get("lever"), Some(&json!("ARMED")));
        assert_eq!(values.get("speed"), Some(&json!(250)));
    }

    #[test]
    fn manifest_decoder_maps_only_declared_integer_ranges() {
        let adapter = test_adapter();
        let cases = [
            (0_u8, json!("STOWED")),
            (1, Value::Null),
            (24, Value::Null),
            (25, json!("ARMED")),
            (26, json!("EXTENDED")),
            (100, json!("EXTENDED")),
            (101, Value::Null),
        ];

        for (raw_value, expected) in cases {
            let mut raw = vec![0_u8; adapter.definition.data_size];
            raw[1] = raw_value;
            let values = adapter.decode(&raw).expect("test payload should decode");
            assert_eq!(
                values.get("lever"),
                Some(&expected),
                "unexpected mapping for raw integer {raw_value}"
            );
        }
    }

    #[test]
    fn manifest_parser_strictly_validates_integer_ranges() {
        let invalid_ranges = [
            (
                json!([{ "min": 26, "max": 25, "value": "EXTENDED" }]),
                "field_range_inverted",
            ),
            (
                json!([{ "min": -1, "max": 10, "value": "EXTENDED" }]),
                "field_range_out_of_type",
            ),
            (
                json!([
                    { "min": 10, "max": 20, "value": "A" },
                    { "min": 20, "max": 30, "value": "B" }
                ]),
                "field_ranges_overlap",
            ),
            (
                json!([{ "min": 25, "max": 30, "value": "EXTENDED" }]),
                "field_range_map_key_overlap",
            ),
        ];

        for (ranges, expected_error) in invalid_ranges {
            let mut parsed: Value =
                serde_json::from_str(&test_connector_manifest()).expect("valid JSON");
            parsed["fields"][1]["ranges"] = ranges;
            let text = serde_json::to_string(&parsed).expect("manifest should serialize");
            assert!(
                parse_connector(&text)
                    .expect_err("invalid integer ranges should be rejected")
                    .contains(expected_error),
                "expected range validation error {expected_error}"
            );
        }
    }

    #[test]
    fn manifest_decoder_builds_normalized_snapshot() {
        let adapter = test_adapter();
        let mut raw = vec![0_u8; adapter.definition.data_size];
        raw[0] = 1;
        raw[1] = 25;
        raw[4..8].copy_from_slice(&250.4_f32.to_le_bytes());

        let values = adapter.decode(&raw).expect("test payload should decode");
        let normalized = adapter
            .normalize(&values)
            .expect("test connector declares normalized mappings");

        assert_eq!(normalized["automation"]["ap"]["engaged"], json!(true));
        assert_eq!(
            normalized["automation"]["ap"]["selected"]["speedKts"],
            json!(250)
        );
        assert_eq!(normalized["spoilers"]["state"], json!("ARMED"));
        assert_eq!(normalized["lights"]["nav"], json!(true));
    }

    #[test]
    fn manifest_decoder_applies_numeric_conditions() {
        let adapter = test_adapter();
        let mut raw = vec![0_u8; adapter.definition.data_size];
        raw[4..8].copy_from_slice(&250.4_f32.to_le_bytes());

        let values = adapter.decode(&raw).expect("test payload should decode");
        assert_eq!(values.get("speed"), Some(&json!(250)));

        raw[4..8].copy_from_slice(&0.777_f32.to_le_bytes());
        let values = adapter.decode(&raw).expect("test payload should decode");
        assert_eq!(values.get("speed"), Some(&Value::Null));
    }

    #[test]
    fn invalid_manifest_cannot_escape_safe_declarative_ops() {
        let mut parsed: Value =
            serde_json::from_str(&test_connector_manifest()).expect("valid JSON");
        parsed["fields"][0]["op"] = json!("eval");
        let text = serde_json::to_string(&parsed).expect("manifest should serialize");
        assert!(parse_connector(&text)
            .expect_err("unsafe op should be rejected")
            .contains("unsupported_field_op"));
    }

    #[test]
    fn invalid_manifest_rejects_unsafe_normalized_paths() {
        let mut parsed: Value =
            serde_json::from_str(&test_connector_manifest()).expect("valid JSON");
        parsed["normalized"][0]["path"] = json!("__proto__.polluted");
        let text = serde_json::to_string(&parsed).expect("manifest should serialize");
        assert!(parse_connector(&text)
            .expect_err("unsafe normalized path should be rejected")
            .contains("invalid_normalized_path"));
    }

    #[test]
    fn manifest_parser_accepts_utf8_bom() {
        let manifest = test_connector_manifest();
        let text = format!("\u{feff}{manifest}");
        let adapter = parse_connector(&text).expect("BOM-prefixed JSON should parse");
        assert_eq!(adapter.id, "test-clientdata");
    }

    #[test]
    fn connector_reader_enforces_the_limit_on_the_open_handle() {
        let payload = b"{}".to_vec();
        let mut accepted = std::io::Cursor::new(payload.clone());
        assert_eq!(
            read_connector_text(&mut accepted, payload.len() as u64),
            Ok("{}".to_string())
        );

        let mut oversized = std::io::Cursor::new(vec![b'x'; MAX_CONNECTOR_BYTES as usize + 1]);
        let error = read_connector_text(&mut oversized, 1)
            .expect_err("actual bytes must remain bounded if metadata becomes stale");
        assert!(error.contains("connector_too_large"));
    }

    #[test]
    fn configured_test_connector_file_uses_the_production_parser() {
        let Some(path) = env::var_os("FF_TEST_SDK_CONNECTOR_FILE") else {
            return;
        };
        let path = PathBuf::from(path);
        let adapter = parse_connector_file(&path)
            .unwrap_or_else(|error| panic!("configured SDK connector should parse: {error}"));
        assert!(!adapter.targets.is_empty());
        assert!(adapter.definition.data_size > 0);

    }
