import type { AircraftIntegrationAction } from './types.js';
/** Opt-in only: confirm the aircraft's selected code after a BCO16 event. */
export declare function confirmedSquawkAction(prefix: string): AircraftIntegrationAction;
