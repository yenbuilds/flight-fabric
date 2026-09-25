// Exercise the real core lifecycle around an automatically recorded takeoff.
'use strict';

// Retain enabled lifecycle coverage without adding a product runtime override.
if (process.argv.includes('--enable-takeoff-fixture')) {
  const settingsPath = require.resolve('../../shared/app-settings-shared.js');
  const settings = require(settingsPath);
  require.cache[settingsPath]!.exports = { ...settings, TAKEOFF_SCORING_ENABLED: true };
}

const { runSimbridgeCore } = require('../../backend/core/simbridge-core');
const eventBus = require('../../backend/core/event-bus');
const timeSource = require('../../backend/core/time-source');
const clock = timeSource.createFixedSource(1_800_000_000_000);
const shutdown = new AbortController();
const disconnect = process.argv.includes('--disconnect');
let elapsed = -200;
let flightStarted = false;

eventBus.on('flight:started', () => {
  flightStarted = true;
  console.log(`TEST:flight_started:${elapsed}`);
});
eventBus.on('takeoff:final', (payload: Record<string, any>) => {
  console.log(`TEST:takeoff_final:${JSON.stringify({
    startSource: payload.takeoff_roll_start_source,
    durationS: payload.takeoff_roll_duration_s,
    recordingActive: flightStarted,
  })}`);
});

void runSimbridgeCore({
  provider: {
    capabilities: { isMock: true, enableLandingRunner: true },
    start: async () => {},
    stop: async () => {},
    nextFrame: async () => {
      elapsed += 200;
      clock.advance(200);
      if (elapsed > 48000) {
        console.log('TEST:scenario_done');
        shutdown.abort('test_complete');
        return new Promise(() => {});
      }
      const fraction = Math.max(0, Math.min(1, (elapsed - 2000) / 30000));
      const wow = elapsed <= 32000;
      const speed = 140 * fraction;
      const height = wow ? 0 : (elapsed - 32000) / 100;
      const lat = 48.995 + 0.00001 * (wow ? fraction * fraction * 1000 : 1000 + height);
      return {
        paused: false, inMenu: false, assists: { slewActive: false },
        wow, lat, lon: 2.55, alt_msl: 425 + height,
        pitch: wow ? 0 : 0.1, bank: 0, heading: 0,
        attitudeValid: true, ias: speed, gs: speed, ra: height / 3.28, vs: wow ? 0 : 3,
        display: { iasKts: speed, gsKts: speed, raFt: height, vsFpm: wow ? 0 : 600 },
        simconnect: {
          connected: !(disconnect && elapsed === 33000), inFlightContext: true,
          simRunning: true, aircraftLoadedName: 'FlyByWire A32NX',
          lat, lon: 2.55, hdgTrueDeg: 0,
        },
        fdm: { anyEngineRunning: true, eng1N1: 80, eng2N1: 80 },
        surface: { valid: true, onGround: wow, onRunway: true, runwayLike: true, raw: 1, class: 'hard' },
      };
    },
  },
  pollRateMs: 1, wsPort: 0, httpPort: 0, shutdownSignal: shutdown.signal,
}).catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};
