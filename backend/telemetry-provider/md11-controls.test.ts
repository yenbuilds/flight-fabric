const test = require('node:test');
const assert = require('node:assert/strict');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider');
const { TFDI_MD_11_INTEGRATION: integration, TFDI_MD_11_PROFILE_KEY: profileKey } = require('../aircraft/aircraft-integrations/tfdi-md-11');
const { decodeAircraftSpecificValue } = require('../aircraft/aircraft-specific-state');

function fixture(options: any = {}) {
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  const values: any = { 'systems.busVoltage': 115, 'afs.speedValue': 250, 'afs.speedMode': 'ias',
    'afs.headingValue': 0, 'afs.headingMode': 'heading', 'afs.altitudeValue': 10000, 'afs.altitudeUnit': 'feet',
    'lights.nav': true, 'lights.strobe': false, 'lights.beacon': true, 'lights.logo': false,
    'lights.nosePosition': 2, 'lights.landingLeftPosition': 2, 'lights.landingRightPosition': 2,
    'lights.turnoffLeft': false, 'lights.turnoffRight': false, 'baro.captain.value': 29.92,
    'approach.captain.minimums': 200, 'approach.firstOfficer.minimums': 200,
    'approach.captain.minimumsMode': 'radio', 'approach.firstOfficer.minimumsMode': 'radio' };
  const calls: any[] = []; let sequence = 1, active = true;
  provider._getActiveAircraftIntegrationConfig = () => active ? { profileKey, integrationId: integration.id, profileRevision: 3 } : null;
  provider._captureAircraftIntegrationReadback = (_bridge, readback) => ({ observed: values[readback.fieldId],
    sequence, updatedAtMs: options.frozenTimestamp ? 1 : sequence, sourceId: readback.fieldId, fresh: active && options.stale !== readback.fieldId });
  const wait = provider._waitForAircraftIntegrationReadback.bind(provider);
  provider._waitForAircraftIntegrationReadback = (bridge, readback, context, baseline) =>
    wait(bridge, { ...readback, timeoutMs: 5 }, context, baseline);
  const bridge: any = { _started: true,
    getSnapshot: () => ({ status: 'running', profileId: profileKey, mobiflight: { connected: true, available: true, state: 'connected' } }),
    sendEvent: async () => { throw Error('Generic events must never be sent'); },
    setNamedVar: async ({name, value}) => {
      calls.push([name, value]); sequence++;
      const field = { 'L:MD11_EXTCTL_FCP_SPD': 'afs.speedValue', 'L:MD11_EXTCTL_FCP_HDG': 'afs.headingValue',
        'L:MD11_EXTCTL_FCP_ALT': 'afs.altitudeValue', 'L:MD11_EXTCTL_CAP_BARO': 'baro.captain.value' }[name];
      if (!options.noReadback) values[field] = value;
      if (options.modeChange) values['afs.speedMode'] = 'mach';
      if (options.disconnect) active = false;
      return { ok: true, sendId: 1 };
    },
    executeMobiFlightCode: async code => {
      calls.push(code); sequence++;
      const id = Number(code.split(' ')[0]);
      if (!options.noReadback) {
        if (id === 90267) values['lights.nav'] = !values['lights.nav'];
        if (id === 90273) values['lights.strobe'] = !values['lights.strobe'];
        if (id === 90257) values['lights.landingLeftPosition']--;
        if (id === 90258) values['lights.landingLeftPosition']++;
        if (id === 90259) values['lights.landingRightPosition']--;
        if (id === 90260) values['lights.landingRightPosition']++;
        if (id === 90261) values['lights.nosePosition']--;
        if (id === 90262) values['lights.nosePosition']++;
        if (id === 90263) values['lights.turnoffLeft'] = !values['lights.turnoffLeft'];
        if (id === 90265) values['lights.turnoffRight'] = !values['lights.turnoffRight'];
        if (id === 86064) values['approach.captain.minimums'] += 10;
        if (id === 86134) values['approach.firstOfficer.minimums'] += 10;
      }
      options.afterWrite?.(values, calls);
      return { ok: true };
    }, findRecentSimConnectException: () => null,
  };
  const execute = (actionId = 'flightGuidance.speed.set', value: any = actionId === 'flightGuidance.speed.set' ? 251 : undefined) => provider._executeAircraftIntegrationAction(
    bridge, { type: 'aircraft-integration', name: integration.id }, 'simconnect',
    { profileKey, profileRevision: 3, request: { actionId, value } });
  return { provider, values, calls, execute, deactivate: () => { active = false; } };
}

test('MD-11 targets use external inputs and require independent consumed values', async () => {
  for (const noReadback of [false, true]) {
    const f = fixture({ noReadback }); const result = await f.execute();
    assert.equal(result.ok, !noReadback);
    assert.deepEqual(f.calls, [['L:MD11_EXTCTL_FCP_SPD', 251]]);
  }
});
test('MD-11 rejects wrong units, dashed targets, stale power and invalid inputs before writes', async () => {
  for (const [field, value, actionId, target] of [
    ['afs.speedMode', 'mach', 'flightGuidance.speed.set', 250],
    ['afs.headingMode', 'track', 'flightGuidance.heading.set', 1],
    ['afs.altitudeUnit', 'metres', 'flightGuidance.altitude.set', 10100],
    ['afs.speedValue', null, 'flightGuidance.speed.set', 251],
    ['systems.busVoltage', 0, 'lights.nav.off', undefined],
    ['baro.captain.value', 1013, 'baro.captain.inHg.set', 29.93],
  ]) { const f = fixture(); f.values[String(field)] = value; assert.equal((await f.execute(String(actionId), target)).ok, false); assert.equal(f.calls.length, 0); }
  const stale = fixture({ stale: 'systems.busVoltage' }); assert.equal((await stale.execute()).ok, false); assert.equal(stale.calls.length, 0);
  for (const value of [99, 400, NaN, 250.5]) { const f = fixture(); assert.equal((await f.execute(undefined, value)).ok, false); assert.equal(f.calls.length, 0); }
});
test('MD-11 disconnect and mode drift during a target cannot claim success', async () => {
  for (const option of [{ disconnect: true }, { modeChange: true }]) assert.equal((await fixture(option).execute()).ok, false);
});
test('MD-11 explicit light intents are idempotent and release the button', async () => {
  const same = fixture(); assert.equal((await same.execute('lights.nav.on', undefined)).noOp, true); assert.equal(same.calls.length, 0);
  for (const noReadback of [false, true]) { const f = fixture({noReadback}); assert.equal((await f.execute('lights.nav.off', undefined)).ok, !noReadback);
    assert.deepEqual(f.calls, ['90267 (>L:CEVENT, Number)', '90268 (>L:CEVENT, Number)']); }
});
test('MD-11 two-detent selectors retain per-field timestamps between confirmed steps', async () => {
  for (const [from, target, event] of [[2, 0, 90257], [0, 2, 90258]]) {
    const f = fixture(); f.values['lights.landingLeftPosition'] = from;
    assert.equal((await f.execute('lights.landingLeft.set', target)).ok, true);
    assert.equal(f.values['lights.landingLeftPosition'], target);
    assert.deepEqual(f.calls, [1, 2].map(() => `${event} (>L:CEVENT, Number)`));
  }
  const silent = fixture({noReadback: true}); assert.equal((await silent.execute('lights.landingLeft.set', 0)).ok, false); assert.equal(silent.calls.length, 1);
});
test('MD-11 stable light annunciators decode their observed opposite polarities', () => {
  for (const id of ['nav', 'beacon', 'strobe']) {
    const decode = integration.fields[`lights.${id}`].sources[0].decode;
    assert.equal(decodeAircraftSpecificValue(0, decode), true);
    assert.equal(decodeAircraftSpecificValue(1, decode), false);
    assert.equal(decodeAircraftSpecificValue(2, decode), undefined);
  }
  assert.equal(decodeAircraftSpecificValue(1, integration.fields['lights.turnoffLeft'].sources[0].decode), true);
});
test('MD-11 radio minimums confirm each wheel step and reject BARO or stale reference', async () => {
  for (const [side, event] of [['captain', 86064], ['firstOfficer', 86134]]) {
    const id = `approach.${side}.minimums.set`, mode = `approach.${side}.minimumsMode`;
    const f = fixture();
    assert.equal((await f.execute(id, 220)).ok, true);
    assert.deepEqual(f.calls, [1, 2].map(() => `${event} (>L:CEVENT, Number)`));
    const baro = fixture(); baro.values[mode] = 'baro';
    assert.equal((await baro.execute(id, 210)).ok, false); assert.equal(baro.calls.length, 0);
    const stale = fixture({ stale: mode });
    assert.equal((await stale.execute(id, 210)).ok, false); assert.equal(stale.calls.length, 0);
    const silent = fixture({ noReadback: true });
    assert.equal((await silent.execute(id, 220)).ok, false); assert.equal(silent.calls.length, 1);
  }
});
test('MD-11 overview uses the same fresh switch fields and rejects stale or unpowered readings', () => {
  const { resolveTfdiMd11Lights } = require('../aircraft/aircraft-integrations/tfdi-md-11/lights');
  const loader = require('../aircraft/aircraft-profile-loader');
  loader.setActiveProfile(profileKey);
  const config = loader.getAircraftSpecificConfig();
  const now = Date.now(), values = {}, valueUpdatedAt = {};
  for (const [id, raw] of Object.entries({ 'lights.nav': 0, 'lights.beacon': 0, 'lights.strobe': 1, 'lights.logo': 1,
    'lights.landingLeftPosition': 0, 'lights.landingRightPosition': 2, 'lights.nosePosition': 1,
    'lights.turnoffLeft': 0, 'lights.turnoffRight': 0, 'systems.busVoltage': 115 })) {
    const key = config.fields.find(field => field.id === id).source.key;
    values[key] = raw; valueUpdatedAt[key] = new Date(now).toISOString();
  }
  const snapshot = { profileId: profileKey, status: 'running', values, valueUpdatedAt };
  assert.deepEqual(resolveTfdiMd11Lights(snapshot, now), {nav: true, beacon: true, strobe: false, logo: true, landing: true, taxi: true, turnoff: false});
  assert.equal(resolveTfdiMd11Lights(snapshot, now + 3000), null);
  assert.equal(resolveTfdiMd11Lights({...snapshot, profileId: 'local/msfs/tfdi-md-11'}, now), null);
  values['aircraft_specific_systems_bus_voltage'] = 0;
  assert.equal(resolveTfdiMd11Lights(snapshot, now), null);
});
test('MD-11 paired light commands complete both sides despite the shared CEVENT cooldown', async () => {
  const loader = require('../aircraft/aircraft-profile-loader');
  const { executeAircraftCommand } = require('../aircraft/aircraft-control-service');
  const previous = process.env.FF_CONTROL_EVIDENCE;
  process.env.FF_CONTROL_EVIDENCE = '0';
  try {
    for (const light of ['landing', 'runwayTurnoff']) {
      const f = fixture();
      const provider = { executeAircraftControlAction: (_action, options) => f.execute(options.request.actionId, options.request.value) };
      const result = await executeAircraftCommand(provider, { commandId: `lights.${light}.set`, input: { value: light !== 'landing' } }, {
        profile: loader.loadProfile(profileKey), profileRevision: 3,
        capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence', 'mobiflight-calculator'] },
        simState: { simconnectConnected: true, inMenu: false },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.completedStepCount, 2);
      for (const side of ['Left', 'Right']) assert.equal(f.values[light === 'landing' ? `lights.landing${side}Position` : `lights.turnoff${side}`], light === 'landing' ? 0 : true);
    }
  } finally {
    if (previous === undefined) delete process.env.FF_CONTROL_EVIDENCE; else process.env.FF_CONTROL_EVIDENCE = previous;
  }
});
test('MD-11 stops minimums movement if power or RADIO reference changes between detents', async () => {
  for (const [field, value] of [['systems.busVoltage', 0], ['approach.captain.minimumsMode', 'baro']]) {
    const f = fixture({ afterWrite: values => { values[field] = value; } });
    assert.equal((await f.execute('approach.captain.minimums.set', 230)).ok, false);
    assert.equal(f.calls.length, 1, `${field}: no more wheel events after the guard changes`);
    assert.equal(f.values['approach.captain.minimums'], 210);
  }
});

test('MD-11 rotaries stop after missing, invalid, wrong-direction or non-advancing field readback', async () => {
  for (const observed of [null, undefined, NaN, 205, 190, 220]) {
    const f = fixture({ afterWrite: values => { values['approach.captain.minimums'] = observed; } });
    assert.equal((await f.execute('approach.captain.minimums.set', 230)).ok, false, String(observed));
    assert.equal(f.calls.length, 1, 'never continue after an unconfirmed detent');
  }
  const frozen = fixture({ frozenTimestamp: true });
  assert.equal((await frozen.execute('approach.captain.minimums.set', 230)).ok, false);
  assert.equal(frozen.calls.length, 1, 'a newer snapshot alone cannot confirm a field');
});

test('MD-11 overlapping CEVENT requests reject the second and profile changes still release a pressed button', async () => {
  const f = fixture();
  const first = f.execute('lights.nav.off', undefined);
  const second = await f.execute('lights.turnoffLeft.on', undefined);
  assert.equal(second.ok, false);
  assert.equal((await first).ok, true);
  assert.deepEqual(f.calls, ['90267 (>L:CEVENT, Number)', '90268 (>L:CEVENT, Number)']);
  assert.equal(f.values['lights.turnoffLeft'], false);

  const switched = fixture();
  const pending = switched.execute('lights.nav.off', undefined);
  switched.deactivate();
  assert.equal((await pending).ok, false);
  assert.deepEqual(switched.calls, ['90267 (>L:CEVENT, Number)', '90268 (>L:CEVENT, Number)']);
});

test('MD-11 lighting presets confirm each side, retain untouched lights and repeat without toggling', async () => {
  const loader = require('../aircraft/aircraft-profile-loader');
  const { executeAircraftCommand } = require('../aircraft/aircraft-control-service');
  const f = fixture(), previous = process.env.FF_CONTROL_EVIDENCE;
  f.values['lights.nav'] = false;
  f.values['lights.turnoffLeft'] = true;
  f.values['lights.turnoffRight'] = true;
  process.env.FF_CONTROL_EVIDENCE = '0';
  const provider = { executeAircraftControlAction: (_action, options) => f.execute(options.request.actionId, options.request.value) };
  try {
    let lastWrites = 0;
    for (const [phase, expected] of [
      ['afterTakeoff', [0, 0, false, false, 0, false, false]],
      ['takeoff', [2, 2, true, true, 2, true, true]],
      ['landing', [2, 2, true, true, 2, true, true]],
      ['afterTakeoff', [0, 0, false, false, 0, true, true]],
      ['afterLanding', [0, 0, true, true, 1, false, true]],
    ] as const) {
      const result = await executeAircraftCommand(provider, { commandId: `configuration.lights.${phase}`, input: {} }, {
        profile: loader.loadProfile(profileKey), profileRevision: 3,
        capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration'], integrationTransports: ['mobiflight-calculator'] },
        simState: { simconnectConnected: true, inMenu: false },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.completedStepCount, result.stepCount);
      assert.deepEqual(['landingLeftPosition', 'landingRightPosition', 'turnoffLeft', 'turnoffRight', 'nosePosition', 'strobe', 'nav']
        .map(light => f.values[`lights.${light}`]), expected, phase);
      assert.equal(f.values['lights.beacon'], true); assert.equal(f.values['lights.logo'], false);
      if (phase === 'landing') assert.equal(f.calls.length, lastWrites, 'already satisfied lights send no toggles');
      lastWrites = f.calls.length;
      await new Promise(resolve => setTimeout(resolve, 410));
    }
  } finally { if (previous === undefined) delete process.env.FF_CONTROL_EVIDENCE; else process.env.FF_CONTROL_EVIDENCE = previous; }
});

test('MD-11 lighting preset reports partial progress and stops on lost power or readback', async () => {
  const loader = require('../aircraft/aircraft-profile-loader');
  const { executeAircraftCommand } = require('../aircraft/aircraft-control-service');
  const previous = process.env.FF_CONTROL_EVIDENCE; process.env.FF_CONTROL_EVIDENCE = '0';
  try {
    for (const options of [
      { afterWrite: values => { values['systems.busVoltage'] = 0; } },
      { noReadback: true },
      { stale: 'lights.landingRightPosition' },
    ]) {
      const f = fixture(options), provider = { executeAircraftControlAction: (_action, request) => f.execute(request.request.actionId, request.request.value) };
      const result = await executeAircraftCommand(provider, { commandId: 'configuration.lights.afterTakeoff', input: {} }, {
        profile: loader.loadProfile(profileKey), profileRevision: 3,
        capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration'], integrationTransports: ['mobiflight-calculator'] },
        simState: { simconnectConnected: true, inMenu: false },
      });
      assert.equal(result.ok, false); assert.equal(result.executionStarted, true);
      assert.equal(result.completedStepCount, options.stale ? 1 : 0);
      assert.ok(f.calls.every(call => call === '90257 (>L:CEVENT, Number)'), 'no later lights dispatched');
      assert.equal(f.values['lights.nosePosition'], 2);
    }
  } finally { if (previous === undefined) delete process.env.FF_CONTROL_EVIDENCE; else process.env.FF_CONTROL_EVIDENCE = previous; }
});
test('MD-11 preset blocks overlapping light requests and stops between steps when the caller disconnects', async () => {
  const loader = require('../aircraft/aircraft-profile-loader');
  const { executeAircraftCommand } = require('../aircraft/aircraft-control-service');
  const f = fixture(), previous = process.env.FF_CONTROL_EVIDENCE;
  process.env.FF_CONTROL_EVIDENCE = '0';
  let connected = true, signalFirst;
  const firstAction = new Promise(resolve => { signalFirst = resolve; });
  const provider = { executeAircraftControlAction: async (_action, options) => {
    const result = await f.execute(options.request.actionId, options.request.value);
    signalFirst(); return result;
  } };
  const options = { profile: loader.loadProfile(profileKey), profileRevision: 3, canExecute: () => connected,
    capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration'], integrationTransports: ['mobiflight-calculator'] },
    simState: { simconnectConnected: true, inMenu: false } };
  try {
    const pending = executeAircraftCommand(provider, { commandId: 'configuration.lights.afterTakeoff', input: {} }, options);
    await firstAction;
    const overlapping = await executeAircraftCommand(provider, { commandId: 'lights.nav.set', input: { value: false } }, options);
    assert.equal(overlapping.code, 'action_in_flight');
    connected = false;
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.code, 'auth_required');
    assert.equal(result.completedStepCount, 1); assert.equal(result.failedStepIndex, 1);
    assert.deepEqual(f.calls, ['90257 (>L:CEVENT, Number)', '90257 (>L:CEVENT, Number)']);
    assert.equal(f.values['lights.landingRightPosition'], 2); assert.equal(f.values['lights.nav'], true);
    connected = true;
    const recovered = await executeAircraftCommand(provider, { commandId: 'lights.nav.set', input: { value: false } }, options);
    assert.equal(recovered.ok, true, 'a stopped preset releases the canonical light lock');
  } finally { if (previous === undefined) delete process.env.FF_CONTROL_EVIDENCE; else process.env.FF_CONTROL_EVIDENCE = previous; }
});
export {};
