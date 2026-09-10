import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';
export type BaroTarget = 'captain' | 'firstOfficer' | 'both';
export type BaroOperation = 'qnhHpa' | 'qnhInHg' | 'std';
export declare const baroSides: (target: BaroTarget) => ("captain" | "firstOfficer")[];
export declare const baroField: (side: string, property: string) => string;
export declare const baroLetter: (side: string) => "L" | "R";
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
export declare const BARO_HPA_PER_INHG = 33.863886666667;
export declare function baroFields(): Record<string, AircraftIntegrationField>;
export declare function baroActions(): Record<string, AircraftIntegrationAction>;
