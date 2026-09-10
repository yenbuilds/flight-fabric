import { type BaroTarget } from '../aircraft/aircraft-integrations/fbw-a32nx/baro.js';
type Sample = {
    observed: unknown;
    updatedAtMs: number;
    fresh: boolean;
};
type Reading = {
    active: boolean;
    std: boolean;
    updatedAt: number;
};
type State = Partial<Record<'captain' | 'firstOfficer', Reading>>;
export declare function captureA380BaroState(target: BaroTarget, sample: (id: string) => Sample, now?: number): State | null;
/** Select and independently confirm STD; never infer it from a numeric pressure. */
export declare function executeA380BaroTransaction({ target, capture, isCurrent, sendEvent, findException, now, sleep, }: {
    target: BaroTarget;
    capture: () => State | null;
    isCurrent: () => boolean;
    sendEvent: (name: string, value: number) => Promise<any>;
    findException?: (ids: number[], since: number) => unknown;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
}): Promise<{
    ok: boolean;
    code: string;
    executionStarted: boolean;
    noOp: boolean;
    baro: {
        target: BaroTarget;
        mode: string;
        confirmedSides: ("captain" | "firstOfficer")[];
    };
    error?: undefined;
} | {
    ok: boolean;
    code: any;
    error: any;
    executionStarted: boolean;
    baro: {
        target: BaroTarget;
        mode: string;
        confirmedSides: ("captain" | "firstOfficer")[];
    };
    noOp?: undefined;
}>;
export {};
