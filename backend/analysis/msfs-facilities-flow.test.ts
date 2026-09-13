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

test('normal Facilities acquisition flows through live scoring, CSV, timeline and logbook as one snapshot', async (t) => {
  const t0 = Date.UTC(2026, 8, 14, 0, 0, 0);
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: t0 });
  const io = transport();
  const telemetry = new SimConnectTelemetryProvider();
  telemetry._rustSimvarBridge = io.bridge;
  telemetry._data = { lat: 37, lon: -122, ra: 2000 };
  let fallbackLookups = 0;
  t.mock.method(runwayDatabase, 'findNearbyAirport', () => ({ icao: 'TST1' }));
  t.mock.method(runwayDatabase, 'findRunwayByPosition', () => { fallbackLookups += 1; return portable; });
  let payload: RecordData;
  const onFinal = (event: RecordData) => { payload = event; };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-facilities-flow-'));
  eventBus.on('landing:final', onFinal);
  try {
    telemetry._registerMsfsFacilitiesGeometryProvider();
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

    // Isolate geometry/scoring serialization with the legacy CSV envelope.
    // Current manifest/companion/completion integrity has its own bundle suite.
    const columns = getV1Columns().filter(column => column !== 'recording_session_id');
    const row = buildRow({ ...buildLandingCsvEventData(payload!, 'facilities-flow'),
      _recordType: 'LANDING', flightId: 'facilities-flow', flightElapsedMs: 420000 });
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const content = `${columns.join(',')}\n${columns.map(column => escape(row[column])).join(',')}\n`;
    const csvPath = path.join(scratch, 'telemetry.csv');
    fs.writeFileSync(csvPath, content);
    const saved = JSON.stringify(payload!);
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
