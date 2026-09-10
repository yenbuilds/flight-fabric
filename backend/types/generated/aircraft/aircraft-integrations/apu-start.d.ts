import type { AircraftIntegrationAction, AircraftIntegrationActionPrecondition } from './types.js';
/** FBW's installed aircraft_preset_procedures.xml uses 3000 ms after master ON. */
export declare function fbwApuMasterOn(prefix: string): AircraftIntegrationAction;
/** Only for vendor-documented fixed START=1 controls (not Fenix counters). */
export declare function lvarApuStartRequest(params: {
    prefix: string;
    lvar: string;
    skipWhen?: readonly AircraftIntegrationActionPrecondition[];
}): AircraftIntegrationAction;
