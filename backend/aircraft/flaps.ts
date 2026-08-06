// flaps.js
// Centralizes flaps mapping and sanitized object creation.
// Reads configuration from aircraft profiles via aircraft-profile-loader.js.
// Falls back to simulator physical flap angle when no profile mapping is active.
//
// Preferred data sources:
// 1) aircraft-specific flap LVARs, when configured by profile and connected
// 2) active aircraft profile detents from discrete handle index
// 3) physical flap deflection angle from simulator telemetry
// 4) raw handle percent as a last-resort fallback

'use strict';

type GenericRecord = Record<string, any>;

let profileLoaderApi: GenericRecord | null | undefined;

/**
 * Format a raw flap value without applying aircraft profile notch mappings.
 */
function formatRawFlapLabel(value: unknown, suffix = ''): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (Math.abs(numeric) < 0.5) return 'UP';
  const rounded = Math.round(numeric * 10) / 10;
  return `${rounded}${suffix}`;
}

function getProfileLoader(): GenericRecord | null {
  if (profileLoaderApi !== undefined) return profileLoaderApi;
  try {
    profileLoaderApi = require('./aircraft-profile-loader');
  } catch (_err) {
    profileLoaderApi = null;
  }
  return profileLoaderApi;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getActiveFlapsConfig(): GenericRecord | null {
  const loader = getProfileLoader();
  const flaps = loader?.getFlapsConfig?.();
  return flaps && typeof flaps === 'object' ? flaps : null;
}

function getProfileNotches(): GenericRecord[] {
  const notches = getActiveFlapsConfig()?.notches;
  if (!Array.isArray(notches)) return [];
  return notches.filter((notch) => notch && typeof notch === 'object' && finiteNumberOrNull(notch.value) !== null);
}

function normalizeRawPercent(raw: unknown): number | null {
  const numeric = finiteNumberOrNull(raw);
  if (numeric === null) return null;
  return Math.max(0, Math.min(100, numeric));
}

function makeProfileFlapsObj(notch: GenericRecord, rawPercent: number | null): GenericRecord | null {
  const value = finiteNumberOrNull(notch.value);
  if (value === null) return null;

  const label = formatRawFlapLabel(notch.label ?? value) || formatRawFlapLabel(value);

  return {
    notch: value,
    label,
    percent: rawPercent !== null ? Math.round(rawPercent) : null,
    fraction: rawPercent !== null ? rawPercent / 100 : null,
    inTransit: false,
    direction: null,
    currentNotch: value,
    targetNotch: value,
    source: 'profile',
  };
}

function findProfileNotchFromIndex(flapsIndex: unknown, notches: GenericRecord[]): GenericRecord | null {
  const index = finiteNumberOrNull(flapsIndex);
  if (index === null) return null;

  // SimConnect FLAPS HANDLE INDEX is a 0-N slot, not the cockpit flap label.
  // Keep exact-value fallback only for non-SimConnect sources that may hand us
  // an out-of-range detent value directly.
  const roundedIndex = Math.round(index);
  if (Math.abs(index - roundedIndex) <= 0.001 && roundedIndex >= 0 && roundedIndex < notches.length) {
    return notches[roundedIndex];
  }

  return notches.find((notch) => finiteNumberOrNull(notch.value) === index) || null;
}

/**
 * Convert raw handle percent to a simple percent flap state.
 * Legacy name retained for existing call sites; profile mapping happens in makeFlapsObj().
 * @param {number} raw - Flaps position as 0-100 percent (from SimConnect FLAPS HANDLE PERCENT)
 * @returns {Object} Raw percent flap state.
 */
function mapFlapsRawToNotch(raw: unknown): GenericRecord {
  const num = Number(raw);
  if (Number.isNaN(num)) return { raw, notch: null, percent: null, fraction: null };

  const rawPercent = Math.round(Math.max(0, Math.min(100, num)));
  const rawFraction = rawPercent / 100;
  return {
    raw: num,
    notch: rawPercent,
    label: formatRawFlapLabel(rawPercent, '%'),
    percent: rawPercent,
    fraction: rawFraction,
    rawPercent,
    inTransit: false,
  };
}

function makeFlapsObjFromLvar(raw: unknown): GenericRecord | null {
  if (raw == null) return null;
  const numeric = Number(raw);
  const label = formatRawFlapLabel(raw);
  if (!Number.isFinite(numeric) && !label) return null;
  const notch = Number.isFinite(numeric) ? numeric : null;
  return {
    raw,
    notch,
    label,
    percent: null,
    fraction: null,
    inTransit: false,
    direction: null,
    currentNotch: notch,
    targetNotch: notch,
    source: 'lvar',
  };
}

/**
 * Create flaps object from raw simulator values.
 * @param {number} raw - Flaps position as 0-100 percent (from SimConnect FLAPS HANDLE PERCENT)
 * @param {number|null} [flapsIndex] - FLAPS HANDLE INDEX value, used as a profile fallback when handle percent is unavailable.
 * @param {number|null} [flapsAngleDeg] - TRAILING EDGE FLAPS LEFT ANGLE in degrees.
 * @returns {Object} Flaps state object with notch, label, percent, etc.
 */
function makeFlapsObj(raw: unknown, flapsIndex?: number | null, flapsAngleDeg?: number | null): GenericRecord {
  const profileNotches = getProfileNotches();
  if (profileNotches.length > 0) {
    const rawPercent = normalizeRawPercent(raw);
    const byIndex = findProfileNotchFromIndex(flapsIndex, profileNotches);
    if (byIndex) {
      const mapped = makeProfileFlapsObj(byIndex, rawPercent);
      if (mapped) return mapped;
    }
  }

  // Use actual physical deflection angle (degrees) only when no profile detent
  // mapping applies.
  if (typeof flapsAngleDeg === 'number' && Number.isFinite(flapsAngleDeg)) {
    const angleDeg = Math.round(flapsAngleDeg);
    const rawPercent = normalizeRawPercent(raw);
    return {
      notch: angleDeg,
      label: angleDeg <= 0 ? 'UP' : `${angleDeg} deg`,
      percent: rawPercent !== null ? Math.round(rawPercent) : null,
      fraction: rawPercent != null ? rawPercent / 100 : null,
      inTransit: false,
      direction: null,
      source: 'angle-generic',
    };
  }

  // Final fallback: raw handle percent if no physical angle is available.
  const mapped = mapFlapsRawToNotch(raw);
  return {
    notch: mapped.notch,
    label: mapped.label || null,
    percent: mapped.percent,
    fraction: mapped.fraction,
    inTransit: !!mapped.inTransit,
    direction: mapped.direction || null,
    currentNotch: typeof mapped.currentNotch === 'number' ? mapped.currentNotch : (mapped.inTransit ? mapped.lowerNotch : undefined),
    targetNotch: typeof mapped.targetNotch === 'number' ? mapped.targetNotch : (mapped.inTransit ? mapped.upperNotch : undefined),
    source: 'percent',
  };
}

/**
 * @returns {number[]} Active aircraft flap notch values, or [] when unavailable.
 */
function getValidNotches(): number[] {
  return getProfileNotches()
    .map((notch) => finiteNumberOrNull(notch.value))
    .filter((value): value is number => value !== null);
}

/**
 * @returns {number[]} Active aircraft landing flap notch values, or [] when unavailable.
 */
function getLandingNotches(): number[] {
  const landingNotches = getActiveFlapsConfig()?.landingNotches;
  if (!Array.isArray(landingNotches)) return [];
  return landingNotches
    .map((value) => finiteNumberOrNull(value))
    .filter((value): value is number => value !== null);
}

/**
 * Check if current flap setting is valid for landing.
 * @param {number} notchValue - Flap value
 * @returns {boolean}
 */
function isLandingFlaps(notchValue: unknown): boolean {
  const landingNotches = getLandingNotches();
  if (landingNotches.length === 0) return true;
  const numeric = finiteNumberOrNull(notchValue);
  return numeric !== null && landingNotches.includes(numeric);
}

/**
 * Get max active profile notch value, or the legacy percent max.
 * @returns {number}
 */
function getMaxNotch(): number {
  const validNotches = getValidNotches();
  return validNotches.length > 0 ? Math.max(...validNotches) : 100;
}

const flapsApi = {
  mapFlapsRawToNotch,
  makeFlapsObjFromLvar,
  makeFlapsObj,
  getValidNotches,
  getLandingNotches,
  isLandingFlaps,
  getMaxNotch,
};

module.exports = flapsApi;

export {};
