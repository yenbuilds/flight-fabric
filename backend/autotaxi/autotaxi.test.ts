import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planTaxiRoute, planTaxiToStand, findParking, listParkings, listParkingOptions, localPosition, distance, type Point, type TaxiGraph, type TaxiRoute } from './route.js';
import { createTaxiController, STOP_INPUT, type TaxiInput } from './controller.js';
import { createTaxiSession, type TaxiAirport, type TaxiObservation, type TaxiRecord } from './session.js';
import { createTaxiRecorder } from './recorder.js';
import { buildTaxiScene } from './scene.js';
import { brakeAxis, writeTaxiAxes, createPmdgAutotaxi } from '../telemetry-provider/pmdg-autotaxi.js';
import { isClientMessageAuthorized } from '../core/client-message-authorization.js';
import { DEFAULT_TAXI_HANDLING, taxiHandlingKey, validateTaxiHandling, type TaxiHandling } from './handling.js';
import { TaxiControlWriteError } from './axes.js';
import { recoverTaxiControlBridge } from './control-recovery.js';

function graph(): TaxiGraph {
  return { complete: true,
    points: [[0, 0, 0, 1], [1, 0, 100, 1], [2, 0, 200, 2], [3, 0, 260, 1], [4, 1000, 260, 1]].map(([id, x, z, type]) => ({ id, x, z, type, orientation: 0 })),
    paths: [[0, 1], [1, 2], [2, 3], [3, 4]].map(([start, end], id) => ({ id, start, end, type: id === 3 ? 2 : 1, runway: id === 3 ? '09' : null, widthM: 45 })),
  };
}
const plan = (g = graph()) => planTaxiRoute(g, { x: 0, z: 10 }, 0, '09', '27', { x: 0, z: 260 });
const resolveTestAircraft = () => ({ ok: true as const, identity: 'C:/fixtures/aircraft.cfg', sourceFiles: [], fingerprint: 'synthetic-737',
  wheelbaseM: 15.6, maxSteeringDeg: 75, wheelTrackM: 8, lengthM: 50, noseOffsetM: 25 });

test('control recovery restarts a stopped bridge, waits for native reconnect, and bounds failures', async () => {
  for (const scenario of ['stopped', 'disconnected', 'timeout', 'cancelled', 'replaced', 'rejected']) {
    let now = 0, ensures = 0, valid = true, status = 'disconnected';
    let bridge = { _started: scenario !== 'stopped', getSnapshot: () => ({ status }) };
    const restored = await recoverTaxiControlBridge(new TaxiControlWriteError('AXIS_LEFT_BRAKE_SET',
      scenario === 'rejected' ? 'invalid_event' : 'not_connected'), () => valid, {
      bridge: () => bridge,
      ensure: async () => { ensures++; bridge._started = true; return bridge; },
      now: () => now,
      wait: async ms => {
        now += ms;
        if (scenario === 'cancelled') valid = false;
        if (scenario === 'replaced') bridge = { ...bridge };
        if (now >= 5000 && scenario !== 'timeout') status = 'connected';
      },
    });
    assert.equal(restored, ['stopped', 'disconnected'].includes(scenario), scenario);
    assert.equal(ensures, scenario === 'stopped' ? 1 : 0, scenario);
    assert(now <= 6500, 'recovery cannot wait indefinitely');
    if (scenario === 'rejected') assert.equal(now, 0, 'a rejected recipe is not a connection failure');
  }
});

test('failed control batch names the event and reconnects only to stop, never to replay thrust', async () => {
  for (const interruption of ['none', 'aircraft', 'release']) {
    let generation = 1, attempts = 0, recoveries = 0;
    let beginRecovery!: () => void, finishRecovery!: () => void;
    const recovering = new Promise<void>(resolve => { beginRecovery = resolve; });
    const gate = new Promise<void>(resolve => { finishRecovery = resolve; });
    const inputs: TaxiInput[] = [];
    const sample = () => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
      headingDeg: 0, speedKts: 0, timeMs: 1000, ready: true, profileKey: 'test', profileRevision: 1, generation });
    const session = createTaxiSession({ now: () => 1000, capture: sample,
      airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
      write: async (input, valid) => {
        inputs.push(input); const fail = ++attempts <= 2;
        await writeTaxiAxes(input, async () => ({ ok: !fail, error: 'not_connected' }), valid);
      },
      recover: async (_error, valid) => { recoveries++; beginRecovery(); await gate; return valid(); },
    });
    const owner = {};
    try {
      const started = session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'test', profileRevision: 1 }, owner);
      await recovering;
      assert.match(session.state().error!, /AXIS_LEFT_BRAKE_SET: not_connected/);
      if (interruption === 'aircraft') generation++;
      const released = interruption === 'release' ? session.request({ operation: 'release' }, owner) : Promise.resolve();
      finishRecovery(); await Promise.all([started, released]);
      assert.equal(recoveries, 1);
      assert(inputs[0].throttle > 0);
      assert.deepEqual(inputs[1], STOP_INPUT);
      assert(inputs.slice(1).every(input => input.throttle === 0), 'lost motion is never retried');
      if (interruption === 'none') {
        assert.deepEqual(inputs[2], STOP_INPUT);
        assert.equal(session.state().status, 'fault');
        assert.match(session.state().error!, /Control connection recovered/);
        assert.equal(session.state().canStart, false, 'a fresh explicit start requires release');
      } else if (interruption === 'aircraft') assert.equal(inputs.length, 2, 'no stop crosses an identity change');
      else {
        assert.equal(session.state().status, 'idle');
        assert.deepEqual(inputs[2], { throttle: 0, brake: 0, steering: 0 }, 'release cancels recovery and sends only its own handback');
      }
    } finally { finishRecovery(); await session.dispose(); }
  }
});

test('readiness lost inside a batch reports its actual reason and prevents later thrust', async () => {
  let ready = true;
  const events: [string, number][] = [];
  const session = createTaxiSession({ now: () => 1000,
    capture: () => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
      headingDeg: 0, speedKts: 0, timeMs: 1000, ready, reason: ready ? '' : 'Waiting for fresh ground-control telemetry.',
      profileKey: 'test', profileRevision: 1, generation: 1 }),
    airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
    write: (input, valid) => writeTaxiAxes(input, async (name, value) => { events.push([name, value]); ready = false; return { ok: true }; }, valid),
    recover: async () => { assert.fail('successful stop requires no reconnect'); },
  });
  try {
    await session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'test', profileRevision: 1 }, {});
    assert.match(session.state().error!, /Waiting for fresh ground-control telemetry/);
    assert(events.every(([name, value]) => !name.startsWith('THROTTLE') || value === 0));
    assert(events.some(([name, value]) => name === 'AXIS_RIGHT_BRAKE_SET' && value === 16383));
  } finally { await session.dispose(); }
});

test('route uses real holding point and leaves 30 metres of nose clearance', () => {
  const route = plan();
  assert.deepEqual(route.holdShort, { x: 0, z: 200 });
  assert.deepEqual(route.points.at(-1), { x: 0, z: 170 });
  assert.equal(route.lengthM, 160);
  assert.equal(route.runwayTravelM, 0);
});

test('aircraft handling changes hold clearance and scenery width eligibility without changing the holding point', () => {
  const g = graph();
  for (const path of g.paths) if (path.type === 1) path.widthM = 15;
  const small = { ...DEFAULT_TAXI_HANDLING, id: 'small', holdShortOffsetM: 8, minPathWidthM: 6 };
  const wide = { ...DEFAULT_TAXI_HANDLING, id: 'wide', holdShortOffsetM: 45, minPathWidthM: 20 };
  const make = (handling: TaxiHandling) => planTaxiRoute(g, { x: 0, z: 10 }, 0, '09', '27', { x: 0, z: 260 }, handling);
  const smallRoute = make(small);
  assert.deepEqual(smallRoute.holdShort, { x: 0, z: 200 });
  assert.deepEqual(smallRoute.points.at(-1), { x: 0, z: 192 });
  assert.throws(() => make(wide), /narrower than 20 m/);
  for (const path of g.paths) if (path.type === 1) path.widthM = 23;
  const wideRoute = make(wide);
  assert.deepEqual(wideRoute.points.at(-1), { x: 0, z: 155 });
  assert.deepEqual(wideRoute.holdShort, smallRoute.holdShort);
});

test('invalid handling cannot enter route planning or control and validated values are immutable', () => {
  for (const changed of [{ wheelbaseM: NaN }, { maxSteeringDeg: 0 }, { maxThrottle: 1.1 },
    { steeringLimitDeg: 80 }, { minPathWidthM: -1 }, { holdShortOffsetM: Infinity }, { maxSpeedKts: 7 }]) {
    const invalid = { ...DEFAULT_TAXI_HANDLING, ...changed };
    assert.throws(() => createTaxiController(plan(), { handling: invalid }), /handling/);
    assert.throws(() => planTaxiRoute(graph(), { x: 0, z: 10 }, 0, '09', '27', { x: 0, z: 260 }, invalid), /handling/);
  }
  const original = { ...DEFAULT_TAXI_HANDLING };
  const validated = validateTaxiHandling(original);
  original.maxThrottle = 0.25;
  assert.equal(validated.maxThrottle, 0.18);
  assert(Object.isFrozen(validated));
  assert.notEqual(taxiHandlingKey(validated), taxiHandlingKey(original));
});

test('route retains a longer junction approach when the cheapest arrival cannot take the onward turn', () => {
  // Northbound 1 -> 2 is cheaper but cannot make the 129-degree turn to 5.
  // Arriving via 3 -> 4 -> 2 faces east and permits the same onward link.
  const g: TaxiGraph = { complete: true,
    points: [[0, 0, 0], [1, 0, 500], [2, 0, 1000], [3, -500, 750], [4, -500, 1000], [5, 500, 600]]
      .map(([id, x, z]) => ({ id, x, z, type: 1, orientation: 0 })),
    paths: [[0, 1], [1, 2], [1, 3], [3, 4], [4, 2], [2, 5]]
      .map(([start, end], id) => ({ id, start, end, type: 1, runway: null, widthM: 30 })),
    parkings: [{ id: 100, type: 9, name: 10, suffix: 0, number: 1, headingDeg: 130, radiusM: 25, x: 600, z: 500 }],
  };
  g.paths.push({ id: 6, start: 5, end: 100, type: 3, runway: null, widthM: 30 });
  const route = planTaxiToStand(g, { x: 0, z: 10 }, 0, 'Gate 1');
  const withoutShortcut = planTaxiToStand({ ...g, paths: g.paths.filter(p => p.id !== 1) }, { x: 0, z: 10 }, 0, 'Gate 1');
  assert.deepEqual(route.points, withoutShortcut.points, 'an unusable shortcut cannot suppress the valid approach');
  assert.deepEqual(route.points, [{ x: 0, z: 10 }, ...[1, 3, 4, 2, 5].map(id => {
    const { x, z } = g.points.find(point => point.id === id)!;
    return { x, z };
  }), { x: 600, z: 500 }]);
  assert.equal(route.runwayTravelM, 0);
});

test('SDK PATH links route like TAXI links; parking, vehicle and closed links do not', () => {
  // Default scenery such as YMML builds nearly its whole network from type 4 PATH links.
  const paths = graph(); for (const p of paths.paths) if (p.type === 1) p.type = 4;
  assert.equal(plan(paths).lengthM, 160);
  for (const type of [3, 5, 6, 7, 8]) {
    const g = graph(); g.paths[2].type = type;
    assert.throws(() => plan(g), /hold-short/);
  }
});

test('links narrower than 10 m are ignored and reported when no hold can be reached', () => {
  const ok = graph(); for (const p of ok.paths) if (p.type !== 2) p.widthM = 10;
  assert.equal(plan(ok).lengthM, 160);
  const narrow = graph(); narrow.paths[2].widthM = 9.9;
  assert.throws(() => plan(narrow), /hold-short point.*1 taxiway links narrower than 10 m/);
  const missing = graph(); missing.points[2].type = 1;
  assert.throws(() => plan(missing), (err: Error) => /hold-short point/.test(err.message) && !/narrower/.test(err.message));
});

test('runway crossings through shared taxiway nodes are allowed', () => {
  const g = graph();
  g.points.push({ id: 5, x: -500, z: 100, type: 1, orientation: 0 });
  g.paths.push({ id: 5, start: 5, end: 1, type: 2, runway: '18', widthM: 45 });
  assert.equal(plan(g).lengthM, 160);
  assert.equal(plan(g).runwayTravelM, 0);
});

test('prefers a taxiway detour to travelling along an intervening runway; permits necessary runway travel', () => {
  const g = graph();
  g.paths[1] = { ...g.paths[1], type: 2, runway: '18' };
  assert.equal(plan(g).runwayTravelM, 100);
  g.points.push({ id: 5, x: 100, z: 100, type: 1, orientation: 0 }, { id: 6, x: 100, z: 200, type: 1, orientation: 0 });
  for (const [start, end] of [[1, 5], [5, 6], [6, 2]]) g.paths.push({ id: g.paths.length, start, end, type: 1, runway: null, widthM: 23 });
  assert.equal(plan(g).runwayTravelM, 0);
  assert(plan(g).lengthM > 160);
});

test('incomplete graphs, missing holding points, invalid edges and off-taxiway starts fail closed', () => {
  assert.throws(() => plan({ ...graph(), complete: false }), /Complete/);
  const missing = graph(); missing.points[2].type = 1;
  assert.throws(() => plan(missing), /hold-short/);
  const invalid = graph(); invalid.paths[0].end = 999;
  assert.throws(() => plan(invalid), /Incomplete/);
  // On the centreline but facing across it: no connector can absorb a 90° turn.
  assert.throws(() => planTaxiRoute(graph(), { x: 0, z: 10 }, 90, '09', '27', { x: 0, z: 260 }), /turn onto/);
  assert.throws(() => planTaxiRoute(graph(), { x: 200, z: 10 }, 0, '09', '27', { x: 0, z: 260 }), /No taxiway within 150 m/);
  // Facing away from the only onward taxiway.
  assert.throws(() => planTaxiRoute(graph(), { x: 20, z: 10 }, 180, '09', '27', { x: 0, z: 260 }), /No forward|turn onto/);
  // A connector that would cross a runway is never planned.
  const crossing = graph();
  crossing.points.push({ id: 5, x: 30, z: -200, type: 1, orientation: 0 }, { id: 6, x: 30, z: 400, type: 1, orientation: 0 });
  crossing.paths.push({ id: 5, start: 5, end: 6, type: 2, runway: '18', widthM: 45 });
  assert.throws(() => planTaxiRoute(crossing, { x: 80, z: 40 }, 300, '09', '27', { x: 0, z: 260 }), /turn onto/);
  assert(planTaxiRoute(graph(), { x: 80, z: 40 }, 300, '09', '27', { x: 0, z: 260 }).joinM > 50, 'the same start plans without the runway');
});

test('planner joins the network from an apron position over a straight connector and reports it', () => {
  // 20 m east of the taxiway, facing north: a shallow connector ahead, never a
  // right-angle dash to the nearest point.
  const route = planTaxiRoute(graph(), { x: 20, z: 10 }, 0, '09', '27', { x: 0, z: 260 });
  assert.deepEqual(route.points[0], { x: 20, z: 10 });
  const joined = route.points[1];
  assert(Math.abs(joined.x) < 0.001 && joined.z > 30, JSON.stringify(joined));
  assert(Math.abs(route.joinM - distance(route.points[0], joined)) < 0.001);
  assert(route.joinM > 20 && route.joinM < 90);
  const first = Math.abs(Math.atan2(joined.x - 20, joined.z - 10) * 180 / Math.PI);
  assert(first <= 45, `first turn ${first}`);
  assert.deepEqual(route.points.at(-1), { x: 0, z: 170 });
  // The connector counts in the route length; a start on the line reports no join.
  assert(route.lengthM > 160);
  assert.equal(plan().joinM, 0);
  // Facing the taxiway from across the apron, and the closed-loop follower copes with the join.
  const across = planTaxiRoute(graph(), { x: 60, z: 40 }, 300, '09', '27', { x: 0, z: 260 });
  assert(across.joinM > 40);
  const c = createTaxiController(across);
  let x = 60, z = 40, speed = 0, heading = 300 * Math.PI / 180;
  for (let now = 1000; now < 300000 && c.getState().status === 'taxiing'; now += 250) {
    const input = c.update({ x, z, timeMs: now, headingDeg: heading * 180 / Math.PI, speedKts: speed / 0.514444, ready: true }, now);
    speed = Math.max(0, speed + (input.throttle * 4 - 0.08 - input.brake * 2.5) * 0.25);
    heading += speed / 15.6 * Math.tan(input.steering * 65 * Math.PI / 180) * 0.25;
    x += Math.sin(heading) * speed * 0.25; z += Math.cos(heading) * speed * 0.25;
  }
  assert.equal(c.getState().status, 'holding', c.getState().reason);
});

// Runway 09/27 along z = 0 with an exit at x = 200, a taxiway north then west,
// and Gate D 12 on its own lead-in link north of the last taxi node.
function standGraph(): TaxiGraph {
  return { complete: true,
    points: [[10, -1000, 0], [11, 1000, 0], [12, 200, 0], [13, 200, 150], [14, 0, 150], [15, 400, 0], [16, 300, 100]]
      .map(([id, x, z]) => ({ id, x, z, type: 1, orientation: 0 })),
    paths: [
      { id: 0, start: 10, end: 12, type: 2, runway: '09', widthM: 45 }, { id: 1, start: 12, end: 15, type: 2, runway: '09', widthM: 45 },
      { id: 2, start: 15, end: 11, type: 2, runway: '09', widthM: 45 },
      { id: 3, start: 12, end: 13, type: 1, runway: null, widthM: 23 }, { id: 4, start: 13, end: 14, type: 1, runway: null, widthM: 23 },
      // A high-speed exit angled back towards the west: usable only for 27 arrivals.
      { id: 5, start: 15, end: 16, type: 1, runway: null, widthM: 23 }, { id: 6, start: 16, end: 13, type: 1, runway: null, widthM: 23 },
      { id: 7, start: 14, end: 0, type: 3, runway: null, widthM: 6 },
    ],
    parkings: [{ id: 0, type: 9, name: 15, suffix: 0, number: 12, headingDeg: 0, radiusM: 18, x: 0, z: 200 },
      { id: 1, type: 1, name: 6, suffix: 13, number: 3, headingDeg: 90, radiusM: 12, x: 600, z: 300 }],
  };
}

test('stands are named from the SDK enums and matched loosely', () => {
  const g = standGraph();
  assert.deepEqual(listParkings(g), ['Gate D 12', 'S Parking 3B']);
  assert.deepEqual(listParkingOptions(g), [
    { label: 'Gate D 12', typeLabel: 'Medium gate' }, { label: 'S Parking 3B', typeLabel: 'GA ramp' },
  ]);
  const types = standGraph();
  types.parkings = [
    { ...g.parkings![0], type: 10, number: 10 }, { ...g.parkings![0], type: 8, number: 2 },
    { ...g.parkings![0], type: 5, number: 3 }, { ...g.parkings![0], type: 0, number: 4 },
    { ...g.parkings![0], type: 99, number: 5 }, { ...g.parkings![0], type: 10, number: 2 },
  ];
  assert.deepEqual(listParkingOptions(types), [
    { label: 'Gate D 2', typeLabel: 'Small gate' }, { label: 'Gate D 3', typeLabel: 'Cargo ramp' },
    { label: 'Gate D 4', typeLabel: 'Unspecified type' }, { label: 'Gate D 5', typeLabel: 'Unknown type' },
    { label: 'Gate D 10', typeLabel: 'Heavy gate' },
  ], 'use scenery type, natural order, and the same first duplicate as routing');
  for (const query of ['D12', 'd 12', 'Gate D 12', 'GATE D12', '12']) assert.equal(findParking(g, query).id, 0, query);
  assert.equal(findParking(g, 'Parking 3B').id, 1);
  assert.throws(() => findParking(g, 'E3'), /No stand "E3"/);
  assert.equal(findParking(g, '3').id, 1, 'a bare number matches the stand number');
  const twin = standGraph(); twin.parkings!.push({ ...twin.parkings![1], id: 2, name: 2 });
  assert.throws(() => findParking(twin, '3'), /used 2 times here: S Parking 3B, N Parking 3B/);
  assert.throws(() => findParking(g, ''), /Enter a gate/);
});

test('after landing the planner rolls to a usable exit, follows taxiways and ends on the stand', () => {
  const g = standGraph();
  const route = planTaxiToStand(g, { x: -300, z: 0 }, 90, 'D12');
  assert.equal(route.kind, 'stand');
  assert.equal(route.label, 'Gate D 12');
  assert.equal(route.joinM, 0);
  assert.deepEqual(route.points.at(-1), { x: 0, z: 200 }, 'no hold-short trim before a stand');
  assert.deepEqual(route.stand && { x: route.stand.x, z: route.stand.z, radiusM: route.stand.radiusM }, { x: 0, z: 200, radiusM: 18 });
  assert(Math.abs(route.runwayTravelM - 500) < 0.01, 'roll-out to the exit counts as runway travel');
  assert(!route.points.some(p => p.x === 300 && p.z === 100), 'the backward-angled exit is not used');
  assert(Math.abs(route.lengthM - 900) < 0.01);
  // Past the last forward exit, the only remaining exit needs a 135° turn: refused rather than driven.
  assert.throws(() => planTaxiToStand(g, { x: 300, z: 0 }, 90, 'D12'), /No forward taxi route to Gate D 12/);
  // A stand with no lead-in link, and a departure plan never enters a stand link.
  const orphan = standGraph(); orphan.paths = orphan.paths.filter(p => p.type !== 3);
  assert.throws(() => planTaxiToStand(orphan, { x: -300, z: 0 }, 90, 'D12'), /no lead-in link/);
  // The follower parks on the stand.
  const c = createTaxiController(route, { steeringSign: 1 });
  let x = -300, z = 0, speed = 8 * 0.514444, heading = Math.PI / 2;
  for (let now = 1000; now < 600000 && c.getState().status === 'taxiing'; now += 250) {
    const input = c.update({ x, z, timeMs: now, headingDeg: heading * 180 / Math.PI, speedKts: speed / 0.514444, ready: true }, now);
    speed = Math.max(0, speed + (input.throttle * 4 - 0.08 - input.brake * 2.5) * 0.25);
    heading += speed / 15.6 * Math.tan(input.steering * 65 * Math.PI / 180) * 0.25;
    x += Math.sin(heading) * speed * 0.25; z += Math.cos(heading) * speed * 0.25;
  }
  assert.equal(c.getState().status, 'holding', c.getState().reason);
  assert.match(c.getState().reason, /Parked at Gate D 12/);
  assert(Math.hypot(x, 200 - z) < 3, `${x.toFixed(1)}, ${z.toFixed(1)}`);
});

test('session lists stands, starts a stand taxi while rolling, and refuses a fast roll-out', async () => {
  const now = 1000;
  let speed = 8;
  const profileKey = 'bundled/msfs/pmdg-737';
  const inputs: any[] = [];
  const asked: (string | null)[] = [];
  const sample = (): TaxiObservation => ({ x: 0, z: 0, lat: 0, lon: -300 / 6371000 * 180 / Math.PI,
    headingDeg: 90, speedKts: speed, timeMs: now, ready: true, profileKey, profileRevision: 1, generation: 1 });
  const session = createTaxiSession({ now: () => now, capture: sample,
    airport: async (_icao, runway) => { asked.push(runway); return { origin: { lat: 0, lon: 0 }, graph: standGraph(), threshold: null, reciprocal: null }; },
    write: async input => { inputs.push(input); } });
  const client = {};
  try {
    const listed: any = await session.request({ operation: 'parkings', icao: 'TEST' }, client);
    assert.deepEqual(listed.stands, ['Gate D 12', 'S Parking 3B']);
    assert.deepEqual(listed.standOptions, [
      { label: 'Gate D 12', typeLabel: 'Medium gate' }, { label: 'S Parking 3B', typeLabel: 'GA ramp' },
    ]);
    assert.deepEqual(asked, [null]);
    speed = 13;
    await assert.rejects(session.request({ operation: 'start', icao: 'TEST', parking: 'D12', profileKey, profileRevision: 1 }, client), /Slow below 12 kt/);
    speed = 8;
    const preview: any = await session.request({ operation: 'preview', icao: 'TEST', parking: 'D12', profileKey, profileRevision: 1 }, client);
    assert.match(preview.reason, /900 m to Gate D 12/);
    assert.equal(preview.preview.kind, 'stand');
    await session.request({ operation: 'start', icao: 'TEST', runway: '', parking: 'd 12', profileKey, profileRevision: 1 }, client);
    const s = session.state(true);
    assert.equal(s.status, 'taxiing');
    assert.equal(s.route?.kind, 'stand');
    assert.equal(s.route?.label, 'Gate D 12');
    assert.equal(s.scene?.stands.length, 1, 'only the stand near the route is drawn');
    assert.equal(s.scene?.stands[0].label, 'Gate D 12');
    assert(inputs.length > 0);
  } finally { await session.dispose(); }
});

test('controller probes the steering axis direction on first use, then trusts it and stops on a contradiction', () => {
  const run = (axis: number, options: { steeringSign?: 1 | -1 | null }, lagS = 0) => {
    const points = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 120, z: 100 }];
    const c = createTaxiController({ points, lengthM: 220, runway: '09', holdShort: { x: 150, z: 100 }, runwayTravelM: 0, joinM: 0, kind: 'hold' as const, label: 'hold short of runway 09' }, options);
    let x = 0, z = 0, speed = 0, heading = 0, wheel = 0, probeM = 0, maxYawDuringProbe = 0;
    for (let now = 1000; now < 300000 && c.getState().status === 'taxiing'; now += 250) {
      const input = c.update({ x, z, timeMs: now, headingDeg: heading * 180 / Math.PI, speedKts: speed / 0.514444, ready: true }, now);
      if (c.getState().probing) { probeM += speed * 0.25; maxYawDuringProbe = Math.max(maxYawDuringProbe, Math.abs(heading) * 180 / Math.PI); }
      speed = Math.max(0, speed + (input.throttle * 4 - 0.08 - input.brake * 2.5) * 0.25);
      wheel += (input.steering - wheel) * (lagS ? 0.25 / (lagS + 0.25) : 1);
      heading += speed / 15.6 * Math.tan(axis * wheel * 65 * Math.PI / 180) * 0.25;
      x += Math.sin(heading) * speed * 0.25; z += Math.cos(heading) * speed * 0.25;
    }
    return { state: c.getState(), x, z, probeM, maxYawDuringProbe };
  };
  // Unknown direction: a short creep decides it, on a documented and on a reversed axis, with tiller lag too.
  for (const [axis, lag] of [[1, 0], [-1, 0], [1, 1.5], [-1, 1.5]] as const) {
    const r = run(axis, {}, lag);
    assert.equal(r.state.status, 'holding', `axis ${axis}, lag ${lag}: ${r.state.reason}`);
    assert.equal(r.state.steeringSign, axis);
    assert(r.probeM < 8 && r.maxYawDuringProbe < 4, `probe ${r.probeM.toFixed(1)} m, ${r.maxYawDuringProbe.toFixed(1)}°`);
    assert(Math.hypot(120 - r.x, 100 - r.z) < 3);
  }
  // A learned direction skips the probe.
  const learned = run(-1, { steeringSign: -1 });
  assert.equal(learned.state.status, 'holding', learned.state.reason);
  assert.equal(learned.probeM, 0);
  // A learned direction that the aircraft contradicts stops the taxi and is forgotten.
  const wrong = run(1, { steeringSign: -1 });
  assert.equal(wrong.state.status, 'fault');
  assert.equal(wrong.state.steeringSign, null);
  // No steering response at all (Rudder Only mode) stops within the probe distance.
  const dead = run(0, {});
  assert.equal(dead.state.status, 'fault');
  assert.match(dead.state.reason, /no effect over 12 m/);
  assert(dead.probeM < 14);
});

test('a stopped session sets the parking brake, releases the axes and hands the aircraft back', async () => {
  let now = 1000;
  let speed = 0;
  const profileKey = 'bundled/msfs/pmdg-737';
  const inputs: any[] = [];
  let parked = 0;
  const sample = (): TaxiObservation => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
    headingDeg: 0, speedKts: speed, timeMs: now, ready: true, profileKey, profileRevision: 1, generation: 1 });
  const session = createTaxiSession({ now: () => now, capture: sample,
    airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
    write: async input => { inputs.push(input); },
    park: async () => { assert.deepEqual(inputs.at(-1), STOP_INPUT, 'toe brakes held while the lever is set'); parked++; },
  });
  const client = {};
  const request = { operation: 'start', icao: 'TEST', runway: '09', profileKey, profileRevision: 1 };
  try {
    await session.request(request, client);
    speed = 3;
    now += 250; await session.tick();
    assert.equal(session.state().status, 'taxiing');
    await session.request({ operation: 'stop' }, client);
    assert.equal(session.state().status, 'stopping');
    assert.equal(parked, 0, 'no parking brake while still rolling');
    speed = 0;
    now += 250; await session.tick();
    assert.equal(session.state().status, 'stopped');
    assert.equal(parked, 0, 'wait a second at rest before handing over');
    assert.equal(session.state().handedOver, false);
    now += 1100; await session.tick();
    assert.equal(parked, 1);
    assert.deepEqual(inputs.at(-1), { throttle: 0, brake: 0, steering: 0 });
    assert.equal(session.state().handedOver, true);
    assert.match(session.state().reason, /Parking brake set/);
    assert.equal(session.isActive(), false, 'other aircraft commands are allowed again');
    assert.equal(session.state().canStart, true);
    const writes = inputs.length;
    now += 250; await session.tick();
    assert.equal(inputs.length, writes, 'no further axis writes after the handover');
    // Release after a handover must not touch the axes again; a new plan needs no release.
    await session.request({ operation: 'release' }, client);
    assert.equal(inputs.length, writes);
    assert.equal(session.state().status, 'idle');
    await session.request(request, client);
    assert.equal(session.state().status, 'taxiing');
    // A lever that drops when the pedals are released is caught in the watch
    // window: the toe brakes go back on and the panel says so.
    let lever: boolean | null = true;
    const dropping = createTaxiSession({ now: () => now, capture: sample,
      airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
      write: async input => { inputs.push(input); }, park: async () => { lever = true; }, parked: () => lever });
    await dropping.request(request, client);
    await dropping.request({ operation: 'stop' }, client);
    now += 1100; await dropping.tick();
    assert.equal(dropping.state().handedOver, true);
    lever = false;
    now += 250; await dropping.tick();
    assert.equal(dropping.state().handedOver, false);
    assert.deepEqual(inputs.at(-1), STOP_INPUT);
    assert.match(dropping.state().error || '', /released when the pedals/);
    assert.equal(dropping.isActive(), true);
    await dropping.dispose();
    // A stop arriving while the lever action is in progress is not a failure.
    let unblockPark!: () => void;
    const parkGate = new Promise<void>(resolve => { unblockPark = resolve; });
    const racing = createTaxiSession({ now: () => now, capture: sample,
      airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
      write: async input => { inputs.push(input); }, park: async () => { await parkGate; }, parked: () => true });
    await racing.request(request, client);
    await racing.request({ operation: 'stop' }, client);
    now += 1100;
    const handing = racing.tick();
    await Promise.resolve(); await Promise.resolve();
    const stopAgain = racing.request({ operation: 'stop' }, client);
    unblockPark(); await Promise.all([handing, stopAgain]);
    assert.equal(racing.state().handedOver, true, racing.state().error || '');
    assert.equal(racing.state().error, null);
    assert.equal(racing.state().status, 'stopped');
    await racing.dispose();
    // A parking-brake failure keeps the toe brakes held and reports it.
    const failing = createTaxiSession({ now: () => now, capture: sample,
      airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
      write: async input => { inputs.push(input); }, park: async () => { throw new Error('lever refused'); } });
    await failing.request(request, client);
    await failing.request({ operation: 'stop' }, client);
    now += 1100; await failing.tick();
    assert.equal(failing.state().handedOver, false);
    assert.match(failing.state().error || '', /lever refused/);
    assert.deepEqual(inputs.at(-1), STOP_INPUT);
    await failing.dispose();
  } finally { await session.dispose(); }
});

test('planner rejects an immediate reversal and a taxi link crossing the destination runway without a shared node', () => {
  const reverse = graph();
  reverse.points.push({ id: 5, x: 0, z: -100, type: 1, orientation: 0 });
  reverse.paths = reverse.paths.filter(p => p.id !== 1);
  reverse.paths.push({ id: 10, start: 0, end: 2, type: 1, widthM: 45, runway: null });
  // The join onto the stub ending at node 1 can only double back, so the
  // planner falls through to the join that continues to node 2 instead.
  const around = plan(reverse);
  assert.equal(around.lengthM, 160);
  assert(!around.points.some(p => p.x === 0 && p.z === 100), 'never routes through the dead-end stub');
  // With the only other way round starting behind the aircraft (and the
  // parallel taxiway beyond join range), the reversal is refused, not driven.
  reverse.paths = reverse.paths.filter(p => p.id !== 10);
  reverse.points.push({ id: 6, x: -200, z: 0, type: 1, orientation: 0 }, { id: 7, x: -200, z: 200, type: 1, orientation: 0 });
  for (const [id, start, end] of [[11, 0, 6], [12, 6, 7], [13, 7, 2]]) reverse.paths.push({ id, start, end, type: 1, widthM: 45, runway: null });
  assert.throws(() => plan(reverse), /No forward/);
  const crossing = graph();
  crossing.points[1] = { ...crossing.points[1], x: 100, z: 350 };
  crossing.points[0] = { ...crossing.points[0], x: 100, z: 450 };
  assert.throws(() => planTaxiRoute(crossing, { x: 100, z: 440 }, 180, '09', '27', { x: 0, z: 260 }), /No forward/);
});

test('airport projection uses true east/north metres including southern latitudes', () => {
  const origin = { lat: -34, lon: 151 };
  const delta = 100 / 6371000 * 180 / Math.PI;
  const p = localPosition(origin.lat + delta, origin.lon + delta / Math.cos(origin.lat * Math.PI / 180), origin);
  assert(Math.abs(p.x - 100) < 0.001 && Math.abs(p.z - 100) < 0.001);
});

test('controller stops on stale data, path deviation, overspeed, explicit stop, and does not auto-resume', () => {
  const sample = { x: 0, z: 10, headingDeg: 0, speedKts: 0, ready: true, timeMs: 1000 };
  for (const altered of [{ ...sample, timeMs: 0 }, { ...sample, x: 10 }, { ...sample, speedKts: 16 }, { ...sample, ready: false }]) {
    const c = createTaxiController(plan());
    assert.deepEqual(c.update(altered, 2000), STOP_INPUT);
    assert.equal(c.getState().status, 'fault');
    assert.deepEqual(c.update({ ...sample, timeMs: 2250 }, 2250), STOP_INPUT);
  }
  const c = createTaxiController(plan()); c.stop();
  assert.deepEqual(c.update(sample, 1000), STOP_INPUT);
  assert.equal(c.getState().status, 'stopped');
});

test('timing and position faults retain the failing sample and original reason', () => {
  const initial = { x: 0, z: 10, headingDeg: 0, speedKts: 3, ready: true, timeMs: 1000 };
  for (const [change, reason] of [
    [{ timeMs: 2700, z: 12 }, /update gap 1.70 s/],
    [{ timeMs: 1250, z: 40 }, /Position jumped 30.0 m/],
    [{ timeMs: 900 }, /update gap -0.10 s/],
  ] as const) {
    const c = createTaxiController(plan(), { steeringSign: 1 });
    c.update(initial, 1000);
    const sample = { ...initial, ...change };
    assert.deepEqual(c.update(sample, sample.timeMs), STOP_INPUT);
    assert.match(c.getState().reason, reason);
    const firstReason = c.getState().reason;
    assert.equal(c.trace()!.dtS, (sample.timeMs - initial.timeMs) / 1000);
    assert.equal(c.trace()!.movedM, sample.z - initial.z);
    assert.equal(c.trace()!.targetKts, null, 'fault trace must not retain the prior speed target');
    assert.equal(c.trace()!.brake, 1);
    assert.equal(c.trace()!.throttle, 0);
    c.update({ ...sample, ready: false, reason: 'later telemetry loss' }, sample.timeMs + 250);
    assert.equal(c.getState().reason, firstReason);
    assert.deepEqual(c.update({ ...sample, timeMs: 3000 }, 3000), STOP_INPUT, 'fresh data never resumes a fault');
    c.update({ ...sample, speedKts: 0, timeMs: 3250 }, 3250);
    c.update({ ...sample, speedKts: 0, timeMs: 4500 }, 4500);
    assert.equal(c.getState().settled, true, 'a timing fault can still settle for parking-brake handover');
    assert.equal(c.getState().reason, firstReason);
  }
});

test('speed planning permits small straight-line corrections and routine braking has no hard minimum', () => {
  const points = [{ x: 0, z: 0 }, { x: 0, z: 500 }];
  const route = { ...plan(), points, lengthM: 500 };
  for (const heading of [0, 4]) {
    const c = createTaxiController(route, { steeringSign: 1 });
    c.update({ x: 0, z: 50, headingDeg: heading, speedKts: 6, ready: true, timeMs: 1000 }, 1000);
    assert(c.trace()!.targetKts! > 6, `a ${heading} degree correction should not select crawl speed`);
    if (heading === 0) assert.equal(c.trace()!.targetKts, 8);
  }
  const c = createTaxiController(route, { steeringSign: 1 });
  const input = c.update({ x: 0, z: 50, headingDeg: 0, speedKts: 8.4, ready: true, timeMs: 1000 }, 1000);
  assert(input.brake > 0 && input.brake < 0.04, `small excess needs a small correction: ${input.brake}`);
  assert.equal(input.throttle, 0);
  c.stop();
  assert.deepEqual(c.update({ x: 0, z: 51, headingDeg: 0, speedKts: 8, ready: true, timeMs: 1250 }, 1250), STOP_INPUT,
    'explicit stop bypasses routine brake ramp');
});

test('parking-brake handover requires a new stationary interval after missing or discontinuous telemetry', async () => {
  for (const interruption of ['unavailable', 'gap', 'backwards', 'duplicate'] as const) {
    let now = 1000, sourceTime = 1000, ready = true;
    let parks = 0;
    const capture = (): TaxiObservation => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
      headingDeg: 0, speedKts: 0, timeMs: sourceTime, ready, profileKey: 'test', profileRevision: 1, generation: 1 });
    const session = createTaxiSession({ now: () => now, capture,
      airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
      write: async () => {}, park: async () => { parks++; } });
    const client = {};
    try {
      await session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'test', profileRevision: 1 }, client);
      await session.request({ operation: 'stop' }, client);
      if (interruption === 'unavailable') {
        now = sourceTime = 1250; ready = false; await session.tick();
        now = sourceTime = 2000; ready = true; await session.tick();
      } else if (interruption === 'gap') {
        now = sourceTime = 3000; await session.tick();
      } else if (interruption === 'backwards') {
        now = 1250; sourceTime = 900; await session.tick();
        now = sourceTime = 2000; await session.tick();
      } else {
        now = 2000; await session.tick(); // Same source sample, still just inside freshness bound.
        assert.equal(parks, 0, 'wall-clock passage alone must not set the parking brake');
        now = 2250; await session.tick(); // Now stale: discard the stationary evidence.
        now = sourceTime = 2500; await session.tick();
      }
      assert.equal(parks, 0, `${interruption}: fresh recovery alone must not complete handover`);
      for (let i = 0; i < 4; i++) { now += 250; sourceTime = now; await session.tick(); }
      assert.equal(parks, 1, `${interruption}: fresh stationary samples permit handover`);
      assert.equal(session.state().handedOver, true);
      assert.notEqual(session.state().status, 'taxiing', 'handover must never resume taxi');
    } finally { await session.dispose(); }
  }
});

test('closed-loop vehicle model follows a straight path and a right-angle turn, then holds without overshooting', () => {
  for (const points of [[{ x: 0, z: 0 }, { x: 0, z: 180 }], [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 120, z: 100 }]]) {
    const route: TaxiRoute = { points, lengthM: 220, runway: '09', holdShort: { x: 150, z: 100 }, runwayTravelM: 0, joinM: 0, kind: 'hold' as const, label: 'hold short of runway 09' };
    const c = createTaxiController(route);
    let x = 0, z = 0, speed = 0, heading = 0, maxSpeed = 0;
    for (let now = 1000; now < 300000; now += 250) {
      const input = c.update({ x, z, timeMs: now, headingDeg: heading * 180 / Math.PI, speedKts: speed / 0.514444, ready: true }, now);
      assert.equal(input.brake > 0 && input.throttle > 0, false);
      assert(input.throttle <= 0.18);
      speed = Math.max(0, speed + (input.throttle * 4 - 0.08 - input.brake * 2.5) * 0.25);
      heading += speed / 15.6 * Math.tan(input.steering * 65 * Math.PI / 180) * 0.25;
      x += Math.sin(heading) * speed * 0.25; z += Math.cos(heading) * speed * 0.25;
      maxSpeed = Math.max(maxSpeed, speed / 0.514444);
      if (c.getState().status === 'holding') break;
      assert.equal(c.getState().status, 'taxiing', c.getState().reason);
    }
    assert.equal(c.getState().status, 'holding');
    assert(maxSpeed < 10);
    const end = points.at(-1)!;
    assert(Math.hypot(end.x - x, end.z - z) < 3);
  }
});

test('lagged vehicle scenarios cover long links, dense points, both turns and curved taxiways', () => {
  const shapes: Record<string, Point[]> = {
    straight: [{ x: 0, z: 0 }, { x: 0, z: 220 }],
    long: [{ x: 0, z: 0 }, { x: 0, z: 1000 }, { x: 150, z: 1000 }],
    right: [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 150, z: 100 }],
    left: [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: -150, z: 100 }],
    dense: Array.from({ length: 801 }, (_, i) => ({ x: 0, z: i * 0.25 })),
    curve: [{ x: 0, z: 0 }, ...Array.from({ length: 19 }, (_, i) => ({
      x: 30 - 30 * Math.cos(i * 5 * Math.PI / 180), z: 100 + 30 * Math.sin(i * 5 * Math.PI / 180),
    })), { x: 150, z: 130 }],
  };
  // Deliberately independent of the controller's assumed dynamics. These are
  // sensitivity tests, not a reproduction of PMDG's proprietary ground model.
  for (const [name, points] of Object.entries(shapes)) {
    for (const [engineLag, steeringLag, brakePower, idleAccel, gain, cadence, effectiveAngle] of [
      [1, 0.3, 3, 0, 5, 0.25, 78], [3, 1, 2.5, 0.05, 4, 0.25, 75],
      [5, 3, 1.5, 0.08, 3, 0.5, 65], [3, 3, 2.5, 0.05, 4, 0.25, 78],
      [3, 5, 2.5, 0.05, 4, 0.25, 75],
      // Strong brakes and slow spool response exposed the old brake/creep
      // cycle on straights as well as bends. Include rolling resistance too.
      [6, 1, 8, 0.05, 4, 0.25, 75], [8, 3, 8, 0.02, 3, 0.5, 75], [5, 1, 8, -0.08, 4, 0.25, 75],
      // Also tolerate a degraded 1 Hz update loop without brake-to-rest cycles.
      [6, 1, 8, 0.05, 4, 1, 75], [5, 1, 8, -0.08, 4, 1, 75],
    ]) {
      const lengthM = points.reduce((sum, p, i) => sum + (i ? distance(p, points[i - 1]) : 0), 0);
      const c = createTaxiController({ points, lengthM, runway: '16', holdShort: points.at(-1)!, runwayTravelM: 0, joinM: 0, kind: 'hold' as const, label: 'hold short of runway 09' });
      let x = 0, z = -3.3, speed = 0, heading = 0, thrust = 0, steering = 0, peak = 0;
      let input = { throttle: 0, brake: 0, steering: 0 };
      const label = `${name}, engine lag ${engineLag}, steering lag ${steeringLag}, cadence ${cadence}`;
      for (let tick = 0; tick < 16000; tick++) {
        const now = 1000 + tick * 50;
        if (tick % Math.round(cadence / 0.05) === 0) {
          input = c.update({ x: x + 3.3 * Math.sin(heading), z: z + 3.3 * Math.cos(heading), timeMs: now,
            headingDeg: heading * 180 / Math.PI, speedKts: speed / 0.514444, ready: true }, now);
        }
        thrust += (input.throttle - thrust) * 0.05 / (engineLag + 0.05);
        steering += (input.steering - steering) * 0.05 / (steeringLag + 0.05);
        speed = Math.max(0, speed + (thrust * gain + idleAccel - 0.025 * speed - input.brake * brakePower) * 0.05);
        heading += speed / 15.57 * Math.tan(steering * effectiveAngle * Math.PI / 180) * 0.05;
        x += Math.sin(heading) * speed * 0.05; z += Math.cos(heading) * speed * 0.05;
        peak = Math.max(peak, speed / 0.514444);
        if (now > 31000 && c.getState().remainingM > 20) {
          assert(speed / 0.514444 > 0.5, `${label}: stalled before the destination at ${(speed / 0.514444).toFixed(2)} kt`);
        }
        if (c.getState().status === 'holding') break;
        assert.equal(c.getState().status, 'taxiing', `${label}: ${c.getState().reason}`);
      }
      assert.equal(c.getState().status, 'holding', label);
      assert(peak < 9, `${label}: excessive speed ${peak}`);
      assert(distance({ x: x + 3.3 * Math.sin(heading), z: z + 3.3 * Math.cos(heading) }, points.at(-1)!) < 2, label);
    }
  }
});

test('axis encoder uses brake release -16383 and attempts both brakes despite a stop-write failure', async () => {
  assert.equal(brakeAxis(0), -16383); assert.equal(brakeAxis(0.27), 0); assert.equal(brakeAxis(1), 16383);
  const events: [string, number][] = [];
  await assert.rejects(writeTaxiAxes(STOP_INPUT, async (name, value) => { events.push([name, value]); return { ok: name !== 'THROTTLE1_SET' }; }, () => true));
  assert(events.some(([name, value]) => name === 'AXIS_RIGHT_BRAKE_SET' && value === 16383));
  const moving: string[] = [];
  await writeTaxiAxes({ throttle: 0.1, brake: 0, steering: -0.5 }, async name => { moving.push(name); return { ok: true }; }, () => true);
  assert.equal(moving.at(-1), 'THROTTLE2_SET');
  await assert.rejects(writeTaxiAxes({ throttle: 1, brake: 0, steering: 0 }, async () => ({ ok: true }), () => true));
});

test('partial braking stays proportional through both simulator axis events', async () => {
  const fractions = [0, 0.01, 0.04, 0.08, 0.17, 0.27, 0.53, 1];
  const encoded = fractions.map(brakeAxis);
  assert(encoded.every((value, i) => i === 0 || value > encoded[i - 1]));
  for (const fraction of fractions) {
    const events: [string, number][] = [];
    await writeTaxiAxes({ throttle: 0, brake: fraction, steering: 0 }, async (name, value) => {
      events.push([name, value]); return { ok: true };
    }, () => true);
    const brakes = events.filter(([name]) => name.includes('BRAKE'));
    assert.deepEqual(brakes, [['AXIS_LEFT_BRAKE_SET', brakeAxis(fraction)], ['AXIS_RIGHT_BRAKE_SET', brakeAxis(fraction)]]);
    if (fraction > 0 && fraction < 1) assert(brakes.every(([, value]) => value > -16383 && value < 16383));
  }
});

test('ground commands require aircraft-control authorization', () => {
  assert.equal(isClientMessageAuthorized({}, 'autotaxi'), false);
  assert.equal(isClientMessageAuthorized({ __ffAircraftControlClient: true }, 'autotaxi'), true);
});

test('PMDG boundary requires exact profiles and every independently fresh required field', async () => {
  let now = 5000;
  let profileKey = 'bundled/msfs/pmdg-737';
  const d = { lat: 0, lon: 0, heading: 0, gs: 0, wow: true, paused: false, slewActive: false,
    parkingBrake: false, engineCount: 2, engineType: 1, eng1Combustion: true, eng2Combustion: true, thr1: 0, thr2: 0, athrArmed: false, athrActive: false };
  const times = Object.fromEntries(Object.keys(d).map(key => [key, new Date(now).toISOString()]));
  const provider = { _data: d, _connected: true, _systemState: { sim: 1 }, _lastDetectedAircraftTitle: 'C:/fixtures/aircraft.cfg',
    _rustSimvarBridge: { getSnapshot: () => ({ status: 'running', values: d, valueUpdatedAt: times }) },
    _sdkBridge: { isDataConnected: () => true, getSnapshot: () => ({ adapterId: 'clientdata-manifest', updatedAt: new Date(now).toISOString(), target: { connector: 'pmdg-737-ng3-clientdata' },
      normalized: { automation: { athr: { armed: false, active: false } } } }) } };
  const session = createPmdgAutotaxi(provider, { getActiveProfileId: () => profileKey, getActiveProfileRevision: () => 1 }, () => now, { resolveModel: resolveTestAircraft });
  assert.equal(session.state().canStart, true);
  profileKey = 'local/pmdg-737'; assert.equal(session.state().canStart, false);
  profileKey = 'bundled/msfs/pmdg-737';
  now++; // The trusted scope receives a new SDK payload before freshness cases.
  assert.equal(session.state().canStart, true);
  for (const key of Object.keys(d)) {
    const original = times[key]; times[key] = new Date(now - 1500).toISOString();
    assert.equal(session.state().canStart, false, `${key} must not inherit another field's freshness`);
    times[key] = original;
    assert.equal(session.state().canStart, true, `${key} restoration must recover readiness`);
  }
  d.athrArmed = true; assert.equal(session.state().canStart, false); d.athrArmed = false;
  d.parkingBrake = true; assert.equal(session.state().canStart, false);
  await session.dispose();
});

test('cancelling a pending airport request never starts a controller or sends motion', async () => {
  let resolveAirport!: (value: any) => void;
  const airport = new Promise<any>(resolve => { resolveAirport = resolve; });
  const sample = { x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
    headingDeg: 0, speedKts: 0, timeMs: 1000, ready: true, profileKey: 'pmdg-test', profileRevision: 1, generation: 1 };
  const inputs: any[] = [];
  const session = createTaxiSession({ now: () => 1000, capture: () => sample, airport: () => airport, write: async input => { inputs.push(input); } });
  const client = {};
  const start = session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: sample.profileKey, profileRevision: 1 }, client);
  const rejection = assert.rejects(start, /cancelled/);
  await session.request({ operation: 'stop' }, client);
  resolveAirport({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' });
  await rejection;
  assert.equal(session.state().status, 'idle');
  assert.equal(inputs.length, 0);
  await session.dispose();
});

test('planning retains its original owner lease and never starts after disconnect or heartbeat expiry', async () => {
  for (const interruption of ['disconnect', 'expiry', 'late-heartbeat', 'live-heartbeats']) {
    let now = 1000, connected = true;
    let finish!: (value: TaxiAirport) => void;
    const inputs: TaxiInput[] = [];
    const sample = (): TaxiObservation => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
      headingDeg: 0, speedKts: 0, timeMs: now, ready: true, profileKey: 'test', profileRevision: 1, generation: 1 });
    const session = createTaxiSession({ now: () => now, capture: sample,
      airport: () => new Promise(resolve => { finish = resolve; }),
      write: async (input, valid) => { assert.ok(valid()); inputs.push(input); } });
    const client = {};
    try {
      const start = session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'test', profileRevision: 1 }, client, () => connected);
      const result = start.then(value => ({ value, error: null }), error => ({ value: null, error }));
      if (interruption === 'disconnect') connected = false;
      for (let i = 0; i < 5; i++) {
        now += 1000;
        await session.request({ operation: 'status' }, interruption === 'expiry' || interruption === 'late-heartbeat' && i < 4 ? {} : client);
      }
      finish({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' });
      const completed = await result;
      if (interruption === 'live-heartbeats') {
        assert.equal(completed.error, null);
        assert.equal(session.state().status, 'taxiing');
        connected = false;
        await session.tick();
        assert.notEqual(session.state().status, 'taxiing');
        assert.deepEqual(inputs.at(-1), STOP_INPUT, 'disconnect preserves the braking path');
      } else {
        assert.match(completed.error?.message || '', /connection|expired/i);
        assert.equal(session.state().status, 'idle');
        assert.deepEqual(inputs, []);
      }
    } finally { await session.dispose(); }
  }
});

test('session rejects stale profile requests, stops on heartbeat expiry, and releases axes explicitly', async () => {
  let now = 1000;
  const profileKey = 'bundled/msfs/pmdg-737';
  const inputs: any[] = [];
  const sample = (): TaxiObservation => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
    headingDeg: 0, speedKts: 0, timeMs: now, ready: true, profileKey, profileRevision: 1, generation: 1 });
  const session = createTaxiSession({ now: () => now, capture: sample,
    airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
    write: async input => { inputs.push(input); },
  });
  const client = {};
  const request = { operation: 'start', icao: 'TEST', runway: '09', profileKey, profileRevision: 1 };
  try {
    await assert.rejects(session.request({ ...request, profileRevision: 2 }, client), /Aircraft changed/);
    await session.request(request, client);
    assert.equal(session.state().status, 'taxiing');
    now += 3100;
    await session.request({ operation: 'status' }, {}); // another client cannot keep ownership alive
    await session.tick();
    assert.notEqual(session.state().status, 'taxiing');
    assert.deepEqual(inputs.at(-1), STOP_INPUT);
    await session.request({ operation: 'release' }, client);
    assert.deepEqual(inputs.at(-1), { throttle: 0, brake: 0, steering: 0 });
    assert.equal(session.state().status, 'idle');
  } finally { await session.dispose(); }
});

test('disconnect during a motion write invalidates its guard but permits the best-effort stop', async () => {
  let connected = true;
  const inputs: TaxiInput[] = [];
  const session = createTaxiSession({ now: () => 1000,
    capture: () => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
      headingDeg: 0, speedKts: 0, timeMs: 1000, ready: true, profileKey: 'test', profileRevision: 1, generation: 1 }),
    airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
    write: async (input, valid) => {
      if (input.throttle > 0 || input.brake < 1) {
        connected = false;
        assert.throws(valid, /Control connection lost/, 'the write guard must reread owner liveness and explain the interruption');
        valid();
      }
      assert.ok(valid(), 'stopping remains allowed after losing the owner');
      inputs.push(input);
    } });
  try {
    await session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'test', profileRevision: 1 }, {}, () => connected);
    assert.deepEqual(inputs, [STOP_INPUT]);
    assert.notEqual(session.state().status, 'taxiing');
  } finally { await session.dispose(); }
});

test('diagram scene clips pavement around the route, builds runway slabs once per pair, and follows the aircraft', async () => {
  const g = graph();
  g.points.push({ id: 9, x: 5000, z: 5000, type: 1, orientation: 0 }, { id: 10, x: 5100, z: 5000, type: 1, orientation: 0 });
  g.paths.push({ id: 9, start: 9, end: 10, type: 4, runway: null, widthM: 23 }, { id: 10, start: 0, end: 1, type: 6, runway: null, widthM: 8 });
  const origin = { lat: 0, lon: 0 };
  const runways = [{ id: '09', reciprocal: '27', threshold: origin, headingDeg: 90, lengthM: 1000, widthM: 45 },
    { id: '27', reciprocal: '09', threshold: { lat: 0, lon: 1000 / 6371000 * 180 / Math.PI }, headingDeg: 270, lengthM: 1000, widthM: 45 }];
  const scene = buildTaxiScene(g, plan(g), origin, runways);
  assert.equal(scene.links.length, 4, 'distant pavement and vehicle links are excluded');
  assert.equal(scene.runways.length, 1);
  assert.equal(scene.runways[0].corners.length, 4);
  assert.ok(Math.abs(scene.runways[0].corners[1].x - 1000) < 1 && Math.abs(Math.abs(scene.runways[0].corners[1].z) - 22.5) < 1);
  const now = 1000;
  const sample = (): TaxiObservation => ({ x: 0, z: 0, lat: 10 / 6371000 * 180 / Math.PI, lon: 0, headingDeg: 0, speedKts: 0, timeMs: now, ready: true,
    profileKey: 'p', profileRevision: 1, generation: 1 });
  const session = createTaxiSession({ now: () => now, capture: sample,
    airport: async () => ({ origin, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27', runways }),
    write: async () => {} });
  const client = {};
  try {
    const before = await session.request({ operation: 'status' }, client);
    assert.equal(before.aircraft, null); assert.equal(before.sceneKey, null); assert.equal(before.route, null);
    const preview = await session.request({ operation: 'preview', icao: 'TEST', runway: '09', profileKey: 'p', profileRevision: 1 }, client);
    assert.ok(preview.scene && preview.scene.runways.length === 1 && preview.sceneKey === preview.scene.key);
    assert.ok(Math.abs(preview.aircraft.z - 10) < 0.01 && preview.aircraft.headingDeg === 0, 'preview places the aircraft on the diagram');
    const status = await session.request({ operation: 'status' }, client);
    assert.equal(status.scene, undefined, 'scene is only sent when asked for');
    assert.equal(status.sceneKey, preview.sceneKey);
    assert.ok((await session.request({ operation: 'status', scene: true }, client)).scene);
    const started = await session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'p', profileRevision: 1 }, client);
    assert.equal(started.route.points.length, 3); assert.deepEqual(started.route.holdShort, { x: 0, z: 200 });
    assert.ok(started.scene);
    await session.request({ operation: 'release' }, client);
    const released = await session.request({ operation: 'status', scene: true }, client);
    assert.equal(released.sceneKey, null); assert.equal(released.route, null); assert.equal(released.aircraft, null);
  } finally { await session.dispose(); }
});

for (const injectLogOptions of [false, true]) test(`YMML-coordinate dry run and PMDG session never enable diagnostic logging (${injectLogOptions ? 'obsolete log options injected' : 'normal app'})`, async (t) => {
  let now = 10000;
  const origin = { lat: -37.67, lon: 144.84 }; // Coordinate projection test, not a captured YMML scenery graph.
  const d: Record<string, any> = { lat: origin.lat + 10 / 6371000 * 180 / Math.PI, lon: origin.lon, heading: 0, gs: 0,
    wow: 1, paused: 0, slewActive: 0, parkingBrake: 0, engineCount: 2, engineType: 1, eng1Combustion: 1, eng2Combustion: 1, thr1: 0, thr2: 0, athrArmed: 0, athrActive: 0 };
  const events: [string, number][] = [];
  const sdk = { adapterId: 'clientdata-manifest', target: { channel: 'pmdg-737-ng3-clientdata' }, updatedAt: new Date(now).toISOString(),
    normalized: { automation: { athr: { armed: false, active: false } } } };
  const provider = { _connected: true, _systemState: { sim: 1 }, _autotaxiConnectionEpoch: 1, _lastDetectedAircraftTitle: 'C:/fixtures/aircraft.cfg',
    _data: { ...d }, // Deliberately retained display values must not satisfy missing source data.
    _rustSimvarBridge: { getSnapshot: () => ({ status: 'running', values: d,
      valueUpdatedAt: Object.fromEntries(Object.keys(d).map(k => [k, new Date(now).toISOString()])) }) },
    _sdkBridge: { isDataConnected: () => true, getSnapshot: () => sdk },
    _msfsFacilitiesGeometryProvider: { probeAirport: async (icao: string) => { assert.equal(icao, 'YMML'); return { ok: true }; },
      getTaxiAirport: () => ({ origin, graph: graph(), threshold: { lat: origin.lat + 260 / 6371000 * 180 / Math.PI, lon: origin.lon }, reciprocal: '27' }) },
    _lvarBridge: { sendEvent: async (name: string, value: number) => { events.push([name, value]); return { ok: true }; } },
  };
  const profileKey = 'bundled/msfs/pmdg-737';
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-autotaxi-log-'));
  // Redirect any accidental default recorder to this fixture directory, never
  // the user's Documents folder. No runtime path may create one at all.
  const recorderModule = require('./recorder.js') as typeof import('./recorder.js');
  const makeRecorder = recorderModule.createTaxiRecorder;
  const recorderSpy = t.mock.method(recorderModule, 'createTaxiRecorder', (options) => makeRecorder({ ...options, dir: () => logDir }));
  // Exercise untyped callers too: the retired fourth argument must not enable
  // logging even if supplied directly, rather than through a client request.
  const s = (createPmdgAutotaxi as any)(provider, { getActiveProfileId: () => profileKey, getActiveProfileRevision: () => 1 }, () => now,
    { ...(injectLogOptions ? { logDir: () => logDir } : {}), resolveModel: resolveTestAircraft }) as ReturnType<typeof createPmdgAutotaxi>;
  const owner = {};
  const request = { operation: 'preview', icao: 'YMML', runway: '09', profileKey, profileRevision: 1 };
  try {
    const result = await s.request(request, owner);
    assert('preview' in result && Math.abs(result.preview.lengthM - 160) < 0.01);
    assert.equal(result.active, false); assert.equal(result.status, 'idle'); assert.equal(events.length, 0);
    d.gs = null; assert.equal(s.state().canStart, false); d.gs = 0;
    sdk.target.channel = 'pmdg-777x-clientdata'; assert.equal(s.state().canStart, false); sdk.target.channel = 'pmdg-737-ng3-clientdata';
    sdk.updatedAt = new Date(now - 2000).toISOString(); assert.equal(s.state().canStart, false, 'a regressed SDK timestamp is rejected'); sdk.updatedAt = new Date(now).toISOString();
    sdk.normalized.automation.athr.active = true; assert.equal(s.state().canStart, false); sdk.normalized.automation.athr.active = false;
    await s.request({ ...request, operation: 'start' }, owner);
    assert.equal(events.length, 5);
    // The first session probes the steering direction: a small demand, slewed from zero, towards the route side.
    assert.deepEqual(events.slice(0, 2), [['AXIS_LEFT_BRAKE_SET', -16383], ['AXIS_RIGHT_BRAKE_SET', -16383]]);
    assert.equal(events[2][0], 'AXIS_STEERING_SET');
    assert(events[2][1] > 0 && events[2][1] <= 0.25 * 16384, String(events[2][1]));
    assert.equal(events[3][0], 'THROTTLE1_SET'); assert(events[3][1] > 0 && events[3][1] < 100);
    // Same bridge object, new connection: no axes may be written into the new flight.
    provider._autotaxiConnectionEpoch++; now += 250;
    await s.tick(); assert.equal(s.state().status, 'fault'); assert.equal(events.length, 5);
    await s.request({ operation: 'release' }, owner); assert.equal(events.length, 5);
    const files = fs.readdirSync(logDir);
    assert.equal(recorderSpy.mock.callCount(), 0, 'app sessions cannot instantiate a diagnostic recorder, even with obsolete options');
    assert.deepEqual(files, [], 'preview, start, motion, fault and release must not write session logs');
  } finally { await s.dispose(); fs.rmSync(logDir, { recursive: true, force: true }); }
});

test('session log records the plan, every tick with controller internals and the written input, and the outcome', async () => {
  let now = 1000;
  let speed = 0;
  let z = 10;
  const x = 0, heading = 0;
  const profileKey = 'bundled/msfs/pmdg-737';
  const rows: TaxiRecord[] = [];
  let parked = false;
  const sample = (): TaxiObservation => ({ x: 0, z: 0, lat: z / 6371000 * 180 / Math.PI, lon: x / 6371000 * 180 / Math.PI,
    headingDeg: heading, speedKts: speed, timeMs: now, ready: true, profileKey, profileRevision: 1, generation: 1, sim: { thr1: 0, parkingBrake: parked } });
  let writes = 0, sinkCalls = 0;
  const session = createTaxiSession({ now: () => now, capture: sample,
    airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
    write: async () => { writes++; if (writes === 3) throw new Error('boom'); now += 5; },
    park: async () => { parked = true; }, parked: () => parked,
    record: row => { if (++sinkCalls === 2) throw new Error('sink failure is ignored'); rows.push(JSON.parse(JSON.stringify(row))); } });
  const owner = {};
  try {
    await session.request({ operation: 'preview', icao: 'TEST', runway: '09', profileKey, profileRevision: 1 }, owner);
    assert.equal(rows.length, 0, 'a preview is not a session');
    await session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey, profileRevision: 1 }, owner);
    const start = rows[0] as any;
    assert.equal(start.type, 'autotaxi_session_start');
    assert.deepEqual([start.icao, start.runway, start.parking, start.profileKey, start.steeringSign], ['TEST', '09', null, profileKey, null]);
    assert.deepEqual(start.start, { lat: sample().lat, lon: 0, headingDeg: 0, speedKts: 0 });
    assert.equal(start.route.lengthM, 160); assert.deepEqual(start.route.holdShort, { x: 0, z: 200 });
    assert.deepEqual(start.airport.threshold, { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 });
    assert.equal(start.scene.links.length, 4);
    // The second row (the transition into taxiing) is lost to the throwing sink; control carries on.
    const first = rows[1] as any;
    assert.equal(first.type, 'autotaxi_tick'); assert.equal(first.status, 'taxiing');
    assert.deepEqual(Object.keys(first.sample).sort(), ['headingDeg', 'lat', 'lon', 'ready', 'sim', 'speedKts', 'timeMs', 'x', 'z']);
    assert.deepEqual(first.sample.sim, { thr1: 0, parkingBrake: false });
    assert.equal(first.trace.segment, 0); assert.equal(first.trace.remainingM, 160); assert.equal(first.trace.crossTrackM, 0);
    assert.equal(first.trace.headingErrorDeg, 0); assert.equal(first.trace.limitM, 6); assert.equal(first.trace.targetKts, 2);
    assert.equal(first.trace.probe.direction, 1); assert.equal(first.trace.steeringSign, null);
    assert.equal(first.input.brake, 0); assert(first.input.throttle > 0); assert.equal(first.writeMs, 5); assert.equal(first.writeError, null);
    assert.equal(first.heartbeatAgeMs, 0);
    // A failed write is on the tick row and the fault transition follows it.
    speed = 1; z += 0.5; now += 250; await session.tick();
    now += 250; await session.tick();
    const failed = rows.find((row: any) => row.type === 'autotaxi_tick' && row.writeError) as any;
    assert.equal(failed.writeError, 'boom');
    const fault = rows.find((row: any) => row.type === 'autotaxi_transition' && row.to === 'fault') as any;
    assert.equal(fault.from, 'taxiing'); assert.match(fault.reason, /Control write failed/);
    await session.request({ operation: 'release' }, owner);
    const end = rows.at(-1) as any;
    assert.equal(end.type, 'autotaxi_session_end'); assert.equal(end.status, 'fault'); assert.equal(end.error, 'boom'); assert.equal(end.ticks, 3);
    assert.equal(rows.filter((row: any) => row.type === 'autotaxi_session_end').length, 1);
    assert(rows.every((row: any) => Number.isFinite(row.timeMs)));
  } finally { await session.dispose(); }
  // A stopped session logs the handover and its outcome.
  rows.length = 0; writes = 0; speed = 0; parked = false;
  const stopping = createTaxiSession({ now: () => now, capture: sample,
    airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
    write: async () => {}, park: async () => { parked = true; }, parked: () => parked, record: row => rows.push(row) });
  try {
    await stopping.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey, profileRevision: 1 }, owner);
    await stopping.request({ operation: 'stop' }, owner);
    now += 1200; await stopping.tick();
    assert.deepEqual(rows.filter(row => row.type !== 'autotaxi_tick').map((row: any) => [row.type, row.to ?? row.ok]),
      [['autotaxi_session_start', undefined], ['autotaxi_transition', 'taxiing'], ['autotaxi_transition', 'stopping'], ['autotaxi_transition', 'stopped'], ['autotaxi_handover', true]]);
    await stopping.dispose();
    assert.equal((rows.at(-1) as any).type, 'autotaxi_session_end');
    await stopping.dispose();
    assert.equal(rows.filter(row => row.type === 'autotaxi_session_end').length, 1, 'dispose after the end adds nothing');
  } finally { await stopping.dispose(); }
});

test('recorder writes one file per session, keeps every row on disk as it arrives, and survives a bad directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-autotaxi-rec-'));
  const warnings: string[] = [];
  try {
    const recorder = createTaxiRecorder({ dir: () => path.join(dir, 'nested', 'Autotaxi Logs'), log: message => warnings.push(message) });
    assert.equal(recorder.currentFile(), null);
    recorder.record({ type: 'autotaxi_tick' } as any);
    assert.equal(fs.existsSync(path.join(dir, 'nested')), false, 'rows outside a session are dropped');
    const start = { type: 'autotaxi_session_start', timeMs: Date.UTC(2026, 8, 19, 10, 30, 15, 250), icao: 'YSSY', runway: null, parking: 'Gate D/12' } as any;
    recorder.record(start);
    const file = recorder.currentFile()!;
    assert.equal(path.basename(file), '2026-09-19T10-30-15-250-YSSY-stand-Gate-D-12.jsonl');
    recorder.record({ type: 'autotaxi_tick', timeMs: start.timeMs + 250 } as any);
    const lines = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines().map(row => row.type), ['autotaxi_manifest', 'autotaxi_session_start', 'autotaxi_tick']);
    // Same row conventions as the flight-bundle sidecars: seq from 1, timeMs plus timestampIso, schema version on the manifest.
    assert.deepEqual(lines().map(row => row.seq), [1, 2, 3]);
    assert.equal(lines()[0].schemaVersion, 1); assert.match(lines()[0].sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual([lines()[0].icao, lines()[0].parking, lines()[0].runway], ['YSSY', 'Gate D/12', null]);
    assert.equal(lines()[2].timestampIso, '2026-09-19T10:30:15.500Z');
    recorder.record({ type: 'autotaxi_session_end', timeMs: start.timeMs + 500 } as any);
    assert.equal(recorder.currentFile(), null);
    assert.equal(lines().length, 4);
    recorder.record({ type: 'autotaxi_session_start', timeMs: start.timeMs + 60000, icao: 'YSSY', runway: '16R', parking: null } as any);
    assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
    assert.match(path.basename(recorder.currentFile()!), /-YSSY-rwy-16R\.jsonl$/);
    // A directory that cannot be created disables logging for the session with one warning, and never throws.
    fs.writeFileSync(path.join(dir, 'file'), '');
    const broken = createTaxiRecorder({ dir: () => path.join(dir, 'file', 'sub'), log: message => warnings.push(message) });
    broken.record({ ...start });
    broken.record({ type: 'autotaxi_tick', timeMs: start.timeMs + 250 } as any);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /session log write failed/);
    // A per-file cap ends the session's log with one warning; the next session logs again.
    const capped = createTaxiRecorder({ dir: () => path.join(dir, 'capped'), log: message => warnings.push(message), maxFileBytes: 900 });
    capped.record({ ...start });
    for (let i = 0; i < 10; i++) capped.record({ type: 'autotaxi_tick', timeMs: start.timeMs + i * 250, filler: 'x'.repeat(50) } as any);
    const cappedLines = fs.readFileSync(capped.currentFile()!, 'utf8').trim().split('\n');
    assert(cappedLines.length >= 3 && cappedLines.length < 12, String(cappedLines.length));
    assert.equal(warnings.length, 2); assert.match(warnings[1], /reached 0 MB/);
    capped.record({ ...start, timeMs: start.timeMs + 60000, parking: 'A1' });
    capped.record({ type: 'autotaxi_tick', timeMs: start.timeMs + 60250 } as any);
    assert.equal(fs.readFileSync(capped.currentFile()!, 'utf8').trim().split('\n').length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stop interrupts a partially acknowledged motion batch and prevents late positive thrust', async () => {
  let unblock!: () => void;
  let first = true;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const events: [string, number][] = [];
  const sample = { x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
    headingDeg: 0, speedKts: 0, timeMs: 1000, ready: true, profileKey: 'test', profileRevision: 1, generation: 1 };
  const session = createTaxiSession({ now: () => 1000, capture: () => sample,
    airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
    write: (input, valid) => writeTaxiAxes(input, async (name, value) => {
      events.push([name, value]); if (first) { first = false; await gate; } return { ok: true };
    }, valid),
  });
  const owner = {};
  try {
    const start = session.request({ operation: 'start', icao: 'YMML', runway: '09', profileKey: 'test', profileRevision: 1 }, owner);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(events.length, 1);
    const stop = session.request({ operation: 'stop' }, owner);
    unblock(); await Promise.all([start, stop]);
    assert(!events.some(([name, value]) => name.startsWith('THROTTLE') && value > 0));
    assert(events.some(([name, value]) => name === 'AXIS_LEFT_BRAKE_SET' && value === 16383));
    assert(events.some(([name, value]) => name === 'AXIS_RIGHT_BRAKE_SET' && value === 16383));
    // The cancelled motion write is the stop's doing, not a control failure:
    // the session stays on course to hand the aircraft back rather than faulting.
    assert.equal(session.state().status, 'stopped');
    assert.equal(session.state().error, null);
  } finally { unblock(); await session.dispose(); }
});

test('sessions reject missing handling and use the selected start-speed limit', async () => {
  let handling: TaxiHandling | null = null;
  let speedKts = 5;
  let loads = 0;
  const sample = (): TaxiObservation => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
    headingDeg: 0, speedKts, timeMs: 1000, ready: true, profileKey: 'generic', profileRevision: 3, generation: 1 });
  const session = createTaxiSession({ now: () => 1000, capture: sample, handling: () => handling,
    airport: async () => { loads++; return { origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }; },
    write: async () => { throw new Error('Read-only test must never write.'); } });
  const request = { operation: 'preview', icao: 'TEST', runway: '09', profileKey: 'generic', profileRevision: 3 };
  try {
    assert.equal(session.state().canStart, false);
    assert.equal(session.state().handling, null);
    assert.equal(session.state().currentProfileKey, 'generic');
    assert.equal(session.state().currentProfileRevision, 3);
    await assert.rejects(session.request(request, {}), /not configured/);
    await assert.rejects(session.request({ ...request, operation: 'start' }, {}), /not configured/);
    assert.equal(loads, 0);
    handling = { ...DEFAULT_TAXI_HANDLING, id: 'small', label: 'Small aircraft', maxStartKts: 4 };
    assert.equal(session.state().canStart, false);
    await assert.rejects(session.request(request, {}), /Slow below 4 kt/);
    speedKts = 3;
    const preview: any = await session.request(request, {});
    assert.equal(preview.canStart, true);
    assert.deepEqual(preview.handling, { id: 'small', label: 'Small aircraft' });
  } finally { await session.dispose(); }
});

test('changing aircraft handling while airport data loads cancels the plan without writes', async () => {
  let handling = { ...DEFAULT_TAXI_HANDLING };
  let finish!: (value: TaxiAirport) => void;
  let writes = 0;
  const sample: TaxiObservation = { x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
    headingDeg: 0, speedKts: 0, timeMs: 1000, ready: true, profileKey: 'generic', profileRevision: 1, generation: 1 };
  const session = createTaxiSession({ now: () => 1000, capture: () => sample, handling: () => handling,
    airport: () => new Promise(resolve => { finish = resolve; }), write: async () => { writes++; } });
  try {
    const start = session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'generic', profileRevision: 1 }, {});
    const rejected = assert.rejects(start, /handling configuration changed/);
    handling = { ...handling, wheelbaseM: 20 };
    finish({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' });
    await rejected;
    assert.equal(writes, 0);
    assert.equal(session.state().status, 'idle');
  } finally { await session.dispose(); }
});

test('learnt steering persists only for the same aircraft, connection and complete handling configuration', async () => {
  for (const change of ['none', 'handling', 'aircraft', 'profile']) {
    let now = 1000, heading = 0, speedKts = 0, generation = 1, profileRevision = 1;
    let handling = { ...DEFAULT_TAXI_HANDLING };
    const sample = (): TaxiObservation => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
      headingDeg: heading, speedKts, timeMs: now, ready: true, profileKey: 'generic', profileRevision, generation });
    let writes = 0;
    const session = createTaxiSession({ now: () => now, capture: sample, handling: () => handling,
      airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
      write: async (_input, valid) => { assert(valid()); writes++; } });
    const request = () => ({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'generic', profileRevision });
    const owner = {};
    try {
      await session.request(request(), owner);
      speedKts = 1; heading = -3; now += 250; await session.tick();
      assert.equal(session.state().probing, false);
      assert.equal(session.state().steeringReversed, true);
      if (change === 'handling') handling = { ...handling, maxThrottle: 0.17 };
      if (change === 'aircraft') generation++;
      if (change === 'profile') profileRevision++;
      if (change !== 'none') {
        const before = writes;
        now += 250; await session.tick();
        assert.equal(session.state().status, 'fault', change);
        assert.equal(session.state().steeringReversed, false, change);
        assert.equal(session.state().route, null, 'old route cannot be shown against the new aircraft');
        assert.equal(writes, before, 'no old-aircraft controls may reach the new configuration');
      }
      await session.request({ operation: 'release' }, owner);
      heading = 0; speedKts = 0; now += 250;
      await session.request(request(), owner);
      assert.equal(session.state().probing, change !== 'none', change);
      assert.equal(session.state().steeringReversed, change === 'none', change);
    } finally { await session.dispose(); }
  }
});

test('handover needs fresh parking-brake confirmation and never reads or writes across an aircraft change', async () => {
  for (const outcome of ['confirmed', 'missing', 'released', 'throwing', 'legacy-omitted', 'changed-aircraft']) {
    let now = 1000, generation = 1, parkedReads = 0;
    let parked: boolean | null = true;
    const inputs: TaxiInput[] = [];
    const sample = (): TaxiObservation => ({ x: 0, z: 10, lat: 10 / 6371000 * 180 / Math.PI, lon: 0,
      headingDeg: 0, speedKts: 0, timeMs: now, ready: true, profileKey: 'generic', profileRevision: 1, generation });
    const session = createTaxiSession({ now: () => now, capture: sample,
      airport: async () => ({ origin: { lat: 0, lon: 0 }, graph: graph(), threshold: { lat: 260 / 6371000 * 180 / Math.PI, lon: 0 }, reciprocal: '27' }),
      write: async (input, valid) => { assert(valid()); inputs.push(input); }, park: async valid => { assert(valid()); },
      ...(outcome === 'legacy-omitted' ? {} : { parked: () => { parkedReads++; if (outcome === 'throwing') throw new Error('readback gone'); return parked; } }) });
    const owner = {};
    try {
      await session.request({ operation: 'start', icao: 'TEST', runway: '09', profileKey: 'generic', profileRevision: 1 }, owner);
      await session.request({ operation: 'stop' }, owner);
      now += 1100; await session.tick();
      assert.equal(session.state().handedOver, true);
      assert.deepEqual(inputs.at(-1), { throttle: 0, brake: 0, steering: 0 });
      if (outcome === 'missing') parked = null;
      if (outcome === 'released') parked = false;
      if (outcome === 'changed-aircraft') generation++;
      const before = inputs.length;
      now += 1600; await session.tick();
      if (outcome === 'confirmed' || outcome === 'legacy-omitted') {
        assert.equal(session.state().handedOver, true, outcome);
        assert.equal(inputs.length, before, outcome);
      } else if (outcome === 'changed-aircraft') {
        assert.equal(session.state().handedOver, false);
        assert.equal(session.state().status, 'fault');
        assert.equal(parkedReads, 0, 'the new aircraft must not supply confirmation for the old handover');
        assert.equal(inputs.length, before, 'the new aircraft must never receive old-session braking');
      } else {
        assert.equal(session.state().handedOver, false, outcome);
        assert.deepEqual(inputs.at(-1), STOP_INPUT, outcome);
        assert.match(session.state().error || '', outcome === 'released' ? /parking brake released/ : /readback is unavailable/);
      }
    } finally { await session.dispose(); }
  }
});
