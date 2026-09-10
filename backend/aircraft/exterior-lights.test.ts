import assert = require('node:assert/strict');
import test = require('node:test');

const loader = require('./aircraft-profile-loader');
const { defaultAircraftIntegrationRegistry: registry } = require('./aircraft-integrations');
const { executeAircraftCommand, resolveAircraftCommand, buildAircraftControlCapabilities } = require('./aircraft-control-service');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const capabilities = { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event'],
  integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] };
const request = (target: string, value: unknown) => ({ commandId: `lights.${target}.set`, input: { value } });
const profiles = [
  'pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900',
  'pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f',
  'fenix-a319', 'fenix-a320', 'fenix-a321', 'fbw-a32nx', 'fbw-a380x', 'headwind-a330',
];

test('individual commands preserve every established takeoff preset recipe', () => {
  const expected = {
    'pmdg-737': ['landingRetractableLeft.on', 'landingRetractableRight.on', 'landingLeft.on', 'landingRight.on',
      'turnoffLeft.on', 'turnoffRight.on', 'taxi.on', 'position.strobeSteady'],
    'pmdg-777': ['landingLeft.on', 'landingNose.on', 'landingRight.on', 'turnoffLeft.on', 'turnoffRight.on', 'taxi.on', 'strobe.on', 'nav.on'],
    'fenix-a320': ['landingLeft.on', 'landingRight.on', 'runwayTurnoff.on', 'nose.takeoff', 'strobe.on', 'navLogo.nav'],
    'fbw-a32nx': ['landingLeft.on', 'landingRight.on', 'runwayTurnoff.on', 'nose.takeoff', 'strobe.on', 'nav.on'],
    'fbw-a380x': ['landing.on', 'taxi.on', 'strobe.on', 'nav.on'],
    'inibuilds-a350-900': ['landing.on', 'nose.takeoff', 'strobe.on', 'nav.nav1'],
  };
  for (const [id, steps] of Object.entries(expected)) {
    const profile = loader.loadProfile(`bundled/msfs/${id}`);
    const result = resolveAircraftCommand({ commandId: 'configuration.lights.takeoff', input: {} }, { profile, capabilities });
    assert.equal(result.ok, true);
    assert.deepEqual(result.controlRequests.map(r => r.actionId), steps.map(id => `lights.${id}`));
  }
});

for (const id of profiles) test(`${id}: individual light groups use complete fixed ON/OFF recipes`, async () => {
  const profile = loader.loadProfile(`bundled/msfs/${id}`);
  const options = { profile, capabilities, profileRevision: 7 };
  const integration = registry.resolveForProfile(profile._profileKey);
  for (const target of ['landing', 'taxi', 'runwayTurnoff']) {
    for (const value of [false, true]) {
      const result = resolveAircraftCommand(request(target, value), options);
      assert.equal(result.ok, true, `${target} ${value}: ${JSON.stringify(result)}`);
      assert.ok(result.controlRequests.length > 0);
      for (const control of result.controlRequests) {
        assert.equal(control.control, 'aircraft-specific');
        const action = registry.resolveAction({ adapterId: integration.id, profileKey: profile._profileKey, actionId: control.actionId });
        assert.ok(action); assert.equal(action.guard.retry, 'never');
        assert.ok(action.routes.some(route => route.readback || route.readbacks));
        if (target === 'landing') assert.match(control.actionId, /landing/i);
        if (target === 'runwayTurnoff') assert.match(control.actionId, /turnoff/i);
        if (target === 'taxi') assert.match(control.actionId, /(?:taxi|nose)/i);
        assert.doesNotMatch(control.actionId, /(?:beacon|strobe|position|nav)/i);
      }
    }
    for (const invalid of ['on', 1, null, '']) assert.equal(resolveAircraftCommand(request(target, invalid), options).ok, false);
    assert.equal(resolveAircraftCommand(request(target, true), { ...options,
      capabilities: { ...capabilities, integrationTransports: [] } }).ok, false);
    assert.equal(resolveAircraftCommand({ ...request(target, true), profileKey: profile._profileKey, profileRevision: 6 },
      { ...options, requireProfileToken: true }).ok, false);
  }
  const sent = [];
  const provider = { aircraftControlCapabilities: capabilities, async executeAircraftControlAction(_action, { request }) {
    sent.push(request.actionId);
    return sent.length === 2 ? { ok: false, code: 'readback_timeout', error: 'Light did not confirm.' } : { ok: true, code: 'executed' };
  } };
  const group = resolveAircraftCommand(request('landing', true), options);
  const result = await executeAircraftCommand(provider, request('landing', true), options);
  assert.equal(sent.length, Math.min(2, group.controlRequests.length));
  assert.equal(result.ok, group.controlRequests.length === 1);
  if (!result.ok) assert.equal(result.completedStepCount, 1);
});

test('PMDG 737 landing commands operate fixed and retractable pairs with the correct SDK detents', async () => {
  loader.setActiveProfile('pmdg-737'); const config = loader.getLvarConfig().aircraftSpecific;
  const profile = loader.loadProfile('bundled/msfs/pmdg-737');
  const provider = new SimConnectTelemetryProvider();
  provider._getActiveAircraftIntegrationConfig = () => config;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ sdk: true });
  const snapshot = { adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 1,
    updatedAt: new Date().toISOString(), normalized: { lights: {
      landing: { retractableLeft: 'retract', retractableRight: 'retract', left: false, right: false },
      turnoff: { left: false, right: false }, taxi: false,
    } } };
  provider._sdkBridge = { getSnapshot: () => snapshot, isDataConnected: () => true };
  const paths = { '#69743': ['landing', 'retractableLeft'], '#69744': ['landing', 'retractableRight'],
    '#69745': ['landing', 'left'], '#69746': ['landing', 'right'], '#69747': ['turnoff', 'left'],
    '#69748': ['turnoff', 'right'], '#69749': ['taxi'] };
  const writes = [];
  const bridge = { sendSdkEvent: async (event, value) => {
    assert.ok(paths[event], event); writes.push([event, value]);
    const path = paths[event];
    if (path.length === 1) snapshot.normalized.lights.taxi = Boolean(value);
    else snapshot.normalized.lights[path[0]][path[1]] = path[1].startsWith('retractable') ? ['retract', 'extend', 'on'][value] : Boolean(value);
    snapshot.snapshotSequence++; return { ok: true };
  } };
  const runner = { aircraftControlCapabilities: capabilities, executeAircraftControlAction: (_action, options) =>
    provider._executeAircraftIntegrationAction(bridge, { name: 'pmdg-737' }, 'test', options) };
  const options = { profile, capabilities, profileRevision: config.profileRevision };
  const landingOn = await executeAircraftCommand(runner, request('landing', true), options);
  assert.equal(landingOn.ok, true, JSON.stringify(landingOn));
  assert.deepEqual(writes, [['#69743', 2], ['#69745', 1], ['#69744', 2], ['#69746', 1]]);
  assert.deepEqual(snapshot.normalized.lights.turnoff, { left: false, right: false });
  assert.equal(snapshot.normalized.lights.taxi, false);
  // Advance the existing per-switch cooldown without changing control semantics.
  provider._aircraftIntegrationActionLastAttemptAt.clear(); writes.length = 0;
  assert.equal((await executeAircraftCommand(runner, request('landing', false), options)).ok, true);
  assert.deepEqual(writes, [['#69743', 1], ['#69745', 0], ['#69744', 1], ['#69746', 0]]);
  writes.length = 0;
  assert.equal((await executeAircraftCommand(runner, request('runwayTurnoff', true), options)).ok, true);
  assert.deepEqual(writes, [['#69747', 1], ['#69748', 1]]);
  assert.equal(snapshot.normalized.lights.taxi, false);
});

for (const id of ['fbw-a380x', 'headwind-a330']) test(`${id}: indexed taxi and turnoff lights stay independent through the real provider`, async () => {
  loader.setActiveProfile(id); const profileKey = `bundled/msfs/${id}`;
  const config = loader.getLvarConfig().aircraftSpecific, integration = registry.resolveForProfile(profileKey);
  const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
  provider._getActiveAircraftIntegrationConfig = () => config;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true });
  const state = { 'TAXI:1': 0, 'TAXI:2': 1, 'TAXI:3': 0, 'LANDING:1': 1, 'LANDING:2': 1, 'LANDING:3': 1 };
  const snapshot: any = { profileId: profileKey, status: 'running', snapshotSequence: 1,
    updatedAt: new Date().toISOString(), values: {}, valueUpdatedAt: {} };
  const refresh = () => {
    for (const field of config.confirmationFields.filter(field => field.id.startsWith('lights.individual.'))) {
      const name = integration.fields[field.id].sources[0].route.name.replace('A:LIGHT ', '');
      snapshot.values[field.source.key] = state[name]; snapshot.valueUpdatedAt[field.source.key] = new Date().toISOString();
    }
    snapshot.updatedAt = new Date().toISOString(); snapshot.snapshotSequence++;
  };
  refresh(); const writes = [];
  const bridge = { getSnapshot: () => snapshot, setNamedVar: async () => { throw Error('Unexpected LVAR write'); },
    sendEvent: async (name, value, parameters) => {
      writes.push([name, value, parameters]);
      assert.equal(parameters.length, 1); assert.ok(parameters[0] > 0, 'must never target all indices');
      state[`${name.split('_')[0]}:${parameters[0]}`] = value;
      await new Promise(resolve => setTimeout(resolve, 2)); refresh(); return { ok: true };
    } };
  const run = light => provider._executeAircraftIntegrationAction(bridge, { name: id }, 'test', {
    profileKey, profileRevision: config.profileRevision, request: { actionId: `lights.individual.${light}.on` } });
  assert.equal((await run('taxi')).ok, true);
  assert.deepEqual(writes, [['TAXI_LIGHTS_SET', 1, [1]]]);
  assert.equal(state['TAXI:2'], 1); assert.equal(state['TAXI:3'], 0); assert.equal(state['LANDING:1'], 1);
  assert.equal((await run('runwayTurnoff')).ok, true);
  assert.deepEqual(writes.slice(1), [['TAXI_LIGHTS_SET', 1, [2]], ['TAXI_LIGHTS_SET', 1, [3]]]);
  assert.equal(state['TAXI:1'], 1); assert.equal(state['LANDING:2'], 1);
});

test('individual lights and the full takeoff preset cannot interleave', async () => {
  const profile = loader.loadProfile('bundled/msfs/pmdg-737'); let release;
  const writes = [];
  const provider = { aircraftControlCapabilities: capabilities, async executeAircraftControlAction(_action, { request }) {
    writes.push(request.actionId);
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, code: 'executed' };
  } };
  const pending = executeAircraftCommand(provider, request('landing', true), { profile });
  await new Promise(resolve => setImmediate(resolve));
  for (const command of [request('taxi', false), request('landingRight', false), { commandId: 'configuration.lights.takeoff', input: {} }]) {
    assert.equal((await executeAircraftCommand(provider, command, { profile })).code, 'action_in_flight');
  }
  assert.equal(writes.length, 1); release(); assert.equal((await pending).ok, true);
  assert.equal((await executeAircraftCommand(provider, request('taxi', true), { profile })).ok, true);
});
