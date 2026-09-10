import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureA380BaroState, executeA380BaroTransaction } from '../telemetry-provider/a380-baro-control.js';
const { defaultAircraftIntegrationRegistry, createAircraftIntegrationRegistry } = require('./aircraft-integrations');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const loader = require('./aircraft-profile-loader');
const profileKey = 'bundled/msfs/fbw-a380x';

function harness() {
  let time = 10000, active = true;
  const calls: any[] = [], state = { captain: { active: true, std: false, updatedAt: time },
    firstOfficer: { active: true, std: false, updatedAt: time } };
  const params = { target: 'both' as const, capture: () => structuredClone(state), isCurrent: () => active,
    now: () => time, sleep: async (ms) => { time += ms; },
    sendEvent: async (name, value) => {
      calls.push({ name, value }); time++;
      const side = name.includes('_L_') ? 'captain' : 'firstOfficer';
      assert.ok(name.endsWith('_BARO_PUSH'));
      state[side].std = true; state[side].updatedAt = time;
      return { ok: true, sendIds: [10 + calls.length, 20 + calls.length] };
    },
  };
  return { state, calls, params, retire: () => { active = false; },
    run: (overrides = {}) => executeA380BaroTransaction({ ...params, ...overrides }) };
}

test('A380 STD reads each selected active panel and ignores hidden numeric pressure', () => {
  const samples = Object.fromEntries(['captain', 'firstOfficer'].flatMap(side => ['active', 'std'].map(property =>
    [`baro.${side}.${property}`, { observed: property === 'active', updatedAtMs: 10000, fresh: true }])));
  const read = (id) => samples[id];
  assert.equal(captureA380BaroState('both', read, 10000)?.captain.std, false);
  assert.equal(captureA380BaroState('both', read, 12001), null);
  assert.equal(captureA380BaroState('both', read, 9999), null);
  delete samples['baro.firstOfficer.std'];
  assert.equal(captureA380BaroState('both', read, 10000), null);
  assert.ok(captureA380BaroState('captain', read, 10000));
});

test('A380 uses PUSH for both STD controls and repeated requests do not toggle back', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.baro.confirmedSides, ['captain', 'firstOfficer']);
  assert.deepEqual(h.calls, ['L', 'R'].map(side => ({ name: `A32NX.FCU_EFIS_${side}_BARO_PUSH`, value: 0 })));
  assert.equal((await h.run()).noOp, true);
  assert.equal(h.calls.length, 2);
});

test('A380 mixed and single-side settings change only the requested side needing STD', async () => {
  const h = harness(); h.state.captain.std = true;
  assert.equal((await h.run()).ok, true);
  assert.deepEqual(h.calls, [{ name: 'A32NX.FCU_EFIS_R_BARO_PUSH', value: 0 }]);
  for (const target of ['captain', 'firstOfficer']) {
    const single = harness(); assert.equal((await single.run({ target })).ok, true);
    assert.equal(single.calls.length, 1);
    assert.equal(single.state[target === 'captain' ? 'firstOfficer' : 'captain'].std, false);
  }
});

test('A380 linked EFIS feedback can satisfy the other side without another write', async () => {
  const h = harness();
  const result = await h.run({ sendEvent: async (name, value) => {
    const ack = await h.params.sendEvent(name, value);
    h.state.firstOfficer = { ...h.state.captain };
    return ack;
  } });
  assert.equal(result.ok, true); assert.equal(h.calls.length, 1);
});

test('A380 needs newer STD feedback on each changed side and reports partial confirmation without retry', async () => {
  const h = harness();
  const result = await h.run({ sendEvent: async (name, value) => {
    if (name.includes('_L_')) return h.params.sendEvent(name, value);
    h.calls.push({ name, value }); h.state.firstOfficer.std = true; // old timestamp cannot confirm
    return { ok: true };
  } });
  assert.equal(result.ok, false); assert.equal(result.code, 'baro_readback_timeout');
  assert.deepEqual(result.baro.confirmedSides, ['captain']); assert.equal(h.calls.length, 2);
});

test('A380 rejects unavailable panels, failed writes, SimConnect exceptions and retired profiles', async () => {
  const off = harness(); off.state.firstOfficer.active = false;
  assert.equal((await off.run()).code, 'baro_unavailable'); assert.equal(off.calls.length, 0);
  for (const fault of ['ack', 'exception', 'profile', 'power']) {
    const h = harness(); let exception = false;
    const result = await h.run({ findException: (ids) => exception && ids.includes(11) ? { exception: 1 } : null,
      sendEvent: async (name, value) => {
        const ack = await h.params.sendEvent(name, value);
        if (fault === 'ack') return { ok: false };
        if (fault === 'exception') exception = true;
        if (fault === 'profile') h.retire();
        if (fault === 'power') h.state.firstOfficer.active = false;
        return ack;
      } });
    assert.equal(result.ok, false, fault); assert.equal(h.calls.length, 1, fault);
    if (fault === 'profile' || fault === 'exception') assert.deepEqual(result.baro.confirmedSides, [], fault);
  }
});

test('A380 STD manifest is exact-profile scoped and rejects altered event direction or confirmation', () => {
  const source = defaultAircraftIntegrationRegistry.resolveForProfile(profileKey);
  assert.ok(source.actions['baro.both.std']);
  assert.equal(defaultAircraftIntegrationRegistry.resolveForProfile('local/msfs/fbw-a380x'), null);
  for (const change of [action => { action.routes[0].operations[0].name = 'A32NX.FCU_EFIS_L_BARO_PULL'; },
    action => { action.routes[0].readbacks.pop(); }, action => { action.routes[0].baro.operation = 'qnhHpa'; }]) {
    const modified = structuredClone(source); change(modified.actions['baro.both.std']);
    assert.throws(() => createAircraftIntegrationRegistry([modified]), /barometer contract/i);
  }
});

test('real A380 loader and provider use decoded fresh panel fields and share one STD lock', async () => {
  loader.setActiveProfile('fbw-a380x');
  const config = loader.getLvarConfig().aircraftSpecific;
  const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
  provider._getActiveAircraftIntegrationConfig = () => config;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true });
  const snapshot: any = { profileId: profileKey, status: 'running', values: {}, valueUpdatedAt: {}, snapshotSequence: 1,
    updatedAt: new Date().toISOString() };
  const refresh = (side, property, value) => {
    const field = config.confirmationFields.find(field => field.id === `baro.${side}.${property}`);
    snapshot.values[field.source.key] = value;
    snapshot.valueUpdatedAt[field.source.key] = new Date().toISOString();
    snapshot.updatedAt = new Date().toISOString(); snapshot.snapshotSequence++;
  };
  for (const side of ['captain', 'firstOfficer']) { refresh(side, 'active', 1); refresh(side, 'std', 0); }
  let release; const calls = [];
  const bridge = { getSnapshot: () => snapshot, sendEvent: async (name, value) => {
    calls.push({ name, value });
    if (!release) await new Promise(resolve => { release = resolve; });
    await new Promise(resolve => setTimeout(resolve, 2));
    refresh(name.includes('_L_') ? 'captain' : 'firstOfficer', 'std', 1);
    return { ok: true };
  } };
  const run = (actionId) => provider._executeAircraftIntegrationAction(bridge, { name: 'fbw-a380x' }, 'test', {
    profileKey, profileRevision: 1, request: { actionId } });
  const pending = run('baro.both.std');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await run('baro.captain.std')).code, 'action_in_progress');
  release(); const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.baro.confirmedSides, ['captain', 'firstOfficer']); assert.equal(calls.length, 2);
  assert.equal((await run('baro.firstOfficer.std')).code, 'action_cooldown');
});
