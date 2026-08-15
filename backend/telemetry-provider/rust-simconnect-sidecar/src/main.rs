// SPDX-License-Identifier: AGPL-3.0-only

//! Flight Fabric's Rust SimConnect sidecar executable.
//!
//! The sidecar is a small native bridge between the Node backend and Microsoft
//! Flight Simulator. Node sends newline-delimited JSON commands on stdin;
//! Windows SimConnect callbacks update session state; JSON status, telemetry,
//! facility, and acknowledgement messages are written to stdout.
//!
//! This file owns orchestration and process modes. Supporting modules isolate
//! wire parsing, subscription preparation, DLL/FFI access, optional ClientData
//! adapters, facility decoding, and Windows lifetime guarantees. The main
//! runtime is Windows-only, while lightweight non-Windows stubs keep capability
//! probing and tests predictable on other platforms.

#[cfg(windows)]
use serde_json::Map;
use serde_json::{json, Value};
#[cfg(windows)]
use std::collections::HashMap;
use std::io::{self, Write};
#[cfg(windows)]
use std::thread;
#[cfg(windows)]
use std::time::{Duration, Instant};

const OWNER_LIFELINE_VERSION: u32 = 1;

#[cfg(any(windows, test))]
mod sdk;

#[cfg(windows)]
mod controls;
#[cfg(windows)]
mod dll_loader;
#[cfg(windows)]
mod facilities;
#[cfg(windows)]
mod mobiflight;
#[cfg(windows)]
mod owner_lifeline;
#[cfg(windows)]
mod process_guardian;
#[cfg(windows)]
mod protocol;
#[cfg(windows)]
mod simconnect_ffi;
#[cfg(windows)]
mod subscriptions;
#[cfg(windows)]
mod windows_job;

fn emit_value(value: Value) {
    let _ = writeln!(io::stdout(), "{value}");
    let _ = io::stdout().flush();
}

#[cfg(windows)]
fn diag(message: impl AsRef<str>) {
    let _ = writeln!(
        io::stderr(),
        "[ff-rust-simconnect-sidecar] {}",
        message.as_ref()
    );
    let _ = io::stderr().flush();
}

// The Windows implementation contains the live SimConnect session and dispatch
// loop. Keeping it cfg-scoped prevents native APIs from leaking into other builds.
#[cfg(windows)]
mod sidecar {
    use super::*;
    use crate::controls::*;
    use crate::dll_loader::{has_simconnect_config, simconnect_server_ready, SimConnectApi};
    use crate::protocol::{
        receive_command_batch, start_stdin_thread, Command, Subscription, MAX_COMMANDS_PER_TICK,
    };
    use crate::simconnect_ffi::*;
    use crate::subscriptions::*;
    use crate::windows_job::KillOnCloseJob;
    use std::ffi::{c_void, CString};
    use std::mem::size_of;
    use std::os::windows::process::CommandExt;
    use std::process::{Command as ProcessCommand, Stdio};
    use std::ptr;
    use std::rc::Rc;
    use std::slice;

    const CONNECTION_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(50);
    const CONNECTION_PROBE_MAX_POLLS: usize = 200;
    const DISPATCH_FAILURE_GRACE: Duration = Duration::from_secs(2);
    const TELEMETRY_SILENCE_GRACE: Duration = Duration::from_secs(12);
    const SDK_SUBSCRIBE_RETRY_INTERVAL: Duration = Duration::from_secs(5);
    const SDK_CLIENT_DATA_ID_BASE: Dword = 0x4646_0000;
    const SDK_CLIENT_DATA_DEFINITION_ID_BASE: Dword = 0x4647_0000;
    const SDK_CLIENT_DATA_REQUEST_ID_BASE: Dword = 0x4648_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const MAX_CONCURRENT_FACILITY_REQUESTS: usize = 64;
    const MAX_PENDING_MESSAGES: usize = 1_024;
    const MAX_MAPPED_EVENTS: usize = 1_024;

    // Active requests describe how a registered definition is sampled. The
    // definition metadata in `DispatchContext` describes how replies are decoded.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum RequestMode {
        SimFrame,
        PollOnce,
    }

    struct ActiveRequest {
        request_id: Dword,
        definition_id: Dword,
        mode: RequestMode,
        poll_interval: Duration,
        last_requested_at: Instant,
    }

    // SimConnect invokes `dispatch_proc` with this mutable context. The callback
    // decodes and records state, queues completed responses for the main loop,
    // and emits only callback-specific diagnostics directly.
    struct DispatchContext {
        definitions: HashMap<Dword, Vec<DefinitionItem>>,
        values: HashMap<String, Value>,
        telemetry_sequence: u64,
        telemetry_updated_at: Option<String>,
        telemetry_updated_instant: Option<Instant>,
        connected: bool,
        quit: bool,
        sdk_aircraft: Option<String>,
        sdk_adapter: Option<sdk::SdkClientDataAdapter>,
        sdk_subscribed: bool,
        mobiflight: Option<mobiflight::ClientState>,
        library_spec: String,
        facility_airport_requests: HashMap<Dword, facilities::AirportFacilityRequest>,
        pending_messages: Vec<Value>,
    }

    impl DispatchContext {
        fn mark_telemetry_update(&mut self) {
            self.telemetry_sequence = self.telemetry_sequence.wrapping_add(1);
            self.telemetry_updated_at =
                Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            self.telemetry_updated_instant = Some(Instant::now());
        }

        fn reset_telemetry_stream(&mut self) {
            self.telemetry_updated_at = None;
            self.telemetry_updated_instant = None;
        }

        fn push_pending_message(&mut self, message: Value) -> bool {
            push_bounded(&mut self.pending_messages, message, MAX_PENDING_MESSAGES)
        }
    }

    #[derive(Default)]
    struct DispatchFailureGuard {
        first_failure_at: Option<Instant>,
    }

    impl DispatchFailureGuard {
        fn record_success(&mut self) {
            self.first_failure_at = None;
        }

        fn record_failure(&mut self, now: Instant) -> bool {
            let first_failure_at = *self.first_failure_at.get_or_insert(now);
            now.duration_since(first_failure_at) >= DISPATCH_FAILURE_GRACE
        }
    }

    fn telemetry_silence_expired(last_update: Option<Instant>, now: Instant) -> bool {
        last_update
            .is_some_and(|last_update| now.duration_since(last_update) >= TELEMETRY_SILENCE_GRACE)
    }

    fn sdk_subscription_retry_due(
        target_requested: bool,
        subscribed: bool,
        last_attempt: Instant,
        now: Instant,
    ) -> bool {
        target_requested
            && !subscribed
            && now.duration_since(last_attempt) >= SDK_SUBSCRIBE_RETRY_INTERVAL
    }

    fn attempt_sdk_subscription(
        last_attempt: &mut Instant,
        now: Instant,
        connect: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        // Stamp before invoking SimConnect so a synchronous failure cannot be
        // followed by an immediate retry in the same main-loop iteration.
        *last_attempt = now;
        connect()
    }

    fn sdk_client_data_period(period: sdk::ClientDataPeriod) -> Dword {
        match period {
            sdk::ClientDataPeriod::VisualFrame => SIMCONNECT_CLIENT_DATA_PERIOD_VISUAL_FRAME,
            sdk::ClientDataPeriod::OnSet => SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET,
        }
    }

    fn has_unemitted_telemetry_update(
        telemetry_sequence: u64,
        last_emitted_sequence: u64,
        telemetry_updated_at: Option<&str>,
    ) -> bool {
        telemetry_sequence != last_emitted_sequence && telemetry_updated_at.is_some()
    }

    fn push_bounded<T>(items: &mut Vec<T>, item: T, max_items: usize) -> bool {
        if items.len() >= max_items {
            return false;
        }
        items.push(item);
        true
    }

    fn can_start_facility_request(
        requests: &HashMap<Dword, facilities::AirportFacilityRequest>,
    ) -> bool {
        requests.len() < MAX_CONCURRENT_FACILITY_REQUESTS
    }

    fn can_map_event(mapped_events: &HashMap<String, Dword>) -> bool {
        mapped_events.len() < MAX_MAPPED_EVENTS
    }

    // This is the central unsafe callback boundary. Every receive variant is
    // size-checked before casting, and variable payload lengths are bounded
    // before being passed to their decoders.
    unsafe extern "system" fn dispatch_proc(
        data: *mut SimConnectRecv,
        cb_data: Dword,
        context: *mut c_void,
    ) {
        if data.is_null() || context.is_null() || !callback_has_size::<SimConnectRecv>(cb_data) {
            return;
        }
        let ctx = unsafe { &mut *(context as *mut DispatchContext) };
        let recv_id = unsafe { (*data).dw_id };
        match recv_id {
            SIMCONNECT_RECV_ID_OPEN => {
                ctx.connected = true;
            }
            SIMCONNECT_RECV_ID_EXCEPTION => {
                if !callback_has_size::<SimConnectRecvException>(cb_data) {
                    return;
                }
                let exception = unsafe { &*(data as *const SimConnectRecvException) };
                ctx.push_pending_message(json!({
                    "type": "exception",
                    "exception": exception.dw_exception,
                    "sendId": exception.dw_send_id,
                    "index": exception.dw_index,
                    "source": "rust-sidecar",
                    "backend": "rust",
                }));
            }
            SIMCONNECT_RECV_ID_QUIT => {
                ctx.connected = false;
                ctx.quit = true;
                if let Some(client) = ctx.mobiflight.as_mut() {
                    client.disconnected("simconnect_quit");
                }
                ctx.push_pending_message(json!({
                    "type": "lifecycle",
                    "event": "quit",
                    "source": "rust-sidecar",
                    "backend": "rust",
                }));
            }
            SIMCONNECT_RECV_ID_EVENT => {
                if !callback_has_size::<SimConnectRecvEvent>(cb_data) {
                    return;
                }
                let event = unsafe { &*(data as *const SimConnectRecvEvent) };
                let name = match event.u_event_id {
                    EVENT_SIM_START => Some("SimStart"),
                    EVENT_SIM_STOP => Some("SimStop"),
                    _ => None,
                };
                if let Some(name) = name {
                    ctx.push_pending_message(json!({
                        "type": "systemEvent",
                        "name": name,
                        "eventId": event.u_event_id,
                        "data": event.dw_data,
                        "source": "rust-sidecar",
                        "backend": "rust",
                        "timestampIso": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    }));
                }
            }
            SIMCONNECT_RECV_ID_SIMOBJECT_DATA => {
                if !callback_has_size::<SimConnectRecvSimObjectData>(cb_data) {
                    return;
                }
                let Some(payload_len) = simobject_payload_len(cb_data) else {
                    return;
                };
                let obj = unsafe { &*(data as *const SimConnectRecvSimObjectData) };
                if let Some(items) = ctx.definitions.get(&obj.dw_define_id) {
                    let Some(expected_len) = definition_payload_size(items) else {
                        return;
                    };
                    if payload_len < expected_len {
                        return;
                    }
                    let mut data_ptr = ptr::addr_of!(obj.dw_data) as *const u8;
                    for item in items {
                        let value = match item.data_type {
                            SIMCONNECT_DATATYPE_INT32 => {
                                let raw = unsafe { ptr::read_unaligned(data_ptr as *const i32) };
                                data_ptr = unsafe { data_ptr.add(size_of::<i32>()) };
                                json!(raw)
                            }
                            SIMCONNECT_DATATYPE_FLOAT32 => {
                                let raw = unsafe { ptr::read_unaligned(data_ptr as *const f32) };
                                data_ptr = unsafe { data_ptr.add(size_of::<f32>()) };
                                json!(raw)
                            }
                            SIMCONNECT_DATATYPE_STRING256 => {
                                let raw = unsafe { slice::from_raw_parts(data_ptr, 256) };
                                let len =
                                    raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
                                let text = String::from_utf8_lossy(&raw[..len]).trim().to_string();
                                data_ptr = unsafe { data_ptr.add(256) };
                                json!(text)
                            }
                            _ => {
                                let raw = unsafe { ptr::read_unaligned(data_ptr as *const f64) };
                                data_ptr = unsafe { data_ptr.add(size_of::<f64>()) };
                                json!(raw)
                            }
                        };
                        ctx.values.insert(item.key.clone(), value);
                    }
                    ctx.mark_telemetry_update();
                }
            }
            SIMCONNECT_RECV_ID_CLIENT_DATA => {
                if !callback_has_size::<SimConnectRecvSimObjectData>(cb_data) {
                    return;
                }
                let Some(payload_len) = simobject_payload_len(cb_data) else {
                    return;
                };
                let obj = unsafe { &*(data as *const SimConnectRecvSimObjectData) };
                if ctx.mobiflight.is_some()
                    && mobiflight::owns_response_packet(obj.dw_request_id, obj.dw_define_id)
                {
                    if payload_len < mobiflight::MESSAGE_SIZE {
                        return;
                    }
                    let raw_ptr = ptr::addr_of!(obj.dw_data) as *const u8;
                    let raw = unsafe {
                        slice::from_raw_parts(raw_ptr, mobiflight::MESSAGE_SIZE)
                    };
                    let response = mobiflight::decode_message(raw);
                    if let Some(client) = ctx.mobiflight.as_mut() {
                        client.handle_response(obj.dw_request_id, &response, Instant::now());
                    }
                    return;
                }
                if !ctx.sdk_subscribed {
                    return;
                }
                let Some(adapter) = ctx.sdk_adapter.as_ref() else {
                    return;
                };
                let definition = &adapter.definition;
                if obj.dw_request_id != definition.request_id {
                    return;
                }
                if payload_len < definition.data_size {
                    return;
                }
                let raw_ptr = ptr::addr_of!(obj.dw_data) as *const u8;
                let raw = unsafe { slice::from_raw_parts(raw_ptr, definition.data_size) };
                if let Some(values) = adapter.decode(raw) {
                    ctx.values = values;
                    ctx.mark_telemetry_update();
                }
            }
            SIMCONNECT_RECV_ID_SYSTEM_STATE => {
                if !callback_has_size::<SimConnectRecvSystemState>(cb_data) {
                    return;
                }
                let state = unsafe { &*(data as *const SimConnectRecvSystemState) };
                let name = match state.dw_request_id {
                    SYSTEM_REQUEST_AIRCRAFT_LOADED => Some("AircraftLoaded"),
                    SYSTEM_REQUEST_SIM => Some("Sim"),
                    SYSTEM_REQUEST_DIALOG_MODE => Some("DialogMode"),
                    _ => None,
                };
                if let Some(name) = name {
                    let raw = unsafe {
                        slice::from_raw_parts(
                            state.sz_string.as_ptr() as *const u8,
                            state.sz_string.len(),
                        )
                    };
                    let len = raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
                    let text = String::from_utf8_lossy(&raw[..len]).trim().to_string();
                    ctx.push_pending_message(json!({
                        "type": "systemState",
                        "name": name,
                        "requestId": state.dw_request_id,
                        "integer": state.dw_integer,
                        "float": state.f_float,
                        "string": text,
                        "source": "rust-sidecar",
                        "backend": "rust",
                        "timestampIso": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    }));
                }
            }
            SIMCONNECT_RECV_ID_FACILITY_DATA | SIMCONNECT_RECV_ID_FACILITY_DATA_END => {
                if callback_has_size::<SimConnectRecvFacilityData>(cb_data) {
                    let Some(payload_len) = facility_payload_len(cb_data) else {
                        emit_facility_debug(
                            "facility_data_bad_payload_len",
                            json!({ "recvId": recv_id, "cbData": cb_data }),
                        );
                        return;
                    };
                    let message = unsafe { &*(data as *const SimConnectRecvFacilityData) };
                    let matched = ctx
                        .facility_airport_requests
                        .contains_key(&message.user_request_id);
                    emit_facility_debug(
                        "facility_data_callback",
                        json!({
                            "recvId": recv_id,
                            "userRequestId": message.user_request_id,
                            "uniqueRequestId": message.unique_request_id,
                            "parentUniqueRequestId": message.parent_unique_request_id,
                            "facilityType": message.facility_type,
                            "isListItem": message.is_list_item,
                            "itemIndex": message.item_index,
                            "listSize": message.list_size,
                            "payloadBytes": payload_len,
                            "matched": matched,
                        }),
                    );
                    if let Some(request) = ctx
                        .facility_airport_requests
                        .get_mut(&message.user_request_id)
                    {
                        request.handle_data(message, payload_len);
                    }
                    return;
                }

                if callback_has_size::<SimConnectRecvFacilityDataEnd>(cb_data) {
                    let message = unsafe { &*(data as *const SimConnectRecvFacilityDataEnd) };
                    let matched = ctx.facility_airport_requests.contains_key(&message.request_id);
                    emit_facility_debug(
                        "facility_data_end_callback",
                        json!({
                            "recvId": recv_id,
                            "requestId": message.request_id,
                            "matched": matched,
                            "coercedBySize": recv_id == SIMCONNECT_RECV_ID_FACILITY_DATA,
                        }),
                    );
                    if let Some(request) = ctx.facility_airport_requests.remove(&message.request_id) {
                        ctx.push_pending_message(request.to_json(Some(&ctx.library_spec)));
                    }
                    return;
                }

                emit_facility_debug(
                    "facility_callback_too_short",
                    json!({
                        "recvId": recv_id,
                        "cbData": cb_data,
                        "minimumBytes": size_of::<SimConnectRecvFacilityDataEnd>(),
                    }),
                );
            }
            _ => {}
        }
    }

    fn hresult_ok(hr: Hresult) -> bool {
        hresult_succeeded(hr)
    }

    fn cached_or_try_load<T, E>(
        cached: &mut Option<Rc<T>>,
        load: impl FnOnce() -> Result<T, E>,
    ) -> Result<Rc<T>, E> {
        if let Some(value) = cached.as_ref() {
            return Ok(Rc::clone(value));
        }

        let value = Rc::new(load()?);
        *cached = Some(Rc::clone(&value));
        Ok(value)
    }

    fn poll_connection_probe<E>(
        max_polls: usize,
        poll_interval: Duration,
        mut try_poll: impl FnMut() -> Result<Option<bool>, E>,
        mut wait: impl FnMut(Duration),
    ) -> Result<Option<bool>, E> {
        for poll_index in 0..max_polls {
            if let Some(succeeded) = try_poll()? {
                return Ok(Some(succeeded));
            }
            if poll_index + 1 < max_polls {
                wait(poll_interval);
            }
        }
        Ok(None)
    }

    fn stop_connection_probe(child: &mut std::process::Child) {
        // Never turn the nominally bounded connection probe into an unbounded
        // shutdown wait. The child also watches this exact sidecar process, and
        // an assigned probe remains covered by the kill-on-close job.
        let _ = child.kill();
        let _ = poll_connection_probe(
            25,
            Duration::from_millis(20),
            || child.try_wait().map(|status| status.map(|_| true)),
            thread::sleep,
        );
    }

    fn connection_probe_owner_arg(owner_pid: u32) -> String {
        format!("--ff-owner-pid={owner_pid}")
    }

    fn isolated_connection_probe() -> Result<bool, String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("connection probe executable lookup failed: {error}"))?;
        let probe_job = KillOnCloseJob::new()?;
        let owner_arg = connection_probe_owner_arg(std::process::id());
        let mut child = ProcessCommand::new(executable)
            .arg("--connection-probe")
            .arg(owner_arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("connection probe spawn failed: {error}"))?;
        if let Err(error) = probe_job.assign(&child) {
            stop_connection_probe(&mut child);
            return Err(error);
        }

        match poll_connection_probe(
            CONNECTION_PROBE_MAX_POLLS,
            CONNECTION_PROBE_POLL_INTERVAL,
            || {
                child
                    .try_wait()
                    .map(|status| status.map(|status| status.success()))
            },
            thread::sleep,
        ) {
            Ok(Some(succeeded)) => Ok(succeeded),
            Ok(None) => {
                stop_connection_probe(&mut child);
                Err("connection probe timed out after 10 seconds".to_string())
            }
            Err(error) => {
                stop_connection_probe(&mut child);
                Err(format!("connection probe wait failed: {error}"))
            }
        }
    }

    fn simconnect_connection_ready() -> Result<bool, String> {
        if has_simconnect_config() {
            // Config index 0 may select a custom pipe or IPv4/IPv6 endpoint. Probe it in a
            // disposable process so a failed SimConnect_Open cannot grow this long-lived process.
            isolated_connection_probe()
        } else {
            simconnect_server_ready()
        }
    }

    fn sdk_subscription_is_current(
        subscribed: bool,
        active_adapter_id: Option<&str>,
        requested_adapter_id: &str,
        registered_definition_matches: bool,
    ) -> bool {
        subscribed
            && registered_definition_matches
            && active_adapter_id
                .is_some_and(|active| active.eq_ignore_ascii_case(requested_adapter_id))
    }

    fn sdk_mapping_requires_registration(
        mappings: &HashMap<Dword, String>,
        data_id: Dword,
        data_name: &str,
    ) -> Result<bool, String> {
        if let Some(mapped_name) = mappings.get(&data_id) {
            return if mapped_name.eq_ignore_ascii_case(data_name) {
                Ok(false)
            } else {
                Err(format!(
                    "ClientData id {data_id} is already mapped to {mapped_name:?}, not {data_name:?}"
                ))
            };
        }
        if let Some((mapped_id, _)) = mappings.iter().find(|(mapped_id, mapped_name)| {
            **mapped_id != data_id && mapped_name.eq_ignore_ascii_case(data_name)
        }) {
            return Err(format!(
                "ClientData name {data_name:?} is already mapped to id {mapped_id}, not {data_id}"
            ));
        }
        Ok(true)
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct SdkClientDataIds {
        data_id: Dword,
        define_id: Dword,
        request_id: Dword,
    }

    fn allocate_sdk_client_data_ids(
        allocations: &mut HashMap<String, SdkClientDataIds>,
        next_slot: &mut Dword,
        data_name: &str,
    ) -> Result<SdkClientDataIds, String> {
        let key = data_name.trim().to_ascii_lowercase();
        if let Some(ids) = allocations.get(&key) {
            return Ok(*ids);
        }

        let slot = *next_slot;
        let ids = SdkClientDataIds {
            data_id: SDK_CLIENT_DATA_ID_BASE
                .checked_add(slot)
                .ok_or_else(|| "SDK ClientData id space exhausted".to_string())?,
            define_id: SDK_CLIENT_DATA_DEFINITION_ID_BASE
                .checked_add(slot)
                .ok_or_else(|| "SDK ClientData definition id space exhausted".to_string())?,
            request_id: SDK_CLIENT_DATA_REQUEST_ID_BASE
                .checked_add(slot)
                .ok_or_else(|| "SDK ClientData request id space exhausted".to_string())?,
        };
        *next_slot = slot
            .checked_add(1)
            .ok_or_else(|| "SDK ClientData allocation space exhausted".to_string())?;
        allocations.insert(key, ids);
        Ok(ids)
    }

    fn replace_stream_after_sdk_disconnect<T, R>(
        state: &mut T,
        disconnect: impl FnOnce(&mut T) -> Result<(), String>,
        replace: impl FnOnce(&mut T) -> R,
    ) -> Result<R, String> {
        disconnect(state)?;
        Ok(replace(state))
    }

    fn cstring(value: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| format!("value contains NUL byte: {value:?}"))
    }

    fn unique_mobiflight_client_name() -> String {
        // A stable machine-scoped suffix avoids leaking a fresh WASM client area on every
        // Flight Fabric restart while remaining distinct from MobiFlight Connector clients.
        let identity = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "local".to_string());
        let hash = identity
            .as_bytes()
            .iter()
            .fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(1_099_511_628_211)
            });
        format!("Client_FlightFabric_{hash:016x}")
    }

    fn normalize_facility_icao(value: &str) -> Option<String> {
        let normalized = value.trim().to_uppercase();
        if normalized.len() < 2 || normalized.len() > 8 {
            return None;
        }
        if !normalized
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return None;
        }
        Some(normalized)
    }

    fn normalize_facility_region(value: &str) -> Option<String> {
        let normalized = value.trim().to_uppercase();
        if normalized.len() > 8 {
            return None;
        }
        if !normalized
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return None;
        }
        Some(normalized)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn test_subscription(key: &str, expression: &str) -> Subscription {
            Subscription {
                key: key.to_string(),
                expression: expression.to_string(),
                simvar: None,
                unit: Some("Number".to_string()),
                data_type: Some("float64".to_string()),
                isolated: false,
            }
        }

        fn test_command(command_type: &str, subscriptions: Vec<Subscription>) -> Command {
            Command {
                command_type: command_type.to_string(),
                request_id: Some(7),
                subscription_generation: None,
                subscriptions,
                aircraft: None,
                icao: None,
                region: None,
                name: None,
                code: None,
                unit: None,
                value: None,
                parameters: Vec::new(),
                x: None,
                y: None,
                z: None,
                units: None,
                pitch: None,
                bank: None,
                heading: None,
                dx: None,
                dy: None,
                dz: None,
                data_type: None,
                poll_interval_ms: None,
                chunk_size: None,
            }
        }

        fn test_dispatch_context() -> DispatchContext {
            DispatchContext {
                definitions: HashMap::new(),
                values: HashMap::new(),
                telemetry_sequence: 0,
                telemetry_updated_at: None,
                telemetry_updated_instant: None,
                connected: false,
                quit: false,
                sdk_aircraft: None,
                sdk_adapter: None,
                sdk_subscribed: false,
                mobiflight: None,
                library_spec: "test-simconnect".to_string(),
                facility_airport_requests: HashMap::new(),
                pending_messages: Vec::new(),
            }
        }

        fn aligned_callback_storage(byte_len: usize) -> Vec<u64> {
            vec![0; byte_len.div_ceil(size_of::<u64>())]
        }

        fn callback_bytes_mut(storage: &mut [u64]) -> &mut [u8] {
            // SAFETY: the returned byte slice covers the same initialized allocation,
            // and u8 has no alignment or invalid-bit-pattern requirements.
            unsafe {
                slice::from_raw_parts_mut(
                    storage.as_mut_ptr() as *mut u8,
                    std::mem::size_of_val(storage),
                )
            }
        }

        struct TestCommandState {
            subscriptions: Vec<Subscription>,
            subscription_kind: SubscriptionKind,
            simvar_chunk_size: usize,
            simvar_poll_interval: Duration,
            sdk_aircraft: Option<String>,
            subscription_generation: Option<u64>,
            last_sdk_subscribe_attempt: Instant,
        }

        impl TestCommandState {
            fn seeded() -> Self {
                Self {
                    subscriptions: vec![test_subscription("old", "(L:OLD)")],
                    subscription_kind: SubscriptionKind::Lvar,
                    simvar_chunk_size: 20,
                    simvar_poll_interval: Duration::from_millis(200),
                    sdk_aircraft: Some("test-clientdata".to_string()),
                    subscription_generation: Some(4),
                    last_sdk_subscribe_attempt: Instant::now(),
                }
            }

            fn handle(&mut self, command: Command) -> bool {
                handle_command(
                    command,
                    None,
                    &mut self.subscriptions,
                    &mut self.subscription_kind,
                    &mut self.simvar_chunk_size,
                    &mut self.simvar_poll_interval,
                    &mut self.sdk_aircraft,
                    &mut self.subscription_generation,
                    &mut self.last_sdk_subscribe_attempt,
                )
            }

            fn assert_seeded(&self) {
                assert_eq!(self.subscriptions.len(), 1);
                assert_eq!(self.subscriptions[0].key, "old");
                assert!(matches!(self.subscription_kind, SubscriptionKind::Lvar));
                assert_eq!(self.simvar_chunk_size, 20);
                assert_eq!(self.simvar_poll_interval, Duration::from_millis(200));
                assert_eq!(self.sdk_aircraft.as_deref(), Some("test-clientdata"));
                assert_eq!(self.subscription_generation, Some(4));
            }
        }

        #[test]
        fn callback_rejects_null_and_short_common_headers() {
            let mut context = test_dispatch_context();
            let mut message = SimConnectRecv {
                dw_size: size_of::<SimConnectRecv>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_OPEN,
            };

            // SAFETY: this deliberately exercises the callback's documented null guards.
            unsafe {
                dispatch_proc(
                    ptr::null_mut(),
                    size_of::<SimConnectRecv>() as Dword,
                    &mut context as *mut DispatchContext as *mut c_void,
                );
                dispatch_proc(
                    &mut message,
                    size_of::<SimConnectRecv>() as Dword,
                    ptr::null_mut(),
                );
            }
            assert!(!context.connected);

            // SAFETY: message and context remain live for the call; cb_data is
            // intentionally one byte short to characterize the size guard.
            unsafe {
                dispatch_proc(
                    &mut message,
                    (size_of::<SimConnectRecv>() - 1) as Dword,
                    &mut context as *mut DispatchContext as *mut c_void,
                );
            }
            assert!(!context.connected);

            // SAFETY: both pointers reference complete, live values for the call.
            unsafe {
                dispatch_proc(
                    &mut message,
                    size_of::<SimConnectRecv>() as Dword,
                    &mut context as *mut DispatchContext as *mut c_void,
                );
            }
            assert!(context.connected);
        }

        #[test]
        fn fixed_callback_variants_require_complete_headers() {
            let mut context = test_dispatch_context();
            let context_ptr = &mut context as *mut DispatchContext as *mut c_void;
            let mut exception = SimConnectRecvException {
                dw_size: size_of::<SimConnectRecvException>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_EXCEPTION,
                dw_exception: 5,
                dw_send_id: 17,
                dw_index: 3,
            };

            // SAFETY: the backing value is complete; the shorter cb_data is intentional.
            unsafe {
                dispatch_proc(
                    &mut exception as *mut SimConnectRecvException as *mut SimConnectRecv,
                    (size_of::<SimConnectRecvException>() - 1) as Dword,
                    context_ptr,
                );
            }
            assert!(context.pending_messages.is_empty());

            // SAFETY: exception and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut exception as *mut SimConnectRecvException as *mut SimConnectRecv,
                    size_of::<SimConnectRecvException>() as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages[0]["type"], "exception");
            assert_eq!(context.pending_messages[0]["sendId"], 17);

            let mut event = SimConnectRecvEvent {
                dw_size: size_of::<SimConnectRecvEvent>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_EVENT,
                u_group_id: 0,
                u_event_id: EVENT_SIM_START,
                dw_data: 9,
            };
            // SAFETY: event and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut event as *mut SimConnectRecvEvent as *mut SimConnectRecv,
                    size_of::<SimConnectRecvEvent>() as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages[1]["type"], "systemEvent");
            assert_eq!(context.pending_messages[1]["name"], "SimStart");

            let mut state = SimConnectRecvSystemState {
                dw_size: size_of::<SimConnectRecvSystemState>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_SYSTEM_STATE,
                dw_request_id: SYSTEM_REQUEST_AIRCRAFT_LOADED,
                dw_integer: 1,
                f_float: 2.5,
                sz_string: [0; 260],
            };
            for (slot, byte) in state.sz_string.iter_mut().zip(b"  C172  \0") {
                *slot = *byte as std::ffi::c_char;
            }
            // SAFETY: state and context are complete and live for both calls.
            unsafe {
                dispatch_proc(
                    &mut state as *mut SimConnectRecvSystemState as *mut SimConnectRecv,
                    (size_of::<SimConnectRecvSystemState>() - 1) as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages.len(), 2);

            // SAFETY: state and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut state as *mut SimConnectRecvSystemState as *mut SimConnectRecv,
                    size_of::<SimConnectRecvSystemState>() as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.pending_messages[2]["type"], "systemState");
            assert_eq!(context.pending_messages[2]["string"], "C172");
        }

        #[test]
        fn simobject_callback_requires_complete_payload_and_decodes_supported_types() {
            let definition_id = 41;
            let mut context = test_dispatch_context();
            context.definitions.insert(
                definition_id,
                vec![
                    DefinitionItem {
                        key: "integer".to_string(),
                        data_type: SIMCONNECT_DATATYPE_INT32,
                    },
                    DefinitionItem {
                        key: "float32".to_string(),
                        data_type: SIMCONNECT_DATATYPE_FLOAT32,
                    },
                    DefinitionItem {
                        key: "text".to_string(),
                        data_type: SIMCONNECT_DATATYPE_STRING256,
                    },
                    DefinitionItem {
                        key: "float64".to_string(),
                        data_type: SIMCONNECT_DATATYPE_FLOAT64,
                    },
                ],
            );

            let mut payload = Vec::new();
            payload.extend_from_slice(&(-7_i32).to_ne_bytes());
            payload.extend_from_slice(&(1.25_f32).to_ne_bytes());
            let mut text = [0_u8; 256];
            text[..10].copy_from_slice(b"  hello  \0");
            payload.extend_from_slice(&text);
            payload.extend_from_slice(&(42.5_f64).to_ne_bytes());

            let callback_len = simobject_data_offset() + payload.len();
            let mut storage = aligned_callback_storage(callback_len);
            {
                // SAFETY: u64 storage is sufficiently aligned and large enough for
                // the fixed callback header.
                let message =
                    unsafe { &mut *(storage.as_mut_ptr() as *mut SimConnectRecvSimObjectData) };
                message.dw_size = callback_len as Dword;
                message.dw_version = 0;
                message.dw_id = SIMCONNECT_RECV_ID_SIMOBJECT_DATA;
                message.dw_request_id = 11;
                message.dw_object_id = SIMCONNECT_OBJECT_ID_USER;
                message.dw_define_id = definition_id;
                message.dw_flags = 0;
                message.dw_entry_number = 0;
                message.dw_out_of = 1;
                message.dw_define_count = 4;
            }
            callback_bytes_mut(&mut storage)
                [simobject_data_offset()..simobject_data_offset() + payload.len()]
                .copy_from_slice(&payload);

            let context_ptr = &mut context as *mut DispatchContext as *mut c_void;
            // SAFETY: storage contains a complete callback header and payload;
            // cb_data is intentionally one byte short for the first call.
            unsafe {
                dispatch_proc(
                    storage.as_mut_ptr() as *mut SimConnectRecv,
                    (callback_len - 1) as Dword,
                    context_ptr,
                );
            }
            assert!(context.values.is_empty());
            assert_eq!(context.telemetry_sequence, 0);

            // SAFETY: storage contains the complete callback bytes described by cb_data.
            unsafe {
                dispatch_proc(
                    storage.as_mut_ptr() as *mut SimConnectRecv,
                    callback_len as Dword,
                    context_ptr,
                );
            }
            assert_eq!(context.values["integer"], json!(-7));
            assert_eq!(context.values["float32"], json!(1.25));
            assert_eq!(context.values["text"], json!("hello"));
            assert_eq!(context.values["float64"], json!(42.5));
            assert_eq!(context.telemetry_sequence, 1);
            assert!(context.telemetry_updated_at.is_some());
            assert!(context.telemetry_updated_instant.is_some());
        }

        #[test]
        fn facility_end_callback_requires_full_header_before_completion() {
            let request_id = 53;
            let mut context = test_dispatch_context();
            context.facility_airport_requests.insert(
                request_id,
                facilities::AirportFacilityRequest::new(700, "YSCB", "AU"),
            );
            let mut message = SimConnectRecvFacilityDataEnd {
                dw_size: size_of::<SimConnectRecvFacilityDataEnd>() as Dword,
                dw_version: 0,
                dw_id: SIMCONNECT_RECV_ID_FACILITY_DATA_END,
                request_id,
            };
            let context_ptr = &mut context as *mut DispatchContext as *mut c_void;

            // SAFETY: the backing value is complete; cb_data is intentionally short.
            unsafe {
                dispatch_proc(
                    &mut message as *mut SimConnectRecvFacilityDataEnd as *mut SimConnectRecv,
                    (size_of::<SimConnectRecvFacilityDataEnd>() - 1) as Dword,
                    context_ptr,
                );
            }
            assert!(context.facility_airport_requests.contains_key(&request_id));
            assert!(context.pending_messages.is_empty());

            // SAFETY: message and context are complete and live for the call.
            unsafe {
                dispatch_proc(
                    &mut message as *mut SimConnectRecvFacilityDataEnd as *mut SimConnectRecv,
                    size_of::<SimConnectRecvFacilityDataEnd>() as Dword,
                    context_ptr,
                );
            }
            assert!(!context.facility_airport_requests.contains_key(&request_id));
            assert_eq!(context.pending_messages.len(), 1);
            assert_eq!(context.pending_messages[0]["type"], "facilityAirport");
            assert_eq!(context.pending_messages[0]["requestId"], 700);
        }

        #[test]
        fn stop_command_is_the_only_false_result_and_preserves_state() {
            let mut state = TestCommandState::seeded();
            assert!(!state.handle(test_command("stop", Vec::new())));
            state.assert_seeded();
        }

        #[test]
        fn unknown_command_is_ignored_without_mutating_state() {
            let mut state = TestCommandState::seeded();
            assert!(state.handle(test_command("futureCommand", Vec::new())));
            state.assert_seeded();
        }

        #[test]
        fn inactive_disconnect_clears_only_sdk_stream_state() {
            let mut state = TestCommandState::seeded();
            assert!(state.handle(test_command("disconnect", Vec::new())));
            assert!(state.subscriptions.is_empty());
            assert!(matches!(state.subscription_kind, SubscriptionKind::Lvar));
            assert_eq!(state.simvar_chunk_size, 20);
            assert_eq!(state.simvar_poll_interval, Duration::from_millis(200));
            assert_eq!(state.sdk_aircraft, None);
            assert_eq!(state.subscription_generation, None);
        }

        #[test]
        fn unsupported_sdk_connect_preserves_existing_state() {
            let mut state = TestCommandState::seeded();
            let target = "__missing_characterization_target__";
            assert!(sdk::resolve_clientdata_adapter(target).is_none());
            let mut command = test_command("connect", Vec::new());
            command.aircraft = Some(target.to_string());

            assert!(state.handle(command));
            state.assert_seeded();
        }

        #[test]
        fn successful_dynamic_load_is_reused_across_connection_attempts() {
            let mut cached = None;
            let mut load_attempts = 0usize;

            let first = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Ok::<_, &'static str>(17u32)
            })
            .expect("initial load should succeed");
            let first_identity = Rc::downgrade(&first);
            drop(first); // Mirrors a failed connection attempt releasing its API reference.
            let second = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Ok::<_, &'static str>(23u32)
            })
            .expect("cached load should succeed");

            assert_eq!(load_attempts, 1);
            assert_eq!(*second, 17);
            assert!(first_identity
                .upgrade()
                .is_some_and(|first| Rc::ptr_eq(&first, &second)));
        }

        #[test]
        fn failed_dynamic_load_remains_retryable() {
            let mut cached: Option<Rc<u32>> = None;
            let mut load_attempts = 0usize;

            let first = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Err::<u32, _>("not ready")
            });
            assert_eq!(first.expect_err("initial load should fail"), "not ready");
            assert!(cached.is_none());

            let second = cached_or_try_load(&mut cached, || {
                load_attempts += 1;
                Ok::<_, &'static str>(29u32)
            })
            .expect("later load should be retried");

            assert_eq!(load_attempts, 2);
            assert_eq!(*second, 29);
            assert!(cached.is_some());
        }

        #[test]
        fn connection_probe_polling_is_bounded_and_stops_on_success() {
            let mut polls = 0usize;
            let mut waits = 0usize;
            let timed_out = poll_connection_probe(
                3,
                Duration::from_millis(1),
                || {
                    polls += 1;
                    Ok::<_, &'static str>(None)
                },
                |_| waits += 1,
            )
            .expect("polling should not fail");
            assert_eq!(timed_out, None);
            assert_eq!(polls, 3);
            assert_eq!(waits, 2);

            let completed = poll_connection_probe(
                3,
                Duration::from_millis(1),
                || Ok::<_, &'static str>(Some(true)),
                |_| panic!("completed probe must not wait"),
            )
            .expect("completed probe should be observed");
            assert_eq!(completed, Some(true));
        }

        #[test]
        fn dispatch_failures_require_a_sustained_grace_period_and_reset_on_success() {
            let start = Instant::now();
            let mut guard = DispatchFailureGuard::default();

            assert!(!guard.record_failure(start));
            assert!(
                !guard.record_failure(start + DISPATCH_FAILURE_GRACE - Duration::from_millis(1))
            );
            guard.record_success();
            assert!(!guard.record_failure(start + DISPATCH_FAILURE_GRACE));
            assert!(guard.record_failure(start + DISPATCH_FAILURE_GRACE * 2));
        }

        #[test]
        fn telemetry_silence_requires_a_real_prior_update_and_full_grace_period() {
            let start = Instant::now();

            assert!(!telemetry_silence_expired(
                None,
                start + TELEMETRY_SILENCE_GRACE
            ));
            assert!(!telemetry_silence_expired(
                Some(start),
                start + TELEMETRY_SILENCE_GRACE - Duration::from_millis(1),
            ));
            assert!(telemetry_silence_expired(
                Some(start),
                start + TELEMETRY_SILENCE_GRACE,
            ));
        }

        #[test]
        fn sdk_client_data_waits_for_publisher_updates_and_retries_only_failed_subscriptions() {
            assert_eq!(
                sdk_client_data_period(sdk::ClientDataPeriod::OnSet),
                SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET
            );
            assert_eq!(
                sdk_client_data_period(sdk::ClientDataPeriod::VisualFrame),
                SIMCONNECT_CLIENT_DATA_PERIOD_VISUAL_FRAME
            );

            let start = Instant::now();
            assert!(!sdk_subscription_retry_due(
                true,
                false,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL - Duration::from_millis(1),
            ));
            assert!(sdk_subscription_retry_due(
                true,
                false,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL,
            ));
            assert!(!sdk_subscription_retry_due(
                true,
                true,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL,
            ));
            assert!(!sdk_subscription_retry_due(
                false,
                false,
                start,
                start + SDK_SUBSCRIBE_RETRY_INTERVAL,
            ));

            let attempted_at = start + Duration::from_secs(30);
            let mut last_attempt = start;
            let mut connect_calls = 0usize;
            let result = attempt_sdk_subscription(&mut last_attempt, attempted_at, || {
                connect_calls += 1;
                Err("synchronous_failure".to_string())
            });
            assert_eq!(result, Err("synchronous_failure".to_string()));
            assert_eq!(connect_calls, 1);
            assert_eq!(last_attempt, attempted_at);
            assert!(!sdk_subscription_retry_due(
                true,
                false,
                last_attempt,
                attempted_at + SDK_SUBSCRIBE_RETRY_INTERVAL - Duration::from_millis(1),
            ));
        }

        #[test]
        fn replacement_stream_is_not_touched_when_sdk_disconnect_fails() {
            #[derive(Default)]
            struct ReplacementProbe {
                disconnect_calls: usize,
                replacement_calls: usize,
            }

            let mut failed = ReplacementProbe::default();
            let result = replace_stream_after_sdk_disconnect(
                &mut failed,
                |probe| {
                    probe.disconnect_calls += 1;
                    Err("stop_failed".to_string())
                },
                |probe| {
                    probe.replacement_calls += 1;
                },
            );
            assert_eq!(result, Err("stop_failed".to_string()));
            assert_eq!(failed.disconnect_calls, 1);
            assert_eq!(failed.replacement_calls, 0);

            let mut succeeded = ReplacementProbe::default();
            let result = replace_stream_after_sdk_disconnect(
                &mut succeeded,
                |probe| {
                    probe.disconnect_calls += 1;
                    Ok(())
                },
                |probe| {
                    probe.replacement_calls += 1;
                    42
                },
            );
            assert_eq!(result, Ok(42));
            assert_eq!(succeeded.disconnect_calls, 1);
            assert_eq!(succeeded.replacement_calls, 1);
        }

        #[test]
        fn sdk_same_adapter_connect_is_idempotent_only_with_its_registered_definition() {
            assert!(sdk_subscription_is_current(
                true,
                Some("clientdata-manifest:test-one"),
                "CLIENTDATA-MANIFEST:TEST-ONE",
                true,
            ));
            assert!(!sdk_subscription_is_current(
                false,
                Some("clientdata-manifest:test-one"),
                "clientdata-manifest:test-one",
                true,
            ));
            assert!(!sdk_subscription_is_current(
                true,
                Some("clientdata-manifest:test-two"),
                "clientdata-manifest:test-one",
                true,
            ));
            assert!(!sdk_subscription_is_current(
                true,
                Some("clientdata-manifest:test-one"),
                "clientdata-manifest:test-one",
                false,
            ));
        }

        #[test]
        fn sdk_clientdata_mapping_is_registered_once_and_rejects_remaps() {
            let mut mappings = HashMap::new();
            assert_eq!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "TEST_SDK_Data"),
                Ok(true),
            );

            mappings.insert(0x5445_5354, "TEST_SDK_Data".to_string());
            assert_eq!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "TEST_SDK_Data"),
                Ok(false),
            );
            assert_eq!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "test_sdk_data"),
                Ok(false),
                "SimConnect ClientData names are compared case-insensitively",
            );
            assert!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5354, "TEST_OTHER_Data",)
                    .is_err()
            );
            assert!(
                sdk_mapping_requires_registration(&mappings, 0x5445_5355, "test_sdk_data",)
                    .is_err()
            );
        }

        #[test]
        fn sdk_clientdata_ids_are_sidecar_owned_stable_and_distinct() {
            let mut allocations = HashMap::new();
            let mut next_slot = 1;
            let first = allocate_sdk_client_data_ids(
                &mut allocations,
                &mut next_slot,
                "VENDOR_SDK_Data",
            )
            .expect("first allocation");
            let repeated = allocate_sdk_client_data_ids(
                &mut allocations,
                &mut next_slot,
                "vendor_sdk_data",
            )
            .expect("case-insensitive repeat");
            let second = allocate_sdk_client_data_ids(
                &mut allocations,
                &mut next_slot,
                "OTHER_SDK_Data",
            )
            .expect("second allocation");

            assert_eq!(first, repeated);
            assert_ne!(first.data_id, second.data_id);
            assert_ne!(first.define_id, second.define_id);
            assert_ne!(first.request_id, second.request_id);
            assert_eq!(first.data_id, SDK_CLIENT_DATA_ID_BASE + 1);
            assert_eq!(first.define_id, SDK_CLIENT_DATA_DEFINITION_ID_BASE + 1);
            assert_eq!(first.request_id, SDK_CLIENT_DATA_REQUEST_ID_BASE + 1);
        }

        #[test]
        fn hresult_success_uses_the_canonical_windows_sign_test() {
            assert!(hresult_ok(S_OK as Hresult));
            assert!(
                hresult_ok(1),
                "non-negative success statuses must be accepted"
            );
            assert!(hresult_ok(i32::MAX));
            assert!(!hresult_ok(0x8000_4005_u32 as Hresult));
            assert!(!hresult_ok(i32::MIN));
        }

        #[test]
        fn snapshots_require_a_new_real_telemetry_sequence_and_receive_timestamp() {
            assert!(!has_unemitted_telemetry_update(
                4,
                4,
                Some("2026-07-15T00:00:00Z")
            ));
            assert!(!has_unemitted_telemetry_update(5, 4, None));
            assert!(has_unemitted_telemetry_update(
                5,
                4,
                Some("2026-07-15T00:00:00Z"),
            ));
        }

        #[test]
        fn nested_connection_probe_is_bound_to_the_exact_spawning_sidecar_pid() {
            assert_eq!(
                connection_probe_owner_arg(4242),
                "--ff-owner-pid=4242"
            );
        }

        #[test]
        fn invalid_subscription_command_preserves_existing_sidecar_state() {
            let mut subscriptions = vec![test_subscription("old", "(L:OLD)")];
            let mut subscription_kind = SubscriptionKind::Lvar;
            let mut simvar_chunk_size = 20usize;
            let mut simvar_poll_interval = Duration::from_millis(200);
            let mut sdk_aircraft = Some("test-clientdata".to_string());
            let mut subscription_generation = Some(4);
            let mut last_sdk_subscribe_attempt = Instant::now();
            let command = test_command(
                "setSimVars",
                vec![test_subscription("bad key", "AIRSPEED INDICATED")],
            );

            assert!(handle_command(
                command,
                None,
                &mut subscriptions,
                &mut subscription_kind,
                &mut simvar_chunk_size,
                &mut simvar_poll_interval,
                &mut sdk_aircraft,
                &mut subscription_generation,
                &mut last_sdk_subscribe_attempt,
            ));
            assert_eq!(subscriptions.len(), 1);
            assert_eq!(subscriptions[0].key, "old");
            assert!(matches!(subscription_kind, SubscriptionKind::Lvar));
            assert_eq!(simvar_chunk_size, 20);
            assert_eq!(simvar_poll_interval, Duration::from_millis(200));
            assert_eq!(sdk_aircraft.as_deref(), Some("test-clientdata"));
            assert_eq!(subscription_generation, Some(4));
        }

        #[test]
        fn valid_simvar_command_updates_inactive_state_and_clamps_poll_settings() {
            let mut subscriptions = Vec::new();
            let mut subscription_kind = SubscriptionKind::Lvar;
            let mut simvar_chunk_size = 20usize;
            let mut simvar_poll_interval = Duration::from_millis(200);
            let mut sdk_aircraft = Some("test-clientdata".to_string());
            let mut subscription_generation = Some(4);
            let mut last_sdk_subscribe_attempt = Instant::now();
            let mut command = test_command(
                "setSimVars",
                vec![test_subscription("ias", "AIRSPEED INDICATED")],
            );
            command.chunk_size = Some(500);
            command.poll_interval_ms = Some(1);

            assert!(handle_command(
                command,
                None,
                &mut subscriptions,
                &mut subscription_kind,
                &mut simvar_chunk_size,
                &mut simvar_poll_interval,
                &mut sdk_aircraft,
                &mut subscription_generation,
                &mut last_sdk_subscribe_attempt,
            ));
            assert_eq!(subscriptions.len(), 1);
            assert_eq!(subscriptions[0].key, "ias");
            assert!(matches!(subscription_kind, SubscriptionKind::Simvar));
            assert_eq!(simvar_chunk_size, 64);
            assert_eq!(simvar_poll_interval, Duration::from_millis(50));
            assert_eq!(sdk_aircraft, None);
            assert_eq!(subscription_generation, None);
        }

        #[test]
        fn lvar_command_stores_generation_and_stream_helpers_scope_it_to_lvars() {
            let mut subscriptions = Vec::new();
            let mut subscription_kind = SubscriptionKind::Simvar;
            let mut simvar_chunk_size = 20usize;
            let mut simvar_poll_interval = Duration::from_millis(200);
            let mut sdk_aircraft = Some("test-clientdata".to_string());
            let mut subscription_generation = None;
            let mut last_sdk_subscribe_attempt = Instant::now();
            let mut command = test_command(
                "setSubscriptions",
                vec![test_subscription("switch", "(L:SWITCH)")],
            );
            command.subscription_generation = Some(9);

            assert!(handle_command(
                command,
                None,
                &mut subscriptions,
                &mut subscription_kind,
                &mut simvar_chunk_size,
                &mut simvar_poll_interval,
                &mut sdk_aircraft,
                &mut subscription_generation,
                &mut last_sdk_subscribe_attempt,
            ));
            assert_eq!(subscription_generation, Some(9));
            assert!(matches!(subscription_kind, SubscriptionKind::Lvar));
            assert_eq!(
                lvar_snapshot_subscription_generation(
                    SubscriptionKind::Lvar,
                    false,
                    subscription_generation,
                ),
                Some(9)
            );
            assert_eq!(
                lvar_snapshot_subscription_generation(
                    SubscriptionKind::Simvar,
                    false,
                    subscription_generation,
                ),
                None
            );
            assert_eq!(
                lvar_snapshot_subscription_generation(
                    SubscriptionKind::Lvar,
                    true,
                    subscription_generation,
                ),
                None
            );

            let payload = status_payload(
                "subscriptions_updated",
                None,
                Some(1),
                None,
                subscription_generation,
            );
            assert_eq!(payload["subscriptionGeneration"], json!(9));
        }

        #[test]
        fn facility_identifiers_are_bounded_ascii_tokens() {
            assert_eq!(normalize_facility_icao(" yscb ").as_deref(), Some("YSCB"));
            assert_eq!(normalize_facility_region("us-ca").as_deref(), Some("US-CA"));
            assert_eq!(normalize_facility_icao(""), None);
            assert_eq!(normalize_facility_icao("TOO-LONG-ICAO"), None);
            assert_eq!(normalize_facility_icao("BAD/ICAO"), None);
            assert_eq!(normalize_facility_region("REGION_TOO_LONG"), None);
        }

        #[test]
        fn session_collection_limits_preserve_normal_capacity_and_reject_excess() {
            let mut messages = Vec::new();
            assert!(push_bounded(&mut messages, json!(1), 2));
            assert!(push_bounded(&mut messages, json!(2), 2));
            assert!(!push_bounded(&mut messages, json!(3), 2));
            assert_eq!(messages, vec![json!(1), json!(2)]);

            let mut facility_requests = HashMap::new();
            for request_id in 0..MAX_CONCURRENT_FACILITY_REQUESTS as Dword {
                facility_requests.insert(
                    request_id,
                    facilities::AirportFacilityRequest::new(
                        u64::from(request_id),
                        "TEST",
                        "",
                    ),
                );
            }
            assert!(!can_start_facility_request(&facility_requests));

            let mapped_events = (0..MAX_MAPPED_EVENTS as Dword)
                .map(|event_id| (format!("EVENT_{event_id}"), event_id))
                .collect();
            assert!(!can_map_event(&mapped_events));
        }
    }

    // `SimSession` owns one open SimConnect handle plus every registration tied
    // to it. Dropping the session closes the handle, so reconnect starts from a
    // fresh set of definitions, requests, event mappings, and SDK state.
    struct SimSession {
        api: Rc<SimConnectApi>,
        handle: Handle,
        context: DispatchContext,
        next_definition_id: Dword,
        next_request_id: Dword,
        next_event_id: Dword,
        mapped_events: HashMap<String, Dword>,
        sdk_client_data_mappings: HashMap<Dword, String>,
        sdk_client_data_allocations: HashMap<String, SdkClientDataIds>,
        next_sdk_client_data_slot: Dword,
        sdk_registered_definition: Option<sdk::ClientDataDefinition>,
        active_requests: Vec<ActiveRequest>,
        facility_airport_definition_id: Option<Dword>,
        system_state_enabled: bool,
        last_aircraft_state_request_at: Instant,
        last_sim_state_request_at: Instant,
        mobiflight_init_configured: bool,
        mobiflight_runtime_configured: bool,
        last_emitted_telemetry_sequence: u64,
    }

    impl SimSession {
        fn connect(api: Rc<SimConnectApi>, enable_mobiflight: bool) -> Result<Self, String> {
            let mut handle: Handle = ptr::null_mut();
            let name = cstring("FlightFabric-Rust-Sidecar")?;
            let hr = unsafe {
                (api.open)(
                    &mut handle,
                    name.as_ptr(),
                    ptr::null_mut(),
                    0,
                    ptr::null_mut(),
                    0,
                )
            };
            if !hresult_ok(hr) {
                return Err(format!("SimConnect_Open failed: hr=0x{:08X}", hr as u32));
            }
            let library_spec = api.library_spec.clone();
            let mut session = Self {
                context: DispatchContext {
                    library_spec,
                    definitions: HashMap::new(),
                    values: HashMap::new(),
                    telemetry_sequence: 0,
                    telemetry_updated_at: None,
                    telemetry_updated_instant: None,
                    connected: false,
                    quit: false,
                    sdk_aircraft: None,
                    sdk_adapter: None,
                    sdk_subscribed: false,
                    mobiflight: enable_mobiflight.then(|| {
                        mobiflight::ClientState::new(unique_mobiflight_client_name())
                    }),
                    facility_airport_requests: HashMap::new(),
                    pending_messages: Vec::new(),
                },
                api,
                handle,
                next_definition_id: 1,
                next_request_id: 1,
                next_event_id: 1,
                mapped_events: HashMap::new(),
                sdk_client_data_mappings: HashMap::new(),
                sdk_client_data_allocations: HashMap::new(),
                next_sdk_client_data_slot: 1,
                sdk_registered_definition: None,
                active_requests: Vec::new(),
                facility_airport_definition_id: None,
                system_state_enabled: false,
                last_aircraft_state_request_at: Instant::now() - Duration::from_secs(10),
                last_sim_state_request_at: Instant::now() - Duration::from_secs(10),
                mobiflight_init_configured: false,
                mobiflight_runtime_configured: false,
                last_emitted_telemetry_sequence: 0,
            };
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut dispatch_failures = DispatchFailureGuard::default();
            while Instant::now() < deadline {
                match session.dispatch_once() {
                    Ok(()) => dispatch_failures.record_success(),
                    Err(error) => {
                        if dispatch_failures.record_failure(Instant::now()) {
                            session.close();
                            return Err(error);
                        }
                    }
                }
                if session.context.connected {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            if !session.context.connected {
                session.close();
                return Err("SimConnect open acknowledgement timed out after 5 seconds".to_string());
            }
            if enable_mobiflight {
                session.initialize_mobiflight();
            }
            Ok(session)
        }

        fn library_spec(&self) -> &str {
            &self.api.library_spec
        }

        fn close(&mut self) {
            if self.handle.is_null() {
                return;
            }
            let handle = self.handle;
            self.handle = ptr::null_mut();
            let _ = unsafe { (self.api.close)(handle) };
        }

        fn dispatch_once(&mut self) -> Result<(), String> {
            if self.handle.is_null() {
                return Err("SimConnect_CallDispatch failed: session handle is closed".to_string());
            }
            let context_ptr = &mut self.context as *mut DispatchContext as *mut c_void;
            let hr = unsafe { (self.api.call_dispatch)(self.handle, dispatch_proc, context_ptr) };
            if hresult_ok(hr) {
                Ok(())
            } else {
                Err(format!(
                    "SimConnect_CallDispatch failed: hr=0x{:08X}",
                    hr as u32
                ))
            }
        }

        fn reset_telemetry_stream(&mut self) {
            self.context.reset_telemetry_stream();
            self.last_emitted_telemetry_sequence = self.context.telemetry_sequence;
        }

        fn telemetry_silence_expired(&self, now: Instant) -> bool {
            telemetry_silence_expired(self.context.telemetry_updated_instant, now)
        }

        fn drain_pending_messages(&mut self) -> Vec<Value> {
            self.context.pending_messages.drain(..).collect()
        }

        fn initialize_mobiflight(&mut self) {
            if self.context.mobiflight.is_none() {
                return;
            }
            let now = Instant::now();
            match self.ensure_mobiflight_areas(mobiflight::ClientAreaKind::Init) {
                Ok(()) => {
                    if let Some(client) = self.context.mobiflight.as_mut() {
                        client.start(now);
                    }
                }
                Err(error) => {
                    if let Some(client) = self.context.mobiflight.as_mut() {
                        client.initialization_failed(error, now);
                    }
                }
            }
            self.flush_mobiflight_statuses();
        }

        fn ensure_mobiflight_areas(
            &mut self,
            kind: mobiflight::ClientAreaKind,
        ) -> Result<(), String> {
            let configured = match kind {
                mobiflight::ClientAreaKind::Init => self.mobiflight_init_configured,
                mobiflight::ClientAreaKind::Runtime => self.mobiflight_runtime_configured,
            };
            if configured {
                return Ok(());
            }

            let runtime_name = self
                .context
                .mobiflight
                .as_ref()
                .map(|client| client.runtime_name().to_string())
                .ok_or_else(|| "mobiflight_disabled".to_string())?;
            let base_name = kind.base_name(&runtime_name);
            let areas = [
                ("LVars", kind.lvar_data_id(), mobiflight::LVAR_AREA_SIZE),
                (
                    "Command",
                    kind.command_data_id(),
                    mobiflight::MESSAGE_SIZE as Dword,
                ),
                (
                    "Response",
                    kind.response_data_id(),
                    mobiflight::MESSAGE_SIZE as Dword,
                ),
                (
                    "StringVars",
                    kind.string_data_id(),
                    mobiflight::STRING_VAR_AREA_SIZE,
                ),
            ];

            for (suffix, data_id, area_size) in areas {
                let name = cstring(&format!("{base_name}.{suffix}"))?;
                let map_hr = unsafe {
                    (self.api.map_client_data_name_to_id)(self.handle, name.as_ptr(), data_id)
                };
                if !hresult_ok(map_hr) {
                    return Err(format!(
                        "MapClientDataNameToID({base_name}.{suffix}) hr=0x{:08X}",
                        map_hr as u32
                    ));
                }

                let create_hr = unsafe {
                    (self.api.create_client_data)(
                        self.handle,
                        data_id,
                        area_size,
                        SIMCONNECT_CREATE_CLIENT_DATA_FLAG_DEFAULT,
                    )
                };
                if !hresult_ok(create_hr) {
                    return Err(format!(
                        "CreateClientData({base_name}.{suffix}) hr=0x{:08X}",
                        create_hr as u32
                    ));
                }
            }

            let add_hr = unsafe {
                (self.api.add_to_client_data_definition)(
                    self.handle,
                    kind.response_define_id(),
                    0,
                    mobiflight::MESSAGE_SIZE as Dword,
                    0.0,
                    0,
                )
            };
            if !hresult_ok(add_hr) {
                return Err(format!(
                    "AddToClientDataDefinition({base_name}.Response) hr=0x{:08X}",
                    add_hr as u32
                ));
            }

            // MobiFlight requires a unique ClientData definition ID for each
            // area, even though Command and Response use the same byte shape.
            let add_command_hr = unsafe {
                (self.api.add_to_client_data_definition)(
                    self.handle,
                    kind.command_define_id(),
                    0,
                    mobiflight::MESSAGE_SIZE as Dword,
                    0.0,
                    0,
                )
            };
            if !hresult_ok(add_command_hr) {
                return Err(format!(
                    "AddToClientDataDefinition({base_name}.Command) hr=0x{:08X}",
                    add_command_hr as u32
                ));
            }

            let request_hr = unsafe {
                (self.api.request_client_data)(
                    self.handle,
                    kind.response_data_id(),
                    kind.response_request_id(),
                    kind.response_define_id(),
                    SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET,
                    // Repeated health probes all respond with the same `MF.Pong` payload.
                    // CHANGED would suppress identical responses after the first probe.
                    SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT,
                    0,
                    0,
                    0,
                )
            };
            if !hresult_ok(request_hr) {
                return Err(format!(
                    "RequestClientData({base_name}.Response) hr=0x{:08X}",
                    request_hr as u32
                ));
            }

            match kind {
                mobiflight::ClientAreaKind::Init => self.mobiflight_init_configured = true,
                mobiflight::ClientAreaKind::Runtime => self.mobiflight_runtime_configured = true,
            }
            Ok(())
        }

        fn write_mobiflight_command(
            &self,
            kind: mobiflight::ClientAreaKind,
            command: &str,
        ) -> Result<(), String> {
            let encoded = mobiflight::encode_command(command).map_err(str::to_string)?;
            let hr = unsafe {
                (self.api.set_client_data)(
                    self.handle,
                    kind.command_data_id(),
                    kind.command_define_id(),
                    SIMCONNECT_CLIENT_DATA_SET_FLAG_DEFAULT,
                    0,
                    mobiflight::MESSAGE_SIZE as Dword,
                    encoded.as_ptr() as *const c_void,
                )
            };
            if !hresult_ok(hr) {
                return Err(format!("SetClientData hr=0x{:08X}", hr as u32));
            }
            Ok(())
        }

        fn perform_mobiflight_action(
            &mut self,
            action: mobiflight::Action,
        ) -> Result<(), String> {
            match action {
                mobiflight::Action::ProbeInit => {
                    self.ensure_mobiflight_areas(mobiflight::ClientAreaKind::Init)?;
                    self.write_mobiflight_command(
                        mobiflight::ClientAreaKind::Init,
                        "MF.DummyCmd",
                    )?;
                    self.write_mobiflight_command(
                        mobiflight::ClientAreaKind::Init,
                        "MF.Ping",
                    )?;
                    self.write_mobiflight_command(
                        mobiflight::ClientAreaKind::Init,
                        "MF.DummyCmd",
                    )
                }
                mobiflight::Action::RegisterRuntime => {
                    let runtime_name = self
                        .context
                        .mobiflight
                        .as_ref()
                        .map(|client| client.runtime_name().to_string())
                        .ok_or_else(|| "mobiflight_disabled".to_string())?;
                    self.write_mobiflight_command(
                        mobiflight::ClientAreaKind::Init,
                        "MF.DummyCmd",
                    )?;
                    self.write_mobiflight_command(
                        mobiflight::ClientAreaKind::Init,
                        &format!("MF.Clients.Add.{runtime_name}"),
                    )
                }
                mobiflight::Action::ConfigureRuntime => {
                    self.ensure_mobiflight_areas(mobiflight::ClientAreaKind::Runtime)
                }
                mobiflight::Action::ProbeRuntime => {
                    self.write_mobiflight_command(
                        mobiflight::ClientAreaKind::Runtime,
                        "MF.Ping",
                    )?;
                    self.write_mobiflight_command(
                        mobiflight::ClientAreaKind::Runtime,
                        "MF.DummyCmd",
                    )
                }
            }
        }

        fn poll_mobiflight(&mut self) {
            let now = Instant::now();
            if let Some(client) = self.context.mobiflight.as_mut() {
                client.tick(now);
            }

            let action = self
                .context
                .mobiflight
                .as_mut()
                .and_then(mobiflight::ClientState::take_action);
            if let Some(action) = action {
                let result = self.perform_mobiflight_action(action);
                if let Some(client) = self.context.mobiflight.as_mut() {
                    match result {
                        Ok(()) => client.action_succeeded(action, now),
                        Err(error) => client.action_failed(action, error, now),
                    }
                }
            }
            self.flush_mobiflight_statuses();
        }

        fn flush_mobiflight_statuses(&mut self) {
            let statuses = self
                .context
                .mobiflight
                .as_mut()
                .map(mobiflight::ClientState::drain_statuses)
                .unwrap_or_default();
            for status in statuses {
                let mut payload = json!({
                    "type": "mobiflightStatus",
                    "state": status.state,
                    "connected": status.connected,
                    "available": status.available,
                    "source": "rust-sidecar",
                    "backend": "rust",
                });
                if let (Value::Object(payload), Some(error)) = (&mut payload, status.error) {
                    payload.insert("error".to_string(), json!(error));
                }
                self.context.push_pending_message(payload);
            }
        }

        fn execute_mobiflight_code(&self, code: &str) -> Result<(), String> {
            let client = self
                .context
                .mobiflight
                .as_ref()
                .ok_or_else(|| "mobiflight_disabled".to_string())?;
            if !client.is_available() {
                return Err("mobiflight_unavailable".to_string());
            }
            let command = mobiflight::execution_command(code).map_err(str::to_string)?;
            self.write_mobiflight_command(mobiflight::ClientAreaKind::Runtime, &command)?;
            self.write_mobiflight_command(
                mobiflight::ClientAreaKind::Runtime,
                "MF.DummyCmd",
            )
        }

        fn subscribe_system_state(&mut self) -> Vec<String> {
            let mut errors = Vec::new();
            for (event_id, event_name) in
                [(EVENT_SIM_START, "SimStart"), (EVENT_SIM_STOP, "SimStop")]
            {
                let event = match cstring(event_name) {
                    Ok(value) => value,
                    Err(err) => {
                        errors.push(format!("{event_name}:{err}"));
                        continue;
                    }
                };
                let hr = unsafe {
                    (self.api.subscribe_to_system_event)(self.handle, event_id, event.as_ptr())
                };
                if !hresult_ok(hr) {
                    errors.push(format!(
                        "{event_name}:SubscribeToSystemEvent hr=0x{:08X}",
                        hr as u32
                    ));
                }
            }
            self.system_state_enabled = true;
            self.request_system_states_now();
            errors
        }

        fn request_system_state(&mut self, request_id: Dword, state_name: &str) -> bool {
            let Ok(state) = cstring(state_name) else {
                return false;
            };
            let hr =
                unsafe { (self.api.request_system_state)(self.handle, request_id, state.as_ptr()) };
            hresult_ok(hr)
        }

        fn request_system_states_now(&mut self) {
            let _ = self.request_system_state(SYSTEM_REQUEST_AIRCRAFT_LOADED, "AircraftLoaded");
            let _ = self.request_system_state(SYSTEM_REQUEST_SIM, "Sim");
            let _ = self.request_system_state(SYSTEM_REQUEST_DIALOG_MODE, "DialogMode");
            self.last_aircraft_state_request_at = Instant::now();
            self.last_sim_state_request_at = Instant::now();
        }

        fn poll_system_state(&mut self) {
            if !self.system_state_enabled {
                return;
            }
            let now = Instant::now();
            if now.duration_since(self.last_aircraft_state_request_at) >= Duration::from_secs(2) {
                let _ = self.request_system_state(SYSTEM_REQUEST_AIRCRAFT_LOADED, "AircraftLoaded");
                self.last_aircraft_state_request_at = now;
            }
            if now.duration_since(self.last_sim_state_request_at) >= Duration::from_secs(1) {
                let _ = self.request_system_state(SYSTEM_REQUEST_SIM, "Sim");
                let _ = self.request_system_state(SYSTEM_REQUEST_DIALOG_MODE, "DialogMode");
                self.last_sim_state_request_at = now;
            }
        }

        fn ensure_facility_airport_definition(&mut self) -> Result<Dword, String> {
            if let Some(definition_id) = self.facility_airport_definition_id {
                return Ok(definition_id);
            }

            let definition_id = self.next_definition_id;
            self.next_definition_id += 1;
            let Some(add_to_facility_definition) = self.api.add_to_facility_definition else {
                emit_facility_debug(
                    "definition_unavailable",
                    json!({ "api": "SimConnect_AddToFacilityDefinition" }),
                );
                return Err("facilities_api_unavailable:AddToFacilityDefinition".to_string());
            };

            emit_facility_debug(
                "definition_create",
                json!({
                    "definitionId": definition_id,
                    "fieldCount": facilities::AIRPORT_FACILITY_FIELDS.len(),
                }),
            );
            for field in facilities::AIRPORT_FACILITY_FIELDS {
                let field_name = cstring(field)?;
                let hr = unsafe { (add_to_facility_definition)(self.handle, definition_id, field_name.as_ptr()) };
                if !hresult_ok(hr) {
                    emit_facility_debug(
                        "definition_field_failed",
                        json!({
                            "definitionId": definition_id,
                            "field": field,
                            "hr": format!("0x{:08X}", hr as u32),
                        }),
                    );
                    return Err(format!(
                        "AddToFacilityDefinition({field}) hr=0x{:08X}",
                        hr as u32
                    ));
                }
            }

            self.facility_airport_definition_id = Some(definition_id);
            emit_facility_debug(
                "definition_ready",
                json!({
                    "definitionId": definition_id,
                    "fieldCount": facilities::AIRPORT_FACILITY_FIELDS.len(),
                }),
            );
            Ok(definition_id)
        }

        fn request_facility_airport(
            &mut self,
            client_request_id: u64,
            icao: &str,
            region: &str,
        ) -> Result<(), String> {
            let normalized_icao = normalize_facility_icao(icao)
                .ok_or_else(|| "invalid_icao".to_string())?;
            let normalized_region = normalize_facility_region(region)
                .ok_or_else(|| "invalid_region".to_string())?;
            if !can_start_facility_request(&self.context.facility_airport_requests) {
                return Err("too_many_concurrent_facility_requests".to_string());
            }
            let definition_id = self.ensure_facility_airport_definition()?;
            let simconnect_request_id = self.next_request_id;
            self.next_request_id += 1;

            let c_icao = cstring(&normalized_icao)?;
            let c_region = cstring(&normalized_region)?;
            let Some(request_facility_data) = self.api.request_facility_data else {
                emit_facility_debug(
                    "request_api_unavailable",
                    json!({ "api": "SimConnect_RequestFacilityData" }),
                );
                return Err("facilities_api_unavailable:RequestFacilityData".to_string());
            };
            self.context.facility_airport_requests.insert(
                simconnect_request_id,
                facilities::AirportFacilityRequest::new(
                    client_request_id,
                    &normalized_icao,
                    &normalized_region,
                ),
            );

            let hr = unsafe {
                (request_facility_data)(
                    self.handle,
                    definition_id,
                    simconnect_request_id,
                    c_icao.as_ptr(),
                    c_region.as_ptr(),
                )
            };
            emit_facility_debug(
                "request_facility_data_sent",
                json!({
                    "clientRequestId": client_request_id,
                    "simconnectRequestId": simconnect_request_id,
                    "definitionId": definition_id,
                    "icao": normalized_icao,
                    "region": normalized_region,
                    "hr": format!("0x{:08X}", hr as u32),
                    "ok": hresult_ok(hr),
                }),
            );
            if !hresult_ok(hr) {
                self.context
                    .facility_airport_requests
                    .remove(&simconnect_request_id);
                return Err(format!("RequestFacilityData hr=0x{:08X}", hr as u32));
            }
            Ok(())
        }

        fn expire_stale_facility_requests(&mut self) {
            const MAX_FACILITY_REQUEST_AGE_MS: u128 = 20_000;
            let expired: Vec<(Dword, String, u128)> = self
                .context
                .facility_airport_requests
                .iter()
                .filter(|(_, request)| request.age_ms() > MAX_FACILITY_REQUEST_AGE_MS)
                .map(|(request_id, request)| {
                    (
                        *request_id,
                        request.requested_icao().to_string(),
                        request.age_ms(),
                    )
                })
                .collect();
            for (request_id, icao, age_ms) in expired {
                emit_facility_debug(
                    "request_expired_in_sidecar",
                    json!({
                        "simconnectRequestId": request_id,
                        "icao": icao,
                        "ageMs": age_ms,
                    }),
                );
            }
            self.context
                .facility_airport_requests
                .retain(|_, request| request.age_ms() <= MAX_FACILITY_REQUEST_AGE_MS);
        }

        fn clear_subscriptions(&mut self) {
            for request in self.active_requests.drain(..) {
                let _ = unsafe {
                    (self.api.request_data_on_sim_object)(
                        self.handle,
                        request.request_id,
                        request.definition_id,
                        SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                        SIMCONNECT_PERIOD_NEVER,
                        SIMCONNECT_DATA_REQUEST_FLAG_DEFAULT,
                        0,
                        0,
                        0,
                    )
                };
                let _ =
                    unsafe { (self.api.clear_data_definition)(self.handle, request.definition_id) };
            }
            self.context.definitions.clear();
            self.context.values.clear();
            self.reset_telemetry_stream();
        }

        fn poll_due_requests(&mut self) {
            let now = Instant::now();
            for request in &mut self.active_requests {
                if request.mode != RequestMode::PollOnce {
                    continue;
                }
                if now.duration_since(request.last_requested_at) < request.poll_interval {
                    continue;
                }
                let hr = unsafe {
                    (self.api.request_data_on_sim_object)(
                        self.handle,
                        request.request_id,
                        request.definition_id,
                        SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                        SIMCONNECT_PERIOD_ONCE,
                        SIMCONNECT_DATA_REQUEST_FLAG_DEFAULT,
                        0,
                        0,
                        0,
                    )
                };
                if hresult_ok(hr) {
                    request.last_requested_at = now;
                }
            }
        }

        fn apply_subscriptions(&mut self, subscriptions: &[Subscription]) -> (usize, Vec<String>) {
            replace_stream_after_sdk_disconnect(
                self,
                SimSession::disconnect_sdk_checked,
                |session| {
                    session.clear_subscriptions();
                    session.apply_subscription_stream(
                        subscriptions,
                        DefaultDatumPrefix::Lvar,
                        1,
                        RequestMode::SimFrame,
                        Duration::from_millis(200),
                    )
                },
            )
            .unwrap_or_else(|error| (0, vec![format!("sdk_disconnect_failed:{error}")]))
        }

        fn apply_simvar_subscriptions(
            &mut self,
            subscriptions: &[Subscription],
            chunk_size: usize,
            poll_interval: Duration,
        ) -> (usize, Vec<String>) {
            replace_stream_after_sdk_disconnect(
                self,
                SimSession::disconnect_sdk_checked,
                |session| {
                    session.clear_subscriptions();
                    let mut system_errors = session.subscribe_system_state();

                    let (count, mut errors) = session.apply_subscription_stream(
                        subscriptions,
                        DefaultDatumPrefix::Simvar,
                        chunk_size,
                        RequestMode::PollOnce,
                        poll_interval,
                    );
                    system_errors.append(&mut errors);
                    (count, system_errors)
                },
            )
            .unwrap_or_else(|error| (0, vec![format!("sdk_disconnect_failed:{error}")]))
        }

        fn apply_subscription_stream(
            &mut self,
            subscriptions: &[Subscription],
            default_prefix: DefaultDatumPrefix,
            chunk_size: usize,
            request_mode: RequestMode,
            poll_interval: Duration,
        ) -> (usize, Vec<String>) {
            let mut errors = Vec::new();
            let chunk_size = chunk_size.clamp(1, 64);
            let period = match request_mode {
                RequestMode::SimFrame => SIMCONNECT_PERIOD_SIM_FRAME,
                RequestMode::PollOnce => SIMCONNECT_PERIOD_ONCE,
            };
            let mut registered_count = 0usize;

            let prepared = subscriptions
                .iter()
                .map(|item| prepare_subscription(item, default_prefix))
                .collect();

            for chunk in split_subscription_chunks(prepared, chunk_size) {
                let definition_id = self.next_definition_id;
                self.next_definition_id += 1;
                let request_id = self.next_request_id;
                self.next_request_id += 1;
                let mut items = Vec::new();

                for subscription in chunk {
                    let datum = match cstring(&subscription.datum_name) {
                        Ok(value) => value,
                        Err(err) => {
                            errors.push(format!("{}:{err}", subscription.key));
                            continue;
                        }
                    };
                    let units = match cstring(&subscription.unit_name) {
                        Ok(value) => value,
                        Err(err) => {
                            errors.push(format!("{}:{err}", subscription.key));
                            continue;
                        }
                    };

                    let add_hr = unsafe {
                        (self.api.add_to_data_definition)(
                            self.handle,
                            definition_id,
                            datum.as_ptr(),
                            units.as_ptr(),
                            subscription.data_type,
                            0.0,
                            SIMCONNECT_UNUSED,
                        )
                    };
                    if !hresult_ok(add_hr) {
                        errors.push(format!(
                            "{}:AddToDataDefinition hr=0x{:08X}",
                            subscription.key, add_hr as u32
                        ));
                        continue;
                    }

                    items.push(DefinitionItem {
                        key: subscription.key.clone(),
                        data_type: subscription.data_type,
                    });
                    diag(format!(
                        "registered key={} datum={}",
                        subscription.key, subscription.datum_name
                    ));
                }

                if items.is_empty() {
                    let _ = unsafe { (self.api.clear_data_definition)(self.handle, definition_id) };
                    continue;
                }

                let req_hr = unsafe {
                    (self.api.request_data_on_sim_object)(
                        self.handle,
                        request_id,
                        definition_id,
                        SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                        period,
                        SIMCONNECT_DATA_REQUEST_FLAG_DEFAULT,
                        0,
                        0,
                        0,
                    )
                };
                if !hresult_ok(req_hr) {
                    errors.push(format!(
                        "definition_{definition_id}:RequestDataOnSimObject hr=0x{:08X}",
                        req_hr as u32
                    ));
                    let _ = unsafe { (self.api.clear_data_definition)(self.handle, definition_id) };
                    continue;
                }

                registered_count += items.len();
                self.context.definitions.insert(definition_id, items);
                self.active_requests.push(ActiveRequest {
                    request_id,
                    definition_id,
                    mode: request_mode,
                    poll_interval,
                    last_requested_at: Instant::now(),
                });
            }

            (registered_count, errors)
        }

        fn connect_sdk(&mut self, aircraft: &str) -> Result<(), String> {
            let Some(mut adapter) = sdk::resolve_clientdata_adapter(aircraft) else {
                return Err(sdk::unsupported_target_error(aircraft));
            };
            let ids = allocate_sdk_client_data_ids(
                &mut self.sdk_client_data_allocations,
                &mut self.next_sdk_client_data_slot,
                &adapter.definition.data_name,
            )?;
            // Connector manifests describe the vendor channel and layout. Numeric
            // SimConnect identifiers are process-owned capabilities and are never
            // accepted from the manifest.
            adapter.definition.data_id = ids.data_id;
            adapter.definition.define_id = ids.define_id;
            adapter.definition.request_id = ids.request_id;
            let definition = adapter.definition.clone();

            if sdk_subscription_is_current(
                self.context.sdk_subscribed,
                self.context
                    .sdk_adapter
                    .as_ref()
                    .map(|active| active.id.as_str()),
                &adapter.id,
                self.sdk_registered_definition.as_ref() == Some(&definition),
            ) {
                return Ok(());
            }

            self.clear_subscriptions();
            self.disconnect_sdk_checked()?;

            if sdk_mapping_requires_registration(
                &self.sdk_client_data_mappings,
                definition.data_id,
                &definition.data_name,
            )? {
                let channel_name = cstring(&definition.data_name)?;
                let map_hr = unsafe {
                    (self.api.map_client_data_name_to_id)(
                        self.handle,
                        channel_name.as_ptr(),
                        definition.data_id,
                    )
                };
                if !hresult_ok(map_hr) {
                    return Err(format!("MapClientDataNameToID hr=0x{:08X}", map_hr as u32));
                }
                self.sdk_client_data_mappings
                    .insert(definition.data_id, definition.data_name.clone());
            }

            let add_hr = unsafe {
                (self.api.add_to_client_data_definition)(
                    self.handle,
                    definition.define_id,
                    0,
                    definition.data_size as Dword,
                    0.0,
                    0,
                )
            };
            if !hresult_ok(add_hr) {
                return Err(format!(
                    "AddToClientDataDefinition hr=0x{:08X}",
                    add_hr as u32
                ));
            }
            self.sdk_registered_definition = Some(definition.clone());

            let request_hr = unsafe {
                (self.api.request_client_data)(
                    self.handle,
                    definition.data_id,
                    definition.request_id,
                    definition.define_id,
                    sdk_client_data_period(definition.request_period),
                    SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_CHANGED,
                    0,
                    0,
                    0,
                )
            };
            if !hresult_ok(request_hr) {
                let request_error = format!("RequestClientData hr=0x{:08X}", request_hr as u32);
                return match self.clear_sdk_client_data_definition() {
                    Ok(()) => Err(request_error),
                    Err(cleanup_error) => Err(format!("{request_error}; {cleanup_error}")),
                };
            }

            self.context.values.clear();
            self.context.sdk_aircraft = Some(aircraft.to_string());
            self.context.sdk_subscribed = true;
            diag(format!(
                "subscribed SDK adapter={} ({}) target={aircraft}",
                adapter.id, adapter.display_name
            ));
            self.context.sdk_adapter = Some(adapter);
            Ok(())
        }

        fn clear_sdk_client_data_definition(&mut self) -> Result<(), String> {
            let Some(definition) = self.sdk_registered_definition.as_ref() else {
                return Ok(());
            };
            let clear_hr = unsafe {
                (self.api.clear_client_data_definition)(self.handle, definition.define_id)
            };
            if !hresult_ok(clear_hr) {
                return Err(format!(
                    "ClearClientDataDefinition hr=0x{:08X}",
                    clear_hr as u32
                ));
            }
            self.sdk_registered_definition = None;
            Ok(())
        }

        fn disconnect_sdk_checked(&mut self) -> Result<(), String> {
            if self.context.sdk_subscribed {
                let definition = self
                    .context
                    .sdk_adapter
                    .as_ref()
                    .map(|adapter| adapter.definition.clone())
                    .ok_or_else(|| {
                        "active SDK subscription is missing its ClientData definition".to_string()
                    })?;
                let stop_hr = unsafe {
                    (self.api.request_client_data)(
                        self.handle,
                        definition.data_id,
                        definition.request_id,
                        definition.define_id,
                        SIMCONNECT_CLIENT_DATA_PERIOD_NEVER,
                        SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT,
                        0,
                        0,
                        0,
                    )
                };
                if !hresult_ok(stop_hr) {
                    // Keep the request and definition tracked so a later cleanup attempt can stop it.
                    // Clearing either here could leave SimConnect delivering an untracked
                    // request against a definition that no longer exists.
                    return Err(format!(
                        "RequestClientData(NEVER) hr=0x{:08X}",
                        stop_hr as u32
                    ));
                }
                self.context.sdk_subscribed = false;
            }

            self.clear_sdk_client_data_definition()?;
            self.context.sdk_aircraft = None;
            self.context.sdk_adapter = None;
            self.context.values.clear();
            self.reset_telemetry_stream();
            Ok(())
        }

        fn map_event(&mut self, name: &str) -> Option<Dword> {
            if let Some(id) = self.mapped_events.get(name) {
                return Some(*id);
            }
            if !can_map_event(&self.mapped_events) {
                return None;
            }
            let event_id = self.next_event_id;
            self.next_event_id += 1;
            let Ok(event_name) = cstring(name) else {
                return None;
            };
            let hr = unsafe {
                (self.api.map_client_event_to_sim_event)(self.handle, event_id, event_name.as_ptr())
            };
            if !hresult_ok(hr) {
                return None;
            }
            self.mapped_events.insert(name.to_string(), event_id);
            Some(event_id)
        }

        fn send_event(
            &mut self,
            name: &str,
            view_event: bool,
            data: [u32; 5],
            parameter_count: usize,
        ) -> Result<(bool, Option<Dword>), String> {
            let Some(event_id) = self.map_event(name) else {
                return Ok((false, None));
            };
            let (object_id, flags) = if view_event {
                (SIMCONNECT_OBJECT_ID_USER, SIMCONNECT_EVENT_FLAG_DEFAULT)
            } else {
                (
                    SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                    SIMCONNECT_EVENT_FLAG_GROUPID_IS_PRIORITY,
                )
            };
            let hr = if parameter_count > 1 {
                if let Some(transmit_client_event_ex1) = self.api.transmit_client_event_ex1 {
                    unsafe {
                        transmit_client_event_ex1(
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
                    }
                } else if data[1..parameter_count].iter().all(|value| *value == 0) {
                    // Older compatible DLLs may not export EX1. A zero-only
                    // trailing parameter has the same implicit default on the
                    // legacy single-parameter call.
                    unsafe {
                        (self.api.transmit_client_event)(
                            self.handle,
                            object_id,
                            event_id,
                            data[0],
                            SIMCONNECT_GROUP_PRIORITY_HIGHEST,
                            flags,
                        )
                    }
                } else {
                    return Err("SimConnect_TransmitClientEvent_EX1 is unavailable".to_string());
                }
            } else {
                unsafe {
                    (self.api.transmit_client_event)(
                        self.handle,
                        object_id,
                        event_id,
                        data[0],
                        SIMCONNECT_GROUP_PRIORITY_HIGHEST,
                        flags,
                    )
                }
            };
            let mut send_id = 0;
            let packet_hr = unsafe {
                (self.api.get_last_sent_packet_id)(self.handle, &mut send_id)
            };
            let packet_id = if hresult_ok(packet_hr) {
                Some(send_id)
            } else {
                None
            };
            Ok((hresult_ok(hr), packet_id))
        }

        fn set_named_var(
            &mut self,
            name: &str,
            unit: &str,
            value: f64,
            data_type: Option<&str>,
        ) -> Result<bool, String> {
            let definition_id = self.next_definition_id;
            self.next_definition_id += 1;

            let datum = cstring(name)?;
            let units = cstring(unit)?;
            let datum_type = resolve_data_type(data_type);
            let add_hr = unsafe {
                (self.api.add_to_data_definition)(
                    self.handle,
                    definition_id,
                    datum.as_ptr(),
                    units.as_ptr(),
                    datum_type,
                    0.0,
                    SIMCONNECT_UNUSED,
                )
            };
            if !hresult_ok(add_hr) {
                let _ = unsafe { (self.api.clear_data_definition)(self.handle, definition_id) };
                return Err(format!("AddToDataDefinition hr=0x{:08X}", add_hr as u32));
            }

            let ok = match datum_type {
                SIMCONNECT_DATATYPE_INT32 => {
                    let raw = value.round() as i32;
                    let hr = unsafe {
                        (self.api.set_data_on_sim_object)(
                            self.handle,
                            definition_id,
                            SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                            0,
                            0,
                            size_of::<i32>() as Dword,
                            &raw as *const i32 as *const c_void,
                        )
                    };
                    hresult_ok(hr)
                }
                SIMCONNECT_DATATYPE_FLOAT32 => {
                    let raw = value as f32;
                    let hr = unsafe {
                        (self.api.set_data_on_sim_object)(
                            self.handle,
                            definition_id,
                            SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                            0,
                            0,
                            size_of::<f32>() as Dword,
                            &raw as *const f32 as *const c_void,
                        )
                    };
                    hresult_ok(hr)
                }
                _ => {
                    let raw = value;
                    let hr = unsafe {
                        (self.api.set_data_on_sim_object)(
                            self.handle,
                            definition_id,
                            SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                            0,
                            0,
                            size_of::<f64>() as Dword,
                            &raw as *const f64 as *const c_void,
                        )
                    };
                    hresult_ok(hr)
                }
            };

            let _ = unsafe { (self.api.clear_data_definition)(self.handle, definition_id) };
            Ok(ok)
        }

        fn eyepoint_offset(&mut self, x: f64, y: f64, z: f64, units: &str) -> bool {
            let definition_id = self.next_definition_id;
            self.next_definition_id += 1;
            let datum = match cstring("STRUCT EYEPOINT DYNAMIC OFFSET") {
                Ok(value) => value,
                Err(_) => return false,
            };
            let units = match cstring(units) {
                Ok(value) => value,
                Err(_) => return false,
            };
            let add_hr = unsafe {
                (self.api.add_to_data_definition)(
                    self.handle,
                    definition_id,
                    datum.as_ptr(),
                    units.as_ptr(),
                    SIMCONNECT_DATATYPE_XYZ,
                    0.0,
                    SIMCONNECT_UNUSED,
                )
            };
            if !hresult_ok(add_hr) {
                let _ = unsafe { (self.api.clear_data_definition)(self.handle, definition_id) };
                return false;
            }
            let xyz = SimConnectDataXyz { x, y, z };
            let set_hr = unsafe {
                (self.api.set_data_on_sim_object)(
                    self.handle,
                    definition_id,
                    SIMCONNECT_OBJECT_ID_USER_AIRCRAFT,
                    0,
                    0,
                    size_of::<SimConnectDataXyz>() as Dword,
                    &xyz as *const SimConnectDataXyz as *const c_void,
                )
            };
            let _ = unsafe { (self.api.clear_data_definition)(self.handle, definition_id) };
            hresult_ok(set_hr)
        }

        fn camera_shake(
            &mut self,
            dx: f64,
            dy: f64,
            dz: f64,
            pitch: f64,
            bank: f64,
            heading: f64,
        ) -> bool {
            let hr = unsafe {
                (self.api.camera_set_relative_6dof)(
                    self.handle,
                    dx as f32,
                    dy as f32,
                    dz as f32,
                    pitch as f32,
                    bank as f32,
                    heading as f32,
                )
            };
            hresult_ok(hr)
        }
    }

    impl Drop for SimSession {
        fn drop(&mut self) {
            self.close();
        }
    }

    // Outbound protocol construction is kept together so every message carries
    // consistent source/backend/library metadata.
    fn emit_ready(library_spec: Option<&str>) {
        emit_value(json!({
            "type": "ready",
            "source": "rust-sidecar",
            "backend": "rust",
            "librarySpec": library_spec,
        }));
    }

    fn status_payload(
        state: &str,
        error: Option<&str>,
        count: Option<usize>,
        library_spec: Option<&str>,
        subscription_generation: Option<u64>,
    ) -> Value {
        let mut payload = json!({
            "type": "status",
            "state": state,
            "source": "rust-sidecar",
            "backend": "rust",
            "librarySpec": library_spec,
        });
        if let Value::Object(map) = &mut payload {
            if let Some(error) = error {
                map.insert("error".to_string(), json!(error));
            }
            if let Some(count) = count {
                map.insert("count".to_string(), json!(count));
            }
            if let Some(subscription_generation) = subscription_generation {
                map.insert(
                    "subscriptionGeneration".to_string(),
                    json!(subscription_generation),
                );
            }
        }
        payload
    }

    fn emit_status(
        state: &str,
        error: Option<&str>,
        count: Option<usize>,
        library_spec: Option<&str>,
    ) {
        emit_value(status_payload(state, error, count, library_spec, None));
    }

    fn emit_subscriptions_updated(
        count: usize,
        library_spec: Option<&str>,
        subscription_generation: Option<u64>,
    ) {
        emit_value(status_payload(
            "subscriptions_updated",
            None,
            Some(count),
            library_spec,
            subscription_generation,
        ));
    }

    fn lvar_snapshot_subscription_generation(
        subscription_kind: SubscriptionKind,
        sdk_subscribed: bool,
        subscription_generation: Option<u64>,
    ) -> Option<u64> {
        if subscription_kind == SubscriptionKind::Lvar && !sdk_subscribed {
            subscription_generation
        } else {
            None
        }
    }

    fn emit_snapshot(
        subscriptions: &[Subscription],
        session: &mut SimSession,
        subscription_kind: SubscriptionKind,
        subscription_generation: Option<u64>,
    ) -> bool {
        if !has_unemitted_telemetry_update(
            session.context.telemetry_sequence,
            session.last_emitted_telemetry_sequence,
            session.context.telemetry_updated_at.as_deref(),
        ) {
            return false;
        }
        let Some(timestamp_iso) = session.context.telemetry_updated_at.clone() else {
            return false;
        };
        let mut values = Map::new();
        if session.context.sdk_subscribed {
            for (key, value) in &session.context.values {
                values.insert(key.clone(), value.clone());
            }
        } else {
            for subscription in subscriptions {
                values.insert(
                    subscription.key.clone(),
                    session
                        .context
                        .values
                        .get(&subscription.key)
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            }
        }
        let normalized = if session.context.sdk_subscribed {
            session
                .context
                .sdk_adapter
                .as_ref()
                .and_then(|adapter| adapter.normalize(&session.context.values))
        } else {
            None
        };
        let mut payload = json!({
            "type": "snapshot",
            "values": values,
            "timestampIso": timestamp_iso,
            "source": "rust-sidecar",
            "backend": "rust",
            "stream": if session.context.sdk_subscribed { "sdk" } else { subscription_kind.as_str() },
            "librarySpec": session.library_spec(),
        });
        if let Value::Object(payload) = &mut payload {
            if let Some(normalized) = normalized {
                payload.insert("normalized".to_string(), normalized);
            }
            if let Some(subscription_generation) = lvar_snapshot_subscription_generation(
                subscription_kind,
                session.context.sdk_subscribed,
                subscription_generation,
            ) {
                payload.insert(
                    "subscriptionGeneration".to_string(),
                    json!(subscription_generation),
                );
            }
        }
        emit_value(payload);
        session.last_emitted_telemetry_sequence = session.context.telemetry_sequence;
        true
    }

    fn emit_facility_debug(event: &str, details: Value) {
        let mut payload = Map::new();
        payload.insert("type".to_string(), json!("facilityDebug"));
        payload.insert("event".to_string(), json!(event));
        payload.insert("source".to_string(), json!("rust-sidecar"));
        payload.insert("backend".to_string(), json!("rust"));
        payload.insert(
            "timestampIso".to_string(),
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        );
        if let Value::Object(details) = details {
            for (key, value) in details {
                payload.insert(key, value);
            }
        }
        emit_value(Value::Object(payload));
    }

    fn emit_facility_airport_error(
        request_id: Option<u64>,
        icao: Option<&str>,
        error: &str,
        library_spec: Option<&str>,
    ) {
        emit_value(json!({
            "type": "facilityAirport",
            "ok": false,
            "requestId": request_id,
            "icao": icao,
            "source": "msfs-facilities",
            "backend": "rust",
            "librarySpec": library_spec,
            "error": error,
            "timestampIso": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }));
    }

    // Command handling validates a command completely before mutating live
    // session/subscription state. Returning `false` is the single graceful-stop
    // signal consumed by the main loop.
    fn handle_command(
        command: Command,
        session: Option<&mut SimSession>,
        subscriptions: &mut Vec<Subscription>,
        subscription_kind: &mut SubscriptionKind,
        simvar_chunk_size: &mut usize,
        simvar_poll_interval: &mut Duration,
        sdk_aircraft: &mut Option<String>,
        subscription_generation: &mut Option<u64>,
        last_sdk_subscribe_attempt: &mut Instant,
    ) -> bool {
        match command.command_type.as_str() {
            "stop" => false,
            "setSubscriptions" => {
                let normalized_subscriptions = match normalize_subscriptions(command.subscriptions)
                {
                    Ok(value) => value,
                    Err(err) => {
                        emit_status(
                            "error",
                            Some(&format!("invalid_subscriptions:{err}")),
                            None,
                            session.as_ref().map(|session| session.library_spec()),
                        );
                        return true;
                    }
                };
                *sdk_aircraft = None;
                *subscription_kind = SubscriptionKind::Lvar;
                *subscriptions = normalized_subscriptions;
                *subscription_generation = command.subscription_generation;
                if let Some(session) = session {
                    let (count, errors) = session.apply_subscriptions(subscriptions);
                    if errors.is_empty() {
                        emit_subscriptions_updated(
                            count,
                            Some(session.library_spec()),
                            *subscription_generation,
                        );
                    } else {
                        emit_status(
                            "error",
                            Some(&format!("subscribe_failed:{}", errors.join("; "))),
                            Some(count),
                            Some(session.library_spec()),
                        );
                    }
                } else {
                    emit_subscriptions_updated(subscriptions.len(), None, *subscription_generation);
                }
                true
            }
            "setSimVars" => {
                let normalized_subscriptions = match normalize_subscriptions(command.subscriptions)
                {
                    Ok(value) => value,
                    Err(err) => {
                        emit_status(
                            "error",
                            Some(&format!("invalid_subscriptions:{err}")),
                            None,
                            session.as_ref().map(|session| session.library_spec()),
                        );
                        return true;
                    }
                };
                *sdk_aircraft = None;
                *subscription_kind = SubscriptionKind::Simvar;
                *subscriptions = normalized_subscriptions;
                *subscription_generation = None;
                let chunk_size = command.chunk_size.unwrap_or(20).clamp(1, 64);
                let poll_interval =
                    Duration::from_millis(command.poll_interval_ms.unwrap_or(200).clamp(50, 5_000));
                *simvar_chunk_size = chunk_size;
                *simvar_poll_interval = poll_interval;

                if let Some(session) = session {
                    let (count, errors) = session.apply_simvar_subscriptions(
                        subscriptions,
                        *simvar_chunk_size,
                        *simvar_poll_interval,
                    );
                    if errors.is_empty() {
                        emit_status(
                            "simvars_updated",
                            None,
                            Some(count),
                            Some(session.library_spec()),
                        );
                    } else {
                        emit_status(
                            "error",
                            Some(&format!("simvar_subscribe_failed:{}", errors.join("; "))),
                            Some(count),
                            Some(session.library_spec()),
                        );
                    }
                } else {
                    emit_status("simvars_updated", None, Some(subscriptions.len()), None);
                }
                true
            }
            "requestFacilityAirport" => {
                let Some(icao) = command
                    .icao
                    .as_deref()
                    .and_then(normalize_facility_icao)
                else {
                    emit_facility_airport_error(
                        command.request_id,
                        command.icao.as_deref(),
                        "invalid_icao",
                        session.as_ref().map(|session| session.library_spec()),
                    );
                    return true;
                };
                let region = command
                    .region
                    .as_deref()
                    .and_then(normalize_facility_region)
                    .unwrap_or_default();
                let Some(request_id) = command.request_id else {
                    emit_facility_airport_error(
                        None,
                        Some(&icao),
                        "missing_request_id",
                        session.as_ref().map(|session| session.library_spec()),
                    );
                    return true;
                };
                if let Some(session) = session {
                    match session.request_facility_airport(request_id, &icao, &region) {
                        Ok(()) => {}
                        Err(err) => emit_facility_airport_error(
                            Some(request_id),
                            Some(&icao),
                            &err,
                            Some(session.library_spec()),
                        ),
                    }
                } else {
                    emit_facility_airport_error(
                        Some(request_id),
                        Some(&icao),
                        "not_connected",
                        None,
                    );
                }
                true
            }
            "connect" => {
                let Some(aircraft) = command
                    .aircraft
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                else {
                    emit_status(
                        "error",
                        Some("sdk_subscribe_failed:missing_sdk_target"),
                        None,
                        session.as_ref().map(|session| session.library_spec()),
                    );
                    return true;
                };
                if sdk::resolve_clientdata_adapter(&aircraft).is_none() {
                    let error = format!(
                        "sdk_subscribe_failed:{}",
                        sdk::unsupported_target_error(&aircraft)
                    );
                    emit_status(
                        "error",
                        Some(&error),
                        None,
                        session.as_ref().map(|session| session.library_spec()),
                    );
                    return true;
                }
                *sdk_aircraft = Some(aircraft.clone());
                subscriptions.clear();
                *subscription_generation = None;
                if let Some(session) = session {
                    let result = attempt_sdk_subscription(
                        last_sdk_subscribe_attempt,
                        Instant::now(),
                        || session.connect_sdk(&aircraft),
                    );
                    match result {
                        Ok(()) => {
                            emit_status("subscribed", None, Some(1), Some(session.library_spec()))
                        }
                        Err(err) => emit_status(
                            "error",
                            Some(&format!("sdk_subscribe_failed:{err}")),
                            None,
                            Some(session.library_spec()),
                        ),
                    }
                } else {
                    emit_status("connecting", None, None, None);
                }
                true
            }
            "disconnect" => {
                *sdk_aircraft = None;
                subscriptions.clear();
                *subscription_generation = None;
                if let Some(session) = session {
                    match session.disconnect_sdk_checked() {
                        Ok(()) => {
                            emit_status("disconnected", None, None, Some(session.library_spec()))
                        }
                        Err(error) => emit_status(
                            "error",
                            Some(&format!("sdk_disconnect_failed:{error}")),
                            None,
                            Some(session.library_spec()),
                        ),
                    }
                } else {
                    emit_status("disconnected", None, None, None);
                }
                true
            }
            "sendEvent" | "sendSdkEvent" | "sendViewEvent" => {
                let Some(name) = command.name.as_deref() else {
                    return true;
                };
                let ack_type = match command.command_type.as_str() {
                    "sendViewEvent" => "sendViewEventAck",
                    "sendSdkEvent" => "sendSdkEventAck",
                    _ => "sendEventAck",
                };
                if command.parameters.len() > 4
                    || (command.command_type != "sendEvent" && !command.parameters.is_empty())
                {
                    emit_value(
                        json!({ "type": ack_type, "name": name, "ok": false, "error": "invalid_payload", "requestId": command.request_id }),
                    );
                    return true;
                }
                let mut event_data = [0_u32; 5];
                let value = command.value.unwrap_or(0.0);
                let primary_data = if command.command_type == "sendSdkEvent" {
                    bounded_sdk_event_data(value)
                } else {
                    bounded_event_data(value)
                };
                let Some(primary_data) = primary_data else {
                    emit_value(
                        json!({ "type": ack_type, "name": name, "ok": false, "error": "invalid_payload", "requestId": command.request_id }),
                    );
                    return true;
                };
                event_data[0] = primary_data;
                let mut parameters_valid = true;
                for (index, parameter) in command.parameters.iter().enumerate() {
                    let Some(parameter_data) = bounded_event_data(*parameter) else {
                        parameters_valid = false;
                        break;
                    };
                    event_data[index + 1] = parameter_data;
                }
                if !parameters_valid {
                    emit_value(
                        json!({ "type": ack_type, "name": name, "ok": false, "error": "invalid_payload", "requestId": command.request_id }),
                    );
                    return true;
                }
                if !is_safe_control_name(name)
                    || (command.command_type == "sendSdkEvent" && !is_safe_sdk_event_name(name))
                {
                    emit_value(
                        json!({ "type": ack_type, "name": name, "ok": false, "error": "invalid_name", "requestId": command.request_id }),
                    );
                    return true;
                }
                if let Some(session) = session {
                    let result = session.send_event(
                        name,
                        command.command_type == "sendViewEvent",
                        event_data,
                        command.parameters.len() + 1,
                    );
                    match result {
                        Ok((ok, send_id)) => emit_value(
                            json!({ "type": ack_type, "name": name, "ok": ok, "requestId": command.request_id, "sendId": send_id }),
                        ),
                        Err(err) => emit_value(
                            json!({ "type": ack_type, "name": name, "ok": false, "error": err, "requestId": command.request_id }),
                        ),
                    }
                } else {
                    emit_value(
                        json!({ "type": ack_type, "name": name, "ok": false, "error": "not_connected", "requestId": command.request_id }),
                    );
                }
                true
            }
            "executeMobiFlightCode" => {
                let Some(code) = command.code.as_deref() else {
                    emit_value(json!({
                        "type": "executeMobiFlightCodeAck",
                        "ok": false,
                        "error": "invalid_code",
                        "requestId": command.request_id,
                    }));
                    return true;
                };
                if let Some(session) = session {
                    match session.execute_mobiflight_code(code) {
                        Ok(()) => emit_value(json!({
                            "type": "executeMobiFlightCodeAck",
                            "ok": true,
                            "requestId": command.request_id,
                        })),
                        Err(error) => emit_value(json!({
                            "type": "executeMobiFlightCodeAck",
                            "ok": false,
                            "error": error,
                            "requestId": command.request_id,
                        })),
                    }
                } else {
                    emit_value(json!({
                        "type": "executeMobiFlightCodeAck",
                        "ok": false,
                        "error": "not_connected",
                        "requestId": command.request_id,
                    }));
                }
                true
            }
            "setNamedVar" => {
                let Some(name) = command.name.as_deref() else {
                    emit_value(
                        json!({ "type": "setNamedVarAck", "ok": false, "error": "invalid_name", "requestId": command.request_id }),
                    );
                    return true;
                };
                let unit = command.unit.as_deref().unwrap_or("Number");
                let value = command.value.unwrap_or(0.0);
                if !is_safe_control_name(name) {
                    emit_value(
                        json!({ "type": "setNamedVarAck", "name": name, "ok": false, "error": "invalid_name", "requestId": command.request_id }),
                    );
                    return true;
                }
                if !is_safe_control_unit(unit) || !is_bounded_control_number(value) {
                    emit_value(
                        json!({ "type": "setNamedVarAck", "name": name, "ok": false, "error": "invalid_payload", "requestId": command.request_id }),
                    );
                    return true;
                }
                if let Some(session) = session {
                    let result =
                        session.set_named_var(name, unit, value, command.data_type.as_deref());
                    match result {
                        Ok(ok) => emit_value(
                            json!({ "type": "setNamedVarAck", "name": name, "ok": ok, "requestId": command.request_id }),
                        ),
                        Err(err) => emit_value(
                            json!({ "type": "setNamedVarAck", "name": name, "ok": false, "error": err, "requestId": command.request_id }),
                        ),
                    }
                } else {
                    emit_value(
                        json!({ "type": "setNamedVarAck", "name": name, "ok": false, "error": "not_connected", "requestId": command.request_id }),
                    );
                }
                true
            }
            "eyepointOffset" => {
                let x = command.x.unwrap_or(0.0);
                let y = command.y.unwrap_or(0.0);
                let z = command.z.unwrap_or(0.0);
                let units = command.units.as_deref().unwrap_or("Meters");
                if !is_bounded_camera_number(x, MAX_CAMERA_OFFSET_METERS)
                    || !is_bounded_camera_number(y, MAX_CAMERA_OFFSET_METERS)
                    || !is_bounded_camera_number(z, MAX_CAMERA_OFFSET_METERS)
                    || !is_safe_control_unit(units)
                {
                    emit_value(
                        json!({ "type": "eyepointOffsetAck", "ok": false, "error": "invalid_payload" }),
                    );
                    return true;
                }
                if let Some(session) = session {
                    let ok = session.eyepoint_offset(x, y, z, units);
                    emit_value(json!({ "type": "eyepointOffsetAck", "ok": ok }));
                } else {
                    emit_value(
                        json!({ "type": "eyepointOffsetAck", "ok": false, "error": "not_connected" }),
                    );
                }
                true
            }
            "cameraShake" => {
                let dx = command.dx.unwrap_or(0.0);
                let dy = command.dy.unwrap_or(0.0);
                let dz = command.dz.unwrap_or(0.0);
                let pitch = command.pitch.unwrap_or(0.0);
                let bank = command.bank.unwrap_or(0.0);
                let heading = command.heading.unwrap_or(0.0);
                if !is_bounded_camera_number(dx, MAX_CAMERA_OFFSET_METERS)
                    || !is_bounded_camera_number(dy, MAX_CAMERA_OFFSET_METERS)
                    || !is_bounded_camera_number(dz, MAX_CAMERA_OFFSET_METERS)
                    || !is_bounded_camera_number(pitch, MAX_CAMERA_ANGLE_DEGREES)
                    || !is_bounded_camera_number(bank, MAX_CAMERA_ANGLE_DEGREES)
                    || !is_bounded_camera_number(heading, MAX_CAMERA_ANGLE_DEGREES)
                {
                    emit_value(
                        json!({ "type": "cameraShakeAck", "ok": false, "error": "invalid_payload" }),
                    );
                    return true;
                }
                if let Some(session) = session {
                    let ok = session.camera_shake(dx, dy, dz, pitch, bank, heading);
                    emit_value(json!({ "type": "cameraShakeAck", "ok": ok }));
                } else {
                    emit_value(
                        json!({ "type": "cameraShakeAck", "ok": false, "error": "not_connected" }),
                    );
                }
                true
            }
            _ => true,
        }
    }

    // Probe mode tests DLL availability without starting the long-running
    // bridge. Connection-probe mode additionally performs an isolated open.
    pub fn probe() -> i32 {
        match SimConnectApi::load() {
            Ok(api) => {
                emit_value(json!({
                    "type": "probe",
                    "ok": true,
                    "source": "rust-sidecar",
                    "backend": "rust",
                    "ownerLifelineVersion": OWNER_LIFELINE_VERSION,
                    "librarySpec": api.library_spec,
                }));
                0
            }
            Err(err) => {
                emit_value(json!({
                    "type": "probe",
                    "ok": false,
                    "source": "rust-sidecar",
                    "backend": "rust",
                    "ownerLifelineVersion": OWNER_LIFELINE_VERSION,
                    "error": err,
                }));
                2
            }
        }
    }

    pub fn connection_probe() -> i32 {
        match SimConnectApi::load().and_then(|api| api.probe_connection()) {
            Ok(()) => 0,
            Err(_) => 2,
        }
    }

    // The long-running bridge alternates bounded command batches, connection
    // management, one SimConnect dispatch, health/retry work, and snapshot
    // emission. No individual stage may monopolize the loop.
    pub fn run(enable_mobiflight: bool) -> i32 {
        let command_rx = start_stdin_thread();
        let mut subscriptions: Vec<Subscription> = Vec::new();
        let mut subscription_kind = SubscriptionKind::Lvar;
        let mut simvar_chunk_size = 20usize;
        let mut simvar_poll_interval = Duration::from_millis(200);
        let mut sdk_aircraft: Option<String> = None;
        let mut subscription_generation: Option<u64> = None;
        let mut simconnect_api: Option<Rc<SimConnectApi>> = None;
        let mut session: Option<SimSession> = None;
        let mut last_connect_attempt = Instant::now() - Duration::from_secs(10);
        let mut consecutive_all_null = 0usize;
        let mut health_error_reported = false;
        let mut last_reregister_at = Instant::now() - Duration::from_secs(30);
        let mut last_sdk_subscribe_attempt = Instant::now();
        let mut dispatch_failures = DispatchFailureGuard::default();

        emit_ready(None);
        diag("sidecar started; awaiting setSubscriptions");

        loop {
            for command in receive_command_batch(&command_rx, MAX_COMMANDS_PER_TICK) {
                let keep_running = handle_command(
                    command,
                    session.as_mut(),
                    &mut subscriptions,
                    &mut subscription_kind,
                    &mut simvar_chunk_size,
                    &mut simvar_poll_interval,
                    &mut sdk_aircraft,
                    &mut subscription_generation,
                    &mut last_sdk_subscribe_attempt,
                );
                if !keep_running {
                    if let Some(session) = session.as_mut() {
                        session.close();
                    }
                    emit_status(
                        "stopped",
                        None,
                        None,
                        session.as_ref().map(|session| session.library_spec()),
                    );
                    return 0;
                }
            }

            if session.is_none() && last_connect_attempt.elapsed() >= Duration::from_secs(5) {
                last_connect_attempt = Instant::now();
                match simconnect_connection_ready() {
                    Ok(false) => {
                        emit_status(
                            "disconnected",
                            Some("simconnect_server_unavailable"),
                            None,
                            simconnect_api.as_ref().map(|api| api.library_spec.as_str()),
                        );
                        thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                    Err(error) => {
                        emit_status(
                            "disconnected",
                            Some(&format!("simconnect_server_probe_failed:{error}")),
                            None,
                            simconnect_api.as_ref().map(|api| api.library_spec.as_str()),
                        );
                        thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                    Ok(true) => {}
                }
                let connect_result = cached_or_try_load(&mut simconnect_api, SimConnectApi::load)
                    .and_then(|api| SimSession::connect(api, enable_mobiflight));
                match connect_result {
                    Ok(mut connected) => {
                        dispatch_failures.record_success();
                        emit_status("connected", None, None, Some(connected.library_spec()));
                        if let Some(aircraft) = sdk_aircraft.as_deref() {
                            let attempt_now = Instant::now();
                            match attempt_sdk_subscription(
                                &mut last_sdk_subscribe_attempt,
                                attempt_now,
                                || connected.connect_sdk(aircraft),
                            ) {
                                Ok(()) => emit_status(
                                    "subscribed",
                                    None,
                                    Some(1),
                                    Some(connected.library_spec()),
                                ),
                                Err(err) => emit_status(
                                    "error",
                                    Some(&format!("sdk_subscribe_failed:{err}")),
                                    None,
                                    Some(connected.library_spec()),
                                ),
                            }
                        } else if !subscriptions.is_empty() {
                            let (count, errors) = if subscription_kind == SubscriptionKind::Simvar {
                                connected.apply_simvar_subscriptions(
                                    &subscriptions,
                                    simvar_chunk_size,
                                    simvar_poll_interval,
                                )
                            } else {
                                connected.apply_subscriptions(&subscriptions)
                            };
                            if errors.is_empty() {
                                if subscription_kind == SubscriptionKind::Simvar {
                                    emit_status(
                                        "simvars_updated",
                                        None,
                                        Some(count),
                                        Some(connected.library_spec()),
                                    );
                                } else {
                                    emit_subscriptions_updated(
                                        count,
                                        Some(connected.library_spec()),
                                        subscription_generation,
                                    );
                                }
                            } else {
                                emit_status(
                                    "error",
                                    Some(&format!("subscribe_failed:{}", errors.join("; "))),
                                    Some(count),
                                    Some(connected.library_spec()),
                                );
                            }
                        }
                        session = Some(connected);
                    }
                    Err(err) => emit_status("disconnected", Some(&err), None, None),
                }
            }

            if let Some(active) = session.as_mut() {
                active.poll_due_requests();
                active.poll_system_state();
                let dispatch_error = match active.dispatch_once() {
                    Ok(()) => {
                        dispatch_failures.record_success();
                        None
                    }
                    Err(error) => dispatch_failures
                        .record_failure(Instant::now())
                        .then_some(error),
                };
                if let Some(error) = dispatch_error {
                    active.context.connected = false;
                    emit_status(
                        "disconnected",
                        Some(&format!("simconnect_dispatch_failed:{error}")),
                        None,
                        Some(active.library_spec()),
                    );
                    active.close();
                    session = None;
                    dispatch_failures.record_success();
                    consecutive_all_null = 0;
                    health_error_reported = false;
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
                active.poll_mobiflight();
                active.expire_stale_facility_requests();
                for message in active.drain_pending_messages() {
                    emit_value(message);
                }
                if active.context.quit {
                    emit_status(
                        "disconnected",
                        Some("simconnect_quit"),
                        None,
                        Some(active.library_spec()),
                    );
                    active.close();
                    session = None;
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }

                let sdk_retry_now = Instant::now();
                if sdk_subscription_retry_due(
                    sdk_aircraft.is_some(),
                    active.context.sdk_subscribed,
                    last_sdk_subscribe_attempt,
                    sdk_retry_now,
                ) {
                    if let Some(aircraft) = sdk_aircraft.as_deref() {
                        match attempt_sdk_subscription(
                            &mut last_sdk_subscribe_attempt,
                            sdk_retry_now,
                            || active.connect_sdk(aircraft),
                        ) {
                            Ok(()) => emit_status(
                                "subscribed",
                                None,
                                Some(1),
                                Some(active.library_spec()),
                            ),
                            Err(err) => emit_status(
                                "error",
                                Some(&format!("sdk_subscribe_failed:{err}")),
                                None,
                                Some(active.library_spec()),
                            ),
                        }
                    }
                }

                let has_subscriptions = !subscriptions.is_empty();
                let has_sdk_subscription = active.context.sdk_subscribed;
                let has_active_stream = has_subscriptions || has_sdk_subscription;
                // SimVar/LVAR requests produce periodic packets even when values are unchanged.
                // SDK ClientData uses the CHANGED flag, so a quiet SDK stream can be healthy.
                if has_subscriptions && active.telemetry_silence_expired(Instant::now()) {
                    emit_status(
                        "disconnected",
                        Some("simconnect_telemetry_stale:12s"),
                        None,
                        Some(active.library_spec()),
                    );
                    active.context.connected = false;
                    active.close();
                    session = None;
                    dispatch_failures.record_success();
                    consecutive_all_null = 0;
                    health_error_reported = false;
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
                if has_active_stream {
                    let _ = emit_snapshot(
                        &subscriptions,
                        active,
                        subscription_kind,
                        subscription_generation,
                    );
                }

                let has_any_value = if has_sdk_subscription {
                    active.context.values.values().any(|value| !value.is_null())
                } else {
                    subscriptions.iter().any(|item| {
                        active
                            .context
                            .values
                            .get(&item.key)
                            .is_some_and(|value| !value.is_null())
                    })
                };
                if has_active_stream && !has_any_value {
                    consecutive_all_null += 1;
                } else {
                    consecutive_all_null = 0;
                    health_error_reported = false;
                }

                if has_active_stream && consecutive_all_null >= 30 && !health_error_reported {
                    let message = if has_sdk_subscription {
                        active
                            .context
                            .sdk_adapter
                            .as_ref()
                            .map(|adapter| adapter.no_data_hint.as_str())
                            .unwrap_or("SDK values unavailable yet (check adapter-specific setup)")
                    } else if subscription_kind == SubscriptionKind::Simvar {
                        "SimVar values unavailable yet (simulator may still be loading)"
                    } else {
                        "LVAR values unavailable yet (aircraft variable not updating)"
                    };
                    emit_status(
                        "connecting",
                        Some(message),
                        None,
                        Some(active.library_spec()),
                    );
                    health_error_reported = true;
                }

                if has_subscriptions
                    && consecutive_all_null >= 150
                    && last_reregister_at.elapsed() >= Duration::from_secs(30)
                {
                    last_reregister_at = Instant::now();
                    let (count, errors) = if subscription_kind == SubscriptionKind::Simvar {
                        active.apply_simvar_subscriptions(
                            &subscriptions,
                            simvar_chunk_size,
                            simvar_poll_interval,
                        )
                    } else {
                        active.apply_subscriptions(&subscriptions)
                    };
                    if errors.is_empty() {
                        if subscription_kind == SubscriptionKind::Simvar {
                            emit_status(
                                "simvars_updated",
                                None,
                                Some(count),
                                Some(active.library_spec()),
                            );
                        } else {
                            emit_subscriptions_updated(
                                count,
                                Some(active.library_spec()),
                                subscription_generation,
                            );
                        }
                    } else {
                        emit_status(
                            "error",
                            Some(&format!("subscribe_failed:{}", errors.join("; "))),
                            Some(count),
                            Some(active.library_spec()),
                        );
                    }
                }
            }

            thread::sleep(Duration::from_millis(200));
        }
    }
}

// Non-Windows builds expose the same mode functions but fail explicitly before
// attempting any native work.
#[cfg(not(windows))]
mod sidecar {
    use super::*;

    pub fn probe() -> i32 {
        emit_value(json!({
            "type": "probe",
            "ok": false,
            "source": "rust-sidecar",
            "backend": "rust",
            "ownerLifelineVersion": OWNER_LIFELINE_VERSION,
            "error": "rust SimConnect sidecar is only supported on Windows",
        }));
        2
    }

    pub fn connection_probe() -> i32 {
        2
    }

    pub fn run(_enable_mobiflight: bool) -> i32 {
        emit_value(json!({
            "type": "error",
            "message": "rust SimConnect sidecar is only supported on Windows",
            "source": "rust-sidecar",
            "backend": "rust",
        }));
        2
    }
}

// Entrypoint helpers keep role selection and PID parsing strict and testable.
// Every non-capability-probe process must establish an owner lifetime contract.
fn should_enable_mobiflight(args: &[String]) -> bool {
    !args
        .iter()
        .any(|arg| arg == "--simvars-bridge" || arg == "--sdk-clientdata-bridge")
}

fn should_run_connection_probe(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--connection-probe")
}

fn should_run_process_guardian(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--process-guardian")
}

fn parse_owner_pid(args: &[String]) -> Result<Option<u32>, String> {
    let mut owner_pid = None;
    for arg in args {
        if arg == "--ff-owner-pid" {
            return Err("--ff-owner-pid must use --ff-owner-pid=<positive PID>".to_string());
        }
        let Some(raw_pid) = arg.strip_prefix("--ff-owner-pid=") else {
            continue;
        };
        if owner_pid.is_some() {
            return Err("--ff-owner-pid may only be specified once".to_string());
        }
        if raw_pid.is_empty() || !raw_pid.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("invalid --ff-owner-pid value: {raw_pid:?}"));
        }
        let parsed = raw_pid
            .parse::<u32>()
            .map_err(|_| format!("invalid --ff-owner-pid value: {raw_pid:?}"))?;
        if parsed == 0 {
            return Err("--ff-owner-pid must be greater than zero".to_string());
        }
        owner_pid = Some(parsed);
    }
    Ok(owner_pid)
}

fn parse_target_pid(args: &[String]) -> Result<Option<u32>, String> {
    let mut target_pid = None;
    for arg in args {
        if arg == "--ff-target-pid" {
            return Err("--ff-target-pid must use --ff-target-pid=<positive PID>".to_string());
        }
        let Some(raw_pid) = arg.strip_prefix("--ff-target-pid=") else {
            continue;
        };
        if target_pid.is_some() {
            return Err("--ff-target-pid may only be specified once".to_string());
        }
        if raw_pid.is_empty() || !raw_pid.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("invalid --ff-target-pid value: {raw_pid:?}"));
        }
        let parsed = raw_pid
            .parse::<u32>()
            .map_err(|_| format!("invalid --ff-target-pid value: {raw_pid:?}"))?;
        if parsed == 0 {
            return Err("--ff-target-pid must be greater than zero".to_string());
        }
        target_pid = Some(parsed);
    }
    Ok(target_pid)
}

fn run_process_guardian(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--probe" | "--connection-probe" | "--simvars-bridge" | "--sdk-clientdata-bridge"
        )
    }) {
        return Err("--process-guardian cannot be combined with a sidecar or probe mode".to_string());
    }
    let owner_pid = parse_owner_pid(args)?
        .ok_or_else(|| "--process-guardian requires --ff-owner-pid=<positive PID>".to_string())?;
    let target_pid = parse_target_pid(args)?
        .ok_or_else(|| "--process-guardian requires --ff-target-pid=<positive PID>".to_string())?;

    #[cfg(windows)]
    {
        process_guardian::run(owner_pid, target_pid)
    }
    #[cfg(not(windows))]
    {
        let _ = (owner_pid, target_pid);
        Err("--process-guardian is only supported on Windows".to_string())
    }
}

fn start_owner_lifeline(args: &[String]) -> Result<(), String> {
    let Some(owner_pid) = parse_owner_pid(args)? else {
        if args.iter().any(|arg| arg == "--probe") {
            return Ok(());
        }
        return Err(
            "--ff-owner-pid=<positive PID> is required for every non-probe mode".to_string(),
        );
    };

    #[cfg(windows)]
    {
        owner_lifeline::start(owner_pid)
    }
    #[cfg(not(windows))]
    {
        let _ = owner_pid;
        Err("--ff-owner-pid is only supported on Windows".to_string())
    }
}

// Mode priority matters: the standalone guardian must not start the normal
// owner watcher, while all regular bridge/probe modes share one dispatch point.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = if should_run_process_guardian(&args) {
        match run_process_guardian(&args) {
            Ok(()) => 0,
            Err(error) => {
                let _ = writeln!(
                    io::stderr(),
                    "[ff-rust-simconnect-sidecar] process guardian failed: {error}"
                );
                let _ = io::stderr().flush();
                3
            }
        }
    } else {
        match start_owner_lifeline(&args) {
            Ok(()) if should_run_connection_probe(&args) => sidecar::connection_probe(),
            Ok(()) if args.iter().any(|arg| arg == "--probe") => sidecar::probe(),
            Ok(()) => sidecar::run(should_enable_mobiflight(&args)),
            Err(error) => {
                let _ = writeln!(
                    io::stderr(),
                    "[ff-rust-simconnect-sidecar] refusing to start without owner lifeline: {error}"
                );
                let _ = io::stderr().flush();
                3
            }
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod entrypoint_tests {
    use super::{
        parse_owner_pid, parse_target_pid, run_process_guardian, should_enable_mobiflight,
        should_run_connection_probe, should_run_process_guardian, start_owner_lifeline,
        OWNER_LIFELINE_VERSION,
    };

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn mobiflight_mode_is_selected_only_by_explicit_sidecar_role_flags() {
        assert!(should_enable_mobiflight(&args(&["sidecar"])));
        assert!(!should_enable_mobiflight(&args(&[
            "sidecar",
            "--simvars-bridge"
        ])));
        assert!(!should_enable_mobiflight(&args(&[
            "sidecar",
            "--sdk-clientdata-bridge"
        ])));
    }

    #[test]
    fn connection_probe_mode_is_explicit_and_cannot_reenter_the_sidecar_loop() {
        assert!(!should_run_connection_probe(&args(&["sidecar"])));
        assert!(should_run_connection_probe(&args(&[
            "sidecar",
            "--connection-probe"
        ])));
    }

    #[test]
    fn process_guardian_mode_is_explicit_and_separate_from_sidecar_modes() {
        assert!(!should_run_process_guardian(&args(&["sidecar"])));
        assert!(should_run_process_guardian(&args(&[
            "sidecar",
            "--process-guardian"
        ])));
        assert!(run_process_guardian(&args(&["sidecar", "--process-guardian"]))
            .expect_err("guardian must require both exact process identities")
            .contains("requires --ff-owner-pid"));
        assert!(run_process_guardian(&args(&[
            "sidecar",
            "--process-guardian",
            "--probe",
            "--ff-owner-pid=1",
            "--ff-target-pid=2",
        ]))
        .expect_err("guardian and probe roles must not be combined")
        .contains("cannot be combined"));
    }

    #[test]
    fn owner_pid_argument_accepts_one_positive_decimal_pid() {
        assert_eq!(parse_owner_pid(&args(&["sidecar"])), Ok(None));
        assert_eq!(
            parse_owner_pid(&args(&["sidecar", "--ff-owner-pid=4242"])),
            Ok(Some(4242))
        );
    }

    #[test]
    fn malformed_or_ambiguous_owner_pid_arguments_fail_closed() {
        for values in [
            vec!["sidecar", "--ff-owner-pid"],
            vec!["sidecar", "--ff-owner-pid="],
            vec!["sidecar", "--ff-owner-pid=0"],
            vec!["sidecar", "--ff-owner-pid=-1"],
            vec!["sidecar", "--ff-owner-pid=12x"],
            vec!["sidecar", "--ff-owner-pid=4294967296"],
            vec!["sidecar", "--ff-owner-pid=12", "--ff-owner-pid=12"],
        ] {
            assert!(
                parse_owner_pid(&args(&values)).is_err(),
                "owner PID arguments should be rejected: {values:?}"
            );
        }
    }

    #[test]
    fn target_pid_argument_is_strict_and_unambiguous() {
        assert_eq!(
            parse_target_pid(&args(&["sidecar", "--ff-target-pid=4242"])),
            Ok(Some(4242))
        );
        for values in [
            vec!["sidecar", "--ff-target-pid"],
            vec!["sidecar", "--ff-target-pid=0"],
            vec!["sidecar", "--ff-target-pid=-1"],
            vec![
                "sidecar",
                "--ff-target-pid=12",
                "--ff-target-pid=12",
            ],
        ] {
            assert!(parse_target_pid(&args(&values)).is_err());
        }
    }

    #[test]
    fn every_process_except_capability_probe_requires_an_owner() {
        let error = start_owner_lifeline(&args(&["sidecar", "--simvars-bridge"]))
            .expect_err("long-running sidecars must reject a missing owner PID");
        assert!(error.contains("required for every non-probe mode"));

        assert_eq!(start_owner_lifeline(&args(&["sidecar", "--probe"])), Ok(()));
        let connection_error =
            start_owner_lifeline(&args(&["sidecar", "--connection-probe"]))
                .expect_err("a disposable connection probe must watch its spawning sidecar");
        assert!(connection_error.contains("required for every non-probe mode"));
        assert_eq!(OWNER_LIFELINE_VERSION, 1);
    }
}
