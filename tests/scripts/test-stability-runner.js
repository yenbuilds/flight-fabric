#!/usr/bin/env node
/**
 * stability-runner.js focused tests
 *
 * `runStability()` is a thin compatibility shim that returns
 * `ultimateScore: null`. All scoring
 * happens via `SimpleStabilityScorer` in the CSV-replay path. These tests
 * therefore exercise the scorer directly using `frameToSample` to convert
 * raw input frames the same way the CSV-replay loop does.
 */

'use strict';

const assert = require('assert');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const {
  runStability,
  SimpleStabilityScorer,
  frameToSample,
  isImc,
  VMC_VISIBILITY_THRESHOLD_M,
  resolveGlidepathAngleForApproach,
  targetVerticalSpeedForGlidepath,
  verticalSpeedFactorForGlidepath,
} = require(resolveBackendRuntimeFile('stability', 'stability-runner.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`\u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`\u2717 ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

function makeFrame(overrides = {}) {
  // `engineLevels` is supported by the live SimConnect provider but not by
  // normalizeFrame's input contract; the scorer reads `thrust` (a single
  // averaged % value). Convert here so tests can keep the per-engine array
  // form for readability.
  const merged = {
    ias: 145,
    vs: -700,
    ra: 1200,
    gs: 140,
    dtMs: 100,
    engineLevels: [55, 55],
    wow: false,
    gearDownLocked: 1,
    flaps: { percent: 35 },
    spoilers: { state: 'STOWED', percent: 0 },
    visibilityM: 10000,
    ...overrides,
  };
  if (merged.thrust == null && Array.isArray(merged.engineLevels) && merged.engineLevels.length > 0) {
    const avg = merged.engineLevels.reduce((sum, v) => sum + v, 0) / merged.engineLevels.length;
    merged.thrust = avg;
  }
  return merged;
}

function scoreFrames(frames, thresholdElevFt = null, scoringContext = {}) {
  const scorer = new SimpleStabilityScorer();
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }
  return scorer.getScore(thresholdElevFt, scoringContext);
}

console.log('\n=== stability-runner.js Tests ===');

test('runStability shim never returns an ultimate score (CSV-replay scorer owns it)', () => {
  // The shim carries IMC visibility classification and raw-input diagnostics.
  const result = runStability(makeFrame({ ra: 400, wow: true }));
  assert.strictEqual(result.instantaneous, null);
  assert.strictEqual(result.ultimateScore, null);
  assert.strictEqual(typeof result.isImc, 'boolean');
  assert.strictEqual(result.imcDataAvailable, true);
});

test('runStability reports unknown IMC state when visibility is unavailable', () => {
  const result = runStability(makeFrame({ visibilityM: null }));
  assert.strictEqual(result.isImc, null);
  assert.strictEqual(result.imcDataAvailable, false);
});

test('returns perfect score when configuration is stable after gate', () => {
  const frames = [
    makeFrame({ ra: 1400 }),
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1000 }), // gate captured here
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 600 }),
    makeFrame({ ra: 400, wow: true }),
  ];

  const result = scoreFrames(frames);
  assert(result.score != null, 'Expected score on touchdown');
  assert.strictEqual(result.score, 100);
  assert.strictEqual(result.breakdown.config_ok, 100);
  assert.strictEqual(result.gateStable, true);
  assert.deepStrictEqual(result.gateFailures, []);
});

test('normal flare energy changes below 50 ft do not degrade approach stability', () => {
  const frames = [
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1000 }),
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 600 }),
    makeFrame({ ra: 400 }),
    makeFrame({ ra: 200 }),
    // Normal flare: speed, sink rate and thrust reduce rapidly below 50 ft.
    makeFrame({ ra: 40, ias: 138, gs: 130, vs: -350, thrust: 25 }),
    makeFrame({ ra: 20, ias: 132, gs: 125, vs: -150, thrust: 5 }),
    makeFrame({ ra: 0, wow: true, ias: 128, gs: 120, vs: -100, thrust: 0 }),
  ];

  const result = scoreFrames(frames);
  assert.strictEqual(result.breakdown.speed_ok, 100, 'Flare speed bleed should be excluded');
  assert.strictEqual(result.breakdown.speed_trend_ok, null, 'An approach shorter than one trend window should report the metric unavailable');
  assert.strictEqual(result.breakdown.glidepath_ok, 100, 'Flare sink-rate reduction should be excluded');
  assert.strictEqual(result.breakdown.thrust_stable_ok, 100, 'Flare thrust reduction should be excluded');
  assert.strictEqual(result.gateStable, true, `Expected stable approach, failures=${result.gateFailures.join(',')}`);
});

test('unavailable dynamic signals are excluded instead of receiving free 100s', () => {
  const frames = Array.from({ length: 14 }, (_, index) => makeFrame({
    ra: 1200 - (index * 90),
    gs: null,
    pitch: null,
    bank: null,
    thrust: null,
    engineLevels: [],
  }));

  const result = scoreFrames(frames);
  assert.strictEqual(result.breakdown.glidepath_ok, null);
  assert.strictEqual(result.breakdown.thrust_ok, null);
  assert.strictEqual(result.breakdown.pitch_ok, null);
  assert.strictEqual(result.breakdown.bank_ok, null);
  assert.strictEqual(result.coverage.scoredMetrics, 3);
  assert.strictEqual(result.coverage.totalMetrics, 8);
  assert.strictEqual(result.score, 100, 'Missing signals should neither reward nor punish the player');
});

test('50 ft flare boundary excludes 50 ft but still scores 51 ft', () => {
  const scoreWithLowSample = (ra, ias) => scoreFrames([
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1000 }),
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 500 }),
    makeFrame({ ra: 200 }),
    makeFrame({ ra, ias }),
    makeFrame({ ra: 0, wow: true }),
  ]);

  const atBoundary = scoreWithLowSample(50, 120);
  assert.strictEqual(atBoundary.breakdown.speed_ok, 100, 'Exactly 50 ft should be inside the flare exclusion');

  const aboveBoundary = scoreWithLowSample(51, 120);
  assert(aboveBoundary.breakdown.speed_ok < 100, 'A deviation at 51 ft must still participate in approach scoring');
});

test('flare exclusion does not hide configuration changes below 50 ft', () => {
  const result = scoreFrames([
    makeFrame({ ra: 1200, flaps: { percent: 35 } }),
    makeFrame({ ra: 1000, flaps: { percent: 35 } }),
    makeFrame({ ra: 800, flaps: { percent: 35 } }),
    makeFrame({ ra: 500, flaps: { percent: 35 } }),
    makeFrame({ ra: 200, flaps: { percent: 35 } }),
    makeFrame({ ra: 40, flaps: { percent: 15 } }),
    makeFrame({ ra: 0, wow: true, flaps: { percent: 15 } }),
  ]);

  assert.strictEqual(result.breakdown.flaps_ok, 0, 'Below-50-ft flap movement must remain a configuration failure');
  assert(result.gateFailures.includes('flaps_changed_after_gate'));
});

test('one-second speed trend rejects sustained changes but ignores 10 Hz IAS jitter', () => {
  const jitterFrames = [makeFrame({ ra: 1200 })];
  for (let index = 0; index < 20; index++) {
    jitterFrames.push(makeFrame({
      ra: 1000 - (index * 30),
      ias: index % 2 === 0 ? 145 : 145.3,
      dtMs: 100,
    }));
  }
  const jitterResult = scoreFrames(jitterFrames);
  assert.strictEqual(jitterResult.breakdown.speed_trend_ok, 100, 'Sub-knot frame jitter should not fail a one-second trend');

  const acceleratingFrames = [makeFrame({ ra: 1200 })];
  for (let index = 0; index < 20; index++) {
    acceleratingFrames.push(makeFrame({
      ra: 1000 - (index * 30),
      ias: 145 + (index * 0.4),
      dtMs: 100,
    }));
  }
  const acceleratingResult = scoreFrames(acceleratingFrames, null, {
    criteria: { speedMinusKts: 100, speedPlusKts: 100 },
  });
  assert(
    acceleratingResult.breakdown.speed_trend_ok < 80,
    `Sustained 4 kt/sec acceleration should fail, got ${acceleratingResult.breakdown.speed_trend_ok}`,
  );
});

test('one-second vertical-rate smoothing ignores alternating provider jitter', () => {
  const frames = [makeFrame({ ra: 1200 })];
  for (let index = 0; index < 20; index++) {
    frames.push(makeFrame({
      ra: 1000 - (index * 30),
      gs: 140,
      vs: index % 2 === 0 ? -500 : -980,
      dtMs: 100,
    }));
  }

  const result = scoreFrames(frames);
  assert(
    result.breakdown.glidepath_ok >= 80,
    `Alternating VS jitter should average near the 3-degree target, got ${result.breakdown.glidepath_ok}`,
  );
  assert(!result.gateFailures.includes('glidepath_proxy_unstable_after_gate'));
});

test('flaps change after gate degrades config and overall score', () => {
  const frames = [
    makeFrame({ ra: 1300, flaps: { percent: 35 } }),
    makeFrame({ ra: 1000, flaps: { percent: 35 } }), // gate
    makeFrame({ ra: 800, flaps: { percent: 15 } }),  // changed after gate
    makeFrame({ ra: 600, flaps: { percent: 15 } }),
    makeFrame({ ra: 500, flaps: { percent: 15 } }),
    makeFrame({ ra: 300, wow: true, flaps: { percent: 15 } }),
  ];

  const result = scoreFrames(frames);
  assert(result.score != null, 'Expected score on touchdown');
  assert.strictEqual(result.score, 70, 'Expected flaps-change cap to limit headline score');
  assert.strictEqual(result.breakdown.config_ok, 0);
  assert.strictEqual(result.breakdown.flaps_ok, 0);
  assert(
    result.gateFailures.includes('flaps_changed_after_gate'),
    'Expected flaps_changed_after_gate failure'
  );
});

test('flaps not set at gate caps headline score even when other metrics are clean', () => {
  const frames = [
    makeFrame({ ra: 1400, flaps: { percent: 0 } }),
    makeFrame({ ra: 1200, flaps: { percent: 0 } }),
    makeFrame({ ra: 1000, flaps: { percent: 0 } }), // gate: no landing flaps
    makeFrame({ ra: 800, flaps: { percent: 0 } }),
    makeFrame({ ra: 600, flaps: { percent: 0 } }),
    makeFrame({ ra: 400, wow: true, flaps: { percent: 0 } }),
  ];

  const result = scoreFrames(frames);
  assert.strictEqual(result.score, 60, 'Expected missing-flaps cap to limit headline score');
  assert.strictEqual(result.breakdown.config_ok, 0);
  assert.strictEqual(result.breakdown.flaps_ok, 0);
  assert.ok(result.gateFailures.includes('flaps_not_set_at_gate'), 'Expected flaps_not_set_at_gate');
});

test('VS, glidepath and throttle movement checks reduce score when unstable', () => {
  const frames = [
    makeFrame({ ra: 1300, ias: 145, gs: 140, vs: -700, engineLevels: [60, 60] }),
    makeFrame({ ra: 1000, ias: 145, gs: 140, vs: -700, engineLevels: [60, 60] }), // gate
    makeFrame({ ra: 850, ias: 170, gs: 110, vs: -1500, engineLevels: [5, 5] }),
    makeFrame({ ra: 700, ias: 120, gs: 170, vs: -200, engineLevels: [85, 85] }),
    makeFrame({ ra: 550, ias: 160, gs: 100, vs: -1300, engineLevels: [8, 8] }),
    makeFrame({ ra: 300, wow: true, ias: 150, gs: 95, vs: -1200, engineLevels: [5, 5] }),
  ];

  const result = scoreFrames(frames);
  assert(result.score != null, 'Expected score on touchdown');
  assert(result.score < 80, `Expected low score, got ${result.score}`);
  assert(result.breakdown.vs_ok < 80, 'Expected VS proxy degradation');
  assert(result.breakdown.glidepath_ok < 80, 'Expected glidepath proxy degradation');
  assert.strictEqual(result.breakdown.thrust_not_idle_ok, 100, 'Expected legacy thrust-idle proxy to stay neutral');
  assert(result.breakdown.thrust_stable_ok < 80, 'Expected throttle-movement degradation');
});

test('does not score with fewer than 5 samples', () => {
  const frames = [
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 900 }),
    makeFrame({ ra: 700 }),
    makeFrame({ ra: 300, wow: true }),
  ];

  const result = scoreFrames(frames);
  assert.strictEqual(result.score, null);
  assert(result.gateFailures.includes('insufficient_data'));
});

test('getScore is single-use per scorer instance', () => {
  // The CSV-replay loop creates a fresh scorer per approach (and resets it
  // after each landing event). Calling getScore twice on the same instance
  // is a programmer error and must throw rather than silently double-count.
  const scorer = new SimpleStabilityScorer();
  for (const frame of [
    makeFrame({ ra: 1300 }),
    makeFrame({ ra: 1000 }),
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 600 }),
    makeFrame({ ra: 500 }),
    makeFrame({ ra: 300, wow: true }),
  ]) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }
  const first = scorer.getScore();
  assert(first.score != null, 'First getScore should return score');
  assert.throws(() => scorer.getScore(), /already been used/);
});

test('isImc follows visibility threshold', () => {
  assert.strictEqual(isImc(null), null);
  assert.strictEqual(isImc(undefined), null);
  assert.strictEqual(isImc(VMC_VISIBILITY_THRESHOLD_M - 1), true);
  assert.strictEqual(isImc(VMC_VISIBILITY_THRESHOLD_M), false);
  assert.strictEqual(isImc(VMC_VISIBILITY_THRESHOLD_M + 1000), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate configuration — gear
// ─────────────────────────────────────────────────────────────────────────────

test('gear not down at 1000 ft gate → gear_not_down_at_gate failure', () => {
  const frames = [
    makeFrame({ ra: 1300, gearDownLocked: 0 }),
    makeFrame({ ra: 1000, gearDownLocked: 0 }), // gate: gear still up
    makeFrame({ ra: 800,  gearDownLocked: 1 }),  // gear extended late
    makeFrame({ ra: 600,  gearDownLocked: 1 }),
    makeFrame({ ra: 400,  gearDownLocked: 1 }),
    makeFrame({ ra: 200, wow: true, gearDownLocked: 1 }),
  ];
  const result = scoreFrames(frames);
  assert.ok(result.gateFailures.includes('gear_not_down_at_gate'), 'Expected gear_not_down_at_gate');
  assert.strictEqual(result.score, 60, 'Expected missing-gear cap to limit headline score');
  assert.strictEqual(result.breakdown.gear_ok, 0);
  assert.strictEqual(result.breakdown.config_ok, 0);
});

test('gear raised after 1000 ft gate → gear_changed_after_gate failure', () => {
  const frames = [
    makeFrame({ ra: 1300, gearDownLocked: 1 }),
    makeFrame({ ra: 1000, gearDownLocked: 1 }), // gate: gear down
    makeFrame({ ra: 800,  gearDownLocked: 0 }), // gear raised mid-approach
    makeFrame({ ra: 600,  gearDownLocked: 0 }),
    makeFrame({ ra: 400,  gearDownLocked: 0 }),
    makeFrame({ ra: 200, wow: true, gearDownLocked: 0 }),
  ];
  const result = scoreFrames(frames);
  assert.ok(result.gateFailures.includes('gear_changed_after_gate'), 'Expected gear_changed_after_gate');
  assert.strictEqual(result.score, 70, 'Expected gear-change cap to limit headline score');
  assert.strictEqual(result.breakdown.gear_ok, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Spoiler telemetry is scoring-neutral
// ─────────────────────────────────────────────────────────────────────────────

test('spoiler movement does not affect stability scoring', () => {
  const frames = [
    makeFrame({ ra: 1300, spoilers: { state: 'ARMED', percent: 0 } }),
    makeFrame({ ra: 1000, spoilers: { state: 'ARMED', percent: 0 } }), // gate
    makeFrame({ ra: 800,  spoilers: { state: 'EXTENDED', percent: 50 } }), // speed brake extended
    makeFrame({ ra: 600,  spoilers: { state: 'EXTENDED', percent: 50 } }),
    makeFrame({ ra: 400,  spoilers: { state: 'EXTENDED', percent: 50 } }),
    makeFrame({ ra: 200, wow: true, spoilers: { state: 'EXTENDED', percent: 50 } }),
  ];
  const neutralFrames = frames.map((frame) => ({
    ...frame,
    spoilers: { state: 'STOWED', percent: 0 },
  }));
  const result = scoreFrames(frames);
  const neutralResult = scoreFrames(neutralFrames);
  assert.strictEqual(result.score, neutralResult.score, 'Spoiler movement must not alter headline score');
  assert.strictEqual(result.breakdown.config_ok, neutralResult.breakdown.config_ok);
  assert.strictEqual(result.breakdown.spoilers_ok, 100, 'Compatibility metric remains neutral');
  assert.ok(!result.gateFailures.includes('spoilers_moved_after_gate'), 'No spoiler gate failure');
});

test('trusted lateral touchdown offset participates in ultimate stability score', () => {
  const frames = [
    makeFrame({ ra: 1400 }),
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1000 }),
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 600 }),
    makeFrame({ ra: 400, wow: true }),
  ];

  const result = scoreFrames(frames, null, {
    lateralOffsetFt: 90,
    runwayWidthFt: 150,
  });
  assert(result.score < 100, `Expected lateral offset to reduce score, got ${result.score}`);
  assert.strictEqual(result.breakdown.lateral_offset_ok, 48);
  assert(result.gateFailures.includes('lateral_offset_unstable_at_touchdown'));
  assert.strictEqual(result.gateStable, false);
});

test('suspect lateral geometry is skipped rather than penalising stability', () => {
  const frames = [
    makeFrame({ ra: 1400 }),
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1000 }),
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 600 }),
    makeFrame({ ra: 400, wow: true }),
  ];

  const result = scoreFrames(frames, null, {
    lateralOffsetFt: 90,
    runwayWidthFt: 150,
    lateralOffsetSuspect: true,
  });
  assert.strictEqual(result.score, 100);
  assert.strictEqual(result.breakdown.lateral_offset_ok, undefined);
  assert(!result.gateFailures.includes('lateral_offset_unstable_at_touchdown'));
});

test('rollout samples after touchdown do not degrade approach stability', () => {
  // Current-approach scoring is consumed at landing:final, after the rollout window. Those
  // on-ground frames must not count against approach speed, VS, thrust, or pitch.
  const frames = [
    makeFrame({ ra: 1300, ias: 145, gs: 140, vs: -700, engineLevels: [55, 55], pitchDeg: 3 }),
    makeFrame({ ra: 1000, ias: 145, gs: 140, vs: -700, engineLevels: [55, 55], pitchDeg: 3 }),
    makeFrame({ ra: 800,  ias: 145, gs: 140, vs: -700, engineLevels: [55, 55], pitchDeg: 3 }),
    makeFrame({ ra: 500,  ias: 145, gs: 140, vs: -700, engineLevels: [55, 55], pitchDeg: 3 }),
    makeFrame({ ra: 20, wow: true, ias: 130, gs: 125, vs: -650, engineLevels: [35, 35], pitchDeg: 5 }),
    makeFrame({ ra: 5,  wow: true, ias: 70,  gs: 65,  vs: 0,    engineLevels: [0, 0],   pitchDeg: 0 }),
    makeFrame({ ra: 3,  wow: true, ias: 35,  gs: 30,  vs: 0,    engineLevels: [0, 0],   pitchDeg: 0 }),
  ];
  const result = scoreFrames(frames);
  assert.strictEqual(result.gateStable, true, `Expected rollout to be ignored, failures=${result.gateFailures.join(',')}`);
  assert.strictEqual(result.score, 100, `Expected perfect approach score, got ${result.score}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Attitude excursions after gate
// ─────────────────────────────────────────────────────────────────────────────

test('bank excursion (>25°) on majority of after-gate samples → bank_unstable_after_gate failure', () => {
  const frames = [
    makeFrame({ ra: 1300, bankDeg: 0 }),
    makeFrame({ ra: 1000, bankDeg: 0 }), // gate
    makeFrame({ ra: 850,  bankDeg: 35 }),
    makeFrame({ ra: 700,  bankDeg: 35 }),
    makeFrame({ ra: 550,  bankDeg: 35 }),
    makeFrame({ ra: 400,  bankDeg: 35 }),
    makeFrame({ ra: 250,  bankDeg: 35 }),
    makeFrame({ ra: 100, wow: true, bankDeg: 0 }),
  ];
  const result = scoreFrames(frames);
  assert.ok(result.breakdown.bank_ok < 80, `Expected bank_ok < 80, got ${result.breakdown.bank_ok}`);
  assert.ok(result.gateFailures.includes('bank_unstable_after_gate'), 'Expected bank_unstable_after_gate');
});

test('pitch excursion (>15°) on majority of after-gate samples → pitch_unstable_after_gate failure', () => {
  const frames = [
    makeFrame({ ra: 1300, pitchDeg: 3 }),
    makeFrame({ ra: 1000, pitchDeg: 3 }), // gate
    makeFrame({ ra: 850,  pitchDeg: 20 }),
    makeFrame({ ra: 700,  pitchDeg: 20 }),
    makeFrame({ ra: 550,  pitchDeg: 20 }),
    makeFrame({ ra: 400,  pitchDeg: 20 }),
    makeFrame({ ra: 250,  pitchDeg: 20 }),
    makeFrame({ ra: 100, wow: true, pitchDeg: 5 }),
  ];
  const result = scoreFrames(frames);
  assert.ok(result.breakdown.pitch_ok < 80, `Expected pitch_ok < 80, got ${result.breakdown.pitch_ok}`);
  assert.ok(result.gateFailures.includes('pitch_unstable_after_gate'), 'Expected pitch_unstable_after_gate');
});

// ─────────────────────────────────────────────────────────────────────────────
// Glidepath below — safety-critical path
// ─────────────────────────────────────────────────────────────────────────────

test('flying below 3° glidepath after gate → glidepath_too_low_after_gate failure', () => {
  // At GS 140 kts, 3° target VS = -140 × 5.31 ≈ -743 fpm.
  // Flying at -1200 fpm is ~460 fpm below the glidepath, exceeding the
  // GLIDEPATH_VS_DELTA_MAX_FPM (200 fpm) threshold.
  const frames = [
    makeFrame({ ra: 1300, gs: 140, vs: -700 }),
    makeFrame({ ra: 1000, gs: 140, vs: -700 }), // gate
    makeFrame({ ra: 850,  gs: 140, vs: -1200 }),
    makeFrame({ ra: 700,  gs: 140, vs: -1200 }),
    makeFrame({ ra: 550,  gs: 140, vs: -1200 }),
    makeFrame({ ra: 400,  gs: 140, vs: -1200 }),
    makeFrame({ ra: 250,  gs: 140, vs: -1200 }),
    makeFrame({ ra: 100, wow: true }),
  ];
  const result = scoreFrames(frames);
  assert.ok(result.breakdown.glidepath_below_ok < 80,
    `Expected glidepath_below_ok < 80, got ${result.breakdown.glidepath_below_ok}`);
  assert.ok(result.gateFailures.includes('glidepath_too_low_after_gate'), 'Expected glidepath_too_low_after_gate');
});

test('glidepath override resolver is runway-specific and keeps legacy default factor', () => {
  assert.strictEqual(verticalSpeedFactorForGlidepath(3), 5.31, '3° should keep the legacy 5.31 VS factor');
  assert.strictEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'EGLC' }).angleDeg,
    3,
    'EGLC without runway should not apply a blind airport-wide override',
  );
  assert.strictEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'EGLC', runwayId: '9' }).angleDeg,
    5.5,
    'EGLC runway 9 should normalize to runway 09',
  );
  assert.strictEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'EGLC', runwayId: '27' }).angleDeg,
    5.5,
    'EGLC runway 27 should use 5.5°',
  );
  assert.strictEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'LSZA', runwayId: '01' }).angleDeg,
    6.65,
    'LSZA runway 01 should use 6.65°',
  );
  assert.strictEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'LOWI', runwayId: '26' }).angleDeg,
    3.77,
    'LOWI runway 26 should use 3.77°',
  );
  assert.strictEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'LOWI', runwayId: '08' }).angleDeg,
    3,
    'LOWI runway 08 should keep the default unless a runway-specific entry exists',
  );
});

test('non-overridden airports score exactly like legacy default glidepath logic', () => {
  const steepVs = targetVerticalSpeedForGlidepath(140, 5.5);
  const frames = [
    makeFrame({ ra: 1300, gs: 140, vs: steepVs }),
    makeFrame({ ra: 1000, gs: 140, vs: steepVs }),
    makeFrame({ ra: 850, gs: 140, vs: steepVs }),
    makeFrame({ ra: 700, gs: 140, vs: steepVs }),
    makeFrame({ ra: 550, gs: 140, vs: steepVs }),
    makeFrame({ ra: 300, gs: 140, vs: steepVs, wow: true }),
  ];

  const defaultResult = scoreFrames(frames);
  const unknownAirportResult = scoreFrames(frames, null, {
    airportIcao: 'KJFK',
    runwayId: '04L',
  });

  assert.strictEqual(unknownAirportResult.criteria.glidepathAngleDeg, defaultResult.criteria.glidepathAngleDeg);
  assert.strictEqual(unknownAirportResult.breakdown.vs_ok, defaultResult.breakdown.vs_ok);
  assert.strictEqual(unknownAirportResult.breakdown.glidepath_ok, defaultResult.breakdown.glidepath_ok);
  assert.strictEqual(unknownAirportResult.breakdown.glidepath_below_ok, defaultResult.breakdown.glidepath_below_ok);
  assert.strictEqual(unknownAirportResult.breakdown.glidepath_above_ok, defaultResult.breakdown.glidepath_above_ok);
  assert.strictEqual(unknownAirportResult.score, defaultResult.score);
});

test('runway-specific steep approach override relaxes glidepath and VS checks only for matching runway', () => {
  const steepVs = targetVerticalSpeedForGlidepath(140, 5.5);
  const frames = [
    makeFrame({ ra: 1300, gs: 140, vs: steepVs }),
    makeFrame({ ra: 1000, gs: 140, vs: steepVs }),
    makeFrame({ ra: 850, gs: 140, vs: steepVs }),
    makeFrame({ ra: 700, gs: 140, vs: steepVs }),
    makeFrame({ ra: 550, gs: 140, vs: steepVs }),
    makeFrame({ ra: 300, gs: 140, vs: steepVs, wow: true }),
  ];

  const noRunway = scoreFrames(frames, null, { airportIcao: 'EGLC' });
  const runway09 = scoreFrames(frames, null, { airportIcao: 'EGLC', runwayId: '09' });

  assert.strictEqual(noRunway.criteria.glidepathAngleDeg, 3, 'EGLC without runway should keep 3° scoring');
  assert.strictEqual(noRunway.breakdown.glidepath_ok, 0, '5.5° profile should fail default 3° proxy');
  assert.strictEqual(noRunway.breakdown.vs_ok, 0, '5.5° profile should fail default VS floor');

  assert.strictEqual(runway09.criteria.glidepathAngleDeg, 5.5, 'EGLC runway 09 should use 5.5° scoring');
  assert.strictEqual(runway09.breakdown.glidepath_ok, 100, '5.5° profile should pass EGLC glidepath proxy');
  assert.strictEqual(runway09.breakdown.vs_ok, 100, '5.5° profile should pass EGLC VS floor');
});

// ─────────────────────────────────────────────────────────────────────────────
// thresholdElevFt — height-above-threshold gate
// ─────────────────────────────────────────────────────────────────────────────

test('thresholdElevFt: gate fires on altMslFt − thresholdElevFt instead of raFt', () => {
  // Airport elevation 5000 ft MSL. Gate at 1000 ft AGL = 6000 ft MSL.
  // raFt values are very high (high-altitude airport) but altMslFt correctly
  // gives height above threshold. Scorer must use altMslFt − thresholdElevFt.
  const thresholdElevFt = 5000;
  const frames = [
    makeFrame({ ra: 9000, altMslFt: 7500 }), // 2500 ft AGL — above gate
    makeFrame({ ra: 8500, altMslFt: 6000 }), // 1000 ft AGL — gate fires here
    makeFrame({ ra: 8200, altMslFt: 5800 }),
    makeFrame({ ra: 8000, altMslFt: 5500 }),
    makeFrame({ ra: 7800, altMslFt: 5200 }),
    makeFrame({ ra: 7600, altMslFt: 5050, wow: true }),
  ];
  const scorer = new SimpleStabilityScorer();
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }
  const result = scorer.getScore(thresholdElevFt);
  assert.ok(result.score != null, 'Expected a score with thresholdElevFt set');
  assert.strictEqual(result.gateStable, true, 'Stable approach should pass the gate');
});

test('thresholdElevFt: falls back to raFt when altMslFt is absent', () => {
  // When altMslFt is not in the sample, the scorer falls back to raFt.
  // Ensure no crash and gate fires normally on raFt.
  const frames = [
    makeFrame({ ra: 1400 }),
    makeFrame({ ra: 1000 }), // gate on raFt = 1000
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 600 }),
    makeFrame({ ra: 400 }),
    makeFrame({ ra: 200, wow: true }),
  ];
  const scorer = new SimpleStabilityScorer();
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }
  const result = scorer.getScore(1000); // thresholdElevFt provided but altMslFt absent
  assert.ok(result.score != null, 'Expected a score when altMslFt absent — falls back to raFt');
});

test('calibrated altitude prevents a cockpit barometer correction from moving the gate or profile', () => {
  const thresholdElevFt = 100;
  const frames = [
    makeFrame({ ra: 9000, altMslFt: 1400, altCalibratedFt: 1400, gearDownLocked: 0 }),
    // Wrong cockpit setting makes legacy indicated altitude cross the gate early.
    makeFrame({ ra: 8800, altMslFt: 1000, altCalibratedFt: 1250, gearDownLocked: 0 }),
    // Correcting QNH makes indicated altitude jump upward; calibrated remains smooth.
    makeFrame({ ra: 8600, altMslFt: 1100, altCalibratedFt: 1100, gearDownLocked: 1 }),
    makeFrame({ ra: 8400, altMslFt: 900, altCalibratedFt: 900, gearDownLocked: 1 }),
    makeFrame({ ra: 8200, altMslFt: 650, altCalibratedFt: 650, gearDownLocked: 1 }),
    makeFrame({ ra: 8000, altMslFt: 150, altCalibratedFt: 150, gearDownLocked: 1, wow: true }),
  ];
  const scorer = new SimpleStabilityScorer();
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }

  const profile = scorer.getApproachProfile();
  assert(profile.every(point => point.profileAltitudeSource === 'calibrated'), 'profile should lock calibrated altitude');
  assert.deepStrictEqual(
    profile.map(point => point.profileAltMslFt),
    [1400, 1250, 1100, 900, 650, 150],
    'selected profile altitude should remain monotonic through the cockpit correction',
  );

  const result = scorer.getScore(thresholdElevFt);
  assert.ok(result.score != null, 'calibrated altitude should provide a valid gate');
  assert(!result.gateFailures.includes('gear_not_down_at_gate'), 'legacy indicated altitude must not trigger the gate early');
});

test('plane altitude is preferred over barometric sources for runway-relative geometry', () => {
  const runwayReferenceElevFt = 100;
  const geometric = [1400, 1250, 1100, 900, 650, 150];
  const calibrated = [1400, 1000, 1200, 900, 650, 150];
  const frames = geometric.map((altPlaneFt, index) => makeFrame({
    ra: 9000 - index * 200,
    altPlaneFt,
    altCalibratedFt: calibrated[index],
    altMslFt: calibrated[index],
    gearDownLocked: index >= 2 ? 1 : 0,
    wow: index === geometric.length - 1,
  }));
  const scorer = new SimpleStabilityScorer();
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }

  const profile = scorer.getApproachProfile();
  assert(profile.every(point => point.profileAltitudeSource === 'plane'), 'profile should lock plane altitude');
  assert.deepStrictEqual(profile.map(point => point.profileAltitudeFt), geometric);
  assert.deepStrictEqual(profile.map(point => point.profileAltMslFt), geometric, 'legacy profile alias should carry the locked value');

  const result = scorer.getScore(runwayReferenceElevFt);
  assert.ok(result.score != null, 'plane altitude should provide a valid gate');
  assert(!result.gateFailures.includes('gear_not_down_at_gate'), 'barometric jump must not trigger the gate early');
});

test('altitude selection falls back when an 80%-covered source cannot cover the operational gate', () => {
  const runwayReferenceElevFt = 100;
  const calibrated = [2100, 1900, 1700, 1500, 1300, 1150, 1000, 800, 500, 150];
  // Eight of ten values and a complete tail satisfy generic profile coverage,
  // but the preferred source never reaches the 1,000 ft runway-relative gate.
  const plane = [null, null, 2200, 2100, 2000, 1900, 1800, 1700, 1600, 1201];
  const frames = calibrated.map((altCalibratedFt, index) => makeFrame({
    ra: Math.max(5, altCalibratedFt - runwayReferenceElevFt),
    altPlaneFt: plane[index],
    altCalibratedFt,
    altMslFt: altCalibratedFt,
    wow: index === calibrated.length - 1,
  }));
  const scorer = new SimpleStabilityScorer();
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }

  const result = scorer.getScore(runwayReferenceElevFt);
  assert.ok(result.score != null, 'complete calibrated altitude should provide a valid gate score');
  assert(!result.gateFailures.includes('no_gate_sample'), 'partial plane altitude must not hide a valid lower-priority gate');

  const profile = scorer.getApproachProfile();
  assert(
    profile.every(point => point.profileAltitudeSource === 'calibrated'),
    'profile should reuse the runway-aware source selected for scoring',
  );
  assert.deepStrictEqual(
    profile.map(point => point.profileAltitudeFt),
    calibrated,
    'chart geometry should use the same calibrated datum as gate scoring',
  );
});

test('scoring criteria gate override controls gate selection', () => {
  const frames = [
    makeFrame({ ra: 1800 }),
    makeFrame({ ra: 1500 }),
    makeFrame({ ra: 1400 }),
    makeFrame({ ra: 1300 }),
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1100 }),
  ];

  const defaultGateResult = scoreFrames(frames);
  assert.strictEqual(defaultGateResult.score, null);
  assert.ok(defaultGateResult.gateFailures.includes('no_gate_sample'), 'default 1000 ft gate should not find a sample');

  const profileGateResult = scoreFrames(frames, null, { criteria: { gateRaFt: 1500 } });
  assert.ok(profileGateResult.score != null, 'profile gate criteria should find the 1500 ft sample');
  assert.strictEqual(profileGateResult.criteria.gateRaFt, 1500);
});

test('constructor gate is the default and per-score criteria can override it', () => {
  const frames = [
    makeFrame({ ra: 1800 }),
    makeFrame({ ra: 1500 }),
    makeFrame({ ra: 1400 }),
    makeFrame({ ra: 1300 }),
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1100 }),
  ];

  const constructorScorer = new SimpleStabilityScorer(1500);
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) constructorScorer.addSample(sample);
  }
  const constructorResult = constructorScorer.getScore();
  assert.ok(constructorResult.score != null, 'constructor gate should select the 1500 ft sample');
  assert.strictEqual(constructorResult.criteria.gateRaFt, 1500);

  const overrideScorer = new SimpleStabilityScorer(500);
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) overrideScorer.addSample(sample);
  }
  const overrideResult = overrideScorer.getScore(null, { criteria: { gateRaFt: 1500 } });
  assert.ok(overrideResult.score != null, 'per-score gate should override the constructor default');
  assert.strictEqual(overrideResult.criteria.gateRaFt, 1500);
});

// ─────────────────────────────────────────────────────────────────────────────
// reset() — scorer is reusable
// ─────────────────────────────────────────────────────────────────────────────

test('reset() clears samples and allows a second scoring pass', () => {
  const scorer = new SimpleStabilityScorer();
  const stableFrames = [
    makeFrame({ ra: 1400 }),
    makeFrame({ ra: 1200 }),
    makeFrame({ ra: 1000 }),
    makeFrame({ ra: 800 }),
    makeFrame({ ra: 500 }),
    makeFrame({ ra: 200, wow: true }),
  ];
  for (const f of stableFrames) {
    const s = frameToSample(f);
    if (s) scorer.addSample(s);
  }
  scorer.getScore(); // first use — sets hasScored
  scorer.reset();
  assert.strictEqual(scorer.getSampleCount(), 0, 'Samples cleared after reset');
  for (const f of stableFrames) {
    const s = frameToSample(f);
    if (s) scorer.addSample(s);
  }
  const second = scorer.getScore();
  assert.ok(second.score != null, 'getScore should succeed after reset');
  assert.strictEqual(second.gateStable, true);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
