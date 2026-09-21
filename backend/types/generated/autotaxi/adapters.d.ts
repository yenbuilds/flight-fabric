import { type TaxiHandling } from './handling.js';
import type { TaxiAircraftConfigResult } from './aircraft-config.js';
export type TaxiFamily = 'generic' | 'pmdg-737' | 'pmdg-777' | 'fenix-a32x';
export type TaxiAdapter = Readonly<{
    family: TaxiFamily;
    label: string;
    sdkChannel: string | null;
    parkingAction: string | null;
    integrationId: string | null;
    setupInstructions: readonly string[];
}>;
export declare function taxiAdapterFor(profileKey: string): TaxiAdapter | null;
/** Geometry is source data; these speed, clearance and thrust limits are
 * conservative engineering policy pending the live matrix in AUTOTAXI-AIRCRAFT.md.
 * Fenix throttle demand denotes travel above idle towards CLB, not simulator
 * full-scale thrust percent. No fixed detent is extrapolated into a write route. */
export declare function handlingForAircraft(adapter: TaxiAdapter, model: Extract<TaxiAircraftConfigResult, {
    ok: true;
}>, engineType: number): TaxiHandling;
