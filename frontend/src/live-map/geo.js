function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

export function getDistanceNm(lat1, lon1, lat2, lon2) {
  const rNm = 3440.065;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return rNm * c;
}

export function getInitialBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

export function unwrapLongitudeNear(lon, referenceLon) {
  let value = Number(lon);
  const hasReference = referenceLon != null
    && referenceLon !== ''
    && Number.isFinite(Number(referenceLon));
  if (!Number.isFinite(value) || !hasReference) return value;
  const reference = Number(referenceLon);
  while (value - reference > 180) value -= 360;
  while (value - reference < -180) value += 360;
  return value;
}

/**
 * Put a latitude/longitude path on one continuous world-copy branch.
 * Leaflet accepts longitudes outside [-180, 180] and wraps the tiles, which
 * avoids drawing a 179E -> 179W segment across the entire map.
 */
export function unwrapLatLngPath(path, referenceLon = null) {
  if (!Array.isArray(path) || path.length === 0) return [];
  const result = [];
  let previousLon = referenceLon != null
    && referenceLon !== ''
    && Number.isFinite(Number(referenceLon))
    ? Number(referenceLon)
    : Number(path[0]?.[1]);

  for (const point of path) {
    const lat = Number(point?.[0]);
    const lon = Number(point?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const unwrappedLon = unwrapLongitudeNear(lon, previousLon);
    result.push([lat, unwrappedLon]);
    previousLon = unwrappedLon;
  }
  return result;
}

export function getGreatCirclePath(lat1, lon1, lat2, lon2, isValidCoord = null) {
  if (typeof isValidCoord === 'function' && (!isValidCoord(lat1, lon1) || !isValidCoord(lat2, lon2))) {
    return [];
  }

  const phi1 = toRad(lat1);
  const lambda1 = toRad(lon1);
  const phi2 = toRad(lat2);
  const lambda2 = toRad(lon2);

  const sinHalfDLat = Math.sin((phi2 - phi1) / 2);
  const sinHalfDLon = Math.sin((lambda2 - lambda1) / 2);
  const a = sinHalfDLat ** 2 + Math.cos(phi1) * Math.cos(phi2) * sinHalfDLon ** 2;
  const delta = 2 * Math.asin(Math.min(1, Math.sqrt(a)));

  if (!Number.isFinite(delta) || delta === 0) {
    return [[lat1, lon1], [lat2, lon2]];
  }

  const distanceNm = getDistanceNm(lat1, lon1, lat2, lon2);
  const segments = Math.max(16, Math.min(128, Math.ceil(distanceNm / 120)));
  const sinDelta = Math.sin(delta);
  const points = [];

  for (let i = 0; i <= segments; i++) {
    const fraction = i / segments;
    const aWeight = Math.sin((1 - fraction) * delta) / sinDelta;
    const bWeight = Math.sin(fraction * delta) / sinDelta;

    const x = aWeight * Math.cos(phi1) * Math.cos(lambda1) + bWeight * Math.cos(phi2) * Math.cos(lambda2);
    const y = aWeight * Math.cos(phi1) * Math.sin(lambda1) + bWeight * Math.cos(phi2) * Math.sin(lambda2);
    const z = aWeight * Math.sin(phi1) + bWeight * Math.sin(phi2);

    const phi = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lambda = Math.atan2(y, x);

    points.push([toDeg(phi), toDeg(lambda)]);
  }

  return points;
}
