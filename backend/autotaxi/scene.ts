/** Map context for the taxi diagram: nearby pavement and runway slabs around a planned route. */
import { localPosition, parkingLabel, type Point, type TaxiGraph, type TaxiRoute } from './route.js';

type Position = { lat: number; lon: number };
export type TaxiRunwayRecord = { id: string; reciprocal: string; threshold: Position; headingDeg: number; lengthM: number; widthM: number };
export type SceneLink = { a: Point; b: Point; widthM: number; runway: boolean };
export type SceneRunway = { id: string; reciprocal: string; corners: Point[]; ends: [Point, Point] };
export type SceneStand = Point & { radiusM: number; headingDeg: number; label: string };
export type TaxiScene = { key: number; origin: Position; marginM: number; bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  runways: SceneRunway[]; links: SceneLink[]; stands: SceneStand[] };

const MAX_LINKS = 4000;
const MAX_STANDS = 400;
let sceneCounter = 0;

/** Pavement within `marginM` of the route's bounding box. Runways are always drawn whole. */
export function buildTaxiScene(graph: TaxiGraph, route: TaxiRoute, origin: Position, runways: TaxiRunwayRecord[] = [], marginM = 300): TaxiScene {
  const all = [...route.points, route.holdShort];
  const bounds = { minX: Math.min(...all.map(p => p.x)) - marginM, maxX: Math.max(...all.map(p => p.x)) + marginM,
    minZ: Math.min(...all.map(p => p.z)) - marginM, maxZ: Math.max(...all.map(p => p.z)) + marginM };
  const inside = (p: Point) => p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ;
  const nodes = new Map(graph.points.map(p => [p.id, p]));
  const links: SceneLink[] = [];
  for (const path of graph.paths) {
    // Taxi, path and runway links only; parking, vehicle and painted lines are not taxi pavement.
    if (![1, 2, 4].includes(path.type)) continue;
    const a = nodes.get(path.start), b = nodes.get(path.end);
    if (!a || !b || !Number.isFinite(path.widthM) || (!inside(a) && !inside(b))) continue;
    links.push({ a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z }, widthM: Math.max(1, Math.min(80, path.widthM)), runway: path.type === 2 });
    if (links.length >= MAX_LINKS) break;
  }
  const seen = new Set<string>();
  const slabs: SceneRunway[] = [];
  for (const rw of runways) {
    const pairKey = [rw.id, rw.reciprocal].sort().join('/');
    if (seen.has(pairKey) || ![rw.headingDeg, rw.lengthM, rw.widthM].every(Number.isFinite) || rw.lengthM <= 0) continue;
    seen.add(pairKey);
    const start = localPosition(rw.threshold.lat, rw.threshold.lon, origin);
    const h = rw.headingDeg * Math.PI / 180;
    const along = { x: Math.sin(h), z: Math.cos(h) }, across = { x: Math.cos(h), z: -Math.sin(h) };
    const end = { x: start.x + along.x * rw.lengthM, z: start.z + along.z * rw.lengthM };
    const half = Math.max(10, rw.widthM) / 2;
    slabs.push({ id: rw.id, reciprocal: rw.reciprocal, ends: [start, end], corners: [
      { x: start.x + across.x * half, z: start.z + across.z * half }, { x: end.x + across.x * half, z: end.z + across.z * half },
      { x: end.x - across.x * half, z: end.z - across.z * half }, { x: start.x - across.x * half, z: start.z - across.z * half } ] });
  }
  // Stands near the route, so a gate taxi shows where it ends and its neighbours.
  const stands: SceneStand[] = [];
  for (const p of graph.parkings || []) {
    if (!inside(p) || !Number.isFinite(p.radiusM)) continue;
    stands.push({ x: p.x, z: p.z, radiusM: Math.max(5, Math.min(60, p.radiusM)), headingDeg: Number.isFinite(p.headingDeg) ? p.headingDeg : 0, label: parkingLabel(p) });
    if (stands.length >= MAX_STANDS) break;
  }
  return { key: ++sceneCounter, origin, marginM, bounds, runways: slabs, links, stands };
}
