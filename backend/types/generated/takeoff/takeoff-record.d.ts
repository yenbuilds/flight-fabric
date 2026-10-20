/** Recorded takeoff projection shared by Logbook and Timeline. No rescoring. */
type AnyRecord = Record<string, any>;
type MeasurementTimeBasis = 'simulator' | 'capture' | null;
export type TakeoffLogRecording = {
    bundleName?: string | null;
    recordingSessionId?: string | null;
    flightId?: string | null;
    /** Zero-based source row, used only by old CSVs without event/sample IDs. */
    rowIndex?: number | null;
};
export type TakeoffLogEntry = {
    id: string;
    eventId: string | null;
    sampleIndex: number | null;
    timestamp: string | null;
    timestampMs: number | null;
    flightStart: string | null;
    aircraft: string | null;
    aircraftProfileId: string | null;
    icao: string | null;
    runway: string | null;
    iasKts: number | null;
    gsKts: number | null;
    pitchDeg: number | null;
    flapsNotch: number | null;
    windSpeedKts: number | null;
    windDirDeg: number | null;
    xwindKts: number | null;
    rollDistanceFt: number | null;
    rollDurationS: number | null;
    rollDurationBasis: MeasurementTimeBasis;
    rollStartSource: string | null;
    liftoffDistanceFt: number | null;
    runwayRemainingFt: number | null;
    runwayUsedPct: number | null;
    runwayUseScore: number | null;
    runwayUseGrade: string | null;
    runwayUseZone: string | null;
    runwayLengthFt: number | null;
    runwayGeometrySource: string | null;
    screenHeightFt: number | null;
    screenHeightRemainingFt: number | null;
    screenHeightReached: boolean;
    screenHeightTimeBasis: MeasurementTimeBasis;
    rotationRateDegS: number | null;
    rotationTimeBasis: MeasurementTimeBasis;
    maxPitchDeg: number | null;
    lateralOffsetFt: number | null;
    lateralOffsetSide: string | null;
    lateralOffsetGrade: string | null;
    lateralOffsetSuspect: boolean;
    hopCount: number;
    assessment: string | null;
    runwayExcursion: boolean;
    flags: Array<{
        code: string;
        label: string;
        severity: string;
    }>;
    /** Original facts, findings and rule provenance; never replaced by current rules. */
    analysis: AnyRecord | null;
    recording: {
        bundleName: string | null;
        recordingSessionId: string | null;
        flightId: string | null;
    };
};
/** Accept either a live takeoff:final payload or its recorded CSV row. */
export declare function extractRecordedTakeoff(payload: AnyRecord | null | undefined, recording?: TakeoffLogRecording): TakeoffLogEntry | null;
/** Preserve the public marker field names while sharing their interpretation. */
export declare function buildTakeoffTimelineContext(entry: TakeoffLogEntry): AnyRecord;
export {};
