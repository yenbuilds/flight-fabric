'use strict';

const test = require('node:test') as typeof import('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  analyzeRollout,
  inferCoordinatePrecisionDigits,
} = require('./rollout-analysis.js') as {
  analyzeRollout: (samples: Record<string, any>[], context?: Record<string, any>) => Record<string, any> | null;
  inferCoordinatePrecisionDigits: (samples: Record<string, any>[]) => number | null;
};

function sample(
  timestampMs: number,
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    timestampMs,
    onGround: true,
    gsKts: 120,
    bankDeg: 0,
    headingTrueDeg: 360,
    lat: -35.31,
    lon: 149.1944,
    ...overrides,
  };
}

test('rollout analysis flags bank, bank-rate, and heading-control events separately from approach stability', () => {
  const result = analyzeRollout([
    sample(1_000, { bankDeg: -0.3, headingTrueDeg: 353.5, gsKts: 136 }),
    sample(1_500, {
      bankDeg: 0.8,
      rollRateDegS: 5.2,
      headingTrueDeg: 353.5,
      gsKts: 134,
    }),
    sample(2_000, {
      bankDeg: 3.3,
      rollRateDegS: 5.4,
      headingTrueDeg: 351.1,
      gsKts: 131,
      lon: 149.1943,
    }),
    sample(2_500, { bankDeg: 2.0, headingTrueDeg: 14.6, gsKts: 111, lon: 149.1943 }),
    sample(3_000, { bankDeg: 0.2, headingTrueDeg: 8.9, gsKts: 100, lon: 149.1944 }),
  ], {
    runwayGeometrySource: 'msfs-facilities',
    runwayHeadingTrueDeg: 360,
    runwayThreshold: { lat: -35.3148, lon: 149.1944 },
    runwayWidthFt: 150,
    coordinatePrecisionDigits: 4,
    source: 'test',
  });

  assert(result);
  assert.equal(result.assessment, 'caution');
  assert.equal(result.maxBankDeg, 3.3);
  assert.equal(result.maxHeadingDeviationDeg, 14.6);
  assert.equal(result.maxHeadingDeviationSide, 'right');
  assert(result.maxBankRateDegS >= 4);
  assert.equal(result.bankRateSource, 'recorded-roll-rate');
  assert.deepEqual(
    result.flags.map((flag: Record<string, any>) => flag.code),
    ['rollout_bank', 'rapid_bank_change', 'heading_deviation'],
  );
  assert.equal(result.lateralDataQuality, 'low');
  assert(result.lateralUncertaintyFt >= 18);
});

test('rollout analysis detects a conservative runway-edge risk with precise coordinates', () => {
  const result = analyzeRollout([
    sample(1_000, { lat: 0, lon: 0, gsKts: 90 }),
    sample(2_000, { lat: 0.0002, lon: 0.00019, gsKts: 80 }),
    sample(3_000, { lat: 0.0004, lon: 0.0002, gsKts: 70 }),
  ], {
    runwayGeometrySource: 'msfs-facilities',
    runwayHeadingTrueDeg: 360,
    runwayThreshold: { lat: 0, lon: 0 },
    runwayWidthFt: 150,
    coordinatePrecisionDigits: 6,
  });

  assert(result);
  assert.equal(result.lateralDataQuality, 'high');
  assert(result.maxLateralOffsetFt > 68);
  assert(result.conservativeRunwayEdgeMarginFt < 7);
  assert(result.flags.some((flag: Record<string, any>) => flag.code === 'runway_edge_margin'));
  assert.equal(result.assessment, 'warning');
});

test('rollout analysis stops before the first sample at the aircraft taxi-in speed', () => {
  const result = analyzeRollout([
    sample(1_000, { gsKts: 132, bankDeg: 0.2, headingTrueDeg: 360, lon: 0 }),
    sample(2_000, { gsKts: 90, bankDeg: 0.3, headingTrueDeg: 360, lon: 0 }),
    sample(3_000, { gsKts: 60.1, bankDeg: 0.2, headingTrueDeg: 359, lon: 0.00001 }),
    sample(4_000, {
      phase: 'TAXI-IN',
      gsKts: 60,
      bankDeg: 8,
      headingTrueDeg: 330,
      lon: 0.0003,
    }),
    sample(5_000, {
      phase: 'TAXI-IN',
      gsKts: 45,
      bankDeg: 12,
      headingTrueDeg: 300,
      lon: 0.0005,
    }),
  ], {
    taxiInMaxKts: 60,
    runwayGeometrySource: 'msfs-facilities',
    runwayHeadingTrueDeg: 360,
    runwayThreshold: { lat: 0, lon: 0 },
    runwayWidthFt: 150,
    coordinatePrecisionDigits: 6,
  });

  assert(result);
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.endGsKts, 60.1);
  assert.equal(result.maxBankDeg, 0.3);
  assert.equal(result.maxHeadingDeviationDeg, 1);
  assert.equal(result.assessment, 'normal');
  assert.equal(result.taxiInMaxKts, 60);
});

test('rollout analysis uses confirmed taxi-in only when groundspeed is unavailable', () => {
  const result = analyzeRollout([
    sample(1_000, { gsKts: 120 }),
    sample(2_000, { gsKts: 100 }),
    sample(3_000, {
      phase: 'TAXI_IN',
      gsKts: null,
      bankDeg: 10,
      headingTrueDeg: 330,
    }),
    sample(4_000, { gsKts: 90, bankDeg: 12, headingTrueDeg: 300 }),
  ], {
    taxiInMaxKts: 60,
    runwayGeometrySource: 'msfs-facilities',
    runwayHeadingTrueDeg: 360,
  });

  assert(result);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.endGsKts, 100);
  assert.equal(result.maxBankDeg, 0);
  assert.equal(result.assessment, 'normal');
});

test('bank-rate analysis ignores a one-frame spike and retains sustained recorded motion', () => {
  const isolatedSpike = analyzeRollout([
    sample(1_000, { rollRateDegS: 0.5 }),
    sample(1_200, { rollRateDegS: 10 }),
    sample(1_400, { rollRateDegS: 0.5 }),
  ], { runwayHeadingTrueDeg: 360 });
  assert(isolatedSpike);
  assert.equal(isolatedSpike.maxBankRateDegS, 0.5);
  assert(!isolatedSpike.flags.some((flag: Record<string, any>) => flag.code === 'rapid_bank_change'));

  const sustainedRate = analyzeRollout([
    sample(1_000, { bankDeg: 0, rollRateDegS: 0.5 }),
    sample(1_200, { bankDeg: 1.7, rollRateDegS: 8.5 }),
    sample(1_400, { bankDeg: 3.5, rollRateDegS: 9 }),
  ], { runwayHeadingTrueDeg: 360 });
  assert(sustainedRate);
  assert.equal(sustainedRate.maxBankRateDegS, 8.5);
  assert(sustainedRate.flags.some((flag: Record<string, any>) => (
    flag.code === 'rapid_bank_change' && flag.severity === 'warning'
  )));
});

test('bank-rate flags require a noticeable bank amplitude', () => {
  // YSCB RWY 35, 737-800, 2026-09-17: nosewheel touchdown with a 6 kt left
  // crosswind rocked the aircraft +2.2 -> -1.4 deg with no roll input. The
  // recorded roll rate briefly reached 5.3 deg/s, but a sub-3 deg wobble is
  // gear settling, not an abrupt correction.
  const gearBump = analyzeRollout([
    sample(1_000, { gsKts: 131.7, bankDeg: 2.2, rollRateDegS: -0.3 }),
    sample(1_250, { gsKts: 130.4, bankDeg: 1.3, rollRateDegS: -0.5 }),
    sample(1_500, { gsKts: 129.5, bankDeg: 0.6, rollRateDegS: 3.3 }),
    sample(1_650, { gsKts: 129.2, bankDeg: 0.1, rollRateDegS: 5.3 }),
    sample(1_750, { gsKts: 129.0, bankDeg: -0.3, rollRateDegS: 5.4 }),
    sample(2_000, { gsKts: 128.0, bankDeg: -1.4, rollRateDegS: 2.6 }),
    sample(2_250, { gsKts: 127.4, bankDeg: -1.4, rollRateDegS: -0.3 }),
  ], { runwayHeadingTrueDeg: 360 });
  assert(gearBump);
  assert.equal(gearBump.maxBankDeg, 2.2);
  assert.equal(gearBump.maxBankRateDegS, 5.3);
  assert.equal(gearBump.assessment, 'normal');
  assert(!gearBump.flags.some((flag: Record<string, any>) => flag.code === 'rapid_bank_change'));

  // Same rate trace, but the roll actually develops into a 3+ deg bank.
  const realCorrection = analyzeRollout([
    sample(1_000, { gsKts: 131.7, bankDeg: 0.4, rollRateDegS: -0.3 }),
    sample(1_250, { gsKts: 130.4, bankDeg: 0.2, rollRateDegS: -0.5 }),
    sample(1_500, { gsKts: 129.5, bankDeg: -0.6, rollRateDegS: 3.3 }),
    sample(1_650, { gsKts: 129.2, bankDeg: -1.4, rollRateDegS: 5.3 }),
    sample(1_750, { gsKts: 129.0, bankDeg: -1.9, rollRateDegS: 5.4 }),
    sample(2_000, { gsKts: 128.0, bankDeg: -3.2, rollRateDegS: 2.6 }),
    sample(2_250, { gsKts: 127.4, bankDeg: -3.2, rollRateDegS: -0.3 }),
  ], { runwayHeadingTrueDeg: 360 });
  assert(realCorrection);
  assert.equal(realCorrection.maxBankDeg, 3.2);
  assert.equal(realCorrection.assessment, 'caution');
  assert.deepEqual(
    realCorrection.flags.map((flag: Record<string, any>) => flag.code).sort(),
    ['rapid_bank_change', 'rollout_bank'],
  );
});

test('runway-edge contact is critical only when corroborated by an excursion', () => {
  const samples = [
    sample(1_000, { lat: 0, lon: 0, gsKts: 90 }),
    sample(2_000, { lat: 0.0002, lon: 0.0003, gsKts: 80 }),
  ];
  const context = {
    runwayGeometrySource: 'msfs-facilities',
    runwayHeadingTrueDeg: 360,
    runwayThreshold: { lat: 0, lon: 0 },
    runwayWidthFt: 150,
    coordinatePrecisionDigits: 7,
  };
  const normalVacate = analyzeRollout(samples, context);
  assert(normalVacate);
  assert.equal(
    normalVacate.flags.find((flag: Record<string, any>) => flag.code === 'runway_edge_margin')?.severity,
    'warning',
  );
  assert.equal(normalVacate.assessment, 'warning');

  const excursion = analyzeRollout(samples, { ...context, runwayExcursion: true });
  assert(excursion);
  assert.equal(excursion.assessment, 'critical');
  assert(excursion.flags.some((flag: Record<string, any>) => flag.code === 'runway_excursion'));
  assert.equal(
    excursion.flags.find((flag: Record<string, any>) => flag.code === 'runway_edge_margin')?.severity,
    'critical',
  );
});

test('rollout analysis excludes airborne, paused, and low-speed taxi samples', () => {
  const result = analyzeRollout([
    sample(1_000),
    sample(2_000, { onGround: false, bankDeg: 20 }),
    sample(3_000, { paused: true, bankDeg: 20 }),
    sample(4_000, { bankDeg: 1, gsKts: 80 }),
    sample(5_000, { gsKts: 20, bankDeg: 20 }),
    sample(6_000, { bankDeg: 20, gsKts: 70 }),
  ], {
    runwayGeometrySource: 'msfs-facilities',
    runwayHeadingTrueDeg: 360,
  });

  assert(result);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.maxBankDeg, 1);
  assert.equal(result.assessment, 'normal');
});

test('coordinate precision inference distinguishes legacy and precise recordings', () => {
  assert.equal(inferCoordinatePrecisionDigits([
    { lat_deg: -35.3099, lon_deg: 149.1944 },
    { lat_deg: -35.3098, lon_deg: 149.1943 },
  ]), 4);
  assert.equal(inferCoordinatePrecisionDigits([
    { lat_deg: -35.309912, lon_deg: 149.194411 },
    { lat_deg: -35.309801, lon_deg: 149.194302 },
  ]), 6);
});

test('rollout window starts at the first eligible ground-roll sample and remains bounded', () => {
  const samples = [
    sample(-120_000, { onGround: false }),
    ...Array.from({ length: 2_050 }, (_, index) => sample(
      1_000 + (index * 20),
      { gsKts: 120 - (index * 0.01) },
    )),
  ];
  const result = analyzeRollout(samples, { runwayHeadingTrueDeg: 360 });

  assert(result);
  assert.equal(result.sampleCount, 2_000);
  assert.equal(result.durationMs, 39_980);
});
