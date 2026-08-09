#!/usr/bin/env node
/**
 * Focused regression tests for landing-runner fail-safe behavior.
 */

'use strict';

const assert = require('assert');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const landingRunnerPath = resolveBackendRuntimeFile('landing', 'landing-runner.js');
const runwayDatabasePath = resolveBackendRuntimeFile('landing', 'runway-database.js');
const phasePath = resolveBackendRuntimeFile('lifecycle', 'phase.js');
const configPath = resolveBackendRuntimeFile('core', 'config.js');
const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));
const { getCriticalLandingCsvMappings } = require(resolveBackendRuntimeFile('flight-recording', 'landing-csv-contract.js'));
const { buildRow } = require(resolveBackendRuntimeFile('flight-recording', 'schema-field-map.js'));

function createLandingRunner() {
  return require(landingRunnerPath).createLandingRunner();
}

function withTouchdownMinVsConfig(value, fn) {
  const envName = 'LANDING_TOUCHDOWN_MIN_VS_FPM';
  const previousEnv = process.env[envName];
  const previousLandingRunner = require.cache[landingRunnerPath];
  const previousConfig = require.cache[configPath];

  process.env[envName] = String(value);
  delete require.cache[landingRunnerPath];
  delete require.cache[configPath];

  try {
    const { createLandingRunner: createWithConfig } = require(landingRunnerPath);
    fn(createWithConfig);
  } finally {
    delete require.cache[landingRunnerPath];
    if (previousLandingRunner) require.cache[landingRunnerPath] = previousLandingRunner;

    delete require.cache[configPath];
    if (previousConfig) require.cache[configPath] = previousConfig;

    if (previousEnv === undefined) delete process.env[envName];
    else process.env[envName] = previousEnv;
  }
}

function withMockRunwayProvider(mockRunwayDatabase, fn) {
  const previousLandingRunner = require.cache[landingRunnerPath];
  const previousRunwayDatabase = require.cache[runwayDatabasePath];

  delete require.cache[landingRunnerPath];
  require.cache[runwayDatabasePath] = {
    id: runwayDatabasePath,
    filename: runwayDatabasePath,
    loaded: true,
    exports: mockRunwayDatabase,
  };

  try {
    const { createLandingRunner: createWithMockRunway } = require(landingRunnerPath);
    fn(createWithMockRunway);
  } finally {
    delete require.cache[landingRunnerPath];
    if (previousLandingRunner) require.cache[landingRunnerPath] = previousLandingRunner;

    delete require.cache[runwayDatabasePath];
    if (previousRunwayDatabase) require.cache[runwayDatabasePath] = previousRunwayDatabase;
  }
}

function withMockRunway(runwayData, fn) {
  withMockRunwayProvider({
    findRunwayByPosition: () => runwayData,
    getRunway: () => runwayData,
  }, fn);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

function makeFrame(overrides = {}) {
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
    gforce: 1.25,
    ...overrides,
  };
}

function withMockPhaseThresholds(getThresholds, fn) {
  const previousLandingRunner = require.cache[landingRunnerPath];
  const previousPhase = require.cache[phasePath];

  delete require.cache[landingRunnerPath];
  require.cache[phasePath] = {
    id: phasePath,
    filename: phasePath,
    loaded: true,
    exports: { getEffectivePhaseThresholds: getThresholds },
  };

  try {
    const { createLandingRunner: createWithMockPhase } = require(landingRunnerPath);
    fn(createWithMockPhase);
  } finally {
    delete require.cache[landingRunnerPath];
    if (previousLandingRunner) require.cache[landingRunnerPath] = previousLandingRunner;

    delete require.cache[phasePath];
    if (previousPhase) require.cache[phasePath] = previousPhase;
  }
}

function makeCtx(overrides = {}) {
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
    aircraftName: 'Test Aircraft',
    icao: null,
    runway: null,
    approachType: 'VISUAL',
    simVersion: 'test',
    aircraftProfileId: 'generic',
    dataSource: 'test',
    ...overrides,
  };
}

function finalizeLanding(createRunner, touchdownFrame, ctxOverrides = {}) {
  const runner = createRunner();
  const out = [];
  const broadcast = (payload) => out.push(payload);
  const t0 = 1_700_200_000_000;
  const ctx = makeCtx(ctxOverrides);

  runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -600, raFt: 120 } }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
  runner.update(makeFrame({ ...touchdownFrame, wow: true }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);
  runner.update(makeFrame({ ...touchdownFrame, wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), broadcast, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  assert(finalEvent, 'Expected final landing event');
  return finalEvent;
}

test('update is safe with invalid frame and non-function broadcast', () => {
  const runner = createLandingRunner();
  assert.doesNotThrow(() => runner.update(null, null, null, makeCtx()));
  assert.doesNotThrow(() => runner.update(undefined, 'not-a-fn', {}, makeCtx()));
});

test('first touchdown still produces final landing event and bounce fields', () => {
  const runner = createLandingRunner();
  const out = [];
  const broadcast = (payload) => out.push(payload);

  const t0 = 1_700_000_000_000;

  // Init airborne
  runner.update(makeFrame({ wow: false }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, makeCtx());

  // First touchdown
  runner.update(makeFrame({ wow: true }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, makeCtx());

  const earlyEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === false);
  assert(earlyEvent, 'Expected an immediate non-final landing broadcast for in-sim consumers');
  assert.strictEqual(typeof earlyEvent.vs, 'number', 'Expected immediate landing broadcast to include touchdown VS');
  assert.strictEqual(typeof earlyEvent.grade, 'string', 'Expected immediate landing broadcast to include touchdown grade');

  // Bounce: short airborne then touchdown again (within cooldown)
  runner.update(makeFrame({ wow: false }), broadcast, { nowEpochMs: t0 + 200, nowIso: new Date(t0 + 200).toISOString() }, makeCtx());
  runner.update(makeFrame({ wow: true }), broadcast, { nowEpochMs: t0 + 300, nowIso: new Date(t0 + 300).toISOString() }, makeCtx());

  // Rollout window expiration to force finalization
  runner.update(makeFrame({ wow: true }), broadcast, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, makeCtx());

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  assert(finalEvent, 'Expected a final landing broadcast event');
  assert(finalEvent.touchdownDistance, 'Expected touchdownDistance object on final event');

  // Fail-safe expectation: bounce fields should exist even without runway distance context
  assert(finalEvent.touchdownDistance.bounceCount >= 1, 'Expected bounceCount >= 1');
  assert(finalEvent.touchdownDistance.bounceScore != null, 'Expected bounceScore to be populated');
  assert(finalEvent.touchdownDistance.bounceGrade != null, 'Expected bounceGrade to be populated');
});

test('brief WOW dropout without lift or meaningful second impact stays clean', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_050_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({
      wow: false,
      fdm: { altPlaneFt: 1980.5 },
      simconnect: { lat: 40, lon: -3, hdgTrueDeg: 180, hdgMagDeg: 180 },
      display: { iasKts: 158, vsFpm: -300, raFt: 120 },
    }), () => {}, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.2,
      fdm: { altPlaneFt: 1980.2 },
      simconnect: { lat: 40, lon: -3, hdgTrueDeg: 180, hdgMagDeg: 180 },
      display: { iasKts: 157, vsFpm: -250, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);

    // Roll on the runway before a 435 ms WOW false interval. Geometric and
    // radio altitude continue downward, matching the Spain log signature.
    runner.update(makeFrame({
      wow: true,
      gforce: 1.0,
      fdm: { altPlaneFt: 1980.0 },
      simconnect: { lat: 40, lon: -2.9989, hdgTrueDeg: 180, hdgMagDeg: 180 },
      display: { iasKts: 155, vsFpm: -20, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1200, nowIso: new Date(t0 + 1200).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1979.8 },
      simconnect: { lat: 40, lon: -2.9988, hdgTrueDeg: 180, hdgMagDeg: 180 },
      display: { iasKts: 154, vsFpm: -40, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1300, nowIso: new Date(t0 + 1300).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1979.6 },
      simconnect: { lat: 40, lon: -2.9986, hdgTrueDeg: 180, hdgMagDeg: 180 },
      display: { iasKts: 153, vsFpm: -101.2, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1500, nowIso: new Date(t0 + 1500).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.05,
      fdm: { altPlaneFt: 1979.3 },
      simconnect: { lat: 40, lon: -2.9984, hdgTrueDeg: 180, hdgMagDeg: 180 },
      display: { iasKts: 152, vsFpm: -20, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1735, nowIso: new Date(t0 + 1735).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      fdm: { altPlaneFt: 1979.3 },
      display: { iasKts: 60, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 0, 'Uncorroborated WOW dropout must not be labeled a bounce');
  assert.strictEqual(finalPayload.bounce_grade, 'Clean', 'Uncorroborated WOW dropout must remain clean');
  assert.strictEqual(finalPayload.bounce_distance_ft, 0, 'Uncorroborated WOW dropout must not add bounce distance');
  assert.strictEqual(finalPayload.final_touchdown_lat, null, 'Unconfirmed contact must not replace the physical touchdown');
});

test('conventional V/S and sustained shallow hop agree across final live outputs', () => {
  const runner = createLandingRunner();
  const broadcasts = [];
  const broadcast = (payload) => broadcasts.push(payload);
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_052_000_000;
  const ctx = makeCtx({ aircraftProfileId: 'fbw-a32nx' });
  const previousTouchdown = {
    latDeg: 0.01,
    lonDeg: 0.01,
    headingTrueDeg: 20,
    headingMagDeg: 20,
    pitchDeg: 2,
    bankDeg: 1,
    normalVelocityFps: 4,
    normalVelocityFpm: 240,
  };
  const freshTouchdown = {
    latDeg: 0.0001,
    lonDeg: 0,
    headingTrueDeg: 5,
    headingMagDeg: 4,
    pitchDeg: 6.2,
    bankDeg: -1.5,
    normalVelocityFps: 5.82,
    normalVelocityFpm: 349.2,
  };

  try {
    runner.update(makeFrame({
      wow: false,
      fdm: { altPlaneFt: 1000.5 },
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: previousTouchdown },
      display: { iasKts: 140, vsFpm: -243.3, raFt: 100 },
    }), broadcast, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.15,
      fdm: { altPlaneFt: 1000 },
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: freshTouchdown },
      display: { iasKts: 138, vsFpm: -243, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 100 }, ctx);

    // Mirrors the sampled signature from the latest flight: WOW remains false
    // for 935 ms while RA, geometric altitude, and upward VS each rise slightly,
    // but every signal remains below its existing hard threshold.
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1000.2 },
      display: { iasKts: 136, vsFpm: 30, raFt: 0.1 },
    }), broadcast, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1000.8 },
      display: { iasKts: 134, vsFpm: 48, raFt: 0.4 },
    }), broadcast, { nowEpochMs: t0 + 700 }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1000.5 },
      display: { iasKts: 132, vsFpm: 10, raFt: 0.2 },
    }), broadcast, { nowEpochMs: t0 + 1100 }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.08,
      fdm: { altPlaneFt: 1000.1 },
      display: { iasKts: 130, vsFpm: -15, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 1235 }, ctx);
    runner.update(makeFrame({
      wow: true,
      fdm: { altPlaneFt: 1000.1 },
      display: { iasKts: 60, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalBroadcast = broadcasts.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalBroadcast, 'Expected final WebSocket landing broadcast');
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalBroadcast.vs, -243.3, 'Final WebSocket headline should use conventional recent-airborne V/S');
  assert.strictEqual(finalBroadcast.grade, 'GOOD', 'Final WebSocket grade should use the recorded A32NX profile');
  assert.strictEqual(finalBroadcast.touchdownDistance.bounceCount, 1, 'Final WebSocket should report one shallow bounce');
  assert.strictEqual(finalBroadcast.touchdownDistance.bounceGrade, 'Single Bounce', 'Final WebSocket should report bounce grade');
  assert.strictEqual(finalPayload.vs_fpm, finalBroadcast.vs, 'Final event-bus and WebSocket rates must agree');
  assert.strictEqual(finalPayload.grade, finalBroadcast.grade, 'Final event-bus and WebSocket grades must agree');
  assert.strictEqual(finalPayload.bounce_count, 1, 'Sustained corroborated shallow hop should count once');
  assert.strictEqual(finalPayload.bounce_grade, 'Single Bounce', 'Shallow hop should no longer be reported as clean');
  assert.strictEqual(finalPayload.bounce_count, finalBroadcast.touchdownDistance.bounceCount, 'Final outputs must agree on bounce count');
  assert.strictEqual(finalPayload.bounce_grade, finalBroadcast.touchdownDistance.bounceGrade, 'Final outputs must agree on bounce grade');
  assert.strictEqual(finalPayload.td_sim_trusted, true, 'Final payload should retain simulator trust');
  assert.strictEqual(finalPayload.td_sim_fresh, true, 'Final payload should retain simulator freshness');
  assert.strictEqual(finalPayload.td_sim_landing_vs_fpm, -349.2, 'Final payload should retain simulator rate diagnostic');
  assert.strictEqual(finalPayload.final_touchdown_vs_fpm, -15, 'Soft recontact rate should be retained');
});

test('brief weak-signal WOW chatter remains clean', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_053_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({ wow: false, fdm: { altPlaneFt: 1000.5 } }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({
      wow: true,
      fdm: { altPlaneFt: 1000 },
      display: { iasKts: 138, vsFpm: -243, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100 }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1000.8 },
      display: { iasKts: 136, vsFpm: 48, raFt: 0.4 },
    }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.08,
      fdm: { altPlaneFt: 1000.1 },
      display: { iasKts: 134, vsFpm: -15, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 600 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 0, 'Brief weak-signal WOW chatter must remain suppressed');
  assert.strictEqual(finalPayload.bounce_grade, 'Clean', 'Brief weak-signal WOW chatter must remain clean');
});

test('sustained radio-height jitter without corroborating motion remains clean', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_054_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({ wow: false, fdm: { altPlaneFt: 1000.5 } }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({
      wow: true,
      fdm: { altPlaneFt: 1000 },
      display: { iasKts: 138, vsFpm: -243, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100 }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1000.1 },
      display: { iasKts: 136, vsFpm: 0, raFt: 0.4 },
    }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1000.1 },
      display: { iasKts: 134, vsFpm: 0, raFt: 0.4 },
    }), () => {}, { nowEpochMs: t0 + 1000 }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.08,
      fdm: { altPlaneFt: 1000.1 },
      display: { iasKts: 132, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1235 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 0, 'Sustained RA jitter alone must remain suppressed');
  assert.strictEqual(finalPayload.bounce_grade, 'Clean', 'Sustained RA jitter alone must remain clean');
});

test('cockpit barometer jump cannot corroborate a physical bounce', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_055_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({
      wow: false,
      alt_msl: 1980,
      display: { iasKts: 140, vsFpm: -400, raFt: 120 },
    }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({
      wow: true,
      alt_msl: 1980,
      gforce: 1.2,
      display: { iasKts: 138, vsFpm: -300, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100 }, ctx);

    // Simulate a +300 ft barometer correction while WOW briefly drops out.
    // No geometric altitude is supplied, and every physical corroborator stays trivial.
    runner.update(makeFrame({
      wow: false,
      alt_msl: 2280,
      gforce: 1.0,
      display: { iasKts: 135, vsFpm: -74, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({
      wow: true,
      alt_msl: 2280,
      gforce: 1.05,
      display: { iasKts: 133, vsFpm: -20, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 500 }, ctx);
    runner.update(makeFrame({
      wow: true,
      alt_msl: 2280,
      gforce: 1.05,
      display: { iasKts: 125, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 900 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 0, 'Indicated-altitude correction must not create a bounce');
  assert.strictEqual(finalPayload.bounce_grade, 'Clean', 'Barometer jump must leave bounce scoring clean');
});

test('zero touchdown VS threshold cannot make stationary WOW chatter a bounce', () => {
  withTouchdownMinVsConfig(0, (createWithConfig) => {
    const runner = createWithConfig();
    const finalPayloads = [];
    const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
    const t0 = 1_700_056_000_000;
    const ctx = makeCtx();

    try {
      runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -300, raFt: 100 } }), () => {}, { nowEpochMs: t0 }, ctx);
      runner.update(makeFrame({ wow: true, gforce: 1.2, display: { iasKts: 138, vsFpm: -250, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 100 }, ctx);
      runner.update(makeFrame({ wow: false, gforce: 1.0, display: { iasKts: 135, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
      runner.update(makeFrame({ wow: true, gforce: 1.0, display: { iasKts: 133, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 500 }, ctx);
      runner.update(makeFrame({ wow: true, gforce: 1.0, display: { iasKts: 120, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 1600 }, ctx);
      runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
    } finally {
      off();
    }

    const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
    assert(finalPayload, 'Expected landing:final event');
    assert.strictEqual(finalPayload.bounce_count, 0, 'Stationary 0 fpm sample must not corroborate a bounce');
    assert.strictEqual(finalPayload.bounce_grade, 'Clean', 'Stationary WOW chatter must remain clean');
  });
});

test('minor 1.10 G ground-load oscillation cannot confirm a bounce by itself', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_056_500_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -300, raFt: 100 } }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.2, display: { iasKts: 138, vsFpm: -250, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 100 }, ctx);
    runner.update(makeFrame({ wow: false, gforce: 1.0, display: { iasKts: 135, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.10, display: { iasKts: 133, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 500 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.10, display: { iasKts: 125, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 900 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.10, display: { iasKts: 115, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 1600 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 0, 'Minor load oscillation alone must not corroborate a bounce');
  assert.strictEqual(finalPayload.bounce_grade, 'Clean', 'Minor ground-load oscillation must remain clean');
});

test('upslope runway motion with flat radio height cannot masquerade as a bounce', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_056_750_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({
      wow: false,
      fdm: { altPlaneFt: 999.5 },
      display: { iasKts: 150, vsFpm: -300, raFt: 100 },
    }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.2,
      fdm: { altPlaneFt: 1000 },
      display: { iasKts: 148, vsFpm: -250, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100 }, ctx);

    // A brief WOW dropout while following a 1% upslope can show both rising
    // geometric MSL altitude and positive VS. Flat RA shows there was no lift
    // away from the runway surface.
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1001.2 },
      display: { iasKts: 146, vsFpm: 150, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1002.0 },
      display: { iasKts: 144, vsFpm: 150, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 500 }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.05,
      fdm: { altPlaneFt: 1002.5 },
      display: { iasKts: 142, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 700 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.05, display: { iasKts: 125, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 1800 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 0, 'Runway slope must not be counted as physical lift');
  assert.strictEqual(finalPayload.bounce_grade, 'Clean', 'Upslope WOW chatter must remain clean');
});

test('delayed post-impact G peak can confirm a sparse short bounce once', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_057_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -400, raFt: 120 } }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.2, display: { iasKts: 138, vsFpm: -300, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 100 }, ctx);
    runner.update(makeFrame({ wow: false, gforce: 1.0, display: { iasKts: 135, vsFpm: -74, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.0, display: { iasKts: 133, vsFpm: -20, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 500 }, ctx);

    // The transition sample is ~1 G, but the simulator's filtered load peak
    // arrives on the following frame inside the existing one-second window.
    runner.update(makeFrame({ wow: true, gforce: 1.4, display: { iasKts: 130, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 600 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.4, display: { iasKts: 128, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 700 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 1, 'Delayed G peak must confirm exactly one bounce');
  assert.strictEqual(finalPayload.final_touchdown_gforce, 1.4, 'Delayed peak must attach to the bounce impact');
  assert.strictEqual(finalPayload.bounce_worst_gforce, 1.4, 'Delayed peak must update bounce severity');
});

test('a later real bounce cannot lend its impact peak to an earlier WOW dropout', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_058_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -400, raFt: 120 } }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.2, display: { iasKts: 138, vsFpm: -300, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 100 }, ctx);

    // First segment is only WOW chatter: no lift, upward motion, impact, or
    // delayed ground-frame load corroborates it.
    runner.update(makeFrame({ wow: false, gforce: 1.0, display: { iasKts: 136, vsFpm: -60, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.0, display: { iasKts: 134, vsFpm: -20, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 450 }, ctx);

    // A separate, physically observed bounce starts inside the old contact's
    // one-second delay window. Its impact must confirm only this segment.
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      fdm: { altPlaneFt: 1003 },
      display: { iasKts: 132, vsFpm: 120, raFt: 5 },
    }), () => {}, { nowEpochMs: t0 + 600 }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.35,
      fdm: { altPlaneFt: 1000 },
      display: { iasKts: 129, vsFpm: -180, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 800 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 1, 'Only the physically corroborated segment should count');
  assert.strictEqual(finalPayload.final_touchdown_gforce, 1.35, 'The real bounce should retain its own impact peak');
});

test('confirmed bounce distance includes only the observed airborne segment', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_060_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({
      wow: false,
      fdm: { altPlaneFt: 1000.5 },
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 90, hdgMagDeg: 90 },
      display: { iasKts: 140, vsFpm: -500, raFt: 120 },
    }), () => {}, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      fdm: { altPlaneFt: 1000 },
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 90, hdgMagDeg: 90 },
      display: { iasKts: 138, vsFpm: -400, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);

    // About 364 ft of ground roll precedes the actual airborne segment.
    runner.update(makeFrame({
      wow: true,
      fdm: { altPlaneFt: 1000 },
      simconnect: { lat: 0, lon: 0.001, hdgTrueDeg: 90, hdgMagDeg: 90 },
      display: { iasKts: 135, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1200, nowIso: new Date(t0 + 1200).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: false,
      fdm: { altPlaneFt: 1002 },
      simconnect: { lat: 0, lon: 0.0011, hdgTrueDeg: 90, hdgMagDeg: 90 },
      display: { iasKts: 133, vsFpm: 300, raFt: 5 },
    }), () => {}, { nowEpochMs: t0 + 1300, nowIso: new Date(t0 + 1300).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: false,
      fdm: { altPlaneFt: 1003 },
      simconnect: { lat: 0, lon: 0.0012, hdgTrueDeg: 90, hdgMagDeg: 90 },
      display: { iasKts: 131, vsFpm: 100, raFt: 8 },
    }), () => {}, { nowEpochMs: t0 + 1500, nowIso: new Date(t0 + 1500).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.25,
      fdm: { altPlaneFt: 1000 },
      simconnect: { lat: 0, lon: 0.0014, hdgTrueDeg: 90, hdgMagDeg: 90 },
      display: { iasKts: 128, vsFpm: -250, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1700, nowIso: new Date(t0 + 1700).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      display: { iasKts: 60, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 1, 'Corroborated lift must remain a physical bounce');
  assert.strictEqual(finalPayload.bounce_grade, 'Single Bounce', 'Corroborated bounce must retain its label');
  assert(
    finalPayload.bounce_distance_ft >= 105 && finalPayload.bounce_distance_ft <= 115,
    `Expected about 109 ft airborne, excluding rollout; got ${finalPayload.bounce_distance_ft}`,
  );
});

test('ordinary consecutive physical bounces are all retained', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_065_000_000;
  const ctx = makeCtx();

  const frameAt = (wow, lon, altPlaneFt, raFt, vsFpm, gforce = 1.0) => makeFrame({
    wow,
    gforce,
    fdm: { altPlaneFt },
    simconnect: { lat: 0, lon, hdgTrueDeg: 90, hdgMagDeg: 90 },
    display: { iasKts: wow ? 125 : 130, vsFpm, raFt },
  });

  try {
    runner.update(frameAt(false, 0, 1001, 100, -450), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(frameAt(true, 0.0001, 1000, 0, -350, 1.2), () => {}, { nowEpochMs: t0 + 100 }, ctx);

    // A normal low bounce: the load and second-contact VS are mild, but the
    // sampled geometric/radio-height rise is unambiguous physical lift.
    runner.update(frameAt(false, 0.0002, 1004, 5, 120), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(frameAt(true, 0.0003, 1000, 0, -80, 1.05), () => {}, { nowEpochMs: t0 + 500 }, ctx);

    // A second ordinary bounce must increment the same landing sequence rather
    // than replacing or losing the first bounce.
    runner.update(frameAt(false, 0.0004, 1003, 4, 90), () => {}, { nowEpochMs: t0 + 700 }, ctx);
    runner.update(frameAt(true, 0.0005, 1000, 0, -70, 1.04), () => {}, { nowEpochMs: t0 + 900 }, ctx);
    runner.update(frameAt(true, 0.0006, 1000, 0, 0), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 2, 'Both physical bounces must be recorded');
  assert.strictEqual(finalPayload.bounce_grade, 'Multiple Bounces', 'Two bounces must retain the existing grade');
  assert(finalPayload.bounce_distance_ft > 0, 'Airborne distance from both bounces must be accumulated');
});

test('meaningful second impact confirms a bounce when the sampled apex is missed', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_070_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -500, raFt: 120 } }), () => {}, { nowEpochMs: t0 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.2, display: { iasKts: 138, vsFpm: -400, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 100 }, ctx);
    runner.update(makeFrame({ wow: false, gforce: 1.0, display: { iasKts: 135, vsFpm: -350, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 300 }, ctx);
    runner.update(makeFrame({ wow: true, gforce: 1.0, display: { iasKts: 132, vsFpm: -50, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 500 }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 60, vsFpm: 0, raFt: 0 } }), () => {}, { nowEpochMs: t0 + 120000 }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.bounce_count, 1, 'A material second impact must survive sparse altitude sampling');
  assert.strictEqual(finalPayload.final_touchdown_vs_fpm, -350, 'Expected recent airborne impact VS to be retained');
});

test('touchdown VS prefers recent airborne sample when WOW frame is damped', () => {
  const runner = createLandingRunner();
  const out = [];
  const broadcast = (payload) => out.push(payload);

  const t0 = 1_700_100_000_000;

  // Init airborne state
  runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -650, raFt: 120 } }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, makeCtx());

  // Touchdown frame can be post-impact damped; expect runner to keep recent airborne sink rate
  runner.update(makeFrame({ wow: true, display: { iasKts: 138, vsFpm: -80, raFt: 5 } }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, makeCtx());

  // Expire rollout window to emit final landing packet
  runner.update(makeFrame({ wow: true, display: { iasKts: 70, vsFpm: 0, raFt: 0 } }), broadcast, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, makeCtx());

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  assert(finalEvent, 'Expected final landing event');
  assert.strictEqual(finalEvent.vs, -650, `Expected VS -650 fpm from recent airborne sample, got ${finalEvent.vs}`);
});

test('landing uses measured simulator G-force instead of estimating it from vertical speed', () => {
  const finalEvent = finalizeLanding(createLandingRunner, {
    gforce: 1.82,
    display: { iasKts: 138, vsFpm: -900, raFt: 2 },
  });

  assert.strictEqual(finalEvent.gforce, 1.82, 'Expected measured touchdown G-force');
});

test('landing leaves G-force unknown when measured telemetry is unavailable', () => {
  const finalEvent = finalizeLanding(createLandingRunner, {
    gforce: null,
    fdm: { gForce: null },
    display: { iasKts: 138, vsFpm: -900, raFt: 2 },
  });

  assert.strictEqual(finalEvent.gforce, null, 'Missing G-force must not be fabricated from vertical speed');
});

test('bounce G-force peak follows the latest impact without replacing the first-touchdown peak', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_104_000_000;
  const ctx = makeCtx();

  try {
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      display: { iasKts: 140, vsFpm: -600, raFt: 120 },
    }), () => {}, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 2.0,
      display: { iasKts: 138, vsFpm: -600, raFt: 4 },
    }), () => {}, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);

    // Bounce after the first touchdown's peak window but before cooldown re-arm.
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      display: { iasKts: 132, vsFpm: -500, raFt: 18 },
    }), () => {}, { nowEpochMs: t0 + 2000, nowIso: new Date(t0 + 2000).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.1,
      display: { iasKts: 130, vsFpm: -500, raFt: 3 },
    }), () => {}, { nowEpochMs: t0 + 2100, nowIso: new Date(t0 + 2100).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.5,
      display: { iasKts: 125, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 2500, nowIso: new Date(t0 + 2500).toISOString() }, ctx);

    runner.update(makeFrame({
      wow: true,
      display: { iasKts: 60, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.gforce, 2.0, 'Overall landing G-force should retain the highest impact');
  assert.strictEqual(finalPayload.first_touchdown_gforce, 2.0, 'First-touchdown peak should remain independent');
  assert.strictEqual(finalPayload.final_touchdown_gforce, 1.5, 'Bounce should capture its own post-impact peak');
  assert.strictEqual(finalPayload.bounce_worst_gforce, 2.0, 'Worst bounce-sequence G-force should retain the maximum');
});

test('runway occupancy records normal low-speed vacate timing', () => {
  const runner = createLandingRunner();
  const out = [];
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const broadcast = (payload) => out.push(payload);
  const t0 = 1_700_105_000_000;
  const ctx = makeCtx();
  const runwaySurface = {
    onGround: true,
    valid: true,
    runwayLike: true,
    onRunway: true,
    raw: 4,
    name: 'ASPHALT',
    class: 'PAVED',
  };
  const taxiwaySurface = {
    ...runwaySurface,
    runwayLike: false,
    onRunway: false,
  };

  try {
    runner.update(makeFrame({
      wow: false,
      surface: { ...runwaySurface, onGround: false, runwayLike: false, onRunway: false },
      display: { iasKts: 140, vsFpm: -600, raFt: 120 },
    }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: runwaySurface,
      gs: 125,
      display: { iasKts: 138, vsFpm: -600, raFt: 4 },
    }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: taxiwaySurface,
      gs: 12,
      display: { iasKts: 40, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 5100, nowIso: new Date(t0 + 5100).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: taxiwaySurface,
      gs: 0,
      display: { iasKts: 20, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalEvent, 'Expected final landing broadcast event');
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalEvent.runwayOccupancyS, 5, `Expected broadcast runway occupancy 5s, got ${finalEvent.runwayOccupancyS}`);
  assert.strictEqual(finalPayload.runway_occupancy_s, 5, `Expected canonical runway occupancy 5s, got ${finalPayload.runway_occupancy_s}`);
  assert.strictEqual(buildRow(finalPayload).runway_occupancy_s, '5.0', 'Expected CSV row to persist runway occupancy seconds');
});

test('runway occupancy waits for paved runway exit after the rollout scoring window', () => {
  const runner = createLandingRunner();
  const out = [];
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const broadcast = (payload) => out.push(payload);
  const t0 = 1_700_100_000_000;
  const ctx = makeCtx();
  const runwaySurface = {
    onGround: true,
    valid: true,
    runwayLike: true,
    onRunway: true,
    raw: 4,
    name: 'ASPHALT',
    class: 'PAVED',
  };
  const taxiwaySurface = {
    onGround: true,
    valid: true,
    runwayLike: false,
    onRunway: false,
    raw: 4,
    name: 'CONCRETE',
    class: 'PAVED',
  };

  try {
    runner.update(makeFrame({
      wow: false,
      surface: { ...runwaySurface, onGround: false, runwayLike: false, onRunway: false },
      display: { iasKts: 140, vsFpm: -600, raFt: 120 },
    }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: runwaySurface,
      gs: 125,
      display: { iasKts: 138, vsFpm: -600, raFt: 4 },
    }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: runwaySurface,
      gs: 40,
      display: { iasKts: 45, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 25_000, nowIso: new Date(t0 + 25_000).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: taxiwaySurface,
      gs: 34,
      display: { iasKts: 40, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 29_500, nowIso: new Date(t0 + 29_500).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalEvent, 'Expected final landing broadcast event');
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalEvent.runwayExcursion, false, 'Expected paved runway exit not to be treated as excursion');
  assert.strictEqual(finalPayload.runway_excursion, false, 'Expected canonical paved runway exit not to be excursion');
  assert.strictEqual(finalEvent.runwayOccupancyS, 29.4, `Expected broadcast runway occupancy 29.4s, got ${finalEvent.runwayOccupancyS}`);
  assert.strictEqual(finalPayload.runway_occupancy_s, 29.4, `Expected canonical runway occupancy 29.4s, got ${finalPayload.runway_occupancy_s}`);
  assert.strictEqual(buildRow(finalPayload).runway_occupancy_s, '29.4', 'Expected CSV row to persist delayed runway occupancy seconds');
});

test('high-speed paved runway exit is not auto-classified as runway excursion', () => {
  const runner = createLandingRunner();
  const out = [];
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const broadcast = (payload) => out.push(payload);
  const t0 = 1_700_106_000_000;
  const ctx = makeCtx();
  const runwaySurface = {
    onGround: true,
    valid: true,
    runwayLike: true,
    onRunway: true,
    raw: 4,
    name: 'ASPHALT',
    class: 'PAVED',
  };
  const pavedExitSurface = {
    onGround: true,
    valid: true,
    runwayLike: false,
    onRunway: false,
    raw: 4,
    name: 'ASPHALT',
    class: 'PAVED',
  };

  try {
    runner.update(makeFrame({
      wow: false,
      surface: { ...runwaySurface, onGround: false, runwayLike: false, onRunway: false },
      display: { iasKts: 140, vsFpm: -600, raFt: 120 },
    }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: runwaySurface,
      gs: 125,
      display: { iasKts: 138, vsFpm: -600, raFt: 4 },
    }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);
    runner.update(makeFrame({
      wow: true,
      surface: pavedExitSurface,
      gs: 52,
      display: { iasKts: 58, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 2600, nowIso: new Date(t0 + 2600).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalEvent, 'Expected final landing broadcast event');
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalEvent.runwayExcursion, false, 'Expected paved runway exit not to be auto-classified as excursion');
  assert.strictEqual(finalPayload.runway_excursion, false, 'Expected canonical payload not to persist paved runway exit as excursion');
  assert.notStrictEqual(finalEvent.grade, 'RUNWAY EXCURSION', 'Paved runway exit should not override final landing grade');
});

test('stale MSFS last-touchdown snapshot is persisted as diagnostic but not trusted', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_110_000_000;
  const staleTouchdown = {
    source: 'msfs_last_touchdown',
    latDeg: 0.01,
    lonDeg: 0.01,
    headingTrueDeg: 45,
    headingMagDeg: 45,
    pitchDeg: 8,
    bankDeg: 6,
    normalVelocityFps: 12,
    normalVelocityFpm: 720,
  };

  try {
    runner.update(makeFrame({
      wow: false,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: staleTouchdown },
      display: { iasKts: 140, vsFpm: -600, raFt: 120 },
    }), () => {}, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, makeCtx());
    runner.update(makeFrame({
      wow: true,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: staleTouchdown },
      display: { iasKts: 138, vsFpm: -500, raFt: 4 },
    }), () => {}, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, makeCtx());
    runner.update(makeFrame({
      wow: true,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: staleTouchdown },
      display: { iasKts: 70, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, makeCtx());
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.touchdown_capture_source, 'frame', 'stale MSFS touchdown should not replace frame snapshot');
  assert.strictEqual(finalPayload.td_sim_trusted, false, 'stale MSFS touchdown should be untrusted');
  assert.strictEqual(finalPayload.td_sim_reject_reason, 'stale', 'expected stale reject reason');
  assert.strictEqual(finalPayload.lat_deg, 0, 'canonical latitude should stay on current frame');
  assert.strictEqual(finalPayload.hdg_true_deg, 0, 'canonical heading should stay on current frame');
  assert.strictEqual(finalPayload.vs_fpm, -600, 'untrusted MSFS rate should fall back to recent airborne V/S');
});

test('MSFS normal-velocity changes remain diagnostic-only', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_112_000_000;
  const previousTouchdown = {
    source: 'msfs_last_touchdown',
    latDeg: 0.0001,
    lonDeg: 0,
    headingTrueDeg: 5,
    headingMagDeg: 4,
    pitchDeg: 6.2,
    bankDeg: -1.5,
    normalVelocityFps: 4,
    normalVelocityFpm: 240,
  };
  const rateOnlyChange = {
    ...previousTouchdown,
    normalVelocityFps: 5.82,
    normalVelocityFpm: 349.2,
  };

  try {
    runner.update(makeFrame({
      wow: false,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: previousTouchdown },
      display: { iasKts: 140, vsFpm: -243.3, raFt: 120 },
    }), () => {}, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, makeCtx({ aircraftProfileId: 'fbw-a32nx' }));
    runner.update(makeFrame({
      wow: true,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: rateOnlyChange },
      display: { iasKts: 138, vsFpm: -80, raFt: 4 },
    }), () => {}, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, makeCtx({ aircraftProfileId: 'fbw-a32nx' }));
    runner.update(makeFrame({
      wow: true,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: rateOnlyChange },
      display: { iasKts: 70, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, makeCtx({ aircraftProfileId: 'fbw-a32nx' }));
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.touchdown_capture_source, 'frame', 'diagnostic rate changes must not select simulator geometry');
  assert.strictEqual(finalPayload.td_sim_fresh, false, 'diagnostic rate changes must not make a snapshot fresh');
  assert.strictEqual(finalPayload.td_sim_reject_reason, 'stale', 'unchanged geometry should remain stale');
  assert.strictEqual(finalPayload.vs_fpm, -243.3, 'headline must remain conventional V/S');
  assert.strictEqual(finalPayload.grade, 'GOOD', 'headline grade must remain profile-derived');
  assert.strictEqual(finalPayload.td_sim_landing_vs_fpm, -349.2, 'simulator-normal rate remains available only as a diagnostic');
});

test('fresh nearby MSFS touchdown snapshot provides canonical geometry but diagnostic-only VS', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_115_000_000;
  const previousTouchdown = {
    source: 'msfs_last_touchdown',
    latDeg: 0.02,
    lonDeg: 0.02,
    headingTrueDeg: 20,
    headingMagDeg: 20,
    pitchDeg: 2,
    bankDeg: 1,
    normalVelocityFps: 4,
    normalVelocityFpm: 240,
  };
  const freshTouchdown = {
    source: 'msfs_last_touchdown',
    latDeg: 0.0001,
    lonDeg: 0,
    headingTrueDeg: 5,
    headingMagDeg: 4,
    pitchDeg: 6.2,
    bankDeg: -1.5,
    normalVelocityFps: 5.82,
    normalVelocityFpm: 349.2,
  };

  try {
    runner.update(makeFrame({
      wow: false,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: previousTouchdown },
      display: { iasKts: 140, vsFpm: -243.3, raFt: 120 },
    }), () => {}, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, makeCtx({ aircraftProfileId: 'fbw-a32nx' }));
    runner.update(makeFrame({
      wow: true,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: freshTouchdown },
      display: { iasKts: 138, vsFpm: -80, raFt: 4 },
    }), () => {}, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, makeCtx({ aircraftProfileId: 'fbw-a32nx' }));
    runner.update(makeFrame({
      wow: true,
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0, touchdown: freshTouchdown },
      display: { iasKts: 70, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, makeCtx({ aircraftProfileId: 'fbw-a32nx' }));
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.touchdown_capture_source, 'msfs_last_touchdown', 'fresh MSFS touchdown should be trusted');
  assert.strictEqual(finalPayload.td_sim_trusted, true, 'fresh MSFS touchdown should be trusted');
  assert.strictEqual(finalPayload.td_sim_reject_reason, null, 'trusted MSFS touchdown should not have reject reason');
  assert.strictEqual(finalPayload.lat_deg, 0.0001, 'canonical latitude should use MSFS touchdown latitude');
  assert.strictEqual(finalPayload.hdg_true_deg, 5, 'canonical true heading should use MSFS touchdown heading');
  assert.strictEqual(finalPayload.pitch_deg, 6.2, 'canonical pitch should use MSFS touchdown pitch');
  assert.strictEqual(finalPayload.bank_deg, -1.5, 'canonical bank should use MSFS touchdown bank');
  assert.strictEqual(finalPayload.vs_fpm, -243.3, 'trusted MSFS normal velocity must not replace conventional V/S');
  assert.strictEqual(finalPayload.grade, 'GOOD', 'headline grade should use conventional V/S and the recorded A32NX profile');
  assert.strictEqual(finalPayload.td_sim_landing_vs_fpm, -349.2, 'MSFS normal velocity should remain available as a diagnostic');
});

test('touchdown VS ignores NaN display sample and emits finite grade data', () => {
  const runner = createLandingRunner();
  const out = [];
  const broadcast = (payload) => out.push(payload);

  const t0 = 1_700_125_000_000;
  const ctx = makeCtx();

  runner.update(makeFrame({
    wow: false,
    display: { iasKts: 140, vsFpm: -600, raFt: 120 },
  }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);

  runner.update(makeFrame({
    wow: true,
    vs: NaN,
    display: { iasKts: 138, vsFpm: NaN, raFt: 5 },
  }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);

  runner.update(makeFrame({
    wow: true,
    display: { iasKts: 70, vsFpm: 0, raFt: 0 },
  }), broadcast, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  assert(finalEvent, 'Expected final landing event');
  assert(Number.isFinite(finalEvent.vs), `Expected finite VS, got ${finalEvent.vs}`);
  assert(Number.isFinite(finalEvent.gforce), `Expected finite gforce, got ${finalEvent.gforce}`);
  assert.notStrictEqual(finalEvent.grade, 'VERY HARD', 'NaN VS should not be graded as VERY HARD');
});

test('bounce touchdown VS prefers recent airborne sample when WOW frame is damped', () => {
  const runner = createLandingRunner();
  const out = [];
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const broadcast = (payload) => out.push(payload);
  const t0 = 1_700_150_000_000;
  const ctx = makeCtx();

  try {
    // First touchdown starts the landing sequence.
    runner.update(makeFrame({ wow: false, display: { iasKts: 140, vsFpm: -500, raFt: 120 } }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 138, vsFpm: -500, raFt: 5 } }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);

    // Bounce airborne sample has the real sink rate; the following WOW frame is damped.
    runner.update(makeFrame({ wow: false, display: { iasKts: 135, vsFpm: -900, raFt: 18 } }), broadcast, { nowEpochMs: t0 + 200, nowIso: new Date(t0 + 200).toISOString() }, ctx);
    runner.update(makeFrame({ wow: true, display: { iasKts: 132, vsFpm: -50, raFt: 4 } }), broadcast, { nowEpochMs: t0 + 300, nowIso: new Date(t0 + 300).toISOString() }, ctx);

    // Expire rollout window to emit final landing packet.
    runner.update(makeFrame({ wow: true, display: { iasKts: 70, vsFpm: 0, raFt: 0 } }), broadcast, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  const missingCriticalKeys = getCriticalLandingCsvMappings()
    .map((mapping) => mapping.payloadKey)
    .filter((key) => !Object.prototype.hasOwnProperty.call(finalPayload, key));
  assert.deepStrictEqual(missingCriticalKeys, [], `landing:final payload missing critical CSV keys: ${missingCriticalKeys.join(', ')}`);
  assert.strictEqual(finalPayload.final_touchdown_vs_fpm, -900, `Expected final bounce VS -900 fpm, got ${finalPayload.final_touchdown_vs_fpm}`);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(finalPayload, 'ultimate_stability_checklist_ok_pct'),
    false,
    'landing:final payload should not expose checklist stability pct',
  );
  assert.strictEqual(finalPayload.ultimate_stability_gate_stable, true, 'Expected canonical gate stable boolean in landing:final payload');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(finalPayload, 'ultimate_stability_gateStable'),
    false,
    'landing:final payload should not expose legacy camel-case gateStable flat key',
  );
});

test('landing:final preserves touchdown surface validity even when class is present', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_160_000_000;
  const invalidSurface = {
    onGround: true,
    valid: false,
    runwayLike: true,
    onRunway: false,
    raw: 4,
    name: 'ASPHALT',
    class: 'PAVED',
  };

  try {
    runner.update(makeFrame({
      wow: false,
      surface: invalidSurface,
      display: { iasKts: 140, vsFpm: -500, raFt: 120 },
    }), () => {}, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, makeCtx());
    runner.update(makeFrame({
      wow: true,
      surface: invalidSurface,
      display: { iasKts: 138, vsFpm: -500, raFt: 4 },
    }), () => {}, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, makeCtx());
    runner.update(makeFrame({
      wow: true,
      surface: invalidSurface,
      display: { iasKts: 70, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, makeCtx());
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalPayload, 'Expected landing:final event');
  assert.strictEqual(finalPayload.surface_valid, false, 'Expected surface_valid false to survive landing:final payload');
  assert.strictEqual(finalPayload.surface_raw, 4, 'Expected surface_raw to survive landing:final payload');
  assert.strictEqual(finalPayload.surface_runway_like, true, 'Expected existing surface_runway_like to survive unchanged');
  assert.strictEqual(finalPayload.surface_on_runway, false, 'Expected explicit surface_on_runway false to survive landing:final payload');
});

test('runway touchdown at threshold counts as TDZ achieved and preserves score-shaped stability', () => {
  const runwayData = {
    icao: 'TEST',
    runway: '36',
    runwayId: '36',
    lengthFt: 6000,
    widthFt: 150,
    surface: 'ASP',
    heading: 0,
    threshold: { lat: 0, lon: 0 },
  };

  withMockRunway(runwayData, (createWithMockRunway) => {
    const finalEvent = finalizeLanding(
      createWithMockRunway,
      {
        simconnect: { lat: 0, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0 },
        display: { iasKts: 138, vsFpm: -500, raFt: 4 },
      },
      {
        stability: {
          ultimateScore: {
            score: 67,
            breakdown: { gear_ok: 100, flaps_ok: 100, spoilers_ok: 100 },
            gateStable: false,
            gateFailures: ['vs_unstable_after_gate'],
            samples: 20,
          },
        },
      },
    );

    assert.strictEqual(finalEvent.touchdownDistance.distanceFt, 0, 'Expected threshold touchdown distance to be 0 ft');
    assert.strictEqual(finalEvent.touchdownDistance.tdzAchieved, true, '0 ft at/after threshold should count as TDZ achieved');
    assert.strictEqual(finalEvent.touchdownDistance.grade, 'Outstanding', 'Generic scoring should not penalize threshold touchdowns without aircraft-specific target data');
    assert.strictEqual(finalEvent.touchdownDistance.shortLanding, false, 'Threshold touchdown is not short');
    assert.strictEqual(finalEvent.touchdownDistance.lateralOffsetFt, 0, 'Centered touchdown should emit lateral offset');
    assert.strictEqual(finalEvent.touchdownDistance.lateralOffsetSide, 'center', 'Centered touchdown should emit center side');
    assert.strictEqual(finalEvent.touchdownDistance.lateralOffsetScore, 100, 'Centered touchdown should score lateral offset');
    assert.strictEqual(finalEvent.touchdownDistance.lateralOffsetGrade, 'Perfect', 'Centered touchdown should grade lateral offset');
    assert.strictEqual(finalEvent.ultimateStability.score, 67, 'score-shaped ultimateScore payload should be preserved');
    assert.strictEqual(finalEvent.ultimateStability.gateStable, false, 'score-shaped gateStable=false should be preserved for UI broadcast');
    assert.deepStrictEqual(
      finalEvent.ultimateStability.gateFailures,
      ['vs_unstable_after_gate'],
      'score-shaped gateFailures should be preserved for UI broadcast',
    );
  });
});

test('landing final payload includes separate rollout-control analysis', () => {
  const runwayData = {
    icao: 'TEST',
    runway: '36',
    runwayId: '36',
    lengthFt: 6000,
    widthFt: 150,
    surface: 'ASP',
    heading: 0,
    threshold: { lat: 0, lon: 0 },
  };

  withMockRunway(runwayData, (createWithMockRunway) => {
    const runner = createWithMockRunway();
    const out = [];
    const finalPayloads = [];
    const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
    const broadcast = (payload) => out.push(payload);
    const t0 = 1_700_400_000_000;
    const ctx = makeCtx();
    const time = (offsetMs) => ({
      nowEpochMs: t0 + offsetMs,
      nowIso: new Date(t0 + offsetMs).toISOString(),
    });
    const rolloutFrame = (bankDeg, headingDeg, gsKts, lon = 0, rollRateDegS = 0) => makeFrame({
      wow: true,
      gs: gsKts,
      fdm: { rollRateRadS: rollRateDegS * (Math.PI / 180) },
      simconnect: { lat: 0.001, lon, hdgTrueDeg: headingDeg, hdgMagDeg: headingDeg },
      attitudeDebug: { pitchDegPrimary: 2, bankDegPrimary: bankDeg },
      display: { iasKts: gsKts, gsKts, vsFpm: 0, raFt: 0 },
    });

    try {
      runner.update(makeFrame({ wow: false }), broadcast, time(0), ctx);
      runner.update(rolloutFrame(-0.3, 0, 136), broadcast, time(100), ctx);
      runner.update(rolloutFrame(0.8, 2, 134, 0, 5.2), broadcast, time(600), ctx);
      runner.update(rolloutFrame(3.3, 15, 131, 0.00001, 5.4), broadcast, time(1100), ctx);
      runner.update(rolloutFrame(2, 14, 115, 0.00001), broadcast, time(1600), ctx);
      runner.update(makeFrame({
        wow: true,
        gs: 80,
        surface: {
          onGround: true,
          valid: true,
          runwayLike: true,
          onRunway: false,
          raw: 1,
          name: 'Asphalt',
          class: 'dry',
        },
        simconnect: { lat: 0.002, lon: 0.00001, hdgTrueDeg: 14, hdgMagDeg: 14 },
        display: { iasKts: 80, gsKts: 80, vsFpm: 0, raFt: 0 },
      }), broadcast, time(2000), ctx);
    } finally {
      off();
    }

    const finalEvent = out.find((event) => event?.type === 'landing' && event.final === true);
    assert(finalEvent?.rolloutAnalysis, 'Expected final landing broadcast to include rollout analysis');
    assert.strictEqual(finalEvent.rolloutAnalysis.schemaVersion, 2);
    assert.strictEqual(finalEvent.rolloutAnalysis.assessment, 'caution');
    assert.strictEqual(finalEvent.rolloutAnalysis.maxBankDeg, 3.3);
    assert.strictEqual(finalEvent.rolloutAnalysis.maxHeadingDeviationDeg, 15);
    assert(finalEvent.rolloutAnalysis.flags.some((flag) => flag.code === 'rapid_bank_change'));

    const finalPayload = finalPayloads.find((payload) => payload?.landing_final === true);
    assert(finalPayload?.rollout_analysis, 'Expected canonical landing:final payload to persist rollout analysis');
    assert.strictEqual(finalPayload.rollout_analysis.assessment, 'caution');
    assert.notStrictEqual(buildRow(finalPayload).rollout_analysis, '', 'Expected rollout analysis JSON in the landing CSV row');
  });
});

test('runway lookup is deferred until rollout finalization and preserves reference elevation', () => {
  let positionLookups = 0;
  let nearbyAirportLookups = 0;
  let idLookups = 0;
  const positionLookupRadii = [];
  const runwayData = {
    icao: 'TEST',
    runway: '36',
    runwayId: '36',
    lengthFt: 6000,
    physicalLengthFt: 6200,
    widthFt: 150,
    surface: 'ASP',
    heading_true_deg: 0,
    threshold: { lat: 0, lon: 0 },
    physicalThreshold: { lat: -0.0001, lon: 0 },
    displacedThresholdFt: 120,
    elevation_ft: 1886,
    elevationReference: 'airport',
  };

  withMockRunwayProvider({
    findRunwayByPosition: (_lat, _lon, radiusNm) => {
      positionLookups += 1;
      positionLookupRadii.push(radiusNm);
      return runwayData;
    },
    findNearbyAirport: () => {
      nearbyAirportLookups += 1;
      return null;
    },
    getRunway: () => {
      idLookups += 1;
      return runwayData;
    },
  }, (createWithMockRunway) => {
    const runner = createWithMockRunway();
    const broadcasts = [];
    const finalPayloads = [];
    const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
    const t0 = 1_700_405_000_000;
    const ctx = makeCtx();
    const frame = (wow, gsKts, vsFpm, raFt) => makeFrame({
      wow,
      gs: gsKts,
      simconnect: { lat: 0.001, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0 },
      display: { iasKts: gsKts, gsKts, vsFpm, raFt },
    });

    try {
      runner.update(frame(false, 140, -600, 120), (payload) => broadcasts.push(payload), {
        nowEpochMs: t0,
        nowIso: new Date(t0).toISOString(),
      }, ctx);
      assert.strictEqual(positionLookups, 0, 'Approach frame must not query runway geometry');

      runner.update(frame(true, 136, -500, 4), (payload) => broadcasts.push(payload), {
        nowEpochMs: t0 + 100,
        nowIso: new Date(t0 + 100).toISOString(),
      }, ctx);
      assert.strictEqual(positionLookups, 0, 'Touchdown frame must not query runway geometry');
      assert(
        broadcasts.some((payload) => payload?.type === 'landing' && payload.final === false),
        'Touchdown should still emit the immediate non-final landing packet',
      );

      runner.update(frame(true, 90, 0, 0), (payload) => broadcasts.push(payload), {
        nowEpochMs: t0 + 1000,
        nowIso: new Date(t0 + 1000).toISOString(),
      }, ctx);
      assert.strictEqual(positionLookups, 0, 'Active rollout capture must not query runway geometry');

      runner.update(frame(true, 40, 0, 0), (payload) => broadcasts.push(payload), {
        nowEpochMs: t0 + 120000,
        nowIso: new Date(t0 + 120000).toISOString(),
      }, ctx);
    } finally {
      off();
    }

    assert.strictEqual(positionLookups, 1, 'Expected one runway lookup after rollout capture freezes');
    assert.deepStrictEqual(positionLookupRadii, [2], 'Final runway lookup should preserve the runway scoring radius');
    assert.strictEqual(nearbyAirportLookups, 0, 'Runway hit must not trigger the airport-only fallback');
    assert.strictEqual(idLookups, 0, 'Position hit must not trigger a second runway-id lookup');

    const finalBroadcast = broadcasts.find((payload) => payload?.type === 'landing' && payload.final === true);
    const finalPayload = finalPayloads.find((payload) => payload?.landing_final === true);
    assert(finalBroadcast, 'Expected final landing broadcast');
    assert(finalPayload, 'Expected canonical landing:final payload');
    assert.strictEqual(finalBroadcast.icao, 'TEST');
    assert.strictEqual(finalBroadcast.runway, '36');
    assert.strictEqual(finalBroadcast.runwayHdg, 0);
    assert.strictEqual(finalBroadcast.touchdownDistance.runwayWidthFt, 150);
    assert.strictEqual(finalPayload.runway_geometry_source, 'ourairports');
    assert.strictEqual(finalPayload.runway_geometry_provider_chain, 'ourairports:hit');
    assert.strictEqual(finalPayload.runway_heading_true_deg, 0);
    assert.strictEqual(finalPayload.runway_length_ft, 6000);
    assert.strictEqual(finalPayload.runway_physical_length_ft, 6200);
    assert.strictEqual(finalPayload.runway_width_ft, 150);
    assert.strictEqual(finalPayload.runway_threshold_lat, 0);
    assert.strictEqual(finalPayload.runway_threshold_lon, 0);
    assert.strictEqual(finalPayload.runway_physical_threshold_lat, -0.0001);
    assert.strictEqual(finalPayload.runway_physical_threshold_lon, 0);
    assert.strictEqual(finalPayload.runway_displaced_threshold_ft, 120);
    assert.strictEqual(finalPayload.runway_reference_elev_ft, 1886);
    assert.strictEqual(finalPayload.runway_reference_elevation_source, 'ourairports');
    assert.strictEqual(finalPayload.runway_reference_elevation_kind, 'airport');
  });
});

test('runway miss preserves nearby airport elevation for retrospective scoring', () => {
  let positionLookups = 0;
  let nearbyAirportLookups = 0;
  let idLookups = 0;
  const positionLookupRadii = [];
  const nearbyAirportLookupRadii = [];

  withMockRunwayProvider({
    findRunwayByPosition: (_lat, _lon, radiusNm) => {
      positionLookups += 1;
      positionLookupRadii.push(radiusNm);
      return null;
    },
    findNearbyAirport: (_lat, _lon, radiusNm) => {
      nearbyAirportLookups += 1;
      nearbyAirportLookupRadii.push(radiusNm);
      return {
        icao: 'TEST',
        elevation_ft: 1886,
        source: 'msfs-facilities',
      };
    },
    getRunway: () => {
      idLookups += 1;
      return null;
    },
  }, (createWithMockRunway) => {
    const finalPayloads = [];
    const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
    let finalBroadcast;
    try {
      finalBroadcast = finalizeLanding(createWithMockRunway, makeFrame({
        wow: true,
        simconnect: { lat: 0.001, lon: 0, hdgTrueDeg: 90, hdgMagDeg: 90 },
        display: { iasKts: 136, gsKts: 136, vsFpm: -500, raFt: 4 },
      }));
    } finally {
      off();
    }

    assert.strictEqual(positionLookups, 1, 'Expected one heading-filtered runway lookup at finalization');
    assert.deepStrictEqual(positionLookupRadii, [2], 'Runway identity matching should stay within 2 NM');
    assert.strictEqual(nearbyAirportLookups, 1, 'Runway miss should retain the nearby-airport scoring fallback');
    assert.deepStrictEqual(nearbyAirportLookupRadii, [5], 'Airport reference fallback should retain its 5 NM radius');
    assert.strictEqual(idLookups, 0, 'Missing live runway hints must not trigger an id lookup');

    const finalPayload = finalPayloads.find((payload) => payload?.landing_final === true);
    assert(finalBroadcast, 'Expected final landing broadcast');
    assert(finalPayload, 'Expected canonical landing:final payload');
    assert.strictEqual(finalBroadcast.icao, 'TEST');
    assert.strictEqual(finalBroadcast.runway, null);
    assert.strictEqual(finalBroadcast.touchdownDistance.distanceFt, null);
    assert.strictEqual(finalPayload.icao, 'TEST');
    assert.strictEqual(finalPayload.runway, null);
    assert.strictEqual(finalPayload.runway_geometry_source, null);
    assert.strictEqual(finalPayload.runway_reference_elev_ft, 1886);
    assert.strictEqual(finalPayload.runway_reference_elevation_source, 'msfs-facilities');
    assert.strictEqual(finalPayload.runway_reference_elevation_kind, 'airport');
  });
});

test('deferred geometry miss emits a complete fail-safe final landing', () => {
  let positionLookups = 0;
  let nearbyAirportLookups = 0;
  let idLookups = 0;

  withMockRunwayProvider({
    findRunwayByPosition: () => {
      positionLookups += 1;
      return null;
    },
    findNearbyAirport: () => {
      nearbyAirportLookups += 1;
      return null;
    },
    getRunway: () => {
      idLookups += 1;
      return null;
    },
  }, (createWithMockRunway) => {
    const runner = createWithMockRunway();
    const broadcasts = [];
    const finalPayloads = [];
    const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
    const t0 = 1_700_406_000_000;
    const ctx = makeCtx();
    const touchdownFrame = makeFrame({
      wow: true,
      simconnect: { lat: 0.001, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0 },
      display: { iasKts: 136, gsKts: 136, vsFpm: -500, raFt: 4 },
    });

    try {
      runner.update(makeFrame({
        wow: false,
        simconnect: { lat: 0.001, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0 },
      }), (payload) => broadcasts.push(payload), {
        nowEpochMs: t0,
        nowIso: new Date(t0).toISOString(),
      }, ctx);
      runner.update(touchdownFrame, (payload) => broadcasts.push(payload), {
        nowEpochMs: t0 + 100,
        nowIso: new Date(t0 + 100).toISOString(),
      }, ctx);
      assert.strictEqual(positionLookups, 0, 'Runway miss must remain deferred past touchdown');

      runner.update(makeFrame({
        ...touchdownFrame,
        display: { iasKts: 40, gsKts: 40, vsFpm: 0, raFt: 0 },
      }), (payload) => broadcasts.push(payload), {
        nowEpochMs: t0 + 120000,
        nowIso: new Date(t0 + 120000).toISOString(),
      }, ctx);
    } finally {
      off();
    }

    assert.strictEqual(positionLookups, 1, 'Runway lookup should be attempted once at finalization');
    assert.strictEqual(nearbyAirportLookups, 1, 'Runway miss should try the airport-only scoring fallback once');
    assert.strictEqual(idLookups, 0, 'Missing runway hints must not trigger a retry by id');

    const finalBroadcast = broadcasts.find((payload) => payload?.type === 'landing' && payload.final === true);
    const finalPayload = finalPayloads.find((payload) => payload?.landing_final === true);
    assert(finalBroadcast, 'Expected fail-safe final landing broadcast');
    assert(finalPayload, 'Expected fail-safe canonical landing:final payload');
    assert.strictEqual(finalBroadcast.icao, null);
    assert.strictEqual(finalBroadcast.runway, null);
    assert.strictEqual(finalBroadcast.touchdownDistance.distanceFt, null);
    assert.strictEqual(finalPayload.runway_geometry_source, null);
    assert.strictEqual(finalPayload.runway_reference_elev_ft, null);
    assert.strictEqual(typeof finalPayload.grade, 'string');
    assert.strictEqual(typeof finalPayload.bounce_score, 'number');
    assert.strictEqual(typeof finalPayload.bounce_grade, 'string');
  });
});

test('landing rollout analysis ends at raw taxi-in speed before the runway-exit turn', () => {
  const runwayData = {
    icao: 'TEST',
    runway: '36',
    runwayId: '36',
    lengthFt: 6000,
    widthFt: 150,
    surface: 'ASP',
    heading: 0,
    threshold: { lat: 0, lon: 0 },
  };

  withMockRunway(runwayData, (createWithMockRunway) => {
    const runner = createWithMockRunway();
    const out = [];
    const broadcast = (payload) => out.push(payload);
    const t0 = 1_700_410_000_000;
    const ctx = makeCtx();
    const time = (offsetMs) => ({
      nowEpochMs: t0 + offsetMs,
      nowIso: new Date(t0 + offsetMs).toISOString(),
    });
    const rolloutFrame = (gsKts, headingDeg, lon, onRunway = true) => makeFrame({
      wow: true,
      gs: gsKts,
      surface: {
        onGround: true,
        valid: true,
        runwayLike: onRunway,
        onRunway,
        raw: 1,
        name: 'Asphalt',
        class: 'PAVED',
      },
      fdm: { rollRateRadS: 0 },
      simconnect: { lat: 0.001, lon, hdgTrueDeg: headingDeg, hdgMagDeg: headingDeg },
      attitudeDebug: { pitchDegPrimary: 2, bankDegPrimary: 0.3 },
      display: { iasKts: gsKts, gsKts, vsFpm: 0, raFt: 0 },
    });

    runner.update(makeFrame({ wow: false }), broadcast, time(0), ctx);
    runner.update(rolloutFrame(132, 0, 0), broadcast, time(100), ctx);
    runner.update(rolloutFrame(90, 0.5, 0.00001), broadcast, time(600), ctx);
    runner.update(rolloutFrame(60.1, 1, 0.00002), broadcast, time(1100), ctx);
    runner.update(rolloutFrame(59.9, 20, 0.0002), broadcast, time(1600), {
      ...ctx,
      phase: 'LANDING',
    });
    runner.update(rolloutFrame(45, 30, 0.0003, false), broadcast, time(2100), {
      ...ctx,
      phase: 'TAXI-IN',
    });

    const finalEvent = out.find((event) => event?.type === 'landing' && event.final === true);
    assert(finalEvent?.rolloutAnalysis, 'Expected final landing broadcast to include rollout analysis');
    assert.strictEqual(finalEvent.rolloutAnalysis.endGsKts, 60.1);
    assert.strictEqual(finalEvent.rolloutAnalysis.maxHeadingDeviationDeg, 1);
    assert.strictEqual(finalEvent.rolloutAnalysis.assessment, 'normal');
  });
});

test('landing crosswind is recomputed against true runway heading', () => {
  const runwayData = {
    icao: 'TEST',
    runway: '36',
    runwayId: '36',
    lengthFt: 6000,
    widthFt: 150,
    surface: 'ASP',
    heading_true_deg: 0,
    threshold: { lat: 0, lon: 0 },
  };

  withMockRunway(runwayData, (createWithMockRunway) => {
    const finalEvent = finalizeLanding(
      createWithMockRunway,
      {
        simconnect: { lat: 0, lon: 0, hdgTrueDeg: 30, hdgMagDeg: 30 },
        windSpeed: 20,
        windDir: 90,
        display: { iasKts: 138, vsFpm: -500, raFt: 4 },
      },
      { xwind_kts: 10 },
    );

    assert.strictEqual(finalEvent.crosswind, 20, 'Expected full 20 kt runway-relative crosswind');
    assert.strictEqual(finalEvent.runwayHdg, 0, 'Expected explicit true runway heading in landing broadcast');
  });
});

test('runway selection and centerline use true heading before magnetic heading', () => {
  const runwayData = {
    icao: 'TEST',
    runway: '01',
    runwayId: '01',
    lengthFt: 6000,
    widthFt: 150,
    surface: 'ASP',
    heading: 10,
    threshold: { lat: 0, lon: 0 },
  };
  const headings = [];

  withMockRunwayProvider({
    findRunwayByPosition: (_lat, _lon, _maxDistanceNm, aircraftHeadingDeg) => {
      headings.push(aircraftHeadingDeg);
      return runwayData;
    },
    getRunway: () => runwayData,
  }, (createWithMockRunway) => {
    const finalEvent = finalizeLanding(createWithMockRunway, {
      simconnect: { lat: 0, lon: 0, hdgTrueDeg: 10, hdgMagDeg: 350 },
      display: { iasKts: 138, vsFpm: -500, raFt: 4 },
    });

    assert.strictEqual(finalEvent.centerlineDev, 0, 'Centerline should compare true heading to true runway heading');
    assert.strictEqual(headings.length, 1, 'Expected one runway lookup at rollout finalization');
    assert.strictEqual(headings[0], 10, `Expected true-heading runway filter, got ${headings.join(', ')}`);
  });
});

test('runway selection and centerline derive true heading from magnetic heading and west-positive magvar', () => {
  const runwayData = {
    icao: 'TEST',
    runway: '28',
    runwayId: '28',
    lengthFt: 6000,
    widthFt: 150,
    surface: 'ASP',
    heading: 253,
    threshold: { lat: 0, lon: 0 },
  };
  const headings = [];

  withMockRunwayProvider({
    findRunwayByPosition: (_lat, _lon, _maxDistanceNm, aircraftHeadingDeg) => {
      headings.push(aircraftHeadingDeg);
      return runwayData;
    },
    getRunway: () => runwayData,
  }, (createWithMockRunway) => {
    const finalEvent = finalizeLanding(createWithMockRunway, {
      simconnect: { lat: 0, lon: 0, hdgMagDeg: 267 },
      magvar: 14,
      display: { iasKts: 138, vsFpm: -500, raFt: 4 },
    });

    assert.strictEqual(finalEvent.centerlineDev, 0, 'Centerline should derive true heading from magnetic heading and magvar');
    assert.strictEqual(headings.length, 1, 'Expected one runway lookup at rollout finalization');
    assert.strictEqual(headings[0], 253, `Expected derived true-heading runway filter, got ${headings.join(', ')}`);
  });
});

test('short landing never counts as TDZ achieved even near the touchdown zone', () => {
  const runwayData = {
    icao: 'TEST',
    runway: '36',
    runwayId: '36',
    lengthFt: 6000,
    widthFt: 150,
    surface: 'ASP',
    heading: 0,
    threshold: { lat: 0, lon: 0 },
  };

  withMockRunway(runwayData, (createWithMockRunway) => {
    const finalEvent = finalizeLanding(createWithMockRunway, {
      // About 365 ft before the threshold for runway heading 360/0.
      simconnect: { lat: -0.001, lon: 0, hdgTrueDeg: 0, hdgMagDeg: 0 },
      display: { iasKts: 138, vsFpm: -500, raFt: 4 },
    });

    assert(finalEvent.touchdownDistance.distanceFt < 0, 'Expected signed distance before threshold');
    assert.strictEqual(finalEvent.touchdownDistance.grade, 'Short Landing', 'Short touchdown should carry Short Landing grade');
    assert.strictEqual(finalEvent.touchdownDistance.shortLanding, true, 'Expected shortLanding flag');
    assert.strictEqual(finalEvent.touchdownDistance.tdzAchieved, false, 'Short landing must not count as TDZ achieved');
  });
});

test('runway excursion stays separate from the touchdown-rate grade', () => {
  const runner = createLandingRunner();
  const out = [];
  const broadcast = (payload) => out.push(payload);
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_300_000_000;
  const ctx = makeCtx();
  const runwaySurface = {
    onGround: true,
    valid: true,
    runwayLike: true,
    raw: 4,
    name: 'ASPHALT',
    class: 'PAVED',
  };
  const offRunwaySurface = {
    onGround: true,
    valid: true,
    runwayLike: false,
    raw: 1,
    name: 'GRASS',
    class: 'UNPAVED',
  };

  try {
    runner.update(makeFrame({
      wow: false,
      surface: runwaySurface,
      display: { iasKts: 140, vsFpm: -500, raFt: 120 },
    }), broadcast, { nowEpochMs: t0, nowIso: new Date(t0).toISOString() }, ctx);

    runner.update(makeFrame({
      wow: true,
      gs: 120,
      surface: runwaySurface,
      display: { iasKts: 138, vsFpm: -500, raFt: 4 },
    }), broadcast, { nowEpochMs: t0 + 100, nowIso: new Date(t0 + 100).toISOString() }, ctx);

    runner.update(makeFrame({
      wow: true,
      gs: 70,
      surface: offRunwaySurface,
      display: { iasKts: 70, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 500, nowIso: new Date(t0 + 500).toISOString() }, ctx);

    runner.update(makeFrame({
      wow: true,
      gs: 50,
      surface: offRunwaySurface,
      display: { iasKts: 50, vsFpm: 0, raFt: 0 },
    }), broadcast, { nowEpochMs: t0 + 120000, nowIso: new Date(t0 + 120000).toISOString() }, ctx);
  } finally {
    off();
  }

  const finalEvent = out.find((evt) => evt && evt.type === 'landing' && evt.final === true);
  const finalPayload = finalPayloads.find((evt) => evt && evt.landing_final === true);
  assert(finalEvent, 'Expected final landing event');
  assert(finalPayload, 'Expected canonical landing:final payload');
  assert.strictEqual(finalEvent.runwayExcursion, true, 'Expected high-speed runway departure to be flagged');
  assert.strictEqual(finalEvent.vs, -500, 'Expected the touchdown-rate headline to remain independent');
  assert.strictEqual(finalEvent.grade, 'FIRM', 'WebSocket grade should remain the known -500 fpm rate grade');
  assert.strictEqual(finalEvent.color, 'gold', 'WebSocket color should remain the rate-grade color');
  assert.strictEqual(finalPayload.runway_excursion, true, 'Canonical payload should preserve runway excursion');
  assert.strictEqual(finalPayload.grade, 'FIRM', 'Canonical CSV grade should remain the touchdown-rate grade');
  assert.strictEqual(finalPayload._ui_color, 'gold', 'Canonical payload color should remain the rate-grade color');
});

test('profile switch after touchdown cannot change final identity, grade, or immediate bounce assessment', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_500_000_000;
  const touchdownCtx = makeCtx({
    aircraftName: 'FlyByWire A380X',
    aircraftProfileId: 'fbw-a380x',
  });
  const changedCtx = makeCtx({
    aircraftName: 'Generic replacement title',
    aircraftProfileId: 'generic',
  });

  try {
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      display: { iasKts: 145, vsFpm: -180, raFt: 100 },
    }), () => {}, { nowEpochMs: t0 }, touchdownCtx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.2,
      display: { iasKts: 142, vsFpm: -180, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100 }, touchdownCtx);

    // The A380 bands classify -180 fpm as GOOD, while generic classifies it
    // as PERFECT. With no lift/load corroboration, this bounce therefore also
    // proves that the touchdown profile remains authoritative after the switch.
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      display: { iasKts: 139, vsFpm: -180, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 300 }, changedCtx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.0,
      display: { iasKts: 136, vsFpm: -180, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 500 }, changedCtx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.0,
      display: { iasKts: 40, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000 }, changedCtx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((payload) => payload?.landing_final === true);
  assert(finalPayload, 'Expected canonical landing:final payload');
  assert.strictEqual(finalPayload.grade, 'GOOD', 'Final grade must remain the A380 touchdown grade');
  assert.strictEqual(finalPayload.aircraft_profile_id, 'fbw-a380x', 'Final profile must remain the touchdown profile');
  assert.strictEqual(finalPayload.aircraft, 'FlyByWire A380X', 'Final aircraft title must remain the touchdown identity');
  assert.strictEqual(finalPayload.landing_rate_context?.profile?.id, 'fbw-a380x', 'Persisted rate context must remain tied to touchdown');
  assert.strictEqual(finalPayload.bounce_count, 1, 'Immediate bounce assessment must use the touchdown profile');
});

test('pending bounce confirmation cannot borrow a newly selected aircraft profile', () => {
  const runner = createLandingRunner();
  const finalPayloads = [];
  const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
  const t0 = 1_700_501_000_000;
  const touchdownCtx = makeCtx({ aircraftProfileId: 'generic' });
  const changedCtx = makeCtx({ aircraftProfileId: 'fbw-a380x' });

  try {
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      display: { iasKts: 145, vsFpm: -180, raFt: 100 },
    }), () => {}, { nowEpochMs: t0 }, touchdownCtx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.2,
      display: { iasKts: 142, vsFpm: -180, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 100 }, touchdownCtx);
    runner.update(makeFrame({
      wow: false,
      gforce: 1.0,
      display: { iasKts: 139, vsFpm: -180, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 300 }, touchdownCtx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.0,
      display: { iasKts: 136, vsFpm: -180, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 500 }, touchdownCtx);

    // This frame is inside the delayed confirmation window. Regrading the
    // contact as A380 GOOD would incorrectly turn the generic PERFECT contact
    // into a confirmed bounce.
    runner.update(makeFrame({
      wow: true,
      gforce: 1.0,
      display: { iasKts: 132, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 600 }, changedCtx);
    runner.update(makeFrame({
      wow: true,
      gforce: 1.0,
      display: { iasKts: 125, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 1700 }, changedCtx);
    runner.update(makeFrame({
      wow: true,
      display: { iasKts: 40, vsFpm: 0, raFt: 0 },
    }), () => {}, { nowEpochMs: t0 + 120000 }, changedCtx);
  } finally {
    off();
  }

  const finalPayload = finalPayloads.find((payload) => payload?.landing_final === true);
  assert(finalPayload, 'Expected canonical landing:final payload');
  assert.strictEqual(finalPayload.aircraft_profile_id, 'generic');
  assert.strictEqual(finalPayload.grade, 'PERFECT');
  assert.strictEqual(finalPayload.bounce_count, 0, 'Pending contact must remain assessed with the generic touchdown profile');
});

test('rollout taxi threshold is frozen at touchdown and reset for the next attempt', () => {
  let taxiInMaxKts = 35;
  withMockPhaseThresholds(() => ({ taxi_in_max_kts: taxiInMaxKts }), (createWithMockPhase) => {
    const runner = createWithMockPhase();
    const finalPayloads = [];
    const off = eventBus.on('landing:final', (payload) => finalPayloads.push(payload));
    const t0 = 1_700_502_000_000;
    const firstCtx = makeCtx({ aircraftName: 'First aircraft', aircraftProfileId: 'fbw-a380x' });
    const secondCtx = makeCtx({ aircraftName: 'Second aircraft', aircraftProfileId: 'generic' });
    const rolloutSurface = {
      onGround: true,
      valid: true,
      runwayLike: true,
      onRunway: true,
      raw: 1,
      name: 'Asphalt',
      class: 'dry',
    };

    try {
      // Abandon one accepted touchdown through the public reset path. Its
      // immutable attempt context must not leak into the next landing.
      runner.update(makeFrame({ wow: false }), () => {}, { nowEpochMs: t0 }, firstCtx);
      runner.update(makeFrame({ wow: true }), () => {}, { nowEpochMs: t0 + 100 }, firstCtx);
      runner.reset();

      runner.update(makeFrame({
        wow: false,
        gs: 130,
        surface: rolloutSurface,
        display: { iasKts: 140, gsKts: 130, vsFpm: -180, raFt: 100 },
      }), () => {}, { nowEpochMs: t0 + 1000 }, secondCtx);
      runner.update(makeFrame({
        wow: true,
        gs: 130,
        surface: rolloutSurface,
        display: { iasKts: 138, gsKts: 130, vsFpm: -180, raFt: 0 },
      }), () => {}, { nowEpochMs: t0 + 1100 }, secondCtx);

      // Simulate an active-profile threshold change during rollout.
      taxiInMaxKts = 80;
      runner.update(makeFrame({
        wow: true,
        gs: 100,
        surface: rolloutSurface,
        display: { iasKts: 100, gsKts: 100, vsFpm: 0, raFt: 0 },
      }), () => {}, { nowEpochMs: t0 + 1600 }, firstCtx);
      runner.update(makeFrame({
        wow: true,
        gs: 70,
        surface: rolloutSurface,
        display: { iasKts: 70, gsKts: 70, vsFpm: 0, raFt: 0 },
      }), () => {}, { nowEpochMs: t0 + 2100 }, firstCtx);
      runner.update(makeFrame({
        wow: true,
        gs: 30,
        surface: { ...rolloutSurface, onRunway: false },
        display: { iasKts: 30, gsKts: 30, vsFpm: 0, raFt: 0 },
      }), () => {}, { nowEpochMs: t0 + 2600 }, firstCtx);
    } finally {
      off();
    }

    const finalPayload = finalPayloads.find((payload) => payload?.landing_final === true);
    assert(finalPayload, 'Expected canonical landing:final payload');
    assert.strictEqual(finalPayload.aircraft_profile_id, 'generic', 'Runner reset must discard the prior attempt profile');
    assert.strictEqual(finalPayload.aircraft, 'Second aircraft', 'Runner reset must discard the prior aircraft title');
    assert.strictEqual(finalPayload.grade, 'PERFECT', 'Second landing must use its own generic grading bands');
    assert(finalPayload.rollout_analysis, 'Expected rollout analysis to be persisted');
    assert.strictEqual(finalPayload.rollout_analysis.taxiInMaxKts, 35, 'Rollout must retain the threshold captured at touchdown');
    assert.strictEqual(finalPayload.rollout_analysis.sampleCount, 3, '70 kt sample must remain in the rollout under the captured 35 kt threshold');
  });
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
