const test = require('node:test');
const assert = require('node:assert/strict');
const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider');
const { createAircraftIntegrationRegistry } = require('../aircraft/aircraft-integrations');
const { INIBUILDS_A380_INTEGRATION: integration, INIBUILDS_A380_PROFILE_KEY: profileKey } = require('../aircraft/aircraft-integrations/inibuilds-a380');

function fixture(options: any = {}) {
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._lastDetectedAircraftTitle = 'SimObjects\\Airplanes\\inibuilds-a380\\presets\\inibuilds\\a380-800_rr_basic\\config\\aircraft.CFG';
  const values: any = { powered: true, speedDashed: false, speedManaged: false, trackFpa: false,
    headingDashed: false, headingManaged: false, verticalSpeedDashed: false,
    speedValue: 200, speedConfirmed: 200, headingValue: 270, headingConfirmed: 270,
    altitudeValue: 10000, altitudeConfirmed: 10000, verticalSpeedValue: 0, verticalSpeedConfirmed: 0 };
  const calls = []; let sequence = 1, current = true;
  provider._getActiveAircraftIntegrationConfig = () => current ? { profileKey, integrationId: integration.id, profileRevision: 7 } : null;
  provider._captureAircraftIntegrationReadback = (_bridge, readback) => ({
    observed: values[readback.fieldId.split('.').at(-1)], sequence, updatedAtMs: sequence,
    sourceId: readback.fieldId, fresh: current && options.stale !== readback.fieldId,
  });
  // Keep production confirmation semantics but make negative assertions fast.
  const wait = provider._waitForAircraftIntegrationReadback.bind(provider);
  provider._waitForAircraftIntegrationReadback = (bridge, readback, context, baseline) =>
    wait(bridge, { ...readback, timeoutMs: 5 }, context, baseline);
  const bridge: any = { _started: true, getSnapshot: () => ({ status: 'connected', profileId: profileKey, inputEventsAvailable: true }),
    sendEvent: async () => { throw new Error('Standard setter must never be used'); },
    setNamedVar: async ({ name, value }) => {
      calls.push([name, value]); sequence++;
      const target = { 'L:INI_AIRSPEED_DIAL': 'speed', 'L:INI_HEADING_DIAL': 'heading',
        'L:INI_ALTITUDE_DIAL': 'altitude', 'L:INI_VVI_DIAL': 'verticalSpeed' }[name];
      values[`${target}Value`] = value;
      if (!options.echoOnly) values[`${target}Confirmed`] = value;
      if (options.modeChange) values.trackFpa = true;
      if (options.disconnect) current = false;
      return { ok: true, sendId: 4 };
    },
    sendInputEvent: async (...args) => { calls.push(args); sequence++; values.verticalSpeedDashed = false; values.verticalSpeedValue = 0; return { ok: true, sendId: 5 }; },
    findRecentSimConnectException: () => null,
  };
  const execute = (name = 'speed', value: any = 250) => provider._executeAircraftIntegrationAction(bridge,
    { type: 'aircraft-integration', name: integration.id }, 'simconnect', { profileKey, profileRevision: 7,
      request: name === 'reveal' ? { actionId: 'flightGuidance.verticalSpeed.reveal' } : { actionId: `flightGuidance.${name}.set`, value } });
  return { provider, bridge, values, calls, execute };
}

test('A380 targets require independent aircraft consumption, not a writable-variable echo', async () => {
  for (const echoOnly of [false, true]) {
    const f = fixture({ echoOnly }); const result = await f.execute();
    assert.equal(result.ok, !echoOnly); assert.equal(f.calls.length, 1);
    if (echoOnly) assert.equal(result.code, 'aircraft_integration_readback_timeout');
    else assert.deepEqual(result.confirmedValues, { 'flightGuidance.speedValue': 250, 'flightGuidance.speedConfirmed': 250 });
  }
});
test('A380 rejects wrong units, modes, unpowered and stale state before writes or no-ops', async () => {
  for (const [field, value, name, target] of [
    ['powered', false, 'speed', 200], ['speedValue', .82, 'speed', 200],
    ['speedDashed', true, 'speed', 200], ['speedManaged', true, 'speed', 200],
    ['trackFpa', true, 'heading', 270], ['headingManaged', true, 'heading', 270],
    ['headingDashed', true, 'heading', 270], ['trackFpa', true, 'verticalSpeed', 0],
    ['verticalSpeedDashed', true, 'verticalSpeed', 0],
  ]) {
    const f = fixture(); f.values[String(field)] = value;
    const result = await f.execute(String(name), target);
    assert.equal(result.code, 'aircraft_integration_precondition_failed'); assert.equal(f.calls.length, 0);
  }
  const stale = fixture({ stale: 'flightGuidance.powered' });
  assert.equal((await stale.execute()).code, 'aircraft_integration_precondition_unavailable');
  assert.equal(stale.calls.length, 0);
});
test('A380 same-state no-op, valid targets and numeric boundaries use the trusted path', async () => {
  const same = fixture(); assert.equal((await same.execute('speed', 200)).noOp, true); assert.equal(same.calls.length, 0);
  for (const [name, value] of [['heading', 0], ['heading', 359], ['altitude', 12300], ['verticalSpeed', -1000]]) {
    const f = fixture(); assert.equal((await f.execute(String(name), value)).ok, true); assert.equal(f.calls.length, 1);
  }
  for (const [name, value] of [['speed', 351], ['heading', 360], ['altitude', 12345], ['verticalSpeed', -6001]]) {
    const f = fixture(); assert.equal((await f.execute(String(name), value)).ok, false); assert.equal(f.calls.length, 0);
  }
});
test('A380 mode change or disconnection after dispatch cannot claim a confirmed target', async () => {
  for (const options of [{ modeChange: true }, { disconnect: true }]) {
    const f = fixture(options); assert.equal((await f.execute('heading', 90)).ok, false); assert.equal(f.calls.length, 1);
  }
});
test('A380 reveal never increments an already visible V/S preselection', async () => {
  const visible = fixture(); visible.values.verticalSpeedValue = 500;
  assert.equal((await visible.execute('reveal')).noOp, true); assert.equal(visible.calls.length, 0);
  const dashed = fixture(); dashed.values.verticalSpeedDashed = true;
  assert.equal((await dashed.execute('reveal')).ok, true); assert.equal(dashed.calls.length, 1);
});
test('required conditions reject malformed ranges, unknown fields, duplicate fields and missing freshness', () => {
  for (const conditions of [[{ fieldId: 'flightGuidance.powered', expectedValue: true }],
    [{ fieldId: 'unknown', freshness: 'field', expectedValue: true }],
    [{ fieldId: 'flightGuidance.speedValue', freshness: 'field', min: NaN, max: 350 }],
    [{ fieldId: 'flightGuidance.speedValue', freshness: 'field', min: 350, max: 100 }],
    [1, 2].map(() => ({ fieldId: 'flightGuidance.powered', freshness: 'field', expectedValue: true }))]) {
    const candidate = structuredClone(integration);
    candidate.actions['flightGuidance.speed.set'].guard.requires = conditions;
    assert.throws(() => createAircraftIntegrationRegistry([candidate]));
  }
});
export {};
