const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FBW_A32NX_ADAPTER_ID,
  FBW_A32NX_INTEGRATION,
  FBW_A32NX_PROFILE_KEY,
} = require('../../../../aircraft/integration-engine/index');
const { defaultAircraftIntegrationRegistry } = require('../../../../aircraft/integration-engine');
const profileLoader = require('../../../../aircraft/aircraft-profile-loader');
const { buildAircraftSpecificState } = require('../../../../aircraft/aircraft-specific-state');
const { SimConnectTelemetryProvider } = require('../../../../telemetry-provider/simconnect-telemetry-provider');

const LIGHT_FIELD_IDS = [
  'lights.strobeMode', 'lights.strobeAuto', 'lights.strobeActive',
  'lights.beacon', 'lights.nav', 'lights.logo', 'lights.wing',
];
const GAUGE_FIELD_IDS = LIGHT_FIELD_IDS.slice(0, 3);
const SIMVAR_FIELD_IDS = LIGHT_FIELD_IDS.slice(3);
const OBSERVED_AT = '2026-10-12T00:00:00.000Z';

function withLightConfig(run) {
  const previousProfileKey = profileLoader.getActiveProfileId();
  try {
    profileLoader.setActiveProfile(FBW_A32NX_PROFILE_KEY);
    const lvarConfig = profileLoader.getLvarConfig();
    const config = lvarConfig.aircraftSpecific;
    assert.equal(config.integrationId, FBW_A32NX_ADAPTER_ID);
    assert.equal(config.profileKey, FBW_A32NX_PROFILE_KEY);
    assert.equal(config.templateId, 'fbw-a32nx');
    const fields = config.fields.filter(field => LIGHT_FIELD_IDS.includes(field.id));
    assert.deepEqual(fields.map(field => field.id), LIGHT_FIELD_IDS);
    run({ ...config, fields }, lvarConfig.subscriptions);
  } finally {
    profileLoader.setActiveProfile(previousProfileKey);
  }
}

function lightFrame(config, overrides = {}) {
  // Synthetic independent-source fixture: AUTO plus a disabled light state
  // exercises decoding; it does not represent observed parked AUTO behavior.
  const raw = {
    'lights.strobeMode': 1, 'lights.strobeAuto': 1, 'lights.strobeActive': 0,
    'lights.beacon': true, 'lights.nav': 1, 'lights.logo': false, 'lights.wing': 0,
    ...overrides,
  };
  const values = Object.fromEntries(config.fields
    .filter(field => field.source.type === 'lvar')
    .map(field => [field.source.key, raw[field.id]]));
  return {
    simconnect: { connected: true },
    lvars: {
      enabled: true, status: 'running', profileId: FBW_A32NX_PROFILE_KEY,
      updatedAt: OBSERVED_AT, values,
      valueUpdatedAt: Object.fromEntries(Object.keys(values).map(key => [key, OBSERVED_AT])),
    },
    lights: Object.fromEntries(SIMVAR_FIELD_IDS.map(id => [id.slice('lights.'.length), raw[id]])),
  };
}

function projectLights(config, frame) {
  return buildAircraftSpecificState({
    config, frame, simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse(OBSERVED_AT),
  });
}

test('A32NX light pilot uses the exact trusted profile and production subscriptions', () => {
  assert.equal(Object.keys(FBW_A32NX_INTEGRATION.fields).length, 166);
  assert.equal(Object.keys(FBW_A32NX_INTEGRATION.actions).length, 292);
  assert.deepEqual(FBW_A32NX_INTEGRATION.trustedProfileKeys, [FBW_A32NX_PROFILE_KEY]);
  for (const profileKey of ['local/msfs/fbw-a32nx', 'bundled/msfs/fbw-a380x', 'bundled/msfs/fenix-a320']) {
    assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FBW_A32NX_ADAPTER_ID, { profileKey }), null);
  }
  withLightConfig((config, subscriptions) => {
    for (const [id, expression, unit] of [
      ['lights.strobeMode', '(L:LIGHTING_STROBE_0)', 'Number'],
      ['lights.strobeAuto', '(L:STROBE_0_AUTO)', 'Number'],
      ['lights.strobeActive', '(A:LIGHT STROBE)', 'Bool'],
    ]) {
      const field = config.fields.find(candidate => candidate.id === id);
      assert.equal(field.source.type, 'lvar');
      const subscription = subscriptions.find(candidate => candidate.key === field.source.key);
      assert.equal(subscription.expression, expression);
      assert.equal(subscription.unit, unit);
    }
    for (const id of SIMVAR_FIELD_IDS) {
      assert.deepEqual(config.fields.find(field => field.id === id).source, {
        type: 'simvar', name: `LIGHT ${id.slice('lights.'.length).toUpperCase()}`, path: id, unit: 'Bool',
      });
    }
  });
});

test('A32NX light projection separates AUTO selection from enabled state and preserves valid OFF values', () => {
  withLightConfig(config => {
    const state = projectLights(config, lightFrame(config));
    assert.deepEqual(state.values, {
      'lights.strobeMode': 'auto', 'lights.strobeAuto': true, 'lights.strobeActive': false,
      'lights.beacon': true, 'lights.nav': true, 'lights.logo': false, 'lights.wing': false,
    });
    assert.deepEqual(state.unavailable, []);
    assert.deepEqual(state.sourceStatus, { overall: 'connected', sources: { lvar: 'connected', simvar: 'connected' } });
    for (const id of GAUGE_FIELD_IDS) assert.equal(state.valueUpdatedAt[id], OBSERVED_AT);
    for (const [rawMode, expectedMode] of [[0, 'on'], [1, 'auto'], [2, 'off']]) {
      assert.equal(projectLights(config, lightFrame(config, { 'lights.strobeMode': rawMode })).values['lights.strobeMode'], expectedMode);
    }
    const offState = projectLights(config, lightFrame(config, {
      'lights.strobeMode': 2, 'lights.strobeAuto': 0, 'lights.strobeActive': false,
      'lights.beacon': 0, 'lights.nav': false, 'lights.logo': 0, 'lights.wing': false,
    }));
    assert.deepEqual(offState.unavailable, []);
    assert.equal(offState.values['lights.strobeMode'], 'off');
    for (const id of LIGHT_FIELD_IDS.slice(1)) assert.equal(offState.values[id], false);
    const onState = projectLights(config, lightFrame(config, {
      'lights.strobeMode': 0, 'lights.strobeAuto': 0, 'lights.strobeActive': true,
      'lights.beacon': 1, 'lights.nav': true, 'lights.logo': 1, 'lights.wing': true,
    }));
    for (const id of LIGHT_FIELD_IDS.slice(2)) assert.equal(onState.values[id], true);
  });
});

test('A32NX light decoders omit missing and invalid observations instead of manufacturing OFF', () => {
  withLightConfig(config => {
    // Deliberately invalid values exercise unknown-state handling, not aircraft behavior.
    for (const raw of [undefined, null, 'invalid', 3]) {
      const state = projectLights(config, lightFrame(config, Object.fromEntries(LIGHT_FIELD_IDS.map(id => [id, raw]))));
      assert.deepEqual(state.values, {});
      assert.deepEqual(state.unavailable, LIGHT_FIELD_IDS);
    }
    for (const raw of [true, false, '1', '0']) {
      const state = projectLights(config, lightFrame(config, { 'lights.strobeAuto': raw }));
      assert.ok(state.unavailable.includes('lights.strobeAuto'), 'numeric 0/1 LVAR must not accept coercible values');
      assert.equal(state.values['lights.strobeActive'], false, 'a bad AUTO sample must not hide independent enabled state');
    }
  });
});

test('A32NX light projection retires stale or wrong-aircraft gauge data independently of current SimVars', () => {
  withLightConfig(config => {
    const scenarios = [
      { change: { updatedAt: '2026-10-11T23:59:57.000Z' }, status: 'stale' },
      { change: { updatedAt: undefined }, status: 'awaiting-values' },
      { change: { status: 'disconnected' }, status: 'disconnected' },
      { change: { enabled: false }, status: 'disabled' },
      { change: { profileId: 'bundled/msfs/fenix-a320' }, status: 'awaiting-values' },
    ];
    for (const { change, status } of scenarios) {
      const frame = lightFrame(config);
      Object.assign(frame.lvars, change);
      const state = projectLights(config, frame);
      assert.deepEqual(state.unavailable, GAUGE_FIELD_IDS);
      assert.deepEqual(Object.keys(state.values), SIMVAR_FIELD_IDS);
      assert.equal(state.sourceStatus.sources.lvar, status);
      assert.equal(state.sourceStatus.sources.simvar, 'connected');
      assert.equal(state.sourceStatus.overall, 'connected');
    }
    const missingNative = lightFrame(config, Object.fromEntries(SIMVAR_FIELD_IDS.map(id => [id, undefined])));
    const independentGauge = projectLights(config, missingNative);
    assert.deepEqual(independentGauge.unavailable, SIMVAR_FIELD_IDS);
    assert.equal(independentGauge.values['lights.strobeActive'], false);
    assert.equal(independentGauge.sourceStatus.sources.simvar, 'awaiting-values');
    const disconnected = lightFrame(config);
    disconnected.simconnect.connected = false;
    const retired = projectLights(config, disconnected);
    assert.deepEqual(retired.values, {});
    assert.deepEqual(retired.unavailable, LIGHT_FIELD_IDS);
    assert.equal(retired.sourceStatus.overall, 'disconnected');
  });
});

test('A32NX command readbacks resolve real profile fields and retain gauge-mask preference and revision gates', () => {
  withLightConfig(config => {
    const provider = new SimConnectTelemetryProvider();
    const frame = lightFrame(config);
    const snapshot = {
      ...frame.lvars, updatedAt: new Date().toISOString(), snapshotSequence: 7,
      values: { ...frame.lvars.values, standard_light_states: 0 },
    };
    const bridge = { getSnapshot: () => snapshot };
    const context = {
      profileKey: config.profileKey, profileRevision: config.profileRevision, adapterId: config.integrationId,
    };
    // The native mask deliberately disagrees. Gauge OFF must remain a usable readback.
    provider._data = { lightStates: (1 << 0) | (1 << 1) | (1 << 7) | (1 << 8) };
    for (const fieldId of SIMVAR_FIELD_IDS) {
      const captured = provider._captureAircraftIntegrationReadback(bridge, { fieldId }, context);
      assert.equal(captured.observed, false);
      assert.equal(captured.fresh, true);
      assert.equal(captured.sequence, 7);
      assert.equal(captured.sourceId, 'lvar:standard_light_states');
    }
    for (const [fieldId, expected] of [['lights.strobeAuto', true], ['lights.strobeActive', false]]) {
      const captured = provider._captureAircraftIntegrationReadback(bridge, { fieldId }, context);
      assert.equal(captured.observed, expected);
      assert.equal(captured.fresh, true);
    }
    const staleRevision = { ...context, profileRevision: config.profileRevision - 1 };
    assert.equal(provider._getActiveAircraftIntegrationConfig(
      staleRevision.profileKey, staleRevision.adapterId, staleRevision.profileRevision,
    ), null);
    const rejected = provider._captureAircraftIntegrationReadback(bridge, { fieldId: 'lights.beacon' }, staleRevision);
    assert.equal(rejected.observed, null);
    assert.equal(rejected.sourceId, 'lvar:unavailable');
  });
});

export {};
