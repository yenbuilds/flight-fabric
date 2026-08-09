/**
 * Schema Field Map - Single source of truth for V1 CSV field extraction
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * PURPOSE: Define HOW to extract each field from the frame object for V1 CSV.
 * This is the SINGLE SOURCE OF TRUTH for V1 flight data output.
 * 
 * ADDING A NEW FIELD:
 *   1. Add entry to FIELD_MAP below with extract function
 *   2. V1 CSV automatically picks it up (no other file edits needed!)
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const timeSource = require('../core/time-source') as TimeSourceModule;

type TimeSourceModule = {
  now: () => number;
};

type FrameRecord = Record<string, any>;
type Formatter = (value: unknown) => string;
type FieldDef = {
  name: string;
  extract: (frame: FrameRecord) => unknown;
  format: Formatter;
};
type FieldRow = Record<string, string>;

/**
 * Field definition with extraction logic.
 * @typedef {Object} FieldDef
 * @property {string} name - Column name
 * @property {function(Object): any} extract - How to get value from frame
 * @property {function(any): string} format - How to format for CSV
 */

// ═══════════════════════════════════════════════════════════════════════════
// Format helpers
// ═══════════════════════════════════════════════════════════════════════════

const fmt: Record<'str' | 'int' | 'real1' | 'real2' | 'real3' | 'real4' | 'real6' | 'bool' | 'json', Formatter> = {
  str: (v: unknown) => String(v ?? ''),
  json: (v: unknown) => {
    if (v == null || v === '') return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },
  int: (v: unknown) => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? String(Math.round(n)) : '';
  },
  real1: (v: unknown) => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(1) : '';
  },
  real2: (v: unknown) => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : '';
  },
  real3: (v: unknown) => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(3) : '';
  },
  real4: (v: unknown) => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(4) : '';
  },
  real6: (v: unknown) => {
    if (v == null || v === '') return '';
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(6) : '';
  },
  bool: (v: unknown) => v != null ? (v ? '1' : '0') : '',
};

const MAX_PLAUSIBLE_ILS_DEVIATION_DOTS = 3;

function plausibleIlsDeviationDots(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.abs(numeric) <= MAX_PLAUSIBLE_ILS_DEVIATION_DOTS ? numeric : null;
}

function coalescePlausibleIlsDeviationDots(...values: unknown[]): number | null {
  for (const value of values) {
    const plausible = plausibleIlsDeviationDots(value);
    if (plausible !== null) return plausible;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Field Definitions
// ═══════════════════════════════════════════════════════════════════════════
function assistValue(frame: FrameRecord, assistKey: string, flatKey: string): unknown {
  const assists = frame.assists;
  if (assists && typeof assists === 'object' && assistKey in assists) {
    return assists[assistKey];
  }
  return frame[flatKey];
}

const FIELD_MAP: FieldDef[] = [
  {
    name: "record_type",
    extract: (f) => f._recordType ?? 'SAMPLE',
    format: fmt.str,
  },
  {
    name: "sample_index",
    extract: (f) => f.sampleIndex ?? f.sample_index,
    format: fmt.int,
  },
  {
    name: "schema_version",
    extract: (f) => f.schemaVersion ?? f.schema_version ?? 3,
    format: fmt.int,
  },
  {
    name: "user_id",
    extract: (f) => f.userId ?? f.user_id,
    format: fmt.str,
  },
  {
    name: "session_id",
    extract: (f) => f.sessionId ?? f.session_id,
    format: fmt.str,
  },
  {
    name: "recording_session_id",
    extract: (f) => f.recordingSessionId ?? f.recording_session_id,
    format: fmt.str,
  },
  {
    name: "bundle_status_required",
    extract: (f) => f.bundleStatusRequired ?? f.bundle_status_required,
    format: fmt.bool,
  },
  {
    name: "ts",
    extract: (f) => f.timestampMs ?? f.timestamp_ms ?? f.ts ?? timeSource.now(),
    format: fmt.int,
  },
  {
    name: "timestamp_utc",
    extract: (f) => f.timestampIso ?? f.timestamp_utc ?? new Date(f.timestampMs ?? f.timestamp_ms ?? f.ts ?? timeSource.now()).toISOString(),
    format: fmt.str,
  },
  {
    name: "recorded_at_ms",
    extract: (f) => f.recordedAtMs ?? f.recorded_at_ms ?? f.timestampMs ?? f.timestamp_ms ?? f.ts ?? timeSource.now(),
    format: fmt.int,
  },
  {
    name: "recorded_at_utc",
    extract: (f) => f.recordedAtUtc ?? f.recorded_at_utc ?? f.timestampIso ?? f.timestamp_utc ?? new Date(f.timestampMs ?? f.timestamp_ms ?? f.ts ?? timeSource.now()).toISOString(),
    format: fmt.str,
  },
  {
    name: "flight_id",
    extract: (f) => f.flightId ?? f.flight_id,
    format: fmt.str,
  },
  {
    name: "flight_elapsed_ms",
    extract: (f) => f.flightElapsedMs ?? f.flight_elapsed_ms,
    format: fmt.int,
  },
  {
    name: "timestamp_monotonic",
    extract: (f) =>
      f.timestampMonotonic ??
      f.timestamp_monotonic ??
      f.flightElapsedMs ??
      f.flight_elapsed_ms,
    format: fmt.int,
  },
  {
    name: "sample_rate_hz",
    extract: (f) => f.sampleRateHz ?? f.sample_rate_hz,
    format: fmt.real2,
  },
  {
    name: "escalation_reason",
    extract: (f) => f.escalationReason ?? f.escalation_reason,
    format: fmt.str,
  },
  {
    name: "flight_phase_hint",
    extract: (f) => f.flightPhaseHint ?? f.flight_phase_hint ?? f.phase,
    format: fmt.str,
  },
  {
    name: "phase",
    extract: (f) => f.phase,
    format: fmt.str,
  },
  {
    name: "stability",
    extract: (f) => f.stability ?? null,
    format: fmt.str,
  },
  {
    name: "on_ground",
    extract: (f) => f.onGround ?? f.on_ground,
    format: fmt.bool,
  },
  {
    name: "sim_paused",
    extract: (f) => f.paused ?? f.sim_paused ?? false,
    format: fmt.bool,
  },
  {
    name: "sim_in_menu",
    extract: (f) => f.inMenu ?? f.sim_in_menu ?? false,
    format: fmt.bool,
  },
  {
    name: "attitude_valid",
    extract: (f) => f.attitudeValid ?? true,
    format: fmt.bool,
  },
  {
    name: "ias_kts",
    extract: (f) => f.ias ?? f.ias_kts,
    format: fmt.real1,
  },
  {
    name: "tas_kts",
    extract: (f) => f.tas ?? f.fdm?.tasKts,
    format: fmt.real1,
  },
  {
    name: "gs_kts",
    extract: (f) => f.gs ?? f.gs_kts,
    format: fmt.real1,
  },
  {
    name: "vs_fpm",
    extract: (f) => f.vs ?? f.vs_fpm,
    format: fmt.real1,
  },
  {
    name: "grade",
    extract: (f) => f.grade ?? f.landingGrade,
    format: fmt.str,
  },
  {
    // Compact snapshot of the exact touchdown-rate policy, recorded aircraft
    // profile and thresholds used for this result. This is deliberately
    // landing-only; SAMPLE rows leave the column empty.
    name: "landing_rate_context",
    extract: (f) => f.landingRateContext ?? f.landing_rate_context,
    format: fmt.json,
  },
  {
    name: "alt_msl_ft",
    extract: (f) => f.altMsl ?? f.altitude?.msl ?? f.alt_msl_ft,
    format: fmt.real1,
  },
  {
    name: "alt_indicated_ft",
    extract: (f) => f.altIndicatedFt ?? f.alt_indicated_ft ?? f.fdm?.altIndicatedFt ?? f.altMsl ?? f.alt_msl_ft,
    format: fmt.real1,
  },
  {
    name: "alt_calibrated_ft",
    extract: (f) => f.altCalibratedFt ?? f.alt_calibrated_ft ?? f.fdm?.altCalibratedFt,
    format: fmt.real1,
  },
  {
    name: "alt_plane_ft",
    extract: (f) => f.altPlaneFt ?? f.alt_plane_ft ?? f.fdm?.altPlaneFt,
    format: fmt.real1,
  },
  {
    name: "ra_ft",
    extract: (f) => f.ra ?? f.altitude?.ra ?? f.ra_ft,
    format: fmt.real1,
  },
  {
    name: "aircraft_agl_ft",
    extract: (f) => f.aircraftAglFt ?? f.aircraft_agl_ft ?? f.fdm?.aircraftAglFt,
    format: fmt.real1,
  },
  {
    name: "aircraft_above_obstacles_ft",
    extract: (f) => f.aircraftAboveObstaclesFt ?? f.aircraft_above_obstacles_ft ?? f.fdm?.aircraftAboveObstaclesFt,
    format: fmt.real1,
  },
  {
    name: "plane_agl_ft",
    extract: (f) => f.planeAglFt ?? f.plane_agl_ft ?? f.fdm?.planeAglFt,
    format: fmt.real1,
  },
  {
    name: "plane_agl_minus_cg_ft",
    extract: (f) => f.planeAglMinusCgFt ?? f.plane_agl_minus_cg_ft ?? f.fdm?.planeAglMinusCgFt,
    format: fmt.real1,
  },
  {
    name: "pressure_alt_ft",
    extract: (f) => f.pressureAltFt ?? f.pressure_alt_ft ?? f.fdm?.pressureAltFt,
    format: fmt.real1,
  },
  {
    name: "kohlsman_setting_mb",
    extract: (f) => f.kohlsmanSettingMb ?? f.kohlsman_setting_mb ?? f.fdm?.kohlsmanSettingMb,
    format: fmt.real2,
  },
  {
    name: "kohlsman_tuned_mb",
    extract: (f) => f.kohlsmanTunedMb ?? f.kohlsman_tuned_mb ?? f.fdm?.kohlsmanTunedMb,
    format: fmt.real2,
  },
  {
    name: "kohlsman_std",
    extract: (f) => f.kohlsmanStd ?? f.kohlsman_std ?? f.fdm?.kohlsmanStd,
    format: fmt.bool,
  },
  {
    name: "mach",
    extract: (f) => f.mach ?? f.fdm?.mach,
    format: fmt.real3,
  },
  {
    name: "ias_trend_kts",
    extract: (f) => f.iasTrend ?? null,
    format: fmt.real1,
  },
  {
    name: "xwind_kts",
    extract: (f) => f.xwind ?? f.xwind_kts ?? null,
    format: fmt.real1,
  },
  {
    name: "hdg_true_deg",
    extract: (f) => f.hdgTrue ?? f.heading?.true ?? f.hdg_true_deg,
    format: fmt.real1,
  },
  {
    name: "hdg_mag_deg",
    extract: (f) => f.hdgMag ?? f.heading?.mag ?? f.hdg_mag_deg,
    format: fmt.real1,
  },
  {
    name: "magvar_deg",
    extract: (f) => f.magvar ?? f.magvar_deg ?? null,
    format: fmt.real2,
  },
  {
    name: "track_true_deg",
    extract: (f) => f.trackTrue ?? f.fdm?.trackTrueDeg ?? f.track_true_deg,
    format: fmt.real1,
  },
  {
    name: "wind_speed_kts",
    extract: (f) => f.windSpeed ?? f.wind?.speed ?? f.wind_speed_kts,
    format: fmt.real1,
  },
  {
    name: "wind_dir_deg",
    extract: (f) => f.windDir ?? f.wind?.direction ?? f.wind_dir_deg,
    format: fmt.real1,
  },
  {
    name: "pitch_deg",
    extract: (f) => f.pitch ?? f.pitch_deg,
    format: fmt.real1,
  },
  {
    name: "bank_deg",
    extract: (f) => f.bank ?? f.bank_deg,
    format: fmt.real1,
  },
  {
    name: "touchdown_capture_source",
    extract: (f) => f.touchdownCaptureSource ?? f.touchdown_capture_source,
    format: fmt.str,
  },
  {
    name: "td_sim_source",
    extract: (f) => f.tdSimSource ?? f.td_sim_source,
    format: fmt.str,
  },
  {
    name: "td_sim_trusted",
    extract: (f) => f.tdSimTrusted ?? f.td_sim_trusted,
    format: fmt.bool,
  },
  {
    name: "td_sim_fresh",
    extract: (f) => f.tdSimFresh ?? f.td_sim_fresh,
    format: fmt.bool,
  },
  {
    name: "td_sim_reject_reason",
    extract: (f) => f.tdSimRejectReason ?? f.td_sim_reject_reason,
    format: fmt.str,
  },
  {
    name: "td_sim_position_delta_ft",
    extract: (f) => f.tdSimPositionDeltaFt ?? f.td_sim_position_delta_ft,
    format: fmt.real1,
  },
  {
    name: "td_sim_lat_deg",
    extract: (f) => f.tdSimLatDeg ?? f.td_sim_lat_deg,
    format: fmt.real6,
  },
  {
    name: "td_sim_lon_deg",
    extract: (f) => f.tdSimLonDeg ?? f.td_sim_lon_deg,
    format: fmt.real6,
  },
  {
    name: "td_sim_hdg_true_deg",
    extract: (f) => f.tdSimHdgTrueDeg ?? f.td_sim_hdg_true_deg,
    format: fmt.real1,
  },
  {
    name: "td_sim_hdg_mag_deg",
    extract: (f) => f.tdSimHdgMagDeg ?? f.td_sim_hdg_mag_deg,
    format: fmt.real1,
  },
  {
    name: "td_sim_pitch_deg",
    extract: (f) => f.tdSimPitchDeg ?? f.td_sim_pitch_deg,
    format: fmt.real1,
  },
  {
    name: "td_sim_bank_deg",
    extract: (f) => f.tdSimBankDeg ?? f.td_sim_bank_deg,
    format: fmt.real1,
  },
  {
    name: "td_sim_normal_velocity_fps",
    extract: (f) => f.tdSimNormalVelocityFps ?? f.td_sim_normal_velocity_fps,
    format: fmt.real2,
  },
  {
    name: "td_sim_normal_velocity_fpm",
    extract: (f) => f.tdSimNormalVelocityFpm ?? f.td_sim_normal_velocity_fpm,
    format: fmt.real1,
  },
  {
    name: "td_sim_landing_vs_fpm",
    extract: (f) => f.tdSimLandingVsFpm ?? f.td_sim_landing_vs_fpm,
    format: fmt.real1,
  },
  {
    name: "aoa_deg",
    extract: (f) => f.aoa ?? f.fdm?.aoaDeg ?? f.aoa_deg,
    format: fmt.real1,
  },
  {
    name: "sideslip_deg",
    extract: (f) => f.sideslip ?? f.fdm?.sideslipDeg ?? f.sideslip_deg,
    format: fmt.real1,
  },
  {
    name: "pitch_rate_rad_s",
    extract: (f) => f.pitchRateRadS ?? f.fdm?.pitchRateRadS,
    format: fmt.real4,
  },
  {
    name: "roll_rate_rad_s",
    extract: (f) => f.rollRateRadS ?? f.fdm?.rollRateRadS,
    format: fmt.real4,
  },
  {
    name: "yaw_rate_rad_s",
    extract: (f) => f.yawRateRadS ?? f.fdm?.yawRateRadS,
    format: fmt.real4,
  },
  {
    name: "g_force",
    extract: (f) => f.gForce ?? f.gforce ?? f.fdm?.gForce,
    format: fmt.real2,
  },
  {
    name: "g_force_lateral",
    extract: (f) => f.gForceLateral ?? f.fdm?.gForceLateral,
    format: fmt.real2,
  },
  {
    name: "g_force_longitudinal",
    extract: (f) => f.gForceLongitudinal ?? f.fdm?.gForceLongitudinal,
    format: fmt.real2,
  },
  {
    name: "lat_deg",
    extract: (f) => f.lat ?? f.position?.lat ?? f.lat_deg,
    format: fmt.real6,
  },
  {
    name: "lon_deg",
    extract: (f) => f.lon ?? f.position?.lon ?? f.lon_deg,
    format: fmt.real6,
  },
  {
    name: "gear_down_locked",
    extract: (f) => f.gearDownLocked ?? f.gear?.locked ?? f.gear_down_locked,
    format: fmt.bool,
  },
  {
    name: "flaps_notch",
    extract: (f) => f.flapsNotch ?? f.flaps?.notch ?? f.flaps_notch ?? f.flapsIndex,
    format: fmt.str,
  },
  {
    // Distinguishes a validated profile/LVAR detent from generic percent or
    // physical-angle fallbacks when reconstructing configuration events.
    name: "flaps_source",
    extract: (f) => f.flapsSource ?? f.flaps?.source ?? f.flaps_source,
    format: fmt.str,
  },
  {
    name: "flaps_pct",
    extract: (f) => {
      // If flaps is a number, use it directly
      if (typeof f.flaps === 'number') return f.flaps;
      // If flaps is an object with percent, use that
      if (f.flaps && typeof f.flaps.percent === 'number') return f.flaps.percent;
      // Fallback
      return f.flaps_pct ?? null;
    },
    format: fmt.real1,
  },
  {
    name: "spoiler_pct",
    extract: (f) => f.spoilerPct ?? f.spoilers?.percent ?? f.fdm?.spoilerPct,
    format: fmt.real1,
  },
  {
    // Provenance and availability come from the resolved spoiler overlay, after
    // aircraft-specific LVAR/SDK substitution and unreliable-source suppression.
    name: "spoiler_source",
    extract: (f) => f.spoilerSource ?? f.spoilers?._source ?? f.spoiler_source,
    format: fmt.str,
  },
  {
    name: "spoiler_available",
    extract: (f) => f.spoilerAvailable ?? f.spoilers?.available ?? f.spoiler_available,
    format: fmt.bool,
  },
  {
    // spoiler_state: canonical state string from spoilers.js — STOWED, ARMED, or EXTENDED.
    // ARMED means the lever is in the armed detent but panels are not raised (correct SOP
    // on approach). Storing this avoids having to re-derive it from the numeric percent
    // when the timeline replays the CSV: the percent alone is ambiguous for aircraft
    // with non-zero armed detents, which can look identical to partial deployment without the boolean context.
    // Note: the enriched frame stores this as `spoilerState` (flat), not nested `spoilers.state`.
    name: "spoiler_state",
    extract: (f) => f.spoilerState ?? f.spoiler_state ?? f.spoilers?.state ?? null,
    format: fmt.str,
  },
  {
    name: "brake_pct",
    extract: (f) => f.brakePct ?? f.brake ?? f.brake_pct,
    format: fmt.real1,
  },
  {
    name: "yoke_x_pct",
    // yokeX / yoke.x are ±1 normalized; scale to ±100 to match column name semantics.
    // fdm.yokeXPct fallback is already ±100.
    extract: (f) => {
      if (f.yokeX != null) return f.yokeX * 100;
      if (f.yoke?.x != null) return f.yoke.x * 100;
      return f.fdm?.yokeXPct ?? null;
    },
    format: fmt.real1,
  },
  {
    name: "yoke_y_pct",
    // yokeY / yoke.y are ±1 normalized; scale to ±100 to match column name semantics.
    // fdm.yokeYPct fallback is already ±100.
    extract: (f) => {
      if (f.yokeY != null) return f.yokeY * 100;
      if (f.yoke?.y != null) return f.yoke.y * 100;
      return f.fdm?.yokeYPct ?? null;
    },
    format: fmt.real1,
  },
  {
    name: "aileron_pct",
    extract: (f) => f.aileronPct ?? f.fdm?.aileronPct,
    format: fmt.real1,
  },
  {
    name: "elevator_pct",
    extract: (f) => f.elevatorPct ?? f.fdm?.elevatorPct,
    format: fmt.real1,
  },
  {
    name: "rudder_pct",
    extract: (f) => f.rudderPct ?? f.fdm?.rudderPct,
    format: fmt.real1,
  },
  {
    name: "rudder_pedal_pct",
    extract: (f) => f.rudderPedalPct ?? f.fdm?.rudderPedalPct ?? null,
    format: fmt.real1,
  },
  {
    name: "elev_trim_pct",
    extract: (f) => f.elevTrimPct ?? f.trim?.elevator ?? f.fdm?.elevTrimPct,
    format: fmt.real1,
  },
  {
    name: "thr1_pct",
    extract: (f) => f.thr1 ?? f.throttle?.eng1 ?? f.throttle?.eng1Pct,
    format: fmt.real1,
  },
  {
    name: "thr2_pct",
    extract: (f) => f.thr2 ?? f.throttle?.eng2 ?? f.throttle?.eng2Pct,
    format: fmt.real1,
  },
  {
    name: "thr3_pct",
    extract: (f) => f.thr3 ?? f.throttle?.eng3 ?? f.throttle?.eng3Pct,
    format: fmt.real1,
  },
  {
    name: "thr4_pct",
    extract: (f) => f.thr4 ?? f.throttle?.eng4 ?? f.throttle?.eng4Pct,
    format: fmt.real1,
  },
  {
    name: "eng1_n1_pct",
    extract: (f) => f.eng1N1 ?? f.fdm?.eng1N1,
    format: fmt.real1,
  },
  {
    name: "eng2_n1_pct",
    extract: (f) => f.eng2N1 ?? f.fdm?.eng2N1,
    format: fmt.real1,
  },
  {
    name: "eng3_n1_pct",
    extract: (f) => f.eng3N1 ?? f.fdm?.eng3N1,
    format: fmt.real1,
  },
  {
    name: "eng4_n1_pct",
    extract: (f) => f.eng4N1 ?? f.fdm?.eng4N1,
    format: fmt.real1,
  },
  {
    name: "eng1_n2_pct",
    extract: (f) => f.eng1N2 ?? f.fdm?.eng1N2,
    format: fmt.real1,
  },
  {
    name: "eng2_n2_pct",
    extract: (f) => f.eng2N2 ?? f.fdm?.eng2N2,
    format: fmt.real1,
  },
  {
    name: "eng3_n2_pct",
    extract: (f) => f.eng3N2 ?? f.fdm?.eng3N2,
    format: fmt.real1,
  },
  {
    name: "eng4_n2_pct",
    extract: (f) => f.eng4N2 ?? f.fdm?.eng4N2,
    format: fmt.real1,
  },
  {
    name: "eng1_egt_c",
    extract: (f) => f.eng1Egt ?? f.fdm?.eng1EgtC,
    format: fmt.real1,
  },
  {
    name: "eng2_egt_c",
    extract: (f) => f.eng2Egt ?? f.fdm?.eng2EgtC,
    format: fmt.real1,
  },
  {
    name: "eng3_egt_c",
    extract: (f) => f.eng3Egt ?? f.fdm?.eng3EgtC,
    format: fmt.real1,
  },
  {
    name: "eng4_egt_c",
    extract: (f) => f.eng4Egt ?? f.fdm?.eng4EgtC,
    format: fmt.real1,
  },
  {
    name: "eng1_ff_pph",
    extract: (f) => f.eng1FF ?? f.fdm?.eng1FfPph,
    format: fmt.real1,
  },
  {
    name: "eng2_ff_pph",
    extract: (f) => f.eng2FF ?? f.fdm?.eng2FfPph,
    format: fmt.real1,
  },
  {
    name: "eng3_ff_pph",
    extract: (f) => f.eng3FF ?? f.fdm?.eng3FfPph,
    format: fmt.real1,
  },
  {
    name: "eng4_ff_pph",
    extract: (f) => f.eng4FF ?? f.fdm?.eng4FfPph,
    format: fmt.real1,
  },
  {
    name: "fuel_total_gal",
    extract: (f) => f.fuelTotal ?? f.fuel?.totalGal ?? f.fdm?.fuelTotalGal,
    format: fmt.real1,
  },
  {
    name: "fuel_total_weight_lbs",
    extract: (f) => f.fuelTotalWeightLbs ?? f.fdm?.fuelTotalWeightLbs,
    format: fmt.real1,
  },
  {
    name: "fuel_weight_per_gal",
    extract: (f) => f.fuelWeightPerGal ?? f.fdm?.fuelWeightPerGal,
    format: fmt.real3,
  },
  {
    name: "gross_weight_lbs",
    extract: (f) => f.grossWeightLbs ?? f.fdm?.grossWeightLbs,
    format: fmt.int,
  },
  {
    name: "cg_pct",
    extract: (f) => f.cgPct ?? f.fdm?.cgPct,
    format: fmt.real1,
  },
  {
    name: "gs_deviation_dots",
    extract: (f) => coalescePlausibleIlsDeviationDots(f.gsDeviation, f.fdm?.gsDeviationDots),
    format: fmt.real2,
  },
  {
    name: "loc_deviation_dots",
    extract: (f) => coalescePlausibleIlsDeviationDots(f.locDeviation, f.fdm?.locDeviationDots),
    format: fmt.real2,
  },
  {
    name: "nav1_gsi_raw",
    extract: (f) => f.nav1GsiRaw ?? f.fdm?.nav1GsiRaw,
    format: fmt.real2,
  },
  {
    name: "nav1_cdi_raw",
    extract: (f) => f.nav1CdiRaw ?? f.fdm?.nav1CdiRaw,
    format: fmt.real2,
  },
  {
    name: "nav1_has_glideslope",
    extract: (f) => f.nav1HasGlideSlope ?? f.fdm?.nav1HasGlideSlope,
    format: fmt.bool,
  },
  {
    name: "nav1_has_localizer",
    extract: (f) => f.nav1HasLocalizer ?? f.fdm?.nav1HasLocalizer,
    format: fmt.bool,
  },
  {
    name: "nav1_signal",
    extract: (f) => f.nav1Signal ?? f.fdm?.nav1Signal,
    format: fmt.real2,
  },
  {
    name: "ap_master",
    extract: (f) => f.apMaster ?? f.autopilot?.master ?? f.fdm?.apMaster,
    format: fmt.bool,
  },
  {
    name: "ap_alt_hold",
    extract: (f) => f.apAltHold ?? f.fdm?.apAltHold,
    format: fmt.bool,
  },
  {
    name: "ap_hdg_hold",
    extract: (f) => f.apHdgHold ?? f.fdm?.apHdgHold,
    format: fmt.bool,
  },
  {
    name: "ap_nav_hold",
    extract: (f) => f.apNavHold ?? f.fdm?.apNavHold,
    format: fmt.bool,
  },
  {
    name: "ap_appr_hold",
    extract: (f) => f.apApprHold ?? f.autopilot?.apprHold ?? f.fdm?.apApprHold,
    format: fmt.bool,
  },
  {
    name: "ap_vs_hold",
    extract: (f) => f.apVsHold ?? f.fdm?.apVsHold,
    format: fmt.bool,
  },
  {
    name: "ap_fd_active",
    extract: (f) => f.apFdActive ?? f.ap_fd_active ?? f.fdm?.apFdActive,
    format: fmt.bool,
  },
  {
    name: "ap_flc_hold",
    extract: (f) =>
      f.apFlcHold ??
      f.ap_flc_hold ??
      f.fdm?.apLvlChgHold ??
      f.fdm?.apFlcHold ??
      null,
    format: fmt.bool,
  },
  {
    name: "ap_speed_hold",
    extract: (f) => f.apSpeedHold ?? f.ap_speed_hold ?? f.fdm?.apSpeedHold,
    format: fmt.bool,
  },
  {
    name: "ap_alt_target_ft",
    extract: (f) => f.fdm?.apAltTargetFt ?? null,
    format: fmt.int,
  },
  {
    name: "ap_hdg_target_deg",
    extract: (f) => f.fdm?.apHdgTargetDeg ?? null,
    format: fmt.real1,
  },
  {
    name: "ap_vs_target_fpm",
    extract: (f) => f.fdm?.apVsTargetFpm ?? null,
    format: fmt.int,
  },
  {
    name: "ap_speed_target_kts",
    extract: (f) => f.fdm?.apSpeedTargetKts ?? null,
    format: fmt.real1,
  },
  {
    name: "ap_mach_target",
    extract: (f) => f.apMachTarget ?? f.ap_mach_target ?? f.fdm?.apMachTarget ?? null,
    format: fmt.real3,
  },
  {
    name: "ap_reliable",
    extract: (f) => f.apReliable ?? f.ap_reliable ?? null,
    format: fmt.bool,
  },
  {
    name: "athr_reliable",
    extract: (f) => f.athrReliable ?? f.athr_reliable ?? null,
    format: fmt.bool,
  },
  {
    name: "ap_reliability_reason",
    extract: (f) => f.apReliabilityReason ?? f.ap_reliability_reason ?? null,
    format: fmt.str,
  },
  {
    name: "athr_active",
    extract: (f) => f.athrActive ?? f.autothrottle?.active ?? f.fdm?.athrActive,
    format: fmt.bool,
  },
  {
    name: "athr_armed",
    extract: (f) => f.athrArmed ?? f.athr_armed ?? f.fdm?.athrArmed,
    format: fmt.bool,
  },
  {
    name: "oat_c",
    extract: (f) => f.oat ?? f.fdm?.oatC,
    format: fmt.real1,
  },
  {
    name: "tat_c",
    extract: (f) => f.tat ?? f.fdm?.tatC,
    format: fmt.real1,
  },
  {
    name: "pressure_mb",
    extract: (f) => f.pressure ?? f.fdm?.pressureMb,
    format: fmt.real1,
  },
  {
    name: "sea_level_pressure_mb",
    extract: (f) => f.seaLevelPressureMb ?? f.sea_level_pressure_mb ?? f.fdm?.seaLevelPressureMb,
    format: fmt.real1,
  },
  {
    name: "visibility_m",
    extract: (f) => f.visibility ?? f.fdm?.visibilityM,
    format: fmt.int,
  },
  {
    name: "precip_rate_mm",
    extract: (f) => f.precipRateMm ?? f.precip_rate_mm ?? f.fdm?.precipRateMm,
    format: fmt.real2,
  },
  {
    name: "precip_state",
    extract: (f) => f.precipState ?? f.precip_state ?? f.fdm?.precipState,
    format: fmt.int,
  },
  {
    name: "in_cloud",
    extract: (f) => f.inCloud ?? f.in_cloud ?? f.fdm?.inCloud,
    format: fmt.bool,
  },
  {
    name: "surface_condition",
    extract: (f) => f.surfaceCondition ?? f.surface_condition ?? f.fdm?.surfaceCondition,
    format: fmt.int,
  },
  {
    name: "density_alt_ft",
    extract: (f) => f.densityAltFt ?? f.fdm?.densityAltFt,
    format: fmt.int,
  },
  {
    name: "cabin_alt_ft",
    extract: (f) => f.cabinAltFt ?? f.fdm?.cabinAltFt,
    format: fmt.int,
  },
  {
    name: "cabin_alt_rate_fpm",
    extract: (f) => f.cabinAltRateFpm ?? f.fdm?.cabinAltRateFpm,
    format: fmt.real1,
  },
  {
    name: "cabin_delta_p_psi",
    extract: (f) => f.cabinDeltaPPsi ?? f.fdm?.cabinDeltaPPsi,
    format: fmt.real2,
  },
  {
    name: "cabin_alt_target_ft",
    extract: (f) => f.cabinAltTargetFt ?? f.fdm?.cabinAltTargetFt,
    format: fmt.int,
  },
  {
    name: "cabin_dump_switch",
    extract: (f) => f.cabinDumpSwitch ?? f.fdm?.cabinDumpSwitch,
    format: fmt.bool,
  },
  {
    name: "surface_raw",
    extract: (f) => f.surfaceRaw ?? f.surface_raw ?? f.surface?.raw,
    format: fmt.int,
  },
  {
    name: "surface_name",
    extract: (f) => f.surfaceName ?? f.surface_name ?? f.surface?.name ?? null,
    format: fmt.str,
  },
  {
    name: "surface_class",
    extract: (f) => f.surfaceClass ?? f.surface_class ?? f.surface?.class ?? null,
    format: fmt.str,
  },
  {
    name: "surface_runway_like",
    extract: (f) => f.surfaceRunwayLike ?? f.surface_runway_like ?? f.surface?.runwayLike ?? null,
    format: fmt.bool,
  },
  {
    name: "surface_on_runway",
    extract: (f) => f.surfaceOnRunway ?? f.surface_on_runway ?? f.surface?.onRunway ?? null,
    format: fmt.bool,
  },
  {
    name: "surface_on_ground",
    extract: (f) => f.surfaceOnGround ?? f.surface_on_ground ?? f.surface?.onGround ?? null,
    format: fmt.bool,
  },
  {
    name: "surface_valid",
    extract: (f) => f.surfaceValid ?? f.surface_valid ?? null,
    format: fmt.bool,
  },
  {
    name: "aircraft",
    extract: (f) => f.aircraft ?? f.aircraftTitle,
    format: fmt.str,
  },
  {
    name: "aircraft_profile_id",
    extract: (f) => f.aircraftProfileId ?? f.aircraft_profile_id,
    format: fmt.str,
  },
  {
    name: "sim_version",
    extract: (f) => f.simVersion ?? f.sim_version,
    format: fmt.str,
  },
  {
    name: "sim_time_zulu_sec",
    extract: (f) => f.simTimeZuluSec ?? f.simTime?.zuluSec ?? null,
    format: fmt.int,
  },
  {
    name: "sim_time_local_sec",
    extract: (f) => f.simTimeLocalSec ?? f.sim_time_local_sec ?? f.simTime?.localSec ?? null,
    format: fmt.int,
  },
  {
    name: "sim_time_zulu_hms",
    extract: (f) => f.simTimeZuluHms ?? f.sim_time_zulu_hms ?? f.simTime?.zuluHms ?? null,
    format: fmt.str,
  },
  {
    name: "sim_time_local_hms",
    extract: (f) => f.simTimeLocalHms ?? f.sim_time_local_hms ?? f.simTime?.localHms ?? null,
    format: fmt.str,
  },
  {
    name: "sim_date_utc",
    extract: (f) => f.simDateZulu ?? f.sim_date_utc ?? f.simTime?.zuluDate ?? null,
    format: fmt.str,
  },
  {
    name: "sim_date_local",
    extract: (f) => f.simDateLocal ?? f.sim_date_local ?? f.simTime?.localDate ?? null,
    format: fmt.str,
  },
  {
    name: "sim_datetime_utc",
    extract: (f) => f.simDatetimeUtc ?? f.sim_datetime_utc ?? f.simTime?.zuluIso ?? null,
    format: fmt.str,
  },
  {
    name: "sim_datetime_local",
    extract: (f) => f.simDatetimeLocal ?? f.sim_datetime_local ?? f.simTime?.localIso ?? null,
    format: fmt.str,
  },
  {
    name: "sim_datetime_source",
    extract: (f) => f.simDatetimeSource ?? f.sim_datetime_source ?? f.simTime?.source ?? null,
    format: fmt.str,
  },
  {
    name: "sim_datetime_valid",
    extract: (f) => f.simDatetimeValid ?? f.sim_datetime_valid ?? f.simTime?.valid ?? null,
    format: fmt.bool,
  },
  {
    name: "sim_timezone_offset_sec",
    extract: (f) => f.simTimezoneOffsetSec ?? f.sim_timezone_offset_sec ?? f.simTime?.timezoneOffsetSec ?? null,
    format: fmt.int,
  },
  {
    name: "sim_absolute_time_sec",
    extract: (f) => f.simAbsoluteTimeSec ?? f.sim_absolute_time_sec ?? f.simTime?.absoluteSec ?? null,
    format: fmt.int,
  },
  {
    name: "sim_time_of_day",
    extract: (f) => f.simTimeOfDay ?? f.sim_time_of_day ?? f.simTime?.timeOfDay ?? null,
    format: fmt.int,
  },
  {
    name: "sim_local_year",
    extract: (f) => f.simLocalYear ?? f.sim_local_year ?? f.simTime?.localYear ?? null,
    format: fmt.int,
  },
  {
    name: "sim_local_month",
    extract: (f) => f.simLocalMonth ?? f.sim_local_month ?? f.simTime?.localMonth ?? null,
    format: fmt.int,
  },
  {
    name: "sim_local_day",
    extract: (f) => f.simLocalDay ?? f.sim_local_day ?? f.simTime?.localDay ?? null,
    format: fmt.int,
  },
  {
    name: "sim_local_day_of_year",
    extract: (f) => f.simLocalDayOfYear ?? f.sim_local_day_of_year ?? f.simTime?.localDayOfYear ?? null,
    format: fmt.int,
  },
  {
    name: "sim_local_day_of_week",
    extract: (f) => f.simLocalDayOfWeek ?? f.sim_local_day_of_week ?? f.simTime?.localDayOfWeek ?? null,
    format: fmt.int,
  },
  {
    name: "sim_zulu_sunrise_sec",
    extract: (f) => f.simZuluSunriseSec ?? f.sim_zulu_sunrise_sec ?? f.simTime?.zuluSunriseSec ?? null,
    format: fmt.int,
  },
  {
    name: "sim_zulu_sunset_sec",
    extract: (f) => f.simZuluSunsetSec ?? f.sim_zulu_sunset_sec ?? f.simTime?.zuluSunsetSec ?? null,
    format: fmt.int,
  },
  {
    name: "flight_start_iso",
    extract: (f) => f.flightStartIso ?? f.flight_start ?? null,
    format: fmt.str,
  },
  {
    name: "data_source",
    extract: (f) => f.dataSource ?? f.data_source,
    format: fmt.str,
  },
  {
    name: "signal_reliability",
    extract: (f) => f.signalReliability ?? f.signal_reliability,
    format: fmt.str,
  },
  {
    name: "assist_unlimited_fuel",
    extract: (f) => assistValue(f, 'unlimitedFuel', 'assist_unlimited_fuel'),
    format: fmt.bool,
  },
  {
    name: "assist_landing_enabled",
    extract: (f) => assistValue(f, 'landingAssist', 'assist_landing_enabled'),
    format: fmt.bool,
  },
  {
    name: "assist_takeoff_enabled",
    extract: (f) => assistValue(f, 'takeoffAssist', 'assist_takeoff_enabled'),
    format: fmt.bool,
  },
  {
    name: "assist_ai_controls",
    extract: (f) => assistValue(f, 'aiControls', 'assist_ai_controls'),
    format: fmt.bool,
  },
  {
    name: "assist_ai_autotrim",
    extract: (f) => assistValue(f, 'aiAutotrim', 'assist_ai_autotrim'),
    format: fmt.bool,
  },
  {
    name: "assist_ai_delegated",
    extract: (f) => assistValue(f, 'aiDelegated', 'assist_ai_delegated'),
    format: fmt.bool,
  },
  {
    name: "assist_ai_antistall_state",
    extract: (f) => assistValue(f, 'aiAntistall', 'assist_ai_antistall_state'),
    format: fmt.int,
  },
  {
    name: "assist_ai_antistall_active",
    extract: (f) => assistValue(f, 'aiAntistallActive', 'assist_ai_antistall_active'),
    format: fmt.bool,
  },
  {
    name: "assist_realism_pct",
    extract: (f) => assistValue(f, 'realismPercent', 'assist_realism_pct'),
    format: fmt.int,
  },
  {
    name: "assist_full_realism",
    extract: (f) => assistValue(f, 'fullRealism', 'assist_full_realism'),
    format: fmt.bool,
  },
  {
    name: "assist_slew_active",
    extract: (f) => assistValue(f, 'slewActive', 'assist_slew_active'),
    format: fmt.bool,
  },
  {
    name: "assist_any_active",
    extract: (f) => assistValue(f, 'anyAssistActive', 'assist_any_active'),
    format: fmt.bool,
  },
  {
    name: "event_id",
    extract: (f) => f.eventId ?? f.event_id,
    format: fmt.str,
  },
  {
    name: "icao",
    extract: (f) => f.icao,
    format: fmt.str,
  },
  {
    name: "runway",
    extract: (f) => f.runway,
    format: fmt.str,
  },
  {
    name: "approach_type",
    extract: (f) => f.approachType ?? f.approach_type,
    format: fmt.str,
  },
  {
    name: "touchdown_distance_ft",
    extract: (f) => f.touchdownDistanceFt ?? f.touchdown_distance_ft,
    format: fmt.int,
  },
  {
    name: "fdm_surface_condition",
    extract: (f) => f.fdmSurfaceCondition ?? f.fdm_surface_condition ?? null,
    format: fmt.int,
  },
  {
    name: "fdm_precip_state",
    extract: (f) => f.fdmPrecipState ?? f.fdm_precip_state ?? null,
    format: fmt.int,
  },
  {
    name: "fdm_precip_rate_mm",
    extract: (f) => f.fdmPrecipRateMm ?? f.fdm_precip_rate_mm ?? null,
    format: fmt.real2,
  },
  {
    name: "fdm_oat_c",
    extract: (f) => f.fdmOatC ?? f.fdm_oat_c ?? null,
    format: fmt.real1,
  },
  {
    name: "touchdown_distance_score",
    extract: (f) => f.touchdown_distance_score,
    format: fmt.real1,
  },
  {
    name: "touchdown_distance_grade",
    extract: (f) => f.touchdown_distance_grade,
    format: fmt.str,
  },
  {
    name: "runway_geometry_source",
    extract: (f) => f.runwayGeometrySource ?? f.runway_geometry_source,
    format: fmt.str,
  },
  {
    name: "runway_geometry_provider_chain",
    extract: (f) => f.runwayGeometryProviderChain ?? f.runway_geometry_provider_chain,
    format: fmt.str,
  },
  {
    name: "runway_geometry_fallback_reason",
    extract: (f) => f.runwayGeometryFallbackReason ?? f.runway_geometry_fallback_reason,
    format: fmt.str,
  },
  {
    name: "runway_geometry_diagnostics",
    extract: (f) => f.runwayGeometryDiagnostics ?? f.runway_geometry_diagnostics,
    format: fmt.json,
  },
  {
    name: "runway_reference_elev_ft",
    extract: (f) => f.runwayReferenceElevFt ?? f.runway_reference_elev_ft,
    format: fmt.real1,
  },
  {
    name: "runway_reference_elevation_source",
    extract: (f) => f.runwayReferenceElevationSource ?? f.runway_reference_elevation_source,
    format: fmt.str,
  },
  {
    name: "runway_reference_elevation_kind",
    extract: (f) => f.runwayReferenceElevationKind ?? f.runway_reference_elevation_kind,
    format: fmt.str,
  },
  {
    name: "runway_heading_true_deg",
    extract: (f) => f.runwayHeadingTrueDeg ?? f.runway_heading_true_deg,
    format: fmt.real1,
  },
  {
    name: "runway_length_ft",
    extract: (f) => f.runway_length_ft,
    format: fmt.int,
  },
  {
    name: "runway_physical_length_ft",
    extract: (f) => f.runwayPhysicalLengthFt ?? f.runway_physical_length_ft,
    format: fmt.int,
  },
  {
    name: "runway_surface",
    extract: (f) => f.runwaySurface ?? f.runway_surface,
    format: fmt.str,
  },
  {
    name: "runway_threshold_lat",
    extract: (f) => f.runwayThresholdLat ?? f.runway_threshold_lat,
    format: fmt.real6,
  },
  {
    name: "runway_threshold_lon",
    extract: (f) => f.runwayThresholdLon ?? f.runway_threshold_lon,
    format: fmt.real6,
  },
  {
    name: "runway_physical_threshold_lat",
    extract: (f) => f.runwayPhysicalThresholdLat ?? f.runway_physical_threshold_lat,
    format: fmt.real6,
  },
  {
    name: "runway_physical_threshold_lon",
    extract: (f) => f.runwayPhysicalThresholdLon ?? f.runway_physical_threshold_lon,
    format: fmt.real6,
  },
  {
    name: "runway_displaced_threshold_ft",
    extract: (f) => f.runwayDisplacedThresholdFt ?? f.runway_displaced_threshold_ft,
    format: fmt.int,
  },
  {
    name: "short_landing",
    extract: (f) => f.shortLanding ?? f.short_landing,
    format: fmt.bool,
  },
  {
    name: "runway_condition",
    extract: (f) => f.runwayCondition ?? f.runway_condition,
    format: fmt.str,
  },
  {
    name: "runway_condition_source",
    extract: (f) => f.runwayConditionSource ?? f.runway_condition_source,
    format: fmt.str,
  },
  {
    name: "runway_condition_confident",
    extract: (f) => f.runwayConditionConfident ?? f.runway_condition_confident,
    format: fmt.bool,
  },
  {
    name: "lateral_offset_ft",
    extract: (f) => f.lateralOffsetFt ?? f.lateral_offset_ft,
    format: fmt.int,
  },
  {
    name: "lateral_offset_side",
    extract: (f) => f.lateralOffsetSide ?? f.lateral_offset_side,
    format: fmt.str,
  },
  {
    name: "lateral_offset_score",
    extract: (f) => f.lateralOffsetScore ?? f.lateral_offset_score,
    format: fmt.real1,
  },
  {
    name: "lateral_offset_grade",
    extract: (f) => f.lateralOffsetGrade ?? f.lateral_offset_grade,
    format: fmt.str,
  },
  {
    name: "lateral_offset_suspect",
    extract: (f) => f.lateralOffsetSuspect ?? f.lateral_offset_suspect,
    format: fmt.bool,
  },
  {
    name: "runway_width_ft",
    extract: (f) => f.runwayWidthFt ?? f.runway_width_ft,
    format: fmt.int,
  },
  {
    name: "runway_excursion",
    extract: (f) => f.runwayExcursion ?? f.runway_excursion,
    format: fmt.bool,
  },
  {
    name: "runway_occupancy_s",
    extract: (f) => f.runwayOccupancyS ?? f.runway_occupancy_s,
    format: fmt.real1,
  },
  {
    name: "rollout_analysis",
    extract: (f) => f.rolloutAnalysis ?? f.rollout_analysis,
    format: fmt.json,
  },
  {
    name: "landing_final",
    extract: (f) => f.landingFinal ?? f.landing_final,
    format: fmt.bool,
  },
  {
    name: "bounce_count",
    extract: (f) => f.bounce_count,
    format: fmt.int,
  },
  {
    name: "bounce_grade",
    extract: (f) => f.bounce_grade,
    format: fmt.str,
  },
  {
    name: "bounce_score",
    extract: (f) => f.bounce_score,
    format: fmt.real1,
  },
  {
    name: "bounce_distance_ft",
    extract: (f) => f.bounce_distance_ft,
    format: fmt.int,
  },
  {
    name: "bounce_worst_gforce",
    extract: (f) => f.bounce_worst_gforce,
    format: fmt.real2,
  },
  {
    name: "first_touchdown_lat",
    extract: (f) => f.first_touchdown_lat,
    format: fmt.real6,
  },
  {
    name: "first_touchdown_lon",
    extract: (f) => f.first_touchdown_lon,
    format: fmt.real6,
  },
  {
    name: "first_touchdown_vs_fpm",
    extract: (f) => f.first_touchdown_vs_fpm,
    format: fmt.real1,
  },
  {
    name: "first_touchdown_gforce",
    extract: (f) => f.first_touchdown_gforce,
    format: fmt.real2,
  },
  {
    name: "final_touchdown_lat",
    extract: (f) => f.final_touchdown_lat,
    format: fmt.real6,
  },
  {
    name: "final_touchdown_lon",
    extract: (f) => f.final_touchdown_lon,
    format: fmt.real6,
  },
  {
    name: "final_touchdown_vs_fpm",
    extract: (f) => f.final_touchdown_vs_fpm,
    format: fmt.real1,
  },
  {
    name: "final_touchdown_gforce",
    extract: (f) => f.final_touchdown_gforce,
    format: fmt.real2,
  },
  {
    name: "ultimate_stability_score",
    extract: (f) => f.ultimate_stability_score,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_verdict",
    extract: (f) => f.ultimate_stability_verdict ?? f.ultimateStabilityVerdict,
    format: fmt.str,
  },
  {
    name: "ultimate_stability_samples",
    extract: (f) => f.ultimate_stability_samples,
    format: fmt.int,
  },
  {
    name: "ultimate_stability_gate_stable",
    extract: (f) => f.ultimate_stability_gate_stable ?? f.ultimate_stability_gateStable,
    format: fmt.bool,
  },
  {
    name: "ultimate_stability_gate_failures",
    extract: (f) => {
      const v = f.ultimate_stability_gate_failures ?? f.ultimate_stability_gateFailures;
      if (Array.isArray(v)) return v.join('|');
      return v;
    },
    format: fmt.str,
  },
  {
    name: "ultimate_stability_breakdown",
    extract: (f) => f.ultimate_stability_breakdown ?? null,
    format: fmt.json,
  },
  {
    name: "ultimate_stability_context",
    extract: (f) => f.ultimate_stability_context ?? f.ultimateStabilityContext ?? null,
    format: fmt.json,
  },
  {
    name: "ultimate_stability_gear_ok_pct",
    extract: (f) => f.ultimate_stability_gear_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_flaps_ok_pct",
    extract: (f) => f.ultimate_stability_flaps_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_spoilers_ok_pct",
    extract: (f) => f.ultimate_stability_spoilers_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_config_ok_pct",
    extract: (f) => f.ultimate_stability_config_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_speed_ok_pct",
    extract: (f) => f.ultimate_stability_speed_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_speed_trend_ok_pct",
    extract: (f) => f.ultimate_stability_speed_trend_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_vs_ok_pct",
    extract: (f) => f.ultimate_stability_vs_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_glidepath_ok_pct",
    extract: (f) => f.ultimate_stability_glidepath_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_glidepath_below_ok_pct",
    extract: (f) => f.ultimate_stability_glidepath_below_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_glidepath_above_ok_pct",
    extract: (f) => f.ultimate_stability_glidepath_above_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_thrust_ok_pct",
    extract: (f) => f.ultimate_stability_thrust_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_thrust_not_idle_ok_pct",
    extract: (f) => f.ultimate_stability_thrust_not_idle_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_thrust_stable_ok_pct",
    extract: (f) => f.ultimate_stability_thrust_stable_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_pitch_ok_pct",
    extract: (f) => f.ultimate_stability_pitch_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_bank_ok_pct",
    extract: (f) => f.ultimate_stability_bank_ok_pct,
    format: fmt.real1,
  },
  {
    name: "ultimate_stability_lateral_offset_ok_pct",
    extract: (f) => f.ultimate_stability_lateral_offset_ok_pct,
    format: fmt.real1,
  },
  {
    name: "previous_phase",
    extract: (f) => f.previousPhase ?? f.previous_phase,
    format: fmt.str,
  },
  {
    name: "goaround_altitude_ft",
    extract: (f) => f.goaroundAltitudeFt ?? f.goaround_altitude_ft,
    format: fmt.real1,
  },
  {
    name: "warning_type",
    extract: (f) => f.warningType ?? f.warning_type,
    format: fmt.str,
  },
  {
    name: "warning_active",
    extract: (f) => f.warningActive ?? f.warning_active,
    format: fmt.bool,
  },
  {
    name: "overspeed_type",
    extract: (f) => f.overspeedType ?? f.overspeed_type,
    format: fmt.str,
  },
  {
    name: "barber_pole_kts",
    extract: (f) => f.barberPoleKts ?? f.barber_pole_kts,
    format: fmt.real1,
  },
  {
    name: "warning_duration_ms",
    extract: (f) => f.warningDurationMs ?? f.warning_duration_ms,
    format: fmt.int,
  },
  // ── Flight violation event columns (FLIGHT_VIOLATION_START / END) ─────────
  {
    name: "rule_id",
    extract: (f) => f.rule_id,
    format: fmt.str,
  },
  {
    name: "label",
    extract: (f) => f.label,
    format: fmt.str,
  },
  {
    name: "severity",
    extract: (f) => f.severity,
    format: fmt.str,
  },
  {
    name: "counts_as_upset",
    extract: (f) => f.countsAsUpset ?? f.counts_as_upset,
    format: fmt.bool,
  },
  {
    name: "max_approach_kts",
    extract: (f) => f.maxApproachKts ?? f.max_approach_kts,
    format: fmt.real1,
  },
  {
    name: "approach_overspeed_limit_kts",
    extract: (f) => f.approachOverspeedLimitKts ?? f.approach_overspeed_limit_kts,
    format: fmt.real1,
  },
  {
    name: "approach_overspeed_buffer_kts",
    extract: (f) => f.approachOverspeedBufferKts ?? f.approach_overspeed_buffer_kts,
    format: fmt.real1,
  },
  {
    name: "approach_overspeed_excess_kts",
    extract: (f) => f.approachOverspeedExcessKts ?? f.approach_overspeed_excess_kts,
    format: fmt.real1,
  },
  {
    name: "risk_level",
    extract: (f) => f.risk_level ?? f.riskLevel,
    format: fmt.str,
  },
  {
    name: "confidence_level",
    extract: (f) => f.confidence_level ?? f.confidenceLevel,
    format: fmt.str,
  },
  {
    name: "convective_score",
    extract: (f) => f.convective_score ?? f.convectiveScore,
    format: fmt.real3,
  },
  {
    name: "convective_duration_ms",
    extract: (f) => f.convective_duration_ms ?? f.convectiveDurationMs ?? f.duration_ms,
    format: fmt.int,
  },
  {
    name: "convective_motion_score",
    extract: (f) => f.convective_motion_score ?? f.convectiveMotionScore,
    format: fmt.real3,
  },
  {
    name: "convective_weather_score",
    extract: (f) => f.convective_weather_score ?? f.convectiveWeatherScore,
    format: fmt.real3,
  },
  {
    name: "convective_weather_available",
    extract: (f) => f.convective_weather_available ?? f.convectiveWeatherAvailable,
    format: fmt.bool,
  },
  {
    name: "convective_weather_aligned",
    extract: (f) => f.convective_weather_aligned ?? f.convectiveWeatherAligned,
    format: fmt.bool,
  },
  {
    name: "convective_peak_load_excursion_g",
    extract: (f) => f.convective_peak_load_excursion_g ?? f.convectivePeakLoadExcursionG,
    format: fmt.real3,
  },
  {
    name: "convective_avg_load_excursion_g",
    extract: (f) => f.convective_avg_load_excursion_g ?? f.convectiveAvgLoadExcursionG,
    format: fmt.real3,
  },
  {
    name: "convective_peak_load_jerk_gps",
    extract: (f) => f.convective_peak_load_jerk_gps ?? f.convectivePeakLoadJerkGps,
    format: fmt.real3,
  },
  {
    name: "convective_peak_pitch_rate_dps",
    extract: (f) => f.convective_peak_pitch_rate_dps ?? f.convectivePeakPitchRateDps,
    format: fmt.real1,
  },
  {
    name: "convective_peak_roll_rate_dps",
    extract: (f) => f.convective_peak_roll_rate_dps ?? f.convectivePeakRollRateDps,
    format: fmt.real1,
  },
  {
    name: "convective_peak_yaw_rate_dps",
    extract: (f) => f.convective_peak_yaw_rate_dps ?? f.convectivePeakYawRateDps,
    format: fmt.real1,
  },
  {
    name: "convective_peak_pitch_deg",
    extract: (f) => f.convective_peak_pitch_deg ?? f.convectivePeakPitchDeg,
    format: fmt.real1,
  },
  {
    name: "convective_peak_bank_deg",
    extract: (f) => f.convective_peak_bank_deg ?? f.convectivePeakBankDeg,
    format: fmt.real1,
  },
  {
    name: "convective_maneuver_ratio",
    extract: (f) => f.convective_maneuver_ratio ?? f.convectiveManeuverRatio,
    format: fmt.real3,
  },
  {
    name: "convective_maneuver_suppressed",
    extract: (f) => f.convective_maneuver_suppressed ?? f.convectiveManeuverSuppressed,
    format: fmt.bool,
  },
  {
    name: "convective_vertical_reversals",
    extract: (f) => f.convective_vertical_reversals ?? f.convectiveVerticalReversals,
    format: fmt.int,
  },
  {
    name: "convective_vertical_reversal_rate_per_min",
    extract: (f) => f.convective_vertical_reversal_rate_per_min ?? f.convectiveVerticalReversalRatePerMin,
    format: fmt.real2,
  },
  {
    name: "convective_vertical_speed_activity_score",
    extract: (f) => f.convective_vertical_speed_activity_score ?? f.convectiveVerticalSpeedActivityScore,
    format: fmt.real3,
  },
  {
    name: "convective_ias_range_kts",
    extract: (f) => f.convective_ias_range_kts ?? f.convectiveIasRangeKts,
    format: fmt.real1,
  },
  {
    name: "convective_vs_range_fpm",
    extract: (f) => f.convective_vs_range_fpm ?? f.convectiveVsRangeFpm,
    format: fmt.real1,
  },
  {
    name: "convective_in_cloud_ratio",
    extract: (f) => f.convective_in_cloud_ratio ?? f.convectiveInCloudRatio,
    format: fmt.real3,
  },
  {
    name: "convective_precip_ratio",
    extract: (f) => f.convective_precip_ratio ?? f.convectivePrecipRatio,
    format: fmt.real3,
  },
  {
    name: "convective_precip_rate_max_mm",
    extract: (f) => f.convective_precip_rate_max_mm ?? f.convectivePrecipRateMaxMm,
    format: fmt.real2,
  },
  {
    name: "convective_density_alt_ft",
    extract: (f) => f.convective_density_alt_ft ?? f.convectiveDensityAltFt,
    format: fmt.int,
  },
  {
    name: "convective_sample_count",
    extract: (f) => f.convective_sample_count ?? f.convectiveSampleCount,
    format: fmt.int,
  },
  {
    name: "duration_ms",
    extract: (f) => f.duration_ms,
    format: fmt.int,
  },
];


// ═══════════════════════════════════════════════════════════════════════════
// Build Index for fast lookup
// ═══════════════════════════════════════════════════════════════════════════

const FIELD_BY_NAME = new Map<string, FieldDef>(FIELD_MAP.map((f): [string, FieldDef] => [f.name, f]));

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get column names for V1 CSV output.
 * @returns {string[]}
 */
function getV1Columns(): string[] {
  return FIELD_MAP.map((f) => f.name);
}

/**
 * Build a row object for V1 CSV output.
 * @param {Object} frame - The telemetry frame
 * @returns {Object} Row object with column:value pairs
 */
function buildRow(frame: FrameRecord): FieldRow {
  const row: FieldRow = {};
  
  for (const col of FIELD_MAP) {
    const value = col.extract(frame);
    row[col.name] = col.format(value);
  }
  
  return row;
}

/**
 * Get a specific field definition.
 * @param {string} name 
 * @returns {FieldDef|undefined}
 */
function getField(name: string): FieldDef | undefined {
  return FIELD_BY_NAME.get(name);
}

module.exports = {
  FIELD_MAP,
  getV1Columns,
  buildRow,
  getField,
  fmt,
};

export {};
