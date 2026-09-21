import assert = require('node:assert/strict');
import test = require('node:test');

const loader = require('./aircraft-profile-loader');
const { defaultAircraftIntegrationRegistry: registry } = require('./aircraft-integrations');
const { executeAircraftCommand, resolveAircraftCommand } = require('./aircraft-control-service');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const capabilities = { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event'],
  integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] };
const request = (target: string, value: unknown) => ({ commandId: `lights.${target}.set`, input: { value } });
const profiles = [
  'pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900',
  'pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f',
  'fenix-a319', 'fenix-a320', 'fenix-a321', 'fbw-a32nx', 'fbw-a380x', 'headwind-a330',
];

for (const id of ['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900']) {
  test(`${id}: strobe voice targets preserve the combined position switch and require confirmation`, async () => {
    for (const transport of ['sdk', 'simconnect-sequence']) {
      for (const initial of ['off', 'steady', 'strobe-steady']) {
        for (const value of [false, true]) {
          loader.setActiveProfile(id);
          const config = loader.getLvarConfig().aircraftSpecific;
          const profile = loader.loadProfile(`bundled/msfs/${id}`);
          const provider = new SimConnectTelemetryProvider();
          provider._getActiveAircraftIntegrationConfig = () => config;
          provider._getAircraftIntegrationTransportCapabilities = () => ({ [transport]: true });
          const snapshot = { adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 1,
            updatedAt: new Date().toISOString(), normalized: { lights: { position: initial } } };
          provider._sdkBridge = { getSnapshot: () => snapshot, isDataConnected: () => true };
          const positions = ['steady', 'off', 'strobe-steady'];
          const writes = [];
          const bridge = {
            setNamedVar: async () => { throw new Error('Strobes must use the position switch'); },
            sendSdkEvent: async (event, rawValue) => {
              assert.equal(event, '#69755');
              writes.push([event, rawValue]);
              snapshot.normalized.lights.position = positions[rawValue];
              snapshot.snapshotSequence++;
              return { ok: true };
            },
            sendEvent: async (event, rawValue) => {
              assert.equal(event, 'ROTOR_BRAKE');
              assert.ok([12301, 12302].includes(rawValue));
              writes.push([event, rawValue]);
              const position = positions.indexOf(snapshot.normalized.lights.position);
              setTimeout(() => {
                snapshot.normalized.lights.position = positions[Math.max(0, Math.min(2, position + (rawValue === 12301 ? -1 : 1)))];
                snapshot.snapshotSequence++;
              }, 20);
              return { ok: true };
            },
          };
          const runner = { aircraftControlCapabilities: capabilities, executeAircraftControlAction: (_action, options) =>
            provider._executeAircraftIntegrationAction(bridge, { name: 'pmdg-737' }, 'test', options) };
          const result = await executeAircraftCommand(runner, request('strobe', value),
            { profile, capabilities, profileRevision: config.profileRevision });
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(snapshot.normalized.lights.position, value ? 'strobe-steady' : initial === 'off' ? 'off' : 'steady');
          if ((!value && initial !== 'strobe-steady') || (value && initial === 'strobe-steady')) {
            assert.equal(writes.length, 0, 'a satisfied strobe request must not move the position switch');
          } else assert.ok(writes.length > 0);
        }
      }
    }
  });
}

test('Headwind strobe mode uses the documented reset and confirms mode plus lamp output', async () => {
  loader.setActiveProfile('headwind-a330');
  const profileKey = 'bundled/msfs/headwind-a330';
  const config = loader.getLvarConfig().aircraftSpecific;
  const integration = registry.resolveForProfile(profileKey);
  for (const initial of ['off', 'auto', 'on']) for (const mode of ['off', 'auto', 'on']) {
    const provider = new SimConnectTelemetryProvider();
    provider._connected = true; provider._simRunning = true;
    provider._getActiveAircraftIntegrationConfig = () => config;
    provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true });
    const values = { 'L:LIGHTING_STROBE_0': initial === 'on' ? 0 : initial === 'auto' ? 1 : 2,
      'L:STROBE_0_AUTO': initial === 'auto' ? 1 : 0, 'A:LIGHT STROBE': initial === 'on' ? 1 : 0 };
    const snapshot: any = { profileId: profileKey, status: 'running', snapshotSequence: 1,
      updatedAt: new Date().toISOString(), values: {}, valueUpdatedAt: {} };
    const refresh = () => {
      for (const field of config.confirmationFields.filter(field => field.id.startsWith('lights.strobe'))) {
        snapshot.values[field.source.key] = values[integration.fields[field.id].sources[0].route.name];
        snapshot.valueUpdatedAt[field.source.key] = new Date().toISOString();
      }
      snapshot.updatedAt = new Date().toISOString(); snapshot.snapshotSequence++;
    };
    refresh();
    const writes = [];
    const bridge = { getSnapshot: () => snapshot,
      setNamedVar: async ({ name, value }) => {
        assert.equal(name, 'L:STROBE_0_AUTO', 'never write the selector animation');
        values[name] = value; writes.push([name, value]); return { ok: true };
      },
      sendEvent: async (name) => {
        assert.ok(['STROBES_OFF', 'STROBES_ON'].includes(name));
        writes.push([name]);
        values['L:LIGHTING_STROBE_0'] = name === 'STROBES_OFF' ? 2 : values['L:STROBE_0_AUTO'] ? 1 : 0;
        values['A:LIGHT STROBE'] = name === 'STROBES_ON' && !values['L:STROBE_0_AUTO'] ? 1 : 0;
        await new Promise(resolve => setTimeout(resolve, 2)); refresh(); return { ok: true };
      },
    };
    const result = await provider._executeAircraftIntegrationAction(bridge, { name: 'headwind-a330' }, 'test', {
      profileKey, profileRevision: config.profileRevision, request: { actionId: `lights.strobe.${mode}` },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(values['L:LIGHTING_STROBE_0'], mode === 'on' ? 0 : mode === 'auto' ? 1 : 2);
    assert.equal(values['A:LIGHT STROBE'], mode === 'on' ? 1 : 0, 'AUTO may leave lamps off on the ground');
    if (initial === mode) assert.equal(writes.length, 0);
    else assert.deepEqual(writes.filter(([name]) => name.startsWith('STROBES_')),
      mode === 'off' ? [['STROBES_OFF']] : [['STROBES_OFF'], ['STROBES_ON']]);
  }
});

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

test('phase light presets compose only reviewed fixed light actions and share the takeoff recipe for landing', () => {
  const expected = {
    'pmdg-737': {
      afterTakeoff: ['landingRetractableLeft.retract', 'landingRetractableRight.retract', 'landingLeft.off', 'landingRight.off',
        'turnoffLeft.off', 'turnoffRight.off', 'taxi.off'],
      afterLanding: ['position.steady', 'landingRetractableLeft.retract', 'landingRetractableRight.retract', 'landingLeft.off',
        'landingRight.off', 'taxi.on', 'turnoffLeft.on', 'turnoffRight.on'],
    },
    'pmdg-777': {
      afterTakeoff: ['landingLeft.off', 'landingNose.off', 'landingRight.off', 'turnoffLeft.off', 'turnoffRight.off', 'taxi.off'],
      afterLanding: ['strobe.off', 'landingLeft.off', 'landingNose.off', 'landingRight.off', 'taxi.on', 'turnoffLeft.on', 'turnoffRight.on'],
    },
    'fenix-a320': {
      afterTakeoff: ['landingLeft.retract', 'landingRight.retract', 'runwayTurnoff.off', 'nose.off'],
      afterLanding: ['strobe.off', 'landingLeft.retract', 'landingRight.retract', 'nose.taxi', 'runwayTurnoff.on'],
    },
    'fbw-a32nx': {
      afterTakeoff: ['landingLeft.retract', 'landingRight.retract', 'runwayTurnoff.off', 'nose.off'],
      afterLanding: ['strobe.off', 'landingLeft.retract', 'landingRight.retract', 'nose.taxi', 'runwayTurnoff.on'],
    },
    'fbw-a380x': {
      afterTakeoff: ['landing.off', 'taxi.off'],
      afterLanding: ['strobe.off', 'landing.off', 'taxi.on'],
    },
    'inibuilds-a350-900': {
      afterTakeoff: ['landing.off', 'nose.off'],
      afterLanding: ['strobe.off', 'landing.off', 'nose.taxi'],
    },
  };
  for (const [id, recipes] of Object.entries(expected)) {
    const profile = loader.loadProfile(`bundled/msfs/${id}`);
    const options = { profile, capabilities };
    const integration = registry.resolveForProfile(profile._profileKey);
    const takeoff = resolveAircraftCommand({ commandId: 'configuration.lights.takeoff', input: {} }, options);
    const landing = resolveAircraftCommand({ commandId: 'configuration.lights.landing', input: {} }, options);
    assert.equal(landing.ok, true, `${id}: landing preset`);
    assert.deepEqual(landing.controlRequests, takeoff.controlRequests, `${id}: landing lights equal the takeoff configuration`);
    for (const [phase, steps] of Object.entries(recipes)) {
      const result = resolveAircraftCommand({ commandId: `configuration.lights.${phase}`, input: {} }, options);
      assert.equal(result.ok, true, `${id}: ${phase} ${JSON.stringify(result)}`);
      assert.deepEqual(result.controlRequests.map(r => r.actionId), steps.map(step => `lights.${step}`), `${id}: ${phase}`);
      for (const control of result.controlRequests) {
        const action = registry.resolveAction({ adapterId: integration.id, profileKey: profile._profileKey, actionId: control.actionId });
        assert.ok(action, `${id}: ${control.actionId} must exist in the adapter`);
        assert.equal(action.guard.retry, 'never');
      }
    }
    // Climb-out never touches strobes, and after landing always ends with strobes off before ground lights.
    assert.ok(!recipes.afterTakeoff.some(step => step.startsWith('strobe.') || step.startsWith('position.')), `${id}: after takeoff keeps strobes`);
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

for (const id of ['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900']) test(`${id}: landing and takeoff commands reach the full ON and OFF switch positions`, async () => {
  loader.setActiveProfile(id); const config = loader.getLvarConfig().aircraftSpecific;
  const profile = loader.loadProfile(`bundled/msfs/${id}`);
  const provider = new SimConnectTelemetryProvider();
  provider._getActiveAircraftIntegrationConfig = () => config;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ sdk: true });
  const snapshot = { adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 1,
    updatedAt: new Date().toISOString(), normalized: { lights: {
      landing: { retractableLeft: 'retract', retractableRight: 'retract', left: false, right: false },
      turnoff: { left: false, right: false }, taxi: false, position: 'off',
    } } };
  provider._sdkBridge = { getSnapshot: () => snapshot, isDataConnected: () => true };
  const paths = { '#69743': ['landing', 'retractableLeft'], '#69744': ['landing', 'retractableRight'],
    '#69745': ['landing', 'left'], '#69746': ['landing', 'right'], '#69747': ['turnoff', 'left'],
    '#69748': ['turnoff', 'right'], '#69749': ['taxi'], '#69755': ['position'] };
  const fixedPositions = { left: 0, right: 0 };
  const writes = [];
  const bridge = { sendSdkEvent: async (event, value) => {
    assert.ok(paths[event], event); writes.push([event, value]);
    const path = paths[event];
    if (event === '#69755') snapshot.normalized.lights.position = ['steady', 'off', 'strobe-steady'][value];
    else if (path.length === 1) snapshot.normalized.lights.taxi = Boolean(value);
    else snapshot.normalized.lights[path[0]][path[1]] = path[1].startsWith('retractable') ? ['retract', 'extend', 'on'][value] : Boolean(value);
    if (event === '#69745' || event === '#69746') fixedPositions[path[1]] = value;
    snapshot.snapshotSequence++; return { ok: true };
  } };
  const runner = { aircraftControlCapabilities: capabilities, executeAircraftControlAction: (_action, options) =>
    provider._executeAircraftIntegrationAction(bridge, { name: 'pmdg-737' }, 'test', options) };
  const options = { profile, capabilities, profileRevision: config.profileRevision };
  const landingOn = await executeAircraftCommand(runner, request('landing', true), options);
  assert.equal(landingOn.ok, true, JSON.stringify(landingOn));
  assert.deepEqual(writes, [['#69743', 2], ['#69745', 2], ['#69744', 2], ['#69746', 2]]);
  assert.deepEqual(fixedPositions, { left: 2, right: 2 }, 'fixed switches must reach full ON, not the centre position');
  assert.deepEqual(snapshot.normalized.lights.turnoff, { left: false, right: false });
  assert.equal(snapshot.normalized.lights.taxi, false);
  // Advance the existing per-switch cooldown without changing control semantics.
  provider._aircraftIntegrationActionLastAttemptAt.clear(); writes.length = 0;
  assert.equal((await executeAircraftCommand(runner, request('landing', false), options)).ok, true);
  assert.deepEqual(writes, [['#69743', 0], ['#69745', 0], ['#69744', 0], ['#69746', 0]]);
  assert.deepEqual(snapshot.normalized.lights.landing,
    { retractableLeft: 'retract', retractableRight: 'retract', left: false, right: false });
  provider._aircraftIntegrationActionLastAttemptAt.clear(); writes.length = 0;
  assert.equal((await executeAircraftCommand(runner, request('landing', false), options)).ok, true);
  assert.deepEqual(writes, [], 'repeating OFF must leave retracted lights alone');

  // Each side must stow an extended light while leaving the opposite side alone.
  for (const [side, other] of [['Left', 'Right'], ['Right', 'Left']]) {
    Object.assign(snapshot.normalized.lights.landing,
      { retractableLeft: 'extend', retractableRight: 'extend', left: true, right: true });
    snapshot.snapshotSequence++;
    provider._aircraftIntegrationActionLastAttemptAt.clear(); writes.length = 0;
    assert.equal((await executeAircraftCommand(runner, request(`landing${side}`, false), options)).ok, true);
    assert.deepEqual(writes, side === 'Left' ? [['#69743', 0], ['#69745', 0]] : [['#69744', 0], ['#69746', 0]]);
    assert.equal(snapshot.normalized.lights.landing[`retractable${side}`], 'retract');
    assert.equal(snapshot.normalized.lights.landing[side.toLowerCase()], false);
    assert.equal(snapshot.normalized.lights.landing[`retractable${other}`], 'extend');
    assert.equal(snapshot.normalized.lights.landing[other.toLowerCase()], true);
    assert.deepEqual(snapshot.normalized.lights.turnoff, { left: false, right: false });
    assert.equal(snapshot.normalized.lights.taxi, false);
  }
  writes.length = 0;
  assert.equal((await executeAircraftCommand(runner, request('runwayTurnoff', true), options)).ok, true);
  assert.deepEqual(writes, [['#69747', 1], ['#69748', 1]]);
  assert.equal(snapshot.normalized.lights.taxi, false);

  // A boolean SDK readback cannot distinguish a centre position from full ON.
  // Start the takeoff preset with one fixed switch at centre and the other OFF.
  Object.assign(snapshot.normalized.lights.landing,
    { retractableLeft: 'on', retractableRight: 'on', left: true, right: false });
  Object.assign(fixedPositions, { left: 1, right: 0 });
  snapshot.snapshotSequence++;
  provider._aircraftIntegrationActionLastAttemptAt.clear(); writes.length = 0;
  assert.equal((await executeAircraftCommand(runner, { commandId: 'configuration.lights.takeoff', input: {} }, options)).ok, true);
  assert.deepEqual(writes, [['#69745', 2], ['#69746', 2], ['#69749', 1], ['#69755', 2]]);
  assert.deepEqual(fixedPositions, { left: 2, right: 2 });
  provider._aircraftIntegrationActionLastAttemptAt.clear(); writes.length = 0;
  assert.equal((await executeAircraftCommand(runner, { commandId: 'configuration.lights.takeoff', input: {} }, options)).ok, true);
  assert.deepEqual(writes, [['#69745', 2], ['#69746', 2]], 'repeating the preset sets fixed ON directly without toggling');
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
  for (const command of [request('taxi', false), request('landingRight', false), { commandId: 'configuration.lights.takeoff', input: {} },
    { commandId: 'configuration.lights.afterTakeoff', input: {} }, { commandId: 'configuration.lights.landing', input: {} }, { commandId: 'configuration.lights.afterLanding', input: {} }]) {
    assert.equal((await executeAircraftCommand(provider, command, { profile })).code, 'action_in_flight');
  }
  assert.equal(writes.length, 1); release(); assert.equal((await pending).ok, true);
  assert.equal((await executeAircraftCommand(provider, request('taxi', true), { profile })).ok, true);
});
