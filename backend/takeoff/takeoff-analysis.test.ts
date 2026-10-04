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

test('screen-height measurements retain their observed height source without guessing older records', () => {
  const { samples, liftoff } = buildRoll();
  const screen = { timestampMs: liftoff.timestampMs + 5000, ...pointAlong(5000), aglFt: 35 };
  for (const source of ['radio', 'plane', 'baro', null, undefined, 'unknown']) {
    const result = analyzeTakeoffRoll(samples, liftoff, { ...screen, aglSource: source }, { runwayData: runway() });
    assert.equal(result?.screenHeight.heightSource, source === 'radio' || source === 'plane' || source === 'baro' ? source : null);
    assert.equal(result?.screenHeight.reached, true);
  }
  const incomplete = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert.equal(incomplete?.screenHeight.heightSource, null);
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

test('an intersection departure separates the observed roll from physical runway use', () => {
  for (const rollingStartGs of [null, 15]) {
    const { samples, liftoff } = buildRoll({ startAlongFt: 2500, liftoffAlongFt: 4500, rollingStartGs });
    const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
    assert(result);
    assert.equal(result.rollStart.source, rollingStartGs == null ? 'standstill' : 'runway_aligned');
    assert.ok(Math.abs(result.rollDistanceFt - 2000) <= 15, 'roll distance begins at the observed intersection start');
    assert.ok(Math.abs(result.liftoff.distanceFt - 4500) <= 15, 'liftoff position still uses the physical threshold');
    assert.ok(Math.abs(result.liftoff.remainingFt - 3500) <= 15, 'remaining pavement is measured to the physical runway end');
    assert.ok(Math.abs(result.liftoff.usedPct - 56.25) <= 0.25, 'used percentage refers to the full physical runway');
    assert.equal(result.runwayUse.grade, 'Recorded');
    assert.equal(result.runwayUse.score, null, 'intersection use is not a takeoff-performance grade');
  }
});

test('new analysis records the assessment rules independently of the JSON schema', () => {
  const { samples, liftoff } = buildRoll();
  const original = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert(original);
  const recorded = JSON.parse(JSON.stringify(original));
  assert.equal(recorded.schemaVersion, 3);
  assert.deepEqual(recorded.assessmentContract, { id: 'takeoff-assessment', version: 1 });
  original.assessmentContract.version = 999;
  const next = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() });
  assert.equal(next?.assessmentContract.version, 1, 'one consumer cannot change the rules recorded by later analyses');
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

test('heading cautions use the weaker corroborating observation at the exact 10/20 degree boundaries', () => {
  for (const [first, second, severity] of [
    [9.9, 25, null], [10, 25, 'caution'], [19.9, 25, 'caution'], [20, 25, 'warning'],
    [350, 335, 'caution'], [340, 335, 'warning'], [359, 1, null],
  ] as const) {
    const { samples, liftoff } = buildRoll();
    samples.at(-2)!.headingTrueDeg = first;
    samples.at(-1)!.headingTrueDeg = second;
    const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() })!;
    assert.equal(result.flags.find((flag: Record<string, any>) => flag.code === 'heading_deviation')?.severity ?? null,
      severity, `${first}/${second} degrees`);
  }
});

test('heading evidence respects speed, observation gap and geometry confidence boundaries', () => {
  for (const [speed, gapMs, geometry, expected] of [
    [30, 1000, {}, true], [29.9, 1000, {}, false], [30, 1001, {}, false],
    [30, 500, { widthFt: null }, false], [30, 500, { source: 'ourairports' }, false],
  ] as const) {
    const { samples, liftoff } = buildRoll();
    for (const sample of samples.slice(-2)) Object.assign(sample, { gsKts: speed, headingTrueDeg: 25 });
    samples.at(-2)!.timestampMs = samples.at(-1)!.timestampMs - gapMs;
    const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway(geometry) })!;
    assert.equal(result.flags.some((flag: Record<string, any>) => flag.code === 'heading_deviation'), expected);
  }
});

test('a corroborated runway-edge departure remains a finding after returning before liftoff', () => {
  const { samples, liftoff } = buildRoll();
  for (const sample of samples.slice(-10, -8)) Object.assign(sample, pointAlong(3000, 90), { onRunway: false });
  const screen = { timestampMs: liftoff.timestampMs + 4000, ...pointAlong(5000) };
  const result = analyzeTakeoffRoll(samples, liftoff, screen, { runwayData: runway() })!;
  assert.equal(result.lateral.liftoffOffsetFt, 0, 'the aircraft returned before liftoff');
  assert.equal(result.lateral.maxOffsetFt, 90);
  assert.deepEqual(result.flags.map((flag: Record<string, any>) => [flag.code, flag.severity]), [['lateral_offset', 'warning']]);
  assert.equal(result.assessment, 'warning', 'recovery must not erase the recorded event');
});

test('lateral edge findings require distinct same-side positions outside the edge at tracking speed', () => {
  for (const [firstCross, secondCross, speed, expected] of [
    [74.9, 74.9, 140, false], [75.1, 75.1, 30, true], [-75.1, -75.1, 30, true],
    [90, -90, 140, false], [90, 90, 29.9, false], [90, 0, 140, false],
  ] as const) {
    const { samples, liftoff } = buildRoll();
    Object.assign(samples.at(-2)!, pointAlong(4400, firstCross), { onRunway: false, gsKts: speed });
    Object.assign(samples.at(-1)!, pointAlong(4500, secondCross), { onRunway: false, gsKts: speed });
    const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() })!;
    assert.equal(result.flags.some((flag: Record<string, any>) => flag.code === 'lateral_offset'), expected,
      `${firstCross}/${secondCross} ft at ${speed} kt`);
  }
});

test('isolated or stale earlier edge observations cannot become recovered findings', () => {
  for (const condition of ['single', 'duplicate', 'gap', 'missing-surface', 'conflict']) {
    const { samples, liftoff } = buildRoll();
    const first = samples.at(-10)!;
    const second = samples.at(condition === 'gap' ? -3 : -9)!;
    Object.assign(first, pointAlong(3000, 90), { onRunway: false });
    if (condition !== 'single') Object.assign(second, pointAlong(3100, 90), { onRunway: false });
    if (condition === 'duplicate') second.timestampMs = first.timestampMs;
    if (condition === 'gap') samples.splice(samples.length - 9, 6);
    if (condition === 'missing-surface') second.onRunway = null;
    if (condition === 'conflict') first.onRunway = true;
    const result = analyzeTakeoffRoll(samples, liftoff, null, { runwayData: runway() })!;
    assert.ok(!result.flags.some((flag: Record<string, any>) => flag.code === 'lateral_offset'), condition);
  }
});

test('a ground overrun requires both recent ground positions beyond the end, valid surface and tracking speed', () => {
  for (const condition of ['confirmed', 'inside', 'missing-surface', 'slow', 'duplicate', 'stale']) {
    const { samples, liftoff } = buildRoll({ liftoffAlongFt: 5800 });
    for (const sample of samples.slice(-2)) Object.assign(sample, pointAlong(6100), { onRunway: false });
    if (condition === 'inside') Object.assign(samples.at(-2)!, pointAlong(5999));
    if (condition === 'missing-surface') samples.at(-2)!.onRunway = null;
    if (condition === 'slow') samples.at(-2)!.gsKts = 29.9;
    if (condition === 'duplicate') samples.at(-1)!.timestampMs = samples.at(-2)!.timestampMs;
    const airborne = { ...liftoff, ...pointAlong(6200), timestampMs: liftoff.timestampMs + (condition === 'stale' ? 3001 : 100) };
    const result = analyzeTakeoffRoll(samples, airborne, null, { runwayData: runway({ physicalLengthFt: 6000 }) })!;
    assert.equal(result.liftoff.beyondRunwayEnd, condition === 'confirmed', condition);
    assert.equal(result.assessment, condition === 'confirmed' ? 'critical' : 'caution', condition);
  }
});

test('invalid or missing runway-use inputs remain unknown without non-finite results', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
    for (const input of [{ liftoffDistanceFt: value, runwayLengthFt: 6000 }, { liftoffDistanceFt: 4000, runwayLengthFt: value }]) {
      const result = scoreTakeoffRunwayUse(input);
      assert.equal(result.grade, 'Unknown');
      assert.equal(result.score, null);
      assert.equal(result.remainingFt, null);
      assert.equal(result.liftoffBeyondEnd, false);
    }
  }
  for (const runwayLengthFt of [0, -6000]) assert.equal(scoreTakeoffRunwayUse({ liftoffDistanceFt: 4000, runwayLengthFt }).grade, 'Unknown');
});

test('takeoff distances use the physical runway origin rather than the displaced landing threshold', () => {
  const { samples, liftoff } = buildRoll();
  const result = analyzeTakeoffRoll(samples, liftoff, null, {
    runwayData: runway({ threshold: pointAlong(1000), lengthFt: 7000, displacedThresholdFt: 1000 }),
  })!;
  assert.equal(result.liftoff.distanceFt, 4500);
  assert.equal(result.liftoff.remainingFt, 3500);
  assert.equal(result.runway.originKind, 'physical_threshold');
  assert.equal(result.runwayUse.verified, true);
});

test('rotation requires an observed pitch rise and at least 400 ms, never fills missing attitude', () => {
  for (const durationMs of [399, 400]) for (const simulationClock of [false, true]) {
    const { samples, liftoff } = buildRoll();
    const roll = samples.filter(sample => sample.timestampMs < liftoff.timestampMs - 1000);
    for (const sample of roll) sample.pitchDeg = 0;
    roll.push({ ...samples.at(-1)!, timestampMs: liftoff.timestampMs - durationMs, pitchDeg: 1 });
    roll.push({ ...samples.at(-1)!, timestampMs: liftoff.timestampMs - 100, pitchDeg: 2.5 });
    if (simulationClock) {
      liftoff.simTimeSec = 63_884_999_000;
      for (const sample of roll) sample.simTimeSec = liftoff.simTimeSec + (sample.timestampMs - liftoff.timestampMs) / 1000;
    }
    const result = analyzeTakeoffRoll(roll, { ...liftoff, pitchDeg: 3 }, null, { runwayData: runway() })!;
    assert.equal(result.rotation.rateDegS, durationMs === 400 ? 5 : null);
  }
  for (const pitchDeg of [null, NaN, Infinity, 0]) {
    const { samples, liftoff } = buildRoll();
    for (const sample of samples) sample.pitchDeg = pitchDeg;
    const result = analyzeTakeoffRoll(samples, { ...liftoff, pitchDeg }, null)!;
    assert.equal(result.rotation.rateDegS, null);
    assert.equal(result.rotation.maxPitchDeg, pitchDeg === 0 ? 0 : null);
  }
});

test('time measurements follow simulation time while event timestamps remain UTC capture time', () => {
  const { samples, liftoff } = buildRoll();
  const baseline = analyzeTakeoffRoll(samples, liftoff, { timestampMs: liftoff.timestampMs + 4000, ...pointAlong(5000) })!;
  const originMs = samples[0].timestampMs;
  for (const sample of samples) sample.simTimeSec = 63_884_999_000 + (sample.timestampMs - originMs) / 1000 * 2;
  const simLiftoff = { ...liftoff, simTimeSec: 63_884_999_000 + (liftoff.timestampMs - originMs) / 1000 * 2 };
  const screen = { timestampMs: liftoff.timestampMs + 4000, simTimeSec: simLiftoff.simTimeSec + 8, ...pointAlong(5000) };
  const result = analyzeTakeoffRoll(samples, simLiftoff, screen)!;
  assert.equal(result.rollDurationS, baseline.rollDurationS * 2);
  assert.equal(result.rotation.rateDegS, baseline.rotation.rateDegS / 2);
  assert.equal(result.screenHeight.elapsedS, 8);
  assert.equal(result.rollDurationBasis, 'simulator');
  assert.equal(result.liftoff.timestampMs, liftoff.timestampMs);
  assert.equal(result.rollDistanceFt, baseline.rollDistanceFt);
});

test('re-liftoff rotation is measured solely from the final ground contact while prior peaks remain recorded', () => {
  for (const observedRise of [false, true]) {
    const { samples, liftoff } = buildRoll();
    const firstContactMs = liftoff.timestampMs + 1500;
    const finalLiftoff = { ...liftoff, timestampMs: firstContactMs + 1500, pitchDeg: 10 };
    const finalGround = [0, 500, 1000].map(offset => ({ ...samples.at(-1)!,
      timestampMs: firstContactMs + offset, pitchDeg: observedRise && offset === 1000 ? 8 : 6,
    }));
    const result = analyzeTakeoffRoll([...samples, ...finalGround], finalLiftoff, null, {
      rollStart: { ...samples[0], source: 'standstill' }, rotationGroundStartMs: firstContactMs,
      priorRotationMaxRateDegS: 12, climb: { maxPitchDeg: 18 }, hopCount: 1,
    })!;
    assert.equal(result.rotation.rateDegS, observedRise ? 4 : null);
    assert.equal(result.rotation.maxRateDegS, 12);
    assert.equal(result.rotation.maxPitchDeg, 18);
    assert.ok(result.rollDurationS > 32, 'total departure measurement still spans the whole attempt');
  }
});
