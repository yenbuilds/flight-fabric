// Which OpenStreetMap tiles to drape under a 3D flight. Two layers keep the
// request count small: a coarse base layer covering the whole track, and a
// detail layer sized to what the camera can currently see. The tile server
// is the same one the 2D maps use, so the network setting that disables it
// disables this too.

import {
  buildTileKey,
  chooseTileZoomForResolution,
  latToMercatorY,
  lonToMercatorX,
  selectTilesForMercatorBounds,
  tileToMercatorBounds,
  EARTH_RADIUS_M,
} from './projection.js';

export const OPENSTREETMAP_TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const HORIZON_LAYER_MAX_TILES = 24;
const HORIZON_LAYER_MAX_ZOOM = 7;
const HORIZON_PADDING_MIN_M = 1500000;
const HORIZON_PADDING_FRACTION = 2;
const BASE_LAYER_MAX_TILES = 48;
const BASE_LAYER_MAX_ZOOM = 12;
const DETAIL_LAYER_MAX_TILES = 64;
const DETAIL_LAYER_MAX_ZOOM = 17;
const DETAIL_HALF_SIZE_MIN_M = 3000;
const DETAIL_HALF_SIZE_MAX_M = 600000;
const BASE_PADDING_FRACTION = 0.3;
const BASE_PADDING_MIN_M = 25000;
const MERCATOR_HALF = Math.PI * EARTH_RADIUS_M;

export function buildTileUrl(tile, template = OPENSTREETMAP_TILE_URL_TEMPLATE) {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.wrappedX ?? tile.x))
    .replace('{y}', String(tile.y));
}

function toSceneTile(tile, layer, projection, template) {
  const bounds = tileToMercatorBounds(tile.z, tile.x, tile.y);
  const west = projection.mercatorToScene(bounds.minX, bounds.maxY);
  const east = projection.mercatorToScene(bounds.maxX, bounds.minY);
  return {
    key: `${layer}:${buildTileKey(tile)}`,
    url: buildTileUrl(tile, template),
    layer,
    z: tile.z,
    x: tile.x,
    y: tile.y,
    wrappedX: tile.wrappedX,
    minX: west.x,
    maxX: east.x,
    minZ: west.z,
    maxZ: east.z,
  };
}

/**
 * Mercator rectangle for the whole track, padded so the flight does not sit
 * at the edge of the map. `trackBounds` uses unwrapped longitudes.
 */
export function mercatorBoundsForTrack(trackBounds) {
  if (!trackBounds) return null;
  const minX = lonToMercatorX(trackBounds.minLon);
  const maxX = lonToMercatorX(trackBounds.maxLon);
  const minY = latToMercatorY(trackBounds.minLat);
  const maxY = latToMercatorY(trackBounds.maxLat);
  const padX = Math.max(BASE_PADDING_MIN_M, (maxX - minX) * BASE_PADDING_FRACTION);
  const padY = Math.max(BASE_PADDING_MIN_M, (maxY - minY) * BASE_PADDING_FRACTION);
  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minY: Math.max(-MERCATOR_HALF, minY - padY),
    maxY: Math.min(MERCATOR_HALF, maxY + padY),
  };
}

/**
 * Very coarse tiles far around the flight so the ground runs to the horizon
 * instead of ending at the edge of the base layer.
 */
function mercatorBoundsForHorizon(baseBounds) {
  if (!baseBounds) return null;
  const padX = Math.max(HORIZON_PADDING_MIN_M, (baseBounds.maxX - baseBounds.minX) * HORIZON_PADDING_FRACTION);
  const padY = Math.max(HORIZON_PADDING_MIN_M, (baseBounds.maxY - baseBounds.minY) * HORIZON_PADDING_FRACTION);
  return {
    minX: baseBounds.minX - padX,
    maxX: baseBounds.maxX + padX,
    minY: Math.max(-MERCATOR_HALF, baseBounds.minY - padY),
    maxY: Math.min(MERCATOR_HALF, baseBounds.maxY + padY),
  };
}

/**
 * Plan the tile set for the current view.
 *
 * - `trackBounds`: `{ minLat, maxLat, minLon, maxLon }` or null.
 * - `viewInfo`: the scene's camera summary (`targetX`, `targetZ`, `distance`,
 *   `sceneUnitsPerPixel`), or null before the camera has settled.
 * - `projection`: the scene projection, whose origin converts mercator
 *   metres to scene units.
 */
export function planGroundTiles({
  trackBounds = null,
  viewInfo = null,
  projection,
  template = OPENSTREETMAP_TILE_URL_TEMPLATE,
} = {}) {
  if (!projection) return [];
  const tiles = [];
  let baseZoom = -1;

  const baseBounds = mercatorBoundsForTrack(trackBounds);
  if (baseBounds) {
    const spanX = baseBounds.maxX - baseBounds.minX;
    const spanY = baseBounds.maxY - baseBounds.minY;
    const requestedZoom = chooseTileZoomForResolution(Math.max(spanX, spanY) / 1024, { maxZoom: BASE_LAYER_MAX_ZOOM });
    const selection = selectTilesForMercatorBounds({
      ...baseBounds,
      zoom: requestedZoom,
      maxTiles: BASE_LAYER_MAX_TILES,
    });
    baseZoom = selection.zoom;
    for (const tile of selection.tiles) tiles.push(toSceneTile(tile, 'base', projection, template));

    const horizonBounds = mercatorBoundsForHorizon(baseBounds);
    const horizonSpan = Math.max(horizonBounds.maxX - horizonBounds.minX, horizonBounds.maxY - horizonBounds.minY);
    const horizonZoom = Math.min(
      baseZoom - 1,
      chooseTileZoomForResolution(horizonSpan / 512, { maxZoom: HORIZON_LAYER_MAX_ZOOM }),
    );
    if (horizonZoom >= 2) {
      const horizon = selectTilesForMercatorBounds({
        ...horizonBounds,
        zoom: horizonZoom,
        maxTiles: HORIZON_LAYER_MAX_TILES,
      });
      if (horizon.zoom < baseZoom) {
        for (const tile of horizon.tiles) tiles.push(toSceneTile(tile, 'horizon', projection, template));
      }
    }
  }

  if (viewInfo && Number.isFinite(viewInfo.sceneUnitsPerPixel) && viewInfo.sceneUnitsPerPixel > 0) {
    const detailZoom = chooseTileZoomForResolution(viewInfo.sceneUnitsPerPixel, { maxZoom: DETAIL_LAYER_MAX_ZOOM });
    if (detailZoom > baseZoom) {
      const halfSize = Math.max(
        DETAIL_HALF_SIZE_MIN_M,
        Math.min(DETAIL_HALF_SIZE_MAX_M, (Number(viewInfo.distance) || 0) * 1.6),
      );
      const target = projection.toLatLon(viewInfo.targetX, viewInfo.targetZ);
      const centerX = lonToMercatorX(target.lon);
      const centerY = latToMercatorY(target.lat);
      const selection = selectTilesForMercatorBounds({
        minX: centerX - halfSize,
        maxX: centerX + halfSize,
        minY: centerY - halfSize,
        maxY: centerY + halfSize,
        zoom: detailZoom,
        minZoom: Math.max(2, baseZoom + 1),
        maxTiles: DETAIL_LAYER_MAX_TILES,
      });
      if (selection.zoom > baseZoom) {
        for (const tile of selection.tiles) tiles.push(toSceneTile(tile, 'detail', projection, template));
      }
    }
  }

  return tiles;
}
