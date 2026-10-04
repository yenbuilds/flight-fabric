import assert = require('node:assert/strict');
import test = require('node:test');
import { cockpitLightingGroups } from './aircraft-integrations/cockpit-lighting';
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');

const loader = require('./aircraft-profile-loader');
const { defaultAircraftIntegrationRegistry: registry, createAircraftIntegrationRegistry } = require('./aircraft-integrations');
const { buildAircraftControlCapabilities, executeAircraftCommand, resolveAircraftCommand } = require('./aircraft-control-service');
const capabilities = { simulator: 'msfs', actionTypes: ['aircraft-integration'],
  integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] };
const request = (target: string, value: unknown = 70) => ({ commandId: `configuration.lighting.${target}`, input: { value } });

const coverage = [
  ...['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900'].map(id => [id, 16, 8]),
  ...['pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f'].map(id => [id, 17, 6]),
  ...['fenix-a319', 'fenix-a320', 'fenix-a321'].map(id => [id, 16, 8]),
  ['fbw-a32nx', 16, 8], ['fbw-a380x', 18, 10], ['headwind-a330', 14, 8],
  ['inibuilds-a350-900', 15, 4], ['inibuilds-a350-1000', 15, 4],
] as const;

for (const [id, allCount, displayCount] of coverage) {
  test(`${id}: global then displays preserves panel and flood brightness`, async () => {
    const profile = loader.loadProfile(`bundled/msfs/${id}`);
    const options = { profile, capabilities, profileRevision: 9 };
    const integration = registry.resolveForProfile(profile._profileKey);
    const groups = cockpitLightingGroups(integration.id);
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    const all = catalogue.commands.find(c => c.id === request('cockpit').commandId).brightnessFields;
    const displays = catalogue.commands.find(c => c.id === request('displays').commandId).brightnessFields;
    assert.equal(all.length, allCount); assert.equal(new Set(all).size, allCount);
    assert.equal(displays.length, displayCount); assert.ok(displays.every(field => all.includes(field)));
    const state = Object.fromEntries(all.map(field => [field, 25]));
    const writes: string[] = [];
    const provider = { aircraftControlCapabilities: capabilities,
      async executeAircraftControlAction(_action, { request: control }) {
        writes.push(control.actionId);
        const group = groups.find(group => group.actionId === control.actionId);
        assert.ok(group);
        const action = integration.actions[group.actionId];
        const readbacks = action.routes[0].readbacks || [action.routes[0].readback];
        assert.deepEqual(readbacks.map(r => r.fieldId), group.fields);
        assert.ok(readbacks.every(r => r.expectedInput === true));
        for (const field of group.fields) state[field] = control.value;
        return { ok: true, code: 'executed' };
      } };
    assert.equal((await executeAircraftCommand(provider, request('cockpit', 50), options)).ok, true);
    assert.ok(Object.values(state).every(value => value === 50)); writes.length = 0;
    assert.equal((await executeAircraftCommand(provider, request('displays', 80), options)).ok, true);
    assert.deepEqual(writes, groups.filter(group => group.displays).map(group => group.actionId));
    for (const field of all) assert.equal(state[field], displays.includes(field) ? 80 : 50, field);
    for (const value of [-1, 101, 50.5, NaN, '', null]) {
      assert.equal(resolveAircraftCommand(request('displays', value), options).ok, false, String(value));
    }
    assert.equal(resolveAircraftCommand(request('displays'), { ...options,
      capabilities: { ...capabilities, integrationTransports: [] } }).ok, false);
    assert.equal(resolveAircraftCommand({ ...request('displays'), profileKey: profile._profileKey, profileRevision: 8 },
      { ...options, requireProfileToken: true }).ok, false);
    assert.equal(registry.resolveForProfile(`local/msfs/${id}`), null);
  });
}

for (const id of ['fbw-a32nx', 'fbw-a380x', 'headwind-a330', 'fenix-a320', 'inibuilds-a350-900', 'inibuilds-a350-1000']) {
  test(`${id}: real loader and provider dispatch and confirm every dimmer`, async () => {
    loader.setActiveProfile(id);
    const profileKey = `bundled/msfs/${id}`;
    const integration = registry.resolveForProfile(profileKey);
    const config = loader.getLvarConfig().aircraftSpecific;
    const groups = cockpitLightingGroups(integration.id);
    let active = true;
    let invalidateAfterWrite = false;
    const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
    provider._getActiveAircraftIntegrationConfig = () => active ? config : null;
    provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true });
    const snapshot: any = { profileId: profileKey, status: 'running', values: {}, valueUpdatedAt: {},
      snapshotSequence: 1, updatedAt: new Date().toISOString() };
    const fields = groups.flatMap(group => group.fields);
    const update = (name, value) => {
      const fieldId = fields.find(field => integration.fields[field].sources[0].route.name === name);
      assert.ok(fieldId, `unexpected write ${name}`);
      const field = config.confirmationFields.find(field => field.id === fieldId);
      assert.ok(field, `${fieldId} needs an actual sidecar subscription`);
      snapshot.values[field.source.key] = value;
      snapshot.valueUpdatedAt[field.source.key] = new Date().toISOString();
      snapshot.updatedAt = new Date().toISOString(); snapshot.snapshotSequence++;
      if (invalidateAfterWrite) active = false;
    };
    for (const fieldId of fields) update(integration.fields[fieldId].sources[0].route.name, 0);
    const writes: any[] = [];
    let target = 70;
    const bridge = { getSnapshot: () => snapshot,
      sendEvent: async (name, index, parameters) => {
        assert.equal(name, 'LIGHT_POTENTIOMETER_SET');
        assert.deepEqual(parameters, [target], 'brightness belongs in the second parameter');
        writes.push({ name, index, parameters }); await new Promise(resolve => setTimeout(resolve, 2));
        update(`A:LIGHT POTENTIOMETER:${index}`, parameters[0]); return { ok: true };
      },
      setNamedVar: async ({ name, value }) => {
        const expected = id === 'fenix-a320' ? target / 100 : target;
        assert.ok(Math.abs(value - expected) < 1e-12, 'Use the aircraft-specific dimmer bounds');
        writes.push({ name, value }); await new Promise(resolve => setTimeout(resolve, 2));
        update(name, value); return { ok: true };
      },
    };
    const run = actionId => provider._executeAircraftIntegrationAction(bridge, { name: integration.id }, 'test', {
      profileKey, profileRevision: config.profileRevision, request: { actionId, value: target } });
    let expectedWrites = 0;
    for (target of [70, 0, 100]) {
      for (const group of groups) {
        const result = await run(group.actionId); assert.equal(result.ok, true, JSON.stringify(result));
      }
      expectedWrites += fields.length;
      assert.equal(writes.length, expectedWrites);
      assert.equal((await run(groups[0].actionId)).noOp, true, 'repeated settings do not rewrite correct knobs');
      assert.equal(writes.length, expectedWrites);
    }
    const stale = config.confirmationFields.find(field => field.id === fields[0]);
    snapshot.valueUpdatedAt[stale.source.key] = new Date(Date.now() - 10000).toISOString();
    assert.equal((await run(groups[0].actionId)).ok, false, 'a fresh snapshot cannot hide a stale knob');
    assert.equal(writes.length, expectedWrites);
    update(integration.fields[fields[0]].sources[0].route.name, id === 'fenix-a320' ? 1 : 100);
    target = 70; invalidateAfterWrite = true;
    const changedProfile = await run(groups[0].actionId);
    assert.equal(changedProfile.ok, false);
    assert.equal(changedProfile.executionStarted, true, 'the first dimmer was dispatched before the profile changed');
    assert.match(changedProfile.error, /profile changed/);
    assert.equal(writes.length, ++expectedWrites, 'a profile change stops the remaining dimmers within the group');
    assert.equal((await run(groups[1].actionId)).ok, false);
    assert.equal(writes.length, expectedWrites);
  });
}

test('A350 brightness uses explicit source dimmers, excluding contrast, power and tablets', () => {
  const integration = registry.resolveForProfile('bundled/msfs/inibuilds-a350-900');
  const groups = cockpitLightingGroups(integration.id);
  const routes = groups.flatMap(group => integration.actions[group.actionId].routes);
  const names = routes.flatMap(route => route.operations.map(operation => operation.name));
  assert.deepEqual(names, [
    'L:INI_CKPT_LT_INTEG', 'L:INI_FCU_DISPLAY_BRT', 'L:INI_FCU_INTEG_BRT',
    'L:INI_CKPT_LT_FLOOD', 'L:INI_CKPT_LT_DOME',
    'L:INI_MIP_MAP_BRT_LEFT', 'L:INI_SLIDING_TABLE_BRT_LEFT', 'L:INI_MIP_CONSOLE_BRT_LEFT',
    'L:INI_MIP_MAP_BRT_RIGHT', 'L:INI_SLIDING_TABLE_BRT_RIGHT', 'L:INI_MIP_CONSOLE_BRT_RIGHT',
    'L:INI_POTENTIOMETER_35', 'L:INI_POTENTIOMETER_37', 'L:INI_POTENTIOMETER_39', 'L:INI_POTENTIOMETER_41',
  ]);
  for (const route of routes) {
    assert.ok(route.operations.every(operation => operation.type === 'lvar'
      && operation.unit === 'Number' && operation.inputValue.source === 'input' && operation.inputValue.scale === undefined));
  }
});

test('A350 presets report a no-op only when every lighting group was already set', async () => {
  const profile = loader.loadProfile('bundled/msfs/inibuilds-a350-900');
  const groups = cockpitLightingGroups('inibuilds-a350');
  const state = Object.fromEntries(groups.flatMap(group => group.fields.map(field => [field, group.displays ? 100 : 0])));
  const writes: string[] = [];
  const provider = { aircraftControlCapabilities: capabilities,
    async executeAircraftControlAction(_action, { request: control }) {
      const group = groups.find(group => group.actionId === control.actionId);
      if (group.fields.every(field => state[field] === control.value)) return { ok: true, code: 'executed', noOp: true, idempotent: true };
      writes.push(group.actionId);
      for (const field of group.fields) state[field] = control.value;
      return { ok: true, code: 'executed' };
    } };
  const options = { profile, capabilities };
  const mixed = await executeAircraftCommand(provider, request('cockpit', 100), options);
  assert.equal(mixed.ok, true);
  assert.equal(writes.length, 4, 'panel, flood and task lights changed while displays were already at 100%');
  assert.notEqual(mixed.noOp, true, 'the last display group cannot mark the whole preset as skipped');
  assert.notEqual(mixed.idempotent, true, 'last-step no-op metadata cannot describe a mixed execution');
  const repeated = await executeAircraftCommand(provider, request('cockpit', 100), options);
  assert.equal(repeated.noOp, true); assert.equal(repeated.idempotent, true);
  assert.equal(writes.length, 4);
  const displays = await executeAircraftCommand(provider, request('displays', 100), options);
  assert.equal(displays.noOp, true, 'single-group display presets retain their no-op result');
});

for (const scenario of ['no-op then disconnect', 'no-op then rejection', 'no-op then failed write', 'write then disconnect']) {
  test(`A350 preset dispatch reporting: ${scenario}`, async () => {
    const profile = loader.loadProfile('bundled/msfs/inibuilds-a350-900');
    const calls: string[] = [];
    let connected = true;
    const provider = { aircraftControlCapabilities: capabilities,
      async executeAircraftControlAction(_action, { request: control }) {
        calls.push(control.actionId);
        if (calls.length > 1) return { ok: false, code: 'test_failure', error: 'Control failed.',
          ...(scenario === 'no-op then failed write' ? { executionStarted: true } : {}) };
        if (scenario.endsWith('disconnect')) connected = false;
        return { ok: true, code: 'executed',
          ...(scenario.startsWith('no-op') ? { noOp: true, idempotent: true } : {}) };
      } };
    const options = { profile, capabilities, canExecute: () => connected };
    const result = await executeAircraftCommand(provider, request('cockpit'), options);
    assert.equal(result.ok, false);
    assert.equal(result.completedStepCount, 1, 'already-correct state still completes its step');
    assert.equal(result.failedStepIndex, 1);
    assert.equal(calls.length, scenario.endsWith('disconnect') ? 1 : 2, 'no dispatch after cancellation or failure');
    assert.equal(result.executionStarted, scenario === 'write then disconnect' || scenario === 'no-op then failed write'
      ? true : undefined, 'completed no-ops cannot imply a native write');
    connected = true; calls.length = 0;
    assert.equal((await executeAircraftCommand(provider, request('displays'), options)).ok, true,
      'a cancelled or rejected global preset releases the shared lighting lock');
  });
}

test('A350 preset stops on one unconfirmed dimmer without retries or later-group writes', async () => {
  const profileKey = 'bundled/msfs/inibuilds-a350-900';
  loader.setActiveProfile(profileKey);
  const profile = loader.loadProfile(profileKey);
  const config = loader.getLvarConfig().aircraftSpecific;
  const integration = registry.resolveForProfile(profileKey);
  const groups = cockpitLightingGroups(integration.id);
  const fields = groups.flatMap(group => group.fields);
  const snapshot: any = { profileId: profileKey, status: 'running', values: {}, valueUpdatedAt: {},
    snapshotSequence: 1, updatedAt: new Date().toISOString() };
  const byName = new Map(fields.map(id => [integration.fields[id].sources[0].route.name,
    config.confirmationFields.find(field => field.id === id)]));
  const refresh = () => {
    const now = new Date().toISOString();
    for (const field of byName.values()) snapshot.valueUpdatedAt[field.source.key] = now;
    snapshot.updatedAt = now; snapshot.snapshotSequence++;
  };
  for (const field of byName.values()) snapshot.values[field.source.key] = 0;
  refresh();
  const writes: string[] = [];
  let failedField = 'lighting.captainTablePercent';
  const bridge = { getSnapshot: () => snapshot, sendEvent: async () => assert.fail('Unexpected event'),
    setNamedVar: async ({ name, value }) => {
      writes.push(name);
      const field = byName.get(name); assert.ok(field);
      await new Promise(resolve => setTimeout(resolve, 2));
      if (field.id !== failedField) snapshot.values[field.source.key] = value;
      refresh(); return { ok: true };
    } };
  const realProvider = new SimConnectTelemetryProvider();
  realProvider._connected = true; realProvider._simRunning = true;
  realProvider._getActiveAircraftIntegrationConfig = () => config;
  realProvider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true });
  const provider = { aircraftControlCapabilities: capabilities,
    executeAircraftControlAction: (action, options) => realProvider._executeAircraftIntegrationAction(bridge, action, 'test', options) };
  const options = { profile, capabilities, profileRevision: config.profileRevision };
  const result = await executeAircraftCommand(provider, request('cockpit'), options);
  assert.equal(result.ok, false); assert.equal(result.code, 'aircraft_integration_readback_timeout');
  assert.equal(result.completedStepCount, 2); assert.equal(result.failedStepIndex, 2);
  assert.equal(result.executionStarted, true); assert.match(result.error, /captainTablePercent/);
  assert.deepEqual(writes, groups.slice(0, 3).flatMap(group => group.fields.map(id => integration.fields[id].sources[0].route.name)),
    'each attempted dimmer is written once; no retries, rollback or subsequent groups');
  failedField = ''; refresh();
  assert.equal((await executeAircraftCommand(provider, request('cockpit'), options)).ok, true,
    'both command and provider group locks release after failed confirmation');
});

test('one lighting preset lock covers the whole recipe and releases after failure', async () => {
  const profile = loader.loadProfile('bundled/msfs/fbw-a32nx');
  const options = { profile, capabilities };
  let release; const writes: string[] = [];
  const provider = { aircraftControlCapabilities: capabilities,
    async executeAircraftControlAction(_action, { request: control }) {
      writes.push(control.actionId);
      if (writes.length === 1) await new Promise(resolve => { release = resolve; });
      return writes.length === 2 ? { ok: false, code: 'readback_timeout', error: 'A knob did not confirm.' }
        : { ok: true, code: 'executed' };
    } };
  const pending = executeAircraftCommand(provider, request('cockpit'), options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await executeAircraftCommand(provider, request('displays'), options)).code, 'action_in_flight');
  assert.equal(writes.length, 1); release();
  const failure = await pending;
  assert.equal(failure.ok, false); assert.equal(failure.completedStepCount, 1);
  assert.equal(writes.length, 2, 'no later groups after a failed readback');
  assert.equal((await executeAircraftCommand(provider, request('displays'), options)).ok, true);
});

test('PMDG 777 writes cockpit LVARs with SDK confirmation and can immediately set displays', async () => {
  loader.setActiveProfile('pmdg-777');
  const profileKey = 'bundled/msfs/pmdg-777';
  const config = loader.getLvarConfig().aircraftSpecific;
  const integration = registry.resolveForProfile(profileKey);
  const groups = cockpitLightingGroups(integration.id);
  const provider = new SimConnectTelemetryProvider();
  provider._getActiveAircraftIntegrationConfig = () => config;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ sdk: true, 'simconnect-sequence': true });
  const snapshot = { adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 1,
    updatedAt: new Date().toISOString(), normalized: { lighting: {} } };
  for (const group of groups) snapshot.normalized.lighting[group.fields[0].split('.')[1]] = 10;
  provider._sdkBridge = { getSnapshot: () => snapshot, isDataConnected: () => true };
  // Independent cockpit-behavior mapping. SDK event ACKs alone did not move
  // the live dome knob, so the old event-only route must fail this regression.
  const knobFields = {
    OH_DOME_SWITCH: 'domePercent', OH_CB_LIGHT_CONTROL: 'circuitBreakerPercent',
    OH_PANEL_LIGHT_CONTROL: 'overheadPanelPercent', OH_GS_PANEL_LIGHT_CONTROL: 'glareshieldPanelPercent',
    OH_GS_FLOOD_LIGHT_CONTROL: 'glareshieldFloodPercent', LEFT_PANEL_LIGHT_CONTROL: 'leftPanelPercent',
    LEFT_FLOOD_LIGHT_CONTROL: 'leftFloodPercent', RIGHT_PANEL_LIGHT_CONTROL: 'rightPanelPercent',
    RIGHT_FLOOD_LIGHT_CONTROL: 'rightFloodPercent', PED_PANEL_LIGHT_CONTROL: 'aislePanelPercent',
    PED_FLOOD_LIGHT_CONTROL: 'aisleFloodPercent', LEFT_OUTBD_BRIGHT_CONTROL: 'leftOutboardDisplayPercent',
    LEFT_INBD_BRIGHT_CONTROL: 'leftInboardDisplayPercent', RIGHT_INBD_BRIGHT_CONTROL: 'rightInboardDisplayPercent',
    RIGHT_OUTBD_BRIGHT_CONTROL: 'rightOutboardDisplayPercent', PED_UPPER_BRIGHT_CONTROL: 'upperDisplayPercent',
    PED_LOWER_BRIGHT_CONTROL: 'lowerDisplayPercent',
  };
  const sent: any[] = [];
  const bridge = { sendEvent: async () => assert.fail('Brightness must use the cockpit knob variables'),
    sendSdkEvent: async () => assert.fail('SDK data percentages do not establish a writable event payload'),
    setNamedVar: async ({ name, unit, value }) => {
      const field = knobFields[name.replace(/^L:/, '')];
      assert.ok(field, name); assert.equal(unit, 'Number'); sent.push({ name, value });
      snapshot.normalized.lighting[field] = value;
      snapshot.snapshotSequence++; snapshot.updatedAt = new Date().toISOString(); return { ok: true };
    } };
  for (const [selected, value] of [[groups, 50], [groups.filter(group => group.displays), 80]] as const) {
    for (const group of selected) {
      const result = await provider._executeAircraftIntegrationAction(bridge, { name: integration.id }, 'test', {
        profileKey, profileRevision: config.profileRevision, request: { actionId: group.actionId, value } });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
  }
  assert.equal(sent.length, 23);
  for (const group of groups) assert.equal(snapshot.normalized.lighting[group.fields[0].split('.')[1]], group.displays ? 80 : 50);
  const repeated = await provider._executeAircraftIntegrationAction(bridge, { name: integration.id }, 'test', {
    profileKey, profileRevision: config.profileRevision, request: { actionId: 'lighting.dome.set', value: 50 } });
  assert.equal(repeated.ok, true); assert.equal(repeated.noOp, true); assert.equal(sent.length, 23);
  provider._sdkBridge.isDataConnected = () => false;
  const disconnected = await provider._executeAircraftIntegrationAction(bridge, { name: integration.id }, 'test', {
    profileKey, profileRevision: config.profileRevision, request: { actionId: 'lighting.dome.set', value: 60 } });
  assert.equal(disconnected.ok, false); assert.equal(disconnected.code, 'sdk_transport_unavailable');
  assert.equal(sent.length, 23, 'A writable LVAR bridge cannot bypass SDK connectivity');
});

test('event parameters accept only trusted numeric input transformations', () => {
  const source = registry.resolveForProfile('bundled/msfs/fbw-a32nx');
  for (const parameter of [{ source: 'client' }, { source: 'input', name: 'OTHER_EVENT' },
    { source: 'input', scale: Infinity }, { source: 'input', encoding: 'squawk-bco16' }, '70']) {
    const altered = structuredClone(source);
    altered.actions['lighting.preset.panels.set'].routes[0].operations[0].parameters = [parameter];
    assert.throws(() => createAircraftIntegrationRegistry([altered]));
  }
  const altered = structuredClone(source); delete altered.actions['lighting.preset.panels.set'].input;
  assert.throws(() => createAircraftIntegrationRegistry([altered]));
  const provider = Object.create(SimConnectTelemetryProvider.prototype);
  const action = source.actions['lighting.preset.panels.set'];
  const route = { ...action.routes[0], operations: [{ type: 'event', name: 'LIGHT_POTENTIOMETER_SET', value: 88, parameters: [20] }] };
  assert.deepEqual(provider._resolveAircraftIntegrationSimConnectOperations(route, action, 70).operations[0].parameters, [20]);
  route.operations[0].parameters = [{ source: 'input', scale: 1e15 }] as any;
  assert.equal(provider._resolveAircraftIntegrationSimConnectOperations(route, action, 70).ok, false);
});
