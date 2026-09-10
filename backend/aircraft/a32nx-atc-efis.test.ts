const test = require('node:test');
const assert = require('node:assert/strict');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const { LvarSidecarBridge } = require('../telemetry-provider/lvar-sidecar-bridge');
const { resolveAircraftCommand, buildAircraftControlCapabilities } = require('./aircraft-control-service');
const { encodeSquawkBco16, decodeSquawkBco16 } = require('../utils/transponder-code');
const { buildAircraftSpecificState } = require('./aircraft-specific-state');
const loader = require('./aircraft-profile-loader');
const PROFILE_KEY = 'bundled/msfs/fbw-a32nx';

function harness(initial = {}) {
  loader.setActiveProfile('fbw-a32nx');
  const config = loader.getAircraftSpecificConfig();
  const provider = new SimConnectTelemetryProvider();
  // Resolve bridge ownership before dating the synthetic telemetry.
  const bridge = new LvarSidecarBridge();
  provider._connected = true; provider._simRunning = true;
  let current = true;
  provider._getActiveAircraftIntegrationConfig = () => current ? config : null;
  const source = { profileId: PROFILE_KEY, enabled: true, status: 'running', values: {}, valueUpdatedAt: {},
    snapshotSequence: 1, updatedAt: new Date().toISOString() };
  const key = (id) => config.confirmationFields.find((f) => f.id === id).source.key;
  const publish = (id, raw, advance = true) => {
    source.values[key(id)] = raw; source.snapshotSequence++;
    source.updatedAt = new Date().toISOString();
    if (advance) source.valueUpdatedAt[key(id)] = source.updatedAt;
  };
  for (const [id, raw] of Object.entries({ 'surveillance.powered': 4, 'surveillance.transmitting': 4,
    'surveillance.squawk': 0x1200, 'surveillance.ident': 0, 'baro.healthy': 1,
    'navigation.lsCaptain': 0, 'navigation.lsFirstOfficer': 0, 'navigation.ndCaptainRange': 0, ...initial })) publish(id, raw);
  for (const name of Object.keys(source.valueUpdatedAt)) source.valueUpdatedAt[name] = new Date(Date.now() - 10).toISOString();
  const calls = [];
  bridge.getSnapshot = () => source;
  bridge._sendWithAck = async (message) => { calls.push(message); return { ok: true }; };
  const wait = provider._waitForAircraftIntegrationReadback.bind(provider);
  provider._waitForAircraftIntegrationReadback = (b, r, c, base) => wait(b, { ...r, timeoutMs: 25 }, c, base);
  const run = (actionId, value?) => provider._executeAircraftIntegrationAction(bridge, { name: 'fbw-a32nx' }, 'test', {
    profileKey: PROFILE_KEY, profileRevision: config.profileRevision, request: { actionId, ...(value === undefined ? {} : { value }) },
  });
  return { provider, bridge, source, calls, key, publish, run, config, retire: () => { current = false; } };
}

test('all 4096 four-digit octal codes round trip, and invalid BCO16/digits never encode', () => {
  for (let n = 0; n < 4096; n++) {
    const logical = Number(n.toString(8));
    assert.equal(decodeSquawkBco16(encodeSquawkBco16(logical)), logical);
  }
  for (const n of [-1, 8, 1289, 8000, 42.1, NaN, Infinity, '0042', null]) assert.equal(encodeSquawkBco16(n), null);
  for (const n of [-1, 0x8, 0x7a00, 0x10000, 1.1, null]) assert.equal(decodeSquawkBco16(n), undefined);
});

test('squawk and IDENT use exact events, fresh confirmation, no-op and no retries', async () => {
  for (const [action, value, field, raw, name, payload] of [
    ['surveillance.squawk.set', 42, 'surveillance.squawk', 0x0042, 'XPNDR_SET', 0x0042],
    ['surveillance.ident.activate', undefined, 'surveillance.ident', 1, 'XPNDR_IDENT_ON', 0],
    ['navigation.lsCaptain.on', undefined, 'navigation.lsCaptain', 1, 'A32NX.FCU_EFIS_L_LS_PUSH', 0],
    ['navigation.lsFirstOfficer.on', undefined, 'navigation.lsFirstOfficer', 1, 'A32NX.FCU_EFIS_R_LS_PUSH', 0],
    ['navigation.ndCaptainRange.nm320', undefined, 'navigation.ndCaptainRange', 5, 'L:A32NX_FCU_EFIS_L_EFIS_RANGE', 5],
  ]) {
    const h = harness();
    h.bridge._sendWithAck = async (message) => { h.calls.push(message); h.publish(field, raw); return { ok: true }; };
    const result = await h.run(action, value);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, name); assert.equal(h.calls[0].value, payload);
    h.provider._aircraftIntegrationActionLastAttemptAt.clear();
    assert.equal((await h.run(action, value)).noOp, true); assert.equal(h.calls.length, 1);
  }
});

test('unpowered, standby IDENT, stale individual samples and invalid squawks dispatch nothing', async () => {
  for (const [action, value, field, raw, stale] of [
    ['surveillance.squawk.set', 42, 'surveillance.powered', 0, false],
    ['surveillance.ident.activate', undefined, 'surveillance.transmitting', 1, false],
    ['navigation.lsCaptain.on', undefined, 'baro.healthy', 0, false],
    ['surveillance.squawk.set', 42, 'surveillance.squawk', 0x1200, true],
    ['surveillance.ident.activate', undefined, 'surveillance.transmitting', 4, true],
    ['navigation.lsCaptain.on', undefined, 'navigation.lsCaptain', 0, true],
    ['surveillance.squawk.set', 1289, 'surveillance.squawk', 0x1200, false],
  ]) {
    const h = harness(); h.publish(field, raw);
    if (stale) delete h.source.valueUpdatedAt[h.key(field)];
    assert.equal((await h.run(action, value)).ok, false, String(action)); assert.equal(h.calls.length, 0);
  }
});

test('post-dispatch profile loss, rejection or an old field cannot confirm IDENT or LS', async () => {
  for (const [action, field] of [['surveillance.ident.activate', 'surveillance.ident'], ['navigation.lsCaptain.on', 'navigation.lsCaptain']]) {
    for (const failure of ['profile', 'reject', 'old-field', 'wrong-value']) {
      const h = harness();
      h.bridge._sendWithAck = async (message) => {
        h.calls.push(message); h.publish(field, failure === 'wrong-value' ? 0 : 1, failure !== 'old-field');
        if (failure === 'profile') h.retire();
        return { ok: failure !== 'reject' };
      };
      assert.equal((await h.run(action)).ok, false); assert.equal(h.calls.length, 1);
    }
  }
});

test('new canonical commands are A32NX-only, validate digits and keep minimums transport explicit', () => {
  loader.setActiveProfile('fbw-a32nx'); const profile = loader.getActiveProfile();
  const capabilities = { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence', 'lvar', 'simbridge-mcdu'] };
  for (const [commandId, value, actionId] of [
    ['surveillance.squawk.set', 42, 'surveillance.squawk.set'],
    ['navigation.captain.range', '160', 'navigation.ndCaptainRange.nm160'],
    ['navigation.firstOfficer.ls', false, 'navigation.lsFirstOfficer.off'],
    ['approach.minimums.baro', 420, 'approach.minimums.baro'],
  ]) {
    const result = resolveAircraftCommand({ commandId, input: { value } }, { profile, capabilities });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.controlRequest.actionId, actionId);
  }
  assert.equal(resolveAircraftCommand({ commandId: 'surveillance.squawk.set', input: { value: 1289 } }, { profile, capabilities }).ok, false);
  const local = { ...profile, _profileKey: 'local/msfs/fbw-a32nx' };
  const commands = buildAircraftControlCapabilities(local, { capabilities }).aircraftCommands.commands;
  assert.equal(commands.some((c) => c.id === 'approach.minimums.baro' || c.id === 'surveillance.squawk.set'), false);
});

test('logical state preserves per-field observation times without borrowing unrelated freshness', () => {
  const h = harness(); delete h.source.valueUpdatedAt[h.key('surveillance.ident')];
  const state = buildAircraftSpecificState({ config: h.config, frame: { simconnect: { connected: true }, lvars: h.source } });
  assert.equal(state.values['surveillance.squawk'], 1200);
  assert.equal(state.valueUpdatedAt['surveillance.squawk'], h.source.valueUpdatedAt[h.key('surveillance.squawk')]);
  assert.equal(state.valueUpdatedAt['surveillance.ident'], undefined);
});

export {};
