#!/usr/bin/env node
'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { createPhaseRunner } = require(resolveBackendRuntimeFile('lifecycle', 'phase-runner.js'));
const { PHASES } = require(resolveBackendRuntimeFile('lifecycle', 'phases.js'));
const { createLandingRunner } = require(resolveBackendRuntimeFile('landing', 'landing-runner.js'));
const { runStability, resetStability, SimpleStabilityScorer, frameToSample } = require(resolveBackendRuntimeFile('stability', 'stability-runner.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function withNoise(base, magnitude, random) {
  return base + (random() * 2 - 1) * magnitude;
}

function makePhaseFrame(overrides = {}) {
  return {
    iasKts: 140,
    wow: false,
    vsFpm: -600,
    raFt: 800,
    gsKts: 145,
    altMslFt: 3000,
    aircraftName: 'MC Test Aircraft',
    ...overrides,
  };
}

function runPhaseMonteCarlo() {
  const iterations = 30;
  for (let i = 0; i < iterations; i++) {
    const random = seeded(1000 + i);
    let now = 1_700_000_000_000 + i * 100_000;
    const runner = createPhaseRunner({ timeNow: () => now });

    const broadcast = () => {};
    const goAround = i % 2 === 0;

    if (goAround) {
      for (let t = 0; t < 12; t++) {
        runner.updatePhase(makePhaseFrame({
          wow: false,
          iasKts: withNoise(145, 8, random),
          gsKts: withNoise(148, 8, random),
          vsFpm: withNoise(-700, 180, random),
          raFt: withNoise(650, 220, random),
          altMslFt: withNoise(2200, 220, random),
        }), broadcast);
        now += 1000;
      }

      for (let t = 0; t < 12; t++) {
        runner.updatePhase(makePhaseFrame({
          wow: false,
          iasKts: withNoise(160, 8, random),
          gsKts: withNoise(162, 8, random),
          vsFpm: withNoise(1800, 250, random),
          raFt: withNoise(450, 100, random),
          altMslFt: withNoise(2600, 200, random),
        }), broadcast);
        now += 1000;
      }

      const phase = runner.getPhase();
      assert(
        phase === 'CLIMB' || phase === 'DESCENT',
        `Expected go-around trajectory to end in an airborne phase, got ${phase}`
      );
      continue;
    }

    for (let t = 0; t < 12; t++) {
      runner.updatePhase(makePhaseFrame({
        wow: false,
        iasKts: withNoise(145, 8, random),
        gsKts: withNoise(148, 8, random),
        vsFpm: withNoise(-700, 180, random),
        raFt: withNoise(650, 220, random),
        altMslFt: withNoise(2200, 220, random),
      }), broadcast);
      now += 1000;
    }

    for (let t = 0; t < 12; t++) {
      runner.updatePhase(makePhaseFrame({
        wow: true,
        iasKts: withNoise(35, 10, random),
        gsKts: withNoise(30, 10, random),
        vsFpm: withNoise(0, 80, random),
        raFt: withNoise(0, 5, random),
        altMslFt: withNoise(500, 5, random),
      }), broadcast);
      now += 1000;
    }

    const phase = runner.getPhase();
    assert(
      phase === PHASES.TAXI_IN || phase === PHASES.TAXI || phase === PHASES.PARKED,
      `Expected landing rollout/taxi end-state, got ${phase}`
    );
  }
}

function makeLandingFrame(overrides = {}) {
  return {
    wow: false,
    vs: -3,
    ra: 50,
    ias: 140,
    alt_msl: 1000,
    lights: {},
    gs: 130,
    surface: {
      onGround: true,
      valid: true,
      runwayLike: true,
      onRunway: true,
      raw: 1,
      name: 'Asphalt',
      class: 'dry',
    },
    display: {
      iasKts: 140,
      vsFpm: -600,
      raFt: 120,
    },
    simconnect: {
      lat: null,
      lon: null,
      hdgTrueDeg: 180,
      hdgMagDeg: 180,
    },
    attitudeDebug: {
      pitchDegPrimary: 2,
      bankDegPrimary: 0,
    },
    flaps: 0.85,
    spoilers: { state: 'STOWED', fraction: 0 },
    windSpeed: 8,
    windDir: 220,
    ...overrides,
  };
}

function makeLandingContext() {
  return {
    phase: 'LANDING',
    xwind_kts: 6,
    stability: {
      ultimateScore: {
        overall: 100,
        breakdown: { gear_ok: 100, flaps_ok: 100, spoilers_ok: 100 },
        gateStable: true,
        gateFailures: [],
        samples: 20,
      },
    },
    aircraftName: 'MC Test Aircraft',
    icao: null,
    runway: null,
    approachType: 'VISUAL',
    simVersion: 'test',
    aircraftProfileId: 'generic',
    dataSource: 'test',
  };
}

function runLandingMonteCarlo() {
  const iterations = 20;
  for (let i = 0; i < iterations; i++) {
    const random = seeded(2000 + i);
    const runner = createLandingRunner();
    const emissions = [];
    const broadcast = (payload) => emissions.push(payload);

    const t0 = 1_700_100_000_000 + i * 200_000;
    const now = (offset) => ({
      nowEpochMs: t0 + offset,
      nowIso: new Date(t0 + offset).toISOString(),
    });

    runner.update(
      makeLandingFrame({ wow: false, display: { iasKts: 145, vsFpm: withNoise(-700, 150, random), raFt: 150 } }),
      broadcast,
      now(0),
      makeLandingContext()
    );

    runner.update(
      makeLandingFrame({ wow: true, display: { iasKts: 140, vsFpm: withNoise(-120, 80, random), raFt: 5 } }),
      broadcast,
      now(100),
      makeLandingContext()
    );

    const bounceCount = Math.floor(random() * 3);
    for (let bounce = 0; bounce < bounceCount; bounce++) {
      runner.update(
        makeLandingFrame({ wow: false, display: { iasKts: 120, vsFpm: withNoise(-450, 130, random), raFt: 35 } }),
        broadcast,
        now(200 + bounce * 200),
        makeLandingContext()
      );
      runner.update(
        makeLandingFrame({ wow: true, display: { iasKts: 110, vsFpm: withNoise(-120, 80, random), raFt: 2 } }),
        broadcast,
        now(300 + bounce * 200),
        makeLandingContext()
      );
    }

    runner.update(
      makeLandingFrame({ wow: true, display: { iasKts: 70, vsFpm: 0, raFt: 0 } }),
      broadcast,
      now(120000),
      makeLandingContext()
    );

    const final = emissions.find((event) => event && event.type === 'landing' && event.final === true);
    assert(final, `Iteration ${i}: expected final landing event`);
    assert(final.touchdownDistance, `Iteration ${i}: expected touchdownDistance payload`);
    assert(Number.isFinite(final.touchdownDistance.bounceCount), `Iteration ${i}: bounceCount should be numeric`);
  }
}

function makeStabilityFrame(overrides = {}) {
  // engineLevels is the per-engine convention used by the live SimConnect
  // provider; normalizeFrame() consumes a single averaged `thrust` field.
  // Convert here so callers can keep the array form for readability.
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
    merged.thrust = merged.engineLevels.reduce((sum, v) => sum + v, 0) / merged.engineLevels.length;
  }
  return merged;
}

function scoreApproach(frames) {
  // Mirrors the CSV-replay loop in events/timeline-generator.js: build a
  // fresh scorer per approach, push every valid sample, then call getScore
  // exactly once at touchdown.
  const scorer = new SimpleStabilityScorer();
  for (const frame of frames) {
    const sample = frameToSample(frame);
    if (sample) scorer.addSample(sample);
  }
  return scorer.getScore();
}

function runStabilityMonteCarlo() {
  const iterations = 20;

  for (let i = 0; i < iterations; i++) {
    const random = seeded(3000 + i);

    // runStability() is now a shim that always returns ultimateScore=null
    // (legacy per-tick scoring was removed in early 2026). Scoring happens via
    // SimpleStabilityScorer in the CSV-replay path; this Monte Carlo replays
    // synthetic frames through the same scorer to validate that stable vs.
    // unstable approaches are clearly separable.
    const stableFrames = [];
    for (let t = 0; t < 24; t++) {
      const ra = Math.max(200, 1500 - t * 55);
      stableFrames.push(makeStabilityFrame({
        wow: t === 23,
        ra,
        ias: withNoise(145, 4, random),
        gs: withNoise(140, 4, random),
        vs: withNoise(-700, 120, random),
        engineLevels: [withNoise(58, 5, random), withNoise(58, 5, random)],
      }));
      // Smoke-call the live shim so its IMC/debug-logging path stays
      // exercised by the regression suite even though it no longer scores.
      runStability(stableFrames[stableFrames.length - 1]);
    }
    const stableResult = scoreApproach(stableFrames);
    assert(stableResult && stableResult.score != null, `Stable iteration ${i}: missing stability score`);

    resetStability();
    const unstableFrames = [];
    for (let t = 0; t < 24; t++) {
      const ra = Math.max(200, 1500 - t * 55);
      unstableFrames.push(makeStabilityFrame({
        wow: t === 23,
        ra,
        ias: withNoise(165, 16, random),
        gs: withNoise(120, 22, random),
        vs: withNoise(-1300, 350, random),
        engineLevels: [withNoise(20, 18, random), withNoise(20, 18, random)],
      }));
      runStability(unstableFrames[unstableFrames.length - 1]);
    }
    const unstableResult = scoreApproach(unstableFrames);
    assert(unstableResult && unstableResult.score != null, `Unstable iteration ${i}: missing stability score`);

    assert(
      stableResult.score > unstableResult.score,
      `Iteration ${i}: expected stable score (${stableResult.score}) > unstable score (${unstableResult.score})`
    );
  }
}

console.log('\n=== Monte Carlo Runner Regression Tests ===');

test('phase runner Monte Carlo scenarios produce valid end-states', runPhaseMonteCarlo);
test('landing runner Monte Carlo scenarios emit final landing events', runLandingMonteCarlo);
test('stability runner Monte Carlo scenarios separate stable vs unstable', runStabilityMonteCarlo);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
