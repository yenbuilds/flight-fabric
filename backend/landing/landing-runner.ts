// landing-runner.js
// Encapsulates touchdown detection, grading, and logging.
// Preserves behavior by mirroring WOW transition logic and payloads.

// This module emits 'landing:touchdown' events via eventBus.
// Subscribers write to their respective stores.

const config = require('../core/config') as ConfigModule;
const { gradeLandingForProfile, buildLandingRateScoringContext } = require('./landing') as LandingModule;
const { makeFlapsObj } = require('../aircraft/flaps') as FlapsModule;
const { computeCrosswind } = require('../utils/helpers') as HelpersModule;
const Debug = require('../core/debug') as DebugModule;
const { msToFpm, metersToFeet } = require('../utils/units') as UnitsModule;
const timeSource = require('../core/time-source') as TimeSourceModule;
const { getUserId, getSessionId } = require('../utils/user-identity') as UserIdentityModule;
const eventBus = require('../core/event-bus') as EventBusModule;
const { getEffectivePhaseThresholds } = require('../lifecycle/phase') as {
  getEffectivePhaseThresholds: () => {
    taxi_in_max_kts?: number;
  };
};
const {
  deriveTrueHeadingFromMagnetic,
  finiteNumberOrNull,
  firstFiniteNumber,
  getAircraftTrueHeadingDeg,
  getRunwayTrueHeadingDeg,
  normalizeHeadingDegrees,
  roundedHeadingDifferenceDegrees,
} = require('../utils/aviation-frames') as AviationFramesModule;

// Touchdown distance calculation
const { findNearbyAirport, findRunwayByPosition, getRunway } = require('./airport-geometry-service') as AirportGeometryServiceModule;
const { scoreBounce, TOUCHDOWN_ZONE_MAX_FT } = require('./landing-distance') as LandingDistanceModule;
const {
  buildDefaultTouchdownDistanceData,
  buildTouchdownRunwayAnalysis,
  isTakeoffSettlingTouchdown,
} = require('../analysis/flight-analysis') as FlightAnalysisModule;
const {
  analyzeRollout,
  ROLLOUT_ANALYSIS_LIMITS,
} = require('./rollout-analysis.js') as {
  analyzeRollout: (samples: AnyRecord[], context?: AnyRecord) => AnyRecord | null;
  ROLLOUT_ANALYSIS_LIMITS: {
    maxSamples: number;
    maxWindowMs: number;
  };
};
const { assessRecordedBounceEvidence } = require('./landing-replay-analysis.js') as {
  assessRecordedBounceEvidence: (
    _evidence: {
      airborneDurationMs?: number | null;
      altitudeLiftFt?: number | null;
      impactLoadG?: number | null;
      maxUpwardVsFpm?: number | null;
      radioHeightLiftFt?: number | null;
      recontactVsFpm?: number | null;
    },
    _gradeFromVs: (_vsFpm: number) => string | null,
    _options?: { minUpwardVsFpm?: number | null },
  ) => AnyRecord;
};

type AnyRecord = Record<string, any>;
type BroadcastFn = (payload: AnyRecord) => void;
type TimeContext = {
  nowEpochMs?: number;
  nowIso?: string;
  flightStartEpochMs?: number | null;
  flightStartIso?: string;
};
type LandingRunnerContext = AnyRecord & {
  phase?: string | null;
  xwind_kts?: number | null;
  stability?: AnyRecord | null;
};
type LandingRunner = {
  update: (frame: AnyRecord, broadcast?: BroadcastFn | null, timeCtx?: TimeContext, ctx?: LandingRunnerContext) => void;
  reset: () => void;
  isRolloutActive: () => boolean;
};
type ConfigModule = {
  landing: {
    rolloutWindowMs: number;
    touchdownCooldownMs: number;
    touchdownPreSampleWindowMs: number;
    touchdownMinIasKts: number;
    touchdownMinVsFpm?: number;
    touchdownMinAirborneRaFt?: number;
    minAirbornePeakRaFt?: number;
  };
  telemetry: {
    schemaVersion: number;
  };
};
type LandingModule = {
  buildLandingRateScoringContext: (profileId: unknown) => AnyRecord;
  gradeLandingForProfile: (vsFpm: number, profileId: unknown) => AnyRecord;
};
type HelpersModule = {
  computeCrosswind: (windSpeed: number, windDirDeg: number, headingDeg: number) => number | null;
};
type FlapsModule = {
  makeFlapsObj: (...args: unknown[]) => AnyRecord | null;
};
type DebugModule = {
  log: (section: string, message: string, data?: AnyRecord) => void;
};
type UnitsModule = {
  msToFpm: (value: number) => number;
  metersToFeet: (value: number) => number;
};
type TimeSourceModule = {
  now: () => number;
};
type UserIdentityModule = {
  getUserId: () => string | null;
  getSessionId: () => string | null;
};
type EventBusModule = {
  emit: (eventName: string, payload: AnyRecord) => void;
};
type AviationFramesModule = {
  deriveTrueHeadingFromMagnetic: (magneticHeadingDeg: unknown, magvarDeg: unknown) => number | null;
  finiteNumberOrNull: (value: unknown) => number | null;
  firstFiniteNumber: (...values: unknown[]) => number | null;
  getAircraftTrueHeadingDeg: (input: AnyRecord | null | undefined) => number | null;
  getRunwayTrueHeadingDeg: (input: AnyRecord | null | undefined) => number | null;
  normalizeHeadingDegrees: (value: unknown) => number | null;
  roundedHeadingDifferenceDegrees: (
    leftHeadingDeg: unknown,
    rightHeadingDeg: unknown,
    precision?: number,
  ) => number | null;
};
type AirportGeometryServiceModule = {
  findNearbyAirport: (...args: unknown[]) => AnyRecord | null;
  findRunwayByPosition: (...args: unknown[]) => AnyRecord | null;
  getRunway: (icao: string, runwayId: string, context?: AnyRecord) => AnyRecord | null;
};
type LandingDistanceModule = {
  scoreBounce: (bounceData: AnyRecord) => AnyRecord;
  TOUCHDOWN_ZONE_MAX_FT: number;
};
type FlightAnalysisModule = {
  buildDefaultTouchdownDistanceData: (bounceScoring?: AnyRecord) => AnyRecord;
  buildTouchdownRunwayAnalysis: (input: AnyRecord) => {
    touchdownDistanceData: AnyRecord;
    shortLandingDetected: boolean;
    tdzAchieved: boolean;
  };
  isTakeoffSettlingTouchdown: (input: AnyRecord) => boolean;
};

// Configuration from centralized config.js
const ROLLOUT_WINDOW_MS = config.landing.rolloutWindowMs;
const RUNWAY_OCCUPANCY_MAX_WAIT_MS = 60_000;
const TOUCHDOWN_COOLDOWN_MS = config.landing.touchdownCooldownMs;
const MSFS_TOUCHDOWN_MAX_POSITION_DELTA_FT = 1500;
const MSFS_TOUCHDOWN_MAX_ATTITUDE_DEG = 90;
const BOUNCE_POST_IMPACT_CONFIRMATION_MS = 1000;

// Touchdown stability scoring is intentionally disabled.
// Keep touchdown-rate grading and the separate landing facts (G-force/runway
// excursion) independent from stability scoring.

function getRunwayComparisonHeading(touchdownSummary: AnyRecord): number | null {
  return getAircraftTrueHeadingDeg(touchdownSummary);
}

function buildAirportGeometryContext(ctx: LandingRunnerContext | null | undefined): AnyRecord {
  const dataSource = typeof ctx?.dataSource === 'string' ? ctx.dataSource : null;
  const simulator = typeof ctx?.simulator === 'string' ? ctx.simulator : dataSource;
  return { simulator, dataSource };
}

function isValidLatLon(lat: unknown, lon: unknown): boolean {
  const latNum = finiteNumberOrNull(lat);
  const lonNum = finiteNumberOrNull(lon);
  return latNum != null && lonNum != null && Math.abs(latNum) <= 90 && Math.abs(lonNum) <= 180;
}

function distanceFtBetweenLatLon(a: { lat: unknown; lon: unknown }, b: { lat: unknown; lon: unknown }): number | null {
  const latA = finiteNumberOrNull(a.lat);
  const lonA = finiteNumberOrNull(a.lon);
  const latB = finiteNumberOrNull(b.lat);
  const lonB = finiteNumberOrNull(b.lon);
  if (latA == null || lonA == null || latB == null || lonB == null) return null;

  const meanLatRad = ((latA + latB) / 2) * Math.PI / 180;
  const feetPerDegLat = 364000;
  const feetPerDegLon = feetPerDegLat * Math.cos(meanLatRad);
  const dLatFt = (latA - latB) * feetPerDegLat;
  const dLonFt = (lonA - lonB) * feetPerDegLon;
  return Math.sqrt(dLatFt * dLatFt + dLonFt * dLonFt);
}

function getMsfsTouchdownSnapshot(frame: AnyRecord | null | undefined): AnyRecord | null {
  const td = frame?.simconnect?.touchdown;
  if (!td || typeof td !== 'object') return null;

  const normalVelocityFps = finiteNumberOrNull(td.normalVelocityFps);
  const rawNormalVelocityFpm = finiteNumberOrNull(td.normalVelocityFpm) ?? (
    normalVelocityFps == null ? null : normalVelocityFps * 60
  );
  // Preserve the simulator-normal rate for telemetry diagnostics only. It is a
  // different quantity from the conventional V/S headline and must not affect
  // snapshot selection, landing grading, bounce detection, or history.
  const landingVsFpm = rawNormalVelocityFpm == null ? null : -Math.abs(rawNormalVelocityFpm);

  return {
    source: 'msfs_last_touchdown',
    latDeg: finiteNumberOrNull(td.latDeg),
    lonDeg: finiteNumberOrNull(td.lonDeg),
    headingTrueDeg: normalizeHeadingDegrees(td.headingTrueDeg),
    headingMagDeg: normalizeHeadingDegrees(td.headingMagDeg),
    pitchDeg: finiteNumberOrNull(td.pitchDeg),
    bankDeg: finiteNumberOrNull(td.bankDeg),
    normalVelocityFps,
    normalVelocityFpm: rawNormalVelocityFpm,
    landingVsFpm,
  };
}

function getMsfsTouchdownSignature(frame: AnyRecord | null | undefined): string | null {
  const td = getMsfsTouchdownSnapshot(frame);
  if (!td) return null;

  const parts = [
    td.latDeg,
    td.lonDeg,
    td.headingTrueDeg,
    td.headingMagDeg,
    td.pitchDeg,
    td.bankDeg,
  ];
  if (!parts.some((value) => value != null)) return null;
  return parts
    .map((value) => value == null ? '' : Number(value).toFixed(6))
    .join('|');
}

function resolveMsfsTouchdownSnapshot(input: {
  frame: AnyRecord;
  currentPosition: { lat_deg: number | null; lon_deg: number | null };
  lastAirborneSignature: string | null;
}): AnyRecord {
  const td = getMsfsTouchdownSnapshot(input.frame);
  const base = {
    trusted: false,
    fresh: false,
    rejectReason: null as string | null,
    positionDeltaFt: null as number | null,
    data: td,
  };

  if (!td) return { ...base, rejectReason: 'missing' };

  const signature = getMsfsTouchdownSignature(input.frame);
  const fresh = signature != null && (
    input.lastAirborneSignature == null || signature !== input.lastAirborneSignature
  );
  const result = { ...base, fresh };

  if (!fresh) return { ...result, rejectReason: 'stale' };
  if (!isValidLatLon(td.latDeg, td.lonDeg)) return { ...result, rejectReason: 'invalid_position' };

  const positionDeltaFt = distanceFtBetweenLatLon(
    { lat: td.latDeg, lon: td.lonDeg },
    { lat: input.currentPosition.lat_deg, lon: input.currentPosition.lon_deg },
  );
  if (positionDeltaFt == null || positionDeltaFt > MSFS_TOUCHDOWN_MAX_POSITION_DELTA_FT) {
    return { ...result, positionDeltaFt, rejectReason: 'position_mismatch' };
  }

  if (td.pitchDeg != null && Math.abs(td.pitchDeg) > MSFS_TOUCHDOWN_MAX_ATTITUDE_DEG) {
    return { ...result, positionDeltaFt, rejectReason: 'invalid_pitch' };
  }
  if (td.bankDeg != null && Math.abs(td.bankDeg) > MSFS_TOUCHDOWN_MAX_ATTITUDE_DEG) {
    return { ...result, positionDeltaFt, rejectReason: 'invalid_bank' };
  }
  return {
    ...result,
    trusted: true,
    positionDeltaFt,
    rejectReason: null,
  };
}

/**
 * Build a canonical landing event payload for event bus emission.
 * 
 * This is the SINGLE SOURCE OF TRUTH for landing event field mapping.
 * Downstream consumers (CSV + analytics/event subscribers) consume this payload.
 * 
 * @param {Object} input - Landing payload input
 * @returns {Object} Canonical landing event payload (snake_case field names)
 */
function cloneAssistSnapshot(assists: unknown): AnyRecord | null {
  if (!assists || typeof assists !== 'object') return null;
  return { ...(assists as AnyRecord) };
}

function buildAssistCsvFields(assists: AnyRecord | null): AnyRecord {
  return {
    assist_unlimited_fuel: assists?.unlimitedFuel ?? null,
    assist_landing_enabled: assists?.landingAssist ?? null,
    assist_takeoff_enabled: assists?.takeoffAssist ?? null,
    assist_ai_controls: assists?.aiControls ?? null,
    assist_ai_autotrim: assists?.aiAutotrim ?? null,
    assist_ai_delegated: assists?.aiDelegated ?? null,
    assist_ai_antistall_state: assists?.aiAntistall ?? null,
    assist_ai_antistall_active: assists?.aiAntistallActive ?? null,
    assist_realism_pct: assists?.realismPercent ?? null,
    assist_full_realism: assists?.fullRealism ?? null,
    assist_slew_active: assists?.slewActive ?? null,
    assist_any_active: assists?.anyAssistActive ?? null,
  };
}

function buildLandingPayload(input: AnyRecord): AnyRecord {
  const {
    touchdownSummary,
    ctx = {},
    finalGrade = {},
    touchdownDistanceData = {},
    runwayData = null,
    runwayReferenceData = runwayData,
    nowEpochMs,
    nowIso,
    timeCtx = {},
    phase,
    excursionDetected,
    userId,
    sessionId,
    schemaVersion = 3,
  } = input;

  const ts = touchdownSummary || {};
  const tdd = touchdownDistanceData || {};
  const rwy = runwayData || {};
  const rwyReference = runwayReferenceData || runwayData || {};
  const runwayReferenceElevFt = finiteNumberOrNull(rwyReference.elevation_ft);
  const runwayReferenceElevationSource = runwayReferenceElevFt === null
    ? null
    : (typeof rwyReference.source === 'string' ? rwyReference.source : null);
  const runwayReferenceElevationKind = runwayReferenceElevFt === null
    ? null
    : (
      typeof rwyReference.elevationReference === 'string'
        ? rwyReference.elevationReference
        : (rwyReference.source === 'msfs-facilities' ? 'runway' : 'airport')
    );
  const assists = cloneAssistSnapshot(ts.assists ?? input.assists);

  // Calculate flight elapsed time
  const flightElapsedMs = (timeCtx.flightStartEpochMs && nowEpochMs)
    ? Math.max(0, nowEpochMs - timeCtx.flightStartEpochMs)
    : null;
  const ultimateStabilityGateStable = normalizeBooleanLike(
    ts.ultimate_stability_gate_stable ?? ts.ultimate_stability_gateStable,
  );

  return {
    // Identity (schema v2)
    schema_version: schemaVersion,
    user_id: userId ?? null,
    session_id: sessionId ?? null,

    // Timestamps
    timestamp_utc: nowIso ?? null,
    timestamp_ms: nowEpochMs ?? null,
    flight_start: timeCtx.flightStartIso ?? null,
    flight_elapsed_ms: flightElapsedMs,

    // Aircraft & location
    aircraft: ts.aircraft || ctx.aircraftName || 'Unknown Aircraft',
    sim_version: ctx.simVersion ?? null,
    aircraft_profile_id: ts.aircraft_profile_id ?? ctx.aircraftProfileId ?? null,
    data_source: ctx.dataSource ?? null,
    assists,
    ...buildAssistCsvFields(assists),
    icao: tdd.runway_icao || rwy.icao || rwyReference.icao || ctx.icao || null,
    runway: tdd.runway_id || rwy.runway || rwy.runwayId || ctx.runway || null,
    approach_type: ctx.approachType || null,

    // Core landing metrics
    vs_fpm: ts.vs_fpm ?? null,
    ias_kts: ts.ias_kts ?? null,
    gs_kts: ts.gs_kts ?? null,
    grade: finalGrade.grade ?? null,
    landing_rate_context: ts.landing_rate_context ?? ts.landingRateContext ?? null,
    gforce: ts.gforce ?? null,

    // Position at touchdown
    lat_deg: ts.lat_deg ?? null,
    lon_deg: ts.lon_deg ?? null,
    hdg_true_deg: ts.hdg_true_deg ?? null,
    hdg_mag_deg: ts.hdg_mag_deg ?? null,
    magvar_deg: ts.magvar_deg ?? null,
    alt_msl_ft: ts.alt_msl_ft ?? null,
    alt_indicated_ft: ts.alt_indicated_ft ?? ts.alt_msl_ft ?? null,
    alt_calibrated_ft: ts.alt_calibrated_ft ?? null,
    alt_plane_ft: ts.alt_plane_ft ?? null,
    ra_ft: ts.ra_ft ?? null,
    aircraft_agl_ft: ts.aircraft_agl_ft ?? null,
    aircraft_above_obstacles_ft: ts.aircraft_above_obstacles_ft ?? null,
    plane_agl_ft: ts.plane_agl_ft ?? null,
    plane_agl_minus_cg_ft: ts.plane_agl_minus_cg_ft ?? null,
    pressure_alt_ft: ts.pressure_alt_ft ?? null,
    kohlsman_setting_mb: ts.kohlsman_setting_mb ?? null,
    kohlsman_tuned_mb: ts.kohlsman_tuned_mb ?? null,
    kohlsman_std: ts.kohlsman_std ?? null,

    // Weather at touchdown
    wind_speed_kts: ts.wind_speed_kts ?? null,
    wind_dir_deg: ts.wind_dir_deg ?? null,
    xwind_kts: ts.xwind_kts ?? null,

    // Attitude at touchdown
    pitch_deg: ts.pitch_deg ?? null,
    bank_deg: ts.bank_deg ?? null,
    touchdown_capture_source: ts.touchdown_capture_source ?? null,
    td_sim_source: ts.td_sim_source ?? null,
    td_sim_trusted: ts.td_sim_trusted ?? null,
    td_sim_fresh: ts.td_sim_fresh ?? null,
    td_sim_reject_reason: ts.td_sim_reject_reason ?? null,
    td_sim_position_delta_ft: ts.td_sim_position_delta_ft ?? null,
    td_sim_lat_deg: ts.td_sim_lat_deg ?? null,
    td_sim_lon_deg: ts.td_sim_lon_deg ?? null,
    td_sim_hdg_true_deg: ts.td_sim_hdg_true_deg ?? null,
    td_sim_hdg_mag_deg: ts.td_sim_hdg_mag_deg ?? null,
    td_sim_pitch_deg: ts.td_sim_pitch_deg ?? null,
    td_sim_bank_deg: ts.td_sim_bank_deg ?? null,
    td_sim_normal_velocity_fps: ts.td_sim_normal_velocity_fps ?? null,
    td_sim_normal_velocity_fpm: ts.td_sim_normal_velocity_fpm ?? null,
    td_sim_landing_vs_fpm: ts.td_sim_landing_vs_fpm ?? null,

    // Configuration at touchdown
    flaps_notch: ts.flaps_notch ?? null,
    spoiler_state: ts.spoiler_state ?? null,

    // Phase & stability
    phase: phase ?? null,
    stability: ts.stability ?? null,
    stability_score: null, // Not captured at touchdown time

    // Ultimate stability (retrospective)
    ultimate_stability_score: ts.ultimate_stability_score ?? null,
    ultimate_stability_verdict: ts.ultimate_stability_verdict ?? ts.ultimateStabilityVerdict ?? null,
    ultimate_stability_samples: ts.ultimate_stability_samples ?? null,
    ultimate_stability_gate_stable: ultimateStabilityGateStable,
    ultimate_stability_gate_failures: ts.ultimate_stability_gateFailures ?? null,
    ultimate_stability_breakdown: ts.ultimate_stability_breakdown ?? null,
    ultimate_stability_context: ts.ultimate_stability_context ?? ts.ultimateStabilityContext ?? null,
    ultimate_stability_gear_ok_pct: ts.ultimate_stability_gear_ok_pct ?? null,
    ultimate_stability_flaps_ok_pct: ts.ultimate_stability_flaps_ok_pct ?? null,
    ultimate_stability_spoilers_ok_pct: ts.ultimate_stability_spoilers_ok_pct ?? null,
    ultimate_stability_config_ok_pct: ts.ultimate_stability_config_ok_pct ?? null,
    ultimate_stability_speed_ok_pct: ts.ultimate_stability_speed_ok_pct ?? null,
    ultimate_stability_speed_trend_ok_pct: ts.ultimate_stability_speed_trend_ok_pct ?? null,
    ultimate_stability_vs_ok_pct: ts.ultimate_stability_vs_ok_pct ?? null,
    ultimate_stability_glidepath_ok_pct: ts.ultimate_stability_glidepath_ok_pct ?? null,
    ultimate_stability_glidepath_below_ok_pct: ts.ultimate_stability_glidepath_below_ok_pct ?? null,
    ultimate_stability_glidepath_above_ok_pct: ts.ultimate_stability_glidepath_above_ok_pct ?? null,
    ultimate_stability_thrust_ok_pct: ts.ultimate_stability_thrust_ok_pct ?? null,
    ultimate_stability_thrust_not_idle_ok_pct: ts.ultimate_stability_thrust_not_idle_ok_pct ?? null,
    ultimate_stability_thrust_stable_ok_pct: ts.ultimate_stability_thrust_stable_ok_pct ?? null,
    ultimate_stability_pitch_ok_pct: ts.ultimate_stability_pitch_ok_pct ?? null,
    ultimate_stability_bank_ok_pct: ts.ultimate_stability_bank_ok_pct ?? null,
    ultimate_stability_lateral_offset_ok_pct: ts.ultimate_stability_lateral_offset_ok_pct ?? null,

    // Surface data (snake_case - canonical names)
    surface_raw: ts.surface_raw ?? null,
    surface_name: ts.surface_name ?? null,
    surface_class: ts.surface_class ?? null,
    surface_runway_like: ts.surface_runway_like ?? null,
    surface_on_runway: ts.surface_on_runway ?? null,
    surface_on_ground: ts.surface_on_ground ?? true,
    surface_valid: ts.surface_valid ?? (ts.surface_class != null),
    runway_excursion: !!excursionDetected,
    runway_occupancy_s: ts.runway_occupancy_s ?? null,
    rollout_analysis: ts.rolloutAnalysis ?? ts.rollout_analysis ?? null,
    landing_final: true,
    fdm_surface_condition: ts.fdm_surface_condition ?? null,
    fdm_precip_state: ts.fdm_precip_state ?? null,
    fdm_precip_rate_mm: ts.fdm_precip_rate_mm ?? null,
    fdm_oat_c: ts.fdm_oat_c ?? null,

    // Touchdown distance (runway overrun analysis)
    touchdown_distance_ft: tdd.touchdown_distance_ft ?? null,
    runway_geometry_source: tdd.runway_geometry_source ?? rwy.source ?? null,
    runway_geometry_provider_chain: tdd.runway_geometry_provider_chain
      ?? rwy.runway_geometry_provider_chain
      ?? rwy.runwayGeometryProviderChain
      ?? null,
    runway_geometry_fallback_reason: tdd.runway_geometry_fallback_reason
      ?? rwy.runway_geometry_fallback_reason
      ?? rwy.runwayGeometryFallbackReason
      ?? null,
    runway_geometry_diagnostics: tdd.runway_geometry_diagnostics
      ?? rwy.runway_geometry_diagnostics
      ?? rwy.runwayGeometryDiagnostics
      ?? null,
    runway_reference_elev_ft: runwayReferenceElevFt,
    runway_reference_elevation_source: runwayReferenceElevationSource,
    runway_reference_elevation_kind: runwayReferenceElevationKind,
    runway_heading_true_deg: tdd.runway_heading_true_deg ?? getRunwayTrueHeadingDeg(rwy),
    runway_length_ft: tdd.runway_length_ft ?? rwy.lengthFt ?? null,
    runway_physical_length_ft: tdd.runway_physical_length_ft ?? rwy.physicalLengthFt ?? null,
    runway_surface: tdd.runway_surface ?? rwy.surface ?? null,
    runway_threshold_lat: tdd.runway_threshold_lat ?? rwy.threshold?.lat ?? null,
    runway_threshold_lon: tdd.runway_threshold_lon ?? rwy.threshold?.lon ?? null,
    runway_physical_threshold_lat: tdd.runway_physical_threshold_lat ?? rwy.physicalThreshold?.lat ?? null,
    runway_physical_threshold_lon: tdd.runway_physical_threshold_lon ?? rwy.physicalThreshold?.lon ?? null,
    runway_displaced_threshold_ft: tdd.runway_displaced_threshold_ft ?? rwy.displacedThresholdFt ?? null,
    touchdown_distance_score: tdd.touchdown_distance_score ?? null,
    touchdown_distance_grade: tdd.touchdown_distance_grade ?? null,
    short_landing: tdd.short_landing ?? tdd.shortLanding ?? null,
    runway_condition: tdd.runway_condition ?? null,
    runway_condition_source: tdd.runway_condition_source ?? null,
    runway_condition_confident: tdd.runway_condition_confident ?? null,

    // Lateral offset scoring (V1.1)
    lateral_offset_ft: tdd.lateral_offset_ft ?? null,
    lateral_offset_side: tdd.lateral_offset_side ?? null,
    lateral_offset_score: tdd.lateral_offset_score ?? null,
    lateral_offset_grade: tdd.lateral_offset_grade ?? null,
    lateral_offset_suspect: tdd.lateral_offset_suspect ?? null,
    runway_width_ft: tdd.runway_width_ft ?? rwy.widthFt ?? null,

    // Bounce scoring (V1.1)
    bounce_score: tdd.bounce_score ?? null,
    bounce_grade: tdd.bounce_grade ?? null,
    bounce_distance_ft: tdd.bounce_distance_ft ?? null,
    bounce_worst_gforce: tdd.bounce_worst_gforce ?? null,

    // Bounce tracking data (raw data, not scoring)
    bounce_count: ts.bounceCount ?? 0,
    first_touchdown_lat: ts.firstTouchdown?.lat ?? null,
    first_touchdown_lon: ts.firstTouchdown?.lon ?? null,
    first_touchdown_vs_fpm: ts.firstTouchdown?.vs_fpm ?? null,
    first_touchdown_gforce: ts.firstTouchdown?.gforce ?? null,
    final_touchdown_lat: ts.finalTouchdown?.lat ?? null,
    final_touchdown_lon: ts.finalTouchdown?.lon ?? null,
    final_touchdown_vs_fpm: ts.finalTouchdown?.vs_fpm ?? null,
    final_touchdown_gforce: ts.finalTouchdown?.gforce ?? null,

    // Color for UI (not stored in database, but useful for WS broadcast)
    _ui_color: finalGrade.color ?? null,
  };
}

function isOnRunwaySurface(surface: AnyRecord | null | undefined): boolean {
  if (!surface || !surface.onGround) return false;
  if (typeof surface.onRunway === 'boolean') return surface.onRunway;
  return surface.runwayLike === true;
}

function getSurfaceClass(surface: AnyRecord | null | undefined): string {
  return String(surface?.class || surface?.surfaceClass || '').trim().toUpperCase();
}

function isLikelyRunwayExcursionSurface(surface: AnyRecord | null | undefined): boolean {
  const surfaceClass = getSurfaceClass(surface);
  return surfaceClass === 'UNPAVED' || surfaceClass === 'WATER';
}

// Touchdown snapshots are captured once at the WOW transition. Early HUD
// broadcasts, final rollout scoring, and CSV/event payloads reuse these helpers
// so touchdown-time values do not get mixed with later rollout frames.
function getTouchdownPosition(frame: AnyRecord): { lat_deg: number | null; lon_deg: number | null } {
  return {
    lat_deg: (frame.simconnect && typeof frame.simconnect.lat === 'number')
      ? frame.simconnect.lat
      : (typeof frame.lat === 'number' ? frame.lat : null),
    lon_deg: (frame.simconnect && typeof frame.simconnect.lon === 'number')
      ? frame.simconnect.lon
      : (typeof frame.lon === 'number' ? frame.lon : null),
  };
}

function getTouchdownHeading(frame: AnyRecord, ctx: LandingRunnerContext): {
  hdg_true_deg: number | null;
  hdg_mag_deg: number | null;
  magvar_deg: number | null;
} {
  const simconnect = frame.simconnect || {};
  const hdgTrueDeg = normalizeHeadingDegrees(firstFiniteNumber(
    simconnect.hdgTrueDeg,
    ctx.computedHdgTrueDeg,
  ));
  const hdgMagDeg = normalizeHeadingDegrees(firstFiniteNumber(
    simconnect.hdgMagDeg,
    ctx.computedHdgMagDeg,
  ));
  const magvarDeg = firstFiniteNumber(
    simconnect.magvarDeg,
    frame.magvar,
    ctx.computedMagvarDeg,
    ctx.magvarDeg,
    ctx.magvar,
  );

  return {
    hdg_true_deg: hdgTrueDeg ?? deriveTrueHeadingFromMagnetic(hdgMagDeg, magvarDeg),
    hdg_mag_deg: hdgMagDeg,
    magvar_deg: magvarDeg,
  };
}

function getTouchdownAttitude(frame: AnyRecord): { pitch_deg: number | null; bank_deg: number | null } {
  return {
    pitch_deg: (frame.attitudeDebug && typeof frame.attitudeDebug.pitchDegPrimary === 'number')
      ? frame.attitudeDebug.pitchDegPrimary
      : null,
    bank_deg: (frame.attitudeDebug && typeof frame.attitudeDebug.bankDegPrimary === 'number')
      ? frame.attitudeDebug.bankDegPrimary
      : null,
  };
}

function getTouchdownConfiguration(frame: AnyRecord): { flaps_notch: number | null; spoiler_state: string | null } {
  return {
    flaps_notch: makeFlapsObj(frame.flaps, frame.flapsIndex, frame.flapsAngleDeg)?.notch ?? null,
    spoiler_state: (frame.spoilers && frame.spoilers.state) ? frame.spoilers.state : null,
  };
}

function getTouchdownSurfaceSnapshot(surface: AnyRecord | null | undefined): AnyRecord {
  return {
    surface_raw: surface && typeof surface.raw === 'number' ? surface.raw : null,
    surface_name: surface && surface.name != null ? String(surface.name) : null,
    surface_class: surface && surface.class != null ? String(surface.class) : null,
    surface_runway_like: surface && typeof surface.runwayLike === 'boolean' ? surface.runwayLike : null,
    surface_on_runway: surface && typeof surface.onRunway === 'boolean' ? surface.onRunway : null,
    surface_on_ground: surface && typeof surface.onGround === 'boolean' ? surface.onGround : true,
    surface_valid: surface && typeof surface.valid === 'boolean' ? surface.valid : null,
  };
}

function getFdmSurfaceSnapshot(frame: AnyRecord): AnyRecord {
  const fdm = frame.fdm || {};
  return {
    fdm_surface_condition: fdm.surfaceCondition != null ? fdm.surfaceCondition : null,
    fdm_xplane_runway_friction: fdm.xplaneRunwayFriction != null ? fdm.xplaneRunwayFriction : null,
    fdm_precip_state: fdm.precipState != null ? fdm.precipState : null,
    fdm_precip_rate_mm: fdm.precipRateMm != null ? fdm.precipRateMm : null,
    fdm_oat_c: fdm.oatC != null ? fdm.oatC : null,
  };
}

function captureTouchdownSnapshot(input: {
  frame: AnyRecord;
  ctx: LandingRunnerContext;
  surface: AnyRecord | null | undefined;
  gs: unknown;
  xwindKts: unknown;
  phaseAtTouchdown: string;
  lastAirborneSimTouchdownSignature: string | null;
}): AnyRecord {
  const { frame, ctx, surface, gs, xwindKts, phaseAtTouchdown, lastAirborneSimTouchdownSignature } = input;
  const position = getTouchdownPosition(frame);
  const heading = getTouchdownHeading(frame, ctx);
  const attitude = getTouchdownAttitude(frame);
  const msfsTouchdown = resolveMsfsTouchdownSnapshot({
    frame,
    currentPosition: position,
    lastAirborneSignature: lastAirborneSimTouchdownSignature,
  });
  const td = msfsTouchdown.data || {};
  const altitudeFdm = frame.fdm || {};
  const useMsfs = msfsTouchdown.trusted === true;
  const hdgMagDeg = useMsfs && td.headingMagDeg != null ? td.headingMagDeg : heading.hdg_mag_deg;
  const hdgTrueDeg = (useMsfs && td.headingTrueDeg != null ? td.headingTrueDeg : heading.hdg_true_deg) ??
    deriveTrueHeadingFromMagnetic(hdgMagDeg, heading.magvar_deg);

  return {
    gs_kts: typeof gs === 'number' ? gs : null,
    xwind_kts: typeof xwindKts === 'number' ? xwindKts : null,
    lat_deg: useMsfs && td.latDeg != null ? td.latDeg : position.lat_deg,
    lon_deg: useMsfs && td.lonDeg != null ? td.lonDeg : position.lon_deg,
    hdg_true_deg: normalizeHeadingDegrees(hdgTrueDeg),
    hdg_mag_deg: normalizeHeadingDegrees(hdgMagDeg),
    magvar_deg: heading.magvar_deg,
    pitch_deg: useMsfs && td.pitchDeg != null ? td.pitchDeg : attitude.pitch_deg,
    bank_deg: useMsfs && td.bankDeg != null ? td.bankDeg : attitude.bank_deg,
    touchdown_capture_source: useMsfs ? 'msfs_last_touchdown' : 'frame',
    td_sim_source: td.source ?? null,
    td_sim_trusted: msfsTouchdown.trusted,
    td_sim_fresh: msfsTouchdown.fresh,
    td_sim_reject_reason: msfsTouchdown.rejectReason,
    td_sim_position_delta_ft: msfsTouchdown.positionDeltaFt,
    td_sim_lat_deg: td.latDeg ?? null,
    td_sim_lon_deg: td.lonDeg ?? null,
    td_sim_hdg_true_deg: td.headingTrueDeg ?? null,
    td_sim_hdg_mag_deg: td.headingMagDeg ?? null,
    td_sim_pitch_deg: td.pitchDeg ?? null,
    td_sim_bank_deg: td.bankDeg ?? null,
    td_sim_normal_velocity_fps: td.normalVelocityFps ?? null,
    td_sim_normal_velocity_fpm: td.normalVelocityFpm ?? null,
    td_sim_landing_vs_fpm: td.landingVsFpm ?? null,
    alt_indicated_ft: altitudeFdm.altIndicatedFt ?? frame.alt_msl ?? null,
    alt_calibrated_ft: altitudeFdm.altCalibratedFt ?? null,
    alt_plane_ft: altitudeFdm.altPlaneFt ?? null,
    aircraft_agl_ft: altitudeFdm.aircraftAglFt ?? null,
    aircraft_above_obstacles_ft: altitudeFdm.aircraftAboveObstaclesFt ?? null,
    plane_agl_ft: altitudeFdm.planeAglFt ?? null,
    plane_agl_minus_cg_ft: altitudeFdm.planeAglMinusCgFt ?? null,
    pressure_alt_ft: altitudeFdm.pressureAltFt ?? null,
    kohlsman_setting_mb: altitudeFdm.kohlsmanSettingMb ?? null,
    kohlsman_tuned_mb: altitudeFdm.kohlsmanTunedMb ?? null,
    kohlsman_std: typeof altitudeFdm.kohlsmanStd === 'boolean' ? altitudeFdm.kohlsmanStd : null,
    wind_speed_kts: typeof frame.windSpeed === 'number' ? frame.windSpeed : null,
    wind_dir_deg: typeof frame.windDir === 'number' ? frame.windDir : null,
    ...getTouchdownConfiguration(frame),
    ...getTouchdownSurfaceSnapshot(surface),
    assists: cloneAssistSnapshot(frame.assists),
    phaseAtTouchdown,
  };
}

function emitRejectedTouchdown(input: {
  reason: string;
  criteria: AnyRecord;
  nowEpochMs: number;
  vsFpm: number | null;
  iasKts: number | null;
}): void {
  const { reason, criteria, nowEpochMs, vsFpm, iasKts } = input;
  try {
    eventBus.emit('landing:touchdown', {
      _rejected: true,
      _rejectionReason: reason,
      _rejectionCriteria: criteria,
      timestampMs: nowEpochMs,
      timestampIso: new Date(nowEpochMs).toISOString(),
      vs_fpm: vsFpm,
      ias_kts: iasKts,
      grade: 'REJECTED',
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    Debug.log('landing', 'Failed to emit rejected touchdown event', { error: errorMessage });
  }
}

function createDefaultTouchdownDistanceData(bounceScoring: AnyRecord): AnyRecord {
  return buildDefaultTouchdownDistanceData(bounceScoring);
}

function resolveTouchdownGeometry(touchdownSummary: AnyRecord, ctx: LandingRunnerContext): {
  runwayData: AnyRecord | null;
  runwayReferenceData: AnyRecord | null;
} {
  const lat = touchdownSummary.lat_deg;
  const lon = touchdownSummary.lon_deg;
  const airportGeometryContext = buildAirportGeometryContext(ctx);
  let runwayData = null;

  if (lat != null && lon != null) {
    const acftHeading = getRunwayComparisonHeading(touchdownSummary);
    runwayData = findRunwayByPosition(lat, lon, 2, acftHeading, airportGeometryContext);
  }
  if (!runwayData && ctx.icao && ctx.runway) {
    runwayData = getRunway(ctx.icao, ctx.runway, airportGeometryContext);
  }

  let runwayReferenceData = runwayData;
  if (!runwayReferenceData && lat != null && lon != null) {
    const airportData = findNearbyAirport(lat, lon, 5, airportGeometryContext);
    if (airportData) {
      runwayReferenceData = {
        ...airportData,
        elevationReference: 'airport',
      };
    }
  }

  return { runwayData, runwayReferenceData };
}

// Final rollout scoring uses runway geometry only when it is available. The
// default data keeps bounce scoring populated even when runway lookup fails.
function buildRunwayTouchdownDistanceData(input: {
  touchdownSummary: AnyRecord;
  runwayData: AnyRecord;
  bounceScoring: AnyRecord;
}): { touchdownDistanceData: AnyRecord; shortLandingDetected: boolean } {
  const { touchdownSummary, runwayData, bounceScoring } = input;
  const analysis = buildTouchdownRunwayAnalysis({
    runwayData,
    touchdownPoint: {
      lat: touchdownSummary.lat_deg,
      lon: touchdownSummary.lon_deg,
    },
    surfaceInputs: {
      surfaceCondition: touchdownSummary.fdm_surface_condition,
      xplaneRunwayFriction: touchdownSummary.fdm_xplane_runway_friction,
      precipState: touchdownSummary.fdm_precip_state,
      precipRateMm: touchdownSummary.fdm_precip_rate_mm,
      oatC: touchdownSummary.fdm_oat_c,
    },
    bounceScoring,
  });

  Debug.log('landing', 'Touchdown distance calculated', {
    distanceFt: analysis.touchdownDistanceData.touchdown_distance_ft,
    grade: analysis.touchdownDistanceData.touchdown_distance_grade,
    shortLanding: analysis.shortLandingDetected,
    runway: runwayData.icao ? `${runwayData.icao}/${runwayData.runway}` : 'position-based',
  });

  return {
    touchdownDistanceData: analysis.touchdownDistanceData,
    shortLandingDetected: analysis.shortLandingDetected,
  };
}

function isTouchdownZoneAchieved(touchdownDistanceData: AnyRecord, shortLandingDetected: boolean): boolean {
  return !shortLandingDetected &&
    touchdownDistanceData.touchdown_distance_ft != null &&
    touchdownDistanceData.touchdown_distance_ft >= 0 &&
    touchdownDistanceData.touchdown_distance_ft <= TOUCHDOWN_ZONE_MAX_FT;
}

function getMeasuredGForce(frame: AnyRecord | null | undefined): number | null {
  const measured = firstFiniteNumber(
    frame?.gforce,
    frame?.fdm?.gForce,
    frame?.simconnect?.fdm?.gForce,
  );
  // Normal load factor at touchdown should be positive. Reject impossible or
  // implausible values instead of manufacturing a value from sink rate.
  return measured != null && measured > 0 && measured <= 10 ? measured : null;
}

function getBounceAltitudeFt(frame: AnyRecord | null | undefined): number | null {
  // Do not use alt_msl here: that is the pilot's indicated altitude and can
  // jump when the barometer is corrected. Bounce lift needs a physical/geometric
  // source; RA, VS, and impact load remain independent fallbacks when unavailable.
  return firstFiniteNumber(
    frame?.fdm?.altPlaneFt,
    frame?.alt_plane_ft,
  );
}

function getBounceRadioHeightFt(frame: AnyRecord | null | undefined): number | null {
  return firstFiniteNumber(
    frame?.display?.raFt,
    typeof frame?.ra === 'number' ? metersToFeet(frame.ra) : null,
  );
}

function getBounceVerticalSpeedFpm(frame: AnyRecord | null | undefined): number | null {
  return firstFiniteNumber(
    frame?.display?.vsFpm,
    typeof frame?.vs === 'number' ? msToFpm(frame.vs) : null,
  );
}

type BounceCandidate = {
  startedEpochMs: number;
  endedEpochMs: number | null;
  baselineAltitudeFt: number | null;
  baselineRadioHeightFt: number | null;
  peakAltitudeFt: number | null;
  peakRadioHeightFt: number | null;
  maxUpwardVsFpm: number | null;
  lastAirbornePosition: { lat: number; lon: number } | null;
  airborneDistanceFt: number;
};

type PendingBounceConfirmation = {
  candidate: BounceCandidate;
  touchdownEpochMs: number;
  bouncePosition: { lat_deg: number | null; lon_deg: number | null };
  bounceVsFpm: number;
  bounceGforce: number | null;
  bounceVsSource: string;
};

function finitePosition(frame: AnyRecord | null | undefined): { lat: number; lon: number } | null {
  const position = frame ? getTouchdownPosition(frame) : { lat_deg: null, lon_deg: null };
  return isValidLatLon(position.lat_deg, position.lon_deg)
    ? { lat: position.lat_deg as number, lon: position.lon_deg as number }
    : null;
}

function buildLiveRolloutAnalysisSample(
  frame: AnyRecord,
  ctx: LandingRunnerContext,
  timestampMs: number,
): AnyRecord {
  const position = finitePosition(frame);
  const bankDeg = firstFiniteNumber(
    frame?.attitudeDebug?.bankDegPrimary,
    typeof frame?.bank === 'number' ? frame.bank * (180 / Math.PI) : null,
  );
  const rollRateRadS = firstFiniteNumber(frame?.fdm?.rollRateRadS, frame?.rollRateRadS);
  const headingTrueDeg = getAircraftTrueHeadingDeg({
    hdg_true_deg: firstFiniteNumber(
      frame?.simconnect?.hdgTrueDeg,
      ctx.computedHdgTrueDeg,
      frame?.heading,
    ),
    hdg_mag_deg: firstFiniteNumber(
      frame?.simconnect?.hdgMagDeg,
      ctx.computedHdgMagDeg,
    ),
    magvar_deg: firstFiniteNumber(
      frame?.simconnect?.magvarDeg,
      ctx.magvarDeg,
      frame?.magvar,
    ),
  });
  return {
    timestampMs,
    onGround: frame?.wow === true,
    paused: frame?.paused === true || frame?.inMenu === true,
    phase: ctx.phase ?? null,
    gsKts: firstFiniteNumber(frame?.display?.gsKts, frame?.gs),
    bankDeg,
    rollRateDegS: rollRateRadS == null ? null : rollRateRadS * (180 / Math.PI),
    headingTrueDeg,
    lat: position?.lat ?? null,
    lon: position?.lon ?? null,
  };
}

function addObservedAirborneDistance(
  candidate: BounceCandidate,
  nextPosition: { lat: number; lon: number } | null,
): void {
  if (candidate.lastAirbornePosition && nextPosition) {
    const segmentFt = distanceFtBetweenLatLon(candidate.lastAirbornePosition, nextPosition);
    if (segmentFt != null) candidate.airborneDistanceFt += segmentFt;
  }
  if (nextPosition) candidate.lastAirbornePosition = nextPosition;
}

function updateBounceCandidatePhysicalEvidence(candidate: BounceCandidate, frame: AnyRecord): void {
  const altitudeFt = getBounceAltitudeFt(frame);
  const radioHeightFt = getBounceRadioHeightFt(frame);
  const vsFpm = getBounceVerticalSpeedFpm(frame);

  if (altitudeFt != null && (candidate.peakAltitudeFt == null || altitudeFt > candidate.peakAltitudeFt)) {
    candidate.peakAltitudeFt = altitudeFt;
  }
  if (radioHeightFt != null && (candidate.peakRadioHeightFt == null || radioHeightFt > candidate.peakRadioHeightFt)) {
    candidate.peakRadioHeightFt = radioHeightFt;
  }
  if (vsFpm != null && (candidate.maxUpwardVsFpm == null || vsFpm > candidate.maxUpwardVsFpm)) {
    candidate.maxUpwardVsFpm = vsFpm;
  }
}

function assessBounceCandidate(input: {
  candidate: BounceCandidate;
  bounceVsFpm: number;
  bounceGforce: number | null;
  minTouchdownVsFpm: number;
  aircraftProfileId?: unknown;
}): AnyRecord {
  const { candidate, bounceVsFpm, bounceGforce, minTouchdownVsFpm, aircraftProfileId } = input;
  const altitudeLiftFt = candidate.baselineAltitudeFt != null && candidate.peakAltitudeFt != null
    ? candidate.peakAltitudeFt - candidate.baselineAltitudeFt
    : null;
  const radioHeightLiftFt = candidate.baselineRadioHeightFt != null && candidate.peakRadioHeightFt != null
    ? candidate.peakRadioHeightFt - candidate.baselineRadioHeightFt
    : null;
  const airborneDurationMs = candidate.endedEpochMs == null
    ? null
    : Math.max(0, candidate.endedEpochMs - candidate.startedEpochMs);
  const assessment = assessRecordedBounceEvidence({
    airborneDurationMs,
    altitudeLiftFt,
    impactLoadG: bounceGforce,
    maxUpwardVsFpm: candidate.maxUpwardVsFpm,
    radioHeightLiftFt,
    recontactVsFpm: bounceVsFpm,
  }, (vsFpm: number) => gradeLandingForProfile(vsFpm, aircraftProfileId)?.grade ?? null, {
    // Keep the touchdown detector's configured noise floor without duplicating
    // the shared physical-evidence thresholds.
    minUpwardVsFpm: minTouchdownVsFpm,
  });

  return {
    ...assessment,
    hasCombinedShallowBounceEvidence: assessment.hasCombinedShallowEvidence,
    weakSupportingSignalCount: assessment.shallowSecondarySignals,
    maxUpwardVsFpm: candidate.maxUpwardVsFpm,
    impactVsFpm: bounceVsFpm,
    impactGforce: bounceGforce,
    airborneDistanceFt: candidate.airborneDistanceFt,
  };
}

function calculateRunwayCrosswind(runwayData: AnyRecord | null, touchdownSummary: AnyRecord): number | null {
  const runwayTrueHeadingDeg = getRunwayTrueHeadingDeg(runwayData);
  const windSpeedKts = finiteNumberOrNull(touchdownSummary.wind_speed_kts);
  const windDirectionTrueDeg = finiteNumberOrNull(touchdownSummary.wind_dir_deg);
  if (runwayTrueHeadingDeg == null || windSpeedKts == null || windDirectionTrueDeg == null) return null;
  return computeCrosswind(windSpeedKts, windDirectionTrueDeg, runwayTrueHeadingDeg);
}

function calculateCenterlineDeviation(runwayData: AnyRecord | null, touchdownSummary: AnyRecord): number | null {
  const runwayTrueHeadingDeg = getRunwayTrueHeadingDeg(runwayData);
  if (runwayTrueHeadingDeg == null) return null;

  const acftHdg = getRunwayComparisonHeading(touchdownSummary);
  if (typeof acftHdg !== 'number') return null;

  return roundedHeadingDifferenceDegrees(acftHdg, runwayTrueHeadingDeg);
}

function normalizeBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return null;
}

function normalizeGateFailures(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((failure) => failure.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split('|').map((failure) => failure.trim()).filter(Boolean);
  }
  return [];
}

function roundSignedMagnitude(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  const magnitude = Math.round(Math.abs(numeric));
  if (magnitude === 0) return 0;
  return numeric < 0 ? -magnitude : magnitude;
}

// WebSocket landing packets are UI-oriented and transient. The canonical
// event-bus/CSV payload is still built by buildLandingPayload().
function buildFinalLandingBroadcast(input: {
  touchdownSummary: AnyRecord;
  finalGrade: AnyRecord;
  touchdownDistanceData: AnyRecord;
  runwayData: AnyRecord | null;
  runwayReferenceData: AnyRecord | null;
  ctx: LandingRunnerContext;
  excursionDetected: boolean;
  shortLandingDetected: boolean;
  tdzAchieved: boolean;
  centerlineDeviation: number | null;
}): AnyRecord {
  const {
    touchdownSummary,
    finalGrade,
    touchdownDistanceData,
    runwayData,
    runwayReferenceData,
    ctx,
    excursionDetected,
    shortLandingDetected,
    tdzAchieved,
    centerlineDeviation,
  } = input;

  return {
    type: 'landing',
    vs: touchdownSummary.vs_fpm,
    grade: finalGrade.grade,
    color: finalGrade.color,
    gforce: touchdownSummary.gforce,
    stability: touchdownSummary.stability,
    breakdown: touchdownSummary.breakdown,
    runwayExcursion: excursionDetected,
    runwayOccupancyS: touchdownSummary.runway_occupancy_s ?? null,
    rolloutAnalysis: touchdownSummary.rolloutAnalysis ?? null,
    shortLanding: shortLandingDetected,
    final: true,
    icao: touchdownDistanceData.runway_icao || runwayData?.icao || runwayReferenceData?.icao || ctx.icao || null,
    runway: touchdownDistanceData.runway_id || runwayData?.runway || runwayData?.runwayId || ctx.runway || null,
    approachType: ctx.approachType || null,
    touchdownDistance: {
      distanceFt: touchdownDistanceData.touchdown_distance_ft,
      runwayLengthFt: touchdownDistanceData.runway_length_ft,
      grade: touchdownDistanceData.touchdown_distance_grade,
      score: touchdownDistanceData.touchdown_distance_score,
      tdzAchieved,
      shortLanding: shortLandingDetected,
      runway: touchdownDistanceData.runway_icao && touchdownDistanceData.runway_id
        ? `${touchdownDistanceData.runway_icao}/${touchdownDistanceData.runway_id}`
        : null,
      lateralOffsetFt: touchdownDistanceData.lateral_offset_ft,
      lateralOffsetSide: touchdownDistanceData.lateral_offset_side,
      lateralOffsetGrade: touchdownDistanceData.lateral_offset_grade,
      lateralOffsetScore: touchdownDistanceData.lateral_offset_score,
      lateralOffsetSuspect: touchdownDistanceData.lateral_offset_suspect,
      runwayWidthFt: touchdownDistanceData.runway_width_ft,
      bounceScore: touchdownDistanceData.bounce_score,
      bounceGrade: touchdownDistanceData.bounce_grade,
      bounceDistanceFt: touchdownDistanceData.bounce_distance_ft,
      bounceCount: touchdownSummary.bounceCount,
    },
    ultimateStability: {
      score: touchdownSummary.ultimate_stability_score ?? null,
      verdict:
        touchdownSummary.ultimate_stability_verdict
        ?? touchdownSummary.ultimateStabilityVerdict
        ?? null,
      scoringContext:
        touchdownSummary.ultimate_stability_context
        ?? touchdownSummary.ultimateStabilityContext
        ?? null,
      gateStable: normalizeBooleanLike(
        touchdownSummary.ultimate_stability_gate_stable ?? touchdownSummary.ultimate_stability_gateStable,
      ),
      gateFailures: normalizeGateFailures(
        touchdownSummary.ultimate_stability_gate_failures ?? touchdownSummary.ultimate_stability_gateFailures,
      ),
    },
    crosswind: roundSignedMagnitude(touchdownSummary.xwind_kts),
    windSpeed: touchdownSummary.wind_speed_kts != null ? Math.round(touchdownSummary.wind_speed_kts) : null,
    windDirectionTrueDeg: normalizeHeadingDegrees(touchdownSummary.wind_dir_deg),
    pitchDeg: touchdownSummary.pitch_deg != null ? Math.round(touchdownSummary.pitch_deg * 10) / 10 : null,
    bankDeg: touchdownSummary.bank_deg != null ? Math.round(touchdownSummary.bank_deg * 10) / 10 : null,
    iasKts: touchdownSummary.ias_kts != null ? Math.round(touchdownSummary.ias_kts) : null,
    gsKts: touchdownSummary.gs_kts != null ? Math.round(touchdownSummary.gs_kts) : null,
    centerlineDev: centerlineDeviation,
    runwayHdg: getRunwayTrueHeadingDeg(runwayData),
  };
}

function createLandingRunner(): LandingRunner {
  let previousWOW = false;
  let lastVS = 0;
  let initialized = false;

  // Track latest airborne VS sample so touchdown can prefer pre-impact sink rate
  // when WOW transition frame is post-impact damped.
  let lastAirborneVsFpm: number | null = null;
  let lastAirborneVsEpochMs: number | null = null;
  let lastAirborneSimTouchdownSignature: string | null = null;

  let lastAcceptedTouchdownEpochMs: number | null = null;
  let airborneSinceEpochMs: number | null = null;
  let touchdownRearmed = true;
  // Highest radio altitude (ft) observed while airborne since the last WOW=true
  // frame. Used to reject "touchdowns" that occur when the aircraft lifted off
  // briefly during a takeoff roll and settled back onto the runway without ever
  // climbing meaningfully.
  let maxRaFtSinceAirborne = 0;

  // Rollout monitoring state
  let rolloutActive = false;
  let rolloutDeadline = 0;
  let rolloutFinalizeDeadline = 0;
  let touchdownSummary: AnyRecord | null = null; // { vs_fpm, ias_kts, ra_ft, alt_msl_ft, lights, grade, gforce }
  let excursionDetected = false;
  let lastRunwayLike: boolean | null = null;
  let touchdownEpochMs: number | null = null;
  let runwayVacateEpochMs: number | null = null;
  let rolloutAnalysisSamples: AnyRecord[] = [];

  // Bounce tracking state
  let bounceCount = 0;
  let firstTouchdown: AnyRecord | null = null;  // { lat, lon, vs_fpm, gforce, timestampMs }
  let finalTouchdown: AnyRecord | null = null;  // Updated on each bounce, used for final scoring
  let worstBounceGforce: number | null = null; // Worst G-force across all touchdowns in sequence
  let bounceCandidate: BounceCandidate | null = null;
  let pendingBounceConfirmation: PendingBounceConfirmation | null = null;
  let bounceAirborneDistanceFt = 0;
  let lastGroundAltitudeFt: number | null = null;
  let lastGroundRadioHeightFt: number | null = null;

  function reset(): void {
    previousWOW = false;
    lastVS = 0;
    initialized = false;
    lastAirborneVsFpm = null;
    lastAirborneVsEpochMs = null;
    lastAirborneSimTouchdownSignature = null;
    lastAcceptedTouchdownEpochMs = null;
    airborneSinceEpochMs = null;
    touchdownRearmed = true;
    maxRaFtSinceAirborne = 0;
    rolloutActive = false;
    rolloutDeadline = 0;
    rolloutFinalizeDeadline = 0;
    touchdownSummary = null;
    excursionDetected = false;
    lastRunwayLike = null;
    touchdownEpochMs = null;
    runwayVacateEpochMs = null;
    rolloutAnalysisSamples = [];
    bounceCount = 0;
    firstTouchdown = null;
    finalTouchdown = null;
    worstBounceGforce = null;
    bounceCandidate = null;
    pendingBounceConfirmation = null;
    bounceAirborneDistanceFt = 0;
    lastGroundAltitudeFt = null;
    lastGroundRadioHeightFt = null;
  }

  function encodeUltimateStabilityBreakdown(ultimateScore: AnyRecord | null | undefined): string {
    if (!ultimateScore || typeof ultimateScore !== 'object') return '';

    const parts: string[] = [];

    const breakdown = ultimateScore.breakdown && typeof ultimateScore.breakdown === 'object'
      ? ultimateScore.breakdown
      : null;

    if (breakdown) {
      const keys = Object.keys(breakdown).sort();
      for (const k of keys) {
        const v = breakdown[k];
        if (v == null) continue;
        parts.push(`${k}=${v}`);
      }
    }

    if (Number.isFinite(ultimateScore.samples)) {
      parts.push(`samples=${ultimateScore.samples}`);
    }
    if (typeof ultimateScore.gateStable === 'boolean') {
      parts.push(`gateStable=${ultimateScore.gateStable ? 1 : 0}`);
    }
    if (Array.isArray(ultimateScore.gateFailures) && ultimateScore.gateFailures.length > 0) {
      parts.push(`gateFailures=${ultimateScore.gateFailures.map(String).join('|')}`);
    }

    return parts.join(';');
  }

  function getUltimateStabilityFlatFields(ultimateScore: AnyRecord | null | undefined): AnyRecord {
    const breakdown = ultimateScore && ultimateScore.breakdown && typeof ultimateScore.breakdown === 'object'
      ? ultimateScore.breakdown
      : null;

    const pct = (key: string): number | null => {
      if (!breakdown) return null;
      const v = breakdown[key];
      return Number.isFinite(v) ? v : null;
    };

    return {
      ultimate_stability_verdict:
        ultimateScore && typeof ultimateScore.verdict === 'string'
          ? ultimateScore.verdict
          : null,
      ultimate_stability_samples:
        ultimateScore && Number.isFinite(ultimateScore.samples)
          ? ultimateScore.samples
          : null,
      ultimate_stability_gate_stable:
        ultimateScore && typeof ultimateScore.gateStable === 'boolean'
          ? ultimateScore.gateStable
          : null,
      ultimate_stability_gateFailures:
        ultimateScore && Array.isArray(ultimateScore.gateFailures) && ultimateScore.gateFailures.length > 0
          ? ultimateScore.gateFailures.map(String).join('|')
          : null,

      ultimate_stability_gear_ok_pct: pct('gear_ok'),
      ultimate_stability_flaps_ok_pct: pct('flaps_ok'),
      ultimate_stability_spoilers_ok_pct: pct('spoilers_ok'),
      ultimate_stability_config_ok_pct: pct('config_ok'),
      ultimate_stability_speed_ok_pct: pct('speed_ok'),
      ultimate_stability_speed_trend_ok_pct: pct('speed_trend_ok'),
      ultimate_stability_vs_ok_pct: pct('vs_ok'),
      ultimate_stability_glidepath_ok_pct: pct('glidepath_ok'),
      ultimate_stability_glidepath_below_ok_pct: pct('glidepath_below_ok'),
      ultimate_stability_glidepath_above_ok_pct: pct('glidepath_above_ok'),
      ultimate_stability_thrust_ok_pct: pct('thrust_ok'),
      ultimate_stability_thrust_not_idle_ok_pct: pct('thrust_not_idle_ok'),
      ultimate_stability_thrust_stable_ok_pct: pct('thrust_stable_ok'),
      ultimate_stability_pitch_ok_pct: pct('pitch_ok'),
      ultimate_stability_bank_ok_pct: pct('bank_ok'),
      ultimate_stability_lateral_offset_ok_pct: pct('lateral_offset_ok'),
    };
  }

  function selectTouchdownVsFpm({ display, vs, lastVS, nowEpochMs }: {
    display?: AnyRecord | null;
    vs?: number | null;
    lastVS: number;
    nowEpochMs: number;
  }): { vsFpm: number; source: string } {
    const rawVs = Number.isFinite(vs)
      ? vs as number
      : (Number.isFinite(lastVS) ? lastVS : 0);
    const touchdownVsFpm = (display && Number.isFinite(display.vsFpm))
      ? display.vsFpm
      : msToFpm(rawVs);

    // Conservative safety window: only use pre-touchdown airborne sample when it
    // was observed very recently and indicates a higher sink rate than touchdown frame.
    const PRE_TOUCHDOWN_WINDOW_MS = Number.isFinite(config.landing.touchdownPreSampleWindowMs)
      ? Math.max(0, config.landing.touchdownPreSampleWindowMs)
      : 350;
    const recentAirborneEpochMs = lastAirborneVsEpochMs as number | null;
    const hasRecentAirborneSample = Number.isFinite(lastAirborneVsFpm)
      && Number.isFinite(lastAirborneVsEpochMs)
      && Number.isFinite(nowEpochMs)
      && recentAirborneEpochMs != null
      && (nowEpochMs - recentAirborneEpochMs >= 0)
      && (nowEpochMs - recentAirborneEpochMs <= PRE_TOUCHDOWN_WINDOW_MS);

    const candidates: Array<{ value: number; source: string }> = [];
    if (Number.isFinite(touchdownVsFpm)) {
      candidates.push({ value: touchdownVsFpm, source: 'touchdown_frame' });
    }
    if (hasRecentAirborneSample) {
      candidates.push({ value: lastAirborneVsFpm as number, source: 'last_airborne' });
    }
    if (candidates.length === 0) {
      return { vsFpm: 0, source: 'fallback_zero' };
    }

    // Prefer the more negative recent conventional sample so a post-impact WOW
    // frame cannot under-report the sink rate. Simulator touchdown normal
    // velocity remains diagnostic metadata and never enters this calculation.
    let selected = candidates[0];
    for (const candidate of candidates) {
      if (candidate.value < selected.value) selected = candidate;
    }
    const { value, source } = selected;
    return { vsFpm: value, source };
  }

  function commitConfirmedBounce(
    pending: PendingBounceConfirmation,
    assessment: AnyRecord,
  ): void {
    bounceCount++;
    bounceAirborneDistanceFt += pending.candidate.airborneDistanceFt;

    // Update final touchdown position (this is where we actually stop)
    finalTouchdown = {
      lat: pending.bouncePosition.lat_deg,
      lon: pending.bouncePosition.lon_deg,
      vs_fpm: pending.bounceVsFpm,
      gforce: pending.bounceGforce,
      timestampMs: pending.touchdownEpochMs,
    };

    // Accumulate worst G-force across ALL touchdowns in sequence (not just first/last)
    if (pending.bounceGforce != null && (worstBounceGforce == null || pending.bounceGforce > worstBounceGforce)) {
      worstBounceGforce = pending.bounceGforce;
    }

    // Keep touchdownSummary in sync with bounce state
    if (touchdownSummary) {
      touchdownSummary.bounceCount = bounceCount;
      touchdownSummary.finalTouchdown = finalTouchdown;
      touchdownSummary.worstBounceGforce = worstBounceGforce;
      touchdownSummary.bounceAirborneDistanceFt = bounceAirborneDistanceFt;
    }

    Debug.log('landing', `Bounce #${bounceCount} detected`, {
      vs_fpm: pending.bounceVsFpm,
      gforce: pending.bounceGforce,
      lat: pending.bouncePosition.lat_deg,
      lon: pending.bouncePosition.lon_deg,
      vs_source: pending.bounceVsSource,
      airborne_distance_ft: pending.candidate.airborneDistanceFt,
      confirmation: assessment,
    });
  }

  function updatePendingBounceConfirmation(
    frame: AnyRecord,
    nowEpochMs: number,
    minTouchdownVsFpm: number,
    aircraftProfileId: unknown,
  ): void {
    const pending = pendingBounceConfirmation;
    if (!pending) return;

    const startedAnotherAirborneSegment = frame?.wow === false || frame?.wow === 0;
    if (startedAnotherAirborneSegment) {
      // Delayed load belongs to a contact only while that contact remains on the
      // ground. Once another airborne segment starts, a later G peak may belong
      // to its eventual impact and must not retroactively confirm this candidate.
      const finalAssessment = assessBounceCandidate({
        candidate: pending.candidate,
        bounceVsFpm: pending.bounceVsFpm,
        bounceGforce: pending.bounceGforce,
        minTouchdownVsFpm,
        aircraftProfileId,
      });
      Debug.log('landing', 'Suppressed unconfirmed bounce before next airborne segment', {
        ...finalAssessment,
        airborne_ms: pending.touchdownEpochMs - pending.candidate.startedEpochMs,
      });
      pendingBounceConfirmation = null;
      return;
    }

    const ageMs = nowEpochMs - pending.touchdownEpochMs;
    if (ageMs >= 0 && ageMs <= BOUNCE_POST_IMPACT_CONFIRMATION_MS) {
      const measuredGForce = getMeasuredGForce(frame);
      if (measuredGForce != null && (pending.bounceGforce == null || measuredGForce > pending.bounceGforce)) {
        pending.bounceGforce = measuredGForce;
      }

      const assessment = assessBounceCandidate({
        candidate: pending.candidate,
        bounceVsFpm: pending.bounceVsFpm,
        bounceGforce: pending.bounceGforce,
        minTouchdownVsFpm,
        aircraftProfileId,
      });
      if (assessment.confirmed) {
        pendingBounceConfirmation = null;
        commitConfirmedBounce(pending, assessment);
        return;
      }
    }

    if (ageMs >= BOUNCE_POST_IMPACT_CONFIRMATION_MS) {
      const finalAssessment = assessBounceCandidate({
        candidate: pending.candidate,
        bounceVsFpm: pending.bounceVsFpm,
        bounceGforce: pending.bounceGforce,
        minTouchdownVsFpm,
        aircraftProfileId,
      });
      Debug.log('landing', 'Suppressed unconfirmed bounce (WOW dropout without physical corroboration)', {
        ...finalAssessment,
        airborne_ms: pending.touchdownEpochMs - pending.candidate.startedEpochMs,
        confirmation_window_ms: BOUNCE_POST_IMPACT_CONFIRMATION_MS,
      });
      pendingBounceConfirmation = null;
    }
  }

  /**
   * Update landing runner with current frame. Emits landing log on touchdown.
   * @param {object} frame - current normalized frame (with frame.display for display units)
   * @param {(obj:any)=>void} broadcast - WS broadcast fn
   * @param {{ nowEpochMs?:number, nowIso?:string, flightStartEpochMs?:number|null, flightStartIso?:string }=} timeCtx
   */
  function update(frame: AnyRecord, broadcast?: BroadcastFn | null, timeCtx?: TimeContext, ctx: LandingRunnerContext = {}): void {
    if (!frame || typeof frame !== 'object') return;
    const emit: BroadcastFn = typeof broadcast === 'function' ? broadcast : () => {};

    const { wow, vs, ra, ias, alt_msl, lights, surface, gs, display } = frame;
    const { phase, xwind_kts, stability } = ctx;

    const nowEpochMsCurrent = (timeCtx && typeof timeCtx.nowEpochMs === 'number') ? timeCtx.nowEpochMs : timeSource.now();

    const cooldownMs = Number.isFinite(TOUCHDOWN_COOLDOWN_MS)
      ? Math.max(0, TOUCHDOWN_COOLDOWN_MS)
      : 30000;
    const configuredMinVsFpm = config.landing.touchdownMinVsFpm ?? 50;

    // A simulator's normal-load peak commonly arrives one or more frames after
    // the WOW transition. Let a pending contact use the same one-second impact
    // window as the existing landing G-force capture before deciding it was only
    // a sensor dropout.
    const landingAttemptProfileId = touchdownSummary?.aircraft_profile_id ?? ctx.aircraftProfileId;
    updatePendingBounceConfirmation(frame, nowEpochMsCurrent, configuredMinVsFpm, landingAttemptProfileId);

    // Start and update a raw post-touchdown airborne segment independently of
    // whether it is eventually confirmed as a physical bounce. This preserves
    // the WOW observation while keeping scoring tied to corroborating motion.
    if (!wow && rolloutActive && touchdownSummary && !touchdownRearmed) {
      if (!bounceCandidate) {
        bounceCandidate = {
          startedEpochMs: nowEpochMsCurrent,
          endedEpochMs: null,
          baselineAltitudeFt: lastGroundAltitudeFt,
          baselineRadioHeightFt: lastGroundRadioHeightFt,
          peakAltitudeFt: null,
          peakRadioHeightFt: null,
          maxUpwardVsFpm: null,
          lastAirbornePosition: finitePosition(frame),
          airborneDistanceFt: 0,
        };
      } else {
        addObservedAirborneDistance(bounceCandidate, finitePosition(frame));
      }
      updateBounceCandidatePhysicalEvidence(bounceCandidate, frame);
    }

    if (wow) {
      lastGroundAltitudeFt = getBounceAltitudeFt(frame);
      lastGroundRadioHeightFt = getBounceRadioHeightFt(frame);
    }

    // Capture latest airborne VS sample for touchdown fidelity.
    if (!wow) {
      lastAirborneSimTouchdownSignature = getMsfsTouchdownSignature(frame);
      const airborneVsFpm = (display && typeof display.vsFpm === 'number')
        ? display.vsFpm
        : msToFpm(typeof vs === 'number' ? vs : lastVS);
      if (Number.isFinite(airborneVsFpm)) {
        lastAirborneVsFpm = airborneVsFpm;
        lastAirborneVsEpochMs = nowEpochMsCurrent;
      }
    }

    // Re-arm touchdown capture only after we've been continuously airborne
    // for the cooldown duration. This suppresses bounces while allowing
    // touch-and-go / go-around sequences to be captured as a new landing.
    if (!wow) {
      if (airborneSinceEpochMs == null) {
        airborneSinceEpochMs = nowEpochMsCurrent;
        // Start a fresh airborne segment: reset peak RA tracker so it reflects
        // only this lift-off, not a previous one.
        maxRaFtSinceAirborne = 0;
      }
      if (!touchdownRearmed && nowEpochMsCurrent - airborneSinceEpochMs >= cooldownMs) {
        touchdownRearmed = true;
      }
      // Track peak RA reached during the current airborne segment so we can
      // distinguish a real takeoff from a brief lift-off-and-settle on the runway.
      const raFtCurrent = (display && typeof display.raFt === 'number')
        ? display.raFt
        : (typeof ra === 'number' ? metersToFeet(ra) : null);
      if (Number.isFinite(raFtCurrent) && raFtCurrent > maxRaFtSinceAirborne) {
        maxRaFtSinceAirborne = raFtCurrent;
      }
    } else {
      airborneSinceEpochMs = null;
      // NOTE: do NOT reset maxRaFtSinceAirborne here — the touchdown branch
      // below reads it on the very same frame where WOW transitions to true.
      // It is reset when the next airborne segment starts (above).
    }

    // capture last VS in case vs is 0 at touchdown
    if (Number.isFinite(vs)) lastVS = vs;
    // On the very first frame, initialize prior WOW state to avoid false touchdown
    if (!initialized) {
      previousWOW = !!wow;
      initialized = true;
    }

    const touchdown = !previousWOW && !!wow; // transition from airborne to WOW
    previousWOW = !!wow;

    if (touchdown) {
      const nowEpochMs = nowEpochMsCurrent;
      const phaseAtTouchdownForCheck = phase || 'LANDING';
      const touchdownSnapshot = captureTouchdownSnapshot({
        frame,
        ctx,
        surface,
        gs,
        xwindKts: xwind_kts,
        phaseAtTouchdown: phaseAtTouchdownForCheck,
        lastAirborneSimTouchdownSignature,
      });
      // Use display units from frame (pre-converted by telemetry provider)
      const ias_kts_check = (display && typeof display.iasKts === 'number')
        ? display.iasKts
        : ias;  // ias is already in knots per frame contract
      const vsSelectionCheck = selectTouchdownVsFpm({
        display,
        vs,
        lastVS,
        nowEpochMs,
      });
      const vs_fpm_check = vsSelectionCheck.vsFpm;

      // GUARD: Reject false touchdowns during sim load/teleportation.
      // A real landing requires meaningful airspeed and descent rate.
      // VS=0 and IAS=0 indicates aircraft was stationary (teleport/load).
      // Thresholds from config.landing
      const minIasKts = config.landing.touchdownMinIasKts ?? 10;
      const minVsFpm = configuredMinVsFpm;
      const isValidTouchdown = (typeof ias_kts_check === 'number' && ias_kts_check >= minIasKts)
        || (typeof vs_fpm_check === 'number' && vs_fpm_check < -minVsFpm);

      if (!isValidTouchdown) {
        Debug.log('landing', 'Rejected false touchdown (sim load/teleport)', {
          ias_kts: ias_kts_check,
          vs_fpm: vs_fpm_check,
          reason: 'IAS too low and no descent rate',
        });
        // Emit rejected touchdown event for audit trail (annotate-don't-reject pattern)
        // Raw data is preserved; downstream can filter by _rejected flag
        emitRejectedTouchdown({
          reason: 'teleport_or_load',
          criteria: {
            ias_kts: ias_kts_check,
            vs_fpm: vs_fpm_check,
            minIasKts: minIasKts,
            minVsFpm: minVsFpm,
          },
          nowEpochMs,
          vsFpm: vs_fpm_check,
          iasKts: ias_kts_check,
        });
        // Don't process this as a real touchdown - skip downstream logic
        return;
      }

      // GUARD: Reject touchdowns that occur right after a takeoff where the
      // aircraft never climbed meaningfully (lifted off then settled back onto
      // the runway). Without this, the first WOW-true frame after such a hop
      // is recorded as a real landing because there is no prior accepted
      // touchdown to invoke the bounce branch below.
      const configuredMinAirborneRaFt = config.landing.touchdownMinAirborneRaFt;
      const minAirborneRaFt = typeof configuredMinAirborneRaFt === 'number' && Number.isFinite(configuredMinAirborneRaFt)
        ? configuredMinAirborneRaFt
        : 50;
      const peakRaFt = maxRaFtSinceAirborne;
      if (isTakeoffSettlingTouchdown({
        lastAcceptedTouchdownMs: lastAcceptedTouchdownEpochMs,
        peakRaFt,
        minAirborneRaFt,
      })) {
        Debug.log('landing', 'Rejected touchdown (takeoff settling)', {
          peak_ra_ft: peakRaFt,
          min_required_ra_ft: minAirborneRaFt,
          ias_kts: ias_kts_check,
          vs_fpm: vs_fpm_check,
        });
        emitRejectedTouchdown({
          reason: 'takeoff_settling',
          criteria: {
            peak_ra_ft: peakRaFt,
            min_required_ra_ft: minAirborneRaFt,
          },
          nowEpochMs,
          vsFpm: vs_fpm_check,
          iasKts: ias_kts_check,
        });
        return;
      }

      if (typeof lastAcceptedTouchdownEpochMs === 'number' && !touchdownRearmed) {
        // A second WOW contact is a raw bounce candidate. Finish the observed
        // airborne distance, then require lift/upward motion or a non-trivial
        // second impact before labeling and scoring a physical bounce.
        if (bounceCandidate) {
          addObservedAirborneDistance(bounceCandidate, finitePosition(frame));
          bounceCandidate.endedEpochMs = nowEpochMs;
        }
        const bouncePosition = {
          lat_deg: touchdownSnapshot.lat_deg,
          lon_deg: touchdownSnapshot.lon_deg,
        };
        const bounceVsSelection = selectTouchdownVsFpm({
          display,
          vs,
          lastVS,
          nowEpochMs,
        });
        const bounceVsFpm = bounceVsSelection.vsFpm;
        const bounceGforce = getMeasuredGForce(frame);
        const contactCandidate = bounceCandidate;
        const bounceAssessment = contactCandidate
          ? assessBounceCandidate({
            candidate: contactCandidate,
            bounceVsFpm,
            bounceGforce,
            minTouchdownVsFpm: minVsFpm,
            aircraftProfileId: touchdownSummary?.aircraft_profile_id ?? ctx.aircraftProfileId,
          })
          : { confirmed: false, airborneDistanceFt: 0 };

        bounceCandidate = null;
        if (!contactCandidate) {
          Debug.log('landing', 'Suppressed bounce contact without an observed airborne segment', {
            vs_fpm: bounceVsFpm,
            gforce: bounceGforce,
          });
        } else if (!bounceAssessment.confirmed) {
          // Keep the raw contact pending so delayed normal-load telemetry can
          // still confirm it during the established one-second impact window.
          pendingBounceConfirmation = {
            candidate: contactCandidate,
            touchdownEpochMs: nowEpochMs,
            bouncePosition,
            bounceVsFpm,
            bounceGforce,
            bounceVsSource: bounceVsSelection.source,
          };
          Debug.log('landing', 'Bounce contact awaiting post-impact confirmation', {
            ...bounceAssessment,
            confirmation_window_ms: BOUNCE_POST_IMPACT_CONFIRMATION_MS,
          });
        } else {
          commitConfirmedBounce({
            candidate: contactCandidate,
            touchdownEpochMs: nowEpochMs,
            bouncePosition,
            bounceVsFpm,
            bounceGforce,
            bounceVsSource: bounceVsSelection.source,
          }, bounceAssessment);
        }
        
        // Keep rollout monitoring state from the first touchdown
      } else {
      const nowIso = (timeCtx && typeof timeCtx.nowIso === 'string') ? timeCtx.nowIso : new Date(nowEpochMs).toISOString();
      const flightStartEpochMs = (timeCtx && typeof timeCtx.flightStartEpochMs === 'number') ? timeCtx.flightStartEpochMs : null;
      const flightStartIso = (timeCtx && typeof timeCtx.flightStartIso === 'string') ? timeCtx.flightStartIso : '';

      // Use display units from frame (pre-converted by telemetry provider)
      // Fall back to manual conversion when formatted display data is unavailable.
      const vsSelection = selectTouchdownVsFpm({
        display,
        vs,
        lastVS,
        nowEpochMs,
      });
      const vs_fpm = vsSelection.vsFpm;
      const ias_kts = (display && typeof display.iasKts === 'number')
        ? display.iasKts
        : ias;  // ias is already in knots per frame contract
      const ra_ft   = (display && typeof display.raFt === 'number')
        ? display.raFt
        : metersToFeet(ra);

      const gforce = getMeasuredGForce(frame);
      const grade = gradeLandingForProfile(
        typeof vs_fpm === 'number' ? vs_fpm : 0,
        ctx.aircraftProfileId,
      );
      const landingRateContext = buildLandingRateScoringContext(ctx.aircraftProfileId);
      // Everything after an accepted touchdown belongs to this landing attempt,
      // even if a noisy aircraft-title update changes the process-wide profile
      // during rollout. Runway/geometry data deliberately remains live.
      const landingAttemptAircraft = ctx.aircraftName || '';
      const landingAttemptProfileId = ctx.aircraftProfileId ?? null;
      const landingAttemptTaxiInMaxKts = finiteNumberOrNull(
        getEffectivePhaseThresholds().taxi_in_max_kts,
      );

      const stableStr = '--';
      const breakdown = null;

      const ultimateScore = stability && stability.ultimateScore ? stability.ultimateScore : null;
      const ultimateStabilityScore =
        ultimateScore && Number.isFinite(ultimateScore.overall) ? ultimateScore.overall
          : ultimateScore && Number.isFinite(ultimateScore.score) ? ultimateScore.score
            : null;
      const ultimateStabilityBreakdown = encodeUltimateStabilityBreakdown(ultimateScore);
      const ultimateStabilityFlat = getUltimateStabilityFlatFields(ultimateScore);

      Debug.log('landing', 'Touchdown detected', { vs_fpm: vs_fpm, ias_kts: ias_kts, ra_ft: ra_ft, grade: grade.grade, gforce, vs_source: vsSelection.source });

      // Capture FIRST touchdown data for bounce analysis
      // Reset bounce tracking on new landing sequence
      bounceCount = 0;
      bounceCandidate = null;
      pendingBounceConfirmation = null;
      bounceAirborneDistanceFt = 0;
      worstBounceGforce = gforce;
      const firstPosition = getTouchdownPosition(frame);
      
      firstTouchdown = {
        lat: firstPosition.lat_deg,
        lon: firstPosition.lon_deg,
        vs_fpm,
        gforce,
        timestampMs: nowEpochMs,
      };
      finalTouchdown = null; // Will be set if bounces occur

      // Initial landing event at touchdown (before rollout evaluation)
      try {
        emit({
          type: 'landing',
          vs: vs_fpm,
          grade: grade.grade,
          color: grade.color,
          gforce,
          stability: stableStr,
          breakdown,
          runwayExcursion: false,
          final: false,
          // Airport/runway info (for immediate HUD display)
          icao: ctx.icao || null,
          runway: ctx.runway || null,
          approachType: ctx.approachType || null,
        });
      } catch {}

      // Capture phase at TOUCHDOWN TIME (not rollout completion when it has transitioned)
      const phaseAtTouchdown = phaseAtTouchdownForCheck;

      // Build early touchdown summary for event bus emission
      const earlyTouchdownSummary = {
        vs_fpm,
        ias_kts,
        ra_ft,
        alt_msl_ft: alt_msl,
        ...touchdownSnapshot,
        stability: stableStr,
        ultimate_stability_score: ultimateStabilityScore,
        ultimate_stability_breakdown: ultimateStabilityBreakdown,
        landing_rate_context: landingRateContext,
        ...ultimateStabilityFlat,
        gforce,
      };

      // Emit early touchdown event (landing_final: false)
      // Subscribers can use this for crash investigation and pre-rollout analysis.
      try {
        const earlyPayload = buildLandingPayload({
          touchdownSummary: earlyTouchdownSummary,
          ctx,
          finalGrade: grade,
          touchdownDistanceData: {},
          nowEpochMs,
          nowIso,
          timeCtx: { flightStartIso, flightStartEpochMs },
          phase,
          excursionDetected: false,
          userId: getUserId(),
          sessionId: getSessionId(),
          schemaVersion: config.telemetry.schemaVersion,
        });
        // Mark as early (not final) - used by subscribers to decide storage destination
        earlyPayload.landing_final = false;
        eventBus.emit('landing:early', earlyPayload);
      } catch {}

      // Start rollout monitoring window for runway excursion detection
      rolloutActive = true;
      const rolloutWindowMs = Math.max(ROLLOUT_WINDOW_MS, 0);
      rolloutDeadline = nowEpochMs + rolloutWindowMs;
      rolloutFinalizeDeadline = nowEpochMs + Math.max(rolloutWindowMs, RUNWAY_OCCUPANCY_MAX_WAIT_MS);
      excursionDetected = false;
      touchdownEpochMs = nowEpochMs;
      runwayVacateEpochMs = null;
      rolloutAnalysisSamples = [];
      const runwayLikeAtTouchdown = isOnRunwaySurface(surface);
      lastRunwayLike = runwayLikeAtTouchdown;
      touchdownSummary = {
        vs_fpm,
        ias_kts,
        ra_ft,
        alt_msl_ft: alt_msl,
        lights,
        grade,
        landing_rate_context: landingRateContext,
        gforce,
        runway_occupancy_s: null,
        stability: stableStr,
        breakdown,
        ultimate_stability_score: ultimateStabilityScore,
        ultimate_stability_breakdown: ultimateStabilityBreakdown,
        ...ultimateStabilityFlat,
        // Capture frame data at touchdown for final event payload and CSV recording
        ...touchdownSnapshot,
        // Surface contamination inputs captured at touchdown (used downstream by
        // landing-distance scoring to derive a wet/dry/ice/snow band adjustment).
        // SimConnect's surfaceCondition SimVar is currently never populated; the
        // inference relies on precipitation + OAT, with a fail-safe to 'wet'
        // when nothing is known. See landing-distance.inferSurfaceCondition.
        ...getFdmSurfaceSnapshot(frame),
        // Aircraft identity retained for landing-event diagnostics.
        aircraft: landingAttemptAircraft,
        aircraft_profile_id: landingAttemptProfileId,
        rollout_taxi_in_max_kts: landingAttemptTaxiInMaxKts,
        // Bounce tracking data (set at creation, updated during bounces)
        bounceCount: 0,
        firstTouchdown: firstTouchdown,
        finalTouchdown: null,
        worstBounceGforce: worstBounceGforce,
        bounceAirborneDistanceFt: 0,
      };

      lastAcceptedTouchdownEpochMs = nowEpochMs;
      touchdownRearmed = false;
      console.log(`[landing-runner] Touchdown accepted — vs=${vs_fpm} fpm, grade=${grade.grade}, gforce=${gforce?.toFixed(2)}, rollout deadline in ${ROLLOUT_WINDOW_MS}ms`);
      }
    }

    // Rollout monitoring: while in the rollout window, watch for leaving runway-like surfaces
    if (rolloutActive && touchdownSummary) {
      const now = nowEpochMsCurrent;  // Use passed time context

      // Capture the measured normal-load peak immediately after the most recent
      // impact. A bounce has its own one-second window and its own recorded peak;
      // touchdownSummary.gforce remains the maximum across the landing sequence.
      // Do not infer load factor from vertical speed.
      const latestImpact = touchdownSummary.finalTouchdown || touchdownSummary.firstTouchdown || null;
      const latestImpactEpochMs = finiteNumberOrNull(latestImpact?.timestampMs);
      if (
        latestImpactEpochMs !== null
        && now >= latestImpactEpochMs
        && now - latestImpactEpochMs <= BOUNCE_POST_IMPACT_CONFIRMATION_MS
      ) {
        const measuredGForce = getMeasuredGForce(frame);
        if (measuredGForce != null) {
          if (latestImpact.gforce == null || measuredGForce > latestImpact.gforce) {
            latestImpact.gforce = measuredGForce;
          }
          if (touchdownSummary.gforce == null || measuredGForce > touchdownSummary.gforce) {
            touchdownSummary.gforce = measuredGForce;
          }
          if (worstBounceGforce == null || measuredGForce > worstBounceGforce) worstBounceGforce = measuredGForce;
          touchdownSummary.worstBounceGforce = worstBounceGforce;
        }
      }

      // Prefer SimConnect's ON ANY RUNWAY (surface.onRunway) if available
      // Falls back to surface.runwayLike (paved surface inference) if not
      // This is more accurate because ON ANY RUNWAY knows actual runway geometry
      const onRunwayNow = isOnRunwaySurface(surface);

      if (
        wow
        && onRunwayNow
        && rolloutAnalysisSamples.length < ROLLOUT_ANALYSIS_LIMITS.maxSamples
        && (
          touchdownEpochMs === null
          || now - touchdownEpochMs <= ROLLOUT_ANALYSIS_LIMITS.maxWindowMs
        )
      ) {
        rolloutAnalysisSamples.push(buildLiveRolloutAnalysisSample(frame, ctx, now));
      }
      
      // Only flag excursion if departing runway surface at significant speed (>30kt).
      // Low-speed departures (e.g., turning onto taxiway) are normal operations, not excursions.
      // Aviation definition: runway excursion = departing runway surface at high speed, implying loss of control.
      const gsKtsNow = typeof gs === 'number' ? gs : 0;
      const highSpeedExcursion = gsKtsNow > 30 && isLikelyRunwayExcursionSurface(surface);
      if (lastRunwayLike === true && onRunwayNow === false && wow && highSpeedExcursion && now <= rolloutDeadline) {
        excursionDetected = true;
        Debug.log('landing', 'Runway excursion detected', {
          gs_kts: gsKtsNow,
          onRunway: surface?.onRunway,
          runwayLike: surface?.runwayLike,
          surfaceClass: surface?.class,
        });
      }
      if (
        lastRunwayLike === true
        && onRunwayNow === false
        && wow
        && !excursionDetected
        && runwayVacateEpochMs === null
      ) {
        runwayVacateEpochMs = now;
        touchdownSummary.runway_occupancy_s = touchdownEpochMs === null
          ? null
          : Math.max(0, (runwayVacateEpochMs - touchdownEpochMs) / 1000);
        Debug.log('landing', 'Runway vacated during rollout', {
          gs_kts: gsKtsNow,
          runway_occupancy_s: touchdownSummary.runway_occupancy_s,
          onRunway: surface?.onRunway,
          runwayLike: surface?.runwayLike,
          surfaceClass: surface?.class,
        });
      }
      if (wow) {
        lastRunwayLike = onRunwayNow;
      }

      // Do not freeze the final payload while a raw second contact is still
      // inside its delayed-load confirmation window. The delay is capped at one
      // second and prevents a same-frame runway/surface transition from racing
      // the normal-load peak used to confirm a real bounce.
      const awaitingBounceConfirmation = pendingBounceConfirmation !== null;
      const shouldFinalizeRollout = !awaitingBounceConfirmation && (
        excursionDetected
        || runwayVacateEpochMs !== null
        || (now >= rolloutDeadline && lastRunwayLike !== true)
        || now >= rolloutFinalizeDeadline
      );

      if (shouldFinalizeRollout) {
        rolloutActive = false;

        // `grade` is the touchdown-rate grade everywhere. Runway excursion,
        // short landing, and touchdown-zone results remain separate facts.
        const finalGrade: AnyRecord = touchdownSummary.grade;

        // Calculate bounce scoring regardless of runway lookup availability.
        // Bounce analysis is independent of runway geometry and should fail-safe.
        const bounceScoring = scoreBounce({
          bounceCount: touchdownSummary.bounceCount,
          firstTouchdown: touchdownSummary.firstTouchdown,
          finalTouchdown: touchdownSummary.finalTouchdown,
          worstGforce: touchdownSummary.worstBounceGforce,
          airborneDistanceFt: touchdownSummary.bounceAirborneDistanceFt,
        });
        let touchdownDistanceData = createDefaultTouchdownDistanceData(bounceScoring);
        const { runwayData, runwayReferenceData } = resolveTouchdownGeometry(touchdownSummary, ctx);
        touchdownSummary.xwind_kts = calculateRunwayCrosswind(runwayData, touchdownSummary);
        touchdownSummary.rolloutAnalysis = analyzeRollout(rolloutAnalysisSamples, {
          taxiInMaxKts: touchdownSummary.rollout_taxi_in_max_kts,
          runwayHeadingTrueDeg: getRunwayTrueHeadingDeg(runwayData),
          runwayThreshold: runwayData?.threshold ?? null,
          runwayWidthFt: runwayData?.widthFt ?? null,
          runwayExcursion: excursionDetected,
          // Live provider coordinates retain substantially more precision than
          // the legacy four-decimal CSV representation.
          coordinatePrecisionDigits: 7,
          source: 'live',
        });

        // Track if this was a short landing (before threshold)
        let shortLandingDetected = false;

        if (runwayData) {
          const result = buildRunwayTouchdownDistanceData({
            touchdownSummary,
            runwayData,
            bounceScoring,
          });
          touchdownDistanceData = result.touchdownDistanceData;
          shortLandingDetected = result.shortLandingDetected;
        }

        const tdzAchieved = isTouchdownZoneAchieved(touchdownDistanceData, shortLandingDetected);
        const centerlineDeviation = calculateCenterlineDeviation(runwayData, touchdownSummary);

        try {
          emit(buildFinalLandingBroadcast({
            touchdownSummary,
            finalGrade,
            touchdownDistanceData,
            runwayData,
            runwayReferenceData,
            ctx,
            excursionDetected,
            shortLandingDetected,
            tdzAchieved,
            centerlineDeviation,
          }));
        } catch {}

        // =================================================================
        // FINAL TOUCHDOWN: Emit via event bus
        // Subscribers (CSV?) receive the same canonical payload.
        // =================================================================
        
        const finalPayload = buildLandingPayload({
          touchdownSummary,
          ctx,
          finalGrade,
          touchdownDistanceData,
          runwayData,
          runwayReferenceData,
          nowEpochMs: now,
          nowIso: new Date(now).toISOString(),
          timeCtx,
          // Use phase captured AT TOUCHDOWN TIME, not current frame phase (which has transitioned to TAXI/PARKED)
          phase: touchdownSummary.phaseAtTouchdown || phase,
          excursionDetected,
          userId: getUserId(),
          sessionId: getSessionId(),
          schemaVersion: config.telemetry.schemaVersion,
        });
        eventBus.emit('landing:final', finalPayload);
        console.log(`[landing-runner] Emitted landing:final — vs=${finalPayload.vs_fpm} fpm, grade=${finalPayload.grade}, icao=${finalPayload.icao}, runway=${finalPayload.runway}, tdz_ft=${finalPayload.touchdown_distance_ft}, tdz_grade=${finalPayload.touchdown_distance_grade}, excursion=${finalPayload.runway_excursion}, geometry=${finalPayload.runway_geometry_source || 'none'}`);
        Debug.log('landing', 'Emitted landing:final event', {
          vs_fpm: finalPayload.vs_fpm,
          grade: finalPayload.grade,
          excursion: finalPayload.runway_excursion,
        });
      }
    }
  }

  return { update, reset, isRolloutActive: () => rolloutActive };
}

module.exports = { createLandingRunner };

export {};
