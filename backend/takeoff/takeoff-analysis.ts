'use strict';

/**
 * Takeoff roll analysis.
 *
 * Pure, stateless interpretation of the ground-roll samples and the liftoff /
 * screen-height snapshots that the takeoff runner collects. The runner owns
 * detection and collection; this module owns measurement, scoring and flags,
 * mirroring how rollout-analysis.ts sits behind the landing runner.
 *
 * Runway use and rotation are measurements, not performance grades. A ground
 * overrun needs consistent ground-contact evidence and verified geometry.
 * An airborne sample beyond the pavement alone cannot establish an overrun.
 */

import { isRunwayGeometryScorable } from '../landing/runway-geometry-confidence';

const {
  finiteNumberOrNull,
  getRunwayTrueHeadingDeg,
  headingDifferenceDegrees,
  normalizeHeadingDegrees,
} = require('../utils/aviation-frames.js') as {
  finiteNumberOrNull: (value: unknown) => number | null;
  getRunwayTrueHeadingDeg: (input: Record<string, unknown> | null | undefined) => number | null;
  headingDifferenceDegrees: (left: unknown, right: unknown) => number | null;
  normalizeHeadingDegrees: (value: unknown) => number | null;
};
const { projectPointToRunwayFeet } = require('../analysis/flight-analysis') as {
  projectPointToRunwayFeet: (
    threshold: { lat: unknown; lon: unknown } | null | undefined,
    point: { lat: unknown; lon: unknown } | null | undefined,
    runwayHeadingDeg: unknown,
  ) => { alongTrackFt: number | null; crossTrackFt: number | null; side: string };
};
const landingDistance = require('../landing/landing-distance') as {
  calculateDistanceFt: (lat1: unknown, lon1: unknown, lat2: unknown, lon2: unknown) => number | null;
};

type AnyRecord = Record<string, any>;

export type TakeoffRollSample = {
  timestampMs: number;
  onGround: boolean;
  onRunway: boolean | null;
  runwayLike: boolean | null;
  paused?: boolean;
  gsKts: number | null;
  iasKts: number | null;
  headingTrueDeg: number | null;
  pitchDeg: number | null;
  bankDeg: number | null;
  lat: number | null;
  lon: number | null;
};

export type TakeoffPoint = {
  timestampMs: number;
  lat: number | null;
  lon: number | null;
  gsKts?: number | null;
  iasKts?: number | null;
  pitchDeg?: number | null;
  bankDeg?: number | null;
  headingTrueDeg?: number | null;
  aglFt?: number | null;
};

export type TakeoffAnalysisContext = {
  runwayData?: AnyRecord | null;
  screenHeightFt?: number | null;
  screenHeightBasis?: string | null;
  runwayExcursion?: boolean;
  hopCount?: number;
  /**
   * A roll start established at an earlier liftoff of the same takeoff. After
   * a settle-back the ground samples have an airborne gap, so the roll is
   * taken from this point instead of being rediscovered behind the gap.
   */
  rollStart?: { timestampMs: number; lat?: number | null; lon?: number | null; gsKts?: number | null; source?: string | null } | null;
  climb?: { maxPitchDeg?: number | null; maxBankDeg?: number | null } | null;
  priorRotationMaxRateDegS?: number | null;
  groundContactUncertain?: boolean;
  lightAircraft?: boolean;
  source?: string;
  finalizeReason?: string;
};

type TakeoffSeverity = 'normal' | 'caution' | 'warning' | 'critical';
type TakeoffFlag = {
  code: string;
  label: string;
  severity: Exclude<TakeoffSeverity, 'normal'>;
};

const SEVERITY_RANK: Record<TakeoffSeverity, number> = {
  normal: 0,
  caution: 1,
  warning: 2,
  critical: 3,
};

/** Below this ground speed the aircraft is treated as stopped or lined up. */
const ROLL_STANDSTILL_GS_KTS = 8;
/** A ground sample this far off the runway heading is not part of the roll. */
const ROLL_ALIGNMENT_TOLERANCE_DEG = 30;
const ROLL_LINEUP_GS_KTS = 30;
const ROLL_ALIGNMENT_ACCELERATION_KTS = 5;
/** A gap longer than this between ground samples ends the contiguous roll. */
const ROLL_MAX_SAMPLE_GAP_MS = 5_000;
/** Samples slower than this are ignored for lateral and heading peaks. */
const MIN_ROLL_TRACKING_GS_KTS = 30;
/** Pitch rise above the ground reference that marks rotation. */
const ROTATION_PITCH_DELTA_DEG = 1.0;
const ROTATION_MAX_LOOKBACK_MS = 15_000;
const MIN_ROTATION_DURATION_S = 0.4;

export const TRANSPORT_SCREEN_HEIGHT_FT = 35;
export const LIGHT_AIRCRAFT_SCREEN_HEIGHT_FT = 50;

export type RunwayUseScore = {
  score: number | null;
  grade: string;
  zone: string;
  remainingFt: number | null;
  usedPct: number | null;
  screenRemainingFt: number | null;
  liftoffBeyondEnd: boolean;
  screenBeyondEnd: boolean;
  positionUncertain: boolean;
};

function round(value: number | null | undefined, digits = 1): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** Math.max(0, digits);
  return Math.round(value * factor) / factor;
}

function sideForSigned(value: number | null): 'left' | 'right' | 'center' | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) < 0.5) return 'center';
  return value > 0 ? 'right' : 'left';
}

function addFlag(
  flags: TakeoffFlag[],
  code: string,
  label: string,
  severity: Exclude<TakeoffSeverity, 'normal'>,
): void {
  if (flags.some((flag) => flag.code === code)) return;
  flags.push({ code, label, severity });
}

function maxSeverity(flags: TakeoffFlag[]): TakeoffSeverity {
  let result: TakeoffSeverity = 'normal';
  for (const flag of flags) {
    if (SEVERITY_RANK[flag.severity] > SEVERITY_RANK[result]) result = flag.severity;
  }
  return result;
}

export function resolveScreenHeightFt(lightAircraft: boolean): { heightFt: number; basis: string } {
  return lightAircraft
    ? { heightFt: LIGHT_AIRCRAFT_SCREEN_HEIGHT_FT, basis: 'light_aircraft_50ft' }
    : { heightFt: TRANSPORT_SCREEN_HEIGHT_FT, basis: 'transport_35ft' };
}

/**
 * Measure runway use, retaining the legacy score fields for saved-record compatibility.
 *
 * @param liftoffDistanceFt   distance from the runway's physical threshold to the liftoff point
 * @param screenHeightDistanceFt distance from the same origin to the screen-height crossing, if observed
 * @param confirmedGroundDistanceFt conservative distance supported by recent ground observations
 * @param runwayLengthFt      physical runway length from that origin, not a declared distance
 */
export function scoreTakeoffRunwayUse(input: {
  liftoffDistanceFt: number | null | undefined;
  confirmedGroundDistanceFt?: number | null;
  screenHeightDistanceFt?: number | null | undefined;
  runwayLengthFt: number | null | undefined;
}): RunwayUseScore {
  const liftoffDistanceFt = finiteNumberOrNull(input.liftoffDistanceFt);
  const lengthFt = finiteNumberOrNull(input.runwayLengthFt);
  const screenDistanceFt = finiteNumberOrNull(input.screenHeightDistanceFt);
  const unknown: RunwayUseScore = {
    score: null,
    grade: 'Unknown',
    zone: 'Runway geometry unavailable',
    remainingFt: null,
    usedPct: null,
    screenRemainingFt: null,
    liftoffBeyondEnd: false,
    screenBeyondEnd: false,
    positionUncertain: false,
  };
  if (liftoffDistanceFt === null || lengthFt === null || lengthFt <= 0) return unknown;

  const remainingRawFt = lengthFt - liftoffDistanceFt;
  const remainingFt = Math.round(remainingRawFt);
  const usedPct = round(Math.max(0, liftoffDistanceFt) / lengthFt * 100, 1);
  const screenRemainingFt = screenDistanceFt === null ? null : Math.round(lengthFt - screenDistanceFt);
  const groundDistanceFt = finiteNumberOrNull(input.confirmedGroundDistanceFt);
  const liftoffBeyondEnd = remainingRawFt < 0 && groundDistanceFt != null && groundDistanceFt > lengthFt;
  const positionUncertain = remainingRawFt < 0 && !liftoffBeyondEnd;
  const screenBeyondEnd = screenDistanceFt !== null && screenDistanceFt > lengthFt;
  return {
    remainingFt: positionUncertain ? null : remainingFt,
    usedPct: positionUncertain ? null : usedPct,
    screenRemainingFt, liftoffBeyondEnd, screenBeyondEnd, positionUncertain,
    score: null,
    grade: liftoffBeyondEnd ? 'Overrun' : positionUncertain ? 'Unknown' : 'Recorded',
    zone: liftoffBeyondEnd ? 'Ground contact beyond runway end'
      : positionUncertain ? 'Liftoff position uncertain at runway end' : 'Observed runway remaining',
  };
}

function normalizeSample(value: AnyRecord): TakeoffRollSample | null {
  const timestampMs = finiteNumberOrNull(value?.timestampMs ?? value?.timestamp_ms ?? value?.ts);
  if (timestampMs == null) return null;
  const onGround = value?.onGround === true || value?.wow === true || value?.on_ground === true;
  return {
    timestampMs,
    onGround,
    onRunway: typeof value?.onRunway === 'boolean' ? value.onRunway : null,
    runwayLike: typeof value?.runwayLike === 'boolean' ? value.runwayLike : null,
    paused: value?.paused === true,
    gsKts: finiteNumberOrNull(value?.gsKts ?? value?.gs_kts ?? value?.gs),
    iasKts: finiteNumberOrNull(value?.iasKts ?? value?.ias_kts ?? value?.ias),
    headingTrueDeg: normalizeHeadingDegrees(value?.headingTrueDeg ?? value?.hdg_true_deg),
    pitchDeg: finiteNumberOrNull(value?.pitchDeg ?? value?.pitch_deg),
    bankDeg: finiteNumberOrNull(value?.bankDeg ?? value?.bank_deg),
    lat: finiteNumberOrNull(value?.lat ?? value?.lat_deg),
    lon: finiteNumberOrNull(value?.lon ?? value?.lon_deg),
  };
}

/**
 * The contiguous ground samples that belong to this takeoff roll, oldest
 * first. Ground continuity and the last stop bound the candidate. Explicit
 * runway entry excludes preceding taxi, even when taxi speed exceeds 30 kt.
 * Heading and surface deviations after acceleration remain assessment evidence.
 */
function selectRollSamples(
  samples: TakeoffRollSample[],
  liftoffTimestampMs: number,
  referenceHeadingDeg: number | null,
): TakeoffRollSample[] {
  const ground = samples
    .filter((sample) => sample.onGround && sample.timestampMs <= liftoffTimestampMs)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const contiguous: TakeoffRollSample[] = [];
  let nextTimestampMs = liftoffTimestampMs;
  for (let index = ground.length - 1; index >= 0; index -= 1) {
    const sample = ground[index];
    if (nextTimestampMs - sample.timestampMs > ROLL_MAX_SAMPLE_GAP_MS) break;
    if (sample.paused) break;
    contiguous.push(sample);
    nextTimestampMs = sample.timestampMs;
    if (sample.gsKts != null && sample.gsKts <= ROLL_STANDSTILL_GS_KTS) break;
  }
  contiguous.reverse();
  const runwayEntry = contiguous.findIndex((sample) => sample.onRunway === true);
  const hadOffRunwayTaxi = runwayEntry > 0
    && contiguous.slice(0, runwayEntry).some((sample) => sample.onRunway === false);
  const candidate = hadOffRunwayTaxi ? contiguous.slice(runwayEntry) : contiguous;
  if (candidate.length === 0) return [];

  // A fast rolling entry can still be turning. Establish direction after an
  // observed speed increase, then retain all subsequent heading deviations.
  // Use the final acceleration from lineup speed, since an earlier taxi run
  // may also have exceeded this speed when runway membership was unavailable.
  let accelerationStart = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const speed = candidate[index].gsKts;
    if (speed != null && speed < ROLL_LINEUP_GS_KTS) accelerationStart = index;
  }
  const accelerating = candidate.slice(accelerationStart);
  const entrySpeed = accelerating.find((sample) => sample.gsKts != null)?.gsKts ?? 0;
  const acceleration = accelerating.find((sample) => sample.gsKts != null
    && sample.gsKts >= Math.max(ROLL_LINEUP_GS_KTS, entrySpeed + ROLL_ALIGNMENT_ACCELERATION_KTS)
    && sample.headingTrueDeg != null);
  const establishedHeading = acceleration?.headingTrueDeg ?? referenceHeadingDeg;
  const roll: TakeoffRollSample[] = [];
  for (let index = candidate.length - 1; index >= 0; index -= 1) {
    const sample = candidate[index];
    if (
      establishedHeading != null
      && sample.headingTrueDeg != null
      && sample.gsKts != null
      && sample.gsKts > ROLL_STANDSTILL_GS_KTS
      && (!acceleration || sample.timestampMs <= acceleration.timestampMs)
    ) {
      const deviation = headingDifferenceDegrees(sample.headingTrueDeg, establishedHeading);
      if (deviation != null && Math.abs(deviation) > ROLL_ALIGNMENT_TOLERANCE_DEG) break;
    }
    roll.push(sample);
  }
  return roll.reverse();
}

function findRollStart(roll: TakeoffRollSample[]): { sample: TakeoffRollSample; source: string } | null {
  if (roll.length === 0) return null;
  for (let index = roll.length - 1; index >= 0; index -= 1) {
    const sample = roll[index];
    if (sample.gsKts != null && sample.gsKts <= ROLL_STANDSTILL_GS_KTS) {
      return { sample, source: 'standstill' };
    }
  }
  return { sample: roll[0], source: 'runway_aligned' };
}

function findRotationStart(
  roll: TakeoffRollSample[],
  liftoffTimestampMs: number,
): { sample: TakeoffRollSample; referencePitchDeg: number } | null {
  const withPitch = roll.filter((sample) => sample.pitchDeg != null);
  if (withPitch.length < 3) return null;
  // Ground reference: the median pitch of the roll before the last 15 s, or
  // of the first half of the roll when the roll is shorter than that.
  const referenceCutoffMs = liftoffTimestampMs - ROTATION_MAX_LOOKBACK_MS;
  let referencePool = withPitch.filter((sample) => sample.timestampMs <= referenceCutoffMs);
  if (referencePool.length < 2) referencePool = withPitch.slice(0, Math.max(2, Math.floor(withPitch.length / 2)));
  const sortedPitch = referencePool.map((sample) => sample.pitchDeg as number).sort((a, b) => a - b);
  const referencePitchDeg = sortedPitch[Math.floor(sortedPitch.length / 2)];

  let rotationStart: TakeoffRollSample | null = null;
  for (let index = withPitch.length - 1; index >= 0; index -= 1) {
    const sample = withPitch[index];
    if (liftoffTimestampMs - sample.timestampMs > ROTATION_MAX_LOOKBACK_MS) break;
    if ((sample.pitchDeg as number) < referencePitchDeg + ROTATION_PITCH_DELTA_DEG) break;
    rotationStart = sample;
  }
  return rotationStart ? { sample: rotationStart, referencePitchDeg } : null;
}

function resolveRunwayOrigin(runwayData: AnyRecord | null | undefined): {
  origin: { lat: number; lon: number } | null;
  originKind: 'physical_threshold' | 'threshold' | null;
  lengthFt: number | null;
  headingTrueDeg: number | null;
  widthFt: number | null;
} {
  if (!runwayData || typeof runwayData !== 'object') {
    return { origin: null, originKind: null, lengthFt: null, headingTrueDeg: null, widthFt: null };
  }
  const physical = runwayData.physicalThreshold || runwayData.physical_threshold || null;
  const displaced = runwayData.threshold || null;
  const physicalLat = finiteNumberOrNull(physical?.lat);
  const physicalLon = finiteNumberOrNull(physical?.lon);
  const displacedLat = finiteNumberOrNull(displaced?.lat);
  const displacedLon = finiteNumberOrNull(displaced?.lon);
  const physicalLengthFt = finiteNumberOrNull(runwayData.physicalLengthFt ?? runwayData.physical_length_ft);
  const lengthFt = finiteNumberOrNull(runwayData.lengthFt ?? runwayData.length_ft);
  const headingTrueDeg = getRunwayTrueHeadingDeg(runwayData);
  const widthFt = finiteNumberOrNull(runwayData.widthFt ?? runwayData.width_ft);

  if (physicalLat != null && physicalLon != null && physicalLengthFt != null && physicalLengthFt > 0) {
    return {
      origin: { lat: physicalLat, lon: physicalLon },
      originKind: 'physical_threshold',
      lengthFt: physicalLengthFt,
      headingTrueDeg,
      widthFt,
    };
  }
  if (displacedLat != null && displacedLon != null && lengthFt != null && lengthFt > 0) {
    return {
      origin: { lat: displacedLat, lon: displacedLon },
      originKind: 'threshold',
      lengthFt,
      headingTrueDeg,
      widthFt,
    };
  }
  return { origin: null, originKind: null, lengthFt: null, headingTrueDeg, widthFt };
}

function alongTrack(
  origin: { lat: number; lon: number } | null,
  headingTrueDeg: number | null,
  point: { lat: number | null; lon: number | null } | null | undefined,
): { alongTrackFt: number | null; crossTrackFt: number | null } {
  if (!origin || headingTrueDeg == null || !point || point.lat == null || point.lon == null) {
    return { alongTrackFt: null, crossTrackFt: null };
  }
  const projected = projectPointToRunwayFeet(origin, { lat: point.lat, lon: point.lon }, headingTrueDeg);
  return { alongTrackFt: projected.alongTrackFt, crossTrackFt: projected.crossTrackFt };
}

/**
 * Locate the roll start behind a liftoff without scoring anything. The runner
 * records it at the first liftoff so a settle-back cannot lose it.
 */
export function findTakeoffRollStart(
  rawSamples: AnyRecord[] | null | undefined,
  liftoffTimestampMs: number,
  referenceHeadingDeg: number | null,
): { timestampMs: number; lat: number | null; lon: number | null; gsKts: number | null; source: string } | null {
  if (!Number.isFinite(liftoffTimestampMs)) return null;
  const samples = (Array.isArray(rawSamples) ? rawSamples : [])
    .map(normalizeSample)
    .filter((sample): sample is TakeoffRollSample => sample !== null);
  const rollStart = findRollStart(selectRollSamples(samples, liftoffTimestampMs, normalizeHeadingDegrees(referenceHeadingDeg)));
  if (!rollStart) return null;
  return {
    timestampMs: rollStart.sample.timestampMs,
    lat: rollStart.sample.lat,
    lon: rollStart.sample.lon,
    gsKts: rollStart.sample.gsKts,
    source: rollStart.source,
  };
}

export function analyzeTakeoffRoll(
  rawSamples: AnyRecord[] | null | undefined,
  liftoff: TakeoffPoint | null | undefined,
  screen: TakeoffPoint | null | undefined,
  context: TakeoffAnalysisContext = {},
): AnyRecord | null {
  if (!liftoff || !Number.isFinite(liftoff.timestampMs)) return null;
  const samples = (Array.isArray(rawSamples) ? rawSamples : [])
    .map(normalizeSample)
    .filter((sample): sample is TakeoffRollSample => sample !== null);

  const runwayData = context.runwayData || null;
  const runway = resolveRunwayOrigin(runwayData);
  const geometrySource = typeof runwayData?.source === 'string' ? runwayData.source : null;
  const liftoffHeadingDeg = normalizeHeadingDegrees(liftoff.headingTrueDeg);
  const referenceHeadingDeg = runway.headingTrueDeg ?? liftoffHeadingDeg;

  const establishedRollStartMs = finiteNumberOrNull(context.rollStart?.timestampMs);
  const roll = establishedRollStartMs != null
    ? samples
      .filter((sample) => sample.onGround
        && sample.timestampMs >= establishedRollStartMs
        && sample.timestampMs <= liftoff.timestampMs)
      .sort((left, right) => left.timestampMs - right.timestampMs)
    : selectRollSamples(samples, liftoff.timestampMs, referenceHeadingDeg);
  const rollStart = establishedRollStartMs != null
    ? {
      sample: {
        timestampMs: establishedRollStartMs,
        onGround: true,
        onRunway: null,
        runwayLike: null,
        gsKts: finiteNumberOrNull(context.rollStart?.gsKts),
        iasKts: null,
        headingTrueDeg: null,
        pitchDeg: null,
        bankDeg: null,
        lat: finiteNumberOrNull(context.rollStart?.lat),
        lon: finiteNumberOrNull(context.rollStart?.lon),
      } as TakeoffRollSample,
      source: typeof context.rollStart?.source === 'string' && context.rollStart.source
        ? context.rollStart.source
        : 'standstill',
    }
    : findRollStart(roll);

  const liftoffProjection = alongTrack(runway.origin, runway.headingTrueDeg, liftoff);
  const rollStartProjection = rollStart
    ? alongTrack(runway.origin, runway.headingTrueDeg, rollStart.sample)
    : { alongTrackFt: null, crossTrackFt: null };
  const screenProjection = screen
    ? alongTrack(runway.origin, runway.headingTrueDeg, screen)
    : { alongTrackFt: null, crossTrackFt: null };

  let rollDistanceFt: number | null = null;
  let rollDistanceSource: string | null = null;
  if (rollStart) {
    if (liftoffProjection.alongTrackFt != null && rollStartProjection.alongTrackFt != null) {
      rollDistanceFt = Math.max(0, Math.round(liftoffProjection.alongTrackFt - rollStartProjection.alongTrackFt));
      rollDistanceSource = 'runway_projection';
    } else {
      const direct = landingDistance.calculateDistanceFt(
        rollStart.sample.lat,
        rollStart.sample.lon,
        liftoff.lat,
        liftoff.lon,
      );
      if (direct != null) {
        rollDistanceFt = Math.round(direct);
        rollDistanceSource = 'position_delta';
      }
    }
  }
  const rollDurationS = rollStart
    ? round(Math.max(0, liftoff.timestampMs - rollStart.sample.timestampMs) / 1000, 1)
    : null;

  const liftoffDistanceFt = liftoffProjection.alongTrackFt == null
    ? null
    : Math.round(liftoffProjection.alongTrackFt);
  const screenDistanceFt = screenProjection.alongTrackFt == null
    ? null
    : Math.round(screenProjection.alongTrackFt);
  // One airborne position beyond the end cannot establish a surface overrun.
  // Require two recent, consistent ground observations with valid off-runway
  // membership. Unknown or contradictory surface data stays inconclusive.
  const groundEndSamples = roll.slice(-2);
  const groundEndProjections = groundEndSamples.length === 2
    && groundEndSamples[1].timestampMs > groundEndSamples[0].timestampMs && groundEndSamples.every((sample) => (
    sample.onRunway === false && sample.gsKts != null && sample.gsKts >= MIN_ROLL_TRACKING_GS_KTS
    && liftoff.timestampMs - sample.timestampMs <= 3000
  )) ? groundEndSamples.map((sample) => alongTrack(runway.origin, runway.headingTrueDeg, sample)) : [];
  const groundDistances = groundEndProjections.map((point) => point.alongTrackFt);
  const confirmedGroundDistanceFt = groundDistances.length === 2 && groundDistances.every((value) => value != null)
    ? Math.min(...groundDistances as number[]) : null;
  const runwayUse = scoreTakeoffRunwayUse({
    liftoffDistanceFt: liftoffProjection.alongTrackFt,
    confirmedGroundDistanceFt,
    screenHeightDistanceFt: screenProjection.alongTrackFt,
    runwayLengthFt: runway.lengthFt,
  });

  // Rotation
  const rotationStart = findRotationStart(roll, liftoff.timestampMs);
  const liftoffPitchDeg = finiteNumberOrNull(liftoff.pitchDeg);
  let rotationRateDegS: number | null = null;
  let rotationDurationS: number | null = null;
  if (rotationStart && liftoffPitchDeg != null) {
    const durationS = (liftoff.timestampMs - rotationStart.sample.timestampMs) / 1000;
    if (durationS >= MIN_ROTATION_DURATION_S) {
      rotationDurationS = round(durationS, 1);
      rotationRateDegS = round((liftoffPitchDeg - (rotationStart.sample.pitchDeg as number)) / durationS, 2);
    }
  }
  const climbMaxPitchDeg = finiteNumberOrNull(context.climb?.maxPitchDeg);
  const pitches = [climbMaxPitchDeg, liftoffPitchDeg, ...roll.map((sample) => sample.pitchDeg)]
    .filter((value): value is number => value != null);
  const maxPitchDeg = pitches.length ? Math.max(...pitches) : null;
  const priorRotationMaxRateDegS = finiteNumberOrNull(context.priorRotationMaxRateDegS);
  const rates = [priorRotationMaxRateDegS, rotationRateDegS].filter((value): value is number => value != null);
  const maxRotationRateDegS = rates.length ? Math.max(...rates) : null;

  // Lateral offset and heading control during the roll
  const geometryScorable = isRunwayGeometryScorable(geometrySource)
    && runway.widthFt != null && runway.widthFt > 0;
  let peakLateralSignedFt: number | null = null;
  let peakHeadingDeviationSignedDeg: number | null = null;
  let previousHeading: { timestampMs: number; deviation: number } | null = null;
  let confirmedHeadingDeviationDeg = 0;
  let surfaceGeometryConflict = false;
  for (const sample of roll) {
    if (sample.gsKts == null || sample.gsKts < MIN_ROLL_TRACKING_GS_KTS) {
      previousHeading = null;
      continue;
    }
    const projection = alongTrack(runway.origin, runway.headingTrueDeg, sample);
    if (projection.crossTrackFt != null) {
      if (
        sample.onRunway === true
        && ((runway.widthFt != null && runway.widthFt > 0
          && Math.abs(projection.crossTrackFt) > runway.widthFt / 2)
          || (projection.alongTrackFt != null && runway.lengthFt != null
            && (projection.alongTrackFt < -50 || projection.alongTrackFt > runway.lengthFt + 50)))
      ) surfaceGeometryConflict = true;
      if (peakLateralSignedFt == null || Math.abs(projection.crossTrackFt) > Math.abs(peakLateralSignedFt)) {
        peakLateralSignedFt = projection.crossTrackFt;
      }
    }
    if (runway.headingTrueDeg != null && sample.headingTrueDeg != null) {
      const deviation = headingDifferenceDegrees(sample.headingTrueDeg, runway.headingTrueDeg);
      if (
        deviation != null
        && (peakHeadingDeviationSignedDeg == null || Math.abs(deviation) > Math.abs(peakHeadingDeviationSignedDeg))
      ) peakHeadingDeviationSignedDeg = deviation;
      // Preserve the measured peak, but an isolated spike cannot establish a
      // roll-control finding. Two nearby observations must agree on the side.
      if (deviation != null && previousHeading
        && sample.timestampMs > previousHeading.timestampMs
        && sample.timestampMs - previousHeading.timestampMs <= 1000
        && Math.sign(deviation) === Math.sign(previousHeading.deviation)) {
        confirmedHeadingDeviationDeg = Math.max(confirmedHeadingDeviationDeg,
          Math.min(Math.abs(deviation), Math.abs(previousHeading.deviation)));
      }
      previousHeading = deviation == null ? null : { timestampMs: sample.timestampMs, deviation };
    } else previousHeading = null;
  }
  const liftoffLateralSignedFt = liftoffProjection.crossTrackFt == null
    ? null
    : Math.round(liftoffProjection.crossTrackFt);
  const lateralVerified = geometryScorable && !surfaceGeometryConflict && liftoffLateralSignedFt != null;
  const groundOutsideEdge = geometryScorable && !surfaceGeometryConflict
    && groundEndProjections.length === 2
    && groundEndProjections.every((point) => point.crossTrackFt != null
      && Math.abs(point.crossTrackFt) > (runway.widthFt as number) / 2)
    && Math.sign(groundEndProjections[0].crossTrackFt as number) === Math.sign(groundEndProjections[1].crossTrackFt as number);
  const liftoffHeadingDeviationDeg = runway.headingTrueDeg != null && liftoffHeadingDeg != null
    ? headingDifferenceDegrees(liftoffHeadingDeg, runway.headingTrueDeg)
    : null;

  const runwayVerified = isRunwayGeometryScorable(geometrySource, surfaceGeometryConflict)
    && runway.originKind === 'physical_threshold';
  if (!runwayVerified) {
    runwayUse.score = null;
    runwayUse.grade = 'Unknown';
    runwayUse.zone = surfaceGeometryConflict ? 'Runway geometry conflicts with surface data' : 'Runway geometry unverified';
    runwayUse.liftoffBeyondEnd = false;
    runwayUse.positionUncertain = false;
    runwayUse.remainingFt = liftoffProjection.alongTrackFt != null && runway.lengthFt != null
      ? Math.round(runway.lengthFt - liftoffProjection.alongTrackFt) : null;
    runwayUse.usedPct = liftoffProjection.alongTrackFt != null && runway.lengthFt != null && runway.lengthFt > 0
      ? round(Math.max(0, liftoffProjection.alongTrackFt) / runway.lengthFt * 100, 1) : null;
  }

  // Flags
  const flags: TakeoffFlag[] = [];
  const runwayExcursion = context.runwayExcursion === true;
  const hopCount = Math.max(0, Math.round(finiteNumberOrNull(context.hopCount) ?? 0));
  if (runwayExcursion) addFlag(flags, 'runway_excursion', 'Runway excursion during the takeoff roll', 'critical');
  if (runwayUse.liftoffBeyondEnd) {
    addFlag(flags, 'liftoff_beyond_runway_end', 'Ground contact beyond the runway end', 'critical');
  } else if (runwayUse.positionUncertain) {
    addFlag(flags, 'liftoff_position_uncertain', 'Liftoff position uncertain at the runway end', 'caution');
  }
  if (!screen) {
    addFlag(flags, 'climb_incomplete', 'Climb-out measurement incomplete; screen height not observed', 'caution');
  }
  if (hopCount > 0) {
    addFlag(flags, 'settled_after_liftoff', hopCount === 1
      ? 'Settled back onto the runway once after lifting off'
      : `Settled back onto the runway ${hopCount} times after lifting off`, 'caution');
  }
  if (context.groundContactUncertain === true) {
    addFlag(flags, 'ground_contact_uncertain', 'Brief ground-contact indication; contact not confirmed', 'caution');
  }
  const maxHeadingDeviationDeg = peakHeadingDeviationSignedDeg == null ? null : Math.abs(peakHeadingDeviationSignedDeg);
  if (geometryScorable && !surfaceGeometryConflict) {
    if (confirmedHeadingDeviationDeg >= 20) addFlag(flags, 'heading_deviation', 'Major runway-heading deviation during the roll', 'warning');
    else if (confirmedHeadingDeviationDeg >= 10) addFlag(flags, 'heading_deviation', 'Runway-heading deviation during the roll', 'caution');
  }
  if (groundOutsideEdge) {
    addFlag(flags, 'lateral_offset', 'Ground contact outside the runway reference edge', 'warning');
  }

  const screenHeightFt = finiteNumberOrNull(context.screenHeightFt) ?? TRANSPORT_SCREEN_HEIGHT_FT;
  return {
    schemaVersion: 3,
    source: typeof context.source === 'string' && context.source ? context.source : 'computed',
    assessment: maxSeverity(flags),
    sampleCount: roll.length,
    rollStart: rollStart ? {
      timestampMs: rollStart.sample.timestampMs,
      lat: rollStart.sample.lat,
      lon: rollStart.sample.lon,
      gsKts: round(rollStart.sample.gsKts),
      source: rollStart.source,
    } : null,
    rollDistanceFt,
    rollDistanceSource,
    rollDurationS,
    liftoff: {
      timestampMs: liftoff.timestampMs,
      lat: liftoff.lat,
      lon: liftoff.lon,
      iasKts: round(finiteNumberOrNull(liftoff.iasKts)),
      gsKts: round(finiteNumberOrNull(liftoff.gsKts)),
      pitchDeg: round(liftoffPitchDeg),
      headingTrueDeg: round(liftoffHeadingDeg),
      distanceFt: runwayUse.positionUncertain ? null : liftoffDistanceFt,
      remainingFt: runwayUse.remainingFt,
      usedPct: runwayUse.usedPct,
      beyondRunwayEnd: runwayUse.liftoffBeyondEnd,
    },
    runwayUse: {
      score: runwayUse.score,
      grade: runwayUse.grade,
      zone: runwayUse.zone,
      verified: runwayVerified,
      notScoredReason: runwayUse.positionUncertain ? 'liftoff_position_uncertain'
        : runwayVerified ? null : surfaceGeometryConflict ? 'surface_geometry_conflict' : 'runway_geometry_unverified',
    },
    screenHeight: {
      heightFt: screenHeightFt,
      basis: typeof context.screenHeightBasis === 'string' ? context.screenHeightBasis : null,
      reached: Boolean(screen),
      timestampMs: screen?.timestampMs ?? null,
      elapsedS: screen ? round(Math.max(0, screen.timestampMs - liftoff.timestampMs) / 1000, 1) : null,
      distanceFt: screenDistanceFt,
      remainingFt: runwayUse.screenRemainingFt,
      beyondRunwayEnd: runwayUse.screenBeyondEnd,
      observationReason: screen ? 'observed' : context.finalizeReason || 'not_observed',
    },
    rotation: {
      startTimestampMs: rotationStart?.sample.timestampMs ?? null,
      referencePitchDeg: round(rotationStart?.referencePitchDeg ?? null),
      startPitchDeg: round(rotationStart?.sample.pitchDeg ?? null),
      liftoffPitchDeg: round(liftoffPitchDeg),
      durationS: rotationDurationS,
      rateDegS: rotationRateDegS,
      maxRateDegS: maxRotationRateDegS,
      priorMaxRateDegS: priorRotationMaxRateDegS,
      maxPitchDeg: round(maxPitchDeg),
    },
    lateral: {
      liftoffOffsetFt: liftoffLateralSignedFt == null ? null : Math.abs(liftoffLateralSignedFt),
      liftoffOffsetSide: sideForSigned(liftoffLateralSignedFt),
      maxOffsetFt: peakLateralSignedFt == null ? null : Math.round(Math.abs(peakLateralSignedFt)),
      maxOffsetSide: sideForSigned(peakLateralSignedFt),
      score: null,
      grade: lateralVerified ? 'Recorded' : 'Unverified',
      verified: lateralVerified,
      suspect: surfaceGeometryConflict,
      notScoredReason: lateralVerified
        ? null
        : surfaceGeometryConflict
          ? 'surface_geometry_conflict'
          : liftoffLateralSignedFt == null
            ? 'runway_geometry_unavailable'
            : 'runway_geometry_unverified',
    },
    heading: {
      liftoffDeviationDeg: liftoffHeadingDeviationDeg == null ? null : round(Math.abs(liftoffHeadingDeviationDeg)),
      liftoffDeviationSide: sideForSigned(liftoffHeadingDeviationDeg),
      maxDeviationDeg: round(maxHeadingDeviationDeg),
      maxDeviationSide: sideForSigned(peakHeadingDeviationSignedDeg),
    },
    hopCount,
    runwayExcursion,
    runway: runwayData ? {
      icao: runwayData.icao ?? null,
      id: runwayData.runway ?? runwayData.runwayId ?? null,
      headingTrueDeg: round(runway.headingTrueDeg),
      lengthFt: runway.lengthFt,
      widthFt: runway.widthFt,
      source: geometrySource,
      originKind: runway.originKind,
      originLat: runway.origin?.lat ?? null,
      originLon: runway.origin?.lon ?? null,
    } : null,
    flags,
  };
}

module.exports = {
  analyzeTakeoffRoll,
  findTakeoffRollStart,
  resolveScreenHeightFt,
  scoreTakeoffRunwayUse,
  TRANSPORT_SCREEN_HEIGHT_FT,
  LIGHT_AIRCRAFT_SCREEN_HEIGHT_FT,
};
