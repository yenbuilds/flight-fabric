'use strict';

const {
  finiteNumberOrNull,
  headingDifferenceDegrees,
  normalizeHeadingDegrees,
} = require('../utils/aviation-frames.js') as {
  finiteNumberOrNull: (value: unknown) => number | null;
  headingDifferenceDegrees: (left: unknown, right: unknown) => number | null;
  normalizeHeadingDegrees: (value: unknown) => number | null;
};

type AnyRecord = Record<string, any>;

export type RolloutAnalysisSample = {
  timestampMs: number;
  onGround: boolean;
  paused?: boolean;
  phase?: string | null;
  gsKts: number | null;
  bankDeg: number | null;
  rollRateDegS?: number | null;
  headingTrueDeg: number | null;
  lat: number | null;
  lon: number | null;
};

export type RolloutAnalysisContext = {
  taxiInMaxKts?: unknown;
  runwayHeadingTrueDeg?: unknown;
  runwayThreshold?: {
    lat?: unknown;
    lon?: unknown;
  } | null;
  runwayWidthFt?: unknown;
  runwayExcursion?: unknown;
  coordinatePrecisionDigits?: unknown;
  source?: unknown;
};

type RolloutSeverity = 'normal' | 'caution' | 'warning' | 'critical';

type RolloutFlag = {
  code: string;
  label: string;
  severity: Exclude<RolloutSeverity, 'normal'>;
};

const MIN_ROLLOUT_GS_KTS = 30;
const MAX_ROLLOUT_WINDOW_MS = 60_000;
const MAX_ROLLOUT_SAMPLES = 2_000;
const MIN_BANK_RATE_INTERVAL_S = 0.05;
const MAX_BANK_RATE_INTERVAL_S = 2;
const FT_PER_DEG_LAT = 364_567;

const SEVERITY_RANK: Record<RolloutSeverity, number> = {
  normal: 0,
  caution: 1,
  warning: 2,
  critical: 3,
};

function round(value: number | null, digits = 1): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** Math.max(0, digits);
  return Math.round(value * factor) / factor;
}

function booleanOrFalse(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function sideForSigned(value: number | null): 'left' | 'right' | 'center' | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) < 0.5) return 'center';
  return value > 0 ? 'right' : 'left';
}

function normalizePhase(value: unknown): string | null {
  const phase = typeof value === 'string'
    ? value.trim().toUpperCase().replaceAll('_', '-')
    : '';
  return phase || null;
}

function isTaxiInPhase(value: unknown): boolean {
  return normalizePhase(value) === 'TAXI-IN';
}

function addFlag(
  flags: RolloutFlag[],
  code: string,
  label: string,
  severity: Exclude<RolloutSeverity, 'normal'>,
): void {
  if (flags.some((flag) => flag.code === code)) return;
  flags.push({ code, label, severity });
}

function maxSeverity(flags: RolloutFlag[]): RolloutSeverity {
  let result: RolloutSeverity = 'normal';
  for (const flag of flags) {
    if (SEVERITY_RANK[flag.severity] > SEVERITY_RANK[result]) {
      result = flag.severity;
    }
  }
  return result;
}

function coordinatePrecisionUncertaintyFt(value: unknown): number | null {
  const digits = finiteNumberOrNull(value);
  if (digits == null || digits < 0 || digits > 12) return null;
  return 0.5 * (10 ** -Math.floor(digits)) * FT_PER_DEG_LAT;
}

function lateralOffsetFt(
  lat: number,
  lon: number,
  thresholdLat: number,
  thresholdLon: number,
  runwayHeadingTrueDeg: number,
): number {
  const headingRad = runwayHeadingTrueDeg * Math.PI / 180;
  const eastFt = (lon - thresholdLon)
    * FT_PER_DEG_LAT
    * Math.cos(thresholdLat * Math.PI / 180);
  const northFt = (lat - thresholdLat) * FT_PER_DEG_LAT;
  // Clockwise perpendicular to the runway axis: positive is right of centerline.
  return eastFt * Math.cos(headingRad) - northFt * Math.sin(headingRad);
}

function normalizeSample(value: AnyRecord): RolloutAnalysisSample | null {
  const timestampMs = finiteNumberOrNull(value?.timestampMs ?? value?.timestamp_ms ?? value?.ts);
  if (timestampMs == null) return null;
  const rollRateDegS = finiteNumberOrNull(
    value?.rollRateDegS
    ?? value?.roll_rate_deg_s
    ?? value?.bankRateDegS
    ?? value?.bank_rate_deg_s,
  );
  const rollRateRadS = finiteNumberOrNull(value?.rollRateRadS ?? value?.roll_rate_rad_s);
  const onGround = value?.onGround === true
    || value?.on_ground === true
    || value?.on_ground === 1
    || value?.on_ground === '1'
    || value?.wow === true;
  return {
    timestampMs,
    onGround,
    paused: booleanOrFalse(value?.paused ?? value?.sim_paused)
      || booleanOrFalse(value?.inMenu ?? value?.sim_in_menu),
    phase: normalizePhase(value?.phase ?? value?.flight_phase_hint),
    gsKts: finiteNumberOrNull(value?.gsKts ?? value?.gs_kts ?? value?.gs),
    bankDeg: finiteNumberOrNull(value?.bankDeg ?? value?.bank_deg ?? value?.bank),
    rollRateDegS: rollRateDegS ?? (
      rollRateRadS == null ? null : rollRateRadS * (180 / Math.PI)
    ),
    headingTrueDeg: normalizeHeadingDegrees(
      value?.headingTrueDeg
      ?? value?.hdg_true_deg
      ?? value?.hdgTrueDeg
      ?? value?.heading,
    ),
    lat: finiteNumberOrNull(value?.lat ?? value?.lat_deg),
    lon: finiteNumberOrNull(value?.lon ?? value?.lon_deg),
  };
}

function selectEligibleSamples(
  samples: AnyRecord[],
  taxiInMaxKts: number | null,
): RolloutAnalysisSample[] {
  const normalized = samples
    .map(normalizeSample)
    .filter((sample): sample is RolloutAnalysisSample => sample !== null)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (normalized.length === 0) return [];

  const eligible: RolloutAnalysisSample[] = [];
  let startMs: number | null = null;
  let lastTimestampMs: number | null = null;
  let rolloutStarted = false;
  for (const sample of normalized) {
    if (sample.timestampMs === lastTimestampMs) continue;
    lastTimestampMs = sample.timestampMs;
    if (!sample.onGround || sample.paused) continue;
    if (sample.gsKts != null && taxiInMaxKts != null && sample.gsKts <= taxiInMaxKts) {
      break;
    }
    if (
      isTaxiInPhase(sample.phase)
      && (sample.gsKts == null || taxiInMaxKts == null)
    ) {
      break;
    }
    if (sample.gsKts == null) continue;
    if (sample.gsKts < MIN_ROLLOUT_GS_KTS) {
      if (rolloutStarted) break;
      continue;
    }
    if (startMs == null) startMs = sample.timestampMs;
    if (sample.timestampMs - startMs > MAX_ROLLOUT_WINDOW_MS) break;
    rolloutStarted = true;
    eligible.push(sample);
    if (eligible.length >= MAX_ROLLOUT_SAMPLES) break;
  }
  return eligible;
}

type BankRateObservation = {
  timestampMs: number;
  gsKts: number | null;
  rateDegS: number;
};

function collectBankRateObservations(
  samples: RolloutAnalysisSample[],
): {
  observations: BankRateObservation[];
  source: 'recorded-roll-rate' | 'bank-angle-slope' | null;
} {
  const recorded = samples
    .filter((sample) => sample.rollRateDegS != null)
    .map((sample) => ({
      timestampMs: sample.timestampMs,
      gsKts: sample.gsKts,
      rateDegS: Math.abs(sample.rollRateDegS as number),
    }));
  if (recorded.length > 0) {
    return { observations: recorded, source: 'recorded-roll-rate' };
  }

  const derived: BankRateObservation[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[index - 1];
    if (sample.bankDeg == null || previous.bankDeg == null) continue;
    const intervalS = (sample.timestampMs - previous.timestampMs) / 1000;
    if (intervalS < MIN_BANK_RATE_INTERVAL_S || intervalS > MAX_BANK_RATE_INTERVAL_S) continue;
    derived.push({
      timestampMs: sample.timestampMs,
      gsKts: sample.gsKts,
      rateDegS: Math.abs(sample.bankDeg - previous.bankDeg) / intervalS,
    });
  }
  return {
    observations: derived,
    source: derived.length > 0 ? 'bank-angle-slope' : null,
  };
}

function persistentPeakBankRate(
  observations: BankRateObservation[],
): { rateDegS: number | null; gsKts: number | null } {
  let peakRateDegS: number | null = null;
  let peakAtGsKts: number | null = null;
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1];
    const current = observations[index];
    const intervalS = (current.timestampMs - previous.timestampMs) / 1000;
    if (intervalS < MIN_BANK_RATE_INTERVAL_S || intervalS > MAX_BANK_RATE_INTERVAL_S) continue;

    // Use the lower of two consecutive observations. A one-frame source update
    // can no longer manufacture a warning, while a real sustained roll remains.
    const persistentRateDegS = Math.min(previous.rateDegS, current.rateDegS);
    if (peakRateDegS == null || persistentRateDegS > peakRateDegS) {
      peakRateDegS = persistentRateDegS;
      peakAtGsKts = current.gsKts;
    }
  }
  return { rateDegS: peakRateDegS, gsKts: peakAtGsKts };
}

function classifyLateralQuality(precisionDigits: number | null): 'high' | 'medium' | 'low' | 'unavailable' {
  if (precisionDigits == null) return 'unavailable';
  if (precisionDigits >= 6) return 'high';
  if (precisionDigits === 5) return 'medium';
  return 'low';
}

export function analyzeRollout(
  rawSamples: AnyRecord[] | null | undefined,
  context: RolloutAnalysisContext = {},
): AnyRecord | null {
  if (!Array.isArray(rawSamples)) return null;
  const configuredTaxiInMaxKts = finiteNumberOrNull(context.taxiInMaxKts);
  const taxiInMaxKts = configuredTaxiInMaxKts != null && configuredTaxiInMaxKts >= 0
    ? configuredTaxiInMaxKts
    : null;
  const samples = selectEligibleSamples(rawSamples, taxiInMaxKts);
  if (samples.length < 2) return null;

  const runwayHeadingTrueDeg = normalizeHeadingDegrees(context.runwayHeadingTrueDeg);
  const runwayWidthFt = finiteNumberOrNull(context.runwayWidthFt);
  const thresholdLat = finiteNumberOrNull(context.runwayThreshold?.lat);
  const thresholdLon = finiteNumberOrNull(context.runwayThreshold?.lon);
  const coordinatePrecisionDigits = finiteNumberOrNull(context.coordinatePrecisionDigits);
  const lateralUncertaintyFt = coordinatePrecisionUncertaintyFt(coordinatePrecisionDigits);
  const lateralDataQuality = thresholdLat != null
    && thresholdLon != null
    && runwayHeadingTrueDeg != null
    ? classifyLateralQuality(coordinatePrecisionDigits)
    : 'unavailable';

  let peakBankSample: RolloutAnalysisSample | null = null;
  let peakHeadingDeviationSignedDeg: number | null = null;
  let peakHeadingDeviationAtGsKts: number | null = null;
  let peakLateralOffsetSignedFt: number | null = null;

  for (const sample of samples) {
    if (
      sample.bankDeg != null
      && (
        peakBankSample == null
        || peakBankSample.bankDeg == null
        || Math.abs(sample.bankDeg) > Math.abs(peakBankSample.bankDeg)
      )
    ) {
      peakBankSample = sample;
    }

    if (runwayHeadingTrueDeg != null && sample.headingTrueDeg != null) {
      const deviation = headingDifferenceDegrees(sample.headingTrueDeg, runwayHeadingTrueDeg);
      if (
        deviation != null
        && (
          peakHeadingDeviationSignedDeg == null
          || Math.abs(deviation) > Math.abs(peakHeadingDeviationSignedDeg)
        )
      ) {
        peakHeadingDeviationSignedDeg = deviation;
        peakHeadingDeviationAtGsKts = sample.gsKts;
      }
    }

    if (
      thresholdLat != null
      && thresholdLon != null
      && runwayHeadingTrueDeg != null
      && sample.lat != null
      && sample.lon != null
    ) {
      const offsetFt = lateralOffsetFt(
        sample.lat,
        sample.lon,
        thresholdLat,
        thresholdLon,
        runwayHeadingTrueDeg,
      );
      if (
        peakLateralOffsetSignedFt == null
        || Math.abs(offsetFt) > Math.abs(peakLateralOffsetSignedFt)
      ) {
        peakLateralOffsetSignedFt = offsetFt;
      }
    }
  }

  const bankRateObservations = collectBankRateObservations(samples);
  const persistentBankRate = persistentPeakBankRate(bankRateObservations.observations);
  const peakBankRateDegS = persistentBankRate.rateDegS;
  const peakBankRateAtGsKts = persistentBankRate.gsKts;
  const maxBankDeg = peakBankSample?.bankDeg == null ? null : Math.abs(peakBankSample.bankDeg);
  const maxHeadingDeviationDeg = peakHeadingDeviationSignedDeg == null
    ? null
    : Math.abs(peakHeadingDeviationSignedDeg);
  const maxLateralOffsetFt = peakLateralOffsetSignedFt == null
    ? null
    : Math.abs(peakLateralOffsetSignedFt);
  const minRunwayEdgeMarginFt = runwayWidthFt != null
    && runwayWidthFt > 0
    && maxLateralOffsetFt != null
    ? (runwayWidthFt / 2) - maxLateralOffsetFt
    : null;
  const conservativeRunwayEdgeMarginFt = minRunwayEdgeMarginFt != null
    && lateralUncertaintyFt != null
    ? minRunwayEdgeMarginFt - lateralUncertaintyFt
    : minRunwayEdgeMarginFt;

  const flags: RolloutFlag[] = [];
  const runwayExcursion = booleanOrFalse(context.runwayExcursion);
  if (runwayExcursion) {
    addFlag(flags, 'runway_excursion', 'Runway excursion', 'critical');
  }
  if (maxBankDeg != null) {
    if (maxBankDeg >= 8) addFlag(flags, 'rollout_bank', 'Excessive bank during rollout', 'warning');
    else if (maxBankDeg >= 3) addFlag(flags, 'rollout_bank', 'Noticeable bank during rollout', 'caution');
  }
  if (peakBankRateDegS != null) {
    if (peakBankRateDegS >= 8) addFlag(flags, 'rapid_bank_change', 'Rapid bank change during rollout', 'warning');
    else if (peakBankRateDegS >= 4) addFlag(flags, 'rapid_bank_change', 'Abrupt bank correction during rollout', 'caution');
  }
  if (maxHeadingDeviationDeg != null) {
    if (maxHeadingDeviationDeg >= 20) addFlag(flags, 'heading_deviation', 'Major runway-heading deviation', 'warning');
    else if (maxHeadingDeviationDeg >= 10) addFlag(flags, 'heading_deviation', 'Runway-heading deviation', 'caution');
  }
  if (conservativeRunwayEdgeMarginFt != null) {
    if (conservativeRunwayEdgeMarginFt <= 0) {
      addFlag(
        flags,
        'runway_edge_margin',
        'Aircraft reference point reached runway edge',
        runwayExcursion ? 'critical' : 'warning',
      );
    } else if (conservativeRunwayEdgeMarginFt <= 15) {
      addFlag(flags, 'runway_edge_margin', 'Very small runway-edge margin', 'warning');
    } else if (conservativeRunwayEdgeMarginFt <= 25) {
      addFlag(flags, 'runway_edge_margin', 'Reduced runway-edge margin', 'caution');
    }
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    schemaVersion: 2,
    source: typeof context.source === 'string' && context.source ? context.source : 'computed',
    assessment: maxSeverity(flags),
    sampleCount: samples.length,
    durationMs: Math.max(0, last.timestampMs - first.timestampMs),
    startGsKts: round(first.gsKts),
    endGsKts: round(last.gsKts),
    maxBankDeg: round(maxBankDeg),
    maxBankSignedDeg: round(peakBankSample?.bankDeg ?? null),
    maxBankAtGsKts: round(peakBankSample?.gsKts ?? null),
    maxBankRateDegS: round(peakBankRateDegS),
    maxBankRateAtGsKts: round(peakBankRateAtGsKts),
    bankRateSource: bankRateObservations.source,
    maxHeadingDeviationDeg: round(maxHeadingDeviationDeg),
    maxHeadingDeviationSide: sideForSigned(peakHeadingDeviationSignedDeg),
    maxHeadingDeviationAtGsKts: round(peakHeadingDeviationAtGsKts),
    maxLateralOffsetFt: round(maxLateralOffsetFt),
    maxLateralOffsetSide: sideForSigned(peakLateralOffsetSignedFt),
    minRunwayEdgeMarginFt: round(minRunwayEdgeMarginFt),
    conservativeRunwayEdgeMarginFt: round(conservativeRunwayEdgeMarginFt),
    lateralUncertaintyFt: round(lateralUncertaintyFt),
    lateralDataQuality,
    coordinatePrecisionDigits: coordinatePrecisionDigits == null
      ? null
      : Math.floor(coordinatePrecisionDigits),
    taxiInMaxKts: round(taxiInMaxKts),
    runwayWidthFt: round(runwayWidthFt),
    flags,
  };
}

export function inferCoordinatePrecisionDigits(samples: AnyRecord[]): number | null {
  let maximumDigits = 0;
  let observed = false;
  for (const sample of samples) {
    for (const value of [sample?.lat ?? sample?.lat_deg, sample?.lon ?? sample?.lon_deg]) {
      const numeric = finiteNumberOrNull(value);
      if (numeric == null) continue;
      observed = true;
      const text = String(value).toLowerCase();
      if (text.includes('e-')) {
        const exponent = Number(text.split('e-')[1]);
        if (Number.isFinite(exponent)) maximumDigits = Math.max(maximumDigits, exponent);
        continue;
      }
      const decimal = text.split('.')[1] || '';
      maximumDigits = Math.max(maximumDigits, decimal.length);
    }
  }
  return observed ? maximumDigits : null;
}

export const ROLLOUT_ANALYSIS_LIMITS = Object.freeze({
  minGroundSpeedKts: MIN_ROLLOUT_GS_KTS,
  maxWindowMs: MAX_ROLLOUT_WINDOW_MS,
  maxSamples: MAX_ROLLOUT_SAMPLES,
});

module.exports = {
  analyzeRollout,
  inferCoordinatePrecisionDigits,
  ROLLOUT_ANALYSIS_LIMITS,
};
