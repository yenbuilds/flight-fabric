
    use super::*;

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

    #[test]
    fn parses_simvar_rpn_reference_for_data_definition() {
        let parsed = parse_datum_ref("(A:AIRSPEED INDICATED, knots)", DefaultDatumPrefix::Simvar);
        assert_eq!(parsed.name, "AIRSPEED INDICATED");
        assert_eq!(parsed.unit.as_deref(), Some("knots"));
    }

    #[test]
    fn leaves_plain_simvar_name_unprefixed() {
        let parsed = parse_datum_ref("TITLE", DefaultDatumPrefix::Simvar);
        assert_eq!(parsed.name, "TITLE");
        assert_eq!(parsed.unit, None);
    }

    #[test]
    fn keeps_lvar_default_for_legacy_subscriptions() {
        let parsed = parse_datum_ref("SDK_TEST_VAR", DefaultDatumPrefix::Lvar);
        assert_eq!(parsed.name, "L:SDK_TEST_VAR");
    }

    #[test]
    fn infers_simconnect_data_type_from_unit_when_data_type_is_absent() {
        assert_eq!(
            resolve_subscription_data_type(None, Some("Bool")),
            SIMCONNECT_DATATYPE_INT32
        );
        assert_eq!(
            resolve_subscription_data_type(None, Some("Enum")),
            SIMCONNECT_DATATYPE_INT32
        );
        assert_eq!(
            resolve_subscription_data_type(None, Some("Mask")),
            SIMCONNECT_DATATYPE_INT32
        );
        assert_eq!(
            resolve_subscription_data_type(None, Some("String")),
            SIMCONNECT_DATATYPE_STRING256
        );
        assert_eq!(
            resolve_subscription_data_type(None, Some("knots")),
            SIMCONNECT_DATATYPE_FLOAT64
        );
    }

    #[test]
    fn definition_payload_size_bounds_variable_payload_reads() {
        let items = vec![
            DefinitionItem {
                key: "int".to_string(),
                data_type: SIMCONNECT_DATATYPE_INT32,
            },
            DefinitionItem {
                key: "string".to_string(),
                data_type: SIMCONNECT_DATATYPE_STRING256,
            },
            DefinitionItem {
                key: "float64".to_string(),
                data_type: SIMCONNECT_DATATYPE_FLOAT64,
            },
        ];
        let expected_size = size_of::<i32>() + 256 + size_of::<f64>();
        assert_eq!(definition_payload_size(&items), Some(expected_size));
    }

    #[test]
    fn rejects_oversized_or_unsafe_subscriptions() {
        let accepted = normalize_subscriptions(vec![
            test_subscription("selected_altitude", "(L:SAFE_ALTITUDE)"),
            test_subscription("ias", "AIRSPEED INDICATED"),
        ])
        .expect("safe subscriptions should normalize");
        assert_eq!(accepted.len(), 2);
        assert_eq!(accepted[0].key, "selected_altitude");

        let too_many = (0..=MAX_COMMAND_SUBSCRIPTIONS)
            .map(|index| test_subscription(&format!("k{index}"), "AIRSPEED INDICATED"))
            .collect::<Vec<_>>();
        assert!(normalize_subscriptions(too_many)
            .expect_err("oversized subscription batches should be rejected")
            .contains("too_many_subscriptions"));

        assert!(
            normalize_subscriptions(vec![test_subscription("bad key", "AIRSPEED INDICATED")])
                .expect_err("subscription keys should use safe runtime tokens")
                .contains("key_invalid")
        );

        let mut bad_data_type = test_subscription("ias", "AIRSPEED INDICATED");
        bad_data_type.data_type = Some("shell".to_string());
        assert!(normalize_subscriptions(vec![bad_data_type])
            .expect_err("subscription data types should be allowlisted")
            .contains("data_type_invalid"));

        let mut long_expression = test_subscription("ias", "AIRSPEED INDICATED");
        long_expression.expression = "A".repeat(MAX_SUBSCRIPTION_REF_LEN + 1);
        assert!(normalize_subscriptions(vec![long_expression])
            .expect_err("subscription expressions should be length bounded")
            .contains("expression_invalid"));

        for unsafe_expression in [
            "(L:SAFE, Number) (>K:EVENT)",
            "L:SAFE, Number, trailing",
            "L:SAFE;DROP",
            "(L:UNBALANCED",
        ] {
            assert!(normalize_subscriptions(vec![test_subscription("unsafe", unsafe_expression)])
                .expect_err("native datum references must use the structured reference grammar")
                .contains("expression_invalid"));
        }
    }

    #[test]
    fn keeps_string_simvars_in_standalone_chunks() {
        fn simvar(
            key: &str,
            expression: &str,
            unit: &str,
            data_type: Option<&str>,
        ) -> Subscription {
            Subscription {
                key: key.to_string(),
                expression: expression.to_string(),
                simvar: None,
                unit: Some(unit.to_string()),
                data_type: data_type.map(str::to_string),
                isolated: false,
            }
        }

        let subscriptions = vec![
            simvar("ias", "AIRSPEED INDICATED", "knots", None),
            simvar("wow", "SIM ON GROUND", "Bool", None),
            simvar("aircraftTitle", "TITLE", "String", Some("string256")),
            simvar("altitude", "PLANE ALTITUDE", "feet", None),
        ];
        let prepared = subscriptions
            .iter()
            .map(|item| prepare_subscription(item, DefaultDatumPrefix::Simvar))
            .collect();
        let chunks = split_subscription_chunks(prepared, 4);

        assert_eq!(chunks.len(), 3);
        assert_eq!(
            chunks[0]
                .iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>(),
            vec!["ias", "wow"]
        );
        assert_eq!(
            chunks[1]
                .iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>(),
            vec!["aircraftTitle"]
        );
        assert_eq!(chunks[1][0].unit_name, "");
        assert_eq!(chunks[1][0].data_type, SIMCONNECT_DATATYPE_STRING256);
        assert_eq!(
            chunks[2]
                .iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>(),
            vec!["altitude"]
        );
    }

    #[test]
    fn keeps_explicitly_isolated_simvars_out_of_shared_definitions() {
        let first = test_subscription("first", "AIRSPEED INDICATED");
        let mut probe = test_subscription("probe", "INDICATED ALTITUDE CALIBRATED");
        probe.isolated = true;
        let last = test_subscription("last", "GROUND VELOCITY");
        let prepared = [first, probe, last]
            .iter()
            .map(|item| prepare_subscription(item, DefaultDatumPrefix::Simvar))
            .collect();

        let chunks = split_subscription_chunks(prepared, 20);
        let keys = chunks
            .iter()
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|item| item.key.as_str())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(keys, vec![vec!["first"], vec!["probe"], vec!["last"]]);
    }
