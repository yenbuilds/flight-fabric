//! One native event dispatch, with the exact transport included in its ACK.
use crate::simconnect_ffi::*;
use serde_json::{json, Value};

pub(crate) struct EventTransmitter {
    pub(crate) handle: Handle,
    pub(crate) transmit_client_event: SimConnectTransmitClientEvent,
    pub(crate) transmit_client_event_ex1: Option<SimConnectTransmitClientEventEx1>,
}

impl EventTransmitter {
    pub(crate) fn transmit(
        &self,
        event_id: Dword,
        view_event: bool,
        data: [Dword; 5],
        parameter_count: usize,
    ) -> Result<(bool, Value), String> {
        if !(1..=5).contains(&parameter_count) {
            return Err("invalid event parameter count".to_string());
        }
        let object_id = SIMCONNECT_OBJECT_ID_USER;
        let flags = if view_event {
            SIMCONNECT_EVENT_FLAG_DEFAULT
        } else {
            SIMCONNECT_EVENT_FLAG_GROUPID_IS_PRIORITY
        };
        let use_ex1 = parameter_count > 1 && self.transmit_client_event_ex1.is_some();
        let legacy_zero_fallback = parameter_count > 1 && !use_ex1;
        if legacy_zero_fallback && data[1..parameter_count].iter().any(|value| *value != 0) {
            return Err("SimConnect_TransmitClientEvent_EX1 is unavailable".to_string());
        }
        // SAFETY: the session owns the live DLL and handle for this call; data
        // contains the bounded DWORDs validated at the command boundary.
        let hr = unsafe {
            if use_ex1 {
                self.transmit_client_event_ex1.unwrap()(
                    self.handle,
                    object_id,
                    event_id,
                    SIMCONNECT_GROUP_PRIORITY_HIGHEST,
                    flags,
                    data[0],
                    data[1],
                    data[2],
                    data[3],
                    data[4],
                )
            } else {
                (self.transmit_client_event)(
                    self.handle,
                    object_id,
                    event_id,
                    data[0],
                    SIMCONNECT_GROUP_PRIORITY_HIGHEST,
                    flags,
                )
            }
        };
        Ok((
            hr >= 0,
            json!({
                "version": 1,
                "api": if use_ex1 { "SimConnect_TransmitClientEvent_EX1" }
                    else { "SimConnect_TransmitClientEvent" },
                "objectId": object_id,
                "eventId": event_id,
                "groupPriority": SIMCONNECT_GROUP_PRIORITY_HIGHEST,
                "flags": flags,
                "data": if use_ex1 { data.to_vec() } else { vec![data[0]] },
                "requestedParameterCount": parameter_count,
                "legacyZeroFallback": legacy_zero_fallback,
                "hresult": format!("0x{:08X}", hr as u32),
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/event_transmit-tests.rs"));
}
