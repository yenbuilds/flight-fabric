/**
 * Exercises the non-mock core recording listener with a plausible synthetic
 * approach, flare and rollout. Retry/failure modes deliberately inject scorer
 * errors; sparse CSV events are contract-robustness cases, not flight scenarios.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2] || 'normal';
const snapshotPath = process.argv[3];
assert(['normal', 'retry', 'failure'].includes(mode));
process.env.FLIGHT_START_REQUIRE_MOVEMENT = '0';
process.env.FLIGHT_END_PARKED_ENGINES_OFF_ENABLE = '0';
process.env.UPDATE_CHECKS_ENABLED = '0';
const runtime = (...parts: string[]) => path.join(__dirname, '../../backend', ...parts);
const eventBus = require(runtime('core/event-bus.js'));
const timeSource = require(runtime('core/time-source.js'));
const clock = timeSource.createFixedSource(1_800_000_000_000);
const tickFrames = require(runtime('lifecycle/tick-frame.js'));
const createTickFrameFactory = tickFrames.createTickFrameFactory;
tickFrames.createTickFrameFactory = options => createTickFrameFactory({
  ...options, monotonicTimeSource: {now: clock.get},
});
const geometry = require(runtime('landing/airport-geometry-service.js'));
// Plausible synthetic runway: northbound, 10,000 x 150 ft, elevation 425 ft.
const runway = {
  icao: 'TEST', runway: '36', runwayId: '36', heading: 0,
  headingTrueDeg: 0, lengthFt: 10000, physicalLengthFt: 10000,
  widthFt: 150, threshold: {lat: 48.995, lon: 2.55},
  physicalThreshold: {lat: 48.995, lon: 2.55}, displacedThresholdFt: 0,
  elevation_ft: 425, elevationReference: 'runway', source: 'msfs-facilities', surface: 'ASP',
};
geometry.findRunwayByPosition = () => runway;
geometry.getRunway = () => runway;
geometry.findNearbyAirport = () => runway;
// Inject failures before the scorer consumes its approach. Keep the production
// scorer and CSV writer active so the fallback and recording order are tested.
const order: string[] = [];
const {SimpleStabilityScorer} = require(runtime('stability/stability-runner.js'));
const originalGetScore = SimpleStabilityScorer.prototype.getScore;
let scoreAttempts = 0;
SimpleStabilityScorer.prototype.getScore = function (...args) {
  scoreAttempts++;
  order.push('score');
  if (mode === 'failure' || (mode === 'retry' && scoreAttempts === 1)) {
    throw new Error('Deliberate scorer failure for recovery regression');
  }
  return originalGetScore.apply(this, args);
};
const writer = require(runtime('flight-recording/flight-csv-writer.js'));
const originalWriteEvent = writer.writeEvent;
writer.writeEvent = function (eventType, ...args) {
  if (eventType === 'LANDING') order.push('csv');
  return originalWriteEvent.call(this, eventType, ...args);
};
const {runSimbridgeCore} = require(runtime('core/simbridge-core.js'));
const {parseCsvLine, splitCsvLines} = require(runtime('utils/csv.js'));
const shutdown = new AbortController();
const publicMessages = [];
const finals = [];
const streams = {};
for (const name of ['ias', 'vs', 'altitude', 'surface', 'phase', 'rates', 'iast',
  'gear', 'flaps', 'spoilers', 'autopilot', 'attitude', 'position', 'xwind']) {
  streams[name] = [];
  eventBus.on('telemetry:' + name, payload => streams[name].push(clean(payload)));
}
let elapsedMs = -200;
let flightStarts = 0;
const clean = value => JSON.parse(JSON.stringify(value, (key, data) => (
  ['user_id', 'session_id', 'recording_session_id', 'event_id'].includes(key) ? '<identity>' : data
)));
eventBus.on('flight:started', () => flightStarts++);
eventBus.on('telemetry:landing', payload => publicMessages.push(clean(payload)));
eventBus.on('telemetry:ultimateStabilityScore', payload => {
  order.push('broadcast');
  publicMessages.push(clean(payload));
});
eventBus.on('landing:final', payload => {
  // Core's later synchronous listener enriches this same payload before writing
  // CSV; capture after all handlers have run, not the provisional nulls.
  queueMicrotask(() => finals.push(clean(payload)));
});
const speedKts = 138;
const speedFtS = speedKts * 1.687809857;
const flareStartS = (1500 - 42) / 12;
const touchdownS = flareStartS + 6;
const thresholdS = (1500 - 50) / 12;
function frameAt(seconds: number) {
  const wow = seconds >= touchdownS;
  const flareS = Math.max(0, Math.min(6, seconds - flareStartS));
  const height = wow ? 0 : seconds <= flareStartS
    ? 1500 - seconds * 12 : 42 - 12 * flareS + (5 / 6) * flareS * flareS;
  const vsFpm = wow ? 0 : seconds <= flareStartS ? -720 : (-12 + (5 / 3) * flareS) * 60;
  const rollS = Math.max(0, seconds - touchdownS);
  const speed = wow ? Math.max(20, speedKts - 2.95 * rollS) : speedKts;
  const decelS = Math.min(40, rollS);
  const alongFt = wow
    ? (touchdownS - thresholdS) * speedFtS + (speedKts * decelS - 0.5 * 2.95 * decelS * decelS) * 1.687809857 + Math.max(0, rollS - 40) * 20 * 1.687809857
    : (seconds - thresholdS) * speedFtS;
  const lat = runway.threshold.lat + alongFt / 364000;
  return {
    paused: false, inMenu: false, assists: {slewActive: false, anyAssistActive: false},
    lights: {}, wow, lat, lon: 2.55, alt_msl: 425 + height,
    pitch: 3 * Math.PI / 180, bank: 0, heading: 0, attitudeValid: true,
    ias: speed, gs: speed, vs: vsFpm / 196.8503937, ra: height / 3.280839895,
    display: {iasKts: speed, gsKts: speed, vsFpm, raFt: height},
    gforce: wow && rollS < 1 ? 1.15 : 1,
    gearHandle: 1, gearDownLocked: true, gearConfigurationAvailable: true,
    flaps: 1, flapsIndex: 4, flapsAngleDeg: 35, flapsConfigurationAvailable: true,
    spoilers: {state: wow && rollS > 1 ? 'DEPLOYED' : 'STOWED', percent: wow && rollS > 1 ? 100 : 0},
    windSpeed: 5, windDir: 0,
    throttle: {engines: [{position: wow ? 0 : 0.45}, {position: wow ? 0 : 0.45}]},
    simconnect: {connected: true, inFlightContext: true, simRunning: true,
      aircraftLoadedName: 'FlyByWire A32NX', lat, lon: 2.55, hdgTrueDeg: 0, hdgMagDeg: 0},
    fdm: {anyEngineRunning: true, eng1N1: wow ? 25 : 55, eng2N1: wow ? 25 : 55,
      altPlaneFt: 425 + height, altIndicatedFt: 425 + height, altCalibratedFt: 425 + height,
      aircraftAglFt: height, gForce: wow && rollS < 1 ? 1.15 : 1, visibilityM: 10000},
    surface: {valid: true, onGround: wow, onRunway: rollS < 40,
      runwayLike: true, raw: 1, name: 'ASPHALT', class: 'hard'},
  };
}
function csvFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? csvFiles(file) : entry.name === 'telemetry.csv' ? [file] : [];
  });
}
// A stale generic VS alias must not replace an absent authoritative touchdown
// VS. Explicit zero/false and structured scoring fields must survive recording.
const sparseCases = [
  {payload: {vs: -250}, expectedVs: ''},
  {payload: {vs_fpm: null, vs: -250}, expectedVs: ''},
  {payload: {vs_fpm: undefined, vs: -250}, expectedVs: ''},
  {payload: {vs_fpm: 0, vs: -250, gforce: 0, ias_kts: 0, gs_kts: 0,
    bounce_count: 0, wind_speed_kts: 0, flaps_notch: 0,
    ultimate_stability_score: 0, ultimate_stability_gate_stable: false,
    ultimate_stability_gate_failures: [], ultimate_stability_breakdown: {bank_ok: 0},
    ultimate_stability_context: {profile: {id: 'test-zero'}}}, expectedVs: '0.0'},
];
let naturalOrder: string[] = [];
(async () => {
  await runSimbridgeCore({
    provider: {
      capabilities: {isMock: false, enableLandingRunner: true},
      start: async () => eventBus.emit('simconnect:aircraftChanged', {title: 'FlyByWire A32NX', displayName: 'FlyByWire A32NX'}),
      stop: async () => {},
      nextFrame: async () => {
        elapsedMs += 200;
        clock.advance(200);
        if (elapsedMs > 172000) {
          naturalOrder = [...order];
          if (mode === 'normal') {
            for (const fixture of sparseCases) {
              eventBus.emit('landing:final', {...fixture.payload});
            }
          }
          shutdown.abort('test_complete');
          return new Promise(() => {});
        }
        return frameAt(elapsedMs / 1000);
      },
    },
    pollRateMs: 1, wsPort: 0, httpPort: 0, shutdownSignal: shutdown.signal,
  });
  assert.equal(flightStarts, 1);
  const expectedLandings = mode === 'normal' ? 1 + sparseCases.length : 1;
  assert.equal(finals.length, expectedLandings, 'Exactly one natural landing plus explicit boundary fixtures');
  const scores = publicMessages.filter(message => message.type === 'ultimateStabilityScore');
  assert.equal(scoreAttempts, mode === 'normal' ? 1 : 2);
  assert.deepEqual(naturalOrder, mode === 'normal' ? ['score', 'csv', 'broadcast']
    : mode === 'retry' ? ['score', 'csv', 'score', 'broadcast'] : ['score', 'csv', 'score']);
  assert.equal(scores.length, mode === 'failure' ? 0 : 1, 'Never duplicate or fabricate a score broadcast');
  if (mode === 'normal') {
    assert(Number.isFinite(finals[0].ultimate_stability_score));
    assert(finals[0].ultimate_stability_samples > 100);
    assert.equal(scores[0].score, finals[0].ultimate_stability_score);
  } else {
    assert.equal(finals[0].ultimate_stability_score, null, 'Failure before recording must preserve the unscored event');
  }
  if (scores.length) {
    const score = scores[0];
    assert.equal(score.score, 100);
    assert.equal(score.verdict, 'stable');
    assert(score.samples > 100);
    assert.equal(score.gateStable, true);
    assert.deepEqual(score.gateFailures, []);
    assert(score.breakdown && typeof score.breakdown.bank_ok === 'number');
    assert.equal(score.scoringContext.profile.id, 'fbw-a32nx');
    assert(score.approachProfile.length > 0);
    assert.equal(score.runwayReferenceElevFt, 425);
    assert.equal(score.thresholdElevFt, score.runwayReferenceElevFt);
    assert.equal(score.runwayReferenceElevationSource, 'msfs-facilities');
    assert.equal(score.runwayReferenceElevationKind, 'runway');
    assert.equal(score.runwayHdg, 0);
    assert.equal(score.runwayWidthFt, 150);
    assert.equal(score.runwayLengthFt, 10000);
    assert.deepEqual(score.runwayThreshold, runway.threshold);
    assert.equal(score.runwayId, '36');
    assert(Number.isFinite(score.glidepathAngle.angleDeg));
  }
  const files = csvFiles(process.env.USERPROFILE);
  assert.equal(files.length, 1, 'Expected one isolated authoritative recording');
  const lines = splitCsvLines(fs.readFileSync(files[0], 'utf8'));
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).filter(Boolean).map(line => Object.fromEntries(parseCsvLine(line).map((value,index) => [headers[index],value])));
  const landingRows = rows.filter(row => row.record_type === 'LANDING');
  assert.equal(landingRows.length, expectedLandings);
  if (mode === 'normal') {
    assert.equal(Number(landingRows[0].ultimate_stability_score), scores[0].score);
    assert.equal(Number(landingRows[0].ultimate_stability_samples), scores[0].samples);
    for (const column of headers.filter(name => /^ultimate_stability_.*_pct$/.test(name))) {
      const metric = column.slice('ultimate_stability_'.length, -'_pct'.length);
      assert(Object.hasOwn(scores[0].breakdown, metric), 'Missing scored metric: ' + metric);
      const value = scores[0].breakdown[metric];
      if (value === null) assert.equal(landingRows[0][column], '', column);
      else {
        assert.notEqual(landingRows[0][column], '', column);
        assert.equal(Number(landingRows[0][column]), value, column);
      }
    }
    for (const [index, fixture] of sparseCases.entries()) {
      assert.equal(landingRows[index + 1].vs_fpm, fixture.expectedVs, 'Preserve authoritative touchdown VS, including absence');
    }
    const zeroRow = landingRows[landingRows.length - 1];
    for (const field of ['g_force', 'ias_kts', 'gs_kts', 'bounce_count', 'wind_speed_kts',
      'flaps_notch', 'ultimate_stability_score']) {
      assert.equal(Number(zeroRow[field]), 0, field);
      assert.notEqual(zeroRow[field], '', field + ' must retain an explicit zero');
    }
    assert.equal(zeroRow.ultimate_stability_gate_stable, '0');
    assert.equal(zeroRow.ultimate_stability_gate_failures, '');
    assert.deepEqual(JSON.parse(zeroRow.ultimate_stability_breakdown), {bank_ok: 0});
    assert.deepEqual(JSON.parse(zeroRow.ultimate_stability_context), {profile: {id: 'test-zero'}});
  } else {
    assert.equal(landingRows[0].ultimate_stability_score, '', 'Later retry must not rewrite the previously recorded row');
  }
  const sampleRows = rows.filter(row => row.record_type === 'SAMPLE');
  assert(sampleRows.length > 100, 'Must exercise the real VRE recording path');
  for (const name of ['ias', 'vs', 'altitude', 'surface']) assert(streams[name].length > 100);
  const output = {headers, rows: clean(rows), streams, publicMessages, finalPayload: finals[0], naturalOrder};
  if (snapshotPath) fs.writeFileSync(snapshotPath, JSON.stringify(output) + '\n');
  console.log('TEST:landing_recording_pass:' + mode);
})().catch(error => {console.error(error);process.exitCode=1;});

export {};
