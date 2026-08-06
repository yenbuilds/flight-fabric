export type TimeContext = {
    nowEpochMs: number;
    nowIso: string;
    flightStartEpochMs: number | null;
    flightStartIso: string;
};
export type FixedSourceController = {
    advance: (ms: number) => void;
    set: (ms: number) => void;
    get: () => number;
};
/**
 * Get current time in milliseconds.
 */
export declare function now(): number;
/**
 * Get current time as ISO string.
 */
export declare function nowIso(): string;
/**
 * Create a time context object for passing to functions.
 * Bundles epochMs, iso, and optional flight start info.
 */
export declare function createContext(flightStartEpochMs?: number | null, flightStartIso?: string): TimeContext;
/**
 * Replace the time source for testing or replay.
 */
export declare function setTimeSource(nowFn: () => number, isoFn?: () => string): void;
/**
 * Create a fixed time source for testing.
 */
export declare function createFixedSource(fixedMs?: number): FixedSourceController;
/**
 * Reset to wall-clock time.
 */
export declare function resetTimeSource(): void;
