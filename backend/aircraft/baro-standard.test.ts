import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureConditionalWriteState, executeConditionalWrites } from './conditional-write-execution.js';
import type { SimConnectSequenceActionRoute } from './integration-engine/types.js';
const { defaultAircraftIntegrationRegistry, createAircraftIntegrationRegistry } = require('./integration-engine');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const loader = require('./aircraft-profile-loader');
const profileKey = 'bundled/msfs/fbw-a380x';
const routeFor = (target = 'both') => defaultAircraftIntegrationRegistry.resolveForProfile(profileKey)
  .actions[`baro.${target}.std`].routes[0];

function harness() {
  let time = 10000, active = true;
  const calls: any[] = [], state = { captain: { ready: true, satisfied: false, updatedAt: time },
    firstOfficer: { ready: true, satisfied: false, updatedAt: time } };
  const params = { capture: () => structuredClone(state), isCurrent: () => active,
    now: () => time, sleep: async (ms) => { time += ms; },
    sendEvent: async (name, value) => {
      calls.push({ name, value }); time++;
      const side = name.includes('_L_') ? 'captain' : 'firstOfficer';
      assert.ok(name.endsWith('_BARO_PUSH'));
      state[side].satisfied = true; state[side].updatedAt = time;
      return { ok: true, sendIds: [10 + calls.length, 20 + calls.length] };
    },
  };
  return { state, calls, params, retire: () => { active = false; },
    run: (overrides: Record<string, any> = {}) => {
      const { target = 'both', ...execution } = overrides;
      return executeConditionalWrites({ ...params, route: routeFor(target), ...execution });
    } };
}

test('A380 STD reads each selected active panel and ignores hidden numeric pressure', () => {
  const samples = Object.fromEntries(['captain', 'firstOfficer'].flatMap(side => ['active', 'std'].map(property =>
    [`baro.${side}.${property}`, { observed: property === 'active', updatedAtMs: 10000, fresh: true }])));
  const read = (id) => samples[id];
  assert.equal(captureConditionalWriteState(routeFor(), read, 10000)?.captain.satisfied, false);
  assert.equal(captureConditionalWriteState(routeFor(), read, 12001), null);
  assert.equal(captureConditionalWriteState(routeFor(), read, 9999), null);
  delete samples['baro.firstOfficer.std'];
  assert.equal(captureConditionalWriteState(routeFor(), read, 10000), null);
  assert.ok(captureConditionalWriteState(routeFor('captain'), read, 10000));
});

test('conditional execution uses declared associations and preserves false and zero expectations', async () => {
  // Direct engine-unit fixture: these neutral associations are not an additional
  // registered aircraft recipe. The registry still authorizes only reviewed STD routes.
  let time = 10000;
  const route: SimConnectSequenceActionRoute = {
    id: 'test.outputs.reset', transport: 'simconnect-sequence',
    operations: [{ type: 'event', name: 'RESET_CHANNEL_BETA', value: 2 },
      { type: 'event', name: 'RESET_CHANNEL_ALPHA', value: 0 }],
    conditionalWrites: { freshnessMs: 1200, targets: [
      { id: 'alpha', operationIndex: 0, prerequisiteFieldIds: ['test.alphaLocked'], readbackFieldId: 'test.enabled' },
      { id: 'beta', operationIndex: 1, prerequisiteFieldIds: ['test.betaLocked'], readbackFieldId: 'test.count' },
    ] },
    readbacks: [
      { fieldId: 'test.alphaLocked', expectedValue: false, timeoutMs: 250, freshness: 'field' as const },
      { fieldId: 'test.enabled', expectedValue: false, timeoutMs: 250, freshness: 'field' as const },
      { fieldId: 'test.betaLocked', expectedValue: false, timeoutMs: 250, freshness: 'field' as const },
      { fieldId: 'test.count', expectedValue: 0, timeoutMs: 250, freshness: 'field' as const },
    ],
  };
  const observations: Record<string, { observed: unknown; fresh: boolean; updatedAtMs: number }> = {
    'test.alphaLocked': { observed: false, fresh: true, updatedAtMs: time },
    'test.betaLocked': { observed: false, fresh: true, updatedAtMs: time },
    'test.enabled': { observed: true, fresh: true, updatedAtMs: time },
    'test.count': { observed: 2, fresh: true, updatedAtMs: time },
  };
  const capture = () => captureConditionalWriteState(route, id => observations[id], time);
  assert.deepEqual(capture(), { alpha: { ready: true, satisfied: false, updatedAt: time },
    beta: { ready: true, satisfied: false, updatedAt: time } });
  observations['test.count'].observed = '0';
  assert.equal(capture(), null, 'numeric-looking text cannot satisfy a numeric observation');
  observations['test.count'].observed = 2;
  const calls = [];
  const run = () => executeConditionalWrites({ route, capture, isCurrent: () => true,
    now: () => time, sleep: async ms => { time += ms; }, sendEvent: async (name, value) => {
      calls.push({ name, value }); time++;
      const field = name === 'RESET_CHANNEL_BETA' ? 'test.enabled' : 'test.count';
      observations[field] = { observed: field === 'test.enabled' ? false : 0, fresh: true, updatedAtMs: time };
      return { ok: true };
    } });
  assert.deepEqual(await run(), { ok: true, code: 'executed', executionStarted: true, noOp: false,
    confirmedTargets: ['alpha', 'beta'] });
  assert.deepEqual(calls, [{ name: 'RESET_CHANNEL_BETA', value: 2 }, { name: 'RESET_CHANNEL_ALPHA', value: 0 }]);
  assert.equal((await run()).noOp, true);
  assert.equal(calls.length, 2);
});

test('A380 uses PUSH for both STD controls and repeated requests do not toggle back', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.confirmedTargets, ['captain', 'firstOfficer']);
  assert.deepEqual(h.calls, ['L', 'R'].map(side => ({ name: `A32NX.FCU_EFIS_${side}_BARO_PUSH`, value: 0 })));
  assert.equal((await h.run()).noOp, true);
  assert.equal(h.calls.length, 2);
});

test('A380 mixed and single-side settings change only the requested side needing STD', async () => {
  const h = harness(); h.state.captain.satisfied = true;
  assert.equal((await h.run()).ok, true);
  assert.deepEqual(h.calls, [{ name: 'A32NX.FCU_EFIS_R_BARO_PUSH', value: 0 }]);
  for (const target of ['captain', 'firstOfficer']) {
    const single = harness(); assert.equal((await single.run({ target })).ok, true);
    assert.equal(single.calls.length, 1);
    assert.equal(single.state[target === 'captain' ? 'firstOfficer' : 'captain'].satisfied, false);
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
    h.calls.push({ name, value }); h.state.firstOfficer.satisfied = true; // old timestamp cannot confirm
    return { ok: true };
  } });
  assert.equal(result.ok, false); assert.equal(result.code, 'readback_timeout');
  assert.deepEqual(result.confirmedTargets, ['captain']); assert.equal(h.calls.length, 2);
});

test('a selected field becoming stale after the first write prevents the second write and any confirmation', async () => {
  for (const staleField of ['baro.firstOfficer.active', 'baro.firstOfficer.std']) {
    let time = 10000;
    const route = routeFor();
    const samples = Object.fromEntries(['captain', 'firstOfficer'].flatMap(side => ['active', 'std'].map(property =>
      [`baro.${side}.${property}`, { observed: property === 'active', updatedAtMs: time, fresh: true }])));
    const calls = [];
    const result = await executeConditionalWrites({ route, isCurrent: () => true,
      capture: () => captureConditionalWriteState(route, id => samples[id], time),
      now: () => time, sleep: async ms => { time += ms; }, sendEvent: async (name, value) => {
        calls.push({ name, value }); time++;
        samples['baro.captain.std'] = { observed: true, updatedAtMs: time, fresh: true };
        samples[staleField].fresh = false;
        return { ok: true };
      } });
    assert.equal(result.code, 'unavailable', staleField);
    assert.deepEqual(result.confirmedTargets, [], staleField);
    assert.deepEqual(calls, [{ name: 'A32NX.FCU_EFIS_L_BARO_PUSH', value: 0 }]);
  }
});

test('A380 rejects unavailable panels, failed writes, SimConnect exceptions and retired profiles', async () => {
  const off = harness(); off.state.firstOfficer.ready = false;
  assert.equal((await off.run()).code, 'unavailable'); assert.equal(off.calls.length, 0);
  for (const fault of ['ack', 'exception', 'profile', 'power']) {
    const h = harness(); let exception = false;
    const result = await h.run({ findException: (ids) => exception && ids.includes(11) ? { exception: 1 } : null,
      sendEvent: async (name, value) => {
        const ack = await h.params.sendEvent(name, value);
        if (fault === 'ack') return { ok: false };
        if (fault === 'exception') exception = true;
        if (fault === 'profile') h.retire();
        if (fault === 'power') h.state.firstOfficer.ready = false;
        return ack;
      } });
    assert.equal(result.ok, false, fault); assert.equal(h.calls.length, 1, fault);
    if (fault === 'profile' || fault === 'exception') assert.deepEqual(result.confirmedTargets, [], fault);
  }
});

test('A380 STD ships the independently reviewed PUSH mapping and remains exact-profile scoped', () => {
  const source = defaultAircraftIntegrationRegistry.resolveForProfile(profileKey);
  assert.equal(defaultAircraftIntegrationRegistry.resolveForProfile('local/msfs/fbw-a380x'), null);
  // A380X's published API selects STD with PUSH; A32NX uses the reverse.
  // Keep this independent expected mapping outside the generalized registry.
  const sides = { captain: ['L'], firstOfficer: ['R'], both: ['L', 'R'] };
  for (const [target, letters] of Object.entries(sides)) {
    const action = source.actions[`baro.${target}.std`];
    assert.deepEqual(action.routes[0].operations,
      letters.map(side => ({ type: 'event', name: `A32NX.FCU_EFIS_${side}_BARO_PUSH`, value: 0 })));
    assert.deepEqual(action.guard, { groupId: 'fbwA380x.baro', cooldownMs: 750, retry: 'never' });
  }
});

test('conditional STD contracts reject missing, ambiguous or unrelated operations and observations', () => {
  const source = defaultAircraftIntegrationRegistry.resolveForProfile(profileKey);
  for (const change of [
    action => { action.routes[0].readbacks.pop(); },
    action => { action.routes[0].baro.operation = 'qnhHpa'; },
    action => { action.routes[0].baro.target = 'captain'; },
    action => { delete action.routes[0].conditionalWrites; },
    action => { action.routes[0].conditionalWrites.targets[1].operationIndex = 0; },
    action => { action.routes[0].conditionalWrites.targets[0].operationIndex = 2; },
    action => { action.routes[0].conditionalWrites.targets[0].prerequisiteFieldIds = ['baro.firstOfficer.active']; },
    action => { action.routes[0].conditionalWrites.targets[0].readbackFieldId = 'baro.firstOfficer.std'; },
    action => { action.routes[0].conditionalWrites.targets[0].id = 'unexpected'; },
    action => { action.routes[0].readbacks[0].expectedValue = false; },
    action => { delete action.routes[0].readbacks[0].freshness; },
    action => { action.routes[0].operations[0] = { type: 'event', name: 'A32NX.FCU_EFIS_L_BARO_PUSH', inputValue: { source: 'input' } }; },
  ]) {
    const modified = structuredClone(source); change(modified.actions['baro.both.std']);
    assert.throws(() => createAircraftIntegrationRegistry([modified]), /barometer|conditional|sequence|input/i);
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
