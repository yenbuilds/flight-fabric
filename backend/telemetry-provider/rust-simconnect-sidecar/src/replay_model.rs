//! Bounded, simulator-independent replay contract and interpolation.
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sample {
    pub time_ms: f64,
    pub source_timestamp_ms: f64,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub altitude_ft: f64,
    pub pitch_deg: f64,
    pub bank_deg: f64,
    pub heading_deg: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Clip {
    pub version: u32,
    pub title: String,
    pub profile_id: String,
    pub duration_ms: f64,
    pub samples: Vec<Sample>,
}

impl Clip {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.title.trim().is_empty()
            || self.title.len() > 255
            || self.title.as_bytes().contains(&0)
            || !matches!(self.profile_id.as_str(), "pmdg-737" | "fenix-a320")
            || !(2..=1300).contains(&self.samples.len())
            || !self.duration_ms.is_finite()
            || self.duration_ms <= 0.0
            || self.duration_ms > 120_000.0
        {
            return Err("Invalid replay clip identity or bounds".into());
        }
        let mut previous: Option<&Sample> = None;
        for s in &self.samples {
            if ![
                s.time_ms,
                s.source_timestamp_ms,
                s.latitude_deg,
                s.longitude_deg,
                s.altitude_ft,
                s.pitch_deg,
                s.bank_deg,
                s.heading_deg,
            ]
            .iter()
            .all(|v| v.is_finite())
                || s.latitude_deg.abs() > 90.0
                || s.longitude_deg.abs() > 180.0
                || s.pitch_deg.abs() > 90.0
                || s.bank_deg.abs() > 180.0
                || !(0.0..=360.0).contains(&s.heading_deg)
                || !(-2000.0..=65000.0).contains(&s.altitude_ft)
            {
                return Err("Invalid replay sample".into());
            }
            if let Some(p) = previous {
                let dt = s.time_ms - p.time_ms;
                if dt <= 0.0
                    || dt > 2500.0
                    || s.source_timestamp_ms <= p.source_timestamp_ms
                    || ((s.source_timestamp_ms - p.source_timestamp_ms) - dt).abs() > 5.0
                {
                    return Err("Discontinuous replay clock".into());
                }
                // Reject teleports even when timestamps look continuous.
                let north = (s.latitude_deg - p.latitude_deg) * 111_320.0;
                let east = angle_delta(p.longitude_deg, s.longitude_deg)
                    * 111_320.0
                    * s.latitude_deg.to_radians().cos();
                if north.hypot(east) / (dt / 1000.0) > 400.0
                    || (s.altitude_ft - p.altitude_ft).abs() / (dt / 1000.0) > 250.0
                {
                    return Err("Implausible replay motion; clip may contain a teleport".into());
                }
            } else if s.time_ms != 0.0 {
                return Err("Replay must start at zero".into());
            }
            previous = Some(s);
        }
        if self.samples.last().unwrap().time_ms != self.duration_ms {
            return Err("Replay duration mismatch".into());
        }
        Ok(())
    }

    pub fn sample(&self, time: f64) -> Sample {
        let t = time.clamp(0.0, self.duration_ms);
        let next = self.samples.partition_point(|s| s.time_ms <= t);
        if next == 0 {
            return self.samples[0].clone();
        }
        if next == self.samples.len() {
            return self.samples[next - 1].clone();
        }
        let a = &self.samples[next - 1];
        let b = &self.samples[next];
        let alpha = (t - a.time_ms) / (b.time_ms - a.time_ms);
        let linear = |x: f64, y: f64| x + (y - x) * alpha;
        Sample {
            time_ms: t,
            source_timestamp_ms: linear(a.source_timestamp_ms, b.source_timestamp_ms),
            latitude_deg: linear(a.latitude_deg, b.latitude_deg),
            longitude_deg: (a.longitude_deg
                + angle_delta(a.longitude_deg, b.longitude_deg) * alpha
                + 180.0)
                .rem_euclid(360.0)
                - 180.0,
            altitude_ft: linear(a.altitude_ft, b.altitude_ft),
            pitch_deg: linear(a.pitch_deg, b.pitch_deg),
            bank_deg: (a.bank_deg + angle_delta(a.bank_deg, b.bank_deg) * alpha + 180.0)
                .rem_euclid(360.0)
                - 180.0,
            heading_deg: (a.heading_deg + angle_delta(a.heading_deg, b.heading_deg) * alpha)
                .rem_euclid(360.0),
        }
    }
}

fn angle_delta(a: f64, b: f64) -> f64 {
    (b - a + 180.0).rem_euclid(360.0) - 180.0
}

/// The caller supplies elapsed monotonic time between visual frames. Never
/// catch up over a stalled frame by teleporting forward along the recording.
pub(crate) fn advance(position: f64, elapsed_ms: f64, duration: f64) -> (f64, bool) {
    if !elapsed_ms.is_finite() || !(0.0..=250.0).contains(&elapsed_ms) {
        return (position, false);
    }
    let next = (position + elapsed_ms).min(duration);
    (next, next < duration)
}

/// Continuous parked readbacks in the same simulator generation.
#[derive(Default)]
pub(crate) struct ParkedGate {
    stable_since: Option<f64>,
    generation: Option<u64>,
}
impl ParkedGate {
    pub fn observe(&mut self, now_ms: f64, changed: u64, parked: bool) -> bool {
        if !parked || self.generation != Some(changed) {
            self.stable_since = None;
            self.generation = Some(changed);
        }
        if !parked {
            return false;
        }
        let since = *self.stable_since.get_or_insert(now_ms);
        now_ms - since >= 3000.0
    }
}

/// Recovery adds the requirement for a new flight load to the shared parked
/// stability gate. Entry uses ParkedGate directly, without fictitious load IDs.
#[derive(Default)]
pub(crate) struct ReloadGate(ParkedGate);
impl ReloadGate {
    pub fn observe(&mut self, now_ms: f64, loaded: u64, after: u64, changed: u64, parked: bool) -> bool {
        self.0.observe(now_ms, changed, parked && loaded > after)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplayCommand {
    pub session: String,
    pub request_id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub position_ms: Option<f64>,
}

/// Keep the load baseline from control acquisition, so a load that *causes*
/// recovery counts as the requested reload. Fence the restoration readback to
/// the same simulator generation that authorized its freeze writes.
pub(crate) struct ReloadRecovery {
    after_loaded: u64,
    gate: ReloadGate,
    restoring_generation: Option<u64>,
}
impl ReloadRecovery {
    pub fn new(loaded: u64) -> Self {
        Self {
            after_loaded: loaded,
            gate: ReloadGate::default(),
            restoring_generation: None,
        }
    }
    pub fn interrupt(&mut self) {
        self.gate = ReloadGate::default();
        self.restoring_generation = None;
    }
    pub fn observe(&mut self, now: f64, loaded: u64, changed: u64, parked: bool) -> bool {
        self.gate
            .observe(now, loaded, self.after_loaded, changed, parked)
    }
    pub fn restoring(&mut self, generation: u64) {
        self.restoring_generation = Some(generation);
    }
    pub fn same_generation(&self, generation: u64) -> bool {
        self.restoring_generation == Some(generation)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReplayPhase {
    Ready, Arming, Paused, Playing, Recovery, Restoring, Done, RecoveryRequired,
}

/// Own the fields that must change together when replay acquires control or
/// enters recovery. The adapter owns simulator I/O; this model owns lifecycle.
pub(crate) struct ReplayLifecycle {
    phase: ReplayPhase,
    since: Instant,
    acquired_generation: Option<u64>,
    recovery: ReloadRecovery,
}
impl ReplayLifecycle {
    pub fn new(recover: bool, loaded: u64, now: Instant) -> Self {
        Self { phase: if recover { ReplayPhase::Recovery } else { ReplayPhase::Ready },
            since: now, acquired_generation: None, recovery: ReloadRecovery::new(loaded) }
    }
    pub fn phase(&self) -> ReplayPhase { self.phase }
    pub fn since(&self) -> Instant { self.since }
    pub fn controls_aircraft(&self) -> bool {
        matches!(self.phase, ReplayPhase::Arming | ReplayPhase::Paused | ReplayPhase::Playing)
    }
    pub fn writes_pose(&self) -> bool {
        matches!(self.phase, ReplayPhase::Paused | ReplayPhase::Playing)
    }
    pub fn recovering(&self) -> bool {
        matches!(self.phase, ReplayPhase::Recovery | ReplayPhase::Restoring)
    }
    pub fn waiting_for_freeze(&self) -> bool {
        matches!(self.phase, ReplayPhase::Arming | ReplayPhase::Restoring)
    }
    pub fn same_acquisition(&self, generation: u64) -> bool {
        self.acquired_generation == Some(generation)
    }
    pub fn arm(&mut self, loaded: u64, generation: u64, now: Instant) {
        self.phase = ReplayPhase::Arming;
        self.since = now;
        self.acquired_generation = Some(generation);
        self.recovery = ReloadRecovery::new(loaded);
    }
    pub fn play(&mut self) { self.phase = ReplayPhase::Playing; }
    pub fn hold(&mut self) { self.phase = ReplayPhase::Paused; }
    pub fn finish(&mut self) { self.phase = ReplayPhase::Done; }
    pub fn enter_recovery(&mut self, now: Instant) {
        self.phase = ReplayPhase::Recovery;
        self.since = now;
        self.recovery.interrupt();
    }
    pub fn reload_ready(&mut self, now_ms: f64, loaded: u64, generation: u64, parked: bool) -> bool {
        self.recovery.observe(now_ms, loaded, generation, parked)
    }
    pub fn restoring(&mut self, generation: u64, now: Instant) {
        self.phase = ReplayPhase::Restoring;
        self.since = now;
        self.recovery.restoring(generation);
    }
    pub fn same_restoration(&self, generation: u64) -> bool {
        self.recovery.same_generation(generation)
    }
    pub fn require_new_reload(&mut self, loaded: u64, now: Instant) {
        self.enter_recovery(now);
        self.recovery = ReloadRecovery::new(loaded);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn clip() -> Clip {
        let a = Sample {
            time_ms: 0.0,
            source_timestamp_ms: 1000.0,
            latitude_deg: 0.0,
            longitude_deg: 179.999,
            altitude_ft: 100.0,
            pitch_deg: 2.0,
            bank_deg: 1.0,
            heading_deg: 359.0,
        };
        let b = Sample {
            time_ms: 1000.0,
            source_timestamp_ms: 2000.0,
            longitude_deg: -179.999,
            altitude_ft: 90.0,
            heading_deg: 1.0,
            ..a.clone()
        };
        Clip {
            version: 1,
            title: "PMDG exact variant".into(),
            profile_id: "pmdg-737".into(),
            duration_ms: 1000.0,
            samples: vec![a, b],
        }
    }
    #[test]
    fn wraps_heading_and_dateline_without_smoothing_vertical_motion() {
        let c = clip();
        c.validate().unwrap();
        let s = c.sample(500.0);
        assert_eq!(s.heading_deg, 0.0);
        assert_eq!(s.longitude_deg, -180.0);
        assert_eq!(s.altitude_ft, 95.0);
        assert_eq!(s.source_timestamp_ms, 1500.0);
        assert_eq!(c.sample(2000.0).time_ms, 1000.0);
    }
    #[test]
    fn rejects_missing_time_gaps_and_teleports() {
        let mut c = clip();
        c.samples[1].time_ms = 0.0;
        assert!(c.validate().is_err());
        c = clip();
        c.samples[1].time_ms = 3000.0;
        assert!(c.validate().is_err());
        c = clip();
        c.samples[1].latitude_deg = 1.0;
        assert!(c.validate().is_err());
        c = clip();
        c.samples[0].altitude_ft = f64::NAN;
        assert!(c.validate().is_err());
    }
    #[test]
    fn controls_reject_unknown_fields_and_non_numeric_seek() {
        assert!(serde_json::from_str::<ReplayCommand>(
            r#"{"session":"s","requestId":1,"type":"seek","positionMs":"2"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<ReplayCommand>(
            r#"{"session":"s","requestId":1,"type":"play","speed":2}"#
        )
        .is_err());
    }
    #[test]
    fn playback_holds_after_stalls_and_at_the_end() {
        assert_eq!(advance(20.0, 16.0, 100.0), (36.0, true));
        assert_eq!(advance(20.0, 251.0, 100.0), (20.0, false));
        assert_eq!(advance(20.0, 100.0, 100.0), (100.0, false));
        assert_eq!(advance(20.0, f64::NAN, 100.0), (20.0, false));
    }
    #[test]
    fn recovery_requires_new_load_and_three_continuous_parked_seconds() {
        let mut gate = ReloadGate::default();
        assert!(!gate.observe(0.0, 1, 1, 1, true));
        assert!(!gate.observe(9999.0, 1, 1, 1, true));
        assert!(!gate.observe(10000.0, 2, 1, 2, true));
        assert!(!gate.observe(12999.0, 2, 1, 2, true));
        assert!(gate.observe(13000.0, 2, 1, 2, true));
        assert!(!gate.observe(14000.0, 2, 1, 2, false));
        assert!(!gate.observe(20000.0, 2, 1, 2, true));
        assert!(!gate.observe(23000.0, 3, 1, 3, true));
        assert!(gate.observe(26000.0, 3, 1, 3, true));
    }
    #[test]
    fn reload_during_playback_counts_without_requiring_a_second_reload() {
        let mut recovery = ReloadRecovery::new(7); // Flight that replay acquired.
        assert!(!recovery.observe(0.0, 7, 12, true));
        recovery.interrupt(); // FlightLoaded 8 caused the playback interruption.
        assert!(!recovery.observe(1000.0, 8, 13, true));
        assert!(recovery.observe(4000.0, 8, 13, true));
        recovery.restoring(13);
        assert!(recovery.same_generation(13));
        assert!(
            !recovery.same_generation(14),
            "a second load cannot acknowledge the first restoration"
        );
    }
    #[test]
    fn source_time_cannot_reverse_inside_clock_tolerance() {
        let mut c = clip();
        c.duration_ms = 1.0;
        c.samples[1] = Sample {
            time_ms: 1.0,
            source_timestamp_ms: 999.0,
            ..c.samples[0].clone()
        };
        assert!(c.validate().is_err());
    }
    #[test]
    fn lifecycle_recovery_resets_timing_and_preserves_the_acquired_load_baseline() {
        use std::time::Duration;
        let now = Instant::now();
        let mut lifecycle = ReplayLifecycle::new(false, 7, now);
        assert_eq!(lifecycle.phase(), ReplayPhase::Ready);
        assert!(!lifecycle.writes_pose());
        lifecycle.arm(7, 12, now);
        assert!(lifecycle.controls_aircraft());
        assert!(lifecycle.waiting_for_freeze());
        assert!(lifecycle.same_acquisition(12));
        assert!(!lifecycle.same_acquisition(13));
        lifecycle.hold();
        assert!(lifecycle.writes_pose());
        lifecycle.play();
        let interrupted = now + Duration::from_secs(1);
        lifecycle.enter_recovery(interrupted);
        assert!(!lifecycle.writes_pose());
        assert!(!lifecycle.controls_aircraft());
        assert_eq!(lifecycle.since(), interrupted);
        assert!(!lifecycle.reload_ready(1000.0, 8, 13, true));
        assert!(lifecycle.reload_ready(4000.0, 8, 13, true));
        lifecycle.restoring(13, now + Duration::from_secs(4));
        assert!(lifecycle.same_restoration(13));
        assert!(!lifecycle.same_restoration(14));
        lifecycle.require_new_reload(9, now + Duration::from_secs(5));
        assert!(!lifecycle.same_restoration(13));
        assert!(!lifecycle.reload_ready(99999.0, 9, 14, true));
        assert!(!lifecycle.reload_ready(100000.0, 10, 15, true));
        assert!(lifecycle.reload_ready(103000.0, 10, 15, true));
        assert_eq!(serde_json::to_string(&ReplayPhase::RecoveryRequired).unwrap(), "\"recovery-required\"");
    }
    #[test]
    fn entry_parked_gate_does_not_need_a_fictitious_flight_load() {
        let mut gate = ParkedGate::default();
        assert!(!gate.observe(0.0, 7, true));
        assert!(gate.observe(3000.0, 7, true));
        assert!(!gate.observe(4000.0, 8, true));
        assert!(!gate.observe(5000.0, 8, false));
        assert!(!gate.observe(6000.0, 8, true));
        assert!(gate.observe(9000.0, 8, true));
    }
}
