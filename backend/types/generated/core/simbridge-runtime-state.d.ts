type AnyRecord = Record<string, any>;
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
export declare function resetSimbridgeBroadcastState(runtimeState: AnyRecord): void;
export declare function rememberReplayMessage(runtimeState: AnyRecord, message: AnyRecord | null | undefined): void;
export declare function getReplayMessages(runtimeState: AnyRecord): any[];
export {};
