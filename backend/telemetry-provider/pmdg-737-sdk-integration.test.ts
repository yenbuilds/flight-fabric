const assert = require('node:assert/strict');
const test = require('node:test');

const profileLoader = require('../aircraft/aircraft-profile-loader');
const { executeAircraftCommand } = require('../aircraft/aircraft-control-service');
const userSettings = require('../core/user-settings');
const {
  PMDG_737_SDK_EULA_ACCEPTANCE_VERSION,
} = require('../../shared/pmdg-737-sdk-authorization');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider');

const PMDG_737_PROFILE_KEY = 'bundled/msfs/pmdg-737';
const PMDG_737_PROFILE_REVISION = 11;
const PMDG_737_ADAPTER_ID = 'pmdg-737';

function stubPmdg737SdkIntegration(provider) {
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
    'afds.flightDirectorCaptain': {
      id: 'afds.flightDirectorCaptain',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.flightDirector.left',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'afds.autothrottleArm': {
      id: 'afds.autothrottleArm',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.athr.armed',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'mcp.speed': {
      id: 'mcp.speed',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.selected.iasMach',
      },
      decode: { type: 'number', precision: 2 },
    },
    'mcp.courseCaptainDeg': {
      id: 'mcp.courseCaptainDeg',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.selected.courseLeftDeg',
      },
      decode: { type: 'number', precision: 0 },
    },
    'mcp.courseFirstOfficerDeg': {
      id: 'mcp.courseFirstOfficerDeg',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'automation.ap.selected.courseRightDeg',
      },
      decode: { type: 'number', precision: 0 },
    },
    'flightControls.speedbrakeArmed': {
      id: 'flightControls.speedbrakeArmed',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'spoilers.armed',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'gear.parkingBrake': {
      id: 'gear.parkingBrake',
      source: {
        type: 'sdk',
        adapterId: 'clientdata-manifest',
        path: 'brakes.parking',
      },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
    },
    'radios.nav1ActiveMhz': {
      id: 'radios.nav1ActiveMhz',
      source: {
        type: 'simvar',
        name: 'NAV ACTIVE FREQUENCY:1',
        path: 'nav1ActiveMhz',
      },
      decode: { type: 'number', precision: 2 },
    },
    'radios.nav2ActiveMhz': {
      id: 'radios.nav2ActiveMhz',
      source: {
        type: 'simvar',
        name: 'NAV ACTIVE FREQUENCY:2',
        path: 'nav2ActiveMhz',
      },
      decode: { type: 'number', precision: 2 },
    },
  };
  provider._getActiveAircraftIntegrationConfig = (profileKey, adapterId, profileRevision) => (
    profileKey === PMDG_737_PROFILE_KEY
    && adapterId === PMDG_737_ADAPTER_ID
    && profileRevision === PMDG_737_PROFILE_REVISION
      ? { profileKey, integrationId: adapterId, profileRevision }
      : null
  );
  provider._getAircraftIntegrationFieldConfig = (profileKey, adapterId, fieldId, profileRevision) => (
    profileKey === PMDG_737_PROFILE_KEY
    && adapterId === PMDG_737_ADAPTER_ID
    && profileRevision === PMDG_737_PROFILE_REVISION
      ? fields[fieldId] || null
      : null
  );
}

test('PMDG 737 SDK profile remains disabled until the reviewed EULA version is accepted', () => {
  const provider = new SimConnectTelemetryProvider();
  const originalProfileKey = profileLoader.getActiveProfile()?._qualifiedId || 'bundled/msfs/generic';
  const originalIntegrations = userSettings.settings.integrations;

  try {
    profileLoader.setActiveProfile(PMDG_737_PROFILE_KEY);
    userSettings.settings.integrations = {};
    assert.equal(provider._resolveActiveSdkProfile(), null, 'unaccepted SDK profile must not start');

    userSettings.settings.integrations = {
      pmdg737Sdk: {
        eulaAcceptedVersion: PMDG_737_SDK_EULA_ACCEPTANCE_VERSION,
        eulaAcceptedAt: new Date().toISOString(),
      },
    };
    const authorized = provider._resolveActiveSdkProfile();
    assert.equal(authorized?.adapter?.id, 'clientdata-manifest');
    assert.equal(authorized?.profileSdk?.target?.channel, 'pmdg-737-ng3-clientdata');
    assert.equal(authorized?.profileSdk?.target?.connector, 'pmdg-737-ng3-clientdata');
  } finally {
    userSettings.settings.integrations = originalIntegrations;
    profileLoader.setActiveProfile(originalProfileKey);
  }
});

test('PMDG 737 exterior light uses direct SDK positions in both directions with newer readback', async () => {
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
      sdkSnapshot.normalized.lights.beacon = value === 1;
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
  stubPmdg737SdkIntegration(provider);

  const capabilities = provider.getAircraftControlCapabilities();
  assert.equal(capabilities.integrationTransports.sdk, true, 'connected PMDG ClientData exposes SDK writes');
  assert.equal(capabilities.integrationTransports['mobiflight-calculator'], false, 'PMDG SDK route does not require MobiFlight');

  const integration = {
    type: 'aircraft-integration',
    name: PMDG_737_ADAPTER_ID,
    verification: 'untested',
  };
  const context = {
    profileKey: PMDG_737_PROFILE_KEY,
    profileRevision: PMDG_737_PROFILE_REVISION,
  };

  const on = await provider.executeAircraftControlAction(integration, {
    ...context,
    request: { actionId: 'lights.beacon.on' },
  });

  assert.equal(on.ok, true, 'trusted SDK ON action should execute and confirm');
  assert.equal(on.confirmedValue, true, 'SDK readback should confirm the requested ON state');
  assert.equal(events.length, 1, 'SDK ON action must dispatch once without retry');
  assert.equal(events[0].name, '#69756', 'registry should supply the reviewed PMDG beacon event');
  assert.equal(events[0].value, 1, 'registry should supply the direct ON position');

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const off = await provider.executeAircraftControlAction(integration, {
    ...context,
    request: { actionId: 'lights.beacon.off' },
  });

  assert.equal(off.ok, true, 'trusted SDK OFF action should execute and confirm');
  assert.equal(off.confirmedValue, false, 'SDK readback should confirm the requested OFF state');
  assert.equal(events.length, 2, 'SDK OFF action must dispatch once without retry');
  assert.equal(events[1].name, '#69756', 'ON and OFF should use the same position event');
  assert.equal(events[1].value, 0, 'registry should supply the direct OFF position');
});

test('PMDG 737 flight director uses one complete SDK mouse click and confirms the requested position', async () => {
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
  stubPmdg737SdkIntegration(provider);

  const on = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: PMDG_737_ADAPTER_ID,
    verification: 'untested',
  }, {
    profileKey: PMDG_737_PROFILE_KEY,
    profileRevision: PMDG_737_PROFILE_REVISION,
    request: { actionId: 'afds.flightDirectorCaptain.on' },
  });

  assert.equal(on.ok, true, 'FD ON should confirm from the decoded SDK switch state');
  assert.equal(on.confirmedValue, true);
  assert.deepEqual(events, [
    { name: '#70010', value: 0x20000000 },
    { name: '#70010', value: 0x00020000 },
  ], 'FD should use the mouse press/release sequence from the installed PMDG sample');

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const alreadyOn = await provider.executeAircraftControlAction({
    type: 'aircraft-integration',
    name: PMDG_737_ADAPTER_ID,
    verification: 'untested',
  }, {
    profileKey: PMDG_737_PROFILE_KEY,
    profileRevision: PMDG_737_PROFILE_REVISION,
    request: { actionId: 'afds.flightDirectorCaptain.on' },
  });

  assert.equal(alreadyOn.ok, true, 'an already-satisfied FD target should succeed');
  assert.equal(alreadyOn.idempotent, true, 'an already-satisfied FD target should be a no-op');
  assert.equal(events.length, 2, 'the idempotent FD target must not send another toggle');
});

test('PMDG 737 paired NAV command writes both active radios with BCD16 and confirms both readbacks', async () => {
  const provider = new SimConnectTelemetryProvider();
  const rustSnapshot: any = {
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  provider._data = { nav1ActiveMhz: 109.5, nav2ActiveMhz: 112.3 };
  provider._rustSimvarSnapshotSequence = 1;
  provider._rustSimvarBridge = { getSnapshot: () => rustSnapshot };
  const bridge = {
    _started: true,
    getSnapshot: () => ({ source: 'mock-sidecar' }),
    async setNamedVar() {
      throw new Error('paired NAV tuning must not use an LVAR write');
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (name === 'NAV1_RADIO_SET') provider._data.nav1ActiveMhz = 110.3;
      if (name === 'NAV2_RADIO_SET') provider._data.nav2ActiveMhz = 110.3;
      provider._rustSimvarSnapshotSequence += 1;
      rustSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  stubPmdg737SdkIntegration(provider);

  const profile = profileLoader.loadProfile(PMDG_737_PROFILE_KEY);
  const execute = () => executeAircraftCommand(provider, {
    commandId: 'radios.nav.setBothActive',
    input: { value: 110.3 },
    profileKey: PMDG_737_PROFILE_KEY,
    profileRevision: PMDG_737_PROFILE_REVISION,
  }, {
    profile,
    profileRevision: PMDG_737_PROFILE_REVISION,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });

  const result = await execute();
  assert.equal(result.ok, true);
  assert.equal(result.commandId, 'radios.nav.setBothActive');
  assert.equal(result.controlRequest.actionId, 'radios.navBoth.setActive');
  assert.deepEqual(events, [
    { name: 'NAV1_RADIO_SET', value: 0x1030 },
    { name: 'NAV2_RADIO_SET', value: 0x1030 },
  ]);
  assert.deepEqual(result.confirmedValues, {
    'radios.nav1ActiveMhz': 110.3,
    'radios.nav2ActiveMhz': 110.3,
  });

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const repeated = await execute();
  assert.equal(repeated.ok, true);
  assert.equal(repeated.noOp, true, 'already-satisfied paired tuning should not dispatch again');
  assert.equal(events.length, 2);
});

test('PMDG 737 paired course command writes both MCP windows and confirms both SDK readbacks', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: {
      automation: { ap: { selected: { courseLeftDeg: 180, courseRightDeg: 90 } } },
    },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  const bridge = {
    _started: true,
    getSnapshot: () => ({ source: 'mock-sidecar' }),
    async setNamedVar() {
      throw new Error('paired MCP course setting must not use an LVAR write');
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (name === '#84132') sdkSnapshot.normalized.automation.ap.selected.courseLeftDeg = value;
      if (name === '#84133') sdkSnapshot.normalized.automation.ap.selected.courseRightDeg = value;
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
  stubPmdg737SdkIntegration(provider);

  const profile = profileLoader.loadProfile(PMDG_737_PROFILE_KEY);
  const execute = () => executeAircraftCommand(provider, {
    commandId: 'flightGuidance.course.setBoth',
    input: { value: 273 },
    profileKey: PMDG_737_PROFILE_KEY,
    profileRevision: PMDG_737_PROFILE_REVISION,
  }, {
    profile,
    profileRevision: PMDG_737_PROFILE_REVISION,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });

  const result = await execute();
  assert.equal(result.ok, true);
  assert.equal(result.commandId, 'flightGuidance.course.setBoth');
  assert.equal(result.controlRequest.actionId, 'mcp.courseBoth.set');
  assert.deepEqual(events, [
    { name: '#84132', value: 273 },
    { name: '#84133', value: 273 },
  ]);
  assert.deepEqual(result.confirmedValues, {
    'mcp.courseCaptainDeg': 273,
    'mcp.courseFirstOfficerDeg': 273,
  });

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const repeated = await execute();
  assert.equal(repeated.ok, true);
  assert.equal(repeated.noOp, true, 'already-satisfied paired course setting should not dispatch again');
  assert.equal(events.length, 2);
});

test('PMDG 737 spoiler and parking-brake commands execute explicit states without unsafe repeat toggles', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: {
      brakes: { parking: false },
      spoilers: { armed: false },
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
      if (value === 0x20000000) {
        if (name === '#76424') sdkSnapshot.normalized.spoilers.armed = true;
        if (name === '#76423') sdkSnapshot.normalized.spoilers.armed = false;
        if (name === '#70325') {
          sdkSnapshot.normalized.brakes.parking = !sdkSnapshot.normalized.brakes.parking;
        }
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
  stubPmdg737SdkIntegration(provider);

  const integration = {
    type: 'aircraft-integration',
    name: PMDG_737_ADAPTER_ID,
    verification: 'untested',
  };
  const execute = async (actionId) => {
    provider._aircraftIntegrationActionLastAttemptAt.clear();
    return provider.executeAircraftControlAction(integration, {
      profileKey: PMDG_737_PROFILE_KEY,
      profileRevision: PMDG_737_PROFILE_REVISION,
      request: { actionId },
    });
  };

  const arm = await execute('flightControls.speedbrake.arm');
  assert.equal(arm.ok, true);
  assert.equal(arm.confirmedValue, true);
  assert.deepEqual(events, [
    { name: '#76424', value: 0x20000000 },
    { name: '#76424', value: 0x00020000 },
  ]);

  const armAgain = await execute('flightControls.speedbrake.arm');
  assert.equal(armAgain.noOp, true, 'repeating ARM should not touch the lever again');
  assert.equal(events.length, 2);

  const disarm = await execute('flightControls.speedbrake.disarm');
  assert.equal(disarm.ok, true);
  assert.equal(disarm.confirmedValue, false);
  assert.deepEqual(events.slice(2), [
    { name: '#76423', value: 0x20000000 },
    { name: '#76423', value: 0x00020000 },
  ]);

  const setParkingBrake = await execute('gear.parkingBrake.set');
  assert.equal(setParkingBrake.ok, true);
  assert.equal(setParkingBrake.confirmedValue, true);
  assert.deepEqual(events.slice(4), [
    { name: '#70325', value: 0x20000000 },
    { name: '#70325', value: 0x00020000 },
  ]);

  const setParkingBrakeAgain = await execute('gear.parkingBrake.set');
  assert.equal(setParkingBrakeAgain.noOp, true, 'repeating SET must not fire the toggle event');
  assert.equal(events.length, 6);

  const releaseParkingBrake = await execute('gear.parkingBrake.released');
  assert.equal(releaseParkingBrake.ok, true);
  assert.equal(releaseParkingBrake.confirmedValue, false);
  assert.deepEqual(events.slice(6), [
    { name: '#70325', value: 0x20000000 },
    { name: '#70325', value: 0x00020000 },
  ]);

  const profile = profileLoader.loadProfile(PMDG_737_PROFILE_KEY);
  const executeCanonical = async (commandId, value) => {
    provider._aircraftIntegrationActionLastAttemptAt.clear();
    return executeAircraftCommand(provider, {
      commandId,
      input: { value },
      profileKey: PMDG_737_PROFILE_KEY,
      profileRevision: PMDG_737_PROFILE_REVISION,
    }, {
      profile,
      profileRevision: PMDG_737_PROFILE_REVISION,
      requireProfileToken: true,
      capabilities: {
        actionTypes: ['aircraft-integration'],
        integrationTransports: ['sdk'],
      },
    });
  };

  const canonicalArm = await executeCanonical('surfaces.spoilersArmed.set', true);
  assert.equal(canonicalArm.ok, true);
  assert.equal(canonicalArm.commandId, 'surfaces.spoilersArmed.set');
  assert.equal(canonicalArm.controlRequest.actionId, 'flightControls.speedbrake.arm');
  assert.deepEqual(events.slice(8, 10), [
    { name: '#76424', value: 0x20000000 },
    { name: '#76424', value: 0x00020000 },
  ]);

  const canonicalSetParkingBrake = await executeCanonical('surfaces.parkingBrake.set', true);
  assert.equal(canonicalSetParkingBrake.ok, true);
  assert.equal(canonicalSetParkingBrake.commandId, 'surfaces.parkingBrake.set');
  assert.equal(canonicalSetParkingBrake.controlRequest.actionId, 'gear.parkingBrake.set');
  assert.deepEqual(events.slice(10), [
    { name: '#70325', value: 0x20000000 },
    { name: '#70325', value: 0x00020000 },
  ]);
});

test('PMDG 737 A/T ARM preserves its reversed SDK wire polarity in both directions', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: { automation: { athr: { armed: false } } },
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
      if (name === '#70012') {
        sdkSnapshot.normalized.automation.athr.armed = value === 0;
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
  stubPmdg737SdkIntegration(provider);

  const action = {
    type: 'aircraft-integration',
    name: PMDG_737_ADAPTER_ID,
    verification: 'untested',
  };
  const options = (actionId) => ({
    profileKey: PMDG_737_PROFILE_KEY,
    profileRevision: PMDG_737_PROFILE_REVISION,
    request: { actionId },
  });

  const on = await provider.executeAircraftControlAction(
    action,
    options('afds.autothrottleArm.on'),
  );
  assert.equal(on.ok, true);
  assert.equal(on.confirmedValue, true);
  assert.deepEqual(events[0], { name: '#70012', value: 0 }, 'wire value 0 is ARM/ON');

  provider._aircraftIntegrationActionLastAttemptAt.clear();
  const off = await provider.executeAircraftControlAction(
    action,
    options('afds.autothrottleArm.off'),
  );
  assert.equal(off.ok, true);
  assert.equal(off.confirmedValue, false);
  assert.deepEqual(events[1], { name: '#70012', value: 1 }, 'wire value 1 is OFF');
});

test('PMDG 737 IAS and Mach requests share in-flight and cooldown guards', async () => {
  const provider = new SimConnectTelemetryProvider();
  const sdkSnapshot: any = {
    adapterId: 'clientdata-manifest',
    status: 'running',
    normalized: { automation: { ap: { selected: { iasMach: 250 } } } },
    snapshotSequence: 1,
    updatedAt: new Date().toISOString(),
  };
  const events: Array<{ name: string; value: number }> = [];
  let signalIasDispatched: () => void = () => {};
  const iasDispatched = new Promise<void>((resolve) => { signalIasDispatched = resolve; });
  const bridge = {
    getSnapshot() {
      return { source: 'mock-sidecar' };
    },
    async sendEvent(name, value) {
      events.push({ name, value });
      if (name === '#84134') signalIasDispatched();
      return { ok: true };
    },
  };
  provider._lvarBridge = bridge;
  provider._ensureControlWriteBridge = async () => bridge;
  provider._sdkBridge = {
    getSnapshot: () => sdkSnapshot,
    isDataConnected: () => true,
  };
  stubPmdg737SdkIntegration(provider);

  const action = {
    type: 'aircraft-integration',
    name: PMDG_737_ADAPTER_ID,
    verification: 'untested',
  };
  const options = (actionId, value) => ({
    profileKey: PMDG_737_PROFILE_KEY,
    profileRevision: PMDG_737_PROFILE_REVISION,
    request: { actionId, value },
  });

  const iasRequest = provider.executeAircraftControlAction(
    action,
    options('mcp.ias.set', 260),
  );
  await iasDispatched;

  const overlappingMach = await provider.executeAircraftControlAction(
    action,
    options('mcp.mach.set', 0.78),
  );
  assert.equal(overlappingMach.ok, false);
  assert.equal(overlappingMach.code, 'action_in_progress');
  assert.deepEqual(events, [{ name: '#84134', value: 260 }],
    'overlapping Mach request must not reach the shared selector');

  sdkSnapshot.normalized.automation.ap.selected.iasMach = 260;
  sdkSnapshot.snapshotSequence += 1;
  sdkSnapshot.updatedAt = new Date().toISOString();
  const iasResult = await iasRequest;
  assert.equal(iasResult.ok, true);
  assert.equal(iasResult.confirmedValue, 260);

  const coolingDownMach = await provider.executeAircraftControlAction(
    action,
    options('mcp.mach.set', 0.78),
  );
  assert.equal(coolingDownMach.ok, false);
  assert.equal(coolingDownMach.code, 'action_cooldown');
  assert.equal(events.length, 1, 'cross-mode cooldown must not dispatch a second selector write');
});

export {};
