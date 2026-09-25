/**
 * Chase-camera ("3D") rendering of the Autotaxi scene. The camera sits behind and above the
 * aircraft, pitched down, so the aircraft holds still on screen while taxiways, runways, stands
 * and the planned route slide past in perspective, like a driving visualiser. The scenery is
 * flat, so every ground shape is projected through one camera and emitted as SVG path data;
 * only the aircraft has height. No WebGL: a few hundred polygons in one <svg> is enough.
 */
const DEG = Math.PI / 180;
const MARGIN = 40;
export const TAXI_VIEW_STORAGE_KEY = 'ff-autotaxi-view';
const TAXI_VIEWS = ['2d', '3d'];

export function readTaxiView(storage) {
  try { const view = storage?.getItem(TAXI_VIEW_STORAGE_KEY); return TAXI_VIEWS.includes(view) ? view : '3d'; } catch { return '3d'; }
}
export function writeTaxiView(storage, view) {
  try { storage?.setItem(TAXI_VIEW_STORAGE_KEY, TAXI_VIEWS.includes(view) ? view : '2d'); } catch {}
}

/**
 * Aircraft frame: r right, u up, f forward, metres. Screen: x right, y down, viewBox px.
 * The camera is `backM` behind and `upM` above the aircraft's reference point, pitched down.
 */
export function createChaseCamera({ w = 360, h = 300, hfovDeg = 60, pitchDeg = 14, backM = 72, upM = 40, nearM = 2, farM = 1600 } = {}) {
  const F = (w / 2) / Math.tan(hfovDeg / 2 * DEG);
  const sin = Math.sin(pitchDeg * DEG), cos = Math.cos(pitchDeg * DEG);
  const cx = w / 2, cy = h / 2;
  // Camera space: x right, y up, d along the view axis.
  const toCamera = (r, u, f) => ({ x: r, y: (u - upM) * cos + (f + backM) * sin, d: (f + backM) * cos - (u - upM) * sin });
  const toScreen = c => [cx + F * c.x / c.d, cy - F * c.y / c.d];
  // Half-spaces, positive inside: in front of the near plane, then within the screen's sides and
  // bottom (a little beyond them), so nothing projects to huge coordinates or bloats a filter region.
  const kx = (w / 2 + MARGIN) / F, ky = (h + MARGIN - cy) / F;
  const planes = [p => p.d - nearM, p => p.x + kx * p.d, p => -p.x + kx * p.d, p => p.y + ky * p.d];
  // Ground far ahead converges on this row.
  return { w, h, F, cx, cy, horizonY: cy - F * sin / cos, nearM, farM, backM, upM, toCamera, toScreen, planes };
}

/** World (x east, z north) to the aircraft frame (r right, f forward) for a heading in degrees clockwise from north. */
function aircraftFrame({ x, z, headingDeg }) {
  const s = Math.sin(headingDeg * DEG), c = Math.cos(headingDeg * DEG);
  return p => ({ r: (p.x - x) * c - (p.z - z) * s, f: (p.x - x) * s + (p.z - z) * c });
}

/** Sutherland–Hodgman against one half-space, in camera space where interpolation is linear. */
function clip(points, inside) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], da = inside(a), db = inside(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), d: a.d + t * (b.d - a.d) }); }
  }
  return out;
}

const fmt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** Camera-space polygon as path data, or null when nothing of it is in view. */
function cameraPath(cam, points) {
  if (points.every(p => p.d > cam.farM)) return null;
  const clipped = cam.planes.reduce(clip, points);
  return clipped.length < 3 ? null : `M${clipped.map(p => fmt(cam.toScreen(p))).join('L')}Z`;
}
const groundPath = (cam, frame, points) => cameraPath(cam, points.map(p => { const l = frame(p); return cam.toCamera(l.r, 0, l.f); }));

/** A straight ground line stays straight on screen, so a segment needs only its clipped ends. */
function groundSegment(cam, frame, from, to) {
  let [a, b] = [from, to].map(p => { const l = frame(p); return cam.toCamera(l.r, 0, l.f); });
  if (a.d > cam.farM && b.d > cam.farM) return null;
  for (const inside of cam.planes) {
    const da = inside(a), db = inside(b);
    if (da < 0 && db < 0) return null;
    if (da < 0 || db < 0) {
      const t = da / (da - db), m = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), d: a.d + t * (b.d - a.d) };
      if (da < 0) a = m; else b = m;
    }
  }
  return `M${fmt(cam.toScreen(a))}L${fmt(cam.toScreen(b))}`;
}

/** Text at a ground point: full size until the ground scale drops below 1 px/m (about 230 m ahead), then shrinking, dropped below 6 px. */
function label(cam, frame, p, text, basePx) {
  const l = frame(p), c = cam.toCamera(l.r, 0, l.f);
  if (c.d < cam.nearM) return null;
  const size = Math.min(basePx, basePx * cam.F / c.d);
  if (size < 6) return null;
  const [x, y] = cam.toScreen(c);
  if (x < -20 || x > cam.w + 20 || y > cam.h + 20) return null;
  return { text, x: Math.round(x), y: Math.round(y), size: Math.round(size * 10) / 10 };
}

// World-space shape builders. Quads and discs share one winding so a single nonzero
// path fills their union without seams or holes where they overlap.
function quad(a, b, half, capM = 0) {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len, nx = -uz * half, nz = ux * half;
  // A square cap extends each end, so consecutive links meet without a wedge of bare ground at a bend.
  const p = { x: a.x - ux * capM, z: a.z - uz * capM }, q = { x: b.x + ux * capM, z: b.z + uz * capM };
  return [{ x: p.x + nx, z: p.z + nz }, { x: q.x + nx, z: q.z + nz }, { x: q.x - nx, z: q.z - nz }, { x: p.x - nx, z: p.z - nz }];
}
function disc(c, r, n = 12) {
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.sin(i / n * 2 * Math.PI), z: c.z + r * Math.cos(i / n * 2 * Math.PI) }));
}
function dashes(from, to, dashM, gapM, half) {
  const len = Math.hypot(to.x - from.x, to.z - from.z), ux = (to.x - from.x) / (len || 1), uz = (to.z - from.z) / (len || 1);
  const out = [];
  for (let s = 0; s < len; s += dashM + gapM) {
    const e = Math.min(len, s + dashM);
    out.push(quad({ x: from.x + ux * s, z: from.z + uz * s }, { x: from.x + ux * e, z: from.z + uz * e }, half));
  }
  return out;
}

/**
 * Round each corner of the route for display with a short curve, tangent to both legs; the
 * controller still follows the straight legs, and the ends are untouched.
 */
export function smoothRoute(points, radiusM = 25) {
  if (!Array.isArray(points) || points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], p = points[i], b = points[i + 1];
    const inLen = Math.hypot(p.x - a.x, p.z - a.z), outLen = Math.hypot(b.x - p.x, b.z - p.z);
    if (!inLen || !outLen) { out.push(p); continue; }
    const ux = (p.x - a.x) / inLen, uz = (p.z - a.z) / inLen, vx = (b.x - p.x) / outLen, vz = (b.z - p.z) / outLen;
    const turn = Math.acos(Math.max(-1, Math.min(1, ux * vx + uz * vz)));
    if (turn < 3 * DEG) { out.push(p); continue; }
    // Tangent length for the radius, capped so neighbouring corners never share a leg and the
    // curve never strays more than 12 m from the planned corner, whatever the angle.
    const t = Math.min(radiusM * Math.tan(turn / 2), 24 / Math.sin(turn / 2), inLen * 0.45, outLen * 0.45);
    const start = { x: p.x - ux * t, z: p.z - uz * t }, end = { x: p.x + vx * t, z: p.z + vz * t };
    const steps = Math.max(2, Math.ceil(turn / (10 * DEG)));
    for (let k = 0; k <= steps; k++) {
      const s = k / steps, w0 = (1 - s) ** 2, w1 = 2 * (1 - s) * s, w2 = s * s;
      out.push({ x: w0 * start.x + w1 * p.x + w2 * end.x, z: w0 * start.z + w1 * p.z + w2 * end.z });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Project the scene for an aircraft pose. `done` and `ahead` are the route split at the aircraft,
 * as the 2D map splits it. Every field is SVG path data (possibly empty) or a list of them.
 */
export function projectTaxiScene(cam, { scene, route, aircraft, done = [], ahead = route.points }) {
  const frame = aircraftFrame(aircraft);
  const ground = points => groundPath(cam, frame, points);
  const join = paths => paths.filter(Boolean).join('');
  const ribbon = (points, half) => join([...points.slice(1).map((p, i) => ground(quad(points[i], p, half))), ...points.map(p => ground(disc(p, half)))]);
  const pavement = { taxi: [], runway: [] }, centrelines = { taxi: [], runway: [] }, edges = { taxi: [], runway: [] };
  const toCamera = p => { const l = frame(p); return cam.toCamera(l.r, 0, l.f); };
  for (const l of scene?.links || []) {
    // Most of a big airport is behind or beside the camera: reject on the two ends before building the quad.
    const a = toCamera(l.a), b = toCamera(l.b);
    if ((a.d > cam.farM && b.d > cam.farM) || cam.planes.some(inside => inside(a) < -l.widthM && inside(b) < -l.widthM)) continue;
    const kind = l.runway ? 'runway' : 'taxi';
    const slab = ground(quad(l.a, l.b, l.widthM / 2, l.widthM / 2));
    if (!slab) continue;
    pavement[kind].push(slab);
    centrelines[kind].push(groundSegment(cam, frame, l.a, l.b));
    // Edge lines sit just outside the slab and are drawn under every slab, so a crossing taxiway covers them at the junction.
    const rim = quad(l.a, l.b, l.widthM / 2 + 0.6);
    edges[kind].push(groundSegment(cam, frame, rim[0], rim[1]), groundSegment(cam, frame, rim[3], rim[2]));
  }
  const runways = (scene?.runways || []).map(rw => ({ id: rw.id, reciprocal: rw.reciprocal, slab: ground(rw.corners),
    // ICAO centreline stripes: 30 m on, 20 m off, 0.9 m wide.
    dashes: join(dashes(rw.ends[0], rw.ends[1], 30, 20, 0.45).map(ground)),
    labels: rw.ends.map((end, i) => label(cam, frame, end, i ? rw.reciprocal : rw.id, 11)).filter(Boolean) })).filter(rw => rw.slab);
  const stands = (scene?.stands || []).map(st => ({ d: ground(disc(st, st.radiusM, 16)), label: label(cam, frame, st, st.label, 9) })).filter(st => st.d);
  let hold = null;
  if (route.kind !== 'stand') {
    const from = route.points[route.points.length - 1], to = route.holdShort;
    const len = Math.hypot(to.x - from.x, to.z - from.z) || 1;
    const ux = (to.x - from.x) / len, uz = (to.z - from.z) / len, nx = -uz, nz = ux;
    hold = { dash: join(dashes(from, to, 4, 4, 0.7).map(ground)),
      bar: ground([{ x: to.x + nx * 14 + ux * 1.5, z: to.z + nz * 14 + uz * 1.5 }, { x: to.x - nx * 14 + ux * 1.5, z: to.z - nz * 14 + uz * 1.5 },
        { x: to.x - nx * 14 - ux * 1.5, z: to.z - nz * 14 - uz * 1.5 }, { x: to.x + nx * 14 - ux * 1.5, z: to.z + nz * 14 - uz * 1.5 }]) };
  }
  return {
    pavement: { taxi: join(pavement.taxi), runway: join(pavement.runway) },
    centrelines: { taxi: join(centrelines.taxi), runway: join(centrelines.runway) },
    edges: { taxi: join(edges.taxi), runway: join(edges.runway) },
    runways, stands,
    destinationStand: route.stand ? ground(disc(route.stand, route.stand.radiusM, 16)) : null,
    route: { done: ribbon(done, 3.5), glow: ribbon(ahead, 5), ahead: ribbon(ahead, 1.8) },
    hold,
    stop: ground(disc(route.points[route.points.length - 1], 2.2, 10)),
  };
}

// Low-poly airliner in the aircraft frame, roughly a 737: 38 m long, 35 m span. Cross-sections are
// ellipses at each station (f forward, w half-width, b/t bottom and top heights). The camera is
// rigid to the aircraft, so the sprite is projected once and reused every frame.
const FUSELAGE = [{ f: 19, w: 0.15, b: 2.9, t: 3.1 }, { f: 17.5, w: 0.9, b: 2.2, t: 3.9 }, { f: 15, w: 1.5, b: 1.5, t: 4.6 }, { f: 11, w: 1.85, b: 1.2, t: 5 },
  { f: -8, w: 1.9, b: 1.2, t: 5 }, { f: -12, w: 1.7, b: 1.6, t: 5 }, { f: -16, w: 1.1, b: 3, t: 4.9 }, { f: -19, w: 0.4, b: 4, t: 4.6 }];
const ENGINE = [{ f: 5.5, w: 1.3, b: 0.5, t: 3.1 }, { f: 0, w: 1.2, b: 0.6, t: 3 }];
const WING = [[2.2, 1.8, 3], [17.5, 3.6, -6], [17.5, 3.6, -9], [2.2, 1.8, -5]];
const WINGLET = [[17.5, 3.6, -6], [17.5, 3.6, -9], [18.3, 6.2, -9.6], [18.3, 6.2, -7.6]];
const STABILISER = [[0.4, 4.6, -13], [7, 4.9, -17], [7, 4.9, -19], [0.4, 4.6, -17.4]];
// The fin is seen from dead astern, so it has a little thickness and a trailing-edge face.
const FIN = sign => [[sign * 0.4, 4.8, -10], [sign * 0.15, 11.5, -17.5], [sign * 0.15, 11.5, -19.8], [sign * 0.4, 4.6, -19]];
const FIN_EDGE = [[0.4, 4.6, -19], [0.15, 11.5, -19.8], [-0.15, 11.5, -19.8], [-0.4, 4.6, -19]];
const WINDSCREEN = [[-1.1, 4.25, 15.3], [1.1, 4.25, 15.3], [0.75, 3.95, 17], [-0.75, 3.95, 17]];
// Plan-view silhouette from the 2D marker, for the ground shadow.
const SILHOUETTE = [[0, 19], [2.2, 14], [2.2, 3], [17.5, -6], [17.5, -9], [2.2, -5], [2.2, -13], [7, -17], [7, -19], [0, -17.4],
  [-7, -19], [-7, -17], [-2.2, -13], [-2.2, -5], [-17.5, -9], [-17.5, -6], [-2.2, 3], [-2.2, 14]];
const LIGHT = [-0.3, 0.9, 0.35];
const DARK = '#1b222c';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => { const l = Math.hypot(...v) || 1; return v.map(c => c / l); };
const centroid = pts => pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
const normal = pts => unit(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
const mirror = pts => pts.map(([r, u, f]) => [-r, u, f]).reverse();

function ring({ f, w, b, t }, rOffset, sides) {
  const m = (b + t) / 2, v = (t - b) / 2;
  return Array.from({ length: sides }, (_, k) => { const a = k / sides * 2 * Math.PI; return [rOffset + w * Math.cos(a), m + v * Math.sin(a), f]; });
}
/** Elliptical cross-sections joined into quads; normals face away from the piece's centreline. */
function loft(stations, rOffset = 0, sides = 8) {
  const rings = stations.map(st => ring(st, rOffset, sides));
  const faces = [];
  for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < sides; k++) {
    const pts = [rings[i][k], rings[i][(k + 1) % sides], rings[i + 1][(k + 1) % sides], rings[i + 1][k]];
    const c = centroid(pts), axis = [rOffset, (stations[i].b + stations[i].t + stations[i + 1].b + stations[i + 1].t) / 4, c[2]];
    let n = normal(pts);
    if (dot(n, sub(c, axis)) < 0) n = n.map(v => -v);
    faces.push({ pts, n, solid: true });
  }
  return faces;
}
/** The aft end of a loft closed with one dark face: engine exhausts and the tail cone. */
const cap = (station, rOffset) => ({ pts: ring(station, rOffset, 8), n: [0, 0, -1], solid: true, fill: DARK });
/** Lambert with a little ambient and a small highlight toward the camera. */
function shade(n, toCam) {
  const l = unit(LIGHT), h = unit([l[0] + toCam[0], l[1] + toCam[1], l[2] + toCam[2]]);
  const k = 0.42 + 0.58 * Math.max(0, dot(n, l)) + 0.3 * Math.max(0, dot(n, h)) ** 24;
  return `rgb(${Math.min(255, Math.round(238 * k))},${Math.min(255, Math.round(243 * k))},${Math.min(255, Math.round(248 * k))})`;
}

/** Shaded faces painted far to near, plus the ground shadow and halo under the aircraft. */
export function aircraftSprite(cam) {
  const camPos = [0, cam.upM, -cam.backM];
  const flat = pts => ({ pts, n: normal(pts), solid: false });
  const faces = [...loft(FUSELAGE), cap(FUSELAGE[FUSELAGE.length - 1], 0), ...[].concat(...[5.5, -5.5].map(r => [...loft(ENGINE, r), cap(ENGINE[ENGINE.length - 1], r)])),
    ...[WING, mirror(WING), WINGLET, mirror(WINGLET), STABILISER, mirror(STABILISER), FIN(1), FIN(-1), FIN_EDGE].map(flat),
    // Painted on the nose: nudged nearer so it sorts above the skin it sits on.
    { ...flat(WINDSCREEN), fill: DARK, overlay: true }];
  const visible = [];
  for (const face of faces) {
    const toCam = unit(sub(camPos, centroid(face.pts)));
    let n = face.n;
    if (dot(n, toCam) < 0) { if (face.solid) continue; n = n.map(v => -v); }
    const pts = face.pts.map(([r, u, f]) => cam.toCamera(r, u, f));
    visible.push({ depth: pts.reduce((s, p) => s + p.d, 0) / pts.length - (face.overlay ? 0.5 : 0),
      fill: face.fill || shade(n, toCam), d: `M${pts.map(p => fmt(cam.toScreen(p))).join('L')}Z` });
  }
  visible.sort((a, b) => b.depth - a.depth);
  return { faces: visible.map(({ fill, d }) => ({ fill, d })),
    shadow: cameraPath(cam, SILHOUETTE.map(([r, f]) => cam.toCamera(r + 1.2, 0, f - 1))),
    halo: cameraPath(cam, disc({ x: 0, z: 0 }, 24, 24).map(p => cam.toCamera(p.x, 0, p.z))) };
}
