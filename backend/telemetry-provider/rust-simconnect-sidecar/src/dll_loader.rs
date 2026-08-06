//! Dynamic SimConnect DLL discovery and loading.
//!
//! This module owns the native-library trust boundary. It builds a
//! deterministic list of approved absolute candidates, loads one DLL, copies
//! the small set of symbols used by the sidecar, and keeps the `Library` alive
//! for as long as those function pointers can be called. It also provides
//! lightweight pipe/configuration probes so `main.rs` can avoid repeatedly
//! opening SimConnect while the simulator is unavailable.

use crate::simconnect_ffi::*;
use libloading::Library;
use std::collections::HashSet;
use std::env;
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::OnceLock;

const SIMCONNECT_PIPE_NAME: &str = r"\\.\pipe\Microsoft Flight Simulator\SimConnect";
const ERROR_FILE_NOT_FOUND: Dword = 2;
const ERROR_PATH_NOT_FOUND: Dword = 3;
const ERROR_BROKEN_PIPE: Dword = 109;
const ERROR_SEM_TIMEOUT: Dword = 121;
const ERROR_PIPE_BUSY: Dword = 231;
const ERROR_PIPE_NOT_CONNECTED: Dword = 233;

#[link(name = "kernel32")]
extern "system" {
    fn WaitNamedPipeW(named_pipe_name: *const u16, timeout_ms: Dword) -> i32;
    fn GetLastError() -> Dword;
}

// This table is the safe-side handle to the raw declarations in
// `simconnect_ffi.rs`. `_lib` must outlive every copied function pointer.
pub(crate) struct SimConnectApi {
    pub(crate) _lib: Library,
    pub(crate) library_spec: String,
    pub(crate) open: SimConnectOpen,
    pub(crate) close: SimConnectClose,
    pub(crate) call_dispatch: SimConnectCallDispatch,
    pub(crate) add_to_data_definition: SimConnectAddToDataDefinition,
    pub(crate) clear_data_definition: SimConnectClearDataDefinition,
    pub(crate) request_data_on_sim_object: SimConnectRequestDataOnSimObject,
    pub(crate) map_client_event_to_sim_event: SimConnectMapClientEventToSimEvent,
    pub(crate) transmit_client_event: SimConnectTransmitClientEvent,
    pub(crate) get_last_sent_packet_id: SimConnectGetLastSentPacketId,
    pub(crate) set_data_on_sim_object: SimConnectSetDataOnSimObject,
    pub(crate) camera_set_relative_6dof: SimConnectCameraSetRelative6Dof,
    pub(crate) map_client_data_name_to_id: SimConnectMapClientDataNameToId,
    pub(crate) create_client_data: SimConnectCreateClientData,
    pub(crate) add_to_client_data_definition: SimConnectAddToClientDataDefinition,
    pub(crate) clear_client_data_definition: SimConnectClearClientDataDefinition,
    pub(crate) request_client_data: SimConnectRequestClientData,
    pub(crate) set_client_data: SimConnectSetClientData,
    pub(crate) request_system_state: SimConnectRequestSystemState,
    pub(crate) subscribe_to_system_event: SimConnectSubscribeToSystemEvent,
    pub(crate) add_to_facility_definition: Option<SimConnectAddToFacilityDefinition>,
    pub(crate) request_facility_data: Option<SimConnectRequestFacilityData>,
}

fn load_symbol<T: Copy>(lib: &Library, symbol: &'static [u8], name: &str) -> Result<T, String> {
    // SimConnect exports stable function pointers; callers keep `lib` owned by SimConnectApi.
    unsafe { lib.get::<T>(symbol) }
        .map(|symbol| *symbol)
        .map_err(|err| format!("missing {name}: {err}"))
}

fn load_optional_symbol<T: Copy>(lib: &Library, symbol: &'static [u8]) -> Option<T> {
    unsafe { lib.get::<T>(symbol) }.map(|symbol| *symbol).ok()
}

impl SimConnectApi {
    pub(crate) fn load() -> Result<Self, String> {
        let mut errors = Vec::new();
        for candidate in simconnect_candidates() {
            match Self::load_candidate(&candidate) {
                Ok(api) => return Ok(api),
                Err(err) => errors.push(format!("{}: {err}", candidate.display_name())),
            }
        }
        Err(format!(
            "Unable to load SimConnect.dll from a trusted path. Configure an absolute FF_SIMCONNECT_DLL_PATH or simulator.simConnectDllPath when using a custom SDK install. Loader details: {}",
            errors.join("; ")
        ))
    }

    fn load_candidate(candidate: &Candidate) -> Result<Self, String> {
        let display = candidate.display_name();
        // Loading a DLL and binding raw exported symbols is the single dynamic-link boundary.
        // The owned Library is stored alongside copied function pointers so symbols cannot outlive it.
        let lib = unsafe { Library::new(candidate.load_name()) }.map_err(|err| err.to_string())?;
        let open = load_symbol::<SimConnectOpen>(&lib, b"SimConnect_Open\0", "SimConnect_Open")?;
        let close =
            load_symbol::<SimConnectClose>(&lib, b"SimConnect_Close\0", "SimConnect_Close")?;
        let call_dispatch = load_symbol::<SimConnectCallDispatch>(
            &lib,
            b"SimConnect_CallDispatch\0",
            "SimConnect_CallDispatch",
        )?;
        let add_to_data_definition = load_symbol::<SimConnectAddToDataDefinition>(
            &lib,
            b"SimConnect_AddToDataDefinition\0",
            "SimConnect_AddToDataDefinition",
        )?;
        let clear_data_definition = load_symbol::<SimConnectClearDataDefinition>(
            &lib,
            b"SimConnect_ClearDataDefinition\0",
            "SimConnect_ClearDataDefinition",
        )?;
        let request_data_on_sim_object = load_symbol::<SimConnectRequestDataOnSimObject>(
            &lib,
            b"SimConnect_RequestDataOnSimObject\0",
            "SimConnect_RequestDataOnSimObject",
        )?;
        let map_client_event_to_sim_event = load_symbol::<SimConnectMapClientEventToSimEvent>(
            &lib,
            b"SimConnect_MapClientEventToSimEvent\0",
            "SimConnect_MapClientEventToSimEvent",
        )?;
        let transmit_client_event = load_symbol::<SimConnectTransmitClientEvent>(
            &lib,
            b"SimConnect_TransmitClientEvent\0",
            "SimConnect_TransmitClientEvent",
        )?;
        let get_last_sent_packet_id = load_symbol::<SimConnectGetLastSentPacketId>(
            &lib,
            b"SimConnect_GetLastSentPacketID\0",
            "SimConnect_GetLastSentPacketID",
        )?;
        let set_data_on_sim_object = load_symbol::<SimConnectSetDataOnSimObject>(
            &lib,
            b"SimConnect_SetDataOnSimObject\0",
            "SimConnect_SetDataOnSimObject",
        )?;
        let camera_set_relative_6dof = load_symbol::<SimConnectCameraSetRelative6Dof>(
            &lib,
            b"SimConnect_CameraSetRelative6DOF\0",
            "SimConnect_CameraSetRelative6DOF",
        )?;
        let map_client_data_name_to_id = load_symbol::<SimConnectMapClientDataNameToId>(
            &lib,
            b"SimConnect_MapClientDataNameToID\0",
            "SimConnect_MapClientDataNameToID",
        )?;
        let create_client_data = load_symbol::<SimConnectCreateClientData>(
            &lib,
            b"SimConnect_CreateClientData\0",
            "SimConnect_CreateClientData",
        )?;
        let add_to_client_data_definition = load_symbol::<SimConnectAddToClientDataDefinition>(
            &lib,
            b"SimConnect_AddToClientDataDefinition\0",
            "SimConnect_AddToClientDataDefinition",
        )?;
        let clear_client_data_definition = load_symbol::<SimConnectClearClientDataDefinition>(
            &lib,
            b"SimConnect_ClearClientDataDefinition\0",
            "SimConnect_ClearClientDataDefinition",
        )?;
        let request_client_data = load_symbol::<SimConnectRequestClientData>(
            &lib,
            b"SimConnect_RequestClientData\0",
            "SimConnect_RequestClientData",
        )?;
        let set_client_data = load_symbol::<SimConnectSetClientData>(
            &lib,
            b"SimConnect_SetClientData\0",
            "SimConnect_SetClientData",
        )?;
        let request_system_state = load_symbol::<SimConnectRequestSystemState>(
            &lib,
            b"SimConnect_RequestSystemState\0",
            "SimConnect_RequestSystemState",
        )?;
        let subscribe_to_system_event = load_symbol::<SimConnectSubscribeToSystemEvent>(
            &lib,
            b"SimConnect_SubscribeToSystemEvent\0",
            "SimConnect_SubscribeToSystemEvent",
        )?;
        let add_to_facility_definition = load_optional_symbol::<SimConnectAddToFacilityDefinition>(
            &lib,
            b"SimConnect_AddToFacilityDefinition\0",
        );
        let request_facility_data = load_optional_symbol::<SimConnectRequestFacilityData>(
            &lib,
            b"SimConnect_RequestFacilityData\0",
        );

        Ok(Self {
            _lib: lib,
            library_spec: display,
            open,
            close,
            call_dispatch,
            add_to_data_definition,
            clear_data_definition,
            request_data_on_sim_object,
            map_client_event_to_sim_event,
            transmit_client_event,
            get_last_sent_packet_id,
            set_data_on_sim_object,
            camera_set_relative_6dof,
            map_client_data_name_to_id,
            create_client_data,
            add_to_client_data_definition,
            clear_client_data_definition,
            request_client_data,
            set_client_data,
            request_system_state,
            subscribe_to_system_event,
            add_to_facility_definition,
            request_facility_data,
        })
    }

    pub(crate) fn probe_connection(&self) -> Result<(), String> {
        let mut handle: Handle = ptr::null_mut();
        let name = CString::new("FlightFabric-Rust-Connection-Probe")
            .expect("static connection probe name cannot contain NUL");
        let hr = unsafe {
            (self.open)(
                &mut handle,
                name.as_ptr(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                0,
            )
        };
        if !hresult_succeeded(hr) {
            return Err(format!(
                "SimConnect_Open probe failed: hr=0x{:08X}",
                hr as u32
            ));
        }

        if !handle.is_null() {
            let _ = unsafe { (self.close)(handle) };
        }
        Ok(())
    }
}

fn simconnect_pipe_name_wide() -> &'static [u16] {
    static PIPE_NAME: OnceLock<Vec<u16>> = OnceLock::new();
    PIPE_NAME
        .get_or_init(|| {
            SIMCONNECT_PIPE_NAME
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect()
        })
        .as_slice()
}

// Waiting for zero milliseconds makes this a non-blocking readiness gate. Some
// Windows pipe errors mean "not ready yet"; unexpected errors remain visible.
fn classify_pipe_wait(wait_succeeded: bool, error_code: Dword) -> Result<bool, Dword> {
    if wait_succeeded {
        return Ok(true);
    }

    match error_code {
        ERROR_FILE_NOT_FOUND
        | ERROR_PATH_NOT_FOUND
        | ERROR_BROKEN_PIPE
        | ERROR_SEM_TIMEOUT
        | ERROR_PIPE_BUSY
        | ERROR_PIPE_NOT_CONNECTED => Ok(false),
        error => Err(error),
    }
}

pub(crate) fn simconnect_server_ready() -> Result<bool, String> {
    let wait_succeeded = unsafe { WaitNamedPipeW(simconnect_pipe_name_wide().as_ptr(), 0) } != 0;
    let error_code = if wait_succeeded {
        0
    } else {
        unsafe { GetLastError() }
    };
    classify_pipe_wait(wait_succeeded, error_code)
        .map_err(|error| format!("WaitNamedPipeW failed: win32={error}"))
}

fn push_config_directory(
    candidates: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
    directory: Option<&Path>,
) {
    let Some(directory) = directory else { return };
    let path = directory.join("SimConnect.cfg");
    let key_path = path.canonicalize().unwrap_or_else(|_| path.clone());
    let key = key_path.to_string_lossy().to_lowercase();
    if seen.insert(key) {
        candidates.push(path);
    }
}

fn simconnect_config_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    if let Ok(exe) = env::current_exe() {
        push_config_directory(&mut candidates, &mut seen, exe.parent());
    }
    if let Ok(current_dir) = env::current_dir() {
        push_config_directory(&mut candidates, &mut seen, Some(&current_dir));
    }
    for candidate in simconnect_candidates() {
        push_config_directory(&mut candidates, &mut seen, candidate.path.parent());
    }

    candidates
}

pub(crate) fn has_simconnect_config() -> bool {
    simconnect_config_candidates()
        .iter()
        .any(|path| path.is_file())
}

struct Candidate {
    path: PathBuf,
    source: &'static str,
}

impl Candidate {
    fn load_name(&self) -> String {
        self.path.to_string_lossy().to_string()
    }

    fn display_name(&self) -> String {
        format!("{}:{}", self.source, self.path.to_string_lossy())
    }
}

// Candidate construction is centralized so environment, executable, and
// working-directory inputs all receive the same absolute-path and dedupe rules.
fn push_candidate(
    candidates: &mut Vec<Candidate>,
    seen: &mut HashSet<String>,
    candidate: Option<PathBuf>,
) {
    let Some(mut path) = candidate else { return };
    if path.as_os_str().is_empty() {
        return;
    }
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("dll"))
        != Some(true)
    {
        path = path.join("SimConnect.dll");
    }
    if !path.is_absolute() {
        return;
    }
    let key_path = path.canonicalize().unwrap_or_else(|_| path.clone());
    let key = key_path.to_string_lossy().to_lowercase();
    if seen.insert(key) {
        candidates.push(Candidate {
            path,
            source: "trusted-path",
        });
    }
}

fn simconnect_candidates() -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    push_candidate(
        &mut candidates,
        &mut seen,
        env::var_os("FF_SIMCONNECT_DLL_PATH").map(PathBuf::from),
    );

    if let Some(local_appdata) = env::var_os("LOCALAPPDATA") {
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(
                PathBuf::from(local_appdata)
                    .join("Flight Fabric")
                    .join("SimConnect")
                    .join("SimConnect.dll"),
            ),
        );
    }
    if let Some(appdata) = env::var_os("APPDATA") {
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(
                PathBuf::from(appdata)
                    .join("Flight Fabric")
                    .join("SimConnect")
                    .join("SimConnect.dll"),
            ),
        );
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push_candidate(
                &mut candidates,
                &mut seen,
                Some(exe_dir.join("simconnect").join("SimConnect.dll")),
            );

            if is_rust_sidecar_target_dir(exe_dir) {
                push_candidate(
                    &mut candidates,
                    &mut seen,
                    Some(
                        exe_dir
                            .join("..")
                            .join("..")
                            .join("..")
                            .join("simconnect")
                            .join("SimConnect.dll"),
                    ),
                );
            }
        }
    }

    candidates
}

fn is_rust_sidecar_target_dir(path: &Path) -> bool {
    let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if !["debug", "release"]
        .iter()
        .any(|name| dir_name.eq_ignore_ascii_case(name))
    {
        return false;
    }
    let Some(target_dir) = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    let Some(project_dir) = path
        .parent()
        .and_then(|parent| parent.parent())
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    target_dir.eq_ignore_ascii_case("target")
        && project_dir.eq_ignore_ascii_case("rust-simconnect-sidecar")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simconnect_pipe_gate_only_opens_when_the_server_is_accepting_connections() {
        assert_eq!(classify_pipe_wait(true, ERROR_FILE_NOT_FOUND), Ok(true));
        for error in [
            ERROR_FILE_NOT_FOUND,
            ERROR_PATH_NOT_FOUND,
            ERROR_BROKEN_PIPE,
            ERROR_SEM_TIMEOUT,
            ERROR_PIPE_BUSY,
            ERROR_PIPE_NOT_CONNECTED,
        ] {
            assert_eq!(classify_pipe_wait(false, error), Ok(false));
        }
        assert_eq!(classify_pipe_wait(false, 5), Err(5));
    }

    #[test]
    fn simconnect_pipe_gate_uses_the_local_sdk_endpoint() {
        let wide = simconnect_pipe_name_wide();
        assert_eq!(wide.last(), Some(&0));
        assert_eq!(
            String::from_utf16(&wide[..wide.len() - 1]).expect("pipe name should be valid UTF-16"),
            SIMCONNECT_PIPE_NAME
        );
    }

    #[test]
    fn simconnect_config_candidates_cover_and_deduplicate_client_directories() {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_config_directory(
            &mut candidates,
            &mut seen,
            Some(Path::new(r"C:\FlightFabric")),
        );
        push_config_directory(
            &mut candidates,
            &mut seen,
            Some(Path::new(r"C:\flightfabric")),
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0],
            PathBuf::from(r"C:\FlightFabric\SimConnect.cfg")
        );
    }

    #[test]
    fn simconnect_config_discovery_covers_executable_cwd_and_dll_locations() {
        let configs = simconnect_config_candidates();
        let executable = env::current_exe().expect("test executable path should resolve");
        let current_dir = env::current_dir().expect("test working directory should resolve");
        assert!(configs.contains(
            &executable
                .parent()
                .expect("test executable should have a parent")
                .join("SimConnect.cfg")
        ));
        assert!(configs.contains(&current_dir.join("SimConnect.cfg")));

        for dll in simconnect_candidates() {
            assert!(configs.contains(
                &dll.path
                    .parent()
                    .expect("DLL candidate should have a parent")
                    .join("SimConnect.cfg")
            ));
        }
    }

    #[test]
    fn simconnect_dll_candidates_require_absolute_trusted_paths() {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(PathBuf::from("relative/SimConnect.dll")),
        );
        assert_eq!(candidates.len(), 0);

        assert!(is_rust_sidecar_target_dir(Path::new(
            r"C:\ff\backend\telemetry-provider\rust-simconnect-sidecar\target\release"
        )));
        assert!(!is_rust_sidecar_target_dir(Path::new(
            r"C:\ff\backend\telemetry-provider"
        )));
    }

    #[test]
    fn push_candidate_appends_dll_name_and_deduplicates_case_insensitively() {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(PathBuf::from(r"C:\FlightFabric\SimConnect")),
        );
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(PathBuf::from(r"C:\flightfabric\simconnect\SimConnect.dll")),
        );

        assert_eq!(candidates.len(), 1);
        assert!(candidates[0]
            .load_name()
            .ends_with(r"FlightFabric\SimConnect\SimConnect.dll"));
    }
}
