type AnyRecord = Record<string, any>;
type DebugLike = {
    log?: (_scope: string, _event: string, _payload?: AnyRecord) => void;
} | null | undefined;
type StoreOptions = {
    Debug?: DebugLike;
    flightCsvWriter?: AnyRecord | null;
    recordingBundleGuard?: AnyRecord | null;
    openHistoryIndexStore?: (_options?: AnyRecord) => AnyRecord;
};
type TimelineReadResult = {
    success: true;
    timeline: AnyRecord;
} | {
    success: false;
    error: string;
};
type TimelineGenerationOptions = {
    requestId?: string | number | null;
    scoringMode?: 'recorded' | 'current-preview';
};
type FlightAnalysisRescoreRequest = {
    filePath?: unknown;
    flightId?: unknown;
    expectedRevision?: number | null;
    expectedSourceFingerprint?: string | null;
    expectedPreviewFingerprint?: string | null;
    expectedAnalysisContractFingerprint?: string | null;
    expectedSnapshotFingerprint?: string | null;
};
type TimelineListResult = {
    success: true;
    flights: AnyRecord[];
    storage: AnyRecord;
} | {
    success: false;
    error: string;
};
type TimelineListOptions = {
    aircraftFilter?: unknown;
    limit?: unknown;
    offset?: unknown;
    routeFilter?: unknown;
    sort?: unknown;
};
type IndexedTimelineListResult = {
    success: true;
    flights: AnyRecord[];
    storage: AnyRecord | null;
    index: AnyRecord;
} | {
    success: false;
    error: string;
};
type DeleteExpectedIdentity = {
    mtimeMs?: unknown;
    sizeBytes?: unknown;
} | null | undefined;
type DeleteResult = {
    success: boolean;
    error?: string | null;
    storage?: AnyRecord | null;
};
type LogbookResult = {
    success: true;
    entries: AnyRecord[];
    stats: AnyRecord;
    takeoffs?: AnyRecord[];
    takeoffStats?: AnyRecord;
    index?: AnyRecord;
} | {
    success: false;
    error: string;
};
type LogbookReadOptions = {
    entryLimit?: unknown;
};
declare function createFlightCsvStore(options?: StoreOptions): {
    applyFlightAnalysisRescore: (request?: FlightAnalysisRescoreRequest) => Promise<AnyRecord>;
    deleteFlightCsv: (filePath: unknown, expectedIdentity?: DeleteExpectedIdentity) => DeleteResult;
    generateTimelineForFlightId: (flightId: unknown, options?: TimelineGenerationOptions) => Promise<TimelineReadResult>;
    generateTimelineFromFile: (filePath: unknown, options?: TimelineGenerationOptions) => Promise<TimelineReadResult>;
    getHistoryIndexStatus: () => AnyRecord;
    getLogbook: (options?: LogbookReadOptions) => Promise<LogbookResult>;
    listFlightsIndexed: (options?: TimelineListOptions) => Promise<IndexedTimelineListResult>;
    listFlights: () => Promise<TimelineListResult>;
    revertFlightAnalysisRescore: (request?: FlightAnalysisRescoreRequest) => AnyRecord;
    startHistoryIndex: (options?: {
        rebuild?: boolean;
    }) => Promise<AnyRecord>;
    stop: () => Promise<AnyRecord>;
};
export type FlightCsvStore = ReturnType<typeof createFlightCsvStore>;
export {};
