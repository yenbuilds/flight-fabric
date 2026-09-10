/** Meters to feet */
export declare const M_TO_FT = 3.28084;
/** Feet to meters */
export declare const FT_TO_M: number;
/** Feet per second to feet per minute (for SimConnect VS conversion) */
export declare const FPS_TO_FPM = 60;
/** Meters per second to feet per minute */
export declare const MS_TO_FPM: number;
/** Feet per minute to meters per second */
export declare const FPM_TO_MS: number;
/**
 * Convert meters to feet.
 */
export declare function metersToFeet(m: number): number;
/**
 * Convert feet to meters.
 */
export declare function feetToMeters(ft: number): number;
/**
 * Convert meters/second to feet/minute.
 */
export declare function msToFpm(ms: number): number;
/**
 * Convert feet/minute to meters/second.
 */
export declare function fpmToMs(fpm: number): number;
