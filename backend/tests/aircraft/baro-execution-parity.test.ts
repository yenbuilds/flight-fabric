import { test } from 'node:test';
import assert from 'node:assert/strict';

const { SimConnectTelemetryProvider } = require('../../telemetry-provider/simconnect-telemetry-provider');
const loader = require('../../aircraft/aircraft-profile-loader');

const families = [
  { profile: 'fbw-a32nx', adapter: 'fbw-a32nx', route: 'fbwA32nx', transport: 'simconnect-sequence' },
  { profile: 'fenix-a320', adapter: 'fenix-a32x', route: 'fenixA32x', transport: 'mobiflight-calculator' },
  { profile: 'fbw-a380x', adapter: 'fbw-a380x', route: 'fbwA380x', transport: 'simconnect-sequence' },
];
const sides = ['captain', 'firstOfficer'];
const stdCounter = (panel: number, direction: '++' | '--') =>
  `(L:S_FCU_EFIS${panel}_BARO_STD, Number) ${direction} (>L:S_FCU_EFIS${panel}_BARO_STD, Number)`;

/** A parked, powered pair of independent altimeters; no production executor helpers. */
function providerHarness(family, initiallyStandard = false) {
  loader.setActiveProfile(family.profile);
  const config = loader.getAircraftSpecificConfig();
  assert.equal(config.integrationId, family.adapter);
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._simRunning = true;
  const calls: any[] = [];
  const snapshot: any = {
    profileId: config.profileKey, status: 'running', values: {}, valueUpdatedAt: {}, snapshotSequence: 0,
    mobiflight: { state: 'connected', connected: true, available: true },
  };
  let sampleTime = Date.now() - 100;
  let beforeWrite = async (_call): Promise<any> => undefined;
  const key = (id) => {
    const field = config.confirmationFields.find(candidate => candidate.id === id);
    assert.equal(field?.source.type, 'lvar', `real profile must subscribe to ${id}`);
    return field.source.key;
  };
  const set = (id, value) => { snapshot.values[key(id)] = value; };
  const poll = () => {
    snapshot.updatedAt = new Date(++sampleTime).toISOString();
    snapshot.snapshotSequence++;
    for (const fieldKey of Object.keys(snapshot.values)) snapshot.valueUpdatedAt[fieldKey] = snapshot.updatedAt;
  };
  if (family.adapter !== 'fbw-a380x') set('baro.healthy', 1);
  for (const side of sides) {
    if (family.adapter === 'fbw-a380x') {
      set(`baro.${side}.active`, 1); set(`baro.${side}.std`, Number(initiallyStandard));
    } else if (family.adapter === 'fenix-a32x') {
      set(`baro.${side}.qnh`, Number(!initiallyStandard));
      set(`baro.${side}.hpa`, 1013); set(`baro.${side}.inhg`, 29.92);
      set(`flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`, 1);
    } else {
      set(`baro.${side}.mode`, initiallyStandard ? 0 : 1);
      set(`baro.${side}.valueMode`, initiallyStandard ? 0 : 1);
      set(`baro.${side}.value`, 1013);
      set(`flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`, 0);
    }
  }
  poll();
  const write = async (call, apply) => {
    calls.push(call);
    const override = await beforeWrite(call);
    if (override) return override;
    apply(); poll();
    return { ok: true, sendIds: [calls.length] };
  };
  const bridge = {
    getSnapshot: () => snapshot,
    sendEvent: async (name, value) => write({ transport: 'event', name, value }, () => {
      const side = name.includes('_L_') ? 'captain' : 'firstOfficer';
      const letter = side === 'captain' ? 'L' : 'R';
      if (family.adapter === 'fbw-a380x') {
        assert.equal(name, `A32NX.FCU_EFIS_${letter}_BARO_PUSH`);
        set(`baro.${side}.std`, 1);
      } else if (name === `A32NX.FCU_EFIS_${letter}_BARO_SET`) {
        set(`baro.${side}.value`, value / 16);
      } else {
        assert.ok(['PUSH', 'PULL'].some(operation => name === `A32NX.FCU_EFIS_${letter}_BARO_${operation}`));
        set(`baro.${side}.mode`, name.endsWith('_PULL') ? 0 : 1);
        set(`baro.${side}.valueMode`, name.endsWith('_PULL') ? 0 : 1);
      }
    }),
    setNamedVar: async () => { assert.fail('These hPa/STD cases must not write a unit selector.'); },
    executeMobiFlightCode: async code => write({ transport: 'calculator', code }, () => {
      const panel = code.includes('EFIS1') ? 1 : 2, side = sides[panel - 1];
      if (code === stdCounter(panel, '++')) set(`baro.${side}.qnh`, 0);
      else if (code === stdCounter(panel, '--')) set(`baro.${side}.qnh`, 1);
      else {
        assert.equal(code, `(L:E_FCU_EFIS${panel}_BARO, Number) ++ (>L:E_FCU_EFIS${panel}_BARO, Number)`);
        set(`baro.${side}.hpa`, snapshot.values[key(`baro.${side}.hpa`)] + 1);
      }
    }),
  };
  return {
    provider, snapshot, calls, config,
    beforeWrite: (callback) => { beforeWrite = callback; },
    retire: () => loader.setActiveProfile('pmdg-737'),
    run: (actionId = 'baro.both.std', value?, revision = config.profileRevision) =>
      provider._executeAircraftIntegrationAction(bridge, { name: family.adapter }, 'parity-fixture', {
        profileKey: config.profileKey, profileRevision: revision, request: { actionId, value },
      }),
  };
}

const expectedStdWrites = (family) => family.adapter === 'fenix-a32x'
  ? [1, 2].map(panel => ({ transport: 'calculator', code: stdCounter(panel, '++') }))
  : ['L', 'R'].map(letter => ({ transport: 'event',
    name: `A32NX.FCU_EFIS_${letter}_BARO_${family.adapter === 'fbw-a380x' ? 'PUSH' : 'PULL'}`, value: 0 }));
const metadata = (family, actionId) => ({ backendSource: 'parity-fixture', integrationId: family.adapter,
  actionId, routeId: `${family.route}.${actionId}`, transportMode: family.transport });

for (const family of families) {
  test(`${family.adapter}: provider preserves exact STD writes and public success/no-op results`, async () => {
    for (const alreadyStandard of [false, true]) {
      const h = providerHarness(family, alreadyStandard);
      assert.deepEqual(await h.run(), {
        ok: true, code: 'executed',
        ...(family.adapter === 'fbw-a380x'
          ? { executionStarted: !alreadyStandard, noOp: alreadyStandard }
          : alreadyStandard ? { noOp: true, idempotent: true } : {}),
        baro: { target: 'both', mode: 'std', confirmedSides: sides },
        ...metadata(family, 'baro.both.std'),
      });
      assert.deepEqual(h.calls, alreadyStandard ? [] : expectedStdWrites(family));
      assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
      assert.equal((await h.run()).code, 'action_cooldown');
    }
  });

  test(`${family.adapter}: provider rejects stale revisions and wrong source profiles before writes`, async () => {
    const h = providerHarness(family);
    assert.equal((await h.run('baro.both.std', undefined, h.config.profileRevision - 1)).code, 'untrusted_aircraft_integration');
    h.snapshot.profileId = 'bundled/msfs/pmdg-737';
    const result = await h.run();
    assert.equal(result.code, 'baro_unavailable');
    assert.equal(result.executionStarted, false);
    assert.deepEqual(result.baro.confirmedSides, []);
    assert.deepEqual(h.calls, []);
    assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
  });

  test(`${family.adapter}: provider stops retired or rejected in-flight requests and releases the shared lock`, async () => {
    for (const failure of ['profile', 'rejection']) {
      const h = providerHarness(family);
      let entered, release;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const pendingWrite = new Promise<void>(resolve => { release = resolve; });
      h.beforeWrite(async () => {
        entered(); await pendingWrite;
        if (failure === 'profile') h.retire();
        else return { ok: false };
      });
      const pending = h.run();
      await started;
      try {
        assert.equal((await h.run('baro.captain.std')).code, 'action_in_progress');
      } finally { release(); }
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.code, failure === 'profile' ? 'stale_baro_context' : 'baro_write_rejected');
      assert.equal(result.executionStarted, true);
      assert.deepEqual(result.baro.confirmedSides, []);
      assert.deepEqual(h.calls, expectedStdWrites(family).slice(0, 1));
      assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
    }
  });
}

for (const family of families.slice(0, 2)) {
  test(`${family.adapter}: provider preserves captain QNH transition and pressure-write order`, async () => {
    const h = providerHarness(family, true);
    assert.deepEqual(await h.run('baro.captain.qnhHpa', 1014), {
      ok: true, code: 'executed', baro: { target: 'captain', mode: 'qnh', unit: 'hPa', value: 1014, confirmedSides: ['captain'] },
      ...metadata(family, 'baro.captain.qnhHpa'),
    });
    assert.deepEqual(h.calls, family.adapter === 'fbw-a32nx' ? [
      { transport: 'event', name: 'A32NX.FCU_EFIS_L_BARO_PUSH', value: 0 },
      { transport: 'event', name: 'A32NX.FCU_EFIS_L_BARO_SET', value: 16224 },
    ] : [
      { transport: 'calculator', code: '(L:S_FCU_EFIS1_BARO_STD, Number) -- (>L:S_FCU_EFIS1_BARO_STD, Number)' },
      { transport: 'calculator', code: '(L:E_FCU_EFIS1_BARO, Number) ++ (>L:E_FCU_EFIS1_BARO, Number)' },
    ]);
    assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
  });
}

test('Fenix provider checks live calculator health before and during a barometer request', async () => {
  const family = families[1];
  const unavailable = providerHarness(family);
  unavailable.snapshot.mobiflight = { state: 'missing', connected: false, available: false };
  assert.equal((await unavailable.run()).code, 'mobiflight_module_missing');
  assert.deepEqual(unavailable.calls, []);
  assert.equal(unavailable.provider._aircraftIntegrationActionsInFlight.size, 0);

  const lost = providerHarness(family);
  lost.beforeWrite(async () => { lost.snapshot.mobiflight.connected = false; });
  const result = await lost.run();
  assert.equal(result.code, 'stale_baro_context');
  assert.equal(result.executionStarted, true);
  assert.deepEqual(result.baro.confirmedSides, []);
  assert.deepEqual(lost.calls, expectedStdWrites(family).slice(0, 1));
  assert.equal(lost.provider._aircraftIntegrationActionsInFlight.size, 0);
});
