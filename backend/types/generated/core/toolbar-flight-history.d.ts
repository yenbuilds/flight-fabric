type AnyRecord = Record<string, any>;
export declare const TOOLBAR_HISTORY_MAX_CAUTIONS = 6;
export declare function sanitizeToolbarLanding(value: unknown): AnyRecord | null;
export declare function sanitizeToolbarCaution(value: unknown): AnyRecord | null;
export declare function sanitizeToolbarFlightHistory(value: unknown): AnyRecord;
export {};
