import type { FlightGuidanceRecipe } from './integration-behavior.js';
type AnyRecord = Record<string, any>;
type Primitive = boolean | number | string;
type CoverageInterval = {
    startElapsedMs: number;
    endElapsedMs: number;
    startTimestampMs: number | null;
    endTimestampMs: number | null;
};
type FlightGuidanceProjectionEvent = {
    type: 'flight_guidance_event';
    eventType: string;
    flightElapsedMs: number;
    confirmedAtElapsedMs: number;
    fieldId: string;
    previous: Primitive;
    current: Primitive;
    label: string;
    summary: string;
    confidence: 'profile-confirmed';
    source: string;
    integrationId: string;
    aircraftProfileId: string | null;
    mode?: string;
    referenceGroup?: string;
    previousReference?: string;
    currentReference?: string;
    target?: string;
    unit?: string;
    context?: AnyRecord;
};
type FlightGuidanceProjection = {
    applicable: boolean;
    active: boolean;
    integrationId: string;
    summary: {
        integrationId: string;
        aircraftProfileId: string | null;
    };
    events: FlightGuidanceProjectionEvent[];
    eventCount: number;
    truncatedCount: number;
    coverageTruncatedCount: number;
    coverage: CoverageInterval[];
};
type ProjectorOptions = {
    modeSettleMs?: number;
    targetSettleMs?: number;
    maxEvents?: number;
    maxCoverageIntervals?: number;
};
/** Project normalized guidance observations using a definition-owned contract. */
export declare function createFlightGuidanceProjection(integrationId: string, recipe: FlightGuidanceRecipe): Readonly<{
    id: string;
    version: number;
    eventType: string;
    lane: string;
    createProjector: (options?: ProjectorOptions) => {
        consume: (row: AnyRecord) => void;
        finish: () => FlightGuidanceProjection;
    };
    matchesTimeline: (timeline: AnyRecord) => boolean;
    automationDedupe: Readonly<{
        windowMs: number;
        matches: (automationEvent: AnyRecord, guidanceEvent: AnyRecord) => boolean;
    }>;
}>;
export {};
