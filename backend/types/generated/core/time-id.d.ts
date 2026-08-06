/**
 * Convert an epoch timestamp to an ISO 8601 string.
 */
export declare function isoFromMs(ms: number): string;
/**
 * Build a stable event identifier from a prefix and timestamp.
 */
export declare function createEventId(prefix: string, timestampMs?: number): string;
