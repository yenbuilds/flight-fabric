type AnyRecord = Record<string, unknown>;
/**
 * Copy the recognised flight-plan fields out of `source`, bounding every
 * value. Fields the source does not carry are omitted; fields it carries
 * with an unusable value become null so a stale value never survives.
 */
export declare function sanitizeFlightPlanFields(source: unknown): AnyRecord;
export {};
