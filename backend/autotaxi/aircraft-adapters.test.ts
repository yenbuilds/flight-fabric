import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeGroundAxes, type TaxiAxisConfig, type TaxiAxisTransport } from './axes.js';
import { taxiAdapterFor, handlingForAircraft, type TaxiFamily } from './adapters.js';
import { STOP_INPUT } from './controller.js';
import type { TaxiAircraftConfigResult } from './aircraft-config.js';
import type { TaxiGraph } from './route.js';
import { createAutotaxi } from '../telemetry-provider/aircraft-autotaxi.js';

const standard = (engineCount = 2): TaxiAxisConfig => ({ family: 'generic', engineCount, maxThrottle: 0.18 });
const fenix: TaxiAxisConfig = { family: 'fenix-a32x', engineCount: 2, maxThrottle: 0.18 };

test('standard axes address every installed engine from one to four, and stop every engine before applying brakes', async () => {
  for (const engineCount of [1, 2, 3, 4]) {
    const events: [string, number][] = [];
    const transport = { sendEvent: async (name: string, value: number) => { events.push([name, value]); return { ok: true }; } };
    await writeGroundAxes({ throttle: 0.12, brake: 0, steering: 0.2 }, transport, () => true, standard(engineCount));
    assert.deepEqual(events.slice(0, 3), [['AXIS_LEFT_BRAKE_SET', -16383], ['AXIS_RIGHT_BRAKE_SET', -16383], ['AXIS_STEERING_SET', Math.round(0.2 * 16384)]]);
    assert.deepEqual(events.slice(3), Array.from({ length: engineCount }, (_, i) => [`THROTTLE${i + 1}_SET`, Math.round(0.12 * 16383)]));
    events.length = 0;
    await writeGroundAxes(STOP_INPUT, transport, () => true, standard(engineCount));
    assert.deepEqual(events.slice(0, engineCount), Array.from({ length: engineCount }, (_, i) => [`THROTTLE${i + 1}_SET`, 0]));
    assert.deepEqual(events.slice(engineCount), [['AXIS_LEFT_BRAKE_SET', 16383], ['AXIS_RIGHT_BRAKE_SET', 16383], ['AXIS_STEERING_SET', 0]]);
  }
});

test('invalid engine configurations and demands never emit controls', async () => {
  let writes = 0;
  const transport = { sendEvent: async () => { writes++; return { ok: true }; } };
  for (const count of [0, 5, 1.5, NaN]) await assert.rejects(writeGroundAxes(STOP_INPUT, transport, () => true, standard(count)), /Invalid/);
  for (const input of [{ throttle: 0.19, brake: 0, steering: 0 }, { throttle: 0.1, brake: 0.1, steering: 0 },
    { throttle: 0, brake: 1, steering: Infinity }, { throttle: -0.1, brake: 0, steering: 0 }]) {
    await assert.rejects(writeGroundAxes(input, transport, () => true, standard()), /Invalid/);
  }
  assert.equal(writes, 0);
});

test('ownership is checked between axis commands, including a full-stop batch', async () => {
  for (const input of [{ throttle: 0.1, brake: 0, steering: 0.1 }, STOP_INPUT]) {
    const names: string[] = [];
    let owned = true;
    await assert.rejects(writeGroundAxes(input, { sendEvent: async name => {
      names.push(name); if (names.length === 2) owned = false; return { ok: true };
    } }, () => owned, standard(4)), /ownership changed/);
    assert.equal(names.length, 2);
  }
});

test('a failed full stop still attempts all engines and both brakes', async () => {
  const names: string[] = [];
  await assert.rejects(writeGroundAxes(STOP_INPUT, { sendEvent: async name => {
    names.push(name); return { ok: name !== 'THROTTLE1_SET', error: 'first engine rejected' };
  } }, () => true, standard(4)), /first engine rejected/);
  assert.deepEqual(names, ['THROTTLE1_SET', 'THROTTLE2_SET', 'THROTTLE3_SET', 'THROTTLE4_SET', 'AXIS_LEFT_BRAKE_SET', 'AXIS_RIGHT_BRAKE_SET', 'AXIS_STEERING_SET']);
});

test('Fenix uses bounded continuous throttle inputs and standard steering and brake axes', async () => {
  const events: [string, number][] = [], variables: { name: string; unit: string; value: number }[] = [];
  const transport: TaxiAxisTransport = {
    sendEvent: async (name, value) => { events.push([name, value]); return { ok: true }; },
    setNamedVar: async input => { variables.push(input); return { ok: true }; },
  };
  await writeGroundAxes({ throttle: 0.12, brake: 0, steering: -0.2 }, transport, () => true, fenix);
  assert.deepEqual(variables, [{ name: 'L:A_FC_THROTTLE_LEFT_INPUT', unit: 'Number', value: 2.12 }, { name: 'L:A_FC_THROTTLE_RIGHT_INPUT', unit: 'Number', value: 2.12 }]);
  assert.deepEqual(events.map(([name]) => name), ['AXIS_LEFT_BRAKE_SET', 'AXIS_RIGHT_BRAKE_SET', 'AXIS_STEERING_SET']);
  variables.length = 0;
  await writeGroundAxes(STOP_INPUT, transport, () => true, fenix);
  assert.deepEqual(variables.map(value => value.value), [2, 2]);
  await assert.rejects(writeGroundAxes({ throttle: 0.19, brake: 0, steering: 0 }, transport, () => true, fenix), /Invalid/);
});

test('missing or rejected Fenix throttle transport still allows the full-stop brake attempts', async () => {
  for (const missing of [true, false]) {
    const names: string[] = [];
    const transport: TaxiAxisTransport = { sendEvent: async name => { names.push(name); return { ok: true }; },
      ...(missing ? {} : { setNamedVar: async (input: { name: string; unit: string; value: number }) => { names.push(input.name); return { ok: false, error: 'throttle rejected' }; } }) };
    await assert.rejects(writeGroundAxes(STOP_INPUT, transport, () => true, fenix));
    assert(names.includes('AXIS_LEFT_BRAKE_SET'), `${missing}: left brake attempted`);
    assert(names.includes('AXIS_RIGHT_BRAKE_SET'), `${missing}: right brake attempted`);
    assert(names.includes('AXIS_STEERING_SET'), `${missing}: steering neutral attempted`);
    names.length = 0;
    if (missing) {
      await assert.rejects(writeGroundAxes({ throttle: 0.1, brake: 0, steering: 0 }, transport, () => true, fenix));
      assert.deepEqual(names, [], 'missing throttle transport must block a motion batch before brake release');
    }
  }
});

function graph(): TaxiGraph {
  return { complete: true,
    points: [[0, 0, 0, 1], [1, 0, 100, 1], [2, 0, 200, 2], [3, 0, 260, 1], [4, 1000, 260, 1]]
      .map(([id, x, z, type]) => ({ id, x, z, type, orientation: 0 })),
    paths: [[0, 1], [1, 2], [2, 3], [3, 4]].map(([start, end], id) => ({ id, start, end, type: id === 3 ? 2 : 1, runway: id === 3 ? '09' : null, widthM: 45 })),
  };
}

function fixture(family: TaxiFamily = 'generic', engineCount = 2) {
  let now = 10000;
  let profileKey = `bundled/msfs/${family === 'fenix-a32x' ? 'fenix-a320' : family}`;
  let model: TaxiAircraftConfigResult = { ok: true, identity: 'C:/fixture/aircraft.cfg', fingerprint: 'fixture-geometry', sourceFiles: [],
    wheelbaseM: 15.6, maxSteeringDeg: 75, wheelTrackM: 8, lengthM: 50, noseOffsetM: 25 };
  const values: Record<string, any> = { lat: 10 / 6371000 * 180 / Math.PI, lon: 0, heading: 0, gs: 0,
    wow: true, paused: false, slewActive: false, parkingBrake: false, engineCount, engineType: 1,
    athrArmed: false, athrActive: false };
  for (let i = 1; i <= engineCount; i++) { values[`eng${i}Combustion`] = true; values[`thr${i}`] = 0; }
  const nativeTimes: Record<string, string> = {};
  const lvarTimes: Record<string, string> = {};
  const lvarValues: Record<string, any> = { fenixAthr: 0, fenixParking: 0, fenixThrottle1: 2, fenixThrottle2: 2 };
  const fields = [
    ['flightGuidance.autothrust', 'fenixAthr'], ['systems.parkingBrake', 'fenixParking'],
    ['propulsion.throttleLever1Position', 'fenixThrottle1'], ['propulsion.throttleLever2Position', 'fenixThrottle2'],
  ].map(([id, key]) => ({ id, source: { type: 'lvar', key } }));
  const sdk: any = { adapterId: 'clientdata-manifest', target: { channel: family === 'pmdg-777' ? 'pmdg-777x-clientdata' : 'pmdg-737-ng3-clientdata' },
    updatedAt: new Date(now).toISOString(), normalized: { automation: { athr: { armed: false, active: false, armedLeft: false, armedRight: false } }, brakes: { parking: false } } };
  const lvars: any = { status: 'running', profileId: profileKey, values: lvarValues, valueUpdatedAt: lvarTimes, source: {} };
  const events: [string, number][] = [], variables: { name: string; unit: string; value: number }[] = [], actions: any[] = [];
  const bridge: any = {
    getSnapshot: () => ({ ...lvars, valueUpdatedAt: { ...Object.fromEntries(Object.keys(lvarValues).map(key => [key, new Date(now).toISOString()])), ...lvarTimes } }),
    sendEvent: async (name: string, value: number) => {
      events.push([name, value]); if (name === 'PARKING_BRAKE_SET') { values.parkingBrake = value === 1; now++; } return { ok: true };
    },
    setNamedVar: async (input: { name: string; unit: string; value: number }) => { variables.push(input); return { ok: true }; },
  };
  const config: any = { profileKey, profileRevision: 1, integrationId: family === 'generic' ? null : family, fields, confirmationFields: [] };
  const provider: any = {
    _connected: true, _systemState: { sim: 1 }, _autotaxiConnectionEpoch: 1, _lastDetectedAircraftTitle: 'C:/fixture/aircraft.cfg',
    _data: { ...values },
    _rustSimvarBridge: { getSnapshot: () => ({ status: 'running', values, valueUpdatedAt: {
      ...Object.fromEntries(Object.keys(values).map(key => [key, new Date(now).toISOString()])), ...nativeTimes,
    } }) },
    _sdkBridge: { isDataConnected: () => true, getSnapshot: () => sdk }, _lvarBridge: bridge,
    _msfsFacilitiesGeometryProvider: { probeAirport: async () => ({ ok: true }), getTaxiAirport: () => ({ origin: { lat: 0, lon: 0 }, graph: graph(),
      threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }) },
    _executeAircraftIntegrationAction: async (_bridge: any, target: any, _source: any, request: any) => {
      actions.push({ target, request }); values.parkingBrake = true; lvarValues.fenixParking = 1; sdk.normalized.brakes.parking = true;
      sdk.updatedAt = new Date(now).toISOString(); return { ok: true };
    },
  };
  const profiles: any = { getActiveProfileId: () => profileKey, getActiveProfileRevision: () => 1, getAircraftSpecificConfig: () => config,
    getActiveProfile: () => ({ aircraft: { engines: 2 }, engineCount: 2 }) };
  const session = createAutotaxi(provider, profiles, () => now, { resolveModel: () => model });
  return { session, provider, bridge, profiles, values, nativeTimes, lvarValues, lvarTimes, lvars, sdk, events, variables, actions, config,
    request: (operation = 'start') => ({ operation, icao: 'TEST', runway: '09', profileKey, profileRevision: 1 }),
    advance: (ms = 250) => { now += ms; }, setModel: (next: TaxiAircraftConfigResult) => { model = next; },
    setProfile: (next: string) => { profileKey = next; }, now: () => now };
}

test('dedicated manual sessions reject every control operation and cannot disturb an active controller', async () => {
  const f = fixture();
  const viewer = createAutotaxi(f.provider, f.profiles, f.now, { readOnly: true });
  const secondViewer = createAutotaxi(f.provider, f.profiles, f.now, { readOnly: true });
  try {
    await f.session.request(f.request('start'), {});
    const before = f.events.length;
    for (const operation of ['start', 'stop', 'release', 'unknown']) {
      await assert.rejects(viewer.request(f.request(operation), {}), /guidance supports/);
    }
    const preview = await viewer.request(f.request('preview'), {});
    assert.ok('preview' in preview && preview.preview.points.length > 1);
    assert.equal(viewer.state().canStart, false);
    assert.equal(secondViewer.state().sceneKey, null, 'independent viewer has no borrowed route');
    assert.equal((await viewer.request(f.request('status'), {})).sceneKey, preview.sceneKey);
    await viewer.request(f.request('parkings'), {});
    assert.equal(f.events.length, before, 'manual reads never write axes or brakes');
    assert.equal(f.session.isActive(), true, 'automatic controller ownership survives all reads');
    assert.equal(f.variables.length, 0); assert.equal(f.actions.length, 0);
  } finally { await f.session.dispose(); }
});

test('taxi guidance works without automatic-control readiness and never writes controls', async () => {
  for (const family of ['generic', 'pmdg-737', 'pmdg-777', 'fenix-a32x'] as const) {
    const f = fixture(family);
    f.values.parkingBrake = true; f.values.eng1Combustion = false; f.values.athrArmed = true;
    f.lvarValues.fenixParking = 1;
    f.sdk.normalized.brakes.parking = true;
    try {
      assert.equal(f.session.state().canGuide, true, family);
      assert.equal(f.session.state().canStart, false, family);
      const preview = await f.session.request(f.request('preview'), {});
      assert.ok('preview' in preview && preview.preview.points.length > 1, family);
      assert.equal(preview.active, false);
      f.values.lat += 30 / 6371000 * 180 / Math.PI; f.values.gs = 18; f.advance();
      assert.ok(f.session.state().aircraft!.z > preview.aircraft!.z + 29, 'manual taxi tracks live position beyond the Autotaxi start speed');
      await assert.rejects(f.session.request(f.request('start'), {}));
      await f.session.request({ operation: 'release' }, {});
      assert.deepEqual([f.events, f.variables, f.actions], [[], [], []]);
    } finally { await f.session.dispose(); }
  }
});

test('guidance remains available without a control adapter or installed aircraft geometry', async () => {
  for (const unsupported of ['adapter', 'geometry', 'sdk']) {
    const f = fixture('pmdg-737');
    if (unsupported === 'adapter') f.setProfile('bundled/msfs/unsupported');
    if (unsupported === 'geometry') f.setModel({ ok: false, reason: 'Installed geometry unavailable.' });
    if (unsupported === 'sdk') f.provider._sdkBridge = null;
    try {
      assert.equal(f.session.state().canGuide, true, unsupported);
      assert.equal(f.session.state().canStart, false, unsupported);
      const result = await f.session.request(f.request('preview'), {});
      assert.ok(result.sceneKey && result.aircraft);
      await assert.rejects(f.session.request(f.request('start'), {}));
      assert.deepEqual([f.events, f.variables, f.actions], [[], [], []]);
    } finally { await f.session.dispose(); }
  }
});

test('guidance suppresses stale or invalid live positions and rejects planning until ground data returns', async () => {
  for (const change of ['stale', 'missing', 'airborne', 'paused', 'slew', 'disconnected', 'profile']) {
    const f = fixture();
    try {
      const preview = await f.session.request(f.request('preview'), {});
      assert.ok(preview.aircraft);
      if (change === 'stale') { f.nativeTimes.lat = new Date(f.now()).toISOString(); f.advance(1100); }
      if (change === 'missing') f.values.heading = null;
      if (change === 'airborne') f.values.wow = false;
      if (change === 'paused') f.values.paused = true;
      if (change === 'slew') f.values.slewActive = true;
      if (change === 'disconnected') f.provider._connected = false;
      if (change === 'profile') f.setProfile('bundled/msfs/unsupported');
      const status = f.session.state();
      assert.equal(status.aircraft, null, change);
      if (change === 'profile') assert.equal(status.sceneKey, null);
      else {
        assert.equal(status.canGuide, false, change);
        await assert.rejects(f.session.request(f.request('preview'), {}));
      }
      assert.deepEqual([f.events, f.variables, f.actions], [[], [], []]);
    } finally { await f.session.dispose(); }
  }
});

test('manual route loading rechecks guidance data and aircraft identity before publishing a ribbon', async () => {
  for (const change of ['stale', 'aircraft', 'disconnect', 'cancel']) {
    const f = fixture();
    f.values.parkingBrake = true;
    let finish!: () => void;
    f.provider._msfsFacilitiesGeometryProvider.probeAirport = () => new Promise(resolve => { finish = () => resolve({ ok: true }); });
    try {
      const loading = f.session.request(f.request('preview'), {});
      const rejected = assert.rejects(loading, /changed|cancelled/);
      if (change === 'stale') f.nativeTimes.lat = new Date(f.now() - 1100).toISOString();
      if (change === 'aircraft') f.setProfile('bundled/msfs/unsupported');
      if (change === 'disconnect') f.provider._connected = false;
      if (change === 'cancel') await f.session.request({ operation: 'stop' }, {});
      finish(); await rejected;
      assert.equal(f.session.state().sceneKey, null, change);
      assert.deepEqual([f.events, f.variables, f.actions], [[], [], []]);
    } finally { await f.session.dispose(); }
  }
});

test('Generic sessions use fresh installed engine count rather than the profile default', async () => {
  for (const count of [1, 2, 3, 4]) {
    const f = fixture('generic', count);
    try {
      assert.equal(f.session.state().canStart, true, `${count}: ${f.session.state().unavailableReason}`);
      await f.session.request(f.request(), {});
      assert.deepEqual(f.events.filter(([name]) => name.startsWith('THROTTLE')).map(([name]) => name), Array.from({ length: count }, (_, i) => `THROTTLE${i + 1}_SET`));
    } finally { await f.session.dispose(); }
  }
});

test('standard GA, turboprop, regional-jet and widebody detection stays eligible through the Generic adapter', async () => {
  for (const [id, engineCount, engineType] of [
    ['ga-base', 1, 0], ['turboprop-base', 2, 5], ['regional-jet', 2, 1], ['widebody-base', 4, 1],
  ] as const) {
    const detectedKey = `bundled/msfs/${id}`;
    assert.equal(taxiAdapterFor(detectedKey)?.family, 'generic', id);
    for (const activeKey of ['bundled/msfs/generic', detectedKey]) {
      const f = fixture('generic', engineCount);
      f.values.engineType = engineType;
      f.setProfile(activeKey);
      f.profiles.detectProfile = () => ({ _profileKey: detectedKey });
      try {
        assert.equal(f.session.state().canStart, true, `${activeKey}/${id}: ${f.session.state().unavailableReason}`);
        await f.session.request(f.request(), {});
        assert.equal(f.session.state().support.family, 'generic');
        assert.equal(f.events.filter(([name]) => name.startsWith('THROTTLE')).length, engineCount);
      } finally { await f.session.dispose(); }
    }
  }
});

test('an installed full-steering speed cap limits planning readiness, cruise and active-session overspeed', async () => {
  const f = fixture();
  const model = { ok: true as const, identity: 'C:/fixture/aircraft.cfg', fingerprint: 'speed-capped', sourceFiles: [],
    wheelbaseM: 15.6, maxSteeringDeg: 75, wheelTrackM: 8, lengthM: 50, noseOffsetM: 25, fullSteeringSpeedKts: 5 };
  const handling = handlingForAircraft(taxiAdapterFor('bundled/msfs/generic')!, model, 1);
  assert.deepEqual({ cruise: handling.cruiseKts, turn: handling.turnKts, start: handling.maxStartKts, speed: handling.maxSpeedKts },
    { cruise: 4.5, turn: 2, start: 5, speed: 5 });
  f.setModel(model);
  try {
    f.values.gs = 5.1;
    assert.equal(f.session.state().canStart, false);
    await assert.rejects(f.session.request(f.request(), {}), /Slow below 5 kt/);
    assert.deepEqual(f.events, []);
    f.values.gs = 0;
    await f.session.request(f.request(), {});
    const before = f.events.length;
    f.values.gs = 5.1; f.advance(); await f.session.tick();
    assert.equal(f.session.state().status, 'fault');
    assert.match(f.session.state().reason, /exceeded 5 kt/);
    assert.deepEqual(f.events.slice(before), [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0],
      ['AXIS_LEFT_BRAKE_SET', 16383], ['AXIS_RIGHT_BRAKE_SET', 16383], ['AXIS_STEERING_SET', 0]]);
  } finally { await f.session.dispose(); }
});

test('Generic parking handover requires a new source sample after the parking command', async () => {
  for (const confirms of [true, false]) {
    const f = fixture('generic', 4);
    if (!confirms) f.bridge.sendEvent = async (name: string, value: number) => {
      // A changed display value with the same cached source timestamp must
      // never count as evidence that this command reached the aircraft.
      f.events.push([name, value]); if (name === 'PARKING_BRAKE_SET') f.values.parkingBrake = true;
      return { ok: true };
    };
    try {
      await f.session.request(f.request(), {});
      await f.session.request({ operation: 'stop' }, {});
      f.advance(1100); await f.session.tick();
      assert.equal(f.session.state().handedOver, confirms, `${confirms}: ${f.session.state().error}`);
      const parkingIndex = f.events.findIndex(([name]) => name === 'PARKING_BRAKE_SET');
      assert(parkingIndex >= 0);
      if (confirms) {
        assert(f.events.slice(parkingIndex + 1).some(([name, value]) => name === 'AXIS_LEFT_BRAKE_SET' && value === -16383));
        assert.equal(f.session.state().error, null);
      } else {
        assert.match(f.session.state().error || '', /did not confirm the parking brake/);
        assert(!f.events.slice(parkingIndex + 1).some(([name, value]) => name.includes('BRAKE_SET') && value === -16383));
      }
    } finally { await f.session.dispose(); }
  }
});

test('missing or stale individual engine state blocks Generic motion without using retained display values', async () => {
  for (const field of ['engineCount', 'engineType', 'eng4Combustion', 'thr4']) {
    const f = fixture('generic', 4);
    try {
      f.nativeTimes[field] = new Date(f.now() - 1500).toISOString();
      assert.equal(f.session.state().canStart, false, field);
      await assert.rejects(f.session.request(f.request(), {}));
      assert.deepEqual(f.events, []);
      delete f.nativeTimes[field];
      f.values[field] = null;
      assert.equal(f.session.state().canStart, false, `${field} missing`);
    } finally { await f.session.dispose(); }
  }
});

test('invalid live engine count never falls back to a two-engine profile default', async () => {
  const f = fixture();
  try {
    for (const count of [undefined, null, 0, 5, 1.5, NaN]) {
      f.values.engineCount = count;
      assert.equal(f.session.state().canStart, false, `count ${count}`);
      await assert.rejects(f.session.request(f.request(), {}));
      assert.deepEqual(f.events, []);
    }
  } finally { await f.session.dispose(); }
});

test('unknown aircraft configurations and unsupported profiles do not inherit Generic control support', async () => {
  const f = fixture();
  try {
    f.setModel({ ok: false, reason: 'Wheel geometry is encrypted.' });
    assert.equal(f.session.state().canStart, false);
    await assert.rejects(f.session.request(f.request('start'), {}));
    f.setProfile('bundled/msfs/flybywire-a32nx');
    assert.equal(f.session.state().canStart, false);
    assert.equal(taxiAdapterFor('bundled/msfs/flybywire-a32nx'), null);
    assert.equal(taxiAdapterFor('local/pmdg-777'), null);
    assert.deepEqual(f.events, []);
  } finally { await f.session.dispose(); }
});

test('a manually selected Generic profile cannot bypass the loaded custom aircraft adapter', async () => {
  const f = fixture();
  let detections = 0;
  f.profiles.detectProfile = () => { detections++; return { _profileKey: 'bundled/msfs/fenix-a320' }; };
  try {
    assert.equal(f.session.state().canStart, false);
    assert.match(f.session.state().unavailableReason || '', /matching profile/);
    await assert.rejects(f.session.request(f.request(), {}), /matching profile/);
    assert.equal(detections, 1, 'detection is cached within a physical aircraft scope');
    assert.deepEqual(f.events, []);
  } finally { await f.session.dispose(); }
});

test('an active session retains same-aircraft stop controls when metadata or a configuration read disappears', async () => {
  for (const missing of ['engineCount', 'engineType', 'eng4Combustion', 'model']) {
    const f = fixture('generic', 4);
    try {
      await f.session.request(f.request(), {});
      const before = f.events.length;
      if (missing === 'model') f.setModel({ ok: false, reason: 'Temporary aircraft configuration read failure.' });
      else f.values[missing] = null;
      f.advance(); await f.session.tick();
      assert.equal(f.session.state().status, 'fault', missing);
      const stop = f.events.slice(before);
      assert.deepEqual(stop, [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0], ['THROTTLE3_SET', 0], ['THROTTLE4_SET', 0],
        ['AXIS_LEFT_BRAKE_SET', 16383], ['AXIS_RIGHT_BRAKE_SET', 16383], ['AXIS_STEERING_SET', 0]], missing);
      assert.equal(f.session.state().canStart, false);
      if (missing !== 'model') f.values[missing] = missing === 'engineCount' ? 4 : missing === 'engineType' ? 1 : true;
      f.advance(); await f.session.tick();
      assert.equal(f.session.state().status, 'fault', `${missing}: never resume after data returns`);
      assert(!f.events.slice(before).some(([name, value]) => name.startsWith('THROTTLE') && value > 0));
    } finally { await f.session.dispose(); }
  }
});

test('a positive installed-engine-count change is a new control identity and receives no previous-session writes', async () => {
  const f = fixture('generic', 2);
  try {
    await f.session.request(f.request(), {});
    const before = f.events.length;
    f.values.engineCount = 3; f.values.eng3Combustion = true; f.values.thr3 = 0;
    f.advance(); await f.session.tick();
    assert.equal(f.session.state().status, 'fault');
    assert.equal(f.events.length, before);
    await f.session.request({ operation: 'release' }, {});
    assert.equal(f.events.length, before, 'release also cannot write into the replacement aircraft');
  } finally { await f.session.dispose(); }
});

test('malformed engine metadata faults an active session while retaining its known stop controls', async () => {
  for (const [field, bad] of [['engineCount', 5], ['engineCount', 2.5], ['engineType', -1], ['engineType', 99], ['engineType', 1.5]] as const) {
    const f = fixture('generic', 4);
    try {
      await f.session.request(f.request(), {});
      const before = f.events.length;
      f.values[field] = bad; f.advance(); await f.session.tick();
      assert.equal(f.session.state().status, 'fault', `${field}=${bad}`);
      assert.deepEqual(f.events.slice(before), [['THROTTLE1_SET', 0], ['THROTTLE2_SET', 0],
        ['THROTTLE3_SET', 0], ['THROTTLE4_SET', 0], ['AXIS_LEFT_BRAKE_SET', 16383],
        ['AXIS_RIGHT_BRAKE_SET', 16383], ['AXIS_STEERING_SET', 0]], `${field}=${bad}`);
      assert.equal(f.session.state().canStart, false);
    } finally { await f.session.dispose(); }
  }
});

test('installed geometry produces distinct handling for aircraft variants and invalidates an active Generic session', async () => {
  const f = fixture();
  try {
    const small = { ok: true as const, identity: 'C:/small/aircraft.cfg', fingerprint: 'small', sourceFiles: [], wheelbaseM: 3, maxSteeringDeg: 35, wheelTrackM: 2, lengthM: 8, noseOffsetM: 3 };
    const large = { ...small, identity: 'C:/large/aircraft.cfg', fingerprint: 'large', wheelbaseM: 31, maxSteeringDeg: 70, wheelTrackM: 12, lengthM: 74, noseOffsetM: 30 };
    const a = handlingForAircraft(taxiAdapterFor('bundled/msfs/generic')!, small, 0);
    const b = handlingForAircraft(taxiAdapterFor('bundled/msfs/pmdg-777')!, large, 1);
    assert(a.holdShortOffsetM < b.holdShortOffsetM);
    assert(a.minPathWidthM < b.minPathWidthM);
    assert(a.wheelbaseM < b.wheelbaseM);
    await f.session.request(f.request(), {});
    const before = f.events.length;
    f.setModel(large); f.advance(); await f.session.tick();
    assert.equal(f.session.state().status, 'fault');
    assert.equal(f.events.length, before, 'old aircraft commands must never be sent into the replacement');
  } finally { await f.session.dispose(); }
});

test('PMDG 777 requires its own SDK data and both autothrottle switches, then hands over with its own parking action', async () => {
  const f = fixture('pmdg-777');
  try {
    assert.equal(f.session.state().canStart, true, f.session.state().unavailableReason || '777 ready');
    f.sdk.target.channel = 'pmdg-737-ng3-clientdata'; assert.equal(f.session.state().canStart, false);
    f.sdk.target.channel = 'pmdg-777x-clientdata';
    for (const key of ['armedLeft', 'armedRight', 'armed', 'active']) {
      f.sdk.normalized.automation.athr[key] = true; assert.equal(f.session.state().canStart, false, key);
      f.sdk.normalized.automation.athr[key] = false;
    }
    f.sdk.normalized.brakes.parking = true; assert.equal(f.session.state().canStart, false); f.sdk.normalized.brakes.parking = false;
    await f.session.request(f.request(), {});
    await f.session.request({ operation: 'stop' }, {});
    f.advance(1100); await f.session.tick();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].target.name, 'pmdg-777');
    assert.equal(f.actions[0].request.request.actionId, 'controls.parkingBrake.on');
    assert.equal(f.session.state().handedOver, true, f.session.state().error || '777 handover');
  } finally { await f.session.dispose(); }
});

test('Fenix requires every independently fresh scoped L-var and continuous-write transport', async () => {
  const f = fixture('fenix-a32x');
  try {
    assert.equal(f.session.state().canStart, true, f.session.state().unavailableReason || 'Fenix ready');
    for (const key of Object.keys(f.lvarValues)) {
      f.lvarTimes[key] = new Date(f.now() - 1500).toISOString();
      assert.equal(f.session.state().canStart, false, `${key} stale`);
      delete f.lvarTimes[key];
      const saved = f.lvarValues[key]; f.lvarValues[key] = null;
      assert.equal(f.session.state().canStart, false, `${key} missing`); f.lvarValues[key] = saved;
    }
    f.lvars.profileId = 'bundled/msfs/fenix-a319'; assert.equal(f.session.state().canStart, false); f.lvars.profileId = 'bundled/msfs/fenix-a320';
    const send = f.bridge.setNamedVar; delete f.bridge.setNamedVar; assert.equal(f.session.state().canStart, false); f.bridge.setNamedVar = send;
    f.lvarValues.fenixAthr = 1; assert.equal(f.session.state().canStart, false); f.lvarValues.fenixAthr = 0;
    f.lvarValues.fenixThrottle1 = 1.9; assert.equal(f.session.state().canStart, false); f.lvarValues.fenixThrottle1 = 2;
    await f.session.request(f.request(), {});
    assert.deepEqual(f.variables.map(value => value.name), ['L:A_FC_THROTTLE_LEFT_INPUT', 'L:A_FC_THROTTLE_RIGHT_INPUT']);
    assert(f.variables.every(value => value.value > 2 && value.value <= 2.18));
    assert(!f.events.some(([name]) => name.startsWith('THROTTLE')));
    await f.session.request({ operation: 'stop' }, {}); f.advance(1100); await f.session.tick();
    assert.equal(f.actions[0].request.request.actionId, 'systems.parkingBrake.set');
    assert.equal(f.session.state().handedOver, true, f.session.state().error || 'Fenix handover');
  } finally { await f.session.dispose(); }
});

test('losing Fenix throttle transport during a session faults while still attempting both full brakes', async () => {
  const f = fixture('fenix-a32x');
  try {
    await f.session.request(f.request(), {});
    const before = f.events.length;
    delete f.bridge.setNamedVar;
    f.advance(); await f.session.tick();
    assert.equal(f.session.state().status, 'fault');
    const after = f.events.slice(before);
    for (const name of ['AXIS_LEFT_BRAKE_SET', 'AXIS_RIGHT_BRAKE_SET']) {
      assert(after.some(([event, value]) => event === name && value === 16383), `${name}: full braking attempted`);
    }
    assert(!after.some(([name, value]) => name.includes('BRAKE_SET') && value === -16383), 'failure must never release the brakes');
    assert(!after.some(([name]) => name.startsWith('THROTTLE')), 'the standard throttle path cannot substitute for the missing custom path');
  } finally { await f.session.dispose(); }
});
