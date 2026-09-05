const assert = require('node:assert/strict');
const test = require('node:test');
const { captureGenericLightReadback, describeGenericLightReadback } = require('./generic-control-diagnostics');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider');
const { LvarSidecarBridge } = require('./lvar-sidecar-bridge');
const { executeAircraftControl, executeAircraftCommand } = require('../aircraft/aircraft-control-service');
const genericProfile = require('../aircraft/profiles/bundled/msfs/generic.json');

const profileKey = 'bundled/msfs/generic';
const profileRevision = 12;
const events = { nav: 'NAV_LIGHTS_SET', beacon: 'BEACON_LIGHTS_SET', strobe: 'STROBES_SET', landing: 'LANDING_LIGHTS_SET', taxi: 'TAXI_LIGHTS_SET' };
const bits = { nav: 1, beacon: 2, landing: 4, taxi: 8, strobe: 16 };

function harness() {
  const provider = new SimConnectTelemetryProvider();
  const bridge = new LvarSidecarBridge();
  const messages = [];
  const native = { status: 'running', updatedAt: new Date().toISOString() };
  const gauge = { status: 'running', source: 'test-sidecar', profileId: profileKey, values: {} as Record<string, unknown>, snapshotSequence: 1, updatedAt: native.updatedAt };
  provider._rustSimvarBridge = { getSnapshot: () => native };
  const updateNative = (mask) => {
    native.updatedAt = new Date().toISOString();
    const values = typeof mask === 'object' && mask !== null ? mask : { lightStates: mask };
    provider._handleRustSimvarSnapshot({ values, updatedAt: native.updatedAt,
      valueUpdatedAt: Object.fromEntries(Object.keys(values).map((key) => [key, native.updatedAt])) });
  };
  updateNative(0);
  provider._getActiveAircraftControlProfileGeneration = () => ({ profileKey, profileRevision });
  provider._ensureControlWriteBridge = async () => bridge;
  bridge.getSnapshot = () => gauge;
  bridge._sendWithAck = async (message, ackType) => {
    messages.push({ message, ackType });
    return { ok: true, sendId: 42, sendIds: [41, 42], transport: { version: 1, api: 'SimConnect_TransmitClientEvent_EX1', objectId: 0, data: [message.value, 0, 0, 0, 0] } };
  };
  const execute = (light = 'beacon', value = true) => executeAircraftControl(provider,
    { control: 'lights', target: light, operation: 'set', value, requestId: 'diagnostic-test' },
    { profile: { ...genericProfile, _profileKey: profileKey }, profileRevision });
  return { provider, bridge, messages, native, gauge, execute, updateNative };
}

test('all five generic light ON/OFF requests reach the real provider and bridge with numeric state then index', async () => {
  await Promise.all(Object.entries(events).flatMap(([light, eventName]) => [false, true].map(async (value) => {
    const h = harness();
    h.updateNative(value ? 0 : bits[light]);
    const send = h.bridge._sendWithAck;
    h.bridge._sendWithAck = async (...args) => {
      const ack = await send(...args);
      h.updateNative(value ? bits[light] : 0);
      return ack;
    };
    const result = await h.execute(light, value);
    assert.deepEqual(h.messages, [{ message: { type: 'sendEvent', name: eventName, value: Number(value), parameters: [0] }, ackType: 'sendEventAck' }]);
    assert.equal(result.code, 'sent_unconfirmed', 'standard readback is not cockpit confirmation');
    assert.equal(result.diagnostics.readback.status, 'changed_to_requested');
    assert.equal(result.diagnostics.requestId, 'diagnostic-test');
    assert.deepEqual(result.diagnostics.sendIds, [41, 42]);
    assert.equal(result.diagnostics.native.api, 'SimConnect_TransmitClientEvent_EX1');
  })));
});

test('late map or transmit rejection wins over a matching readback and never retries', async () => {
  for (const packet of [41, 42]) {
    const h = harness();
    const pending = h.execute();
    await new Promise((resolve) => setTimeout(resolve, 80));
    h.updateNative(2);
    h.bridge._onStdout(`${JSON.stringify({ type: 'exception', exception: 5, sendId: packet, index: 0 })}\n`);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'simconnect_exception');
    assert.equal(result.diagnostics.exception.sendId, packet);
    assert.equal(h.messages.length, 1);
  }
});

test('unrelated and old packet exceptions cannot reject a generic command', async () => {
  const h = harness();
  h.bridge._recentSimConnectExceptions = [{ sendId: 42, exception: 5, receivedAtMs: Date.now() - 1000 }];
  const pending = h.execute();
  await new Promise((resolve) => setTimeout(resolve, 80));
  h.bridge._onStdout(`${JSON.stringify({ type: 'exception', exception: 5, sendId: 999, index: 0 })}\n`);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.code, 'sent_unconfirmed');
  assert.equal(result.diagnostics.readback.status, 'no_new_sample');
});

test('post-dispatch profile change or disconnect interrupts observation without replay', async () => {
  for (const reason of ['profile', 'disconnect', 'stop']) {
    const h = harness();
    const pending = h.execute();
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (reason === 'profile') h.provider._getActiveAircraftControlProfileGeneration = () => ({ profileKey, profileRevision: 13 });
    if (reason === 'disconnect') h.gauge.status = 'disconnected';
    if (reason === 'stop') h.provider._stopping = true;
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.executionStarted, true);
    assert.equal(result.code, reason === 'profile' ? 'stale_profile' : 'observation_interrupted');
    assert.equal(h.messages.length, 1);
  }
});

test('negative acknowledgement and transport exception retain one dispatch and diagnostic context', async () => {
  for (const throws of [false, true]) {
    const h = harness();
    let attempts = 0;
    h.bridge._sendWithAck = async () => {
      attempts++;
      if (throws) throw new Error('broken pipe');
      return { ok: false, error: 'native failure' };
    };
    const result = await h.execute();
    assert.equal(result.ok, false);
    assert.equal(attempts, 1);
    assert.equal(result.diagnostics.eventName, 'BEACON_LIGHTS_SET');
    assert.equal(result.executionStarted, true);
  }
});

test('canonical generic commands preserve diagnostics through command-service normalization', async () => {
  const h = harness();
  const result = await executeAircraftCommand(h.provider,
    { commandId: 'lights.beacon.set', input: { value: true } },
    { profile: { ...genericProfile, _profileKey: profileKey }, profileRevision });
  assert.equal(result.code, 'sent_unconfirmed');
  assert.equal(result.steps[0].diagnostics.eventName, 'BEACON_LIGHTS_SET');
  assert.equal(result.diagnostics.eventName, 'BEACON_LIGHTS_SET');
});

test('readback classification preserves unknown, stale, source disagreement and already-matching states', () => {
  const nowMs = Date.now();
  const capture = (mask, sequence = 1, changes = {}) => captureGenericLightReadback({
    eventName: 'BEACON_LIGHTS_SET', profileKey, nowMs,
    nativeMask: mask, nativeSequence: sequence,
    nativeSnapshot: { status: 'running', updatedAt: new Date(nowMs).toISOString() },
    gaugeSnapshot: {}, ...changes,
  });
  for (const mask of [undefined, null, NaN, -1, 0.5]) {
    const sample = capture(mask);
    assert.equal(sample.native.observed, null);
    assert.equal(describeGenericLightReadback(sample, sample, 0, nowMs).status, 'unavailable');
  }
  assert.equal(describeGenericLightReadback(capture(0), capture(0, 2), 0, nowMs).status, 'already_matched');
  assert.equal(describeGenericLightReadback(capture(0), capture(0, 2), 1, nowMs).status, 'mismatch');
  assert.equal(describeGenericLightReadback(capture(null), capture(0, 2), 0, nowMs).status, 'matched_without_baseline');
  const stale = capture(0, 2, { nativeSnapshot: { status: 'running', updatedAt: new Date(nowMs - 3000).toISOString() } });
  assert.equal(describeGenericLightReadback(capture(2), stale, 0, nowMs).status, 'unavailable');
  const gaugeSnapshot = { status: 'running', profileId: profileKey, values: { standard_light_states: 2 }, snapshotSequence: 3, updatedAt: new Date(nowMs).toISOString() };
  const disagreement = capture(0, 2, { gaugeSnapshot });
  assert.equal(disagreement.native.observed, false);
  assert.equal(disagreement.gauge.observed, true);
  assert.equal(describeGenericLightReadback(capture(0), disagreement, 1, nowMs).status, 'matched_without_baseline');
  const wrongProfile = capture(0, 2, { gaugeSnapshot: { ...gaugeSnapshot, profileId: 'other-aircraft' } });
  assert.equal(wrongProfile.gauge.fresh, false);
  assert.equal(describeGenericLightReadback(capture(0), wrongProfile, 1, nowMs).status, 'mismatch');
});

test('stale or wrong-aircraft gauge light data cannot overwrite the displayed native state', async () => {
  const { resolveLightsForBroadcast, createSourceOverlayContext } = require('./source-overlays');
  for (const reason of ['fresh', 'stale', 'profile', 'disconnected', 'missing']) {
    const h = harness();
    h.provider._lvarBridge = h.bridge;
    h.provider._lvarConfig = { enabled: true, profileId: profileKey, subscriptions: [] };
    h.gauge.values = { standard_light_states: 2 };
    if (reason === 'stale') h.gauge.updatedAt = new Date(Date.now() - 3000).toISOString();
    if (reason === 'profile') h.gauge.profileId = 'other-aircraft';
    if (reason === 'disconnected') h.gauge.status = 'disconnected';
    if (reason === 'missing') {
      h.gauge.values = {};
      delete h.provider._data.lightStates;
    }
    const frame = await h.provider.nextFrame();
    const lights = resolveLightsForBroadcast({
      baseLights: frame.lights,
      profile: {},
      sourceContext: createSourceOverlayContext({ frame, dataSourceInfo: {}, profile: {} }),
    });
    assert.equal(lights.available, reason !== 'missing', reason);
    assert.equal(lights.beacon, reason === 'fresh', reason);
    assert.equal(h.gauge.values.standard_light_states, reason === 'missing' ? undefined : 2,
      'diagnostic filtering never mutates the bridge snapshot');
  }
});

test('unrelated gauge snapshots cannot refresh a cached light field', async () => {
  const h = harness();
  const gaugeBridge = new LvarSidecarBridge();
  gaugeBridge._snapshot.profileId = profileKey;
  h.provider._lvarBridge = gaugeBridge;
  h.provider._lvarConfig = { enabled: true, profileId: profileKey, subscriptions: [] };
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3000).toISOString();
  const emit = (updatedAt) => gaugeBridge._onStdout(`${JSON.stringify({
    type: 'snapshot', values: { standard_light_states: 2, unrelated: 100 },
    valueUpdatedAt: { standard_light_states: updatedAt, unrelated: now }, timestampIso: now,
  })}\n`);
  emit(old);
  assert.equal(h.provider._captureGenericControlReadback(gaugeBridge, 'BEACON_LIGHTS_SET', { profileKey }).gauge.fresh, false);
  assert.equal((await h.provider.nextFrame()).lvars.values.standard_light_states, undefined);
  emit(now);
  assert.equal(h.provider._captureGenericControlReadback(gaugeBridge, 'BEACON_LIGHTS_SET', { profileKey }).gauge.fresh, true);
  assert.equal((await h.provider.nextFrame()).lvars.values.standard_light_states, 2);
  emit(new Date(Date.now() - 250).toISOString());
  h.provider._resetTelemetryForAircraftChange('test:queued gauge sample');
  assert.equal(h.provider._captureGenericControlReadback(gaugeBridge, 'BEACON_LIGHTS_SET', { profileKey }).gauge.fresh, false);
  assert.equal((await h.provider.nextFrame()).lvars.values.standard_light_states, undefined);
  emit(new Date().toISOString());
  assert.equal((await h.provider.nextFrame()).lvars.values.standard_light_states, 2);
});

test('missing native light updates invalidate a previous ON or OFF reading', async () => {
  for (const mask of [0, 2]) {
    const h = harness();
    h.provider._handleRustSimvarSnapshot({ values: { lightStates: mask }, updatedAt: new Date().toISOString() });
    assert.equal((await h.provider.nextFrame()).lights.available, true);
    h.provider._handleRustSimvarSnapshot({ values: { lightStates: null, ias: 120 }, updatedAt: new Date().toISOString() });
    assert.equal((await h.provider.nextFrame()).lights.available, false, 'a missing sample must clear previous availability');
    const reading = h.provider._captureGenericControlReadback(h.bridge, 'BEACON_LIGHTS_SET', { profileKey });
    assert.equal(reading.native.observed, null);
    h.updateNative(mask);
    assert.equal((await h.provider.nextFrame()).lights.available, true, 'a fresh sample restores availability');
  }
});

test('unrelated native updates cannot refresh a stale light reading', async () => {
  const h = harness();
  h.provider._handleRustSimvarSnapshot({ values: { lightStates: 0 }, updatedAt: new Date(Date.now() - 3000).toISOString() });
  h.provider._handleRustSimvarSnapshot({ values: { ias: 120 }, updatedAt: new Date().toISOString() });
  assert.equal((await h.provider.nextFrame()).lights.available, false);
  assert.equal(h.provider._captureGenericControlReadback(h.bridge, 'BEACON_LIGHTS_SET', { profileKey }).native.fresh, false);
});

test('generic NAV standby and swap commands reach SimConnect once with documented BCD16 payloads', async () => {
  await Promise.all([1, 2].flatMap((index) => ['setStandby', 'swap'].map(async (operation) => {
    const h = harness();
    h.updateNative({ [`nav${index}Available`]: 1, [`nav${index}ActiveMhz`]: 108, [`nav${index}StandbyMhz`]: 117.95 });
    const result = await executeAircraftCommand(h.provider,
      { commandId: `radios.nav${index}.${operation}`, input: operation === 'setStandby' ? { value: 110.30 } : {} },
      { profile: { ...genericProfile, _profileKey: profileKey }, profileRevision });
    assert.deepEqual(h.messages, [{ message: {
      type: 'sendEvent', name: operation === 'setStandby' ? `NAV${index}_STBY_SET` : `NAV${index}_RADIO_SWAP`,
      value: operation === 'setStandby' ? 0x1030 : 0,
    }, ackType: 'sendEventAck' }]);
    assert.equal(result.code, 'sent_unconfirmed');
    assert.equal(result.diagnostics.navRadiosBefore[`nav${index}`].installed, true);
    assert.equal(result.diagnostics.navRadiosAfter[`nav${index}`].standbyMhz, 117.95);
  })));
});

test('generic NAV writes reject absent, unknown, stale and disconnected radios without dispatch', async () => {
  for (const reason of ['absent', 'unknown', 'missing-standby', 'stale', 'disconnected', 'wrong-receiver', 'missing-active']) {
    const h = harness();
    h.updateNative({ nav1Available: reason === 'absent' ? 0 : reason === 'unknown' ? null : 1,
      nav1ActiveMhz: reason === 'missing-active' ? null : 108,
      nav1StandbyMhz: reason === 'missing-standby' ? null : 117.95, nav2Available: 0 });
    if (reason === 'stale') {
      h.provider._handleRustSimvarSnapshot({ values: { nav1StandbyMhz: 117.95 }, updatedAt: new Date().toISOString(),
        valueUpdatedAt: { nav1StandbyMhz: new Date(Date.now() - 3000).toISOString() } });
      h.updateNative({ ias: 100 });
    }
    if (reason === 'disconnected') h.native.status = 'disconnected';
    const result = await executeAircraftCommand(h.provider, {
      commandId: `radios.${reason === 'wrong-receiver' ? 'nav2' : 'nav1'}.${reason === 'missing-active' ? 'swap' : 'setStandby'}`,
      input: reason === 'missing-active' ? {} : { value: 110.30 },
    }, { profile: { ...genericProfile, _profileKey: profileKey }, profileRevision });
    assert.equal(result.ok, false, reason);
    assert.equal(result.code, 'radio_unavailable', reason);
    assert.equal(h.messages.length, 0, reason);
  }
});

test('cumulative native snapshots cannot refresh cached NAV or light samples', async () => {
  const { RustSimvarBridge } = require('./rust-simvar-bridge');
  const h = harness();
  const bridge = new RustSimvarBridge({ onSnapshot: (snapshot) => h.provider._handleRustSimvarSnapshot(snapshot) });
  const oldTime = new Date(Date.now() - 3000).toISOString();
  const freshTime = new Date().toISOString();
  bridge._onStdout(JSON.stringify({ type: 'snapshot', stream: 'simvars', timestampIso: freshTime,
    values: { nav1Available: 1, nav1ActiveMhz: 108, nav1StandbyMhz: 110.30, lightStates: 2, ias: 150 },
    valueUpdatedAt: { nav1Available: oldTime, nav1ActiveMhz: oldTime, nav1StandbyMhz: oldTime, lightStates: oldTime, ias: freshTime },
  }) + '\n');
  const frame = await h.provider.nextFrame();
  assert.equal(frame.navRadios.radios.nav1.installed, null);
  assert.equal(frame.lights.available, false);
  bridge._onStdout(JSON.stringify({ type: 'snapshot', stream: 'simvars', timestampIso: freshTime,
    values: { nav1Available: 1, nav1ActiveMhz: 108, nav1StandbyMhz: 110.30 },
  }) + '\n');
  assert.equal((await h.provider.nextFrame()).navRadios.radios.nav1.installed, null, 'old sidecar without field timestamps cannot authorize NAV writes');
});

test('cached light samples from before an aircraft change cannot restore current readback', async () => {
  for (const mask of [0, 2]) {
    const h = harness();
    const sample = { values: { lightStates: mask }, updatedAt: new Date().toISOString(),
      valueUpdatedAt: { lightStates: new Date(Date.now() - 250).toISOString() } };
    h.provider._handleRustSimvarSnapshot(sample);
    assert.equal((await h.provider.nextFrame()).lights.available, true);
    h.provider._resetTelemetryForAircraftChange('regression-test');
    h.provider._handleRustSimvarSnapshot({ ...sample, updatedAt: new Date().toISOString() });
    assert.equal((await h.provider.nextFrame()).lights.available, false);
    assert.equal(h.provider._captureGenericControlReadback(h.bridge, 'BEACON_LIGHTS_SET', { profileKey }).native.fresh, false);
    h.updateNative(mask);
    assert.equal((await h.provider.nextFrame()).lights.available, true, 'new-aircraft samples restore readback');
  }
});

test('NAV telemetry distinguishes installed receivers and clears null, stale and previous-aircraft samples', async () => {
  const h = harness();
  h.updateNative({ nav1Available: 1, nav1ActiveMhz: 108, nav1StandbyMhz: 117.95,
    nav2Available: 0, nav2ActiveMhz: 110.30, nav2StandbyMhz: 110.30 });
  let frame = await h.provider.nextFrame();
  assert.deepEqual(frame.navRadios, { profileKey, profileRevision, radios: {
    nav1: { installed: true, activeMhz: 108, standbyMhz: 117.95 },
    nav2: { installed: false, activeMhz: null, standbyMhz: null },
  } });
  h.updateNative({ nav1StandbyMhz: null });
  assert.equal((await h.provider.nextFrame()).navRadios.radios.nav1.standbyMhz, null);
  h.provider._handleRustSimvarSnapshot({ values: { nav1Available: 1 }, updatedAt: new Date().toISOString(),
    valueUpdatedAt: { nav1Available: new Date(Date.now() - 3000).toISOString() } });
  h.updateNative({ ias: 150 });
  assert.equal((await h.provider.nextFrame()).navRadios.radios.nav1.installed, null);
  h.updateNative({ nav1Available: 1, nav1StandbyMhz: 117.95 });
  h.provider._resetTelemetryForAircraftChange('test');
  h.provider._handleRustSimvarSnapshot({ values: { nav1Available: 1, nav1StandbyMhz: 117.95 },
    updatedAt: new Date().toISOString(), valueUpdatedAt: {
      nav1Available: new Date(Date.now() - 250).toISOString(), nav1StandbyMhz: new Date(Date.now() - 250).toISOString(),
    } });
  frame = await h.provider.nextFrame();
  assert.equal(frame.navRadios.radios.nav1.installed, null);
  assert.equal(frame.navRadios.radios.nav2.installed, null);
});

export {};
