// SPDX-License-Identifier: AGPL-3.0-only

//! Subscription validation and translation into SimConnect data definitions.
//!
//! `protocol.rs` deserializes the wire shape; this module applies semantic
//! limits, parses LVAR/SIMVAR references, resolves native data types, and splits
//! subscriptions into bounded definition chunks. The resulting prepared items
//! are consumed by `SimSession` in `main.rs`, while definition metadata is kept
//! for decoding each returned binary payload in the original field order.

use crate::protocol::Subscription;
use crate::simconnect_ffi::{
    Dword, SIMCONNECT_DATATYPE_FLOAT32, SIMCONNECT_DATATYPE_FLOAT64, SIMCONNECT_DATATYPE_INT32,
    SIMCONNECT_DATATYPE_STRING256,
};
use std::mem::size_of;

const MAX_COMMAND_SUBSCRIPTIONS: usize = 256;
const MAX_SUBSCRIPTION_KEY_LEN: usize = 80;
const MAX_SUBSCRIPTION_REF_LEN: usize = 256;
const MAX_SUBSCRIPTION_UNIT_LEN: usize = 48;
const MAX_SUBSCRIPTION_DATA_TYPE_LEN: usize = 32;

// `PreparedSubscription` is the native registration plan; `DefinitionItem` is
// the smaller decode plan retained after registration.
#[derive(Clone)]
pub(crate) struct DefinitionItem {
    pub(crate) key: String,
    pub(crate) data_type: Dword,
}

#[derive(Clone)]
pub(crate) struct PreparedSubscription {
    pub(crate) key: String,
    pub(crate) datum_name: String,
    pub(crate) unit_name: String,
    pub(crate) data_type: Dword,
    pub(crate) isolated: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DefaultDatumPrefix {
    Lvar,
    Simvar,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubscriptionKind {
    Lvar,
    Simvar,
}

impl SubscriptionKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SubscriptionKind::Lvar => "lvars",
            SubscriptionKind::Simvar => "simvars",
        }
    }
}

fn definition_item_size(data_type: Dword) -> usize {
    match data_type {
        SIMCONNECT_DATATYPE_INT32 => size_of::<i32>(),
        SIMCONNECT_DATATYPE_FLOAT32 => size_of::<f32>(),
        SIMCONNECT_DATATYPE_STRING256 => 256,
        _ => size_of::<f64>(),
    }
}

pub(crate) fn definition_payload_size(items: &[DefinitionItem]) -> Option<usize> {
    items.iter().try_fold(0usize, |total, item| {
        total.checked_add(definition_item_size(item.data_type))
    })
}

fn is_safe_subscription_key(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_SUBSCRIPTION_KEY_LEN
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-' | ':'))
}

fn is_safe_subscription_text(value: &str, max_len: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= max_len
        && trimmed
            .bytes()
            .all(|byte| (0x20..=0x7e).contains(&byte) && byte != 0)
}

fn is_safe_datum_reference(value: &str) -> bool {
    let mut reference = value.trim();
    if reference.starts_with('(') || reference.ends_with(')') {
        if !(reference.starts_with('(') && reference.ends_with(')')) || reference.len() <= 2 {
            return false;
        }
        reference = reference[1..reference.len() - 1].trim();
    }
    if reference.contains('(') || reference.contains(')') {
        return false;
    }

    let mut parts = reference.split(',');
    let name = parts.next().unwrap_or_default().trim();
    let unit = parts.next().map(str::trim);
    if name.is_empty() || parts.next().is_some() {
        return false;
    }
    let safe_name = name.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || ch.is_ascii_whitespace()
            || matches!(ch, '_' | '-' | '.' | '/' | ':' | '#' | '+' | '%')
    });
    let safe_unit = unit.is_none_or(|unit| {
        !unit.is_empty()
            && unit.chars().all(|ch| {
                ch.is_ascii_alphanumeric()
                    || ch.is_ascii_whitespace()
                    || matches!(ch, '_' | '-' | '.' | '/' | '^' | '%')
            })
    });
    safe_name && safe_unit
}

fn normalize_optional_subscription_text(
    value: Option<String>,
    max_len: usize,
    field_name: &str,
) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !is_safe_subscription_text(trimmed, max_len) {
        return Err(format!("{field_name}_invalid"));
    }
    Ok(Some(trimmed.to_string()))
}

fn is_allowed_subscription_data_type(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "int"
            | "int32"
            | "bool"
            | "boolean"
            | "float32"
            | "single"
            | "float64"
            | "double"
            | "string"
            | "string256"
    )
}

// Normalize once before replacing live state. Any invalid item rejects the
// entire incoming set so a partial command cannot corrupt existing streams.
fn normalize_subscription(subscription: Subscription) -> Result<Subscription, String> {
    let key = subscription.key.trim().to_string();
    if !is_safe_subscription_key(&key) {
        return Err("key_invalid".to_string());
    }

    let expression = subscription.expression.trim().to_string();
    if !expression.is_empty()
        && (!is_safe_subscription_text(&expression, MAX_SUBSCRIPTION_REF_LEN)
            || !is_safe_datum_reference(&expression))
    {
        return Err("expression_invalid".to_string());
    }

    let simvar = normalize_optional_subscription_text(
        subscription.simvar,
        MAX_SUBSCRIPTION_REF_LEN,
        "simvar",
    )?;
    if simvar.as_deref().is_some_and(|value| !is_safe_datum_reference(value)) {
        return Err("simvar_invalid".to_string());
    }
    if expression.is_empty() && simvar.is_none() {
        return Err("reference_required".to_string());
    }

    let unit =
        normalize_optional_subscription_text(subscription.unit, MAX_SUBSCRIPTION_UNIT_LEN, "unit")?;
    let data_type = normalize_optional_subscription_text(
        subscription.data_type,
        MAX_SUBSCRIPTION_DATA_TYPE_LEN,
        "data_type",
    )?;
    if let Some(data_type) = data_type.as_deref() {
        if !is_allowed_subscription_data_type(data_type) {
            return Err("data_type_invalid".to_string());
        }
    }

    Ok(Subscription {
        key,
        expression,
        simvar,
        unit,
        data_type,
        isolated: subscription.isolated,
    })
}

pub(crate) fn normalize_subscriptions(
    subscriptions: Vec<Subscription>,
) -> Result<Vec<Subscription>, String> {
    if subscriptions.len() > MAX_COMMAND_SUBSCRIPTIONS {
        return Err(format!(
            "too_many_subscriptions:{}>{}",
            subscriptions.len(),
            MAX_COMMAND_SUBSCRIPTIONS
        ));
    }
    subscriptions
        .into_iter()
        .enumerate()
        .filter(|(_, item)| !item.key.trim().is_empty() && !item.reference().trim().is_empty())
        .map(|(index, item)| {
            normalize_subscription(item).map_err(|err| format!("subscription_{index}:{err}"))
        })
        .collect()
}

struct ParsedDatum {
    name: String,
    unit: Option<String>,
}

// Expressions may be written as `L:NAME`, `A:NAME`, bare names, or
// `(reference, unit)`. The selected command mode supplies the bare-name default.
fn parse_datum_ref(expression: &str, default_prefix: DefaultDatumPrefix) -> ParsedDatum {
    let mut reference = expression.trim().to_string();
    let mut unit = None;
    if reference.starts_with('(') && reference.ends_with(')') && reference.len() > 2 {
        reference = reference[1..reference.len() - 1].trim().to_string();
    }
    if let Some(comma_index) = reference.find(',') {
        let left = reference[..comma_index].trim().to_string();
        let parsed_unit = reference[comma_index + 1..].trim().to_string();
        reference = left;
        if !parsed_unit.is_empty() {
            unit = Some(parsed_unit);
        }
    }
    let upper = reference.to_ascii_uppercase();
    let name = if upper.starts_with("A:") {
        reference[2..].trim().to_string()
    } else if upper.starts_with("L:") {
        reference
    } else {
        match default_prefix {
            DefaultDatumPrefix::Lvar => format!("L:{reference}"),
            DefaultDatumPrefix::Simvar => reference,
        }
    };
    ParsedDatum { name, unit }
}

pub(crate) fn resolve_data_type(raw: Option<&str>) -> Dword {
    match raw.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "int" | "int32" | "bool" | "boolean" => SIMCONNECT_DATATYPE_INT32,
        "float32" | "single" => SIMCONNECT_DATATYPE_FLOAT32,
        "string" | "string256" => SIMCONNECT_DATATYPE_STRING256,
        "float64" | "double" => SIMCONNECT_DATATYPE_FLOAT64,
        _ => SIMCONNECT_DATATYPE_FLOAT64,
    }
}

fn resolve_subscription_data_type(raw_data_type: Option<&str>, raw_unit: Option<&str>) -> Dword {
    if raw_data_type.is_some_and(|value| !value.trim().is_empty()) {
        return resolve_data_type(raw_data_type);
    }
    match raw_unit
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "bool" | "boolean" | "enum" | "mask" => SIMCONNECT_DATATYPE_INT32,
        "string" | "string256" => SIMCONNECT_DATATYPE_STRING256,
        _ => SIMCONNECT_DATATYPE_FLOAT64,
    }
}

pub(crate) fn prepare_subscription(
    subscription: &Subscription,
    default_prefix: DefaultDatumPrefix,
) -> PreparedSubscription {
    let parsed = parse_datum_ref(subscription.reference(), default_prefix);
    let data_type = resolve_subscription_data_type(
        subscription.data_type.as_deref(),
        subscription.unit.as_deref().or(parsed.unit.as_deref()),
    );
    let unit_name = if data_type == SIMCONNECT_DATATYPE_STRING256 {
        ""
    } else {
        subscription
            .unit
            .as_deref()
            .or(parsed.unit.as_deref())
            .unwrap_or("Number")
    }
    .to_string();

    PreparedSubscription {
        key: subscription.key.clone(),
        datum_name: parsed.name,
        unit_name,
        data_type,
        isolated: subscription.isolated,
    }
}

// SimConnect definitions are bounded both by requested chunk size and decoded
// payload bytes. Isolated subscriptions always receive their own definition.
pub(crate) fn split_subscription_chunks(
    prepared: Vec<PreparedSubscription>,
    chunk_size: usize,
) -> Vec<Vec<PreparedSubscription>> {
    let chunk_size = chunk_size.clamp(1, 64);
    let mut chunks = Vec::new();
    let mut numeric_chunk: Vec<PreparedSubscription> = Vec::new();

    for item in prepared {
        if item.isolated || item.data_type == SIMCONNECT_DATATYPE_STRING256 {
            if !numeric_chunk.is_empty() {
                chunks.push(std::mem::take(&mut numeric_chunk));
            }
            chunks.push(vec![item]);
            continue;
        }

        numeric_chunk.push(item);
        if numeric_chunk.len() >= chunk_size {
            chunks.push(std::mem::take(&mut numeric_chunk));
        }
    }

    if !numeric_chunk.is_empty() {
        chunks.push(numeric_chunk);
    }

    chunks
}

#[cfg(test)]
mod tests {
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
}
