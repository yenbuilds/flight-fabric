#!/usr/bin/env node
/**
 * test-schema-coverage.js
 *
 * Guard: ensures every field in the buildVreEnrichedFrame() output is either
 * captured by a schema-field-map.ts extractor OR explicitly listed in SKIP_KEYS.
 *
 * HOW IT WORKS
 * ─────────────
 * 1. Calls buildVreEnrichedFrame() with a fully-populated dummy frame so that
 *    all keys are present in the returned object.
 * 2. Wraps the result in a Proxy that records every top-level property access.
 * 3. Runs every extractor in FIELD_MAP against the proxied frame.
 * 4. Any enriched-frame key that was never touched by any extractor, AND is
 *    not in SKIP_KEYS, is reported as an error.
 *
 * WHEN TO UPDATE THIS FILE
 * ─────────────────────────
 * • You added a field to buildVreEnrichedFrame() AND added a schema column → test passes.
 * • You added a field to buildVreEnrichedFrame() without a schema column → test fails.
 *   Fix: add the column to schema-field-map.ts, OR add the key to SKIP_KEYS with a reason.
 * • You removed a field from buildVreEnrichedFrame() → update SKIP_KEYS if it was there.
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { buildVreEnrichedFrame } = require(resolveBackendRuntimeFile('core', 'simbridge-core-utils.js'));
const {
  FIELD_MAP,
  buildRow,
  getField,
  getV1Columns,
} = require(resolveBackendRuntimeFile('flight-recording', 'schema-field-map.js'));

// ─────────────────────────────────────────────────────────────────────────────
// Keys intentionally NOT mapped to a CSV column.
// Each entry must have a reason comment.
// ─────────────────────────────────────────────────────────────────────────────
const SKIP_KEYS = new Set([
  // The merged FDM object itself — its individual sub-properties (eng1N1, oatC, etc.)
  // are accessed directly on f.fdm inside many extractors, but the blob is not a column.
  'fdm',

  // Expanded into assist_* columns.
  'assists',

  // Always null in the current implementation — buildVreEnrichedFrame hardcodes null.
  'stabilityScore',

  // Epoch-ms form of the flight start time. The ISO string is captured via flight_start_iso.
  'flightStartEpochMs',

  // Alias for timestampMs (both set to nowEpochMs). The `ts` column extractor reads
  // f.timestampMs first; since it is always non-null the f.ts fallback is never
  // reached and the Proxy never sees it accessed. Not a gap — the value IS recorded
  // via the `ts` column.
  'ts',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Build a fully-populated dummy enriched frame.
// Every field returned by buildVreEnrichedFrame must have a non-undefined value
// so the Proxy can confirm it exists in the output shape.
// ─────────────────────────────────────────────────────────────────────────────
const dummyFdm = {
  tasKts: 280,
  aileronPct: 5, elevatorPct: -2, rudderPct: 0,
  yokeXPct: 10, yokeYPct: -5, rudderPedalPct: 0,
  pitchRateRadS: 0.01, rollRateRadS: 0, yawRateRadS: 0,
  oatC: -50, tatC: -40, pressureMb: 253, seaLevelPressureMb: 1013,
  visibilityM: 50000, precipRateMm: 0, precipState: 0, inCloud: false,
  surfaceCondition: 0, densityAltFt: 38000,
  cabinAltFt: 7500, cabinAltRateFpm: 200, cabinDeltaPPsi: 7.8,
  cabinAltTargetFt: 8000, cabinDumpSwitch: false,
  eng1N1: 85, eng2N1: 85, eng3N1: 82, eng4N1: 83,
  eng1N2: 90, eng2N2: 90, eng3N2: 88, eng4N2: 89,
  eng1EgtC: 650, eng2EgtC: 650, eng3EgtC: 640, eng4EgtC: 645,
  eng1FfPph: 5000, eng2FfPph: 5000, eng3FfPph: 4900, eng4FfPph: 4950,
  fuelTotalGal: 15000, fuelTotalPct: 74, fuelTotalWeightLbs: 100500, fuelWeightPerGal: 6.7,
  grossWeightLbs: 450000, cgPct: 25,
  apMaster: true, apAltHold: true, apHdgHold: false, apNavHold: true,
  apApprHold: false, apVsHold: false, apFlcHold: false, apSpeedHold: false,
  apFdActive: true, athrActive: true, athrArmed: true,
  apAltTargetFt: 35000, apHdgTargetDeg: 90, apVsTargetFpm: -1000,
  apSpeedTargetKts: 280, apMachTarget: 0.82,
  // Fields sourced from frame.fdm via mergeFdmData — must be present so the
  // schema extractors (f.fdm?.X fallback chains) can reach non-undefined values.
  mach: 0.82,
  aoaDeg: 2.1, sideslipDeg: 0.3, trackTrueDeg: 92.0,
  gForceLateral: 0.01, gForceLongitudinal: 0.02,
  elevTrimPct: 0.5,
  nav1GsiRaw: 119, nav1CdiRaw: -127,
  nav1HasGlideSlope: true, nav1HasLocalizer: true, nav1Signal: 98,
  gsDeviationDots: 0.05, locDeviationDots: -0.1,
};

const dummyFrame = {
  wow: false, lat: 51.47, lon: -0.45,
  gforce: 1.01,
  // Fields that buildVreEnrichedFrame reads from frame.fdm:
  fdm: { mach: 0.82, aoaDeg: 2.1, sideslipDeg: 0.3, trackTrueDeg: 92.0,
         gForceLateral: 0.01, gForceLongitudinal: 0.02 },
  // WASM sidecar ILS deviation path (ilsGsDeviation / ilsLocDeviation):
  ilsGsDeviation: 0.05, ilsLocDeviation: -0.1,
  surface: { raw: 1, name: 'Asphalt', class: 'hard' },
  simTime: {
    zuluSec: 43200,
    localSec: 39600,
    zuluHms: '12:00:00',
    localHms: '11:00:00',
    zuluDate: '2026-06-07',
    localDate: '2026-06-07',
    zuluIso: '2026-06-07T12:00:00Z',
    localIso: '2026-06-07T11:00:00',
    zuluYear: 2026,
    zuluMonth: 6,
    zuluDay: 7,
    zuluDayOfYear: 158,
    zuluDayOfWeek: 0,
    localYear: 2026,
    localMonth: 6,
    localDay: 7,
    localDayOfYear: 158,
    localDayOfWeek: 6,
    timezoneOffsetSec: -3600,
    absoluteSec: 63884995200,
    timeOfDay: 3,
    zuluSunriseSec: 21000,
    zuluSunsetSec: 69000,
    source: 'simconnect',
    valid: true,
  },
  simconnect: { simVersion: '12.0.0' },
  assists: {
    unlimitedFuel: false,
    landingAssist: false,
    takeoffAssist: false,
    aiControls: false,
    aiAutotrim: false,
    aiDelegated: false,
    aiAntistall: 2,
    aiAntistallActive: false,
    realismPercent: 100,
    fullRealism: true,
    slewActive: false,
    anyAssistActive: false,
  },
  yoke: { x: 0.1, y: -0.2 },
  spoilers: { percent: 0, state: 'STOWED' },
};

const now = Date.now();
const enrichedFrame = buildVreEnrichedFrame({
  frame: dummyFrame,
  fdm: dummyFdm,
  userId: 'u-test',
  sessionId: 's-test',
  nowEpochMs: now,
  timestampIso: new Date(now).toISOString(),
  flightId: 'f-test',
  flightStartIso: '2026-01-01T00:00:00.000Z',
  flightStartEpochMs: now - 3600000,
  sampleRateHz: 2,
  escalationReason: null,
  phase: 'FINAL',
  stability: 'STABLE',
  iasKnots: 145,
  gs: 148,
  vsFeetPerMin: -700,
  altMslFt: 2000,
  raFeet: 1900,
  xwind: 8,
  trend: -2,
  headingData: { hdgTrueDeg: 270, hdgMagDeg: 265, magvarDeg: 5 },
  pitchDeg: -3.2,
  bankDeg: 1.1,
  maxPitchBankDeg: 179,
  windSpeed: 15,
  windDir: 270,
  gearDownLocked: true,
  flapsNotch: 3,
  flaps: 75,
  spoilerPct: 0,
  spoilerState: 'ARMED',
  brakePct: 0,
  thr1Pct: 65,
  thr2Pct: 65,
  thr3Pct: 62,
  thr4Pct: 63,
  profileId: 'boeing-747-400',
  signalReliability: 'authoritative',
  dataSource: 'simconnect',
  aircraftName: 'Boeing 747-400',
  elapsedMs: 3600000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Proxy: record which top-level keys are accessed by any extractor
// ─────────────────────────────────────────────────────────────────────────────
function validateFieldMapContract(frame) {
  const errors = [];

  if (!Array.isArray(FIELD_MAP) || FIELD_MAP.length === 0) {
    return ['FIELD_MAP must be a non-empty array'];
  }

  const names = FIELD_MAP.map((field) => field && field.name);
  const seen = new Set();
  const duplicates = new Set();

  for (const [index, field] of FIELD_MAP.entries()) {
    if (!field || typeof field !== 'object') {
      errors.push(`FIELD_MAP[${index}] must be an object`);
      continue;
    }

    if (typeof field.name !== 'string' || field.name.length === 0) {
      errors.push(`FIELD_MAP[${index}] must have a non-empty name`);
    } else {
      if (!/^[a-z0-9_]+$/.test(field.name)) {
        errors.push(`FIELD_MAP column "${field.name}" must be snake_case ASCII`);
      }
      if (seen.has(field.name)) duplicates.add(field.name);
      seen.add(field.name);
    }

    if (typeof field.extract !== 'function') {
      errors.push(`FIELD_MAP column "${field.name || index}" must have an extract function`);
    }
    if (typeof field.format !== 'function') {
      errors.push(`FIELD_MAP column "${field.name || index}" must have a format function`);
    }

    if (typeof field.extract === 'function' && typeof field.format === 'function') {
      try {
        const formatted = field.format(field.extract(frame));
        if (typeof formatted !== 'string') {
          errors.push(`FIELD_MAP column "${field.name}" formatter returned ${typeof formatted}, expected string`);
        }
        if (formatted === 'undefined' || formatted === 'NaN' || formatted === 'Invalid Date') {
          errors.push(`FIELD_MAP column "${field.name}" formatted invalid sentinel "${formatted}"`);
        }
      } catch (err) {
        errors.push(`FIELD_MAP column "${field.name}" threw on representative frame: ${err.message}`);
      }
    }
  }

  if (duplicates.size > 0) {
    errors.push(`FIELD_MAP duplicate column name(s): ${[...duplicates].join(', ')}`);
  }

  const v1Columns = getV1Columns();
  if (JSON.stringify(v1Columns) !== JSON.stringify(names)) {
    errors.push('getV1Columns() must return FIELD_MAP names in order');
  }

  for (const [index, name] of names.entries()) {
    if (getField(name) !== FIELD_MAP[index]) {
      errors.push(`getField("${name}") must return the matching FIELD_MAP entry`);
    }
  }

  let row;
  try {
    row = buildRow(frame);
  } catch (err) {
    errors.push(`buildRow() threw on representative frame: ${err.message}`);
    return errors;
  }

  const rowKeys = Object.keys(row);
  if (rowKeys.length !== names.length) {
    errors.push(`buildRow() produced ${rowKeys.length} unique columns for ${names.length} FIELD_MAP entries`);
  }

  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(row, name)) {
      errors.push(`buildRow() missing column "${name}"`);
      continue;
    }
    if (typeof row[name] !== 'string') {
      errors.push(`buildRow() column "${name}" returned ${typeof row[name]}, expected string`);
    }
    if (row[name] === 'undefined' || row[name] === 'NaN' || row[name] === 'Invalid Date') {
      errors.push(`buildRow() column "${name}" formatted invalid sentinel "${row[name]}"`);
    }
  }

  return errors;
}

const accessed = new Set();
const proxiedFrame = new Proxy(enrichedFrame, {
  get(target, key) {
    if (typeof key === 'string') accessed.add(key);
    return target[key];
  },
});

for (const field of FIELD_MAP) {
  try {
    field.extract(proxiedFrame);
  } catch {
    // Ignore extractor errors — we only care about which keys were touched.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
const allFrameKeys = new Set(Object.keys(enrichedFrame));
const uncovered = [...allFrameKeys].filter(k => !accessed.has(k) && !SKIP_KEYS.has(k));
const fieldMapContractErrors = validateFieldMapContract(enrichedFrame);

console.log('Schema coverage check:');
console.log(`  FIELD_MAP columns: ${FIELD_MAP.length}`);
console.log(`  Enriched frame keys : ${allFrameKeys.size}`);
console.log(`  Skipped (intentional): ${[...allFrameKeys].filter(k => SKIP_KEYS.has(k)).length}`);
console.log(`  Accessed by extractors: ${[...allFrameKeys].filter(k => accessed.has(k)).length}`);

if (fieldMapContractErrors.length > 0) {
  console.error(`\n  x ${fieldMapContractErrors.length} schema-field-map contract error(s):`);
  for (const error of fieldMapContractErrors) {
    console.error(`      - ${error}`);
  }
  process.exit(1);
}

if (uncovered.length === 0) {
  console.log(`  ✓ All enriched frame keys are covered by schema-field-map.ts`);
  process.exit(0);
} else {
  console.error(`\n  ✗ ${uncovered.length} enriched frame key(s) have no schema column:`);
  for (const key of uncovered) {
    console.error(`      - ${key}`);
  }
  console.error(`
  Fix: add a column to schema-field-map.ts for each key above,
       OR add the key to SKIP_KEYS in scripts/test-schema-coverage.js with a reason.
`);
  process.exit(1);
}
