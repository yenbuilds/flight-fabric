export type ClockLike = {
    now: () => number;
};
export type FreezeFn = <T>(obj: T) => T;
export type TickFrameMeta = Readonly<{
    sequence: number;
    timestampMs: number;
    timestampIso: string;
    actualDeltaMs: number | null;
}>;
export type TickFrame = Readonly<Record<string, unknown> & {
    meta: TickFrameMeta;
    tickNumber: number;
    timestampMs: number;
    timestampIso: string;
    pollRateMs: number;
    deltaSec: number;
}>;
export type TickFrameFactory = {
    create: (rawFrame: Record<string, unknown>) => TickFrame;
    getTickCount: () => number;
    reset: () => void;
};
export declare function defaultFreeze<T>(obj: T): T;
export declare function createTickFrame(rawFrame: Record<string, unknown>, options?: {
    tickNumber?: number;
    nowEpochMs?: number;
    pollRateMs?: number;
    actualDeltaMs?: number | null;
    freeze?: FreezeFn;
}): TickFrame;
export declare function createTickFrameFactory(options?: {
    timeSource?: ClockLike;
    monotonicTimeSource?: ClockLike;
    pollRateMs?: number;
    freeze?: FreezeFn;
}): TickFrameFactory;
