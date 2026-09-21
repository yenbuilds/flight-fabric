// Vertex data for the 3D flight track: the coloured path at altitude, the
// translucent curtain that drops from it to the ground, and its ground
// shadow. Everything here is plain arrays so it can be unit tested without a
// WebGL context; the scene wrapper only uploads the buffers.

import { unwrapLongitudeNear } from './projection.js';

const EARTH_RADIUS_NM = 3440.065;
const DEG_TO_RAD = Math.PI / 180;

// Validated against the dark path outline (#152536) with the dataviz palette
// checks: one hue per sequential ramp, monotone lightness, and the diverging
// pair keeps a neutral midpoint so level flight reads as "neither".
export const TRACK_COLOR_MODES = Object.freeze({
  altitude: Object.freeze({
    key: 'altitude',
    label: 'Altitude',
    unit: 'ft',
    kind: 'sequential',
    stops: Object.freeze(['#008096', '#2f9bb2', '#51b8cf', '#70d5ed', '#8befff']),
  }),
  groundSpeed: Object.freeze({
    key: 'groundSpeed',
    label: 'Ground speed',
    unit: 'kt',
    kind: 'sequential',
    stops: Object.freeze(['#a56d0f', '#bf8532', '#d99e4d', '#f4b768', '#ffd181']),
  }),
  verticalSpeed: Object.freeze({
    key: 'verticalSpeed',
    label: 'Vertical speed',
    unit: 'fpm',
    kind: 'diverging',
    stops: Object.freeze(['#d99e4d', '#c2cad4', '#51b8cf']),
    poleLabels: Object.freeze({ low: 'Descent', mid: 'Level', high: 'Climb' }),
  }),
});

export const TRACK_COLOR_MODE_KEYS = Object.freeze(Object.keys(TRACK_COLOR_MODES));
export const DEFAULT_TRACK_COLOR_MODE = 'altitude';

export function normalizeTrackColorMode(value) {
  return TRACK_COLOR_MODE_KEYS.includes(value) ? value : DEFAULT_TRACK_COLOR_MODE;
}

function hexToRgb(hex) {
  const value = String(hex).replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  ];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308 ? clamped * 12.92 : (1.055 * (clamped ** (1 / 2.4))) - 0.055;
}

function rgbToOklab([r, g, b]) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt((0.4122214708 * lr) + (0.5363325363 * lg) + (0.0514459929 * lb));
  const m = Math.cbrt((0.2119034982 * lr) + (0.6806995451 * lg) + (0.1073969566 * lb));
  const s = Math.cbrt((0.0883024619 * lr) + (0.2817188376 * lg) + (0.6299787005 * lb));
  return [
    (0.2104542553 * l) + (0.7936177850 * m) - (0.0040720468 * s),
    (1.9779984951 * l) - (2.4285922050 * m) + (0.4505937099 * s),
    (0.0259040371 * l) + (0.7827717662 * m) - (0.8086757660 * s),
  ];
}

function oklabToRgb([L, a, b]) {
  const l = (L + (0.3963377774 * a) + (0.2158037573 * b)) ** 3;
  const m = (L - (0.1055613458 * a) - (0.0638541728 * b)) ** 3;
  const s = (L - (0.0894841775 * a) - (1.2914855480 * b)) ** 3;
  return [
    linearToSrgb((4.0767416621 * l) - (3.3077115913 * m) + (0.2309699292 * s)),
    linearToSrgb((-1.2684380046 * l) + (2.6097574011 * m) - (0.3413193965 * s)),
    linearToSrgb((-0.0041960863 * l) - (0.7034186147 * m) + (1.7076147010 * s)),
  ];
}

const rampCache = new Map();

function getRampLab(stops) {
  const key = stops.join(',');
  if (!rampCache.has(key)) rampCache.set(key, stops.map((hex) => rgbToOklab(hexToRgb(hex))));
  return rampCache.get(key);
}

// Interpolate a ramp in OKLab so the midpoints keep their perceived lightness.
export function sampleRamp(stops, t) {
  const lab = getRampLab(stops);
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const scaled = clamped * (lab.length - 1);
  const index = Math.min(lab.length - 2, Math.floor(scaled));
  const fraction = scaled - index;
  const from = lab[index];
  const to = lab[index + 1];
  return oklabToRgb([
    from[0] + ((to[0] - from[0]) * fraction),
    from[1] + ((to[1] - from[1]) * fraction),
    from[2] + ((to[2] - from[2]) * fraction),
  ]);
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a = (Math.sin(dLat / 2) ** 2)
    + (Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * (Math.sin(dLon / 2) ** 2));
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Fill in ground speed and vertical speed from neighbouring samples when the
 * source did not record them. Recorded values always win; derived values are
 * marked so the legend can say so. Altitude gaps carry the last known value.
 */
export function derivePointMetrics(segments) {
  let derivedAny = false;
  const result = (Array.isArray(segments) ? segments : []).map((segment) => {
    const points = Array.isArray(segment) ? segment : [];
    let lastAlt = null;
    return points.map((point, index) => {
      const lat = finiteOrNull(point?.lat);
      const lon = finiteOrNull(point?.lon);
      let altFt = finiteOrNull(point?.altFt);
      if (altFt === null) altFt = lastAlt;
      if (altFt !== null) lastAlt = altFt;

      let gsKts = finiteOrNull(point?.gsKts);
      let vsFpm = finiteOrNull(point?.vsFpm);
      const timestampMs = finiteOrNull(point?.timestampMs);
      const neighbor = points[index + 1] || points[index - 1] || null;
      if ((gsKts === null || vsFpm === null) && neighbor) {
        const neighborTs = finiteOrNull(neighbor.timestampMs);
        const dtHours = timestampMs !== null && neighborTs !== null
          ? Math.abs(neighborTs - timestampMs) / 3_600_000
          : null;
        if (dtHours !== null && dtHours > 0) {
          const neighborLat = finiteOrNull(neighbor.lat);
          const neighborLon = finiteOrNull(neighbor.lon);
          if (gsKts === null && lat !== null && lon !== null && neighborLat !== null && neighborLon !== null) {
            gsKts = haversineNm(lat, lon, neighborLat, neighborLon) / dtHours;
            derivedAny = true;
          }
          const neighborAlt = finiteOrNull(neighbor.altFt);
          if (vsFpm === null && altFt !== null && neighborAlt !== null) {
            const sign = neighborTs >= (timestampMs ?? 0) ? 1 : -1;
            vsFpm = (sign * (neighborAlt - altFt)) / (dtHours * 60);
            derivedAny = true;
          }
        }
      }

      return {
        ...point,
        lat,
        lon,
        altFt,
        gsKts,
        vsFpm,
        iasKts: finiteOrNull(point?.iasKts),
        timestampMs,
      };
    });
  });
  return { segments: result, derived: derivedAny };
}

function metricForMode(point, mode) {
  if (mode === 'groundSpeed') return finiteOrNull(point?.gsKts);
  if (mode === 'verticalSpeed') return finiteOrNull(point?.vsFpm);
  return finiteOrNull(point?.altFt);
}

function niceStep(range, targetTicks = 4) {
  if (!(range > 0)) return 1;
  const rough = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor = normalized >= 5 ? 5 : (normalized >= 2 ? 2 : 1);
  return factor * magnitude;
}

/**
 * Colour scale for a track: the value range seen in the data, a colour lookup
 * per point, and legend labels. Diverging modes centre on zero with symmetric
 * arms so a climb and a descent of equal rate get equal saturation.
 */
export function buildTrackColorScale(segments, modeKey = DEFAULT_TRACK_COLOR_MODE) {
  const mode = TRACK_COLOR_MODES[normalizeTrackColorMode(modeKey)];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const segment of Array.isArray(segments) ? segments : []) {
    for (const point of Array.isArray(segment) ? segment : []) {
      const value = metricForMode(point, mode.key);
      if (value === null) continue;
      count += 1;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (count === 0) {
    min = 0;
    max = 0;
  }

  let lower = min;
  let upper = max;
  if (mode.kind === 'diverging') {
    const arm = Math.max(Math.abs(min), Math.abs(max), 100);
    lower = -arm;
    upper = arm;
  } else if (upper - lower < 1e-6) {
    upper = lower + 1;
  }

  const span = upper - lower;
  const fallback = sampleRamp(mode.stops, mode.kind === 'diverging' ? 0.5 : 0);

  function colorFor(point) {
    const value = metricForMode(point, mode.key);
    if (value === null) return fallback;
    return sampleRamp(mode.stops, (value - lower) / span);
  }

  const step = niceStep(span);
  const ticks = [];
  const first = Math.ceil(lower / step) * step;
  for (let value = first; value <= upper + 1e-9 && ticks.length < 12; value += step) {
    ticks.push({
      value: Math.round(value),
      t: (value - lower) / span,
    });
  }

  return Object.freeze({
    mode: mode.key,
    label: mode.label,
    unit: mode.unit,
    kind: mode.kind,
    stops: mode.stops,
    poleLabels: mode.poleLabels || null,
    hasData: count > 0,
    min: count > 0 ? min : null,
    max: count > 0 ? max : null,
    lower,
    upper,
    ticks,
    colorFor,
    gradientCss: `linear-gradient(90deg, ${mode.stops.join(', ')})`,
  });
}

/** Lowest recorded altitude, the level drawn as the ground plane. */
export function computeTrackFloorFt(segments) {
  let floor = Number.POSITIVE_INFINITY;
  for (const segment of Array.isArray(segments) ? segments : []) {
    for (const point of Array.isArray(segment) ? segment : []) {
      const alt = finiteOrNull(point?.altFt);
      if (alt !== null && alt < floor) floor = alt;
    }
  }
  return Number.isFinite(floor) ? Math.floor(floor / 50) * 50 : 0;
}

/** Geographic centre and extent of a track, unwrapped around its first point. */
export function computeTrackBounds(segments) {
  let referenceLon = null;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const segment of Array.isArray(segments) ? segments : []) {
    for (const point of Array.isArray(segment) ? segment : []) {
      const lat = finiteOrNull(point?.lat);
      const lon = finiteOrNull(point?.lon);
      if (lat === null || lon === null) continue;
      if (referenceLon === null) referenceLon = lon;
      const displayLon = unwrapLongitudeNear(lon, referenceLon);
      count += 1;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (displayLon < minLon) minLon = displayLon;
      if (displayLon > maxLon) maxLon = displayLon;
    }
  }
  if (count === 0) return null;
  return {
    minLat,
    maxLat,
    minLon,
    maxLon,
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2,
    pointCount: count,
  };
}

function extendBounds(bounds, x, y, z) {
  if (x < bounds.minX) bounds.minX = x;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (y > bounds.maxY) bounds.maxY = y;
  if (z < bounds.minZ) bounds.minZ = z;
  if (z > bounds.maxZ) bounds.maxZ = z;
}

/**
 * Build the vertex buffers for a track. The path and shadow are segment
 * pairs (so gaps between segments stay open); the curtain is two triangles
 * per span between the path and the ground plane.
 */
export function buildTrackGeometry(segments, projection, colorScale) {
  const pathPositions = [];
  const pathColors = [];
  const shadowPositions = [];
  const curtainPositions = [];
  const curtainColors = [];
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
  let pointCount = 0;
  let spanCount = 0;

  for (const segment of Array.isArray(segments) ? segments : []) {
    const points = Array.isArray(segment) ? segment : [];
    let previous = null;
    for (const point of points) {
      const lat = finiteOrNull(point?.lat);
      const lon = finiteOrNull(point?.lon);
      if (lat === null || lon === null) continue;
      const altFt = finiteOrNull(point?.altFt);
      const scene = projection.toScene(lat, lon, altFt === null ? projection.floorFt : altFt);
      const color = colorScale.colorFor(point);
      const current = { x: scene.x, y: Math.max(0, scene.y), z: scene.z, color };
      pointCount += 1;
      extendBounds(bounds, current.x, current.y, current.z);

      if (previous) {
        spanCount += 1;
        pathPositions.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
        pathColors.push(...previous.color, ...current.color);
        shadowPositions.push(previous.x, 0, previous.z, current.x, 0, current.z);

        // Two triangles: previous-top, previous-ground, current-top and
        // previous-ground, current-ground, current-top.
        curtainPositions.push(
          previous.x, previous.y, previous.z,
          previous.x, 0, previous.z,
          current.x, current.y, current.z,
          previous.x, 0, previous.z,
          current.x, 0, current.z,
          current.x, current.y, current.z,
        );
        curtainColors.push(
          ...previous.color, ...previous.color, ...current.color,
          ...previous.color, ...current.color, ...current.color,
        );
      }
      previous = current;
    }
  }

  if (pointCount === 0) {
    return {
      pointCount: 0,
      spanCount: 0,
      pathPositions: new Float32Array(0),
      pathColors: new Float32Array(0),
      shadowPositions: new Float32Array(0),
      curtainPositions: new Float32Array(0),
      curtainColors: new Float32Array(0),
      bounds: null,
    };
  }

  if (bounds.minY === bounds.maxY) bounds.maxY = bounds.minY + 1;

  return {
    pointCount,
    spanCount,
    pathPositions: Float32Array.from(pathPositions),
    pathColors: Float32Array.from(pathColors),
    shadowPositions: Float32Array.from(shadowPositions),
    curtainPositions: Float32Array.from(curtainPositions),
    curtainColors: Float32Array.from(curtainColors),
    bounds,
  };
}
