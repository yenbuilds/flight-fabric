import assert from 'node:assert/strict';
import test from 'node:test';
import { aircraftSprite, createChaseCamera, projectTaxiScene, readTaxiView, smoothRoute, writeTaxiView, TAXI_VIEW_STORAGE_KEY } from './autotaxi-chase-view.js';

const cam = createChaseCamera({ w: 360, h: 300 });
const ground = (r, f) => cam.toScreen(cam.toCamera(r, 0, f));
// The layout-test fixture: a northbound taxiway, a turn east and a hold short of runway 16.
const route = { points: [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 110, z: 100 }], kind: 'hold', lengthM: 210, runway: '16', holdShort: { x: 140, z: 100 } };
const scene = {
  runways: [{ id: '16', reciprocal: '34', ends: [{ x: 175, z: 400 }, { x: 175, z: -300 }],
    corners: [{ x: 197.5, z: 400 }, { x: 197.5, z: -300 }, { x: 152.5, z: -300 }, { x: 152.5, z: 400 }] }],
  links: [{ a: { x: 0, z: -200 }, b: { x: 0, z: 100 }, widthM: 23, runway: false }, { a: { x: 0, z: 100 }, b: { x: 175, z: 100 }, widthM: 23, runway: false },
    { a: { x: 175, z: 400 }, b: { x: 175, z: -300 }, widthM: 45, runway: true }],
  stands: [{ x: -40, z: 60, radiusM: 20, headingDeg: 0, label: 'Gate D 12' }],
};
const aircraft = { x: 0.4, z: 12, headingDeg: 3 };
const subpaths = d => d.split('M').filter(Boolean).map(s => s.replace('Z', '').split('L').map(pair => pair.split(',').map(Number)));
const signedArea = pts => pts.reduce((sum, [x, y], i) => { const [nx, ny] = pts[(i + 1) % pts.length]; return sum + x * ny - nx * y; }, 0);
const inView = ([x, y]) => x >= -40 && x <= 400 && y <= 340;

test('Chase camera: the aircraft sits on the centre column in the lower half and the ground climbs to a horizon above it', () => {
  const [ax, ay] = ground(0, 0);
  assert.equal(Math.round(ax), 180);
  assert.ok(ay > 200 && ay < 260, `aircraft row ${ay}`);
  let last = ay;
  for (const f of [20, 100, 400, 1500]) {
    const [x, y] = ground(0, f);
    assert.equal(Math.round(x), 180);
    assert.ok(y < last && y > cam.horizonY, `ground ${f} m ahead rises toward the horizon: ${y}`);
    last = y;
  }
  assert.ok(cam.horizonY > 40 && cam.horizonY < 100, `horizon ${cam.horizonY}`);
  // Behind and above the reference point, the tail is still on screen.
  assert.ok(ground(0, -19)[1] < 300);
});

test('Chase camera: a straight ground line projects to a straight line, so polygons need no subdivision', () => {
  const [a, b] = [ground(-20, 30), ground(40, 300)];
  const m = ground(10, 165);
  const cross = (b[0] - a[0]) * (m[1] - a[1]) - (b[1] - a[1]) * (m[0] - a[0]);
  assert.ok(Math.abs(cross) < 1e-6, `midpoint off the line by ${cross}`);
});

test('Scene projection follows the aircraft heading: what is ahead is centred, what is left is left', () => {
  // Heading east: a stand due east is straight ahead, one to the north-east is to the left, and one due north is abeam, out of view.
  const east = projectTaxiScene(cam, { scene: { stands: [{ x: 100, z: 0, radiusM: 5, label: 'E' }, { x: 60, z: 60, radiusM: 5, label: 'NE' }, { x: 0, z: 100, radiusM: 5, label: 'N' }] }, route, aircraft: { x: 0, z: 0, headingDeg: 90 } });
  const centre = pts => pts.reduce((s, [x]) => s + x, 0) / pts.length;
  assert.deepEqual(east.stands.map(st => st.label.text), ['E', 'NE']);
  const [e, ne] = east.stands.map(st => centre(subpaths(st.d)[0]));
  assert.ok(Math.abs(e - 180) < 1, `east stand centred: ${e}`);
  assert.ok(ne < 100, `north-east stand on the left: ${ne}`);
});

test('Scene projection clips to the view: nothing behind the camera, beyond the far limit or off the sides survives', () => {
  const out = projectTaxiScene(cam, { scene, route, aircraft });
  // On the last leg, facing the hold-short bar 80 m ahead.
  const facing = projectTaxiScene(cam, { scene, route, aircraft: { x: 60, z: 100, headingDeg: 90 } });
  for (const d of [out.pavement.taxi, out.pavement.runway, out.route.ahead, out.stop, out.edges.taxi, ...out.runways.map(rw => rw.slab), facing.hold.bar, facing.hold.dash]) {
    assert.ok(d.length > 0);
    for (const poly of subpaths(d)) assert.ok(poly.every(inView), `polygon within the margin: ${JSON.stringify(poly)}`);
  }
  assert.equal(out.hold.bar, null, 'the bar 140 m to the right of a northbound aircraft is out of frame');
  // Each visible link contributes two edge lines, each a single straight segment.
  assert.ok(subpaths(out.edges.taxi).every(seg => seg.length === 2));
  assert.equal(subpaths(out.edges.taxi).length, 2 * subpaths(out.pavement.taxi).length);
  // Slabs are square-capped by half their width, so a bend between two links leaves no bare wedge:
  // the corner of the northbound taxiway's slab reaches past the node into the eastbound one.
  const bend = projectTaxiScene(cam, { scene: { links: [{ a: { x: 0, z: 0 }, b: { x: 0, z: 100 }, widthM: 20, runway: false }] }, route, aircraft: { x: 0, z: 0, headingDeg: 0 } });
  const [slab] = subpaths(bend.pavement.taxi);
  const nodeAhead = ground(0, 100), capAhead = ground(10, 110);
  assert.ok(slab.some(([x, y]) => Math.abs(x - capAhead[0]) < 0.1 && Math.abs(y - capAhead[1]) < 0.1), `slab reaches 10 m past its end node (${nodeAhead}) to ${capAhead}: ${JSON.stringify(slab)}`);
  const behind = projectTaxiScene(cam, { scene: { links: [{ a: { x: 0, z: -500 }, b: { x: 0, z: -300 }, widthM: 23, runway: false }] }, route, aircraft });
  assert.equal(behind.pavement.taxi, '');
  assert.equal(behind.centrelines.taxi, '');
  const far = projectTaxiScene(cam, { scene: { links: [{ a: { x: 0, z: 3000 }, b: { x: 0, z: 5000 }, widthM: 23, runway: false }] }, route, aircraft });
  assert.equal(far.pavement.taxi, '');
  const beside = projectTaxiScene(cam, { scene: { links: [{ a: { x: 400, z: 0 }, b: { x: 400, z: 30 }, widthM: 23, runway: false }] }, route, aircraft });
  assert.equal(beside.pavement.taxi, '');
});

test('Ribbon pieces share one winding so a single nonzero path fills their union without holes', () => {
  const out = projectTaxiScene(cam, { scene, route, aircraft, done: [route.points[0], aircraft], ahead: [aircraft, ...route.points.slice(1)] });
  for (const d of [out.route.ahead, out.route.glow, out.route.done, out.pavement.taxi]) {
    const signs = new Set(subpaths(d).map(poly => Math.sign(signedArea(poly))).filter(Boolean));
    assert.equal(signs.size, 1, `one orientation in ${d.slice(0, 60)}`);
  }
});

test('Labels shrink with distance and vanish once unreadable; a stand route rings its destination instead of a hold bar', () => {
  const out = projectTaxiScene(cam, { scene, route, aircraft });
  assert.deepEqual(out.stands[0].label.text, 'Gate D 12');
  assert.ok(out.stands[0].label.size > 6 && out.stands[0].label.size <= 9);
  const [near] = out.runways[0].labels;
  assert.equal(near.text, '16', 'the far threshold, 400 m ahead, is labelled; the one behind is not');
  const farAway = projectTaxiScene(cam, { scene, route, aircraft: { x: 175, z: -1600, headingDeg: 0 } });
  assert.deepEqual(farAway.runways[0].labels, [], 'a designator 2 km ahead is too small to read');
  const stand = projectTaxiScene(cam, { scene, aircraft, route: { ...route, kind: 'stand', label: 'Gate D 12', stand: { x: -40, z: 60, radiusM: 20 } } });
  assert.equal(stand.hold, null);
  assert.ok(stand.destinationStand.length > 0);
  assert.equal(out.destinationStand, null);
});

test('Aircraft sprite: shaded faces painted far to near, centred on screen with the fin nearest the camera', () => {
  const sprite = aircraftSprite(cam);
  assert.ok(sprite.faces.length >= 20);
  const points = sprite.faces.flatMap(face => subpaths(face.d)[0]);
  assert.ok(points.every(inView));
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 180) < 1, 'symmetric about the centre column');
  assert.ok(Math.min(...ys) > 150 && Math.max(...ys) < 300, `in the lower half: ${Math.min(...ys)}..${Math.max(...ys)}`);
  assert.ok(sprite.faces.every(face => /^rgb\(\d+,\d+,\d+\)$/.test(face.fill) || face.fill === '#1b222c'), 'shaded skin, dark exhausts, tail cone and windscreen');
  assert.equal(sprite.faces.filter(face => face.fill === '#1b222c').length, 4, 'two exhausts, the tail cone and the windscreen face the camera');
  assert.ok(new Set(sprite.faces.map(face => face.fill)).size > 8, 'shading distinguishes top, sides and tail');
  // The fin's trailing edge, on the centre line, is nearest the camera and so painted last.
  assert.ok(subpaths(sprite.faces.at(-1).d)[0].every(([x]) => Math.abs(x - 180) < 3), 'the fin is painted last');
  assert.ok(sprite.shadow.length > 0 && sprite.halo.length > 0);
});

test('Route corners are rounded for display only: ends fixed, straight legs untouched, short legs limit the curve', () => {
  const rounded = smoothRoute(route.points);
  assert.deepEqual(rounded[0], route.points[0]);
  assert.deepEqual(rounded.at(-1), route.points.at(-1));
  assert.ok(rounded.length > route.points.length);
  assert.ok(!rounded.some(p => p.x === 0 && p.z === 100), 'the corner itself is replaced');
  // The curve stays inside the corner, tangent to both legs 25 m out.
  const arc = rounded.slice(1, -1);
  assert.ok(arc.every(p => p.x >= 0 && p.x <= 25.01 && p.z >= 74.99 && p.z <= 100), JSON.stringify(arc));
  assert.deepEqual(arc[0], { x: 0, z: 75 });
  assert.ok(Math.abs(arc.at(-1).x - 25) < 1e-9 && Math.abs(arc.at(-1).z - 100) < 1e-9);
  const straight = [{ x: 0, z: 0 }, { x: 0, z: 50 }, { x: 0, z: 120 }];
  assert.deepEqual(smoothRoute(straight), straight);
  const short = smoothRoute([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 40, z: 10 }]);
  assert.deepEqual(short[1], { x: 0, z: 5.5 }, 'a 10 m leg gives up at most 45% to the curve');
  // Even a hairpin keeps the curve within about 12 m of the corner, well inside the map's 25 m off-route cut-off.
  for (const deg of [90, 110, 150, 170]) {
    const rad = deg * Math.PI / 180, corner = { x: 0, z: 200 };
    const hairpin = smoothRoute([{ x: 0, z: 0 }, corner, { x: 200 * Math.sin(rad), z: 200 + 200 * Math.cos(rad) }]);
    const nearest = Math.min(...hairpin.map(p => Math.hypot(p.x - corner.x, p.z - corner.z)));
    assert.ok(nearest <= 12.5, `${deg}° turn strays ${nearest.toFixed(1)} m`);
  }
  assert.equal(smoothRoute([{ x: 0, z: 0 }, { x: 5, z: 5 }]).length, 2);
});

test('The ribbon is the default and existing view preferences persist per browser', () => {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(readTaxiView(storage), '3d');
  writeTaxiView(storage, '2d');
  assert.equal(readTaxiView(storage), '2d', 'an existing 2D preference is retained');
  writeTaxiView(storage, '3d');
  assert.equal(store.get(TAXI_VIEW_STORAGE_KEY), '3d');
  assert.equal(readTaxiView(storage), '3d');
  writeTaxiView(storage, 'isometric');
  assert.equal(readTaxiView(storage), '2d');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readTaxiView(broken), '3d');
  assert.doesNotThrow(() => writeTaxiView(broken, '3d'));
  assert.equal(readTaxiView(null), '3d');
});
