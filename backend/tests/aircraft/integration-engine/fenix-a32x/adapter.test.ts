const assert = require('node:assert/strict');
const test = require('node:test');

const { FENIX_A32X_ADAPTER_ID, FENIX_A32X_INTEGRATION } = require('../../../../aircraft/integration-engine/index');
const { defaultAircraftIntegrationRegistry } = require('../../../../aircraft/integration-engine');
const profileLoader = require('../../../../aircraft/aircraft-profile-loader');
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require('../../../../aircraft/aircraft-control-service');
const { buildAircraftSpecificState, createAircraftSpecificStateProjector } = require('../../../../aircraft/aircraft-specific-state');
const { SimConnectTelemetryProvider } = require('../../../../telemetry-provider/simconnect-telemetry-provider');

const PROFILE_KEYS = ['bundled/msfs/fenix-a319', 'bundled/msfs/fenix-a320', 'bundled/msfs/fenix-a321'];
const FCU_VARIABLES = {
  'flightGuidance.speedValue': 'N_FCU_SPEED',
  'flightGuidance.headingDeg': 'N_FCU_HEADING',
  'flightGuidance.altitudeFt': 'N_FCU_ALTITUDE',
  'flightGuidance.verticalValue': 'N_FCU_VS',
  'flightGuidance.machMode': 'B_FCU_SPEED_MACH',
  'flightGuidance.trkFpaMode': 'B_FCU_TRACK_FPA_MODE',
};
const FCU_IDS = Object.keys(FCU_VARIABLES);
const OBSERVED_AT = '2026-10-12T01:00:00.000Z';

function withFcuConfig(profileKey, run) {
  const original = profileLoader.getActiveProfileId();
  try {
    profileLoader.setActiveProfile(profileKey);
    const lvarConfig = profileLoader.getLvarConfig();
    const config = lvarConfig.aircraftSpecific;
    assert.equal(config.integrationId, FENIX_A32X_ADAPTER_ID);
    assert.equal(config.profileKey, profileKey);
    assert.equal(config.templateId, 'fenix-a32x');
    const fields = config.fields.filter(field => FCU_IDS.includes(field.id));
    assert.deepEqual(fields.map(field => field.id).sort(), [...FCU_IDS].sort());
    for (const field of fields) {
      assert.equal(field.source.type, 'lvar');
      const subscription = lvarConfig.subscriptions.find(item => item.key === field.source.key);
      assert.equal(subscription.expression, `(L:${FCU_VARIABLES[field.id]})`);
      assert.equal(subscription.unit, 'Number');
      const confirmationField = config.confirmationFields.find(item => item.id === field.id);
      assert.deepEqual(confirmationField, field, 'display and command confirmation use the same resolved field');
    }
    run({ ...config, fields });
  } finally {
    profileLoader.setActiveProfile(original);
  }
}

function fcuSnapshot(config, overrides = {}, updatedAt = OBSERVED_AT) {
  // Representative selected IAS/heading/altitude and descending V/S. These
  // are source-boundary fixtures, not additional live aircraft qualification.
  const values = {
    'flightGuidance.speedValue': 250,
    'flightGuidance.headingDeg': 273,
    'flightGuidance.altitudeFt': 10000,
    'flightGuidance.verticalValue': -1500,
    'flightGuidance.machMode': 0,
    'flightGuidance.trkFpaMode': 0,
    ...overrides,
  };
  return {
    enabled: true,
    profileId: config.profileKey,
    status: 'running',
    snapshotSequence: 7,
    updatedAt,
    values: Object.fromEntries(config.fields.map(field => [field.source.key, values[field.id]])),
    valueUpdatedAt: Object.fromEntries(config.fields.map(field => [field.source.key, updatedAt])),
  };
}

function projectState(config, lvars, connected = true) {
  return buildAircraftSpecificState({
    config,
    frame: { simconnect: { connected }, lvars },
    simState: { simconnectConnected: connected, inMenu: false },
    nowEpochMs: Date.parse(OBSERVED_AT),
  });
}

test('Fenix FCU selected targets and independent modes resolve for each exact trusted variant', () => {
  assert.deepEqual(FENIX_A32X_INTEGRATION.trustedProfileKeys, PROFILE_KEYS);
  for (const profileKey of PROFILE_KEYS) {
    assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FENIX_A32X_ADAPTER_ID, { profileKey }).id,
      FENIX_A32X_ADAPTER_ID);
    withFcuConfig(profileKey, config => {
      const state = projectState(config, fcuSnapshot(config));
      assert.deepEqual(state.values, {
        'flightGuidance.speedValue': 250,
        'flightGuidance.headingDeg': 273,
        'flightGuidance.altitudeFt': 10000,
        'flightGuidance.verticalValue': -1500,
        'flightGuidance.machMode': false,
        'flightGuidance.trkFpaMode': false,
      });
      assert.deepEqual(state.unavailable, []);
      assert.equal(state.profileRevision, config.profileRevision);
      assert.deepEqual(state.valueUpdatedAt, Object.fromEntries(FCU_IDS.map(id => [id, OBSERVED_AT])));
      const machFpa = projectState(config, fcuSnapshot(config, {
        'flightGuidance.speedValue': 0.78,
        'flightGuidance.verticalValue': -3.1,
        'flightGuidance.machMode': 1,
        'flightGuidance.trkFpaMode': 1,
      }));
      assert.equal(machFpa.values['flightGuidance.speedValue'], 0.78);
      assert.equal(machFpa.values['flightGuidance.verticalValue'], -3.1);
      assert.equal(machFpa.values['flightGuidance.machMode'], true);
      assert.equal(machFpa.values['flightGuidance.trkFpaMode'], true);
      const zeros = projectState(config, fcuSnapshot(config, Object.fromEntries(FCU_IDS.map(id => [id, 0]))));
      assert.deepEqual(zeros.unavailable, []);
      assert.equal(zeros.values['flightGuidance.headingDeg'], 0);
      assert.equal(zeros.values['flightGuidance.verticalValue'], 0);
      assert.equal(zeros.values['flightGuidance.machMode'], false);
    });
  }
  for (const profileKey of ['bundled/msfs/fenix-a32x-base', 'user/msfs/fenix-a320', 'bundled/msfs/fbw-a32nx']) {
    assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FENIX_A32X_ADAPTER_ID, { profileKey }), null);
  }
});

test('Fenix FCU keeps numeric precision and rejects deliberately invalid source encodings', () => {
  withFcuConfig(PROFILE_KEYS[1], config => {
    // Artificial decoder boundary samples exercise rounding, not a cockpit claim.
    const rounded = projectState(config, fcuSnapshot(config, {
      'flightGuidance.speedValue': 0.784,
      'flightGuidance.headingDeg': 273.4,
      'flightGuidance.altitudeFt': 10000.4,
      'flightGuidance.verticalValue': -3.126,
    }));
    assert.equal(rounded.values['flightGuidance.speedValue'], 0.78);
    assert.equal(rounded.values['flightGuidance.headingDeg'], 273);
    assert.equal(rounded.values['flightGuidance.altitudeFt'], 10000);
    assert.equal(rounded.values['flightGuidance.verticalValue'], -3.13);
    for (const invalid of [undefined, null, '1', true, 2]) {
      const state = projectState(config, fcuSnapshot(config, {
        'flightGuidance.machMode': invalid, 'flightGuidance.trkFpaMode': invalid,
      }));
      assert.deepEqual(state.unavailable, ['flightGuidance.machMode', 'flightGuidance.trkFpaMode']);
      assert.equal(state.values['flightGuidance.speedValue'], 250, 'unknown mode does not invent target units');
    }
    for (const invalid of [undefined, null, '250', true, NaN, Infinity]) {
      const state = projectState(config, fcuSnapshot(config, { 'flightGuidance.speedValue': invalid }));
      assert.deepEqual(state.unavailable, ['flightGuidance.speedValue']);
      assert.equal(Object.hasOwn(state.values, 'flightGuidance.speedValue'), false);
    }
  });
});

test('Fenix FCU missing, stale, disconnected and previous-aircraft snapshots clear observations', () => {
  withFcuConfig(PROFILE_KEYS[1], config => {
    for (const [snapshot, connected, expectedStatus] of [
      [{ ...fcuSnapshot(config), values: {} }, true, 'connected'],
      [fcuSnapshot(config, {}, '2026-10-12T00:59:57.000Z'), true, 'stale'],
      [{ ...fcuSnapshot(config), status: 'disconnected' }, true, 'disconnected'],
      [fcuSnapshot(config), false, 'disconnected'],
      [{ ...fcuSnapshot(config), profileId: PROFILE_KEYS[0] }, true, 'awaiting-values'],
    ] as const) {
      const state = projectState(config, snapshot, connected);
      assert.equal(state.available, false);
      assert.equal(state.sourceStatus.overall, expectedStatus);
      assert.deepEqual(state.values, {});
      assert.deepEqual(state.valueUpdatedAt, {});
      assert.deepEqual(state.unavailable, FCU_IDS);
    }
  });
});

test('Fenix command readback uses actual resolved FCU fields and requires newer matching observations', () => {
  for (const profileKey of PROFILE_KEYS) withFcuConfig(profileKey, config => {
    const provider = new SimConnectTelemetryProvider();
    provider._connected = true;
    const context = { profileKey, adapterId: FENIX_A32X_ADAPTER_ID, profileRevision: config.profileRevision };
    let snapshot = fcuSnapshot(config, {}, new Date().toISOString());
    const bridge = { getSnapshot: () => snapshot };
    for (const [fieldId, expected] of [
      ['flightGuidance.speedValue', 250], ['flightGuidance.headingDeg', 273],
      ['flightGuidance.altitudeFt', 10000], ['flightGuidance.verticalValue', -1500],
      ['flightGuidance.machMode', false], ['flightGuidance.trkFpaMode', false],
    ]) {
      const sample = provider._captureAircraftIntegrationReadback(bridge, { fieldId }, context);
      assert.equal(sample.observed, expected);
      assert.equal(sample.fresh, true);
      assert.equal(sample.sourceId, `lvar:${config.fields.find(field => field.id === fieldId).source.key}`);
      const readback = { fieldId, expectedValue: expected };
      assert.equal(provider._evaluateAircraftIntegrationReadback(sample, readback, sample).confirmed, false);
      assert.equal(provider._evaluateAircraftIntegrationReadback({ ...sample, sequence: sample.sequence + 1 }, readback, sample).confirmed, true);
    }
    const fieldId = 'flightGuidance.speedValue';
    snapshot = fcuSnapshot(config, {}, new Date(Date.now() - 10000).toISOString());
    assert.equal(provider._captureAircraftIntegrationReadback(bridge, { fieldId }, context).fresh, false);
    snapshot = fcuSnapshot(config, {}, new Date().toISOString());
    snapshot.profileId = 'bundled/msfs/fbw-a32nx';
    assert.equal(provider._captureAircraftIntegrationReadback(bridge, { fieldId }, context).fresh, false);
    snapshot.profileId = profileKey;
    const oldRevision = provider._captureAircraftIntegrationReadback(bridge, { fieldId }, {
      ...context, profileRevision: context.profileRevision - 1,
    });
    assert.equal(oldRevision.observed, null, 'previous generations cannot resolve current confirmation fields');
    assert.equal(oldRevision.sourceId, 'lvar:unavailable');
    snapshot.values = {};
    assert.equal(provider._captureAircraftIntegrationReadback(bridge, { fieldId }, context).observed, null);
  });
});

test('Fenix profile changes rebuild projection and reject the previous variant snapshot before recovery', () => {
  withFcuConfig(PROFILE_KEYS[0], originalConfig => {
    const broadcasts = [];
    const projector = createAircraftSpecificStateProjector({ profileLoader, broadcast: message => broadcasts.push(message) });
    const oldSnapshot = fcuSnapshot(originalConfig);
    const input = { frame: { simconnect: { connected: true }, lvars: oldSnapshot },
      simState: { simconnectConnected: true, inMenu: false }, nowEpochMs: Date.parse(OBSERVED_AT) };
    const first = projector.update(input);
    assert.equal(first.values['flightGuidance.speedValue'], 250);
    profileLoader.setActiveProfile(PROFILE_KEYS[1]);
    const changed = projector.update(input);
    assert.equal(changed.profileKey, PROFILE_KEYS[1]);
    assert.notEqual(changed.profileRevision, originalConfig.profileRevision);
    assert.deepEqual(changed.values, {});
    assert.equal(changed.available, false);
    const recovered = projector.update({ ...input, frame: {
      ...input.frame, lvars: { ...oldSnapshot, profileId: PROFILE_KEYS[1], snapshotSequence: 1 },
    } });
    assert.equal(recovered.values['flightGuidance.speedValue'], 250);
    assert.equal(recovered.profileRevision, changed.profileRevision);
    assert.equal(broadcasts.length, 3);
  });
});

test('combined-session PMDG to Fenix to A32NX to PMDG changeovers replace the active read contract', () => {
  const original = profileLoader.getActiveProfileId();
  try {
    const projector = createAircraftSpecificStateProjector({ profileLoader, broadcast() {} });
    const simState = { simconnectConnected: true, inMenu: false };
    const nowEpochMs = Date.parse(OBSERVED_AT);
    let previousLvars = null;
    let previousRevision = null;
    for (const [profileKey, integrationId, selectedField, expected] of [
      ['bundled/msfs/pmdg-737', 'pmdg-737', 'mcp.altitudeFt', 10000],
      ['bundled/msfs/fenix-a320', 'fenix-a32x', 'flightGuidance.speedValue', 250],
      ['bundled/msfs/fbw-a32nx', 'fbw-a32nx', 'lights.strobeAuto', true],
      ['bundled/msfs/pmdg-737', 'pmdg-737', 'mcp.altitudeFt', 10000],
    ] as const) {
      profileLoader.setActiveProfile(profileKey);
      const { aircraftSpecific: config, subscriptions } = profileLoader.getLvarConfig();
      assert.equal(config.integrationId, integrationId);
      assert.notEqual(config.profileRevision, previousRevision);
      previousRevision = config.profileRevision;
      const selected = config.fields.find(field => field.id === selectedField);
      assert.ok(selected);
      // A bridge retires its SDK snapshot when targets change. A late LVAR
      // snapshot retains its original profile identity and cannot populate the
      // new profile, including logical field IDs shared by the two Airbuses.
      const waiting = projector.update({
        frame: { simconnect: { connected: true }, lvars: previousLvars, sdk: { status: 'stopped' } },
        simState, nowEpochMs,
      });
      assert.equal(waiting.profileKey, profileKey);
      assert.equal(Object.hasOwn(waiting.values, selectedField), false);
      const lvars = {
        enabled: true, profileId: profileKey, status: 'running', snapshotSequence: 1,
        updatedAt: OBSERVED_AT, values: {},
      };
      if (selected.source.type === 'lvar') {
        assert.ok(subscriptions.some(subscription => subscription.key === selected.source.key));
        lvars.values[selected.source.key] = expected === true ? 1 : expected;
      }
      const recovered = projector.update({
        frame: {
          simconnect: { connected: true }, lvars,
          ...(integrationId === 'pmdg-737' ? { sdk: {
            adapterId: 'clientdata-manifest', status: 'running', snapshotSequence: 1,
            updatedAt: OBSERVED_AT, normalized: { automation: { ap: { selected: { altitudeFt: 10000 } } } },
          } } : {}),
        },
        simState, nowEpochMs,
      });
      assert.equal(recovered.values[selectedField], expected);
      assert.equal(recovered.profileRevision, config.profileRevision);
      for (const fieldId of [...Object.keys(recovered.values), ...recovered.unavailable]) {
        assert.ok(config.fields.some(field => field.id === fieldId), `retired field ${fieldId} must not remain`);
      }
      previousLvars = lvars;
    }
  } finally {
    profileLoader.setActiveProfile(original);
  }
});

async function withWingConfig(profileKey, run) {
  const original = profileLoader.getActiveProfileId();
  try {
    profileLoader.setActiveProfile(profileKey);
    const { aircraftSpecific: config, subscriptions } = profileLoader.getLvarConfig();
    const field = config.fields.find(item => item.id === 'lights.wing');
    assert.equal(config.integrationId, FENIX_A32X_ADAPTER_ID);
    assert.equal(field.source.type, 'lvar');
    assert.deepEqual(config.confirmationFields.find(item => item.id === field.id), field);
    const subscription = subscriptions.find(item => item.key === field.source.key);
    assert.equal(subscription.expression, '(L:S_OH_EXT_LT_WING)');
    assert.equal(subscription.unit, 'Number');
    await run({ ...config, fields: [field] }, field);
  } finally {
    profileLoader.setActiveProfile(original);
  }
}

function wingSnapshot(config, value, updatedAt = OBSERVED_AT) {
  const key = config.fields[0].source.key;
  return {
    enabled: true, profileId: config.profileKey, status: 'running',
    snapshotSequence: 7, updatedAt,
    values: { [key]: value }, valueUpdatedAt: { [key]: updatedAt },
  };
}

test('Fenix wing selector keeps OFF distinct from unknown for every trusted variant', async () => {
  for (const profileKey of PROFILE_KEYS) await withWingConfig(profileKey, config => {
    for (const [raw, expected] of [[0, false], [1, true]]) {
      const state = projectState(config, wingSnapshot(config, raw));
      assert.deepEqual(state.values, { 'lights.wing': expected });
      assert.deepEqual(state.unavailable, []);
      assert.equal(state.valueUpdatedAt['lights.wing'], OBSERVED_AT);
    }
    // Deliberately invalid source encodings must never become a valid OFF.
    for (const invalid of [undefined, null, '0', '1', false, true, -1, 2, NaN, Infinity]) {
      const state = projectState(config, wingSnapshot(config, invalid));
      assert.deepEqual(state.values, {});
      assert.deepEqual(state.unavailable, ['lights.wing']);
    }
  });
});

test('Fenix wing projection clears stale or retired snapshots and recovers for the current variant', async () => {
  await withWingConfig(PROFILE_KEYS[1], config => {
    for (const [snapshot, connected, expectedStatus] of [
      [wingSnapshot(config, 1, '2026-10-12T00:59:57.000Z'), true, 'stale'],
      [{ ...wingSnapshot(config, 1), status: 'disconnected' }, true, 'disconnected'],
      [wingSnapshot(config, 1), false, 'disconnected'],
      [{ ...wingSnapshot(config, 1), profileId: PROFILE_KEYS[0] }, true, 'awaiting-values'],
    ] as const) {
      const state = projectState(config, snapshot, connected);
      assert.equal(state.sourceStatus.overall, expectedStatus);
      assert.deepEqual(state.values, {});
      assert.deepEqual(state.unavailable, ['lights.wing']);
    }
    const projector = createAircraftSpecificStateProjector({ profileLoader, broadcast() {} });
    const input = {
      frame: { simconnect: { connected: true }, lvars: wingSnapshot(config, 1) },
      simState: { simconnectConnected: true, inMenu: false }, nowEpochMs: Date.parse(OBSERVED_AT),
    };
    assert.equal(projector.update(input).values['lights.wing'], true);
    profileLoader.setActiveProfile(PROFILE_KEYS[2]);
    const changed = projector.update(input);
    assert.notEqual(changed.profileRevision, config.profileRevision);
    assert.equal(Object.hasOwn(changed.values, 'lights.wing'), false);
    const recovered = projector.update({ ...input, frame: { ...input.frame,
      lvars: { ...input.frame.lvars, profileId: PROFILE_KEYS[2], snapshotSequence: 1 },
    } });
    assert.equal(recovered.values['lights.wing'], true);
    assert.equal(recovered.profileRevision, changed.profileRevision);
  });
});

test('Fenix wing confirmation requires a fresh newer sampled selector and the current profile revision', async () => {
  await withWingConfig(PROFILE_KEYS[1], (config, field) => {
    const provider = new SimConnectTelemetryProvider();
    const context = { profileKey: config.profileKey, adapterId: config.integrationId,
      profileRevision: config.profileRevision };
    let snapshot = wingSnapshot(config, 0, new Date().toISOString());
    const bridge = { getSnapshot: () => snapshot };
    const readback = FENIX_A32X_INTEGRATION.actions['lights.wing.on'].routes[0].readback;
    const baseline = provider._captureAircraftIntegrationReadback(bridge, readback, context);
    assert.equal(baseline.observed, false);
    assert.equal(baseline.sourceId, `lvar:${field.source.key}`);
    snapshot.values[field.source.key] = 1;
    const unadvanced = provider._captureAircraftIntegrationReadback(bridge, readback, context);
    assert.equal(provider._evaluateAircraftIntegrationReadback(unadvanced, readback, baseline).confirmed, false);
    snapshot.snapshotSequence++;
    const confirmed = provider._captureAircraftIntegrationReadback(bridge, readback, context);
    assert.equal(provider._evaluateAircraftIntegrationReadback(confirmed, readback, baseline).confirmed, true);
    for (const invalid of [undefined, null, '1', true, 2]) {
      snapshot.values[field.source.key] = invalid;
      const sample = provider._captureAircraftIntegrationReadback(bridge, readback, context);
      assert.equal(sample.observed, null);
      assert.equal(provider._evaluateAircraftIntegrationReadback(sample, readback, baseline).confirmed, false);
    }
    snapshot = wingSnapshot(config, 1, new Date(Date.now() - 10000).toISOString());
    assert.equal(provider._captureAircraftIntegrationReadback(bridge, readback, context).fresh, false);
    snapshot = wingSnapshot(config, 1, new Date().toISOString());
    snapshot.profileId = PROFILE_KEYS[0];
    assert.equal(provider._captureAircraftIntegrationReadback(bridge, readback, context).fresh, false);
    snapshot.profileId = config.profileKey;
    profileLoader.setActiveProfile(PROFILE_KEYS[2]);
    const retired = provider._captureAircraftIntegrationReadback(bridge, readback, context);
    assert.equal(retired.observed, null);
    assert.equal(retired.sourceId, 'lvar:unavailable');
  });
});

test('canonical Fenix wing commands reach the exact guarded write and sampled readback routes', async () => {
  for (const profileKey of PROFILE_KEYS) await withWingConfig(profileKey, async config => {
    const options = {
      profile: profileLoader.getActiveProfile(), profileRevision: config.profileRevision,
      simState: { simconnectConnected: true, inMenu: false },
      capabilities: { simulator: 'msfs', actionTypes: ['aircraft-integration'],
        integrationTransports: ['mobiflight-calculator', 'lvar'] },
    };
    const command = buildAircraftControlCapabilities(options.profile, options).aircraftCommands.commands
      .find(item => item.id === 'lights.wing.set');
    assert.ok(command, 'the production capability catalogue advertises the wing-light command');
    assert.deepEqual(command.input, { kind: 'boolean' });
    // Catalogue probes do not carry client tokens; actual command requests do.
    const guarded = { ...options, requireProfileToken: true, requireStableSimState: true };
    for (const value of [false, true]) {
      const request = { commandId: 'lights.wing.set', input: { value },
        profileKey, profileRevision: config.profileRevision };
      const resolved = resolveAircraftCommand(request, guarded);
      assert.equal(resolved.ok, true);
      assert.equal(resolved.controlRequest.actionId, `lights.wing.${value ? 'on' : 'off'}`);
      assert.equal(resolved.action.name, FENIX_A32X_ADAPTER_ID);
      assert.equal(resolveAircraftCommand({ ...request, profileRevision: config.profileRevision - 1 }, guarded).code,
        'stale_profile');
      // The same family contract is authorized for all three profiles. Exercise
      // actual provider writes for A320 only; this is not live variant evidence.
      if (profileKey !== PROFILE_KEYS[1]) continue;
      for (const calculator of [true, false]) {
        const provider = new SimConnectTelemetryProvider();
        provider._connected = true;
        const snapshot = { ...wingSnapshot(config, Number(value), new Date().toISOString()),
          mobiflight: { state: calculator ? 'connected' : 'missing', connected: calculator,
            available: calculator, error: null } };
        const writes = [];
        const publishSelector = (observedValue = value) => {
          const key = config.fields[0].source.key;
          snapshot.values[key] = Number(observedValue);
          snapshot.snapshotSequence++;
          snapshot.updatedAt = new Date().toISOString();
          snapshot.valueUpdatedAt[key] = snapshot.updatedAt;
          return { ok: true };
        };
        const bridge = {
          _started: true, getSnapshot: () => snapshot,
          async executeMobiFlightCode(code) { writes.push(code); return publishSelector(); },
          async setNamedVar(operation) { writes.push(operation); return publishSelector(); },
        };
        provider._lvarBridge = bridge;
        provider._ensureControlWriteBridge = async () => bridge;
        const execution = { profileKey, profileRevision: config.profileRevision, request: resolved.controlRequest };
        const noOp = await provider.executeAircraftControlAction(resolved.action, execution);
        assert.equal(noOp.ok, true);
        assert.equal(noOp.noOp, true);
        assert.equal(writes.length, 0, 'an already-selected target does not write');
        // A subsequent observed cockpit switch change makes the target actionable.
        publishSelector(!value);
        const result = await provider.executeAircraftControlAction(resolved.action, execution);
        assert.equal(result.ok, true);
        assert.equal(result.confirmedValue, value);
        assert.equal(result.transportMode, calculator ? 'mobiflight' : 'direct-lvar');
        assert.deepEqual(writes, [calculator ? `${Number(value)} (>L:S_OH_EXT_LT_WING, Number)`
          : { name: 'L:S_OH_EXT_LT_WING', unit: 'Number', value: Number(value), dataType: 'float64' }]);
        const repeated = await provider.executeAircraftControlAction(resolved.action, execution);
        assert.equal(repeated.code, 'action_cooldown');
        assert.equal(writes.length, 1, 'immediate repetition stays behind the group cooldown');
      }
    }
  });
});

export {};
