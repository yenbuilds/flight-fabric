import type { AircraftIntegrationAction } from '../types.js';
export declare const MINIMUMS_INPUTS: {
    readonly baro: {
        readonly type: "number";
        readonly min: 0;
        readonly max: 39000;
        readonly step: 1;
    };
    readonly radio: {
        readonly type: "number";
        readonly min: 0;
        readonly max: 5000;
        readonly step: 1;
    };
};
export declare function minimumsActions(): Record<string, AircraftIntegrationAction>;
