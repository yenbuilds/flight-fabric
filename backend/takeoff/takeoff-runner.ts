// takeoff-runner.ts
// Detects liftoff, collects the ground roll that led to it, scores runway use
// once the aircraft is clearly airborne, and publishes the result the same way
// the landing runner does: a `takeoff` WebSocket message for the UI and a
// `takeoff:final` event-bus payload that core writes to the flight CSV.
//
// The runner never decides that a takeoff is good or bad on its own; the pure
// scoring lives in ./takeoff-analysis.ts so replay and tests can share it.

'use strict';

const config = require('../core/config') as ConfigModule;
const { TAKEOFF_SCORING_ENABLED } = require('../../shared/app-settings-shared.js') as {
  TAKEOFF_SCORING_ENABLED: boolean;
};
const Debug = require('../core/debug') as DebugModule;
const timeSource = require('../core/time-source') as { now: () => number };
const eventBus = require('../core/event-bus') as { emit: (eventName: string, payload: AnyRecord) => void };
const { getUserId, getSessionId } = require('../utils/user-identity') as {
  getUserId: () => string | null;
  getSessionId: () => string | null;
};
const { computeCrosswind } = require('../utils/helpers') as {
  computeCrosswind: (windSpeed: unknown, windDirDeg: unknown, headingDeg: unknown) => number | null;
};
const { makeFlapsObj } = require('../aircraft/flaps') as { makeFlapsObj: (...args: unknown[]) => AnyRecord | null };
const profileLoader = require('../aircraft/aircraft-profile-loader.js') as {
  loadProfile: (profileId: unknown) => AnyRecord | null;
};
const {
  deriveTrueHeadingFromMagnetic,
  finiteNumberOrNull,
  firstFiniteNumber,
  getRunwayTrueHeadingDeg,
  normalizeHeadingDegrees,
} = require('../utils/aviation-frames') as {
  deriveTrueHeadingFromMagnetic: (magneticHeadingDeg: unknown, magvarDeg: unknown) => number | null;
  finiteNumberOrNull: (value: unknown) => number | null;
  firstFiniteNumber: (...values: unknown[]) => number | null;
  getRunwayTrueHeadingDeg: (input: AnyRecord | null | undefined) => number | null;
  normalizeHeadingDegrees: (value: unknown) => number | null;
};
const { findNearbyAirport, findRunwayByPosition, getRunway } = require('../landing/airport-geometry-service') as {
  findNearbyAirport: (lat: number, lon: number, radiusNm: number, context?: AnyRecord) => AnyRecord | null;
  findRunwayByPosition: (
    lat: number, lon: number, maxDistanceNm: number, headingDeg: number | null, context?: AnyRecord,
  ) => AnyRecord | null;
  getRunway: (icao: string, runwayId: string, context?: AnyRecord) => AnyRecord | null;
};
const { analyzeTakeoffRoll, findTakeoffRollStart, resolveScreenHeightFt } = require('./takeoff-analysis') as {
  analyzeTakeoffRoll: (
    samples: AnyRecord[], liftoff: AnyRecord, screen: AnyRecord | null, context: AnyRecord,
  ) => AnyRecord | null;
  findTakeoffRollStart: (
    samples: AnyRecord[], liftoffTimestampMs: number, referenceHeadingDeg: number | null,
  ) => RollStart | null;
  resolveScreenHeightFt: (lightAircraft: boolean) => { heightFt: number; basis: string };
};
const { buildAssistCsvFields, cloneAssistSnapshot } = require('../utils/assist-snapshot') as {
  buildAssistCsvFields: (assists: AnyRecord | null) => AnyRecord;
  cloneAssistSnapshot: (assists: unknown) => AnyRecord | null;
};

type RollStart = {
  timestampMs: number;
  lat: number | null;
  lon: number | null;
  gsKts: number | null;
  source: string;
};

type AnyRecord = Record<string, any>;
type BroadcastFn = (payload: AnyRecord) => void;
type TimeContext = {
  nowEpochMs?: number;
  nowIso?: string;
  flightStartEpochMs?: number | null;
  flightStartIso?: string;
};
type TakeoffRunnerContext = AnyRecord & {
  phase?: string | null;
  aircraftName?: string | null;
  aircraftProfileId?: string | null;
  icao?: string | null;
  runway?: string | null;
  simVersion?: string | null;
  dataSource?: string | null;
  simulator?: string | null;
  computedHdgMagDeg?: number | null;
  computedHdgTrueDeg?: number | null;
};
type ConfigModule = {
  landing: { touchdownMinAirborneRaFt?: number };
  takeoff: {
    liftoffMinIasKts: number;
    minRollDurationMs: number;
    minRollAccelerationKts: number;
    rollSampleIntervalMs: number;
    rollBufferMs: number;
    confirmTimeoutMs: number;
    hopWindowMs: number;
  };
  telemetry: { schemaVersion: number };
};
type DebugModule = { log: (section: string, message: string, data?: AnyRecord) => void };

type GroundSample = {
  timestampMs: number;
  onGround: true;
  onRunway: boolean | null;
  runwayLike: boolean | null;
  paused: boolean;
  gsKts: number | null;
  iasKts: number | null;
  headingTrueDeg: number | null;
  pitchDeg: number | null;
  bankDeg: number | null;
  lat: number | null;
  lon: number | null;
};

type PendingTakeoff = {
  liftoffEpochMs: number;
  liftoff: AnyRecord;
  rollStart: RollStart | null;
  rollSamples: GroundSample[];
  screenPoint: AnyRecord | null;
  screenHeightFt: number;
  screenHeightBasis: string;
  lightAircraft: boolean;
  confirmAglFt: number;
  maxPitchDeg: number | null;
  maxBankDeg: number | null;
  maxAglFt: number | null;
  aglSource: string | null;
  rollExcursion: boolean;
  aircraftName: string;
  aircraftProfileId: string | null;
  phaseAtLiftoff: string | null;
  timeCtx: TimeContext;
};

export type TakeoffRunner = {
  update: (frame: AnyRecord, broadcast?: BroadcastFn | null, timeCtx?: TimeContext, ctx?: TakeoffRunnerContext) => void;
  reset: () => void;
  isPending: () => boolean;
};

const ROLL_EVIDENCE_WINDOW_MS = 8_000;
const ROLL_CONTIGUOUS_GAP_MS = 3_000;
const ROLL_EXCURSION_MIN_GS_KTS = 30;
/** Mirrors the analysis standstill threshold: below this the aircraft has stopped. */
const ROLL_STANDSTILL_GS_KTS = 8;
const MAX_LIFTOFF_GS_KTS = 250;
const GROUND_SAMPLE_LIMIT = 1_200;

const {
  getFramePosition,
  getFrameRadioHeightFt,
  getSurfaceSnapshot,
  isValidLatLon,
} = require('../utils/frame-snapshots') as {
  getFramePosition: (frame: AnyRecord | null | undefined) => { lat_deg: number | null; lon_deg: number | null };
  getFrameRadioHeightFt: (frame: AnyRecord | null | undefined) => number | null;
  getSurfaceSnapshot: (surface: AnyRecord | null | undefined) => AnyRecord;
  isValidLatLon: (lat: unknown, lon: unknown) => boolean;
};

function getPosition(frame: AnyRecord): { lat: number | null; lon: number | null } {
  const position = getFramePosition(frame);
  return { lat: position.lat_deg, lon: position.lon_deg };
}

function getHeading(frame: AnyRecord, ctx: TakeoffRunnerContext): {
  hdg_true_deg: number | null;
  hdg_mag_deg: number | null;
  magvar_deg: number | null;
} {
  const simconnect = frame.simconnect || {};
  const hdgTrueDeg = normalizeHeadingDegrees(firstFiniteNumber(simconnect.hdgTrueDeg, ctx.computedHdgTrueDeg));
  const hdgMagDeg = normalizeHeadingDegrees(firstFiniteNumber(simconnect.hdgMagDeg, ctx.computedHdgMagDeg));
  const magvarDeg = firstFiniteNumber(simconnect.magvarDeg, frame.magvar, ctx.computedMagvarDeg, ctx.magvarDeg);
  return {
    hdg_true_deg: hdgTrueDeg ?? deriveTrueHeadingFromMagnetic(hdgMagDeg, magvarDeg),
    hdg_mag_deg: hdgMagDeg,
    magvar_deg: magvarDeg,
  };
}

function getAttitude(frame: AnyRecord): { pitch_deg: number | null; bank_deg: number | null } {
  return {
    pitch_deg: finiteNumberOrNull(frame.attitudeDebug?.pitchDegPrimary),
    bank_deg: finiteNumberOrNull(frame.attitudeDebug?.bankDegPrimary),
  };
}

function getSpeeds(frame: AnyRecord): { iasKts: number | null; gsKts: number | null } {
  return {
    iasKts: firstFiniteNumber(frame.display?.iasKts, frame.ias),
    gsKts: firstFiniteNumber(frame.display?.gsKts, frame.gs),
  };
}

function getRadioHeightFt(frame: AnyRecord): number | null {
  return getFrameRadioHeightFt(frame);
}

function buildAirportGeometryContext(ctx: TakeoffRunnerContext): AnyRecord {
  const dataSource = typeof ctx?.dataSource === 'string' ? ctx.dataSource : null;
  const simulator = typeof ctx?.simulator === 'string' ? ctx.simulator : dataSource;
  return { simulator, dataSource };
}

function isLightAircraftProfile(profileId: unknown): boolean {
  try {
    const profile = profileLoader.loadProfile(profileId ?? 'generic');
    return String(profile?.aircraft?.category || '').trim().toUpperCase() === 'A';
  } catch {
    return false;
  }
}

function buildGroundSample(frame: AnyRecord, ctx: TakeoffRunnerContext, timestampMs: number): GroundSample {
  const position = getPosition(frame);
  const heading = getHeading(frame, ctx);
  const attitude = getAttitude(frame);
  const speeds = getSpeeds(frame);
  const surface = frame.surface;
  return {
    timestampMs,
    onGround: true,
    onRunway: surface?.valid === true && typeof surface.onRunway === 'boolean' ? surface.onRunway : null,
    runwayLike: surface && typeof surface.runwayLike === 'boolean' ? surface.runwayLike : null,
    paused: frame.paused === true || frame.inMenu === true,
    gsKts: speeds.gsKts,
    iasKts: speeds.iasKts,
    headingTrueDeg: heading.hdg_true_deg,
    pitchDeg: attitude.pitch_deg,
    bankDeg: attitude.bank_deg,
    lat: position.lat,
    lon: position.lon,
  };
}

/**
 * Ground samples that lead contiguously into the liftoff (no gap longer than
 * ROLL_CONTIGUOUS_GAP_MS), oldest first.
 */
function contiguousGroundRun(samples: GroundSample[], liftoffEpochMs: number): GroundSample[] {
  const run: GroundSample[] = [];
  let nextMs = liftoffEpochMs;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (nextMs - sample.timestampMs > ROLL_CONTIGUOUS_GAP_MS) break;
    run.push(sample);
    nextMs = sample.timestampMs;
  }
  return run.reverse();
}

function buildTakeoffPayload(input: {
  pending: PendingTakeoff;
  analysis: AnyRecord | null;
  runwayData: AnyRecord | null;
  runwayReferenceData: AnyRecord | null;
  ctx: TakeoffRunnerContext;
  nowEpochMs: number;
  nowIso: string;
  xwindKts: number | null;
  finalizeReason: string;
}): AnyRecord {
  const { pending, analysis, runwayData, runwayReferenceData, ctx, nowEpochMs, nowIso, xwindKts, finalizeReason } = input;
  const lo = pending.liftoff;
  const rwy = runwayData || {};
  const rwyReference = runwayReferenceData || runwayData || {};
  const assists = cloneAssistSnapshot(lo.assists);
  const timeCtx = pending.timeCtx || {};
  const flightElapsedMs = (timeCtx.flightStartEpochMs && pending.liftoffEpochMs)
    ? Math.max(0, pending.liftoffEpochMs - timeCtx.flightStartEpochMs)
    : null;
  const runwayUse = analysis?.runwayUse || {};
  const lateral = analysis?.lateral || {};
  const screen = analysis?.screenHeight || {};
  const rotation = analysis?.rotation || {};

  return {
    schema_version: config.telemetry.schemaVersion,
    user_id: getUserId(),
    session_id: getSessionId(),

    // Timestamps: the row is stamped at liftoff, scored a few seconds later.
    timestamp_utc: new Date(pending.liftoffEpochMs).toISOString(),
    timestamp_ms: pending.liftoffEpochMs,
    takeoff_liftoff_timestamp_ms: pending.liftoffEpochMs,
    scored_timestamp_ms: nowEpochMs,
    scored_timestamp_utc: nowIso,
    flight_start: timeCtx.flightStartIso ?? null,
    flight_elapsed_ms: flightElapsedMs,

    aircraft: pending.aircraftName || ctx.aircraftName || 'Unknown Aircraft',
    sim_version: ctx.simVersion ?? null,
    aircraft_profile_id: pending.aircraftProfileId ?? ctx.aircraftProfileId ?? null,
    data_source: ctx.dataSource ?? null,
    assists,
    ...buildAssistCsvFields(assists),
    icao: rwy.icao || rwyReference.icao || ctx.icao || null,
    runway: rwy.runway || rwy.runwayId || ctx.runway || null,

    // Liftoff facts
    ias_kts: lo.ias_kts ?? null,
    gs_kts: lo.gs_kts ?? null,
    lat_deg: lo.lat_deg ?? null,
    lon_deg: lo.lon_deg ?? null,
    hdg_true_deg: lo.hdg_true_deg ?? null,
    hdg_mag_deg: lo.hdg_mag_deg ?? null,
    magvar_deg: lo.magvar_deg ?? null,
    alt_msl_ft: lo.alt_msl_ft ?? null,
    ra_ft: lo.ra_ft ?? null,
    pitch_deg: lo.pitch_deg ?? null,
    bank_deg: lo.bank_deg ?? null,
    flaps_notch: lo.flaps_notch ?? null,
    wind_speed_kts: lo.wind_speed_kts ?? null,
    wind_dir_deg: lo.wind_dir_deg ?? null,
    xwind_kts: xwindKts,
    phase: 'TAKEOFF',
    phase_at_liftoff: pending.phaseAtLiftoff ?? null,

    // Surface at the last ground contact
    surface_raw: lo.surface_raw ?? null,
    surface_name: lo.surface_name ?? null,
    surface_class: lo.surface_class ?? null,
    surface_runway_like: lo.surface_runway_like ?? null,
    surface_on_runway: lo.surface_on_runway ?? null,
    surface_on_ground: false,
    surface_valid: lo.surface_valid ?? (lo.surface_class != null),
    runway_excursion: analysis?.runwayExcursion === true,

    // Runway geometry
    runway_geometry_source: rwy.source ?? null,
    runway_geometry_provider_chain: rwy.runway_geometry_provider_chain ?? rwy.runwayGeometryProviderChain ?? null,
    runway_geometry_fallback_reason: rwy.runway_geometry_fallback_reason ?? rwy.runwayGeometryFallbackReason ?? null,
    runway_geometry_diagnostics: rwy.runway_geometry_diagnostics ?? rwy.runwayGeometryDiagnostics ?? null,
    runway_heading_true_deg: getRunwayTrueHeadingDeg(rwy),
    runway_length_ft: rwy.lengthFt ?? null,
    runway_physical_length_ft: rwy.physicalLengthFt ?? null,
    runway_surface: rwy.surface ?? null,
    runway_threshold_lat: rwy.threshold?.lat ?? null,
    runway_threshold_lon: rwy.threshold?.lon ?? null,
    runway_physical_threshold_lat: rwy.physicalThreshold?.lat ?? null,
    runway_physical_threshold_lon: rwy.physicalThreshold?.lon ?? null,
    runway_displaced_threshold_ft: rwy.displacedThresholdFt ?? null,
    runway_width_ft: rwy.widthFt ?? null,

    // Lateral position at liftoff
    lateral_offset_ft: lateral.liftoffOffsetFt ?? null,
    lateral_offset_side: lateral.liftoffOffsetSide ?? null,
    lateral_offset_score: lateral.score ?? null,
    lateral_offset_grade: lateral.grade ?? null,
    lateral_offset_suspect: lateral.verified === true ? false : true,

    // Takeoff results
    takeoff_roll_distance_ft: analysis?.rollDistanceFt ?? null,
    takeoff_roll_duration_s: analysis?.rollDurationS ?? null,
    takeoff_roll_start_source: analysis?.rollStart?.source ?? null,
    takeoff_liftoff_distance_ft: analysis?.liftoff?.distanceFt ?? null,
    takeoff_runway_remaining_ft: analysis?.liftoff?.remainingFt ?? null,
    takeoff_runway_used_pct: analysis?.liftoff?.usedPct ?? null,
    takeoff_runway_use_score: runwayUse.score ?? null,
    takeoff_runway_use_grade: runwayUse.grade ?? null,
    takeoff_runway_use_zone: runwayUse.zone ?? null,
    takeoff_screen_height_ft: screen.heightFt ?? pending.screenHeightFt,
    takeoff_screen_height_distance_ft: screen.distanceFt ?? null,
    takeoff_screen_height_remaining_ft: screen.remainingFt ?? null,
    takeoff_screen_height_elapsed_s: screen.elapsedS ?? null,
    takeoff_rotation_rate_deg_s: rotation.rateDegS ?? null,
    takeoff_max_pitch_deg: rotation.maxPitchDeg ?? null,
    takeoff_max_lateral_offset_ft: lateral.maxOffsetFt ?? null,
    takeoff_hop_count: analysis?.hopCount ?? 0,
    takeoff_assessment: analysis?.assessment ?? null,
    takeoff_analysis: analysis,
    takeoff_final: true,
    takeoff_finalize_reason: finalizeReason,
  };
}

function buildTakeoffBroadcast(payload: AnyRecord, analysis: AnyRecord | null): AnyRecord {
  return {
    type: 'takeoff',
    final: true,
    timestampMs: payload.timestamp_ms,
    aircraft: payload.aircraft,
    aircraftProfileId: payload.aircraft_profile_id,
    icao: payload.icao,
    runway: payload.runway,
    grade: payload.takeoff_runway_use_grade,
    score: payload.takeoff_runway_use_score,
    zone: payload.takeoff_runway_use_zone,
    assessment: payload.takeoff_assessment,
    runwayExcursion: payload.runway_excursion,
    hopCount: payload.takeoff_hop_count,
    runwayUse: {
      grade: payload.takeoff_runway_use_grade,
      score: payload.takeoff_runway_use_score,
      zone: payload.takeoff_runway_use_zone,
      liftoffDistanceFt: payload.takeoff_liftoff_distance_ft,
      remainingFt: payload.takeoff_runway_remaining_ft,
      usedPct: payload.takeoff_runway_used_pct,
      runwayLengthFt: analysis?.runway?.lengthFt ?? payload.runway_physical_length_ft ?? payload.runway_length_ft ?? null,
      beyondRunwayEnd: analysis?.liftoff?.beyondRunwayEnd === true,
    },
    roll: {
      distanceFt: payload.takeoff_roll_distance_ft,
      durationS: payload.takeoff_roll_duration_s,
      startSource: payload.takeoff_roll_start_source,
      distanceSource: analysis?.rollDistanceSource ?? null,
    },
    liftoff: {
      iasKts: payload.ias_kts != null ? Math.round(payload.ias_kts) : null,
      gsKts: payload.gs_kts != null ? Math.round(payload.gs_kts) : null,
      pitchDeg: payload.pitch_deg != null ? Math.round(payload.pitch_deg * 10) / 10 : null,
      bankDeg: payload.bank_deg != null ? Math.round(payload.bank_deg * 10) / 10 : null,
      headingTrueDeg: payload.hdg_true_deg,
      flapsNotch: payload.flaps_notch,
    },
    screenHeight: analysis?.screenHeight ?? null,
    rotation: analysis?.rotation ?? null,
    lateral: analysis?.lateral ?? null,
    heading: analysis?.heading ?? null,
    flags: Array.isArray(analysis?.flags) ? analysis.flags : [],
    crosswind: payload.xwind_kts != null ? Math.round(payload.xwind_kts * 10) / 10 : null,
    windSpeed: payload.wind_speed_kts != null ? Math.round(payload.wind_speed_kts) : null,
    windDirectionTrueDeg: normalizeHeadingDegrees(payload.wind_dir_deg),
    runwayHdg: payload.runway_heading_true_deg,
    runwayGeometrySource: payload.runway_geometry_source,
    lateralOffsetSuspect: payload.lateral_offset_suspect,
    finalizeReason: payload.takeoff_finalize_reason,
  };
}

function createTakeoffRunner(): TakeoffRunner {
  if (!TAKEOFF_SCORING_ENABLED) {
    return { update: () => {}, reset: () => {}, isPending: () => false };
  }
  let initialized = false;
  let previousWOW = false;
  let groundSamples: GroundSample[] = [];
  let lastGroundSampleMs: number | null = null;
  let lastGroundFrame: AnyRecord | null = null;
  let lastGroundFrameMs: number | null = null;
  let pending: PendingTakeoff | null = null;
  // Settle-back bookkeeping: the takeoff continues at the next liftoff, so the
  // roll start and any roll excursion from the first liftoff are kept here.
  let hopCount = 0;
  let lastHopEpochMs: number | null = null;
  let hopRollStart: RollStart | null = null;
  let hopRollExcursion = false;
  // The most recent broadcast function, so reset() can tell the UI that a
  // pending takeoff will not be scored.
  let lastEmit: BroadcastFn = () => {};

  function emitCancelled(emit: BroadcastFn, reason: string, nowEpochMs: number): void {
    try {
      emit({ type: 'takeoff', final: false, cancelled: true, reason, timestampMs: nowEpochMs });
    } catch {}
  }

  function clearHopState(): void {
    hopCount = 0;
    lastHopEpochMs = null;
    hopRollStart = null;
    hopRollExcursion = false;
  }

  function reset(): void {
    if (pending || hopCount > 0) {
      Debug.log('takeoff', 'Pending takeoff dropped by reset', { hop_count: hopCount, pending: pending !== null });
      emitCancelled(lastEmit, 'reset', timeSource.now());
    }
    initialized = false;
    previousWOW = false;
    groundSamples = [];
    lastGroundSampleMs = null;
    lastGroundFrame = null;
    lastGroundFrameMs = null;
    pending = null;
    clearHopState();
  }

  function recordGroundSample(frame: AnyRecord, ctx: TakeoffRunnerContext, nowEpochMs: number): void {
    lastGroundFrame = frame;
    lastGroundFrameMs = nowEpochMs;
    const intervalMs = Math.max(0, config.takeoff.rollSampleIntervalMs);
    if (lastGroundSampleMs != null && nowEpochMs - lastGroundSampleMs < intervalMs) return;
    lastGroundSampleMs = nowEpochMs;
    groundSamples.push(buildGroundSample(frame, ctx, nowEpochMs));
    const oldestAllowedMs = nowEpochMs - Math.max(0, config.takeoff.rollBufferMs);
    while (groundSamples.length > 0 && (groundSamples[0].timestampMs < oldestAllowedMs || groundSamples.length > GROUND_SAMPLE_LIMIT)) {
      groundSamples.shift();
    }
  }

  function rejectLiftoff(reason: string, data: AnyRecord): void {
    Debug.log('takeoff', `Ignored WOW release (${reason})`, data);
  }

  function startPending(
    frame: AnyRecord,
    emit: BroadcastFn,
    timeCtx: TimeContext,
    ctx: TakeoffRunnerContext,
    nowEpochMs: number,
  ): void {
    const speeds = getSpeeds(frame);
    const minIasKts = Number.isFinite(config.takeoff.liftoffMinIasKts) ? config.takeoff.liftoffMinIasKts : 35;
    const flyingSpeed = Math.max(speeds.iasKts ?? -Infinity, speeds.gsKts ?? -Infinity);
    if (!(flyingSpeed >= minIasKts)) {
      rejectLiftoff('below_flying_speed', { ias_kts: speeds.iasKts, gs_kts: speeds.gsKts, min_kts: minIasKts });
      return;
    }
    if (speeds.gsKts != null && speeds.gsKts > MAX_LIFTOFF_GS_KTS) {
      rejectLiftoff('implausible_ground_speed', { gs_kts: speeds.gsKts });
      return;
    }
    if (frame.paused === true || frame.inMenu === true) {
      rejectLiftoff('paused', {});
      return;
    }
    if (lastGroundFrameMs == null || nowEpochMs - lastGroundFrameMs > ROLL_CONTIGUOUS_GAP_MS) {
      rejectLiftoff('no_recent_ground_contact', { last_ground_age_ms: lastGroundFrameMs == null ? null : nowEpochMs - lastGroundFrameMs });
      return;
    }

    const run = contiguousGroundRun(groundSamples, nowEpochMs);
    const lastGround = run[run.length - 1];
    if (lastGround && lastGround.onRunway === false && lastGround.runwayLike === false) {
      rejectLiftoff('not_on_runway', { on_runway: lastGround.onRunway, runway_like: lastGround.runwayLike });
      return;
    }

    // A liftoff soon after a settle-back continues the takeoff that already
    // passed the roll checks; the short ground contact in between is not a
    // roll of its own and must not be judged as one.
    const continuingHop = hopCount > 0
      && lastHopEpochMs != null
      && nowEpochMs - lastHopEpochMs <= config.takeoff.hopWindowMs;
    if (!continuingHop) {
      clearHopState();
      const runDurationMs = run.length > 0 ? nowEpochMs - run[0].timestampMs : 0;
      const evidenceWindow = run.filter((sample) => nowEpochMs - sample.timestampMs <= ROLL_EVIDENCE_WINDOW_MS);
      const windowGs = evidenceWindow.map((sample) => sample.gsKts).filter((value): value is number => value != null);
      const minWindowGs = windowGs.length > 0 ? Math.min(...windowGs) : null;
      const liftoffGs = speeds.gsKts ?? speeds.iasKts;
      const accelerationKts = minWindowGs != null && liftoffGs != null ? liftoffGs - minWindowGs : null;
      if (runDurationMs < config.takeoff.minRollDurationMs) {
        rejectLiftoff('ground_roll_too_short', { run_duration_ms: runDurationMs, samples: run.length });
        return;
      }
      if (accelerationKts == null || accelerationKts < config.takeoff.minRollAccelerationKts) {
        rejectLiftoff('not_accelerating', { acceleration_kts: accelerationKts, min_window_gs_kts: minWindowGs, gs_kts: liftoffGs });
        return;
      }
    }

    const rollExcursion = hopRollExcursion || run.some((sample) => (
      sample.gsKts != null
      && sample.gsKts >= ROLL_EXCURSION_MIN_GS_KTS
      && sample.onRunway === false
      && sample.runwayLike === false
    ));
    const position = getPosition(frame);
    const heading = getHeading(frame, ctx);
    const attitude = getAttitude(frame);
    const rollStart = continuingHop && hopRollStart
      ? hopRollStart
      : findTakeoffRollStart(groundSamples, nowEpochMs, heading.hdg_true_deg);
    const groundSurface = lastGroundFrame?.surface ?? frame.surface;
    const aircraftProfileId = ctx.aircraftProfileId ?? null;
    const lightAircraft = isLightAircraftProfile(aircraftProfileId);
    const screen = resolveScreenHeightFt(lightAircraft);
    const configuredMinAirborneRaFt = finiteNumberOrNull(config.landing.touchdownMinAirborneRaFt);
    const confirmAglFt = Math.max(screen.heightFt, configuredMinAirborneRaFt ?? 50);

    pending = {
      liftoffEpochMs: nowEpochMs,
      // Snake_case: this is the payload shape. The analysis point is derived
      // from it in finalize().
      liftoff: {
        lat_deg: position.lat,
        lon_deg: position.lon,
        ias_kts: speeds.iasKts,
        gs_kts: speeds.gsKts,
        ...heading,
        ...attitude,
        alt_msl_ft: finiteNumberOrNull(frame.alt_msl),
        ra_ft: getRadioHeightFt(frame),
        flaps_notch: makeFlapsObj(frame.flaps, frame.flapsIndex, frame.flapsAngleDeg)?.notch ?? null,
        wind_speed_kts: finiteNumberOrNull(frame.windSpeed),
        wind_dir_deg: finiteNumberOrNull(frame.windDir),
        ...getSurfaceSnapshot(groundSurface),
        assists: cloneAssistSnapshot(frame.assists),
      },
      rollStart,
      rollSamples: groundSamples.slice(),
      screenPoint: null,
      screenHeightFt: screen.heightFt,
      screenHeightBasis: screen.basis,
      lightAircraft,
      confirmAglFt,
      maxPitchDeg: attitude.pitch_deg,
      maxBankDeg: attitude.bank_deg == null ? null : Math.abs(attitude.bank_deg),
      maxAglFt: null,
      aglSource: null,
      rollExcursion,
      aircraftName: ctx.aircraftName || '',
      aircraftProfileId,
      phaseAtLiftoff: ctx.phase ?? null,
      timeCtx: {
        flightStartEpochMs: timeCtx.flightStartEpochMs ?? null,
        flightStartIso: timeCtx.flightStartIso ?? '',
      },
    };

    Debug.log('takeoff', 'Liftoff detected', {
      ias_kts: speeds.iasKts,
      gs_kts: speeds.gsKts,
      pitch_deg: attitude.pitch_deg,
      roll_samples: pending.rollSamples.length,
      roll_start_source: rollStart?.source ?? null,
      continuing_hop: continuingHop,
      hop_count: hopCount,
      screen_height_ft: screen.heightFt,
    });
    try {
      emit({
        type: 'takeoff',
        final: false,
        timestampMs: nowEpochMs,
        iasKts: speeds.iasKts != null ? Math.round(speeds.iasKts) : null,
        gsKts: speeds.gsKts != null ? Math.round(speeds.gsKts) : null,
        pitchDeg: attitude.pitch_deg != null ? Math.round(attitude.pitch_deg * 10) / 10 : null,
        hopCount,
        screenHeightFt: screen.heightFt,
      });
    } catch {}
  }

  function trackClimb(frame: AnyRecord, emit: BroadcastFn, ctx: TakeoffRunnerContext, nowEpochMs: number, nowIso: string): void {
    if (!pending) return;
    const attitude = getAttitude(frame);
    if (attitude.pitch_deg != null && (pending.maxPitchDeg == null || attitude.pitch_deg > pending.maxPitchDeg)) {
      pending.maxPitchDeg = attitude.pitch_deg;
    }
    if (attitude.bank_deg != null && (pending.maxBankDeg == null || Math.abs(attitude.bank_deg) > pending.maxBankDeg)) {
      pending.maxBankDeg = Math.abs(attitude.bank_deg);
    }

    let aglFt = getRadioHeightFt(frame);
    let aglSource: string | null = aglFt == null ? null : 'radio';
    if (aglFt == null) {
      const altMsl = finiteNumberOrNull(frame.alt_msl);
      const liftoffAlt = finiteNumberOrNull(pending.liftoff.alt_msl_ft);
      if (altMsl != null && liftoffAlt != null) {
        aglFt = altMsl - liftoffAlt;
        aglSource = 'baro';
      }
    }
    if (aglFt != null) {
      pending.aglSource = pending.aglSource ?? aglSource;
      if (pending.maxAglFt == null || aglFt > pending.maxAglFt) pending.maxAglFt = aglFt;
      if (!pending.screenPoint && aglFt >= pending.screenHeightFt) {
        const position = getPosition(frame);
        const speeds = getSpeeds(frame);
        pending.screenPoint = {
          timestampMs: nowEpochMs,
          lat: position.lat,
          lon: position.lon,
          aglFt,
          aglSource,
          iasKts: speeds.iasKts,
          gsKts: speeds.gsKts,
          pitchDeg: attitude.pitch_deg,
        };
      }
      if (aglFt >= pending.confirmAglFt) {
        finalize(emit, ctx, nowEpochMs, nowIso, 'airborne');
        return;
      }
    }
    if (nowEpochMs - pending.liftoffEpochMs >= config.takeoff.confirmTimeoutMs) {
      finalize(emit, ctx, nowEpochMs, nowIso, aglFt == null ? 'timeout_no_height' : 'timeout');
    }
  }

  function handleSettleBack(emit: BroadcastFn, nowEpochMs: number): void {
    if (!pending) return;
    hopCount += 1;
    lastHopEpochMs = nowEpochMs;
    hopRollStart = pending.rollStart;
    hopRollExcursion = pending.rollExcursion;
    Debug.log('takeoff', 'Aircraft settled back onto the ground after liftoff', {
      hop_count: hopCount,
      airborne_ms: nowEpochMs - pending.liftoffEpochMs,
      max_agl_ft: pending.maxAglFt,
    });
    pending = null;
    try {
      emit({ type: 'takeoff', final: false, settled: true, hopCount, timestampMs: nowEpochMs });
    } catch {}
  }

  /**
   * While waiting for the next liftoff after a settle-back: stopping on the
   * runway or running out the hop window means the takeoff was abandoned.
   */
  function expireSettleBack(frame: AnyRecord, emit: BroadcastFn, nowEpochMs: number): void {
    if (hopCount === 0 || lastHopEpochMs == null) return;
    const gsKts = getSpeeds(frame).gsKts;
    const stopped = gsKts != null && gsKts <= ROLL_STANDSTILL_GS_KTS;
    const expired = nowEpochMs - lastHopEpochMs > config.takeoff.hopWindowMs;
    if (!stopped && !expired) return;
    Debug.log('takeoff', 'Takeoff abandoned after settle-back', {
      hop_count: hopCount,
      reason: stopped ? 'stopped' : 'hop_window_expired',
    });
    clearHopState();
    emitCancelled(emit, stopped ? 'stopped_after_settle_back' : 'settle_back_window_expired', nowEpochMs);
  }

  function resolveGeometry(current: PendingTakeoff, ctx: TakeoffRunnerContext): {
    runwayData: AnyRecord | null;
    runwayReferenceData: AnyRecord | null;
  } {
    const geometryContext = buildAirportGeometryContext(ctx);
    const liftoff = current.liftoff;
    const heading = finiteNumberOrNull(liftoff.hdg_true_deg);
    let runwayData: AnyRecord | null = null;
    if (isValidLatLon(liftoff.lat_deg, liftoff.lon_deg)) {
      runwayData = findRunwayByPosition(liftoff.lat_deg, liftoff.lon_deg, 2, heading, geometryContext);
    }
    if (!runwayData) {
      // A liftoff past the pavement can miss the along-track window; the roll
      // itself is inside the runway, so try a mid-roll sample.
      const midRoll = [...current.rollSamples]
        .reverse()
        .find((sample) => (
          current.liftoffEpochMs - sample.timestampMs >= 10_000
          && sample.gsKts != null && sample.gsKts >= ROLL_EXCURSION_MIN_GS_KTS
          && isValidLatLon(sample.lat, sample.lon)
        ));
      if (midRoll) {
        runwayData = findRunwayByPosition(midRoll.lat as number, midRoll.lon as number, 2, midRoll.headingTrueDeg ?? heading, geometryContext);
      }
    }
    if (!runwayData && ctx.icao && ctx.runway) {
      runwayData = getRunway(ctx.icao, ctx.runway, geometryContext);
    }
    let runwayReferenceData = runwayData;
    if (!runwayReferenceData && isValidLatLon(liftoff.lat_deg, liftoff.lon_deg)) {
      const airportData = findNearbyAirport(liftoff.lat_deg, liftoff.lon_deg, 5, geometryContext);
      if (airportData) runwayReferenceData = { ...airportData, elevationReference: 'airport' };
    }
    return { runwayData, runwayReferenceData };
  }

  function finalize(emit: BroadcastFn, ctx: TakeoffRunnerContext, nowEpochMs: number, nowIso: string, reason: string): void {
    const current = pending;
    if (!current) return;
    pending = null;

    const { runwayData, runwayReferenceData } = resolveGeometry(current, ctx);
    const liftoffPoint = {
      timestampMs: current.liftoffEpochMs,
      lat: current.liftoff.lat_deg,
      lon: current.liftoff.lon_deg,
      iasKts: current.liftoff.ias_kts,
      gsKts: current.liftoff.gs_kts,
      pitchDeg: current.liftoff.pitch_deg,
      bankDeg: current.liftoff.bank_deg,
      headingTrueDeg: current.liftoff.hdg_true_deg,
    };
    const analysis = analyzeTakeoffRoll(current.rollSamples, liftoffPoint, current.screenPoint, {
      runwayData,
      rollStart: current.rollStart,
      screenHeightFt: current.screenHeightFt,
      screenHeightBasis: current.screenHeightBasis,
      runwayExcursion: current.rollExcursion,
      hopCount,
      climb: { maxPitchDeg: current.maxPitchDeg, maxBankDeg: current.maxBankDeg },
      lightAircraft: current.lightAircraft,
      source: 'live',
    });
    const runwayHeading = getRunwayTrueHeadingDeg(runwayData);
    const xwindKts = runwayHeading == null
      ? null
      : computeCrosswind(current.liftoff.wind_speed_kts, current.liftoff.wind_dir_deg, runwayHeading);

    const payload = buildTakeoffPayload({
      pending: current,
      analysis,
      runwayData,
      runwayReferenceData,
      ctx,
      nowEpochMs,
      nowIso,
      xwindKts,
      finalizeReason: reason,
    });
    clearHopState();

    try {
      emit(buildTakeoffBroadcast(payload, analysis));
    } catch {}
    eventBus.emit('takeoff:final', payload);
    console.log(`[takeoff-runner] Emitted takeoff:final — icao=${payload.icao}, runway=${payload.runway}, roll_ft=${payload.takeoff_roll_distance_ft}, remaining_ft=${payload.takeoff_runway_remaining_ft}, grade=${payload.takeoff_runway_use_grade}, reason=${reason}, geometry=${payload.runway_geometry_source || 'none'}`);
    Debug.log('takeoff', 'Emitted takeoff:final event', {
      grade: payload.takeoff_runway_use_grade,
      remaining_ft: payload.takeoff_runway_remaining_ft,
      roll_ft: payload.takeoff_roll_distance_ft,
      reason,
    });
  }

  function update(frame: AnyRecord, broadcast?: BroadcastFn | null, timeCtx: TimeContext = {}, ctx: TakeoffRunnerContext = {}): void {
    if (!frame || typeof frame !== 'object') return;
    const emit: BroadcastFn = typeof broadcast === 'function' ? broadcast : () => {};
    if (typeof broadcast === 'function') lastEmit = broadcast;
    const nowEpochMs = typeof timeCtx.nowEpochMs === 'number' ? timeCtx.nowEpochMs : timeSource.now();
    const nowIso = typeof timeCtx.nowIso === 'string' ? timeCtx.nowIso : new Date(nowEpochMs).toISOString();
    const wow = !!frame.wow;

    if (!initialized) {
      previousWOW = wow;
      initialized = true;
    }
    const liftoffEdge = previousWOW && !wow;
    previousWOW = wow;

    if (wow) {
      if (pending) handleSettleBack(emit, nowEpochMs);
      recordGroundSample(frame, ctx, nowEpochMs);
      expireSettleBack(frame, emit, nowEpochMs);
      return;
    }

    if (liftoffEdge) {
      startPending(frame, emit, timeCtx, ctx, nowEpochMs);
    }
    if (pending) {
      trackClimb(frame, emit, ctx, nowEpochMs, nowIso);
    }
  }

  return { update, reset, isPending: () => pending !== null };
}

module.exports = { createTakeoffRunner };

export {};
