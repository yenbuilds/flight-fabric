const assert = require('node:assert/strict');
const test = require('node:test');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const { defaultAircraftIntegrationRegistry: registry } = require('./aircraft-integrations');

function action(adapter, profile, id) {
  return registry.resolveAction({ adapterId: adapter, profileKey: `bundled/msfs/${profile}`, actionId: id });
}

test('capability refresh notices write-bridge readiness even when telemetry status is unchanged', () => {
  const provider = Object.create(SimConnectTelemetryProvider.prototype);
  const messages: any[] = [];
  let sdk = false;
  provider._onBroadcast = message => messages.push(message);
  provider.getPrimaryDataSource = () => ({ type: 'simconnect', connected: true, description: 'Live' });
  provider.getSecondaryDataSources = () => [];
  provider.getAircraftControlCapabilities = () => ({ integrationTransports: { sdk } });
  provider._broadcastDataSourcesIfLvarStatusChanged();
  provider._broadcastDataSourcesIfLvarStatusChanged();
  assert.equal(messages.length, 1);
  sdk = true;
  provider._broadcastDataSourcesIfLvarStatusChanged();
  assert.equal(messages.length, 2);
  sdk = false;
  provider._broadcastDataSourcesIfLvarStatusChanged();
  assert.equal(messages.length, 3);
});

for (const [adapter, profile, machWire] of [['pmdg-737', 'pmdg-737', 78], ['pmdg-777', 'pmdg-777', 780]]) {
  test(`${adapter}: exact cockpit units reach the dedicated SDK setters`, () => {
    const provider = Object.create(SimConnectTelemetryProvider.prototype);
    for (const [target, value, event, wire] of [
      ['ias', 250, '#84134', 250], ['mach', 0.78, '#84135', machWire],
      ['heading', 270, '#84136', 270], ['altitude', 12500, '#84137', 12500],
      ['verticalSpeed', -1800, '#84138', 8200], ['verticalSpeed', 0, '#84138', 10000],
    ]) {
      const control = action(adapter, profile, `mcp.${target}.set`);
      assert.equal(control.routes[0].command, event);
      assert.deepEqual(provider._resolveAircraftIntegrationSdkValues(control.routes[0], control, value).values, [wire]);
    }
  });
}

for (const adapter of ['fbw-a32nx', 'fbw-a380x']) {
  test(`${adapter}: custom FCU events encode signed V/S and fractional Mach with unit guards`, () => {
    const provider = Object.create(SimConnectTelemetryProvider.prototype);
    for (const [left, right] of [['speed', 'mach'], ['verticalSpeed', 'flightPathAngle']]) {
      assert.equal(action(adapter, adapter, `flightGuidance.${left}.set`).guard.groupId,
        action(adapter, adapter, `flightGuidance.${right}.set`).guard.groupId,
        'commands for the same physical knob must share a lock');
    }
    for (const [target, value, event, wire, field, expected] of [
      ['speed', 250, 'SPD', 250, 'machMode', false],
      ['mach', 0.78, 'SPD', 78, 'machMode', true],
      ['heading', 270, 'HDG', 270, 'trkFpaMode', false],
      ['altitude', 12500, 'ALT', 12500, null, null],
      ['verticalSpeed', -1800, 'VS', -1800, 'trkFpaMode', false],
      ['flightPathAngle', -3.1, 'VS', -31, 'trkFpaMode', true],
    ]) {
      const control = action(adapter, adapter, `flightGuidance.${target}.set`);
      const route = control.routes[0];
      const result = provider._resolveAircraftIntegrationSimConnectOperations(route, control, value);
      assert.equal(result.ok, true);
      assert.equal(result.operations[0].name, `A32NX.FCU_${event}_SET`);
      assert.equal(result.operations[0].value, wire);
      if (field) assert.deepEqual(route.precondition, { fieldId: `flightGuidance.${field}`, expectedValue: expected });
    }
  });
}

function fenixHarness(target, initial, mode, options: any = {}) {
  const control = action('fenix-a32x', 'fenix-a320', `flightGuidance.${target}.set`);
  const route = control.routes[0];
  const provider = Object.create(SimConnectTelemetryProvider.prototype);
  let value = initial, sequence = 1;
  let modeValue = mode;
  const calls: string[] = [];
  const sample = field => ({ observed: field === route.precondition?.fieldId ? modeValue : value, fresh: true, sequence });
  provider._captureAircraftIntegrationReadback = (_bridge, field) => sample(field.fieldId);
  provider._waitForAircraftIntegrationReadback = async (_bridge, readback) => {
    const state = sample(readback.fieldId);
    return { confirmed: readback.confirmation === 'changed' || Object.is(state.observed, readback.expectedValue), ...state };
  };
  const bridge = { async executeMobiFlightCode(code) {
    calls.push(code);
    if (options.reject) return { ok: false, code: 'write_failed' };
    sequence++;
    if (code === route.prepareCode) { if (!options.noPrepare) modeValue = 'hundred'; }
    else value = Number((value + (code === route.increaseCode ? 1 : -1) * control.input.step).toFixed(8));
    if (options.modeChange && calls.length === 1) modeValue = !modeValue;
    return { ok: true };
  } };
  return { calls, run: value => provider._executeAircraftIntegrationMobiFlightRoute(
    bridge, route, control, value, sample(route.readback.fieldId)), value: () => value };
}

for (const [target, initial, requested, mode] of [
  ['mach', 0.69, 0.72, true], ['verticalSpeed', -1700, -2000, false],
  ['flightPathAngle', -2.9, -3.2, true], ['altitude', 12400, 12600, 'thousand'],
]) {
  test(`Fenix ${target}: readback-paced target reaches the requested value`, async () => {
    const harness = fenixHarness(target, initial, mode);
    assert.equal((await harness.run(requested)).ok, true);
    assert.equal(harness.value(), requested);
    if (target === 'altitude') assert.match(harness.calls[0], /S_FCU_ALTITUDE_SCALE/);
  });
}

test('Fenix mode mismatch, scale failure and transport rejection stop before further rotary movement', async () => {
  for (const [target, initial, mode, requested, options, count] of [
    ['verticalSpeed', 0, true, 1000, {}, 0],
    ['mach', 0.7, true, 0.74, { modeChange: true }, 1],
    ['altitude', 12000, 'thousand', 12500, { noPrepare: true }, 1],
    ['verticalSpeed', 0, false, 1000, { reject: true }, 1],
  ] as any[]) {
    const harness = fenixHarness(target, initial, mode, options);
    assert.equal((await harness.run(requested)).ok, false);
    assert.equal(harness.calls.length, count);
  }
});

export {};
