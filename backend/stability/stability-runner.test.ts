#!/usr/bin/env node
// stability-runner.test.ts
//
// Unit tests for normalizeFrame() and frameToSample() — the pure, exported
// functions in stability-runner.
//
// Focus areas:
//   1. Spoilers suppression path: when state/percent/fraction are all null
//      (profile marked simVarReliable:false, no SDK connected), spoilersRetracted
//      must be TRUE and rawSpoilers must be NULL so the stability scorer does not
//      penalise the approach for missing data.
//   2. Normal spoilers states (STOWED / ARMED / EXTENDED / numeric percent).
//   3. frameToSample passthrough of suppressed values into the sample object.
//
// Run with: node dist/backend/stability/stability-runner.test.js

'use strict';

type NormalizeFrameFn = (frame: Record<string, unknown>) => Record<string, unknown> | null;
type FrameToSampleFn = (frame: Record<string, unknown>) => Record<string, unknown> | null;
type StabilityRunnerModule = {
  normalizeFrame: NormalizeFrameFn;
  frameToSample: FrameToSampleFn;
  SimpleStabilityScorer: new (gateRaFt?: number) => {
    addSample: (sample: Record<string, unknown>) => void;
    getScore: (thresholdElevFt?: number | null, scoringContext?: Record<string, unknown>) => Record<string, any>;
  };
  resolveGlidepathAngleForApproach: (input?: { airportIcao?: unknown; runwayId?: unknown }) => { angleDeg: number; source: string };
  targetVerticalSpeedForGlidepath: (gsKts: number, angleDeg?: number) => number;
  verticalSpeedFactorForGlidepath: (angleDeg?: number) => number;
};
type HarnessModule = {
  createHarness: () => {
    test: (name: string, fn: () => void) => void;
    assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
    assertTrue: (value: unknown, message?: string) => void;
    summary: (label: string) => void;
  };
};

const {
  normalizeFrame,
  frameToSample,
  SimpleStabilityScorer,
  resolveGlidepathAngleForApproach,
  targetVerticalSpeedForGlidepath,
  verticalSpeedFactorForGlidepath,
} = require('./stability-runner') as StabilityRunnerModule;
const { resolveStabilityPolicy, buildStabilityScoringContext } = require('./stability-policy') as {
  resolveStabilityPolicy: (input: Record<string, unknown>) => Record<string, any>;
  buildStabilityScoringContext: (input: Record<string, unknown>) => Record<string, any>;
};
const { normalizeRetiredSpoilerStability } = require('./retired-spoiler-compat') as {
  normalizeRetiredSpoilerStability: (value: unknown) => Record<string, any> | null;
};
const { createHarness } = require('../../tests/support/mini-test-harness') as HarnessModule;

const { test, assertEqual, assertTrue, summary } = createHarness();

console.log('\nStability policy — common game rules');

test('generic and transport profiles use the same versioned policy', () => {
  const commonCriteria = { gateRaFt: 1000, speedMinusKts: 5, speedPlusKts: 5 };
  const generic = resolveStabilityPolicy({
    profile: { id: 'generic', aircraft: { category: 'C' } },
    commonCriteria,
    profileCriteria: { speedMinusKts: 50, speedPlusKts: 100 },
  });
  const airliner = resolveStabilityPolicy({
    profile: { id: 'fbw-a32nx', aircraft: { category: 'C' } },
    commonCriteria,
    profileCriteria: { speedMinusKts: 5, speedPlusKts: 15 },
  });

  assertEqual(generic.id, 'transport-v2');
  assertEqual(airliner.id, 'transport-v2');
  assertEqual(generic.criteria.speedPlusKts, airliner.criteria.speedPlusKts);
  assertEqual(generic.profileCriteriaApplied, false);
});

test('category-A profile keeps its GA scoring limits', () => {
  const resolved = resolveStabilityPolicy({
    profile: { id: 'ga-base', aircraft: { category: 'A' } },
    commonCriteria: { gateRaFt: 1000, vsMinFpm: -1000 },
    profileCriteria: { gateRaFt: 500, vsMinFpm: -800 },
  });
  assertEqual(resolved.id, 'ga-profile-v2');
  assertEqual(resolved.criteria.gateRaFt, 500);
  assertEqual(resolved.profileCriteriaApplied, true);
});

test('recorded scoring context carries policy identity and metric coverage', () => {
  const policy = resolveStabilityPolicy({
    profile: { id: 'generic', aircraft: { category: 'C' } },
    commonCriteria: { gateRaFt: 1000 },
  });
  const context = buildStabilityScoringContext({
    scoreResult: {
      criteria: policy.criteria,
      coverage: { scoredMetrics: 6, totalMetrics: 8, metrics: {} },
    },
    profile: { id: 'generic', name: 'Generic Aircraft' },
    policy,
  });
  assertEqual(context.schemaVersion, 3);
  assertEqual(context.policy.id, 'transport-v2');
  assertEqual(context.verdictPolicy.id, 'approach-stability-verdict');
  assertEqual(context.verdictPolicy.severeMetricFloorPct, 60);
  assertEqual(context.coverage.scoredMetrics, 6);
});

// Minimal valid fields needed for frameToSample to return non-null.
// (raFt, iasKts, vsFpm must be finite numbers.)
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ra: 500, ias: 140, vs: -700, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeFrame — spoilersRetracted
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnormalizeFrame — spoilersRetracted');

test('suppressed object (all null) → retracted=true, percent=null', () => {
  const n = normalizeFrame(base({
    spoilers: { state: null, percent: null, fraction: null, available: false },
  }));
  assertEqual(n.spoilersRetracted, true,  'suppressed → should be retracted');
  assertEqual(n.spoilersPercent,   null,  'suppressed percent should be null');
  assertEqual(n.spoilersState,     null,  'suppressed state should be null');
});

test('STOWED → retracted=true', () => {
  const n = normalizeFrame(base({
    spoilers: { state: 'STOWED', percent: 0, fraction: 0 },
  }));
  assertEqual(n.spoilersRetracted, true, 'STOWED → retracted');
});

test('ARMED → retracted=true (correct procedure, auto-deploy on landing)', () => {
  const n = normalizeFrame(base({
    spoilers: { state: 'ARMED', percent: 0, fraction: 0 },
  }));
  assertEqual(n.spoilersRetracted, true, 'ARMED → retracted');
});

test('EXTENDED → retracted=false', () => {
  const n = normalizeFrame(base({
    spoilers: { state: 'EXTENDED', percent: 50, fraction: 0.5 },
  }));
  assertEqual(n.spoilersRetracted, false, 'EXTENDED → not retracted');
});

test('percent < 5 with no state → retracted=true (noise floor)', () => {
  const n = normalizeFrame(base({
    spoilers: { percent: 3, fraction: 0.03 },
  }));
  assertEqual(n.spoilersRetracted, true, 'low percent → retracted');
});

test('percent >= 5 with no state → retracted=false', () => {
  const n = normalizeFrame(base({
    spoilers: { percent: 10, fraction: 0.1 },
  }));
  assertEqual(n.spoilersRetracted, false, 'percent >=5 without state → not retracted');
});

test('fraction only (no percent field) → derived correctly', () => {
  const n = normalizeFrame(base({
    spoilers: { fraction: 0.5 },
  }));
  // fraction * 100 = 50 → not retracted
  assertEqual(n.spoilersPercent,   50,    'fraction→percent derivation');
  assertEqual(n.spoilersRetracted, false, 'derived 50% → not retracted');
});

test('spoilers: null → retracted=true (no data = no penalty)', () => {
  const n = normalizeFrame(base({ spoilers: null }));
  assertEqual(n.spoilersRetracted, true, 'null spoilers → retracted');
});

test('spoilers absent → retracted=true', () => {
  const n = normalizeFrame(base());
  assertEqual(n.spoilersRetracted, true, 'absent spoilers → retracted');
});

test('spoilers: numeric (legacy path) → percent set, retracted always true (no state = no penalty)', () => {
  // When spoilers is a plain number there is no state string, so the code
  // cannot distinguish "30% extended" from "30% transient noise". It falls
  // to the else-branch and conservatively assumes retracted to avoid false
  // penalisation on old/simple data. This is correct intentional behaviour.
  const low = normalizeFrame(base({ spoilers: 3 }));
  assertEqual(low.spoilersPercent,   3,    'numeric → percent extracted');
  assertEqual(low.spoilersRetracted, true, 'numeric, no state → conservative retracted=true');

  const high = normalizeFrame(base({ spoilers: 30 }));
  assertEqual(high.spoilersPercent,   30,   'numeric 30 → percent extracted');
  assertEqual(high.spoilersRetracted, true, 'numeric, no state → conservative retracted=true');
});

test('explicit input.spoilersRetracted:boolean overrides object analysis', () => {
  // Should trust a boolean override regardless of the spoilers object content.
  const n = normalizeFrame(base({
    spoilersRetracted: false,
    spoilers: { state: 'STOWED', percent: 0 },
  }));
  assertEqual(n.spoilersRetracted, false, 'boolean override false beats STOWED');

  const n2 = normalizeFrame(base({
    spoilersRetracted: true,
    spoilers: { state: 'EXTENDED', percent: 80 },
  }));
  assertEqual(n2.spoilersRetracted, true, 'boolean override true beats EXTENDED');
});

// ─────────────────────────────────────────────────────────────────────────────
// frameToSample — suppressed values flow through to sample fields
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nframeToSample — suppressed spoilers passthrough');

test('suppressed spoilers → sample.spoilersRetracted=true, rawSpoilers=null', () => {
  const sample = frameToSample(base({
    spoilers: { state: null, percent: null, fraction: null, available: false },
  }));
  assertTrue(sample !== null, 'frameToSample should return a sample');
  assertEqual(sample.spoilersRetracted, true, 'sample.spoilersRetracted must be true for suppressed data');
  assertEqual(sample.rawSpoilers,       null, 'sample.rawSpoilers must be null for suppressed data');
});

test('EXTENDED spoilers → sample.spoilersRetracted=false, rawSpoilers=50', () => {
  const sample = frameToSample(base({
    spoilers: { state: 'EXTENDED', percent: 50, fraction: 0.5 },
  }));
  assertTrue(sample !== null, 'frameToSample should return a sample');
  assertEqual(sample.spoilersRetracted, false, 'EXTENDED → not retracted in sample');
  assertEqual(sample.rawSpoilers,       50,    'rawSpoilers should be 50');
});

test('ARMED spoilers → sample.spoilersRetracted=true, rawSpoilers=0', () => {
  const sample = frameToSample(base({
    spoilers: { state: 'ARMED', percent: 0, fraction: 0 },
  }));
  assertTrue(sample !== null, 'frameToSample should return a sample');
  assertEqual(sample.spoilersRetracted, true, 'ARMED → retracted in sample');
  assertEqual(sample.rawSpoilers,       0,    'rawSpoilers=0 for ARMED');
});

test('frameToSample returns null when required fields missing', () => {
  const sample = frameToSample({ spoilers: { state: 'STOWED', percent: 0 } });
  assertEqual(sample, null, 'missing ra/ias/vs → null sample');
});

// ─────────────────────────────────────────────────────────────────────────────
// SimpleStabilityScorer — non-standard glidepath angle
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nSimpleStabilityScorer — glidepath angle overrides');

function stableApproachSample(raFt: number, gsKts: number, vsFpm: number): Record<string, unknown> {
  return {
    raFt,
    iasKts: 140,
    vsFpm,
    altMslFt: null,
    gearDown: true,
    flapsLanding: true,
    spoilersRetracted: true,
    rawGear: 1,
    rawFlaps: 30,
    rawSpoilers: 0,
    onGround: false,
    gsKts,
    pitchDeg: 3,
    bankDeg: 0,
    thrustPct: 35,
    headingDeg: null,
    latDeg: null,
    lonDeg: null,
    dtMs: 1000,
  };
}

function scoreSteepApproach(context: Record<string, unknown> = {}): Record<string, any> {
  const scorer = new SimpleStabilityScorer();
  const gsKts = 140;
  const targetVsFpm = targetVerticalSpeedForGlidepath(gsKts, 5.5);
  for (const raFt of [1200, 950, 750, 550, 350, 150]) {
    scorer.addSample(stableApproachSample(raFt, gsKts, targetVsFpm));
  }
  return scorer.getScore(null, context);
}

test('EGLC override uses 5.5° glidepath and relaxes VS floor for steep approach', () => {
  const defaultScore = scoreSteepApproach();
  assertEqual(defaultScore.criteria.glidepathAngleDeg, 3, 'default glidepath angle should remain 3°');
  assertEqual(defaultScore.breakdown.glidepath_ok, 0, '5.5° profile should fail default 3° glidepath proxy');
  assertEqual(defaultScore.breakdown.vs_ok, 0, '5.5° profile should fail default VS floor');

  const override = resolveGlidepathAngleForApproach({ airportIcao: 'EGLC', runwayId: '09' });
  assertEqual(override.angleDeg, 5.5, 'EGLC should resolve to 5.5°');

  const eglcScore = scoreSteepApproach({ airportIcao: 'EGLC', runwayId: '09' });
  assertEqual(eglcScore.criteria.glidepathAngleDeg, 5.5, 'EGLC scoring should use 5.5°');
  assertEqual(eglcScore.breakdown.glidepath_ok, 100, '5.5° profile should pass EGLC glidepath proxy');
  assertEqual(eglcScore.breakdown.glidepath_below_ok, 100, '5.5° profile should pass EGLC below-path check');
  assertEqual(eglcScore.breakdown.glidepath_above_ok, 100, '5.5° profile should pass EGLC above-path check');
  assertEqual(eglcScore.breakdown.vs_ok, 100, 'EGLC glidepath should relax steep-approach VS floor');
});

test('glidepath overrides are runway-specific and normalize runway IDs', () => {
  assertEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'EGLC' }).angleDeg,
    3,
    'EGLC without runway should not apply a blind airport-wide override',
  );
  assertEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'EGLC', runwayId: '9' }).angleDeg,
    5.5,
    'EGLC runway 9 should normalize to runway 09',
  );
  assertEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'EGLC', runwayId: '27' }).angleDeg,
    5.5,
    'EGLC runway 27 should use 5.5°',
  );
  assertEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'LSZA', runwayId: '01' }).angleDeg,
    6.65,
    'LSZA runway 01 should use 6.65°',
  );
  assertEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'LOWI', runwayId: '26' }).angleDeg,
    3.77,
    'LOWI runway 26 should use 3.77°',
  );
  assertEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'LOWI', runwayId: '08' }).angleDeg,
    3,
    'LOWI runway 08 should keep the default unless a runway-specific entry exists',
  );
});

test('non-overridden airports keep default 3° behavior exactly', () => {
  assertEqual(verticalSpeedFactorForGlidepath(3), 5.31, '3° factor should keep legacy 5.31 constant');
  assertEqual(
    resolveGlidepathAngleForApproach({ airportIcao: 'KJFK', runwayId: '04L' }).angleDeg,
    3,
    'non-overridden airport should resolve to default 3°',
  );

  const scoreDefault = scoreSteepApproach();
  const scoreNonOverride = scoreSteepApproach({ airportIcao: 'KJFK', runwayId: '04L' });
  assertEqual(scoreNonOverride.criteria.glidepathAngleDeg, scoreDefault.criteria.glidepathAngleDeg, 'criteria angle should match default');
  assertEqual(scoreNonOverride.breakdown.vs_ok, scoreDefault.breakdown.vs_ok, 'VS score should match default');
  assertEqual(scoreNonOverride.breakdown.glidepath_ok, scoreDefault.breakdown.glidepath_ok, 'glidepath score should match default');
  assertEqual(scoreNonOverride.score, scoreDefault.score, 'overall score should match default');
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeFrame — spoilers state string passthrough
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nSimpleStabilityScorer — spoiler movement discipline');

function spoilerApproachSample(raFt: number, rawSpoilers: number): Record<string, unknown> {
  return {
    ...stableApproachSample(raFt, 140, -700),
    rawSpoilers,
    spoilersRetracted: rawSpoilers <= 1,
  };
}

test('constructor gate is used by default and explicit criteria override it', () => {
  const samples = [1800, 1500, 1400, 1300, 1200, 1100]
    .map(raFt => stableApproachSample(raFt, 140, -700));

  const constructorScorer = new SimpleStabilityScorer(1500);
  for (const sample of samples) constructorScorer.addSample(sample);
  const constructorResult = constructorScorer.getScore();
  assertTrue(constructorResult.score !== null, 'constructor gate should find the 1500 ft sample');
  assertEqual(constructorResult.criteria.gateRaFt, 1500, 'constructor gate should populate scoring criteria');
  assertEqual(constructorResult.reference.gateIasKts, 140, 'score should retain the IAS used as the speed reference');
  assertEqual(constructorResult.reference.gateHeightFt, 1500, 'score should retain the selected gate height');
  assertEqual(constructorResult.reference.altitudeSource, 'radio', 'score should retain the selected altitude source');

  const overrideScorer = new SimpleStabilityScorer(500);
  for (const sample of samples) overrideScorer.addSample(sample);
  const overrideResult = overrideScorer.getScore(null, { criteria: { gateRaFt: 1500 } });
  assertTrue(overrideResult.score !== null, 'explicit criteria should override the constructor gate');
  assertEqual(overrideResult.criteria.gateRaFt, 1500, 'explicit gate should populate scoring criteria');
});

test('spoiler movement is neutral in stability scoring', () => {
  const baselineScorer = new SimpleStabilityScorer();
  const movingSpoilerScorer = new SimpleStabilityScorer();
  const heights = [1200, 950, 750, 550, 350, 150];
  const movingValues = [0, 76, 0, 34, 0, 100];
  for (let i = 0; i < heights.length; i++) {
    baselineScorer.addSample(spoilerApproachSample(heights[i], 0));
    movingSpoilerScorer.addSample(spoilerApproachSample(heights[i], movingValues[i]));
  }

  const baseline = baselineScorer.getScore(null);
  const moving = movingSpoilerScorer.getScore(null);
  assertEqual(moving.score, baseline.score, 'spoiler telemetry should not alter the headline score');
  assertEqual(moving.breakdown.spoilers_ok, 100, 'compatibility field should stay neutral');
  assertEqual(moving.breakdown.config_ok, 100, 'configuration should depend on gear and flaps only');
  assertEqual(moving.gateFailures.includes('spoilers_moved_after_gate'), false, 'spoilers should not add a gate failure');
});

test('saved spoiler penalties are removed without hiding unrelated failures', () => {
  const normalized = normalizeRetiredSpoilerStability({
    score: 75,
    gateStable: false,
    gateFailures: ['spoilers_moved_after_gate', 'glidepath_proxy_unstable_after_gate'],
    breakdown: {
      config_ok: 0,
      gear_ok: 100,
      flaps_ok: 100,
      spoilers_ok: 0,
      speed_ok: 85,
      speed_trend_ok: 86,
      vs_ok: 96,
      glidepath_ok: 51,
      thrust_ok: 81,
      pitch_ok: 100,
      bank_ok: 100,
      lateral_offset_ok: 100,
    },
  });

  assertEqual(normalized?.score, 89, 'headline score should be recomputed from the active metrics');
  assertEqual(normalized?.breakdown.spoilers_ok, 100, 'retired compatibility field should be neutral');
  assertEqual(normalized?.breakdown.config_ok, 100, 'configuration should be recomputed from gear and flaps');
  assertEqual(normalized?.gateStable, false, 'unrelated failures should still make the gate unstable');
  assertEqual(normalized?.verdict, 'marginal', 'soft path-only finding should normalize to marginal');
  assertEqual(
    normalized?.gateFailures.join('|'),
    'glidepath_proxy_unstable_after_gate',
    'only the retired spoiler failure should be removed',
  );
});

console.log('\nnormalizeFrame — spoilersState passthrough');

test('FULL state passes through', () => {
  const n = normalizeFrame(base({
    spoilers: { state: 'FULL', percent: 100, fraction: 1 },
  }));
  assertEqual(n.spoilersState,     'FULL', 'FULL state preserved');
  assertEqual(n.spoilersRetracted, false,  'FULL → not retracted');
});

test('null state with non-null percent uses percent for retracted decision', () => {
  const n = normalizeFrame(base({
    spoilers: { state: null, percent: 30 },
  }));
  assertEqual(n.spoilersState,     null,  'null state preserved');
  assertEqual(n.spoilersPercent,   30,    'percent preserved');
  assertEqual(n.spoilersRetracted, false, '30% → not retracted even with null state');
});

// ─────────────────────────────────────────────────────────────────────────────

summary('stability-runner spoilers');

export {};
