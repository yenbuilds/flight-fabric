const assert = require('node:assert/strict');
const test = require('node:test');

const profileLoader = require('../aircraft/aircraft-profile-loader');
const { executeAircraftCommand } = require('../aircraft/aircraft-control-service');
const userSettings = require('../core/user-settings');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider');

const PMDG_777_PROFILE_KEY = 'bundled/msfs/pmdg-777';
const PMDG_777_PROFILE_REVISION = 11;
const PMDG_777_ADAPTER_ID = 'pmdg-777';

async function withGearFixture(profileKey, run) {
  const originalProfileKey = profileLoader.getActiveProfileId();
  try {
    profileLoader.setActiveProfile(profileKey);
    const profileRevision = profileLoader.getActiveProfileRevision();
    const provider = new SimConnectTelemetryProvider();
    provider._connected = true;
    provider._systemState = { sim: 1 };
    provider._data = { userInput: true, gearLeft: 0, gearRight: 0, gearNose: 0 };
    const snapshot: any = { adapterId: 'clientdata-manifest', status: 'running',
      snapshotSequence: 1, updatedAt: new Date().toISOString(), normalized: { gear: { down: false } } };
    const events: Array<{ name: string; value: number }> = [];
    const fixture = { provider, snapshot, events, connected: true, exception: null as any,
      publish(down) {
        snapshot.normalized.gear.down = down;
        snapshot.snapshotSequence += 1;
        snapshot.updatedAt = new Date().toISOString();
      },
      onEvent(name) {
        fixture.publish(name === 'GEAR_DOWN');
        return { ok: true, sendId: 42 };
      },
      async execute(value) {
        // Independent requests do not need to spend real time on cooldowns.
        provider._aircraftIntegrationActionLastAttemptAt.clear();
        return executeAircraftCommand(provider, {
          commandId: 'surfaces.gear.set', input: { value }, profileKey, profileRevision,
        }, { profile: profileLoader.loadProfile(profileKey), profileRevision,
          requireProfileToken: true, capabilities: provider.getAircraftControlCapabilities() });
      },
    };
    provider._sdkBridge = { getSnapshot: () => snapshot, isDataConnected: () => fixture.connected };
    const bridge = {
      _started: true, getSnapshot: () => ({ status: 'running' }),
      async sendEvent(name, value) {
        events.push({ name, value });
        return fixture.onEvent(name);
      },
      async setNamedVar() { throw new Error('Gear must not write an LVar'); },
      async sendSdkEvent() { throw new Error('Gear must not fall back to the numeric SDK recipe'); },
      findRecentSimConnectException(sendIds) { return sendIds.includes(42) ? fixture.exception : null; },
    };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    await run(fixture);
  } finally {
    profileLoader.setActiveProfile(originalProfileKey);
  }
}

test('all PMDG 777 profiles confirm SDK gear lever selection ahead of physical travel', async () => {
  // The -300ER live capture showed lever selection well before physical travel;
  // see docs/PMDG-777-GEAR-VALIDATION.md. Other variants have contract coverage only.
  for (const profileKey of [PMDG_777_PROFILE_KEY, 'bundled/msfs/pmdg-777-200er',
    'bundled/msfs/pmdg-777-200lr', 'bundled/msfs/pmdg-777f']) {
    await withGearFixture(profileKey, async ({ execute, events, provider, snapshot }) => {
      // Event-driven ClientData silence alone does not invalidate a live lever.
      snapshot.updatedAt = new Date(Date.now() - 60000).toISOString();
      assert.equal((await execute('up')).noOp, true);
      assert.equal(events.length, 0);
      for (const target of ['down', 'up']) {
        const before = events.length;
        const result = await execute(target);
        assert.equal(result.ok, true, `${profileKey} ${target}: ${result.error}`);
        assert.equal(result.confirmedValue, target === 'down');
        assert.equal(result.transportAcknowledged, undefined);
        assert.deepEqual(events.slice(before), [{ name: target === 'down' ? 'GEAR_DOWN' : 'GEAR_UP', value: 0 }]);
        for (const key of ['gearLeft', 'gearRight', 'gearNose']) {
          assert.equal(provider._data[key], target === 'down' ? 0 : 100, 'do not wait for full gear travel');
        }
        assert.equal((await execute(target)).noOp, true);
        assert.equal(events.length, before + 1);
        // Let physical travel finish before reversing, as in the live test.
        for (const key of ['gearLeft', 'gearRight', 'gearNose']) provider._data[key] = target === 'down' ? 100 : 0;
      }
    });
  }
});

test('PMDG 777 gear refuses unavailable SDK lever state before any write', async () => {
  for (const condition of ['missing', 'invalid', 'stopped', 'disconnected', 'wrong-adapter']) {
    await withGearFixture(PMDG_777_PROFILE_KEY, async (fixture) => {
      if (condition === 'missing') delete fixture.snapshot.normalized.gear.down;
      // Deliberately invalid telemetry: unknown must not become a lever selection.
      if (condition === 'invalid') fixture.snapshot.normalized.gear.down = 'unknown';
      if (condition === 'stopped') fixture.snapshot.status = 'stopped';
      if (condition === 'disconnected') fixture.connected = false;
      if (condition === 'wrong-adapter') fixture.snapshot.adapterId = 'other-adapter';
      const result = await fixture.execute('down');
      assert.equal(result.ok, false, condition);
      assert.equal(fixture.events.length, 0, condition);
    });
  }
});

test('PMDG 777 gear retains no-retry, fresh confirmation, SDK/profile and late-exception safeguards', async () => {
  for (const [condition, expectedCode] of [
    ['unchanged-lever', 'aircraft_integration_readback_timeout'],
    ['unchanged-sequence', 'aircraft_integration_readback_timeout'],
    ['rejected', 'simconnect_sequence_execution_failed'],
    ['sdk-disconnected', 'sdk_transport_unavailable'],
    ['profile-changed', 'stale_profile'],
    ['simconnect-exception', 'aircraft_integration_simconnect_exception'],
  ]) {
    await withGearFixture(PMDG_777_PROFILE_KEY, async (fixture) => {
      fixture.onEvent = () => {
        if (condition === 'unchanged-sequence') fixture.snapshot.normalized.gear.down = true;
        else fixture.publish(condition !== 'unchanged-lever');
        if (condition === 'sdk-disconnected') fixture.connected = false;
        if (condition === 'profile-changed') profileLoader.setActiveProfile('bundled/msfs/generic');
        if (condition === 'simconnect-exception') fixture.exception = { sendId: 42, exception: 1 };
        return { ok: condition !== 'rejected', sendId: 42 };
      };
      const result = await fixture.execute('down');
      assert.equal(result.ok, false, condition);
      assert.equal(result.code, expectedCode, condition);
      assert.equal(result.executionStarted, true, condition);
      assert.deepEqual(fixture.events, [{ name: 'GEAR_DOWN', value: 0 }]);
    });
  }
});

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

test('PMDG 777 SDK profile resolves without an app agreement or acceptance record', () => {
  const provider = new SimConnectTelemetryProvider();
  const originalProfileKey = profileLoader.getActiveProfile()?._qualifiedId || 'bundled/msfs/generic';
  const originalIntegrations = userSettings.settings.integrations;

  try {
    profileLoader.setActiveProfile(PMDG_777_PROFILE_KEY);
    for (const integrations of [undefined, {}, { pmdg777Sdk: { eulaAcceptedVersion: 'obsolete' } }]) {
      userSettings.settings.integrations = integrations;
      const resolved = provider._resolveActiveSdkProfile();
      assert.equal(resolved?.adapter?.id, 'clientdata-manifest');
      assert.equal(resolved?.profileSdk?.target?.channel, 'pmdg-777x-clientdata');
      assert.equal(resolved?.profileSdk?.target?.connector, 'pmdg-777x-clientdata');
      assert.equal(userSettings.settings.integrations, integrations, 'resolving the SDK never records acceptance');
    }
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
      sdkSnapshot.snapshotSequence += 1;
      sdkSnapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    },
    async setNamedVar({ name, unit, value }) {
      assert.equal(name, 'L:OH_DOME_SWITCH');
      assert.equal(unit, 'Number');
      events.push({ name, value });
      sdkSnapshot.normalized.lighting.domePercent = value;
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
    { name: 'L:OH_DOME_SWITCH', value: 42 },
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
