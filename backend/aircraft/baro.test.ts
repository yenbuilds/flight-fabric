const test = require('node:test');
const assert = require('node:assert/strict');
const { captureStagedControlState, executeStagedControl } = require('./staged-control-execution');
const { defaultAircraftIntegrationRegistry, createAircraftIntegrationRegistry } = require('./integration-engine');
const { buildAircraftControlCapabilities } = require('./aircraft-control-service');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const { LvarSidecarBridge } = require('../telemetry-provider/lvar-sidecar-bridge');
const loader = require('./aircraft-profile-loader');
const PROFILE = { id: 'fbw-a32nx', simulator: 'msfs', _profileKey: 'bundled/msfs/fbw-a32nx',
  integration: { aircraftSpecific: { adapter: 'fbw-a32nx' }, controls: { genericFallback: false } } };
const capabilities = { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence'] };

// Independent simulator fixture conversions and logical field names, not imported authoring helpers.
const BARO_HPA_PER_INHG = 33.863886666667;
const baroField = (side, property) => property === 'unitInHg'
  ? `flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}` : `baro.${side}.${property}`;
const routeFor = (target, operation) => defaultAircraftIntegrationRegistry.resolveForProfile(PROFILE._profileKey)
  .actions[`baro.${target}.${operation}`].routes[0];

// Exercise the neutral engine with the existing independent physical fixtures.
// Exact public response adaptation remains covered by unchanged provider parity tests.
async function executeRecipe(params) {
  const route = routeFor(params.target, params.operation);
  return executeStagedControl({ ...params, recipe: route.stagedControl, capture: () => {
    const state = params.capture();
    return state && { available: state.healthy, targets: Object.fromEntries(Object.entries(state.sides).map(([id, s]: [string, any]) =>
      [id, { values: { mode: s.mode, valueMode: s.valueMode, value: s.value, unitInHg: s.unitInHg }, times: s.updatedAt }])) };
  }, write: (id, key) => {
    const op = route.operations[route.stagedControl.targets.find(t => t.id === id).writes[key]];
    const value = op.inputValue ? Math.round(params.value * op.inputValue.scale) : op.value;
    return op.type === 'event' ? params.sendEvent(op.name, value) : params.setNamedVar({ name: op.name, unit: op.unit, value });
  } });
}

function harness() {
  let time = 1000, active = true;
  const calls: any[] = [];
  const state = { healthy: true, sides: Object.fromEntries(['captain', 'firstOfficer'].map((side) => [side,
    { mode: 1, valueMode: 1, unitInHg: false, value: 1013, updatedAt: { mode: time, valueMode: time, unitInHg: time, value: time } }])) };
  const params = { target: 'both', operation: 'qnhHpa', value: 1016,
    capture: () => structuredClone(state), isCurrent: () => active, now: () => time,
    sleep: async (ms) => {
      time += ms;
      // Mode polling continues even when an unlinked side has not changed.
      for (const side of ['captain', 'firstOfficer']) state.sides[side].updatedAt.mode = time;
    },
    sendEvent: async (name, value) => {
      calls.push({ name, value }); time++;
      const s = state.sides[name.includes('_L_') ? 'captain' : 'firstOfficer'];
      if (name.endsWith('_SET')) { s.value = Math.round(value / 16 * (s.unitInHg ? 100 / BARO_HPA_PER_INHG : 1)) / (s.unitInHg ? 100 : 1); s.updatedAt.value = time; }
      else { s.mode = name.endsWith('_PULL') ? 0 : s.mode === 0 ? 2 : s.mode === 2 ? 1 : 2;
        s.valueMode = s.mode === 0 ? 0 : s.unitInHg ? 2 : 1; s.updatedAt.mode = s.updatedAt.valueMode = time; }
      return { ok: true, sendIds: [calls.length + 100, calls.length] };
    },
    setNamedVar: async ({ name, value }) => {
      calls.push({ name, value }); time++;
      const s = state.sides[name.includes('_L_') ? 'captain' : 'firstOfficer'];
      s.value = Math.round(s.value * (value ? 100 / BARO_HPA_PER_INHG : BARO_HPA_PER_INHG)) / (value ? 100 : 1);
      s.unitInHg = Boolean(value); s.valueMode = s.mode === 0 ? 0 : value ? 2 : 1;
      s.updatedAt.unitInHg = s.updatedAt.valueMode = s.updatedAt.value = time;
      return { ok: true };
    },
  };
  return { params, state, calls, advance: (ms) => { time += ms; },
    run: (overrides = {}) => executeRecipe({ ...params, ...overrides }), retire: () => { active = false; } };
}

test('neutral staged recipe consumes explicit false/zero values, confirmed transitions and single increments', async () => {
  const { hasValidStagedControl } = require('./staged-control-contract');
  const conditions = [{ property: 'enabled', equals: false }, { property: 'setting', equals: 1 }, { property: 'count', input: true, scale: 1 }];
  const recipe = {
    sampling: 'raw', freshnessMs: 2000, prerequisites: [{ fieldId: 'utility.inhibit', type: 'boolean01', equals: false }],
    targets: ['alpha', 'beta'].map((id, index) => ({ id, observations: {
      enabled: { fieldId: `utility.${id}.enabled`, type: 'boolean01' },
      setting: { fieldId: `utility.${id}.setting`, type: 'enum', values: [0, 1, 2] },
      count: { fieldId: `utility.${id}.count`, type: 'number' },
    }, writes: { disable: index * 4, select: index * 4 + 1, minus: index * 4 + 2, plus: index * 4 + 3 } })),
    input: { min: 0, max: 10, step: 1, scale: 1, validation: 'scaled-integer' },
    stages: [
      { kind: 'ensure', phase: 'configuration', property: 'enabled', conditions: [conditions[0]], write: 'disable', confirmation: 'affected', invalidate: 'count',
        freeze: { conditions: [conditions[0]], message: 'Configuration changed.' } },
      { kind: 'transition', phase: 'selection', property: 'setting', conditions: [conditions[1]], write: 'select', maxTransitions: 2,
        completion: [conditions[1]], invalidate: 'count', freeze: { conditions: [conditions[1]], message: 'Selection changed.' } },
      { kind: 'step', phase: 'quantity', property: 'count', conditions: [conditions[2]], decrease: 'minus', increase: 'plus', scale: 1, min: 0, max: 10, maxSteps: 11 },
    ], final: conditions, timing: { readbackTimeoutMs: 2500, pollMs: 50, totalTimeoutMs: 25000 },
    errors: Object.fromEntries(['staleContext', 'failed', 'unavailable', 'transportRejected', 'writeRejected', 'invalidInput', 'timeout',
      'timeLimit', 'finalChanged', 'outOfRange', 'missingValue', 'unexpectedStep', 'valueChanged'].map(key => [key, `${key}: {phase}`])),
  };
  const fields = Object.fromEntries(['utility.inhibit', ...recipe.targets.flatMap(t => Object.values(t.observations).map(o => o.fieldId))].map(id => [id, { id }]));
  const route = { stagedControl: recipe, transport: 'mobiflight-calculator', mode: 'staged-control', codes: Array.from({ length: 8 }, (_, i) => `write ${i}`),
    readbacks: [{ fieldId: 'utility.inhibit', expectedValue: false, timeoutMs: 2500 }, ...recipe.targets.flatMap(t => conditions.map(c => ({
      fieldId: t.observations[c.property].fieldId, ...(c.input ? { expectedInput: true } : { expectedValue: c.equals }), timeoutMs: 2500,
    })))],
  };
  assert.equal(hasValidStagedControl({ fields }, { guard: { retry: 'never' }, input: { type: 'number', min: 0, max: 10, step: 1 } }, route), true);
  let now = 1000;
  const states = Object.fromEntries(recipe.targets.map(t => [t.id, { enabled: true, setting: 0, count: 2 }]));
  const calls = [];
  const capture = () => captureStagedControlState(recipe, { decoded: () => null, raw: field => {
    const [, id, property] = field.split('.');
    return { value: field === 'utility.inhibit' ? 0 : states[id][property], updatedAt: new Date(now).toISOString() };
  } }, now);
  const result = await executeStagedControl({ recipe, value: 0, isCurrent: () => true, capture, now: () => now,
    sleep: async ms => { now += ms; }, write: async (id, key) => {
      calls.push([id, key]); now++;
      if (key === 'disable') states[id].enabled = false;
      if (key === 'select') states[id].setting = states[id].setting === 0 ? 2 : 1;
      if (key === 'minus') states[id].count--;
      return { ok: true };
    } });
  assert.deepEqual(result, { ok: true, code: 'executed', confirmedTargets: ['alpha', 'beta'] });
  assert.deepEqual(calls, [['alpha', 'disable'], ['beta', 'disable'], ['alpha', 'select'], ['beta', 'select'],
    ['alpha', 'select'], ['beta', 'select'], ['alpha', 'minus'], ['beta', 'minus'], ['alpha', 'minus'], ['beta', 'minus']]);
  assert.deepEqual(states, { alpha: { enabled: false, setting: 1, count: 0 }, beta: { enabled: false, setting: 1, count: 0 } });
});

test('barometer samples require fresh independent timestamps, valid modes, units and FCU health', () => {
  const samples: any = { 'baro.healthy': { value: 1, updatedAt: new Date(1000).toISOString() } };
  for (const side of ['captain', 'firstOfficer']) for (const [p, value] of Object.entries({ mode: 1, valueMode: 1, value: 1013, unitInHg: 0 })) {
    samples[baroField(side, p)] = { value, updatedAt: new Date(1000).toISOString() };
  }
  const capture = (target = 'both', now = 1000) => captureStagedControlState(routeFor(target, 'qnhHpa').stagedControl,
    { raw: (id) => samples[id], decoded: () => null }, now);
  assert.equal(capture().available, true);
  assert.equal(capture('both', 3001), null); assert.equal(capture('both', 999), null);
  samples['baro.firstOfficer.mode'].updatedAt = null;
  assert.equal(capture(), null); assert.ok(capture('captain'));
  samples['baro.captain.mode'].value = 3; assert.equal(capture('captain'), null);
  samples['baro.captain.mode'].value = 1; samples['baro.healthy'].value = 0; assert.equal(capture('captain').available, false);
});

test('both pressure writes are dispatched before waiting and each selected side confirms', async () => {
  const h = harness(), queued = [];
  const result = await h.run({ sendEvent: async (name, value) => { queued.push({ name, value }); return { ok: true }; },
    sleep: async (ms) => { assert.equal(queued.length, 2); for (const item of queued.splice(0)) await h.params.sendEvent(item.name, item.value); await h.params.sleep(ms); } });
  assert.equal(result.ok, true); assert.deepEqual(result.confirmedTargets, ['captain', 'firstOfficer']);
  assert.deepEqual(h.calls, ['L', 'R'].map((s) => ({ name: `A32NX.FCU_EFIS_${s}_BARO_SET`, value: 16256 })));
  assert.equal((await h.run()).noOp, true); assert.equal(h.calls.length, 2);
});

test('captain and first officer requests remain independent; inHg conversion has exact displayed confirmation', async () => {
  for (const target of ['captain', 'firstOfficer']) {
    const h = harness(); assert.equal((await h.run({ target, operation: 'qnhInHg', value: 30.12 })).ok, true);
    assert.equal(h.state.sides[target].value, 30.12);
    assert.equal(h.state.sides[target === 'captain' ? 'firstOfficer' : 'captain'].value, 1013);
    assert.equal(h.calls.at(-1).value, Math.round(30.12 * BARO_HPA_PER_INHG * 16));
    assert.deepEqual(h.calls.map((c) => c.name.split('_').at(-1)), ['INHG', 'SET']);
  }
});

test('leaving STD confirms remembered QFE before a separate QNH push; existing QNH is never pushed', async () => {
  const h = harness(); h.state.sides.captain.mode = h.state.sides.captain.valueMode = 0;
  h.state.sides.firstOfficer.mode = 2;
  assert.equal((await h.run()).ok, true);
  assert.deepEqual(h.calls.filter((c) => c.name.endsWith('PUSH')).map((c) => c.name),
    ['A32NX.FCU_EFIS_L_BARO_PUSH', 'A32NX.FCU_EFIS_R_BARO_PUSH', 'A32NX.FCU_EFIS_L_BARO_PUSH']);
  const qnh = harness(); await qnh.run(); assert.equal(qnh.calls.some((c) => c.name.endsWith('PUSH')), false);
});

test('STD pulls both sides once and is idempotent, with no pressure or unit changes', async () => {
  const h = harness(); assert.equal((await h.run({ operation: 'std' })).ok, true);
  assert.deepEqual(h.calls, ['L', 'R'].map((s) => ({ name: `A32NX.FCU_EFIS_${s}_BARO_PULL`, value: 0 })));
  assert.equal((await h.run({ operation: 'std' })).noOp, true);
});

test('QNH pushes wait for delayed mode observations on each side before another possibly linked input', async () => {
  for (const linked of [false, true]) for (const mode of [0, 2]) {
    const h = harness(), sides = ['captain', 'firstOfficer'], queued = [];
    const physical = Object.fromEntries(sides.map((side) => [side, { mode, value: 1013 }]));
    for (const side of sides) {
      h.state.sides[side].mode = mode;
      h.state.sides[side].valueMode = mode === 0 ? 0 : 1;
    }
    let poll = 0;
    const result = await h.run({
      sendEvent: async (name, value) => { h.calls.push({ name, value }); queued.push({ name, value }); return { ok: true }; },
      sleep: async (ms) => {
        h.advance(ms);
        for (const { name, value } of queued.splice(0)) {
          const target = name.includes('_L_') ? 'captain' : 'firstOfficer';
          for (const side of linked ? sides : [target]) {
            if (name.endsWith('_PUSH')) physical[side].mode = physical[side].mode === 2 ? 1 : 2;
            else if (name.endsWith('_SET')) physical[side].value = Math.round(value / 16);
          }
        }
        // ACK precedes the aircraft update. Captain and FO observations arrive
        // in separate polls even when the physical altimeters are linked.
        const side = sides[poll++ % sides.length], state = h.state.sides[side];
        state.mode = physical[side].mode; state.valueMode = state.mode === 0 ? 0 : 1;
        state.value = physical[side].value;
        state.updatedAt.mode = state.updatedAt.valueMode = state.updatedAt.value = h.params.now();
      },
    });
    assert.equal(result.ok, true, `${linked}/${mode}: ${JSON.stringify(result)}`);
    assert.ok(sides.every((side) => physical[side].mode === 1 && physical[side].value === 1016));
    assert.equal(h.calls.filter((call) => call.name.endsWith('_PUSH')).length,
      (linked ? 1 : 2) * (mode === 0 ? 2 : 1), 'every push must make progress without toggling linked QNH back to QFE');
  }
});

test('QNH cannot confirm cached pressure digits from before leaving STD or QFE, including linked modes', async () => {
  for (const mode of [0, 2]) for (const linked of [false, true]) for (const refresh of ['neither', 'captain', 'both']) {
    const h = harness();
    for (const side of ['captain', 'firstOfficer']) {
      h.state.sides[side].mode = mode;
      h.state.sides[side].valueMode = mode === 0 ? 0 : 1;
      h.state.sides[side].value = 1016;
    }
    const result = await h.run({ sendEvent: async (name, value) => {
      const side = name.includes('_L_') ? 'captain' : 'firstOfficer';
      const previousTime = h.state.sides[side].updatedAt.value;
      const ack = await h.params.sendEvent(name, value);
      if (name.endsWith('_PUSH') && linked) {
        const peer = h.state.sides[side === 'captain' ? 'firstOfficer' : 'captain'];
        peer.mode = h.state.sides[side].mode;
        peer.valueMode = h.state.sides[side].valueMode;
        peer.updatedAt.mode = peer.updatedAt.valueMode = h.state.sides[side].updatedAt.mode;
      }
      // Mode observations advance independently of pressure. A matching old
      // pressure remains cached even if the later SET is never observed.
      if (name.endsWith('_SET') && refresh !== 'both' && refresh !== side) {
        h.state.sides[side].updatedAt.value = previousTime;
      }
      return ack;
    } });
    assert.equal(result.ok, refresh === 'both', `${mode}/${linked}/${refresh}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.confirmedTargets, refresh === 'both' ? ['captain', 'firstOfficer']
      : refresh === 'captain' ? ['captain'] : []);
    assert.equal(h.calls.filter((call) => call.name.endsWith('_SET')).length, 2,
      'each side needs a pressure write or a fresh pressure observation after its mode change');
  }
});

test('a newer QNH observation on one side cannot authorize a push from an older linked peer observation', async () => {
  const h = harness();
  h.state.sides.captain.updatedAt.mode = 1001;
  h.advance(1);
  h.state.sides.firstOfficer.mode = 2;
  for (const side of ['captain', 'firstOfficer']) h.state.sides[side].value = 1016;
  const result = await h.run({ sleep: async (ms) => {
    h.advance(ms);
    const peer = h.state.sides.firstOfficer;
    peer.mode = 1;
    peer.updatedAt.mode = peer.updatedAt.value = h.params.now();
  } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.noOp, true);
  assert.deepEqual(h.calls, [], 'the delayed peer observation already satisfies the target');
});

test('missing peer mode observations stop a QNH request before another possibly linked push', async () => {
  const h = harness();
  for (const side of ['captain', 'firstOfficer']) h.state.sides[side].mode = 2;
  const result = await h.run({ sleep: async (ms) => { h.advance(ms); } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'readback_timeout');
  assert.deepEqual(h.calls.map((call) => call.name), ['A32NX.FCU_EFIS_L_BARO_PUSH']);
});

test('fresh pressure after a mode transition skips an unnecessary pressure setter', async () => {
  const h = harness();
  for (const side of ['captain', 'firstOfficer']) h.state.sides[side].mode = 2;
  const result = await h.run({ sendEvent: async (name, value) => {
    const ack = await h.params.sendEvent(name, value);
    const side = h.state.sides[name.includes('_L_') ? 'captain' : 'firstOfficer'];
    side.value = 1016; side.updatedAt.value = h.params.now();
    return ack;
  } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.calls.map((call) => call.name.split('_').at(-1)), ['PUSH', 'PUSH']);
});

test('one responding altimeter cannot report both success; absent and old readbacks never retry', async () => {
  for (const operation of ['qnhHpa', 'std']) {
    const h = harness(); const result = await h.run({ operation, sendEvent: async (name, value) => {
      if (name.includes('_L_')) return h.params.sendEvent(name, value);
      h.calls.push({ name, value }); return { ok: true };
    } });
    assert.equal(result.ok, false); assert.equal(result.code, 'readback_timeout');
    assert.deepEqual(result.confirmedTargets, ['captain']); assert.equal(h.calls.length, 2);
  }
  const h = harness(); h.state.sides.captain.mode = h.state.sides.captain.valueMode = 0;
  assert.equal((await h.run({ sendEvent: async (name, value) => { h.calls.push({ name, value }); return { ok: true }; } })).ok, false);
  assert.equal(h.calls.length, 1, 'missing STD transition stops without another push or pressure write');
  const old = harness();
  const stale = await old.run({ sendEvent: async () => { old.state.sides.captain.value = old.state.sides.firstOfficer.value = 1016; return { ok: true }; } });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.confirmedTargets, [], 'stale pressure cannot be reported as a confirmed side after a failed write');
});

test('invalid input, stale state, lost power, rejection, profile changes and correlated native exceptions stop writes', async () => {
  for (const value of [947, 1085, 1016.5, '1016', NaN]) { const h = harness(); assert.equal((await h.run({ value })).ok, false); assert.equal(h.calls.length, 0); }
  for (const capture of [() => null, () => ({ healthy: false, sides: {} })]) { const h = harness(); assert.equal((await h.run({ capture })).ok, false); assert.equal(h.calls.length, 0); }
  for (const change of ['reject', 'profile', 'power', 'exception']) {
    const h = harness(); const result = await h.run({ sendEvent: async (name, value) => {
      const ack = await h.params.sendEvent(name, value);
      if (change === 'profile') h.retire(); if (change === 'power') h.state.healthy = false;
      return change === 'reject' ? { ok: false } : ack;
    }, findException: (ids) => change === 'exception' && ids.includes(101) ? {} : null });
    assert.equal(result.ok, false, change); assert.equal(h.calls.length, 1, change);
  }
});

test('real sidecar validation accepts exact A32NX barometer events and unit setters', async () => {
  const h = harness(), bridge = new LvarSidecarBridge();
  bridge._sendWithAck = async (message) => message.type === 'setNamedVar'
    ? h.params.setNamedVar(message) : h.params.sendEvent(message.name, message.value);
  const result = await h.run({ operation: 'qnhInHg', value: 30.12, sendEvent: (name, value) => bridge.sendEvent(name, value), setNamedVar: (input) => bridge.setNamedVar(input) });
  assert.equal(result.ok, true); assert.equal(h.calls.length, 4);
});

test('trusted A32NX barometer recipes retain independent write, limit and shared-guard expectations', () => {
  for (const profile of [PROFILE, { ...PROFILE, _profileKey: 'local/msfs/fbw-a32nx' }, { id: 'generic', simulator: 'msfs' }]) {
    const commands = buildAircraftControlCapabilities(profile, { capabilities }).aircraftCommands.commands.filter((c) => c.id.startsWith('baro.'));
    assert.equal(commands.length, profile === PROFILE ? 9 : 0);
  }
  const source = defaultAircraftIntegrationRegistry.resolveForProfile(PROFILE._profileKey);
  for (const target of ['captain', 'firstOfficer', 'both']) for (const operation of ['qnhHpa', 'qnhInHg', 'std']) {
    const action = source.actions[`baro.${target}.${operation}`], inHg = operation === 'qnhInHg', std = operation === 'std';
    const sides = target === 'both' ? ['L', 'R'] : [target === 'captain' ? 'L' : 'R'];
    assert.deepEqual(action.guard, { groupId: 'fbwA32nx.baro', cooldownMs: 750, retry: 'never' });
    assert.deepEqual(action.input, std ? undefined : { type: 'number', min: inHg ? 27.99 : 948, max: inHg ? 32.01 : 1084, step: inHg ? .01 : 1 });
    assert.deepEqual(action.routes[0].operations, sides.flatMap(side => std
      ? [{ type: 'event', name: `A32NX.FCU_EFIS_${side}_BARO_PULL`, value: 0 }]
      : [{ type: 'lvar', name: `L:A32NX_FCU_EFIS_${side}_BARO_IS_INHG`, unit: 'Number', value: inHg ? 1 : 0 },
        { type: 'event', name: `A32NX.FCU_EFIS_${side}_BARO_PUSH`, value: 0 },
        { type: 'event', name: `A32NX.FCU_EFIS_${side}_BARO_SET`, inputValue: { source: 'input', scale: 16 * (inHg ? 33.863886666667 : 1), round: 'nearest' } }]));
  }
  for (const change of [(a) => { a.routes[0].stagedControl.targets[0].writes.setValue = 99; },
    (a) => { a.input.max = 1200; }, (a) => { a.guard.retry = 'automatic'; },
    (a) => { a.routes[0].stagedControl.targets[0].observations.mode.fieldId = 'missing.mode'; },
    (a) => { a.routes[0].stagedControl.stages[1].property = 'missing'; },
    (a) => { a.routes[0].stagedControl.targets[1].id = 'captain'; },
    (a) => { a.routes[0].stagedControl.final[0].equals = 2; },
  ]) {
    const invalid = structuredClone(source); change(invalid.actions['baro.both.qnhHpa']);
    assert.throws(() => createAircraftIntegrationRegistry([invalid]), /barometer|staged.control|dispatch guard|invalid action/i);
  }
});

test('real loader field keys feed provider readback and shared lock covers both, single and legacy unit writes', async () => {
  loader.setActiveProfile('fbw-a32nx'); const config = loader.getLvarConfig().aircraftSpecific;
  const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
  provider._getActiveAircraftIntegrationConfig = () => config;
  provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true, lvar: true });
  const source = { profileId: PROFILE._profileKey, status: 'running', values: {}, valueUpdatedAt: {}, snapshotSequence: 1, updatedAt: new Date().toISOString() };
  const h = harness();
  const refresh = () => { for (const f of config.confirmationFields) {
    if (f.source.type !== 'lvar') continue;
    const id = f.id; let value = id === 'baro.healthy' ? 1 : undefined;
    for (const side of ['captain', 'firstOfficer']) for (const p of ['mode', 'valueMode', 'value', 'unitInHg']) if (id === baroField(side, p)) value = h.state.sides[side][p];
    if (value !== undefined) { source.values[f.source.key] = typeof value === 'boolean' ? Number(value) : value; source.valueUpdatedAt[f.source.key] = new Date().toISOString(); }
  } };
  refresh(); let release;
  const bridge = { getSnapshot: () => source, setNamedVar: h.params.setNamedVar, sendEvent: async (name, value) => {
    if (!release) await new Promise((resolve) => { release = resolve; });
    const ack = await h.params.sendEvent(name, value); await new Promise((resolve) => setTimeout(resolve, 2)); refresh(); return ack;
  } };
  const run = (actionId, value?) => provider._executeAircraftIntegrationAction(bridge, { name: 'fbw-a32nx' }, 'test', {
    profileKey: PROFILE._profileKey, profileRevision: 1, request: { actionId, value } });
  const pending = run('baro.both.qnhHpa', 1016);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await run('baro.captain.std')).code, 'action_in_progress');
  assert.equal((await run('flightGuidance.baroUnitCaptain.inhg')).code, 'action_in_progress');
  release(); const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.baro.confirmedSides, ['captain', 'firstOfficer']);
});

export {};
