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

for (const id of ['fbw-a32nx', 'fbw-a380x', 'headwind-a330', 'fenix-a320']) {
  test(`${id}: real loader and provider dispatch and confirm every dimmer`, async () => {
    loader.setActiveProfile(id);
    const profileKey = `bundled/msfs/${id}`;
    const integration = registry.resolveForProfile(profileKey);
    const config = loader.getLvarConfig().aircraftSpecific;
    const groups = cockpitLightingGroups(integration.id);
    let active = true;
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
    };
    for (const fieldId of fields) update(integration.fields[fieldId].sources[0].route.name, 0);
    const writes: any[] = [];
    const bridge = { getSnapshot: () => snapshot,
      sendEvent: async (name, index, parameters) => {
        assert.equal(name, 'LIGHT_POTENTIOMETER_SET');
        assert.deepEqual(parameters, [70], 'brightness belongs in the second parameter');
        writes.push({ name, index, parameters }); await new Promise(resolve => setTimeout(resolve, 2));
        update(`A:LIGHT POTENTIOMETER:${index}`, parameters[0]); return { ok: true };
      },
      setNamedVar: async ({ name, value }) => {
        assert.ok(Math.abs(value - 0.7) < 1e-12, 'Fenix scales percentage to its 0..1 knob range');
        writes.push({ name, value }); await new Promise(resolve => setTimeout(resolve, 2));
        update(name, value); return { ok: true };
      },
    };
    const run = actionId => provider._executeAircraftIntegrationAction(bridge, { name: integration.id }, 'test', {
      profileKey, profileRevision: config.profileRevision, request: { actionId, value: 70 } });
    for (const group of groups) {
      const result = await run(group.actionId); assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.equal(writes.length, fields.length);
    assert.equal((await run(groups[0].actionId)).noOp, true, 'repeated settings do not rewrite correct knobs');
    assert.equal(writes.length, fields.length);
    const stale = config.confirmationFields.find(field => field.id === fields[0]);
    snapshot.valueUpdatedAt[stale.source.key] = new Date(Date.now() - 10000).toISOString();
    assert.equal((await run(groups[0].actionId)).ok, false, 'a fresh snapshot cannot hide a stale knob');
    active = false;
    assert.equal((await run(groups[1].actionId)).ok, false);
    assert.equal(writes.length, fields.length);
  });
}

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

test('PMDG 777 can set displays immediately after global lighting through the real SDK provider', async () => {
  loader.setActiveProfile('pmdg-777');
  const profileKey = 'bundled/msfs/pmdg-777';
  const config = loader.getLvarConfig().aircraftSpecific;
  const integration = registry.resolveForProfile(profileKey);
  const groups = cockpitLightingGroups(integration.id);
  const provider = new SimConnectTelemetryProvider();
  provider._getActiveAircraftIntegrationConfig = () => config;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ sdk: true });
  const snapshot = { adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 1,
    updatedAt: new Date().toISOString(), normalized: { lighting: {} } };
  for (const group of groups) snapshot.normalized.lighting[group.fields[0].split('.')[1]] = 10;
  provider._sdkBridge = { getSnapshot: () => snapshot, isDataConnected: () => true };
  const sent: any[] = [];
  const bridge = { sendSdkEvent: async (command, value) => {
    const group = groups.find(group => integration.actions[group.actionId].routes[0].command === command);
    assert.ok(group); sent.push({ command, value });
    snapshot.normalized.lighting[group.fields[0].split('.')[1]] = value;
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
