import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createFlightScene } from './scene.js';
import {
  buildTerrainTileUrl,
  buildTileElevationGrid,
  createTerrainProvider,
  decodeTerrariumElevation,
  decodeTerrariumPixels,
  sampleElevationGrid,
  terrainTileForMapTile,
  TERRARIUM_MAX_ZOOM,
  TERRARIUM_TILE_URL_TEMPLATE,
} from './terrain-tiles.js';

function queuedTerrain() {
  const loads = [];
  const pixels = new Uint8ClampedArray(256 * 256 * 4);
  const documentRef = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) }) };
  const provider = createTerrainProvider({ documentRef,
    loadImage: url => new Promise(resolve => { loads.push({ url, finish: () => resolve({}) }); }),
    consoleRef: { warn() {} } });
  return { provider, loads, documentRef };
}

function terrainScene(documentRef) {
  const canvas = { classList: { add() {} }, style: {}, addEventListener() {}, removeEventListener() {} };
  class Renderer {
    domElement = canvas;
    setPixelRatio() {} setSize() {} dispose() {}
  }
  class Controls extends THREE.EventDispatcher {
    target = new THREE.Vector3();
    dispose() {}
  }
  return createFlightScene({
    containerEl: { clientWidth: 800, clientHeight: 600, appendChild() {} }, documentRef,
    windowRef: { requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
    three: { THREE: { ...THREE, WebGLRenderer: Renderer }, OrbitControls: Controls, LineSegments2, LineSegmentsGeometry, LineMaterial },
  });
}

const mapTiles = () => Array.from({ length: 12 }, (_, x) => ({ z: 5, x, y: 0, key: `5/${x}/0`,
  minX: x * 100, maxX: (x + 1) * 100, minZ: 0, maxZ: 100, layer: 'base' }));
const flushLoads = () => new Promise(resolve => setImmediate(resolve));

test('removing online ground from the real scene prevents queued elevation downloads', async () => {
  const { provider, loads, documentRef } = queuedTerrain();
  const scene = terrainScene(documentRef);
  try {
    scene.setGroundTiles(mapTiles(), { terrain: { provider, unitsPerMeter: 1, floorMeters: 0 } });
    assert.equal(loads.length, 4);
    scene.setGroundTiles([]); // Both map controllers use this path when online maps are disabled.
    loads.slice().forEach(load => load.finish());
    await flushLoads();
    assert.equal(loads.length, 4, 'the eight queued tiles must never start after online maps are disabled');
    assert.equal(provider.size(), 0, 'cancelled results are discarded');
  } finally { scene.dispose(); provider.dispose(); }
});

test('terrain disposal settles both queued and active requests and rejects subsequent work', async () => {
  const { provider, loads } = queuedTerrain();
  const results = mapTiles().map(tile => provider.getElevations(tile).then(() => 'resolved', error => error.name));
  provider.dispose();
  assert.deepEqual(await Promise.all(results), Array(12).fill('AbortError'));
  await assert.rejects(provider.getElevations(mapTiles()[0]), { name: 'AbortError' });
  loads.forEach(load => load.finish());
  await flushLoads();
  assert.equal(loads.length, 4);
});

test('panning drops obsolete queued terrain and suspension waits for the next viewport before resuming', async () => {
  const { provider, loads, documentRef } = queuedTerrain();
  const scene = terrainScene(documentRef);
  const tiles = mapTiles(), options = { terrain: { provider, unitsPerMeter: 1, floorMeters: 0 } };
  try {
    scene.start();
    scene.setGroundTiles(tiles, options);
    scene.setGroundTiles(tiles.slice(8), options);
    loads.slice().forEach(load => load.finish());
    await flushLoads();
    assert.equal(loads.length, 8);
    assert.ok(loads.slice(4).every(load => /\/5\/(8|9|10|11)\/0\.png$/.test(load.url)), 'only the new viewport drains');
    scene.stop();
    scene.setGroundTiles([]);
    scene.start();
    loads.slice(4).forEach(load => load.finish());
    await flushLoads();
    assert.equal(loads.length, 8, 'resume does not request the obsolete viewport');
    scene.setGroundTiles(tiles.slice(8), options);
    assert.equal(loads.length, 12);
    loads.slice(8).forEach(load => load.finish());
    await flushLoads();
    assert.ok(Number.isFinite(scene.groundHeightAt(850, 50)), 'resumed tiles receive their elevations');
  } finally { scene.dispose(); provider.dispose(); }
});

test('resuming the same ground meshes retries cancelled elevations', async () => {
  const { provider, loads, documentRef } = queuedTerrain();
  const scene = terrainScene(documentRef);
  const tiles = mapTiles().slice(0, 4), options = { terrain: { provider, unitsPerMeter: 1, floorMeters: 0 } };
  try {
    scene.setGroundTiles(tiles, options);
    scene.stop();
    scene.setGroundTiles(tiles, options); // A controller refresh already scheduled before suspension.
    loads.slice().forEach(load => load.finish());
    await flushLoads();
    assert.equal(loads.length, 4, 'a late viewport refresh cannot restart a suspended scene');
    scene.start();
    scene.setGroundTiles(tiles, options);
    assert.equal(loads.length, 8, 'new requests survive completion of cancelled jobs with the same keys');
    loads.slice(4).forEach(load => load.finish());
    await flushLoads();
    assert.ok(Number.isFinite(scene.groundHeightAt(50, 50)));
  } finally { scene.dispose(); provider.dispose(); }
});

test('terrain queue is bounded and a throwing image loader does not stall it', async () => {
  const { provider } = queuedTerrain();
  const results = Array.from({ length: 200 }, (_, x) => provider.getElevations({ z: 8, x, y: 0, key: `8/${x}/0` })
    .then(() => '', error => error.message));
  provider.dispose();
  assert.equal((await Promise.all(results)).filter(message => /limit/.test(message)).length, 40);
  const throwing = createTerrainProvider({ loadImage() { throw new Error('Image unavailable'); }, consoleRef: { warn() {} } });
  try {
    for (const tile of mapTiles()) await assert.rejects(throwing.getElevations(tile), /Image unavailable/);
  } finally { throwing.dispose(); }
});

test('completion of a cancelled tile does not remove a replacement request for the same tile', async () => {
  const { provider, loads } = queuedTerrain();
  const tile = mapTiles()[0];
  const first = provider.getElevations(tile).catch(error => error.name);
  provider.retainTiles([]);
  const replacement = provider.getElevations(tile);
  loads[0].finish();
  await flushLoads();
  assert.equal(await first, 'AbortError');
  assert.equal(provider.getElevations(tile), replacement, 'the new owner still coalesces with its own request');
  loads[1].finish();
  await replacement;
  provider.dispose();
});

test('terrarium pixels decode to metres and never dig below sea level', () => {
  // 32768 m offset: (128 * 256 + 0 + 0) - 32768 = 0 m.
  assert.equal(decodeTerrariumElevation(128, 0, 0), 0);
  // Mont Blanc-ish: 4808 m -> 32768 + 4808 = 37576 = 146 * 256 + 200.
  assert.ok(Math.abs(decodeTerrariumElevation(146, 200, 0) - 4808) < 1e-9);
  assert.ok(Math.abs(decodeTerrariumElevation(146, 200, 128) - 4808.5) < 1e-9);
  const pixels = new Uint8ClampedArray(4 * 4);
  pixels.set([146, 200, 0, 255, 100, 0, 0, 255, 128, 10, 0, 255, 0, 0, 0, 255]);
  const decoded = decodeTerrariumPixels(pixels, 2);
  assert.equal(decoded.length, 4);
  assert.ok(Math.abs(decoded[0] - 4808) < 1e-9);
  assert.equal(decoded[1], 0, 'ocean floor clamps to sea level');
  assert.equal(decoded[2], 10);
  assert.equal(decoded[3], 0);
});

test('map tiles above the elevation zoom map to a window of the coarser elevation tile', () => {
  assert.equal(TERRARIUM_MAX_ZOOM, 15);
  const same = terrainTileForMapTile({ z: 12, x: 1200, y: 1500 });
  assert.deepEqual({ z: same.z, x: same.x, y: same.y }, { z: 12, x: 1200, y: 1500 });
  assert.deepEqual([same.u0, same.v0, same.span], [0, 0, 1]);

  const finer = terrainTileForMapTile({ z: 17, x: 38403, y: 48002, wrappedX: 38403 });
  assert.equal(finer.z, 15);
  assert.equal(finer.x, Math.floor(38403 / 4));
  assert.equal(finer.y, Math.floor(48002 / 4));
  assert.equal(finer.span, 0.25);
  assert.ok(Math.abs(finer.u0 - ((38403 % 4) / 4)) < 1e-12);
  assert.ok(Math.abs(finer.v0 - ((48002 % 4) / 4)) < 1e-12);
  assert.equal(finer.key, `15/${Math.floor(38403 / 4)}/${Math.floor(48002 / 4)}`);

  const wrapped = terrainTileForMapTile({ z: 13, x: 8300, y: 100, wrappedX: 108 });
  assert.equal(wrapped.x, 108, 'the wrapped column is used for the image');
  assert.equal(buildTerrainTileUrl({ z: 15, x: 9600, y: 12000 }), 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/9600/12000.png');
  assert.equal(TERRARIUM_TILE_URL_TEMPLATE, 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png');
});

test('elevation grids sample bilinearly', () => {
  const size = 4;
  // A ramp rising to the east: 0, 100, 200, 300 metres per column.
  const elevations = Float32Array.from({ length: size * size }, (_, index) => (index % size) * 100);
  assert.ok(Math.abs(sampleElevationGrid(elevations, 0, 0.5, size) - 0) < 1e-9, 'west edge');
  assert.ok(Math.abs(sampleElevationGrid(elevations, 1, 0.5, size) - 300) < 1e-9, 'east edge');
  assert.ok(Math.abs(sampleElevationGrid(elevations, 0.5, 0.5, size) - 150) < 1e-9, 'halfway');
  assert.equal(sampleElevationGrid(null, 0.5, 0.5, size), 0);

  const grid = buildTileElevationGrid(elevations, { u0: 0, v0: 0, span: 1 }, 2, size);
  assert.equal(grid.length, 9);
  assert.ok(Math.abs(grid[0]) < 1e-9 && Math.abs(grid[2] - 300) < 1e-9 && Math.abs(grid[1] - 150) < 1e-9);
  const window = buildTileElevationGrid(elevations, { u0: 0.5, v0: 0, span: 0.5 }, 2, size);
  assert.ok(Math.abs(window[0] - 150) < 1e-9 && Math.abs(window[2] - 300) < 1e-9, 'a window samples the eastern half');
});

test('the terrain provider decodes, caches and coalesces tile loads', async () => {
  const loads = [];
  const pixels = new Uint8ClampedArray(256 * 256 * 4);
  for (let index = 0; index < 256 * 256; index += 1) {
    pixels[index * 4] = 129; // 256 m
    pixels[(index * 4) + 3] = 255;
  }
  const documentRef = {
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: pixels }),
      }),
    }),
  };
  const provider = createTerrainProvider({
    documentRef,
    loadImage: (url) => {
      loads.push(url);
      return Promise.resolve({});
    },
    cacheLimit: 2,
    consoleRef: { warn() {} },
  });
  const tile = { z: 12, x: 5, y: 6, key: '12/5/6' };
  const [first, second] = await Promise.all([provider.getElevations(tile), provider.getElevations(tile)]);
  assert.equal(loads.length, 1, 'concurrent requests for one tile share a load');
  assert.equal(first, second);
  assert.equal(first.length, 256 * 256);
  assert.equal(first[0], 256);
  assert.equal(provider.peekElevations('12/5/6'), first);
  await provider.getElevations(tile);
  assert.equal(loads.length, 1, 'cached tiles are not reloaded');

  await provider.getElevations({ z: 12, x: 5, y: 7, key: '12/5/7' });
  await provider.getElevations({ z: 12, x: 5, y: 8, key: '12/5/8' });
  assert.equal(provider.size(), 2, 'the cache is bounded');
  assert.equal(provider.peekElevations('12/5/6'), null, 'the oldest tile is evicted');

  const failing = createTerrainProvider({
    documentRef,
    loadImage: () => Promise.reject(new Error('offline')),
    consoleRef: { warn() {} },
  });
  await assert.rejects(failing.getElevations({ z: 1, x: 0, y: 0, key: '1/0/0' }), /offline/);
  provider.dispose();
});
