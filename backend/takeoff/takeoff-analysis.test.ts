'use strict';

const test = require('node:test') as typeof import('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  analyzeTakeoffRoll,
  resolveScreenHeightFt,
  scoreTakeoffRunwayUse,
  RUNWAY_USE_BANDS,
} = require('./takeoff-analysis.js') as {
  analyzeTakeoffRoll: (
    samples: Record<string, any>[],
    liftoff: Record<string, any>,
    screen: Record<string, any> | null,
    context?: Record<string, any>,
  ) => Record<string, any> | null;
  resolveScreenHeightFt: (lightAircraft: boolean) => { heightFt: number; basis: string };
  scoreTakeoffRunwayUse: (input: Record<string, any>) => Record<string, any>;
  RUNWAY_USE_BANDS: Record<string, { score: number; grade: string; zone: string }>;
};

const FT_PER_DEG_LAT = 364567;
const ORIGIN = { lat: -35.3, lon: 149.19 };

// Runway 36: heading 360 true, so along-track feet map straight onto latitude.
function pointAlong(alongFt: number, crossFt = 0): { lat: number; lon: number } {
  const cosLat = Math.cos(ORIGIN.lat * Math.PI / 180);
  return {
    lat: ORIGIN.lat + alongFt / FT_PER_DEG_LAT,
    lon: ORIGIN.lon + crossFt / (FT_PER_DEG_LAT * cosLat),
  };
}

function runway(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    icao: 'YSCB',
    runway: '35',
    source: 'msfs-facilities',
    heading_true_deg: 360,
    headingTrueDeg: 360,
    lengthFt: 8000,
    physicalLengthFt: 8000,
    widthFt: 150,
    threshold: pointAlong(0),
    physicalThreshold: pointAlong(0),
    displacedThresholdFt: 0,
    ...overrides,
  };
}

function buildRoll(options: {
  standstillS?: number;
  rollS?: number;
  liftoffAlongFt?: number;
  startAlongFt?: number;
  rollingStartGs?: number | null;
  crossFt?: number;
} = {}): { samples: Record<string, any>[]; liftoff: Record<string, any> } {
  const standstillS = options.standstillS ?? 2;
  const rollS = options.rollS ?? 30;
  const startAlongFt = options.startAlongFt ?? 200;
  const liftoffAlongFt = options.liftoffAlongFt ?? 4500;
  const crossFt = options.crossFt ?? 0;
  const samples: Record<string, any>[] = [];
  const t0 = 1_700_000_000_000;
  const liftoffTs = t0 + (standstillS + rollS) * 1000;
  for (let t = 0; t <= standstillS + rollS; t += 0.5) {
    const rolling = t > standstillS;
    const fraction = rolling ? (t - standstillS) / rollS : 0;
    const gs = options.rollingStartGs != null
      ? options.rollingStartGs + (140 - options.rollingStartGs) * fraction
      : (rolling ? 140 * fraction : 0);
    const along = startAlongFt + (liftoffAlongFt - startAlongFt) * fraction * fraction;
    const rotationT = standstillS + rollS - 3.5;
    const pitch = t < rotationT ? 0 : (t - rotationT) * 2.5;
    samples.push({
      timestampMs: t0 + t * 1000,
      onGround: true,
      onRunway: true,
      runwayLike: true,
      gsKts: gs,
      iasKts: gs,
      headingTrueDeg: 360,
      pitchDeg: pitch,
      bankDeg: 0,
      ...pointAlong(along, crossFt),
    });
  }
  const liftoff = {
    timestampMs: liftoffTs,
    ...pointAlong(liftoffAlongFt, crossFt),
    iasKts: 145,
    gsKts: 140,
    pitchDeg: 8.75,
    headingTrueDeg: 360,
  };
  return { samples, liftoff };
}

test('runway-use bands anchor on runway remaining with absolute floors', () => {
  assert.equal(scoreTakeoffRunwayUse({ liftoffDistanceFt: 5000, runwayLengthFt: 10000 }).grade, 'Outstanding');
  assert.equal(scoreTakeoffRunwayUse({ liftoffDistanceFt: 9000, runwayLengthFt: 12000 }).grade, 'Outstanding', '3,000 ft left is ample on any runway');
  assert.equal(scoreTakeoffRunwayUse({ liftoffDistanceFt: 4300, runwayLengthFt: 6000 }).grade, 'Good');
  assert.equal(scoreTakeoffRunwayUse({ liftoffDistanceFt: 5100, runwayLengthFt: 6000 }).grade, 'Acceptable');
  const late = scoreTakeoffRunwayUse({ liftoffDistanceFt: 2800, runwayLengthFt: 3000 });
  assert.equal(late.grade, 'Late Liftoff');
  assert.equal(late.remainingFt, 200);
  assert.equal(late.usedPct, 93.3);
});

test('the runway end and the screen height are the operational lines', () => {
  const overrun = scoreTakeoffRunwayUse({ liftoffDistanceFt: 3100, runwayLengthFt: 3000 });
  assert.equal(overrun.grade, RUNWAY_USE_BANDS.OVERRUN.grade);
  assert.equal(overrun.score, 0);
  assert.equal(overrun.liftoffBeyondEnd, true);
  assert.equal(overrun.remainingFt, -100);

  const screenPastEnd = scoreTakeoffRunwayUse({ liftoffDistanceFt: 2700, screenHeightDistanceFt: 3200, runwayLengthFt: 3000 });
  assert.equal(screenPastEnd.grade, 'Dangerous');
  assert.equal(screenPastEnd.screenBeyondEnd, true);
  assert.equal(screenPastEnd.screenRemainingFt, -200);

  const unknown = scoreTakeoffRunwayUse({ liftoffDistanceFt: null, runwayLengthFt: 3000 });
  assert.equal(unknown.grade, 'Unknown');
  assert.equal(unknown.score, null);
});

test('screen height follows the aircraft category', () => {
  assert.deepEqual(resolveScreenHeightFt(false), { heightFt: 35, basis: 'transport_35ft' });
  assert.deepEqual(resolveScreenHeightFt(true), { heightFt: 50, basis: 'light_aircraft_50ft' });
});

test('a standing-start roll is measured from the last standstill to liftoff', () => {
  const { samples, liftoff } = buildRoll();
  const screen = { timestampMs: liftoff.timestampMs + 4000, ...pointAlong(6000), aglFt: 36 };
  const result = analyzeTakeoffRoll(samples, liftoff, screen, {
    runwayData: runway(),
    screenHeightFt: 35,
    screenHeightBasis: 'transport_35ft',
    climb: { maxPitchDeg: 12.4 },
    source: 'test',
  });

  assert(result);
  assert.equal(result.rollStart.source, 'standstill');
  assert.equal(result.rollDistanceSource, 'runway_projection');
  // The fixture and the projection use slightly different feet-per-degree
  // constants; a quarter of a percent is well inside runway-scale accuracy.
  assert.ok(Math.abs(result.rollDistanceFt - 4300) <= 15, `roll distance ${result.rollDistanceFt}`);
  assert.ok(Math.abs(result.liftoff.distanceFt - 4500) <= 15, `liftoff distance ${result.liftoff.distanceFt}`);
  assert.ok(Math.abs(result.liftoff.remainingFt - 3500) <= 15, `remaining ${result.liftoff.remainingFt}`);
  assert.equal(result.runwayUse.grade, 'Outstanding');
  // The last sample under the 8 kt standstill threshold is 1.5 s into the roll.
  assert.equal(result.rollDurationS, 28.5);
  assert.equal(result.screenHeight.reached, true);
  assert.ok(Math.abs(result.screenHeight.remainingFt - 2000) <= 15);
  assert.equal(result.screenHeight.elapsedS, 4);
  assert.equal(result.rotation.rateDegS, 2.5);
  assert.equal(result.rotation.maxPitchDeg, 12.4);
  assert.equal(result.lateral.verified, true);
  assert.equal(result.lateral.grade, 'Perfect');
  assert.equal(result.heading.liftoffDeviationDeg, 0);
  assert.equal(result.assessment, 'normal');
  assert.deepEqual(result.flags, []);
  assert.equal(result.runway.originKind, 'physical_threshold');
});

test('a rolling start is measured from runway alignment and reduces confidence honestly', () => {
  const { samples, liftoff } = buildRoll({ standstillS: 0, rollingStartGs: 15 });
  const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert(result);
  assert.equal(result.rollStart.source, 'runway_aligned');
  assert.equal(result.screenHeight.reached, false);
  assert.equal(result.screenHeight.remainingFt, null);
  assert.equal(result.runwayUse.grade, 'Outstanding');
});

test('late liftoff, settle-backs and excursions become separate flags', () => {
  const { samples, liftoff } = buildRoll({ liftoffAlongFt: 7600 });
  const screen = { timestampMs: liftoff.timestampMs + 5000, ...pointAlong(8300), aglFt: 35 };
  const result = analyzeTakeoffRoll(samples, liftoff, screen, {
    runwayData: runway(),
    runwayExcursion: true,
    hopCount: 1,
  });
  assert(result);
  assert.equal(result.runwayUse.grade, 'Dangerous', 'screen height past the end outranks the late-liftoff band');
  const codes = result.flags.map((flag: { code: string }) => flag.code);
  assert.deepEqual(codes, ['runway_excursion', 'screen_height_beyond_runway_end', 'settled_after_liftoff']);
  assert.equal(result.assessment, 'critical');

  const late = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert(late);
  assert.equal(late.runwayUse.grade, 'Late Liftoff');
  assert.deepEqual(late.flags.map((flag: { code: string }) => flag.code), ['late_liftoff']);
  assert.equal(late.assessment, 'caution');
});

test('liftoff beyond the runway end is an overrun', () => {
  const { samples, liftoff } = buildRoll({ liftoffAlongFt: 8150 });
  const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert(result);
  assert.equal(result.runwayUse.grade, 'Overrun');
  assert.equal(result.liftoff.beyondRunwayEnd, true);
  assert.equal(result.flags[0].code, 'liftoff_beyond_runway_end');
  assert.equal(result.assessment, 'critical');
});

test('without runway geometry the roll is still measured and the grade stays unknown', () => {
  const { samples, liftoff } = buildRoll();
  const result = analyzeTakeoffRoll(samples, liftoff, null, {});
  assert(result);
  assert.equal(result.rollDistanceSource, 'position_delta');
  assert.ok(Math.abs(result.rollDistanceFt - 4300) <= 15, `roll distance ${result.rollDistanceFt}`);
  assert.equal(result.runwayUse.grade, 'Unknown');
  assert.equal(result.runwayUse.score, null);
  assert.equal(result.liftoff.remainingFt, null);
  assert.equal(result.lateral.verified, false);
  assert.equal(result.lateral.notScoredReason, 'runway_geometry_unavailable');
  assert.equal(result.runway, null);
});

test('OurAirports geometry measures distance but does not verify lateral placement', () => {
  const { samples, liftoff } = buildRoll({ crossFt: 40 });
  const result = analyzeTakeoffRoll(samples, liftoff, null, {
    runwayData: runway({ source: 'ourairports' }),
  });
  assert(result);
  assert.equal(result.runwayUse.grade, 'Outstanding');
  assert.equal(result.lateral.liftoffOffsetFt, 40);
  assert.equal(result.lateral.liftoffOffsetSide, 'right');
  assert.equal(result.lateral.verified, false);
  assert.equal(result.lateral.grade, 'Unverified');
  assert.equal(result.lateral.notScoredReason, 'runway_geometry_unverified');
});

test('rapid rotation is a caution for transport aircraft only', () => {
  const { samples, liftoff } = buildRoll();
  const fastLiftoff = { ...liftoff, pitchDeg: 20 };
  const transport = analyzeTakeoffRoll(samples, fastLiftoff, null, { runwayData: runway() });
  assert(transport);
  assert.ok(transport.rotation.rateDegS > 5);
  assert.ok(transport.flags.some((flag: { code: string }) => flag.code === 'rapid_rotation'));

  const light = analyzeTakeoffRoll(samples, fastLiftoff, null, { runwayData: runway(), lightAircraft: true });
  assert(light);
  assert.ok(!light.flags.some((flag: { code: string }) => flag.code === 'rapid_rotation'));
});
