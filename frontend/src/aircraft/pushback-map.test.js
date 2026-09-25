import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPushbackMap } from './pushback-map.js';

function svgRoot() {
  const document = { createElementNS: (_ns, tag) => new Element(tag) };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.ownerDocument = document; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    get firstChild() { return this.children[0]; }
    contains(child) { return this.children.includes(child); }
  }
  return new Element('svg');
}
const data = () => ({ pushbackPreview: { id: 'shown', runway: '09', phase: 'preview', lengthM: 80, remainingM: 80, headingDeg: 90,
  points: [{x:0,z:0},{x:0,z:-60},{x:-20,z:-60}] }, aircraft: {x:0,z:0,headingDeg:359}, scene: {links:[]},
  route: { points: [{x:-20,z:-60},{x:100,z:-60}] } });
const find = (root, attribute) => root.children.find(n => attribute in n.attributes);

test('live map retains geometry and marker, interpolates the shortest north crossing, and clears stale motion', () => {
  const root = svgRoot(), initial = data(); renderPushbackMap(root, initial);
  const marker = find(root, 'data-pushback-aircraft'), path = find(root, 'data-pushback-path');
  renderPushbackMap(root, {...initial, scene:{...initial.scene}, aircraft:{x:0,z:-1,headingDeg:1}});
  assert.equal(find(root, 'data-pushback-aircraft'), marker);
  assert.equal(find(root, 'data-pushback-path'), path);
  assert.match(marker.attributes.transform, /rotate\(361\)/, 'a two-degree turn across north');
  assert.match(marker.attributes.style, /--taxi-motion-duration/, 'respects the host motion preference');
  renderPushbackMap(root, initial, false);
  assert.equal(find(root, 'data-pushback-aircraft'), undefined);
  assert.equal(find(root, 'data-pushback-progress').attributes['data-pushback-progress'], '');
  renderPushbackMap(root, initial);
  assert.notEqual(find(root, 'data-pushback-aircraft'), marker);
  assert.match(find(root, 'data-pushback-aircraft').attributes.style, /transform 0ms/, 'recovery never glides from a stale position');
});

test('progress follows observed remaining distance; only confirmed completion gets the finished treatment', () => {
  const root = svgRoot(), initial = data();
  const update = changes => renderPushbackMap(root, {...initial, pushbackPreview:{...initial.pushbackPreview,...changes}});
  update({phase:'connecting',remainingM:80});
  assert.ok(root.children.some(n=>n.textContent==='Connecting tug'));
  assert.equal(find(root,'data-pushback-progress').attributes['data-pushback-progress'],'');
  update({phase:'pushing',remainingM:40});
  assert.equal(find(root, 'data-pushback-progress').attributes['data-pushback-progress'], '50');
  update({phase:'stopping',remainingM:2});
  assert.ok(root.children.some(n => n.textContent === 'Stopping…'));
  assert.ok(!root.children.some(n => n.textContent === 'Ready to taxi'));
  update({phase:'complete',remainingM:2});
  assert.equal(find(root, 'data-pushback-progress').attributes['data-pushback-progress'], '100');
  assert.ok(root.children.some(n => n.textContent === 'Ready to taxi'));
  assert.equal(find(root, 'data-pushback-path').attributes.points, '', 'completed diagram cannot imply more reversing remains');
});

test('changing plans or returning from a taxi map rebuilds geometry without carrying old motion', () => {
  const root = svgRoot(), initial = data(); renderPushbackMap(root, initial);
  const first = find(root, 'data-pushback-path');
  renderPushbackMap(root, {...initial, pushbackPreview:{...initial.pushbackPreview,id:'new'}});
  assert.notEqual(find(root, 'data-pushback-path'), first);
  while (root.firstChild) root.removeChild(root.firstChild);
  renderPushbackMap(root, initial);
  assert.ok(find(root, 'data-pushback-path'));
  assert.match(find(root, 'data-pushback-aircraft').attributes.style, /transform 0ms/);
});
