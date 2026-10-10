import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const { RustSimvarBridge } = require('../telemetry-provider/rust-simvar-bridge');
const { createMsfsFacilitiesGeometryProvider } = require('../landing/msfs-facilities-geometry-provider');
const geometry = require('../landing/airport-geometry-service');
const runwayDatabase = require('../landing/runway-database');
const { createLandingRunner } = require('../landing/landing-runner');
const { createTakeoffRunner } = require('../takeoff/takeoff-runner');
const { SimpleStabilityScorer, frameToSample } = require('../stability/stability-runner');
const { resolveLandingGeometryScoringInputs } = require('../core/simbridge-core-utils');
const { buildLandingCsvEventData } = require('../flight-recording/landing-csv-contract');
const { buildRow, getV1Columns } = require('../flight-recording/schema-field-map');
const { generateFromCSV } = require('../events/timeline-generator');
const { parseLandingsFromContent } = require('../landing/flight-logbook');
const { gradeLandingForRecordedProfile, gradeLandingForProfile } = require('../landing/landing');
const { parseCsvLine, splitCsvLines } = require('../utils/csv');
const eventBus = require('../core/event-bus');

type RecordData = Record<string, any>;
const runway = {
  icao: 'TST1', runway: '36', headingTrueDeg: 0, heading_true_deg: 0,
  threshold: { lat: 37, lon: -122 }, physicalThreshold: { lat: 36.997257, lon: -122 },
  lengthFt: 8000, physicalLengthFt: 9000, widthFt: 150, displacedThresholdFt: 1000,
  elevation_ft: 200, elevationReference: 'runway', surface: 'ASPHALT',
};
const portable = { ...runway, source: 'ourairports', widthFt: 190, elevation_ft: 210,
  threshold: { lat: 37, lon: -122.001 } };

function transport(callbacks: RecordData = {}) {
  // Only the native process is substituted. Request IDs, wire encoding,
  // response decoding, timeout handling and promise settlement are real.
  const bridge = new RustSimvarBridge({ enabled: true, ...callbacks });
  const sent: RecordData[] = [];
  bridge._started = true;
  bridge._snapshot.status = 'running';
  bridge._proc = { killed: false, stdin: { writable: true, write: (line: string) => {
    sent.push(JSON.parse(line)); return true;
  } } };
  const reply = (message: RecordData = {}) => bridge._onStdout(`${JSON.stringify({
    type: 'facilityAirport', requestId: sent[sent.length - 1].requestId,
    ok: true, icao: 'TST1', airport: { elevationFt: 200 }, runways: [runway], ...message,
  })}\n`);
  const dispose = () => { bridge._rejectPendingFacilityRequests('test_finished'); bridge._started = false; bridge._proc = null; };
  return { bridge, sent, reply, dispose };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('normal startup acquires Facilities after a late simulator connection and reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: Date.UTC(2026, 8, 14) });
  const telemetry = new SimConnectTelemetryProvider();
  const io = transport({
    onSnapshot: (snapshot: RecordData) => telemetry._handleRustSimvarSnapshot(snapshot),
    onStatus: (snapshot: RecordData) => telemetry._handleRustSimvarStatus(snapshot),
  });
  io.bridge._snapshot.status = 'ready';
  telemetry._rustSimvarBridge = io.bridge;
  // Optional aircraft-control bridges are outside this acquisition path.
  t.mock.method(telemetry, '_initLvarBridge', async () => {});
  t.mock.method(telemetry, '_initSdkBridge', async () => {});
  t.mock.method(runwayDatabase, 'findNearbyAirport', () => ({ icao: 'TST1' }));
  const requests = () => io.sent.filter(message => message.type === 'requestFacilityAirport');
  const receive = (message: RecordData) => io.bridge._onStdout(`${JSON.stringify(message)}\n`);
  try {
    await telemetry.start();
    assert.ok(telemetry._msfsFacilitiesWarmupTimer, 'normal startup must start acquisition without a manual registration call');
    assert.equal(telemetry._msfsFacilitiesProbeTimer, null);
    assert.equal(requests().length, 0, 'a ready sidecar without a simulator connection must wait');
    receive({ type: 'status', state: 'connected' });
    t.mock.timers.tick(10000);
    assert.equal(requests().length, 0, 'a connection without position must still wait');
    receive({ type: 'snapshot', values: { lat: 37, lon: -122, ra: 11000 } });
    t.mock.timers.tick(10000);
    assert.equal(requests().length, 0, 'radio height received from the bridge is in feet');
    receive({ type: 'snapshot', values: { ra: 9000 } });
    t.mock.timers.tick(10000);
    assert.equal(requests().length, 1, 'descent must activate acquisition through real telemetry callbacks');
    io.reply();
    await flush();
    assert.equal(geometry.getRunway('TST1', '36', { simulator: 'msfs' }).source, 'msfs-facilities');
    receive({ type: 'status', state: 'disconnected' });
    t.mock.timers.tick(610000);
    assert.equal(requests().length, 1, 'disconnection must suppress background requests even after cache expiry');
    receive({ type: 'snapshot', values: { lat: 37, lon: -122, ra: 2000 } });
    t.mock.timers.tick(10000);
    assert.equal(requests().length, 2, 'the existing timer must resume acquisition after reconnect');
    io.reply();
    await flush();
    assert.equal(geometry.getRunway('TST1', '36', { simulator: 'msfs' }).source, 'msfs-facilities');
  } finally {
    telemetry._stopMsfsFacilitiesWarmup();
    telemetry._stopMsfsFacilitiesProbe();
    io.dispose();
    geometry.resetAirportGeometryProviders();
  }
});

function landingFrame(onGround: boolean, gsKts = 130): RecordData {
  const raFt = onGround ? 0 : 120;
  return {
    wow: onGround, vs: -128 * 0.3048 / 60, ra: raFt * 0.3048, ias: 140, gs: gsKts,
    alt_msl: 200 + raFt, lights: {}, flaps: 0.85, spoilers: { state: 'STOWED', fraction: 0 },
    surface: { onGround, valid: true, runwayLike: true, onRunway: onGround, raw: 4, name: 'ASPHALT', class: 'PAVED' },
    display: { iasKts: 140, vsFpm: -128, raFt, gsKts },
    simconnect: { lat: 37 + 2000 / 364567, lon: -122, hdgTrueDeg: 0, hdgMagDeg: 0 },
    attitudeDebug: { pitchDegPrimary: 2, bankDegPrimary: 0 }, windSpeed: 8, windDir: 45, gforce: 1.1,
  };
}

test('Facilities scoring, CSV, timeline and logbook preserve their snapshot across cache eviction and reload', async (t) => {
  const t0 = Date.UTC(2026, 8, 14, 0, 0, 0);
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: t0 });
  const io = transport();
  const telemetry = new SimConnectTelemetryProvider();
  telemetry._rustSimvarBridge = io.bridge;
  telemetry._data = { lat: 37, lon: -122, ra: 2000 };
  const provider = createMsfsFacilitiesGeometryProvider(io.bridge, { cacheMaxEntries: 2, logger: null });
  let fallbackLookups = 0;
  t.mock.method(runwayDatabase, 'findNearbyAirport', () => ({ icao: 'TST1' }));
  t.mock.method(runwayDatabase, 'findRunwayByPosition', () => { fallbackLookups += 1; return portable; });
  t.mock.method(runwayDatabase, 'getRunway', () => { fallbackLookups += 1; return portable; });
  let payload: RecordData;
  const onFinal = (event: RecordData) => { payload = event; };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-facilities-flow-'));
  eventBus.on('landing:final', onFinal);
  try {
    // Startup registration is covered above. Use the real acquisition path
    // with a small cache budget to exercise turnover without dozens of airports.
    telemetry._msfsFacilitiesGeometryProvider = provider;
    geometry.registerAirportGeometryProvider(provider);
    telemetry._startMsfsFacilitiesWarmup();
    assert.equal(telemetry._msfsFacilitiesProbeTimer, null);
    assert.equal(io.sent.length, 1);
    assert.equal(io.sent[0].type, 'requestFacilityAirport');
    assert.equal(io.sent[0].icao, 'TST1');
    io.reply();
    await flush();
    t.mock.timers.tick(10000);
    assert.equal(io.sent.length, 1, 'fresh airport data does not generate another API request');

    const runner = createLandingRunner();
    const broadcasts: RecordData[] = [];
    const ctx = { phase: 'LANDING', aircraftProfileId: 'generic', aircraftName: 'Facilities fixture', dataSource: 'rust-simvars' };
    for (const [offset, grounded, speed] of [[0, false, 130], [100, true, 130], [120000, true, 40]] as const) {
      runner.update(landingFrame(grounded, speed), event => broadcasts.push(event), {
        nowEpochMs: t0 + offset, nowIso: new Date(t0 + offset).toISOString(),
        flightStartEpochMs: t0 - 300000, flightStartIso: new Date(t0 - 300000).toISOString(),
      }, ctx);
    }
    assert.ok(payload!, 'landing finalization emitted its canonical payload');
    const landing = broadcasts.find(event => event.final === true);
    assert.equal(fallbackLookups, 0, 'a usable Facilities runway must bypass the portable runway lookup');
    assert.equal(payload!.runway_geometry_source, 'msfs-facilities');
    assert.equal(payload!.runway_geometry_provider_chain, 'msfs-facilities:hit');
    assert.equal(payload!.touchdown_distance_ft, 2000);
    assert.equal(payload!.touchdown_distance_grade, 'Good');
    assert.equal(payload!.lateral_offset_suspect, false);
    assert.equal(payload!.lateral_offset_score, 100);
    assert.equal(payload!.runway_width_ft, 150);
    assert.equal(payload!.runway_displaced_threshold_ft, 1000);
    assert.equal(payload!.runway_reference_elev_ft, 200);
    assert.equal(landing?.touchdownDistance.distanceFt, payload!.touchdown_distance_ft);
    assert.equal(landing?.touchdownDistance.lateralOffsetScore, payload!.lateral_offset_score);

    const scoringInputs = resolveLandingGeometryScoringInputs(payload!);
    assert.deepEqual(scoringInputs.runwayThreshold, runway.threshold);
    const scorer = new SimpleStabilityScorer();
    for (let i = 0; i < 90; i += 1) {
      scorer.addSample(frameToSample({ tMs: t0 - 90000 + i * 1000, dtMs: 1000,
        raFt: 1100 - i * 11, altMslFt: 1300 - i * 11, iasKts: 140, selectedSpeedKts: 140,
        vsFpm: -660, gsKts: 140, gearDownLocked: 1, flapsPercent: 85,
        spoilersPercent: 0, spoilersState: 'ARMED', pitchDeg: 2, bankDeg: 0, thrustPct: 45, onGround: false }));
    }
    const approach = scorer.getScore(scoringInputs.thresholdElevFt, {
      lateralOffsetFt: payload!.lateral_offset_ft, lateralOffsetSuspect: payload!.lateral_offset_suspect,
      runwayWidthFt: scoringInputs.runwayWidthFt,
    });
    assert.ok(Number.isFinite(approach.score), 'simulator elevation and alignment feed the approach scorer');
    assert.equal(approach.breakdown.lateral_offset_ok, 100);
    payload!.ultimate_stability_score = approach.score;

    const saved = JSON.stringify(payload!);
    const heldRunway = provider.getRunway('TST1', '36');
    const heldRunwaySnapshot = JSON.stringify(heldRunway);
    telemetry._stopMsfsFacilitiesWarmup();
    // Synthetic subsequent-airport fixtures, about 30 NM apart with requests
    // 30 minutes apart. This checks cache turnover, not measured live-flight RAM.
    for (const [icao, latitude] of [['TST2', 37.5], ['TST3', 38]] as const) {
      t.mock.timers.tick(30 * 60 * 1000);
      const pending = provider.probeAirport(icao);
      io.reply({ icao, runways: [{ ...runway, icao,
        threshold: { lat: latitude, lon: -122 },
        physicalThreshold: { lat: latitude - 0.002743, lon: -122 } }] });
      assert.equal((await pending).ok, true);
    }
    assert.equal(provider.getDiagnosticSnapshot().cacheEntryCount, 2);
    assert.deepEqual(provider.getDiagnosticSnapshot().cachedIcaos, ['TST2', 'TST3']);
    assert.equal(JSON.stringify(heldRunway), heldRunwaySnapshot, 'eviction must not clear geometry held by a consumer');
    assert.equal(JSON.stringify(payload!), saved, 'eviction must preserve the canonical landing snapshot');

    const lookup = () => geometry.getRunway('TST1', '36', { simulator: 'msfs' });
    const requestsBeforeReload = io.sent.length;
    const fallback = lookup();
    const fallbackSnapshot = JSON.stringify(fallback);
    assert.equal(fallback.source, 'ourairports', 'an evicted airport keeps the existing cold-cache fallback');
    lookup();
    assert.equal(io.sent.length, requestsBeforeReload + 1, 'an evicted airport reload is still deduplicated');
    io.reply({ ok: false, error: 'temporary_failure' });
    await flush();
    assert.equal(lookup().source, 'ourairports', 'failed reload continues to use the portable runway');
    assert.equal(io.sent.length, requestsBeforeReload + 1, 'failed reload respects retry backoff');
    t.mock.timers.tick(30000);
    lookup();
    assert.equal(io.sent.length, requestsBeforeReload + 2);
    io.reply({ runways: [{ ...runway, widthFt: 170, elevation_ft: 225 }] });
    await flush();
    assert.equal(lookup().source, 'msfs-facilities', 'successful retry restores simulator geometry priority');
    assert.equal(lookup().widthFt, 170, 'new lookups receive the reloaded geometry');
    assert.equal(JSON.stringify(fallback), fallbackSnapshot, 'recovery must preserve the prior fallback snapshot');
    assert.equal(JSON.stringify(heldRunway), heldRunwaySnapshot, 'reload must not mutate geometry previously held by a consumer');
    assert.equal(JSON.stringify(payload!), saved, 'reload must not revise an already finalized landing');

    // Isolate geometry/scoring serialization with the legacy CSV envelope.
    // Current manifest/companion/completion integrity has its own bundle suite.
    const columns = getV1Columns().filter(column => column !== 'recording_session_id');
    const row = buildRow({ ...buildLandingCsvEventData(payload!, 'facilities-flow'),
      _recordType: 'LANDING', flightId: 'facilities-flow', flightElapsedMs: 420000 });
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const content = `${columns.join(',')}\n${columns.map(column => escape(row[column])).join(',')}\n`;
    const csvPath = path.join(scratch, 'telemetry.csv');
    fs.writeFileSync(csvPath, content);
    // Disconnect before replay: recorded geometry must remain authoritative.
    io.bridge._snapshot.status = 'stopped';
    geometry.resetAirportGeometryProviders();
    const replay = await generateFromCSV(csvPath);
    assert.equal(replay.success, true, replay.error);
    const replayLanding = replay.timeline.events.find(event => event.type === 'landing');
    const entries = parseLandingsFromContent(content, csvPath, parseCsvLine,
      gradeLandingForRecordedProfile, splitCsvLines, gradeLandingForProfile);
    assert.equal(entries.length, 1);
    for (const result of [replayLanding.touchdownDistance, entries[0]]) {
      assert.equal(result.runwayGeometrySource, 'msfs-facilities');
      assert.equal(result.runwayWidthFt, 150);
      assert.equal(result.runwayDisplacedThresholdFt, 1000);
      assert.equal(result.lateralOffsetScore, 100);
    }
    assert.equal(replayLanding.touchdownDistance.distanceFt, 2000);
    assert.equal(entries[0].touchdownDistanceFt, 2000);
    assert.equal(entries[0].stabilityScore, approach.score);
    assert.equal(JSON.stringify(payload!), saved, 'replay cannot mutate the live snapshot');
  } finally {
    eventBus.off('landing:final', onFinal);
    telemetry._stopMsfsFacilitiesWarmup();
    telemetry._stopMsfsFacilitiesProbe();
    io.dispose();
    geometry.resetAirportGeometryProviders();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('Facilities timeout falls back, retries, recovers priority and preserves prior snapshots', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 8, 14) });
  const io = transport();
  const provider = createMsfsFacilitiesGeometryProvider(io.bridge, { logger: null });
  geometry.registerAirportGeometryProvider(provider);
  let fallbackLookups = 0;
  t.mock.method(runwayDatabase, 'getRunway', () => { fallbackLookups += 1; return portable; });
  const lookup = () => geometry.getRunway('TST1', '36', { simulator: 'msfs' });
  try {
    const cold = lookup();
    const original = JSON.stringify(cold);
    assert.equal(cold.source, 'ourairports');
    lookup();
    assert.equal(io.sent.length, 1, 'pending requests must be deduplicated');
    t.mock.timers.tick(4000);
    await flush();
    assert.equal(provider.getDiagnosticSnapshot().lastOutcome.error, 'timeout');
    assert.equal(lookup().source, 'ourairports');
    t.mock.timers.tick(30000);
    lookup();
    assert.equal(io.sent.length, 2, 'a timed-out request retries after backoff');
    io.reply();
    await flush();
    const fallbackCount = fallbackLookups;
    const live = lookup();
    assert.equal(live.source, 'msfs-facilities');
    assert.equal(live.widthFt, 150);
    assert.equal(fallbackLookups, fallbackCount, 'a recovered Facilities provider wins without consulting fallback');
    assert.equal(JSON.stringify(cold), original, 'a late response must not replace an earlier fallback snapshot');
    const liveSnapshot = JSON.stringify(live);
    t.mock.timers.tick(600001);
    lookup();
    io.reply({ ok: false, error: 'temporary_failure' });
    await flush();
    assert.equal(lookup().source, 'msfs-facilities', 'failed refresh retains known usable simulator geometry');
    assert.equal(JSON.stringify(live), liveSnapshot);
    io.bridge._snapshot.status = 'stopped';
    assert.equal(lookup().source, 'ourairports', 'disconnected simulator permits fallback');
    io.bridge._snapshot.status = 'running';
    assert.equal(lookup().source, 'msfs-facilities', 'reconnected simulator restores preferred cached geometry');
  } finally { io.dispose(); geometry.resetAirportGeometryProviders(); }
});

for (const failure of ['failed response', 'null response', 'rejected request'] as const) {
  test(`pending Facilities refresh preserves last-good geometry after eviction and ${failure}`, async (t) => {
    const io = transport();
    const provider = createMsfsFacilitiesGeometryProvider(io.bridge, { cacheMaxEntries: 1, logger: null });
    geometry.registerAirportGeometryProvider(provider);
    try {
      const initial = provider.probeAirport('TST1');
      io.reply({ airport: { elevationFt: 200, lat: 37, lon: -122 },
        // Minimal geometry fixture for availability; route planning is covered separately.
        taxiways: { complete: true, points: [{ id: 0, x: 10, z: 20 }], paths: [] } });
      assert.equal((await initial).ok, true);
      const heldAirport = provider._cache.get('TST1');
      const heldAirportSnapshot = JSON.stringify(heldAirport);
      const heldRunway = provider.getRunway('TST1', '36');
      const heldTaxi = provider.getTaxiAirport('TST1', null);
      const heldTaxiSnapshot = JSON.stringify(heldTaxi);

      let resolveRefresh!: (value: RecordData | null) => void;
      let rejectRefresh!: (error: Error) => void;
      const refreshResponse = new Promise<RecordData | null>((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
      });
      const request = io.bridge.requestFacilityAirport.bind(io.bridge);
      t.mock.method(io.bridge, 'requestFacilityAirport', (icao: string, options: RecordData) =>
        icao === 'TST1' ? refreshResponse : request(icao, options));
      const refresh = provider.probeAirport('TST1');
      const competing = provider.probeAirport('TST2');
      io.reply({ icao: 'TST2', runways: [{ ...runway, icao: 'TST2',
        threshold: { lat: 37.5, lon: -122 }, physicalThreshold: { lat: 37.497257, lon: -122 } }] });
      assert.equal((await competing).ok, true);
      assert.deepEqual(provider.getDiagnosticSnapshot().cachedIcaos, ['TST2']);
      assert.deepEqual(provider.getDiagnosticSnapshot().pendingIcaos, ['TST1']);

      if (failure === 'rejected request') rejectRefresh(new Error('temporary_failure'));
      else resolveRefresh(failure === 'null response' ? null : { ok: false, error: 'temporary_failure' });
      const outcome = await refresh;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error, failure === 'null response' ? 'empty_response' : 'temporary_failure');
      assert.equal(provider.getDiagnosticSnapshot().cacheEntryCount, 1);
      assert.deepEqual(provider.getDiagnosticSnapshot().cachedIcaos, ['TST1']);
      assert.deepEqual(provider.getDiagnosticSnapshot().pendingIcaos, []);
      const restored = geometry.getRunway('TST1', '36', { simulator: 'msfs' });
      assert.equal(restored.source, 'msfs-facilities', 'failed refresh retains usable runway geometry for landing analysis');
      assert.equal(restored.widthFt, 150);
      assert.equal(provider.getRunway('TST1', '36'), heldRunway);
      assert.throws(() => provider.getTaxiAirport('TST1', null), /Live airport data for TST1 are unavailable/,
        'new taxi planning still rejects the failed refresh rather than consuming stale geometry');
      assert.equal(JSON.stringify(heldAirport), heldAirportSnapshot, 'failure must not mutate the retained previous cache record');
      assert.equal(JSON.stringify(heldTaxi), heldTaxiSnapshot, 'failure must not alter geometry already held by a taxi consumer');
    } finally { io.dispose(); geometry.resetAirportGeometryProviders(); }
  });
}

for (const operation of ['landing', 'takeoff'] as const) {
  test(`normal warmup retains the current airport in a full cache through ${operation} finalization`, async (t) => {
    const t0 = Date.UTC(2026, 9, 10);
    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: t0 });
    const io = transport();
    const telemetry = new SimConnectTelemetryProvider();
    const provider = createMsfsFacilitiesGeometryProvider(io.bridge, { logger: null });
    telemetry._rustSimvarBridge = io.bridge;
    telemetry._msfsFacilitiesGeometryProvider = provider;
    geometry.registerAirportGeometryProvider(provider);
    let fallbackLookups = 0;
    t.mock.method(runwayDatabase, 'findNearbyAirport', () => ({ icao: 'TST1' }));
    t.mock.method(runwayDatabase, 'findRunwayByPosition', () => { fallbackLookups += 1; return portable; });
    t.mock.method(runwayDatabase, 'getRunway', () => { fallbackLookups += 1; return portable; });
    const finals: RecordData[] = [];
    const onFinal = (payload: RecordData) => finals.push(payload);
    eventBus.on(`${operation}:final`, onFinal);
    try {
      // Prefilled capacity fixture representing prior use, not 32 airports flown
      // during this capture window. The active airport starts least recently used.
      for (let index = 0; index < 32; index += 1) {
        const icao = index === 0 ? 'TST1' : `C${String(index).padStart(3, '0')}`;
        const latitude = index === 0 ? 37 : 38 + index / 20;
        const pending = provider.probeAirport(icao);
        io.reply({ icao, runways: [{ ...runway, icao,
          threshold: { lat: latitude, lon: -122 },
          physicalThreshold: { lat: latitude - 0.002743, lon: -122 } }] });
        assert.equal((await pending).ok, true);
      }
      assert.equal(provider.getDiagnosticSnapshot().cacheEntryLimit, 32);
      assert.equal(provider.getDiagnosticSnapshot().cacheEntryCount, 32);
      assert.equal([...provider._cache.keys()][0], 'TST1');
      const requestCount = io.sent.length;
      const runner = operation === 'landing' ? createLandingRunner() : createTakeoffRunner();
      const ctx = { phase: operation === 'landing' ? 'LANDING' : 'TAKEOFF', aircraftProfileId: 'generic',
        aircraftName: 'Facilities fixture', dataSource: 'rust-simvars', simulator: 'msfs' };
      const knotsToFeetPerSecond = 6076.12 / 3600;
      const dtSeconds = 0.2;
      const durationSeconds = operation === 'landing' ? 80 : 42;
      let alongFt = operation === 'landing' ? 1000 - 130 * knotsToFeetPerSecond * 20 : -800;
      let previousGs = operation === 'landing' ? 130 : 0;
      let warmupChecks = 0;
      const warm = telemetry._warmMsfsFacilitiesAirport.bind(telemetry);
      t.mock.method(telemetry, '_warmMsfsFacilitiesAirport', () => { warmupChecks += 1; warm(); });
      for (let step = 0; step <= durationSeconds / dtSeconds; step += 1) {
        const seconds = step * dtSeconds;
        const grounded = operation === 'landing' ? seconds >= 20 : seconds <= 32;
        const gs = operation === 'landing' ? Math.max(20, 130 - Math.max(0, seconds - 20) * 2.75)
          : Math.min(140, Math.max(0, seconds - 2) / 30 * 140);
        // Flare over the last five seconds from 720 to 128 fpm; integrate
        // that descent rate so radio height and vertical speed agree.
        const remaining = Math.max(0, 20 - seconds);
        const flareRate = 128 / 60;
        const flareDeceleration = (12 - flareRate) / 5;
        const landingRaFt = remaining <= 5 ? flareRate * remaining + 0.5 * flareDeceleration * remaining ** 2
          : flareRate * 5 + 0.5 * flareDeceleration * 25 + (remaining - 5) * 12;
        const raFt = operation === 'landing' ? landingRaFt
          : Math.max(0, seconds - 32) * 12;
        if (step > 0) alongFt += (previousGs + gs) / 2 * knotsToFeetPerSecond * dtSeconds;
        previousGs = gs;
        const frame = landingFrame(grounded, gs);
        frame.display.raFt = raFt;
        frame.ra = raFt * 0.3048;
        frame.alt_msl = 200 + raFt;
        frame.ias = gs;
        frame.display.iasKts = gs;
        frame.display.vsFpm = grounded ? 0 : operation === 'landing' ? -60 * Math.min(12, flareRate + flareDeceleration * remaining) : 720;
        frame.vs = frame.display.vsFpm * 0.3048 / 60;
        frame.attitudeDebug.pitchDegPrimary = operation === 'takeoff' && !grounded ? 10 : 2;
        frame.simconnect.lat = 37 + alongFt / 364567;
        // Remain on the runway centerline while slowing to 20 kt. The landing
        // finalizes at its 60 s occupancy deadline, still within the 8000 ft runway.
        frame.simconnect.lon = -122;
        frame.surface.onRunway = grounded;
        telemetry._data = { lat: frame.simconnect.lat, lon: frame.simconnect.lon, ra: raFt };
        if (step === 0) telemetry._startMsfsFacilitiesWarmup();
        else t.mock.timers.tick(dtSeconds * 1000);
        runner.update(frame, () => {}, { nowEpochMs: t0 + seconds * 1000,
          nowIso: new Date(t0 + seconds * 1000).toISOString(),
          flightStartEpochMs: t0 - 300000, flightStartIso: new Date(t0 - 300000).toISOString() }, ctx);
      }
      assert.ok(warmupChecks >= 5, 'normal acquisition keeps running throughout the capture');
      assert.equal(io.sent.length, requestCount, 'touching a fresh airport must not force Facilities refreshes');
      assert.equal([...provider._cache.keys()].at(-1), 'TST1', 'normal warmup retains the current airport as most recently used');
      assert.equal(provider.getDiagnosticSnapshot().cacheEntryCount, 32);
      assert.equal(finals.length, 1, 'production capture emits one final result');
      assert.equal(finals[0].runway_geometry_source, 'msfs-facilities');
      assert.equal(finals[0].runway_geometry_provider_chain, 'msfs-facilities:hit');
      assert.equal(finals[0].icao, 'TST1');
      assert.equal(finals[0].runway, '36');
      assert.equal(finals[0].runway_width_ft, 150);
      assert.equal(fallbackLookups, 0, 'current Facilities geometry remains authoritative at delayed finalization');
      const scoredAtMs = operation === 'landing' ? finals[0].timestamp_ms : finals[0].scored_timestamp_ms;
      const captureAtMs = operation === 'landing' ? t0 + 20000 : finals[0].timestamp_ms;
      assert.ok(scoredAtMs >= captureAtMs + 4000,
        'the assertion must cover delayed finalization, not immediate geometry selection');
    } finally {
      eventBus.off(`${operation}:final`, onFinal);
      telemetry._stopMsfsFacilitiesWarmup();
      io.dispose();
      geometry.resetAirportGeometryProviders();
    }
  });
}

for (const failure of ['failed response', 'empty runways'] as const) {
  test(`an evicted alias ${failure} preserves a newer canonical airport response`, async () => {
    const io = transport();
    // Reduced capacity forces the supported alias/request ordering; this is
    // an ownership regression, not evidence of an observed in-flight failure.
    const provider = createMsfsFacilitiesGeometryProvider(io.bridge, { cacheMaxEntries: 2, logger: null });
    try {
      const initial = provider.probeAirport('OLD1');
      io.reply(); // The simulator supplies the canonical ICAO, TST1.
      assert.equal((await initial).ok, true);
      const initialAirport = provider._cache.get('TST1');
      const initialSnapshot = JSON.stringify(initialAirport);
      assert.equal(provider._cache.get('OLD1'), initialAirport);

      const delayedAlias = provider.probeAirport('OLD1');
      const delayedRequestId = io.sent[io.sent.length - 1].requestId;
      const competing = provider.probeAirport('TST2');
      io.reply({ icao: 'TST2', runways: [{ ...runway, icao: 'TST2',
        threshold: { lat: 37.5, lon: -122 }, physicalThreshold: { lat: 37.497257, lon: -122 } }] });
      assert.equal((await competing).ok, true);
      assert.equal(provider._cache.has('OLD1'), false);
      assert.equal(provider._cache.has('TST1'), false, 'both old aliases must actually be evicted');

      const current = provider.probeAirport('TST1');
      io.reply({ runways: [{ ...runway, widthFt: 164 }] });
      assert.equal((await current).ok, true);
      const latestAirport = provider._cache.get('TST1');
      const latestSnapshot = JSON.stringify(latestAirport);
      const latestRunway = provider.getRunway('TST1', '36');

      io.reply({ requestId: delayedRequestId, ...(failure === 'failed response'
        ? { ok: false, error: 'temporary_failure' } : { runways: [] }) });
      const outcome = await delayedAlias;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error, failure === 'failed response' ? 'temporary_failure' : 'empty_facility_response');
      assert.equal(provider.getRunway('TST1', '36'), latestRunway,
        'an older alias failure must not replace the newer canonical runway');
      assert.equal(provider.getRunway('OLD1', '36'), latestRunway, 'restored aliases share the newer geometry');
      assert.equal(latestRunway.widthFt, 164);
      assert.equal(provider.getDiagnosticSnapshot().cacheEntryCount, 2);
      assert.deepEqual(provider.getDiagnosticSnapshot().pendingIcaos, []);
      assert.throws(() => provider.getTaxiAirport('TST1', null), /Live airport data for TST1 are unavailable/,
        'the existing failed-refresh taxi gate remains in force');
      assert.equal(JSON.stringify(initialAirport), initialSnapshot, 'held old geometry remains unchanged');
      assert.equal(JSON.stringify(latestAirport), latestSnapshot, 'failure metadata must not mutate held fresh geometry');
    } finally { io.dispose(); }
  });
}
