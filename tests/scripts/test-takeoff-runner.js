#!/usr/bin/env node
/**
 * Takeoff runner regression tests: liftoff detection, settle-backs, the scored
 * `takeoff` broadcast, and the takeoff:final -> CSV -> timeline contract.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const takeoffRunnerPath = resolveBackendRuntimeFile('takeoff', 'takeoff-runner.js');
const sharedSettingsPath = require.resolve(path.resolve(path.dirname(takeoffRunnerPath), '../../shared/app-settings-shared.js'));
const sharedSettings = require(sharedSettingsPath);
const runwayDatabasePath = resolveBackendRuntimeFile('landing', 'runway-database.js');
const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));
const {
  buildTakeoffCsvEventData,
  getCriticalTakeoffCsvMappings,
} = require(resolveBackendRuntimeFile('flight-recording', 'takeoff-csv-contract.js'));
const schemaFieldMapPath = resolveBackendRuntimeFile('flight-recording', 'schema-field-map.js');
const { _generateTimelineFromRows: generateTimelineFromRows } = require(resolveBackendRuntimeFile('events', 'timeline-generator.js'));

const FT_PER_DEG_LAT = 364567;
const ORIGIN = { lat: -35.3, lon: 149.19 };

function pointAlong(alongFt, crossFt = 0) {
  const cosLat = Math.cos(ORIGIN.lat * Math.PI / 180);
  return {
    lat: ORIGIN.lat + alongFt / FT_PER_DEG_LAT,
    lon: ORIGIN.lon + crossFt / (FT_PER_DEG_LAT * cosLat),
  };
}

const MOCK_RUNWAY = {
  icao: 'YSCB',
  runway: '35',
  airportName: 'Canberra',
  elevation_ft: 1886,
  source: 'msfs-facilities',
  heading_true_deg: 360,
  headingTrueDeg: 360,
  lengthFt: 6000,
  physicalLengthFt: 6000,
  widthFt: 150,
  threshold: pointAlong(0),
  physicalThreshold: pointAlong(0),
  displacedThresholdFt: 0,
  surface: 'ASP',
};

function withMockRunwayProvider(mockRunwayDatabase, fn) {
  const previousRunner = require.cache[takeoffRunnerPath];
  const previousRunwayDatabase = require.cache[runwayDatabasePath];
  const previousSettings = require.cache[sharedSettingsPath];
  const previousSchema = require.cache[schemaFieldMapPath];
  // Exercise the retained scorer without adding a runtime override to the release gate.
  require.cache[sharedSettingsPath] = { ...previousSettings, exports: { ...sharedSettings, TAKEOFF_SCORING_ENABLED: true } };
  delete require.cache[takeoffRunnerPath];
  delete require.cache[schemaFieldMapPath];
  require.cache[runwayDatabasePath] = {
    id: runwayDatabasePath,
    filename: runwayDatabasePath,
    loaded: true,
    exports: mockRunwayDatabase,
  };
  try {
    const { createTakeoffRunner } = require(takeoffRunnerPath);
    fn(createTakeoffRunner);
  } finally {
    require.cache[sharedSettingsPath] = previousSettings;
    delete require.cache[schemaFieldMapPath];
    if (previousSchema) require.cache[schemaFieldMapPath] = previousSchema;
    delete require.cache[takeoffRunnerPath];
    if (previousRunner) require.cache[takeoffRunnerPath] = previousRunner;
    delete require.cache[runwayDatabasePath];
    if (previousRunwayDatabase) require.cache[runwayDatabasePath] = previousRunwayDatabase;
  }
}

function withMockRunway(runwayData, fn) {
  withMockRunwayProvider({
    findRunwayByPosition: () => runwayData,
    getRunway: () => runwayData,
    findNearbyAirport: () => null,
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
    console.error(`  ${err.stack || err.message}`);
    failed++;
  }
}

function makeFrame({ wow, gs, ias, raFt, along, pitch = 0, alt = 1900, surface = {} } = {}) {
  const position = pointAlong(along);
  return {
    wow,
    vs: 0,
    ra: raFt / 3.280839895,
    ias,
    gs,
    alt_msl: alt,
    lights: {},
    surface: {
      onGround: wow,
      valid: true,
      runwayLike: true,
      onRunway: true,
      raw: 1,
      name: 'Asphalt',
      class: 'dry',
      ...surface,
    },
    display: { iasKts: ias, gsKts: gs, vsFpm: 0, raFt },
    simconnect: {
      lat: position.lat,
      lon: position.lon,
      hdgTrueDeg: 360,
      hdgMagDeg: 348,
      magvarDeg: 12,
    },
    attitudeDebug: { pitchDegPrimary: pitch, bankDegPrimary: 0 },
    flaps: 0.25,
    flapsIndex: 1,
    windSpeed: 8,
    windDir: 90,
    assists: { takeoffAssist: false, anyAssistActive: false },
  };
}

function makeCtx(overrides = {}) {
  return {
    phase: 'TAXI',
    aircraftName: 'Test Aircraft',
    icao: null,
    runway: null,
    simVersion: 'test',
    aircraftProfileId: 'generic',
    dataSource: 'test',
    simulator: 'msfs',
    ...overrides,
  };
}

/**
 * Drive a full takeoff: 2 s standstill, a 30 s accelerating roll, liftoff, and
 * a climb through the screen height. Returns the broadcasts and the payload.
 */
function runTakeoff(createRunner, {
  liftoffAlongFt = 4000,
  settleBack = false,
  settleAfterMs = 1500,
  settleForMs = 1000,
  abortAfterSettle = false,
  ctxOverrides = {},
} = {}) {
  const runner = createRunner();
  const out = [];
  const finals = [];
  const onFinal = (payload) => finals.push(payload);
  eventBus.on('takeoff:final', onFinal);
  const broadcast = (payload) => out.push(payload);
  const ctx = makeCtx(ctxOverrides);
  const t0 = 1_700_300_000_000;
  const timeCtx = (ms) => ({
    nowEpochMs: t0 + ms,
    nowIso: new Date(t0 + ms).toISOString(),
    flightStartEpochMs: t0 - 60_000,
    flightStartIso: new Date(t0 - 60_000).toISOString(),
  });
  try {
    let ms = 0;
    for (; ms <= 2000; ms += 100) {
      runner.update(makeFrame({ wow: true, gs: 0, ias: 0, raFt: 0, along: 200 }), broadcast, timeCtx(ms), ctx);
    }
    const rollStartMs = ms;
    const rollMs = 30_000;
    for (; ms <= rollStartMs + rollMs; ms += 100) {
      const fraction = (ms - rollStartMs) / rollMs;
      const gs = 140 * fraction;
      const along = 200 + (liftoffAlongFt - 200) * fraction * fraction;
      const pitch = fraction > 0.9 ? (fraction - 0.9) * 10 * 8 : 0;
      runner.update(makeFrame({ wow: true, gs, ias: gs, raFt: 0, along, pitch }), broadcast, timeCtx(ms), ctx);
    }
    const liftoffMs = ms;
    let along = liftoffAlongFt;
    let raFt = 0;
    let settled = false;
    let stoppedGs = 142;
    for (; ms <= liftoffMs + 24_000; ms += 100) {
      along += 24; // ~140 kt
      raFt += 1.2;
      if (settleBack && !settled && ms >= liftoffMs + settleAfterMs && ms < liftoffMs + settleAfterMs + settleForMs) {
        // Sank back onto the runway before flying away.
        runner.update(makeFrame({ wow: true, gs: 142, ias: 146, raFt: 0, along, pitch: 6 }), broadcast, timeCtx(ms), ctx);
        raFt = 0;
        if (ms + 100 >= liftoffMs + settleAfterMs + settleForMs) settled = true;
        continue;
      }
      if (settleBack && settled && abortAfterSettle) {
        // Stayed on the ground and braked to a stop: the takeoff was abandoned.
        stoppedGs = Math.max(0, stoppedGs - 4);
        runner.update(makeFrame({ wow: true, gs: stoppedGs, ias: stoppedGs, raFt: 0, along, pitch: 0 }), broadcast, timeCtx(ms), ctx);
        continue;
      }
      runner.update(makeFrame({ wow: false, gs: 142, ias: 146, raFt, along, pitch: 10, alt: 1900 + raFt }), broadcast, timeCtx(ms), ctx);
    }
  } finally {
    eventBus.off('takeoff:final', onFinal);
  }
  return { out, finals, runner };
}

test('the release gate disables all takeoff publications and pending state', () => {
  assert.equal(sharedSettings.TAKEOFF_SCORING_ENABLED, false, 'the shipped gate must be off');
  assert.equal(Object.isFrozen(sharedSettings), true, 'settings cannot mutate the release capability');
  const { createTakeoffRunner } = require(takeoffRunnerPath);
  for (const options of [{}, { settleBack: true }, { settleBack: true, abortAfterSettle: true }]) {
    const { out, finals, runner } = runTakeoff(createTakeoffRunner, options);
    assert.deepEqual(out, [], 'no pending, scored, settled or cancelled packets');
    assert.deepEqual(finals, [], 'no final events for CSV or logbook persistence');
    assert.equal(runner.isPending(), false);
    runner.reset();
    assert.deepEqual(out, [], 'reset remains silent');
  }
});

test('update is safe with invalid frame and non-function broadcast', () => {
  const { createTakeoffRunner } = require(takeoffRunnerPath);
  const runner = createTakeoffRunner();
  assert.doesNotThrow(() => runner.update(null, null));
  assert.doesNotThrow(() => runner.update({ wow: true }, 'not-a-function'));
  assert.equal(runner.isPending(), false);
});

test('a standing-start takeoff is scored once the aircraft is clearly airborne', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { out, finals, runner } = runTakeoff(createRunner);
    const pending = out.find((evt) => evt && evt.type === 'takeoff' && evt.final === false);
    assert(pending, 'liftoff broadcast (final: false) expected');
    assert.equal(pending.iasKts, 146, 'the first airborne frame is the liftoff');
    const final = out.find((evt) => evt && evt.type === 'takeoff' && evt.final === true);
    assert(final, 'scored takeoff broadcast expected');
    assert.equal(runner.isPending(), false);
    assert.equal(final.icao, 'YSCB');
    assert.equal(final.runway, '35');
    assert.equal(final.grade, 'Good', `grade ${final.grade}: ${final.zone}`);
    assert.ok(Math.abs(final.runwayUse.remainingFt - 2000) <= 30, `remaining ${final.runwayUse.remainingFt}`);
    assert.ok(Math.abs(final.roll.distanceFt - 3800) <= 30, `roll ${final.roll.distanceFt}`);
    assert.equal(final.roll.startSource, 'standstill');
    // The roll starts at the last sample under the standstill threshold, a
    // couple of samples after brake release in this fixture.
    assert.ok(final.roll.durationS >= 28 && final.roll.durationS <= 30, `roll duration ${final.roll.durationS}`);
    assert.equal(final.liftoff.iasKts, 146);
    assert.equal(typeof final.liftoff.flapsNotch, 'number', 'the flap setting at liftoff is recorded');
    assert.equal(final.screenHeight.reached, true);
    assert.equal(final.screenHeight.heightFt, 35);
    assert.ok(final.screenHeight.remainingFt > 0 && final.screenHeight.remainingFt < 2000, `screen remaining ${final.screenHeight.remainingFt}`);
    assert.equal(final.hopCount, 0);
    assert.equal(final.runwayExcursion, false);
    assert.equal(final.lateral.verified, true);
    assert.equal(final.crosswind, 8, 'wind from 090 across runway 36 is 8 kt from the right');
    assert.equal(final.finalizeReason, 'airborne');
    assert.equal(final.assessment, 'normal');

    assert.equal(finals.length, 1, 'one takeoff:final payload');
    const payload = finals[0];
    assert.equal(payload.phase, 'TAKEOFF');
    assert.equal(payload.takeoff_final, true);
    assert.equal(payload.takeoff_runway_use_grade, 'Good');
    assert.equal(payload.icao, 'YSCB');
    assert.equal(payload.flight_elapsed_ms, pending.timestampMs - (payload.timestamp_ms - payload.flight_elapsed_ms), 'elapsed time is measured at liftoff');
    assert.equal(payload.timestamp_ms, pending.timestampMs, 'the row is stamped at liftoff, not at scoring');
    assert.equal(payload.assist_takeoff_enabled, false);
  });
});

test('a settle-back after liftoff is counted and the roll continues to the real liftoff', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { out } = runTakeoff(createRunner, { settleBack: true });
    const finals = out.filter((evt) => evt && evt.type === 'takeoff' && evt.final === true);
    assert.equal(finals.length, 1, 'the settle-back must not produce a second scored takeoff');
    assert.equal(finals[0].hopCount, 1);
    assert.equal(finals[0].roll.startSource, 'standstill');
    assert.ok(finals[0].flags.some((flag) => flag.code === 'settled_after_liftoff'));
    const settledPacket = out.find((evt) => evt && evt.type === 'takeoff' && evt.final === false && evt.settled === true);
    assert(settledPacket, 'the UI is told about the settle-back');
    assert.equal(settledPacket.hopCount, 1);
    assert.equal(out.some((evt) => evt && evt.type === 'takeoff' && evt.cancelled === true), false, 'a continued takeoff is never cancelled');
  });
});

test('a long float before settling back still scores one takeoff from the original roll start', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    // Airborne for 4 s (longer than the contiguous-roll gap), on the ground for
    // 1 s (shorter than a real roll), then away for good.
    const { out, finals } = runTakeoff(createRunner, { settleBack: true, settleAfterMs: 4000, settleForMs: 1000 });
    const final = out.find((evt) => evt && evt.type === 'takeoff' && evt.final === true);
    assert(final, 'the re-liftoff must not be rejected as a too-short roll');
    assert.equal(finals.length, 1);
    assert.equal(final.hopCount, 1);
    assert.equal(final.roll.startSource, 'standstill', 'the roll start established at the first liftoff survives the gap');
    assert.ok(final.roll.durationS > 30, `roll duration ${final.roll.durationS} spans the float`);
    assert.ok(Math.abs(final.roll.distanceFt - (3800 + 24 * 51)) <= 60, `roll distance ${final.roll.distanceFt} reaches the final liftoff`);
    assert.ok(final.runwayUse.remainingFt < 2000, 'runway remaining is measured at the final liftoff');
  });
});

test('stopping on the runway after a settle-back cancels the pending takeoff', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { out, finals, runner } = runTakeoff(createRunner, { settleBack: true, abortAfterSettle: true });
    assert.equal(finals.length, 0, 'an abandoned takeoff is never scored');
    const cancelled = out.find((evt) => evt && evt.type === 'takeoff' && evt.cancelled === true);
    assert(cancelled, 'the UI is told the takeoff will not be scored');
    assert.equal(cancelled.reason, 'stopped_after_settle_back');
    assert.equal(runner.isPending(), false);
  });
});

test('reset while a takeoff is pending tells the UI it was dropped', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const runner = createRunner();
    const out = [];
    const broadcast = (payload) => out.push(payload);
    const ctx = makeCtx();
    const t0 = 1_700_500_000_000;
    const timeCtx = (ms) => ({ nowEpochMs: t0 + ms, nowIso: new Date(t0 + ms).toISOString() });
    let ms = 0;
    for (; ms <= 2000; ms += 100) runner.update(makeFrame({ wow: true, gs: 0, ias: 0, raFt: 0, along: 200 }), broadcast, timeCtx(ms), ctx);
    const rollStart = ms;
    for (; ms <= rollStart + 30_000; ms += 100) {
      const fraction = (ms - rollStart) / 30_000;
      runner.update(makeFrame({ wow: true, gs: 140 * fraction, ias: 140 * fraction, raFt: 0, along: 200 + 3800 * fraction * fraction }), broadcast, timeCtx(ms), ctx);
    }
    runner.update(makeFrame({ wow: false, gs: 142, ias: 146, raFt: 2, along: 4024, pitch: 9 }), broadcast, timeCtx(ms), ctx);
    assert.equal(runner.isPending(), true);
    runner.reset();
    assert.equal(runner.isPending(), false);
    const cancelled = out.find((evt) => evt && evt.type === 'takeoff' && evt.cancelled === true);
    assert(cancelled, 'reset broadcasts a cancel for the pending takeoff');
    assert.equal(cancelled.reason, 'reset');
    assert.equal(out.some((evt) => evt && evt.type === 'takeoff' && evt.final === true), false);
  });
});

test('a bounce during a landing rollout is not a takeoff', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const runner = createRunner();
    const out = [];
    const broadcast = (payload) => out.push(payload);
    const ctx = makeCtx({ phase: 'LANDING' });
    const t0 = 1_700_400_000_000;
    const timeCtx = (ms) => ({ nowEpochMs: t0 + ms, nowIso: new Date(t0 + ms).toISOString() });
    let ms = 0;
    for (; ms < 3000; ms += 100) {
      runner.update(makeFrame({ wow: false, gs: 130, ias: 132, raFt: 40 - ms / 100, along: 1000 + ms / 5 }), broadcast, timeCtx(ms), ctx);
    }
    // Touchdown, decelerating rollout for one second, then a bounce.
    for (; ms < 4000; ms += 100) {
      runner.update(makeFrame({ wow: true, gs: 128 - (ms - 3000) / 50, ias: 128, raFt: 0, along: 1600 + ms / 5 }), broadcast, timeCtx(ms), ctx);
    }
    for (; ms < 6000; ms += 100) {
      runner.update(makeFrame({ wow: false, gs: 105, ias: 106, raFt: 3, along: 1800 + ms / 5 }), broadcast, timeCtx(ms), ctx);
    }
    assert.equal(out.some((evt) => evt && evt.type === 'takeoff'), false, 'no takeoff message for a rollout bounce');
    assert.equal(runner.isPending(), false);
  });
});

test('a liftoff beyond the runway end is graded as an overrun', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { out } = runTakeoff(createRunner, { liftoffAlongFt: 6100 });
    const final = out.find((evt) => evt && evt.type === 'takeoff' && evt.final === true);
    assert(final);
    assert.equal(final.grade, 'Overrun');
    assert.equal(final.runwayUse.beyondRunwayEnd, true);
    assert.ok(final.runwayUse.remainingFt < 0);
    assert.equal(final.assessment, 'critical');
  });
});

test('without runway geometry the takeoff still reports the roll and an unknown grade', () => {
  withMockRunwayProvider({
    findRunwayByPosition: () => null,
    getRunway: () => null,
    findNearbyAirport: () => ({ icao: 'YSCB', name: 'Canberra', elevation_ft: 1886 }),
  }, (createRunner) => {
    const { out, finals } = runTakeoff(createRunner);
    const final = out.find((evt) => evt && evt.type === 'takeoff' && evt.final === true);
    assert(final);
    assert.equal(final.grade, 'Unknown');
    assert.equal(final.icao, 'YSCB', 'nearest airport still names the departure');
    assert.equal(final.runway, null);
    assert.ok(Math.abs(final.roll.distanceFt - 3800) <= 40, `roll ${final.roll.distanceFt}`);
    assert.equal(final.roll.distanceSource, 'position_delta');
    assert.equal(final.crosswind, null, 'no runway heading means no runway-relative crosswind');
    assert.equal(finals[0].takeoff_runway_use_score, null);
  });
});

test('takeoff:final payload carries every critical CSV mapping into a TAKEOFF row and a timeline marker', () => {
  let historical;
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { buildRow, getV1Columns } = require(schemaFieldMapPath);
    const { finals } = runTakeoff(createRunner);
    const payload = finals[0];
    const mappings = getCriticalTakeoffCsvMappings();
    const columns = new Set(getV1Columns());
    const eventData = buildTakeoffCsvEventData(payload, 'takeoff-test-1');
    const row = buildRow({ ...eventData, _recordType: 'TAKEOFF' });

    assert.equal(row.record_type, 'TAKEOFF');
    assert.equal(row.phase, 'TAKEOFF');
    assert.equal(row.on_ground, '0', 'a takeoff row is airborne');
    const missingKeys = mappings.filter(({ payloadKey }) => !(payloadKey in payload)).map(({ payloadKey }) => payloadKey);
    assert.deepEqual(missingKeys, [], 'payload keys missing');
    const missingColumns = mappings.filter(({ column }) => !columns.has(column)).map(({ column }) => column);
    assert.deepEqual(missingColumns, [], 'schema columns missing');
    const emptyColumns = mappings
      .filter(({ payloadKey }) => payload[payloadKey] !== null && payload[payloadKey] !== undefined)
      .filter(({ column }) => row[column] === '' || row[column] === undefined)
      .map(({ column }) => column);
    assert.deepEqual(emptyColumns, [], 'columns that lost a non-null payload value');
    assert.equal(row.takeoff_runway_use_grade, 'Good');
    assert.equal(row.ias_kts, '146.0');
    assert.ok(row.takeoff_analysis.startsWith('{'), 'analysis is persisted as JSON');

    const sampleRow = (ts, extra = {}) => ({
      record_type: 'SAMPLE',
      ts: String(ts),
      timestamp_ms: String(ts),
      flight_elapsed_ms: String(ts - payload.timestamp_ms + 40_000),
      lat_deg: String(ORIGIN.lat),
      lon_deg: String(ORIGIN.lon),
      alt_msl_ft: '1900',
      ias_kts: '0',
      gs_kts: '0',
      on_ground: '1',
      phase: 'TAXI',
      aircraft: 'Test Aircraft',
      ...extra,
    });
    // The live writer stamps ts/flight_elapsed_ms with its own clock at write
    // time, which is the scoring moment after liftoff; replay the row the way
    // it lands in the CSV, several seconds after the liftoff it describes.
    const scoredAtMs = payload.timestamp_ms + 4100;
    assert.equal(row.takeoff_liftoff_timestamp_ms, String(payload.timestamp_ms), 'the liftoff time survives as its own column');
    const takeoffRow = {
      ...row,
      record_type: 'TAKEOFF',
      ts: String(scoredAtMs),
      timestamp_ms: String(scoredAtMs),
      timestamp_utc: new Date(scoredAtMs).toISOString(),
      flight_elapsed_ms: String(payload.flight_elapsed_ms + 4100),
    };
    const rows = [
      sampleRow(payload.timestamp_ms - 40_000),
      sampleRow(payload.timestamp_ms - 1000, { ias_kts: '138', gs_kts: '136' }),
      takeoffRow,
      sampleRow(payload.timestamp_ms + 20_000, { on_ground: '0', phase: 'CLIMB', alt_msl_ft: '2500', ias_kts: '160', gs_kts: '165' }),
    ];
    historical = { rows, payload };
  });
  // Replay retained data after restoring the disabled release gate and schema.
  assert.equal(require(sharedSettingsPath).TAKEOFF_SCORING_ENABLED, false);
  assert.equal(require(schemaFieldMapPath).getV1Columns().length, 331);
  const { rows, payload } = historical;
  const generated = generateTimelineFromRows('C:/tmp/takeoff-test/telemetry.csv', rows);
  const events = generated?.timeline?.events || generated?.events || [];
  const marker = events.find((event) => event.type === 'marker' && event.markerType === 'takeoff');
  assert(marker, 'disabled scoring must still replay a recorded takeoff marker');
  assert.equal(marker.timestampMs, payload.timestamp_ms, 'the marker sits at the liftoff moment, not the scoring moment');
  assert.equal(marker.elapsedMs, payload.flight_elapsed_ms, 'and its elapsed time matches the liftoff');
  assert.equal(marker.context.runway_use_grade, 'Good');
  assert.equal(marker.context.icao, 'YSCB');
  assert.equal(marker.context.ias_kts, 146);
  assert.ok(Math.abs(marker.context.runway_remaining_ft - 2000) <= 30);
  assert.ok(Array.isArray(marker.context.flags));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
