// stability-runner.js
// Unified interface for retrospective stability scoring.
//
// ARCHITECTURAL NOTE:
// This module now uses the simplified stability scoring approach.
// - No real-time scoring: samples are recorded during descent
// - Retrospective scoring: final score computed on touchdown (WOW transition)
// - Simplified rules: only checks configuration changes after stability gate

const { scoreLateralOffset } = require('../landing/landing-distance') as LandingDistanceModule;
const config = require('../core/config') as ConfigModule;
const {
  GLIDEPATH_ANGLE_OVERRIDES,
} = require('./glidepath-angle-overrides') as {
  GLIDEPATH_ANGLE_OVERRIDES: Record<string, { default?: number; runways?: Record<string, number>; note?: string }>;
};

// IMC/VMC visibility threshold (meters)
// FAA/ICAO: Basic VFR requires 3 statute miles (4828m) visibility
// We use 5000m as a conservative threshold
const VMC_VISIBILITY_THRESHOLD_M = 5000;

// Simplified proxy thresholds (intentionally minimal and fixed).
const SPEED_MINUS_KTS = 5;
const SPEED_PLUS_KTS = 5;
const VS_MIN_FPM = -1000;
const VS_MAX_CLIMB_FPM = 200;
const DEFAULT_GLIDEPATH_ANGLE_DEG = 3;
const GLIDEPATH_VS_DELTA_MAX_FPM = 200;
const MIN_GS_FOR_GLIDEPATH_KTS = 30;
const SPEED_TREND_MAX_KTS_PER_SEC = 2.5;
// Normal flare inputs deliberately reduce airspeed, sink rate and thrust. Keep
// those energy/path-rate proxies focused on the approach down to the threshold
// crossing region, while configuration and attitude checks continue through
// touchdown.
const ENERGY_SCORING_FLOOR_FT = 50;
// Consecutive 10 Hz telemetry frames are too sensitive to quantisation and
// provider jitter. Trend/rate proxies use a one-second observation window so
// their meaning does not change with the configured polling rate.
const RATE_WINDOW_MS = 1000;
const THRUST_IDLE_MIN_PCT = 15;
const THRUST_STABLE_MAX_PCT_PER_SEC = 10;
// Spoiler movement tolerance: 1 % absorbs SimConnect float-point frame noise
// (observed drift is sub-0.1 %) while remaining far below any real handle
// movement (armed detents, partial flight-spoiler, or full deployment all
// register > 5 % change). We cannot reliably know what percentage corresponds
// to "armed" on each aircraft, so the rule is: whatever position the handle is
// at the 1,000 ft gate, it must not move more than 1 % before touchdown.
const PITCH_MIN_DEG = -5;
const PITCH_MAX_DEG = 15;
const BANK_MAX_DEG = 25;
const CHECK_PASS_PCT = 80;
// The strict gateStable audit remains an all-checks boolean. The user-facing
// verdict is deliberately less brittle: proxy/advisory misses are marginal
// unless the overall result or a directly measured core metric is clearly poor.
const STABILITY_VERDICT_POLICY_ID = 'approach-stability-verdict';
const STABILITY_VERDICT_POLICY_VERSION = 2;
const STABILITY_VERDICT_MIN_OVERALL_SCORE = 80;
const STABILITY_VERDICT_SEVERE_METRIC_FLOOR_PCT = 60;
const FEET_PER_NM = 6076.12;
const DEFAULT_GLIDEPATH_VS_FACTOR = 5.31;
const MIN_GLIDEPATH_ANGLE_DEG = 1;
const MAX_GLIDEPATH_ANGLE_DEG = 8;
const CONFIG_SCORE_CAPS: Record<string, number> = Object.freeze({
  gear_not_down_at_gate: 60,
  flaps_not_set_at_gate: 60,
  gear_changed_after_gate: 70,
  flaps_changed_after_gate: 70,
});

type StabilityBreakdown = {
  speed_ok: number | null;
  speed_trend_ok: number | null;
  vs_ok: number | null;
  glidepath_ok: number | null;
  glidepath_below_ok?: number | null;
  glidepath_above_ok?: number | null;
  config_ok: number | null;
  flaps_ok: number | null;
  gear_ok: number | null;
  spoilers_ok: number;
  pitch_ok: number | null;
  bank_ok: number | null;
  lateral_offset_ok?: number | null;
  thrust_ok: number | null;
  thrust_not_idle_ok: number;
  thrust_stable_ok: number | null;
};

type ApproachStabilityVerdict = 'stable' | 'marginal' | 'unstable' | 'no_verdict';

type StabilityVerdictInput = {
  score?: unknown;
  samples?: unknown;
  gateStable?: unknown;
  gateFailures?: unknown;
  breakdown?: Record<string, unknown> | null;
};

const HARD_STABILITY_FAILURES = new Set([
  'gear_not_down_at_gate',
  'flaps_not_set_at_gate',
  'gear_changed_after_gate',
  'flaps_changed_after_gate',
]);

const DIRECT_CORE_STABILITY_METRICS = [
  'speed_ok',
  'vs_ok',
  'pitch_ok',
  'bank_ok',
  'lateral_offset_ok',
] as const;
const HARD_CONFIGURATION_METRICS = ['config_ok', 'gear_ok', 'flaps_ok'] as const;

/**
 * Classify a scored approach without changing its strict gate audit.
 *
 * Boundary semantics are intentional: 80 overall and 60 for a direct metric
 * are acceptable for a marginal verdict; only values below those floors are
 * unstable. Path-rate, directional path, speed-trend and throttle-movement
 * failures remain visible in gateFailures but are advisory for this verdict.
 */
function classifyApproachStability(
  result: StabilityVerdictInput | null | undefined,
): ApproachStabilityVerdict {
  if (!result || typeof result !== 'object') return 'no_verdict';

  const rawFailures = Array.isArray(result.gateFailures)
    ? result.gateFailures
    : (typeof result.gateFailures === 'string' ? result.gateFailures.split('|') : []);
  const failures = rawFailures.map(value => String(value || '').trim()).filter(Boolean);
  if (failures.includes('insufficient_data') || failures.includes('no_gate_sample')) {
    return 'no_verdict';
  }

  const score = typeof result.score === 'number' && Number.isFinite(result.score)
    ? result.score
    : null;
  const gateStable = typeof result.gateStable === 'boolean' ? result.gateStable : null;
  const breakdown = result.breakdown && typeof result.breakdown === 'object'
    ? result.breakdown
    : {};
  const hasMetric = Object.values(breakdown).some(value => (
    typeof value === 'number' && Number.isFinite(value)
  ));
  const hasUsableResult = score !== null || gateStable !== null || failures.length > 0 || hasMetric;
  if (!hasUsableResult) return 'no_verdict';
  if (typeof result.samples === 'number'
    && Number.isFinite(result.samples)
    && result.samples <= 0
    && score === null
    && !hasMetric) {
    return 'no_verdict';
  }
  if (failures.some(failure => HARD_STABILITY_FAILURES.has(failure))) return 'unstable';
  if (score !== null && score < STABILITY_VERDICT_MIN_OVERALL_SCORE) return 'unstable';

  for (const key of DIRECT_CORE_STABILITY_METRICS) {
    const value = breakdown[key];
    if (typeof value === 'number'
      && Number.isFinite(value)
      && value < STABILITY_VERDICT_SEVERE_METRIC_FLOOR_PCT) {
      return 'unstable';
    }
  }
  for (const key of HARD_CONFIGURATION_METRICS) {
    const value = breakdown[key];
    if (typeof value === 'number'
      && Number.isFinite(value)
      && value < CHECK_PASS_PCT) {
      return 'unstable';
    }
  }

  if (gateStable === true) return 'stable';
  if (score === null) {
    if (gateStable === false || failures.length > 0) return 'marginal';
    return 'no_verdict';
  }
  const failuresWereRecorded = Array.isArray(result.gateFailures)
    || typeof result.gateFailures === 'string';
  if (gateStable !== false && failuresWereRecorded && failures.length === 0) return 'stable';
  if (gateStable === false || failures.length > 0) return 'marginal';
  return 'no_verdict';
}

type StabilityMetricCoverage = {
  available: boolean;
  eligibleCount: number;
  observedCount: number;
};

type StabilityCoverage = {
  scoredMetrics: number;
  totalMetrics: number;
  metrics: Record<string, StabilityMetricCoverage>;
};

type LandingDistanceModule = {
  scoreLateralOffset: (
    offsetFt: number | null | undefined,
    runwayWidthFt?: number | null,
  ) => { score: number | null; grade?: string | null };
};

type StabilityScoringContext = {
  lateralOffsetFt?: number | null;
  runwayWidthFt?: number | null;
  lateralOffsetSuspect?: boolean | null;
  airportIcao?: string | null;
  runwayId?: string | null;
  criteria?: Partial<StabilityScoringCriteria> | null;
};

type StabilityScoringCriteria = {
  gateRaFt: number;
  speedMinusKts: number;
  speedPlusKts: number;
  vsMinFpm: number;
  vsMaxClimbFpm: number;
  glidepathAngleDeg: number;
  glidepathVsDeltaMaxFpm: number;
  speedTrendMaxKtsPerSec: number;
  thrustIdleMinPct: number;
  thrustStableMaxPctPerSec: number;
  pitchMinDeg: number;
  pitchMaxDeg: number;
  bankMaxDeg: number;
  passPct: number;
};

type ApproachSample = {
  raFt: number;
  iasKts: number;
  vsFpm: number;
  altMslFt: number | null;
  altCalibratedFt: number | null;
  altPlaneFt: number | null;
  pressureAltFt: number | null;
  aircraftAglFt: number | null;
  aircraftAboveObstaclesFt: number | null;
  planeAglFt: number | null;
  planeAglMinusCgFt: number | null;
  gearDown: boolean | null;
  gearAvailable: boolean;
  flapsLanding: boolean | null;
  flapsAvailable: boolean;
  spoilersRetracted: boolean;
  rawGear: number | null;
  rawFlaps: number | null;
  rawSpoilers: number | null;
  onGround: boolean;
  gsKts: number | null;
  pitchDeg: number | null;
  bankDeg: number | null;
  thrustPct: number | null;
  headingDeg: number | null;
  latDeg: number | null;
  lonDeg: number | null;
  dtMs: number | null;
};

type CanonicalFrame = {
  raFt: unknown;
  iasKts: unknown;
  vsFpm: unknown;
  gsKts: unknown;
  altMslFt: unknown;
  altCalibratedFt: unknown;
  altPlaneFt: unknown;
  pressureAltFt: unknown;
  aircraftAglFt: unknown;
  aircraftAboveObstaclesFt: unknown;
  planeAglFt: unknown;
  planeAglMinusCgFt: unknown;
  gearDownLocked: number | null;
  gearDown: boolean | null;
  gearAvailable: boolean;
  flapsPercent: number | null;
  flapsNotch: unknown;
  flapsLanding: boolean | null;
  flapsAvailable: boolean;
  spoilersState: string | null;
  spoilersPercent: number | null;
  spoilersRetracted: boolean;
  pitchDeg: unknown;
  bankDeg: unknown;
  thrustPct: unknown;
  headingDeg: unknown;
  latDeg: unknown;
  lonDeg: unknown;
  onGround: boolean;
  dtMs: unknown;
};

type StabilityScoreResult = {
  score: number | null;
  verdict: ApproachStabilityVerdict;
  breakdown: StabilityBreakdown;
  samples: number;
  gateStable: boolean;
  gateFailures: string[];
  criteria: StabilityScoringCriteria;
  coverage: StabilityCoverage;
  reference: {
    altitudeSource: ApproachAltitudeSource;
    gateHeightFt: number | null;
    gateIasKts: number | null;
  };
};

type StabilityCheckResult = {
  score: number;
  breakdown: StabilityBreakdown;
  gateStable: boolean;
  gateFailures: string[];
  coverage: StabilityCoverage;
};

type ApproachProfilePoint = {
  raFt: number;
  altMslFt: number | null;
  altCalibratedFt: number | null;
  altPlaneFt: number | null;
  pressureAltFt: number | null;
  aircraftAglFt: number | null;
  aircraftAboveObstaclesFt: number | null;
  planeAglFt: number | null;
  planeAglMinusCgFt: number | null;
  /** Selected altitude reference used for runway-relative geometry. */
  profileAltitudeFt: number | null;
  /** Backward-compatible alias for clients recorded before profileAltitudeFt. */
  profileAltMslFt: number | null;
  profileAltitudeSource: 'plane' | 'calibrated' | 'indicated' | 'radio';
  vsFpm: number;
  iasKts: number;
  gsKts: number | null;
  dtMs: number | null;
  pitchDeg: number | null;
  bankDeg: number | null;
  headingDeg: number | null;
  latDeg: number | null;
  lonDeg: number | null;
};

type StabilityLoggerModule = {
  isEnabled: () => boolean;
  writeLog: (channel: string, message: string, payload: Record<string, unknown>) => void;
};

type ConfigModule = {
  stability?: {
    gateRaFt?: number;
    speedMinusKts?: number;
    speedPlusKts?: number;
    vsMinFpm?: number;
    vsMaxClimbFpm?: number;
    glidepathAngleDeg?: number;
    glidepathVsDeltaMaxFpm?: number;
    speedTrendMaxKtsPerSec?: number;
    thrustIdleMinPct?: number;
    thrustStableMaxPctPerSec?: number;
    pitchMinDeg?: number;
    pitchMaxDeg?: number;
    bankMaxDeg?: number;
    passPct?: number;
  };
};

type StabilityRunParams = Record<string, any> & {
  visibilityM?: number | null;
  ra?: number;
  spoilers?: unknown;
  flaps?: unknown;
  ias?: unknown;
  vs?: unknown;
  alt_msl_ft?: unknown;
  gearDownLocked?: unknown;
  wow?: unknown;
};

type StabilityRunResult = {
  instantaneous: null;
  ultimateScore: null;
  isImc: boolean | null;
  imcDataAvailable: boolean;
  visibilityM: number | null | undefined;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values: Array<number | null | undefined>): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const finite = values.filter((v): v is number => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sum = finite.reduce((acc, current) => acc + current, 0);
  return sum / finite.length;
}

function applyConfigurationScoreCap(score: number, gateFailures: string[]): number {
  let cap: number | null = null;
  for (const failure of gateFailures) {
    const failureCap = CONFIG_SCORE_CAPS[failure];
    if (typeof failureCap === 'number') {
      cap = cap == null ? failureCap : Math.min(cap, failureCap);
    }
  }
  return cap == null ? score : Math.min(score, cap);
}

function percentageOfSamples<T>(samples: T[], predicate: (sample: T) => boolean): number {
  if (!Array.isArray(samples) || samples.length === 0) return 100;
  let passCount = 0;
  for (const sample of samples) {
    if (predicate(sample)) {
      passCount++;
    }
  }
  return clamp01((passCount / samples.length) * 100);
}

function airborneOrAllSamples(samples: ApproachSample[]): ApproachSample[] {
  const airborne = samples.filter(sample => !sample.onGround);
  return airborne.length > 0 ? airborne : samples;
}

type ApproachAltitudeSource = 'plane' | 'calibrated' | 'indicated' | 'radio';

type ApproachAltitudeSelectionOptions = {
  runwayReferenceElevFt?: number | null;
  gateRaFt?: number | null;
};

const MIN_ALTITUDE_SOURCE_COVERAGE = 0.8;

function hasUsableAltitudeCoverage(
  samples: ApproachSample[],
  valueOf: (sample: ApproachSample) => number | null | undefined,
  options: ApproachAltitudeSelectionOptions = {},
): boolean {
  if (samples.length === 0) return false;
  const finiteCount = samples.reduce((count, sample) => {
    const value = valueOf(sample);
    return count + (typeof value === 'number' && Number.isFinite(value) ? 1 : 0);
  }, 0);
  const minimumCount = Math.min(5, samples.length);
  if (finiteCount < minimumCount || finiteCount / samples.length < MIN_ALTITUDE_SOURCE_COVERAGE) {
    return false;
  }

  // Coverage percentage alone is not sufficient: a source can be present for
  // 80% of an approach yet disappear for the final 20%, exactly where the gate
  // and touchdown geometry are evaluated. Require the retained approach tail
  // to be continuous so consumers can keep one datum without pointwise mixing.
  const operationalTail = samples.slice(-minimumCount);
  if (operationalTail.some(sample => {
    const value = valueOf(sample);
    return typeof value !== 'number' || !Number.isFinite(value);
  })) {
    return false;
  }

  const runwayReferenceElevFt = options.runwayReferenceElevFt;
  const gateRaFt = options.gateRaFt;
  if (typeof runwayReferenceElevFt !== 'number' || !Number.isFinite(runwayReferenceElevFt)
      || typeof gateRaFt !== 'number' || !Number.isFinite(gateRaFt)) {
    return true;
  }

  const gateIndex = samples.findIndex(sample => {
    const value = valueOf(sample);
    return typeof value === 'number'
      && Number.isFinite(value)
      && value - runwayReferenceElevFt <= gateRaFt;
  });
  if (gateIndex < 0) return false;

  // Once the selected datum reaches the operational gate it must remain
  // available through the end of the approach. If it does not, select the next
  // complete whole-profile source instead of manufacturing a mixed-datum path.
  return samples.slice(gateIndex).every(sample => {
    const value = valueOf(sample);
    return typeof value === 'number' && Number.isFinite(value);
  });
}

// Select once from the complete approach buffer. Consumers must not switch
// altitude references point-by-point because that can manufacture a vertical
// discontinuity even when the aircraft path itself is smooth.
function selectApproachAltitudeSource(
  samples: ApproachSample[],
  options: ApproachAltitudeSelectionOptions = {},
): ApproachAltitudeSource {
  if (hasUsableAltitudeCoverage(samples, sample => sample.altPlaneFt, options)) return 'plane';
  if (hasUsableAltitudeCoverage(samples, sample => sample.altCalibratedFt, options)) return 'calibrated';
  if (hasUsableAltitudeCoverage(samples, sample => sample.altMslFt, options)) return 'indicated';
  return 'radio';
}

function selectedReferenceAltitude(sample: ApproachSample, source: ApproachAltitudeSource): number | null {
  const value = source === 'plane'
    ? sample.altPlaneFt
    : (source === 'calibrated'
      ? sample.altCalibratedFt
      : (source === 'indicated' ? sample.altMslFt : null));
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percentageOfWindowedRates(
  samples: ApproachSample[],
  selector: (sample: ApproachSample) => number | null | undefined,
  maxRatePerSecond: number,
  windowMs = RATE_WINDOW_MS,
): { score: number | null; eligibleCount: number } {
  if (!Array.isArray(samples) || samples.length < 2) return { score: null, eligibleCount: 0 };

  let pairCount = 0;
  let passCount = 0;
  for (let currentIndex = 1; currentIndex < samples.length; currentIndex++) {
    let previousIndex = currentIndex;
    let elapsedMs = 0;
    while (previousIndex > 0 && elapsedMs < windowMs) {
      const dtMs = samples[previousIndex].dtMs;
      elapsedMs += typeof dtMs === 'number' && Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 100;
      previousIndex--;
    }
    if (elapsedMs < windowMs) continue;

    const previousValue = selector(samples[previousIndex]);
    const currentValue = selector(samples[currentIndex]);
    if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue)) continue;

    pairCount++;
    const rate = Math.abs((currentValue as number) - (previousValue as number)) / (elapsedMs / 1000);
    if (rate <= maxRatePerSecond) passCount++;
  }

  if (pairCount === 0) return { score: null, eligibleCount: 0 };
  return {
    score: clamp01((passCount / pairCount) * 100),
    eligibleCount: pairCount,
  };
}

function rollingAverageAtIndex(
  samples: ApproachSample[],
  currentIndex: number,
  selector: (sample: ApproachSample) => number | null | undefined,
  windowMs = RATE_WINDOW_MS,
): number | null {
  const values: number[] = [];
  let cursor = currentIndex;
  let elapsedMs = 0;

  while (cursor >= 0) {
    const value = selector(samples[cursor]);
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
    if (cursor === 0 || elapsedMs >= windowMs) break;

    const dtMs = samples[cursor].dtMs;
    elapsedMs += typeof dtMs === 'number' && Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 100;
    cursor--;
  }

  return average(values);
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeAirportIcao(value: unknown): string | null {
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';
  return normalized.length >= 3 && normalized.length <= 4 ? normalized : null;
}

function normalizeRunwayId(value: unknown): string | null {
  const raw = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().toUpperCase()
    : '';
  if (!raw) return null;
  const normalized = raw.replace(/^RWY\s*/i, '').replace(/[^0-9LCR]/g, '');
  if (/^[1-9][LCR]?$/.test(normalized)) return `0${normalized}`;
  return normalized || null;
}

function clampGlidepathAngleDeg(value: unknown, fallback = DEFAULT_GLIDEPATH_ANGLE_DEG): number {
  const angle = finiteOrDefault(value, fallback);
  return Math.max(MIN_GLIDEPATH_ANGLE_DEG, Math.min(MAX_GLIDEPATH_ANGLE_DEG, angle));
}

function verticalSpeedFactorForGlidepath(angleDeg = DEFAULT_GLIDEPATH_ANGLE_DEG): number {
  const clampedAngle = clampGlidepathAngleDeg(angleDeg);
  if (clampedAngle === DEFAULT_GLIDEPATH_ANGLE_DEG) return DEFAULT_GLIDEPATH_VS_FACTOR;
  return (FEET_PER_NM / 60) * Math.tan((clampedAngle * Math.PI) / 180);
}

function targetVerticalSpeedForGlidepath(gsKts: number, angleDeg = DEFAULT_GLIDEPATH_ANGLE_DEG): number {
  return -gsKts * verticalSpeedFactorForGlidepath(angleDeg);
}

function resolveGlidepathAngleForApproach(input: {
  airportIcao?: unknown;
  runwayId?: unknown;
  defaultAngleDeg?: unknown;
} = {}): { angleDeg: number; source: string } {
  const configuredDefaultAngle = clampGlidepathAngleDeg(
    input.defaultAngleDeg,
    config.stability?.glidepathAngleDeg ?? DEFAULT_GLIDEPATH_ANGLE_DEG,
  );
  const configuredDefaultSource = configuredDefaultAngle === DEFAULT_GLIDEPATH_ANGLE_DEG
    ? 'default'
    : 'criteria';
  const airportIcao = normalizeAirportIcao(input.airportIcao);
  if (!airportIcao) {
    return { angleDeg: configuredDefaultAngle, source: configuredDefaultSource };
  }

  const override = GLIDEPATH_ANGLE_OVERRIDES[airportIcao];
  if (!override) {
    return { angleDeg: configuredDefaultAngle, source: configuredDefaultSource };
  }

  const runwayId = normalizeRunwayId(input.runwayId);
  if (runwayId && override.runways && Number.isFinite(override.runways[runwayId])) {
    return {
      angleDeg: clampGlidepathAngleDeg(override.runways[runwayId]),
      source: `${airportIcao}:${runwayId}`,
    };
  }

  if (Number.isFinite(override.default)) {
    return {
      angleDeg: clampGlidepathAngleDeg(override.default),
      source: `${airportIcao}:default`,
    };
  }

  return { angleDeg: configuredDefaultAngle, source: configuredDefaultSource };
}

function getStabilityCriteria(overrides: Partial<StabilityScoringCriteria> | null | undefined = null): StabilityScoringCriteria {
  const settings = config.stability || {};
  const source = { ...settings, ...(overrides || {}) };

  return {
    gateRaFt: Math.max(100, finiteOrDefault(source.gateRaFt, 1000)),
    speedMinusKts: Math.max(0, finiteOrDefault(source.speedMinusKts, SPEED_MINUS_KTS)),
    speedPlusKts: Math.max(0, finiteOrDefault(source.speedPlusKts, SPEED_PLUS_KTS)),
    vsMinFpm: finiteOrDefault(source.vsMinFpm, VS_MIN_FPM),
    vsMaxClimbFpm: finiteOrDefault(source.vsMaxClimbFpm, VS_MAX_CLIMB_FPM),
    glidepathAngleDeg: clampGlidepathAngleDeg(source.glidepathAngleDeg, DEFAULT_GLIDEPATH_ANGLE_DEG),
    glidepathVsDeltaMaxFpm: Math.max(0, finiteOrDefault(source.glidepathVsDeltaMaxFpm, GLIDEPATH_VS_DELTA_MAX_FPM)),
    speedTrendMaxKtsPerSec: Math.max(0, finiteOrDefault(source.speedTrendMaxKtsPerSec, SPEED_TREND_MAX_KTS_PER_SEC)),
    thrustIdleMinPct: Math.max(0, finiteOrDefault(source.thrustIdleMinPct, THRUST_IDLE_MIN_PCT)),
    thrustStableMaxPctPerSec: Math.max(0, finiteOrDefault(source.thrustStableMaxPctPerSec, THRUST_STABLE_MAX_PCT_PER_SEC)),
    pitchMinDeg: finiteOrDefault(source.pitchMinDeg, PITCH_MIN_DEG),
    pitchMaxDeg: finiteOrDefault(source.pitchMaxDeg, PITCH_MAX_DEG),
    bankMaxDeg: Math.max(0, finiteOrDefault(source.bankMaxDeg, BANK_MAX_DEG)),
    passPct: Math.max(1, Math.min(100, finiteOrDefault(source.passPct, CHECK_PASS_PCT))),
  };
}

function getLateralOffsetOkPct(context: StabilityScoringContext | null | undefined): number | null {
  if (!context || context.lateralOffsetSuspect === true) return null;

  const offsetFt = finiteNumberOrNull(context.lateralOffsetFt);
  if (offsetFt === null) return null;

  const runwayWidthFt = finiteNumberOrNull(context.runwayWidthFt);
  const scored = scoreLateralOffset(
    offsetFt,
    runwayWidthFt !== null && runwayWidthFt > 0 ? runwayWidthFt : undefined,
  );
  return finiteNumberOrNull(scored.score);
}

/**
 * Simplified stability scorer.
 * Checks configuration changes after the stability gate.
 */
class SimpleStabilityScorer {
  gateRaFt: number;
  samples: ApproachSample[];
  hasScored: boolean;
  selectedAltitudeSource: ApproachAltitudeSource | null;

  constructor(gateRaFt = getStabilityCriteria().gateRaFt) {
    this.gateRaFt = gateRaFt;
    this.samples = [];
    this.hasScored = false;
    this.selectedAltitudeSource = null;
  }

  // Maximum samples to retain. A typical approach from 5000ft at 10Hz is ~3000 samples.
  // 5000 provides generous headroom while bounding memory (~750KB worst case).
  static readonly MAX_SAMPLES = 5000;

  /**
   * Add a sample to the approach history.
   * @param {object} sample
   */
  addSample(sample: ApproachSample | null | undefined): void {
    if (!sample || typeof sample !== 'object') return;

    this.samples.push(sample);

    // Hard cap to prevent unbounded growth during abnormal flights
    if (this.samples.length > SimpleStabilityScorer.MAX_SAMPLES) {
      this.samples = this.samples.slice(-SimpleStabilityScorer.MAX_SAMPLES);
    }
  }

  /**
   * Get stability score based on simple rules.
   * @returns {object}
   */
  getScore(
    runwayReferenceElevFt: number | null = null,
    scoringContext: StabilityScoringContext = {},
  ): StabilityScoreResult {
    if (this.hasScored) {
      throw new Error('Scorer has already been used for scoring');
    }
    this.hasScored = true;

    const runwayElevationFt = typeof runwayReferenceElevFt === 'number' && Number.isFinite(runwayReferenceElevFt)
      ? runwayReferenceElevFt
      : null;
    const glidepathAngle = resolveGlidepathAngleForApproach({
      airportIcao: scoringContext.airportIcao,
      runwayId: scoringContext.runwayId,
      defaultAngleDeg: scoringContext.criteria?.glidepathAngleDeg,
    });
    const requestedCriteria = scoringContext.criteria || {};
    const criteria = getStabilityCriteria({
      ...requestedCriteria,
      gateRaFt: Number.isFinite(requestedCriteria.gateRaFt)
        ? requestedCriteria.gateRaFt
        : this.gateRaFt,
      ...(glidepathAngle.source !== 'default' ? { glidepathAngleDeg: glidepathAngle.angleDeg } : {}),
    });
    const altitudeSource = runwayElevationFt !== null
      ? selectApproachAltitudeSource(this.samples, {
        runwayReferenceElevFt: runwayElevationFt,
        gateRaFt: criteria.gateRaFt,
      })
      : 'radio';
    this.selectedAltitudeSource = altitudeSource;

    // Height above the runway reference uses one altitude source for the
    // complete approach. PLANE ALTITUDE is preferred because it represents the
    // simulator's geometric aircraft position and is independent of cockpit
    // barometer settings and atmospheric pressure changes. Older recordings
    // fall back to calibrated/legacy indicated altitude, then radio height.
    const heightOf = (s: ApproachSample): number => {
      if (runwayElevationFt !== null && altitudeSource !== 'radio') {
        const selectedAltitudeFt = selectedReferenceAltitude(s, altitudeSource);
        return selectedAltitudeFt === null ? Number.NaN : selectedAltitudeFt - runwayElevationFt;
      }
      return s.raFt;
    };

    if (this.samples.length < 5) {
      return {
        score: null,
        verdict: 'no_verdict',
        breakdown: this._createEmptyBreakdown(),
        samples: this.samples.length,
        gateStable: false,
        gateFailures: ['insufficient_data'],
        criteria,
        coverage: this._createEmptyCoverage(),
        reference: {
          altitudeSource,
          gateHeightFt: null,
          gateIasKts: null,
        },
      };
    }

    const gateSample = this.samples.find(s => heightOf(s) <= criteria.gateRaFt);
    if (!gateSample) {
      return {
        score: null,
        verdict: 'no_verdict',
        breakdown: this._createEmptyBreakdown(),
        samples: this.samples.length,
        gateStable: false,
        gateFailures: ['no_gate_sample'],
        criteria,
        coverage: this._createEmptyCoverage(),
        reference: {
          altitudeSource,
          gateHeightFt: null,
          gateIasKts: null,
        },
      };
    }

    // Check configuration stability after gate
    const result = this._checkConfigurationStability(gateSample, heightOf, scoringContext, criteria);

    const verdict = classifyApproachStability({
      ...result,
      samples: this.samples.length,
    });
    return {
      score: result.score,
      verdict,
      breakdown: result.breakdown,
      samples: this.samples.length,
      gateStable: result.gateStable,
      gateFailures: result.gateFailures,
      criteria,
      coverage: result.coverage,
      reference: {
        altitudeSource,
        gateHeightFt: Number.isFinite(heightOf(gateSample)) ? heightOf(gateSample) : null,
        gateIasKts: Number.isFinite(gateSample.iasKts) ? gateSample.iasKts : null,
      },
    };
  }

  /**
   * Check if configuration remains stable after the gate.
   * @returns {object}
   */
  _checkConfigurationStability(
    gateSample: ApproachSample,
    heightOf: (sample: ApproachSample) => number,
    scoringContext: StabilityScoringContext = {},
    criteria: StabilityScoringCriteria = getStabilityCriteria(scoringContext.criteria),
  ): StabilityCheckResult {
    const gateHeight = heightOf(gateSample);
    const samplesAfterGate = this.samples.filter(s => heightOf(s) <= gateHeight);
    // Stability is an approach quality judgement. A current-flight buffer may
    // continue receiving frames until rollout finalization, so exclude WOW/rollout samples
    // from all after-gate checks. Otherwise normal touchdown effects (idle thrust,
    // deceleration and pitch settling) can poison the score.
    const approachSamplesAfterGate = airborneOrAllSamples(samplesAfterGate);
    const energySamplesAfterGate = approachSamplesAfterGate.filter(
      sample => heightOf(sample) > ENERGY_SCORING_FLOOR_FT,
    );
    // Gate configuration
    const gateGearAvailable = gateSample.gearAvailable === true
      || (gateSample.gearAvailable == null && typeof gateSample.gearDown === 'boolean');
    const gateFlapsAvailable = gateSample.flapsAvailable === true
      || (gateSample.flapsAvailable == null && typeof gateSample.flapsLanding === 'boolean');
    const gateGearDown = gateGearAvailable ? gateSample.gearDown : null;
    const gateFlapsSet = gateFlapsAvailable ? gateSample.flapsLanding : null;

    let gearChanged = false;
    let flapsChanged = false;

    // Check gear/flap changes after gate (any change in raw values is bad).
    // IMPORTANT: only airborne samples count — once weight-is-on-wheels, pilots
    // auto-deploy (ARMED→EXTENDED) and pilots routinely retract flaps during
    // rollout. Both are normal post-touchdown actions, not approach breaches, so
    // including on-ground samples would falsely flag every successful landing.
    for (const sample of approachSamplesAfterGate) {
      if (sample.rawGear !== null && gateSample.rawGear !== null && sample.rawGear !== gateSample.rawGear) {
        gearChanged = true;
      }
      if (sample.rawFlaps !== null && gateSample.rawFlaps !== null && sample.rawFlaps !== gateSample.rawFlaps) {
        flapsChanged = true;
      }
    }

    const speedTargetKts = Number.isFinite(gateSample.iasKts) ? gateSample.iasKts : null;
    const speedSamples = energySamplesAfterGate.filter(sample => Number.isFinite(sample.iasKts));
    const speedOkPct = speedTargetKts == null || speedSamples.length === 0
      ? null
      : percentageOfSamples(speedSamples, (sample) =>
          sample.iasKts >= (speedTargetKts - criteria.speedMinusKts)
            && sample.iasKts <= (speedTargetKts + criteria.speedPlusKts));

    const speedTrendResult = percentageOfWindowedRates(
      speedSamples,
      sample => sample.iasKts,
      criteria.speedTrendMaxKtsPerSec,
    );
    const speedTrendOkPct = speedTrendResult.score;

    const vsSamples = approachSamplesAfterGate.filter(sample => Number.isFinite(sample.vsFpm));
    const vsOkPct = vsSamples.length === 0 ? null : percentageOfSamples(vsSamples, (sample) => {
      const steepApproachVsMinFpm = criteria.glidepathAngleDeg > DEFAULT_GLIDEPATH_ANGLE_DEG
        && typeof sample.gsKts === 'number'
        && Number.isFinite(sample.gsKts)
        && sample.gsKts >= MIN_GS_FOR_GLIDEPATH_KTS
        ? targetVerticalSpeedForGlidepath(sample.gsKts, criteria.glidepathAngleDeg) - criteria.glidepathVsDeltaMaxFpm
        : criteria.vsMinFpm;
      const effectiveVsMinFpm = Math.min(criteria.vsMinFpm, steepApproachVsMinFpm);
      return sample.vsFpm >= effectiveVsMinFpm && sample.vsFpm <= criteria.vsMaxClimbFpm;
    });

    const glidepathSamples = energySamplesAfterGate.filter(
      (sample): sample is ApproachSample & { gsKts: number } =>
        typeof sample.gsKts === 'number'
        && Number.isFinite(sample.gsKts)
        && sample.gsKts >= MIN_GS_FOR_GLIDEPATH_KTS
        && Number.isFinite(sample.vsFpm),
    );
    // Symmetric path-rate check used for the overall score. A trailing one-second
    // VS average absorbs provider jitter without hiding sustained deviations.
    const smoothedGlidepathSamples = glidepathSamples.map((sample, index) => ({
      sample,
      smoothedVsFpm: rollingAverageAtIndex(glidepathSamples, index, value => value.vsFpm),
    }));
    const glidepathOkPct = smoothedGlidepathSamples.length === 0
      ? null
      : percentageOfSamples(smoothedGlidepathSamples, ({ sample, smoothedVsFpm }) => {
          if (smoothedVsFpm === null) return true;
          const targetVsFpm = targetVerticalSpeedForGlidepath(sample.gsKts, criteria.glidepathAngleDeg);
          return Math.abs(smoothedVsFpm - targetVsFpm) <= criteria.glidepathVsDeltaMaxFpm;
        });
    // Directional vertical-rate metrics; not positional glideslope measurements.
    // A sample fails glidepath_below_ok when VS is more negative than the target path by
    // more than GLIDEPATH_VS_DELTA_MAX_FPM. Without a positional signal this
    // cannot establish that the aircraft is below the normal glidepath.
    const glidepathBelowOkPct = smoothedGlidepathSamples.length === 0
      ? null
      : percentageOfSamples(smoothedGlidepathSamples, ({ sample, smoothedVsFpm }) => {
          if (smoothedVsFpm === null) return true;
          const targetVsFpm = targetVerticalSpeedForGlidepath(sample.gsKts, criteria.glidepathAngleDeg);
          return smoothedVsFpm >= targetVsFpm - criteria.glidepathVsDeltaMaxFpm;
        });
    // A sample fails glidepath_above_ok when VS is less negative than the target path by
    // more than GLIDEPATH_VS_DELTA_MAX_FPM. This does not establish a
    // position above the normal glidepath.
    const glidepathAboveOkPct = smoothedGlidepathSamples.length === 0
      ? null
      : percentageOfSamples(smoothedGlidepathSamples, ({ sample, smoothedVsFpm }) => {
          if (smoothedVsFpm === null) return true;
          const targetVsFpm = targetVerticalSpeedForGlidepath(sample.gsKts, criteria.glidepathAngleDeg);
          return smoothedVsFpm <= targetVsFpm + criteria.glidepathVsDeltaMaxFpm;
        });

    const thrustSamples = energySamplesAfterGate.filter(
      (sample): sample is ApproachSample & { thrustPct: number } =>
        typeof sample.thrustPct === 'number' && Number.isFinite(sample.thrustPct),
    );
    // Legacy compatibility field. This used to treat reported engine/thrust percent
    // >= 15 as "not idle", but many turbojets report real idle near 20% N1 and
    // add-ons differ on whether this value is N1, thrust, or lever position. Keep
    // the column neutral until a reliable throttle-lever idle-detent source exists.
    const thrustNotIdleOkPct = 100;

    // Compatibility name: this is a throttle/engine-percent movement proxy,
    // not a turbofan spool-rate requirement. Live collection prefers explicit
    // throttle lever percent before falling back to N1-like engine levels.
    const thrustStableResult = percentageOfWindowedRates(
      thrustSamples,
      sample => sample.thrustPct,
      criteria.thrustStableMaxPctPerSec,
    );
    const thrustStableOkPct = thrustStableResult.score;

    // Scoring rules
    const gearOk = gateGearDown === null ? null : gateGearDown && !gearChanged;
    const flapsOk = gateFlapsSet === null ? null : gateFlapsSet && !flapsChanged;
    const availableConfigurationChecks = [gearOk, flapsOk]
      .filter((value): value is boolean => typeof value === 'boolean');
    const configOkPct = availableConfigurationChecks.length === 0
      ? null
      : (availableConfigurationChecks.every(Boolean) ? 100 : 0);
    const thrustOkPct = thrustStableOkPct === null ? null : clamp01(thrustStableOkPct);

    // Pitch and bank stability (percentage of samples within limits)
    const pitchSamples = approachSamplesAfterGate.filter(
      sample => typeof sample.pitchDeg === 'number' && Number.isFinite(sample.pitchDeg),
    );
    const pitchOkPct = pitchSamples.length === 0 ? null : percentageOfSamples(pitchSamples, (sample) => {
      return sample.pitchDeg >= criteria.pitchMinDeg && sample.pitchDeg <= criteria.pitchMaxDeg;
    });

    const bankSamples = approachSamplesAfterGate.filter(
      sample => typeof sample.bankDeg === 'number' && Number.isFinite(sample.bankDeg),
    );
    const bankOkPct = bankSamples.length === 0 ? null : percentageOfSamples(bankSamples, (sample) => {
      return Math.abs(sample.bankDeg) <= criteria.bankMaxDeg;
    });

    // Lateral offset is a touchdown-point quality metric, not a per-sample
    // approach trend. Include it only when runway geometry produced a trusted
    // finite offset; missing/suspect geometry leaves historical scoring unchanged.
    const lateralOffsetOkPct = getLateralOffsetOkPct(scoringContext);
    const scoreInputs = [
      configOkPct,
      speedOkPct,
      speedTrendOkPct,
      vsOkPct,
      glidepathOkPct,
      thrustOkPct,
      pitchOkPct,
      bankOkPct,
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (lateralOffsetOkPct !== null) scoreInputs.push(lateralOffsetOkPct);

    const averageScore = clamp01(average(scoreInputs) ?? 0);

    const coverageMetrics: Record<string, StabilityMetricCoverage> = {
      config_ok: { available: configOkPct !== null, eligibleCount: configOkPct === null ? 0 : approachSamplesAfterGate.length, observedCount: approachSamplesAfterGate.length },
      speed_ok: { available: speedOkPct !== null, eligibleCount: speedSamples.length, observedCount: energySamplesAfterGate.length },
      speed_trend_ok: { available: speedTrendOkPct !== null, eligibleCount: speedTrendResult.eligibleCount, observedCount: speedSamples.length },
      vs_ok: { available: vsOkPct !== null, eligibleCount: vsSamples.length, observedCount: approachSamplesAfterGate.length },
      glidepath_ok: { available: glidepathOkPct !== null, eligibleCount: smoothedGlidepathSamples.length, observedCount: energySamplesAfterGate.length },
      thrust_ok: { available: thrustOkPct !== null, eligibleCount: thrustStableResult.eligibleCount, observedCount: energySamplesAfterGate.length },
      pitch_ok: { available: pitchOkPct !== null, eligibleCount: pitchSamples.length, observedCount: approachSamplesAfterGate.length },
      bank_ok: { available: bankOkPct !== null, eligibleCount: bankSamples.length, observedCount: approachSamplesAfterGate.length },
      lateral_offset_ok: { available: lateralOffsetOkPct !== null, eligibleCount: lateralOffsetOkPct === null ? 0 : 1, observedCount: 1 },
    };
    const coreMetricKeys = [
      'config_ok',
      'speed_ok',
      'speed_trend_ok',
      'vs_ok',
      'glidepath_ok',
      'thrust_ok',
      'pitch_ok',
      'bank_ok',
    ];
    const coverage: StabilityCoverage = {
      scoredMetrics: coreMetricKeys.filter(key => coverageMetrics[key].available).length
        + (lateralOffsetOkPct === null ? 0 : 1),
      totalMetrics: coreMetricKeys.length + (lateralOffsetOkPct === null ? 0 : 1),
      metrics: coverageMetrics,
    };

    const breakdown: StabilityBreakdown = {
      speed_ok: speedOkPct,
      speed_trend_ok: speedTrendOkPct,
      vs_ok: vsOkPct,
      glidepath_ok: glidepathOkPct,
      // Compatibility field names: directional vertical-rate checks, not
      // positional glideslope measurements.
      glidepath_below_ok: glidepathBelowOkPct,
      glidepath_above_ok: glidepathAboveOkPct,
      config_ok: configOkPct,
      flaps_ok: flapsOk === null ? null : (flapsOk ? 100 : 0),
      gear_ok: gearOk === null ? null : (gearOk ? 100 : 0),
      // Retained as a neutral compatibility field for existing CSV and API
      // consumers. Spoiler telemetry no longer participates in scoring.
      spoilers_ok: 100,
      pitch_ok: pitchOkPct,
      bank_ok: bankOkPct,
      thrust_ok: thrustOkPct,
      thrust_not_idle_ok: thrustNotIdleOkPct,
      thrust_stable_ok: thrustStableOkPct,
      ...(lateralOffsetOkPct !== null ? { lateral_offset_ok: lateralOffsetOkPct } : {}),
    };

    const gateFailures = [];
    if (gearOk === false) {
      if (gateGearDown === false) gateFailures.push('gear_not_down_at_gate');
      if (gearChanged) gateFailures.push('gear_changed_after_gate');
    }
    if (flapsOk === false) {
      if (gateFlapsSet === false) gateFailures.push('flaps_not_set_at_gate');
      if (flapsChanged) gateFailures.push('flaps_changed_after_gate');
    }
    if (speedOkPct !== null && speedOkPct < criteria.passPct) gateFailures.push('speed_proxy_unstable_after_gate');
    if (speedTrendOkPct !== null && speedTrendOkPct < criteria.passPct) gateFailures.push('speed_trend_unstable_after_gate');
    if (vsOkPct !== null && vsOkPct < criteria.passPct) gateFailures.push('vs_unstable_after_gate');
    if (glidepathOkPct !== null && glidepathOkPct < criteria.passPct) gateFailures.push('glidepath_proxy_unstable_after_gate');
    if (glidepathBelowOkPct !== null && glidepathBelowOkPct < criteria.passPct) gateFailures.push('glidepath_too_low_after_gate');
    if (thrustStableOkPct !== null && thrustStableOkPct < criteria.passPct) gateFailures.push('thrust_unstable_after_gate');
    if (pitchOkPct !== null && pitchOkPct < criteria.passPct) gateFailures.push('pitch_unstable_after_gate');
    if (bankOkPct !== null && bankOkPct < criteria.passPct) gateFailures.push('bank_unstable_after_gate');
    if (lateralOffsetOkPct !== null && lateralOffsetOkPct < criteria.passPct) {
      gateFailures.push('lateral_offset_unstable_at_touchdown');
    }

    const score = applyConfigurationScoreCap(averageScore, gateFailures);
    const gateStable = gateFailures.length === 0;

    return {
      score,
      breakdown,
      gateStable,
      gateFailures,
      coverage,
    };
  }

  /**
   * Create empty breakdown for error cases.
   * @returns {object}
   */
  _createEmptyBreakdown(): StabilityBreakdown {
    return {
      speed_ok: null,
      speed_trend_ok: null,
      vs_ok: null,
      glidepath_ok: null,
      config_ok: null,
      flaps_ok: null,
      gear_ok: null,
      spoilers_ok: 100,
      pitch_ok: null,
      bank_ok: null,
      thrust_ok: null,
      thrust_not_idle_ok: 0,
      thrust_stable_ok: null,
    };
  }

  _createEmptyCoverage(): StabilityCoverage {
    const metrics: Record<string, StabilityMetricCoverage> = {};
    for (const key of [
      'config_ok',
      'speed_ok',
      'speed_trend_ok',
      'vs_ok',
      'glidepath_ok',
      'thrust_ok',
      'pitch_ok',
      'bank_ok',
      'lateral_offset_ok',
    ]) {
      metrics[key] = { available: false, eligibleCount: 0, observedCount: 0 };
    }
    return { scoredMetrics: 0, totalMetrics: 8, metrics };
  }

  /**
   * Reset scorer for new approach.
   */
  reset(): void {
    this.samples = [];
    this.hasScored = false;
    this.selectedAltitudeSource = null;
  }

  /**
   * Get a downsampled approach profile for frontend visualization.
   * Returns altitude (raFt) plus key telemetry for side-on and top-down approach diagrams.
   * Downsampled to ~1 Hz for lightweight WebSocket payloads.
   * @param {number} [maxPoints=120] - Maximum data points to return
   * @returns {Array<{raFt: number, altMslFt: number|null, vsFpm: number, iasKts: number, gsKts: number|null, pitchDeg: number|null, bankDeg: number|null, headingDeg: number|null}>}
   */
  getApproachProfile(maxPoints = 120): ApproachProfilePoint[] {
    if (this.samples.length === 0) return [];

    // Downsample if we have more points than maxPoints
    const raw = this.samples;
    // If scoring has already resolved runway-relative gate coverage, the chart
    // must use that exact datum too. Before scoring, use the same whole-buffer
    // generic selector so live previews remain available.
    const altitudeSource = this.selectedAltitudeSource ?? selectApproachAltitudeSource(raw);
    const indices = [];
    if (raw.length <= maxPoints) {
      for (let i = 0; i < raw.length; i++) indices.push(i);
    } else {
      const step = raw.length / maxPoints;
      for (let i = 0; i < maxPoints; i++) indices.push(Math.floor(i * step));
      // Always include the last sample (touchdown)
      const lastIdx = raw.length - 1;
      if (indices[indices.length - 1] !== lastIdx) indices.push(lastIdx);
    }

    // Each retained sample's dtMs represents the gap to the previous retained
    // sample so groundspeed-by-time distance integration remains correct after
    // downsampling.
    const result = [];
    let prevKeptIdx = -1;
    for (const idx of indices) {
      const s = raw[idx];
      let gapMs = null;
      if (prevKeptIdx >= 0) {
        gapMs = 0;
        for (let j = prevKeptIdx + 1; j <= idx; j++) {
          const d = raw[j].dtMs;
          if (typeof d === 'number' && Number.isFinite(d) && d > 0) gapMs += d;
        }
        if (gapMs <= 0) gapMs = null;
      }
      prevKeptIdx = idx;
      result.push({
        raFt: s.raFt,
        // Legacy cockpit indication retained for diagnosis and old clients.
        // `profileAltitudeFt` below is the approach-locked chart reference.
        altMslFt: s.altMslFt ?? null,
        altCalibratedFt: s.altCalibratedFt ?? null,
        altPlaneFt: s.altPlaneFt ?? null,
        pressureAltFt: s.pressureAltFt ?? null,
        aircraftAglFt: s.aircraftAglFt ?? null,
        aircraftAboveObstaclesFt: s.aircraftAboveObstaclesFt ?? null,
        planeAglFt: s.planeAglFt ?? null,
        planeAglMinusCgFt: s.planeAglMinusCgFt ?? null,
        profileAltitudeFt: selectedReferenceAltitude(s, altitudeSource),
        // Retain the old key so already-deployed frontend/timeline code can
        // render new payloads during a rolling upgrade.
        profileAltMslFt: selectedReferenceAltitude(s, altitudeSource),
        profileAltitudeSource: altitudeSource,
        vsFpm: s.vsFpm,
        iasKts: s.iasKts,
        gsKts: s.gsKts ?? null,
        dtMs: gapMs,
        pitchDeg: s.pitchDeg ?? null,
        bankDeg: s.bankDeg ?? null,
        headingDeg: s.headingDeg ?? null,
        latDeg: s.latDeg ?? null,
        lonDeg: s.lonDeg ?? null,
      });
    }
    return result;
  }

  /**
   * Get sample count.
   * @returns {number}
   */
  getSampleCount(): number {
    return this.samples.length;
  }

}


// ─── Frame normalization ────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for interpreting any input frame shape (live
// SimConnect raw, CSV-row-derived, mock provider, hand-crafted test). Every
// caller that wants to feed the stability scorer goes through this normalizer
// first — no input shape may be re-decoded ad-hoc anywhere else. Adding a new
// producer means: convert it into something this function understands; do NOT
// add interpretation logic at the call site.
//
// Returns a CANONICAL frame object whose field set is stable and whose values
// are already coerced/derived. `frameToSample` then only does sanity checks
// and reshaping into the ApproachSample contract the scorer consumes.
//
// Callers that already have a canonical frame can pass it through; the
// normalizer is intentionally tolerant of canonical field names too.

function firstDefined(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

/**
 * Normalize an arbitrarily-shaped input frame into the canonical shape the
 * stability scorer expects. See block comment above for the source-of-truth
 * contract.
 *
 * @param {object} input
 * @returns {object|null} Canonical frame, or null if input is not an object.
 */
function normalizeFrame(input: Record<string, any> | null | undefined): CanonicalFrame | null {
  if (!input || typeof input !== 'object') return null;

  const display = input.display && typeof input.display === 'object' ? input.display : {};
  const fdm = input.fdm && typeof input.fdm === 'object' ? input.fdm : {};

  // Required numerics — preserve "first non-null wins" semantics; finite
  // validation is deferred to frameToSample so callers can inspect the raw
  // canonical frame even when one of the required fields is absent.
  const raFt   = firstDefined(display.raFt,   input.raFt,   input.ra,  input.radio_altitude_ft);
  const iasKts = firstDefined(display.iasKts, input.iasKts, input.ias, input.ias_kts);
  const vsFpm  = firstDefined(display.vsFpm,  input.vsFpm,  input.vs,  input.vs_fpm);
  // Legacy pilot-adjustable barometric indication. New recordings also carry
  // calibrated altitude; source selection happens once over the complete
  // approach buffer rather than point-by-point.
  const altMslFt = firstDefined(display.altMslFt, input.altMslFt, input.alt_msl_ft, input.altMsl, input.altitude?.msl);
  const altCalibratedFt = firstDefined(display.altCalibratedFt, input.altCalibratedFt, input.alt_calibrated_ft, input.altitude?.calibrated, fdm.altCalibratedFt);
  const altPlaneFt = firstDefined(display.altPlaneFt, input.altPlaneFt, input.alt_plane_ft, input.altitude?.plane, fdm.altPlaneFt);
  const pressureAltFt = firstDefined(display.pressureAltFt, input.pressureAltFt, input.pressure_alt_ft, input.altitude?.pressure, fdm.pressureAltFt);
  const aircraftAglFt = firstDefined(input.aircraftAglFt, input.aircraft_agl_ft, input.altitude?.aircraftAgl, fdm.aircraftAglFt);
  const aircraftAboveObstaclesFt = firstDefined(input.aircraftAboveObstaclesFt, input.aircraft_above_obstacles_ft, input.altitude?.aircraftAboveObstacles, fdm.aircraftAboveObstaclesFt);
  const planeAglFt = firstDefined(input.planeAglFt, input.plane_agl_ft, input.altitude?.planeAgl, fdm.planeAglFt);
  const planeAglMinusCgFt = firstDefined(input.planeAglMinusCgFt, input.plane_agl_minus_cg_ft, input.altitude?.planeAglMinusCg, fdm.planeAglMinusCgFt);

  // ── Gear ─────────────────────────────────────────────────────────────────
  // Two orthogonal outputs:
  //   gearDownLocked — int 0|1|null   (the change-detection "raw" value)
  //   gearDown       — boolean        (the gate "is the gear down?" flag)
  let gearDownLocked = null;
  if (typeof input.gearDownLocked === 'number') {
    gearDownLocked = input.gearDownLocked === 1 ? 1 : 0;
  } else if (input.gear && typeof input.gear === 'object' && typeof input.gear.locked === 'boolean') {
    gearDownLocked = input.gear.locked ? 1 : 0;
  }
  let gearDown: boolean | null;
  if (typeof input.gearDown === 'boolean') {
    gearDown = input.gearDown;
  } else if (input.gear && typeof input.gear === 'object') {
    gearDown = input.gear.locked === true;
  } else if (typeof input.gear_locked === 'boolean') {
    gearDown = input.gear_locked;
  } else if (typeof input.gearDownLocked === 'number') {
    gearDown = input.gearDownLocked === 1;
  } else {
    gearDown = null;
  }
  const hasExplicitGearState = typeof input.gearDown === 'boolean'
    || (input.gear && typeof input.gear === 'object' && typeof input.gear.locked === 'boolean')
    || typeof input.gear_locked === 'boolean';
  const hasGenericGearState = typeof input.gearDownLocked === 'number' && Number.isFinite(input.gearDownLocked);
  const gearAvailable = hasExplicitGearState
    || (input.gearConfigurationAvailable !== false && hasGenericGearState);
  if (!gearAvailable) gearDown = null;

  // ── Flaps ────────────────────────────────────────────────────────────────
  // The live SimConnect provider sends `flaps` as a bare number (0-100 from
  // FLAPS HANDLE PERCENT). The CSV-replay path sends an object. Both must end
  // up with the same `flapsPercent`/`flapsNotch`/`flapsLanding` semantics.
  let flapsPercent = firstDefined(input.flapsPercent, input.flaps_percent);
  let flapsNotch = null;
  if (input.flaps && typeof input.flaps === 'object') {
    flapsPercent = firstDefined(
      input.flaps.percent,
      input.flaps.fraction != null ? input.flaps.fraction * 100 : null
    );
    flapsNotch = firstDefined(input.flaps.currentNotch, input.flaps.notch);
  } else if (typeof input.flaps === 'number') {
    flapsPercent = input.flaps;
  }
  flapsNotch = firstDefined(input.flapsNotch, input.flaps_notch, flapsNotch);

  let flapsLanding: boolean | null;
  if (typeof input.flapsLanding === 'boolean') {
    flapsLanding = input.flapsLanding;
  } else if (typeof input.flaps_landing === 'boolean') {
    flapsLanding = input.flaps_landing;
  } else if (input.flaps && typeof input.flaps === 'object') {
    // PERMISSIVE for ALL aircraft: extension >10% OR notch>0 = configured.
    flapsLanding = (typeof flapsPercent === 'number' && flapsPercent > 10) ||
                   (typeof flapsNotch === 'number' && flapsNotch > 0);
  } else if (typeof input.flaps === 'number') {
    flapsLanding = input.flaps > 10;
  } else if (typeof flapsPercent === 'number' || typeof flapsNotch === 'number') {
    flapsLanding = (typeof flapsPercent === 'number' && flapsPercent > 10) ||
                   (typeof flapsNotch === 'number' && flapsNotch > 0);
  } else if (input.flaps == null) {
    flapsLanding = null;
  } else {
    flapsLanding = false;
  }
  const hasExplicitFlapsState = typeof input.flapsLanding === 'boolean'
    || typeof input.flaps_landing === 'boolean';
  const hasIndependentLvarFlapsState = input.flaps
    && typeof input.flaps === 'object'
    && input.flaps.source === 'lvar';
  const hasGenericFlapsState = (typeof flapsPercent === 'number' && Number.isFinite(flapsPercent))
    || (typeof flapsNotch === 'number' && Number.isFinite(flapsNotch));
  const flapsAvailable = hasExplicitFlapsState
    || ((input.flapsConfigurationAvailable !== false || hasIndependentLvarFlapsState) && hasGenericFlapsState);
  if (!flapsAvailable) flapsLanding = null;

  // ── Spoilers ─────────────────────────────────────────────────────────────
  // ARMED is correct procedure (auto-deploy on touchdown) and counts as
  // "retracted" for stability purposes. Only EXTENDED in-flight is a breach.
  // SPOILERS ARMED boolean is the authoritative source — see spoilers.js for
  // the upstream state mapping.
  const hasDirectSpoilersShape =
    input.spoilersState != null ||
    input.spoiler_state != null ||
    input.spoilersPercent != null ||
    input.spoiler_pct != null;
  let spoilersState = firstDefined(input.spoilersState, input.spoiler_state);
  let spoilersPercent = firstDefined(input.spoilersPercent, input.spoiler_pct);
  if (input.spoilers && typeof input.spoilers === 'object') {
    spoilersState = input.spoilers.state || null;
    spoilersPercent = firstDefined(
      input.spoilers.percent,
      input.spoilers.fraction != null ? input.spoilers.fraction * 100 : null
    );
  } else if (typeof input.spoilers === 'number' && !hasDirectSpoilersShape) {
    spoilersPercent = input.spoilers;
  }

  let spoilersRetracted;
  if (typeof input.spoilersRetracted === 'boolean') {
    spoilersRetracted = input.spoilersRetracted;
  } else if (input.spoilers && typeof input.spoilers === 'object') {
    spoilersRetracted =
      spoilersState === 'STOWED' ||
      spoilersState === 'ARMED' ||
      (typeof spoilersPercent === 'number' && spoilersPercent < 5) ||
      // Suppressed / unavailable data (state:null, percent:null) — assume retracted
      // to avoid penalising aircraft where no authoritative source is connected.
      (spoilersState === null && spoilersPercent === null);
  } else if (hasDirectSpoilersShape) {
    spoilersRetracted =
      spoilersState === 'STOWED' ||
      spoilersState === 'ARMED' ||
      (typeof spoilersPercent === 'number' && spoilersPercent < 5);
  } else {
    spoilersRetracted = true; // no data → assume retracted (don't penalize)
  }

  // ── Optional fields ──────────────────────────────────────────────────────
  // Loose `??`-style chains — same as before. No coercion; downstream consumers
  // tolerate non-numbers / nulls and skip those samples.
  const gsKts      = firstDefined(input.gs,      input.gsKts,      input.gs_kts);
  // Prefer explicit degree fields over the ambiguous `pitch`/`bank` fields.
  // The live SimConnect provider stores pitch/bank as radians (frame.pitch = pitchDeg * DEG2RAD);
  // the CSV-replay path supplies degrees via `pitch:` (row.pitch_deg). Both routes are handled
  // by the call-site augmenting the frame with pitchDeg/bankDeg when radians are in use.
  const pitchDeg   = firstDefined(input.pitchDeg, input.pitch_deg, input.pitch);
  const bankDeg    = firstDefined(input.bankDeg,  input.bank_deg,  input.bank);
  const thrustPct  = firstDefined(input.thrust,  input.thrustPct,  input.thrust_pct);
  const headingDeg = firstDefined(input.heading, input.headingDeg, input.heading_deg);
  const latDeg     = firstDefined(input.lat,     input.latDeg,     input.lat_deg);
  const lonDeg     = firstDefined(input.lon,     input.lonDeg,     input.lon_deg);
  const dtMs       = firstDefined(input.dtMs, input.meta?.actualDeltaMs, input.pollRateMs);

  // Weight-on-wheels — accepts wow / on_ground / onGround. The scorer uses
  // this to exclude on-ground samples from change detection (auto-deploying
  // spoilers and rollout flap retraction are not approach breaches).
  const onGround = !!(input.onGround ?? input.on_ground ?? input.wow);
  const normalizedGearDownLocked = typeof gearDownLocked === 'number' ? gearDownLocked : null;
  const normalizedFlapsPercent = flapsAvailable && typeof flapsPercent === 'number' && Number.isFinite(flapsPercent) ? flapsPercent : null;
  const normalizedSpoilersState = typeof spoilersState === 'string' ? spoilersState : null;
  const normalizedSpoilersPercent = typeof spoilersPercent === 'number' && Number.isFinite(spoilersPercent) ? spoilersPercent : null;

  return {
    raFt, iasKts, vsFpm, gsKts, altMslFt,
    altCalibratedFt, altPlaneFt, pressureAltFt,
    aircraftAglFt, aircraftAboveObstaclesFt, planeAglFt, planeAglMinusCgFt,
    gearDownLocked: normalizedGearDownLocked, gearDown, gearAvailable,
    flapsPercent: normalizedFlapsPercent, flapsNotch, flapsLanding, flapsAvailable,
    spoilersState: normalizedSpoilersState, spoilersPercent: normalizedSpoilersPercent, spoilersRetracted,
    pitchDeg, bankDeg, thrustPct,
    headingDeg, latDeg, lonDeg,
    onGround, dtMs,
  };
}

/**
 * Map any telemetry frame to ApproachSample format.
 * Delegates ALL input-shape interpretation to `normalizeFrame` (single source
 * of truth). Only this function knows the ApproachSample contract.
 *
 * @param {object} frame - Raw or canonical telemetry frame
 * @returns {object | null} ApproachSample or null if frame is unusable.
 */
function frameToSample(frame: Record<string, any>): ApproachSample | null {
  const n = normalizeFrame(frame);
  if (!n) return null;

  // Validate required numeric fields. Anything missing/non-finite means we
  // can't position this sample on the approach profile.
  if (typeof n.raFt   !== 'number' || !Number.isFinite(n.raFt))   return null;
  if (typeof n.iasKts !== 'number' || !Number.isFinite(n.iasKts)) return null;
  if (typeof n.vsFpm  !== 'number' || !Number.isFinite(n.vsFpm))  return null;

  const altMslFt = typeof n.altMslFt === 'number' && Number.isFinite(n.altMslFt) ? n.altMslFt : null;
  const altCalibratedFt = finiteNumberOrNull(n.altCalibratedFt);
  const altPlaneFt = finiteNumberOrNull(n.altPlaneFt);
  const pressureAltFt = finiteNumberOrNull(n.pressureAltFt);
  const aircraftAglFt = finiteNumberOrNull(n.aircraftAglFt);
  const aircraftAboveObstaclesFt = finiteNumberOrNull(n.aircraftAboveObstaclesFt);
  const planeAglFt = finiteNumberOrNull(n.planeAglFt);
  const planeAglMinusCgFt = finiteNumberOrNull(n.planeAglMinusCgFt);
  const gsKts = typeof n.gsKts === 'number' && Number.isFinite(n.gsKts) ? n.gsKts : null;
  const pitchDeg = typeof n.pitchDeg === 'number' && Number.isFinite(n.pitchDeg) ? n.pitchDeg : null;
  const bankDeg = typeof n.bankDeg === 'number' && Number.isFinite(n.bankDeg) ? n.bankDeg : null;
  const thrustPct = typeof n.thrustPct === 'number' && Number.isFinite(n.thrustPct) ? n.thrustPct : null;
  const headingDeg = typeof n.headingDeg === 'number' && Number.isFinite(n.headingDeg) ? n.headingDeg : null;
  const latDeg = typeof n.latDeg === 'number' && Number.isFinite(n.latDeg) ? n.latDeg : null;
  const lonDeg = typeof n.lonDeg === 'number' && Number.isFinite(n.lonDeg) ? n.lonDeg : null;
  const dtMs = typeof n.dtMs === 'number' && Number.isFinite(n.dtMs) ? n.dtMs : null;

  return {
    raFt: n.raFt,
    iasKts: n.iasKts,
    vsFpm: n.vsFpm,
    altMslFt,
    altCalibratedFt,
    altPlaneFt,
    pressureAltFt,
    aircraftAglFt,
    aircraftAboveObstaclesFt,
    planeAglFt,
    planeAglMinusCgFt,
    gearDown: n.gearDown,
    gearAvailable: n.gearAvailable,
    flapsLanding: n.flapsLanding,
    flapsAvailable: n.flapsAvailable,
    spoilersRetracted: n.spoilersRetracted,
    // Raw values for change detection
    rawGear: n.gearDownLocked,
    rawFlaps: n.flapsPercent,
    rawSpoilers: n.spoilersPercent,
    // Weight-on-wheels — used by _checkConfigurationStability to exclude
    // on-ground samples from the gear/flaps/spoilers change checks.
    onGround: n.onGround,
    // Optional fields
    gsKts,
    pitchDeg,
    bankDeg,
    thrustPct,
    headingDeg,
    latDeg,
    lonDeg,
    dtMs,
  };
}

// NOTE: The legacy per-tick stability scorer was removed. simbridge-core keeps
// an in-memory current-approach buffer for the live landing popup and LANDING
// CSV row; timeline-generator keeps a replay scorer for older or incomplete CSVs.

/**
 * Determine if conditions are IMC (Instrument Meteorological Conditions).
 * Per FAR 91.155 / ICAO Annex 2:
 * - VMC requires visibility >= 3SM (~5km) and clear of clouds
 * - Below these minima = IMC
 * 
 * @param {number|null} visibilityM - Visibility in meters (from SimConnect AMBIENT VISIBILITY)
 * @returns {boolean|null} True if IMC, false if VMC, null when visibility is unavailable
 */
function isImc(visibilityM: number | null | undefined): boolean | null {
  // Missing visibility is unknown, not IMC. Callers that need conservative
  // operational behavior should branch on imcDataAvailable explicitly.
  if (typeof visibilityM !== 'number' || !Number.isFinite(visibilityM)) {
    return null;
  }
  
  // IMC if visibility less than threshold
  return visibilityM < VMC_VISIBILITY_THRESHOLD_M;
}

const stabilityLogger = require('./stability-debug-logger') as StabilityLoggerModule;

/**
 * Primary stability-evaluation entry point.
 * Returns:
 *  {
 *    instantaneous: {...},   // stable/unstable + checks (per-tick)
 *    ultimateScore,          // final landing score (null until WOW)
 *    isImc,                  // boolean|null - weather condition, null if unknown
 *    imcDataAvailable        // boolean - true when visibility was available
 *  }
 */
function runStability(params: StabilityRunParams): StabilityRunResult {
  // Log a bounded sample of raw parameters before normalization.
  // Raw stability debug samples remain altitude-gated to avoid broad high-altitude logging.
  const rawRa = typeof params.ra === 'number' ? params.ra : Number.POSITIVE_INFINITY;
  const shouldLogRaw = stabilityLogger.isEnabled() && Math.random() < 0.20 && rawRa < 1500;

  if (shouldLogRaw) {
    // Detailed spoiler breakdown for debugging armed vs deployed
    const spoilerDebug = (() => {
      const s = params.spoilers;
      if (s && typeof s === 'object') {
        const spoilerRecord = s as Record<string, unknown>;
        return {
          type: 'object',
          state: spoilerRecord.state,
          fraction: spoilerRecord.fraction,
          percent: spoilerRecord.percent,
          raw: JSON.stringify(s),
          value: undefined,
        };
      }
      return {
        type: typeof s,
        value: s,
        state: undefined,
        fraction: undefined,
        percent: undefined,
        raw: undefined,
      };
    })();

    stabilityLogger.writeLog('RAW_INPUT', 'Pre-normalization params', {
      raw_flaps: params.flaps,
      raw_spoilers: spoilerDebug.value ?? spoilerDebug.raw,
      spoiler_type: spoilerDebug.type,
      spoiler_state: spoilerDebug.state,
      raw_ias: params.ias,
      raw_vs: params.vs,
      raw_ra: params.ra,
      raw_alt_msl_ft: params.alt_msl_ft,
      raw_gearDownLocked: params.gearDownLocked,
      raw_wow: params.wow,
    });
  }

  const imcConditions = isImc(params.visibilityM);

  return {
    instantaneous: null,
    ultimateScore: null, // Computed by SimpleStabilityScorer at landing time/replay.
    isImc: imcConditions,
    imcDataAvailable: imcConditions !== null,
    visibilityM: params.visibilityM,
  };
}

/**
 * Reset all stability scoring state.
 * Call this between flights or on go-around.
 */
function resetStability(): void {
  // No-op: legacy per-tick scoring state was removed. CSV replay and the
  // current-approach buffer manage their own retrospective scorer instances.
}

module.exports = { 
  runStability, 
  resetStability,
  isImc,  // Exported for testing
  VMC_VISIBILITY_THRESHOLD_M,  // Exported for documentation
  // Stability gate thresholds — exported so timeline-generator.js can
  // reference the same values for violation detection without re-defining them.
  BANK_MAX_DEG,
  VS_MIN_FPM,
  DEFAULT_GLIDEPATH_ANGLE_DEG,
  GLIDEPATH_VS_DELTA_MAX_FPM,
  STABILITY_VERDICT_POLICY_ID,
  STABILITY_VERDICT_POLICY_VERSION,
  STABILITY_VERDICT_MIN_OVERALL_SCORE,
  STABILITY_VERDICT_SEVERE_METRIC_FLOOR_PCT,
  classifyApproachStability,
  getStabilityCriteria,
  resolveGlidepathAngleForApproach,
  targetVerticalSpeedForGlidepath,
  verticalSpeedFactorForGlidepath,
  // Exported so the CSV-replay path in events/timeline-generator.js can
  // recompute a retrospective stability breakdown for landing events when the
  // recording does not include a LANDING record row (e.g. older recordings,
  // crashed recorder, or short-form CSVs).
  SimpleStabilityScorer,
  frameToSample,
  selectApproachAltitudeSource,
  // Single source of truth for interpreting any input frame shape. Producers
  // (live SimConnect, CSV-replay, mock) MUST go through this — no ad-hoc
  // re-decoding of flaps/spoilers/gear field shapes anywhere else.
  normalizeFrame,
};

export {};
