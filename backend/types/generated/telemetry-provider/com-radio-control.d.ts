export declare const COM_RADIO_DEFINITIONS: {
    name: string;
    simvar: string;
    unit: string;
    isolated: boolean;
}[];
export declare const COM_RADIO_FIELDS: Set<string>;
type Sample = {
    value: unknown;
    updatedAt: string | null;
};
export type ComRadioState = {
    installed: boolean | null;
    status: number | null;
    spacingMode: number | null;
    activeMhz: number | null;
    standbyMhz: number | null;
    updatedAt: Record<string, number>;
};
export declare function captureComRadio(samples: Record<string, Sample>, status: unknown, index: 1 | 2, nowMs?: number): ComRadioState;
/** Bounded transaction under the provider's per-radio lock. Never retries a write. */
export declare function executeComRadioTransaction({ index, operation, value, capture, isCurrent, sendEvent, findException, now, sleep, }: {
    index: 1 | 2;
    operation: 'setStandby' | 'swap' | 'switchTo';
    value?: number;
    capture: () => ComRadioState;
    isCurrent: () => boolean;
    sendEvent: (name: string, value: number) => Promise<any>;
    findException?: (ids: number[], since: number) => unknown;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
}): Promise<{
    confirmedValue: number;
    radio: {
        index: 1 | 2;
        bank: string;
        frequencyMhz: number;
    };
    noOp?: boolean;
    idempotent?: boolean;
    ok: boolean;
    code: string;
} | {
    ok: boolean;
    code: any;
    executionStarted: boolean;
    error: string;
}>;
export {};
