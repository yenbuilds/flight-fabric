// spoilers.js
// Profile-driven spoiler mapping: raw value -> percent/fraction/state.
//
// DATA SOURCE: SimConnect SPOILERS HANDLE POSITION (0-100 percent)
// As of V1, SimConnect is the ONLY production data source.
//
// Reads scale configuration from aircraft profiles via aircraft-profile-loader.js.
// Supported scales (defined in aircraft profiles):
// - 'fraction': Pre-normalized 0..1
// - 'percent': Pre-normalized 0..100 (SimConnect default)
//
// Exports:
//   - mapSpoilersRawToPercent(raw, options)
//   - makeSpoilersObj(raw, options)  -> { percent, fraction, state }

'use strict';

const profileLoader = require('./aircraft-profile-loader.js') as {
  getSpoilersConfig: () => { armedValue?: number; maxValue?: number; scale?: string } | null;
};

type SpoilersState = {
  fraction: number | null;
  percent: number | null;
  state: string | null;
};

let lastKnownSpoilers: SpoilersState = { percent: 0, fraction: 0, state: 'STOWED' };

/**
 * Get spoiler scale configuration from active profile.
 * @returns {{scale: string, maxValue: number, armedValue?: number}}
 */
function getSpoilersScaleConfig(): {
  armedValue?: number;
  maxValue: number;
  scale: string;
} {
  const config = profileLoader.getSpoilersConfig();

  if (!config) {
    // No profile - SimConnect provides 0-100 percent
    return {
      scale: 'percent',
      maxValue: 100,
      armedValue: undefined,
    };
  }

  return {
    scale: config.scale || 'percent',
    maxValue: config.maxValue || 100,
    armedValue: config.armedValue,
  };
}

/**
 * Map raw spoiler lever value to percent/fraction/state.
 * Uses profile configuration for scale-specific thresholds.
 *
 * @param {number} raw - Raw spoiler value (any scale)
 * @param {{scale?: 'auto'|'fraction'|'percent', armed?: boolean}} options
 * @returns {{raw:number, percent:number|null, fraction:number|null, state:string|null}}
 */
function mapSpoilersRawToPercent(
  raw: unknown,
  options: { armed?: boolean; scale?: 'auto' | 'fraction' | 'percent' } = {},
): {
  fraction: number | null;
  percent: number | null;
  raw: unknown;
  state: string | null;
} {
  // Guard against null/undefined which Number() would coerce to 0
  if (raw === null || typeof raw === 'undefined') {
    return { raw, percent: null, fraction: null, state: null };
  }
  // Preserve invalid strings (e.g., empty) as invalid
  if (typeof raw === 'string' && raw.trim() === '') {
    return { raw, percent: null, fraction: null, state: null };
  }

  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return { raw, percent: null, fraction: null, state: null };
  }

  // Get scale config from profile
  const scaleConfig = getSpoilersScaleConfig();

  // Determine scale: use explicit option or profile default
  let scale: 'fraction' | 'percent';
  if (options.scale && options.scale !== 'auto') {
    scale = options.scale;
  } else if (scaleConfig.scale === 'fraction' || scaleConfig.scale === 'percent') {
    scale = scaleConfig.scale;
  } else {
    scale = 'percent';
  }

  const armed = options.armed === true;

  // Handle based on detected/specified scale
  switch (scale) {
    case 'fraction': {
      // Already normalized 0-1
      const clamped = Math.max(0, Math.min(1, num));
      const percent = Math.round(clamped * 100);
      // Physical deployment wins over armed: once the surfaces are
      // actually deflected (>0%) the state is EXTENDED, even if the
      // SPOILERS ARMED bool is still latched on. ARMED only describes
      // a stowed-but-armed lever, but with `fraction`/`percent` semantics
      // that distinction collapses to "percent==0".
      const state = (percent === 0)
        ? (armed ? 'ARMED' : 'STOWED')
        : 'EXTENDED';
      return { raw: num, percent, fraction: clamped, state };
    }

    case 'percent':
    default: {
      // Percent 0-100 (SimConnect default)
      const clamped = Math.max(0, Math.min(100, num));
      const fraction = clamped / 100;
      // See note above: physical deployment wins over armed.
      const state = (clamped === 0)
        ? (armed ? 'ARMED' : 'STOWED')
        : 'EXTENDED';
      return { raw: num, percent: Math.round(clamped), fraction, state };
    }
  }
}

/**
 * Wrap the mapping with caching + fallback:
 * - If mapping invalid -> return lastKnownSpoilers
 * - Otherwise update lastKnownSpoilers and return it.
 *
 * @param {number|null} raw
 * @param {{scale?: 'auto'|'fraction'|'percent', armed?: boolean}} options
 * @returns {{percent:number, fraction:number, state:string}}
 */
function makeSpoilersObj(
  raw: unknown,
  options: { armed?: boolean; scale?: 'auto' | 'fraction' | 'percent' } = {},
): SpoilersState {
  const mapped = mapSpoilersRawToPercent(raw, options);

  if (typeof mapped.percent !== 'number' || Number.isNaN(mapped.percent)) {
    // Fall back to last-known stable object
    return lastKnownSpoilers;
  }

  lastKnownSpoilers = {
    percent: mapped.percent,
    fraction: mapped.fraction,
    state: mapped.state,
  };

  return lastKnownSpoilers;
}

const spoilersApi = {
  mapSpoilersRawToPercent,
  makeSpoilersObj,
  // Exposed for testing
  getSpoilersScaleConfig,
};

module.exports = spoilersApi;

export {};
