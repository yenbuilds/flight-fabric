/**
 * Shared flight-analysis helpers.
 *
 * This module owns the small pure functions that must stay identical between
 * the live landing path and CSV replay. Keep simulator/provider interpretation
 * at the boundary and pass unit-explicit values through this file.
 */

'use strict';

const landingDistance = require('../landing/landing-distance') as LandingDistanceModule;
const { getRunwayTrueHeadingDeg } = require('../utils/aviation-frames') as AviationFramesModule;

type AnyRecord = Record<string, any>;
type NullableNumber = number | null | undefined;
type Coordinate = { lat: NullableNumber; lon: NullableNumber };
type RunwayData = AnyRecord & {
  threshold?: Coordinate | null;
  physicalThreshold?: Coordinate | null;
  heading?: NullableNumber;
  heading_true_deg?: NullableNumber;
  headingTrueDeg?: NullableNumber;
  runway_heading_true_deg?: NullableNumber;
  runway_heading?: NullableNumber;
  runwayHeading?: NullableNumber;
  lengthFt?: NullableNumber;
  length_ft?: NullableNumber;
  physicalLengthFt?: NullableNumber;
  physical_length_ft?: NullableNumber;
  displacedThresholdFt?: NullableNumber;
  displaced_threshold_ft?: NullableNumber;
  widthFt?: NullableNumber;
  width_ft?: NullableNumber;
  surface?: string | null;
  source?: string | null;
  icao?: string | null;
  runway?: string | null;
  runwayId?: string | null;
};
type BounceScoring = {
  score?: NullableNumber;
  grade?: string | null;
  distanceTraveledFt?: NullableNumber;
  worstGforce?: NullableNumber;
};
type TouchdownRunwayAnalysis = {
  touchdownDistanceData: AnyRecord;
  shortLandingDetected: boolean;
  tdzAchieved: boolean;
};
type LandingDistanceModule = {
  calculateTouchdownDistance: (threshold: Coordinate, touchdown: Coordinate) => number | null;
  calculateSignedTouchdownDistance: (
    threshold: Coordinate,
    touchdown: Coordinate,
    headingDeg: number,
  ) => { distanceFt: number | null; isShort: boolean };
  calculateLateralOffset: (
    threshold: Coordinate,
    touchdown: Coordinate,
    headingDeg: number,
  ) => { offsetFt: number | null; side: string };
  scoreTouchdownDistance: (distanceFt: number | null, options?: AnyRecord) => AnyRecord;
  scoreLateralOffset: (offsetFt: number | null, runwayWidthFt?: number | null) => AnyRecord;
  inferSurfaceCondition: (inputs: AnyRecord) => AnyRecord;
  TOUCHDOWN_ZONE_MAX_FT: number;
};
type AviationFramesModule = {
  getRunwayTrueHeadingDeg: (input: AnyRecord | null | undefined) => number | null;
};

const FT_PER_DEG_LAT = 364567;

function finiteNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function averageFinite(values: unknown[]): number | null {
  const finite = values
    .map(finiteNumberOrNull)
    .filter((value): value is number => value !== null);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function buildCanonicalStabilityFrameFromCsvRow(row: AnyRecord, dtMs: number | null): AnyRecord {
  return {
    raFt: finiteNumberOrNull(row.ra_ft),
    altMslFt: finiteNumberOrNull(row.alt_msl_ft),
    altCalibratedFt: finiteNumberOrNull(row.alt_calibrated_ft),
    altPlaneFt: finiteNumberOrNull(row.alt_plane_ft),
    pressureAltFt: finiteNumberOrNull(row.pressure_alt_ft),
    aircraftAglFt: finiteNumberOrNull(row.aircraft_agl_ft),
    aircraftAboveObstaclesFt: finiteNumberOrNull(row.aircraft_above_obstacles_ft),
    planeAglFt: finiteNumberOrNull(row.plane_agl_ft),
    planeAglMinusCgFt: finiteNumberOrNull(row.plane_agl_minus_cg_ft),
    iasKts: finiteNumberOrNull(row.ias_kts),
    vsFpm: finiteNumberOrNull(row.vs_fpm),
    gsKts: finiteNumberOrNull(row.gs_kts),
    gearDownLocked: finiteNumberOrNull(row.gear_down_locked),
    flapsPercent: finiteNumberOrNull(row.flaps_pct ?? row.flaps_percent),
    flapsNotch: finiteNumberOrNull(row.flaps_notch),
    spoilersPercent: finiteNumberOrNull(row.spoiler_pct),
    spoilersState: row.spoiler_state || null,
    pitchDeg: finiteNumberOrNull(row.pitch_deg),
    bankDeg: finiteNumberOrNull(row.bank_deg),
    headingDeg: finiteNumberOrNull(row.hdg_true_deg),
    thrustPct: averageFinite([row.thr1_pct, row.thr2_pct, row.thr3_pct, row.thr4_pct]),
    onGround: booleanOrNull(row.on_ground) === true,
    paused: booleanOrNull(row.sim_paused) === true,
    inMenu: booleanOrNull(row.sim_in_menu) === true,
    latDeg: finiteNumberOrNull(row.lat_deg),
    lonDeg: finiteNumberOrNull(row.lon_deg),
    dtMs: finiteNumberOrNull(dtMs),
  };
}

function buildDefaultTouchdownDistanceData(bounceScoring: BounceScoring = {}): AnyRecord {
  return {
    touchdown_distance_ft: null,
    runway_length_ft: null,
    runway_physical_length_ft: null,
    runway_surface: null,
    runway_geometry_source: null,
    runway_geometry_provider_chain: null,
    runway_geometry_fallback_reason: null,
    runway_geometry_diagnostics: null,
    runway_heading_true_deg: null,
    runway_threshold_lat: null,
    runway_threshold_lon: null,
    runway_physical_threshold_lat: null,
    runway_physical_threshold_lon: null,
    runway_displaced_threshold_ft: null,
    touchdown_distance_score: null,
    touchdown_distance_grade: null,
    touchdown_distance_zone: null,
    runway_icao: null,
    runway_id: null,
    short_landing: null,
    runway_condition: null,
    runway_condition_source: null,
    runway_condition_confident: null,
    lateral_offset_ft: null,
    lateral_offset_side: null,
    lateral_offset_score: null,
    lateral_offset_grade: null,
    lateral_offset_suspect: null,
    runway_width_ft: null,
    bounce_score: bounceScoring.score ?? null,
    bounce_grade: bounceScoring.grade ?? null,
    bounce_distance_ft: bounceScoring.distanceTraveledFt ?? null,
    bounce_worst_gforce: bounceScoring.worstGforce ?? null,
  };
}

function runwayLengthFt(runwayData: RunwayData): number | null {
  return finiteNumberOrNull(runwayData.lengthFt ?? runwayData.length_ft);
}

function runwayPhysicalLengthFt(runwayData: RunwayData): number | null {
  return finiteNumberOrNull(runwayData.physicalLengthFt ?? runwayData.physical_length_ft);
}

function runwayWidthFt(runwayData: RunwayData): number | null {
  return finiteNumberOrNull(runwayData.widthFt ?? runwayData.width_ft);
}

function runwayDisplacedThresholdFt(runwayData: RunwayData): number | null {
  return finiteNumberOrNull(runwayData.displacedThresholdFt ?? runwayData.displaced_threshold_ft);
}

function buildTouchdownRunwayAnalysis(input: {
  runwayData: RunwayData | null | undefined;
  touchdownPoint: Coordinate;
  surfaceInputs?: AnyRecord;
  bounceScoring?: BounceScoring;
}): TouchdownRunwayAnalysis {
  const { runwayData, touchdownPoint, surfaceInputs = {}, bounceScoring = {} } = input;
  const baseData = buildDefaultTouchdownDistanceData(bounceScoring);
  if (!runwayData || !runwayData.threshold) {
    return { touchdownDistanceData: baseData, shortLandingDetected: false, tdzAchieved: false };
  }

  const threshold = runwayData.threshold;
  const heading = getRunwayTrueHeadingDeg(runwayData);
  const lengthFt = runwayLengthFt(runwayData);
  const physicalLengthFt = runwayPhysicalLengthFt(runwayData);
  const widthFt = runwayWidthFt(runwayData);
  const displacedThresholdFt = runwayDisplacedThresholdFt(runwayData);
  const physicalThreshold = runwayData.physicalThreshold || null;

  let distanceFt: number | null = null;
  let shortLandingDetected = false;
  if (heading !== null) {
    const signed = landingDistance.calculateSignedTouchdownDistance(threshold, touchdownPoint, heading);
    distanceFt = signed.distanceFt;
    shortLandingDetected = signed.isShort;
  } else {
    distanceFt = landingDistance.calculateTouchdownDistance(threshold, touchdownPoint);
  }

  if (distanceFt == null) {
    return { touchdownDistanceData: baseData, shortLandingDetected, tdzAchieved: false };
  }

  const lateralOffset = heading !== null
    ? landingDistance.calculateLateralOffset(threshold, touchdownPoint, heading)
    : { offsetFt: null, side: 'center' };
  const lateralScore = lateralOffset.offsetFt != null
    ? landingDistance.scoreLateralOffset(lateralOffset.offsetFt, widthFt != null && widthFt > 0 ? widthFt : undefined)
    : null;
  const surfaceResolution = landingDistance.inferSurfaceCondition(surfaceInputs);
  const scoring = landingDistance.scoreTouchdownDistance(distanceFt, {
    runwayLengthFt: lengthFt ?? undefined,
    surface: surfaceResolution.surface,
  });

  const touchdownDistanceData = {
    ...baseData,
    touchdown_distance_ft: Math.round(distanceFt),
    runway_length_ft: lengthFt,
    runway_physical_length_ft: physicalLengthFt,
    runway_surface: runwayData.surface || null,
    runway_geometry_source: runwayData.source || null,
    runway_geometry_provider_chain: runwayData.runway_geometry_provider_chain ?? runwayData.runwayGeometryProviderChain ?? null,
    runway_geometry_fallback_reason: runwayData.runway_geometry_fallback_reason ?? runwayData.runwayGeometryFallbackReason ?? null,
    runway_geometry_diagnostics: runwayData.runway_geometry_diagnostics ?? runwayData.runwayGeometryDiagnostics ?? null,
    runway_heading_true_deg: heading,
    runway_threshold_lat: threshold.lat ?? null,
    runway_threshold_lon: threshold.lon ?? null,
    runway_physical_threshold_lat: physicalThreshold?.lat ?? null,
    runway_physical_threshold_lon: physicalThreshold?.lon ?? null,
    runway_displaced_threshold_ft: displacedThresholdFt,
    touchdown_distance_score: scoring.score,
    touchdown_distance_grade: scoring.grade,
    touchdown_distance_zone: scoring.zone,
    runway_icao: runwayData.icao || null,
    runway_id: runwayData.runway || runwayData.runwayId || null,
    short_landing: shortLandingDetected,
    runway_condition: surfaceResolution.surface,
    runway_condition_source: surfaceResolution.source,
    runway_condition_confident: surfaceResolution.confident,
    lateral_offset_ft: lateralOffset.offsetFt,
    lateral_offset_side: lateralOffset.offsetFt != null ? lateralOffset.side : null,
    lateral_offset_score: lateralScore ? lateralScore.score : null,
    lateral_offset_grade: lateralScore ? lateralScore.grade : null,
    lateral_offset_suspect: false,
    runway_width_ft: widthFt,
  };

  return {
    touchdownDistanceData,
    shortLandingDetected,
    tdzAchieved: isTouchdownZoneAchieved(touchdownDistanceData, shortLandingDetected),
  };
}

function isTouchdownZoneAchieved(touchdownDistanceData: AnyRecord, shortLandingDetected: boolean): boolean {
  return !shortLandingDetected &&
    touchdownDistanceData.touchdown_distance_ft != null &&
    touchdownDistanceData.touchdown_distance_ft >= 0 &&
    touchdownDistanceData.touchdown_distance_ft <= landingDistance.TOUCHDOWN_ZONE_MAX_FT;
}

function isTouchdownTransitionCandidate(input: {
  wasOnGround: boolean | null;
  onGround: boolean | null;
  raFt: NullableNumber;
  iasKts: NullableNumber;
  vsFpm: NullableNumber;
  flightEnded?: boolean;
  minIasKts?: number;
  maxIasKts?: number;
  maxRaFt?: number;
  requireDescent?: boolean;
}): boolean {
  const {
    wasOnGround,
    onGround,
    raFt,
    iasKts,
    vsFpm,
    flightEnded = false,
    minIasKts = 50,
    maxIasKts = 250,
    maxRaFt = 50,
    requireDescent = true,
  } = input;
  const ra = finiteNumberOrNull(raFt);
  const ias = finiteNumberOrNull(iasKts);
  const vs = finiteNumberOrNull(vsFpm);
  return wasOnGround === false &&
    onGround === true &&
    ra !== null &&
    ra < maxRaFt &&
    ias !== null &&
    ias > minIasKts &&
    ias < maxIasKts &&
    (!requireDescent || (vs !== null && vs < 0)) &&
    !flightEnded;
}

function isTakeoffSettlingTouchdown(input: {
  lastAcceptedTouchdownMs?: NullableNumber;
  peakRaFt: NullableNumber;
  minAirborneRaFt?: number;
}): boolean {
  const peakRaFt = finiteNumberOrNull(input.peakRaFt) ?? 0;
  const minAirborneRaFt = Number.isFinite(input.minAirborneRaFt)
    ? Math.max(0, input.minAirborneRaFt as number)
    : 50;
  return input.lastAcceptedTouchdownMs == null && peakRaFt < minAirborneRaFt;
}

function downsampleTimedSamples(samples: AnyRecord[], maxPoints: number): AnyRecord[] {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const limit = Math.max(1, Math.floor(maxPoints));

  const indices: number[] = [];
  if (samples.length <= limit) {
    for (let index = 0; index < samples.length; index++) indices.push(index);
  } else {
    const step = (samples.length - 1) / (limit - 1);
    for (let index = 0; index < limit; index++) indices.push(Math.round(index * step));
  }

  const result = [];
  let previousTMs: number | null = null;
  for (const index of indices) {
    const sample = samples[index];
    const tMs = finiteNumberOrNull(sample.tMs);
    const dtMs = tMs !== null && previousTMs !== null ? Math.max(0, tMs - previousTMs) : null;
    previousTMs = tMs;
    const { tMs: _drop, ...rest } = sample;
    result.push({ ...rest, dtMs });
  }
  return result;
}

function projectPointToRunwayFeet(
  threshold: Coordinate | null | undefined,
  point: Coordinate | null | undefined,
  runwayHeadingDeg: NullableNumber,
): { alongTrackFt: number | null; crossTrackFt: number | null; side: string } {
  const heading = finiteNumberOrNull(runwayHeadingDeg);
  if (!threshold || !point || heading === null) {
    return { alongTrackFt: null, crossTrackFt: null, side: 'center' };
  }
  const thresholdLat = finiteNumberOrNull(threshold.lat);
  const thresholdLon = finiteNumberOrNull(threshold.lon);
  const pointLat = finiteNumberOrNull(point.lat);
  const pointLon = finiteNumberOrNull(point.lon);
  if ([thresholdLat, thresholdLon, pointLat, pointLon].some((value) => value === null)) {
    return { alongTrackFt: null, crossTrackFt: null, side: 'center' };
  }

  const headingRad = heading * Math.PI / 180;
  const dNorthFt = ((pointLat as number) - (thresholdLat as number)) * FT_PER_DEG_LAT;
  const dEastFt = ((pointLon as number) - (thresholdLon as number)) *
    FT_PER_DEG_LAT *
    Math.cos((thresholdLat as number) * Math.PI / 180);
  const alongTrackFt = dEastFt * Math.sin(headingRad) + dNorthFt * Math.cos(headingRad);
  const crossTrackFt = dEastFt * Math.cos(headingRad) - dNorthFt * Math.sin(headingRad);
  const side = Math.abs(crossTrackFt) < 5 ? 'center' : crossTrackFt > 0 ? 'right' : 'left';

  return { alongTrackFt, crossTrackFt, side };
}

module.exports = {
  averageFinite,
  booleanOrNull,
  buildCanonicalStabilityFrameFromCsvRow,
  buildDefaultTouchdownDistanceData,
  buildTouchdownRunwayAnalysis,
  downsampleTimedSamples,
  finiteNumberOrNull,
  isTakeoffSettlingTouchdown,
  isTouchdownTransitionCandidate,
  isTouchdownZoneAchieved,
  projectPointToRunwayFeet,
};

export {};
