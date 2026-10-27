/** Real core/recorders with steady airborne telemetry and UI recording commands. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const mode = process.argv[2];
assert(['automatic', 'manual'].includes(mode));
const runtime = (...parts: string[]) => path.join(__dirname, '../../backend', ...parts);
const clock = require(runtime('core/time-source.js')).createFixedSource(1_800_000_000_000);
const eventBus = require(runtime('core/event-bus.js'));
const writer = require(runtime('flight-recording/flight-csv-writer.js'));
const utils = require(runtime('core/simbridge-core-utils.js'));
const tickFrames = require(runtime('lifecycle/tick-frame.js'));
const originalFactory = tickFrames.createTickFrameFactory;
tickFrames.createTickFrameFactory = options => originalFactory({ ...options, monotonicTimeSource: { now: clock.get } });
const counts = { inactiveBuilds: 0, initialWrites: 0, restartedWrites: 0, inactiveEvaluations: 0, inactivePositions: 0 };
let tick = -1;
const buildSample = utils.buildVreEnrichedFrame;
utils.buildVreEnrichedFrame = args => {
  if (!writer.isRecording()) counts.inactiveBuilds++;
  return buildSample(args);
};
const buildEvaluation = utils.buildVreEvaluationFrame;
utils.buildVreEvaluationFrame = args => {
  if (!writer.isRecording()) counts.inactiveEvaluations++;
  return buildEvaluation(args);
};
const writeSample = writer.writeSample;
writer.writeSample = sample => {
  assert.equal(writer.isRecording(), true);
  assert.equal(sample.onGround, false);
  assert.equal(sample.ias, 210);
  assert.equal(sample.altMsl, 10000);
  const accepted = writeSample(sample);
  assert.equal(accepted, true);
  if (tick < 80) counts.initialWrites++;
  else counts.restartedWrites++;
  return accepted;
};
eventBus.on('telemetry:position', () => { if (!writer.isRecording()) counts.inactivePositions++; });
// Use the same authorized message callback and handlers as the UI. The fake
// client avoids network timing; server and recording lifecycle remain real.
const bootstrap = require(runtime('core/ws-bootstrap.js'));
const createWsServer = bootstrap.createWsServer;
let dispatch;
bootstrap.createWsServer = options => { dispatch = options.onClientMessage; return createWsServer(options); };
const replies: any[] = [];
const client = { __ffPrivilegedClient: true, send: value => replies.push(JSON.parse(value)) };
async function command(type: string) {
  const before = replies.length;
  await dispatch(client, { type });
  assert.ok(replies.slice(before).some(reply => reply.success === true), JSON.stringify(replies.slice(before)));
}
const shutdown = new AbortController();
const { runSimbridgeCore } = require(runtime('core/simbridge-core.js'));
runSimbridgeCore({
  provider: {
    capabilities: { isMock: false, enableLandingRunner: false },
    start: async () => {}, stop: async () => {},
    nextFrame: async () => {
      tick++;
      clock.advance(200);
      if (tick === 40) {
        if (mode === 'manual') {
          assert.equal(writer.isRecording(), false);
          await command('startRecording');
        }
        assert.equal(writer.isRecording(), true, 'automatic or manual start must activate the real recorder');
      }
      if (tick === 80) {
        assert.ok(counts.initialWrites > 0, 'starting mid-flight must produce samples');
        await command('endFlightManual');
        assert.equal(writer.isRecording(), false);
      }
      if (tick === 120) {
        assert.equal(writer.isRecording(), false, 'manual end must suppress automatic restart');
        await command('startRecording');
        assert.equal(writer.isRecording(), true);
      }
      if (tick === 160) {
        assert.ok(counts.restartedWrites > 0, 'a later start must resume sample preparation');
        await command('endFlightManual');
        shutdown.abort('test_complete');
        return new Promise(() => {});
      }
      // Level flight at 210 kt, 10,000 ft MSL / 9,500 ft AGL. Advance north
      // at the declared groundspeed; no synthetic touchdown or scoring event.
      const lat = 49 + tick * 0.2 * 210 * 1.687809857 / 364000;
      return {
        paused: false, inMenu: false, assists: { slewActive: false },
        wow: false, lat, lon: 2.55, alt_msl: 10000,
        pitch: 0.035, bank: 0, heading: 0, attitudeValid: true,
        ias: 210, gs: 210, ra: 9500 / 3.280839895, vs: 0,
        display: { iasKts: 210, gsKts: 210, raFt: 9500, vsFpm: 0 },
        simconnect: { connected: true, inFlightContext: true, simRunning: true,
          aircraftLoadedName: 'FlightFabric recording fixture', lat, lon: 2.55, hdgTrueDeg: 0 },
        fdm: { anyEngineRunning: true, eng1N1: 60, eng2N1: 60 },
        surface: { valid: true, onGround: false, onRunway: false, runwayLike: false },
      };
    },
  },
  pollRateMs: 1, wsPort: 0, httpPort: 0, shutdownSignal: shutdown.signal,
}).then(() => {
  assert.equal(counts.inactiveBuilds, 0, 'no recording sample may be prepared while the recorder is inactive');
  assert.ok(counts.inactivePositions > 0, 'live position updates must continue without recording');
  if (mode === 'manual') assert.ok(counts.inactiveEvaluations > 0, 'sampling evaluation must continue before a manual start');
  console.log('TEST:recording_sampling_pass:' + mode + ':' + JSON.stringify(counts));
}).catch(error => { console.error(error); process.exitCode = 1; });
export {};
