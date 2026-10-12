/** Existing supported barometer command domains, shared by the opted-in adapters. */
export type BaroTarget = 'captain' | 'firstOfficer' | 'both';
export type BaroOperation = 'qnhHpa' | 'qnhInHg' | 'std';
export declare const baroSides: (target: BaroTarget) => ("captain" | "firstOfficer")[];
export declare const BARO_INPUTS: {
    readonly qnhHpa: {
        readonly type: "number";
        readonly min: 948;
        readonly max: 1084;
        readonly step: 1;
    };
    readonly qnhInHg: {
        readonly type: "number";
        readonly min: 27.99;
        readonly max: 32.01;
        readonly step: 0.01;
    };
};
