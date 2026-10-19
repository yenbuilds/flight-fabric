const assert = require('node:assert/strict');
const test = require('node:test');
const { SimConnectTelemetryProvider } = require('../../telemetry-provider/simconnect-telemetry-provider');
const { createAircraftIntegrationRegistry, defaultAircraftIntegrationRegistry } = require('../../aircraft/integration-engine');

// Synthetic definition isolates transport confirmation from aircraft mappings.
const adapterId = 'native-input-test';
const profileKey = 'bundled/msfs/native-input-test';
const aircraft = 'SimObjects\\Airplanes\\native-input-test\\aircraft.CFG';
const definition: any = {
  id: adapterId, aircraft: { vendor: 'Fixture', family: 'Native' },
  trustedProfileKeys: [profileKey], presentation: { templateId: adapterId },
  fields: { 'lights.beacon': { id: 'lights.beacon', sources: [{
    route: { type: 'lvar', name: 'L:FIXTURE_BEACON', unit: 'Number' },
    decode: { type: 'boolean', trueValues: [0], falseValues: [1] },
  }] } },
  actions: { 'lights.beacon.on': { id: 'lights.beacon.on', verification: 'untested',
    guard: { groupId: 'nativeInput.beacon', cooldownMs: 1, retry: 'never' },
    routes: [{ id: 'beacon.native', transport: 'input-event', inputEvent: 'FIXTURE_BEACON', value: 0,
      readback: { fieldId: 'lights.beacon', expectedValue: true, timeoutMs: 15, freshness: 'field' } }],
  } },
};
definition.actions['lights.beacon.conditional'] = structuredClone(definition.actions['lights.beacon.on']);
definition.actions['lights.beacon.conditional'].id = 'lights.beacon.conditional';
definition.actions['lights.beacon.conditional'].routes[0].id = 'beacon.conditional.native';
definition.actions['lights.beacon.conditional'].routes[0].precondition = {
  fieldId: 'lights.beacon', expectedValue: false, freshness: 'field',
};
defaultAircraftIntegrationRegistry.register(definition);

function fixture(options: any = {}) {
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._lastDetectedAircraftTitle = aircraft;
  let current = true;
  const stamp = Date.now() - 200;
  const snapshot: any = { profileId: profileKey, status: 'connected', inputEventsAvailable: true,
    snapshotSequence: 1, values: { beacon: 1 }, updatedAt: new Date(stamp).toISOString(),
    valueUpdatedAt: { beacon: new Date(stamp).toISOString() } };
  const calls = [];
  const bridge: any = {
    _started: true, getSnapshot: () => snapshot,
    sendInputEvent: async (...args) => {
      calls.push(args);
      if (options.reject) return { ok: false, error: 'input_event_not_found' };
      if (!options.noChange) {
        snapshot.values.beacon = 0;
        snapshot.snapshotSequence++;
        snapshot.updatedAt = new Date().toISOString();
        if (!options.staleField) snapshot.valueUpdatedAt.beacon = snapshot.updatedAt;
      }
      if (options.changeAircraft) current = false;
      return { ok: true, sendId: 42 };
    },
    findRecentSimConnectException: (ids, since) => {
      assert.deepEqual(ids, [42]); assert.equal(typeof since, 'number');
      return options.exception ? { sendId: 42, exception: 3 } : null;
    },
  };
  provider._getActiveAircraftIntegrationConfig = (key, id, revision) => (
    current && key === profileKey && id === adapterId && revision === 7
      ? { profileKey, integrationId: adapterId, profileRevision: 7 } : null
  );
  provider._getAircraftIntegrationFieldConfig = () => ({ id: 'lights.beacon',
    source: { type: 'lvar', key: 'beacon' }, decode: { type: 'boolean', trueValues: [0], falseValues: [1] } });
  const execute = (request = {}) => provider._executeAircraftIntegrationAction(bridge,
    { type: 'aircraft-integration', name: adapterId }, 'simconnect',
    { profileKey, profileRevision: 7, request: { actionId: 'lights.beacon.on', ...request } });
  return { provider, snapshot, bridge, calls, execute };
}

test('native integration routes require a fixed finite payload and independent dated readback', () => {
  for (const value of [0, -1, 1]) {
    const candidate = structuredClone(definition);
    candidate.actions['lights.beacon.on'].routes[0].value = value;
    assert.doesNotThrow(() => createAircraftIntegrationRegistry([candidate]));
  }
  for (const patch of [
    { value: undefined }, { value: NaN }, { value: Infinity }, { value: '0' }, { value: true },
    { inputEvent: 'A'.repeat(64) }, { inputEvent: 'INVALID\0NAME' }, { inputEvent: 'B:EVENT (>L:VAR)' },
    { readback: undefined }, { confirmation: 'transport-acknowledged' }, { parameters: [1] },
    { readback: { fieldId: 'lights.beacon', expectedValue: true, timeoutMs: 15 } },
    { precondition: { fieldId: 'lights.beacon', expectedValue: false } },
    { precondition: { fieldId: 'unknown.field', expectedValue: false, freshness: 'field' } },
    { precondition: { fieldId: 'lights.beacon', expectedValue: false, freshness: 'field', code: 'unsafe' } },
  ]) {
    const candidate = structuredClone(definition);
    Object.assign(candidate.actions['lights.beacon.on'].routes[0], patch);
    assert.throws(() => createAircraftIntegrationRegistry([candidate]));
  }
});

test('native integration preserves payload zero and exact AircraftLoaded identity, then confirms fresh state', async () => {
  const f = fixture();
  const result = await f.execute();
  assert.deepEqual(f.calls, [['FIXTURE_BEACON', 0, aircraft]]);
  assert.equal(result.ok, true);
  assert.equal(result.confirmedValue, true);
  assert.equal(result.transportMode, 'input-event');
  assert.equal(result.transportAcknowledged, undefined);
});

test('live bridge native support is advertised to the catalogue as well as the executor', () => {
  const f = fixture(); f.provider._lvarBridge = f.bridge;
  for (const [started, available] of [[true, true], [true, false], [false, true]]) {
    f.bridge._started = started; f.snapshot.inputEventsAvailable = available;
    const advertised = f.provider.getAircraftControlCapabilities();
    assert.equal(advertised.integrationTransports['input-event'], started && available);
    assert.equal(advertised.actionTypes.includes('input-event'), started && available);
    assert.equal(f.provider._getAircraftIntegrationTransportCapabilities(f.bridge)['input-event'], started && available);
  }
});

test('native integration refuses unavailable transport, title-only identity, client values and stale baseline', async () => {
  const cases = [
    { change: f => { f.snapshot.inputEventsAvailable = false; }, code: 'aircraft_integration_transport_unavailable' },
    { change: f => { f.bridge._started = false; }, code: 'aircraft_integration_transport_unavailable' },
    { change: f => { f.provider._lastDetectedAircraftTitle = 'Aircraft title'; }, code: 'aircraft_identity_required' },
    { change: f => { f.snapshot.valueUpdatedAt.beacon = '2020-01-01T00:00:00.000Z'; }, code: 'aircraft_integration_readback_unavailable' },
    { change: () => {}, request: { value: 1 }, code: 'invalid_value' },
  ];
  for (const scenario of cases) {
    const f = fixture(); scenario.change(f);
    const result = await f.execute(scenario.request);
    assert.equal(result.code, scenario.code); assert.equal(result.ok, false);
    assert.equal(f.calls.length, 0);
  }
});

test('native integration same-state intent is a no-op, protecting toggle-only aircraft buttons', async () => {
  const f = fixture(); f.snapshot.values.beacon = 0;
  const result = await f.execute();
  assert.equal(result.ok, true); assert.equal(result.noOp, true);
  assert.equal(f.calls.length, 0);
});

test('native integration requires fresh matching prerequisite state before dispatch', async () => {
  for (const [mode, expectedCode] of [['wrong', 'aircraft_integration_precondition_failed'], ['stale', 'aircraft_integration_precondition_unavailable'], ['valid', 'executed']]) {
    const f = fixture();
    if (mode === 'wrong') f.snapshot.values.beacon = 0;
    if (mode === 'stale') f.snapshot.valueUpdatedAt.beacon = '2020-01-01T00:00:00.000Z';
    const result = await f.execute({ actionId: 'lights.beacon.conditional' });
    assert.equal(result.code, expectedCode);
    assert.equal(result.ok, mode === 'valid');
    assert.equal(f.calls.length, mode === 'valid' ? 1 : 0);
  }
});

test('native ACK cannot replace newer field confirmation, and failure never retries', async () => {
  for (const options of [{ noChange: true }, { staleField: true }, { reject: true }, { exception: true }, { changeAircraft: true }]) {
    const f = fixture(options); const result = await f.execute();
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 1);
    assert.equal(result.code, options.reject ? 'input_event_execution_failed'
      : options.exception ? 'aircraft_integration_simconnect_exception'
      : options.changeAircraft ? 'stale_profile' : 'aircraft_integration_readback_timeout');
    if (!options.reject) assert.equal(result.executionStarted, true);
  }
});

test('native SimVar confirmation requires a newer field sample, not an unrelated update', () => {
  const f = fixture();
  f.provider._getAircraftIntegrationFieldConfig = () => ({ id: 'controls.flaps',
    source: { type: 'simvar', name: 'FLAPS HANDLE INDEX' },
    decode: { type: 'enum', values: { 0: 'up', 1: '1' } } });
  const stamp = Date.now() - 200;
  const snapshot = { status: 'running', updatedAt: new Date(stamp).toISOString(),
    valueUpdatedAt: { flapsIndex: new Date(stamp).toISOString() } };
  f.provider._rustSimvarBridge = { getSnapshot: () => snapshot };
  f.provider._rustSimvarSnapshotSequence = 1;
  f.provider._data.flapsIndex = 0;
  const readback = { fieldId: 'controls.flaps', freshness: 'field', expectedValue: '1' };
  const context = { profileKey, adapterId, profileRevision: 7 };
  const capture = () => f.provider._captureAircraftIntegrationReadback(f.bridge, readback, context);
  const baseline = capture();
  assert.equal(baseline.fresh, true);
  f.provider._data.flapsIndex = 1;
  f.provider._rustSimvarSnapshotSequence++;
  snapshot.updatedAt = new Date().toISOString();
  assert.equal(f.provider._evaluateAircraftIntegrationReadback(capture(), readback, baseline).confirmed, false);
  snapshot.valueUpdatedAt.flapsIndex = snapshot.updatedAt;
  assert.equal(f.provider._evaluateAircraftIntegrationReadback(capture(), readback, baseline).confirmed, true);
  delete snapshot.valueUpdatedAt.flapsIndex;
  assert.equal(capture().fresh, false);
  snapshot.valueUpdatedAt.flapsIndex = snapshot.updatedAt;
  f.provider._connected = false;
  assert.equal(capture().fresh, false);
});

// Use bundled fields and the production decoder/subscription keys. These tests
// verify request semantics; they do not establish live aircraft response.
function mappedFixture(key, initial, options: any = {}) {
  const loader = require('../../aircraft/aircraft-profile-loader');
  loader.setActiveProfile(key);
  const config = loader.getAircraftSpecificConfig();
  const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
  provider._lastDetectedAircraftTitle = `SimObjects\\Airplanes\\${config.integrationId}\\aircraft.CFG`;
  provider._getActiveAircraftIntegrationConfig = () => config;
  const stamp = new Date(Date.now() - 100).toISOString();
  const snapshot: any = { profileId: key, status: 'running', inputEventsAvailable: true, snapshotSequence: 1,
    values: {}, valueUpdatedAt: {}, updatedAt: stamp,
    mobiflight: { connected: true, available: true, state: 'connected' } };
  const native: any = { status: 'running', valueUpdatedAt: { flaps: stamp }, updatedAt: stamp };
  provider._rustSimvarBridge = { getSnapshot: () => native }; provider._rustSimvarSnapshotSequence = 1;
  let tick = Date.now() - 100;
  const publish = (id, value, fresh = true) => {
    const field = config.confirmationFields.find(f => f.id === id);
    assert.ok(field, id);
    const time = new Date(++tick).toISOString();
    if (field.source.type === 'simvar') {
      assert.equal(field.source.name, 'FLAPS HANDLE PERCENT');
      provider._data.flaps = value; provider._rustSimvarSnapshotSequence++;
      if (fresh) native.valueUpdatedAt.flaps = time;
    } else {
      snapshot.values[field.source.key] = value; snapshot.snapshotSequence++;
      if (fresh) snapshot.valueUpdatedAt[field.source.key] = time;
    }
  };
  Object.entries(initial).forEach(([id, value]) => publish(id, value));
  const calls = [];
  const bridge: any = { _started: true, getSnapshot: () => snapshot,
    sendInputEvent: async (...args) => { calls.push(args); options.onWrite?.(publish, args); return { ok: true }; },
    sendEvent: async (...args) => { calls.push(args); options.onWrite?.(publish, args); return { ok: true }; },
    executeMobiFlightCode: async code => { calls.push(code); options.onWrite?.(publish, code); return { ok: true }; },
    setNamedVar: async () => { throw Error('No raw state writes'); },
  };
  const wait = provider._waitForAircraftIntegrationReadback.bind(provider);
  provider._waitForAircraftIntegrationReadback = (b, r, c, baseline) => wait(b, { ...r, timeoutMs: 15 }, c, baseline);
  const execute = (actionId, value = undefined) => provider._executeAircraftIntegrationAction(bridge,
    { name: config.integrationId }, 'test', { profileKey: key, profileRevision: config.profileRevision, request: { actionId, value } });
  return { provider, snapshot, config, calls, publish, execute };
}

test('A350 landing autobrake confirms system state, suppresses repeated toggles and refuses stale or unpowered state', async () => {
  const key = 'bundled/msfs/inibuilds-a350-1000';
  for (const state of [0, 1]) {
    const f = mappedFixture(key, { 'controls.autobrakeArmed': state, 'systems.busVoltage': 28 }, {
      onWrite: publish => publish('controls.autobrakeArmed', 1),
    });
    const result = await f.execute('controls.autobrake.arm');
    assert.equal(result.ok, true); assert.equal(f.calls.length, state === 1 ? 0 : 1);
    if (f.calls.length) assert.equal(f.calls[0][0], 'AIRLINER_LDG_AUTO_BRK');
  }
  for (const problem of ['stale', 'unknown', 'power', 'silent']) {
    const f = mappedFixture(key, { 'controls.autobrakeArmed': problem === 'unknown' ? 7 : 0,
      'systems.busVoltage': problem === 'power' ? 0 : 28 });
    if (problem === 'stale') Object.keys(f.snapshot.valueUpdatedAt).forEach(k => { f.snapshot.valueUpdatedAt[k] = '2000-01-01'; });
    const result = await f.execute('controls.autobrake.arm');
    assert.equal(result.ok, false, problem);
    assert.equal(f.calls.length, problem === 'silent' ? 1 : 0, problem);
  }
});

test('A350 flap targets confirm the selection ahead of surface travel, including UP zero', async () => {
  for (const target of [0, 50, 100]) {
    let current = 25;
    const f = mappedFixture('bundled/msfs/inibuilds-a350-900', { 'controls.flapsHandle': current, 'systems.busVoltage': 28 }, {
      onWrite: (publish, code) => { current += code.includes('_Inc') ? 25 : -25; publish('controls.flapsHandle', current); },
    });
    f.provider._data.flapsAngle = 0;
    const result = await f.execute('controls.flaps.set', target);
    assert.equal(result.ok, true); assert.equal(result.confirmedValue, target);
    assert.equal(f.calls.length, Math.abs(target - 25) / 25);
    assert.match(f.calls[0], /FLAPS NUM HANDLE POSITIONS.*B:AIRLINER_Flaps_(Inc|Dec)/);
  }
  const silent = mappedFixture('bundled/msfs/inibuilds-a350-900', { 'controls.flapsHandle': 25, 'systems.busVoltage': 28 });
  assert.equal((await silent.execute('controls.flaps.set', 100)).ok, false);
  assert.equal(silent.calls.length, 1, 'an unconfirmed step stops the remaining movement');
});

test('iniBuilds A380 gear uses its native handle, preserves ground inhibition and confirms selection only', async () => {
  for (const onGround of [1, 9, 0]) {
    const f = mappedFixture('bundled/msfs/inibuilds-a380-800-rr', {
      'controls.onGround': onGround, 'controls.gearHandleDown': 1,
    }, { onWrite: publish => publish('controls.gearHandleDown', 0) });
    const result = await f.execute('controls.gear.up');
    assert.equal(result.ok, onGround === 0); assert.equal(f.calls.length, onGround === 0 ? 1 : 0);
    if (f.calls.length) assert.deepEqual(f.calls[0].slice(0, 2), ['AIRLINER_MIP_LG_HANDLE', 0]);
  }
  const same = mappedFixture('bundled/msfs/inibuilds-a380-800-rr', { 'controls.onGround': 1, 'controls.gearHandleDown': 1 });
  assert.equal((await same.execute('controls.gear.down')).noOp, true); assert.equal(same.calls.length, 0);
});

export {};
