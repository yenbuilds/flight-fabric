import type { AircraftCommandBinding, AircraftCommandDefinition } from './aircraft-command-catalogue';
/** Shared intent only. Each family below explicitly selects its own existing actions. */
export declare const PARITY_COMMAND_DEFINITIONS: readonly AircraftCommandDefinition[];
export declare function aircraftParityBindings(adapterId: string): readonly AircraftCommandBinding[];
