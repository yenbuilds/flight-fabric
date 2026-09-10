import { type BaroTarget, type BaroOperation } from '../aircraft/aircraft-integrations/fbw-a32nx/baro.js';
type Side = 'captain' | 'firstOfficer';
type Reading = {
    qnh: boolean;
    units: string;
    pressure: number | null;
    times: Record<string, number>;
};
export type FenixBaroState = {
    healthy: boolean;
    sides: Partial<Record<Side, Reading>>;
};
export declare function captureFenixBaroState(target: BaroTarget, operation: BaroOperation, sample: (id: string) => {
    observed: unknown;
    fresh: boolean;
    updatedAtMs: number;
}, now?: number): FenixBaroState | null;
/** Native one-detent inputs, each confirmed before another input; never retry a lost detent. */
export declare function executeFenixBaroTransaction({ target, operation, value, capture, isCurrent, executeCode, findException, now, sleep, }: {
    target: BaroTarget;
    operation: BaroOperation;
    value?: number;
    capture: () => FenixBaroState | null;
    isCurrent: () => boolean;
    executeCode: (code: string) => Promise<any>;
    findException?: (ids: number[], since: number) => unknown;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
}): Promise<{
    baro: {
        confirmedSides: ("captain" | "firstOfficer")[];
        unit?: string;
        value?: number;
        target: BaroTarget;
        mode: string;
    };
    noOp?: boolean;
    idempotent?: boolean;
    ok: boolean;
    code: string;
    executionStarted?: undefined;
    error?: undefined;
} | {
    ok: boolean;
    code: any;
    executionStarted: boolean;
    error: any;
    baro: {
        confirmedSides: ("captain" | "firstOfficer")[];
        unit?: string;
        value?: number;
        target: BaroTarget;
        mode: string;
    };
}>;
export {};
