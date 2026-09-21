import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneProjection, tileToMercatorBounds } from './projection.js';
import {
  buildTileUrl,
  mercatorBoundsForTrack,
  planGroundTiles,
  OPENSTREETMAP_TILE_URL_TEMPLATE,
} from './ground-tiles.js';

const LONDON_BOSTON = { minLat: 42.36, maxLat: 51.47, minLon: -71.0, maxLon: -0.46 };

test('tile URLs use the wrapped column on the OpenStreetMap standard tile server', () => {
  assert.equal(buildTileUrl({ z: 5, x: 33, y: 10, wrappedX: 1 }), 'https://tile.openstreetmap.org/5/1/10.png');
  assert.equal(buildTileUrl({ z: 5, x: 3, y: 10 }), 'https://tile.openstreetmap.org/5/3/10.png');
  assert.equal(OPENSTREETMAP_TILE_URL_TEMPLATE, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
});

test('the base layer covers the padded track with a bounded tile count', () => {
  const padded = mercatorBoundsForTrack({ minLat: 51.4, maxLat: 51.5, minLon: -0.5, maxLon: -0.4 });
  assert.ok(padded.maxX - padded.minX >= 50000, 'short flights still get 25 km of margin each side');

  const projection = createSceneProjection({ refLat: 47, refLon: -35 });
  const planned = planGroundTiles({ trackBounds: LONDON_BOSTON, viewInfo: null, projection });
  const tiles = planned.filter((tile) => tile.layer === 'base');
  const horizon = planned.filter((tile) => tile.layer === 'horizon');
  assert.equal(planned.length, tiles.length + horizon.length, 'no detail layer without a camera');
  assert.ok(tiles.length > 0 && tiles.length <= 48);
  assert.ok(tiles.every((tile) => tile.key.startsWith('base:') && tile.url.startsWith('https://tile.openstreetmap.org/')));
  const zooms = new Set(tiles.map((tile) => tile.z));
  assert.equal(zooms.size, 1, 'one zoom for the base layer');
  assert.ok(horizon.length > 0 && horizon.length <= 24, `a coarse horizon layer surrounds the flight: ${horizon.length}`);
  assert.ok(horizon.every((tile) => tile.z < tiles[0].z), 'horizon tiles are coarser than the base layer');

  // Tile placement follows the projection: north edge is the smaller z.
  for (const tile of tiles) {
    assert.ok(tile.maxX > tile.minX && tile.maxZ > tile.minZ);
  }
  const union = tiles.reduce((acc, tile) => ({
    minX: Math.min(acc.minX, tile.minX),
    maxX: Math.max(acc.maxX, tile.maxX),
    minZ: Math.min(acc.minZ, tile.minZ),
    maxZ: Math.max(acc.maxZ, tile.maxZ),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const london = projection.toScene(51.47, -0.46, 0);
  const boston = projection.toScene(42.36, -71.0, 0);
  assert.ok(london.x <= union.maxX && london.x >= union.minX && london.z >= union.minZ && london.z <= union.maxZ);
  assert.ok(boston.x <= union.maxX && boston.x >= union.minX && boston.z >= union.minZ && boston.z <= union.maxZ);
});

test('a close camera adds a finer detail layer around its target and a far one does not', () => {
  const projection = createSceneProjection({ refLat: 47, refLon: -35 });
  const target = projection.toScene(51.47, -0.46, 0);
  const close = planGroundTiles({
    trackBounds: LONDON_BOSTON,
    viewInfo: { targetX: target.x, targetZ: target.z, distance: 8000, sceneUnitsPerPixel: 12 },
    projection,
  });
  const detail = close.filter((tile) => tile.layer === 'detail');
  const base = close.filter((tile) => tile.layer === 'base');
  assert.ok(detail.length > 0 && detail.length <= 64, `detail tiles: ${detail.length}`);
  assert.ok(detail[0].z > base[0].z, 'detail tiles are finer than the base layer');
  assert.ok(detail.some((tile) => (
    target.x >= tile.minX && target.x <= tile.maxX && target.z >= tile.minZ && target.z <= tile.maxZ
  )), 'the camera target is covered by a detail tile');

  const far = planGroundTiles({
    trackBounds: LONDON_BOSTON,
    viewInfo: { targetX: target.x, targetZ: target.z, distance: 1.2e7, sceneUnitsPerPixel: 40000 },
    projection,
  });
  assert.equal(far.filter((tile) => tile.layer === 'detail').length, 0, 'no detail layer when the base is already as sharp');
});

test('without a track the plan still drapes tiles under the camera', () => {
  const projection = createSceneProjection({ refLat: 40, refLon: -74 });
  const tiles = planGroundTiles({
    trackBounds: null,
    viewInfo: { targetX: 0, targetZ: 0, distance: 20000, sceneUnitsPerPixel: 30 },
    projection,
  });
  assert.ok(tiles.length > 0);
  assert.ok(tiles.every((tile) => tile.layer === 'detail'));
  const first = tiles[0];
  const merc = tileToMercatorBounds(first.z, first.x ?? 0, first.y ?? 0);
  assert.ok(Number.isFinite(merc.minX));
});
