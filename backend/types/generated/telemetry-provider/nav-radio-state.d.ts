export declare const NAV_RADIO_FIELDS: Set<string>;
export type NavRadioSample = {
    value: unknown;
    updatedAt: string | null;
};
export declare function captureNavRadios(samples: Record<string, NavRadioSample>, status: unknown, nowMs?: number): {
    [k: string]: {
        installed: boolean;
        activeMhz: number;
        standbyMhz: number;
    };
};
