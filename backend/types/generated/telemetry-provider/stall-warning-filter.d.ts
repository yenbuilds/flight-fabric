export declare const STALL_WARNING_ENTRY_MS = 1000;
/** Confirm a continuous simulator warning, not a stall inferred from IAS.
 * Pauses, ground contact, missing data and sample gaps break confirmation. */
export declare class StallWarningFilter {
    private sinceMs;
    private lastMs;
    update(warning: unknown, valid: boolean, onGround: unknown, nowMs: number): boolean;
}
/** Only discard historical pulses whose complete start/end pair is recorded.
 * An unclosed or malformed warning cannot be assumed to have been brief. */
export declare function transientStallRows<T extends Record<string, any>>(rows: T[]): Set<T>;
