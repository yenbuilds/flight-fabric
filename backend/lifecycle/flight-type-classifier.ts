import type { FlightTypeMap, FlightTypeValue } from './flight-types';

'use strict';

type FlightSample = Record<string, unknown>;

type TouchdownOptions = {
  wowKey?: string;
  tsKey?: string;
};

type AltitudeOptions = {
  raKey?: string;
  altMslKey?: string;
  wowKey?: string;
};

type ClassificationOptions = TouchdownOptions & AltitudeOptions;

type TouchdownResult = {
  count: number;
  timestamps: number[];
};

type AltitudeStats = {
  maxAglFt: number;
  maxMslFt: number;
  avgAglFt: number;
  hasAglData: boolean;
  aglSampleCount: number;
  altitudeSource: 'radio' | 'msl-baseline' | 'unknown';
  mslBaselineFt: number | null;
};

type PatternThresholds = Readonly<{
  MAX_ALTITUDE_AGL_FT: number;
  MIN_LANDING_COUNT: number;
  MAX_AVG_TIME_BETWEEN_LANDINGS_MS: number;
  MAX_TOTAL_FLIGHT_TIME_MS: number;
  HIGH_CONFIDENCE_LANDING_COUNT: number;
}>;

type PatternSignals = {
  altitudeBelowPatternMax: boolean;
  hasMultipleLandings: boolean;
  shortIntervals: boolean;
  reasonableFlightTime: boolean;
  highConfidencePattern: boolean;
};

type FlightClassificationEvidence = {
  reason?: string;
  classification?: string;
  landingCount?: number;
  maxAltAglFt?: number;
  maxAltMslFt?: number;
  hasAltitudeData?: boolean;
  altitudeSource?: AltitudeStats['altitudeSource'];
  altitudeSampleCount?: number;
  mslBaselineFt?: number | null;
  totalFlightTimeMs?: number;
  avgTimeBetweenLandingsMs?: number;
  touchdownTimestamps?: number[];
  thresholds?: PatternThresholds;
  patternSignals?: PatternSignals;
};

type FlightClassification = {
  flightType: FlightTypeValue;
  confidence: number;
  landingCount: number;
  circuitCount: number;
  maxAltAglFt: number;
  totalFlightTimeMs: number;
  avgTimeBetweenLandingsMs: number;
  isPatternWork: boolean;
  evidence: FlightClassificationEvidence;
};

const { FLIGHT_TYPE } = require('./flight-types') as { FLIGHT_TYPE: FlightTypeMap };

const PATTERN_THRESHOLDS: PatternThresholds = Object.freeze({
  MAX_ALTITUDE_AGL_FT: 2000,
  MIN_LANDING_COUNT: 2,
  MAX_AVG_TIME_BETWEEN_LANDINGS_MS: 8 * 60 * 1000,
  MAX_TOTAL_FLIGHT_TIME_MS: 2 * 60 * 60 * 1000,
  HIGH_CONFIDENCE_LANDING_COUNT: 5,
});

// Keep flight classification consistent with timeline replay: contacts less
// than ten seconds apart are one landing sequence, not separate circuits.
const BOUNCE_CLUSTER_WINDOW_MS = 10 * 1000;

function getSampleValue(sample: FlightSample, key: string): unknown {
  return sample[key];
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toWowBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value === true || value === 1 || value === '1' || value === 'true';
}

function countTouchdowns(
  samples: FlightSample[],
  options: TouchdownOptions = {},
): TouchdownResult {
  const wowKey = options.wowKey || 'wow';
  const tsKey = options.tsKey || 'ts';

  const touchdowns: number[] = [];
  let previousWow: boolean | null = null;

  for (const sample of samples) {
    const wow = toWowBoolean(getSampleValue(sample, wowKey));
    const ts = toFiniteNumber(getSampleValue(sample, tsKey));

    if (wow === null) {
      continue;
    }

    if (previousWow === false && wow === true && ts !== null) {
      touchdowns.push(ts);
    }

    previousWow = wow;
  }

  return {
    count: touchdowns.length,
    timestamps: touchdowns,
  };
}

function collapseBounceTouchdowns(timestamps: number[]): number[] {
  const landings: number[] = [];
  let previousContactTs: number | null = null;

  for (const timestamp of timestamps) {
    if (previousContactTs === null || timestamp - previousContactTs >= BOUNCE_CLUSTER_WINDOW_MS) {
      landings.push(timestamp);
    }
    previousContactTs = timestamp;
  }

  return landings;
}

function calculateAltitudeStats(
  samples: FlightSample[],
  options: AltitudeOptions = {},
): AltitudeStats {
  const raKey = options.raKey || 'ra_ft';
  const altMslKey = options.altMslKey || 'alt_msl_ft';
  const wowKey = options.wowKey || 'wow';

  let maxAglFt = 0;
  let maxMslFt = 0;
  let sumAglFt = 0;
  let countAgl = 0;
  const altMslValues: number[] = [];
  const groundMslValues: number[] = [];

  for (const sample of samples) {
    const ra = toFiniteNumber(getSampleValue(sample, raKey));
    const altMsl = toFiniteNumber(getSampleValue(sample, altMslKey));
    const wow = toWowBoolean(getSampleValue(sample, wowKey));

    if (ra !== null && ra >= 0) {
      maxAglFt = Math.max(maxAglFt, ra);
      sumAglFt += ra;
      countAgl++;
    }

    if (altMsl !== null) {
      maxMslFt = Math.max(maxMslFt, altMsl);
      altMslValues.push(altMsl);
      if (wow === true) {
        groundMslValues.push(altMsl);
      }
    }
  }

  if (countAgl > 0) {
    return {
      maxAglFt,
      maxMslFt,
      avgAglFt: sumAglFt / countAgl,
      hasAglData: true,
      aglSampleCount: countAgl,
      altitudeSource: 'radio',
      mslBaselineFt: null,
    };
  }

  if (altMslValues.length > 0 && groundMslValues.length > 0) {
    const mslBaselineFt = Math.min(...groundMslValues);
    for (const altMsl of altMslValues) {
      const agl = Math.max(0, altMsl - mslBaselineFt);
      maxAglFt = Math.max(maxAglFt, agl);
      sumAglFt += agl;
    }

    return {
      maxAglFt,
      maxMslFt,
      avgAglFt: sumAglFt / altMslValues.length,
      hasAglData: true,
      aglSampleCount: altMslValues.length,
      altitudeSource: 'msl-baseline',
      mslBaselineFt,
    };
  }

  return {
    maxAglFt,
    maxMslFt,
    avgAglFt: 0,
    hasAglData: false,
    aglSampleCount: 0,
    altitudeSource: 'unknown',
    mslBaselineFt: null,
  };
}

function classifyFlight(
  samples: FlightSample[],
  options: ClassificationOptions = {},
): FlightClassification {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      flightType: FLIGHT_TYPE.UNKNOWN,
      confidence: 0,
      landingCount: 0,
      circuitCount: 0,
      maxAltAglFt: 0,
      totalFlightTimeMs: 0,
      avgTimeBetweenLandingsMs: 0,
      isPatternWork: false,
      evidence: { reason: 'No samples provided' },
    };
  }

  const tsKey = options.tsKey || 'ts';
  const firstTs = toFiniteNumber(getSampleValue(samples[0], tsKey));
  const lastTs = toFiniteNumber(getSampleValue(samples[samples.length - 1], tsKey));
  const totalFlightTimeMs = firstTs !== null && lastTs !== null
    ? Math.max(0, lastTs - firstTs)
    : 0;

  const touchdownResult = countTouchdowns(samples, options);
  const touchdownTimestamps = collapseBounceTouchdowns(touchdownResult.timestamps);
  const landingCount = touchdownTimestamps.length;

  const altitudeStats = calculateAltitudeStats(samples, options);
  const maxAltAglFt = altitudeStats.maxAglFt;
  const hasAltitudeData = altitudeStats.hasAglData;

  let avgTimeBetweenLandingsMs = 0;
  if (touchdownTimestamps.length >= 2) {
    const intervals: number[] = [];
    for (let index = 1; index < touchdownTimestamps.length; index++) {
      intervals.push(
        touchdownTimestamps[index] - touchdownTimestamps[index - 1],
      );
    }
    avgTimeBetweenLandingsMs = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
  }

  const evidence: FlightClassificationEvidence = {
    landingCount,
    maxAltAglFt,
    maxAltMslFt: altitudeStats.maxMslFt,
    hasAltitudeData,
    altitudeSource: altitudeStats.altitudeSource,
    altitudeSampleCount: altitudeStats.aglSampleCount,
    mslBaselineFt: altitudeStats.mslBaselineFt,
    totalFlightTimeMs,
    avgTimeBetweenLandingsMs,
    touchdownTimestamps,
    thresholds: PATTERN_THRESHOLDS,
  };

  const altitudeBelowPatternMax = hasAltitudeData
    && maxAltAglFt < PATTERN_THRESHOLDS.MAX_ALTITUDE_AGL_FT;
  const hasMultipleLandings = landingCount >= PATTERN_THRESHOLDS.MIN_LANDING_COUNT;
  const shortIntervals = avgTimeBetweenLandingsMs > 0
    && avgTimeBetweenLandingsMs < PATTERN_THRESHOLDS.MAX_AVG_TIME_BETWEEN_LANDINGS_MS;
  const reasonableFlightTime = totalFlightTimeMs < PATTERN_THRESHOLDS.MAX_TOTAL_FLIGHT_TIME_MS;

  const highConfidencePattern = landingCount >= PATTERN_THRESHOLDS.HIGH_CONFIDENCE_LANDING_COUNT
    && altitudeBelowPatternMax
    && shortIntervals
    && reasonableFlightTime;

  const isPatternWork = (
    hasMultipleLandings
    && altitudeBelowPatternMax
    && shortIntervals
    && reasonableFlightTime
  ) || highConfidencePattern;

  evidence.patternSignals = {
    altitudeBelowPatternMax,
    hasMultipleLandings,
    shortIntervals,
    reasonableFlightTime,
    highConfidencePattern,
  };

  let confidence = 0;
  let flightType: FlightTypeValue = FLIGHT_TYPE.UNKNOWN;

  if (isPatternWork) {
    flightType = FLIGHT_TYPE.PATTERN_WORK;

    const landingFactor = Math.min(1, landingCount / 5);
    const altFactor = maxAltAglFt < 1500 ? 1.0 : maxAltAglFt < 2000 ? 0.8 : 0.5;
    const intervalFactor = avgTimeBetweenLandingsMs < 4 * 60 * 1000
      ? 1.0
      : avgTimeBetweenLandingsMs < 6 * 60 * 1000
        ? 0.8
        : 0.6;

    confidence = (landingFactor * 0.5) + (altFactor * 0.3) + (intervalFactor * 0.2);
    evidence.classification = 'Multiple touchdowns at low altitude with short intervals';
  } else if (landingCount === 1 && altitudeBelowPatternMax && totalFlightTimeMs < 30 * 60 * 1000) {
    flightType = FLIGHT_TYPE.LOCAL_FLIGHT;
    confidence = 0.7;
    evidence.classification = 'Single landing, low altitude, short duration';
  } else if (landingCount === 1 && maxAltAglFt > 3000) {
    flightType = FLIGHT_TYPE.CROSS_COUNTRY;
    confidence = 0.85;
    evidence.classification = 'Single landing after reaching cruise altitude';
  } else if (landingCount === 0) {
    flightType = FLIGHT_TYPE.UNKNOWN;
    confidence = 0;
    evidence.classification = 'No landings detected';
  } else {
    flightType = FLIGHT_TYPE.CROSS_COUNTRY;
    confidence = 0.6;
    evidence.classification = 'Default classification - does not match pattern work criteria';
  }

  return {
    flightType,
    confidence: Math.round(confidence * 100) / 100,
    landingCount,
    circuitCount: isPatternWork ? landingCount : 0,
    maxAltAglFt: Math.round(maxAltAglFt),
    totalFlightTimeMs,
    avgTimeBetweenLandingsMs: Math.round(avgTimeBetweenLandingsMs),
    isPatternWork,
    evidence,
  };
}

module.exports = {
  FLIGHT_TYPE,
  PATTERN_THRESHOLDS,
  classifyFlight,
  countTouchdowns,
  calculateAltitudeStats,
};

export {};
