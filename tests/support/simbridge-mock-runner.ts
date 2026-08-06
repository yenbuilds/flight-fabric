/*
 * simbridge-mock-runner.js
 *
 * Simple runner that starts runSimbridgeCore with a scripted mock provider.
 * Emits deterministic frames to exercise provider lifecycle and profile detection.
 * Logs marker lines to stdout for the parent test to assert on.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function resolveBackendRuntimePathsModule(): string {
  const candidatePaths = [
    path.resolve(__dirname, '..', '..', 'scripts', 'backend-runtime-paths.js'),
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'backend-runtime-paths.js'),
  ];

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) return candidatePath;
  }

  throw new Error(`Unable to locate scripts/backend-runtime-paths.js from ${__dirname}`);
}

const { resolveBackendRuntimeFile } = require(resolveBackendRuntimePathsModule()) as {
  resolveBackendRuntimeFile: (...segments: string[]) => string;
};

const { runSimbridgeCore } = require(resolveBackendRuntimeFile('core', 'simbridge-core.js'));
const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));
const profileLoader = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-loader.js'));

async function main() {
  // Scripted sequence of provider frames (promises returned from nextFrame)
  const sequence = [];

  // 1) Provider not present / disconnected: emit frames with simconnect.connected = false
  sequence.push({ simconnect: { connected: false }, display: {}, fdm: {} });
  sequence.push({ simconnect: { connected: false }, display: {}, fdm: {} });

  // 2) Provider connects but missing title/critical fields
  sequence.push({ simconnect: { connected: true, aircraftLoadedName: null }, display: { iasKts: null, vsFpm: null }, fdm: {} });

  // 3) Provider provides title and sufficient fields to detect profile
  sequence.push({ simconnect: { connected: true, aircraftLoadedName: 'PMDG 737 NGXu' }, display: { iasKts: 140, vsFpm: -200 }, fdm: {} });

  // 4) Intermittent gap: frames with missing fields (degraded)
  sequence.push({ simconnect: { connected: true, aircraftLoadedName: 'PMDG 737 NGXu' }, display: { iasKts: null, vsFpm: null }, fdm: {} });
  sequence.push({ simconnect: { connected: true, aircraftLoadedName: 'PMDG 737 NGXu' }, display: { iasKts: 142, vsFpm: -180 }, fdm: {} });

  // 5) Provider disconnects
  sequence.push({ simconnect: { connected: false }, display: {}, fdm: {} });

  // 6) Provider reconnects after brief outage (should recover profile)
  sequence.push({
    simconnect: { connected: true, aircraftLoadedName: 'PMDG 737 NGXu' },
    display: { iasKts: 141, vsFpm: -190 },
    fdm: {},
    ias: 141,
    pitch: 0.5,
    bank: -0.25,
  });

  // We'll use an index to step through sequence
  let idx = 0;
  let prevConnected = false;
  let seenOnceConnected = false;
  let seenConnectedWithTitle = false;
  let firstDetectedProfileId = null;
  let inDegradedGap = false;
  let profileStableLogged = false;
  let latestRawFrame: Record<string, any> | null = null;
  let canonicalTickLogged = false;
  let awaitingReconnectRate = false;
  const shutdownController = new AbortController();

  eventBus.on('telemetry:frame', (tick: Record<string, any>) => {
    if (canonicalTickLogged) return;
    canonicalTickLogged = true;
    const canonical = !!tick?.meta
      && Object.isFrozen(tick)
      && Object.isFrozen(tick.meta)
      && Object.isFrozen(tick.simconnect)
      && tick.simconnect !== latestRawFrame?.simconnect
      && latestRawFrame !== null
      && !Object.isFrozen(latestRawFrame)
      && !Object.isFrozen(latestRawFrame.simconnect);
    console.log(`TEST:canonical_tick:${canonical}:${tick?.meta?.sequence ?? 'missing'}`);
  });

  eventBus.on('telemetry:rates', (payload: Record<string, any>) => {
    if (!awaitingReconnectRate) return;
    awaitingReconnectRate = false;
    const reset = payload?.pitchRate === 0 && payload?.bankRate === 0;
    console.log(`TEST:reconnect_rates_reset:${reset}`);
  });

  // Mock provider
  const mockProvider = {
    capabilities: { isMock: true, enableLandingRunner: false },
    start: async () => {
      console.log('TEST:provider_start');
      return { ok: true };
    },
    stop: async () => {
      console.log('TEST:provider_stop');
    },
    nextFrame: async () => {
      // Delay slightly to allow simbridge to run some cycles
      await new Promise(r => setTimeout(r, 10));

      if (idx < sequence.length) {
        const frame = sequence[idx++];
        latestRawFrame = frame;

        const connectedNow = frame.simconnect && frame.simconnect.connected === true;

        // Emit markers for interesting transitions
        if (!connectedNow) {
          console.log('TEST:provider_disconnected');
        } else {
          if (!prevConnected && seenOnceConnected) {
            console.log('TEST:provider_reconnected');
            awaitingReconnectRate = true;
          }

          if (!seenConnectedWithTitle && frame.simconnect.aircraftLoadedName) {
            console.log(`TEST:provider_connected_with_title:${frame.simconnect.aircraftLoadedName}`);
            seenConnectedWithTitle = true;
          } else if (!frame.simconnect.aircraftLoadedName) {
            console.log('TEST:provider_connected_no_title');
          }

          seenOnceConnected = true;
        }

        // Remember previous connection state for transition detection
        prevConnected = connectedNow;

        // Track degraded gap when critical display fields missing
        if (frame.display && (frame.display.iasKts == null || frame.display.vsFpm == null)) {
          inDegradedGap = true;
        }

        // After emitting the frame, check if profileLoader detected a profile
        // Wait a tick for simbridge-core to process and set profile
        setTimeout(() => {
          const active = profileLoader.getActiveProfile();
          if (active && active.id) {
            console.log(`TEST:profile_detected:${active.id}`);
            if (!firstDetectedProfileId) {
              firstDetectedProfileId = active.id;
            } else if (inDegradedGap && !profileStableLogged && active.id === firstDetectedProfileId) {
              console.log(`TEST:profile_stable:${active.id}`);
              profileStableLogged = true;
              inDegradedGap = false;
            }
          }

          // Also emit data source health metadata (mock provider)
          const dataSourceType = 'mock';
          const dataSourceConnected = connectedNow;
          console.log(`TEST:data_source:${dataSourceType}:${dataSourceConnected}`);

          // Log a local last-frame timestamp for basic recency checks
          console.log(`TEST:last_frame_local_ts:${Date.now()}`);
        }, 50);

        return frame;
      }

      // Sequence finished; give simbridge a moment then exit cleanly
      console.log('TEST:done');
      // Deliberately ignore the acquisition signal here. The core-level abort
      // race must still reach provider.stop() and close its servers.
      setTimeout(() => shutdownController.abort('test_complete'), 100);

      // Simulate a third-party provider that never settles its pending read.
      await new Promise(() => {});
    },
  };

  // Run simbridge core with short poll rate and ephemeral ports so local dev
  // instances on the default ports do not break the smoke test.
  try {
    await runSimbridgeCore({
      provider: mockProvider,
      pollRateMs: 20,
      wsPort: 0,
      httpPort: 0,
      shutdownSignal: shutdownController.signal,
    });
    console.log('TEST:core_stopped');
  } catch (err) {
    console.error('TEST:runner_error', err && err.stack ? err.stack : (err && err.message));
    process.exitCode = 2;
  }
}

main();

export {};
