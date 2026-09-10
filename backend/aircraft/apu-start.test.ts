const assert = require('node:assert/strict');
const test = require('node:test');
const { executeAircraftCommand, buildAircraftControlCapabilities } = require('./aircraft-control-service');
const { resolveAircraftCommandConfiguration } = require('./aircraft-command-catalogue');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const { defaultAircraftIntegrationRegistry, createAircraftIntegrationRegistry } = require('./aircraft-integrations');

const families = [
  ['fbw-a32nx', 'fbw-a32nx', 'systems.apuStart.start', 'systems.apuMaster.on'],
  ['fbw-a380x', 'fbw-a380x', 'systems.apuStart.start', 'systems.apuMaster.on'],
  ['fenix-a32x', 'fenix-a320', 'systems.apuStart.start', 'systems.apuMaster.on'],
  ['inibuilds-a350', 'inibuilds-a350-900', 'systems.apuStart.start', 'systems.apuMaster.on'],
  ['pmdg-737', 'pmdg-737', 'systems.apu.start'],
  ['pmdg-777', 'pmdg-777', 'systems.apuSelector.start'],
];
function profile(adapter, id) {
  return { id, simulator: 'msfs', _profileKey: `bundled/msfs/${id}`,
    integration: { aircraftSpecific: { adapter }, controls: { genericFallback: false } } };
}
const capabilities = {
  actionTypes: ['aircraft-integration'],
  integrationTransports: ['sdk', 'simconnect-sequence', 'mobiflight-calculator', 'lvar'],
};

for (const [adapter, id, start, master] of families) {
  test(`${adapter}: shared UI/voice preset orders only master and START and returns request acceptance`, async () => {
    const calls: string[] = [];
    const provider = { aircraftControlCapabilities: capabilities,
      async executeAircraftControlAction(_action, options) {
        calls.push(options.request.actionId);
        return { ok: true, code: 'executed', transportAcknowledged: options.request.actionId === start };
      } };
    const catalogue = buildAircraftControlCapabilities(profile(adapter, id), { capabilities }).aircraftCommands;
    const command = catalogue.commands.find((item) => item.id === 'configuration.apu.start');
    assert.equal(command.kind, 'preset');
    assert.deepEqual(command.input, { kind: 'none' });
    assert.ok(command.speech.patterns.includes('start apu'));
    const result = await executeAircraftCommand(provider, { commandId: command.id, input: {} }, { profile: profile(adapter, id) });
    assert.equal(result.ok, true);
    assert.equal(result.transportAcknowledged, true);
    assert.equal(result.confirmedValue, undefined);
    assert.deepEqual(calls, [...(master ? [master] : []), start]);
    assert.equal(result.steps.at(-1).transportAcknowledged, true);
  });
}

test('APU preset reports accepted master and failed START without retry or rollback', async () => {
  const calls: string[] = [];
  const provider = { aircraftControlCapabilities: capabilities,
    async executeAircraftControlAction(_action, options) {
      calls.push(options.request.actionId);
      return calls.length === 1 ? { ok: true, code: 'executed' }
        : { ok: false, code: 'write_failed', error: 'START rejected.' };
    } };
  const result = await executeAircraftCommand(provider, { commandId: 'configuration.apu.start' }, { profile: profile('fenix-a32x', 'fenix-a320') });
  assert.equal(result.ok, false);
  assert.deepEqual(result.acceptedStepLabels, ['APU master ON']);
  assert.equal(result.failedStepLabel, 'APU START');
  assert.equal(result.executionStarted, true);
  assert.deepEqual(calls, ['systems.apuMaster.on', 'systems.apuStart.start']);
});

test('disconnect after master ON blocks START and reports the accepted step', async () => {
  let connected = true;
  const calls: string[] = [];
  const provider = { aircraftControlCapabilities: capabilities,
    async executeAircraftControlAction(_action, options) {
      calls.push(options.request.actionId);
      connected = false;
      return { ok: true, code: 'executed' };
    } };
  const result = await executeAircraftCommand(provider, { commandId: 'configuration.apu.start' }, {
    profile: profile('fbw-a32nx', 'fbw-a32nx'), requireStableSimState: true,
    getSimState: () => ({ simconnectConnected: connected, inMenu: false }),
  });
  assert.equal(result.code, 'sim_disconnected');
  assert.equal(result.failedStepLabel, 'APU START');
  assert.deepEqual(calls, ['systems.apuMaster.on']);
});

test('FBW master settling is bounded and uses installed preset timing, separate from START acknowledgement', () => {
  for (const adapter of ['fbw-a32nx', 'fbw-a380x']) {
    const integration = defaultAircraftIntegrationRegistry.resolveIntegration(adapter, { profileKey: `bundled/msfs/${adapter}` });
    assert.deepEqual(integration.actions['systems.apuMaster.on'].routes[0].operations, [
      { type: 'lvar', name: 'L:A32NX_OVHD_APU_MASTER_SW_PB_IS_ON', unit: 'Number', value: 1 },
      { type: 'delay', milliseconds: 3000 },
    ]);
    assert.equal(integration.actions['systems.apuMaster.on'].routes[0].readback.fieldId, 'systems.apuMaster');
    assert.equal(integration.actions['systems.apuStart.start'].routes[0].readback, undefined);
  }
});

test('APU preset never falls back on unsupported or copied profiles; A380X keeps radio and native surface bindings', () => {
  for (const aircraft of [{ id: 'generic', simulator: 'msfs' }, profile('fenix-a32x', 'copied-fenix')]) {
    const catalogue = buildAircraftControlCapabilities(aircraft, { capabilities }).aircraftCommands;
    assert.equal(catalogue.commands.some((command) => command.id === 'configuration.apu.start'), false);
  }
  const generic = resolveAircraftCommandConfiguration({});
  const a380 = resolveAircraftCommandConfiguration(profile('fbw-a380x', 'fbw-a380x'));
  const preserved = ({ commandId }) => commandId.startsWith('radios.');
  assert.deepEqual(a380.bindings.filter(preserved), generic.bindings.filter(preserved));
  const gear = a380.bindings.find(binding => binding.commandId === 'surfaces.gear.set');
  assert.equal(gear.choices.down.control, 'aircraft-specific');
  assert.equal(gear.choices.down.actionId, 'controls.gear.down');
  assert.equal(gear.choices.up.actionId, 'controls.gear.up');
});

function harness(adapter, id, actionId) {
  const provider = new SimConnectTelemetryProvider();
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(adapter, { profileKey: `bundled/msfs/${id}` });
  const action = integration.actions[actionId];
  const calls: unknown[] = [];
  let active = true;
  let accepted = true;
  let fresh = true;
  const observed = {};
  const bridge = {
    getSnapshot: () => ({ source: 'test' }),
    async setNamedVar(value) { calls.push(value); return { ok: accepted, error: 'Rejected.' }; },
    async sendEvent(name, value) { calls.push({ name, value }); return { ok: accepted, error: 'Rejected.' }; },
    async executeMobiFlightCode(code) { calls.push(code); return { ok: accepted, error: 'Rejected.' }; },
  };
  provider._sdkBridge = { isDataConnected: () => active, getSnapshot: () => ({ adapterId: 'clientdata-manifest' }) };
  provider._getActiveAircraftIntegrationConfig = () => active ? {} : null;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ sdk: true, 'simconnect-sequence': true, 'mobiflight-calculator': true });
  provider._getMobiFlightHealth = () => ({ connected: true });
  provider._captureAircraftIntegrationReadback = (_bridge, condition) => ({ fresh, observed: observed[condition.fieldId] });
  provider._waitForAircraftIntegrationReadback = () => { throw new Error('START must not wait for readback'); };
  const run = () => provider._executeAircraftIntegrationAction(bridge,
    { name: adapter }, 'test', { profileKey: `bundled/msfs/${id}`, profileRevision: 1, request: { actionId } });
  return { provider, action, calls, bridge, observed, run,
    setActive(value) { active = value; }, setAccepted(value) { accepted = value; }, setFresh(value) { fresh = value; } };
}

for (const [adapter, id, start] of families) {
  test(`${adapter}: START transport acceptance is prompt with absent availability; cooldown and rejection never retry`, async () => {
    const h = harness(adapter, id, start);
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.transportAcknowledged, true);
    assert.equal(result.confirmedValue, undefined);
    const count = h.calls.length;
    assert.equal(count, adapter.startsWith('pmdg-') ? 3 : adapter === 'fenix-a32x' ? 2 : 1);
    if (adapter === 'pmdg-737' || adapter === 'pmdg-777') {
      const values = adapter === 'pmdg-737' ? [11802, 11802, 11804] : [302, 302, 304];
      assert.deepEqual(h.calls, values.map((value) => ({ name: 'ROTOR_BRAKE', value })));
    }
    assert.equal((await h.run()).code, 'action_cooldown');
    assert.equal(h.calls.length, count);
    const rejected = harness(adapter, id, start);
    rejected.setAccepted(false);
    assert.equal((await rejected.run()).ok, false);
    assert.equal(rejected.calls.length, 1);
  });
}

for (const [adapter, start, selectorField, advanceValue, releaseValue] of [
  ['pmdg-737', 'systems.apu.start', 'systems.apuMode', 11802, 11804],
  ['pmdg-777', 'systems.apuSelector.start', 'systems.apuSelectorMode', 302, 304],
] as const) {
  test(`${adapter} START reaches the spring-loaded endpoint from OFF or ON and releases it once`, async () => {
    for (const initialPosition of [0, 1]) {
      const h = harness(adapter, adapter, start);
      let position = initialPosition;
      let startReleases = 0;
      h.observed[selectorField] = initialPosition === 0 ? 'off' : 'on';
      h.bridge.sendEvent = async (name, value) => {
        h.calls.push({ name, value });
        assert.equal(name, 'ROTOR_BRAKE', 'use the cockpit interaction, not a selector readback value');
        if (value === advanceValue) position = Math.min(2, position + 1);
        else if (value === releaseValue) {
          assert.equal(position, 2, 'release must follow a movement into START');
          startReleases += 1;
          position = 1;
        } else assert.fail(`Unexpected APU interaction ${value}`);
        return { ok: true, error: '' };
      };
      assert.equal((await h.run()).transportAcknowledged, true);
      assert.equal(startReleases, 1);
      assert.equal(position, 1);
    }
  });

  test(`${adapter} START fails on any rejected movement or release without retry or SDK fallback`, async () => {
    for (const rejectedStep of [1, 2, 3]) {
      const h = harness(adapter, adapter, start);
      h.bridge.sendEvent = async (name, value) => {
        h.calls.push({ name, value });
        return { ok: h.calls.length !== rejectedStep, error: 'APU interaction rejected.' };
      };
      const result = await h.run();
      assert.equal(result.ok, false);
      assert.equal(result.executionStarted, true);
      assert.equal(result.transportAcknowledged, undefined);
      assert.equal(h.calls.length, rejectedStep);
      assert.equal((await h.run()).code, 'action_cooldown');
      assert.equal(h.calls.length, rejectedStep);
    }
  });

  test(`${adapter} compatibility START retains matching SDK connectivity before and during dispatch`, async () => {
    for (const unavailable of ['disconnected', 'wrong-adapter']) {
      const h = harness(adapter, adapter, start);
      if (unavailable === 'disconnected') h.provider._sdkBridge.isDataConnected = () => false;
      else h.provider._sdkBridge.getSnapshot = () => ({ adapterId: 'different-sdk' });
      assert.equal((await h.run()).code, 'sdk_transport_unavailable');
      assert.equal(h.calls.length, 0);
    }
    for (const disconnectAfter of [1, 3]) {
      const h = harness(adapter, adapter, start);
      h.bridge.sendEvent = async (name, value) => {
        h.calls.push({ name, value });
        if (h.calls.length === disconnectAfter) h.provider._sdkBridge.isDataConnected = () => false;
        return { ok: true, error: '' };
      };
      const result = await h.run();
      assert.equal(result.ok, false);
      assert.equal(result.executionStarted, true);
      assert.equal(h.calls.length, disconnectAfter);
    }
  });

  test(`${adapter} START guards concurrent requests and stops remaining movements after an aircraft change`, async () => {
    const h = harness(adapter, adapter, start);
    let finish;
    h.bridge.sendEvent = async (name, value) => {
      h.calls.push({ name, value });
      return new Promise((resolve) => { finish = resolve; });
    };
    const pending = h.run();
    assert.equal((await h.run()).code, 'action_in_progress');
    h.setActive(false);
    finish({ ok: true });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.executionStarted, true);
    assert.equal(h.calls.length, 1);
  });
}

test('fresh starting/running telemetry suppresses START; stale and missing observations do not', async () => {
  for (const [adapter, id, start] of families) {
    const sample = harness(adapter, id, start);
    for (const condition of sample.action.guard.skipWhen || []) {
      const h = harness(adapter, id, start);
      h.observed[condition.fieldId] = condition.expectedValue;
      assert.equal((await h.run()).code, 'already_satisfied');
      assert.equal(h.calls.length, 0);
      h.setFresh(false);
      assert.equal((await h.run()).transportAcknowledged, true);
    }
  }
});

test('FBW START cannot report already active from an old field inside a current snapshot', async () => {
  const loader = require('./aircraft-profile-loader');
  for (const adapter of ['fbw-a32nx', 'fbw-a380x']) {
    loader.setActiveProfile(adapter);
    const config = loader.getAircraftSpecificConfig();
    for (const fieldId of ['systems.apuAvailable', 'systems.apuStart']) for (const freshness of ['fresh', 'stale', 'missing']) {
      const h = harness(adapter, adapter, 'systems.apuStart.start');
      h.provider._connected = true; h.provider._simRunning = true;
      h.provider._getActiveAircraftIntegrationConfig = () => config;
      h.provider._captureAircraftIntegrationReadback = SimConnectTelemetryProvider.prototype._captureAircraftIntegrationReadback.bind(h.provider);
      const timestamp = new Date().toISOString();
      const key = config.confirmationFields.find((field) => field.id === fieldId).source.key;
      h.bridge.getSnapshot = () => ({ source: 'test', profileId: config.profileKey, status: 'running', snapshotSequence: 1,
        updatedAt: timestamp, values: { [key]: 1 }, valueUpdatedAt: freshness === 'missing' ? {}
          : { [key]: freshness === 'fresh' ? timestamp : new Date(Date.now() - 60000).toISOString() } });
      const result = await h.run();
      assert.equal(result.code, freshness === 'fresh' ? 'already_satisfied' : 'executed',
        `${adapter}/${fieldId}/${freshness}: ${JSON.stringify(result)}`);
      assert.equal(h.calls.length, freshness === 'fresh' ? 0 : 1);
      if (freshness !== 'fresh') assert.equal(result.transportAcknowledged, true, 'missing status does not invent a running APU');
    }
  }
});

test('in-flight START cannot overlap, and changed aircraft cannot receive the remaining recipe', async () => {
  const h = harness('fbw-a32nx', 'fbw-a32nx', 'systems.apuStart.start');
  let finish;
  h.bridge.setNamedVar = async (value) => { h.calls.push(value); return new Promise((resolve) => { finish = resolve; }); };
  const pending = h.run();
  assert.equal((await h.run()).code, 'action_in_progress');
  h.setActive(false);
  finish({ ok: true });
  assert.equal((await pending).code, 'stale_profile');
  assert.equal(h.calls.length, 1);
});

test('SDK acknowledgement still requires SDK connectivity and registry rejects unrelated readback removal', async () => {
  const h = harness('pmdg-777', 'pmdg-777', 'systems.apuSelector.start');
  h.provider._sdkBridge.isDataConnected = () => false;
  assert.equal((await h.run()).code, 'sdk_transport_unavailable');
  assert.equal(h.calls.length, 0);
  const source = defaultAircraftIntegrationRegistry.resolveIntegration('pmdg-777', { profileKey: 'bundled/msfs/pmdg-777' });
  const invalid = structuredClone(source);
  delete invalid.actions['systems.apuSelector.on'].routes[0].readback;
  assert.throws(() => createAircraftIntegrationRegistry([invalid]), /require readback/);
  const mixed = structuredClone(source);
  mixed.actions['systems.apuSelector.start'].routes[0].readback = { fieldId: 'systems.apuRunning', expectedValue: true, timeoutMs: 1 };
  assert.throws(() => createAircraftIntegrationRegistry([mixed]), /acknowledgement contract/);
});

test('Fenix rejected release reports failure after exactly one press and one release attempt', async () => {
  const h = harness('fenix-a32x', 'fenix-a320', 'systems.apuStart.start');
  h.bridge.executeMobiFlightCode = async (code) => {
    h.calls.push(code);
    return { ok: h.calls.length === 1, error: 'Release rejected.' };
  };
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.executionStarted, true);
  assert.equal(h.calls.length, 2);
});

test('a known SimConnect exception overrides initial START acknowledgement for both PMDG families', async () => {
  for (const [adapter, start] of [
    ['pmdg-737', 'systems.apu.start'],
    ['pmdg-777', 'systems.apuSelector.start'],
  ] as const) {
    const h = harness(adapter, adapter, start);
    h.bridge.sendEvent = async (name, value) => { h.calls.push({ name, value }); return { ok: true, sendId: 23, error: '' }; };
    h.bridge['findRecentSimConnectException'] = (ids) => ids.includes(23) ? { exception: 3, sendId: 23 } : null;
    const result = await h.run();
    assert.equal(result.code, 'aircraft_integration_simconnect_exception');
    assert.equal(result.ok, false);
    assert.equal(result.executionStarted, true);
    assert.equal(h.calls.length, 3);
  }
});

export {};
