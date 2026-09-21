/** Aircraft-specific ground handling. Values describe the installed control
 * adapter, not a promise that an aircraft has passed live acceptance. */
export type TaxiHandling = Readonly<{
  id: string;
  label: string;
  wheelbaseM: number;
  /** Effective nose-wheel angle at a full steering-axis command. */
  maxSteeringDeg: number;
  /** Controller steering limit, at or below the effective full-axis angle. */
  steeringLimitDeg: number;
  /** Minimum authored scenery-link width; scenery is not a clearance survey. */
  minPathWidthM: number;
  /** Distance from reference point to the hold line, including nose clearance. */
  holdShortOffsetM: number;
  cruiseKts: number;
  turnKts: number;
  maxStartKts: number;
  maxSpeedKts: number;
  maxThrottle: number;
}>;

/** Legacy controller defaults retained for standalone callers and fixtures.
 * Production sessions provide a resolved aircraft configuration explicitly. */
export const DEFAULT_TAXI_HANDLING: TaxiHandling = Object.freeze({
  id: 'pmdg-737', label: 'PMDG 737', wheelbaseM: 15.6, maxSteeringDeg: 75,
  steeringLimitDeg: 65, minPathWidthM: 10, holdShortOffsetM: 30,
  cruiseKts: 8, turnKts: 2, maxStartKts: 12, maxSpeedKts: 15, maxThrottle: 0.18,
});

const bounds = {
  wheelbaseM: [1, 40], maxSteeringDeg: [5, 85], steeringLimitDeg: [5, 85],
  minPathWidthM: [2, 60], holdShortOffsetM: [3, 80], cruiseKts: [1, 12],
  turnKts: [0.5, 5], maxStartKts: [1, 12], maxSpeedKts: [2, 15], maxThrottle: [0.01, 1],
} as const;

/** Validate and copy so caller mutation cannot change a plan already in use. */
export function validateTaxiHandling(value: TaxiHandling): TaxiHandling {
  if (!value || typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.id)
    || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 120) {
    throw new Error('Aircraft ground-handling configuration is unavailable.');
  }
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = value[key as keyof typeof bounds];
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid aircraft ground-handling value: ${key}.`);
  }
  if (value.steeringLimitDeg > value.maxSteeringDeg || value.turnKts > value.cruiseKts
    || value.cruiseKts >= value.maxSpeedKts || value.maxStartKts > value.maxSpeedKts) {
    throw new Error('Aircraft ground-handling limits are inconsistent.');
  }
  return Object.freeze({ ...value });
}

/** The identity includes every tuning value; changing limits invalidates learnt
 * steering direction and any plan created before that change. */
export function taxiHandlingKey(value: TaxiHandling): string {
  return JSON.stringify([value.id, value.label, ...Object.keys(bounds).map(key => value[key as keyof typeof bounds])]);
}
