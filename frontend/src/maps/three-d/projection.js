// Scene coordinates for the 3D flight views.
//
// The ground is the Web Mercator plane in metres (EPSG:3857) so that the
// same OpenStreetMap raster tiles the 2D maps use can be draped on it without
// reprojection. Scene axes follow three.js conventions: +x east, +y up,
// -z north. Mercator stretches ground distances by 1/cos(lat), so altitudes
// are stretched by the same factor at the reference latitude; angles such as
// a 3 degree glide path then look right, and any vertical exaggeration on top
// of that is an explicit, labelled choice rather than a projection artefact.

export const EARTH_RADIUS_M = 6378137;
const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;
export const FEET_TO_METERS = 0.3048;
const TILE_SIZE_PX = 256;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clampMercatorLat(lat) {
  return Math.max(-WEB_MERCATOR_MAX_LAT_DEG, Math.min(WEB_MERCATOR_MAX_LAT_DEG, Number(lat) || 0));
}

export function lonToMercatorX(lon) {
  return EARTH_RADIUS_M * (Number(lon) || 0) * DEG_TO_RAD;
}

export function latToMercatorY(lat) {
  const latRad = clampMercatorLat(lat) * DEG_TO_RAD;
  return EARTH_RADIUS_M * Math.log(Math.tan((Math.PI / 4) + (latRad / 2)));
}

export function mercatorXToLon(x) {
  return (x / EARTH_RADIUS_M) * RAD_TO_DEG;
}

export function mercatorYToLat(y) {
  return ((2 * Math.atan(Math.exp(y / EARTH_RADIUS_M))) - (Math.PI / 2)) * RAD_TO_DEG;
}

// Mercator metres per real ground metre at a latitude.
export function mercatorScaleAtLat(lat) {
  return 1 / Math.max(1e-6, Math.cos(clampMercatorLat(lat) * DEG_TO_RAD));
}

export function unwrapLongitudeNear(lon, referenceLon) {
  let value = Number(lon);
  const reference = Number(referenceLon);
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return value;
  while (value - reference > 180) value -= 360;
  while (value - reference < -180) value += 360;
  return value;
}

/**
 * A projection centred on the flight so float32 GPU vertices keep sub-metre
 * precision. `floorFt` is the altitude drawn at y = 0: sea level when the
 * ground is displaced by elevation tiles, otherwise the lowest recorded
 * altitude, so that on a flat plane at least one airport sits on the ground
 * instead of hovering (flights are recorded in MSL feet).
 */
export function createSceneProjection({
  refLat = 0,
  refLon = 0,
  floorFt = 0,
  verticalScale = 1,
} = {}) {
  const safeRefLat = clampMercatorLat(refLat);
  const safeRefLon = Number.isFinite(Number(refLon)) ? Number(refLon) : 0;
  const safeFloorFt = Number.isFinite(Number(floorFt)) ? Number(floorFt) : 0;
  const safeVerticalScale = Number.isFinite(Number(verticalScale)) && Number(verticalScale) > 0
    ? Number(verticalScale)
    : 1;
  const originX = lonToMercatorX(safeRefLon);
  const originY = latToMercatorY(safeRefLat);
  const groundScale = mercatorScaleAtLat(safeRefLat);
  const altitudeUnitsPerFoot = FEET_TO_METERS * groundScale * safeVerticalScale;

  function altitudeToY(altFt) {
    const alt = Number(altFt);
    if (!Number.isFinite(alt)) return 0;
    return (alt - safeFloorFt) * altitudeUnitsPerFoot;
  }

  function toScene(lat, lon, altFt = safeFloorFt) {
    const displayLon = unwrapLongitudeNear(lon, safeRefLon);
    return {
      x: lonToMercatorX(displayLon) - originX,
      y: altitudeToY(altFt),
      z: -(latToMercatorY(lat) - originY),
    };
  }

  function toLatLon(x, z) {
    return {
      lat: mercatorYToLat(originY - z),
      lon: mercatorXToLon(originX + x),
    };
  }

  function mercatorToScene(mercX, mercY) {
    return { x: mercX - originX, z: -(mercY - originY) };
  }

  return Object.freeze({
    refLat: safeRefLat,
    refLon: safeRefLon,
    floorFt: safeFloorFt,
    verticalScale: safeVerticalScale,
    groundScale,
    altitudeUnitsPerFoot,
    altitudeToY,
    // Convert a real ground distance in metres into scene units at the flight.
    metersToScene: (meters) => (Number(meters) || 0) * groundScale,
    sceneToMeters: (units) => (Number(units) || 0) / groundScale,
    toScene,
    toLatLon,
    mercatorToScene,
  });
}

// ---------------------------------------------------------------------------
// Slippy-map tile arithmetic (OpenStreetMap z/x/y, 256px tiles).
// ---------------------------------------------------------------------------

function tileCount(zoom) {
  return 2 ** Math.max(0, Math.floor(zoom));
}

function mercatorTileSize(zoom) {
  return (2 * Math.PI * EARTH_RADIUS_M) / tileCount(zoom);
}

export function lonLatToTile(lon, lat, zoom) {
  const n = tileCount(zoom);
  const x = ((Number(lon) + 180) / 360) * n;
  const latRad = clampMercatorLat(lat) * DEG_TO_RAD;
  const y = ((1 - (Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI)) / 2) * n;
  return { x, y };
}

export function wrapTileX(x, zoom) {
  const n = tileCount(zoom);
  return ((Math.floor(x) % n) + n) % n;
}

// Mercator bounds in metres of a tile. `x` may sit outside 0..2^z-1 when a
// track crosses the antimeridian; the bounds continue past the seam and the
// caller wraps `x` only when fetching the image.
export function tileToMercatorBounds(zoom, x, y) {
  const n = tileCount(zoom);
  const size = mercatorTileSize(zoom);
  const half = Math.PI * EARTH_RADIUS_M;
  const minX = -half + (x * size);
  const maxY = half - (y * size);
  return {
    minX,
    maxX: minX + size,
    minY: maxY - size,
    maxY,
    n,
  };
}

// Highest zoom whose tiles are at least as sharp as the requested mercator
// metres per screen pixel.
export function chooseTileZoomForResolution(metersPerPixel, { minZoom = 2, maxZoom = 17 } = {}) {
  const target = Number(metersPerPixel);
  if (!Number.isFinite(target) || target <= 0) return minZoom;
  const raw = Math.log2((2 * Math.PI * EARTH_RADIUS_M) / (TILE_SIZE_PX * target));
  return Math.max(minZoom, Math.min(maxZoom, Math.floor(raw)));
}

/**
 * Tiles covering a mercator rectangle at a zoom, lowering the zoom until the
 * count fits `maxTiles`. Returns tile coordinates with unwrapped `x` (for
 * placement) and `wrappedX` (for the image URL).
 */
export function selectTilesForMercatorBounds({
  minX,
  maxX,
  minY,
  maxY,
  zoom,
  minZoom = 2,
  maxTiles = 64,
} = {}) {
  const half = Math.PI * EARTH_RADIUS_M;
  const clampedMinY = Math.max(-half, Math.min(half, Number(minY)));
  const clampedMaxY = Math.max(-half, Math.min(half, Number(maxY)));
  if (![minX, maxX, clampedMinY, clampedMaxY].every(Number.isFinite) || maxX < minX || clampedMaxY < clampedMinY) {
    return { zoom: minZoom, tiles: [] };
  }

  let z = Math.max(minZoom, Math.floor(Number(zoom) || minZoom));
  for (;;) {
    const size = mercatorTileSize(z);
    const n = tileCount(z);
    const x0 = Math.floor((minX + half) / size);
    const x1 = Math.floor((maxX + half) / size);
    const y0 = Math.max(0, Math.floor((half - clampedMaxY) / size));
    const y1 = Math.min(n - 1, Math.floor((half - clampedMinY) / size));
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count <= maxTiles || z <= minZoom) {
      if (count > maxTiles) return { zoom: z, tiles: [] };
      const tiles = [];
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          tiles.push({ z, x, y, wrappedX: wrapTileX(x, z) });
        }
      }
      return { zoom: z, tiles };
    }
    z -= 1;
  }
}

export function buildTileKey(tile) {
  return `${tile.z}/${tile.x}/${tile.y}`;
}
