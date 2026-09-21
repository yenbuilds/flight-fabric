import { validateTaxiHandling, type TaxiHandling } from './handling.js';
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

const adapters: Record<TaxiFamily, TaxiAdapter> = {
  generic: { family: 'generic', label: 'Standard MSFS aircraft', sdkChannel: null,
    parkingAction: null, integrationId: null,
    setupInstructions: ['Use a conventional aircraft with steerable nose gear and standard MSFS throttle and brake controls.',
      'Keep hardware axes still and disable other control writers during the test.'] },
  'pmdg-737': { family: 'pmdg-737', label: 'PMDG 737', sdkChannel: 'pmdg-737-ng3-clientdata',
    parkingAction: 'gear.parkingBrake.set', integrationId: 'pmdg-737',
    setupInstructions: ['Select Tiller + Rudder / MSFS NWS AXIS + RUDDER in PMDG steering settings.',
      'Disarm autothrottle and prepare normal hydraulic and steering power.'] },
  'pmdg-777': { family: 'pmdg-777', label: 'PMDG 777', sdkChannel: 'pmdg-777x-clientdata',
    parkingAction: 'controls.parkingBrake.on', integrationId: 'pmdg-777',
    setupInstructions: ['Select Tiller + Rudder in PMDG steering settings.',
      'Disarm both autothrottle arm switches and prepare normal hydraulic and steering power.'] },
  'fenix-a32x': { family: 'fenix-a32x', label: 'Fenix A319 / A320 / A321', sdkChannel: null,
    parkingAction: 'systems.parkingBrake.set', integrationId: 'fenix-a32x',
    setupInstructions: ['Prepare nose-wheel steering and hydraulics; release PED DISC.',
      'Disengage autothrust and keep hardware throttle, brake and tiller axes still.'] },
};

// This is a candidate adapter list, not an assertion of live acceptance. Known
// custom add-ons never inherit the standard adapter merely because they have
// telemetry. The Generic fallback still needs actual installed geometry and
// live engine configuration; its default profile engine count is not used.
const profileFamilies = new Map<string, TaxiFamily>([
  ...['generic', 'ga-base', 'turboprop-base', 'regional-jet', 'widebody-base',
    'workingtitle-cj4', 'workingtitle-citation-longitude', 'microsoft-737-max-8']
    .map(id => [`bundled/msfs/${id}`, 'generic'] as [string, TaxiFamily]),
  ...['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900']
    .map(id => [`bundled/msfs/${id}`, 'pmdg-737'] as [string, TaxiFamily]),
  ...['pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f']
    .map(id => [`bundled/msfs/${id}`, 'pmdg-777'] as [string, TaxiFamily]),
  ...['fenix-a319', 'fenix-a320', 'fenix-a321']
    .map(id => [`bundled/msfs/${id}`, 'fenix-a32x'] as [string, TaxiFamily]),
]);

export function taxiAdapterFor(profileKey: string): TaxiAdapter | null {
  const family = profileFamilies.get(profileKey);
  return family ? adapters[family] : null;
}

/** Geometry is source data; these speed, clearance and thrust limits are
 * conservative engineering policy pending the live matrix in AUTOTAXI-AIRCRAFT.md.
 * Fenix throttle demand denotes travel above idle towards CLB, not simulator
 * full-scale thrust percent. No fixed detent is extrapolated into a write route. */
export function handlingForAircraft(adapter: TaxiAdapter, model: Extract<TaxiAircraftConfigResult, { ok: true }>, engineType: number): TaxiHandling {
  const cruiseKts = Math.min(engineType === 0 ? 5 : 8, model.fullSteeringSpeedKts === undefined ? 8 : model.fullSteeringSpeedKts * 0.9);
  return validateTaxiHandling({
    id: `${adapter.family}-${model.fingerprint.slice(0, 24)}`, label: adapter.label,
    wheelbaseM: model.wheelbaseM, maxSteeringDeg: model.maxSteeringDeg,
    steeringLimitDeg: Math.min(65, Math.max(5, model.maxSteeringDeg * 0.9)),
    minPathWidthM: Math.max(engineType === 0 ? 3 : 10, model.wheelTrackM + 2),
    holdShortOffsetM: Math.max(model.lengthM / 2, model.noseOffsetM || 0) + 5,
    cruiseKts, turnKts: Math.min(2, cruiseKts),
    maxStartKts: Math.min(engineType === 0 ? 6 : 12, model.fullSteeringSpeedKts ?? 12),
    maxSpeedKts: Math.min(engineType === 0 ? 10 : 15, model.fullSteeringSpeedKts ?? 15),
    maxThrottle: 0.18,
  });
}
