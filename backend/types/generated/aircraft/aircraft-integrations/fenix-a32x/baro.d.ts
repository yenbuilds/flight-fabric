import type { AircraftIntegrationAction, AircraftIntegrationField } from '../types.js';
export declare const fenixBaroUnitField: (side: string) => string;
export declare const fenixBaroCounter: (side: string, button: boolean, direction: 1 | -1) => string;
export declare const fenixBaroUnits: (side: string, inHg: boolean) => string;
export declare function fenixBaroFields(): Record<string, AircraftIntegrationField>;
/** Exact reviewed recipes: the executor selects only these codes from fresh state. */
export declare function fenixBaroActions(): Record<string, AircraftIntegrationAction>;
