
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
