const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const { captureFenixBaroState, executeFenixBaroTransaction } = require(runtime('telemetry-provider/fenix-baro-control.js'));
const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require(runtime('aircraft/aircraft-control-service.js'));
const capabilities = { actionTypes: ['aircraft-integration'], integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'] };
const sides = ['captain', 'firstOfficer'];

function harness(operation = 'qnhHpa', value = 1016, target = 'both') {
  let time = 10000, current = true;
  const calls = [], state = { healthy: true, sides: Object.fromEntries(sides.map(side => [side,
    { qnh: true, units: 'hpa', pressure: operation === 'qnhInHg' ? 29.92 : 1013, times: { qnh: time, units: time, pressure: time } }])) };
  const h = { state, calls, operation, target, value, after: null,
    advance: (ms) => { time += ms; },
    retire: () => { current = false; },
    update(side, property, value, fresh = true) { state.sides[side][property] = value; if (fresh) state.sides[side].times[property] = ++time; },
    async write(code) {
      calls.push(code);
      const side = code.includes('EFIS1') ? 'captain' : 'firstOfficer', direction = code.includes('++') ? 1 : -1;
      if (h.after) return h.after(code, side, direction);
      if (code.includes('_MODE')) h.update(side, 'units', code.startsWith('0') ? 'inhg' : 'hpa');
      else if (code.includes('_STD')) h.update(side, 'qnh', direction === -1);
      else h.update(side, 'pressure', Math.round((state.sides[side].pressure + direction * (operation === 'qnhInHg' ? .01 : 1)) * 100) / 100);
      if (code.includes('_MODE') || code.includes('_STD')) h.update(side, 'pressure', state.sides[side].pressure);
      return { ok: true };
    },
    run: (patch = {}) => executeFenixBaroTransaction({ target, operation, value, capture: () => structuredClone(state),
      isCurrent: () => current, executeCode: code => h.write(code), now: () => time, sleep: async ms => {
        time += ms;
        if (!h.after) for (const side of sides) state.sides[side].times.pressure = time;
      }, ...patch }),
  };
  return h;
}

test('Fenix QNH confirms units, leaves STD once and steps each side to hPa/inHg targets', async () => {
  for (const operation of ['qnhHpa', 'qnhInHg']) for (const target of [...sides, 'both']) {
    const h = harness(operation, operation === 'qnhHpa' ? 1016 : 29.95, target);
    for (const side of sides) { h.state.sides[side].qnh = false; h.state.sides[side].units = operation === 'qnhHpa' ? 'inhg' : 'hpa'; }
    const r = await h.run(); assert.equal(r.ok, true, JSON.stringify(r));
    const count = target === 'both' ? 2 : 1;
    assert.equal(h.calls.filter(c => c.includes('_MODE')).length, count);
    assert.equal(h.calls.filter(c => c.includes('_STD')).length, count);
    assert.equal(h.calls.filter(c => c.includes('(L:E_')).length, count * 3);
    assert.deepEqual(r.baro.confirmedSides, target === 'both' ? sides : [target]);
    if (target !== 'both') assert.ok(h.calls.every(c => c.includes(target === 'captain' ? 'EFIS1' : 'EFIS2')));
  }
});

test('Fenix STD is a single pull per necessary side, never inferred from 29.92 QNH', async () => {
  const h = harness('std'); h.state.sides.captain.qnh = false; h.state.sides.firstOfficer.pressure = 29.92;
  assert.equal((await h.run()).ok, true);
  assert.deepEqual(h.calls, ['(L:S_FCU_EFIS2_BARO_STD, Number) ++ (>L:S_FCU_EFIS2_BARO_STD, Number)']);
  h.calls.length = 0; assert.equal((await h.run()).noOp, true); assert.deepEqual(h.calls, []);
  const q = harness('qnhHpa', 1013); assert.equal((await q.run()).noOp, true); assert.deepEqual(q.calls, []);
});

test('leaving STD waits for the numeric display when mode and pressure arrive in separate polls', async () => {
  const h = harness('qnhHpa', 1014);
  for (const side of sides) { h.state.sides[side].qnh = false; h.state.sides[side].pressure = 0; }
  h.after = async (code, side) => {
    if (code.includes('_STD')) h.update(side, 'qnh', true);
    else h.update(side, 'pressure', 1014);
    return { ok: true };
  };
  const r = await h.run({ sleep: async () => {
    if (sides.some(side => h.state.sides[side].pressure === 0)) {
      assert.equal(h.calls.filter(c => c.includes('(L:E_')).length, 0, 'no knob input until the numeric display is ready');
    }
    for (const side of sides) h.update(side, 'pressure', h.state.sides[side].pressure || 1013);
  } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(h.calls.length, 4);
});

test('QNH cannot confirm cached matching pressure from before a mode or unit change', async () => {
  for (const linked of [false, true]) for (const transition of ['qnh', 'units']) for (const refresh of ['neither', 'captain', 'both']) {
    const h = harness('qnhHpa', 1013);
    for (const side of sides) h.state.sides[side][transition] = transition === 'qnh' ? false : 'inhg';
    h.after = async (_code, side) => {
      for (const affected of linked ? sides : [side]) {
        h.update(affected, transition, transition === 'qnh' ? true : 'hpa');
        if (refresh === affected || refresh === 'both') h.update(affected, 'pressure', 1013);
      }
      return { ok: true };
    };
    const r = await h.run();
    assert.equal(r.ok, refresh === 'both', `${linked}/${transition}/${refresh}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.baro.confirmedSides, refresh === 'both' ? sides : refresh === 'captain' ? ['captain'] : []);
    assert.equal(h.calls.length, linked ? 1 : 2, 'missing pressure updates must not cause knob input or retries');
  }
});

test('missing or stale detent confirmation is not retried or counted as success', async () => {
  for (const target of ['captain', 'both']) for (const outcome of ['inhibited', 'stale']) {
    const h = harness('qnhHpa', 1014, target);
    h.after = async (_code, side) => {
      const confirmed = target === 'both' && side === 'captain';
      h.update(side, 'pressure', confirmed || outcome === 'stale' ? 1014 : 1013, confirmed);
      return { ok: true };
    };
    const r = await h.run(); assert.equal(r.ok, false); assert.equal(r.code, 'baro_readback_timeout');
    assert.deepEqual(r.baro.confirmedSides, target === 'both' ? ['captain'] : []);
    assert.equal(h.calls.length, 1, 'no retry or peer detent based on an old sample');
  }
});

test('pressure overshoot, unexpected mode or units, power, profile, exception and rejection halt further inputs', async () => {
  for (const outcome of ['overshoot', 'units', 'mode', 'power', 'profile', 'exception', 'reject']) {
    const h = harness(); let exception = false;
    h.after = async (_code, side) => {
      h.update(side, 'pressure', outcome === 'overshoot' ? 1020 : 1014);
      if (outcome === 'units') h.update(side, 'units', 'inhg');
      if (outcome === 'mode') h.update(side, 'qnh', false);
      if (outcome === 'power') h.state.healthy = false;
      if (outcome === 'profile') h.retire();
      exception = outcome === 'exception'; return { ok: outcome !== 'reject', sendId: 7 };
    };
    const r = await h.run({ findException: ids => exception && ids.includes(7) });
    assert.equal(r.ok, false, outcome); assert.ok(h.calls.length <= 2, outcome);
  }
});

test('linked altimeters skip a redundant second input and confirm both, including downward targets', async () => {
  const h = harness('qnhHpa', 1010);
  h.after = async (_code, _side, direction) => { for (const side of sides) h.update(side, 'pressure', h.state.sides[side].pressure + direction); return { ok: true }; };
  const r = await h.run(); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(h.calls.length, 3);
});

test('linked altimeters wait for a dispatched detent before deciding whether the other side needs an input', async () => {
  for (const [operation, value] of [['qnhHpa', 1010], ['qnhHpa', 1016], ['qnhInHg', 29.95]]) {
    const h = harness(operation, value), queued = [];
    if (operation === 'qnhInHg') for (const side of sides) h.state.sides[side].units = 'inhg';
    // Transport ACK arrives before the next aircraft update. Native linking
    // applies every knob input to both sides on that update.
    h.after = async (_code, _side, direction) => { queued.push(direction); return { ok: true }; };
    const r = await h.run({ sleep: async ms => {
      h.advance(ms);
      for (const direction of queued.splice(0)) for (const side of sides) {
        h.update(side, 'pressure', Math.round((h.state.sides[side].pressure + direction * (operation === 'qnhInHg' ? .01 : 1)) * 100) / 100);
      }
    } });
    assert.equal(r.ok, true, `${operation}: ${JSON.stringify(r)}`);
    assert.equal(h.calls.length, 3, 'one confirmed input per linked detent');
    assert.deepEqual(r.baro.confirmedSides, sides);
    assert.ok(sides.every(side => h.state.sides[side].pressure === value));
  }
});

test('separately polled linked altimeters cannot receive a duplicate detent while the peer sample lags', async () => {
  for (const linked of [false, true]) for (const [operation, value] of [['qnhHpa', 1010], ['qnhHpa', 1016], ['qnhInHg', 29.95]]) {
    const h = harness(operation, value), physical = Object.fromEntries(sides.map(side => [side, h.state.sides[side].pressure]));
    if (operation === 'qnhInHg') for (const side of sides) h.state.sides[side].units = 'inhg';
    h.after = async (_code, side, direction) => {
      for (const affected of linked ? sides : [side]) {
        physical[affected] = Math.round((physical[affected] + direction * (operation === 'qnhInHg' ? .01 : 1)) * 100) / 100;
      }
      // The write has physically completed, but only its own display has been
      // polled. The peer's cached pressure still predates this detent.
      h.update(side, 'pressure', physical[side]);
      return { ok: true };
    };
    const r = await h.run({ sleep: async ms => {
      h.advance(ms);
      for (const side of sides) h.update(side, 'pressure', physical[side]);
    } });
    assert.equal(r.ok, true, `${linked}/${operation}: ${JSON.stringify(r)}`);
    assert.equal(h.calls.length, linked ? 3 : 6, 'each physical detent is sent exactly once');
    assert.ok(sides.every(side => physical[side] === value));
  }
});

test('initially staggered pressure samples are refreshed before planning linked detents', async () => {
  const h = harness('qnhHpa', 1016), physical = { captain: 1014, firstOfficer: 1014 };
  h.update('captain', 'pressure', 1014);
  // A previous linked cockpit input has not yet reached the peer's poll.
  h.after = async (_code, side, direction) => {
    for (const affected of sides) physical[affected] += direction;
    h.update(side, 'pressure', physical[side]);
    return { ok: true };
  };
  const r = await h.run({ sleep: async ms => {
    h.advance(ms);
    for (const side of sides) h.update(side, 'pressure', physical[side]);
  } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.calls.length, 2);
  assert.deepEqual(physical, { captain: 1016, firstOfficer: 1016 });
});

test('a mirrored pressure or mode value with an old own timestamp cannot confirm the second side', async () => {
  for (const operation of ['qnhHpa', 'std']) {
    const h = harness(operation, 1014);
    h.after = async () => {
      for (const side of sides) h.update(side, operation === 'std' ? 'qnh' : 'pressure', operation === 'std' ? false : 1014, side === 'captain');
      return { ok: true };
    };
    const r = await h.run();
    assert.equal(r.ok, false); assert.equal(r.code, 'baro_readback_timeout');
    assert.deepEqual(r.baro.confirmedSides, ['captain']); assert.equal(h.calls.length, 1);
  }
});

test('Fenix pressure bounds reject invalid input before writing and full range remains bounded', async () => {
  for (const [op, values] of [['qnhHpa', [947, 1085, 1016.5, NaN]], ['qnhInHg', [27.98, 32.02, 29.921]]]) for (const value of values) {
    const h = harness(op, value); assert.equal((await h.run()).code, 'invalid_baro_value'); assert.deepEqual(h.calls, []);
  }
  const h = harness('qnhInHg', 32.01); for (const side of sides) h.state.sides[side] = { ...h.state.sides[side], units: 'inhg', pressure: 27.99 };
  assert.equal((await h.run()).ok, true); assert.equal(h.calls.length, 804);
});

test('capture requires independently recent mode, units and power; STD permits a blank pressure', () => {
  const values = { 'baro.healthy': true, 'baro.captain.qnh': false, 'flightGuidance.baroUnitCaptain': 'hpa' };
  const sample = id => ({ observed: values[id], fresh: true, updatedAtMs: 9000 });
  assert.equal(captureFenixBaroState('captain', 'std', sample, 10000).sides.captain.pressure, null);
  for (const id of Object.keys(values)) for (const patch of [{ fresh: false }, { updatedAtMs: 7000 }, { updatedAtMs: 10001 }, { observed: null }]) {
    assert.equal(captureFenixBaroState('captain', 'std', key => ({ ...sample(key), ...(key === id ? patch : {}) }), 10000), null);
  }
  const h = harness('std'); h.state.healthy = false;
  return h.run().then(r => { assert.equal(r.ok, false); assert.deepEqual(h.calls, []); });
});

test('all three Fenix profiles expose nine targeted UI/voice commands; unreviewed families and local profiles do not', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  for (const id of ['fenix-a319', 'fenix-a320', 'fenix-a321', 'pmdg-737', 'pmdg-777', 'inibuilds-a350-900', 'inibuilds-a350-1000']) {
    loader.setActiveProfile(id); const profile = loader.getActiveProfile();
    const catalogue = buildAircraftControlCapabilities(profile, { capabilities }).aircraftCommands, supported = id.startsWith('fenix');
    assert.equal(catalogue.commands.filter(c => c.id.startsWith('baro.')).length, supported ? 9 : 0, id);
    for (const target of ['captain', 'first officer', 'both']) for (const suffix of ['QNH 1016', 'QNH 29.92 inHg', 'standard pressure']) {
      const parsed = interpret(`${target} ${suffix}`, catalogue); assert.equal(parsed.ok, supported, `${id} ${target} ${suffix}`);
      if (supported) assert.equal(resolveAircraftCommand({ commandId: parsed.commandId, input: parsed.input }, { profile, capabilities }).ok, true);
    }
    const local = { ...profile, _profileKey: `local/msfs/${id}` };
    assert.equal(buildAircraftControlCapabilities(local, { capabilities }).aircraftCommands.commands.some(c => c.id.startsWith('baro.')), false);
  }
});

test('registry rejects modified recipes, weakened guards, missing confirmations and wrong aircraft', () => {
  const { defineAircraftIntegration } = require(runtime('aircraft/aircraft-integrations/registry.js'));
  const { FENIX_A32X_INTEGRATION } = require(runtime('aircraft/aircraft-integrations/fenix-a32x/index.js'));
  for (const mutate of [
    a => { a.routes[0].codes[0] = '1 (>L:UNREVIEWED, Number)'; }, a => { a.routes[0].readbacks.pop(); },
    a => { a.guard.groupId = 'other'; }, a => { a.input.max = 9999; }, a => { delete a.routes[0].baro; },
  ]) {
    const integration = structuredClone(FENIX_A32X_INTEGRATION); mutate(integration.actions['baro.both.qnhHpa']);
    assert.throws(() => defineAircraftIntegration(integration), /barometer|calculator|invalid action/);
  }
  for (const side of ['Captain', 'FirstOfficer']) for (const unit of ['hpa', 'inhg']) {
    assert.equal(FENIX_A32X_INTEGRATION.actions[`flightGuidance.baroUnit${side}.${unit}`].guard.groupId, 'fenixA32x.baro');
  }
});

test('real provider loads each Fenix profile, routes QNH/STD through native counters, and shares the legacy units lock', async () => {
  const { SimConnectTelemetryProvider } = require(runtime('telemetry-provider/simconnect-telemetry-provider.js'));
  const { LvarSidecarBridge } = require(runtime('telemetry-provider/lvar-sidecar-bridge.js'));
  for (const id of ['fenix-a319', 'fenix-a320', 'fenix-a321']) for (const operation of ['qnhHpa', 'qnhInHg', 'std']) {
    loader.setActiveProfile(id); const config = loader.getAircraftSpecificConfig(), calls = [];
    const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
    provider._getActiveAircraftIntegrationConfig = () => config;
    provider._getMobiFlightHealth = () => ({ connected: true });
    const snapshot = { profileId: config.profileKey, status: 'running', values: {}, valueUpdatedAt: {}, snapshotSequence: 1 };
    const fieldKey = field => config.confirmationFields.find(f => f.id === field).source.key;
    const publish = (field, value) => {
      snapshot.values[fieldKey(field)] = value; snapshot.snapshotSequence++;
      snapshot.updatedAt = new Date().toISOString(); snapshot.valueUpdatedAt[fieldKey(field)] = snapshot.updatedAt;
    };
    publish('baro.healthy', 1);
    for (const side of sides) {
      publish(`baro.${side}.qnh`, operation === 'std' ? 1 : 0);
      publish(`flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`, operation === 'qnhInHg' ? 1 : 0);
      publish(`baro.${side}.hpa`, 1013); publish(`baro.${side}.inhg`, 29.92);
    }
    for (const key of Object.keys(snapshot.valueUpdatedAt)) snapshot.valueUpdatedAt[key] = new Date(Date.now() - 20).toISOString();
    const bridge = new LvarSidecarBridge(); bridge.getSnapshot = () => {
      // The real sidecar keeps polling unchanged fields. Model that polling so
      // cold-start work cannot expire an otherwise active simulated panel.
      if (Date.now() - Date.parse(snapshot.updatedAt) > 500) {
        snapshot.updatedAt = new Date(Date.now() - 20).toISOString(); snapshot.snapshotSequence++;
        for (const key of Object.keys(snapshot.valueUpdatedAt)) snapshot.valueUpdatedAt[key] = snapshot.updatedAt;
      }
      return snapshot;
    };
    const run = (actionId, value) => provider._executeAircraftIntegrationAction(bridge, { name: config.integrationId }, 'test', {
      profileKey: config.profileKey, profileRevision: config.profileRevision, request: { actionId, ...(value === undefined ? {} : { value }) },
    });
    let checkedLock = false;
    bridge.executeMobiFlightCode = async code => {
      calls.push(code);
      if (!checkedLock) { checkedLock = true; assert.equal((await run('flightGuidance.baroUnitCaptain.hpa')).code, 'action_in_progress'); }
      // Allow the next own field timestamp to advance even for same-millisecond writes.
      await new Promise(resolve => setTimeout(resolve, 2));
      const side = code.includes('EFIS1') ? 'captain' : 'firstOfficer';
      if (code.includes('_MODE')) publish(`flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`, code.startsWith('0') ? 0 : 1);
      else if (code.includes('_STD')) publish(`baro.${side}.qnh`, code.includes('--') ? 1 : 0);
      else publish(`baro.${side}.${operation === 'qnhInHg' ? 'inhg' : 'hpa'}`, operation === 'qnhInHg' ? 29.93 : 1014);
      if (code.includes('_MODE') || code.includes('_STD')) for (const unit of ['hpa', 'inhg']) {
        const field = `baro.${side}.${unit}`; publish(field, snapshot.values[fieldKey(field)]);
      }
      // Ordinary polling also refreshes unchanged peer fields.
      for (const key of Object.keys(snapshot.valueUpdatedAt)) snapshot.valueUpdatedAt[key] = snapshot.updatedAt;
      return { ok: true };
    };
    const result = await run(`baro.both.${operation}`, operation === 'std' ? undefined : operation === 'qnhInHg' ? 29.93 : 1014);
    assert.equal(result.ok, true, `${id} ${operation}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.baro.confirmedSides, sides); assert.equal(result.transportMode, 'mobiflight-calculator');
    assert.equal(calls.length, operation === 'std' ? 2 : 6);
    assert.equal(provider._aircraftIntegrationActionsInFlight.size, 0);
    assert.equal((await run('baro.both.std')).code, 'action_cooldown');
  }
});
