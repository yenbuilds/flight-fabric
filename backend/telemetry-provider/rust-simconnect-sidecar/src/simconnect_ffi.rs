//! Minimal raw FFI surface for the SimConnect APIs used by FlightFabric.
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

pub(crate) const fn hresult_succeeded(hr: Hresult) -> bool {
    // Equivalent to the Windows SUCCEEDED macro.
    hr >= 0
}

// These function-pointer types are populated at runtime by `SimConnectApi`.
pub(crate) type DispatchProc = unsafe extern "system" fn(*mut SimConnectRecv, Dword, *mut c_void);
pub(crate) type SimConnectOpen =
    unsafe extern "system" fn(*mut Handle, *const c_char, Hwnd, Dword, Handle, Dword) -> Hresult;
pub(crate) type SimConnectClose = unsafe extern "system" fn(Handle) -> Hresult;
pub(crate) type SimConnectEnumerateInputEvents =
    unsafe extern "system" fn(Handle, Dword) -> Hresult;
pub(crate) type SimConnectEnumerateInputEventParams =
    unsafe extern "system" fn(Handle, u64) -> Hresult;
pub(crate) type SimConnectSetInputEvent =
    unsafe extern "system" fn(Handle, u64, Dword, *mut c_void) -> Hresult;
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
pub(crate) type SimConnectTransmitClientEventEx1 = unsafe extern "system" fn(
    Handle, Dword, Dword, Dword, Dword, Dword, Dword, Dword, Dword, Dword,
) -> Hresult;
pub(crate) type SimConnectGetLastSentPacketId =
    unsafe extern "system" fn(Handle, *mut Dword) -> Hresult;
pub(crate) type SimConnectSetDataOnSimObject =
    unsafe extern "system" fn(Handle, Dword, Dword, Dword, Dword, Dword, *const c_void) -> Hresult;
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
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/simconnect_ffi-tests.rs"));
}
