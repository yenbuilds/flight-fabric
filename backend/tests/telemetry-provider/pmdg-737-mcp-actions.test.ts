const assert = require('node:assert/strict');
const test = require('node:test');

const profileLoader = require('../../aircraft/aircraft-profile-loader');
const { executeAircraftCommand } = require('../../aircraft/aircraft-control-service');
const { SimConnectTelemetryProvider } = require('../../telemetry-provider/simconnect-telemetry-provider');

const PROFILE_KEY = 'bundled/msfs/pmdg-737';
const PROFILE_KEYS = [
  'bundled/msfs/pmdg-737-600', 'bundled/msfs/pmdg-737-700',
  PROFILE_KEY, 'bundled/msfs/pmdg-737-900',
];
const TARGETS = [
  { commandId: 'flightGuidance.heading.set', event: '#84136', key: 'headingDeg', initial: 166, target: 167 },
  { commandId: 'flightGuidance.speed.set', event: '#84134', key: 'iasMach', initial: 100, target: 101 },
  { commandId: 'flightGuidance.altitude.set', event: '#84137', key: 'altitudeFt', initial: 10000, target: 10100 },
] as const;

async function withMcpFixture(profileKey, run) {
  const originalProfileKey = profileLoader.getActiveProfileId();
  try {
    profileLoader.setActiveProfile(profileKey);
    const profileRevision = profileLoader.getActiveProfileRevision();
    const provider = new SimConnectTelemetryProvider();
    provider._connected = true;
    provider._systemState = { sim: 1 };
    provider._data = { userInput: true };
    // Recorded target changes from the 737-800BCF acceptance session on 2 October.
    // Applying them to other trusted profiles is automated contract coverage only.
    // A current-generation CHANGED SDK snapshot remains usable while unchanged.
    let observedAt = Date.now() - 60000;
    const snapshot: any = {
      adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 1,
      updatedAt: new Date(observedAt).toISOString(),
      normalized: { automation: { ap: { selected: Object.fromEntries(
        TARGETS.map(({ key, initial }) => [key, initial]),
      ) } } },
    };
    const events: Array<{ name: string; value: number }> = [];
    const fixture = {
      provider, snapshot, events, connected: true,
      publish(key, value) {
        snapshot.normalized.automation.ap.selected[key] = value;
        snapshot.snapshotSequence += 1;
        snapshot.updatedAt = new Date(++observedAt).toISOString();
      },
      onEvent(name, value): any {
        const target = TARGETS.find((candidate) => candidate.event === name);
        assert.ok(target, `unexpected SDK command ${name}`);
        fixture.publish(target.key, value);
        return { ok: true, sendId: events.length };
      },
      async execute(commandId, value, token = {}) {
        // Independent requests skip real-time cooldown waits. The existing SDK
        // suite separately checks IAS/Mach in-flight and shared cooldown guards.
        provider._aircraftIntegrationActionLastAttemptAt.clear();
        return executeAircraftCommand(provider, {
          commandId, input: { value }, profileKey, profileRevision, ...token,
        }, {
          profile: profileLoader.loadProfile(profileKey), profileRevision,
          requireProfileToken: true, capabilities: provider.getAircraftControlCapabilities(),
        });
      },
    };
    provider._sdkBridge = {
      getSnapshot: () => snapshot,
      isDataConnected: () => fixture.connected,
    };
    const bridge = {
      getSnapshot: () => ({ status: 'running' }),
      async sendSdkEvent(name, value) {
        events.push({ name, value });
        return fixture.onEvent(name, value);
      },
      async sendEvent() { throw new Error('MCP SDK targets must not fall back to standard events'); },
      async setNamedVar() { throw new Error('MCP SDK targets must not fall back to LVAR writes'); },
    };
    provider._lvarBridge = bridge;
    provider._ensureControlWriteBridge = async () => bridge;
    await run(fixture);
  } finally {
    profileLoader.setActiveProfile(originalProfileKey);
  }
}

test('PMDG MCP commands use trusted profile fields for SDK confirmation, no-op repeats and restoration', async () => {
  for (const profileKey of PROFILE_KEYS) {
    await withMcpFixture(profileKey, async (fixture) => {
      for (const target of TARGETS) {
        const before = fixture.events.length;
        const changed = await fixture.execute(target.commandId, target.target);
        assert.equal(changed.ok, true, `${profileKey} ${target.commandId}: ${changed.error}`);
        assert.equal(changed.confirmedValue, target.target);
        assert.equal(changed.transportMode, 'sdk');
        assert.equal(changed.transportAcknowledged, undefined, 'an ACK alone is not target confirmation');
        assert.deepEqual(fixture.events.slice(before), [{ name: target.event, value: target.target }]);
        const repeated = await fixture.execute(target.commandId, target.target);
        assert.equal(repeated.ok, true);
        assert.equal(repeated.noOp, true);
        assert.equal(fixture.events.length, before + 1, 'an already observed target must not be rewritten');
        const restored = await fixture.execute(target.commandId, target.initial);
        assert.equal(restored.ok, true);
        assert.equal(restored.confirmedValue, target.initial);
        assert.deepEqual(fixture.events.slice(before), [
          { name: target.event, value: target.target },
          { name: target.event, value: target.initial },
        ]);
      }
    });
  }
});

test('PMDG MCP inputs preserve inclusive bounds, valid zero and cockpit increments', async () => {
  await withMcpFixture(PROFILE_KEY, async (fixture) => {
    // Input-domain boundary checks, not a suggested flight configuration.
    for (const [commandId, values] of [
      ['flightGuidance.heading.set', [0, 359]],
      ['flightGuidance.speed.set', [399, 100]],
      ['flightGuidance.altitude.set', [0, 50000]],
    ] as const) {
      for (const value of values) {
        const result = await fixture.execute(commandId, value);
        assert.equal(result.ok, true, `${commandId}=${value}: ${result.error}`);
        assert.equal(result.confirmedValue, value);
      }
    }
    const before = fixture.events.length;
    for (const [commandId, values] of [
      ['flightGuidance.heading.set', [-1, 360, 166.5]],
      ['flightGuidance.speed.set', [99, 400, 100.5]],
      ['flightGuidance.altitude.set', [-100, 50100, 10050]],
    ] as const) {
      for (const value of values) {
        const result = await fixture.execute(commandId, value);
        assert.equal(result.ok, false, `${commandId}=${value}`);
        assert.equal(result.code, 'invalid_command_input');
      }
    }
    assert.equal(fixture.events.length, before, 'invalid targets must never reach the SDK');
  });
});

test('PMDG MCP commands reject stale profile tokens before any SDK write', async () => {
  await withMcpFixture(PROFILE_KEY, async (fixture) => {
    for (const target of TARGETS) {
      for (const token of [
        { profileKey: 'bundled/msfs/pmdg-737-900' },
        { profileRevision: profileLoader.getActiveProfileRevision() - 1 },
      ]) {
        const result = await fixture.execute(target.commandId, target.target, token);
        assert.equal(result.ok, false);
        assert.equal(result.code, 'stale_profile');
      }
    }
    assert.equal(fixture.events.length, 0);
  });
});

test('PMDG MCP SDK capability loss blocks writes and recovery uses the same command path', async () => {
  await withMcpFixture(PROFILE_KEY, async (fixture) => {
    fixture.connected = false;
    assert.equal(fixture.provider.getAircraftControlCapabilities().integrationTransports.sdk, false);
    for (const target of TARGETS) {
      assert.equal((await fixture.execute(target.commandId, target.target)).ok, false);
    }
    assert.equal(fixture.events.length, 0);
    fixture.connected = true;
    assert.equal(fixture.provider.getAircraftControlCapabilities().integrationTransports.sdk, true);
    for (const target of TARGETS) {
      assert.equal((await fixture.execute(target.commandId, target.target)).ok, true);
    }
    assert.equal(fixture.events.length, 3);
  });
});

test('PMDG MCP missing or previous-generation readbacks never become zero or same-target no-ops', async () => {
  for (const target of TARGETS) {
    for (const condition of ['missing', 'invalid', 'stopped', 'reset-sequence', 'wrong-adapter']) {
      await withMcpFixture(PROFILE_KEY, async (fixture) => {
        const selected = fixture.snapshot.normalized.automation.ap.selected;
        if (condition === 'missing') delete selected[target.key];
        // Deliberately invalid telemetry tests rejection, not aircraft behavior.
        if (condition === 'invalid') selected[target.key] = 'unavailable';
        if (condition === 'stopped') fixture.snapshot.status = 'stopped';
        if (condition === 'reset-sequence') fixture.snapshot.snapshotSequence = 0;
        if (condition === 'wrong-adapter') fixture.snapshot.adapterId = 'different-sdk';
        const result = await fixture.execute(target.commandId, target.initial);
        assert.equal(result.ok, false, `${target.commandId} ${condition}`);
        assert.equal(result.noOp, undefined);
        assert.equal(fixture.events.length, 0);
      });
    }
  }
});

test('PMDG MCP accepted writes require newer independent target readback and never retry', async () => {
  for (const [index, target] of TARGETS.entries()) {
    await withMcpFixture(PROFILE_KEY, async (fixture) => {
      fixture.onEvent = () => {
        if (index === 0) fixture.publish(target.key, target.initial); // New snapshot, unchanged selector.
        if (index === 1) fixture.snapshot.normalized.automation.ap.selected[target.key] = target.target;
        // Altitude has no new snapshot at all. IAS has a matching cached value
        // without a new sequence. Neither is independent confirmation.
        return { ok: true, sendId: 42 };
      };
      const result = await fixture.execute(target.commandId, target.target);
      assert.equal(result.ok, false, target.commandId);
      assert.equal(result.code, 'aircraft_integration_readback_timeout');
      assert.equal(result.executionStarted, true);
      assert.deepEqual(fixture.events, [{ name: target.event, value: target.target }]);
      assert.equal(fixture.provider._aircraftIntegrationActionsInFlight.size, 0, 'failed confirmation releases its lock');
    });
  }
});

test('PMDG MCP transport rejections cannot be reported as confirmed or retried', async () => {
  for (const target of TARGETS) {
    await withMcpFixture(PROFILE_KEY, async (fixture) => {
      fixture.onEvent = () => ({ ok: false, error: 'Test sidecar rejected SDK event' });
      const result = await fixture.execute(target.commandId, target.target);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'sdk_execution_failed');
      assert.deepEqual(fixture.events, [{ name: target.event, value: target.target }]);
      assert.equal(fixture.provider._aircraftIntegrationActionsInFlight.size, 0);
    });
  }
});

test('PMDG MCP confirmation rejects aircraft changeover or a retired SDK snapshot during dispatch', async () => {
  for (const condition of ['profile-changed', 'sdk-retired']) {
    await withMcpFixture(PROFILE_KEY, async (fixture) => {
      const target = TARGETS[0];
      fixture.onEvent = () => {
        fixture.publish(target.key, target.target);
        if (condition === 'profile-changed') profileLoader.setActiveProfile('bundled/msfs/generic');
        if (condition === 'sdk-retired') {
          fixture.connected = false;
          fixture.snapshot.status = 'stopped';
          fixture.snapshot.snapshotSequence = 0;
          fixture.snapshot.normalized = {};
        }
        return { ok: true, sendId: 42 };
      };
      const result = await fixture.execute(target.commandId, target.target);
      assert.equal(result.ok, false, condition);
      assert.equal(result.code, 'aircraft_integration_readback_timeout');
      assert.equal(result.executionStarted, true);
      assert.equal(fixture.events.length, 1, 'aircraft changeover must not trigger a fallback or retry');
      assert.equal(fixture.provider._aircraftIntegrationActionsInFlight.size, 0);
    });
  }
});

test('PMDG 737 monitoring never writes controls on startup, AP readback changes, reconnect or shutdown', async (t) => {
  const originalProfileKey = profileLoader.getActiveProfileId();
  const provider = new SimConnectTelemetryProvider();
  const writes = [];
  const subscriptions = [];
  const connections = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  const snapshot: any = {
    status: 'running', adapterId: 'clientdata-manifest', snapshotSequence: 1,
    updatedAt: new Date().toISOString(), values: {},
    normalized: { automation: { ap: { engaged: false, leftEngaged: false, rightEngaged: false } } },
  };
  const bridge = () => ({
    _started: false,
    _adapter: { id: 'clientdata-manifest' },
    async start() { this._started = true; },
    async stop() { this._started = false; },
    isEnabled: () => true,
    isDataConnected: () => true,
    getSnapshot: () => snapshot,
    setSimVars: items => subscriptions.push(...items),
    setSubscriptions: items => subscriptions.push(...items),
    connect: target => connections.push(target),
    ...Object.fromEntries(['sendEvent', 'sendSdkEvent', 'setNamedVar', 'sendInputEvent', 'executeMobiFlightCode', 'startPushback']
      .map(method => [method, async (...args) => {
        writes.push({ method, args });
        return { ok: true };
      }])),
  });
  provider._rustSimvarBridge = bridge();
  provider._lvarBridge = bridge();
  provider._sdkBridge = bridge();
  try {
    profileLoader.setActiveProfile(PROFILE_KEY);
    await provider.start();
    assert.ok(subscriptions.length > 0, 'real provider startup registers telemetry');
    assert.equal(connections.length, 1, 'real profile starts its SDK subscription');
    provider._handleRustSystemState({ name: 'Sim', integer: 1 });
    provider._handleRustSimvarStatus({ status: 'running' });
    // Representative independent states, not a replay of the reported flight.
    // External AP changes must remain observations, including disagreement with
    // the generic AP SimVar, which PMDG profiles declare unreliable.
    for (const state of [
      { wow: 1, ias: 0, ra: 8, vs: 0, ap: false },
      { wow: 0, ias: 175, ra: 1500, vs: 25, ap: false },
      { wow: 0, ias: 175, ra: 1500, vs: 25, ap: true },
      { wow: 0, ias: 175, ra: 1500, vs: 25, ap: false },
    ]) {
      snapshot.updatedAt = new Date().toISOString();
      snapshot.snapshotSequence++;
      snapshot.normalized.automation.ap.engaged = state.ap;
      snapshot.normalized.automation.ap.leftEngaged = state.ap;
      provider._handleRustSimvarSnapshot({ updatedAt: snapshot.updatedAt, values: {
        wow: state.wow, ias: state.ias, ra: state.ra, vs: state.vs,
        apMaster: 0, userInput: 1, paused: 0, cameraState: 2,
      } });
      const frame = await provider.nextFrame();
      assert.equal(frame.sdk.normalized.automation.ap.engaged, state.ap);
    }
    provider._handleRustSimvarStatus({ status: 'disconnected' });
    provider._handleRustSimvarStatus({ status: 'running' });
    await provider._initSdkBridge();
    await provider._initLvarBridge();
    t.mock.timers.tick(10000);
    await new Promise(resolve => setImmediate(resolve));
    await provider.nextFrame();
    assert.equal(Boolean(provider._autotaxi?.isActive()), false);
    assert.equal(Boolean(provider._pushback?.isActive()), false);
    await provider.stop();
    assert.deepEqual(writes, [], 'monitoring, reconnection and cleanup never dispatch aircraft controls');
  } finally {
    await provider.stop();
    require('../../landing/airport-geometry-service').resetAirportGeometryProviders();
    profileLoader.setActiveProfile(originalProfileKey);
  }
});

export {};
