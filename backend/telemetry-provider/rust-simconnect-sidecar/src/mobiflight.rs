//! Flight Fabric's client for the MobiFlight Event Module's SimConnect
//! ClientData protocol. This talks directly to the WASM module running inside
//! MSFS; it does not launch or require the MobiFlight Connector desktop app.
//!
//! `ClientState` is intentionally transport-agnostic: its state machine emits
//! `Action` values, while `main.rs` performs the actual SimConnect calls and
//! reports success or failure back. Startup first contacts MobiFlight's shared
//! initialization area, then switches to a unique runtime area and periodically
//! health-checks it. This separation keeps retries and timeouts unit-testable.

use std::time::{Duration, Instant};

pub(crate) const MESSAGE_SIZE: usize = 1024;
pub(crate) const LVAR_AREA_SIZE: u32 = 4096;
pub(crate) const STRING_VAR_AREA_SIZE: u32 = 128 * 64;

pub(crate) const INIT_LVAR_DATA_ID: u32 = 0x4D46_1001;
pub(crate) const INIT_COMMAND_DATA_ID: u32 = 0x4D46_1002;
pub(crate) const INIT_RESPONSE_DATA_ID: u32 = 0x4D46_1003;
pub(crate) const INIT_STRING_DATA_ID: u32 = 0x4D46_1004;
pub(crate) const RUNTIME_LVAR_DATA_ID: u32 = 0x4D46_1011;
pub(crate) const RUNTIME_COMMAND_DATA_ID: u32 = 0x4D46_1012;
pub(crate) const RUNTIME_RESPONSE_DATA_ID: u32 = 0x4D46_1013;
pub(crate) const RUNTIME_STRING_DATA_ID: u32 = 0x4D46_1014;

pub(crate) const INIT_RESPONSE_DEFINE_ID: u32 = 0x4D46_2001;
pub(crate) const RUNTIME_RESPONSE_DEFINE_ID: u32 = 0x4D46_2002;
pub(crate) const INIT_RESPONSE_REQUEST_ID: u32 = 0x4D46_3001;
pub(crate) const RUNTIME_RESPONSE_REQUEST_ID: u32 = 0x4D46_3002;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(4);
const RETRY_DELAY: Duration = Duration::from_secs(5);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(10);

// The initialization area is shared with the WASM module; the runtime area is
// unique to this sidecar instance so simultaneous clients do not collide.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClientAreaKind {
    Init,
    Runtime,
}

impl ClientAreaKind {
    pub(crate) fn base_name(self, runtime_name: &str) -> &str {
        match self {
            Self::Init => "MobiFlight",
            Self::Runtime => runtime_name,
        }
    }

    pub(crate) fn lvar_data_id(self) -> u32 {
        match self {
            Self::Init => INIT_LVAR_DATA_ID,
            Self::Runtime => RUNTIME_LVAR_DATA_ID,
        }
    }

    pub(crate) fn command_data_id(self) -> u32 {
        match self {
            Self::Init => INIT_COMMAND_DATA_ID,
            Self::Runtime => RUNTIME_COMMAND_DATA_ID,
        }
    }

    pub(crate) fn response_data_id(self) -> u32 {
        match self {
            Self::Init => INIT_RESPONSE_DATA_ID,
            Self::Runtime => RUNTIME_RESPONSE_DATA_ID,
        }
    }

    pub(crate) fn string_data_id(self) -> u32 {
        match self {
            Self::Init => INIT_STRING_DATA_ID,
            Self::Runtime => RUNTIME_STRING_DATA_ID,
        }
    }

    pub(crate) fn response_define_id(self) -> u32 {
        match self {
            Self::Init => INIT_RESPONSE_DEFINE_ID,
            Self::Runtime => RUNTIME_RESPONSE_DEFINE_ID,
        }
    }

    pub(crate) fn response_request_id(self) -> u32 {
        match self {
            Self::Init => INIT_RESPONSE_REQUEST_ID,
            Self::Runtime => RUNTIME_RESPONSE_REQUEST_ID,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Status {
    pub(crate) state: &'static str,
    pub(crate) connected: bool,
    pub(crate) available: bool,
    pub(crate) error: Option<String>,
}

impl Status {
    fn connecting(connected: bool) -> Self {
        Self {
            state: "connecting",
            connected,
            available: false,
            error: None,
        }
    }

    fn ready() -> Self {
        Self {
            state: "connected",
            connected: true,
            available: true,
            error: None,
        }
    }

    fn error(error: impl Into<String>) -> Self {
        Self {
            state: "error",
            connected: false,
            available: false,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    AwaitingPong,
    AwaitingRegistration,
    Ready,
    RetryWait,
}

// Actions describe the next transport operation without directly depending on
// SimConnect function pointers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    ProbeInit,
    RegisterRuntime,
    ConfigureRuntime,
    ProbeRuntime,
}

pub(crate) struct ClientState {
    runtime_name: String,
    phase: Phase,
    deadline: Option<Instant>,
    retry_at: Option<Instant>,
    next_health_check_at: Option<Instant>,
    health_deadline: Option<Instant>,
    pending_action: Option<Action>,
    pending_statuses: Vec<Status>,
    last_status: Option<Status>,
}

impl ClientState {
    pub(crate) fn new(runtime_name: String) -> Self {
        Self {
            runtime_name,
            phase: Phase::Idle,
            deadline: None,
            retry_at: None,
            next_health_check_at: None,
            health_deadline: None,
            pending_action: None,
            pending_statuses: Vec::new(),
            last_status: None,
        }
    }

    pub(crate) fn runtime_name(&self) -> &str {
        &self.runtime_name
    }

    pub(crate) fn is_available(&self) -> bool {
        self.phase == Phase::Ready
    }

    pub(crate) fn start(&mut self, now: Instant) {
        self.phase = Phase::Idle;
        self.deadline = None;
        self.retry_at = None;
        self.next_health_check_at = None;
        self.health_deadline = None;
        self.pending_action = Some(Action::ProbeInit);
        self.push_status(Status::connecting(false));
        self.tick(now);
    }

    pub(crate) fn action_succeeded(&mut self, action: Action, now: Instant) {
        match action {
            Action::ProbeInit => {
                self.phase = Phase::AwaitingPong;
                self.deadline = Some(now + HANDSHAKE_TIMEOUT);
            }
            Action::RegisterRuntime => {
                self.phase = Phase::AwaitingRegistration;
                self.deadline = Some(now + HANDSHAKE_TIMEOUT);
            }
            Action::ConfigureRuntime => {
                self.phase = Phase::Ready;
                self.deadline = None;
                self.retry_at = None;
                self.health_deadline = None;
                self.next_health_check_at = Some(now + HEALTH_CHECK_INTERVAL);
                self.push_status(Status::ready());
            }
            Action::ProbeRuntime => {
                self.health_deadline = Some(now + HANDSHAKE_TIMEOUT);
            }
        }
    }

    pub(crate) fn action_failed(&mut self, action: Action, error: impl AsRef<str>, now: Instant) {
        let error = format!(
            "mobiflight_wasm_{}_failed:{}",
            match action {
                Action::ProbeInit => "probe",
                Action::RegisterRuntime => "registration",
                Action::ConfigureRuntime => "runtime_setup",
                Action::ProbeRuntime => "health_check",
            },
            error.as_ref()
        );
        self.fail_and_retry(error, now);
    }

    pub(crate) fn initialization_failed(&mut self, error: impl AsRef<str>, now: Instant) {
        self.fail_and_retry(
            format!("mobiflight_wasm_init_failed:{}", error.as_ref()),
            now,
        );
    }

    pub(crate) fn disconnected(&mut self, error: impl Into<String>) {
        self.phase = Phase::Idle;
        self.deadline = None;
        self.retry_at = None;
        self.next_health_check_at = None;
        self.health_deadline = None;
        self.pending_action = None;
        self.push_status(Status {
            state: "disconnected",
            connected: false,
            available: false,
            error: Some(error.into()),
        });
    }

    pub(crate) fn handle_response(&mut self, request_id: u32, response: &str, now: Instant) {
        if request_id == INIT_RESPONSE_REQUEST_ID {
            if response == "MF.Pong"
                && matches!(
                    self.phase,
                    Phase::AwaitingPong | Phase::RetryWait | Phase::Idle
                )
            {
                self.deadline = None;
                self.push_status(Status::connecting(true));
                self.pending_action = Some(Action::RegisterRuntime);
            } else if self.phase == Phase::AwaitingRegistration
                && response.contains(&self.runtime_name)
            {
                self.deadline = None;
                self.pending_action = Some(Action::ConfigureRuntime);
            }
            return;
        }

        if request_id == RUNTIME_RESPONSE_REQUEST_ID && response == "MF.Pong" {
            self.health_deadline = None;
            self.next_health_check_at = Some(now + HEALTH_CHECK_INTERVAL);
            if self.phase == Phase::Ready {
                self.push_status(Status::ready());
            }
        }
    }

    pub(crate) fn tick(&mut self, now: Instant) {
        if self.deadline.is_some_and(|deadline| now >= deadline)
            || self.health_deadline.is_some_and(|deadline| now >= deadline)
        {
            self.fail_and_retry("mobiflight_wasm_handshake_timeout", now);
            return;
        }

        if self.phase == Phase::RetryWait && self.retry_at.is_some_and(|retry_at| now >= retry_at) {
            self.retry_at = None;
            self.pending_action = Some(Action::ProbeInit);
            self.push_status(Status::connecting(false));
            return;
        }

        if self.phase == Phase::Ready
            && self.health_deadline.is_none()
            && self
                .next_health_check_at
                .is_some_and(|check_at| now >= check_at)
        {
            self.next_health_check_at = None;
            self.pending_action = Some(Action::ProbeRuntime);
        }
    }

    pub(crate) fn take_action(&mut self) -> Option<Action> {
        self.pending_action.take()
    }

    pub(crate) fn drain_statuses(&mut self) -> Vec<Status> {
        self.pending_statuses.drain(..).collect()
    }

    fn fail_and_retry(&mut self, error: impl Into<String>, now: Instant) {
        self.phase = Phase::RetryWait;
        self.deadline = None;
        self.health_deadline = None;
        self.next_health_check_at = None;
        self.pending_action = None;
        self.retry_at = Some(now + RETRY_DELAY);
        self.push_status(Status::error(error));
    }

    fn push_status(&mut self, status: Status) {
        if self.last_status.as_ref() == Some(&status) {
            return;
        }
        self.last_status = Some(status.clone());
        self.pending_statuses.push(status);
    }
}

// ClientData messages are fixed-size NUL-padded ASCII buffers. These helpers
// keep encoding rules at the protocol edge rather than in the session loop.
pub(crate) fn owns_response_packet(request_id: u32, define_id: u32) -> bool {
    matches!(
        (request_id, define_id),
        (INIT_RESPONSE_REQUEST_ID, INIT_RESPONSE_DEFINE_ID)
            | (RUNTIME_RESPONSE_REQUEST_ID, RUNTIME_RESPONSE_DEFINE_ID)
    )
}

pub(crate) fn decode_message(raw: &[u8]) -> String {
    let len = raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..len]).trim().to_string()
}

pub(crate) fn encode_command(command: &str) -> Result<[u8; MESSAGE_SIZE], &'static str> {
    if command.is_empty() {
        return Err("empty_command");
    }
    if !command
        .as_bytes()
        .iter()
        .all(|byte| matches!(byte, 0x20..=0x7e))
    {
        return Err("command_must_be_printable_ascii");
    }
    if command.len() > MESSAGE_SIZE {
        return Err("command_too_long");
    }
    let mut encoded = [0u8; MESSAGE_SIZE];
    encoded[..command.len()].copy_from_slice(command.as_bytes());
    Ok(encoded)
}

pub(crate) fn execution_command(code: &str) -> Result<String, &'static str> {
    let code = code.trim();
    if code.is_empty() {
        return Err("empty_code");
    }
    let command = format!("MF.SimVars.Set.{code}");
    encode_command(&command)?;
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_fixed_size_printable_ascii_and_bounded() {
        let command = execution_command("1 (>K:ROTOR_BRAKE)").expect("valid RPN");
        assert_eq!(command, "MF.SimVars.Set.1 (>K:ROTOR_BRAKE)");
        let encoded = encode_command(&command).expect("command should encode");
        assert_eq!(decode_message(&encoded), command);
        assert_eq!(encoded.len(), MESSAGE_SIZE);

        assert_eq!(execution_command(" \n "), Err("empty_code"));
        assert_eq!(
            execution_command("1\n2"),
            Err("command_must_be_printable_ascii")
        );
        assert_eq!(
            execution_command("é"),
            Err("command_must_be_printable_ascii")
        );
        assert_eq!(
            encode_command(&"X".repeat(MESSAGE_SIZE + 1)),
            Err("command_too_long")
        );
    }

    #[test]
    fn request_ids_reserve_mobiflight_responses_without_claiming_sdk_packets() {
        assert!(owns_response_packet(
            INIT_RESPONSE_REQUEST_ID,
            INIT_RESPONSE_DEFINE_ID
        ));
        assert!(owns_response_packet(
            RUNTIME_RESPONSE_REQUEST_ID,
            RUNTIME_RESPONSE_DEFINE_ID
        ));
        assert!(!owns_response_packet(3, 2));
        assert!(!owns_response_packet(INIT_RESPONSE_REQUEST_ID, 2));
    }

    #[test]
    fn handshake_requires_pong_and_unique_client_confirmation() {
        let start = Instant::now();
        let mut client = ClientState::new("Client_FlightFabric_123".to_string());
        client.start(start);
        assert_eq!(client.take_action(), Some(Action::ProbeInit));
        client.action_succeeded(Action::ProbeInit, start);
        assert!(!client.is_available());

        client.handle_response(INIT_RESPONSE_REQUEST_ID, "MF.Pong", start);
        assert_eq!(client.take_action(), Some(Action::RegisterRuntime));
        client.action_succeeded(Action::RegisterRuntime, start);
        client.handle_response(
            INIT_RESPONSE_REQUEST_ID,
            "MF.Clients.Added.Client_FlightFabric_123",
            start,
        );
        assert_eq!(client.take_action(), Some(Action::ConfigureRuntime));
        client.action_succeeded(Action::ConfigureRuntime, start);
        assert!(client.is_available());
        assert!(client
            .drain_statuses()
            .iter()
            .any(|status| status.state == "connected" && status.available));
    }

    #[test]
    fn handshake_timeout_marks_unavailable_and_schedules_retry() {
        let start = Instant::now();
        let mut client = ClientState::new("Client_FlightFabric_123".to_string());
        client.start(start);
        assert_eq!(client.take_action(), Some(Action::ProbeInit));
        client.action_succeeded(Action::ProbeInit, start);

        client.tick(start + HANDSHAKE_TIMEOUT + Duration::from_millis(1));
        assert!(!client.is_available());
        assert!(client
            .drain_statuses()
            .iter()
            .any(|status| status.error.as_deref() == Some("mobiflight_wasm_handshake_timeout")));

        client.tick(start + HANDSHAKE_TIMEOUT + RETRY_DELAY + Duration::from_millis(2));
        assert_eq!(client.take_action(), Some(Action::ProbeInit));
    }

    #[test]
    fn ready_client_stays_available_during_health_probe_and_drops_on_timeout() {
        let start = Instant::now();
        let mut client = ClientState::new("Client_FlightFabric_123".to_string());
        client.action_succeeded(Action::ConfigureRuntime, start);
        assert!(client.is_available());

        client.tick(start + HEALTH_CHECK_INTERVAL + Duration::from_millis(1));
        assert_eq!(client.take_action(), Some(Action::ProbeRuntime));
        client.action_succeeded(Action::ProbeRuntime, start + HEALTH_CHECK_INTERVAL);
        assert!(client.is_available());

        client.tick(start + HEALTH_CHECK_INTERVAL + HANDSHAKE_TIMEOUT + Duration::from_millis(1));
        assert!(!client.is_available());
        assert!(client
            .drain_statuses()
            .iter()
            .any(|status| status.error.as_deref() == Some("mobiflight_wasm_handshake_timeout")));
    }
}
