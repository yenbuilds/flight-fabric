import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAircraftModel, disposeAircraftModel } from './aircraft-model.js';
import { createEventBadgeCanvas, createLabelCanvas } from './marker-sprites.js';
import { createFakeCanvas } from './fake-scene.js';
import { loadThree } from './load-three.js';

test('the aircraft silhouette points its nose at -z with wings on x and the fin on +y', async () => {
  const { THREE } = await loadThree();
  const model = buildAircraftModel(THREE);
  const meshes = [];
  model.traverse((child) => { if (child.isMesh) meshes.push(child); });
  assert.ok(meshes.length >= 7, 'fuselage, nose, tail, wings, stabilizer, fin and engines');

  const box = new THREE.Box3().setFromObject(model);
  assert.ok(box.min.z < -18 && box.max.z > 18, 'about forty metres long along z');
  assert.ok(box.min.x < -16 && box.max.x > 16, 'wings span x');
  assert.ok(box.max.y > 5, 'the fin rises above the fuselage');
  assert.ok(Math.abs(box.min.x + box.max.x) < 0.5, 'symmetric about the centreline');

  const nose = meshes.find((mesh) => mesh.geometry.type === 'ConeGeometry' && mesh.position.z < 0);
  assert.ok(nose, 'the nose cone sits ahead of the fuselage');
  disposeAircraftModel(model);
});

test('badge and label canvases size themselves to their text', () => {
  const documentRef = { createElement: () => createFakeCanvas() };
  const round = createEventBadgeCanvas(documentRef, { glyph: '!', bg: '#7f1d1d', border: '#f87171', fg: '#fee2e2', size: 14, shape: 'round' });
  assert.ok(round.width === round.height && round.width >= 24);
  const pill = createEventBadgeCanvas(documentRef, { glyph: 'LDG', bg: '#14532d', border: '#4ade80', fg: '#f0fdf4', size: 9, shape: 'pill' });
  assert.ok(pill.width > pill.height, 'pills are wider than tall');
  assert.equal(pill.canvas.width, Math.ceil(pill.width * 2), 'drawn at 2x for crisp sprites');
  const label = createLabelCanvas(documentRef, 'FROM EGLL');
  assert.ok(label.width > 40 && label.height > 12);
  assert.equal(createEventBadgeCanvas({ createElement: () => ({ getContext: () => null }) }, {}), null, 'no 2D context means no marker');
});
