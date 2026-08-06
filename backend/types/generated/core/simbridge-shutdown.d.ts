type StopHandle = (handle: unknown, label: string, timeoutMs?: number) => Promise<unknown>;
type ShutdownSequenceOptions = {
    finalizationTask?: (() => Promise<unknown> | unknown) | null;
    provider?: unknown;
    historyIndexHandle?: unknown;
    cabinAnnouncementsHandle?: unknown;
    updateCheckerHandle?: unknown;
    stopHandle: StopHandle;
    closeServersTask?: (() => Promise<unknown> | unknown) | null;
};
type RecordingShutdownFinalizerOptions = {
    flightActive: boolean;
    endActiveFlight: () => Promise<unknown> | unknown;
    getPendingFinalization: () => Promise<unknown> | null;
    finalizeOpenRecorders: () => Promise<unknown> | unknown;
};
/**
 * Select and fully await recording cleanup during shutdown.
 *
 * A failed three-member startup leaves the flight lifecycle active while the
 * individual recorder modules have already moved into finalization. In that
 * state `endActiveFlight()` can have no new recorder to close, but the earlier
 * rollback promise still owns the files and must be awaited before exit.
 */
export declare function finalizeRecordingForShutdown({ flightActive, endActiveFlight, getPendingFinalization, finalizeOpenRecorders, }: RecordingShutdownFinalizerOptions): Promise<void>;
/**
 * Start every runtime-handle stop before awaiting any one handle or flight
 * finalization. In particular, provider.stop() owns the telemetry sidecars and
 * must not be skipped because an unrelated component hangs earlier in cleanup.
 */
export declare function runSimbridgeShutdownSequence({ finalizationTask, provider, historyIndexHandle, cabinAnnouncementsHandle, updateCheckerHandle, stopHandle, closeServersTask, }: ShutdownSequenceOptions): Promise<void>;
export {};
