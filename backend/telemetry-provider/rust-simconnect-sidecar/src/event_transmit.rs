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
    use super::*;
    use std::cell::RefCell;
    thread_local! { static CALLS: RefCell<Vec<Vec<Dword>>> = const { RefCell::new(Vec::new()) }; }
    unsafe extern "system" fn legacy(
        _: Handle,
        object: Dword,
        event: Dword,
        data: Dword,
        group: Dword,
        flags: Dword,
    ) -> Hresult {
        CALLS.with(|calls| {
            calls
                .borrow_mut()
                .push(vec![object, event, data, group, flags])
        });
        0
    }
    unsafe extern "system" fn ex1(
        _: Handle,
        object: Dword,
        event: Dword,
        group: Dword,
        flags: Dword,
        a: Dword,
        b: Dword,
        c: Dword,
        d: Dword,
        e: Dword,
    ) -> Hresult {
        CALLS.with(|calls| {
            calls
                .borrow_mut()
                .push(vec![object, event, group, flags, a, b, c, d, e])
        });
        0
    }
    fn transmitter(has_ex1: bool) -> EventTransmitter {
        CALLS.with(|calls| calls.borrow_mut().clear());
        EventTransmitter {
            handle: std::ptr::null_mut(),
            transmit_client_event: legacy,
            transmit_client_event_ex1: if has_ex1 { Some(ex1) } else { None },
        }
    }
    #[test]
    fn explicit_light_on_and_off_use_ex1_state_then_index_on_user_aircraft() {
        for state in [0, 1] {
            let tx = transmitter(true);
            let (ok, trace) = tx.transmit(42, false, [state, 0, 0, 0, 0], 2).unwrap();
            assert!(ok);
            CALLS.with(|calls| {
                assert_eq!(*calls.borrow(), vec![vec![0, 42, 1, 16, state, 0, 0, 0, 0]])
            });
            assert_eq!(trace["api"], "SimConnect_TransmitClientEvent_EX1");
            assert_eq!(trace["legacyZeroFallback"], false);
        }
    }
    #[test]
    fn old_single_value_path_and_unavailable_ex1_are_identifiable() {
        let tx = transmitter(true);
        let (_, old) = tx.transmit(42, false, [1, 0, 0, 0, 0], 1).unwrap();
        CALLS.with(|calls| assert_eq!(*calls.borrow(), vec![vec![0, 42, 1, 1, 16]]));
        assert_eq!(old["legacyZeroFallback"], false);
        let tx = transmitter(false);
        let (_, fallback) = tx.transmit(42, false, [1, 0, 0, 0, 0], 2).unwrap();
        assert_eq!(fallback["api"], "SimConnect_TransmitClientEvent");
        assert_eq!(fallback["legacyZeroFallback"], true);
        CALLS.with(|calls| assert_eq!(calls.borrow().len(), 1));
    }
    #[test]
    fn nonzero_secondary_data_never_falls_back_or_retries() {
        let tx = transmitter(false);
        assert!(tx.transmit(42, false, [1, 3, 0, 0, 0], 2).is_err());
        CALLS.with(|calls| assert!(calls.borrow().is_empty()));
    }
    #[test]
    fn full_ex1_payload_and_camera_flags_retain_their_native_order() {
        let tx = transmitter(true);
        tx.transmit(42, false, [275, 3, 4, 5, 6], 5).unwrap();
        CALLS.with(|calls| assert_eq!(*calls.borrow(), vec![vec![0, 42, 1, 16, 275, 3, 4, 5, 6]]));
        let tx = transmitter(true);
        tx.transmit(43, true, [1, 0, 0, 0, 0], 1).unwrap();
        CALLS.with(|calls| assert_eq!(*calls.borrow(), vec![vec![0, 43, 1, 1, 0]]));
        assert!(tx.transmit(42, false, [0; 5], 0).is_err());
        assert!(tx.transmit(42, false, [0; 5], 6).is_err());
        CALLS.with(|calls| assert_eq!(calls.borrow().len(), 1));
    }
    #[test]
    fn failed_ex1_is_not_replayed_through_legacy() {
        unsafe extern "system" fn failed(
            _: Handle,
            _: Dword,
            _: Dword,
            _: Dword,
            _: Dword,
            _: Dword,
            _: Dword,
            _: Dword,
            _: Dword,
            _: Dword,
        ) -> Hresult {
            -1
        }
        let mut tx = transmitter(true);
        tx.transmit_client_event_ex1 = Some(failed);
        let (ok, trace) = tx.transmit(42, false, [1, 0, 0, 0, 0], 2).unwrap();
        assert!(!ok);
        assert_eq!(trace["hresult"], "0xFFFFFFFF");
        CALLS.with(|calls| assert!(calls.borrow().is_empty()));
    }
}
