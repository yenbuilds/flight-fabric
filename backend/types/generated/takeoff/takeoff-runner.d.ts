type AnyRecord = Record<string, any>;
type BroadcastFn = (payload: AnyRecord) => void;
type TimeContext = {
    nowEpochMs?: number;
    nowIso?: string;
    flightStartEpochMs?: number | null;
    flightStartIso?: string;
};
type TakeoffRunnerContext = AnyRecord & {
    scoringEnabled?: boolean;
    phase?: string | null;
    aircraftName?: string | null;
    aircraftProfileId?: string | null;
    icao?: string | null;
    runway?: string | null;
    simVersion?: string | null;
    dataSource?: string | null;
    simulator?: string | null;
    computedHdgMagDeg?: number | null;
    computedHdgTrueDeg?: number | null;
};
export type TakeoffRunner = {
    update: (frame: AnyRecord, broadcast?: BroadcastFn | null, timeCtx?: TimeContext, ctx?: TakeoffRunnerContext) => void;
    reset: () => void;
    isPending: () => boolean;
};
export {};
