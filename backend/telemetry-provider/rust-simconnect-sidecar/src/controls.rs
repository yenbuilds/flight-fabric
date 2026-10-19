//! Validation and conversion helpers for commands that can change simulator
//! state.
//!
//! Command JSON has already been parsed by the time it reaches this module,
//! but its strings and numbers are still untrusted input. Keeping the allowed
//! character sets, numeric limits, and SimConnect-specific conversions here
//! gives every control path in `main.rs` the same fail-closed policy.

// These limits bound both memory use and the values passed across the FFI boundary.
const MAX_CONTROL_NAME_LEN: usize = 160;
const MAX_CONTROL_UNIT_LEN: usize = 48;
const MAX_CONTROL_NUMERIC_ABS: f64 = 1_000_000.0;

// MSFS 2024 rejects the documentation's unprefixed names for these two
// events with SIMCONNECT_EXCEPTION_UNRECOGNIZED_ID. Keep the application
// command names (and their DWORD validation/lease) but map the actual names
// accepted by SimConnect. TUG_DISABLE is already accepted without KEY_.
pub(crate) fn simconnect_event_name(name: &str) -> &str {
    match name {
        "TUG_HEADING" => "KEY_TUG_HEADING",
        "TUG_SPEED" => "KEY_TUG_SPEED",
        _ => name,
    }
}

fn is_safe_control_char(ch: char, allow_hash: bool) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            ' ' | '_' | '.' | '/' | ':' | '+' | '%' | '(' | ')' | '-'
        )
        || (allow_hash && ch == '#')
}

pub(crate) fn is_safe_control_name(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_CONTROL_NAME_LEN
        && trimmed.chars().all(|ch| is_safe_control_char(ch, true))
}

pub(crate) fn is_safe_control_unit(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_CONTROL_UNIT_LEN
        && trimmed.chars().all(|ch| is_safe_control_char(ch, false))
}

pub(crate) fn is_bounded_control_number(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_CONTROL_NUMERIC_ABS
}

// General SimConnect events historically accept signed-looking values encoded
// in the API's u32 field, so this path rounds before preserving those bits.
pub(crate) fn bounded_event_data(value: f64) -> Option<u32> {
    if !is_bounded_control_number(value) {
        return None;
    }
    Some(value.round() as i64 as u32)
}

// These two standby setters take Hz, above the general event ceiling. Keep
// their exception exact and reject invalid channel designators without rounding.
pub(crate) fn bounded_named_event_data(
    name: &str,
    value: f64,
    parameter_count: usize,
) -> Option<u32> {
    // A negative speed becomes a huge positive DWORD in MSFS 2024. Never
    // dispatch nonzero tug speed; normal pushback owns its reverse speed.
    if matches!(name, "TUG_SPEED" | "KEY_TUG_SPEED") {
        return if value == 0.0 && parameter_count == 0 { Some(0) } else { None };
    }
    if name == "TUG_HEADING" {
        return if parameter_count == 0 { bounded_sdk_event_data(value) } else { None };
    }
    if !matches!(name, "COM_STBY_RADIO_SET_HZ" | "COM2_STBY_RADIO_SET_HZ") {
        return bounded_event_data(value);
    }
    if parameter_count != 0
        || !value.is_finite()
        || !(118_000_000.0..=136_990_000.0).contains(&value)
        || value.fract() != 0.0
    {
        return None;
    }
    let hz = value as u32;
    if hz % 1000 != 0 || !matches!((hz / 1000) % 25, 0 | 5 | 10 | 15) {
        return None;
    }
    Some(hz)
}

// SDK event IDs are stricter: only an exact, non-negative u32 is accepted.
pub(crate) fn bounded_sdk_event_data(value: f64) -> Option<u32> {
    if !value.is_finite() || value < 0.0 || value > u32::MAX as f64 || value.fract() != 0.0 {
        return None;
    }
    Some(value as u32)
}

pub(crate) fn is_safe_sdk_event_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 6 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/controls-tests.rs"));
}
