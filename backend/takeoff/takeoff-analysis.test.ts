'use strict';

const test = require('node:test') as typeof import('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  analyzeTakeoffRoll,
  findTakeoffRollStart,
  resolveScreenHeightFt,
  scoreTakeoffRunwayUse,
} = require('./takeoff-analysis.js') as {
  analyzeTakeoffRoll: (
    samples: Record<string, any>[],
    liftoff: Record<string, any>,
    screen: Record<string, any> | null,
    context?: Record<string, any>,
  ) => Record<string, any> | null;
  resolveScreenHeightFt: (lightAircraft: boolean) => { heightFt: number; basis: string };
  scoreTakeoffRunwayUse: (input: Record<string, any>) => Record<string, any>;
  findTakeoffRollStart: (samples: Record<string, any>[], timestampMs: number, heading: number) => Record<string, any> | null;
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

test('runway remaining is measured without rewarding earlier liftoff', () => {
  for (const liftoffDistanceFt of [1000, 4300, 5100, 5800]) {
    const result = scoreTakeoffRunwayUse({ liftoffDistanceFt, runwayLengthFt: 6000 });
    assert.equal(result.grade, 'Recorded');
    assert.equal(result.score, null);
    assert.equal(result.remainingFt, 6000 - liftoffDistanceFt);
  }
  const late = scoreTakeoffRunwayUse({ liftoffDistanceFt: 2800, runwayLengthFt: 3000 });
  assert.equal(late.grade, 'Recorded');
  assert.equal(late.remainingFt, 200);
  assert.equal(late.usedPct, 93.3);
});

test('screen-height position is context while verified liftoff beyond the end is an overrun', () => {
  const overrun = scoreTakeoffRunwayUse({ liftoffDistanceFt: 3100, confirmedGroundDistanceFt: 3050, runwayLengthFt: 3000 });
  assert.equal(overrun.grade, 'Overrun');
  assert.equal(overrun.score, null);
  assert.equal(overrun.liftoffBeyondEnd, true);
  assert.equal(overrun.remainingFt, -100);

  const screenPastEnd = scoreTakeoffRunwayUse({ liftoffDistanceFt: 2700, screenHeightDistanceFt: 3200, runwayLengthFt: 3000 });
  assert.equal(screenPastEnd.grade, 'Recorded');
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

test('display rounding cannot turn an inside-runway liftoff into an overrun', () => {
  for (const distance of [5999.6, 6000]) {
    const result = scoreTakeoffRunwayUse({ liftoffDistanceFt: distance, runwayLengthFt: 6000 });
    assert.equal(result.liftoffBeyondEnd, false);
    assert.equal(result.grade, 'Recorded');
    assert.equal(result.remainingFt, 0);
  }
  const beyond = scoreTakeoffRunwayUse({ liftoffDistanceFt: 6000.1, runwayLengthFt: 6000 });
  assert.equal(beyond.liftoffBeyondEnd, false);
  assert.equal(beyond.grade, 'Unknown');
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
  assert.equal(result.runwayUse.grade, 'Recorded');
  // The last sample under the 8 kt standstill threshold is 1.5 s into the roll.
  assert.equal(result.rollDurationS, 28.5);
  assert.equal(result.screenHeight.reached, true);
  assert.ok(Math.abs(result.screenHeight.remainingFt - 2000) <= 15);
  assert.equal(result.screenHeight.elapsedS, 4);
  assert.equal(result.rotation.rateDegS, 2.5);
  assert.equal(result.rotation.maxPitchDeg, 12.4);
  assert.equal(result.lateral.verified, true);
  assert.equal(result.lateral.grade, 'Recorded');
  assert.equal(result.lateral.score, null);
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
  assert.equal(result.runwayUse.grade, 'Recorded');
});

test('a late heading excursion retains the high-speed roll but excludes the taxi turn', () => {
  const samples = [
    [0, 15, 90], [1000, 15, 90], [2000, 20, 0], [3000, 35, 0],
    [4000, 60, 0], [5000, 100, 40], [6000, 140, 40],
  ].map(([timestampMs, gsKts, headingTrueDeg]) => ({ timestampMs, gsKts, headingTrueDeg, onGround: true }));
  const start = findTakeoffRollStart(samples, 6100, 40);
  assert.equal(start?.timestampMs, 2000);
  assert.equal(start?.source, 'runway_aligned');
});

test('settle-backs and excursions remain warnings without a runway-remaining target', () => {
  const { samples, liftoff } = buildRoll({ liftoffAlongFt: 7600 });
  const screen = { timestampMs: liftoff.timestampMs + 5000, ...pointAlong(8300), aglFt: 35 };
  const result = analyzeTakeoffRoll(samples, liftoff, screen, {
    runwayData: runway(),
    runwayExcursion: true,
    hopCount: 1,
  });
  assert(result);
  assert.equal(result.runwayUse.grade, 'Recorded');
  const codes = result.flags.map((flag: { code: string }) => flag.code);
  assert.deepEqual(codes, ['runway_excursion', 'settled_after_liftoff']);
  assert.equal(result.assessment, 'critical');

  const late = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert(late);
  assert.equal(late.runwayUse.grade, 'Recorded');
  assert.deepEqual(late.flags.map((flag: { code: string }) => flag.code), ['climb_incomplete']);
  assert.equal(late.assessment, 'caution');
});

test('liftoff beyond the runway end is an overrun', () => {
  const { samples, liftoff } = buildRoll({ liftoffAlongFt: 8400 });
  for (const sample of samples) {
    if (sample.lat > pointAlong(8000).lat) { sample.onRunway = false; sample.runwayLike = false; }
  }
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

test('OurAirports geometry measures distance but cannot grade runway use or placement', () => {
  const { samples, liftoff } = buildRoll({ crossFt: 40 });
  const result = analyzeTakeoffRoll(samples, liftoff, null, {
    runwayData: runway({ source: 'ourairports' }),
  });
  assert(result);
  assert.equal(result.runwayUse.grade, 'Unknown');
  assert.equal(result.lateral.liftoffOffsetFt, 40);
  assert.equal(result.lateral.liftoffOffsetSide, 'right');
  assert.equal(result.lateral.verified, false);
  assert.equal(result.lateral.grade, 'Unverified');
  assert.equal(result.lateral.notScoredReason, 'runway_geometry_unverified');
});

test('unverified or conflicting runway lengths cannot establish an overrun', () => {
  const { samples, liftoff } = buildRoll();
  for (const geometry of [
    runway({ source: 'ourairports', lengthFt: 2000, physicalLengthFt: 2000 }),
    runway({ lengthFt: 2000, physicalLengthFt: 2000 }),
    runway({ physicalThreshold: null, physicalLengthFt: null }),
  ]) {
    const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: geometry });
    assert(result);
    assert.equal(result.runwayUse.grade, 'Unknown');
    assert.equal(result.runwayUse.score, null);
    assert.equal(result.liftoff.beyondRunwayEnd, false);
    assert.ok(!result.flags.some((flag: { code: string }) => flag.code === 'liftoff_beyond_runway_end'));
    assert.equal(typeof result.liftoff.remainingFt, 'number', 'approximate measurements remain available');
  }
});

test('rotation remains a measured rate without a generic aircraft limit', () => {
  const { samples, liftoff } = buildRoll();
  const fastLiftoff = { ...liftoff, pitchDeg: 20 };
  const transport = analyzeTakeoffRoll(samples, fastLiftoff, null, { runwayData: runway() });
  assert(transport);
  assert.ok(transport.rotation.rateDegS > 5);
  assert.ok(!transport.flags.some((flag: { code: string }) => flag.code === 'rapid_rotation'));

  const light = analyzeTakeoffRoll(samples, fastLiftoff, null, { runwayData: runway(), lightAircraft: true });
  assert(light);
  assert.ok(!light.flags.some((flag: { code: string }) => flag.code === 'rapid_rotation'));
});

test('a prior liftoff rotation remains measured without replacing the final rotation rate', () => {
  const { samples, liftoff } = buildRoll();
  const baseline = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert(baseline);
  const result = analyzeTakeoffRoll(samples, liftoff, null, {
    runwayData: runway(), priorRotationMaxRateDegS: 12, climb: { maxPitchDeg: 18 },
  });
  assert(result);
  assert.equal(result.rotation.rateDegS, baseline.rotation.rateDegS);
  assert.equal(result.rotation.maxRateDegS, 12);
  assert.equal(result.rotation.maxPitchDeg, 18);
  assert.ok(!result.flags.some((flag: { code: string }) => flag.code === 'rapid_rotation'));
  const light = analyzeTakeoffRoll(samples, liftoff, null, {
    runwayData: runway(), priorRotationMaxRateDegS: 12, lightAircraft: true,
  });
  assert(light);
  assert.ok(!light.flags.some((flag: { code: string }) => flag.code === 'rapid_rotation'));
});

test('runway-end sampling ambiguity never becomes a definitive overrun', () => {
  const { samples, liftoff } = buildRoll({ liftoffAlongFt: 5970 });
  const airborne = { ...liftoff, timestampMs: liftoff.timestampMs + 400, ...pointAlong(6060) };
  const result = analyzeTakeoffRoll(samples, airborne, null, { runwayData: runway({ lengthFt: 6000, physicalLengthFt: 6000 }) });
  assert(result);
  assert.equal(result.runwayUse.grade, 'Unknown');
  assert.equal(result.runwayUse.notScoredReason, 'liftoff_position_uncertain');
  assert.equal(result.liftoff.remainingFt, null);
  assert.equal(result.liftoff.distanceFt, null);
  assert.equal(result.liftoff.beyondRunwayEnd, false);
  assert.ok(result.flags.some((flag: { code: string }) => flag.code === 'liftoff_position_uncertain'));
  assert.ok(!result.flags.some((flag: { severity: string }) => flag.severity === 'critical'));
});

test('one ground-position spike or missing surface evidence cannot confirm an overrun', () => {
  for (const missingSurface of [false, true]) {
    const { samples, liftoff } = buildRoll({ liftoffAlongFt: missingSurface ? 6400 : 5970 });
    for (const sample of samples) sample.onRunway = missingSurface ? null : sample.onRunway;
    if (!missingSurface) Object.assign(samples[samples.length - 1], pointAlong(6100), { onRunway: false });
    const result = analyzeTakeoffRoll(samples, { ...liftoff, ...pointAlong(6500) }, null, {
      runwayData: runway({ lengthFt: 6000, physicalLengthFt: 6000 }),
    });
    assert(result);
    assert.equal(result.runwayUse.grade, 'Unknown');
    assert.equal(result.liftoff.beyondRunwayEnd, false);
  }
});

test('liftoff heading and position remain measurements without landing-derived grades', () => {
  const { samples, liftoff } = buildRoll();
  const result = analyzeTakeoffRoll(samples, { ...liftoff, ...pointAlong(4500, 90), headingTrueDeg: 15 }, null, { runwayData: runway() });
  assert.equal(result.heading.liftoffDeviationDeg, 15);
  assert.ok(result.lateral.liftoffOffsetFt >= 89);
  assert.equal(result.lateral.score, null);
  assert.equal(result.lateral.grade, 'Recorded');
  assert.deepEqual(result.flags.map((flag: Record<string, any>) => flag.code), ['climb_incomplete']);
});

test('only corroborated ground positions can establish a lateral runway-edge finding', () => {
  for (const condition of ['confirmed', 'inside', 'one-sample', 'duplicate', 'missing-surface', 'unverified']) {
    const { samples, liftoff } = buildRoll();
    for (const sample of samples.slice(-2)) {
      Object.assign(sample, pointAlong(4400, condition === 'inside' ? 70 : 90), { onRunway: false });
    }
    if (condition === 'one-sample') Object.assign(samples.at(-2)!, pointAlong(4350, 0));
    if (condition === 'duplicate') samples.at(-1)!.timestampMs = samples.at(-2)!.timestampMs;
    if (condition === 'missing-surface') samples.at(-1)!.onRunway = null;
    const result = analyzeTakeoffRoll(samples, { ...liftoff, ...pointAlong(4500, 90) }, null, {
      runwayData: runway({ source: condition === 'unverified' ? 'ourairports' : 'msfs-facilities' }),
    });
    assert.equal(result.flags.some((flag: Record<string, any>) => flag.code === 'lateral_offset'), condition === 'confirmed', condition);
  }
});

test('heading findings need distinct nearby ground observations on the same side', () => {
  for (const condition of ['confirmed', 'spike', 'opposite', 'missing', 'gap', 'duplicate']) {
    const { samples, liftoff } = buildRoll();
    samples.at(-1)!.headingTrueDeg = 25;
    samples.at(-2)!.headingTrueDeg = condition === 'spike' ? 0 : condition === 'opposite' ? 335 : condition === 'missing' ? null : 25;
    if (condition === 'gap') samples.at(-1)!.timestampMs += 1200;
    if (condition === 'duplicate') samples.at(-1)!.timestampMs = samples.at(-2)!.timestampMs;
    const result = analyzeTakeoffRoll(samples, { ...liftoff, timestampMs: liftoff.timestampMs + 1500 }, null, { runwayData: runway() });
    assert.equal(result.heading.maxDeviationDeg, 25);
    assert.equal(result.flags.some((flag: Record<string, any>) => flag.code === 'heading_deviation'), condition === 'confirmed', condition);
  }
});
