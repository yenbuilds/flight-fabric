//! Validation and conversion helpers for commands that can change simulator
//! state.
//!
//! Command JSON has already been parsed by the time it reaches this module,
//! but its strings and numbers are still untrusted input. Keeping the allowed
//! character sets, numeric limits, and SimConnect-specific conversions here
//! gives every control path in `main.rs` the same fail-closed policy.

// Camera movement has deliberately tighter limits than general numeric controls.
pub(crate) const MAX_CAMERA_OFFSET_METERS: f64 = 2.0;
pub(crate) const MAX_CAMERA_ANGLE_DEGREES: f64 = 15.0;

// These limits bound both memory use and the values passed across the FFI boundary.
const MAX_CONTROL_NAME_LEN: usize = 160;
const MAX_CONTROL_UNIT_LEN: usize = 48;
const MAX_CONTROL_NUMERIC_ABS: f64 = 1_000_000.0;

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

// SDK event IDs are stricter: only an exact, non-negative u32 is accepted.
pub(crate) fn bounded_sdk_event_data(value: f64) -> Option<u32> {
    if !value.is_finite()
        || value < 0.0
        || value > u32::MAX as f64
        || value.fract() != 0.0
    {
        return None;
    }
    Some(value as u32)
}

pub(crate) fn is_safe_sdk_event_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 6 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_digit)
}

pub(crate) fn is_bounded_camera_number(value: f64, max_abs: f64) -> bool {
    value.is_finite() && value.abs() <= max_abs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_control_payload_tokens_and_extreme_values() {
        assert!(is_safe_control_name("AP_ALT_VAR_SET_ENGLISH"));
        assert!(is_safe_control_name("L:SDK_TEST_VAR"));
        assert!(!is_safe_control_name(""));
        assert!(!is_safe_control_name("BAD;Remove-Item"));
        assert!(!is_safe_control_unit("Feet; rm"));
        assert!(bounded_event_data(-9900.0).is_some());
        assert!(bounded_event_data(f64::NAN).is_none());
        assert!(bounded_event_data(1_000_001.0).is_none());
        assert_eq!(bounded_sdk_event_data(0x20000000 as f64), Some(0x20000000));
        assert_eq!(bounded_sdk_event_data(u32::MAX as f64), Some(u32::MAX));
        assert!(bounded_sdk_event_data(-1.0).is_none());
        assert!(bounded_sdk_event_data(1.5).is_none());
        assert!(is_safe_sdk_event_name("#70361"));
        assert!(!is_safe_sdk_event_name("AP_MASTER"));
        assert!(!is_bounded_camera_number(30.0, MAX_CAMERA_ANGLE_DEGREES));
        assert!(is_bounded_camera_number(1.5, MAX_CAMERA_OFFSET_METERS));
    }
}
