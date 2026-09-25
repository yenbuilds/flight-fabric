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

function withMockRunwayProvider(mockRunwayDatabase, fn, enabled = true) {
  const previousRunner = require.cache[takeoffRunnerPath];
  const previousRunwayDatabase = require.cache[runwayDatabasePath];
  const previousSettings = require.cache[sharedSettingsPath];
  const previousSchema = require.cache[schemaFieldMapPath];
  // Isolate the source capability in fixtures without a product runtime override.
  require.cache[sharedSettingsPath] = { ...previousSettings, exports: { ...sharedSettings, TAKEOFF_SCORING_ENABLED: enabled } };
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
  transform = (frame) => frame,
  beforeRoll = () => {},
  climbDurationMs = 24_000,
} = {}) {
  const runner = createRunner();
  const update = runner.update.bind(runner);
  runner.update = (frame, broadcast, time, ctx) => {
    const next = transform(frame, time);
    if (next) update(next, broadcast, time, ctx);
  };
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
    beforeRoll(runner, broadcast, timeCtx, ctx);
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
    for (; ms <= liftoffMs + climbDurationMs; ms += 100) {
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
  assert.equal(sharedSettings.TAKEOFF_SCORING_ENABLED, false, 'takeoff capture is disabled for this release');
  assert.equal(Object.isFrozen(sharedSettings), true, 'settings cannot mutate the release capability');
  withMockRunwayProvider({}, (createTakeoffRunner) => {
    for (const options of [{}, { settleBack: true }, { settleBack: true, abortAfterSettle: true }]) {
      const { out, finals, runner } = runTakeoff(createTakeoffRunner, options);
      assert.deepEqual(out, [], 'no pending, scored, settled or cancelled packets');
      assert.deepEqual(finals, [], 'no final events for CSV or logbook persistence');
      assert.equal(runner.isPending(), false);
      runner.reset();
      assert.deepEqual(out, [], 'reset remains silent');
    }
  }, false);
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
    assert.equal(final.grade, 'Recorded', `grade ${final.grade}: ${final.zone}`);
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
    assert.equal(payload.takeoff_runway_use_grade, 'Recorded');
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
    const { out } = runTakeoff(createRunner, { liftoffAlongFt: 6300, transform(frame) {
      if (frame.wow && frame.simconnect.lat > pointAlong(6000).lat) {
        frame.surface = { valid: true, onGround: true, onRunway: false, runwayLike: false, class: 'UNPAVED' };
      }
      return frame;
    } });
    const final = out.find((evt) => evt && evt.type === 'takeoff' && evt.final === true);
    assert(final);
    assert.equal(final.grade, 'Overrun');
    assert.equal(final.runwayUse.beyondRunwayEnd, true);
    assert.ok(final.runwayUse.remainingFt < 0);
    assert.equal(final.assessment, 'critical');
  });
});

test('a sampled liftoff across the runway end stays uncertain in broadcasts and saved data', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { out, finals } = runTakeoff(createRunner, { liftoffAlongFt: 5970, transform(frame, time) {
      if (!frame.wow) Object.assign(frame.simconnect, pointAlong(6060 + (time.nowEpochMs - 1_700_300_032_200) * 0.24));
      return frame;
    } });
    assert.equal(finals.length, 1);
    const final = out.find((message) => message.final);
    assert.equal(final.grade, 'Unknown');
    assert.equal(final.score, null);
    assert.equal(final.runwayUse.remainingFt, null);
    assert.equal(final.runwayUse.beyondRunwayEnd, false);
    assert.equal(final.runwayUse.notScoredReason, 'liftoff_position_uncertain');
    assert.ok(final.flags.some((flag) => flag.code === 'liftoff_position_uncertain'));
    assert.ok(!final.flags.some((flag) => flag.severity === 'critical'));
    const csv = buildTakeoffCsvEventData(finals[0]);
    assert.equal(csv.takeoff_runway_remaining_ft, null);
    const saved = typeof csv.takeoff_analysis === 'string' ? JSON.parse(csv.takeoff_analysis) : csv.takeoff_analysis;
    assert.equal(saved.schemaVersion, 3);
    assert.ok(saved.flags.some((flag) => flag.code === 'liftoff_position_uncertain'));
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
    assert.equal(row.takeoff_runway_use_grade, 'Recorded');
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
  // Replay still uses recorded results, never reconstructing or rescoring them.
  assert.equal(require(sharedSettingsPath).TAKEOFF_SCORING_ENABLED, false);
  assert.equal(require(schemaFieldMapPath).getV1Columns().length, 331);
  const { rows, payload } = historical;
  const generated = generateTimelineFromRows('C:/tmp/takeoff-test/telemetry.csv', rows);
  const events = generated?.timeline?.events || generated?.events || [];
  const marker = events.find((event) => event.type === 'marker' && event.markerType === 'takeoff');
  assert(marker, 'disabled scoring must still replay a recorded takeoff marker');
  assert.equal(marker.timestampMs, payload.timestamp_ms, 'the marker sits at the liftoff moment, not the scoring moment');
  assert.equal(marker.elapsedMs, payload.flight_elapsed_ms, 'and its elapsed time matches the liftoff');
  assert.equal(marker.context.runway_use_grade, 'Recorded');
  assert.equal(marker.context.icao, 'YSCB');
  assert.equal(marker.context.ias_kts, 146);
  assert.ok(Math.abs(marker.context.runway_remaining_ft - 2000) <= 30);
  assert.ok(Array.isArray(marker.context.flags));
});

const offRunway = { valid: true, onGround: true, onRunway: false, runwayLike: false, class: 'UNPAVED' };

test('pre-lineup movement and a single surface glitch cannot cause an excursion or truncate the roll', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const baseline = runTakeoff(createRunner).finals[0];
    const result = runTakeoff(createRunner, {
      beforeRoll(runner, broadcast, time, ctx) {
        for (let ms = -4000; ms < 0; ms += 100) {
          runner.update(makeFrame({ wow: true, gs: 40, ias: 40, raFt: 0, along: 0, surface: offRunway }), broadcast, time(ms), ctx);
        }
      },
      transform(frame, time) {
        if (time.nowEpochMs === 1_700_300_020_000) frame.surface = offRunway;
        return frame;
      },
    }).finals[0];
    assert.equal(result.runway_excursion, false);
    assert.equal(result.takeoff_roll_distance_ft, baseline.takeoff_roll_distance_ft);
    assert.equal(result.takeoff_assessment, 'normal');
  });
});

test('sustained valid off-pavement contact within the accepted roll records an excursion', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { transform(frame, time) {
      if (time.nowEpochMs >= 1_700_300_020_000 && time.nowEpochMs <= 1_700_300_022_000) frame.surface = offRunway;
      return frame;
    } }).finals[0];
    assert.equal(result.runway_excursion, true);
    assert.equal(result.takeoff_assessment, 'critical');
    assert.ok(result.takeoff_roll_distance_ft > 3700);
  });
});

test('a 60-second airborne gap cannot fabricate a screen crossing', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    let firstAir = null;
    const { out } = runTakeoff(createRunner, { climbDurationMs: 65_000, transform(frame, time) {
      if (!frame.wow) {
        firstAir ??= time.nowEpochMs;
        if (time.nowEpochMs > firstAir && time.nowEpochMs < firstAir + 60_000) return null;
      }
      return frame;
    } });
    const final = out.find((message) => message.final);
    assert.equal(final.finalizeReason, 'telemetry_gap');
    assert.equal(final.screenHeight.reached, false);
    assert.equal(final.screenHeight.distanceFt, null);
    assert.ok(final.flags.some((flag) => flag.code === 'climb_incomplete'));
    assert.notEqual(final.grade, 'Dangerous');
  });
});

test('screen crossing is interpolated between continuous height samples', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const final = runTakeoff(createRunner).finals[0];
    const screen = final.takeoff_analysis.screenHeight;
    assert.equal(screen.reached, true);
    assert.ok(screen.timestampMs % 100 !== 0, 'crossing falls between fixture frames');
    assert.equal(screen.elapsedS, 2.8);
  });
});

test('pause, menu, slew, disconnect and backwards time cancel pending measurement', () => {
  for (const interrupt of [
    (frame) => { frame.paused = true; }, (frame) => { frame.inMenu = true; },
    (frame) => { frame.assists.slewActive = true; }, (frame) => { frame.simconnect.connected = false; },
    (frame) => { frame.simconnect.inFlightContext = false; },
    (_frame, time) => { time.nowEpochMs -= 2000; },
    (frame) => { frame.simTime.absoluteSec -= 2000; },
    (frame) => { frame.simTime.absoluteSec += 2000; },
  ]) {
    withMockRunway(MOCK_RUNWAY, (createRunner) => {
      let firstAir = null;
      const { out, finals } = runTakeoff(createRunner, { transform(frame, time) {
        frame.simTime = { absoluteSec: time.nowEpochMs / 1000 };
        if (!frame.wow) {
          firstAir ??= time.nowEpochMs;
          if (time.nowEpochMs === firstAir + 500) interrupt(frame, time);
        }
        return frame;
      } });
      assert.equal(finals.length, 0);
      assert.ok(out.some((message) => message.cancelled));
    });
  }
});

test('missing height times out with explicitly incomplete climb measurements', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { out } = runTakeoff(createRunner, { climbDurationMs: 50_000, transform(frame) {
      frame.ra = null; frame.display.raFt = null; frame.alt_msl = null;
      return frame;
    } });
    const final = out.find((message) => message.final);
    assert.equal(final.finalizeReason, 'timeout_no_height');
    assert.equal(final.screenHeight.reached, false);
    assert.equal(final.assessment, 'caution');
  });
});

test('repeated source snapshots cannot fabricate a crossing and stale snapshots end measurement', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    let firstAir = null;
    const { out } = runTakeoff(createRunner, { transform(frame, time) {
      if (!frame.wow) firstAir ??= time.nowEpochMs;
      frame.simconnect.rustSimvars = { updatedAt: new Date(firstAir ?? time.nowEpochMs).toISOString() };
      return frame;
    } });
    const final = out.find((message) => message.final);
    assert.equal(final.finalizeReason, 'telemetry_gap');
    assert.equal(final.screenHeight.reached, false);
    assert.equal(final.screenHeight.timestampMs, null);
    assert.equal(final.assessment, 'caution');
  });
});

test('late heading deviations preserve the established roll and its warning', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const { finals } = runTakeoff(createRunner, { transform(frame, time) {
      if (time.nowEpochMs >= 1_700_300_029_000) frame.simconnect.hdgTrueDeg = 40;
      return frame;
    } });
    assert.equal(finals.length, 1, 'a heading deviation must not discard a real departure');
    assert.ok(finals[0].takeoff_roll_distance_ft > 3700, 'the original roll is retained');
    assert.ok(finals[0].takeoff_analysis.flags.some((flag) => flag.code === 'heading_deviation'));
  });
});

test('unknown weight-on-wheels cannot start or confirm a takeoff', () => {
  for (const missing of [null, undefined, NaN]) {
    withMockRunway(MOCK_RUNWAY, (createRunner) => {
      const { finals, out } = runTakeoff(createRunner, { climbDurationMs: 50_000, transform(frame) {
        if (!frame.wow) frame.wow = missing;
        return frame;
      } });
      assert.equal(finals.length, 0, 'missing ground state is not proof of liftoff');
      assert.equal(out.some((message) => message.final === false && !message.cancelled), false);
      const interrupted = runTakeoff(createRunner, { transform(frame, time) {
        if (time.nowEpochMs === 1_700_300_033_000) frame.wow = missing;
        return frame;
      } });
      assert.equal(interrupted.finals.length, 0, 'unknown ground state cancels an existing attempt');
      assert.ok(interrupted.out.some((message) => message.cancelled));
      const falseLiftoff = runTakeoff(createRunner, { transform(frame, time) {
        if (time.nowEpochMs === 1_700_300_026_000) frame.wow = missing;
        return frame;
      } });
      assert.ok(falseLiftoff.out.filter((message) => message.final === false && !message.cancelled)
        .every((message) => message.timestampMs >= 1_700_300_032_200), 'missing ground state cannot invent a premature liftoff');
    });
  }
});

test('observation before recording retains the roll but cannot publish a takeoff', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const inactive = runTakeoff(createRunner, { ctxOverrides: { scoringEnabled: false } });
    assert.equal(inactive.out.length, 0);
    assert.equal(inactive.finals.length, 0);
    const delayed = runTakeoff(() => {
      const runner = createRunner();
      const update = runner.update.bind(runner);
      runner.update = (frame, emit, time, ctx) => update(frame, emit, time, { ...ctx, scoringEnabled: time.nowEpochMs >= 1_700_300_015_000 });
      return runner;
    });
    assert.equal(delayed.finals.length, 1);
    assert.equal(delayed.finals[0].takeoff_roll_start_source, 'standstill');
    assert.ok(delayed.finals[0].takeoff_roll_distance_ft > 3700);
  });
});

test('CSV replay preserves missing ground state and converts recorded units', () => {
  const { takeoffFrameFromCsv } = require('./replay-takeoff-csv');
  const frame = takeoffFrameFromCsv({ on_ground: '', ra_ft: '', gs_kts: '0', pitch_deg: '8.5', flaps_pct: '25', flaps_notch: '5' });
  assert.equal(frame.wow, null);
  assert.equal(frame.display.raFt, null);
  assert.equal(frame.display.gsKts, 0);
  assert.equal(frame.attitudeDebug.pitchDegPrimary, 8.5);
  assert.equal(frame.flaps, 0.25);
  assert.equal(frame.flapsIndex, undefined);
});

function recordedTakeoffRows(fixture = 'rolling-runway-entry') {
  const fs = require('node:fs');
  const { parseCsvLine, splitCsvLines } = require(resolveBackendRuntimeFile('utils', 'csv.js'));
  const records = splitCsvLines(fs.readFileSync(path.join(__dirname, `../fixtures/takeoff/${fixture}.csv`), 'utf8'));
  const headers = parseCsvLine(records.shift());
  const liftoffMs = 1_700_000_000_000;
  return records.map((record) => {
    const values = parseCsvLine(record);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    return { ...row, ts: liftoffMs + Number(row.elapsed_ms), aircraft_profile_id: 'pmdg-737' };
  });
}

for (const fixture of ['rolling-runway-entry', 'rolling-unknown-surface']) test(`recorded ${fixture} excludes the preceding fast taxi`, () => {
  const { replayTakeoffRows } = require('./replay-takeoff-csv');
  const rows = recordedTakeoffRows(fixture);
  withMockRunway(null, (createRunner) => {
    const result = replayTakeoffRows(rows, { createRunner });
    assert.equal(result.finals.length, 1);
    const takeoff = result.finals[0];
    assert.equal(takeoff.takeoff_liftoff_timestamp_ms, 1_700_000_000_000);
    assert.equal(takeoff.takeoff_roll_start_source, 'runway_aligned');
    assert.ok(takeoff.takeoff_roll_duration_s >= 25 && takeoff.takeoff_roll_duration_s <= 33,
      `recorded runway entry/alignment was within 33 s of liftoff, got ${takeoff.takeoff_roll_duration_s} s`);
    assert.equal(takeoff.runway_excursion, false);
  });
});

test('a recorded roll mutated into a rejected takeoff never publishes a departure', () => {
  const { replayTakeoffRows } = require('./replay-takeoff-csv');
  const rows = recordedTakeoffRows().map((row) => {
    const ms = Number(row.elapsed_ms);
    if (ms < -5000) return row;
    return { ...row, on_ground: '1', surface_on_ground: '1', surface_on_runway: '1',
      gs_kts: Math.max(0, 100 - (ms + 5000) / 50), ra_ft: 0 };
  });
  withMockRunway(null, (createRunner) => {
    const result = replayTakeoffRows(rows, { createRunner });
    assert.equal(result.finals.length, 0);
    assert.equal(result.messages.length, 0);
    assert.equal(result.pending, false);
  });
});

test('a recorded takeoff with two simulated settle-backs retains both hops and the earlier pitch peak', () => {
  const { replayTakeoffRows } = require('./replay-takeoff-csv');
  const rows = recordedTakeoffRows().map((row) => {
    const ms = Number(row.elapsed_ms);
    if (ms < 0 || ms >= 3500) return row;
    const ground = (ms >= 1000 && ms < 1500) || (ms >= 2500 && ms < 3000);
    return { ...row, on_ground: ground ? '1' : '0', surface_on_ground: ground ? '1' : '0',
      surface_valid: '1', surface_on_runway: ground ? '1' : '0', surface_runway_like: ground ? '1' : '0',
      surface_class: ground ? 'PAVED' : 'UNKNOWN', ra_ft: ground ? 0 : 20,
      pitch_deg: ms < 1000 ? 18 : 8 };
  });
  withMockRunway(null, (createRunner) => {
    const result = replayTakeoffRows(rows, { createRunner });
    assert.equal(result.finals.length, 1);
    const final = result.finals[0];
    assert.equal(final.takeoff_hop_count, 2);
    assert.equal(final.takeoff_max_pitch_deg, 18);
    assert.ok(final.takeoff_analysis.flags.some((flag) => flag.code === 'settled_after_liftoff'));
    assert.equal(result.pending, false);
  });
});

test('a long decelerating landing rollout cannot qualify as an established accelerating takeoff', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { transform(frame, time) {
      const ms = time.nowEpochMs - 1_700_300_000_000;
      frame.display.gsKts = frame.gs = Math.max(90, 160 - ms / 32200 * 70);
      return frame;
    } });
    assert.equal(result.finals.length, 0);
    assert.equal(result.out.length, 0);
  });
});

test('a touch-and-go still qualifies after decelerating and then accelerating without stopping', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { transform(frame, time) {
      const ms = time.nowEpochMs - 1_700_300_000_000;
      frame.display.gsKts = frame.gs = ms < 16000 ? 150 - ms / 16000 * 70
        : Math.min(142, 80 + (ms - 16000) / 16200 * 62);
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_roll_start_source, 'runway_aligned');
  });
});

for (const decelerating of [false, true]) test(`an established ${decelerating ? 'decelerating' : 'speed-limited'} roll still reports its abnormal liftoff`, () => {
  const runway = { ...MOCK_RUNWAY, lengthFt: 4000, physicalLengthFt: 4000 };
  withMockRunway(runway, (createRunner) => {
    let along = 200;
    let previousMs = null;
    const result = runTakeoff(createRunner, { transform(frame, time) {
      const elapsed = time.nowEpochMs - 1_700_300_000_000;
      const accelerating = Math.max(0, Math.min(140, (elapsed - 2000) / 20000 * 140));
      const speed = decelerating && elapsed > 22000 ? Math.max(110, 140 - (elapsed - 22000) / 1000 * 2) : accelerating;
      if (previousMs != null) along += speed * 1.68781 * (time.nowEpochMs - previousMs) / 1000;
      previousMs = time.nowEpochMs;
      frame.display.gsKts = frame.gs = speed;
      frame.display.iasKts = frame.ias = speed;
      Object.assign(frame.simconnect, pointAlong(along));
      if (frame.wow && along > 4000) frame.surface = { ...offRunway, onGround: true };
      return frame;
    } });
    assert.equal(result.finals.length, 1, 'lack of acceleration in the last eight seconds must not erase the departure');
    assert.equal(result.finals[0].takeoff_runway_use_grade, 'Overrun');
    assert.equal(result.finals[0].takeoff_assessment, 'critical');
  });
});

test('an early confirmed climb cannot lend its old roll to a later landing bounce', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { settleBack: true, settleAfterMs: 500, settleForMs: 1000,
      transform(frame, time) {
        if (!frame.wow && time.nowEpochMs < 1_700_300_032_700) frame.display.raFt = 60;
        return frame;
      },
    });
    assert.equal(result.finals.length, 1, 'only a fresh acceleration roll can produce another takeoff after confirmation');
  });
});

test('a recovered settle-back retains the earlier pitch peak and rotation measurement', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { settleBack: true, transform(frame, time) {
      const elapsed = time.nowEpochMs - 1_700_300_000_000;
      if (elapsed >= 30000 && elapsed < 31600) frame.attitudeDebug.pitchDegPrimary = 0;
      if (elapsed >= 31600 && elapsed <= 32100) frame.attitudeDebug.pitchDegPrimary = (elapsed - 31600) / 100 * 2;
      if (!frame.wow && elapsed < 33700) frame.attitudeDebug.pitchDegPrimary = 18;
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_max_pitch_deg, 18, 'the first climb is part of the same takeoff');
    assert.ok(!result.finals[0].takeoff_analysis.flags.some((flag) => flag.code === 'rapid_rotation'));
    const broadcast = result.out.find((message) => message.final);
    assert.ok(broadcast.rotation.priorMaxRateDegS >= 5);
    const csv = buildTakeoffCsvEventData(result.finals[0]);
    const recorded = typeof csv.takeoff_analysis === 'string' ? JSON.parse(csv.takeoff_analysis) : csv.takeoff_analysis;
    assert.ok(recorded.rotation.priorMaxRateDegS >= 5, 'saved debriefs retain the earlier rotation measurement');
  });
});

for (const timeScale of [1, 0.2]) test(`a lateral excursion cannot switch runway after a ${30 * timeScale}-second roll`, () => {
  const parallel = { ...MOCK_RUNWAY, runway: '35R', physicalThreshold: pointAlong(0, 250), threshold: pointAlong(0, 250) };
  withMockRunwayProvider({
    findRunwayByPosition: (_lat, lon) => lon > pointAlong(0, 100).lon ? parallel : MOCK_RUNWAY,
    getRunway: () => MOCK_RUNWAY, findNearbyAirport: () => null,
  }, (createRunner) => {
    const result = runTakeoff(createRunner, { transform(frame, time) {
      if (time.nowEpochMs >= 1_700_300_000_000 + (timeScale < 1 ? 25000 : 28000)) {
        frame.simconnect.lon = pointAlong(0, 250).lon;
        if (frame.wow) frame.surface = { ...offRunway, onGround: true };
      }
      time.nowEpochMs = 1_700_300_000_000 + Math.round((time.nowEpochMs - 1_700_300_000_000) * timeScale);
      time.nowIso = new Date(time.nowEpochMs).toISOString();
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].runway, '35', 'the established runway roll identifies the departure runway');
    assert.equal(result.finals[0].runway_excursion, true);
  });
});

// Reference expectations describe the constructed event, not a snapshot of the
// analyzer's output. See fixtures/takeoff/README.md for evidence and limits.
const referenceCases = [
  { name: 'isolated ground-heading spike', transform(frame, ms) {
    if (ms === 29000) frame.simconnect.hdgTrueDeg = 40;
  } },
  { name: 'isolated ground-position spike', transform(frame, ms) {
    if (ms === 29000) frame.simconnect.lon = pointAlong(0, 250).lon;
  } },
  { name: 'first airborne lateral-position spike', transform(frame, ms) {
    if (ms === 32200) frame.simconnect.lon = pointAlong(0, 250).lon;
  } },
  { name: 'crosswind heading after liftoff', transform(frame) {
    if (!frame.wow) frame.simconnect.hdgTrueDeg = 15;
  } },
  { name: 'single WOW release during the ground roll', transform(frame, ms) {
    if (ms === 26000) frame.wow = false;
  } },
  { name: 'single ground-contact indication during climb', contactUncertain: true, transform(frame, ms) {
    if (ms === 33300) frame.wow = true;
  } },
  { name: 'missing surface data', transform(frame) { frame.surface = {}; } },
  { name: 'missing heading data', transform(frame) {
    frame.simconnect.hdgTrueDeg = null; frame.simconnect.hdgMagDeg = null;
  } },
  { name: 'missing lateral and height observations', incomplete: true, transform(frame) {
    frame.simconnect.lon = null; frame.ra = null; frame.display.raFt = null; frame.alt_msl = null;
  } },
  { name: 'non-finite position and height observations', incomplete: true, transform(frame) {
    frame.simconnect.lon = NaN; frame.ra = NaN; frame.display.raFt = Infinity; frame.alt_msl = Infinity;
  } },
];
for (const reference of referenceCases) test(`reference departure: ${reference.name} cannot invent an operational finding`, () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { climbDurationMs: reference.incomplete ? 50000 : 10000,
      transform(frame, time) { reference.transform(frame, time.nowEpochMs - 1_700_300_000_000); return frame; },
    });
    assert.equal(result.finals.length, 1, 'one constructed departure');
    const final = result.finals[0];
    assert.equal(final.takeoff_hop_count, 0, 'isolated indications are not confirmed settle-backs');
    assert.deepEqual(final.takeoff_analysis.flags.map((flag) => flag.code), reference.incomplete
      ? ['climb_incomplete'] : reference.contactUncertain ? ['ground_contact_uncertain'] : []);
    assert.equal(final.takeoff_analysis.screenHeight.reached, !reference.incomplete);
    assert.equal(final.runway_excursion, false);
  });
});

for (const interval of [200, 500, 1000]) test(`reference departure and excursion survive ${interval} ms sampling`, () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    for (const excursion of [false, true]) {
      const result = runTakeoff(createRunner, { transform(frame, time) {
        const ms = time.nowEpochMs - 1_700_300_000_000;
        if (ms % interval !== 0) return null;
        if (excursion && ms >= 25000 && frame.wow) frame.surface = { ...offRunway, onGround: true };
        return frame;
      } });
      assert.equal(result.finals.length, 1);
      assert.equal(result.finals[0].runway_excursion, excursion);
      assert.equal(result.finals[0].takeoff_assessment, excursion ? 'critical' : 'normal');
      assert.equal(result.finals[0].takeoff_analysis.screenHeight.reached, true);
    }
  });
});

test('a single height spike cannot finalize a takeoff before a real settle-back', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { settleBack: true, transform(frame, time) {
      if (time.nowEpochMs === 1_700_300_033_000) frame.display.raFt = 90;
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_hop_count, 1);
    assert.ok(result.finals[0].takeoff_liftoff_timestamp_ms > 1_700_300_033_000);
  });
});

test('a single screen-height spike cannot invent a measured crossing', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { climbDurationMs: 50000, transform(frame, time) {
      if (!frame.wow) frame.display.raFt = time.nowEpochMs === 1_700_300_033_000 ? 40 : 20;
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_analysis.screenHeight.reached, false);
    assert.equal(result.finals[0].takeoff_finalize_reason, 'timeout');
  });
});

test('a telemetry gap after one contact indication preserves its uncertainty', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { transform(frame, time) {
      const ms = time.nowEpochMs - 1_700_300_000_000;
      if (ms === 33300) frame.wow = true;
      if (ms > 33300 && ms < 37300) return null;
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_finalize_reason, 'telemetry_gap');
    assert.equal(result.finals[0].takeoff_hop_count, 0);
    assert.ok(result.finals[0].takeoff_analysis.flags.some((flag) => flag.code === 'ground_contact_uncertain'));
  });
});

test('two distinct ground observations retain a short genuine settle-back', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const result = runTakeoff(createRunner, { settleBack: true, settleForMs: 200 });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_hop_count, 1);
    assert.ok(!result.finals[0].takeoff_analysis.flags.some((flag) => flag.code === 'ground_contact_uncertain'));
  });
});

test('duplicating a height spike cannot supply its own confirmation', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    const duplicateRunner = () => {
      const runner = createRunner();
      const update = runner.update.bind(runner);
      runner.update = (...args) => { update(...args); update(...args); };
      return runner;
    };
    const result = runTakeoff(duplicateRunner, { settleBack: true, transform(frame, time) {
      if (time.nowEpochMs === 1_700_300_033_000) frame.display.raFt = 90;
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_hop_count, 1);
  });
});

test('the extra confirmation sample preserves the existing pitch-peak measurement endpoint', () => {
  withMockRunway(MOCK_RUNWAY, (createRunner) => {
    let reached = false;
    const result = runTakeoff(createRunner, { transform(frame) {
      if (reached) frame.attitudeDebug.pitchDegPrimary = 25;
      if (!frame.wow && frame.display.raFt >= 50) reached = true;
      return frame;
    } });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_max_pitch_deg, 10);
  });
});

for (const variation of ['duplicate', 'drop-third', 'missing-surface']) test(`recorded reference tolerates ${variation} samples without adding findings`, () => {
  const { replayTakeoffRows } = require('./replay-takeoff-csv');
  let rows = recordedTakeoffRows();
  if (variation === 'duplicate') rows = rows.flatMap((row) => [row, { ...row }]);
  if (variation === 'drop-third') rows = rows.filter((_row, index) => index % 3 !== 0);
  if (variation === 'missing-surface') rows = rows.map((row) => ({ ...row,
    surface_valid: '', surface_on_runway: '', surface_on_ground: '', surface_runway_like: '',
  }));
  withMockRunway(null, (createRunner) => {
    const result = replayTakeoffRows(rows, { createRunner });
    assert.equal(result.finals.length, 1);
    assert.equal(result.finals[0].takeoff_hop_count, 0);
    assert.equal(result.finals[0].runway_excursion, false);
    assert.deepEqual(result.finals[0].takeoff_analysis.flags, []);
    if (variation !== 'missing-surface') {
      assert.ok(result.finals[0].takeoff_roll_duration_s >= 25 && result.finals[0].takeoff_roll_duration_s <= 34);
    }
    assert.equal(result.finals[0].takeoff_roll_start_source, 'runway_aligned', 'missing entry evidence remains a rolling-start estimate');
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
