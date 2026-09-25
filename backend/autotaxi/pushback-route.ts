import { angle, bearing, distance, localPosition, planTaxiRoute, project, type Point, type TaxiRoute } from './route.js';
import type { TaxiAirport } from './session.js';
import { DEFAULT_TAXI_HANDLING } from './handling.js';

export type PushbackPoint = Point & { headingDeg: number; distanceM: number };
export type PushbackPlan = { points: PushbackPoint[]; lengthM: number; headingDeg: number; taxiRoute: TaxiRoute };
const radians = (degrees: number) => degrees * Math.PI / 180;
const unit = (heading: number) => ({ x: Math.sin(radians(heading)), z: Math.cos(radians(heading)) });
const cross = (a: Point, b: Point) => a.x * b.z - a.z * b.x;

/** Back straight, then one reversing arc and a short alignment on the taxiway. Choose the
 * onward direction by routing to the selected runway, never its compass number.
 * This bounded manoeuvre deliberately rejects complex/ambiguous apron layouts.
 */
export function planPushback(airport: TaxiAirport, start: Point, headingDeg: number, runway: string,
  dimensions: { wheelbaseM: number; lengthM: number }): PushbackPlan {
  if (!airport.threshold || !airport.reciprocal || !airport.graph.complete) throw new Error('Complete airport taxiways are needed to choose the pushback direction.');
  if (![start.x, start.z, headingDeg, dimensions.wheelbaseM, dimensions.lengthM].every(Number.isFinite)
    || dimensions.wheelbaseM <= 0 || dimensions.lengthM <= 0) throw new Error('Aircraft position or dimensions are unavailable.');
  const graph = airport.graph;
  if (graph.points.length > 20000 || graph.paths.length > 40000
    || graph.points.some(p => ![p.x, p.z].every(Number.isFinite))) throw new Error('Airport taxiway data is invalid or too large.');
  const nodes = new Map(graph.points.map(p => [p.id, p]));
  const forward = unit(headingDeg), back = { x: -forward.x, z: -forward.z };
  const clearance = Math.max(8, dimensions.lengthM * 0.25);
  // The normal simulator tug owns speed (~2.7 kt in the PMDG live test).
  // Tiny geometric arcs cannot be followed by its finite heading response.
  const minRadius = Math.max(25, dimensions.wheelbaseM / Math.tan(radians(45)));
  // A point-following tug cuts slightly inside the arc. Give it a straight
  // finish before the stop tolerance so the nose settles onto the taxi heading.
  const alignmentM = Math.max(8, dimensions.wheelbaseM / 2);
  const candidates: (PushbackPlan & { score: number })[] = [];
  const handling = { ...DEFAULT_TAXI_HANDLING, minPathWidthM: 2, holdShortOffsetM: Math.max(30, dimensions.lengthM / 2 + 5) };
  // Nearest links first bounds the expensive onward-routing work at big airports.
  const links = graph.paths.filter(p => [1, 4].includes(p.type) && p.widthM >= 2 && nodes.has(p.start) && nodes.has(p.end))
    .map(path => ({ path, a: nodes.get(path.start)!, b: nodes.get(path.end)! }))
    .map(link => ({ ...link, distance: project(start, link.a, link.b).distance }))
    .filter(link => link.distance < 250)
    .sort((a, b) => a.distance - b.distance).slice(0, 24);
  for (const { a, b } of links) for (const [from, to] of [[a, b], [b, a]]) {
    const targetHeading = bearing(from, to), turn = angle(targetHeading - headingDeg);
    if (Math.abs(turn) < 25 || Math.abs(turn) > 110) continue;
    const along = unit(targetHeading), length = distance(from, to);
    const denominator = cross(back, along);
    if (Math.abs(denominator) < 0.1 || length < 15) continue;
    for (const radius of [minRadius, minRadius * 1.4, minRadius * 2]) {
      const sign = Math.sign(turn), h0 = radians(headingDeg), h1 = radians(headingDeg + turn);
      const arc = { x: sign * radius * (Math.cos(h1) - Math.cos(h0)), z: -sign * radius * (Math.sin(h1) - Math.sin(h0)) };
      const offset = { x: from.x - start.x - arc.x, z: from.z - start.z - arc.z };
      const straight = cross(offset, along) / denominator;
      if (straight < clearance || straight > 120) continue;
      const arcEnd = { x: start.x + back.x * straight + arc.x, z: start.z + back.z * straight + arc.z };
      const end = { x: arcEnd.x - along.x * alignmentM, z: arcEnd.z - along.z * alignmentM };
      const fractions = [arcEnd, end].map(p => ((p.x - from.x) * along.x + (p.z - from.z) * along.z) / length);
      if (fractions.some(fraction => fraction < 0.02 || fraction > 0.95)) continue;
      const arcLength = radius * Math.abs(radians(turn)), total = straight + arcLength + alignmentM;
      if (total > 180) continue;
      const points: PushbackPoint[] = [];
      for (let d = 0; d < straight; d += 2) points.push({ x: start.x + back.x * d, z: start.z + back.z * d, headingDeg, distanceM: d });
      const steps = Math.ceil(arcLength / 2);
      for (let i = 0; i <= steps; i++) {
        const h = radians(headingDeg + turn * i / steps);
        points.push({ x: start.x + back.x * straight + sign * radius * (Math.cos(h) - Math.cos(h0)),
          z: start.z + back.z * straight - sign * radius * (Math.sin(h) - Math.sin(h0)),
          headingDeg: (headingDeg + turn * i / steps + 360) % 360, distanceM: straight + arcLength * i / steps });
      }
      const alignmentSteps = Math.ceil(alignmentM / 2);
      for (let i = 1; i <= alignmentSteps; i++) {
        const d = alignmentM * i / alignmentSteps;
        points.push({ x: arcEnd.x - along.x * d, z: arcEnd.z - along.z * d,
          headingDeg: (targetHeading + 360) % 360, distanceM: straight + arcLength + d });
      }
      // Never reverse over any authored runway, including a crossing runway.
      const runwayLinks = graph.paths.filter(p => p.type === 2).map(p => ({ a: nodes.get(p.start), b: nodes.get(p.end), width: p.widthM }));
      const blocked = points.some(p => runwayLinks.some(l => {
        if (!l.a || !l.b || !Number.isFinite(l.width)) return true;
        const dx = l.b.x - l.a.x, dz = l.b.z - l.a.z, l2 = dx * dx + dz * dz;
        const t = l2 ? Math.max(0, Math.min(1, ((p.x - l.a.x) * dx + (p.z - l.a.z) * dz) / l2)) : 0;
        return Math.hypot(p.x - l.a.x - t * dx, p.z - l.a.z - t * dz) < l.width / 2 + dimensions.lengthM / 2;
      }));
      if (blocked) continue;
      try {
        const threshold = localPosition(airport.threshold.lat, airport.threshold.lon, airport.origin);
        const taxiRoute = planTaxiRoute(graph, end, targetHeading, runway, airport.reciprocal, threshold, handling);
        if (taxiRoute.joinM > 1) continue;
        candidates.push({ points, lengthM: total, headingDeg: (targetHeading + 360) % 360, taxiRoute,
          score: taxiRoute.lengthM + total * 2 + taxiRoute.runwayTravelM * 5 });
      } catch { /* This direction cannot reach the requested departure end. */ }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  if (!candidates.length) throw new Error('No simple pushback onto a taxiway was found here. Use the simulator pushback to reposition.');
  const { score: _score, ...plan } = candidates[0];
  return plan;
}
