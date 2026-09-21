import { DEFAULT_TAXI_HANDLING, validateTaxiHandling, type TaxiHandling } from './handling.js';

/** Taxiway graph routing in metres east/north of the airport reference. */
export type Point = { x: number; z: number };
export type TaxiPoint = Point & { id: number; type: number; orientation: number };
export type TaxiPath = { id: number; type: number; widthM: number; start: number; end: number; runway: string | null };
/** SDK TAXI_PARKING record. name and suffix are SDK enums: 1-9 ramp areas, 10 GATE, 11 DOCK, 12-37 GATE_A..GATE_Z (suffix likewise A..Z). */
export type TaxiParking = { id: number; type: number; name: number; suffix: number; number: number; headingDeg: number; radiusM: number; x: number; z: number };
export type TaxiParkingOption = { label: string; typeLabel: string };
export type TaxiGraph = { complete: boolean; points: TaxiPoint[]; paths: TaxiPath[]; parkings?: TaxiParking[] };
export type TaxiStand = Point & { headingDeg: number; radiusM: number; label: string };
export type TaxiRoute = { points: Point[]; kind: 'hold' | 'stand'; label: string; runway: string; lengthM: number; runwayTravelM: number; joinM: number; holdShort: Point; stand?: TaxiStand };
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z);
export const bearing = (a: Point, b: Point): number => Math.atan2(b.x - a.x, b.z - a.z) * 180 / Math.PI;
export const angle = (degrees: number): number => ((degrees + 540) % 360 + 360) % 360 - 180;
export function project(p: Point, a: Point, b: Point): { point: Point; t: number; distance: number } {
  const length2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / length2)) : 0;
  const point = { x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) };
  return { point, t, distance: distance(p, point) };
}
export function normalizeRunway(value: unknown): string {
  if (typeof value !== 'string' || !/^(0?[1-9]|[12][0-9]|3[0-6])[LRC]?$/.test(value.trim().toUpperCase())) throw new Error('Enter a runway such as 16L or 27.');
  return value.trim().toUpperCase().padStart(/[LRC]$/i.test(value.trim()) ? 3 : 2, '0');
}
export function localPosition(lat: number, lon: number, origin: { lat: number; lon: number }): Point {
  return { x: angle(lon - origin.lon) * Math.PI / 180 * 6371000 * Math.cos(origin.lat * Math.PI / 180),
    z: (lat - origin.lat) * Math.PI / 180 * 6371000 };
}
const isPoint = (p: Point): boolean => Number.isFinite(p?.x) && Number.isFinite(p?.z) && Math.abs(p.x) < 100000 && Math.abs(p.z) < 100000;
const hold = (p: TaxiPoint): boolean => [2, 4, 5, 6].includes(p.type);
// SDK TAXI_PATH types: 1 TAXI, 2 RUNWAY, 3 PARKING, 4 PATH. Default scenery
// (e.g. YMML) builds nearly its whole network from PATH links, so treat
// TAXI and PATH alike. Vehicle, road and painted-line paths stay excluded.
const taxiway = (p: TaxiPath): boolean => p.type === 1 || p.type === 4;
// Scenery widths are authored, not surveyed (YMAV declares 13 m for 23 m
// taxiways). The aircraft-specific minimum filters links; it cannot establish
// obstacle or wingtip clearance by itself.
// Off-network join limits. A 737 at full tiller turns in about 7 m and the
// centreline follower allows 6 m over the first 20 m from rest. In the lagged
// vehicle models a 40° first turn with a reversed axis and 3 s of tiller lag
// peaks at 6.1 m and 35° at 6.0 m; 30° stays under 6 m in every case tried.
const JOIN_RADIUS_M = 150;
const JOIN_TURN_DEG = 30;
// Under 90 so a perpendicular approach takes the shallow join ahead rather
// than a right-angle dash to the nearest point, which lagged models cut wide.
const JOIN_CORNER_DEG = 80;
const MAX_TURN_DEG = 110;
// Stands live in their own SDK index space; they join the node map above this.
const STAND_ID_BASE = 1 << 24;
type Edge = { to: number; length: number; runway: boolean; protected: boolean };

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(project(a, c, d).distance, project(b, c, d).distance, project(c, a, b).distance, project(d, a, b).distance);
}

const PARKING_NAMES = ['', 'Parking', 'N Parking', 'NE Parking', 'E Parking', 'SE Parking', 'S Parking', 'SW Parking', 'W Parking', 'NW Parking', 'Gate', 'Dock'];
// SimConnect TAXI_PARKING.TYPE, independent of the stand's NAME enum.
// https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimConnect/API_Reference/Facilities/SimConnect_AddToFacilityDefinition.htm
const PARKING_TYPES = ['Unspecified type', 'GA ramp', 'Small GA ramp', 'Medium GA ramp', 'Large GA ramp',
  'Cargo ramp', 'Military cargo ramp', 'Military combat ramp', 'Small gate', 'Medium gate', 'Heavy gate',
  'GA dock', 'Fuel', 'Vehicle', 'Extra GA ramp', 'Extra gate'];
const enumLetter = (value: number): string => (value >= 12 && value <= 37 ? String.fromCharCode(65 + value - 12) : '');
/** Human label for a stand, e.g. "Gate D 12", "Parking 3A", "Dock 7". */
export function parkingLabel(p: TaxiParking): string {
  const base = p.name >= 12 ? `Gate ${enumLetter(p.name)}` : PARKING_NAMES[p.name] || 'Stand';
  const tail = `${p.number > 0 ? p.number : ''}${enumLetter(p.suffix)}`;
  return tail ? `${base} ${tail}` : base;
}
const parkingKey = (text: string): string => text.toUpperCase().replace(/\b(GATE|STAND|PARKING|RAMP|DOCK|BAY)\b/g, '').replace(/[^A-Z0-9]/g, '');
/** Stand names and scenery types for a picker, in natural order. */
export function listParkingOptions(graph: TaxiGraph): TaxiParkingOption[] {
  const options = new Map<string, TaxiParkingOption>();
  for (const parking of graph.parkings || []) {
    const label = parkingLabel(parking);
    // Match findParking's first exact match when scenery repeats a name.
    if (!options.has(label)) options.set(label, { label, typeLabel: PARKING_TYPES[parking.type] || 'Unknown type' });
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
/** Name-only list retained for clients without stand-type display. */
export function listParkings(graph: TaxiGraph): string[] {
  return listParkingOptions(graph).map(option => option.label);
}
/** Resolve "D12", "Gate D 12" or "12" to one stand, or explain what is close. */
export function findParking(graph: TaxiGraph, query: unknown): TaxiParking {
  const wanted = typeof query === 'string' ? parkingKey(query) : '';
  if (!wanted) throw new Error('Enter a gate or stand, such as D12.');
  const labelled = (graph.parkings || []).map(p => ({ p, key: parkingKey(parkingLabel(p)) }));
  const exact = labelled.filter(item => item.key === wanted);
  if (exact.length) return exact[0].p;
  // A bare number is the stand number whatever its area name, if that is unique.
  if (/^\d+$/.test(wanted)) {
    const numbered = labelled.filter(item => item.p.number === Number(wanted));
    if (numbered.length === 1) return numbered[0].p;
    if (numbered.length > 1) throw new Error(`Stand number ${wanted} is used ${numbered.length} times here: ${numbered.slice(0, 8).map(item => parkingLabel(item.p)).join(', ')}.`);
  }
  // "Parking 3B" for "S Parking 3B": accept a unique partial match, else list them.
  const near = labelled.filter(item => item.key.endsWith(wanted) || item.key.startsWith(wanted));
  if (near.length === 1) return near[0].p;
  const close = near.slice(0, 8).map(item => parkingLabel(item.p));
  throw new Error(`No stand "${String(query).trim()}" in the simulator data for this airport.${close.length ? ` Close: ${close.join(', ')}.` : ''}`);
}

type Destination = { kind: 'hold'; runway: string; reciprocal: string; threshold: Point } | { kind: 'stand'; parking: TaxiParking };

/** Hold short of a runway: real scenery hold-short nodes only. Runway thresholds alone cannot authorize a route. */
export function planTaxiRoute(graph: TaxiGraph, start: Point, heading: number,
  runway: string, reciprocal: string, threshold: Point, handling: TaxiHandling = DEFAULT_TAXI_HANDLING): TaxiRoute {
  if (!isPoint(threshold)) throw new Error('Complete simulator taxiway and hold-short data are required.');
  return plan(graph, start, heading, { kind: 'hold', runway, reciprocal, threshold }, validateTaxiHandling(handling));
}
/** Taxi to a named stand, typically after landing: along the landing runway to an exit, then the taxiway network, then the stand's own lead-in link. */
export function planTaxiToStand(graph: TaxiGraph, start: Point, heading: number, query: unknown, handling: TaxiHandling = DEFAULT_TAXI_HANDLING): TaxiRoute {
  if (!graph?.complete || !Array.isArray(graph.parkings)) throw new Error('Complete simulator taxiway and stand data are required.');
  return plan(graph, start, heading, { kind: 'stand', parking: findParking(graph, query) }, validateTaxiHandling(handling));
}

function plan(graph: TaxiGraph, start: Point, heading: number, destination: Destination, handling: TaxiHandling): TaxiRoute {
  if (!graph?.complete || !Array.isArray(graph.points) || !Array.isArray(graph.paths)
      || graph.points.length > 20000 || graph.paths.length > 20000 || (graph.parkings?.length ?? 0) > 20000
      || !isPoint(start) || !Number.isFinite(heading)) {
    throw new Error('Complete simulator taxiway and hold-short data are required.');
  }
  const nodes = new Map<number, TaxiPoint>();
  for (const p of graph.points) {
    if (!isPoint(p) || !Number.isSafeInteger(p.id) || p.id < 0 || nodes.has(p.id)) throw new Error('Invalid taxiway point data.');
    nodes.set(p.id, p);
  }
  const stands = new Map<number, TaxiParking>();
  for (const p of graph.parkings || []) {
    if (!isPoint(p) || !Number.isSafeInteger(p.id) || p.id < 0 || stands.has(p.id)) throw new Error('Invalid stand data.');
    stands.set(p.id, p);
    nodes.set(STAND_ID_BASE + p.id, { id: STAND_ID_BASE + p.id, type: 1, orientation: 0, x: p.x, z: p.z });
  }
  const adjacent = new Map<number, Edge[]>();
  const targetNodes = new Set<number>();
  const targetPaths = destination.kind === 'hold' ? graph.paths.filter(p => p.type === 2 && [destination.runway, destination.reciprocal].includes(p.runway || '')) : [];
  const protectedPath = (a: Point, b: Point) => targetPaths.some(p => {
    const c = nodes.get(p.start), d = nodes.get(p.end);
    return c && d && segmentDistance(a, b, c, d) < p.widthM / 2 + 20;
  });
  const runwayPaths = graph.paths.filter(p => p.type === 2 && nodes.has(p.start) && nodes.has(p.end) && Number.isFinite(p.widthM));
  const runwayHalfWidth = (p: TaxiPath) => p.widthM / 2;
  // After landing the aircraft is on runway pavement; that runway is not an obstacle to leaving it.
  const underAircraft = new Set(runwayPaths.filter(p => segmentDistance(start, start, nodes.get(p.start)!, nodes.get(p.end)!) < runwayHalfWidth(p)));
  const crossesRunway = (a: Point, b: Point) => runwayPaths.some(p => !underAircraft.has(p) && segmentDistance(a, b, nodes.get(p.start)!, nodes.get(p.end)!) < runwayHalfWidth(p));
  const usable: TaxiPath[] = [];
  let narrow = 0;
  for (const path of graph.paths) {
    if (path.type === 3) {
      // A stand's lead-in link: one way, into the stand, never a shortcut through it.
      if (destination.kind !== 'stand') continue;
      const [pointId, standId] = stands.has(path.end) && nodes.has(path.start) ? [path.start, path.end]
        : stands.has(path.start) && nodes.has(path.end) ? [path.end, path.start] : [null, null];
      if (pointId == null || standId == null) continue;
      const a = nodes.get(pointId)!, b = nodes.get(STAND_ID_BASE + standId)!;
      if (distance(a, b) < 0.1) continue;
      const edges = adjacent.get(a.id) || [];
      edges.push({ to: b.id, length: distance(a, b), runway: false, protected: false });
      adjacent.set(a.id, edges);
      continue;
    }
    if (!taxiway(path) && path.type !== 2) continue;
    const a = nodes.get(path.start), b = nodes.get(path.end);
    if (!a || !b || !Number.isFinite(path.widthM)) throw new Error('Incomplete taxiway connections.');
    if (path.type === 2 && destination.kind === 'hold' && [destination.runway, destination.reciprocal].includes(path.runway || '')) {
      targetNodes.add(a.id); targetNodes.add(b.id);
    }
    if (path.widthM < handling.minPathWidthM) { if (taxiway(path)) narrow++; continue; }
    if (distance(a, b) < 0.1) continue;
    usable.push(path);
    for (const [from, to] of [[a, b], [b, a]]) {
      const edges = adjacent.get(from.id) || [];
      edges.push({ to: to.id, length: distance(a, b), runway: path.type === 2, protected: protectedPath(a, b) });
      adjacent.set(from.id, edges);
    }
  }
  // Destination set: real holding points on access branches of the requested
  // runway, or the one stand. Never infer a hold from a threshold distance.
  const goals = new Set<number>();
  if (destination.kind === 'hold') {
    if (!targetNodes.size) throw new Error('The selected runway is not identified in the simulator taxiway graph.');
    const queue = [...targetNodes].map(id => ({ id, length: 0 }));
    const seen = new Set(targetNodes);
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      for (const edge of adjacent.get(item.id) || []) {
        if (seen.has(edge.to) || edge.runway || item.length + edge.length > 300) continue;
        seen.add(edge.to);
        const node = nodes.get(edge.to)!;
        if (hold(node)) {
          // Departure end only; don't select a short route to the far end of the runway.
          if (distance(node, destination.threshold) <= 800) goals.add(node.id);
        } else queue.push({ id: node.id, length: item.length + edge.length });
      }
    }
    if (!goals.size) {
      throw new Error(`No simulator hold-short point found near the selected runway end.${narrow
        ? ` ${narrow} taxiway links narrower than ${handling.minPathWidthM} m in this scenery were ignored.` : ''}`);
    }
  } else {
    goals.add(STAND_ID_BASE + destination.parking.id);
    if (![...adjacent.values()].some(edges => edges.some(e => e.to === STAND_ID_BASE + destination.parking.id))) {
      throw new Error(`${parkingLabel(destination.parking)} has no lead-in link from the taxiway network in this scenery.`);
    }
  }
  // Join the network from wherever the aircraft is. A centreline beneath the
  // aircraft is used directly. Otherwise the nearest usable taxiway within
  // JOIN_RADIUS_M is reached over a straight connector, chosen so the aircraft
  // turns at most JOIN_TURN_DEG onto the connector and JOIN_CORNER_DEG onto the
  // centreline. The connector crosses whatever lies between (apron, grass);
  // the map shows it and joinM reports it so the pilot can check.
  type Join = { legs: Point[]; to: number; behind: number; cost: number; joinM: number; runway: boolean };
  // Best candidate per onward node, so a cheap join onto a stub that cannot
  // reach the goal is tried and rejected before a dearer one that can.
  const candidates = new Map<string, Join>();
  for (const path of usable) {
    // A landing roll-out may join the runway itself; a departure never does.
    if (!(taxiway(path) || (destination.kind === 'stand' && path.type === 2)) || targetNodes.has(path.start) || targetNodes.has(path.end)) continue;
    const a = nodes.get(path.start)!, b = nodes.get(path.end)!;
    if (protectedPath(a, b)) continue;
    const projected = project(start, a, b);
    if (projected.distance > JOIN_RADIUS_M) continue;
    for (const [to, other] of [[a, b], [b, a]]) {
      const remaining = distance(projected.point, to);
      if (remaining < 1) continue;
      const u = { x: (to.x - projected.point.x) / remaining, z: (to.z - projected.point.z) / remaining };
      // Candidate join points from the projection to the shallowest approach.
      for (const ahead of [0, 1, 2, 4, 8].map(k => Math.min(k * projected.distance, remaining - 1))) {
        const point = { x: projected.point.x + u.x * ahead, z: projected.point.z + u.z * ahead };
        const joinM = distance(start, point);
        const first = joinM >= 1 ? bearing(start, point) : heading;
        const turn = Math.abs(angle(first - heading));
        const corner = Math.abs(angle(bearing(point, to) - first));
        // A short connector cannot absorb its own turn, so the two turns share
        // a budget that grows with the connector until it is long enough to
        // straighten on before the corner.
        const cornerBudget = joinM < 10 ? JOIN_TURN_DEG - turn : joinM < 30 ? JOIN_CORNER_DEG - turn : JOIN_CORNER_DEG;
        if (turn > JOIN_TURN_DEG || corner > cornerBudget) continue;
        // The connector is invented, so it must not cross any runway pavement
        // or the destination runway's protected strip.
        if (joinM >= 1 && (protectedPath(start, point) || crossesRunway(start, point))) continue;
        const cost = joinM + (turn + corner) * 0.5;
        const key = `${to.id}:${other.id}`;
        if (cost < (candidates.get(key)?.cost ?? Infinity)) candidates.set(key, { legs: joinM >= 1 ? [{ ...start }, point] : [point], to: to.id, behind: other.id, cost, joinM: joinM >= 1 ? joinM : 0, runway: path.type === 2 });
      }
    }
  }
  if (!candidates.size) throw new Error(`No taxiway within ${JOIN_RADIUS_M} m that the aircraft can turn onto. Face within ${JOIN_TURN_DEG}° of the taxi direction.`);
  const joins = [...candidates.values()].sort((a, b) => a.cost - b.cost);
  // An onward turn depends on how the junction was reached. Keep each
  // incoming direction as a separate search state: a cheaper arrival may
  // face away from the exit that a longer approach can use.
  type Arrival = { id: number; from: number | null; key: string; cost: number };
  const costs = new Map<string, number>();
  const previous = new Map<string, { from: Arrival; edge: Edge }>();
  // Binary min heap keeps large scenery graphs from blocking the telemetry loop.
  const heap: Arrival[] = [];
  function push(item: Arrival) {
    let i = heap.length; heap.push(item);
    while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].cost <= item.cost) break; heap[i] = heap[parent]; i = parent; }
    heap[i] = item;
  }
  function pop(): Arrival {
    const result = heap[0], tail = heap.pop()!;
    if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let child = i * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++;
      if (heap[child].cost >= tail.cost) break; heap[i] = heap[child]; i = child; } heap[i] = tail; }
    return result;
  }
  let destinationArrival: Arrival | null = null;
  let join: Join = joins[0];
  // A stand route may need the landing runway to reach an exit, so along-runway
  // travel is allowed at once (still at 50 times its length, so the nearest
  // usable exit wins). A hold-short route only falls back to it.
  const passes = destination.kind === 'stand' ? [true] : [false, true];
  for (const candidate of joins) {
    join = candidate;
    for (const allowRunwayTravel of passes) {
      costs.clear(); previous.clear(); heap.length = 0;
      const initial: Arrival = { id: join.to, from: null, key: 'join', cost: distance(join.legs.at(-1)!, nodes.get(join.to)!) };
      costs.set(initial.key, initial.cost);
      push(initial);
      while (heap.length) {
        const current = pop();
        if (current.cost !== costs.get(current.key)) continue;
        if (goals.has(current.id)) { destinationArrival = current; break; }
        const incoming = current.from != null ? nodes.get(current.from)! : join.legs.at(-1)!;
        for (const edge of adjacent.get(current.id) || []) {
          if (targetNodes.has(edge.to) || edge.protected || (edge.runway && !allowRunwayTravel)) continue;
          // The initial join is already committed forwards; reversing along it
          // would otherwise look like an inexpensive graph route behind the jet.
          if (current.from == null && edge.to === join.behind) continue;
          // No corner the follower cannot take, such as a high-speed exit
          // entered backwards or a reversal at a runway node.
          const here = nodes.get(current.id)!, next = nodes.get(edge.to)!;
          if (Math.abs(angle(bearing(here, next) - bearing(incoming, here))) > MAX_TURN_DEG) continue;
          // Crossings through shared nodes remain allowed in both searches.
          const cost = current.cost + edge.length * (edge.runway ? 50 : 1);
          const key = `${current.id}:${edge.to}`;
          if (cost >= (costs.get(key) ?? Infinity)) continue;
          costs.set(key, cost); previous.set(key, { from: current, edge });
          push({ id: edge.to, from: current.id, key, cost });
        }
      }
      if (destinationArrival != null) break;
    }
    if (destinationArrival != null) break;
  }
  if (destinationArrival == null) throw new Error(destination.kind === 'hold' ? 'No forward taxi route to this runway holding point.' : `No forward taxi route to ${parkingLabel(destination.parking)}.`);
  const ids = [destinationArrival.id];
  // The roll-out from the join point to the first node is runway travel too.
  let runwayTravelM = join.runway ? distance(join.legs.at(-1)!, nodes.get(join.to)!) : 0;
  let arrival = destinationArrival;
  while (previous.has(arrival.key)) {
    const step = previous.get(arrival.key)!;
    if (step.edge.runway) runwayTravelM += step.edge.length;
    arrival = step.from; ids.unshift(arrival.id);
  }
  const points: Point[] = [...join.legs, ...ids.map(id => ({ x: nodes.get(id)!.x, z: nodes.get(id)!.z }))];
  const holdShort = { ...points[points.length - 1] };
  for (let i = 1; i < points.length - 1; i++) {
    if (Math.abs(angle(bearing(points[i], points[i + 1]) - bearing(points[i - 1], points[i]))) > MAX_TURN_DEG) {
      throw new Error('Route contains a turn too tight for this initial controller. Reposition on the onward taxiway.');
    }
  }
  // Position telemetry is at the aircraft reference, not its nose. Keep the
  // aircraft behind a holding line using its configured reference-point
  // clearance. A stand's position is where the reference sits when parked.
  let trim = destination.kind === 'hold' ? handling.holdShortOffsetM : 0;
  while (points.length > 1 && trim > 0) {
    const end = points[points.length - 1], before = points[points.length - 2];
    const length = distance(before, end);
    if (length <= trim) { points.pop(); trim -= length; }
    else { points[points.length - 1] = { x: end.x + (before.x - end.x) * trim / length, z: end.z + (before.z - end.z) * trim / length }; trim = 0; }
  }
  const lengthM = points.reduce((sum, p, i) => sum + (i ? distance(points[i - 1], p) : 0), 0);
  if (points.length < 2 || lengthM < 5) throw new Error(destination.kind === 'hold' ? 'Already too close to the holding point to start autotaxi.' : 'Already at the stand.');
  if (destination.kind === 'hold') {
    return { points, kind: 'hold', label: `hold short of runway ${destination.runway}`, runway: destination.runway, lengthM, runwayTravelM, joinM: join.joinM, holdShort };
  }
  const p = destination.parking;
  return { points, kind: 'stand', label: parkingLabel(p), runway: '', lengthM, runwayTravelM, joinM: join.joinM, holdShort,
    stand: { x: p.x, z: p.z, headingDeg: p.headingDeg, radiusM: Number.isFinite(p.radiusM) ? Math.max(5, Math.min(60, p.radiusM)) : 20, label: parkingLabel(p) } };
}
