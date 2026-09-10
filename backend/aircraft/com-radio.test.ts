const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeComFrequencyMhz } = require('../utils/radio-frequency');
const { captureComRadio, executeComRadioTransaction, COM_RADIO_DEFINITIONS } = require('../telemetry-provider/com-radio-control');
const { defaultAircraftIntegrationRegistry, createAircraftIntegrationRegistry } = require('./aircraft-integrations');
const { buildAircraftControlCapabilities, executeAircraftCommand } = require('./aircraft-control-service');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const { LvarSidecarBridge } = require('../telemetry-provider/lvar-sidecar-bridge');
const PROFILE = { id: 'fbw-a32nx', simulator: 'msfs', _profileKey: 'bundled/msfs/fbw-a32nx',
  integration: { aircraftSpecific: { adapter: 'fbw-a32nx' }, controls: { genericFallback: false } } };
const capabilities = { actionTypes: ['aircraft-integration'], integrationTransports: ['simconnect-sequence'] };

function harness() {
  let time = 1000;
  let active = true;
  const calls: { name: string; value: number }[] = [];
  const state = { installed: true, status: 0, spacingMode: 1, activeMhz: 121.7, standbyMhz: 123.45,
    updatedAt: { installed: time, status: time, spacingMode: time, activeMhz: time, standbyMhz: time } };
  const params = {
    index: 1, operation: 'switchTo', value: 123.005,
    capture: () => structuredClone(state), isCurrent: () => active, now: () => time,
    sleep: async (ms) => { time += ms; },
    sendEvent: async (name, value) => {
      calls.push({ name, value }); time += 1;
      if (name.includes('SET_HZ')) { state.standbyMhz = value / 1000000; state.updatedAt.standbyMhz = time; }
      else { [state.activeMhz, state.standbyMhz] = [state.standbyMhz, state.activeMhz];
        state.updatedAt.activeMhz = state.updatedAt.standbyMhz = time; }
      return { ok: true, sendId: calls.length };
    },
  };
  return { params, state, calls, run: (overrides = {}) => executeComRadioTransaction({ ...params, ...overrides }),
    retire: () => { active = false; } };
}

test('COM validation preserves channel designators and never rounds invalid or incompatible input', () => {
  for (const mhz of [118, 118.005, 123.01, 123.015, 123.025, 123.45, 136.99]) assert.equal(normalizeComFrequencyMhz(mhz), mhz);
  for (const mhz of [117.995, 137, 123.02, 123.045, 123.07, 123.095, 123.456, '123.45', NaN]) assert.equal(normalizeComFrequencyMhz(mhz), null);
  assert.equal(normalizeComFrequencyMhz(123.45, 0), 123.45);
  assert.equal(normalizeComFrequencyMhz(123.005, 0), null);
  for (const mode of [null, undefined, '0', true, 2]) {
    if (mode !== undefined) assert.equal(normalizeComFrequencyMhz(123.005, mode), null);
  }
});

test('COM freshness is per field, clears missing timestamps and honors disconnects', () => {
  const samples = Object.fromEntries(COM_RADIO_DEFINITIONS.filter((field) => field.name.startsWith('com1')).map((field) => [field.name,
    { value: field.name.endsWith('Installed') ? true : field.name.endsWith('SpacingMode') ? 1 : field.name.endsWith('Status') ? 0 : 123.45,
      updatedAt: new Date(1000).toISOString() }]));
  assert.equal(captureComRadio(samples, 'running', 1, 1000).activeMhz, 123.45);
  samples.com1ActiveMhz.updatedAt = null;
  assert.equal(captureComRadio(samples, 'running', 1, 1000).activeMhz, null);
  assert.equal(captureComRadio(samples, 'running', 1, 3001).standbyMhz, null);
  assert.equal(captureComRadio(samples, 'disconnected', 1, 1000).installed, null);
  assert.equal(captureComRadio(samples, 'running', 1, 999).standbyMhz, null);
});

test('COM1 and COM2 switch-to confirm standby before one swap and confirm both resulting banks', async () => {
  for (const index of [1, 2]) {
    const h = harness();
    const result = await h.run({ index });
    assert.equal(result.ok, true);
    assert.deepEqual(h.calls, [{ name: index === 1 ? 'COM_STBY_RADIO_SET_HZ' : 'COM2_STBY_RADIO_SET_HZ', value: 123005000 },
      { name: `COM${index}_RADIO_SWAP`, value: 0 }]);
    assert.deepEqual(result.radio, { index, bank: 'active', frequencyMhz: 123.005 });
    assert.equal(h.state.standbyMhz, 121.7);
    assert.equal(result.transportAcknowledged, undefined);
  }
});

test('native snapshots require per-field timestamps from the current aircraft generation', () => {
  const provider = new SimConnectTelemetryProvider();
  const timestamp = new Date().toISOString();
  provider._rustSimvarBridge = { getSnapshot: () => ({ status: 'running' }) };
  const values = { com1Installed: 1, com1Status: 0, com1SpacingMode: 1, com1ActiveMhz: 121.7, com1StandbyMhz: 123.005 };
  const valueUpdatedAt = Object.fromEntries(Object.keys(values).map((key) => [key, timestamp]));
  provider._handleRustSimvarSnapshot({ values, valueUpdatedAt, updatedAt: timestamp });
  assert.equal(provider._captureComRadioState(1).installed, true, 'native boolean coercion');
  assert.equal(provider._captureComRadioState(1).standbyMhz, 123.005);
  provider._handleRustSimvarSnapshot({ values, valueUpdatedAt: { ...valueUpdatedAt, com1StandbyMhz: null }, updatedAt: timestamp });
  assert.equal(provider._captureComRadioState(1).standbyMhz, null, 'aggregate timestamp cannot refresh a missing field');
  provider._rustControlReadbackNotBeforeMs = Date.parse(timestamp) + 1;
  provider._handleRustSimvarSnapshot({ values, valueUpdatedAt, updatedAt: timestamp });
  assert.equal(provider._captureComRadioState(1).activeMhz, null, 'retired generation cannot authorize tuning');
});

test('standby tuning never swaps; swap readback reports actual active; same targets are no-ops', async () => {
  const h = harness();
  assert.equal((await h.run({ operation: 'setStandby' })).radio.bank, 'standby');
  assert.equal(h.state.activeMhz, 121.7);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.run({ operation: 'setStandby' })).noOp, true);
  assert.equal((await h.run({ operation: 'swap' })).radio.frequencyMhz, 123.005);
  assert.equal((await h.run()).noOp, true);
  assert.equal(h.calls.length, 2);
});

test('invalid channels, missing power or stale banks reject before dispatch', async () => {
  for (const patch of [{ installed: false }, { status: 2 }, { spacingMode: null }, { standbyMhz: null }, { activeMhz: null }, { spacingMode: 0 }]) {
    const h = harness(); Object.assign(h.state, patch);
    assert.equal((await h.run()).ok, false);
    assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal((await h.run({ value: 123.02 })).code, 'invalid_radio_channel');
  assert.equal(h.calls.length, 0);
  h.state.spacingMode = 0; h.state.standbyMhz = 123.005;
  assert.equal((await h.run({ operation: 'swap' })).code, 'invalid_radio_channel');
  assert.equal(h.calls.length, 0);
});

test('rejected, absent, rounded or old standby readback never causes a swap or retry', async () => {
  for (const mode of ['rejected', 'absent', 'rounded', 'old']) {
    const h = harness();
    const result = await h.run({ sendEvent: async (name, value) => {
      h.calls.push({ name, value });
      if (mode === 'old') h.state.standbyMhz = 123.005;
      if (mode === 'rounded') { h.state.standbyMhz = 123; h.state.updatedAt.standbyMhz += 1; }
      return { ok: mode !== 'rejected' };
    } });
    assert.equal(result.ok, false, mode); assert.equal(h.calls.length, 1, mode);
  }
});

test('aircraft, spacing and manual bank changes between tune and swap stop remaining writes', async () => {
  for (const change of ['aircraft', 'spacing', 'active']) {
    const h = harness();
    const result = await h.run({ sendEvent: async (name, value) => {
      const ack = await h.params.sendEvent(name, value);
      if (change === 'aircraft') h.retire();
      if (change === 'spacing') h.state.spacingMode = 0;
      if (change === 'active') h.state.activeMhz = 122.8;
      return ack;
    } });
    assert.equal(result.ok, false, change); assert.equal(h.calls.length, 1, change);
  }
});

test('failed swap identifies confirmed standby and cannot be mistaken for a completed switch', async () => {
  for (const failSwap of ['reject', 'no-readback', 'standby-wrong']) {
    const h = harness();
    const result = await h.run({ sendEvent: async (name, value) => {
      if (name.includes('SET_HZ')) return h.params.sendEvent(name, value);
      h.calls.push({ name, value });
      if (failSwap === 'standby-wrong') { h.state.activeMhz = 123.005; h.state.updatedAt.activeMhz += 1; }
      return { ok: failSwap !== 'reject' };
    } });
    assert.equal(result.ok, false); assert.equal(result.executionStarted, true);
    assert.match(result.error, /Standby tuning was confirmed/); assert.equal(h.calls.length, 2);
  }
});

test('known native rejection overrides matching radio readback', async () => {
  const h = harness(); const result = await h.run({ findException: (ids) => ids.length ? { exception: 3 } : null });
  assert.equal(result.code, 'radio_write_rejected'); assert.equal(h.calls.length, 1);
});

test('rejections correlate against mapping packets as well as the final transmit packet', async () => {
  const h = harness();
  const result = await h.run({
    sendEvent: async (name, value) => {
      await h.params.sendEvent(name, value);
      return { ok: true, sendId: 22, sendIds: [21, 22] };
    },
    findException: (ids) => ids.includes(21) ? { exception: 3, sendId: 21 } : null,
  });
  assert.equal(result.code, 'radio_write_rejected');
  assert.equal(h.calls.length, 1, 'a rejected mapping packet must prevent the remaining swap');
});

test('COM transactions pass exact Hz through the real sidecar bridge validator', async () => {
  for (const index of [1, 2]) {
    const h = harness();
    const bridge = new LvarSidecarBridge();
    bridge._sendWithAck = async (message, ackType) => {
      assert.equal(ackType, 'sendEventAck');
      assert.equal(message.type, 'sendEvent');
      return h.params.sendEvent(message.name, message.value);
    };
    const result = await h.run({ index, sendEvent: bridge.sendEvent.bind(bridge) });
    assert.equal(result.ok, true, result.error);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].value, 123005000);
    assert.equal(result.radio.frequencyMhz, 123.005);
  }
});

test('only the reviewed exact A32NX profile exposes COM commands and malformed contracts are rejected', () => {
  const source = defaultAircraftIntegrationRegistry.resolveForProfile(PROFILE._profileKey);
  for (const candidate of [PROFILE, { ...PROFILE, _profileKey: 'local/msfs/fbw-a32nx' },
    { id: 'generic', simulator: 'msfs' }, { id: 'pmdg-737', simulator: 'msfs', _profileKey: 'bundled/msfs/pmdg-737', integration: { aircraftSpecific: { adapter: 'pmdg-737' } } }]) {
    const commands = buildAircraftControlCapabilities(candidate, { capabilities }).aircraftCommands.commands.filter((command) => command.id.startsWith('radios.com'));
    assert.equal(commands.length, candidate === PROFILE ? 6 : 0);
  }
  for (const mutate of [
    (route) => { route.operations[0].name = 'COM_RADIO_SET_HZ'; },
    (route) => { route.confirmation = 'transport-acknowledged'; delete route.readback; },
    (route) => { route.comRadio.index = 3; },
  ]) {
    const invalid = structuredClone(source); mutate(invalid.actions['radios.com1.switchTo'].routes[0]);
    assert.throws(() => createAircraftIntegrationRegistry([invalid]), /COM radio contract|acknowledgement contract/);
  }
});

test('real provider and command service share a per-radio lock and return observed result metadata', async () => {
  const h = harness(); const provider = new SimConnectTelemetryProvider();
  provider.aircraftControlCapabilities = capabilities;
  provider._connected = true; provider._simRunning = true;
  provider._getActiveAircraftIntegrationConfig = () => ({});
  provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true });
  provider._captureComRadioState = h.params.capture;
  let release;
  const bridge = { setNamedVar: async () => ({ ok: true }), sendEvent: async (name, value) => {
    await new Promise((resolve) => { release = resolve; }); return h.params.sendEvent(name, value);
  } };
  const run = (operation, value?) => provider._executeAircraftIntegrationAction(bridge, { name: 'fbw-a32nx' }, 'test', {
    profileKey: PROFILE._profileKey, profileRevision: 1, request: { actionId: `radios.com1.${operation}`, value },
  });
  const pending = run('setStandby', 123.005);
  assert.equal((await run('swap')).code, 'action_in_progress');
  release(); assert.equal((await pending).radio.frequencyMhz, 123.005);
  assert.equal((await run('swap')).code, 'action_cooldown');
  const result = await executeAircraftCommand({ aircraftControlCapabilities: capabilities,
    executeAircraftControlAction: async () => ({ ok: true, code: 'executed', radio: { index: 1, bank: 'active', frequencyMhz: 123.005 } }),
  }, { commandId: 'radios.com1.switchTo', input: { value: 123.005 } }, { profile: PROFILE });
  assert.deepEqual(result.radio, { index: 1, bank: 'active', frequencyMhz: 123.005 });
});

export {};
