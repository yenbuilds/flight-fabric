/*
 * Core integration runner for aircraft identity churn during an accepted
 * landing rollout. A parent node:test process asserts the emitted markers.
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

const TOUCHDOWN_AIRCRAFT = 'FlyByWire A32NX';
const CHANGED_AIRCRAFT = 'Cessna 152 Asobo';

function makeFrame(overrides: Record<string, any> = {}): Record<string, any> {
  const displayOverrides = overrides.display || {};
  const simconnectOverrides = overrides.simconnect || {};
  const fdmOverrides = overrides.fdm || {};
  const surfaceOverrides = overrides.surface || {};

  return {
    assists: { slewActive: false, anyAssistActive: false },
    lights: {},
    spoilers: null,
    flaps: 0.5,
    flapsIndex: 2,
    flapsAngleDeg: 15,
    gearHandle: 1,
    gearDownLocked: true,
    gearConfigurationAvailable: true,
    flapsConfigurationAvailable: true,
    attitudeValid: true,
    pitch: 0.04,
    bank: 0.01,
    heading: 90,
    windSpeed: 5,
    windDir: 100,
    lat: 48.995,
    lon: 2.55,
    alt_msl: 400,
    ias: displayOverrides.iasKts ?? 135,
    gs: displayOverrides.gsKts ?? 130,
    vs: -1.6,
    ra: 36,
    wow: false,
    gforce: 1.02,
    ...overrides,
    display: {
      iasKts: 135,
      vsFpm: -320,
      raFt: 120,
      gsKts: 130,
      ...displayOverrides,
    },
    simconnect: {
      connected: true,
      inFlightContext: true,
      simRunning: true,
      aircraftLoadedName: TOUCHDOWN_AIRCRAFT,
      ...simconnectOverrides,
    },
    fdm: {
      anyEngineRunning: true,
      eng1N1: 45,
      eng2N1: 45,
      ...fdmOverrides,
    },
    surface: {
      raw: 1,
      name: 'ASPHALT',
      class: 'hard',
      runwayLike: true,
      onRunway: true,
      onGround: overrides.wow === true,
      valid: true,
      ...surfaceOverrides,
    },
  };
}

async function main(): Promise<void> {
  const shutdownController = new AbortController();
  let frameIndex = 0;
  let touchdownAccepted = false;
  let landingFinalSeen = false;
  let aircraftChangeEmitted = false;

  eventBus.on('landing:early', () => {
    touchdownAccepted = true;
    console.log('TEST:touchdown_accepted');
  });

  eventBus.on('landing:final', (payload: Record<string, any>) => {
    landingFinalSeen = true;
    console.log(`TEST:landing_final:${JSON.stringify({
      aircraft: payload.aircraft,
      aircraftProfileId: payload.aircraft_profile_id,
      scoringProfileId: payload.landing_rate_context?.profile?.id || null,
      grade: payload.grade,
    })}`);
  });

  eventBus.on('flight:ended', (payload: Record<string, any>) => {
    console.log(`TEST:flight_ended:${payload.reason || 'unknown'}`);
  });

  const frames = [
    makeFrame(),
    makeFrame({
      wow: true,
      display: { iasKts: 126, vsFpm: -240, raFt: 0, gsKts: 112 },
      ias: 126,
      gs: 112,
      vs: -1.2,
      ra: 0,
      gforce: 1.18,
    }),
    makeFrame({
      wow: true,
      simconnect: { aircraftLoadedName: CHANGED_AIRCRAFT },
      display: { iasKts: 25, vsFpm: 0, raFt: 0, gsKts: 18 },
      ias: 25,
      gs: 18,
      vs: 0,
      ra: 0,
      surface: {
        raw: 1,
        name: 'ASPHALT',
        class: 'hard',
        runwayLike: false,
        onRunway: false,
        onGround: true,
        valid: true,
      },
    }),
    makeFrame({
      wow: true,
      simconnect: { aircraftLoadedName: CHANGED_AIRCRAFT },
      display: { iasKts: 15, vsFpm: 0, raFt: 0, gsKts: 10 },
      ias: 15,
      gs: 10,
      vs: 0,
      ra: 0,
      surface: {
        raw: 1,
        name: 'ASPHALT',
        class: 'hard',
        runwayLike: false,
        onRunway: false,
        onGround: true,
        valid: true,
      },
    }),
  ];

  const mockProvider = {
    capabilities: { isMock: true, enableLandingRunner: true },
    start: async () => {
      eventBus.emit('simconnect:aircraftChanged', {
        title: TOUCHDOWN_AIRCRAFT,
        displayName: TOUCHDOWN_AIRCRAFT,
        previousTitle: null,
      });
      console.log(`TEST:initial_profile:${profileLoader.getActiveProfile()?.id || 'missing'}`);
    },
    stop: async () => {},
    nextFrame: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));

      if (frameIndex < frames.length) {
        if (frameIndex === 2) {
          if (!touchdownAccepted) {
            console.log('TEST:aircraft_change_before_touchdown_acceptance');
          }
          aircraftChangeEmitted = true;
          eventBus.emit('simconnect:aircraftChanged', {
            title: CHANGED_AIRCRAFT,
            displayName: CHANGED_AIRCRAFT,
            previousTitle: TOUCHDOWN_AIRCRAFT,
            previousDisplayName: TOUCHDOWN_AIRCRAFT,
          });
          console.log(`TEST:changed_profile:${profileLoader.getActiveProfile()?.id || 'missing'}`);
        }

        return frames[frameIndex++];
      }

      console.log(`TEST:scenario_done:${aircraftChangeEmitted}:${landingFinalSeen}`);
      setTimeout(() => shutdownController.abort('test_complete'), 25);
      await new Promise(() => {});
    },
  };

  try {
    await runSimbridgeCore({
      provider: mockProvider,
      pollRateMs: 1,
      wsPort: 0,
      httpPort: 0,
      shutdownSignal: shutdownController.signal,
    });
    console.log('TEST:core_stopped');
  } catch (error) {
    console.error('TEST:runner_error', error?.stack || error?.message || String(error));
    process.exitCode = 2;
  }
}

void main();

export {};
