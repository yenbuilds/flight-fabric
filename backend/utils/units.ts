// =========================================================================
// SINGLE SOURCE OF TRUTH for unit conversions in the telemetry platform.
// =========================================================================
//
// Architectural rule:
// - Define shared unit conversion constants in this module.
// - Shared conversions should be imported from this module.
// - Frame contract: source units are m/s, meters, IAS in knots (SimConnect native)
// - Display units: fpm, feet, knots
//
// Add new shared conversions here to keep conversion factors consistent.
// =========================================================================

// ---------------------------------------------------------------------------
// Conversion Constants
// ---------------------------------------------------------------------------

/** Meters to feet */
export const M_TO_FT = 3.28084;

/** Feet to meters */
export const FT_TO_M = 1 / M_TO_FT;

/** Feet per second to feet per minute (for SimConnect VS conversion) */
export const FPS_TO_FPM = 60;

/** Meters per second to feet per minute */
export const MS_TO_FPM = M_TO_FT * 60;

/** Feet per minute to meters per second */
export const FPM_TO_MS = 1 / MS_TO_FPM;

// ---------------------------------------------------------------------------
// Conversion Functions (for clarity and type safety)
// ---------------------------------------------------------------------------

/**
 * Convert meters to feet.
 */
export function metersToFeet(m: number): number {
  return Number.isFinite(m) ? m * M_TO_FT : 0;
}

/**
 * Convert feet to meters.
 */
export function feetToMeters(ft: number): number {
  return Number.isFinite(ft) ? ft * FT_TO_M : 0;
}

/**
 * Convert meters/second to feet/minute.
 */
export function msToFpm(ms: number): number {
  return Number.isFinite(ms) ? ms * MS_TO_FPM : 0;
}

/**
 * Convert feet/minute to meters/second.
 */
export function fpmToMs(fpm: number): number {
  return Number.isFinite(fpm) ? fpm * FPM_TO_MS : 0;
}
