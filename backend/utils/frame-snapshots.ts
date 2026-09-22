'use strict';

/**
 * Frame-reading helpers shared by the landing and takeoff runners so both
 * read position, radio height and the surface snapshot from the same fields.
 */

const { finiteNumberOrNull } = require('./aviation-frames') as {
  finiteNumberOrNull: (value: unknown) => number | null;
};
const { metersToFeet } = require('./units') as { metersToFeet: (value: number) => number };

type AnyRecord = Record<string, any>;

function isValidLatLon(lat: unknown, lon: unknown): boolean {
  const latNum = finiteNumberOrNull(lat);
  const lonNum = finiteNumberOrNull(lon);
  return latNum != null && lonNum != null && Math.abs(latNum) <= 90 && Math.abs(lonNum) <= 180;
}

/** SimConnect position first, then the generic frame position. */
function getFramePosition(frame: AnyRecord | null | undefined): { lat_deg: number | null; lon_deg: number | null } {
  const simLat = finiteNumberOrNull(frame?.simconnect?.lat);
  const simLon = finiteNumberOrNull(frame?.simconnect?.lon);
  const frameLat = finiteNumberOrNull(frame?.lat);
  const frameLon = finiteNumberOrNull(frame?.lon);
  const useSimPosition = isValidLatLon(simLat, simLon);
  const useFramePosition = isValidLatLon(frameLat, frameLon);
  return {
    lat_deg: useSimPosition ? simLat : (useFramePosition ? frameLat : null),
    lon_deg: useSimPosition ? simLon : (useFramePosition ? frameLon : null),
  };
}

/** Radio height in feet: the display value, else the raw metres converted. */
function getFrameRadioHeightFt(frame: AnyRecord | null | undefined): number | null {
  const displayRa = finiteNumberOrNull(frame?.display?.raFt);
  if (displayRa != null) return displayRa;
  const ra = finiteNumberOrNull(frame?.ra);
  return ra == null ? null : metersToFeet(ra);
}

function getSurfaceSnapshot(surface: AnyRecord | null | undefined): AnyRecord {
  return {
    surface_raw: surface && typeof surface.raw === 'number' ? surface.raw : null,
    surface_name: surface && surface.name != null ? String(surface.name) : null,
    surface_class: surface && surface.class != null ? String(surface.class) : null,
    surface_runway_like: surface && typeof surface.runwayLike === 'boolean' ? surface.runwayLike : null,
    surface_on_runway: surface && typeof surface.onRunway === 'boolean' ? surface.onRunway : null,
    surface_on_ground: surface && typeof surface.onGround === 'boolean' ? surface.onGround : true,
    surface_valid: surface && typeof surface.valid === 'boolean' ? surface.valid : null,
  };
}

module.exports = { getFramePosition, getFrameRadioHeightFt, getSurfaceSnapshot, isValidLatLon };

export {};
