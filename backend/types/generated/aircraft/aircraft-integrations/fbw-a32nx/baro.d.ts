import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';
export declare const baroField: (side: string, property: string) => string;
export declare const baroLetter: (side: string) => "L" | "R";
export declare const BARO_HPA_PER_INHG = 33.863886666667;
export declare function baroFields(): Record<string, AircraftIntegrationField>;
export declare function baroActions(): Record<string, AircraftIntegrationAction>;
