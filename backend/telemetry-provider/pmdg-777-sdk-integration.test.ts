const assert = require('node:assert/strict');
const test = require('node:test');

const profileLoader = require('../aircraft/aircraft-profile-loader');
const userSettings = require('../core/user-settings');
const {
  PMDG_777_SDK_EULA_ACCEPTANCE_VERSION,
} = require('../../shared/pmdg-777-sdk-authorization');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider');

const PMDG_777_PROFILE_KEY = 'bundled/msfs/pmdg-777';
const PMDG_777_PROFILE_REVISION = 11;
const PMDG_777_ADAPTER_ID = 'pmdg-777';

function stubPmdg777SdkIntegration(provider) {
  const fields = {
    'lights.beacon': {
      id: 'lights.beacon',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'lights.beacon',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'flightGuidance.fdLeft': {
      id: 'flightGuidance.fdLeft',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.flightDirector.left',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'flightGuidance.mach': {
      id: 'flightGuidance.mach',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.selected.mach',
      },
      decode: { type: 'number', precision: 3 },
    },
    'flightGuidance.fpaDeg': {
      id: 'flightGuidance.fpaDeg',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.selected.fpaDeg',
      },
      decode: { type: 'number', precision: 1 },
    },
    'flightGuidance.headingMode': {
      id: 'flightGuidance.headingMode',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.headingMode',
      },
      decode: { type: 'enum', values: { HDG: 'HDG', TRK: 'TRK' } },
    },
    'systems.electrical.batteryOn': {
      id: 'systems.electrical.batteryOn',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'systems.electrical.battery',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'controls.flapsLabel': {
      id: 'controls.flapsLabel',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'flaps.label',
      },
      decode: {
        type: 'enum',
        values: { UP: 'UP', 1: '1', 5: '5', 15: '15', 20: '20', 25: '25', 30: '30' },
      },
    },
    'controls.parkingBrake': {
      id: 'controls.parkingBrake',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'brakes.parking',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'controls.speedbrakePercent': {
      id: 'controls.speedbrakePercent',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'spoilers.handlePercent',
      },
      decode: { type: 'number', precision: 0 },
    },
    'lighting.domePercent': {
      id: 'lighting.domePercent',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'lighting.domePercent',
      },
      decode: { type: 'number', precision: 0 },
    },
  };
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === PMDG_777_PROFILE_KEY
    && adapterId === PMDG_777_ADAPTER_ID
    && profileRevision === PMDG_777_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === PMDG_777_PROFILE_KEY
    && adapterId === PMDG_777_ADAPTER_ID
    && profileRevision === PMDG_777_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

test('PMDG 777 SDK profile remains disabled until the reviewed EULA version is accepted', () => {
  const provider = new SimConnectTelemetryProvider();
  const originalProfileKey = profileLoader.getActiveProfile()?._qualifiedId || 'bundled/msfs/generic';
  const originalIntegrations = userSettings.settings.integrations;

  try {
    profileLoader.setActiveProfile(PMDG_777_PROFILE_KEY);
    userSettings.settings.integrations = {};
    assert.equal(provider._resolveActiveSdkProfile(), null, 'unaccepted SDK profile must not start');

    userSettings.settings.integrations = {
      pmdg777Sdk: {
        eulaAcceptedVersion: PMDG_777_SDK_EULA_ACCEPTANCE_VERSION,
        eulaAcceptedAt: new Date().toISOString(),
      },
    };
    const authorized = provider._resolveActiveSdkProfile();
    assert.equal(authorized?.adapter?.id, 'clientdata-manifest');
    assert.equal(authorized?.profileSdk?.target?.channel, 'pmdg-777x-clientdata');
    assert.equal(authorized?.profileSdk?.target?.connector, 'pmdg-777x-clientdata');
  } finally {
    userSettings.settings.integrations = originalIntegrations;
    profileLoader.setActiveProfile(originalProfileKey);
  }
});

test('PMDG 777 two-state controls dispatch one complete mouse click and require newer SDK readback', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: { lights: { beacon: false } },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  const bridge = {
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (value === 0x20000000) sdkSnapshot.normalized.lights.beacon = true;
      sdkSnapshot.snapshotSequence += 1;
      sdkSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  provider._sdkBridge = {
    getSnapshot: () => sdkSnapshot,
    isDataConnected: () => true,
  };
  stubPmdg777SdkIntegration(provider);

  const capabilities = provider.getAircraftControlCapabilities();
  assert.equal(capabilities.integrationTransports.sdk, true, 'connected PMDG ClientData exposes SDK writes');
  assert.equal(capabilities.integrationTransports['mobiflight-calculator'], false, 'PMDG SDK route does not require MobiFlight');

  const result = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: PMDG_777_ADAPTER_ID,
    verification: 'untested',
  }, {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'lights.beacon.on' },
  });

  assert.equal(result.ok, true, 'trusted SDK action should execute and confirm');
  assert.equal(result.confirmedValue, true, 'SDK readback should confirm the requested switch state');
  assert.equal(events.length, 2, 'SDK action must dispatch one press/release click without retry');
  assert.equal(events[0].name, '#69746', 'registry should supply the reviewed PMDG beacon event');
  assert.deepEqual(
    events.map((event) => event.value),
    [0x20000000, 0x00020000],
    'two-state controls must not assume a numeric ON/OFF position polarity',
  );
});

test('PMDG 777 parking-brake OFF uses a polarity-independent click and becomes an idempotent no-op', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: { brakes: { parking: true } },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  let parkingLeverCanMove = true;
  const bridge = {
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (parkingLeverCanMove && name === '#70147' && value === 0x20000000) {
        sdkSnapshot.normalized.brakes.parking = false;
      }
      sdkSnapshot.snapshotSequence += 1;
      sdkSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  provider._sdkBridge = {
    getSnapshot: () => sdkSnapshot,
    isDataConnected: () => true,
  };
  stubPmdg777SdkIntegration(provider);

  const action = {
    type: 'aircraft-integration',
    name: PMDG_777_ADAPTER_ID,
    verification: 'untested',
  };
  const released = await provider.executeAircraftControlAction(action, {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'controls.parkingBrake.off' },
  });
  assert.equal(released.ok, true);
  assert.equal(released.confirmedValue, false);
  assert.deepEqual(events, [
    { name: '#70147', value: 0x20000000 },
    { name: '#70147', value: 0x00020000 },
  ]);

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const alreadyReleased = await provider.executeAircraftControlAction(action, {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'controls.parkingBrake.off' },
  });
  assert.equal(alreadyReleased.ok, true);
  assert.equal(alreadyReleased.idempotent, true);
  assert.equal(events.length, 2, 'an already-released parking brake must not be toggled back on');

  parkingLeverCanMove = false;
  sdkSnapshot.normalized.brakes.parking = true;
  sdkSnapshot.snapshotSequence += 1;
  sdkSnapshot.updatedAt = new Date().toISOString();
  provider._aircraftIntegrationActionLastAttemptAt.clear();
  provider._waitForAircraftIntegrationReadback = async () => ({
    confirmed: false,
    observed: true,
    sequenceAdvanced: false,
  });
  const interlocked = await provider.executeAircraftControlAction(action, {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'controls.parkingBrake.off' },
  });
  assert.equal(interlocked.ok, false);
  assert.equal(
    interlocked.error.includes('both toe brakes'),
    true,
    'parking-brake failure explains the PMDG operational interlock',
  );
});

test('PMDG 777 direct MCP setters encode wire parameters and confirm logical SDK values', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: {
      automation: {
        ap: { selected: { mach: 0.7, fpaDeg: 0 } },
      },
    },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  const bridge = {
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (name === '#84135') {
        sdkSnapshot.normalized.automation.ap.selected.mach = value * 0.001;
      } else if (name === '#84139') {
        sdkSnapshot.normalized.automation.ap.selected.fpaDeg = (value * 0.1) - 10;
      }
      sdkSnapshot.snapshotSequence += 1;
      sdkSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  provider._sdkBridge = {
    getSnapshot: () => sdkSnapshot,
    isDataConnected: () => true,
  };
  stubPmdg777SdkIntegration(provider);

  const mach = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: PMDG_777_ADAPTER_ID,
    verification: 'untested',
  }, {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'mcp.mach.set', value: 0.78 },
  });
  assert.equal(mach.ok, true);
  assert.equal(mach.confirmedValue, 0.78, 'readback stays in logical Mach units');
  assert.deepEqual(events[0], { name: '#84135', value: 780 });

  const fpa = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: PMDG_777_ADAPTER_ID,
    verification: 'untested',
  }, {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'mcp.fpa.set', value: -1.8 },
  });
  assert.equal(fpa.ok, true);
  assert.equal(fpa.confirmedValue, -1.8, 'readback stays in logical FPA degrees');
  assert.deepEqual(events[1], { name: '#84139', value: 82 });
});

test('PMDG 777 expanded fixed targets dispatch once and confirm logical selector state', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: {
      systems: { electrical: { battery: false } },
      flaps: { label: 'UP' },
      spoilers: { handlePercent: 0 },
      lighting: { domePercent: 10 },
    },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  const bridge = {
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (name === '#69633' && value === 0x20000000) {
        sdkSnapshot.normalized.systems.electrical.battery =
          !sdkSnapshot.normalized.systems.electrical.battery;
      }
      if (name === '#74708' && value === 0x20000000) sdkSnapshot.normalized.flaps.label = '25';
      if (name === '#74614' && value === 0x20000000) sdkSnapshot.normalized.spoilers.handlePercent = 25;
      if (name === '#69658') sdkSnapshot.normalized.lighting.domePercent = value;
      sdkSnapshot.snapshotSequence += 1;
      sdkSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  provider._sdkBridge = {
    getSnapshot: () => sdkSnapshot,
    isDataConnected: () => true,
  };
  stubPmdg777SdkIntegration(provider);

  const action = {
    type: 'aircraft-integration',
    name: PMDG_777_ADAPTER_ID,
    verification: 'untested',
  };
  for (const [actionId, value, expected] of [
    ['systems.electrical.battery.on', undefined, true],
    ['controls.flaps.twentyFive', undefined, '25'],
    ['controls.speedbrake.armed', undefined, 25],
    ['lighting.dome.set', 42, 42],
  ] as const) {
    const result = await provider.executeAircraftControlAction(action, {
      profileKey: PMDG_777_PROFILE_KEY,
      profileRevision: PMDG_777_PROFILE_REVISION,
      request: {
        actionId,
        ...(value === undefined ? {} : { value }),
      },
    });
    assert.equal(result.ok, true, `${actionId} should confirm`);
    assert.equal(result.confirmedValue, expected);
  }

  assert.deepEqual(events, [
    { name: '#69633', value: 0x20000000 },
    { name: '#69633', value: 0x00020000 },
    { name: '#74708', value: 0x20000000 },
    { name: '#74708', value: 0x00020000 },
    { name: '#74614', value: 0x20000000 },
    { name: '#74614', value: 0x00020000 },
    { name: '#69658', value: 42 },
  ], 'expanded actions must dispatch the intended click or bounded payload');

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const alreadyOn = await provider.executeAircraftControlAction(action, {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'systems.electrical.battery.on' },
  });
  assert.equal(alreadyOn.ok, true);
  assert.equal(alreadyOn.idempotent, true);
  assert.equal(events.length, 7, 'same-state two-state controls must not dispatch again');
});

test('PMDG 777 flight director uses one complete mouse click and an already-satisfied target is a no-op', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: { automation: { ap: { flightDirector: { left: false } } } },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  const bridge = {
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (value === 0x20000000) {
        sdkSnapshot.normalized.automation.ap.flightDirector.left =
          !sdkSnapshot.normalized.automation.ap.flightDirector.left;
        sdkSnapshot.snapshotSequence += 1;
        sdkSnapshot.updatedAt = new Date().toISOString();
      }
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  provider._sdkBridge = {
    getSnapshot: () => sdkSnapshot,
    isDataConnected: () => true,
  };
  stubPmdg777SdkIntegration(provider);

  const action = {
    type: 'aircraft-integration',
    name: PMDG_777_ADAPTER_ID,
    verification: 'untested',
  };
  const options = {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'afds.flightDirectorCaptain.on' },
  };
  const on = await provider.executeAircraftControlAction(action, options);
  assert.equal(on.ok, true);
  assert.equal(on.confirmedValue, true);
  assert.deepEqual(events, [
    { name: '#69834', value: 0x20000000 },
    { name: '#69834', value: 0x00020000 },
  ]);

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const alreadyOn = await provider.executeAircraftControlAction(action, options);
  assert.equal(alreadyOn.ok, true);
  assert.equal(alreadyOn.idempotent, true);
  assert.equal(events.length, 2, 'idempotent FD request must not toggle the switch again');
});

test('PMDG 777 mode selectors click only when the requested deterministic target differs', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: { automation: { ap: { headingMode: 'HDG' } } },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  const bridge = {
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (value === 0x20000000) {
        sdkSnapshot.normalized.automation.ap.headingMode =
          sdkSnapshot.normalized.automation.ap.headingMode === 'HDG' ? 'TRK' : 'HDG';
        sdkSnapshot.snapshotSequence += 1;
        sdkSnapshot.updatedAt = new Date().toISOString();
      }
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  provider._sdkBridge = {
    getSnapshot: () => sdkSnapshot,
    isDataConnected: () => true,
  };
  stubPmdg777SdkIntegration(provider);

  const action = {
    type: 'aircraft-integration',
    name: PMDG_777_ADAPTER_ID,
    verification: 'untested',
  };
  const options = {
    profileKey: PMDG_777_PROFILE_KEY,
    profileRevision: PMDG_777_PROFILE_REVISION,
    request: { actionId: 'afds.headingMode.trk' },
  };
  const track = await provider.executeAircraftControlAction(action, options);
  assert.equal(track.ok, true);
  assert.equal(track.confirmedValue, 'TRK');
  assert.deepEqual(events, [
    { name: '#69848', value: 0x20000000 },
    { name: '#69848', value: 0x00020000 },
  ]);

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const alreadyTrack = await provider.executeAircraftControlAction(action, options);
  assert.equal(alreadyTrack.ok, true);
  assert.equal(alreadyTrack.idempotent, true);
  assert.equal(events.length, 2, 'an already-selected target must not send another toggle click');
});

export {};
