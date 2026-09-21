import assert = require('node:assert/strict');
import test = require('node:test');
import { createPmdgAutotaxi } from '../telemetry-provider/pmdg-autotaxi.js';
const { SdkBridge } = require('../telemetry-provider/sdk-bridge.js');
const { getSdkAdapterById } = require('../telemetry-provider/sdk-registry.js');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider.js');

function harness() {
  let now = 1000;
  let profileRevision = 1;
  const values: Record<string, number | boolean> = { lat: 0, lon: 0, heading: 0, gs: 0, wow: true,
    paused: false, slewActive: false, parkingBrake: false, eng1Combustion: true, eng2Combustion: true,
    engineCount: 2, engineType: 1, thr1: 0, thr2: 0, athrArmed: false, athrActive: false,
    cameraState: 2, crashFlag: 0, crashSequence: 0, userInput: true };
  const times: Record<string, string> = {};
  const bridge = () => {
    const sdk = new SdkBridge(getSdkAdapterById('clientdata-manifest'));
    // Exercise the real bridge snapshot/status lifecycle without spawning a sidecar.
    sdk.connect({ connector: 'pmdg-737-ng3-clientdata' });
    return sdk;
  };
  const provider = Object.assign(new SimConnectTelemetryProvider(), {
    _connected: true, _systemState: { sim: 1 }, _simRunning: true, _data: values, _autotaxiConnectionEpoch: 1,
    _autotaxiConnectionStartedAtMs: now, _rustControlReadbackNotBeforeMs: 0,
    _rustSimvarBridge: { getSnapshot: () => ({ status: 'running', values, valueUpdatedAt: times }) },
    _sdkBridge: bridge() });
  const refreshSimvars = () => { for (const key of Object.keys(values)) times[key] = new Date(now).toISOString(); };
  refreshSimvars();
  const sdkMessage = (message: Record<string, unknown>) => provider._sdkBridge._onStdout(JSON.stringify(message) + '\n');
  const sdkSnapshot = (at = now, armed = false) => sdkMessage({ type: 'snapshot', timestampIso: new Date(at).toISOString(),
    values: { at_armed: armed, at_active: false }, normalized: { automation: { athr: { armed, active: false } } } });
  const session = createPmdgAutotaxi(provider, { getActiveProfileId: () => 'bundled/msfs/pmdg-737',
    getActiveProfileRevision: () => profileRevision }, () => now, { resolveModel: () => ({ ok: true,
      identity: 'readiness-737', sourceFiles: [], fingerprint: 'readiness737', wheelbaseM: 15.6,
      maxSteeringDeg: 75, wheelTrackM: 5.7, lengthM: 39.5, noseOffsetM: 16 }) });
  provider._autotaxi = session;
  return { provider, session, times, values, bridge, sdkMessage, sdkSnapshot,
    now: () => now, advance: (ms: number) => { now += ms; refreshSimvars(); },
    changeProfile: () => { profileRevision++; } };
}

function enableTaxiTransport(h: ReturnType<typeof harness>) {
  const events: [string, number][] = [];
  Object.assign(h.provider, {
    _lvarBridge: { sendEvent: async (name: string, value: number) => { events.push([name, value]); return { ok: true }; } },
    _msfsFacilitiesGeometryProvider: { probeAirport: async () => ({ ok: true }), getTaxiAirport: () => ({
      origin: { lat: 0, lon: 0 }, threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27',
      graph: { complete: true,
        points: [[0, 0, 0, 1], [1, 0, 100, 1], [2, 0, 200, 2], [3, 0, 260, 1], [4, 1000, 260, 1]]
          .map(([id, x, z, type]) => ({ id, x, z, type, orientation: 0 })),
        paths: [[0, 1], [1, 2], [2, 3], [3, 4]].map(([start, end], id) => ({ id, start, end,
          type: id === 3 ? 2 : 1, runway: id === 3 ? '09' : null, widthM: 45 })) },
    }) },
  });
  return events;
}

test('production taxi boundary restarts a dead control bridge once and sends only stop after recovery', async () => {
  const h = harness();
  const events = enableTaxiTransport(h);
  h.sdkSnapshot();
  let starts = 0;
  const bridge = h.provider._lvarBridge;
  const send = bridge.sendEvent;
  bridge._started = false;
  bridge.getSnapshot = () => ({ status: bridge._started ? 'connected' : 'stopped' });
  bridge.sendEvent = async (name: string, value: number) => bridge._started ? send(name, value) : { ok: false, error: 'sidecar_unavailable' };
  h.provider._ensureControlWriteBridge = async () => { starts++; bridge._started = true; return bridge; };
  try {
    const state = await h.session.request({ operation: 'start', icao: 'TEST', runway: '09',
      profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1 }, {});
    assert.equal(starts, 1);
    assert.equal(state.status, 'fault');
    assert.match(state.error!, /Control connection recovered/);
    assert.deepEqual(events, [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0],
      ['AXIS_LEFT_BRAKE_SET', 16383], ['AXIS_RIGHT_BRAKE_SET', 16383], ['AXIS_STEERING_SET', 0]]);
  } finally { await h.session.dispose(); }
});

const lifecycleInterruptions: { label: string; interrupt: (h: ReturnType<typeof harness>) => void; inMenu: boolean }[] = [
  { label: 'SimStop before SystemState catches up', interrupt: h => h.provider._handleRustSystemEvent({ name: 'SimStop' }), inMenu: true },
  { label: 'menu camera', interrupt: h => { h.values.cameraState = 9; }, inMenu: true },
  { label: 'crash flag', interrupt: h => { h.values.crashFlag = 1; }, inMenu: true },
  { label: 'crash sequence', interrupt: h => { h.values.crashSequence = 1; }, inMenu: true },
  { label: 'user input disabled', interrupt: h => { h.values.userInput = false; }, inMenu: false },
  { label: 'numeric user-input readback disabled', interrupt: h => { h.values.userInput = 0; }, inMenu: false },
];

test('simulator lifecycle interruptions prevent starts at the PMDG capture boundary', async () => {
  for (const interruption of lifecycleInterruptions) {
    const h = harness();
    const events = enableTaxiTransport(h);
    h.sdkSnapshot();
    interruption.interrupt(h);
    h.advance(250);
    assert.equal((await h.provider.nextFrame()).inMenu, interruption.inMenu, interruption.label);
    assert.equal(h.session.state().canStart, false, interruption.label);
    await assert.rejects(h.session.request({ operation: 'start', icao: 'TEST', runway: '09',
      profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1 }, {}, () => true), /simulator controls available/, interruption.label);
    assert.deepEqual(events, [], interruption.label);
    await h.session.dispose();
  }
});

test('active taxi stops on lifecycle interruptions and never resumes itself when simulator control returns', async () => {
  for (const interruption of lifecycleInterruptions) {
    const h = harness();
    const events = enableTaxiTransport(h);
    h.sdkSnapshot();
    const owner = {};
    try {
      await h.session.request({ operation: 'start', icao: 'TEST', runway: '09',
        profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1 }, owner, () => true);
      assert(events.some(([name, value]) => name === 'THROTTLE1_SET' && value > 0));
      interruption.interrupt(h);
      h.advance(250);
      assert.equal((await h.provider.nextFrame()).inMenu, interruption.inMenu, interruption.label);
      events.length = 0;
      await h.session.request({ operation: 'status' }, owner, () => true);
      await h.session.tick();
      assert.equal(h.session.state().status, 'fault', interruption.label);
      assert.deepEqual(events, [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0],
        ['AXIS_LEFT_BRAKE_SET', 16383], ['AXIS_RIGHT_BRAKE_SET', 16383], ['AXIS_STEERING_SET', 0]], interruption.label);

      h.provider._handleRustSystemEvent({ name: 'SimStart' });
      Object.assign(h.values, { cameraState: 2, crashFlag: 0, crashSequence: 0, userInput: true });
      h.advance(250);
      events.length = 0;
      await h.session.tick();
      assert.equal(h.session.state().status, 'fault', `${interruption.label}: no automatic resumption`);
      assert(events.every(([name, value]) => !name.startsWith('THROTTLE') || value === 0));

      // Release remains available even after another interruption.
      interruption.interrupt(h);
      events.length = 0;
      await h.provider.requestAutotaxi({ operation: 'release' }, owner, () => true);
      assert.equal(h.session.state().status, 'idle');
      assert.deepEqual(events, [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0],
        ['AXIS_LEFT_BRAKE_SET', -16383], ['AXIS_RIGHT_BRAKE_SET', -16383], ['AXIS_STEERING_SET', 0]], interruption.label);
    } finally { await h.session.dispose(); }
  }
});

test('enabled Autotaxi creates a session but preserves readiness checks and source-owned configuration', async () => {
  const shared = require('../../shared/app-settings-shared.js');
  assert.equal(shared.LIVE_AUTOTAXI_ENABLED, true);
  assert.equal(Object.isFrozen(shared), true, 'the source-only gate is not a mutable runtime setting');
  const patch = shared.sanitizeAppSettingsPatch({ autotaxi: { enabled: false },
    simulator: { liveAutotaxiEnabled: false }, LIVE_AUTOTAXI_ENABLED: false });
  assert.equal(patch.autotaxi, undefined);
  assert.equal(patch.simulator.liveAutotaxiEnabled, undefined);
  assert.equal(patch.LIVE_AUTOTAXI_ENABLED, undefined);

  const provider = new SimConnectTelemetryProvider();
  Object.assign(provider, {
    _rustSimvarBridge: { getSnapshot: () => ({ status: 'disconnected', values: {}, valueUpdatedAt: {} }) },
    _msfsFacilitiesGeometryProvider: { probeAirport: () => assert.fail('readiness precedes facility lookup') },
    _lvarBridge: { sendEvent: () => assert.fail('unready aircraft must not receive control writes') },
  });
  try {
    for (const operation of ['start', 'preview']) {
      await assert.rejects(provider.requestAutotaxi({ operation, icao: 'TEST', runway: '09',
        profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1, enabled: true,
        LIVE_AUTOTAXI_ENABLED: true, settings: { autotaxi: { enabled: true } } }, {}, () => true),
      /engine configuration|disconnected/i);
    }
    assert.ok(provider._autotaxi, 'the production entry point creates the enabled session');
    for (const operation of ['status', 'stop', 'release']) {
      const state = await provider.requestAutotaxi({ operation }, {}, () => true);
      assert.equal(state.canStart, false);
      assert.equal(state.active, false);
      assert.match(state.unavailableReason, /engine configuration|disconnected/i);
    }
  } finally { await provider._autotaxi?.dispose(); }
});

test('enabled provider starts a ready aircraft, preserves status polling and explicitly stops and releases controls', async () => {
  const h = harness();
  const events = enableTaxiTransport(h);
  h.sdkSnapshot();
  const owner = {};
  try {
    await h.provider.requestAutotaxi({ operation: 'start', icao: 'TEST', runway: '09',
      profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1 }, owner, () => true);
    assert(events.some(([name, value]) => name === 'THROTTLE1_SET' && value > 0));
    const running = await h.provider.requestAutotaxi({ operation: 'status' }, owner, () => true);
    assert.equal(running.status, 'taxiing');
    assert.equal(running.active, true);
    events.length = 0;
    await h.provider.requestAutotaxi({ operation: 'stop' }, owner, () => true);
    assert.deepEqual(events, [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0],
      ['AXIS_LEFT_BRAKE_SET', 16383], ['AXIS_RIGHT_BRAKE_SET', 16383], ['AXIS_STEERING_SET', 0]]);
    const stopped = await h.provider.requestAutotaxi({ operation: 'status' }, owner, () => true);
    assert.notEqual(stopped.status, 'taxiing');
    h.advance(250);
    await h.session.tick();
    assert(events.every(([name, value]) => !name.startsWith('THROTTLE') || value === 0));
    events.length = 0;
    const released = await h.provider.requestAutotaxi({ operation: 'release' }, owner, () => true);
    assert.equal(released.status, 'idle');
    assert.equal(released.canStart, true, 'a healthy aircraft remains available after explicit release');
    assert.deepEqual(events, [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0],
      ['AXIS_LEFT_BRAKE_SET', -16383], ['AXIS_RIGHT_BRAKE_SET', -16383], ['AXIS_STEERING_SET', 0]]);
  } finally { await h.session.dispose(); }
});

test('quiet PMDG ClientData remains usable while independent motion SimVars stay fresh', () => {
  const h = harness();
  assert.equal(h.session.state().canStart, false, 'a connected target alone is not an SDK payload');
  h.sdkSnapshot();
  assert.equal(h.session.state().canStart, true);
  const original = h.provider._sdkBridge.getSnapshot();
  h.advance(60_000);
  assert.equal(h.session.state().canStart, true, 'on-change ClientData is not a 1.5-second heartbeat');
  assert.equal(h.provider._sdkBridge.getSnapshot().updatedAt, original.updatedAt, 'never manufacture freshness');
  assert.equal(h.provider._sdkBridge.getSnapshot().snapshotSequence, original.snapshotSequence);
  h.times.gs = new Date(h.now() - 1001).toISOString();
  assert.equal(h.session.state().canStart, false, 'quiet SDK must not relax the motion freshness guard');
  h.advance(250);
  h.values.athrArmed = true;
  assert.equal(h.session.state().canStart, false, 'fresh simulator autothrottle guard remains active');
  h.values.athrArmed = false;
  h.sdkSnapshot(h.now(), true);
  assert.equal(h.session.state().canStart, false, 'SDK autothrottle guard remains active');
});

test('active taxi survives quiet SDK data and stops writing if its SDK bridge is replaced', async () => {
  const h = harness();
  const events = enableTaxiTransport(h);
  h.sdkSnapshot();
  const owner = {};
  try {
    await h.session.request({ operation: 'start', icao: 'TEST', runway: '09',
      profileKey: 'bundled/msfs/pmdg-737', profileRevision: 1 }, owner);
    for (let tick = 0; tick < 16; tick++) {
      h.advance(250);
      await h.session.request({ operation: 'status' }, owner);
      await h.session.tick();
      assert.equal(h.session.state().status, 'taxiing', `quiet SDK tick ${tick}`);
    }
    assert.equal(events.length, 17 * 5);
    h.provider._sdkBridge = h.bridge();
    h.sdkSnapshot();
    await h.session.tick();
    assert.equal(h.session.state().status, 'fault');
    assert.equal(events.length, 17 * 5, 'do not send even a stop into a different SDK ownership scope');
    await h.session.request({ operation: 'release' }, owner);
  } finally { await h.session.dispose(); }
});

test('SDK disconnect, error and missing payload still prevent taxi readiness', () => {
  const h = harness();
  h.sdkSnapshot();
  assert.equal(h.session.state().canStart, true);
  h.sdkMessage({ type: 'status', state: 'error', error: 'dispatch failed' });
  assert.equal(h.session.state().canStart, false);
  h.advance(250); h.sdkSnapshot();
  assert.equal(h.session.state().canStart, true);
  h.sdkMessage({ type: 'status', state: 'disconnected' });
  assert.equal(h.provider._sdkBridge.getSnapshot().updatedAt, null);
  assert.equal(h.session.state().canStart, false);
  h.sdkMessage({ type: 'status', state: 'running' });
  assert.equal(h.session.state().canStart, false, 'transport status does not replace the initial payload');
  h.advance(250); h.sdkSnapshot();
  assert.equal(h.session.state().canStart, true);
});

test('cached SDK data cannot cross native reconnect, aircraft, profile or SDK bridge boundaries', () => {
  for (const scope of ['native-reconnect', 'aircraft', 'profile', 'sdk-bridge']) {
    const h = harness();
    h.sdkSnapshot();
    assert.equal(h.session.state().canStart, true);
    h.advance(5000);
    if (scope === 'native-reconnect') {
      h.provider._autotaxiConnectionEpoch++;
      h.provider._autotaxiConnectionStartedAtMs = h.now();
    } else if (scope === 'aircraft') h.provider._rustControlReadbackNotBeforeMs = h.now();
    else if (scope === 'profile') h.changeProfile();
    else {
      h.provider._sdkBridge = h.bridge();
      h.sdkSnapshot(1000);
    }
    assert.equal(h.session.state().canStart, false, scope);
    h.sdkSnapshot();
    assert.equal(h.session.state().canStart, true, `${scope}: the new scope's payload is accepted`);
    h.advance(5000);
    assert.equal(h.session.state().canStart, true, `${scope}: its unchanged payload remains usable`);
  }
});

test('post-change SDK payloads received before the next capture remain valid across scopes', () => {
  for (const scope of ['native-reconnect', 'aircraft', 'profile', 'sdk-bridge']) {
    const h = harness();
    h.sdkSnapshot();
    assert.equal(h.session.state().canStart, true);
    h.advance(5000);
    const changedAt = h.now();
    if (scope === 'native-reconnect') {
      h.provider._autotaxiConnectionEpoch++;
      h.provider._autotaxiConnectionStartedAtMs = changedAt;
    } else if (scope === 'aircraft') h.provider._rustControlReadbackNotBeforeMs = changedAt;
    else if (scope === 'profile') h.changeProfile();
    else h.provider._sdkBridge = h.bridge();
    h.advance(100);
    h.sdkSnapshot(); // Received after the real change, before Autotaxi observes it.
    const payloadAt = h.now();
    h.advance(100);
    assert.equal(h.session.state().canStart, true, `${scope}: do not invent a later capture-time boundary`);
    assert.equal(h.provider._sdkBridge.getSnapshot().updatedAt, new Date(payloadAt).toISOString());
    h.advance(60_000);
    assert.equal(h.session.state().canStart, true, `${scope}: no second payload is required`);
  }
});

test('an SDK payload newer than the last observed one still cannot predate the actual aircraft boundary', () => {
  for (const scope of ['native-reconnect', 'aircraft']) {
    const h = harness();
    h.sdkSnapshot();
    assert.equal(h.session.state().canStart, true);
    h.advance(5000);
    if (scope === 'native-reconnect') {
      h.provider._autotaxiConnectionEpoch++;
      h.provider._autotaxiConnectionStartedAtMs = h.now();
    } else h.provider._rustControlReadbackNotBeforeMs = h.now();
    h.sdkSnapshot(h.now() - 100);
    h.advance(100);
    assert.equal(h.session.state().canStart, false, `${scope}: pre-boundary payload is rejected`);
    h.sdkSnapshot(h.now() - 50);
    assert.equal(h.session.state().canStart, true, `${scope}: already-received post-boundary payload is accepted`);
  }
});

test('first SDK payload must belong to the current aircraft and have a real source timestamp', () => {
  const h = harness();
  h.sdkSnapshot(999);
  assert.equal(h.session.state().canStart, false, 'pre-connection SDK cache is rejected on the first capture');
  h.sdkSnapshot(1001);
  assert.equal(h.session.state().canStart, false, 'future timestamps are not accepted');
  h.sdkMessage({ type: 'snapshot', values: { at_armed: false } });
  assert.equal(h.session.state().canStart, false, 'a payload without its source timestamp is not accepted');
  h.sdkSnapshot();
  assert.equal(h.session.state().canStart, true);
  h.advance(250); h.sdkSnapshot();
  assert.equal(h.session.state().canStart, true);
  h.sdkSnapshot(1000);
  assert.equal(h.session.state().canStart, false, 'a timestamp regression is not an unchanged SDK payload');
  h.sdkSnapshot();
  assert.equal(h.session.state().canStart, true);
  h.provider._sdkBridge.connect({ connector: 'pmdg-777x-clientdata' });
  assert.equal(h.session.state().canStart, false, 'SDK target change clears the old payload');
  h.sdkSnapshot();
  assert.equal(h.session.state().canStart, false, 'another aircraft SDK is rejected even with a payload');
});
