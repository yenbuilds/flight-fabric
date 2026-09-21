import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaxiController, type TaxiInput } from './controller.js';
import { distance, type Point, type TaxiRoute } from './route.js';
import { DEFAULT_TAXI_HANDLING, type TaxiHandling } from './handling.js';

// The same sensitivity models used by autotaxi.test.ts, with short first links
// and rolling initial conditions. These do not model PMDG's proprietary physics.
const models = {
  ordinary: { engineLag: 3, steeringLag: 1, brakePower: 2.5, idleAccel: 0.05, gain: 4, cadence: 0.25, angle: 75 },
  weakBrakes: { engineLag: 5, steeringLag: 3, brakePower: 1.5, idleAccel: 0.08, gain: 3, cadence: 0.5, angle: 65 },
  resistance: { engineLag: 5, steeringLag: 1, brakePower: 8, idleAccel: -0.08, gain: 4, cadence: 0.25, angle: 75 },
  slowUpdates: { engineLag: 6, steeringLag: 1, brakePower: 8, idleAccel: 0.05, gain: 4, cadence: 1, angle: 75 },
};

function follow(points: Point[], model: typeof models.ordinary, initialKts: number, learned = true,
  handling: TaxiHandling = DEFAULT_TAXI_HANDLING, geometry = { wheelbaseM: 15.57, referenceM: 3.3 }, axis = 1) {
  const route: TaxiRoute = { points, lengthM: points.reduce((sum, p, i) => sum + (i ? distance(p, points[i - 1]) : 0), 0),
    runway: '09', holdShort: points.at(-1)!, runwayTravelM: 0, joinM: 0, kind: 'hold', label: 'hold short of runway 09' };
  const controller = createTaxiController(route, { handling, ...(learned ? { steeringSign: 1 as const } : {}) });
  let x = 0, z = -geometry.referenceM, speed = initialKts * 0.514444, heading = 0, thrust = 0, steering = 0;
  let input: TaxiInput = { throttle: 0, brake: 0, steering: 0 };
  let movingMinimum = Infinity;
  for (let tick = 0; tick < 8000; tick++) {
    const now = 1000 + tick * 50;
    if (tick % Math.round(model.cadence / 0.05) === 0) {
      input = controller.update({ x: x + geometry.referenceM * Math.sin(heading), z: z + geometry.referenceM * Math.cos(heading),
        timeMs: now, headingDeg: heading * 180 / Math.PI, speedKts: speed / 0.514444, ready: true }, now);
      assert(!(input.throttle > 0 && input.brake > 0), 'never add thrust while braking');
      assert(input.throttle <= handling.maxThrottle, 'never exceed the selected aircraft throttle limit');
    }
    thrust += (input.throttle - thrust) * 0.05 / (model.engineLag + 0.05);
    steering += (input.steering - steering) * 0.05 / (model.steeringLag + 0.05);
    speed = Math.max(0, speed + (thrust * model.gain + model.idleAccel - 0.025 * speed - input.brake * model.brakePower) * 0.05);
    heading += speed / geometry.wheelbaseM * Math.tan(axis * steering * model.angle * Math.PI / 180) * 0.05;
    x += Math.sin(heading) * speed * 0.05;
    z += Math.cos(heading) * speed * 0.05;
    if (now > 31000 && controller.getState().remainingM > 20) movingMinimum = Math.min(movingMinimum, speed / 0.514444);
    if (controller.getState().status !== 'taxiing') break;
  }
  return { state: controller.getState(), position: { x: x + geometry.referenceM * Math.sin(heading), z: z + geometry.referenceM * Math.cos(heading) }, movingMinimum };
}

test('rolling starts at the allowed speed stop before a nearby endpoint', () => {
  for (const [name, model] of Object.entries(models)) {
    const result = follow([{ x: 0, z: 0 }, { x: 0, z: 20 }], model, 12);
    assert.equal(result.state.status, 'holding', `${name}: ${result.state.reason}`);
    assert(result.position.z <= 20, `${name}: overshot by ${result.position.z - 20} m`);
    assert(distance(result.position, { x: 0, z: 20 }) < 1.5, name);
  }
});

test('rolling starts capture turn speed before short initial bends', () => {
  for (const [model, speed, firstLink, learned] of [
    [models.ordinary, 12, 10, true], [models.ordinary, 12, 20, false],
    [models.weakBrakes, 4, 10, true], [models.weakBrakes, 8, 20, false],
    [models.slowUpdates, 12, 10, false],
  ] as const) {
    const result = follow([{ x: 0, z: 0 }, { x: 0, z: firstLink }, { x: 150, z: firstLink }], model, speed, learned);
    assert.equal(result.state.status, 'holding', `${speed} kt, ${firstLink} m, learned ${learned}: ${result.state.reason}`);
    assert(distance(result.position, { x: 150, z: firstLink }) < 2);
    assert(result.movingMinimum > 0.5, 'normal taxi must continue after the initial speed capture');
  }
});

test('a short first bend tracks its target with lagged steering and weaker brakes', () => {
  for (const x of [-150, 150]) {
    const result = follow([{ x: 0, z: 0 }, { x: 0, z: 20 }, { x, z: 20 }], models.weakBrakes, 0, false);
    assert.equal(result.state.status, 'holding', result.state.reason);
    assert(result.movingMinimum > 0.5);
    assert(distance(result.position, { x, z: 20 }) < 2);
  }
});

test('final approach can overcome resistance when starting just outside the arrival radius', () => {
  for (const remainingM of [1.6, 2, 3, 7]) {
    const result = follow([{ x: 0, z: 0 }, { x: 0, z: remainingM }], models.resistance, 0);
    assert.equal(result.state.status, 'holding', `${remainingM} m: ${result.state.reason}`);
    assert(result.position.z > 0, 'must actually progress into the arrival radius');
    assert(distance(result.position, { x: 0, z: remainingM }) < 1.5);
    assert(result.position.z <= remainingM);
  }
});

test('configured short and long wheelbases follow both turns and stop with bounded aircraft-specific thrust', () => {
  // Synthetic sensitivity cases, not claims about any proprietary flight model.
  for (const setup of [
    { id: 'small', wheelbaseM: 3, referenceM: 0.6, angle: 35, throttle: 0.12, engineLag: 0.5, gain: 7 },
    { id: 'narrowbody', wheelbaseM: 12.6, referenceM: 3, angle: 75, throttle: 0.16, engineLag: 3, gain: 4 },
    { id: 'widebody', wheelbaseM: 31, referenceM: 5, angle: 70, throttle: 0.18, engineLag: 5, gain: 4 },
  ]) {
    const handling = { ...DEFAULT_TAXI_HANDLING, id: setup.id, wheelbaseM: setup.wheelbaseM,
      maxSteeringDeg: setup.angle, steeringLimitDeg: Math.min(setup.angle, 65), maxThrottle: setup.throttle };
    for (const direction of [-1, 1]) for (const axis of [-1, 1]) {
      const result = follow([{ x: 0, z: 0 }, { x: 0, z: 80 }, { x: direction * 180, z: 80 }],
        { ...models.ordinary, engineLag: setup.engineLag, gain: setup.gain, angle: setup.angle }, 0, false, handling,
        { wheelbaseM: setup.wheelbaseM, referenceM: setup.referenceM }, axis);
      assert.equal(result.state.status, 'holding', `${setup.id}/${direction}/${axis}: ${result.state.reason}`);
      assert.equal(result.state.steeringSign, axis, `${setup.id}/${direction}/${axis}: axis direction`);
      assert(distance(result.position, { x: direction * 180, z: 80 }) < 1.5, `${setup.id}/${direction}/${axis}`);
      assert(result.movingMinimum > 0.5, `${setup.id}/${direction}/${axis}: no stalled progress`);
    }
  }
});

test('the configured overspeed limit stops even below the legacy jet threshold', () => {
  const points = [{ x: 0, z: 0 }, { x: 0, z: 150 }];
  const route: TaxiRoute = { points, lengthM: 150, runway: '09', holdShort: points[1], runwayTravelM: 0, joinM: 0, kind: 'hold', label: '09' };
  const controller = createTaxiController(route, { handling: { ...DEFAULT_TAXI_HANDLING, cruiseKts: 5, maxStartKts: 6, maxSpeedKts: 8 } });
  const input = controller.update({ x: 0, z: 0, headingDeg: 0, speedKts: 9, timeMs: 1000, ready: true }, 1000);
  assert.equal(controller.getState().status, 'fault');
  assert.match(controller.getState().reason, /exceeded 8 kt/);
  assert.deepEqual(input, { throttle: 0, brake: 1, steering: 0 });
});

test('the steering probe respects an aircraft limit below the usual probing demand', () => {
  const points = [{ x: 0, z: 0 }, { x: 0, z: 150 }];
  const route: TaxiRoute = { points, lengthM: 150, runway: '09', holdShort: points[1], runwayTravelM: 0, joinM: 0, kind: 'hold', label: '09' };
  const controller = createTaxiController(route, { handling: { ...DEFAULT_TAXI_HANDLING, steeringLimitDeg: 10 } });
  for (let i = 0; i < 8; i++) {
    const now = 1000 + i * 250;
    const input = controller.update({ x: 0, z: 0, headingDeg: 0, speedKts: 0, timeMs: now, ready: true }, now);
    assert(Math.abs(input.steering) <= 10 / 75);
    assert.equal(controller.getState().probing, true);
  }
});
