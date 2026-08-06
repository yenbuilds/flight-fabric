//! Minimal raw FFI surface for the SimConnect APIs used by Flight Fabric.
//!
//! This is an ABI description, not application logic. Function signatures,
//! numeric constants, and `repr(C)` receive layouts must stay aligned with the
//! Microsoft SDK. Dynamic symbol loading lives in `dll_loader.rs`; higher-level
//! bounds checks and dispatch behavior live in the other modules. Keeping the
//! declarations here makes the crate's unsafe native boundary easy to audit.

use std::ffi::{c_char, c_void};
use std::mem::size_of;

// Windows SDK aliases are repeated locally to avoid pulling a broad Win32
// binding into this small sidecar.
pub(crate) type Dword = u32;
pub(crate) type Hresult = i32;
pub(crate) type Handle = *mut c_void;
pub(crate) type Hwnd = *mut c_void;

#[cfg(test)]
pub(crate) const S_OK: u32 = 0;
pub(crate) const SIMCONNECT_UNUSED: Dword = 0xFFFF_FFFF;
pub(crate) const SIMCONNECT_OBJECT_ID_USER: Dword = 0;
pub(crate) const SIMCONNECT_OBJECT_ID_USER_AIRCRAFT: Dword = 0;
pub(crate) const SIMCONNECT_GROUP_PRIORITY_HIGHEST: Dword = 1;
pub(crate) const SIMCONNECT_EVENT_FLAG_DEFAULT: Dword = 0x0000_0000;
pub(crate) const SIMCONNECT_EVENT_FLAG_GROUPID_IS_PRIORITY: Dword = 0x0000_0010;

pub(crate) const SIMCONNECT_RECV_ID_EXCEPTION: Dword = 1;
pub(crate) const SIMCONNECT_RECV_ID_OPEN: Dword = 2;
pub(crate) const SIMCONNECT_RECV_ID_QUIT: Dword = 3;
pub(crate) const SIMCONNECT_RECV_ID_EVENT: Dword = 4;
pub(crate) const SIMCONNECT_RECV_ID_SIMOBJECT_DATA: Dword = 8;
pub(crate) const SIMCONNECT_RECV_ID_SYSTEM_STATE: Dword = 15;
pub(crate) const SIMCONNECT_RECV_ID_CLIENT_DATA: Dword = 16;
pub(crate) const SIMCONNECT_RECV_ID_FACILITY_DATA: Dword = 28;
pub(crate) const SIMCONNECT_RECV_ID_FACILITY_DATA_END: Dword = 29;

pub(crate) const SYSTEM_REQUEST_AIRCRAFT_LOADED: Dword = 7001;
pub(crate) const SYSTEM_REQUEST_SIM: Dword = 7002;
pub(crate) const SYSTEM_REQUEST_DIALOG_MODE: Dword = 7003;
pub(crate) const EVENT_SIM_START: Dword = 9101;
pub(crate) const EVENT_SIM_STOP: Dword = 9102;

pub(crate) const SIMCONNECT_PERIOD_NEVER: Dword = 0;
pub(crate) const SIMCONNECT_PERIOD_ONCE: Dword = 1;
pub(crate) const SIMCONNECT_PERIOD_SIM_FRAME: Dword = 3;

pub(crate) const SIMCONNECT_DATA_REQUEST_FLAG_DEFAULT: Dword = 0;
pub(crate) const SIMCONNECT_CLIENT_DATA_PERIOD_NEVER: Dword = 0;
pub(crate) const SIMCONNECT_CLIENT_DATA_PERIOD_VISUAL_FRAME: Dword = 2;
pub(crate) const SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET: Dword = 3;
pub(crate) const SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT: Dword = 0;
pub(crate) const SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_CHANGED: Dword = 1;
pub(crate) const SIMCONNECT_CLIENT_DATA_SET_FLAG_DEFAULT: Dword = 0;
pub(crate) const SIMCONNECT_CREATE_CLIENT_DATA_FLAG_DEFAULT: Dword = 0;

pub(crate) const SIMCONNECT_DATATYPE_INT32: Dword = 1;
pub(crate) const SIMCONNECT_DATATYPE_FLOAT32: Dword = 3;
pub(crate) const SIMCONNECT_DATATYPE_FLOAT64: Dword = 4;
pub(crate) const SIMCONNECT_DATATYPE_STRING256: Dword = 9;
pub(crate) const SIMCONNECT_DATATYPE_XYZ: Dword = 16;

pub(crate) const fn hresult_succeeded(hr: Hresult) -> bool {
    // Equivalent to the Windows SUCCEEDED macro.
    hr >= 0
}

// These function-pointer types are populated at runtime by `SimConnectApi`.
pub(crate) type DispatchProc = unsafe extern "system" fn(*mut SimConnectRecv, Dword, *mut c_void);
pub(crate) type SimConnectOpen =
    unsafe extern "system" fn(*mut Handle, *const c_char, Hwnd, Dword, Handle, Dword) -> Hresult;
pub(crate) type SimConnectClose = unsafe extern "system" fn(Handle) -> Hresult;
pub(crate) type SimConnectCallDispatch =
    unsafe extern "system" fn(Handle, DispatchProc, *mut c_void) -> Hresult;
pub(crate) type SimConnectAddToDataDefinition = unsafe extern "system" fn(
    Handle,
    Dword,
    *const c_char,
    *const c_char,
    Dword,
    f32,
    Dword,
) -> Hresult;
pub(crate) type SimConnectClearDataDefinition = unsafe extern "system" fn(Handle, Dword) -> Hresult;
pub(crate) type SimConnectRequestDataOnSimObject = unsafe extern "system" fn(
    Handle,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
) -> Hresult;
pub(crate) type SimConnectMapClientEventToSimEvent =
    unsafe extern "system" fn(Handle, Dword, *const c_char) -> Hresult;
pub(crate) type SimConnectTransmitClientEvent =
    unsafe extern "system" fn(Handle, Dword, Dword, Dword, Dword, Dword) -> Hresult;
pub(crate) type SimConnectGetLastSentPacketId =
    unsafe extern "system" fn(Handle, *mut Dword) -> Hresult;
pub(crate) type SimConnectSetDataOnSimObject =
    unsafe extern "system" fn(Handle, Dword, Dword, Dword, Dword, Dword, *const c_void) -> Hresult;
pub(crate) type SimConnectCameraSetRelative6Dof =
    unsafe extern "system" fn(Handle, f32, f32, f32, f32, f32, f32) -> Hresult;
pub(crate) type SimConnectMapClientDataNameToId =
    unsafe extern "system" fn(Handle, *const c_char, Dword) -> Hresult;
pub(crate) type SimConnectCreateClientData =
    unsafe extern "system" fn(Handle, Dword, Dword, Dword) -> Hresult;
pub(crate) type SimConnectAddToClientDataDefinition =
    unsafe extern "system" fn(Handle, Dword, Dword, Dword, f32, Dword) -> Hresult;
pub(crate) type SimConnectClearClientDataDefinition =
    unsafe extern "system" fn(Handle, Dword) -> Hresult;
pub(crate) type SimConnectRequestClientData = unsafe extern "system" fn(
    Handle,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
) -> Hresult;
pub(crate) type SimConnectSetClientData = unsafe extern "system" fn(
    Handle,
    Dword,
    Dword,
    Dword,
    Dword,
    Dword,
    *const c_void,
) -> Hresult;
pub(crate) type SimConnectRequestSystemState =
    unsafe extern "system" fn(Handle, Dword, *const c_char) -> Hresult;
pub(crate) type SimConnectSubscribeToSystemEvent =
    unsafe extern "system" fn(Handle, Dword, *const c_char) -> Hresult;
pub(crate) type SimConnectAddToFacilityDefinition =
    unsafe extern "system" fn(Handle, Dword, *const c_char) -> Hresult;
pub(crate) type SimConnectRequestFacilityData = unsafe extern "system" fn(
    Handle,
    Dword,
    Dword,
    *const c_char,
    *const c_char,
) -> Hresult;

// Receive structures begin with the common three-DWORD header. Payload-bearing
// messages use a trailing placeholder field just like the C SDK declarations.
#[repr(C)]
pub(crate) struct SimConnectRecv {
    pub(crate) dw_size: Dword,
    pub(crate) dw_version: Dword,
    pub(crate) dw_id: Dword,
}

#[repr(C)]
pub(crate) struct SimConnectRecvSimObjectData {
    pub(crate) dw_size: Dword,
    pub(crate) dw_version: Dword,
    pub(crate) dw_id: Dword,
    pub(crate) dw_request_id: Dword,
    pub(crate) dw_object_id: Dword,
    pub(crate) dw_define_id: Dword,
    pub(crate) dw_flags: Dword,
    pub(crate) dw_entry_number: Dword,
    pub(crate) dw_out_of: Dword,
    pub(crate) dw_define_count: Dword,
    pub(crate) dw_data: Dword,
}

#[repr(C)]
pub(crate) struct SimConnectRecvException {
    pub(crate) dw_size: Dword,
    pub(crate) dw_version: Dword,
    pub(crate) dw_id: Dword,
    pub(crate) dw_exception: Dword,
    pub(crate) dw_send_id: Dword,
    pub(crate) dw_index: Dword,
}

#[repr(C)]
pub(crate) struct SimConnectRecvEvent {
    pub(crate) dw_size: Dword,
    pub(crate) dw_version: Dword,
    pub(crate) dw_id: Dword,
    pub(crate) u_group_id: Dword,
    pub(crate) u_event_id: Dword,
    pub(crate) dw_data: Dword,
}

#[repr(C)]
pub(crate) struct SimConnectRecvSystemState {
    pub(crate) dw_size: Dword,
    pub(crate) dw_version: Dword,
    pub(crate) dw_id: Dword,
    pub(crate) dw_request_id: Dword,
    pub(crate) dw_integer: Dword,
    pub(crate) f_float: f32,
    pub(crate) sz_string: [c_char; 260],
}

#[repr(C)]
pub(crate) struct SimConnectRecvFacilityData {
    pub(crate) dw_size: Dword,
    pub(crate) dw_version: Dword,
    pub(crate) dw_id: Dword,
    pub(crate) user_request_id: Dword,
    pub(crate) unique_request_id: Dword,
    pub(crate) parent_unique_request_id: Dword,
    pub(crate) facility_type: Dword,
    pub(crate) is_list_item: i32,
    pub(crate) item_index: Dword,
    pub(crate) list_size: Dword,
    pub(crate) data: Dword,
}

#[repr(C)]
pub(crate) struct SimConnectRecvFacilityDataEnd {
    pub(crate) dw_size: Dword,
    pub(crate) dw_version: Dword,
    pub(crate) dw_id: Dword,
    pub(crate) request_id: Dword,
}

#[repr(C)]
pub(crate) struct SimConnectDataXyz {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) z: f64,
}

// SimConnect reports the callback byte count separately. These helpers prevent
// callers from reading a fixed header or trailing payload that was not supplied.
pub(crate) fn callback_has_size<T>(cb_data: Dword) -> bool {
    cb_data as usize >= size_of::<T>()
}

pub(crate) fn simobject_data_offset() -> usize {
    size_of::<SimConnectRecvSimObjectData>() - size_of::<Dword>()
}

pub(crate) fn simobject_payload_len(cb_data: Dword) -> Option<usize> {
    (cb_data as usize).checked_sub(simobject_data_offset())
}

pub(crate) fn facility_data_offset() -> usize {
    size_of::<SimConnectRecvFacilityData>() - size_of::<Dword>()
}

pub(crate) fn facility_payload_len(cb_data: Dword) -> Option<usize> {
    (cb_data as usize).checked_sub(facility_data_offset())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{align_of, offset_of};

    #[test]
    fn fixed_receive_struct_byte_layouts_match_the_simconnect_sdk() {
        assert_eq!(size_of::<SimConnectRecv>(), 12);
        assert_eq!(align_of::<SimConnectRecv>(), 4);
        assert_eq!(offset_of!(SimConnectRecv, dw_size), 0);
        assert_eq!(offset_of!(SimConnectRecv, dw_version), 4);
        assert_eq!(offset_of!(SimConnectRecv, dw_id), 8);

        assert_eq!(size_of::<SimConnectRecvException>(), 24);
        assert_eq!(align_of::<SimConnectRecvException>(), 4);
        assert_eq!(offset_of!(SimConnectRecvException, dw_size), 0);
        assert_eq!(offset_of!(SimConnectRecvException, dw_version), 4);
        assert_eq!(offset_of!(SimConnectRecvException, dw_id), 8);
        assert_eq!(offset_of!(SimConnectRecvException, dw_exception), 12);
        assert_eq!(offset_of!(SimConnectRecvException, dw_send_id), 16);
        assert_eq!(offset_of!(SimConnectRecvException, dw_index), 20);

        assert_eq!(size_of::<SimConnectRecvEvent>(), 24);
        assert_eq!(align_of::<SimConnectRecvEvent>(), 4);
        assert_eq!(offset_of!(SimConnectRecvEvent, dw_size), 0);
        assert_eq!(offset_of!(SimConnectRecvEvent, dw_version), 4);
        assert_eq!(offset_of!(SimConnectRecvEvent, dw_id), 8);
        assert_eq!(offset_of!(SimConnectRecvEvent, u_group_id), 12);
        assert_eq!(offset_of!(SimConnectRecvEvent, u_event_id), 16);
        assert_eq!(offset_of!(SimConnectRecvEvent, dw_data), 20);

        assert_eq!(size_of::<SimConnectRecvSystemState>(), 284);
        assert_eq!(align_of::<SimConnectRecvSystemState>(), 4);
        assert_eq!(offset_of!(SimConnectRecvSystemState, dw_size), 0);
        assert_eq!(offset_of!(SimConnectRecvSystemState, dw_version), 4);
        assert_eq!(offset_of!(SimConnectRecvSystemState, dw_id), 8);
        assert_eq!(offset_of!(SimConnectRecvSystemState, dw_request_id), 12);
        assert_eq!(offset_of!(SimConnectRecvSystemState, dw_integer), 16);
        assert_eq!(offset_of!(SimConnectRecvSystemState, f_float), 20);
        assert_eq!(offset_of!(SimConnectRecvSystemState, sz_string), 24);

        assert_eq!(size_of::<SimConnectRecvFacilityDataEnd>(), 16);
        assert_eq!(align_of::<SimConnectRecvFacilityDataEnd>(), 4);
        assert_eq!(offset_of!(SimConnectRecvFacilityDataEnd, dw_size), 0);
        assert_eq!(offset_of!(SimConnectRecvFacilityDataEnd, dw_version), 4);
        assert_eq!(offset_of!(SimConnectRecvFacilityDataEnd, dw_id), 8);
        assert_eq!(offset_of!(SimConnectRecvFacilityDataEnd, request_id), 12);
    }

    #[test]
    fn variable_receive_struct_byte_layouts_match_the_simconnect_sdk() {
        assert_eq!(size_of::<SimConnectRecvSimObjectData>(), 44);
        assert_eq!(align_of::<SimConnectRecvSimObjectData>(), 4);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_size), 0);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_version), 4);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_id), 8);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_request_id), 12);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_object_id), 16);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_define_id), 20);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_flags), 24);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_entry_number), 28);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_out_of), 32);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_define_count), 36);
        assert_eq!(offset_of!(SimConnectRecvSimObjectData, dw_data), 40);
        assert_eq!(
            simobject_data_offset(),
            offset_of!(SimConnectRecvSimObjectData, dw_data)
        );

        assert_eq!(size_of::<SimConnectRecvFacilityData>(), 44);
        assert_eq!(align_of::<SimConnectRecvFacilityData>(), 4);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, dw_size), 0);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, dw_version), 4);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, dw_id), 8);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, user_request_id), 12);
        assert_eq!(
            offset_of!(SimConnectRecvFacilityData, unique_request_id),
            16
        );
        assert_eq!(
            offset_of!(SimConnectRecvFacilityData, parent_unique_request_id),
            20
        );
        assert_eq!(offset_of!(SimConnectRecvFacilityData, facility_type), 24);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, is_list_item), 28);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, item_index), 32);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, list_size), 36);
        assert_eq!(offset_of!(SimConnectRecvFacilityData, data), 40);
        assert_eq!(
            facility_data_offset(),
            offset_of!(SimConnectRecvFacilityData, data)
        );
    }

    #[test]
    fn xyz_data_layout_matches_the_simconnect_sdk() {
        assert_eq!(size_of::<SimConnectDataXyz>(), 24);
        assert_eq!(align_of::<SimConnectDataXyz>(), 8);
        assert_eq!(offset_of!(SimConnectDataXyz, x), 0);
        assert_eq!(offset_of!(SimConnectDataXyz, y), 8);
        assert_eq!(offset_of!(SimConnectDataXyz, z), 16);
    }

    #[test]
    fn receive_struct_alignment_difference_from_the_packed_sdk_is_explicit() {
        // SimConnect.h declares the receive hierarchy inside `#pragma pack(push, 1)`.
        // The Rust declarations currently reproduce its byte sizes and offsets, but
        // `repr(C)` gives them stronger alignment. Callback code must therefore not
        // infer that an SDK buffer is aligned merely because these layouts match.
        const SDK_RECEIVE_ALIGNMENT: usize = 1;
        for rust_alignment in [
            align_of::<SimConnectRecv>(),
            align_of::<SimConnectRecvException>(),
            align_of::<SimConnectRecvEvent>(),
            align_of::<SimConnectRecvSimObjectData>(),
            align_of::<SimConnectRecvSystemState>(),
            align_of::<SimConnectRecvFacilityData>(),
            align_of::<SimConnectRecvFacilityDataEnd>(),
        ] {
            assert_eq!(rust_alignment, align_of::<Dword>());
            assert!(rust_alignment > SDK_RECEIVE_ALIGNMENT);
        }
    }

    #[test]
    fn simconnect_constants_used_at_the_ffi_boundary_match_the_sdk() {
        assert_eq!(SIMCONNECT_UNUSED, u32::MAX);
        assert_eq!(SIMCONNECT_OBJECT_ID_USER, 0);
        assert_eq!(SIMCONNECT_OBJECT_ID_USER_AIRCRAFT, 0);
        assert_eq!(SIMCONNECT_GROUP_PRIORITY_HIGHEST, 1);
        assert_eq!(SIMCONNECT_EVENT_FLAG_DEFAULT, 0);
        assert_eq!(SIMCONNECT_EVENT_FLAG_GROUPID_IS_PRIORITY, 0x10);

        assert_eq!(SIMCONNECT_RECV_ID_EXCEPTION, 1);
        assert_eq!(SIMCONNECT_RECV_ID_OPEN, 2);
        assert_eq!(SIMCONNECT_RECV_ID_QUIT, 3);
        assert_eq!(SIMCONNECT_RECV_ID_EVENT, 4);
        assert_eq!(SIMCONNECT_RECV_ID_SIMOBJECT_DATA, 8);
        assert_eq!(SIMCONNECT_RECV_ID_SYSTEM_STATE, 15);
        assert_eq!(SIMCONNECT_RECV_ID_CLIENT_DATA, 16);
        assert_eq!(SIMCONNECT_RECV_ID_FACILITY_DATA, 28);
        assert_eq!(SIMCONNECT_RECV_ID_FACILITY_DATA_END, 29);

        assert_eq!(SIMCONNECT_PERIOD_NEVER, 0);
        assert_eq!(SIMCONNECT_PERIOD_ONCE, 1);
        assert_eq!(SIMCONNECT_PERIOD_SIM_FRAME, 3);
        assert_eq!(SIMCONNECT_DATA_REQUEST_FLAG_DEFAULT, 0);
        assert_eq!(SIMCONNECT_CLIENT_DATA_PERIOD_NEVER, 0);
        assert_eq!(SIMCONNECT_CLIENT_DATA_PERIOD_VISUAL_FRAME, 2);
        assert_eq!(SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET, 3);
        assert_eq!(SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT, 0);
        assert_eq!(SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_CHANGED, 1);
        assert_eq!(SIMCONNECT_CLIENT_DATA_SET_FLAG_DEFAULT, 0);
        assert_eq!(SIMCONNECT_CREATE_CLIENT_DATA_FLAG_DEFAULT, 0);

        assert_eq!(SIMCONNECT_DATATYPE_INT32, 1);
        assert_eq!(SIMCONNECT_DATATYPE_FLOAT32, 3);
        assert_eq!(SIMCONNECT_DATATYPE_FLOAT64, 4);
        assert_eq!(SIMCONNECT_DATATYPE_STRING256, 9);
        assert_eq!(SIMCONNECT_DATATYPE_XYZ, 16);
    }

    #[test]
    fn callback_size_helpers_bound_simconnect_payload_reads() {
        assert!(!callback_has_size::<SimConnectRecv>(
            (size_of::<SimConnectRecv>() - 1) as Dword
        ));
        assert!(callback_has_size::<SimConnectRecv>(
            size_of::<SimConnectRecv>() as Dword
        ));
        assert_eq!(
            simobject_payload_len((simobject_data_offset() - 1) as Dword),
            None
        );
        assert_eq!(
            simobject_payload_len(simobject_data_offset() as Dword),
            Some(0)
        );
        assert_eq!(
            facility_payload_len((facility_data_offset() - 1) as Dword),
            None
        );
        assert_eq!(
            facility_payload_len(facility_data_offset() as Dword),
            Some(0)
        );
        assert_eq!(facility_data_offset(), 40);
    }

    #[test]
    fn facilities_recv_ids_match_msfs_2024_sdk_order() {
        assert_eq!(SIMCONNECT_RECV_ID_FACILITY_DATA, 28);
        assert_eq!(SIMCONNECT_RECV_ID_FACILITY_DATA_END, 29);
    }

    #[test]
    fn default_clientdata_request_flags_do_not_suppress_identical_responses() {
        assert_eq!(SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT, 0);
        assert_ne!(
            SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT,
            SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_CHANGED
        );
    }

    #[test]
    fn clear_clientdata_definition_ffi_uses_the_sdk_two_argument_signature() {
        unsafe extern "system" fn clear_definition(_handle: Handle, _define_id: Dword) -> Hresult {
            S_OK as Hresult
        }

        let clear: SimConnectClearClientDataDefinition = clear_definition;
        assert_eq!(unsafe { clear(std::ptr::null_mut(), 42) }, S_OK as Hresult);
    }

    #[test]
    fn hresult_success_uses_the_windows_sign_bit_contract() {
        assert!(hresult_succeeded(S_OK as Hresult));
        assert!(hresult_succeeded(1));
        assert!(hresult_succeeded(i32::MAX));
        assert!(!hresult_succeeded(0x8000_4005_u32 as Hresult));
        assert!(!hresult_succeeded(i32::MIN));
    }
}
