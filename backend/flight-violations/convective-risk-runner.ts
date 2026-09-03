import type { ViolationRuleId, ViolationRuleMap } from '../../shared/violation-rules';

'use strict';

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';
type Severity = 'warning' | 'critical';

type EventBusModule = {
  emit: (event: string, payload: unknown) => void;
};

type PhasesModule = {
  GROUND_PHASES: Set<string>;
};

type BroadcastFn = (payload: Record<string, unknown>) => void;

type FdmFrame = {
  gForce?: number | null;
  gForceLateral?: number | null;
  gForceLongitudinal?: number | null;
  pitchRateRadS?: number | null;
  rollRateRadS?: number | null;
  yawRateRadS?: number | null;
  precipRateMm?: number | null;
  precipState?: number | null;
  inCloud?: boolean | number | null;
  densityAltFt?: number | null;
};

type DisplayFrame = {
  iasKts?: number | null;
  vsFpm?: number | null;
  pitchDeg?: number | null;
  bankDeg?: number | null;
};

type TelemetryFrame = {
  display?: DisplayFrame | null;
  fdm?: FdmFrame | null;
  gforce?: number | null;
  gForce?: number | null;
  ias?: number | null;
  vs?: number | null;
  pitch?: number | null;
  bank?: number | null;
  pitchDeg?: number | null;
  bankDeg?: number | null;
  attitudeDebug?: {
    pitchDegPrimary?: number | null;
    bankDegPrimary?: number | null;
  } | null;
  wow?: unknown;
};

type TimeContext = {
  nowEpochMs: number;
  nowIso: string;
};

type FlightCsvWriter = {
  isRecording: () => boolean;
  writeEvent: (eventType: string, payload: Record<string, unknown>) => void;
};

type UpdateContext = {
  phase?: string | null;
  flightCsvWriter?: FlightCsvWriter | null;
  iasKts?: number | null;
  vsFpm?: number | null;
  pitchDeg?: number | null;
  bankDeg?: number | null;
  pitchRateDeg?: number | null;
  bankRateDeg?: number | null;
};

type RiskSample = {
  ts: number;
  phase: string | null;
  gForce: number | null;
  gForceLateral: number | null;
  gForceLongitudinal: number | null;
  loadExcursionG: number | null;
  loadJerkGps: number | null;
  lateralJerkGps: number | null;
  longitudinalJerkGps: number | null;
  pitchRateDps: number | null;
  rollRateDps: number | null;
  yawRateDps: number | null;
  pitchDeg: number | null;
  bankDeg: number | null;
  maneuverSuppressed: boolean;
  iasKts: number | null;
  vsFpm: number | null;
  inCloud: boolean | null;
  precipActive: boolean | null;
  precipRateMm: number | null;
  precipState: number | null;
  densityAltFt: number | null;
};

type FeatureSummary = {
  score: number;
  riskLevel: RiskLevel | null;
  confidenceLevel: ConfidenceLevel;
  motionScore: number;
  weatherScore: number;
  weatherDataAvailable: boolean;
  weatherAligned: boolean;
  sampleCount: number;
  windowMs: number;
  loadExcursionPeakG: number | null;
  loadExcursionAvgG: number | null;
  loadJerkPeakGps: number | null;
  lateralGPeak: number | null;
  longitudinalGPeak: number | null;
  lateralJerkPeakGps: number | null;
  longitudinalJerkPeakGps: number | null;
  axisGPeak: number | null;
  axisJerkPeakGps: number | null;
  pitchRatePeakDps: number | null;
  rollRatePeakDps: number | null;
  yawRatePeakDps: number | null;
  pitchPeakDeg: number | null;
  bankPeakDeg: number | null;
  maneuverSampleRatio: number | null;
  maneuverSuppressed: boolean;
  verticalReversalCount: number;
  verticalReversalRatePerMin: number | null;
  verticalSpeedActivityScore: number;
  iasRangeKts: number | null;
  vsRangeFpm: number | null;
  inCloudRatio: number | null;
  precipRatio: number | null;
  precipRateMaxMm: number | null;
  densityAltFt: number | null;
};

type RiskMetrics = Record<string, string | number | boolean | null>;

const eventBus = require('../core/event-bus') as EventBusModule;
const { GROUND_PHASES } = require('../lifecycle/phases') as PhasesModule;
const {
  sanitizePrecipRateMm,
  sanitizePrecipState,
} = require('../utils/weather-telemetry') as {
  sanitizePrecipRateMm: (value: unknown) => number | null;
  sanitizePrecipState: (value: unknown) => number | null;
};
const { VIOLATION_RULE } = require('../../shared/violation-rules.js') as { VIOLATION_RULE: ViolationRuleMap };

const CONVECTIVE_RULE = Object.freeze({
  EXPOSURE: VIOLATION_RULE.CONVECTIVE_EXPOSURE as ViolationRuleId,
});

const RAD_TO_DEG = 180 / Math.PI;
const WINDOW_MS = 45_000;
// Event dwell must reflect current conditions, not merely a peak that remains
// somewhere in the longer metrics window. A short evidence window tolerates
// normal telemetry jitter while allowing a brief impulse to expire promptly.
const EVENT_EVIDENCE_WINDOW_MS = 5_000;
const MIN_EVENT_DURATION_MS = 30_000;
const CLEAR_DWELL_MS = 12_000;
const ARM_SCORE = 0.45;
const CLEAR_SCORE = 0.24;
const WEATHER_EXPOSURE_LOW_SCORE = 0.25;
const STRONG_WEATHER_SCORE = 0.6;
const MOTION_CORROBORATING_PRECIP_RATE_MM = 0.5;
const MOTION_CORROBORATING_PRECIP_RATIO = 0.2;
const PROFILE_CHANGE_PHASES = new Set(['TAKEOFF', 'CLIMB', 'DESCENT', 'APPROACH', 'GO_AROUND']);
const MANEUVER_BANK_SUPPRESS_DEG = 25;
const MANEUVER_PITCH_SUPPRESS_DEG = 18;
const MANEUVER_RATE_SUPPRESS_DPS = 28;
const MANEUVER_DISCOUNT_RATIO = 0.35;
const MANEUVER_STRONG_DISCOUNT_RATIO = 0.6;
const VS_REVERSAL_MIN_FPM = 300;
const VS_REVERSAL_MIN_DELTA_FPM = 600;

function finiteNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function boolOrNull(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

function maxOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length ? Math.max(...finite) : null;
}

function maxAbsOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length ? Math.max(...finite.map((value) => Math.abs(value))) : null;
}

function avgOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function rangeOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length < 2) return null;
  return Math.max(...finite) - Math.min(...finite);
}

function ratioOrNull(values: Array<boolean | null>): number | null {
  const known = values.filter((value): value is boolean => typeof value === 'boolean');
  if (!known.length) return null;
  return known.filter(Boolean).length / known.length;
}

function gForceCurrent(frame: TelemetryFrame): number | null {
  if (frame.fdm && typeof frame.fdm.gForce === 'number') return frame.fdm.gForce;
  if (typeof frame.gForce === 'number') return frame.gForce;
  if (typeof frame.gforce === 'number') return frame.gforce;
  return null;
}

function iasCurrent(frame: TelemetryFrame, ctx: UpdateContext): number | null {
  return finiteNumberOrNull(ctx.iasKts)
    ?? finiteNumberOrNull(frame.display?.iasKts)
    ?? finiteNumberOrNull(frame.ias);
}

function vsCurrent(frame: TelemetryFrame, ctx: UpdateContext): number | null {
  return finiteNumberOrNull(ctx.vsFpm)
    ?? finiteNumberOrNull(frame.display?.vsFpm)
    ?? finiteNumberOrNull(frame.vs);
}

function degRateFromRad(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  return numeric == null ? null : numeric * RAD_TO_DEG;
}

function degFromMaybeRadians(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  return Math.abs(numeric) <= Math.PI * 2 ? numeric * RAD_TO_DEG : numeric;
}

function pitchDegCurrent(frame: TelemetryFrame, ctx: UpdateContext): number | null {
  return finiteNumberOrNull(ctx.pitchDeg)
    ?? finiteNumberOrNull(frame.display?.pitchDeg)
    ?? finiteNumberOrNull(frame.attitudeDebug?.pitchDegPrimary)
    ?? finiteNumberOrNull(frame.pitchDeg)
    ?? degFromMaybeRadians(frame.pitch);
}

function bankDegCurrent(frame: TelemetryFrame, ctx: UpdateContext): number | null {
  return finiteNumberOrNull(ctx.bankDeg)
    ?? finiteNumberOrNull(frame.display?.bankDeg)
    ?? finiteNumberOrNull(frame.attitudeDebug?.bankDegPrimary)
    ?? finiteNumberOrNull(frame.bankDeg)
    ?? degFromMaybeRadians(frame.bank);
}

function isManeuverSuppressedSample(input: {
  phase: string | null;
  pitchDeg: number | null;
  bankDeg: number | null;
  pitchRateDps: number | null;
  rollRateDps: number | null;
}): boolean {
  const bankAbs = Math.abs(input.bankDeg ?? 0);
  if (bankAbs > MANEUVER_BANK_SUPPRESS_DEG) return true;

  const pitchAbs = Math.abs(input.pitchDeg ?? 0);
  if (pitchAbs > MANEUVER_PITCH_SUPPRESS_DEG) return true;

  const maxRate = Math.max(Math.abs(input.pitchRateDps ?? 0), Math.abs(input.rollRateDps ?? 0));
  return maxRate > MANEUVER_RATE_SUPPRESS_DPS && isProfileChangePhase(input.phase);
}

function verticalReversalStats(samples: RiskSample[]): {
  count: number;
  ratePerMin: number | null;
  activityScore: number;
} {
  let count = 0;
  let previousSign = 0;
  let previousVs: number | null = null;

  for (const sample of samples) {
    const vs = sample.vsFpm;
    if (vs == null || Math.abs(vs) < VS_REVERSAL_MIN_FPM) continue;

    const sign = vs > 0 ? 1 : -1;
    if (
      previousSign !== 0 &&
      sign !== previousSign &&
      previousVs != null &&
      Math.abs(vs - previousVs) >= VS_REVERSAL_MIN_DELTA_FPM
    ) {
      count++;
    }

    previousSign = sign;
    previousVs = vs;
  }

  const firstTs = samples[0]?.ts ?? 0;
  const lastTs = samples[samples.length - 1]?.ts ?? firstTs;
  const durationMin = Math.max(0, lastTs - firstTs) / 60_000;
  const ratePerMin = durationMin > 0 ? count / durationMin : null;
  const activityScore = clamp(count / 6);

  return { count, ratePerMin, activityScore };
}

function getRiskLevel(score: number): RiskLevel | null {
  if (score >= 0.7) return 'HIGH';
  if (score >= 0.45) return 'MEDIUM';
  if (score >= 0.25) return 'LOW';
  return null;
}

function isStrongWeatherExposure(
  inCloudRatio: number | null,
  precipRatio: number | null,
  precipRateMaxMm: number | null,
  weatherScore: number,
): boolean {
  return (inCloudRatio ?? 0) >= 0.6 &&
    (precipRatio ?? 0) >= 0.5 &&
    (precipRateMaxMm ?? 0) > 0.5 &&
    weatherScore >= STRONG_WEATHER_SCORE;
}

function isWeatherExposureArmed(summary: FeatureSummary): boolean {
  return summary.score >= WEATHER_EXPOSURE_LOW_SCORE &&
    isStrongWeatherExposure(
      summary.inCloudRatio,
      summary.precipRatio,
      summary.precipRateMaxMm,
      summary.weatherScore,
    );
}

function hasMotionCorroboratingWeather(summary: FeatureSummary): boolean {
  const precipitationDataAvailable = summary.precipRatio != null || summary.precipRateMaxMm != null;

  // Cloud state alone is not enough to confirm or reject convective weather.
  // Treat missing precipitation probes as unknown and retain the existing
  // low-confidence motion-only fallback.
  if (!precipitationDataAvailable) return true;

  if (summary.precipRateMaxMm != null) {
    return summary.precipRateMaxMm > MOTION_CORROBORATING_PRECIP_RATE_MM &&
      (summary.precipRatio ?? 0) >= MOTION_CORROBORATING_PRECIP_RATIO;
  }

  if ((summary.precipRatio ?? 0) < 0.5) return false;

  // When precipitation state is the only usable weather probe, a missing
  // cloud probe must not be interpreted as known-clear conditions.
  return summary.inCloudRatio == null || summary.inCloudRatio >= 0.25;
}

function isMotionExposureArmed(summary: FeatureSummary): boolean {
  return summary.score >= ARM_SCORE && hasMotionCorroboratingWeather(summary);
}

function isCriticalConvectiveExposure(summary: FeatureSummary): boolean {
  return summary.riskLevel === 'HIGH' &&
    summary.confidenceLevel === 'HIGH' &&
    summary.weatherDataAvailable &&
    summary.weatherAligned &&
    summary.motionScore >= ARM_SCORE &&
    !summary.maneuverSuppressed;
}

function getSeverity(summary: FeatureSummary): Severity {
  return isCriticalConvectiveExposure(summary) ? 'critical' : 'warning';
}

function getLabel(summary: FeatureSummary, riskLevel: RiskLevel): string {
  return isCriticalConvectiveExposure(summary)
    ? `Convective Exposure Likelihood: ${riskLevel}`
    : `Convective Exposure Advisory: ${riskLevel}`;
}

function isProfileChangePhase(phase: string | null): boolean {
  return PROFILE_CHANGE_PHASES.has(String(phase || '').toUpperCase());
}

function precipIsActive(precipState: number | null, precipRateMm: number | null): boolean | null {
  const stateKnown = precipState != null;
  const rateKnown = precipRateMm != null;
  if (!stateKnown && !rateKnown) return null;
  if (rateKnown) {
    return precipRateMm > 0.05;
  }
  if (!stateKnown) return null;

  // MSFS 2024 exposes AMBIENT PRECIP STATE as a mask: 2=None, 4=Rain, 8=Snow.
  // Keep 0/1 as legacy no-precip values, and treat other >2 legacy values as
  // active only after the explicit MSFS mask checks.
  const state = Math.trunc(precipState);
  if ((state & 4) !== 0 || (state & 8) !== 0) return true;
  if ((state & 2) !== 0 || state <= 1) return false;
  return state > 2;
}

function summarize(samples: RiskSample[]): FeatureSummary {
  const sampleCount = samples.length;
  const firstTs = samples[0]?.ts ?? 0;
  const lastTs = samples[sampleCount - 1]?.ts ?? firstTs;
  const windowMs = Math.max(0, lastTs - firstTs);

  const loadExcursionPeakG = maxOrNull(samples.map((sample) => sample.loadExcursionG));
  const loadExcursionAvgG = avgOrNull(samples.map((sample) => sample.loadExcursionG));
  const loadJerkPeakGps = maxOrNull(samples.map((sample) => sample.loadJerkGps));
  const lateralGPeak = maxAbsOrNull(samples.map((sample) => sample.gForceLateral));
  const longitudinalGPeak = maxAbsOrNull(samples.map((sample) => sample.gForceLongitudinal));
  const lateralJerkPeakGps = maxOrNull(samples.map((sample) => sample.lateralJerkGps));
  const longitudinalJerkPeakGps = maxOrNull(samples.map((sample) => sample.longitudinalJerkGps));
  const axisGPeak = maxOrNull([lateralGPeak, longitudinalGPeak]);
  const axisJerkPeakGps = maxOrNull([lateralJerkPeakGps, longitudinalJerkPeakGps]);
  const pitchRatePeakDps = maxOrNull(samples.map((sample) => sample.pitchRateDps == null ? null : Math.abs(sample.pitchRateDps)));
  const rollRatePeakDps = maxOrNull(samples.map((sample) => sample.rollRateDps == null ? null : Math.abs(sample.rollRateDps)));
  const yawRatePeakDps = maxOrNull(samples.map((sample) => sample.yawRateDps == null ? null : Math.abs(sample.yawRateDps)));
  const pitchPeakDeg = maxOrNull(samples.map((sample) => sample.pitchDeg == null ? null : Math.abs(sample.pitchDeg)));
  const bankPeakDeg = maxOrNull(samples.map((sample) => sample.bankDeg == null ? null : Math.abs(sample.bankDeg)));
  const maneuverSampleRatio = ratioOrNull(samples.map((sample) => sample.maneuverSuppressed));
  const maneuverSuppressed = (maneuverSampleRatio ?? 0) >= MANEUVER_DISCOUNT_RATIO;
  const verticalReversal = verticalReversalStats(samples);
  const iasRangeKts = rangeOrNull(samples.map((sample) => sample.iasKts));
  const vsRangeFpm = rangeOrNull(samples.map((sample) => sample.vsFpm));
  const inCloudRatio = ratioOrNull(samples.map((sample) => sample.inCloud));
  const precipRatio = ratioOrNull(samples.map((sample) => sample.precipActive));
  const precipRateMaxMm = maxOrNull(samples.map((sample) => sample.precipRateMm));
  const densityAltFt = samples.length ? samples[samples.length - 1].densityAltFt : null;
  const profileChangeSampleRatio = ratioOrNull(samples.map((sample) => isProfileChangePhase(sample.phase)));
  const profileChangeDominant = (profileChangeSampleRatio ?? 0) >= 0.6;

  let motionScore = 0;
  if ((loadExcursionPeakG ?? 0) > 0.45) motionScore += 0.45;
  else if ((loadExcursionPeakG ?? 0) > 0.3) motionScore += 0.32;
  else if ((loadExcursionPeakG ?? 0) > 0.15) motionScore += 0.18;

  if ((loadExcursionAvgG ?? 0) > 0.18) motionScore += 0.18;
  else if ((loadExcursionAvgG ?? 0) > 0.1) motionScore += 0.08;

  if ((loadJerkPeakGps ?? 0) > 0.4) motionScore += 0.2;
  else if ((loadJerkPeakGps ?? 0) > 0.2) motionScore += 0.12;

  if ((axisGPeak ?? 0) > 0.3) motionScore += 0.24;
  else if ((axisGPeak ?? 0) > 0.18) motionScore += 0.14;
  else if ((axisGPeak ?? 0) > 0.1) motionScore += 0.06;

  if ((axisJerkPeakGps ?? 0) > 0.5) motionScore += 0.14;
  else if ((axisJerkPeakGps ?? 0) > 0.3) motionScore += 0.08;

  const maxRateDps = Math.max(pitchRatePeakDps ?? 0, rollRatePeakDps ?? 0, yawRatePeakDps ?? 0);
  if (maxRateDps > 12) motionScore += 0.18;
  else if (maxRateDps > 8) motionScore += 0.1;

  if (!profileChangeDominant) {
    if ((vsRangeFpm ?? 0) > 1500) motionScore += 0.12;
    else if ((vsRangeFpm ?? 0) > 800) motionScore += 0.06;
    if (verticalReversal.activityScore >= 0.5) motionScore += 0.08;
    else if (verticalReversal.activityScore > 0) motionScore += 0.04;
    if ((iasRangeKts ?? 0) > 25) motionScore += 0.08;
    else if ((iasRangeKts ?? 0) > 12) motionScore += 0.04;
  }

  if (maneuverSuppressed) {
    motionScore *= (maneuverSampleRatio ?? 0) >= MANEUVER_STRONG_DISCOUNT_RATIO ? 0.25 : 0.45;
  }
  motionScore = clamp(motionScore);

  let weatherScore = 0;
  if ((inCloudRatio ?? 0) >= 0.6) weatherScore += 0.28;
  else if ((inCloudRatio ?? 0) >= 0.25) weatherScore += 0.14;

  if ((precipRatio ?? 0) >= 0.5) weatherScore += 0.25;
  else if ((precipRatio ?? 0) >= 0.2) weatherScore += 0.12;

  if ((precipRateMaxMm ?? 0) > 2) weatherScore += 0.18;
  else if ((precipRateMaxMm ?? 0) > 0.5) weatherScore += 0.1;
  weatherScore = clamp(weatherScore);

  const weatherDataAvailable = inCloudRatio != null || precipRatio != null || precipRateMaxMm != null;
  const weatherAligned =
    (precipRateMaxMm != null && precipRateMaxMm > 0.05) ||
    (precipRateMaxMm == null && (precipRatio ?? 0) >= 0.2) ||
    (
      (inCloudRatio ?? 0) >= 0.25 &&
      ((precipRatio ?? 0) >= 0.2 || (precipRateMaxMm ?? 0) > MOTION_CORROBORATING_PRECIP_RATE_MM)
    );
  const blendedScore = clamp((motionScore * 0.7) + (weatherScore * 0.3));
  const score = isStrongWeatherExposure(inCloudRatio, precipRatio, precipRateMaxMm, weatherScore)
    ? Math.max(blendedScore, WEATHER_EXPOSURE_LOW_SCORE)
    : blendedScore;
  const riskLevel = getRiskLevel(score);

  let confidenceLevel: ConfidenceLevel = 'LOW';
  if (weatherDataAvailable && motionScore >= 0.45 && weatherAligned) {
    confidenceLevel = weatherScore >= 0.35 ? 'HIGH' : 'MEDIUM';
  } else if (weatherDataAvailable && weatherAligned) {
    confidenceLevel = 'MEDIUM';
  }

  return {
    score,
    riskLevel,
    confidenceLevel,
    motionScore,
    weatherScore,
    weatherDataAvailable,
    weatherAligned,
    sampleCount,
    windowMs,
    loadExcursionPeakG,
    loadExcursionAvgG,
    loadJerkPeakGps,
    lateralGPeak,
    longitudinalGPeak,
    lateralJerkPeakGps,
    longitudinalJerkPeakGps,
    axisGPeak,
    axisJerkPeakGps,
    pitchRatePeakDps,
    rollRatePeakDps,
    yawRatePeakDps,
    pitchPeakDeg,
    bankPeakDeg,
    maneuverSampleRatio,
    maneuverSuppressed,
    verticalReversalCount: verticalReversal.count,
    verticalReversalRatePerMin: verticalReversal.ratePerMin,
    verticalSpeedActivityScore: verticalReversal.activityScore,
    iasRangeKts,
    vsRangeFpm,
    inCloudRatio,
    precipRatio,
    precipRateMaxMm,
    densityAltFt,
  };
}

function metricsFromSummary(summary: FeatureSummary, durationMs: number | null = null): RiskMetrics {
  const critical = isCriticalConvectiveExposure(summary);
  return {
    risk_level: summary.riskLevel || 'LOW',
    confidence_level: summary.confidenceLevel,
    convective_advisory: !critical,
    convective_score: round(summary.score, 3),
    convective_duration_ms: durationMs,
    convective_motion_score: round(summary.motionScore, 3),
    convective_weather_score: round(summary.weatherScore, 3),
    convective_weather_available: summary.weatherDataAvailable,
    convective_weather_aligned: summary.weatherAligned,
    convective_peak_load_excursion_g: round(summary.loadExcursionPeakG, 3),
    convective_avg_load_excursion_g: round(summary.loadExcursionAvgG, 3),
    convective_peak_load_jerk_gps: round(summary.loadJerkPeakGps, 3),
    convective_peak_pitch_rate_dps: round(summary.pitchRatePeakDps, 1),
    convective_peak_roll_rate_dps: round(summary.rollRatePeakDps, 1),
    convective_peak_yaw_rate_dps: round(summary.yawRatePeakDps, 1),
    convective_peak_pitch_deg: round(summary.pitchPeakDeg, 1),
    convective_peak_bank_deg: round(summary.bankPeakDeg, 1),
    convective_maneuver_ratio: round(summary.maneuverSampleRatio, 3),
    convective_maneuver_suppressed: summary.maneuverSuppressed,
    convective_vertical_reversals: summary.verticalReversalCount,
    convective_vertical_reversal_rate_per_min: round(summary.verticalReversalRatePerMin, 2),
    convective_vertical_speed_activity_score: round(summary.verticalSpeedActivityScore, 3),
    convective_ias_range_kts: round(summary.iasRangeKts, 1),
    convective_vs_range_fpm: round(summary.vsRangeFpm, 0),
    convective_in_cloud_ratio: round(summary.inCloudRatio, 3),
    convective_precip_ratio: round(summary.precipRatio, 3),
    convective_precip_rate_max_mm: round(summary.precipRateMaxMm, 2),
    convective_density_alt_ft: round(summary.densityAltFt, 0),
    convective_sample_count: summary.sampleCount,
    note: critical
      ? 'Likelihood-based convective exposure proxy from strong aircraft response and aligned simulator weather indicators.'
      : (
        summary.weatherDataAvailable
          ? 'Advisory convective exposure proxy from simulator weather and aircraft-response indicators; not a confirmed turbulence or thunderstorm-cell event.'
          : 'Advisory turbulence/convective proxy from aircraft response; simulator weather indicators were unavailable.'
      ),
  };
}

function createConvectiveRiskRunner(): {
  update: (
    frame: TelemetryFrame,
    broadcast: BroadcastFn,
    timeCtx: TimeContext,
    ctx?: UpdateContext,
  ) => void;
  reset: () => void;
  evaluateSamples: () => FeatureSummary;
} {
  const samples: RiskSample[] = [];
  let previousSample: RiskSample | null = null;
  let candidateStartMs: number | null = null;
  let activeStartMs: number | null = null;
  let activePeak: FeatureSummary | null = null;
  let clearSinceMs: number | null = null;

  function isSuppressed(frame: TelemetryFrame, phase: string | null | undefined): boolean {
    return Boolean(frame.wow) || !phase || GROUND_PHASES.has(phase);
  }

  function addSample(frame: TelemetryFrame, nowMs: number, ctx: UpdateContext): void {
    const gForce = gForceCurrent(frame);
    const gForceLateral = finiteNumberOrNull(frame.fdm?.gForceLateral);
    const gForceLongitudinal = finiteNumberOrNull(frame.fdm?.gForceLongitudinal);
    const dtSeconds = previousSample ? Math.max(0.001, (nowMs - previousSample.ts) / 1000) : null;
    const loadExcursionG = gForce == null ? null : Math.abs(gForce - 1.0);
    const loadJerkGps = gForce == null || previousSample?.gForce == null || dtSeconds == null
      ? null
      : Math.abs(gForce - previousSample.gForce) / dtSeconds;
    const lateralJerkGps = gForceLateral == null || previousSample?.gForceLateral == null || dtSeconds == null
      ? null
      : Math.abs(gForceLateral - previousSample.gForceLateral) / dtSeconds;
    const longitudinalJerkGps = gForceLongitudinal == null || previousSample?.gForceLongitudinal == null || dtSeconds == null
      ? null
      : Math.abs(gForceLongitudinal - previousSample.gForceLongitudinal) / dtSeconds;

    const fdm = frame.fdm || {};
    const precipRateMm = sanitizePrecipRateMm(fdm.precipRateMm);
    const precipState = sanitizePrecipState(fdm.precipState);
    const pitchRateDps = finiteNumberOrNull(ctx.pitchRateDeg) ?? degRateFromRad(fdm.pitchRateRadS);
    const rollRateDps = finiteNumberOrNull(ctx.bankRateDeg) ?? degRateFromRad(fdm.rollRateRadS);
    const pitchDeg = pitchDegCurrent(frame, ctx);
    const bankDeg = bankDegCurrent(frame, ctx);
    const phase = ctx.phase || null;
    const sample: RiskSample = {
      ts: nowMs,
      phase,
      gForce,
      gForceLateral,
      gForceLongitudinal,
      loadExcursionG,
      loadJerkGps,
      lateralJerkGps,
      longitudinalJerkGps,
      pitchRateDps,
      rollRateDps,
      yawRateDps: degRateFromRad(fdm.yawRateRadS),
      pitchDeg,
      bankDeg,
      maneuverSuppressed: isManeuverSuppressedSample({
        phase,
        pitchDeg,
        bankDeg,
        pitchRateDps,
        rollRateDps,
      }),
      iasKts: iasCurrent(frame, ctx),
      vsFpm: vsCurrent(frame, ctx),
      inCloud: boolOrNull(fdm.inCloud),
      precipActive: precipIsActive(precipState, precipRateMm),
      precipRateMm,
      precipState,
      densityAltFt: finiteNumberOrNull(fdm.densityAltFt),
    };

    samples.push(sample);
    previousSample = sample;

    const cutoff = nowMs - WINDOW_MS;
    while (samples.length && samples[0].ts < cutoff) samples.shift();
  }

  function evaluateSamples(): FeatureSummary {
    return summarize(samples);
  }

  function evaluateCurrentEvidence(nowMs: number): FeatureSummary {
    const cutoff = nowMs - EVENT_EVIDENCE_WINDOW_MS;
    return summarize(samples.filter((sample) => sample.ts >= cutoff));
  }

  function publishStart(
    summary: FeatureSummary,
    broadcast: BroadcastFn,
    nowMs: number,
    nowIso: string,
  ): void {
    const metrics = metricsFromSummary(summary);
    const riskLevel = summary.riskLevel || 'MEDIUM';
    const severity = getSeverity(summary);
    const payload = {
      type: 'convectiveRisk',
      event: 'start',
      rule_id: CONVECTIVE_RULE.EXPOSURE,
      label: getLabel(summary, riskLevel),
      severity,
      diagnostic_only: true,
      metrics,
      timestamp_ms: nowMs,
      timestamp_utc: nowIso,
    };

    void broadcast;
    eventBus.emit('convectiveRisk:start', payload);

    console.log(
      `[CONVECTIVE DIAG] ${riskLevel} severity=${severity} confidence=${summary.confidenceLevel} score=${summary.score.toFixed(2)} disconnected=true`,
    );
  }

  function publishEnd(
    summary: FeatureSummary,
    broadcast: BroadcastFn,
    nowMs: number,
    nowIso: string,
  ): void {
    const durationMs = activeStartMs == null ? 0 : Math.max(0, nowMs - activeStartMs);
    const peak = activePeak || summary;
    const metrics = metricsFromSummary(peak, durationMs);
    const riskLevel = peak.riskLevel || 'LOW';
    const severity = getSeverity(peak);
    const payload = {
      type: 'convectiveRisk',
      event: 'end',
      rule_id: CONVECTIVE_RULE.EXPOSURE,
      label: getLabel(peak, riskLevel),
      severity,
      diagnostic_only: true,
      metrics,
      timestamp_ms: nowMs,
      timestamp_utc: nowIso,
    };

    void broadcast;
    eventBus.emit('convectiveRisk:end', payload);

    console.log(`[CONVECTIVE CLEAR] duration=${(durationMs / 1000).toFixed(1)}s peak=${riskLevel}`);
  }

  function resetTransient(): void {
    samples.length = 0;
    previousSample = null;
    candidateStartMs = null;
    activeStartMs = null;
    activePeak = null;
    clearSinceMs = null;
  }

  function update(
    frame: TelemetryFrame,
    broadcast: BroadcastFn,
    timeCtx: TimeContext,
    ctx: UpdateContext = {},
  ): void {
    const { nowEpochMs, nowIso } = timeCtx;
    const phase = ctx.phase || null;

    if (isSuppressed(frame, phase)) {
      if (activeStartMs != null) {
        publishEnd(evaluateSamples(), broadcast, nowEpochMs, nowIso);
      }
      resetTransient();
      return;
    }

    addSample(frame, nowEpochMs, ctx);
    const summary = evaluateSamples();
    const currentEvidence = evaluateCurrentEvidence(nowEpochMs);
    const armed = isMotionExposureArmed(currentEvidence) || isWeatherExposureArmed(currentEvidence);

    if (activeStartMs == null) {
      if (!armed) {
        candidateStartMs = null;
        return;
      }
      if (candidateStartMs == null) candidateStartMs = nowEpochMs;
      if ((nowEpochMs - candidateStartMs) >= MIN_EVENT_DURATION_MS) {
        activeStartMs = candidateStartMs;
        activePeak = summary;
        clearSinceMs = null;
        publishStart(summary, broadcast, nowEpochMs, nowIso);
      }
      return;
    }

    if (!activePeak || summary.score > activePeak.score) {
      activePeak = summary;
    }

    if (currentEvidence.score <= CLEAR_SCORE) {
      if (clearSinceMs == null) clearSinceMs = nowEpochMs;
      if ((nowEpochMs - clearSinceMs) >= CLEAR_DWELL_MS) {
        publishEnd(summary, broadcast, nowEpochMs, nowIso);
        candidateStartMs = null;
        activeStartMs = null;
        activePeak = null;
        clearSinceMs = null;
      }
      return;
    }

    clearSinceMs = null;
  }

  function reset(): void {
    resetTransient();
  }

  return { update, reset, evaluateSamples };
}

module.exports = {
  createConvectiveRiskRunner,
  CONVECTIVE_RULE,
  metricsFromSummary,
};

export {};
