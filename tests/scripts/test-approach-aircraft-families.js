const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require(runtime('aircraft/aircraft-control-service.js'));
const { SimConnectTelemetryProvider } = require(runtime('telemetry-provider/simconnect-telemetry-provider.js'));
const { LvarSidecarBridge } = require(runtime('telemetry-provider/lvar-sidecar-bridge.js'));
const { buildAircraftSpecificState } = require(runtime('aircraft/aircraft-specific-state.js'));
const capabilities = { actionTypes: ['aircraft-integration'], integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] };
const families = {
  'pmdg-737': ['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900'],
  'pmdg-777': ['pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f'],
  'fenix-a32x': ['fenix-a319', 'fenix-a320', 'fenix-a321'],
  'inibuilds-a350': ['inibuilds-a350-900', 'inibuilds-a350-1000'],
};

function harness(profileId, initial) {
  loader.setActiveProfile(profileId); const config = loader.getAircraftSpecificConfig();
  const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
  let current = true;
  provider._getActiveAircraftIntegrationConfig = () => current ? config : null;
  provider._getMobiFlightHealth = () => ({ connected: true });
  const source = { profileId: config.profileKey, enabled: true, status: 'running', values: {}, valueUpdatedAt: {}, snapshotSequence: 1, updatedAt: new Date().toISOString() };
  const key = (id) => config.confirmationFields.find((f) => f.id === id).source.key;
  function publish(id, value, fresh = true) {
    source.values[key(id)] = value; source.snapshotSequence++; source.updatedAt = new Date().toISOString();
    if (fresh) source.valueUpdatedAt[key(id)] = source.updatedAt;
  }
  for (const [id, value] of Object.entries(initial)) publish(id, value);
  for (const name of Object.keys(source.valueUpdatedAt)) source.valueUpdatedAt[name] = new Date(Date.now() - 10).toISOString();
  const bridge = new LvarSidecarBridge(), calls = [];
  bridge.getSnapshot = () => source;
  bridge._sendWithAck = async (message) => { calls.push(message); return { ok: true }; };
  bridge.executeMobiFlightCode = async (code) => { calls.push(code); return { ok: true }; };
  const wait = provider._waitForAircraftIntegrationReadback.bind(provider);
  provider._waitForAircraftIntegrationReadback = (b, r, c, base) => wait(b, { ...r, timeoutMs: 30 }, c, base);
  return { provider, source, bridge, calls, key, publish, config, retire: () => { current = false; },
    run: (actionId, value) => provider._executeAircraftIntegrationAction(bridge, { name: config.integrationId }, 'test', {
      profileKey: config.profileKey, profileRevision: config.profileRevision, request: { actionId, ...(value === undefined ? {} : { value }) },
    }),
  };
}

test('all thirteen profiles accept only aircraft-appropriate flap, autobrake and speedbrake voice targets', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  const flaps = { 'pmdg-737': ['up', '1', '2', '5', '10', '15', '25', '30', '40'],
    'pmdg-777': ['up', '1', '5', '15', '20', '25', '30'], 'fenix-a32x': ['up', '1', '2', '3', 'full'], 'inibuilds-a350': [] };
  const brakes = { 'pmdg-737': ['rto', 'off', '1', '2', '3', 'max'], 'pmdg-777': ['rto', 'off', 'disarm', '1', '2', 'max'],
    'fenix-a32x': ['off', 'low', 'medium', 'max'], 'inibuilds-a350': [] };
  for (const [family, profiles] of Object.entries(families)) for (const id of profiles) {
    loader.setActiveProfile(id); const profile = loader.getActiveProfile();
    const catalogue = buildAircraftControlCapabilities(profile, { capabilities }).aircraftCommands;
    for (const [prefix, commandId, choices] of [['flaps', 'surfaces.flaps.set', flaps[family]],
      ['autobrake', 'surfaces.autobrake.set', brakes[family]], ['speedbrake', 'surfaces.spoilers.set', ['retract', 'half', 'full']]]) {
      for (const value of choices) {
        const text = `${prefix} ${value}`, parsed = interpret(text, catalogue);
        assert.equal(parsed.ok, true, `${id}: ${text}: ${JSON.stringify(parsed)}`);
        assert.equal(parsed.commandId, commandId);
        assert.equal(parsed.input.value, value === 'retract' ? 'retracted' : value);
        assert.equal(resolveAircraftCommand({ commandId, input: parsed.input }, { profile, capabilities }).ok, true);
      }
    }
    for (const value of ['up', '1', '2', '3', '5', '10', '15', '20', '25', '30', '40', 'full'].filter(v => !flaps[family].includes(v))) {
      assert.equal(interpret(`flaps ${value}`, catalogue).ok, false, `${id}: unsupported flaps ${value}`);
    }
    for (const value of ['rto', 'low', 'medium', '3'].filter(v => !brakes[family].includes(v))) {
      assert.equal(interpret(`autobrake ${value}`, catalogue).ok, false, `${id}: unsupported autobrake ${value}`);
    }
    const local = { ...profile, _profileKey: `local/msfs/${id}` };
    assert.equal(buildAircraftControlCapabilities(local, { capabilities }).aircraftCommands.commands.some(c => c.id === 'surfaces.spoilers.set'), false);
  }
});

const brakeModes = ['off', 'low', 'medium', 'max'];
const brakeFields = (mode) => ({ 'baro.healthy': 1,
  ...Object.fromEntries(brakeModes.slice(1).map(m => [`controls.autobrake.${m}`, Number(m === mode)])) });

test('Fenix autobrake never treats unpowered or stale power indications as a confirmed selection', async () => {
  for (const profile of ['fenix-a319', 'fenix-a320', 'fenix-a321']) for (const target of brakeModes) {
    for (const current of new Set(['off', target])) for (const power of ['off', 'missing', 'stale']) {
      const h = harness(profile, brakeFields(current)), key = h.key('baro.healthy');
      if (power === 'off') h.publish('baro.healthy', 0);
      if (power === 'missing') delete h.source.values[key];
      if (power === 'stale') delete h.source.valueUpdatedAt[key];
      const result = await h.run(`controls.autobrake.${target}`);
      assert.equal(result.ok, false, `${profile}/${current}->${target}/${power}: ${JSON.stringify(result)}`);
      assert.deepEqual(h.calls, [], 'power must be established before sending a pulse or claiming a no-op');
    }
  }
});

test('Fenix autobrake losing power during a pulse releases the button without confirming OFF', async () => {
  const h = harness('fenix-a320', brakeFields('low'));
  h.bridge.executeMobiFlightCode = async code => {
    h.calls.push(code);
    for (const [field, value] of Object.entries({ ...brakeFields('off'), 'baro.healthy': 0 })) h.publish(field, value);
    return { ok: true };
  };
  const result = await h.run('controls.autobrake.off');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(h.calls.length, 2, 'the accepted press still receives its release');
  assert.equal(result.executionStarted, true);
});

test('Fenix autobrake confirmation cannot combine earlier matching fields with a later incompatible state', async () => {
  for (const drift of ['none', 'power', 'lamp', 'stale']) {
    const h = harness('fenix-a320', brakeFields('medium'));
    h.bridge.executeMobiFlightCode = async code => {
      h.calls.push(code);
      // LOW and power already match, while the MED lamp is still going out.
      h.publish('baro.healthy', 1);
      h.publish('controls.autobrake.low', 0);
      h.publish('controls.autobrake.max', 0);
      return { ok: true };
    };
    const wait = h.provider._waitForAircraftIntegrationReadback.bind(h.provider);
    h.provider._waitForAircraftIntegrationReadback = async (bridge, readback, context, baseline) => {
      const confirmation = await wait(bridge, readback, context, baseline);
      if (readback.fieldId === 'controls.autobrake.low' && confirmation.confirmed) {
        // A subsequent telemetry update finally clears MED, but contradicts
        // one of the fields that another waiter already considered confirmed.
        if (drift === 'power') h.publish('baro.healthy', 0);
        if (drift === 'lamp') h.publish('controls.autobrake.low', 1);
        if (drift === 'stale') delete h.source.valueUpdatedAt[h.key('controls.autobrake.low')];
        h.publish('controls.autobrake.medium', 0);
      }
      return confirmation;
    };
    const result = await h.run('controls.autobrake.off');
    assert.equal(result.ok, drift === 'none', `${drift}: ${JSON.stringify(result)}`);
    if (drift !== 'none') assert.equal(result.executionStarted, true);
    assert.equal(h.calls.length, 2, 'confirmation drift must never repeat the physical button pulse');
  }
});

test('Fenix all sixteen autobrake transitions press and release the intended counter exactly once, or no-op', async () => {
  for (const current of brakeModes) for (const target of brakeModes) {
    const h = harness('fenix-a320', brakeFields(current));
    h.bridge.executeMobiFlightCode = async code => {
      h.calls.push(code);
      // Change the indications immediately after press: release must use the frozen original button.
      for (const [field, value] of Object.entries(brakeFields(target))) h.publish(field, value);
      return { ok: true };
    };
    const result = await h.run(`controls.autobrake.${target}`);
    assert.equal(result.ok, true, `${current}->${target}: ${JSON.stringify(result)}`);
    if (current === target) { assert.equal(result.noOp, true); assert.deepEqual(h.calls, []); }
    else {
      const button = { low: 'LO', medium: 'MED', max: 'MAX' }[target === 'off' ? current : target];
      assert.deepEqual(h.calls, Array(2).fill(`(L:S_MIP_AUTOBRAKE_${button}, Number) ++ (>L:S_MIP_AUTOBRAKE_${button}, Number)`));
    }
  }
});

test('Fenix autobrake rejects missing, stale, invalid and contradictory indications without a press', async () => {
  for (const invalid of ['missing', 'stale', 'invalid', 'contradictory']) {
    const h = harness('fenix-a321', brakeFields('low')), key = h.key('controls.autobrake.max');
    if (invalid === 'missing') delete h.source.values[key];
    if (invalid === 'stale') delete h.source.valueUpdatedAt[key];
    if (invalid === 'invalid') h.source.values[key] = 2;
    if (invalid === 'contradictory') h.source.values[key] = 1;
    const result = await h.run('controls.autobrake.off');
    assert.equal(result.ok, false, `${invalid}: ${JSON.stringify(result)}`); assert.deepEqual(h.calls, []);
  }
});

test('Fenix pulse confirms all three own observations, releases after profile loss and never retries an inhibited press', async () => {
  for (const outcome of ['stale-low', 'stale-medium', 'stale-max', 'inhibited', 'profile', 'release-failed']) {
    const h = harness('fenix-a319', brakeFields('medium'));
    h.bridge.executeMobiFlightCode = async code => {
      h.calls.push(code);
      if (outcome !== 'inhibited') for (const [field, value] of Object.entries(brakeFields('off'))) {
        h.publish(field, value, outcome !== `stale-${field.split('.').at(-1)}`);
      }
      if (outcome === 'profile') h.retire();
      return { ok: !(outcome === 'release-failed' && h.calls.length === 2) };
    };
    const result = await h.run('controls.autobrake.off');
    assert.equal(result.ok, false, `${outcome}: ${JSON.stringify(result)}`);
    assert.deepEqual(h.calls, Array(2).fill('(L:S_MIP_AUTOBRAKE_MED, Number) ++ (>L:S_MIP_AUTOBRAKE_MED, Number)'));
  }
});

test('Fenix flap detents and speedbrake targets use native lever values, with zero reserved for ARM', async () => {
  for (const [prefix, field, lvar, targets] of [
    ['flaps', 'controls.flapsHandle', 'L:S_FC_FLAPS', [['up', 0], ['one', 1], ['two', 2], ['three', 3], ['full', 4]]],
    ['speedbrake', 'controls.speedbrakePosition', 'L:A_FC_SPEEDBRAKE', [['armed', 0], ['retracted', 1], ['half', 2], ['full', 3]]],
  ]) for (const [suffix, raw] of targets) {
    const h = harness('fenix-a320', { [field]: raw === 4 ? 0 : 4 });
    h.bridge._sendWithAck = async message => { h.calls.push(message); h.publish(field, raw); return { ok: true }; };
    const result = await h.run(`controls.${prefix}.${suffix}`);
    assert.equal(result.ok, true, `${prefix} ${suffix}: ${JSON.stringify(result)}`);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, lvar); assert.equal(h.calls[0].value, raw);
    h.provider._aircraftIntegrationActionLastAttemptAt.clear();
    assert.equal((await h.run(`controls.${prefix}.${suffix}`)).noOp, true); assert.equal(h.calls.length, 1);
  }
});

test('A350 HALF uses the existing 50 percent route and requires its own newly sampled handle readback', async () => {
  for (const profile of families['inibuilds-a350']) for (const fresh of [true, false]) {
    const field = 'controls.speedbrakePercent', h = harness(profile, { [field]: 0 });
    h.bridge._sendWithAck = async message => { h.calls.push(message); h.publish(field, 50, fresh); return { ok: true }; };
    const result = await h.run('controls.speedbrake.set', 50);
    assert.equal(result.ok, fresh, JSON.stringify(result));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, 'SPOILERS_SET'); assert.equal(h.calls[0].value, 8192);
  }
});

test('PMDG fixed SDK speedbrake targets use a complete click and confirm the matching handle position', async () => {
  for (const family of ['pmdg-737', 'pmdg-777']) for (const [target, percent] of [['retracted', 0], ['half', 50], ['full', 100]]) {
    const is777 = family === 'pmdg-777', field = is777 ? 'controls.speedbrakePercent' : 'flightControls.speedbrakePercent';
    const h = harness(family, is777 ? {} : { [field]: percent === 0 ? 50 : 0 });
    const sdk = { adapterId: 'clientdata-manifest', status: 'running', normalized: { spoilers: { handlePercent: percent === 0 ? 50 : 0 } },
      snapshotSequence: 1, updatedAt: new Date().toISOString() };
    h.provider._sdkBridge = { getSnapshot: () => sdk, isDataConnected: () => true };
    h.bridge.sendSdkEvent = async (name, value) => {
      h.calls.push({ name, value });
      if (is777) { sdk.normalized.spoilers.handlePercent = percent; sdk.snapshotSequence++; sdk.updatedAt = new Date().toISOString(); }
      else h.publish(field, percent);
      return { ok: true };
    };
    const result = await h.run(`${is777 ? 'controls' : 'flightControls'}.speedbrake.${is777 && target === 'retracted' ? 'stowed' : target}`);
    assert.equal(result.ok, true, `${family} ${target}: ${JSON.stringify(result)}`);
    const event = (is777 ? { retracted: 74613, half: 74616, full: 74615 } : { retracted: 76423, half: 76425, full: 76427 })[target];
    assert.deepEqual(h.calls, [{ name: `#${event}`, value: 0x20000000 }, { name: `#${event}`, value: 0x00020000 }]);
  }
});

test('state-selected pulse definitions reject malformed conditions and unsafe or incompatible routes', () => {
  const { defineAircraftIntegration } = require(runtime('aircraft/aircraft-integrations/registry.js'));
  const { FENIX_A32X_INTEGRATION } = require(runtime('aircraft/aircraft-integrations/fenix-a32x/index.js'));
  assert.equal(typeof defineAircraftIntegration, 'function');
  for (const mutate of [
    r => { r.pulses = []; }, r => { delete r.pulses[0].when[0].freshness; },
    r => { r.pulses[0].when[0].fieldId = 'controls.notConfirmed'; },
    r => { r.pulses[0].when.push(r.pulses[0].when[0]); },
    r => { r.pulses[0].pressCode = '1\n2'; }, r => { r.mode = 'single'; },
    r => { r.pressCode = '1'; r.releaseCode = '1'; },
    r => { r.readbacks.find(readback => readback.fieldId === 'controls.autobrake.low').freshness = undefined; },
  ]) {
    const definition = JSON.parse(JSON.stringify(FENIX_A32X_INTEGRATION));
    mutate(definition.actions['controls.autobrake.off'].routes[0]);
    assert.throws(() => defineAircraftIntegration(definition), TypeError);
  }
});

test('ambiguous pulse candidates cannot dispatch, and one physical autobrake group blocks overlapping requests', async () => {
  const h = harness('fenix-a320', brakeFields('low'));
  const { FENIX_A32X_INTEGRATION } = require(runtime('aircraft/aircraft-integrations/fenix-a32x/index.js'));
  const action = FENIX_A32X_INTEGRATION.actions['controls.autobrake.off'];
  const route = JSON.parse(JSON.stringify(action.routes[0]));
  route.pulses.push(route.pulses[0]);
  const result = await h.provider._executeAircraftIntegrationMobiFlightRoute(h.bridge, route, action, undefined, undefined,
    { profileKey: h.config.profileKey, profileRevision: h.config.profileRevision, adapterId: h.config.integrationId });
  assert.equal(result.ok, false); assert.equal(result.code, 'aircraft_integration_precondition_failed'); assert.deepEqual(h.calls, []);
  let pressed, release;
  const atPress = new Promise(resolve => { pressed = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  h.bridge.executeMobiFlightCode = async code => {
    h.calls.push(code); pressed(); await hold;
    for (const [field, value] of Object.entries(brakeFields('off'))) h.publish(field, value);
    return { ok: true };
  };
  const first = h.run('controls.autobrake.off'); await atPress;
  try { assert.equal((await h.run('controls.autobrake.max')).ok, false); assert.equal(h.calls.length, 1); }
  finally { release(); }
  assert.equal((await first).ok, true); assert.equal(h.calls.length, 2);
});

test('PMDG speedbrake cannot confirm unchanged or retired telemetry and never repeats the click', async () => {
  for (const family of ['pmdg-737', 'pmdg-777']) for (const outcome of ['stale', 'profile']) {
    const is777 = family === 'pmdg-777', field = is777 ? 'controls.speedbrakePercent' : 'flightControls.speedbrakePercent';
    const h = harness(family, is777 ? {} : { [field]: 0 });
    const sdk = { adapterId: 'clientdata-manifest', status: 'running', normalized: { spoilers: { handlePercent: 0 } },
      snapshotSequence: 1, updatedAt: new Date().toISOString() };
    h.provider._sdkBridge = { getSnapshot: () => sdk, isDataConnected: () => true };
    h.bridge.sendSdkEvent = async (name, value) => {
      h.calls.push({ name, value });
      if (is777) sdk.normalized.spoilers.handlePercent = 50;
      else h.publish(field, 50, false);
      if (outcome === 'profile') h.retire();
      return { ok: true };
    };
    const result = await h.run(`${is777 ? 'controls' : 'flightControls'}.speedbrake.half`);
    assert.equal(result.ok, false, `${family} ${outcome}: ${JSON.stringify(result)}`); assert.equal(h.calls.length, 2);
  }
});
