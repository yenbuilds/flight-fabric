import type { FlightCsvStore } from '../flight-recording/flight-csv-store';
import type { TargetLocation } from './destination-target-store';
type AnyRecord = Record<string, any>;
type DebugLike = {
    log: (_scope: string, _event: string, _payload?: AnyRecord) => void;
};
type ClientRecordingStats = {
    filePath?: string | null;
    flightId?: string | null;
    rowCount?: number;
};
type ClientProviderRequest = (message: AnyRecord, owner: unknown, isCurrent: () => boolean) => AnyRecord | Promise<AnyRecord>;
export type ClientMessageContext = {
    lastSimState?: Record<string, unknown> | null;
    getSimState?: () => Record<string, unknown> | null;
    getPhase?: () => string | null;
    flightCsvWriter?: {
        isRecording: () => boolean;
        getStats: () => ClientRecordingStats | null;
        isFinalizing?: () => boolean;
        getFinalizingStats?: () => ClientRecordingStats | null;
        flush?: () => boolean | void | Promise<boolean | void>;
    } | null;
    getFlightRecordingStatus?: () => AnyRecord;
    flightCsvStore?: FlightCsvStore;
    recordingBundleGuard?: {
        isOwnedCsvPath?: (csvPath: unknown) => boolean;
        isFinalizing?: () => boolean;
        isBusy?: () => boolean;
        getActiveCsvPath?: () => string | null;
        flushActiveBundle?: () => Promise<boolean>;
    } | null;
    flightActive?: boolean;
    flightId?: string | null;
    flightStartIso?: string | null;
    flightStartAircraftTitle?: string | null;
    recordingSession?: {
        getState: () => {
            isRecording: boolean;
        };
    };
    startFlightManual?: () => AnyRecord | Promise<AnyRecord> | null;
    endFlight?: (nowEpochMs: number, reason: string) => ClientRecordingStats | Promise<ClientRecordingStats> | null;
    getDestinationTarget?: () => TargetLocation | null;
    setDestinationTarget?: (target: TargetLocation) => TargetLocation | null;
    clearDestinationTarget?: () => void;
    getOriginTarget?: () => TargetLocation | null;
    setOriginTarget?: (target: TargetLocation) => TargetLocation | null;
    clearOriginTarget?: () => void;
    replayMessages?: ReadonlyArray<Record<string, unknown>>;
    provider?: {
        requestCdu?: (message: AnyRecord, canWrite: () => boolean) => AnyRecord | Promise<AnyRecord>;
        requestPushback?: ClientProviderRequest;
        requestTaxiGuidance?: ClientProviderRequest;
        requestAutotaxi?: ClientProviderRequest;
    };
    broadcast?: (message: AnyRecord) => void;
    getCabinAnnouncementsConfig?: () => AnyRecord | null;
    reconfigureCabinAnnouncements?: (settings: AnyRecord) => unknown;
    timeNow?: () => number;
    Debug?: DebugLike;
};
export {};
