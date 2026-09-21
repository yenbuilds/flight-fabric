type AnyRecord = Record<string, unknown>;
declare function boundedString(value: unknown, maxLength: number): string | null;
declare function finiteNumber(value: unknown): number | null;
type FieldSanitizer = (value: unknown) => unknown;
export declare const FLIGHT_PLAN_SCALAR_FIELDS: Readonly<Record<string, FieldSanitizer>>;
export declare const FLIGHT_PLAN_GROUP_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldSanitizer>>>>;
/**
 * Copy the recognised flight-plan fields out of `source`, bounding every
 * value. Fields the source does not carry are omitted; fields it carries
 * with an unusable value become null so a stale value never survives.
 */
export declare function sanitizeFlightPlanFields(source: unknown): AnyRecord;
export { boundedString as boundedFlightPlanString, finiteNumber as finiteFlightPlanNumber };
