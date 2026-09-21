// Bounded shape of the relayed SimBrief flight plan.
//
// The desktop UI normalizes the SimBrief OFP and relays it as a `flightPlan`
// message; the backend stores the last plan, broadcasts it and replays it to
// clients that connect later (strip overlays, phones, the MSFS toolbar
// panel). One field schema here bounds the payload on the way in (client
// message handler) and again on the way out to unpaired clients (server
// message projection) so both stay in step when the plan grows.

type AnyRecord = Record<string, unknown>;

const MAX_NAVLOG_FIXES = 250;

function hasOwn(target: unknown, key: string): boolean {
  return Boolean(target) && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, key);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed || null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function icaoCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return code.length >= 3 ? code : null;
}

function runwayIdent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ident = value.trim().toUpperCase();
  return /^[A-Z0-9-]{1,12}$/.test(ident) ? ident : null;
}

function procedureIdent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ident = value.trim().toUpperCase();
  return /^[A-Z0-9]{1,10}$/.test(ident) ? ident : null;
}

function weightUnit(value: unknown): 'kg' | 'lbs' | null {
  return value === 'kg' || value === 'lbs' ? value : null;
}

type FieldSanitizer = (value: unknown) => unknown;

// Field name -> sanitizer. Each nested group lists its own scalar fields.
export const FLIGHT_PLAN_SCALAR_FIELDS: Readonly<Record<string, FieldSanitizer>> = Object.freeze({
  origin: icaoCode,
  originName: (value) => boundedString(value, 80),
  departureRunway: runwayIdent,
  destination: icaoCode,
  destinationName: (value) => boundedString(value, 80),
  arrivalRunway: runwayIdent,
  alternate: icaoCode,
  aircraft: (value) => boundedString(value, 20),
  aircraftName: (value) => boundedString(value, 80),
  callsign: (value) => boundedString(value, 20),
  flightNumber: (value) => boundedString(value, 20),
  route: (value) => boundedString(value, 2000),
  cruiseAltFl: (value) => boundedString(value, 10),
  cruiseMach: (value) => boundedString(value, 10),
  eteSeconds: finiteNumber,
  fuelLbs: finiteNumber,
  costIndex: finiteNumber,
  weightUnit,
  registration: (value) => boundedString(value, 20),
  airac: (value) => boundedString(value, 10),
  generatedAt: finiteNumber,
  scheduledOut: finiteNumber,
  scheduledOff: finiteNumber,
  scheduledOn: finiteNumber,
  scheduledIn: finiteNumber,
  estimatedOut: finiteNumber,
  estimatedOff: finiteNumber,
  estimatedOn: finiteNumber,
  estimatedIn: finiteNumber,
  blockSeconds: finiteNumber,
  taxiOutSeconds: finiteNumber,
  taxiInSeconds: finiteNumber,
  enduranceSeconds: finiteNumber,
  icaoFlightPlan: (value) => boundedString(value, 4000),
});

export const FLIGHT_PLAN_GROUP_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldSanitizer>>>> = Object.freeze({
  procedures: Object.freeze({
    sid: procedureIdent,
    sidTransition: procedureIdent,
    star: procedureIdent,
    starTransition: procedureIdent,
  }),
  fuel: Object.freeze({
    taxi: finiteNumber,
    trip: finiteNumber,
    contingency: finiteNumber,
    alternate: finiteNumber,
    reserve: finiteNumber,
    extra: finiteNumber,
    takeoff: finiteNumber,
    landing: finiteNumber,
  }),
  weights: Object.freeze({
    passengers: finiteNumber,
    cargo: finiteNumber,
    payload: finiteNumber,
    zeroFuel: finiteNumber,
    ramp: finiteNumber,
    takeoff: finiteNumber,
    landing: finiteNumber,
    maxTakeoff: finiteNumber,
    maxLanding: finiteNumber,
  }),
  performance: Object.freeze({
    averageWindComponent: finiteNumber,
    averageWindDirection: finiteNumber,
    averageWindSpeed: finiteNumber,
    routeDistance: finiteNumber,
    airDistance: finiteNumber,
    greatCircleDistance: finiteNumber,
    cruiseTas: finiteNumber,
    stepClimbs: (value) => boundedString(value, 200),
  }),
  weather: Object.freeze({
    originMetar: (value) => boundedString(value, 2000),
    originTaf: (value) => boundedString(value, 2000),
    destinationMetar: (value) => boundedString(value, 2000),
    destinationTaf: (value) => boundedString(value, 2000),
    alternateMetar: (value) => boundedString(value, 2000),
    alternateTaf: (value) => boundedString(value, 2000),
    etopsMetar: (value) => boundedString(value, 2000),
    etopsTaf: (value) => boundedString(value, 2000),
  }),
});

const NAVLOG_FIX_FIELDS: Readonly<Record<string, FieldSanitizer>> = Object.freeze({
  ident: (value) => boundedString(value, 12),
  type: (value) => boundedString(value, 24),
  altitude: finiteNumber,
  windDirection: finiteNumber,
  windSpeed: finiteNumber,
  temperature: finiteNumber,
  distance: finiteNumber,
  legTime: finiteNumber,
  fuelRemaining: finiteNumber,
});

function sanitizeGroup(source: unknown, fields: Readonly<Record<string, FieldSanitizer>>): AnyRecord | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const group: AnyRecord = {};
  for (const [key, sanitize] of Object.entries(fields)) {
    if (!hasOwn(source, key)) continue;
    group[key] = sanitize((source as AnyRecord)[key]);
  }
  return group;
}

function sanitizeNavlog(source: unknown): AnyRecord[] | null {
  if (!Array.isArray(source)) return null;
  const fixes: AnyRecord[] = [];
  for (const entry of source.slice(0, MAX_NAVLOG_FIXES)) {
    const fix = sanitizeGroup(entry, NAVLOG_FIX_FIELDS);
    if (fix && typeof fix.ident === 'string') fixes.push(fix);
  }
  return fixes;
}

/**
 * Copy the recognised flight-plan fields out of `source`, bounding every
 * value. Fields the source does not carry are omitted; fields it carries
 * with an unusable value become null so a stale value never survives.
 */
export function sanitizeFlightPlanFields(source: unknown): AnyRecord {
  const plan: AnyRecord = {};
  if (!source || typeof source !== 'object') return plan;
  const record = source as AnyRecord;
  for (const [key, sanitize] of Object.entries(FLIGHT_PLAN_SCALAR_FIELDS)) {
    if (!hasOwn(record, key)) continue;
    plan[key] = record[key] === null ? null : sanitize(record[key]);
  }
  for (const [key, fields] of Object.entries(FLIGHT_PLAN_GROUP_FIELDS)) {
    if (!hasOwn(record, key)) continue;
    plan[key] = sanitizeGroup(record[key], fields);
  }
  if (hasOwn(record, 'navlog')) plan.navlog = sanitizeNavlog(record.navlog);
  return plan;
}

export { boundedString as boundedFlightPlanString, finiteNumber as finiteFlightPlanNumber };
