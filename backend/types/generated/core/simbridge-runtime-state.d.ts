type AnyRecord = Record<string, any>;
type RuntimeSnapshotInput = {
    flightActive: boolean;
    flightId: string | null | undefined;
    flightStartIso: string | null | undefined;
    aircraftTitle: string | null | undefined;
    phase: string | null | undefined;
    timestampMs: number;
};
export declare function createSimbridgeRuntimeState(params?: {
    destinationTarget?: AnyRecord | null;
    originTarget?: AnyRecord | null;
}): {
    sim: {
        lastState: any;
        latestTickFrame: any;
    };
    targets: {
        destination: AnyRecord;
        origin: AnyRecord;
    };
    broadcast: {
        lastFlapsNotch: any;
        lastGearState: any;
        lastGearParkingBrake: any;
        lastSpoilersState: any;
        pendingSpoilersState: any;
        pendingSpoilersStateTicks: number;
    };
    replay: {
        latestMessages: {};
    };
};
export declare function buildSimbridgeRuntimeSnapshot(runtimeState: AnyRecord, input: RuntimeSnapshotInput): {
    tickFrame: any;
    phase: string;
    simState: any;
    flightActive: boolean;
    flightId: string;
    flightStartIso: string;
    aircraftTitle: string;
    timestampMs: number;
};
export declare function resetSimbridgeBroadcastState(runtimeState: AnyRecord): void;
export declare function clearLiveReplayMessages(runtimeState: AnyRecord): void;
export declare function rememberReplayMessage(runtimeState: AnyRecord, message: AnyRecord | null | undefined): void;
export declare function getReplayMessages(runtimeState: AnyRecord): any[];
export {};
