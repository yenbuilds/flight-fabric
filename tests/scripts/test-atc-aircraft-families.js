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

test('all thirteen exact family profiles expose only their supported ATC/EFIS voice commands', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  for (const [family, profiles] of Object.entries(families)) for (const profileId of profiles) {
    loader.setActiveProfile(profileId); const profile = loader.getActiveProfile();
    const catalogue = buildAircraftControlCapabilities(profile, { capabilities }).aircraftCommands;
    const cases = [
      ['captain range one hundred sixty', 'navigation.captain.range', '160'],
      ['first officer range twenty', 'navigation.firstOfficer.range', '20'],
      ...(family.startsWith('pmdg-') ? [
        ['captain minimums baro', 'approach.captain.minimumsMode', 'baro'],
        ['first officer minimums radio', 'approach.firstOfficer.minimumsMode', 'radio'],
      ] : [['captain ls on', 'navigation.captain.ls', true], ['first officer l s off', 'navigation.firstOfficer.ls', false]]),
      ...(family !== 'inibuilds-a350' ? [['squawk zero zero four two', 'surveillance.squawk.set', 42], ['ident', 'surveillance.ident.activate', undefined]] : []),
    ];
    for (const [text, commandId, value] of cases) {
      const match = interpret(text, catalogue);
      assert.equal(match.ok, true, `${profileId}: ${text}: ${JSON.stringify(match)}`);
      assert.equal(match.commandId, commandId); assert.equal(match.input.value, value);
      assert.equal(resolveAircraftCommand({ commandId, input: match.input }, { profile, capabilities }).ok, true);
    }
    for (const text of ['set radio minimums 200', 'set baro minimums 420', 'squawk 1289', 'captain range fifteen', 'ident and squawk 1234']) {
      assert.equal(interpret(text, catalogue).ok, false, `${profileId}: ${text}`);
    }
    assert.equal(interpret('captain range five', catalogue).ok, family === 'pmdg-737');
    assert.equal(interpret('captain range six hundred forty', catalogue).ok, family !== 'fenix-a32x');
    if (family.startsWith('pmdg-')) assert.equal(interpret('captain ls on', catalogue).ok, false);
    if (family === 'inibuilds-a350') assert.equal(interpret('squawk 1234', catalogue).ok, false);
    const local = { ...profile, _profileKey: `local/msfs/${profileId}` };
    assert.equal(buildAircraftControlCapabilities(local, { capabilities }).aircraftCommands.commands.some((c) => c.id === 'navigation.captain.range'), false);
  }
});

function harness(profileId, initial) {
  loader.setActiveProfile(profileId); const config = loader.getAircraftSpecificConfig();
  const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
  let current = true;
  provider._getActiveAircraftIntegrationConfig = () => current ? config : null;
  provider._getMobiFlightHealth = () => ({ connected: true });
  // Windows ownership discovery can take seconds; publish fresh fixtures only
  // after constructing the bridge, so setup time cannot expire the readbacks.
  const bridge = new LvarSidecarBridge(), calls = [];
  const source = { profileId: config.profileKey, enabled: true, status: 'running', values: {}, valueUpdatedAt: {}, snapshotSequence: 1, updatedAt: new Date().toISOString() };
  const key = (id) => config.confirmationFields.find((f) => f.id === id).source.key;
  function publish(id, value, fresh = true) {
    source.values[key(id)] = value; source.snapshotSequence++; source.updatedAt = new Date().toISOString();
    if (fresh) source.valueUpdatedAt[key(id)] = source.updatedAt;
  }
  for (const [id, value] of Object.entries(initial)) publish(id, value);
  for (const name of Object.keys(source.valueUpdatedAt)) source.valueUpdatedAt[name] = new Date(Date.now() - 10).toISOString();
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

test('PMDG and Fenix squawk writes preserve BCO16, require own fresh readback and never retry', async () => {
  for (const profileId of ['pmdg-737', 'pmdg-777', 'fenix-a320']) for (const outcome of ['ok', 'stale', 'wrong', 'profile', 'rejected', 'unpowered']) {
    const fenix = profileId === 'fenix-a320';
    const h = harness(profileId, { 'surveillance.powered': outcome === 'unpowered' ? 0 : fenix ? 1 : 4, 'surveillance.squawk': fenix ? 1200 : 0x1200 });
    h.bridge._sendWithAck = async (message) => {
      h.calls.push(message); h.publish('surveillance.squawk', outcome === 'wrong' ? 0 : fenix ? 42 : 0x0042, outcome !== 'stale');
      if (outcome === 'profile') h.retire(); return { ok: outcome !== 'rejected' };
    };
    const result = await h.run('surveillance.squawk.set', 42);
    assert.equal(result.ok, outcome === 'ok', `${profileId} ${outcome}: ${JSON.stringify(result)}`);
    assert.equal(h.calls.length, outcome === 'unpowered' ? 0 : 1);
    if (h.calls.length) { assert.equal(h.calls[0].name, 'XPNDR_SET'); assert.equal(h.calls[0].value, 0x0042); }
    if (outcome === 'ok') {
      h.provider._aircraftIntegrationActionLastAttemptAt.clear();
      assert.equal((await h.run('surveillance.squawk.set', 42)).noOp, true); assert.equal(h.calls.length, 1);
    }
  }
});

test('IDENT acknowledges one PMDG click or Fenix counter pulse and rejects stale/standby data', async () => {
  for (const profileId of ['pmdg-737', 'pmdg-777', 'fenix-a320']) for (const state of ['ready', 'standby', 'stale', 'profile']) {
    const h = harness(profileId, { 'surveillance.transmitting': state === 'standby' ? 1 : 4 });
    if (state === 'stale') delete h.source.valueUpdatedAt[h.key('surveillance.transmitting')];
    const observe = (message) => { h.calls.push(message); if (state === 'profile') h.retire(); return { ok: true }; };
    h.bridge._sendWithAck = async (message) => observe(message);
    h.bridge.executeMobiFlightCode = async (code) => observe(code);
    const result = await h.run('surveillance.ident.activate');
    assert.equal(result.ok, state === 'ready', `${profileId} ${state}: ${JSON.stringify(result)}`);
    if (state === 'ready') {
      assert.equal(result.transportAcknowledged, true); assert.equal(h.calls.length, 2);
      if (profileId === 'fenix-a320') assert.deepEqual(h.calls, Array(2).fill('(L:S_XPDR_IDENT, Number) ++ (>L:S_XPDR_IDENT, Number)'));
      else assert.deepEqual(h.calls.map((m) => m.value), profileId === 'pmdg-737' ? [80601, 80604] : [74601, 74604]);
    }
    if (['standby', 'stale'].includes(state)) assert.equal(h.calls.length, 0);
    if (state === 'profile' && profileId === 'fenix-a320') assert.equal(h.calls.length, 2, 'accepted counter press still releases once');
  }
});

test('Fenix and A350 range targets confirm independent sides, including leaving airport zoom', async () => {
  for (const [profileId, side, initial, targetRaw, name] of [
    ['fenix-a320', 'captain', 0, 5, 'L:S_FCU_EFIS1_ND_ZOOM'],
    ['fenix-a321', 'firstOfficer', 1, 5, 'L:S_FCU_EFIS2_ND_ZOOM'],
    ['inibuilds-a350-900', 'captain', 4, 10, 'L:INI_MAP_RANGE_CAPT_SWITCH'],
    ['inibuilds-a350-1000', 'firstOfficer', 5, 10, 'L:INI_MAP_RANGE_FO_SWITCH'],
  ]) {
    const field = `navigation.${side}.range`, h = harness(profileId, { [field]: initial });
    h.bridge._sendWithAck = async (message) => { h.calls.push(message); h.publish(field, targetRaw); return { ok: true }; };
    assert.equal((await h.run(`${field}.nm320`)).ok, true);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, name); assert.equal(h.calls[0].value, targetRaw);
  }
});

test('Fenix LS pulses the correct side and confirms its own fresh output without toggling an already set selection', async () => {
  for (const [side, number] of [['captain', 1], ['firstOfficer', 2]]) {
    const field = `navigation.${side}.ls`, h = harness('fenix-a320', { [field]: 0 });
    h.bridge.executeMobiFlightCode = async (code) => {
      h.calls.push(code); if (h.calls.length === 2) h.publish(field, 1); return { ok: true };
    };
    assert.equal((await h.run(`${field}.on`)).ok, true);
    assert.deepEqual(h.calls, Array(2).fill(`(L:S_FCU_EFIS${number}_LS, Number) ++ (>L:S_FCU_EFIS${number}_LS, Number)`));
    h.provider._aircraftIntegrationActionLastAttemptAt.clear();
    assert.equal((await h.run(`${field}.on`)).noOp, true); assert.equal(h.calls.length, 2);
    h.provider._aircraftIntegrationActionLastAttemptAt.clear();
    delete h.source.valueUpdatedAt[h.key(field)];
    assert.equal((await h.run(`${field}.off`)).ok, false); assert.equal(h.calls.length, 2);
  }
});

test('SDK query observations remain live for unchanged ClientData and retire with its generation', () => {
  loader.setActiveProfile('pmdg-777'); const config = loader.getAircraftSpecificConfig();
  const now = Date.now(), field = 'flightGuidance.altitudeFt';
  const sdk = { adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 12,
    updatedAt: new Date(now - 60000).toISOString(), normalized: { automation: { ap: { selected: { altitudeFt: 12000 } } } } };
  const frame = { simconnect: { connected: true }, sdk };
  const state = buildAircraftSpecificState({ config, frame, nowEpochMs: now });
  assert.equal(state.values[field], 12000); assert.equal(state.valueUpdatedAt[field], new Date(now).toISOString());
  for (const patch of [{ snapshotSequence: 0 }, { status: 'disconnected' }, { adapterId: 'wrong' }, { error: 'lost' }]) {
    const invalid = buildAircraftSpecificState({ config, frame: { ...frame, sdk: { ...sdk, ...patch } }, nowEpochMs: now });
    assert.equal(invalid.valueUpdatedAt[field], undefined); assert.ok(invalid.unavailable.includes(field));
  }
});

test('family queries use their own fields, do not advertise unsupported data, and reject old deliveries', async () => {
  const { answerAircraftStateQuery: answer, stateQueryExamples, canQueryAircraftState } = await import('../../frontend/src/voice/state-queries.js');
  const now = Date.now();
  for (const [family, profiles] of Object.entries(families)) for (const profileId of profiles) {
    const altitude = family === 'pmdg-737' ? 'mcp.altitudeFt' : 'flightGuidance.altitudeFt';
    const values = { [altitude]: 13000, 'efis.captain.minimumsMode': 'radio', 'efis.captain.radioMinimumsSet': true, 'efis.captain.radioMinimumsFt': 200 };
    const state = { activeProfileKey: `bundled/msfs/${profileId}`, activeProfileRevision: 4, sourceStatus: 'connected', values, unavailable: [], receivedAt: now,
      updatedAt: new Date(now).toISOString(), valueUpdatedAt: Object.fromEntries(Object.keys(values).map((id) => [id, new Date(now).toISOString()])) };
    const context = { profileKey: state.activeProfileKey, profileRevision: 4 };
    assert.equal(canQueryAircraftState(state), true);
    assert.equal(answer('what is selected altitude', state, context, now).text, 'Selected altitude 13000 feet.');
    assert.equal(answer('what is selected altitude', state, context, now + 2001).ok, false);
    assert.equal(answer('what is selected altitude', state, { ...context, profileRevision: 5 }, now).ok, false);
    assert.equal(answer('what are captain minimums', state, context, now).ok, family === 'pmdg-777');
    if (family === 'pmdg-777') {
      assert.equal(answer('what are captain minimums', state, context, now).text, 'captain radio minimums 200 feet.');
      state.values['efis.captain.radioMinimumsSet'] = false;
      assert.equal(answer('what are captain minimums', state, context, now).text, 'captain radio minimums not set.');
      state.values['efis.captain.radioMinimumsSet'] = true;
      for (const field of ['efis.captain.radioMinimumsSet', 'efis.captain.radioMinimumsFt']) {
        const timestamp = state.valueUpdatedAt[field]; delete state.valueUpdatedAt[field];
        assert.equal(answer('what are captain minimums', state, context, now).ok, false);
        state.valueUpdatedAt[field] = timestamp;
      }
      assert.equal(answer('what are first officer minimums', state, context, now).ok, false, 'captain values cannot answer the other side');
    }
    assert.equal(stateQueryExamples(state).includes('what is com 1 active'), false);
    assert.equal(canQueryAircraftState({ ...state, activeProfileKey: `local/msfs/${profileId}` }), false);
    delete state.valueUpdatedAt[altitude]; assert.equal(answer('what is selected altitude', state, context, now).ok, false);
  }
});
