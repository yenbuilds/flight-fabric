import { angle, bearing, distance, project, type Point, type TaxiRoute } from './route.js';
import { DEFAULT_TAXI_HANDLING, validateTaxiHandling, type TaxiHandling } from './handling.js';

export type TaxiSample = Point & { timeMs: number; headingDeg: number; speedKts: number; ready: boolean; reason?: string };
export type TaxiInput = { throttle: number; brake: number; steering: number };
export type TaxiStatus = 'taxiing' | 'stopping' | 'holding' | 'stopped' | 'fault';
/** steeringSign: +1 when positive AXIS_STEERING_SET turns right as documented, -1 when reversed, null/absent when unknown. */
export type TaxiControllerOptions = { steeringSign?: 1 | -1 | null; handling?: TaxiHandling };
/** The internals of one update, for the session log. Fields stay null on the paths that never compute them. */
export type TaxiTrace = {
  dtS: number; sampleAgeMs: number; movedM: number; turnedDeg: number; segment: number; remainingM: number;
  crossTrackM: number | null; limitM: number | null; headingErrorDeg: number | null; target: Point | null;
  demand: number | null; steering: number; targetKts: number | null; excessKts: number | null; throttle: number;
  accelerationKtsS: number; brake: number;
  probe: { yaw: number; travelledM: number; direction: 1 | -1 | null } | null; steeringSign: 1 | -1 | null; evidence: number;
};
export const STOP_INPUT: TaxiInput = Object.freeze({ throttle: 0, brake: 1, steering: 0 });
const PROBE_DEMAND = 0.25;
const PROBE_DEMAND_MAX = 0.4;
// Off the centreline on a scenery link is a fault at 5 m. The first 20 m from
// rest get 6 m: while the probe still holds a fixed tiller the aircraft drifts
// along its initial heading and then swings back, and the planner's own
// connector across an apron is not a painted line. The planner limits the
// first turn to 30°, which the lagged vehicle models keep under 6 m; the
// aircraft is at 2 kt throughout.
const DEVIATION_M = 5;
const START_DEVIATION_M = 6;
const START_M = 20;
const PROBE_YAW_DEG = 2;
const PROBE_TRAVEL_M = 12;
const KTS_TO_MS = 0.514444;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Isolated, deterministic low-speed controller. No simulator or network I/O. */
export function createTaxiController(route: TaxiRoute, options: TaxiControllerOptions = {}) {
  const handling = validateTaxiHandling(options.handling ?? DEFAULT_TAXI_HANDLING);
  const { cruiseKts, turnKts, maxThrottle, maxSteeringDeg, steeringLimitDeg, wheelbaseM } = handling;
  let status: TaxiStatus = 'taxiing';
  let reason = 'Taxiing to ' + route.label + '.';
  let segment = 0;
  let previous: TaxiSample | null = null;
  let throttle = 0;
  let cruiseThrottle = 0;
  let acceleration = 0;
  let brake = 0;
  let rollingBrake = 0;
  let brakingFromRollingStart: boolean | null = null;
  let steering = 0;
  let remainingM = route.lengthM;
  let restSince: number | null = null;
  let settled = false;
  let lastProgressAt: number | null = null;
  let lastProgressRemaining = remainingM;
  // The SDK documents positive AXIS_STEERING_SET as right, but the installed
  // PMDG steering mode decides what the aircraft actually does. Until a session
  // has learned the direction, the first metres are a probe: creep with a small
  // fixed tiller demand until 2 degrees of yaw show which way the axis works,
  // or fault when 12 m of travel shows no response at all.
  let steeringSign: 1 | -1 | null = options.steeringSign ?? null;
  let probe: { yaw: number; travelledM: number; direction: 1 | -1 | null } | null = steeringSign ? null : { yaw: 0, travelledM: 0, direction: null };
  // Once learned, a sustained turn against the intended direction means
  // something else is steering; stop and forget the learned direction.
  let intended = 0;
  let evidence = 0;
  let trace: TaxiTrace | null = null;
  // A stop after the aircraft has already stopped, held or faulted keeps that state and its reason.
  function stop(message = 'Stop requested') { if (status === 'taxiing') { status = 'stopping'; reason = message; } }
  function resetRest() { restSince = null; settled = false; }
  function fault(message: string) { if (status !== 'fault') { status = 'fault'; reason = message; } resetRest(); }
  function rest(sample: TaxiSample): boolean {
    // Repeated reads of a cached sample cannot prove a stationary interval.
    if (sample.speedKts < 0.2) { restSince ??= sample.timeMs; settled = sample.timeMs - restSince >= 1000; }
    else resetRest();
    return settled;
  }
  function update(sample: TaxiSample, now: number): TaxiInput {
    const dt = previous ? (sample.timeMs - previous.timeMs) / 1000 : 0.25;
    const moved = previous ? distance(previous, sample) : 0;
    const turned = previous ? angle(sample.headingDeg - previous.headingDeg) : 0;
    // Create a fresh trace even for a rejected sample; never log the preceding
    // successful tick as the explanation for a timing/telemetry fault.
    const t: TaxiTrace = trace = { dtS: dt, sampleAgeMs: now - sample.timeMs, movedM: moved, turnedDeg: turned, segment, remainingM,
      crossTrackM: null, limitM: null, headingErrorDeg: null, target: null, demand: null, steering,
      targetKts: null, excessKts: null, throttle: 0, brake: 1, accelerationKtsS: acceleration,
      probe: probe ? { ...probe } : null, steeringSign, evidence };
    const valid = sample.ready && [sample.timeMs, sample.x, sample.z, sample.headingDeg, sample.speedKts, now].every(Number.isFinite)
      && sample.speedKts >= 0 && now - sample.timeMs >= 0 && now - sample.timeMs <= 1000;
    if (!valid) { fault(sample.reason || 'Telemetry unavailable or stale. Take control.'); return STOP_INPUT; }
    if (sample.speedKts > handling.maxSpeedKts) { fault(`Taxi speed exceeded ${handling.maxSpeedKts} kt. Take control.`); return STOP_INPUT; }
    if (status !== 'taxiing') {
      // A latched fault still observes fresh speed for the parking-brake
      // handover. Rechecking the original gap forever would prevent settling.
      if (dt < 0) { resetRest(); return STOP_INPUT; }
      if (dt > 1.5) resetRest();
      previous = { ...sample };
      if (sample.speedKts < 0.2 && status === 'stopping') status = 'stopped';
      rest(sample);
      return STOP_INPUT;
    }
    if (previous && (dt < 0 || dt > 1.5)) {
      fault(`Telemetry/control update gap ${dt.toFixed(2)} s (limit 1.50 s; sample age ${Math.round(now - sample.timeMs)} ms). Take control.`); return STOP_INPUT;
    }
    if (previous && moved > Math.max(4, dt * 12)) {
      fault(`Position jumped ${moved.toFixed(1)} m in ${dt.toFixed(2)} s. Take control.`); return STOP_INPUT;
    }
    if (previous && dt > 0) {
      const measured = clamp((sample.speedKts - previous.speedKts) / dt, -4, 4);
      acceleration += (measured - acceleration) * dt / (1 + dt);
    }
    t.accelerationKtsS = acceleration;
    previous = { ...sample };
    if (steeringSign && sample.speedKts >= 1 && Math.abs(intended) >= 0.15) {
      evidence = Math.min(8, evidence + Math.max(-5, Math.min(5, turned)) * Math.sign(intended));
      t.evidence = evidence;
      if (evidence <= -8) { steeringSign = null; t.steeringSign = null; fault('Steering response contradicts the learned direction. Take control.'); return STOP_INPUT; }
    }
    const points = route.points;
    let projection = project(sample, points[segment], points[segment + 1]);
    // Advance in metres, not a percentage of an arbitrarily long scenery link.
    // Walk consecutive short links in one tick; never jump to a distant crossing.
    while (segment < points.length - 2) {
      const next = project(sample, points[segment + 1], points[segment + 2]);
      const toCorner = distance(projection.point, points[segment + 1]);
      if (!(projection.t >= 1 || (toCorner < 12 && next.distance < projection.distance))) break;
      if (next.distance > 5) break;
      segment++; projection = next;
    }
    remainingM = distance(projection.point, points[segment + 1]);
    for (let i = segment + 1; i < points.length - 1; i++) remainingM += distance(points[i], points[i + 1]);
    const starting = route.lengthM - remainingM < START_M || (segment === 0 && route.joinM > 0);
    const limitM = starting ? START_DEVIATION_M : DEVIATION_M;
    t.segment = segment; t.remainingM = remainingM; t.crossTrackM = projection.distance; t.limitM = limitM;
    if (projection.distance > limitM) { fault(`More than ${limitM} m from the planned ${route.joinM > 0 && segment === 0 ? 'line to the taxiway' : 'centreline'}. Take control.`); return STOP_INPUT; }
    if (remainingM < 1.5) {
      if (rest(sample)) { status = 'holding'; reason = route.kind === 'stand' ? `Parked at ${route.label}.` : `Holding short of runway ${route.runway}.`; }
      return STOP_INPUT;
    }
    lastProgressAt ??= now;
    if (lastProgressRemaining - remainingM > 2) { lastProgressAt = now; lastProgressRemaining = remainingM; }
    if (now - lastProgressAt > 45000) { fault('No taxi progress for 45 seconds. Take control.'); return STOP_INPUT; }
    let lookahead = 10;
    let target: Point = points[segment + 1];
    let from = projection.point;
    for (let i = segment + 1; i < points.length; i++) {
      const length = distance(from, points[i]);
      if (length >= lookahead) { target = { x: from.x + (points[i].x - from.x) * lookahead / length, z: from.z + (points[i].z - from.z) * lookahead / length }; break; }
      lookahead -= length; target = points[i]; from = points[i];
    }
    const error = angle(bearing(sample, target) - sample.headingDeg);
    t.headingErrorDeg = error; t.target = target;
    if (Math.abs(error) > 100) { fault('Route is behind the aircraft. Take control.'); return STOP_INPUT; }
    const wheelAngle = Math.atan2(2 * wheelbaseM * Math.sin(error * Math.PI / 180), Math.max(3, distance(sample, target)));
    let demand = clamp(wheelAngle / (maxSteeringDeg * Math.PI / 180), -steeringLimitDeg / maxSteeringDeg, steeringLimitDeg / maxSteeringDeg);
    if (probe) {
      // Only yaw while rolling counts; a nudge at rest is not the axis answering.
      if (sample.speedKts >= 0.5) probe.yaw += turned;
      probe.travelledM += moved;
      if (Math.abs(probe.yaw) >= PROBE_YAW_DEG) {
        // Written raw, so yaw in the written direction means the axis is as documented.
        steeringSign = (probe.yaw > 0 ? 1 : -1) * (probe.direction ?? 1) > 0 ? 1 : -1;
        probe = null;
        t.steeringSign = steeringSign;
      } else if (probe.travelledM > PROBE_TRAVEL_M) {
        fault(`Steering had no effect over ${PROBE_TRAVEL_M} m. Check the aircraft steering-axis configuration and take control.`);
        return STOP_INPUT;
      } else {
        // Probe towards the side the route wants anyway, so a correct axis costs nothing.
        probe.direction ??= demand < 0 ? -1 : 1;
        // At least the probe demand, more when the route wants that side anyway,
        // but capped: on a reversed axis with tiller lag, the wrong-way swing
        // before the flip grows with the demand.
        demand = probe.direction * Math.min(PROBE_DEMAND_MAX, steeringLimitDeg / maxSteeringDeg, Math.max(PROBE_DEMAND, demand * probe.direction));
      }
    }
    t.probe = probe ? { ...probe } : null;
    t.demand = demand;
    steering += Math.max(-dt * 0.8, Math.min(dt * 0.8, demand - steering));
    // A small centreline correction is not a tight bend. Limit speed smoothly
    // with curvature (0.2 m/s² lateral acceleration), retaining the configured
    // low turn speed while discovering the steering direction.
    const curvature = Math.abs(Math.tan(Math.max(Math.abs(demand), Math.abs(steering)) * maxSteeringDeg * Math.PI / 180) / wheelbaseM);
    let targetKts = probe || starting ? turnKts : clamp(Math.sqrt(0.2 / Math.max(curvature, 0.001)) / KTS_TO_MS, turnKts, cruiseKts);
    targetKts = Math.min(targetKts, clamp(cruiseKts - projection.distance * 2, turnKts, cruiseKts));
    if (Math.abs(error) > 60) targetKts = Math.min(targetKts, turnKts);
    // Anticipate corners as well as the final stop. Units: metres, m/s, knots.
    let aheadM = distance(projection.point, points[segment + 1]);
    for (let i = segment + 1; i < points.length - 1 && aheadM < 60; i++) {
      const turn = Math.abs(angle(bearing(points[i], points[i + 1]) - bearing(points[i - 1], points[i])));
      if (turn > 5) {
        const cornerKts = clamp(cruiseKts - turn / 12, turnKts, cruiseKts);
        targetKts = Math.min(targetKts, Math.sqrt((cornerKts * KTS_TO_MS) ** 2 + 2 * 0.2 * Math.max(0, aheadM - 25)) / KTS_TO_MS);
      }
      aheadM += distance(points[i], points[i + 1]);
    }
    targetKts = Math.min(targetKts, Math.sqrt(2 * 0.2 * Math.max(0, remainingM - 1.5)) / KTS_TO_MS, remainingM / 2);
    const excess = sample.speedKts - targetKts;
    // Anticipate engine spool-down and release braking as soon as deceleration
    // will remove the excess. No minimum brake step; routine braking ramps in.
    // A small learned brake trim can balance idle thrust; proportional braking
    // alone otherwise settles above a tight-turn target on a light aircraft.
    rollingBrake = clamp(rollingBrake + (excess > 0 ? excess * 0.008 : -0.05) * dt, 0, 0.12);
    // A rolling start can arrive at 12 kt beside a turn or the final stop.
    // Arrest that initial excess promptly; the gentle cruise ramp alone can
    // spend over four seconds building pressure and miss the stopping point.
    // Once captured, normal speed corrections always use the soft ramp.
    brakingFromRollingStart ??= excess >= 1;
    if (excess < 0.3) brakingFromRollingStart = false;
    const brakeDemand = brakingFromRollingStart ? clamp(0.12 + excess * 0.15, 0, 0.65)
      : excess > 0 ? clamp(rollingBrake + (excess + acceleration * 1.5 - 0.15) * 0.2, 0, 0.35) : 0;
    brake = brakingFromRollingStart ? brakeDemand : brake + clamp(brakeDemand - brake, -dt * 0.8, dt * 0.08);
    if (brake < 0.001) brake = 0;
    const speedError = -excess - acceleration * 3;
    const desiredThrottle = cruiseThrottle + speedError * 0.035;
    // Keep the rolling thrust across small corrections, without winding up at
    // the lever limit. Retain learning through the final approach so a stopped
    // aircraft can overcome resistance outside the 1.5 m arrival radius; the
    // arrival/stop branches above always command idle and full braking.
    if (brake > 0) cruiseThrottle = Math.max(0, cruiseThrottle - dt * 0.02);
    else if (brake === 0 && (desiredThrottle > 0 && desiredThrottle < maxThrottle || speedError < 0)) {
      cruiseThrottle = clamp(cruiseThrottle + speedError * dt * 0.006, 0, Math.min(0.12, maxThrottle));
    }
    if (brake > 0 || excess > 0.2) throttle = 0;
    else throttle += clamp(clamp(desiredThrottle, 0, maxThrottle) - throttle, -dt * 0.12, dt * 0.02);
    intended = probe ? 0 : steering;
    t.steering = steering; t.targetKts = targetKts; t.excessKts = excess; t.throttle = throttle; t.brake = brake;
    return { throttle, brake, steering: probe ? steering : steering * steeringSign! };
  }
  return { update, stop, fault,
    getState: () => ({ status, reason, remainingM, runway: route.runway, settled, steeringSign, probing: !!probe }),
    /** Internals of the most recent update, or null before the first valid sample. */
    trace: () => trace };
}
