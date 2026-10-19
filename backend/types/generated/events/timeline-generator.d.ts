type AnyRecord = Record<string, any>;
type AirportSummary = {
    icao: string;
    name: string;
} & AnyRecord;
type GeneratedTimeline = {
    flightId: string;
    startTime: string | number | null;
    endTime: string | number | null;
    simDateTimeLocal: string | null;
    simDateTimeUtc: string | null;
    durationMs: number;
    durationFormatted: string;
    aircraft: string;
    aircraftProfileId: string | null;
    departureAirport: AirportSummary | null;
    arrivalAirport: AirportSummary | null;
    route: string | null;
    distanceNm?: number | null;
    fuelBurnGal: number | null;
    fuelBurnWeightLbs: number | null;
    fuelStartGal: number | null;
    fuelEndGal: number | null;
    fuelBurnSource?: string | null;
    events: AnyRecord[];
    track: AnyRecord[];
    generated: boolean;
    generatedAt: string;
    eventCount?: number;
    sampleCount?: number;
    worstMoment?: AnyRecord | null;
    flightType?: string;
    flightClassification?: AnyRecord;
    automationSummary?: AnyRecord;
    aircraftTimelineProjections?: Record<string, AnyRecord>;
    analysisRescore?: {
        mode: 'recorded' | 'current-preview';
        scope: 'full-landing-analysis';
        contract: {
            id: string;
            version: number;
            scope: 'full-landing-analysis';
        };
        persistedDataModified: false;
        complete: boolean;
        landingCount: number;
        landings: AnyRecord[];
    };
};
type TimelineResult = {
    success: false;
    error: string;
} | {
    success: true;
    timeline: GeneratedTimeline;
};
export type RecordingReadRequest = {
    kind: 'timeline';
    options: AnyRecord;
};
export type RecordingReadResult = TimelineResult;
export {};
