import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseTileZoomForResolution,
  createSceneProjection,
  latToMercatorY,
  lonLatToTile,
  lonToMercatorX,
  mercatorScaleAtLat,
  mercatorXToLon,
  mercatorYToLat,
  selectTilesForMercatorBounds,
  tileToMercatorBounds,
  wrapTileX,
  EARTH_RADIUS_M,
  FEET_TO_METERS,
} from './projection.js';

test('mercator conversions round-trip and agree with the slippy tile grid', () => {
  for (const [lat, lon] of [[0, 0], [51.47, -0.46], [-33.94, 151.18], [80, 179.9]]) {
    assert.ok(Math.abs(mercatorXToLon(lonToMercatorX(lon)) - lon) < 1e-9);
    assert.ok(Math.abs(mercatorYToLat(latToMercatorY(lat)) - lat) < 1e-9);
  }
  // Tile 0/0/0 spans the whole mercator square.
  const world = tileToMercatorBounds(0, 0, 0);
  assert.ok(Math.abs(world.minX + (Math.PI * EARTH_RADIUS_M)) < 1e-6);
  assert.ok(Math.abs(world.maxY - (Math.PI * EARTH_RADIUS_M)) < 1e-6);
  // Heathrow sits in the tile the OSM formula gives for it.
  const tile = lonLatToTile(-0.4614, 51.4700, 10);
  assert.equal(Math.floor(tile.x), 510);
  assert.equal(Math.floor(tile.y), 340);
  assert.equal(wrapTileX(-1, 3), 7);
  assert.equal(wrapTileX(9, 3), 1);
});

test('the scene projection keeps the reference point at the origin and stretches altitude like the ground', () => {
  const projection = createSceneProjection({ refLat: 60, refLon: 10, floorFt: 500, verticalScale: 2 });
  const origin = projection.toScene(60, 10, 500);
  assert.ok(Math.abs(origin.x) < 1e-6 && Math.abs(origin.y) < 1e-6 && Math.abs(origin.z) < 1e-6);

  // North is -z, east is +x.
  const north = projection.toScene(61, 10, 500);
  const east = projection.toScene(60, 11, 500);
  assert.ok(north.z < 0 && Math.abs(north.x) < 1e-6);
  assert.ok(east.x > 0 && Math.abs(east.z) < 1e-6);

  // At 60N mercator doubles ground distances, so 1000 ft of altitude above
  // the floor is 1000 ft * 0.3048 * 2 (mercator) * 2 (vertical scale).
  const up = projection.toScene(60, 10, 1500);
  assert.ok(Math.abs(mercatorScaleAtLat(60) - 2) < 1e-6);
  assert.ok(Math.abs(up.y - (1000 * FEET_TO_METERS * 2 * 2)) < 1e-6);
  assert.ok(Math.abs(projection.altitudeToY(500)) < 1e-9, 'the floor is the ground plane');

  const back = projection.toLatLon(east.x, east.z);
  assert.ok(Math.abs(back.lat - 60) < 1e-9 && Math.abs(back.lon - 11) < 1e-9);
});

test('the scene projection unwraps longitudes across the antimeridian', () => {
  const projection = createSceneProjection({ refLat: 0, refLon: 179 });
  const west = projection.toScene(0, -179, 0);
  // -179 is 2 degrees east of 179, not 358 degrees west.
  assert.ok(west.x > 0);
  assert.ok(Math.abs(west.x - (lonToMercatorX(181) - lonToMercatorX(179))) < 1e-6);
});

test('tile zoom follows the requested resolution and tile selection respects the cap', () => {
  assert.equal(chooseTileZoomForResolution(1e9), 2, 'coarse resolutions clamp to the minimum zoom');
  assert.equal(chooseTileZoomForResolution(0.0001), 17, 'fine resolutions clamp to the maximum zoom');
  const zoom10 = chooseTileZoomForResolution(152.87);
  assert.equal(zoom10, 10, 'about 153 m/px is zoom 10');

  const bounds = tileToMercatorBounds(8, 100, 90);
  const inside = selectTilesForMercatorBounds({
    minX: bounds.minX + 10,
    maxX: bounds.maxX - 10,
    minY: bounds.minY + 10,
    maxY: bounds.maxY - 10,
    zoom: 10,
    maxTiles: 64,
  });
  assert.equal(inside.zoom, 10);
  assert.equal(inside.tiles.length, 16, 'one zoom-8 tile holds 16 zoom-10 tiles');
  assert.ok(inside.tiles.every((tile) => tile.wrappedX === tile.x));

  const capped = selectTilesForMercatorBounds({
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: bounds.minY,
    maxY: bounds.maxY,
    zoom: 12,
    maxTiles: 64,
  });
  assert.equal(capped.zoom, 10, 'zoom drops until the tile count fits');
  assert.ok(capped.tiles.length <= 64);
});

test('tiles past the antimeridian keep their place but wrap for the image', () => {
  const half = Math.PI * EARTH_RADIUS_M;
  const selection = selectTilesForMercatorBounds({
    minX: half - 1000,
    maxX: half + 1000,
    minY: -1000,
    maxY: 1000,
    zoom: 6,
    maxTiles: 16,
  });
  const beyond = selection.tiles.filter((tile) => tile.x >= 64);
  assert.ok(beyond.length > 0, 'tiles east of the seam are placed beyond the last column');
  assert.ok(beyond.every((tile) => tile.wrappedX === tile.x - 64));
});
