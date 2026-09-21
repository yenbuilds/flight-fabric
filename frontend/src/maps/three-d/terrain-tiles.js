// Ground elevation for the 3D views from the Terrarium elevation tiles on
// AWS Open Data (Mapzen/Tilezen; SRTM, NED, EU-DEM and other public sources,
// attribution only, no key). They use the same z/x/y grid as the map tiles,
// so every draped map tile is displaced by the elevation tile that covers
// it. Decoding needs only a 2D canvas; nothing here depends on WebGL, and the
// pure helpers are unit tested.

export const TERRARIUM_TILE_URL_TEMPLATE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_MAX_ZOOM = 15;
const TERRAIN_TILE_SIZE = 256;
const TERRAIN_CACHE_LIMIT = 160;
const TERRAIN_LOAD_CONCURRENCY = 4;
// The current view uses at most 136 map tiles, often sharing elevation tiles.
const TERRAIN_PENDING_LIMIT = 160;

export function decodeTerrariumElevation(r, g, b) {
  return (r * 256) + g + (b / 256) - 32768;
}

/**
 * Decode a 256x256 RGBA pixel buffer (as from `getImageData`) into metres.
 * Voids and the ocean floor are clamped at sea level so bathymetry does not
 * dig holes under coastal flights.
 */
export function decodeTerrariumPixels(pixels, size = TERRAIN_TILE_SIZE) {
  const elevations = new Float32Array(size * size);
  for (let index = 0; index < size * size; index += 1) {
    const offset = index * 4;
    const value = decodeTerrariumElevation(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    elevations[index] = Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  return elevations;
}

/**
 * The elevation tile that covers a map tile, and the map tile's window in
 * it. Above the elevation set's maximum zoom the map tile is a sub-square of
 * the coarser elevation tile.
 */
export function terrainTileForMapTile({ z, x, y, wrappedX }, maxZoom = TERRARIUM_MAX_ZOOM) {
  const zoom = Math.min(z, maxZoom);
  const shift = z - zoom;
  const column = wrappedX ?? x;
  const scale = 2 ** shift;
  return {
    z: zoom,
    x: Math.floor(column / scale),
    y: Math.floor(y / scale),
    key: `${zoom}/${Math.floor(column / scale)}/${Math.floor(y / scale)}`,
    u0: (column % scale) / scale,
    v0: (y % scale) / scale,
    span: 1 / scale,
  };
}

export function buildTerrainTileUrl(tile, template = TERRARIUM_TILE_URL_TEMPLATE) {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/** Bilinear sample of a tile's metres at (u, v) in [0, 1], v = 0 at the north edge. */
export function sampleElevationGrid(elevations, u, v, size = TERRAIN_TILE_SIZE) {
  if (!elevations || elevations.length < size * size) return 0;
  const px = Math.max(0, Math.min(size - 1, (Math.max(0, Math.min(1, u)) * size) - 0.5));
  const py = Math.max(0, Math.min(size - 1, (Math.max(0, Math.min(1, v)) * size) - 0.5));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const fx = px - x0;
  const fy = py - y0;
  const top = (elevations[(y0 * size) + x0] * (1 - fx)) + (elevations[(y0 * size) + x1] * fx);
  const bottom = (elevations[(y1 * size) + x0] * (1 - fx)) + (elevations[(y1 * size) + x1] * fx);
  return (top * (1 - fy)) + (bottom * fy);
}

/**
 * Elevations in metres on a map tile's vertex grid, row by row from the
 * north-west corner, `(segments + 1)^2` values.
 */
export function buildTileElevationGrid(elevations, window, segments, size = TERRAIN_TILE_SIZE) {
  const count = segments + 1;
  const grid = new Float32Array(count * count);
  for (let row = 0; row < count; row += 1) {
    const v = window.v0 + ((row / segments) * window.span);
    for (let column = 0; column < count; column += 1) {
      const u = window.u0 + ((column / segments) * window.span);
      grid[(row * count) + column] = sampleElevationGrid(elevations, u, v, size);
    }
  }
  return grid;
}

/**
 * Loads, decodes and caches elevation tiles. `loadImage(url)` must resolve to
 * something a 2D canvas can draw; the default uses an `Image` with CORS.
 */
export function createTerrainProvider({
  documentRef = typeof document !== 'undefined' ? document : null,
  template = TERRARIUM_TILE_URL_TEMPLATE,
  cacheLimit = TERRAIN_CACHE_LIMIT,
  loadImage = null,
  consoleRef = console,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let inFlight = 0;
  let disposed = false;

  const defaultLoadImage = (url) => new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('Image loading is unavailable'));
      return;
    }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Elevation tile failed: ${url}`));
    image.src = url;
  });
  const resolveImage = typeof loadImage === 'function' ? loadImage : defaultLoadImage;

  function cancelledError() {
    const error = new Error('Terrain request cancelled');
    error.name = 'AbortError';
    return error;
  }

  function cancel(job) {
    job.cancelled = true;
    job.reject(cancelledError());
    if (pending.get(job.tile.key) === job) pending.delete(job.tile.key);
  }

  /** One scene owns this provider. Drop work outside its current viewport. */
  function retainTiles(keys) {
    const wanted = new Set(keys);
    for (const [key, job] of pending) if (!wanted.has(key)) cancel(job);
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].cancelled) queue.splice(index, 1);
    }
  }

  function decodeImage(image) {
    const canvas = documentRef.createElement('canvas');
    canvas.width = TERRAIN_TILE_SIZE;
    canvas.height = TERRAIN_TILE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas is unavailable for elevation decoding');
    ctx.drawImage(image, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);
    return decodeTerrariumPixels(ctx.getImageData(0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE).data);
  }

  function remember(key, elevations) {
    cache.delete(key);
    cache.set(key, elevations);
    while (cache.size > cacheLimit) {
      cache.delete(cache.keys().next().value);
    }
  }

  function pump() {
    while (!disposed && inFlight < TERRAIN_LOAD_CONCURRENCY && queue.length > 0) {
      const job = queue.shift();
      inFlight += 1;
      let loading;
      try { loading = resolveImage(buildTerrainTileUrl(job.tile, template)); }
      catch (error) { loading = Promise.reject(error); }
      Promise.resolve(loading)
        .then((image) => {
          if (job.cancelled || disposed) return;
          const elevations = decodeImage(image);
          remember(job.tile.key, elevations);
          job.resolve(elevations);
        })
        .catch((error) => {
          if (!job.cancelled && !disposed) consoleRef.warn?.('[Terrain] Elevation tile unavailable', job.tile.key, error?.message || error);
          job.reject(error);
        })
        .finally(() => {
          inFlight -= 1;
          if (pending.get(job.tile.key) === job) pending.delete(job.tile.key);
          pump();
        });
    }
  }

  /** Elevations (metres, 256x256) for a terrain tile `{ z, x, y, key }`. */
  function getElevations(tile) {
    if (disposed) return Promise.reject(cancelledError());
    if (!tile?.key) return Promise.reject(new Error('A terrain tile is required'));
    const cached = cache.get(tile.key);
    if (cached) {
      remember(tile.key, cached);
      return Promise.resolve(cached);
    }
    if (pending.has(tile.key)) return pending.get(tile.key).promise;
    if (pending.size >= TERRAIN_PENDING_LIMIT) return Promise.reject(new Error('Terrain request limit reached'));
    const job = { tile, cancelled: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    queue.push(job);
    pending.set(tile.key, job);
    pump();
    return job.promise;
  }

  function peekElevations(key) {
    return cache.get(key) || null;
  }

  function dispose() {
    disposed = true;
    retainTiles([]);
    cache.clear();
  }

  return {
    dispose,
    getElevations,
    peekElevations,
    retainTiles,
    size: () => cache.size,
  };
}
