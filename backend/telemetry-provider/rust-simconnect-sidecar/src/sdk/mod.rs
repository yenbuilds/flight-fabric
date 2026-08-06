//! Declarative SimConnect ClientData adapter loading and decoding.
//!
//! Aircraft SDK integrations arrive as bounded JSON connector manifests rather
//! than compiled Rust code. This module discovers those manifests, validates
//! every offset/type/condition before use, decodes fixed-size ClientData
//! snapshots, and optionally projects raw fields into the normalized JSON shape
//! expected by the backend. There are deliberately no built-in aircraft
//! definitions here; search paths provide adapters at runtime.
//!
//! Data flow: manifest file -> validated `SdkClientDataAdapter` -> raw field map
//! -> normalized nested JSON. Keep validation ahead of all raw-buffer reads.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::mem::size_of;
use std::path::{Path, PathBuf};

const CONNECTOR_KIND: &str = "sdk-clientdata-connector";
const CONNECTOR_SCHEMA_VERSION: u32 = 1;
const MAX_CONNECTOR_BYTES: u64 = 256 * 1024;
const MAX_CLIENT_DATA_SIZE: usize = 16 * 1024;
const MAX_FIELDS: usize = 512;
const MAX_NORMALIZED_MAPPINGS: usize = 512;

// Runtime types exposed to `main.rs` after a connector has passed validation.
pub type SdkValues = HashMap<String, Value>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ClientDataPeriod {
    VisualFrame,
    OnSet,
}

fn default_client_data_period() -> ClientDataPeriod {
    ClientDataPeriod::VisualFrame
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub struct ClientDataDefinition {
    pub data_name: String,
    pub data_id: u32,
    pub define_id: u32,
    pub request_id: u32,
    pub data_size: usize,
    pub request_period: ClientDataPeriod,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct SdkClientDataAdapter {
    pub id: String,
    pub display_name: String,
    pub targets: Vec<String>,
    pub definition: ClientDataDefinition,
    fields: Vec<FieldSpec>,
    normalized: Vec<NormalizedSpec>,
    pub no_data_hint: String,
}

impl SdkClientDataAdapter {
    fn matches_target(&self, target: &str) -> bool {
        self.targets
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(target.trim()))
    }

    pub fn decode(&self, raw: &[u8]) -> Option<SdkValues> {
        if raw.len() < self.definition.data_size {
            return None;
        }

        let mut values = HashMap::new();
        for field in &self.fields {
            values.insert(field.name.clone(), decode_field(raw, field));
        }
        Some(values)
    }

    pub fn normalize(&self, values: &SdkValues) -> Option<Value> {
        if self.normalized.is_empty() {
            return None;
        }

        let mut root = Map::new();
        for mapping in &self.normalized {
            let value = normalize_mapping(values, mapping);
            set_normalized_path(&mut root, &mapping.path, value);
        }
        Some(Value::Object(root))
    }
}

// Serde-only manifest types describe the accepted declarative schema. They are
// converted into the runtime adapter only after the full document is checked.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorManifest {
    kind: String,
    schema_version: u32,
    id: String,
    display_name: String,
    targets: Vec<String>,
    client_data: ClientDataManifest,
    #[serde(default)]
    no_data_hint: Option<String>,
    fields: Vec<FieldSpec>,
    #[serde(default)]
    normalized: Vec<NormalizedSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientDataManifest {
    name: String,
    data_id: u32,
    define_id: u32,
    request_id: u32,
    size: usize,
    #[serde(default = "default_client_data_period")]
    request_period: ClientDataPeriod,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldSpec {
    name: String,
    #[serde(default, rename = "type")]
    value_type: Option<String>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    op: Option<String>,
    #[serde(default)]
    terms: Vec<ReadTerm>,
    #[serde(default)]
    equals: Option<Value>,
    #[serde(default)]
    map: HashMap<String, Value>,
    #[serde(default)]
    ranges: Vec<IntegerRangeMapSpec>,
    #[serde(default)]
    fallback: Option<Value>,
    #[serde(default)]
    round: Option<u32>,
    #[serde(default)]
    when: Vec<ConditionSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntegerRangeMapSpec {
    min: i64,
    max: i64,
    value: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedSpec {
    path: String,
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    op: Option<String>,
    #[serde(default)]
    fields: Vec<String>,
    #[serde(default)]
    map: HashMap<String, Value>,
    #[serde(default)]
    fallback: Option<Value>,
    #[serde(default)]
    when: Vec<NormalizedCondition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedCondition {
    field: String,
    equals: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadTerm {
    #[serde(rename = "type")]
    value_type: String,
    offset: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConditionSpec {
    #[serde(rename = "type")]
    value_type: String,
    offset: usize,
    #[serde(default)]
    equals: Option<Value>,
    #[serde(default)]
    gt: Option<f64>,
    #[serde(default)]
    gte: Option<f64>,
    #[serde(default)]
    lt: Option<f64>,
    #[serde(default)]
    lte: Option<f64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReadType {
    Bool,
    U8,
    I16Le,
    U16Le,
    I32Le,
    U32Le,
    F32Le,
}

#[derive(Clone, Copy, Debug)]
enum ScalarValue {
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
}

// Public lookup helpers reload the bounded connector set and match targets
// case-insensitively. Invalid files are reported and skipped, never half-loaded.
pub fn resolve_clientdata_adapter(target: &str) -> Option<SdkClientDataAdapter> {
    load_adapters()
        .into_iter()
        .find(|adapter| adapter.matches_target(target))
}

pub fn supported_targets() -> Vec<String> {
    load_adapters()
        .into_iter()
        .flat_map(|adapter| adapter.targets)
        .collect()
}

pub fn unsupported_target_error(target: &str) -> String {
    format!(
        "unsupported_aircraft:{target}; supported_sdk_targets:{}",
        supported_targets().join(",")
    )
}

// Discovery accepts configured and packaged directories, then sorts/deduplicates
// files so adapter selection is deterministic across runs.
fn load_adapters() -> Vec<SdkClientDataAdapter> {
    let mut adapters = Vec::new();
    let mut seen_ids = HashSet::new();

    for path in connector_search_paths() {
        for connector_path in list_connector_files(&path) {
            push_adapter(
                &mut adapters,
                &mut seen_ids,
                parse_connector_file(&connector_path),
            );
        }
    }

    adapters
}

fn push_adapter(
    adapters: &mut Vec<SdkClientDataAdapter>,
    seen_ids: &mut HashSet<String>,
    result: Result<SdkClientDataAdapter, String>,
) {
    match result {
        Ok(adapter) => {
            let key = adapter.id.to_ascii_lowercase();
            if seen_ids.insert(key) {
                adapters.push(adapter);
            }
        }
        Err(err) => {
            let _ = writeln_stderr(format!("sdk_connector_ignored:{err}"));
        }
    }
}

fn connector_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for key in ["FF_SDK_CONNECTORS_PATHS", "FF_SDK_CONNECTORS_DIR"] {
        let Some(raw) = env::var_os(key) else {
            continue;
        };
        paths.extend(env::split_paths(&raw));
    }
    paths
}

fn list_connector_files(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return paths;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

fn parse_connector_file(path: &Path) -> Result<SdkClientDataAdapter, String> {
    let mut file = fs::File::open(path).map_err(|err| format!("{}:{err}", path.display()))?;
    let declared_len = file
        .metadata()
        .map_err(|err| format!("{}:{err}", path.display()))?
        .len();
    let text = read_connector_text(&mut file, declared_len)
        .map_err(|err| format!("{}:{err}", path.display()))?;
    parse_connector(&text).map_err(|err| format!("{}:{err}", path.display()))
}

fn read_connector_text(
    reader: &mut impl Read,
    declared_len: u64,
) -> Result<String, String> {
    if declared_len > MAX_CONNECTOR_BYTES {
        return Err(format!("connector_too_large:{declared_len}"));
    }

    let mut bytes = Vec::with_capacity(declared_len as usize + 1);
    reader
        .take(MAX_CONNECTOR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("connector_read_failed:{err}"))?;
    if bytes.len() as u64 > MAX_CONNECTOR_BYTES {
        return Err(format!("connector_too_large:>{MAX_CONNECTOR_BYTES}"));
    }
    String::from_utf8(bytes).map_err(|err| format!("connector_not_utf8:{err}"))
}

fn parse_connector(text: &str) -> Result<SdkClientDataAdapter, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let manifest: ConnectorManifest =
        serde_json::from_str(text).map_err(|err| format!("invalid_json:{err}"))?;
    validate_manifest(&manifest)?;

    Ok(SdkClientDataAdapter {
        id: manifest.id,
        display_name: manifest.display_name,
        targets: manifest.targets,
        definition: ClientDataDefinition {
            data_name: manifest.client_data.name,
            data_id: manifest.client_data.data_id,
            define_id: manifest.client_data.define_id,
            request_id: manifest.client_data.request_id,
            data_size: manifest.client_data.size,
            request_period: manifest.client_data.request_period,
        },
        fields: manifest.fields,
        normalized: manifest.normalized,
        no_data_hint: manifest.no_data_hint.unwrap_or_else(|| {
            "SDK values unavailable yet (check connector-specific setup)".to_string()
        }),
    })
}

// Validation is the security boundary for the declarative format. It constrains
// allocation sizes, byte ranges, operations, output paths, and cross-references.
fn validate_manifest(manifest: &ConnectorManifest) -> Result<(), String> {
    if manifest.kind != CONNECTOR_KIND {
        return Err(format!("unsupported_kind:{}", manifest.kind));
    }
    if manifest.schema_version != CONNECTOR_SCHEMA_VERSION {
        return Err(format!(
            "unsupported_schema_version:{}",
            manifest.schema_version
        ));
    }
    if !is_safe_connector_id(&manifest.id) {
        return Err(format!("invalid_id:{}", manifest.id));
    }
    if manifest.display_name.trim().is_empty() || manifest.display_name.len() > 96 {
        return Err("invalid_display_name".to_string());
    }
    if manifest.targets.is_empty() || manifest.targets.len() > 16 {
        return Err("invalid_targets".to_string());
    }
    for target in &manifest.targets {
        if !is_safe_target(target) {
            return Err(format!("invalid_target:{target}"));
        }
    }
    if manifest.client_data.name.trim().is_empty()
        || manifest.client_data.name.len() > 128
        || manifest.client_data.name.contains('\0')
    {
        return Err("invalid_clientdata_name".to_string());
    }
    if manifest.client_data.size == 0 || manifest.client_data.size > MAX_CLIENT_DATA_SIZE {
        return Err(format!(
            "invalid_clientdata_size:{}",
            manifest.client_data.size
        ));
    }
    if manifest.fields.is_empty() || manifest.fields.len() > MAX_FIELDS {
        return Err("invalid_fields".to_string());
    }

    let mut field_names = HashSet::new();
    for field in &manifest.fields {
        validate_field(field, manifest.client_data.size)?;
        if !field_names.insert(field.name.to_ascii_lowercase()) {
            return Err(format!("duplicate_field:{}", field.name));
        }
    }
    validate_normalized(&manifest.normalized, &field_names)?;
    Ok(())
}

fn validate_normalized(
    normalized: &[NormalizedSpec],
    field_names: &HashSet<String>,
) -> Result<(), String> {
    if normalized.len() > MAX_NORMALIZED_MAPPINGS {
        return Err("too_many_normalized_mappings".to_string());
    }

    for mapping in normalized {
        if !is_safe_normalized_path(&mapping.path) {
            return Err(format!("invalid_normalized_path:{}", mapping.path));
        }
        if mapping.map.len() > 64 {
            return Err(format!("normalized_map_too_large:{}", mapping.path));
        }
        for value in mapping.map.values() {
            validate_output_value(value, &mapping.path)?;
        }
        if let Some(value) = &mapping.fallback {
            validate_output_value(value, &mapping.path)?;
        }

        match mapping.op.as_deref().unwrap_or("copy") {
            "copy" | "read" => {
                let Some(field) = mapping.field.as_deref() else {
                    return Err(format!("normalized_missing_field:{}", mapping.path));
                };
                validate_normalized_field_ref(field, field_names, &mapping.path)?;
                if !mapping.fields.is_empty() {
                    return Err(format!("normalized_copy_has_fields:{}", mapping.path));
                }
            }
            "any" => {
                if mapping.fields.is_empty() || mapping.fields.len() > 16 {
                    return Err(format!("invalid_normalized_any_fields:{}", mapping.path));
                }
                if mapping.field.is_some() {
                    return Err(format!("normalized_any_has_field:{}", mapping.path));
                }
                for field in &mapping.fields {
                    validate_normalized_field_ref(field, field_names, &mapping.path)?;
                }
            }
            other => return Err(format!("unsupported_normalized_op:{other}")),
        }

        if mapping.when.len() > 16 {
            return Err(format!("too_many_normalized_conditions:{}", mapping.path));
        }
        for condition in &mapping.when {
            validate_normalized_field_ref(&condition.field, field_names, &mapping.path)?;
            validate_output_value(&condition.equals, &mapping.path)?;
        }
    }
    Ok(())
}

fn validate_normalized_field_ref(
    field: &str,
    field_names: &HashSet<String>,
    path: &str,
) -> Result<(), String> {
    if !is_safe_field_name(field) {
        return Err(format!("invalid_normalized_field_ref:{path}:{field}"));
    }
    if !field_names.contains(&field.to_ascii_lowercase()) {
        return Err(format!("unknown_normalized_field_ref:{path}:{field}"));
    }
    Ok(())
}

fn validate_field(field: &FieldSpec, data_size: usize) -> Result<(), String> {
    if !is_safe_field_name(&field.name) {
        return Err(format!("invalid_field_name:{}", field.name));
    }
    if field.map.len() > 64 {
        return Err(format!("field_map_too_large:{}", field.name));
    }
    for value in field.map.values() {
        validate_output_value(value, &field.name)?;
    }
    if field.ranges.len() > 64 {
        return Err(format!("field_ranges_too_large:{}", field.name));
    }
    for range in &field.ranges {
        validate_output_value(&range.value, &field.name)?;
    }
    if let Some(value) = &field.fallback {
        validate_output_value(value, &field.name)?;
    }
    if let Some(value) = &field.equals {
        validate_output_value(value, &field.name)?;
    }

    match field.op.as_deref().unwrap_or("read") {
        "read" => {
            let read_type = parse_read_type(field.value_type.as_deref().unwrap_or_default())?;
            let offset = field
                .offset
                .ok_or_else(|| format!("field_missing_offset:{}", field.name))?;
            validate_read_bounds(offset, read_type, data_size, &field.name)?;
            validate_integer_ranges(field, read_type)?;
        }
        "any" => {
            if !field.ranges.is_empty() {
                return Err(format!("field_ranges_require_read:{}", field.name));
            }
            if field.terms.is_empty() || field.terms.len() > 16 {
                return Err(format!("invalid_any_terms:{}", field.name));
            }
            for term in &field.terms {
                let read_type = parse_read_type(&term.value_type)?;
                validate_read_bounds(term.offset, read_type, data_size, &field.name)?;
            }
        }
        other => return Err(format!("unsupported_field_op:{other}")),
    }

    for condition in &field.when {
        let read_type = parse_read_type(&condition.value_type)?;
        validate_read_bounds(condition.offset, read_type, data_size, &field.name)?;
    }
    Ok(())
}

fn validate_integer_ranges(field: &FieldSpec, read_type: ReadType) -> Result<(), String> {
    if field.ranges.is_empty() {
        return Ok(());
    }
    if field.equals.is_some() || field.round.is_some() {
        return Err(format!("field_ranges_conflict:{}", field.name));
    }

    let Some((type_min, type_max)) = integer_read_bounds(read_type) else {
        return Err(format!("field_ranges_require_integer:{}", field.name));
    };

    for (index, range) in field.ranges.iter().enumerate() {
        if range.min > range.max {
            return Err(format!("field_range_inverted:{}:{index}", field.name));
        }
        if range.min < type_min || range.max > type_max {
            return Err(format!("field_range_out_of_type:{}:{index}", field.name));
        }
        if field.ranges[..index]
            .iter()
            .any(|other| range.min <= other.max && other.min <= range.max)
        {
            return Err(format!("field_ranges_overlap:{}:{index}", field.name));
        }
    }

    for key in field.map.keys().filter(|key| key.as_str() != "*") {
        let exact = key
            .parse::<i64>()
            .map_err(|_| format!("field_range_map_key_not_integer:{}:{key}", field.name))?;
        if exact < type_min || exact > type_max {
            return Err(format!(
                "field_range_map_key_out_of_type:{}:{key}",
                field.name
            ));
        }
        if field
            .ranges
            .iter()
            .any(|range| exact >= range.min && exact <= range.max)
        {
            return Err(format!("field_range_map_key_overlap:{}:{key}", field.name));
        }
    }
    Ok(())
}

fn integer_read_bounds(read_type: ReadType) -> Option<(i64, i64)> {
    match read_type {
        ReadType::U8 => Some((i64::from(u8::MIN), i64::from(u8::MAX))),
        ReadType::I16Le => Some((i64::from(i16::MIN), i64::from(i16::MAX))),
        ReadType::U16Le => Some((i64::from(u16::MIN), i64::from(u16::MAX))),
        ReadType::I32Le => Some((i64::from(i32::MIN), i64::from(i32::MAX))),
        ReadType::U32Le => Some((i64::from(u32::MIN), i64::from(u32::MAX))),
        ReadType::Bool | ReadType::F32Le => None,
    }
}

fn validate_read_bounds(
    offset: usize,
    read_type: ReadType,
    data_size: usize,
    field_name: &str,
) -> Result<(), String> {
    let width = read_width(read_type);
    if offset.checked_add(width).is_none_or(|end| end > data_size) {
        return Err(format!("field_out_of_bounds:{field_name}:{offset}+{width}"));
    }
    Ok(())
}

fn validate_output_value(value: &Value, field_name: &str) -> Result<(), String> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(value) if value.len() <= 128 => Ok(()),
        _ => Err(format!("unsupported_output_value:{field_name}")),
    }
}

fn parse_read_type(raw: &str) -> Result<ReadType, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "bool" | "boolean" => Ok(ReadType::Bool),
        "u8" | "uint8" => Ok(ReadType::U8),
        "i16le" | "int16le" => Ok(ReadType::I16Le),
        "u16le" | "uint16le" => Ok(ReadType::U16Le),
        "i32le" | "int32le" => Ok(ReadType::I32Le),
        "u32le" | "uint32le" => Ok(ReadType::U32Le),
        "f32le" | "float32le" => Ok(ReadType::F32Le),
        other => Err(format!("unsupported_read_type:{other}")),
    }
}

fn read_width(read_type: ReadType) -> usize {
    match read_type {
        ReadType::Bool | ReadType::U8 => 1,
        ReadType::I16Le | ReadType::U16Le => size_of::<u16>(),
        ReadType::I32Le | ReadType::U32Le | ReadType::F32Le => size_of::<u32>(),
    }
}

// Field decoding happens only after validation proved every read fits inside
// `data_size`; runtime length is checked again by `SdkClientDataAdapter::decode`.
fn decode_field(raw: &[u8], field: &FieldSpec) -> Value {
    if !field
        .when
        .iter()
        .all(|condition| condition_matches(raw, condition))
    {
        return Value::Null;
    }

    if field.op.as_deref() == Some("any") {
        return json!(field.terms.iter().any(|term| {
            parse_read_type(&term.value_type)
                .ok()
                .and_then(|read_type| read_scalar(raw, term.offset, read_type))
                .is_some_and(scalar_truthy)
        }));
    }

    let Some(read_type) = field
        .value_type
        .as_deref()
        .and_then(|value_type| parse_read_type(value_type).ok())
    else {
        return Value::Null;
    };

    let Some(value) = read_scalar(raw, field.offset.unwrap_or_default(), read_type) else {
        return Value::Null;
    };

    if let Some(expected) = &field.equals {
        return json!(scalar_equals(value, expected));
    }

    if !field.map.is_empty() || !field.ranges.is_empty() {
        let key = scalar_map_key(value);
        if let Some(mapped) = field.map.get(&key) {
            return materialize_output_value(mapped, value);
        }
        if let Some(integer) = scalar_to_i64(value) {
            if let Some(range) = field
                .ranges
                .iter()
                .find(|range| integer >= range.min && integer <= range.max)
            {
                return materialize_output_value(&range.value, value);
            }
        }
        if let Some(mapped) = field.map.get("*") {
            return materialize_output_value(mapped, value);
        }
        if let Some(fallback) = &field.fallback {
            return materialize_output_value(fallback, value);
        }
        if !field.ranges.is_empty() {
            return Value::Null;
        }
    }

    let mut output = scalar_to_json(value);
    if let Some(decimals) = field.round {
        output = round_json_number(&output, decimals);
    }
    output
}

// Normalized mappings turn decoded flat fields into the stable nested shape
// consumed by the backend; manifest paths are validated before reaching here.
fn normalize_mapping(values: &SdkValues, mapping: &NormalizedSpec) -> Value {
    if !mapping
        .when
        .iter()
        .all(|condition| normalized_condition_matches(values, condition))
    {
        return Value::Null;
    }

    let source = match mapping.op.as_deref().unwrap_or("copy") {
        "any" => normalized_any(values, &mapping.fields),
        _ => mapping
            .field
            .as_deref()
            .and_then(|field| values.get(field))
            .cloned()
            .unwrap_or(Value::Null),
    };

    apply_normalized_map(source, mapping)
}

fn normalized_condition_matches(values: &SdkValues, condition: &NormalizedCondition) -> bool {
    values
        .get(&condition.field)
        .is_some_and(|value| value == &condition.equals)
}

fn normalized_any(values: &SdkValues, fields: &[String]) -> Value {
    let mut saw_falsey = false;
    for field in fields {
        match values.get(field).and_then(value_truthy) {
            Some(true) => return json!(true),
            Some(false) => saw_falsey = true,
            None => {}
        }
    }
    if saw_falsey {
        json!(false)
    } else {
        Value::Null
    }
}

fn apply_normalized_map(source: Value, mapping: &NormalizedSpec) -> Value {
    if mapping.map.is_empty() {
        return source;
    }

    let key = value_map_key(&source);
    if let Some(mapped) = mapping.map.get(&key).or_else(|| mapping.map.get("*")) {
        return materialize_normalized_output(mapped, &source);
    }
    if let Some(fallback) = &mapping.fallback {
        return materialize_normalized_output(fallback, &source);
    }
    source
}

fn set_normalized_path(root: &mut Map<String, Value>, path: &str, value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    set_normalized_path_parts(root, &parts, value);
}

fn set_normalized_path_parts(map: &mut Map<String, Value>, parts: &[&str], value: Value) {
    let Some((key, rest)) = parts.split_first() else {
        return;
    };
    if rest.is_empty() {
        map.insert((*key).to_string(), value);
        return;
    }

    let entry = map
        .entry((*key).to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    if let Value::Object(child) = entry {
        set_normalized_path_parts(child, rest, value);
    }
}

fn condition_matches(raw: &[u8], condition: &ConditionSpec) -> bool {
    let Some(value) = parse_read_type(&condition.value_type)
        .ok()
        .and_then(|read_type| read_scalar(raw, condition.offset, read_type))
    else {
        return false;
    };

    if let Some(expected) = &condition.equals {
        return scalar_equals(value, expected);
    }

    let Some(numeric) = scalar_to_f64(value) else {
        return false;
    };

    if condition.gt.is_some_and(|threshold| numeric <= threshold) {
        return false;
    }
    if condition.gte.is_some_and(|threshold| numeric < threshold) {
        return false;
    }
    if condition.lt.is_some_and(|threshold| numeric >= threshold) {
        return false;
    }
    if condition.lte.is_some_and(|threshold| numeric > threshold) {
        return false;
    }
    true
}

// All raw scalar reads use checked slices and explicit little-endian decoding;
// no pointer casts into the manifest-controlled offset are needed.
fn read_scalar(raw: &[u8], offset: usize, read_type: ReadType) -> Option<ScalarValue> {
    let end = offset.checked_add(read_width(read_type))?;
    if end > raw.len() {
        return None;
    }
    match read_type {
        ReadType::Bool => Some(ScalarValue::Bool(raw[offset] != 0)),
        ReadType::U8 => Some(ScalarValue::U64(u64::from(raw[offset]))),
        ReadType::I16Le => {
            let bytes = [raw[offset], raw[offset + 1]];
            Some(ScalarValue::I64(i64::from(i16::from_le_bytes(bytes))))
        }
        ReadType::U16Le => {
            let bytes = [raw[offset], raw[offset + 1]];
            Some(ScalarValue::U64(u64::from(u16::from_le_bytes(bytes))))
        }
        ReadType::I32Le => {
            let bytes = [
                raw[offset],
                raw[offset + 1],
                raw[offset + 2],
                raw[offset + 3],
            ];
            Some(ScalarValue::I64(i64::from(i32::from_le_bytes(bytes))))
        }
        ReadType::U32Le => {
            let bytes = [
                raw[offset],
                raw[offset + 1],
                raw[offset + 2],
                raw[offset + 3],
            ];
            Some(ScalarValue::U64(u64::from(u32::from_le_bytes(bytes))))
        }
        ReadType::F32Le => {
            let bytes = [
                raw[offset],
                raw[offset + 1],
                raw[offset + 2],
                raw[offset + 3],
            ];
            Some(ScalarValue::F64(f64::from(f32::from_le_bytes(bytes))))
        }
    }
}

fn scalar_truthy(value: ScalarValue) -> bool {
    match value {
        ScalarValue::Bool(value) => value,
        ScalarValue::I64(value) => value != 0,
        ScalarValue::U64(value) => value != 0,
        ScalarValue::F64(value) => value.is_finite() && value != 0.0,
    }
}

fn scalar_to_f64(value: ScalarValue) -> Option<f64> {
    match value {
        ScalarValue::Bool(_) => None,
        ScalarValue::I64(value) => Some(value as f64),
        ScalarValue::U64(value) => Some(value as f64),
        ScalarValue::F64(value) if value.is_finite() => Some(value),
        ScalarValue::F64(_) => None,
    }
}

fn scalar_to_i64(value: ScalarValue) -> Option<i64> {
    match value {
        ScalarValue::I64(value) => Some(value),
        ScalarValue::U64(value) => i64::try_from(value).ok(),
        ScalarValue::Bool(_) | ScalarValue::F64(_) => None,
    }
}

fn scalar_equals(value: ScalarValue, expected: &Value) -> bool {
    match (value, expected) {
        (ScalarValue::Bool(left), Value::Bool(right)) => left == *right,
        (ScalarValue::I64(left), Value::Number(right)) => right.as_i64() == Some(left),
        (ScalarValue::U64(left), Value::Number(right)) => right.as_u64() == Some(left),
        (ScalarValue::F64(left), Value::Number(right)) => right
            .as_f64()
            .is_some_and(|right| (left - right).abs() < f64::EPSILON),
        _ => false,
    }
}

fn scalar_map_key(value: ScalarValue) -> String {
    match value {
        ScalarValue::Bool(true) => "true".to_string(),
        ScalarValue::Bool(false) => "false".to_string(),
        ScalarValue::I64(value) => value.to_string(),
        ScalarValue::U64(value) => value.to_string(),
        ScalarValue::F64(value) if value.fract() == 0.0 => (value as i64).to_string(),
        ScalarValue::F64(value) => value.to_string(),
    }
}

fn value_truthy(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => value
            .as_f64()
            .map(|number| number.is_finite() && number != 0.0),
        Value::String(value) => Some(!value.is_empty()),
        Value::Null => None,
        _ => None,
    }
}

fn value_map_key(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(value) => {
            if let Some(number) = value.as_i64() {
                return number.to_string();
            }
            if let Some(number) = value.as_u64() {
                return number.to_string();
            }
            if let Some(number) = value.as_f64() {
                if number.fract() == 0.0 {
                    return (number as i64).to_string();
                }
                return number.to_string();
            }
            "null".to_string()
        }
        Value::String(value) => value.clone(),
        _ => "null".to_string(),
    }
}

fn scalar_to_json(value: ScalarValue) -> Value {
    match value {
        ScalarValue::Bool(value) => json!(value),
        ScalarValue::I64(value) => json!(value),
        ScalarValue::U64(value) => json!(value),
        ScalarValue::F64(value) => json!(value),
    }
}

fn materialize_output_value(template: &Value, source: ScalarValue) -> Value {
    match template {
        Value::String(value) if value == "$value" => scalar_to_json(source),
        Value::String(value) if value == "$valueString" => Value::String(scalar_map_key(source)),
        _ => template.clone(),
    }
}

fn materialize_normalized_output(template: &Value, source: &Value) -> Value {
    match template {
        Value::String(value) if value == "$value" => source.clone(),
        Value::String(value) if value == "$valueString" => Value::String(value_map_key(source)),
        _ => template.clone(),
    }
}

fn round_json_number(value: &Value, decimals: u32) -> Value {
    let Some(number) = value.as_f64() else {
        return value.clone();
    };
    if !number.is_finite() {
        return Value::Null;
    }

    let clamped_decimals = decimals.min(6);
    let factor = 10_f64.powi(clamped_decimals as i32);
    let rounded = (number * factor).round() / factor;
    if clamped_decimals == 0 {
        json!(rounded as i64)
    } else {
        json!(rounded)
    }
}

// Token validators keep connector identifiers and generated JSON paths within a
// small printable grammar before they are used as map keys or diagnostics.
fn is_safe_connector_id(value: &str) -> bool {
    is_safe_token(value, 96, |ch| {
        ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.'
    })
}

fn is_safe_target(value: &str) -> bool {
    is_safe_token(value, 96, |ch| {
        ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.'
    })
}

fn is_safe_field_name(value: &str) -> bool {
    is_safe_token(value, 96, |ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn is_safe_normalized_path(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    !parts.is_empty()
        && parts.len() <= 8
        && value.len() <= 256
        && parts.iter().all(|part| is_safe_field_name(part))
}

fn is_safe_token(value: &str, max_len: usize, valid: impl Fn(char) -> bool) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_len {
        return false;
    }
    let Some(first) = trimmed.chars().next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    trimmed.chars().all(valid)
}

fn writeln_stderr(message: String) -> io::Result<()> {
    use std::io::{self, Write};
    let _ = writeln!(io::stderr(), "[ff-rust-simconnect-sidecar] {message}");
    io::stderr().flush()
}

#[cfg(test)]
mod tests {
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

    fn test_adapter() -> SdkClientDataAdapter {
        parse_connector(&test_connector_manifest()).expect("test connector should parse")
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
}
