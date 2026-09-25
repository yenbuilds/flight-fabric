//! Dedicated MSFS 2024 motion proof. Owns the USER object, never an AI proxy.
//! This mode deliberately survives stdin EOF to complete reload recovery.
//! A durable journal blocks ordinary bridges even after a native process crash.
use crate::dll_loader::SimConnectApi;
use crate::replay_journal::{self, Journal};
use crate::replay_model::{advance, Clip, ParkedGate, ReplayCommand, ReplayLifecycle, ReplayPhase, Sample};
use crate::replay_transport::ReplayOutput;
use crate::simconnect_ffi::*;
use serde_json::json;
use std::ffi::{c_void, CString};
use std::fs;
use std::io::{self, BufRead, Read};
use std::ptr;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};

const FRAME: u32 = 100;
const SIM_START: u32 = 101;
const SIM_STOP: u32 = 102;
const FLIGHT_LOADED: u32 = 103;
const AIRCRAFT_LOADED: u32 = 104;
const PAUSE: u32 = 105;
const SNAPSHOT: u32 = 200;
const POSE: u32 = 201;
const FREEZE: u32 = 300;

#[derive(Clone, Debug)]
struct Snapshot {
    title: String,
    values: [f64; 13],
    at: Instant,
}
impl Snapshot {
    fn freezes(&self) -> [bool; 3] {
        [
            self.values[0] == 1.0,
            self.values[1] == 1.0,
            self.values[2] == 1.0,
        ]
    }
    fn valid(&self, title: &str) -> bool {
        self.at.elapsed() < Duration::from_millis(500) && self.title == title
            && self.values.iter().all(|x| x.is_finite())
            && self.values[..3].iter().all(|x| *x==0.0 || *x==1.0)
            // MSFS 2024 native cockpit/external/showcase/drone views. Never
            // reuse computeMenuState's aircraft-input gate for free cameras.
            && self.values[5].fract() == 0.0
            // 9 is also the toolbar's transition to the last showcase view.
            && matches!(self.values[5] as u32, 2..=9 | 16 | 17)
            && self.values[6]==0.0 && self.values[7]==0.0 && self.values[8]==0.0
    }
    fn parked(&self) -> bool {
        self.values[3] == 1.0
            && self.values[4].abs() < 1.0
            && self.values[9..].iter().all(|v| *v == 0.0)
    }
}

struct Inbox {
    snapshot: Option<Snapshot>,
    freeze_request: Option<u32>,
    freeze_readback: Option<Snapshot>,
    frame: bool,
    speed: f32,
    sim: bool,
    paused: bool,
    loaded: u64,
    changed: u64,
    fault: Option<String>,
}

// SDK buffers are packed and not necessarily aligned. Never form references
// into them; check both lengths before copying primitive fields.
unsafe extern "system" fn dispatch(data: *mut SimConnectRecv, cb: u32, context: *mut c_void) {
    if data.is_null() || context.is_null() || cb < 12 {
        return;
    }
    let inbox = unsafe { &mut *(context as *mut Inbox) };
    let p = data as *const u8;
    let u32_at = |n: usize| unsafe { ptr::read_unaligned(p.add(n) as *const u32) };
    let bytes = (cb as usize).min(u32_at(0) as usize);
    if bytes < 12 {
        return;
    }
    match u32_at(8) {
        1 if bytes >= 24 => {
            inbox.fault = Some(format!(
                "SimConnect exception {} (packet {})",
                u32_at(12),
                u32_at(16)
            ))
        }
        3 => inbox.fault = Some("Simulator disconnected; reload recovery is required".into()),
        4 | 6 if bytes >= 24 => match u32_at(16) {
            SIM_START => inbox.sim = true,
            SIM_STOP => {
                inbox.sim = false;
                inbox.changed += 1;
                inbox.freeze_readback = None;
            }
            FLIGHT_LOADED => {
                inbox.loaded += 1;
                inbox.changed += 1;
                inbox.snapshot = None;
                inbox.freeze_readback = None;
            }
            AIRCRAFT_LOADED => {
                inbox.changed += 1;
                inbox.snapshot = None;
                inbox.freeze_readback = None;
            }
            PAUSE => inbox.paused = u32_at(20) != 0,
            _ => (),
        },
        7 if bytes >= 32 && u32_at(16) == FRAME => {
            inbox.frame = true;
            inbox.speed = unsafe { ptr::read_unaligned(p.add(28) as *const f32) };
        }
        15 if bytes >= 284 && u32_at(12) == SIM_START => inbox.sim = u32_at(16) == 1,
        8 if bytes >= 40 + 256 + 13 * 8
            && (u32_at(12) == SNAPSHOT || Some(u32_at(12)) == inbox.freeze_request)
            && u32_at(16) == 0
            && u32_at(20) == SNAPSHOT
            && u32_at(36) == 14 =>
        {
            let raw = unsafe { std::slice::from_raw_parts(p.add(40), 256) };
            let title =
                String::from_utf8_lossy(&raw[..raw.iter().position(|x| *x == 0).unwrap_or(256)])
                    .trim()
                    .to_string();
            let mut values = [0.0; 13];
            for (i, v) in values.iter_mut().enumerate() {
                *v = unsafe { ptr::read_unaligned(p.add(40 + 256 + i * 8) as *const f64) };
            }
            let snapshot = Snapshot {
                title,
                values,
                at: Instant::now(),
            };
            if u32_at(12) == SNAPSHOT {
                inbox.snapshot = Some(snapshot);
            } else {
                inbox.freeze_readback = Some(snapshot);
            }
        }
        _ => (),
    }
}

struct Connection {
    api: SimConnectApi,
    handle: Handle,
    inbox: Box<Inbox>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        unsafe {
            (self.api.close)(self.handle);
        }
    }
}
fn check(hr: Hresult) -> Result<(), String> {
    if hresult_succeeded(hr) {
        Ok(())
    } else {
        Err(format!("SimConnect call failed: 0x{hr:08x}"))
    }
}
impl Connection {
    fn open() -> Result<Self, String> {
        let api = SimConnectApi::load()?;
        let mut handle = ptr::null_mut();
        let name = CString::new("FlightFabric Dedicated Replay Proof").unwrap();
        check(unsafe {
            (api.open)(
                &mut handle,
                name.as_ptr(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                0,
            )
        })?;
        let c = Self {
            api,
            handle,
            inbox: Box::new(Inbox {
                snapshot: None,
                freeze_request: None,
                freeze_readback: None,
                frame: false,
                speed: 0.0,
                sim: false,
                paused: true,
                loaded: 0,
                changed: 0,
                fault: None,
            }),
        };
        for (id, name) in [
            (FRAME, "Frame"),
            (SIM_START, "SimStart"),
            (SIM_STOP, "SimStop"),
            (FLIGHT_LOADED, "FlightLoaded"),
            (AIRCRAFT_LOADED, "AircraftLoaded"),
            (PAUSE, "Pause_EX1"),
        ] {
            let name = CString::new(name).unwrap();
            check(unsafe { (c.api.subscribe_to_system_event)(c.handle, id, name.as_ptr()) })?;
        }
        let sim = CString::new("Sim").unwrap();
        check(unsafe { (c.api.request_system_state)(c.handle, SIM_START, sim.as_ptr()) })?;
        c.define(SNAPSHOT, "TITLE", "", SIMCONNECT_DATATYPE_STRING256)?;
        for (name, unit) in [
            ("IS LATITUDE LONGITUDE FREEZE ON", "Bool"),
            ("IS ALTITUDE FREEZE ON", "Bool"),
            ("IS ATTITUDE FREEZE ON", "Bool"),
            ("SIM ON GROUND", "Bool"),
            ("GROUND VELOCITY", "knots"),
            ("CAMERA STATE", "Enum"),
            ("IS SLEW ACTIVE", "Bool"),
            ("CRASH FLAG", "Bool"),
            ("CRASH SEQUENCE", "Enum"),
            ("GENERAL ENG COMBUSTION:1", "Bool"),
            ("GENERAL ENG COMBUSTION:2", "Bool"),
            ("GENERAL ENG COMBUSTION:3", "Bool"),
            ("GENERAL ENG COMBUSTION:4", "Bool"),
        ] {
            c.define(SNAPSHOT, name, unit, SIMCONNECT_DATATYPE_FLOAT64)?;
        }
        // VISUAL_FRAME keeps state/recovery observable independently of the
        // replay clock. This does not change the telemetry bridge's cadence.
        check(unsafe {
            (c.api.request_data_on_sim_object)(c.handle, SNAPSHOT, SNAPSHOT, 0, 2, 0, 0, 0, 0)
        })?;
        for (name, unit) in [
            ("PLANE LATITUDE", "degrees"),
            ("PLANE LONGITUDE", "degrees"),
            ("PLANE ALTITUDE", "feet"),
            ("PLANE PITCH DEGREES", "degrees"),
            ("PLANE BANK DEGREES", "degrees"),
            ("PLANE HEADING DEGREES TRUE", "degrees"),
        ] {
            c.define(POSE, name, unit, SIMCONNECT_DATATYPE_FLOAT64)?;
        }
        for (i, name) in [
            "FREEZE_LATITUDE_LONGITUDE_SET",
            "FREEZE_ALTITUDE_SET",
            "FREEZE_ATTITUDE_SET",
        ]
        .iter()
        .enumerate()
        {
            let name = CString::new(*name).unwrap();
            check(unsafe {
                (c.api.map_client_event_to_sim_event)(c.handle, FREEZE + i as u32, name.as_ptr())
            })?;
        }
        Ok(c)
    }
    fn define(&self, id: u32, name: &str, unit: &str, datatype: u32) -> Result<(), String> {
        let name = CString::new(name).unwrap();
        let unit = CString::new(unit).unwrap();
        check(unsafe {
            (self.api.add_to_data_definition)(
                self.handle,
                id,
                name.as_ptr(),
                unit.as_ptr(),
                datatype,
                0.0,
                SIMCONNECT_UNUSED,
            )
        })
    }
    fn poll(&mut self) -> Result<(), String> {
        check(unsafe {
            (self.api.call_dispatch)(
                self.handle,
                dispatch,
                self.inbox.as_mut() as *mut Inbox as *mut c_void,
            )
        })?;
        if let Some(error) = self.inbox.fault.take() {
            Err(error)
        } else {
            Ok(())
        }
    }
    fn freeze(&mut self, states: [bool; 3]) -> Result<(), String> {
        for (i, state) in states.iter().enumerate() {
            check(unsafe {
                (self.api.transmit_client_event)(
                    self.handle,
                    0,
                    FREEZE + i as u32,
                    u32::from(*state),
                    SIMCONNECT_GROUP_PRIORITY_HIGHEST,
                    SIMCONNECT_EVENT_FLAG_GROUPID_IS_PRIORITY,
                )
            })?;
        }
        self.inbox.freeze_request = Some(
            self.inbox
                .freeze_request
                .unwrap_or(1000)
                .checked_add(1)
                .ok_or("Replay freeze request limit reached")?,
        );
        self.inbox.freeze_readback = None;
        self.request_freeze_readback()
    }
    fn request_freeze_readback(&self) -> Result<(), String> {
        let request = self
            .inbox
            .freeze_request
            .ok_or("No freeze transaction is pending")?;
        // A streaming sample delivered after the write can have been queued
        // before it. Only a separately identified post-write ONCE request can
        // acknowledge this transaction. Poll it until the events take effect.
        check(unsafe {
            (self.api.request_data_on_sim_object)(
                self.handle,
                request,
                SNAPSHOT,
                0,
                SIMCONNECT_PERIOD_ONCE,
                0,
                0,
                0,
                0,
            )
        })
    }
    fn pose(&self, s: &Sample) -> Result<(), String> {
        let values = [
            s.latitude_deg,
            s.longitude_deg,
            s.altitude_ft,
            -s.pitch_deg,
            -s.bank_deg,
            s.heading_deg,
        ];
        // INITPOSITION must not be used per frame on the user aircraft; it
        // reinitializes scenery. Write only the six explicit pose variables.
        check(unsafe {
            (self.api.set_data_on_sim_object)(
                self.handle,
                POSE,
                0,
                0,
                1,
                48,
                values.as_ptr() as *const c_void,
            )
        })
    }
}

fn read_command(reader: &mut impl BufRead) -> Result<Option<ReplayCommand>, String> {
    let mut bytes = Vec::new();
    // Stop on the first byte beyond the bound. Draining an arbitrarily long
    // unterminated line would keep a malformed controller alive indefinitely.
    reader.take(1025).read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
    if bytes.is_empty() { return Ok(None); }
    if bytes.len() > 1024 { return Err("Replay command exceeds its size limit".into()); }
    serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("Invalid replay command: {e}"))
}

fn commands() -> Receiver<Result<ReplayCommand, String>> {
    let (tx, rx) = mpsc::sync_channel(16);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = stdin.lock();
        loop {
            let parsed = match read_command(&mut reader) {
                Ok(Some(command)) => Ok(command),
                Ok(None) => break,
                Err(error) => Err(error),
            };
            let malformed = parsed.is_err();
            if tx.send(parsed).is_err() || malformed {
                break;
            }
        }
    });
    rx
}
fn read_json<T: serde::de::DeserializeOwned>(
    path: &std::path::Path,
    max: u64,
) -> Result<T, String> {
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(max + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > max {
        return Err("Replay file exceeds its size limit".into());
    }
    serde_json::from_slice(&data).map_err(|e| e.to_string())
}
fn report(output: &ReplayOutput, session: &str, state: ReplayPhase, position: f64, detail: &str) {
    output.send(
        json!({"type":"replayStatus","session":session,"state":state,"positionMs":position,"detail":detail}),
    );
}
fn option<'a>(args: &'a [String], prefix: &str) -> Option<&'a str> {
    args.iter().find_map(|a| a.strip_prefix(prefix))
}

pub(crate) fn validate_file(path: &str) -> Result<(), String> {
    let clip: Clip = read_json(std::path::Path::new(path), 512 * 1024)?;
    clip.validate()?;
    crate::emit_value(
        json!({"ok":true,"samples":clip.samples.len(),"durationMs":clip.duration_ms}),
    );
    Ok(())
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| {
        matches!(
            a.as_str(),
            "--probe"
                | "--connection-probe"
                | "--simvars-bridge"
                | "--sdk-clientdata-bridge"
                | "--process-guardian"
        )
    }) {
        return Err("Dedicated replay cannot be combined with another sidecar mode".into());
    }
    let _lease = crate::replay_exclusion::acquire(true)?;
    let recover = args.iter().any(|a| a == "--replay-recover");
    let journal_path = crate::replay_exclusion::journal_path()?;
    let mut journal: Option<Journal> = if recover {
        Some(read_json(&journal_path, 4096)?)
    } else {
        None
    };
    if !recover && journal_path.try_exists().map_err(|e| e.to_string())? {
        return Err("An earlier replay needs --recover before another replay can start".into());
    }
    let clip: Option<Clip> = if recover {
        None
    } else {
        let path = option(args, "--replay-clip=").ok_or("Replay requires an absolute clip path")?;
        if !std::path::Path::new(path).is_absolute() {
            return Err("Replay clip path must be absolute".into());
        }
        let clip: Clip = read_json(std::path::Path::new(path), 512 * 1024)?;
        clip.validate()?;
        Some(clip)
    };
    let session = option(args, "--replay-session=")
        .ok_or("Replay session identity is required")?
        .to_string();
    if session.is_empty() || session.len() > 64 {
        return Err("Invalid replay session identity".into());
    }
    if let Some(j) = &journal {
        if j.version != 1 || j.title.is_empty() || j.title.len() > 255 {
            return Err(
                "Invalid recovery journal; simulator recovery must be inspected manually".into(),
            );
        }
    }
    let title = clip
        .as_ref()
        .map(|c| c.title.clone())
        .unwrap_or_else(|| journal.as_ref().unwrap().title.clone());
    let mut c = Connection::open()?;
    let output = ReplayOutput::stdout();
    let rx = commands();
    let mut controller_lost = false;
    let mut lifecycle = ReplayLifecycle::new(recover, c.inbox.loaded, Instant::now());
    let mut position = 0.0;
    let mut last_tick = Instant::now();
    let mut last_status = Instant::now();
    let mut last_request = 0;
    let started = Instant::now();
    let mut entry_gate = ParkedGate::default();
    let mut last_freeze_readback = Instant::now();
    report(
        &output,
        &session,
        lifecycle.phase(),
        position,
        if recover {
            "Reload the matching aircraft into a parked, engines-off flight"
        } else {
            "Motion proof only. Park with engines off, then send start. Native camera controls remain available."
        },
    );
    loop {
        if let Err(error) = c.poll() {
            // No reconnect-and-write: the journal and exclusion remain the
            // authoritative recovery barrier. The next invocation is read-only
            // until it observes a new matching parked flight load.
            report(&output, &session, ReplayPhase::RecoveryRequired, position, &error);
            return Err(error);
        }
        let snapshot = c.inbox.snapshot.as_ref();
        let valid = c.inbox.sim
            && !c.inbox.paused
            && (c.inbox.speed - 1.0).abs() < 0.001
            && snapshot.as_ref().is_some_and(|s| s.valid(&title));
        let parked = valid && snapshot.as_ref().is_some_and(|s| s.parked());
        let freeze_flags = snapshot.map(Snapshot::freezes);
        let entry_ready = entry_gate.observe(
            started.elapsed().as_secs_f64() * 1000.0,
            c.inbox.changed,
            parked,
        );
        for _ in 0..16 {
            if controller_lost || output.failed() { break; }
            let cmd = match rx.try_recv() {
                Ok(Ok(cmd)) => cmd,
                Ok(Err(error)) => {
                    report(&output, &session, lifecycle.phase(), position, &error);
                    controller_lost = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    controller_lost = true;
                    break;
                }
            };
            let result: Result<(), String> = (|| {
                if cmd.session != session || cmd.request_id <= last_request {
                    return Err("Stale replay session or request".into());
                }
                last_request = cmd.request_id;
                match cmd.kind.as_str() {
                    "start" if lifecycle.phase() == ReplayPhase::Ready && entry_ready => {
                        let j = Journal {
                            version: 1,
                            session: session.clone(),
                            title: title.clone(),
                            freeze: freeze_flags.unwrap(),
                        };
                        replay_journal::save(&j)?;
                        journal = Some(j);
                        lifecycle.arm(c.inbox.loaded, c.inbox.changed, Instant::now());
                        c.freeze([true; 3])?;
                    }
                    "play" if lifecycle.phase() == ReplayPhase::Paused && valid => {
                        lifecycle.play();
                        last_tick = Instant::now();
                    }
                    "pause" if lifecycle.phase() == ReplayPhase::Playing => { lifecycle.hold(); }
                    "seek" if lifecycle.writes_pose() && valid => {
                        let target = cmd.position_ms.filter(|v| {
                            v.is_finite() && *v >= 0.0 && *v <= clip.as_ref().unwrap().duration_ms
                        })
                            .ok_or("Seek position is outside the clip")?;
                        position = target;
                        lifecycle.hold();
                    }
                    "stop" if lifecycle.recovering() => {}
                    "stop" => {
                        if journal.is_none() { lifecycle.finish(); }
                        else {
                            lifecycle.enter_recovery(Instant::now());
                        }
                    }
                    _ => return Err("Command unavailable: start requires the exact aircraft parked with engines off at 1x for three seconds".into()),
                }
                Ok(())
            })();
            output.send(
                json!({"type":"replayAck","session":session,"requestId":cmd.request_id,
                "ok":result.is_ok(),"state":lifecycle.phase(),"error":result.err()}),
            );
        }
        controller_lost |= output.failed();
        if controller_lost {
            if journal.is_none() { return Ok(()); }
            if !lifecycle.recovering() {
                lifecycle.enter_recovery(Instant::now());
                report(&output, &session, lifecycle.phase(), position,
                    "Controller disconnected or transport failed. Reload a matching parked flight; recovery continues independently.");
            }
        }
        if lifecycle.phase() == ReplayPhase::Done {
            return Ok(());
        }
        if lifecycle.controls_aircraft() {
            let lost_freeze =
                lifecycle.phase() != ReplayPhase::Arming && freeze_flags.is_some_and(|f| f != [true; 3]);
            if !valid
                || !lifecycle.same_acquisition(c.inbox.changed)
                || lost_freeze
                || (lifecycle.phase() == ReplayPhase::Arming && lifecycle.since().elapsed() > Duration::from_secs(3))
            {
                if valid && lifecycle.same_acquisition(c.inbox.changed) && lost_freeze {
                    // An external freeze toggle must not release an airborne
                    // replay frame. Reassert only for the verified same target.
                    c.freeze([true; 3])?;
                }
                lifecycle.enter_recovery(Instant::now());
                report(&output,&session,lifecycle.phase(),position,"Replay stopped because identity, session, clock or freeze readback changed. Reload a matching parked flight.");
            } else if lifecycle.phase() == ReplayPhase::Arming
                && c.inbox.snapshot
                    .as_ref()
                    .is_some_and(|s| s.freezes() == [true; 3] && s.at > lifecycle.since())
                && c.inbox
                    .freeze_readback
                    .as_ref()
                    .is_some_and(|s| s.valid(&title) && s.freezes() == [true; 3])
            {
                lifecycle.hold();
                report(&output,&session,lifecycle.phase(),position,"Freeze confirmed. Use play, pause, seek or stop; camera movement is independent.");
            }
        }
        if c.inbox.frame {
            c.inbox.frame = false;
            let now = Instant::now();
            let elapsed = now.duration_since(last_tick);
            last_tick = now;
            if lifecycle.phase() == ReplayPhase::Playing {
                let (next, playing) = advance(
                    position,
                    elapsed.as_secs_f64() * 1000.0,
                    clip.as_ref().unwrap().duration_ms,
                );
                position = next;
                if !playing {
                    lifecycle.hold();
                    report(
                        &output,
                        &session,
                        lifecycle.phase(),
                        position,
                        "Playback held at the end or after a frame gap.",
                    );
                }
            }
            if lifecycle.writes_pose() && valid {
                if let Err(e) = c.pose(&clip.as_ref().unwrap().sample(position)) {
                    lifecycle.enter_recovery(Instant::now());
                    report(&output, &session, lifecycle.phase(), position, &e);
                }
            }
        }
        if lifecycle.phase() == ReplayPhase::Recovery {
            if lifecycle.reload_ready(
                started.elapsed().as_secs_f64() * 1000.0,
                c.inbox.loaded,
                c.inbox.changed,
                parked,
            ) {
                c.freeze(journal.as_ref().unwrap().freeze)?;
                lifecycle.restoring(c.inbox.changed, Instant::now());
            }
        }
        if lifecycle.phase() == ReplayPhase::Restoring {
            if !parked || !lifecycle.same_restoration(c.inbox.changed) {
                lifecycle.require_new_reload(c.inbox.loaded, Instant::now());
            } else if c.inbox.freeze_readback.as_ref().is_some_and(|s| {
                s.valid(&title)
                    && s.parked()
                    && s.at > lifecycle.since()
                    && s.freezes() == journal.as_ref().unwrap().freeze
            }) {
                fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
                report(
                    &output,
                    &session,
                    ReplayPhase::Done,
                    position,
                    "Reload confirmed; original freeze flags restored. FlightFabric may reconnect.",
                );
                return Ok(());
            } else if lifecycle.since().elapsed() > Duration::from_secs(3) {
                return Err(
                    "Freeze restoration was not acknowledged; replay recovery remains required"
                        .into(),
                );
            }
        }
        if lifecycle.waiting_for_freeze()
            && last_freeze_readback.elapsed() >= Duration::from_millis(100)
        {
            c.request_freeze_readback()?;
            last_freeze_readback = Instant::now();
        }
        if last_status.elapsed() > Duration::from_millis(500) {
            report(
                &output,
                &session,
                lifecycle.phase(),
                position,
                if lifecycle.phase() == ReplayPhase::Recovery {
                    "Reload the matching aircraft parked with engines off. Do not resume flight from a replay frame."
                } else {
                    ""
                },
            );
            last_status = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_parsing_bounds_unterminated_input_and_rejects_invalid_utf8() {
        let mut oversized = io::Cursor::new(vec![b' '; 8192]);
        assert!(read_command(&mut oversized).unwrap_err().contains("size limit"));
        assert_eq!(oversized.position(), 1025, "must not drain an unbounded line");
        assert!(read_command(&mut io::Cursor::new(b"{\"session\":\"\xff\"}" )).is_err());
        let mut valid = io::Cursor::new(b"{\"type\":\"stop\",\"session\":\"s\",\"requestId\":1}\n");
        assert_eq!(read_command(&mut valid).unwrap().unwrap().kind, "stop");
        assert!(read_command(&mut valid).unwrap().is_none());
    }
    #[test]
    fn free_camera_is_allowed_but_menu_unknown_stale_and_wrong_identity_are_not() {
        let mut s = Snapshot {
            title: "FenixA320 CFM SL".into(),
            values: [0.0; 13],
            at: Instant::now(),
        };
        s.values[3] = 1.0;
        for camera in (2..=9).chain([16, 17]) {
            s.values[5] = camera as f64;
            assert!(s.valid("FenixA320 CFM SL"));
        }
        s.values[5] = 10.0;
        assert!(!s.valid("FenixA320 CFM SL"));
        s.values[5] = 8.0;
        assert!(!s.valid("Airbus A320"));
        s.at = Instant::now() - Duration::from_secs(1);
        assert!(!s.valid("FenixA320 CFM SL"));
    }
    #[test]
    fn recovery_requires_stopped_engines_and_no_ground_motion() {
        let mut s = Snapshot {
            title: "x".into(),
            values: [0.0; 13],
            at: Instant::now(),
        };
        assert!(!s.parked());
        s.values[3] = 1.0;
        assert!(s.parked());
        s.values[9] = 1.0;
        assert!(!s.parked());
        s.values[9] = 0.0;
        s.values[4] = 2.0;
        assert!(!s.parked());
    }
    #[test]
    fn truncated_native_messages_are_ignored() {
        let mut inbox = Inbox {
            snapshot: None,
            freeze_request: None,
            freeze_readback: None,
            frame: false,
            speed: 0.0,
            sim: false,
            paused: true,
            loaded: 0,
            changed: 0,
            fault: None,
        };
        let mut bytes = [0u8; 48];
        bytes[0..4].copy_from_slice(&48u32.to_ne_bytes());
        bytes[8..12].copy_from_slice(&8u32.to_ne_bytes());
        unsafe {
            dispatch(
                bytes.as_mut_ptr() as *mut SimConnectRecv,
                48,
                &mut inbox as *mut Inbox as *mut c_void,
            );
        }
        assert!(inbox.snapshot.is_none());
    }
    #[test]
    fn only_the_current_post_write_request_can_acknowledge_freeze_changes() {
        let mut inbox = Inbox {
            snapshot: None,
            freeze_request: Some(1002),
            freeze_readback: None,
            frame: false,
            speed: 1.0,
            sim: true,
            paused: false,
            loaded: 0,
            changed: 0,
            fault: None,
        };
        let mut bytes = vec![0u8; 40 + 256 + 13 * 8];
        let length = bytes.len() as u32;
        for (offset, value) in [
            (0, length),
            (8, 8),
            (12, SNAPSHOT),
            (20, SNAPSHOT),
            (36, 14),
        ] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_ne_bytes());
        }
        bytes[40..45].copy_from_slice(b"Fenix");
        for request in [SNAPSHOT, 1001, 1002] {
            bytes[12..16].copy_from_slice(&request.to_ne_bytes());
            unsafe {
                dispatch(
                    bytes.as_mut_ptr() as *mut SimConnectRecv,
                    length,
                    &mut inbox as *mut Inbox as *mut c_void,
                );
            }
            assert_eq!(
                inbox.freeze_readback.is_some(),
                request == 1002,
                "streaming or previous-transaction responses must not acknowledge restoration"
            );
        }
        assert_eq!(inbox.freeze_readback.unwrap().title, "Fenix");
    }
}
