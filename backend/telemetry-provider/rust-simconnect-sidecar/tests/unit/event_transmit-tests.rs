
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
