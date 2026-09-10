import type { AircraftIntegrationAction, AircraftIntegrationField } from './types.js';
/** Shared simulator transponder state; PMDG's SDK does not publish the code. */
export declare function pmdgAtcFields(): Record<string, AircraftIntegrationField>;
export declare function pmdgAtcActions(prefix: 'pmdg737' | 'pmdg777', identSwitch: 806 | 746): Record<string, AircraftIntegrationAction>;
