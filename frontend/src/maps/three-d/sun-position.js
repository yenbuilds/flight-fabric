// Sun position and the lighting rig derived from it, for time-of-day
// rendering in the 3D views. The solar position follows the NOAA solar
// calculator (Meeus), accurate to a fraction of a degree, which is far finer
// than lighting needs. Night keeps a fixed "moonlight" so terrain stays
// legible; it is a lighting device, not the real moon, and is labelled so.

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - (2 * t));
}

/**
 * Sun elevation and azimuth (clockwise from north) at a UTC instant for a
 * latitude/longitude, without atmospheric refraction.
 */
export function sunPosition(dateMs, latDeg, lonDeg) {
  const time = Number(dateMs);
  const lat = Number(latDeg);
  const lon = Number(lonDeg);
  if (![time, lat, lon].every(Number.isFinite)) return null;

  const julianDay = (time / MS_PER_DAY) + 2440587.5;
  const century = (julianDay - 2451545) / 36525;
  const meanLongitude = normalizeDegrees(280.46646 + (century * (36000.76983 + (century * 0.0003032))));
  const meanAnomaly = 357.52911 + (century * (35999.05029 - (0.0001537 * century)));
  const eccentricity = 0.016708634 - (century * (0.000042037 + (0.0000001267 * century)));
  const equationOfCenter = (Math.sin(meanAnomaly * DEG) * (1.914602 - (century * (0.004817 + (0.000014 * century)))))
    + (Math.sin(2 * meanAnomaly * DEG) * (0.019993 - (0.000101 * century)))
    + (Math.sin(3 * meanAnomaly * DEG) * 0.000289);
  const trueLongitude = meanLongitude + equationOfCenter;
  const omega = 125.04 - (1934.136 * century);
  const apparentLongitude = trueLongitude - 0.00569 - (0.00478 * Math.sin(omega * DEG));
  const meanObliquity = 23 + ((26 + ((21.448 - (century * (46.815 + (century * (0.00059 - (century * 0.001813)))))) / 60)) / 60);
  const obliquity = meanObliquity + (0.00256 * Math.cos(omega * DEG));
  const declination = Math.asin(Math.sin(obliquity * DEG) * Math.sin(apparentLongitude * DEG));

  const y = Math.tan((obliquity / 2) * DEG) ** 2;
  const equationOfTimeMinutes = 4 * (
    (y * Math.sin(2 * meanLongitude * DEG))
    - (2 * eccentricity * Math.sin(meanAnomaly * DEG))
    + (4 * eccentricity * y * Math.sin(meanAnomaly * DEG) * Math.cos(2 * meanLongitude * DEG))
    - (0.5 * y * y * Math.sin(4 * meanLongitude * DEG))
    - (1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * DEG))
  ) / DEG;

  const minutesUtc = (((time % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 60000;
  const trueSolarMinutes = (((minutesUtc + equationOfTimeMinutes + (4 * lon)) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarMinutes / 4) < 0 ? (trueSolarMinutes / 4) + 180 : (trueSolarMinutes / 4) - 180;

  const latRad = lat * DEG;
  const cosZenith = (Math.sin(latRad) * Math.sin(declination))
    + (Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle * DEG));
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  const elevationDeg = 90 - (zenith / DEG);

  let azimuthDeg;
  const denominator = Math.cos(latRad) * Math.sin(zenith);
  if (Math.abs(denominator) < 1e-9) {
    azimuthDeg = 180;
  } else {
    const cosAzimuth = Math.max(-1, Math.min(1, ((Math.sin(latRad) * Math.cos(zenith)) - Math.sin(declination)) / denominator));
    const base = Math.acos(cosAzimuth) / DEG;
    azimuthDeg = hourAngle > 0 ? normalizeDegrees(base + 180) : normalizeDegrees(540 - base);
  }

  return { elevationDeg, azimuthDeg, declinationDeg: declination / DEG };
}

const LIGHTING_PHASES = Object.freeze({
  night: Object.freeze({ key: 'night', label: 'Night' }),
  dusk: Object.freeze({ key: 'dusk', label: 'Twilight' }),
  golden: Object.freeze({ key: 'golden', label: 'Low sun' }),
  day: Object.freeze({ key: 'day', label: 'Day' }),
});

export function classifyLightingPhase(elevationDeg) {
  const elevation = Number(elevationDeg);
  if (!Number.isFinite(elevation)) return 'day';
  if (elevation < -6) return 'night';
  if (elevation < 0) return 'dusk';
  if (elevation < 10) return 'golden';
  return 'day';
}

function hexToRgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((channel) => channel / 255);
}

function rgbToHex([r, g, b]) {
  return (Math.round(clamp01(r) * 255) << 16) | (Math.round(clamp01(g) * 255) << 8) | Math.round(clamp01(b) * 255);
}

function mixHex(fromHex, toHex, t) {
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);
  return rgbToHex(from.map((channel, index) => channel + ((to[index] - channel) * clamp01(t))));
}

// Rig endpoints. Daylight brightness on flat ground comes to about 1.0
// (hemisphere plus sun), night to about 0.4 from the fixed moonlight, so
// the tiles darken without losing their relief.
const RIG = Object.freeze({
  night: Object.freeze({
    hemisphereSky: 0x1a2233, hemisphereGround: 0x080b10, hemisphereIntensity: 0.32,
    fog: 0x0b1018, sky: 0x0a0e15, horizon: 0x1c2532, aircraftEmissive: 0.75,
  }),
  dusk: Object.freeze({
    hemisphereSky: 0x6f5f7a, hemisphereGround: 0x1a1a22, hemisphereIntensity: 0.4,
    fog: 0x3f3848, sky: 0x1b1a2a, horizon: 0x8a6a6e, aircraftEmissive: 0.45,
  }),
  golden: Object.freeze({
    hemisphereSky: 0xd8c2b0, hemisphereGround: 0x2b2a2e, hemisphereIntensity: 0.46,
    fog: 0x5b5560, sky: 0x2a3446, horizon: 0xc79a7a, aircraftEmissive: 0.25,
  }),
  day: Object.freeze({
    hemisphereSky: 0xe3ecff, hemisphereGround: 0x2b2f36, hemisphereIntensity: 0.5,
    fog: 0x3b4553, sky: 0x242a33, horizon: 0x4b5665, aircraftEmissive: 0.18,
  }),
});

const SUN_WARM = 0xffb36b;
const SUN_WHITE = 0xffffff;
const MOON_COLOR = 0x9db2d6;

/**
 * The full lighting rig for a sun elevation: light colours and intensities,
 * fog and sky colours and the phase label. Values blend continuously through
 * twilight so scrubbing a replay through sunset never snaps.
 */
export function lightingForSunElevation(elevationDeg) {
  const elevation = Number.isFinite(Number(elevationDeg)) ? Number(elevationDeg) : 60;
  const phase = classifyLightingPhase(elevation);
  const sunIntensity = 0.85 * smoothstep(-4, 8, elevation);
  const sunColor = mixHex(SUN_WARM, SUN_WHITE, smoothstep(2, 16, elevation));
  const moonIntensity = 0.42 * (1 - smoothstep(-8, -1, elevation));

  // Blend the rig endpoints: night -> dusk across civil twilight, dusk ->
  // golden across the horizon, golden -> day up to 15 degrees.
  let from;
  let to;
  let t;
  if (elevation < -6) {
    from = RIG.night; to = RIG.night; t = 0;
  } else if (elevation < 0) {
    from = RIG.night; to = RIG.dusk; t = smoothstep(-6, 0, elevation);
  } else if (elevation < 5) {
    from = RIG.dusk; to = RIG.golden; t = smoothstep(0, 5, elevation);
  } else {
    from = RIG.golden; to = RIG.day; t = smoothstep(5, 15, elevation);
  }
  const blend = (key) => mixHex(from[key], to[key], t);
  const blendNumber = (key) => from[key] + ((to[key] - from[key]) * t);

  return Object.freeze({
    phase,
    phaseLabel: LIGHTING_PHASES[phase].label,
    sunElevationDeg: elevation,
    sunIntensity,
    sunColor,
    moonIntensity,
    moonColor: MOON_COLOR,
    hemisphereSky: blend('hemisphereSky'),
    hemisphereGround: blend('hemisphereGround'),
    hemisphereIntensity: blendNumber('hemisphereIntensity'),
    fogColor: blend('fog'),
    skyColor: blend('sky'),
    horizonColor: blend('horizon'),
    aircraftEmissive: blendNumber('aircraftEmissive'),
  });
}

/** Daylight rig used when time-of-day lighting is switched off. */
export function daylightLighting() {
  return lightingForSunElevation(60);
}

/**
 * Unit vector toward the sun in scene axes (+x east, +y up, -z north). The
 * moon direction is the fixed night light: opposite the sun's azimuth and
 * well above the horizon.
 */
export function directionFromSky(elevationDeg, azimuthDeg) {
  const elevation = Number(elevationDeg) * DEG;
  const azimuth = Number(azimuthDeg) * DEG;
  return {
    x: Math.cos(elevation) * Math.sin(azimuth),
    y: Math.sin(elevation),
    z: -Math.cos(elevation) * Math.cos(azimuth),
  };
}

export function moonDirectionForSun(azimuthDeg) {
  return directionFromSky(55, normalizeDegrees(Number(azimuthDeg) + 180));
}

export function formatZuluTime(dateMs) {
  if (dateMs == null || dateMs === '') return '--:--Z';
  const time = Number(dateMs);
  if (!Number.isFinite(time)) return '--:--Z';
  const date = new Date(time);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}
