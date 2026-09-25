import { randomUUID } from 'node:crypto';
import { angle, distance, localPosition, normalizeRunway } from './route.js';
import { planPushback, type PushbackPlan } from './pushback-route.js';
import { buildTaxiScene, type TaxiScene } from './scene.js';
import type { PushbackDependencies } from './pushback-session.js';
import type { TaxiAirport, TaxiObservation } from './session.js';

export type PreparedPushback = {
  id: string; icao: string; runway: string; airport: TaxiAirport; plan: PushbackPlan; scene: TaxiScene;
  /** Read-only checks against the aircraft/configuration that produced this plan. */
  sameAircraft: () => boolean; valid: () => boolean;
};
type Dependencies = Pick<PushbackDependencies, 'now' | 'capture' | 'dimensions' | 'airport'>;

/** Per-viewer dry runs. This module has no simulator write dependency. */
export function createPushbackPreviews(deps: Dependencies) {
  const viewers = new WeakMap<object, { generation: number; plan: PreparedPushback | null }>();
  const fresh = (s: TaxiObservation) => s.guidanceReady === true && Number.isFinite(s.timeMs)
    && s.timeMs <= deps.now() && deps.now() - s.timeMs <= 1000;
  function destination(message: Record<string, any>) {
    const icao = typeof message.icao === 'string' ? message.icao.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{3,8}$/.test(icao)) throw new Error('Choose your departure airport.');
    return { icao, runway: normalizeRunway(message.runway) };
  }
  function matches(p: PreparedPushback, message: Record<string, any>) {
    const d = destination(message);
    return p.icao === d.icao && p.runway === d.runway && p.sameAircraft();
  }
  function view(p: PreparedPushback | null, geometry = false, phase = 'preview', remainingM?: number) {
    const s = deps.capture();
    const usable = p?.sameAircraft() === true;
    return { canGuide: fresh(s), guidanceUnavailableReason: fresh(s) ? null : s.guidanceReason || 'Waiting for live aircraft position.',
      currentProfileKey: s.profileKey, currentProfileRevision: s.profileRevision,
      aircraft: usable && fresh(s) ? { ...localPosition(s.lat, s.lon, p.airport.origin), headingDeg: s.headingDeg, speedKts: s.speedKts } : null,
      sceneKey: usable ? p.scene.key : null,
      pushbackPreview: usable ? { id: p.id, icao: p.icao, runway: p.runway, phase,
        valid: phase === 'preview' && p.valid(), lengthM: p.plan.lengthM, headingDeg: p.plan.headingDeg,
        remainingM: remainingM ?? p.plan.lengthM, ...(geometry ? { points: p.plan.points } : {}) } : null,
      ...(usable && geometry ? { scene: p.scene, preview: p.plan.taxiRoute } : {}),
    };
  }
  async function request(message: Record<string, any>, client: object, connected: () => boolean) {
    const target = destination(message);
    if (!connected()) throw new Error('Taxi guidance connection lost.');
    let entry = viewers.get(client);
    if (!entry) { entry = { generation: 0, plan: null }; viewers.set(client, entry); }
    if (message.operation === 'status') return view(entry.plan && matches(entry.plan, message) ? entry.plan : null, message.scene === true);
    if (message.operation !== 'preview') throw new Error('Pushback guidance supports preview and status only.');
    const generation = ++entry.generation;
    entry.plan = null;
    const initial = deps.capture();
    if (!fresh(initial) || initial.speedKts > 0.5) throw new Error('Stop on the ground to preview pushback.');
    if (message.profileKey !== initial.profileKey || message.profileRevision !== initial.profileRevision) throw new Error('Aircraft changed. Wait for current aircraft data.');
    const dimensions = deps.dimensions();
    if (!dimensions) throw new Error('Aircraft dimensions are unavailable for pushback.');
    const sameAircraft = () => {
      const current = deps.capture(), size = deps.dimensions();
      return current.generation === initial.generation && current.profileKey === initial.profileKey && current.profileRevision === initial.profileRevision
        && size?.wheelbaseM === dimensions.wheelbaseM && size?.lengthM === dimensions.lengthM;
    };
    const airport = await deps.airport(target.icao, target.runway);
    const current = deps.capture();
    const position = localPosition(current.lat, current.lon, airport.origin);
    if (!connected() || generation !== entry.generation || !sameAircraft() || !fresh(current) || current.speedKts > 0.5
      || distance(position, localPosition(initial.lat, initial.lon, airport.origin)) > 2 || Math.abs(angle(current.headingDeg - initial.headingDeg)) > 5) {
      throw new Error('Aircraft moved or changed while finding pushback. Preview again.');
    }
    const plan = planPushback(airport, position, current.headingDeg, target.runway, dimensions);
    const created = deps.now();
    const valid = () => {
      const latest = deps.capture();
      return sameAircraft() && fresh(latest) && latest.speedKts <= 0.5 && deps.now() - created <= 60000
        && distance(position, localPosition(latest.lat, latest.lon, airport.origin)) <= 2
        && Math.abs(angle(latest.headingDeg - current.headingDeg)) <= 5;
    };
    // Include both legs in the scenery bounds; keep their directions separate.
    const scene = buildTaxiScene(airport.graph, { ...plan.taxiRoute, points: [...plan.points, ...plan.taxiRoute.points] }, airport.origin, airport.runways || []);
    entry.plan = { id: randomUUID(), ...target, airport, plan, scene, sameAircraft, valid };
    return view(entry.plan, true);
  }
  function prepared(message: Record<string, any>, client: object) {
    const p = viewers.get(client)?.plan;
    if (!p || p.id !== message.previewId || !matches(p, message) || !p.valid()) throw new Error('Pushback preview changed. Wait for the updated path before starting.');
    return p;
  }
  return { request, prepared, view, matches };
}
