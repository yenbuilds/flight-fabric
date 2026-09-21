import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createFlightScene } from './scene.js';
import { createFakeCanvas, flushPromises } from './fake-scene.js';

// Exercise the production scene lifecycle with real scene objects, but no GPU,
// image requests or browser. Only the renderer and pointer controls are stubs.
function createHarness(options = {}) {
  const frames = new Map();
  let nextFrame = 0;
  let renders = 0;
  let controls;
  const imageLoads = [];
  const liveTextures = new Set();
  const notifications = [];
  const canvas = Object.assign(new EventTarget(), {
    classList: { add() {} },
    style: {},
  });
  class Renderer {
    domElement = canvas;
    setPixelRatio() {}
    setSize() {}
    render() { renders += 1; }
    dispose() {}
    forceContextLoss() { canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); }
  }
  class Controls extends THREE.EventDispatcher {
    target = new THREE.Vector3();
    enabled = true;
    constructor() { super(); controls = this; }
    update() { return false; }
    dispose() {}
  }
  class TextureLoader {
    setCrossOrigin() {}
    load(url, onLoad, _onProgress, onError) {
      imageLoads.push({ url, finish: () => {
        const texture = new THREE.Texture();
        liveTextures.add(texture);
        texture.addEventListener('dispose', () => liveTextures.delete(texture));
        onLoad(texture);
      }, fail: () => onError(new Error('offline')) });
    }
  }
  const containerEl = {
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    appendChild(child) { child.parentNode = this; },
    removeChild(child) { child.parentNode = null; },
  };
  const scene = createFlightScene({
    containerEl,
    three: { THREE: { ...THREE, WebGLRenderer: Renderer, TextureLoader }, OrbitControls: Controls, LineSegments2, LineSegmentsGeometry, LineMaterial },
    windowRef: {
      requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
    documentRef: { createElement: createFakeCanvas },
    consoleRef: { warn() {} },
    onContextLost() { notifications.push({ type: 'lost', active: scene.isActive() }); },
    onContextRestored() { notifications.push({ type: 'restored', active: scene.isActive() }); },
    onTerrainUpdated() { notifications.push({ type: 'terrain' }); },
    ...options,
  });
  return {
    scene, canvas, controls, frames, notifications, imageLoads, liveTextures,
    renderCount: () => renders,
    runFrames() {
      const pending = [...frames.entries()];
      for (const [id, callback] of pending) { frames.delete(id); callback(); }
    },
  };
}

test('context loss stops scene work and restoration waits for the owning view to resume', () => {
  const harness = createHarness();
  const { scene, canvas, notifications } = harness;
  try {
    scene.start();
    harness.runFrames();
    assert.equal(harness.renderCount(), 1);
    const lost = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(lost);
    assert.equal(lost.defaultPrevented, true, 'allow the browser to restore its WebGL context');
    assert.equal(scene.isActive(), false);
    assert.equal(harness.controls.enabled, false);
    assert.equal(harness.frames.size, 0, 'no frame loop survives the loss');
    assert.deepEqual(notifications, [{ type: 'lost', active: false }]);

    scene.start();
    scene.requestRender();
    harness.runFrames();
    assert.equal(scene.isActive(), false, 'resize/foreground callbacks cannot restart a lost context');
    assert.equal(harness.renderCount(), 1);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    assert.equal(notifications.length, 1, 'duplicate loss events do not repeat recovery');

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    assert.deepEqual(notifications.at(-1), { type: 'restored', active: false });
    assert.equal(harness.controls.enabled, true);
    assert.equal(scene.isActive(), false, 'the controller decides whether this view is still visible');
    assert.equal(harness.frames.size, 0);
    scene.start();
    harness.runFrames();
    assert.equal(harness.renderCount(), 2);
  } finally { scene.dispose(); }
  const afterDispose = notifications.length;
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(notifications.length, afterDispose, 'disposed canvases cannot notify or revive their owners');
  assert.equal(harness.frames.size, 0);
});

const imageryTiles = (prefix, count = 12) => Array.from({ length: count }, (_, x) => ({
  key: `${prefix}/${x}`, url: `https://tiles.invalid/${prefix}/${x}.png`, layer: 'base',
  minX: x * 100, maxX: (x + 1) * 100, minZ: 0, maxZ: 100,
}));

for (const suspend of ['hidden', 'context-lost']) {
  test(`${suspend} scenes stop queued imagery until the visible view resumes`, () => {
    const { scene, canvas, imageLoads } = createHarness();
    try {
      scene.start();
      scene.setGroundTiles(imageryTiles('first'));
      assert.equal(imageLoads.length, 6);
      if (suspend === 'hidden') scene.stop();
      else canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      imageLoads.slice().forEach(load => load.finish());
      assert.equal(imageLoads.length, 6, 'late completions do not drain the hidden queue');
      scene.setGroundTiles(imageryTiles('current'));
      assert.equal(imageLoads.length, 6, 'a late viewport refresh cannot restart hidden downloads');
      if (suspend === 'context-lost') canvas.dispatchEvent(new Event('webglcontextrestored'));
      scene.start();
      scene.setGroundTiles(imageryTiles('current'));
      assert.equal(imageLoads.length, 12, 'the selected viewport resumes loading');
      assert.ok(imageLoads.slice(6).every(load => load.url.includes('/current/')));
    } finally { scene.dispose(); }
  });
}

test('panning away and back does not leave duplicate queued imagery retries', () => {
  const { scene, imageLoads } = createHarness();
  try {
    scene.start();
    const blocking = imageryTiles('blocked', 6);
    scene.setGroundTiles(blocking);
    for (let index = 0; index < 100; index += 1) {
      scene.setGroundTiles([...blocking, ...imageryTiles('queued', 1)]);
      scene.setGroundTiles(blocking);
    }
    scene.setGroundTiles([...blocking, ...imageryTiles('queued', 1)]);
    imageLoads[0].finish();
    assert.equal(imageLoads.length, 7);
    imageLoads[6].fail();
    assert.equal(imageLoads.length, 7, 'one failed tile must not replay obsolete viewport requests');
  } finally { scene.dispose(); }
});

for (const persistentCount of [90, 114]) test(`compact imagery cache evicts unused textures with ${persistentCount} persistent visible tiles`, () => {
  const { scene, imageLoads, liveTextures } = createHarness({ quality: 'compact' });
  let completed = 0;
  try {
    scene.start();
    for (let view = 0; view < 40; view += 1) {
      scene.setGroundTiles([...imageryTiles('persistent', persistentCount), ...imageryTiles(`pan-${view}`, 6)]);
      while (completed < imageLoads.length) imageLoads[completed++].finish();
      assert.equal(liveTextures.size, persistentCount + 6, 'only the current viewport is retained when it fills the budget');
    }
  } finally { scene.dispose(); }
  assert.equal(liveTextures.size, 0, 'all imagery is released on disposal');
});

test('context loss releases terrain work and ignores a late elevation response', async () => {
  const harness = createHarness();
  const retained = [];
  let resolveElevation;
  const pendingElevation = new Promise((resolve) => { resolveElevation = resolve; });
  const provider = {
    retainTiles(keys) { retained.push(keys); },
    peekElevations() { return null; },
    getElevations() { return pendingElevation; },
  };
  try {
    harness.scene.start();
    harness.scene.setGroundTiles([{
      key: 'tile', z: 0, x: 0, y: 0, layer: 'detail', minX: -100, maxX: 100, minZ: -100, maxZ: 100,
    }], { terrain: { provider, floorMeters: 0, unitsPerMeter: 1 } });
    assert.ok(retained.at(-1).length > 0);
    harness.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    assert.deepEqual(retained.at(-1), [], 'pending terrain ownership is released');
    resolveElevation(new Float32Array(256 * 256).fill(10));
    await flushPromises();
    harness.runFrames();
    assert.equal(harness.scene.groundHeightAt(0, 0), null, 'late data cannot mutate lost terrain');
    assert.deepEqual(harness.notifications, [{ type: 'lost', active: false }]);
    assert.equal(harness.frames.size, 0);
  } finally { harness.scene.dispose(); }
});

test('context loss cancels an already queued terrain notification', () => {
  const harness = createHarness();
  const elevations = new Float32Array(256 * 256).fill(10);
  try {
    harness.scene.start();
    harness.scene.setGroundTiles([{
      key: 'cached', z: 0, x: 0, y: 0, layer: 'detail', minX: -100, maxX: 100, minZ: -100, maxZ: 100,
    }], { terrain: {
      provider: { retainTiles() {}, peekElevations() { return elevations; } },
      floorMeters: 0,
      unitsPerMeter: 1,
    } });
    assert.ok(harness.frames.size > 1, 'terrain has scheduled a notification beside the render loop');
    harness.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    assert.equal(harness.frames.size, 0);
    harness.runFrames();
    assert.deepEqual(harness.notifications, [{ type: 'lost', active: false }]);
  } finally { harness.scene.dispose(); }
});
