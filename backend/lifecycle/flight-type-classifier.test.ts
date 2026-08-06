import type { PhaseMap, PhaseValue } from '../../shared/flight-phases';
import type { FlightTypeMap, FlightTypeValue } from './flight-types';

'use strict';

type FlightSample = {
  ts: number;
  wow: boolean;
  ra_ft: number | null;
  alt_msl_ft: number | null;
  vs_fpm: number;
  phase: PhaseValue;
};

type SampleOptions = Partial<Omit<FlightSample, 'ts'>>;

type Harness = {
  test: (name: string, fn: () => void) => void;
  assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
  assertTrue: (value: unknown, message?: string) => void;
  summary: (label: string) => void;
};

type FlightClassifierModule = {
  classifyFlight: (samples: FlightSample[]) => {
    flightType: FlightTypeValue;
    confidence: number;
    landingCount: number;
    circuitCount: number;
    maxAltAglFt: number;
    totalFlightTimeMs: number;
    avgTimeBetweenLandingsMs: number;
    isPatternWork: boolean;
    evidence: {
      hasAltitudeData?: boolean;
      altitudeSource?: 'radio' | 'msl-baseline' | 'unknown';
      patternSignals?: {
        altitudeBelowPatternMax: boolean;
        reasonableFlightTime: boolean;
      };
    };
  };
  countTouchdowns: (samples: FlightSample[]) => {
    count: number;
    timestamps: number[];
  };
  calculateAltitudeStats: (samples: FlightSample[]) => {
    maxAglFt: number;
    avgAglFt: number;
    hasAglData: boolean;
    altitudeSource: 'radio' | 'msl-baseline' | 'unknown';
    mslBaselineFt: number | null;
  };
  FLIGHT_TYPE: FlightTypeMap;
};

const { createHarness } = require('../../tests/support/mini-test-harness') as {
  createHarness: () => Harness;
};
const {
  classifyFlight,
  countTouchdowns,
  calculateAltitudeStats,
  FLIGHT_TYPE,
} = require('./flight-type-classifier') as FlightClassifierModule;
const { PHASES } = require('./phases') as { PHASES: PhaseMap };

const { test, assertEqual, assertTrue, summary } = createHarness();

function sample(ts: number, opts: SampleOptions = {}): FlightSample {
  return {
    ts,
    wow: opts.wow ?? false,
    ra_ft: opts.ra_ft === undefined ? 1000 : opts.ra_ft,
    alt_msl_ft: opts.alt_msl_ft === undefined ? 2000 : opts.alt_msl_ft,
    vs_fpm: opts.vs_fpm ?? 0,
    phase: opts.phase ?? PHASES.CRUISE,
  };
}

function generatePatternFlight(circuits = 5, patternAltFt = 1000): FlightSample[] {
  const samples: FlightSample[] = [];
  let ts = 0;

  for (let circuitIndex = 0; circuitIndex < circuits; circuitIndex++) {
    samples.push(sample(ts, { wow: true, ra_ft: 0, phase: PHASES.TAXI }));
    ts += 30000;
    samples.push(sample(ts, { wow: true, ra_ft: 0, phase: PHASES.TAKEOFF }));
    ts += 15000;
    samples.push(sample(ts, { wow: false, ra_ft: 50, vs_fpm: 800, phase: PHASES.TAKEOFF }));
    ts += 10000;

    samples.push(sample(ts, { wow: false, ra_ft: 300, vs_fpm: 600, phase: PHASES.CLIMB }));
    ts += 20000;
    samples.push(sample(ts, { wow: false, ra_ft: patternAltFt, vs_fpm: 0, phase: PHASES.CLIMB }));
    ts += 30000;

    samples.push(sample(ts, { wow: false, ra_ft: patternAltFt, vs_fpm: 0, phase: PHASES.DESCENT }));
    ts += 60000;

    samples.push(sample(ts, { wow: false, ra_ft: 600, vs_fpm: -500, phase: PHASES.APPROACH }));
    ts += 30000;
    samples.push(sample(ts, { wow: false, ra_ft: 200, vs_fpm: -400, phase: PHASES.APPROACH }));
    ts += 20000;
    samples.push(sample(ts, { wow: false, ra_ft: 50, vs_fpm: -300, phase: PHASES.APPROACH }));
    ts += 10000;

    samples.push(sample(ts, { wow: true, ra_ft: 0, vs_fpm: -200, phase: PHASES.LANDING }));
    ts += 5000;
  }

  samples.push(sample(ts, { wow: true, ra_ft: 0, phase: PHASES.TAXI_IN }));

  return samples;
}

function generateCrossCountryFlight(
  cruiseAltFt = 10000,
  flightTimeMs = 2 * 60 * 60 * 1000,
): FlightSample[] {
  const samples: FlightSample[] = [];
  let ts = 0;

  samples.push(sample(ts, { wow: true, ra_ft: 0, phase: PHASES.TAXI }));
  ts += 5 * 60 * 1000;
  samples.push(sample(ts, { wow: true, ra_ft: 0, phase: PHASES.TAKEOFF }));
  ts += 30000;
  samples.push(sample(ts, { wow: false, ra_ft: 100, vs_fpm: 1500, phase: PHASES.TAKEOFF }));
  ts += 30000;

  for (let alt = 1000; alt < cruiseAltFt; alt += 2000) {
    samples.push(sample(ts, { wow: false, ra_ft: alt, vs_fpm: 1200, phase: PHASES.CLIMB }));
    ts += 2 * 60 * 1000;
  }

  while (ts < flightTimeMs * 0.7) {
    samples.push(sample(ts, { wow: false, ra_ft: cruiseAltFt, vs_fpm: 0, phase: PHASES.CRUISE }));
    ts += 5 * 60 * 1000;
  }

  for (let alt = cruiseAltFt; alt > 3000; alt -= 2000) {
    samples.push(sample(ts, { wow: false, ra_ft: alt, vs_fpm: -1000, phase: PHASES.DESCENT }));
    ts += 2 * 60 * 1000;
  }

  samples.push(sample(ts, { wow: false, ra_ft: 2000, vs_fpm: -700, phase: PHASES.APPROACH }));
  ts += 60000;
  samples.push(sample(ts, { wow: false, ra_ft: 1000, vs_fpm: -500, phase: PHASES.APPROACH }));
  ts += 60000;
  samples.push(sample(ts, { wow: false, ra_ft: 200, vs_fpm: -400, phase: PHASES.APPROACH }));
  ts += 30000;

  samples.push(sample(ts, { wow: true, ra_ft: 0, vs_fpm: -200, phase: PHASES.LANDING }));
  ts += 60000;
  samples.push(sample(ts, { wow: true, ra_ft: 0, phase: PHASES.TAXI_IN }));

  return samples;
}

console.log('Flight Type Classifier Tests\n');

test('countTouchdowns detects single touchdown', () => {
  const samples = [
    sample(0, { wow: false }),
    sample(1000, { wow: true }),
  ];
  const result = countTouchdowns(samples);
  assertEqual(result.count, 1, 'Should detect 1 touchdown');
  assertEqual(result.timestamps[0], 1000, 'Touchdown should be at ts=1000');
});

test('countTouchdowns detects multiple touchdowns', () => {
  const samples = [
    sample(0, { wow: true }),
    sample(1000, { wow: false }),
    sample(2000, { wow: true }),
    sample(3000, { wow: false }),
    sample(4000, { wow: true }),
    sample(5000, { wow: false }),
    sample(6000, { wow: true }),
  ];
  const result = countTouchdowns(samples);
  assertEqual(result.count, 3, 'Should detect 3 touchdowns');
});

test('countTouchdowns handles no touchdowns', () => {
  const samples = [
    sample(0, { wow: false }),
    sample(1000, { wow: false }),
  ];
  const result = countTouchdowns(samples);
  assertEqual(result.count, 0, 'Should detect 0 touchdowns');
});

test('classifyFlight treats bounce contacts as one landing sequence', () => {
  const samples = [
    sample(0, { wow: false, ra_ft: 500, phase: PHASES.APPROACH }),
    sample(1000, { wow: true, ra_ft: 0, phase: PHASES.LANDING }),
    sample(2000, { wow: false, ra_ft: 8, phase: PHASES.LANDING }),
    sample(4000, { wow: true, ra_ft: 0, phase: PHASES.LANDING }),
    sample(5000, { wow: true, ra_ft: 0, phase: PHASES.TAXI_IN }),
  ];

  assertEqual(countTouchdowns(samples).count, 2, 'raw WOW transitions should remain available');
  const result = classifyFlight(samples);
  assertEqual(result.landingCount, 1, 'bounce contacts should collapse into one landing');
  assertEqual(result.circuitCount, 0, 'a bounce must not create another circuit');
  assertEqual(result.isPatternWork, false, 'a bounced landing must not become pattern work');
});

test('calculateAltitudeStats computes max and average', () => {
  const samples = [
    sample(0, { ra_ft: 100 }),
    sample(1000, { ra_ft: 500 }),
    sample(2000, { ra_ft: 1000 }),
    sample(3000, { ra_ft: 800 }),
    sample(4000, { ra_ft: 200 }),
  ];
  const result = calculateAltitudeStats(samples);
  assertEqual(result.maxAglFt, 1000, 'Max AGL should be 1000');
  assertEqual(result.avgAglFt, 520, 'Average AGL should be 520');
  assertEqual(result.hasAglData, true, 'RA samples should count as AGL data');
  assertEqual(result.altitudeSource, 'radio', 'RA samples should be the preferred altitude source');
});

test('calculateAltitudeStats falls back to MSL baseline when radio altitude is absent', () => {
  const samples = [
    sample(0, { wow: true, ra_ft: null, alt_msl_ft: 500 }),
    sample(1000, { wow: false, ra_ft: null, alt_msl_ft: 1200 }),
    sample(2000, { wow: false, ra_ft: null, alt_msl_ft: 1500 }),
    sample(3000, { wow: true, ra_ft: null, alt_msl_ft: 505 }),
  ];
  const result = calculateAltitudeStats(samples);
  assertEqual(result.maxAglFt, 1000, 'Max AGL should be derived from MSL minus ground baseline');
  assertEqual(result.hasAglData, true, 'MSL baseline should provide usable AGL data');
  assertEqual(result.altitudeSource, 'msl-baseline', 'MSL baseline should be recorded as the altitude source');
  assertEqual(result.mslBaselineFt, 500, 'Ground MSL baseline should use on-ground samples');
});

test('classifyFlight detects pattern work', () => {
  const samples = generatePatternFlight(5, 1000);
  const result = classifyFlight(samples);

  assertEqual(result.flightType, FLIGHT_TYPE.PATTERN_WORK, 'Should classify as PATTERN_WORK');
  assertEqual(result.isPatternWork, true, 'isPatternWork should be true');
  assertEqual(result.landingCount, 5, 'Should count 5 landings');
  assertEqual(result.circuitCount, 5, 'Should count 5 circuits');
  assertTrue(result.maxAltAglFt <= 1000, 'Max altitude should be <=1000ft');
  assertTrue(result.confidence >= 0.7, 'Confidence should be high');
});

test('classifyFlight detects cross-country flight', () => {
  const samples = generateCrossCountryFlight(10000);
  const result = classifyFlight(samples);

  assertEqual(result.flightType, FLIGHT_TYPE.CROSS_COUNTRY, 'Should classify as CROSS_COUNTRY');
  assertEqual(result.isPatternWork, false, 'isPatternWork should be false');
  assertEqual(result.landingCount, 1, 'Should count 1 landing');
  assertEqual(result.circuitCount, 0, 'Should count 0 circuits');
  assertTrue(result.maxAltAglFt >= 8000, 'Max altitude should be high');
});

test('classifyFlight treats two low-altitude landings as pattern work', () => {
  const samples = generatePatternFlight(2, 1000);
  const result = classifyFlight(samples);

  assertEqual(result.flightType, FLIGHT_TYPE.PATTERN_WORK, 'Should classify as PATTERN_WORK');
  assertEqual(result.landingCount, 2, 'Should count 2 landings');
});

test('classifyFlight uses MSL baseline when radio altitude is absent', () => {
  const samples = generatePatternFlight(3, 1000);
  for (const flightSample of samples) {
    const aglFt = flightSample.ra_ft || 0;
    flightSample.alt_msl_ft = 450 + aglFt;
    flightSample.ra_ft = null;
  }

  const result = classifyFlight(samples);
  assertEqual(result.flightType, FLIGHT_TYPE.PATTERN_WORK, 'No-RA pattern work should classify from MSL baseline');
  assertEqual(result.evidence.altitudeSource, 'msl-baseline', 'Classification should report MSL fallback');
  assertTrue(result.maxAltAglFt <= 1000, 'MSL-derived max altitude should preserve the pattern altitude');
});

test('classifyFlight does not treat absent altitude as low altitude', () => {
  const samples = generatePatternFlight(3, 1000);
  for (const flightSample of samples) {
    flightSample.ra_ft = null;
    flightSample.alt_msl_ft = null;
  }

  const result = classifyFlight(samples);
  assertEqual(result.isPatternWork, false, 'Missing altitude data should not pass the pattern altitude gate');
  assertEqual(result.evidence.hasAltitudeData, false, 'Classification should record missing altitude data');
  assertEqual(result.evidence.altitudeSource, 'unknown', 'Classification should report unknown altitude source');
  assertEqual(
    result.evidence.patternSignals?.altitudeBelowPatternMax,
    false,
    'Missing altitude should not be interpreted as below pattern altitude',
  );
});

test('classifyFlight long-duration guard blocks pattern-work classification', () => {
  const samples = generatePatternFlight(5, 1000);
  for (let index = 0; index < samples.length; index++) {
    samples[index].ts = index * 6 * 60 * 1000;
  }

  const result = classifyFlight(samples);
  if (result.flightType === FLIGHT_TYPE.PATTERN_WORK) {
    throw new Error('Long sessions should not classify as PATTERN_WORK');
  }
  assertEqual(
    result.evidence.patternSignals?.reasonableFlightTime,
    false,
    'reasonableFlightTime signal should be false',
  );
});

test('classifyFlight handles empty samples', () => {
  const result = classifyFlight([]);
  assertEqual(result.flightType, FLIGHT_TYPE.UNKNOWN, 'Should return UNKNOWN');
  assertEqual(result.confidence, 0, 'Confidence should be 0');
});

summary('flight-type-classifier tests');

export {};
