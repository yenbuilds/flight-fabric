import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTaxiMap } from './taxi-map.js';

function svgRoot() {
  const document = { createElementNS: (_ns, tag) => new Element(tag) };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.ownerDocument = document; this.writes = 0; }
    setAttribute(name, value) { this.attributes[name] = String(value); this.writes++; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    get firstChild() { return this.children[0]; }
    contains(child) { return this.children.some(node => node === child || node.contains(child)); }
  }
  return new Element('svg');
}
// An ordinary apron connector, northbound taxiway and right turn toward a hold.
const route = () => ({ kind: 'hold', runway: '09', points: [{ x: 0, z: 0 }, { x: 0, z: 160 }, { x: 120, z: 160 }],
  holdShort: { x: 150, z: 160 } });
const aircraft = { x: 0, z: 35, headingDeg: 0 };
const find = (root, attribute) => root.children.find(node => attribute in node.attributes);
const descendants = root => root.children.flatMap(node => [node, ...descendants(node)]);

test('retains fixed route geometry and aircraft across movement and equivalent deserialized replies', () => {
  const root = svgRoot();
  assert.equal(renderTaxiMap(root, route(), aircraft), true);
  const line = find(root, 'data-taxi-route'), marker = find(root, 'data-taxi-aircraft');
  const points = line.attributes.points, count = descendants(root).length, writes = line.writes;
  const firstPose = marker.attributes.transform;
  renderTaxiMap(root, JSON.parse(JSON.stringify(route())), { ...aircraft, z: 40, headingDeg: 4 });
  assert.equal(find(root, 'data-taxi-route'), line);
  assert.equal(find(root, 'data-taxi-aircraft'), marker);
  assert.equal(line.attributes.points, points, 'position does not refit or pan the map');
  assert.equal(line.writes, writes, 'static geometry is not rewritten');
  assert.equal(descendants(root).length, count);
  assert.notEqual(marker.attributes.transform, firstPose);
  const unchanged = descendants(root).map(node => node.writes), rootWrites = root.writes;
  renderTaxiMap(root, route(), { ...aircraft, z: 40, headingDeg: 4 });
  assert.deepEqual(descendants(root).map(node => node.writes), unchanged);
  assert.equal(root.writes, rootWrites);
});

test('a thirty-minute slow taxi retains seven nodes and writes only newly observed marker positions', () => {
  const root = svgRoot();
  // A 3.6 km parallel taxiway at 2 m/s (about 3.9 kt), with an observation
  // every 500 ms and the existing UI refresh between observations.
  const plan = { kind: 'hold', runway: '09', points: Array.from({ length: 37 }, (_, i) => ({ x: 0, z: i * 100 })) };
  let created = 0;
  const create = root.ownerDocument.createElementNS;
  root.ownerDocument.createElementNS = (...args) => { created++; return create(...args); };
  renderTaxiMap(root, plan, { x: 0, z: 0, headingDeg: 0 });
  const retained = descendants(root), marker = find(root, 'data-taxi-aircraft');
  const staticNodes = [root, ...retained.filter(node => node !== marker)];
  const staticWrites = staticNodes.map(node => node.writes), markerWrites = marker.writes;
  assert.equal(retained.length, 7);
  assert.equal(created, retained.length);

  for (let sample = 1; sample <= 3600; sample++) {
    const reply = JSON.parse(JSON.stringify(plan));
    const pose = { x: 0, z: sample, headingDeg: 0 };
    renderTaxiMap(root, reply, pose);
    const observedWrites = marker.writes;
    renderTaxiMap(root, reply, pose);
    assert.equal(marker.writes, observedWrites, 'the 250 ms refresh does not rewrite an unchanged observation');
    assert.equal(marker.attributes.display, 'inline');
    assert.equal(marker.attributes.transform, `translate(180,${Math.round((272 - sample * 244 / 3600) * 1000) / 1000}) rotate(0)`);
    const current = descendants(root);
    assert.equal(current.length, retained.length);
    current.forEach((node, i) => assert.equal(node, retained[i]));
  }
  assert.equal(created, retained.length, 'live updates never allocate replacement SVG nodes');
  assert.deepEqual(staticNodes.map(node => node.writes), staticWrites, 'route, marker strokes and viewport stay unchanged');
  assert.equal(marker.writes - markerWrites, 3600, 'one transform write per new observed position');
});

test('uses open strokes, finite coordinates and distinct consecutive route points', () => {
  const root = svgRoot(), plan = route();
  plan.points.splice(1, 0, { ...plan.points[0] });
  renderTaxiMap(root, plan, aircraft);
  const nodes = descendants(root);
  assert.ok(nodes.every(node => ['polyline', 'line', 'g', 'text'].includes(node.tag)));
  for (const node of nodes.filter(node => ['polyline', 'line', 'g'].includes(node.tag))) assert.equal(node.attributes.fill, 'none');
  const points = find(root, 'data-taxi-route').attributes.points.split(' ').map(pair => pair.split(',').map(Number));
  assert.equal(points.length, 3);
  assert.ok(points.flat().every(Number.isFinite));
  assert.ok(points.every(([x, y]) => x >= 28 && x <= 332 && y >= 28 && y <= 272));
  for (const line of nodes.filter(node => node.tag === 'line')) {
    const { x1, y1, x2, y2 } = line.attributes;
    assert.ok([x1, y1, x2, y2].every(n => Number.isFinite(Number(n))));
    assert.ok(x1 !== x2 || y1 !== y2, 'no zero-length line');
  }
  assert.ok(find(root, 'data-taxi-hold'));
});

test('rebuilds only when route geometry changes or another view replaces its children', () => {
  const root = svgRoot(); renderTaxiMap(root, route(), aircraft);
  const original = find(root, 'data-taxi-route');
  const changed = route(); changed.points[1].z += 10;
  renderTaxiMap(root, changed, aircraft);
  assert.notEqual(find(root, 'data-taxi-route'), original);
  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(root.ownerDocument.createElementNS('', 'rect'));
  renderTaxiMap(root, changed, aircraft);
  assert.ok(find(root, 'data-taxi-route'));
  assert.equal(root.children.some(node => node.tag === 'rect'), false);
});

test('hides stale, invalid and off-diagram poses without moving them to a false edge position', () => {
  const root = svgRoot(); renderTaxiMap(root, route(), aircraft);
  const marker = find(root, 'data-taxi-aircraft'), transform = marker.attributes.transform;
  for (const pose of [null, { ...aircraft, x: NaN }, { ...aircraft, headingDeg: Infinity }, { ...aircraft, x: 1000 }]) {
    renderTaxiMap(root, route(), pose);
    assert.equal(marker.attributes.display, 'none');
    assert.equal(marker.attributes.transform, transform);
  }
  renderTaxiMap(root, route(), { ...aircraft, headingDeg: 359 });
  assert.equal(find(root, 'data-taxi-aircraft'), marker);
  assert.equal(marker.attributes.display, 'inline');
  assert.match(marker.attributes.transform, /rotate\(359\)/);
});

test('a stand destination has its own marker and never implies a runway holding line', () => {
  const root = svgRoot(), plan = { ...route(), kind: 'stand', label: 'Gate 12' };
  renderTaxiMap(root, plan, aircraft);
  assert.equal(find(root, 'data-taxi-hold'), undefined);
  assert.equal(find(root, 'data-taxi-hold-approach'), undefined);
  assert.equal(root.children.filter(node => node.attributes.class === 'taxi-simple-destination').length, 2);
});

test('stops at the safe aircraft reference endpoint, leaving the physical holding line beyond the route', () => {
  const root = svgRoot(), plan = route();
  // The 30 m gap accommodates a transport aircraft's nose and holding clearance.
  assert.equal(plan.holdShort.x - plan.points.at(-1).x, 30);
  renderTaxiMap(root, plan, aircraft);
  const line = find(root, 'data-taxi-route'), bar = find(root, 'data-taxi-hold');
  const endpoint = line.attributes.points.split(' ').at(-1).split(',').map(Number);
  assert.equal((Number(bar.attributes.x1) + Number(bar.attributes.x2)) / 2, endpoint[0]);
  assert.equal((Number(bar.attributes.y1) + Number(bar.attributes.y2)) / 2, endpoint[1]);
  assert.equal(find(root, 'data-taxi-hold-approach'), undefined, 'no path extends to the physical boundary');
  assert.equal(root.children.filter(node => node.attributes.class === 'taxi-simple-route').length, 1);
  renderTaxiMap(root, { ...plan, holdShort: null }, aircraft);
  assert.equal(find(root, 'data-taxi-route'), line, 'physical boundary is not part of this route-only diagram');
  assert.equal(find(root, 'data-taxi-hold'), bar);
});

test('invalid geometry clears the previous diagram rather than keeping an outdated route', () => {
  const root = svgRoot();
  for (const invalid of [null, { ...route(), points: [{ x: 0, z: 0 }, { x: 0, z: 0 }] },
    { ...route(), points: [{ x: 0, z: 0 }, { x: Infinity, z: 40 }] },
    { ...route(), points: [{ x: 0, z: 0 }, { x: 20, z: NaN }] }]) {
    renderTaxiMap(root, route(), aircraft);
    assert.equal(renderTaxiMap(root, invalid, aircraft), false);
    assert.equal(root.children.length, 0);
  }
});
