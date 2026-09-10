import { type BaroTarget, type BaroOperation } from '../aircraft/aircraft-integrations/fbw-a32nx/baro.js';
type Side = 'captain' | 'firstOfficer';
type Reading = {
    mode: number;
    valueMode: number;
    value: number;
    unitInHg: boolean;
    updatedAt: Record<string, number>;
};
export type BaroState = {
    healthy: boolean;
    sides: Partial<Record<Side, Reading>>;
};
/** Read only independently timestamped samples belonging to the current profile. */
export declare function captureBaroState(target: BaroTarget, sample: (id: string) => {
    value: unknown;
    updatedAt: unknown;
}, now?: number): BaroState | null;
export declare function executeBaroTransaction({ target, operation, value, capture, isCurrent, sendEvent, setNamedVar, findException, now, sleep, }: {
    target: BaroTarget;
    operation: BaroOperation;
    value?: number;
    capture: () => BaroState | null;
    isCurrent: () => boolean;
    sendEvent: (name: string, value: number) => Promise<any>;
    setNamedVar: (input: {
        name: string;
        unit: string;
        value: number;
    }) => Promise<any>;
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
