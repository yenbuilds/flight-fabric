//! Best-effort display metadata from Windows PnP. No HID device opens or I/O.
use std::mem::size_of_val;
use windows_sys::Win32::{
    Devices::{DeviceAndDriverInstallation::*, Properties::*},
    Foundation::DEVPROPKEY,
};

fn property_string(buffer: &[u16], bytes: u32, kind: u32) -> Option<String> {
    if kind != DEVPROP_TYPE_STRING || bytes < 2 || !bytes.is_multiple_of(2) {
        return None;
    }
    let value = buffer.get(..bytes as usize / 2)?;
    let end = value.iter().position(|c| *c == 0)?;
    let value = String::from_utf16(&value[..end]).ok()?;
    (!value.is_empty()).then_some(value)
}

fn read_string(query: impl FnOnce(*mut u8, &mut u32, &mut u32) -> u32) -> Option<String> {
    // Fixed allocation; missing/oversized/racing properties simply use a fallback.
    let mut buffer = [0_u16; 1024];
    let mut bytes = size_of_val(&buffer) as u32;
    let mut kind = 0;
    if query(buffer.as_mut_ptr().cast(), &mut bytes, &mut kind) != CR_SUCCESS {
        return None;
    }
    property_string(&buffer, bytes, kind)
}

fn node_string(node: u32, key: &DEVPROPKEY) -> Option<String> {
    // SAFETY: read_string owns and bounds the output storage for this call.
    read_string(|buffer, bytes, kind| unsafe {
        CM_Get_DevNode_PropertyW(node, key, kind, buffer, bytes, 0)
    })
}

fn container(node: u32) -> Option<[u32; 4]> {
    let mut value = [0_u32; 4]; // GUID-sized/aligned; equality only, never exposed.
    let mut bytes = size_of_val(&value) as u32;
    let mut kind = 0;
    // SAFETY: all outputs are owned and correctly sized/aligned.
    let result = unsafe {
        CM_Get_DevNode_PropertyW(
            node,
            &DEVPKEY_Device_ContainerId,
            &mut kind,
            value.as_mut_ptr().cast(),
            &mut bytes,
            0,
        )
    };
    (result == CR_SUCCESS && kind == DEVPROP_TYPE_GUID && bytes == 16 && value != [0; 4])
        .then_some(value)
}

fn display_name(value: String) -> Option<String> {
    let clean: String = value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let name: String = clean
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(100)
        .collect();
    (!name.is_empty()).then_some(name)
}

pub fn controller_name(path: &str) -> Option<String> {
    let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let interface_string = |key: &DEVPROPKEY| {
        // SAFETY: path is a live NUL-terminated string; output is owned by read_string.
        read_string(|buffer, bytes, kind| unsafe {
            CM_Get_Device_Interface_PropertyW(path.as_ptr(), key, kind, buffer, bytes, 0)
        })
    };
    let fallback = interface_string(&DEVPKEY_DeviceInterface_FriendlyName).and_then(display_name);
    let Some(instance) = interface_string(&DEVPKEY_Device_InstanceId) else {
        return fallback;
    };
    let instance: Vec<u16> = instance.encode_utf16().chain(Some(0)).collect();
    let mut node = 0;
    // SAFETY: instance is NUL-terminated; node is writable. No device is opened.
    if unsafe { CM_Locate_DevNodeW(&mut node, instance.as_ptr(), CM_LOCATE_DEVNODE_NORMAL) }
        != CR_SUCCESS
    {
        return fallback;
    }
    let fallback =
        fallback.or_else(|| node_string(node, &DEVPKEY_Device_DeviceDesc).and_then(display_name));
    let original_container = container(node);
    // Composite HID collections can keep their product name on a parent node.
    // Never borrow a hub/computer name: stay within the same physical container.
    for _ in 0..4 {
        for key in [
            &DEVPKEY_Device_BusReportedDeviceDesc,
            &DEVPKEY_Device_FriendlyName,
        ] {
            if let Some(name) = node_string(node, key).and_then(display_name) {
                return Some(name);
            }
        }
        let mut parent = 0;
        // SAFETY: parent is writable; the Configuration Manager owns the nodes.
        if original_container.is_none()
            || unsafe { CM_Get_Parent(&mut parent, node, 0) } != CR_SUCCESS
            || container(parent) != original_container
        {
            break;
        }
        node = parent;
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_or_oversized_property_strings() {
        let value = [b'A' as u16, 0];
        assert_eq!(
            property_string(&value, 4, DEVPROP_TYPE_STRING).as_deref(),
            Some("A")
        );
        for (bytes, kind) in [
            (0, DEVPROP_TYPE_STRING),
            (3, DEVPROP_TYPE_STRING),
            (6, DEVPROP_TYPE_STRING),
            (4, DEVPROP_TYPE_STRING_LIST),
        ] {
            assert!(property_string(&value, bytes, kind).is_none());
        }
        assert!(property_string(&[65, 66], 4, DEVPROP_TYPE_STRING).is_none());
        assert!(property_string(&[0xd800, 0], 4, DEVPROP_TYPE_STRING).is_none());
    }

    #[test]
    fn display_names_are_bounded_plain_text_and_optional() {
        assert_eq!(
            display_name("  T.16000M\t  Joystick\u{202e} ".into()).as_deref(),
            Some("T.16000M Joystick")
        );
        assert!(display_name("\n\t ".into()).is_none());
        assert_eq!(display_name("✈".repeat(500)).unwrap().chars().count(), 100);
    }
}
