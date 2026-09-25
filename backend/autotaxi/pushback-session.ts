import { angle, bearing, distance, localPosition, normalizeRunway, project } from './route.js';
import { planPushback, type PushbackPlan } from './pushback-route.js';
import type { TaxiAirport, TaxiObservation } from './session.js';
import type { PreparedPushback } from './pushback-preview.js';

export type PushbackCommand = { kind: 'start' | 'stop' } | { kind: 'steer'; headingDeg: number };
export type PushbackDependencies = {
  now: () => number;
  capture: () => TaxiObservation & { parked: boolean | null; tug: { state: number; forwardSpeedFps: number } | null };
  dimensions: () => { wheelbaseM: number; lengthM: number } | null;
  airport: (icao: string, runway: string) => Promise<TaxiAirport>;
  write: (command: PushbackCommand, valid: () => boolean) => Promise<void>;
  conflict: () => boolean;
};

/** One explicit start, one owner heartbeat, no automatic resume. Commands use
 * the simulator tug only: no throttle, parking-brake, slew or position writes. */
export function createPushbackSession(deps: PushbackDependencies) {
  let status = 'idle', reason = '', error: string | null = null, plan: PushbackPlan | null = null, airport: TaxiAirport | null = null;
  let baseline: ReturnType<typeof deps.capture> | null = null, owner: unknown = null, connected = () => false;
  let heartbeat = 0, generation = 0, busy = false, operation: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null, started = 0, progress = 0, lastProgressAt = 0, lastProgress = 0;
  let stoppingAt = 0, complete = false, icao = '', runway = '', sentMotion = false;
  let activationSent = false;
  const active = () => ['planning', 'connecting', 'pushing', 'stopping'].includes(status);
  const fresh = (s: TaxiObservation) => s.guidanceReady === true && Number.isFinite(s.timeMs)
    && s.timeMs <= deps.now() && deps.now() - s.timeMs <= 1000;
  const same = () => {
    const s = deps.capture();
    return !!baseline && s.profileKey === baseline.profileKey && s.profileRevision === baseline.profileRevision && s.generation === baseline.generation;
  };
  function unavailable(s = deps.capture()) {
    if (!fresh(s)) return s.guidanceReason || 'Waiting for fresh aircraft position on the ground.';
    if (deps.conflict()) return 'Stop Autotaxi before pushing back.';
    if (s.parked !== false) return s.parked ? 'Release the parking brake to push back.' : 'Waiting for parking-brake readback.';
    if (!s.tug) return 'Waiting for simulator tug readback.';
    if (s.tug.state !== 3) return 'Stop the current simulator pushback before starting another.';
    if (s.speedKts > 0.5) return 'Stop the aircraft before pushing back.';
    if (!deps.dimensions()) return 'Aircraft dimensions are unavailable for pushback.';
    return null;
  }
  function state() {
    const s = deps.capture(), blocked = unavailable(s);
    return { type: 'pushbackState', status, active: active(), reason, error,
      canStart: !active() && !blocked, unavailableReason: blocked, currentProfileKey: s.profileKey, currentProfileRevision: s.profileRevision,
      icao, runway, headingDeg: plan?.headingDeg ?? null, remainingM: plan ? Math.max(0, plan.lengthM - progress) : null };
  }
  function finish(next: string, text: string) {
    status = next; reason = text; sentMotion = false; owner = null; connected = () => false;
    if (timer) clearInterval(timer); timer = null;
  }
  async function stop(text: string, arrived = false) {
    generation++; complete = arrived;
    if (!sentMotion) { finish('stopped', text); return; }
    reason = text; status = 'stopping'; stoppingAt = deps.now();
    try {
      if (!same()) { finish('stopped', 'Aircraft changed. Pushback was not resumed.'); return; }
      await deps.write({ kind: 'stop' }, same);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      finish('fault', 'Could not confirm pushback stopped. Use the simulator pushback control.');
    }
  }
  async function tick() {
    if (busy || !active() || status === 'planning') return;
    busy = true;
    operation = (async () => {
      const s = deps.capture();
      if (!same()) { finish('stopped', 'Aircraft changed. Pushback was not resumed.'); return; }
      if (status === 'stopping') {
        if (fresh(s) && s.tug?.state === 3 && s.speedKts <= 0.1) {
          const aligned = complete && plan && airport && Math.abs(angle(s.headingDeg - plan.headingDeg)) <= 12
            && distance(localPosition(s.lat, s.lon, airport.origin), plan.points[plan.points.length - 1]) <= 6;
          finish(aligned ? 'complete' : 'stopped', aligned ? 'Pushback complete. Ready to taxi.' : complete ? 'Pushback stopped. Check your taxi alignment.' : reason);
        }
        else if (deps.now() - stoppingAt > 15000) finish('fault', 'Pushback did not confirm stopped. Use the simulator pushback control.');
        return;
      }
      if (!fresh(s) || !s.tug || !connected() || deps.now() - heartbeat > 3000 || deps.conflict() || s.parked !== false) {
        await stop(!fresh(s) ? 'Pushback stopped: aircraft position unavailable.' : s.parked === true ? 'Parking brake set. Pushback stopped.' : 'Pushback stopped: control connection changed.'); return;
      }
      const currentGeneration = generation;
      const valid = () => {
        const latest = deps.capture();
        return currentGeneration === generation && ['connecting', 'pushing'].includes(status) && same() && connected()
          && deps.now() - heartbeat <= 3000 && fresh(s) && fresh(latest) && latest.tug !== null
          && latest.parked === false && !deps.conflict() && latest.speedKts <= 5
          && distance(localPosition(s.lat, s.lon, airport!.origin), localPosition(latest.lat, latest.lon, airport!.origin)) <= 6;
      };
      if (!activationSent) {
        activationSent = true; sentMotion = true;
        await deps.write({ kind: 'start' }, () => valid() && deps.capture().tug?.state === 3
          && deps.capture().speedKts <= 0.5 && Math.abs(angle(deps.capture().headingDeg - s.headingDeg)) <= 5);
        return;
      }
      if (s.tug.forwardSpeedFps > 0.5) { await stop('Pushback stopped: unexpected forward movement.'); return; }
      if (s.tug.state === 3) {
        if (status === 'connecting' && deps.now() - started <= 1000) return;
        await stop('Simulator pushback stopped.'); return;
      }
      if (status === 'connecting') {
        if (deps.now() - started > 60000) { await stop('The tug did not start moving. Check the simulator pushback service.'); return; }
        if (s.tug.forwardSpeedFps < -0.15) {
          status = 'pushing'; reason = `Pushing back for runway ${runway}.`; lastProgressAt = deps.now();
        }
      }
      if (s.speedKts > 5 || deps.now() - started > 240000) { await stop('Pushback stopped: movement outside the planned limits.'); return; }
      const p = localPosition(s.lat, s.lon, airport!.origin), points = plan!.points;
      let closest = { d: Infinity, progress: 0 };
      for (let i = 1; i < points.length; i++) {
        const projection = project(p, points[i - 1], points[i]);
        const at = points[i - 1].distanceM + projection.t * (points[i].distanceM - points[i - 1].distanceM);
        if (at < progress - 3 || at > progress + 12) continue;
        if (projection.distance < closest.d) closest = { d: projection.distance, progress: at };
      }
      if (closest.d > 6) { await stop('Pushback stopped: aircraft moved away from the planned path.'); return; }
      progress = Math.max(progress, closest.progress);
      if (progress - lastProgress >= 1) { lastProgressAt = deps.now(); lastProgress = progress; }
      if (status === 'pushing' && deps.now() - lastProgressAt > 30000) { await stop('Pushback did not move the aircraft. Use the simulator pushback control.'); return; }
      // The normal tug coasts after disable. Begin stopping before the endpoint;
      // only confirm completion from the final observed position and heading.
      const stopDistance = Math.min(8, Math.max(2.5, (s.speedKts * 0.514444) ** 2 / 0.44 + s.speedKts * 0.128611));
      if (distance(p, points[points.length - 1]) <= stopDistance) {
        const aligned = Math.abs(angle(s.headingDeg - plan!.headingDeg)) <= 12;
        await stop(aligned ? 'Stopping at the taxiway.' : 'Pushback stopped. Check your taxi alignment.', aligned); return;
      }
      const target = points.find(point => point.distanceM >= progress + 5) || points[points.length - 1];
      const desired = (bearing(p, target) + 540) % 360;
      if (Math.abs(angle(desired - s.headingDeg)) > 40) { await stop('Pushback stopped: aircraft heading differs from the planned path.'); return; }
      // TUG_HEADING is a heading servo, not an instantaneous aircraft heading.
      // The PMDG live trace showed a slow response to small heading errors.
      // Convert the path bearing into a bounded steering lead, proportional to
      // reverse speed / lookahead. Keep the path/observed-heading guards above.
      const steeringGain = Math.max(1, 16 * s.speedKts * 0.514444 / Math.max(5, distance(p, target)));
      const steeringLead = Math.max(-60, Math.min(60, steeringGain * angle(desired - s.headingDeg)));
      const tugTarget = (s.headingDeg + steeringLead + 360) % 360;
      await deps.write({ kind: 'steer', headingDeg: tugTarget }, () => {
        const latest = deps.capture();
        // Bridge startup and heading acknowledgements can yield. A command
        // calculated before a pause, brake input or position jump must expire.
        return valid() && latest.tug?.state !== 3 && latest.tug!.forwardSpeedFps <= 0.5
          && distance(p, localPosition(latest.lat, latest.lon, airport!.origin)) <= 6
          && Math.abs(angle(desired - latest.headingDeg)) <= 40
          && Math.abs(angle(tugTarget - latest.headingDeg)) <= 65;
      });
    })().catch(async err => {
      error = err instanceof Error ? err.message : String(err);
      await stop('Pushback stopped after a simulator command failed.');
    }).finally(() => { busy = false; });
    await operation;
  }
  async function request(message: Record<string, any>, client: unknown, isConnected = () => true, prepared?: PreparedPushback) {
    if (message.operation === 'status') {
      if (client === owner && isConnected() && deps.now() - heartbeat <= 3000) heartbeat = deps.now();
      return state();
    }
    if (message.operation === 'stop') {
      generation++; await operation;
      if (active() && status !== 'stopping') await stop('Pushback stopped.');
      return state();
    }
    if (message.operation !== 'start') throw new Error('Unknown pushback operation.');
    if (active()) throw new Error('Pushback is already in progress.');
    const initial = deps.capture(), blocked = unavailable(initial);
    if (blocked) throw new Error(blocked);
    if (!isConnected()) throw new Error('Pushback connection lost.');
    if (message.profileKey !== initial.profileKey || message.profileRevision !== initial.profileRevision) throw new Error('Aircraft changed. Try again.');
    icao = typeof message.icao === 'string' ? message.icao.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{3,8}$/.test(icao)) throw new Error('Choose your departure airport.');
    runway = normalizeRunway(message.runway);
    const token = ++generation;
    baseline = initial; owner = client; connected = isConnected; heartbeat = deps.now();
    status = 'planning'; reason = 'Finding pushback direction…'; error = null; plan = null; progress = 0;
    try {
      const loaded = prepared ? prepared.airport : await deps.airport(icao, runway);
      if (token !== generation || !same() || !connected() || deps.now() - heartbeat > 3000) throw new Error('Pushback request cancelled or expired.');
      const current = deps.capture(), changed = unavailable(current);
      if (changed) throw new Error(changed);
      if (distance(localPosition(initial.lat, initial.lon, loaded.origin), localPosition(current.lat, current.lon, loaded.origin)) > 2
        || Math.abs(angle(current.headingDeg - initial.headingDeg)) > 5) throw new Error('Aircraft moved while finding the pushback direction. Try again.');
      if (prepared && (!prepared.valid() || prepared.icao !== icao || prepared.runway !== runway)) throw new Error('Pushback preview changed. Preview again.');
      plan = prepared ? prepared.plan : planPushback(loaded, localPosition(current.lat, current.lon, loaded.origin), current.headingDeg, runway, deps.dimensions()!);
      airport = loaded; started = deps.now(); lastProgressAt = started; lastProgress = 0;
      status = 'connecting'; reason = 'Connecting tug. Movement will start when it is ready.';
      activationSent = false; sentMotion = false;
      timer = setInterval(() => { void tick(); }, 250);
      await tick();
      return state();
    } catch (err) {
      if (token === generation) { error = err instanceof Error ? err.message : String(err); await stop('Pushback cancelled.'); }
      throw err;
    }
  }
  return { request, state, tick, isActive: active, async dispose() { generation++; await operation; if (active()) await stop('Pushback stopped.'); if (timer) clearInterval(timer); timer = null; } };
}
