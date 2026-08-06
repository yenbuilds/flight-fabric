#!/usr/bin/env node
/**
 * Critical CSV Event Contract
 *
 * This guard covers the event payload path that sample-frame schema coverage
 * cannot see: landing:final -> simbridge-core -> flight-csv-writer ->
 * schema-field-map -> timeline replay -> logbook CSV reader.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const schemaFieldMap = require(resolveBackendRuntimeFile('flight-recording', 'schema-field-map.js'));
const {
  buildLandingCsvEventData,
  getCriticalLandingCsvMappings,
} = require(resolveBackendRuntimeFile('flight-recording', 'landing-csv-contract.js'));
const timelineGenerator = require(resolveBackendRuntimeFile('events', 'timeline-generator.js'));
const flightLogbook = require(resolveBackendRuntimeFile('landing', 'flight-logbook.js'));
const {
  computeFlightSummaryFromRows,
  readFlightSummary,
} = require(resolveBackendRuntimeFile('flight-recording', 'read-flight-summary.js'));
const { parseCsvLine, splitCsvLines } = require(resolveBackendRuntimeFile('utils', 'csv.js'));
const { gradeLanding } = require(resolveBackendRuntimeFile('landing', 'landing.js'));

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed += 1;
  }
}

function escapeCsv(value) {
  const stringValue = String(value ?? '');
  return /[",\n\r]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}

function csvLine(headers, row) {
  return headers.map((header) => escapeCsv(row[header])).join(',');
}

function buildDutchRollSampleRows(options = {}) {
  const rows = [];
  const baseTs = options.baseTs || 1770000000000;
  const phase = options.phase || 'CRUISE';
  const paused = options.paused === true;
  for (let index = 0; index <= 24; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    rows.push({
      record_type: 'SAMPLE',
      ts: baseTs + (index * 1000),
      timestamp_ms: baseTs + (index * 1000),
      phase,
      on_ground: false,
      sim_paused: paused,
      sim_in_menu: false,
      alt_msl_ft: 32000,
      ra_ft: 32000,
      ias_kts: 252,
      gs_kts: 452,
      bank_deg: Math.sin(angle) * 4.2,
      yaw_rate_rad_s: (Math.sin(angle) * 1.4) * (Math.PI / 180),
      sideslip_deg: Math.sin(angle + 0.45) * 1.2,
      hdg_true_deg: 90,
      track_true_deg: 90 - (Math.sin(angle + 0.45) * 1.2),
    });
  }
  return rows;
}

function buildHoldingPatternSampleRows(options = {}) {
  const rows = [];
  const baseTs = options.baseTs || 1771000000000;
  const loopCount = options.loopCount || 2;
  const loopDurationSeconds = 240;
  const baseLat = -33.94;
  const baseLon = 151.18;
  const lonScale = 60 * Math.cos(baseLat * Math.PI / 180);

  for (let elapsedSeconds = 0; elapsedSeconds <= loopCount * loopDurationSeconds; elapsedSeconds += 5) {
    const cycleSeconds = elapsedSeconds % loopDurationSeconds;
    let eastNm;
    let northNm;
    let trackDeg;
    if (cycleSeconds <= 60) {
      eastNm = -3 + (cycleSeconds / 60) * 6;
      northNm = 1;
      trackDeg = 90;
    } else if (cycleSeconds <= 120) {
      const theta = 90 - ((cycleSeconds - 60) / 60) * 180;
      eastNm = 3 + Math.cos(theta * Math.PI / 180);
      northNm = Math.sin(theta * Math.PI / 180);
      trackDeg = 180 - theta;
    } else if (cycleSeconds <= 180) {
      eastNm = 3 - ((cycleSeconds - 120) / 60) * 6;
      northNm = -1;
      trackDeg = 270;
    } else {
      const theta = -90 - ((cycleSeconds - 180) / 60) * 180;
      eastNm = -3 + Math.cos(theta * Math.PI / 180);
      northNm = Math.sin(theta * Math.PI / 180);
      trackDeg = 180 - theta;
    }

    // Repeatable asymmetric offsets approximate a wind-distorted ground track.
    const cycleRadians = (cycleSeconds / loopDurationSeconds) * Math.PI * 2;
    eastNm += Math.sin(cycleRadians) * 0.18;
    northNm += Math.sin(cycleRadians * 2) * 0.12;
    const timestamp = baseTs + elapsedSeconds * 1000;
    rows.push({
      record_type: 'SAMPLE',
      ts: timestamp,
      timestamp_ms: timestamp,
      phase: options.phase || 'APPROACH',
      on_ground: false,
      sim_paused: false,
      sim_in_menu: false,
      lat_deg: baseLat + (northNm / 60),
      lon_deg: baseLon + (eastNm / lonScale),
      alt_msl_ft: 6000 + Math.sin(cycleRadians) * 120,
      ra_ft: 5000,
      ias_kts: 180,
      gs_kts: 190,
      bank_deg: 0,
      hdg_true_deg: ((trackDeg % 360) + 360) % 360,
      track_true_deg: ((trackDeg % 360) + 360) % 360,
    });
  }
  return rows;
}

function buildCircularOrbitSampleRows() {
  const rows = [];
  const baseTs = 1772000000000;
  const baseLat = -33.94;
  const baseLon = 151.18;
  const lonScale = 60 * Math.cos(baseLat * Math.PI / 180);
  for (let elapsedSeconds = 0; elapsedSeconds <= 240; elapsedSeconds += 5) {
    const angleDeg = 90 - (elapsedSeconds / 240) * 360;
    const angleRad = angleDeg * Math.PI / 180;
    const timestamp = baseTs + elapsedSeconds * 1000;
    rows.push({
      record_type: 'SAMPLE',
      ts: timestamp,
      timestamp_ms: timestamp,
      phase: 'CRUISE',
      on_ground: false,
      sim_paused: false,
      sim_in_menu: false,
      lat_deg: baseLat + ((Math.sin(angleRad) * 2) / 60),
      lon_deg: baseLon + ((Math.cos(angleRad) * 2) / lonScale),
      alt_msl_ft: 8000,
      ias_kts: 180,
      gs_kts: 190,
      hdg_true_deg: ((180 - angleDeg) % 360 + 360) % 360,
      track_true_deg: ((180 - angleDeg) % 360 + 360) % 360,
    });
  }
  return rows;
}

function buildPostFlightInsightRows() {
  const rows = [];
  const baseTs = 1773000000000;
  const baseLat = -33.94;
  const baseLon = 151.18;
  const lonScale = 60 * Math.cos(baseLat * Math.PI / 180);
  let eastNm = 0;

  for (let elapsedSeconds = 0; elapsedSeconds <= 900; elapsedSeconds += 10) {
    if (elapsedSeconds > 0) {
      const previousElapsed = elapsedSeconds - 10;
      const previousAirborne = previousElapsed >= 120 && previousElapsed < 900;
      eastNm += (previousAirborne ? 180 : 12) * (10 / 3600);
    }
    const airborne = elapsedSeconds >= 120 && elapsedSeconds < 900;
    const onGround = !airborne;
    const approach = elapsedSeconds >= 720 && elapsedSeconds < 900;
    const raFt = approach
      ? Math.max(0, 3000 - ((elapsedSeconds - 720) * (3000 / 180)))
      : airborne ? 5000 : 0;
    const timestamp = baseTs + elapsedSeconds * 1000;
    rows.push({
      record_type: 'SAMPLE',
      ts: timestamp,
      timestamp_ms: timestamp,
      phase: elapsedSeconds < 120 ? 'TAXI' : approach ? 'APPROACH' : airborne ? 'CRUISE' : 'LANDING',
      on_ground: onGround,
      sim_paused: elapsedSeconds >= 60 && elapsedSeconds < 90,
      sim_in_menu: false,
      lat_deg: baseLat,
      lon_deg: baseLon + (eastNm / lonScale),
      alt_msl_ft: airborne ? 6000 : 20,
      ra_ft: raFt,
      ias_kts: airborne ? 175 : 10,
      gs_kts: airborne ? 180 : elapsedSeconds < 900 ? 12 : 0,
      bank_deg: elapsedSeconds === 650 ? 25 : 4,
      g_force: elapsedSeconds === 600 || elapsedSeconds === 610 ? 1.3 : 1,
      g_force_lateral: elapsedSeconds === 620 ? 0.12 : 0.02,
      g_force_longitudinal: 0.03,
      fuel_total_gal: 1000 - (elapsedSeconds * (100 / 900)),
      fuel_total_weight_lbs: 6000 - (elapsedSeconds * (600 / 900)),
      fuel_weight_per_gal: 6,
      ap_master: airborne && elapsedSeconds < 780,
      ap_reliable: true,
      in_cloud: elapsedSeconds >= 480 && elapsedSeconds < 600,
      precip_rate_mm: elapsedSeconds >= 520 && elapsedSeconds < 580 ? 1.2 : 0,
      precip_state: elapsedSeconds >= 520 && elapsedSeconds < 580 ? 2 : 0,
      wind_speed_kts: elapsedSeconds === 600 ? 45 : 20,
      gear_down_locked: elapsedSeconds >= 840,
      flaps_notch: elapsedSeconds >= 870 ? '30' : elapsedSeconds >= 800 ? '20' : '0',
      flaps_pct: elapsedSeconds >= 870 ? 75 : elapsedSeconds >= 800 ? 50 : 0,
      hdg_true_deg: 90,
      track_true_deg: 90,
    });
  }
  return rows;
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function extractStabilityBreakdownMetricKeys() {
  const source = stripComments(readSource(path.join('backend', 'stability', 'stability-runner.ts')));
  const match = source.match(/type\s+StabilityBreakdown\s*=\s*\{([\s\S]*?)\};/);
  assert(match, 'could not find StabilityBreakdown type in stability-runner.ts');

  const keys = new Set();
  const fieldRe = /^\s*([a-zA-Z0-9_]+)\??:\s*number\b/gm;
  let fieldMatch;
  while ((fieldMatch = fieldRe.exec(match[1])) !== null) {
    keys.add(fieldMatch[1]);
  }
  return Array.from(keys).sort();
}

function flatStabilityColumn(metricKey) {
  return `ultimate_stability_${metricKey}_pct`;
}

const EXPECTED_STABILITY_BREAKDOWN_METRICS = Object.freeze([
  'bank_ok',
  'config_ok',
  'flaps_ok',
  'gear_ok',
  'glidepath_above_ok',
  'glidepath_below_ok',
  'glidepath_ok',
  'lateral_offset_ok',
  'pitch_ok',
  'speed_ok',
  'speed_trend_ok',
  'spoilers_ok',
  'thrust_not_idle_ok',
  'thrust_ok',
  'thrust_stable_ok',
  'vs_ok',
]);

function assertSameStringSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  const missing = expectedSorted.filter((value) => !actualSorted.includes(value));
  const extra = actualSorted.filter((value) => !expectedSorted.includes(value));
  assert(
    missing.length === 0 && extra.length === 0,
    `${label} drifted; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
  );
}

const landingPayload = {
  schema_version: 2,
  user_id: 'user-contract',
  session_id: 'session-contract',
  timestamp_ms: 1770000000123,
  timestamp_utc: '2026-02-03T04:05:00.123Z',
  flight_start: '2026-02-03T03:30:00.000Z',
  flight_elapsed_ms: 2100123,
  aircraft: 'Contract Test 737',
  sim_version: '1.2.3',
  aircraft_profile_id: 'contract-737',
  data_source: 'simconnect',
  assists: {
    unlimitedFuel: false,
    landingAssist: true,
    takeoffAssist: false,
    aiControls: true,
    aiAutotrim: false,
    aiDelegated: true,
    aiAntistall: 1,
    aiAntistallActive: true,
    realismPercent: 75,
    fullRealism: false,
    slewActive: false,
    anyAssistActive: true,
  },
  assist_unlimited_fuel: false,
  assist_landing_enabled: true,
  assist_takeoff_enabled: false,
  assist_ai_controls: true,
  assist_ai_autotrim: false,
  assist_ai_delegated: true,
  assist_ai_antistall_state: 1,
  assist_ai_antistall_active: true,
  assist_realism_pct: 75,
  assist_full_realism: false,
  assist_slew_active: false,
  assist_any_active: true,
  icao: 'YSSY',
  runway: '34L',
  approach_type: 'ILS',
  vs_fpm: -420,
  ias_kts: 132,
  gs_kts: 126,
  grade: 'Good',
  gforce: 1.23,
  lat_deg: -33.9461,
  lon_deg: 151.1772,
  hdg_true_deg: 344.2,
  hdg_mag_deg: 333.7,
  alt_msl_ft: 23,
  alt_indicated_ft: 23,
  alt_calibrated_ft: 18,
  alt_plane_ft: 17,
  ra_ft: 2,
  aircraft_agl_ft: 6,
  aircraft_above_obstacles_ft: 5,
  plane_agl_ft: 5,
  plane_agl_minus_cg_ft: 1,
  pressure_alt_ft: 108,
  kohlsman_setting_mb: 1013.25,
  kohlsman_tuned_mb: 1008.4,
  kohlsman_std: true,
  wind_speed_kts: 16,
  wind_dir_deg: 280,
  xwind_kts: 9,
  pitch_deg: 3.5,
  bank_deg: -1.2,
  touchdown_capture_source: 'msfs_last_touchdown',
  td_sim_source: 'msfs_last_touchdown',
  td_sim_trusted: true,
  td_sim_fresh: true,
  td_sim_reject_reason: 'none',
  td_sim_position_delta_ft: 33.4,
  td_sim_lat_deg: -33.9461,
  td_sim_lon_deg: 151.1772,
  td_sim_hdg_true_deg: 344.1,
  td_sim_hdg_mag_deg: 333.6,
  td_sim_pitch_deg: 3.6,
  td_sim_bank_deg: -1.1,
  td_sim_normal_velocity_fps: 7,
  td_sim_normal_velocity_fpm: 420,
  td_sim_landing_vs_fpm: -420,
  flaps_notch: 5,
  spoiler_state: 'ARMED',
  phase: 'LANDING',
  stability: 'STABLE',
  ultimate_stability_score: 87,
  ultimate_stability_samples: 42,
  ultimate_stability_gate_stable: false,
  ultimate_stability_gate_failures: ['speed_ok', 'gear_ok'],
  ultimate_stability_breakdown: { custom_ok: 77 },
  ultimate_stability_context: {
    schemaVersion: 1,
    profile: { id: 'generic', name: 'Generic Aircraft', reliability: 'generic' },
    criteria: { speedMinusKts: 50, speedPlusKts: 100 },
  },
  ultimate_stability_gear_ok_pct: 100,
  ultimate_stability_flaps_ok_pct: 95,
  ultimate_stability_spoilers_ok_pct: 90,
  ultimate_stability_config_ok_pct: 82,
  ultimate_stability_speed_ok_pct: 80,
  ultimate_stability_speed_trend_ok_pct: 75,
  ultimate_stability_vs_ok_pct: 70,
  ultimate_stability_glidepath_ok_pct: 65,
  ultimate_stability_glidepath_below_ok_pct: 64,
  ultimate_stability_glidepath_above_ok_pct: 63,
  ultimate_stability_thrust_ok_pct: 62,
  ultimate_stability_thrust_not_idle_ok_pct: 60,
  ultimate_stability_thrust_stable_ok_pct: 55,
  ultimate_stability_pitch_ok_pct: 50,
  ultimate_stability_bank_ok_pct: 45,
  ultimate_stability_lateral_offset_ok_pct: 70,
  surface_raw: 4,
  surface_name: 'Asphalt',
  surface_class: 'hard',
  surface_runway_like: true,
  surface_on_runway: false,
  surface_on_ground: true,
  surface_valid: true,
  runway_excursion: true,
  runway_occupancy_s: 42.5,
  rollout_analysis: {
    schemaVersion: 1,
    assessment: 'caution',
    maxBankDeg: 3.3,
    flags: [{ code: 'rollout_bank', severity: 'caution' }],
  },
  landing_final: true,
  fdm_surface_condition: 1,
  fdm_precip_state: 2,
  fdm_precip_rate_mm: 0.8,
  fdm_oat_c: 4.5,
  touchdown_distance_ft: -275,
  runway_geometry_source: 'ourairports',
  runway_geometry_provider_chain: 'msfs-facilities:miss,ourairports:hit',
  runway_geometry_fallback_reason: 'msfs-facilities:miss',
  runway_geometry_diagnostics: { providerChain: 'msfs-facilities:miss,ourairports:hit' },
  runway_heading_true_deg: 335.2,
  runway_length_ft: 8000,
  runway_physical_length_ft: 9000,
  runway_surface: 'ASPHALT',
  runway_threshold_lat: -33.9460,
  runway_threshold_lon: 151.1770,
  runway_physical_threshold_lat: -33.9500,
  runway_physical_threshold_lon: 151.1800,
  runway_displaced_threshold_ft: 1000,
  touchdown_distance_score: 0,
  touchdown_distance_grade: 'Short Landing',
  short_landing: true,
  runway_condition: 'wet',
  runway_condition_source: 'inferred',
  runway_condition_confident: true,
  lateral_offset_ft: 42,
  lateral_offset_side: 'right',
  lateral_offset_score: 85,
  lateral_offset_grade: 'Marginal',
  lateral_offset_suspect: false,
  runway_width_ft: 150,
  bounce_count: 2,
  bounce_grade: 'Multiple Bounces',
  bounce_score: 80,
  bounce_distance_ft: 95,
  bounce_worst_gforce: 1.8,
  first_touchdown_lat: -33.9462,
  first_touchdown_lon: 151.1771,
  first_touchdown_vs_fpm: -390,
  first_touchdown_gforce: 1.3,
  final_touchdown_lat: -33.9461,
  final_touchdown_lon: 151.1772,
  final_touchdown_vs_fpm: -420,
  final_touchdown_gforce: 1.8,
};

const mappings = getCriticalLandingCsvMappings();
const eventData = buildLandingCsvEventData(landingPayload, 'landing-contract');
const headers = schemaFieldMap.getV1Columns();
// These replay fixtures isolate landing-field recovery and deliberately model
// pre-bundle CSVs. A session-scoped header selects the current strict protocol,
// which also requires a manifest, both JSONL companions, and a completion
// certificate; those end-to-end obligations are covered by the bundle tests.
const legacyReplayHeaders = headers.filter((header) => header !== 'recording_session_id');
const landingRow = schemaFieldMap.buildRow({
  _recordType: 'LANDING',
  flightId: 'contract-flight',
  ...eventData,
});
const csvLandingRow = {
  ...landingRow,
  ultimate_stability_gate_stable: 'false',
  runway_excursion: 'true',
  short_landing: 'true',
};

console.log('\nCritical CSV event contract');

test('simbridge-core landing CSV path uses the contract helper', () => {
  const coreSource = readSource(path.join('backend', 'core', 'simbridge-core.ts'));
  assert(
    coreSource.includes('buildLandingCsvEventData(payload'),
    'landing:final CSV write must pass through buildLandingCsvEventData(payload, ...)',
  );
});

test('live runway geometry is resolved only after landing capture finalizes', () => {
  const coreSource = readSource(path.join('backend', 'core', 'simbridge-core.ts'));
  const runnerSource = readSource(path.join('backend', 'landing', 'landing-runner.ts'));
  const positionLookupCalls = runnerSource.match(/findRunwayByPosition\(/g) || [];
  const nearbyAirportLookupCalls = runnerSource.match(/findNearbyAirport\(/g) || [];
  const finalizationIndex = runnerSource.indexOf('if (shouldFinalizeRollout)');
  const finalLookupIndex = runnerSource.indexOf('resolveTouchdownGeometry(touchdownSummary, ctx)');

  assert(
    !coreSource.includes('createRunwayContextDetector'),
    'live core must not run the runway detector during approach',
  );
  assert(
    !coreSource.includes('findRunwayByPosition') && !coreSource.includes('findNearbyAirport'),
    'landing:final scoring must reuse the canonical payload instead of querying geometry again',
  );
  assert(
    coreSource.includes('resolveLandingGeometryScoringInputs(payload)'),
    'landing:final scoring must consume the resolved final geometry payload',
  );
  assert(positionLookupCalls.length === 1, 'landing runner must contain exactly one position lookup');
  assert(nearbyAirportLookupCalls.length === 1, 'landing runner must contain only one airport-only miss fallback');
  assert(finalizationIndex >= 0, 'landing runner rollout finalization guard is missing');
  assert(
    finalLookupIndex > finalizationIndex,
    'runway lookup must occur only after bounce and rollout capture have finalized',
  );
  assert(!runnerSource.includes('earlyRunway'), 'touchdown-time runway lookup must remain removed');
});

test('critical landing mappings are unique and target real CSV columns', () => {
  const payloadKeys = new Set();
  const columns = new Set(headers);
  for (const mapping of mappings) {
    assert(!payloadKeys.has(mapping.payloadKey), `duplicate payload mapping for ${mapping.payloadKey}`);
    payloadKeys.add(mapping.payloadKey);
    assert(columns.has(mapping.column), `critical column missing from schema: ${mapping.column}`);
  }
});

test('landing CSV event builder preserves every critical payload key', () => {
  for (const mapping of mappings) {
    assert(
      eventData[mapping.payloadKey] !== undefined,
      `event data dropped critical payload key: ${mapping.payloadKey}`,
    );
  }
  assert(eventData.vs === landingPayload.vs_fpm, 'event data must provide vs alias for schema');
  assert(eventData.gForce === landingPayload.gforce, 'event data must provide gForce alias for schema');
});

test('landing CSV event builder forces LANDING phase while preserving detector phase hint', () => {
  const quickTurnEventData = buildLandingCsvEventData({
    ...landingPayload,
    phase: 'CLIMB',
  }, 'quick-turn-landing');
  const quickTurnRow = schemaFieldMap.buildRow({
    _recordType: 'LANDING',
    flightId: 'quick-turn-flight',
    ...quickTurnEventData,
  });

  assert(quickTurnEventData.phase === 'LANDING', `expected event phase LANDING, got ${quickTurnEventData.phase}`);
  assert(quickTurnEventData.flight_phase_hint === 'CLIMB', `expected detector phase hint CLIMB, got ${quickTurnEventData.flight_phase_hint}`);
  assert(quickTurnRow.phase === 'LANDING', `expected CSV phase LANDING, got ${quickTurnRow.phase}`);
  assert(quickTurnRow.flight_phase_hint === 'CLIMB', `expected CSV flight_phase_hint CLIMB, got ${quickTurnRow.flight_phase_hint}`);
});

test('backend stability breakdown metric set is fixed to the approved contract', () => {
  assertSameStringSet(
    extractStabilityBreakdownMetricKeys(),
    EXPECTED_STABILITY_BREAKDOWN_METRICS,
    'StabilityBreakdown metric set',
  );
});

test('every backend stability breakdown metric has a first-class CSV and UI contract', () => {
  const metricKeys = extractStabilityBreakdownMetricKeys();
  const mappedColumns = new Set(mappings.map((mapping) => mapping.column));
  const schemaColumns = new Set(headers);
  const landingRunnerSource = readSource(path.join('backend', 'landing', 'landing-runner.ts'));
  const coreSource = readSource(path.join('backend', 'core', 'simbridge-core.ts'));
  const timelineSource = readSource(path.join('backend', 'events', 'timeline-generator.ts'));
  const logbookSource = readSource(path.join('backend', 'landing', 'flight-logbook.ts'));
  const frontendSource = readSource(path.join('frontend', 'src', 'landing', 'controller.js'));

  for (const metricKey of metricKeys) {
    const column = flatStabilityColumn(metricKey);
    assert(schemaColumns.has(column), `schema-field-map missing flat stability column for ${metricKey}: ${column}`);
    assert(mappedColumns.has(column), `landing CSV contract missing ${column}`);
    assert(landingRunnerSource.includes(`${column}:`) && landingRunnerSource.includes(`pct('${metricKey}')`), `landing-runner does not flatten ${metricKey}`);
    assert(coreSource.includes(`${column}: pct('${metricKey}')`), `simbridge-core live landing path does not flatten ${metricKey} before CSV write`);
    assert(coreSource.includes(`${column}: payload.${column}`), `simbridge-core CSV write payload does not include ${column}`);
    assert(timelineSource.includes(`['${metricKey}', row.${column}]`), `timeline replay does not recover ${metricKey} from ${column}`);
    assert(logbookSource.includes(`['${metricKey}', '${column}']`), `logbook CSV reader does not recover ${metricKey} from ${column}`);
    assert(frontendSource.includes(`${metricKey}:`), `frontend stability debug UI has no label/description metadata for ${metricKey}`);
  }
});

test('simbridge-core computes current-approach stability before writing LANDING CSV rows', () => {
  const coreSource = readSource(path.join('backend', 'core', 'simbridge-core.ts'));
  const scoreIndex = coreSource.indexOf('currentApproachScorePayload = {');
  const writeIndex = coreSource.indexOf("flightCsvWriter.writeEvent('LANDING'");
  assert(scoreIndex >= 0, 'could not find current approach score assignment');
  assert(writeIndex >= 0, 'could not find LANDING CSV write');
  assert(scoreIndex < writeIndex, 'LANDING CSV row is written before current approach stability has been flattened into payload');
});

test('landing rows use the same canonical aircraft profile id as sample rows', () => {
  const coreSource = readSource(path.join('backend', 'core', 'simbridge-core.ts'));
  assert(
    coreSource.includes("aircraftProfileId: profileLoader.getActiveProfile()?.id || 'generic'"),
    'landing context should use profile.id for aircraft_profile_id',
  );
  assert(
    !coreSource.includes('aircraftProfileId: profileLoader.getActiveProfile()?._qualifiedId'),
    'landing context must not use _qualifiedId because sample rows use profile.id',
  );
});

test('landing CSV event builder normalizes event ID aliases', () => {
  const explicit = buildLandingCsvEventData({ event_id: 'source-snake' }, 'explicit-id');
  assert(explicit.eventId === 'explicit-id', `explicit eventId mismatch: ${explicit.eventId}`);
  assert(explicit.event_id === 'explicit-id', `explicit event_id mismatch: ${explicit.event_id}`);

  const camelFallback = buildLandingCsvEventData({ eventId: 'source-camel' }, '');
  assert(camelFallback.eventId === 'source-camel', `camel fallback eventId mismatch: ${camelFallback.eventId}`);
  assert(camelFallback.event_id === 'source-camel', `camel fallback event_id mismatch: ${camelFallback.event_id}`);
});

test('flight summary suppresses dry motion-only convective rows but keeps true upset rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-summary-dry-convective-'));
  const csvPath = path.join(tmpDir, 'summary.csv');
  const headers = [
    'record_type',
    'ts',
    'timestamp_ms',
    'alt_msl_ft',
    'ias_kts',
    'rule_id',
    'label',
    'severity',
    'duration_ms',
    'convective_weather_available',
    'convective_precip_ratio',
    'convective_precip_rate_max_mm',
  ];
  const rows = [
    ['SAMPLE', 1700000000000, '', 5000, 220, '', '', '', '', '', '', ''],
    ['FLIGHT_VIOLATION_START', '', 1700000001000, '', '', 'convective_exposure', 'Convective Exposure Likelihood: HIGH', 'critical', '', 1, 0, 0],
    ['FLIGHT_VIOLATION_END', '', 1700000011000, '', '', 'convective_exposure', 'Convective Exposure Likelihood: HIGH', 'critical', 10000, 1, 0, 0],
    ['FLIGHT_VIOLATION_START', '', 1700000012000, '', '', 'upset_bank', 'Bank upset (> 45 deg)', 'critical', '', '', '', ''],
    ['FLIGHT_VIOLATION_END', '', 1700000022000, '', '', 'upset_bank', 'Bank upset (> 45 deg)', 'critical', 10000, '', '', ''],
  ];

  try {
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => csvLine(headers, Object.fromEntries(headers.map((header, index) => [header, row[index]]))))].join('\n'), 'utf8');
    const summary = readFlightSummary(csvPath);
    assert(summary, 'expected summary from CSV');
    assert(summary.violations.length === 1, `expected only bank violation, got ${summary.violations.length}`);
    assert(summary.violations[0].rule_id === 'upset_bank', `expected upset_bank, got ${summary.violations[0].rule_id}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('flight summary refuses oversized CSVs before reading them into memory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-summary-oversize-'));
  const csvPath = path.join(tmpDir, 'oversized.csv');
  try {
    fs.writeFileSync(csvPath, 'record_type,ts\nSAMPLE,1700000000000\n', 'utf8');
    fs.truncateSync(csvPath, (200 * 1024 * 1024) + 1);
    const summary = readFlightSummary(csvPath);
    assert(summary === null, 'expected oversized summary CSV to fail closed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('flight summary suppresses convective rows even when precip evidence exists', () => {
  const summary = computeFlightSummaryFromRows([
    { record_type: 'SAMPLE', ts: 1700000000000, alt_msl_ft: 5000, ias_kts: 220 },
    {
      record_type: 'FLIGHT_VIOLATION_START',
      timestamp_ms: 1700000001000,
      rule_id: 'convective_exposure',
      label: 'Convective Exposure Likelihood: HIGH',
      severity: 'critical',
      convective_weather_available: 1,
      convective_precip_ratio: 0.3,
      convective_precip_rate_max_mm: 1.2,
    },
    {
      record_type: 'FLIGHT_VIOLATION_END',
      timestamp_ms: 1700000011000,
      rule_id: 'convective_exposure',
      label: 'Convective Exposure Likelihood: HIGH',
      severity: 'critical',
      duration_ms: 10000,
      convective_weather_available: 1,
      convective_precip_ratio: 0.3,
      convective_precip_rate_max_mm: 1.2,
    },
  ]);
  assert(summary, 'expected row-based summary');
  assert(summary.violations.length === 0, `expected convective rows to be suppressed, got ${summary.violations.length}`);
});

test('flight summary reports possible Dutch roll as informational cruise data', () => {
  const summary = computeFlightSummaryFromRows(buildDutchRollSampleRows());
  assert(summary, 'expected row-based summary');
  assert(summary.dutch_roll, 'expected Dutch roll summary');
  assert(summary.dutch_roll.detected === true, 'expected Dutch roll to be detected');
  assert(summary.dutch_roll.confidence === 'HIGH', `unexpected confidence ${summary.dutch_roll.confidence}`);
  assert(summary.dutch_roll.max_duration_ms >= 20000, `unexpected duration ${summary.dutch_roll.max_duration_ms}`);
  assert(summary.dutch_roll.max_bank_deg >= 3.5, `unexpected bank peak ${summary.dutch_roll.max_bank_deg}`);
  assert(summary.violations.length === 0, 'Dutch roll summary should not create a violation row');
});

test('flight summary ignores Dutch-roll-like motion while paused or on approach', () => {
  const pausedSummary = computeFlightSummaryFromRows(buildDutchRollSampleRows({ paused: true }));
  assert(pausedSummary, 'expected paused row-based summary');
  assert(pausedSummary.dutch_roll === null, 'paused samples should not produce a Dutch roll summary');

  const approachSummary = computeFlightSummaryFromRows(buildDutchRollSampleRows({ phase: 'APPROACH' }));
  assert(approachSummary, 'expected approach row-based summary');
  assert(approachSummary.dutch_roll === null, 'approach samples should not produce a Dutch roll summary');
});

test('flight summary reads Dutch roll evidence from CSV sample columns', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-summary-dutch-roll-'));
  const csvPath = path.join(tmpDir, 'summary.csv');
  const headers = [
    'record_type',
    'ts',
    'timestamp_ms',
    'phase',
    'on_ground',
    'sim_paused',
    'sim_in_menu',
    'alt_msl_ft',
    'ra_ft',
    'ias_kts',
    'gs_kts',
    'bank_deg',
    'yaw_rate_rad_s',
    'sideslip_deg',
    'hdg_true_deg',
    'track_true_deg',
  ];
  try {
    const rows = buildDutchRollSampleRows();
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => csvLine(headers, row))].join('\n'), 'utf8');
    const summary = readFlightSummary(csvPath);
    assert(summary, 'expected summary from CSV');
    assert(summary.dutch_roll?.detected === true, 'expected Dutch roll summary from CSV');
    assert(summary.violations.length === 0, 'Dutch roll CSV summary should remain informational');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('flight summary reports completed holding loops after a go-around without creating violations', () => {
  const summary = computeFlightSummaryFromRows([
    { record_type: 'GO_AROUND', timestamp_ms: 1770999999000 },
    ...buildHoldingPatternSampleRows(),
  ]);
  assert(summary, 'expected row-based summary');
  assert(summary.go_around_count === 1, `expected one go-around, got ${summary.go_around_count}`);
  assert(summary.holding?.detected === true, 'expected a holding-pattern summary');
  assert(summary.holding.loop_count === 2, `expected two holding loops, got ${summary.holding.loop_count}`);
  assert(
    summary.holding.duration_ms >= 440000 && summary.holding.duration_ms <= 500000,
    `unexpected holding duration ${summary.holding.duration_ms}`,
  );
  assert(summary.holding.episode_count === 1, `expected one holding episode, got ${summary.holding.episode_count}`);
  assert(
    summary.holding.duration_ms === summary.holding.end_ts - summary.holding.start_ts,
    'overlapping loop boundaries must not be counted twice in holding duration',
  );
  assert(
    summary.holding.episodes[0].duration_ms === summary.holding.duration_ms,
    'single-episode duration should match total holding duration',
  );
  assert(summary.violations.length === 0, 'holding should remain informational and must not create a violation');
});

test('holding detection ignores an intermittent missing altitude instead of treating it as sea level', () => {
  const rows = buildHoldingPatternSampleRows();
  rows[Math.floor(rows.length / 4)].alt_msl_ft = null;
  const summary = computeFlightSummaryFromRows(rows);
  assert(summary?.holding?.detected === true, 'expected holding detection with one missing altitude sample');
  assert(summary.holding.loop_count === 2, `expected two loops despite missing altitude, got ${summary.holding.loop_count}`);
});

test('detected holding time is excluded from the final-approach duration', () => {
  const holdingRows = buildHoldingPatternSampleRows({ loopCount: 1, phase: 'APPROACH' });
  const lastHoldingRow = holdingRows[holdingRows.length - 1];
  const finalRows = [];
  for (let elapsedSeconds = 10; elapsedSeconds <= 180; elapsedSeconds += 10) {
    const progress = elapsedSeconds / 180;
    finalRows.push({
      ...lastHoldingRow,
      ts: lastHoldingRow.ts + elapsedSeconds * 1000,
      timestamp_ms: lastHoldingRow.timestamp_ms + elapsedSeconds * 1000,
      on_ground: elapsedSeconds === 180,
      ra_ft: Math.max(0, 2500 * (1 - progress)),
      lat_deg: lastHoldingRow.lat_deg + progress * 0.01,
      lon_deg: lastHoldingRow.lon_deg + progress * 0.01,
      alt_msl_ft: Math.max(20, 2520 * (1 - progress)),
      track_true_deg: 45,
      hdg_true_deg: 45,
    });
  }

  const summary = computeFlightSummaryFromRows([...holdingRows, ...finalRows]);
  assert(summary?.holding?.loop_count === 1, 'expected the pre-landing hold to be detected');
  assert(summary.insights?.approach, 'expected a final-approach summary');
  assert(
    summary.insights.approach.duration_ms === 180000,
    `holding leaked into final approach duration: ${summary.insights.approach.duration_ms}`,
  );
});

test('flight summary does not classify a continuous circular orbit as a racetrack hold', () => {
  const summary = computeFlightSummaryFromRows(buildCircularOrbitSampleRows());
  assert(summary, 'expected row-based summary');
  assert(summary.holding === null, 'a circular orbit without reciprocal straight legs should not be a hold');
});

test('flight summary reads holding coordinates from CSV sample columns', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-summary-holding-'));
  const csvPath = path.join(tmpDir, 'summary.csv');
  const rows = buildHoldingPatternSampleRows({ loopCount: 1, phase: 'CLIMB' });
  const headers = [
    'record_type',
    'ts',
    'timestamp_ms',
    'phase',
    'on_ground',
    'sim_paused',
    'sim_in_menu',
    'lat_deg',
    'lon_deg',
    'alt_msl_ft',
    'ias_kts',
    'gs_kts',
    'hdg_true_deg',
    'track_true_deg',
  ];
  try {
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => csvLine(headers, row))].join('\n'), 'utf8');
    const summary = readFlightSummary(csvPath);
    assert(summary, 'expected summary from CSV');
    assert(summary.holding?.detected === true, 'expected holding summary from CSV');
    assert(summary.holding.loop_count === 1, `expected one holding loop, got ${summary.holding.loop_count}`);
    assert(summary.violations.length === 0, 'holding CSV summary should remain informational');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('flight summary derives every scoring-neutral post-flight insight from CSV samples', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-summary-insights-'));
  const csvPath = path.join(tmpDir, 'summary.csv');
  const rows = [
    { record_type: 'GO_AROUND', timestamp_ms: 1772999999000 },
    ...buildPostFlightInsightRows(),
  ];
  const headers = [
    'record_type',
    'ts',
    'timestamp_ms',
    'phase',
    'on_ground',
    'sim_paused',
    'sim_in_menu',
    'lat_deg',
    'lon_deg',
    'alt_msl_ft',
    'ra_ft',
    'ias_kts',
    'gs_kts',
    'bank_deg',
    'g_force',
    'g_force_lateral',
    'g_force_longitudinal',
    'fuel_total_gal',
    'fuel_total_weight_lbs',
    'fuel_weight_per_gal',
    'ap_master',
    'ap_reliable',
    'in_cloud',
    'precip_rate_mm',
    'precip_state',
    'wind_speed_kts',
    'gear_down_locked',
    'flaps_notch',
    'flaps_pct',
    'hdg_true_deg',
    'track_true_deg',
  ];
  try {
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => csvLine(headers, row))].join('\n'), 'utf8');
    const summary = readFlightSummary(csvPath);
    assert(summary, 'expected summary from CSV');
    const insights = summary.insights;
    assert(insights, 'expected post-flight insights');
    assert(insights.time.airborne_time_ms === 780000, `unexpected airborne time ${insights.time.airborne_time_ms}`);
    assert(insights.time.taxi_time_ms === 90000, `unexpected taxi time ${insights.time.taxi_time_ms}`);
    assert(insights.time.paused_time_ms === 30000, `unexpected paused time ${insights.time.paused_time_ms}`);
    assert(insights.route.distance_nm === 39, `unexpected route distance ${insights.route.distance_nm}`);
    assert(insights.route.average_ground_speed_kts === 180, `unexpected average GS ${insights.route.average_ground_speed_kts}`);
    assert(insights.route.coverage_percent === 100, `unexpected route coverage ${insights.route.coverage_percent}`);
    assert(insights.fuel.burn_gal === 100, `unexpected fuel burn ${insights.fuel.burn_gal}`);
    assert(insights.fuel.burn_lbs === 600, `unexpected fuel weight burn ${insights.fuel.burn_lbs}`);
    assert(insights.fuel.efficiency_lbs_per_nm === 15.4, `unexpected fuel efficiency ${insights.fuel.efficiency_lbs_per_nm}`);
    assert(insights.automation.autopilot_percent === 85, `unexpected AP percentage ${insights.automation.autopilot_percent}`);
    assert(insights.automation.coverage_percent === 100, `unexpected automation coverage ${insights.automation.coverage_percent}`);
    assert(insights.automation.hand_flown_time_ms === 120000, `unexpected hand-flown time ${insights.automation.hand_flown_time_ms}`);
    assert(insights.automation.hand_flown_below_1000_ft_ms === 60000, `unexpected low manual time ${insights.automation.hand_flown_below_1000_ft_ms}`);
    assert(insights.weather.in_cloud_time_ms === 120000, `unexpected cloud time ${insights.weather.in_cloud_time_ms}`);
    assert(insights.weather.precipitation_time_ms === 60000, `unexpected precip time ${insights.weather.precipitation_time_ms}`);
    assert(insights.weather.max_wind_kts === 45, `unexpected max wind ${insights.weather.max_wind_kts}`);
    assert(insights.weather.coverage_percent === 100, `unexpected weather coverage ${insights.weather.coverage_percent}`);
    assert(insights.configuration.gear_down_ra_ft === 1000, `unexpected gear altitude ${insights.configuration.gear_down_ra_ft}`);
    assert(insights.configuration.landing_flaps === '30', `unexpected landing flaps ${insights.configuration.landing_flaps}`);
    assert(insights.configuration.landing_flaps_ra_ft === 500, `unexpected flap altitude ${insights.configuration.landing_flaps_ra_ft}`);
    assert(insights.comfort.peak_g === 1.3, `unexpected peak G ${insights.comfort.peak_g}`);
    assert(insights.comfort.max_bank_deg === 25, `unexpected max bank ${insights.comfort.max_bank_deg}`);
    assert(insights.comfort.rough_air_time_ms === 30000, `unexpected rough-air time ${insights.comfort.rough_air_time_ms}`);
    assert(insights.approach.duration_ms === 180000, `unexpected approach duration ${insights.approach.duration_ms}`);
    assert(insights.approach.attempt_count === 2, `unexpected approach attempts ${insights.approach.attempt_count}`);
    assert(insights.approach.established_distance_nm === 9, `unexpected approach distance ${insights.approach.established_distance_nm}`);
    assert(summary.violations.length === 0, 'post-flight insights must not create violations');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('post-flight insights hide sparse or implausible telemetry instead of inventing summaries', () => {
  const baseTs = 1774000000000;
  const rows = Array.from({ length: 4 }, (_, index) => ({
    record_type: 'SAMPLE',
    ts: baseTs + index * 10000,
    timestamp_ms: baseTs + index * 10000,
    phase: 'CRUISE',
    on_ground: false,
    sim_paused: false,
    lat_deg: -30 + index * 10,
    lon_deg: 140 + index * 10,
    ra_ft: 5000,
    gs_kts: 180,
    ap_master: index === 0 ? true : null,
    ap_reliable: index === 0 ? true : null,
    wind_speed_kts: 999,
    g_force: 99,
    g_force_lateral: 99,
    g_force_longitudinal: 99,
    bank_deg: 999,
  }));
  const summary = computeFlightSummaryFromRows(rows);
  assert(summary?.insights, 'expected guarded post-flight insights');
  assert(summary.insights.route === null, 'teleport-like positions should not produce route distance');
  assert(summary.insights.fuel === null, 'missing fuel telemetry should not produce fuel usage');
  assert(summary.insights.automation === null, 'sparse automation coverage should not produce automation usage');
  assert(summary.insights.weather === null, 'implausible wind should not produce a weather summary');
  assert(summary.insights.comfort === null, 'implausible G and bank should not produce a comfort summary');
  assert(summary.insights.configuration === null, 'missing configuration telemetry should not produce milestones');
  assert(summary.insights.approach === null, 'cruise-only telemetry should not produce an approach summary');
});

test('post-flight insights require representative coverage for route, automation, and weather', () => {
  const baseTs = 1774500000000;
  const rows = Array.from({ length: 101 }, (_, index) => ({
    record_type: 'SAMPLE',
    ts: baseTs + index * 1000,
    timestamp_ms: baseTs + index * 1000,
    phase: 'CRUISE',
    on_ground: false,
    sim_paused: false,
    ra_ft: 5000,
    lat_deg: index < 2 ? -33.9 + index * 0.001 : null,
    lon_deg: index < 2 ? 151.2 : null,
    ap_master: index < 51 ? true : null,
    ap_reliable: index < 51 ? true : null,
    in_cloud: index === 0 ? false : null,
    fuel_total_gal: 500 - index * 0.1,
  }));
  const summary = computeFlightSummaryFromRows(rows);
  assert(summary?.insights, 'expected time insight from sparse samples');
  assert(summary.insights.route === null, 'one position interval must not represent the full route');
  assert(summary.insights.fuel?.burn_gal === 10, 'fuel burn should remain available independently of route coverage');
  assert(summary.insights.fuel.efficiency_gal_per_nm === null, 'partial route distance must not produce fuel efficiency');
  assert(summary.insights.automation === null, '51% automation coverage must not be presented as AP 100%');
  assert(summary.insights.weather === null, 'one cloud sample must not be presented as zero cloud time');
});

test('configuration altitudes require an observed transition', () => {
  const baseTs = 1774750000000;
  const rows = Array.from({ length: 11 }, (_, index) => ({
    record_type: 'SAMPLE',
    ts: baseTs + index * 10000,
    timestamp_ms: baseTs + index * 10000,
    phase: 'APPROACH',
    on_ground: index === 10,
    sim_paused: false,
    ra_ft: Math.max(0, 3000 - index * 300),
    gear_down_locked: true,
    flaps_notch: '30',
    flaps_pct: 75,
  }));
  const summary = computeFlightSummaryFromRows(rows);
  assert(summary?.insights?.configuration, 'expected recorded landing configuration');
  assert(summary.insights.configuration.gear_down_recorded === true, 'gear-down state should remain recorded');
  assert(summary.insights.configuration.gear_down_ra_ft === null, 'initial gear state must not invent a deployment altitude');
  assert(summary.insights.configuration.landing_flaps === '30', 'final flap setting should remain recorded');
  assert(summary.insights.configuration.landing_flaps_ra_ft === null, 'initial flap state must not invent a deployment altitude');
});

test('blank optional CSV columns remain unavailable in post-flight insights', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-summary-blank-insights-'));
  const csvPath = path.join(tmpDir, 'summary.csv');
  const headers = [
    'record_type', 'ts', 'timestamp_ms', 'phase', 'on_ground', 'sim_paused',
    'lat_deg', 'lon_deg', 'ra_ft', 'gs_kts', 'bank_deg', 'g_force',
    'g_force_lateral', 'g_force_longitudinal', 'fuel_total_gal',
    'fuel_total_weight_lbs', 'fuel_weight_per_gal', 'ap_master', 'ap_reliable',
    'in_cloud', 'precip_rate_mm', 'precip_state', 'wind_speed_kts',
    'gear_down_locked', 'flaps_notch', 'flaps_pct',
  ];
  const baseTs = 1775000000000;
  const rows = Array.from({ length: 3 }, (_, index) => ({
    record_type: 'SAMPLE',
    ts: baseTs + index * 10000,
    timestamp_ms: baseTs + index * 10000,
    phase: 'CRUISE',
    on_ground: false,
    sim_paused: false,
  }));
  try {
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((row) => csvLine(headers, row))].join('\n'), 'utf8');
    const summary = readFlightSummary(csvPath);
    assert(summary?.insights, 'expected time insight from CSV timestamps');
    assert(summary.insights.time.airborne_time_ms === 20000, 'airborne time should remain available');
    assert(summary.insights.route === null, 'blank positions should not become zero coordinates');
    assert(summary.insights.fuel === null, 'blank fuel columns should remain unavailable');
    assert(summary.insights.automation === null, 'blank AP columns should remain unavailable');
    assert(summary.insights.weather === null, 'blank weather columns should remain unavailable');
    assert(summary.insights.configuration === null, 'blank configuration columns should remain unavailable');
    assert(summary.insights.comfort === null, 'blank G and bank columns should remain unavailable');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('schema writes every critical landing column with a non-empty fixture value', () => {
  for (const mapping of mappings) {
    assert(
      landingRow[mapping.column] !== '',
      `schema produced empty value for critical column ${mapping.column} from ${mapping.payloadKey}`,
    );
  }
  assert(landingRow.ts === String(landingPayload.timestamp_ms), `expected ts ${landingPayload.timestamp_ms}, got ${landingRow.ts}`);
  assert(landingRow.timestamp_utc === landingPayload.timestamp_utc, `expected timestamp_utc ${landingPayload.timestamp_utc}, got ${landingRow.timestamp_utc}`);
  assert(landingRow.flight_start_iso === landingPayload.flight_start, `expected flight_start_iso ${landingPayload.flight_start}, got ${landingRow.flight_start_iso}`);
});

async function main() {
  await testAsync('CSV replay and logbook recover critical landing diagnostics', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-critical-csv-contract-'));
  const csvPath = path.join(tmpDir, 'contract-flight.csv');
  const sampleRow = schemaFieldMap.buildRow({
    _recordType: 'SAMPLE',
    flightId: 'contract-flight',
    timestampMs: landingPayload.timestamp_ms - 1000,
    timestampIso: '2026-02-03T04:04:59.123Z',
    phase: 'APPROACH',
    onGround: false,
    ias: 140,
    vs: -700,
    gs: 140,
    ra: 100,
    altMsl: 120,
    lat: -33.9470,
    lon: 151.1760,
    hdgTrue: 344,
    aircraft: landingPayload.aircraft,
  });
  const content = [
    legacyReplayHeaders.join(','),
    csvLine(legacyReplayHeaders, sampleRow),
    csvLine(legacyReplayHeaders, csvLandingRow),
  ].join('\n');
  fs.writeFileSync(csvPath, content, 'utf8');

  try {
    const replay = await timelineGenerator.generateFromCSV(csvPath);
    assert(replay.success === true, `timeline replay failed: ${replay.error}`);
    const landing = replay.timeline.events.find((event) => event.type === 'landing');
    assert(landing, 'timeline replay did not produce landing event');
    assert(landing.touchdownDistance, 'timeline landing is missing touchdownDistance');
    assert(landing.touchdownDistance.distanceFt === landingPayload.touchdown_distance_ft, 'timeline lost touchdown distance');
    assert(landing.touchdownDistance.shortLanding === true, 'timeline lost short landing flag');
    assert(landing.touchdownDistance.runway_condition === landingPayload.runway_condition, 'timeline lost runway condition');
    assert(landing.touchdownDistance.lateralOffsetFt === landingPayload.lateral_offset_ft, 'timeline lost lateral offset');
    assert(landing.touchdownDistance.lateralOffsetGrade === landingPayload.lateral_offset_grade, 'timeline lost lateral grade');
    assert(landing.touchdownDistance.runwayWidthFt === landingPayload.runway_width_ft, 'timeline lost runway width');
    assert(landing.touchdownDistance.runwayGeometrySource === landingPayload.runway_geometry_source, 'timeline lost runway geometry source');
    assert(landing.touchdownDistance.runwayGeometryProviderChain === landingPayload.runway_geometry_provider_chain, 'timeline lost runway geometry provider chain');
    assert(landing.touchdownDistance.runwayGeometryFallbackReason === landingPayload.runway_geometry_fallback_reason, 'timeline lost runway geometry fallback reason');
    assert(
      landing.touchdownDistance.runwayGeometryDiagnostics?.providerChain === landingPayload.runway_geometry_diagnostics.providerChain,
      'timeline lost runway geometry diagnostics',
    );
    assert(landing.touchdownDistance.runwayHeadingTrueDeg === landingPayload.runway_heading_true_deg, 'timeline lost runway heading');
    assert(landing.touchdownDistance.runwayPhysicalLengthFt === landingPayload.runway_physical_length_ft, 'timeline lost physical runway length');
    assert(landing.touchdownDistance.runwayDisplacedThresholdFt === landingPayload.runway_displaced_threshold_ft, 'timeline lost displaced threshold');
    assert(landing.ultimateStability, 'timeline lost ultimate stability object');
    assert(landing.ultimateStability.scoringContext?.profile?.id === 'generic', 'timeline lost stability scoring profile context');
    assert(landing.ultimateStability.scoringContext?.criteria?.speedPlusKts === 100, 'timeline lost stability scoring criteria context');
    assert(landing.ultimateStability.gateStable === false, 'timeline lost string false gate-stable flag');
    assert(landing.ultimateStability.breakdown.gear_ok === landingPayload.ultimate_stability_gear_ok_pct, 'timeline lost gear stability breakdown');
    assert(landing.ultimateStability.breakdown.bank_ok === landingPayload.ultimate_stability_bank_ok_pct, 'timeline lost bank stability breakdown');
    assert(landing.rolloutAnalysis?.assessment === 'caution', 'timeline lost rollout analysis');
    for (const metricKey of extractStabilityBreakdownMetricKeys()) {
      assert(
        landing.ultimateStability.breakdown[metricKey] === landingPayload[flatStabilityColumn(metricKey)],
        `timeline lost ${metricKey} stability breakdown`,
      );
    }

    const entries = flightLogbook.parseLandingsFromContent(content, csvPath, parseCsvLine, gradeLanding, splitCsvLines);
    assert(entries.length === 1, `expected one logbook landing, got ${entries.length}`);
    const entry = entries[0];
    assert(entry.assists, 'logbook lost landing assist summary');
    assert(entry.assists.landingAssist === true, 'logbook lost landing assist flag');
    assert(entry.assists.slewActive === false, 'logbook lost false slew assist flag');
    assert(entry.assists.aiAntistall === landingPayload.assist_ai_antistall_state, 'logbook lost anti-stall state');
    assert(entry.assists.realismPercent === landingPayload.assist_realism_pct, 'logbook lost realism pct');
    assert(entry.assists.anyAssistActive === true, 'logbook lost any-assist flag');
    assert(entry.gateStable === false, 'logbook lost string false gate-stable flag');
    assert(entry.stabilityGateFailures?.[0] === 'speed_ok', 'logbook lost first stability gate failure reason');
    assert(entry.stabilityGateFailures?.[1] === 'gear_ok', 'logbook lost second stability gate failure reason');
    assert(entry.runwayExcursion === true, 'logbook lost runway excursion');
    assert(entry.rolloutAnalysis?.assessment === 'caution', 'logbook lost rollout analysis');
    assert(entry.shortLanding === true, 'logbook lost short landing');
    assert(entry.runwayCondition === landingPayload.runway_condition, 'logbook lost runway condition');
    assert(entry.runwayConditionConfident === true, 'logbook lost runway condition confidence');
    assert(entry.lateralOffsetFt === landingPayload.lateral_offset_ft, 'logbook lost lateral offset');
    assert(entry.lateralOffsetScore === landingPayload.lateral_offset_score, 'logbook lost lateral offset score');
    assert(entry.runwayWidthFt === landingPayload.runway_width_ft, 'logbook lost runway width');
    assert(entry.runwayGeometrySource === landingPayload.runway_geometry_source, 'logbook lost runway geometry source');
    assert(entry.runwayGeometryProviderChain === landingPayload.runway_geometry_provider_chain, 'logbook lost runway geometry provider chain');
    assert(entry.runwayGeometryFallbackReason === landingPayload.runway_geometry_fallback_reason, 'logbook lost runway geometry fallback reason');
    assert(
      entry.runwayGeometryDiagnostics?.providerChain === landingPayload.runway_geometry_diagnostics.providerChain,
      'logbook lost runway geometry diagnostics',
    );
    assert(entry.runwayHeadingTrueDeg === landingPayload.runway_heading_true_deg, 'logbook lost runway heading');
    assert(entry.runwayPhysicalLengthFt === landingPayload.runway_physical_length_ft, 'logbook lost physical runway length');
    assert(entry.runwayDisplacedThresholdFt === landingPayload.runway_displaced_threshold_ft, 'logbook lost displaced threshold');
    assert(entry.stabilityBreakdown.gear_ok === landingPayload.ultimate_stability_gear_ok_pct, 'logbook lost gear stability breakdown');
    assert(entry.stabilityBreakdown.bank_ok === landingPayload.ultimate_stability_bank_ok_pct, 'logbook lost bank stability breakdown');
    for (const metricKey of extractStabilityBreakdownMetricKeys()) {
      assert(
        entry.stabilityBreakdown[metricKey] === landingPayload[flatStabilityColumn(metricKey)],
        `logbook lost ${metricKey} stability breakdown`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  });

  await testAsync('timeline replay merges delayed LANDING rows back into the touchdown event', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-delayed-landing-merge-'));
    const csvPath = path.join(tmpDir, 'delayed-landing-merge.csv');
    const touchdownTs = landingPayload.timestamp_ms;
    const delayedLandingTs = touchdownTs + 60000;
    const touchdownLat = landingPayload.first_touchdown_lat;
    const touchdownLon = landingPayload.first_touchdown_lon;

    const approachRow = schemaFieldMap.buildRow({
      _recordType: 'SAMPLE',
      flightId: 'delayed-landing-merge',
      timestampMs: touchdownTs - 1000,
      timestampIso: new Date(touchdownTs - 1000).toISOString(),
      phase: 'APPROACH',
      onGround: false,
      ias: 137,
      vs: -620,
      gs: 132,
      ra: 120,
      altMsl: 140,
      lat: touchdownLat - 0.001,
      lon: touchdownLon - 0.001,
      hdgTrue: landingPayload.hdg_true_deg,
      aircraft: landingPayload.aircraft,
    });
    const touchdownRow = schemaFieldMap.buildRow({
      _recordType: 'SAMPLE',
      flightId: 'delayed-landing-merge',
      timestampMs: touchdownTs,
      timestampIso: new Date(touchdownTs).toISOString(),
      phase: 'LANDING',
      onGround: true,
      ias: landingPayload.ias_kts,
      vs: landingPayload.first_touchdown_vs_fpm,
      gs: landingPayload.gs_kts,
      ra: landingPayload.ra_ft,
      altMsl: landingPayload.alt_msl_ft,
      lat: touchdownLat,
      lon: touchdownLon,
      hdgTrue: landingPayload.hdg_true_deg,
      pitch: landingPayload.pitch_deg,
      bank: landingPayload.bank_deg,
      aircraft: landingPayload.aircraft,
    });
    const rolloutRows = Array.from({ length: 6 }, (_, index) => schemaFieldMap.buildRow({
      _recordType: 'SAMPLE',
      flightId: 'delayed-landing-merge',
      timestampMs: touchdownTs + ((index + 1) * 1000),
      timestampIso: new Date(touchdownTs + ((index + 1) * 1000)).toISOString(),
      phase: 'LANDING',
      onGround: true,
      ias: landingPayload.ias_kts - index,
      vs: -20,
      gs: landingPayload.gs_kts - index,
      ra: 0,
      altMsl: landingPayload.alt_msl_ft,
      lat: touchdownLat + (index * 0.0002),
      lon: touchdownLon + 0.003,
      hdgTrue: landingPayload.hdg_true_deg,
      pitch: landingPayload.pitch_deg,
      bank: landingPayload.bank_deg,
      aircraft: landingPayload.aircraft,
    }));
    const delayedLandingEventData = {
      ...eventData,
      timestamp_ms: delayedLandingTs,
      timestamp_utc: new Date(delayedLandingTs).toISOString(),
      flight_elapsed_ms: landingPayload.flight_elapsed_ms + 60000,
      lat_deg: touchdownLat,
      lon_deg: touchdownLon,
      first_touchdown_lat: touchdownLat,
      first_touchdown_lon: touchdownLon,
      // Regression guard: bounced/final touchdown coordinates can differ from
      // the primary WOW event, so replay must try all touchdown identities.
      final_touchdown_lat: touchdownLat + 0.05,
      final_touchdown_lon: touchdownLon,
      // Older LANDING rows have no immutable criteria snapshot; retain the
      // touchdown replay's clearly marked reconstructed context when merging.
      ultimate_stability_context: null,
    };
    const delayedLandingRow = schemaFieldMap.buildRow({
      _recordType: 'LANDING',
      flightId: 'delayed-landing-merge',
      ...delayedLandingEventData,
    });
    const content = [
      legacyReplayHeaders.join(','),
      csvLine(legacyReplayHeaders, approachRow),
      csvLine(legacyReplayHeaders, touchdownRow),
      ...rolloutRows.map((row) => csvLine(legacyReplayHeaders, row)),
      csvLine(legacyReplayHeaders, delayedLandingRow),
    ].join('\n');
    fs.writeFileSync(csvPath, content, 'utf8');

    try {
      const replay = await timelineGenerator.generateFromCSV(csvPath);
      assert(replay.success === true, `timeline replay failed: ${replay.error}`);
      const landings = replay.timeline.events.filter((event) => event.type === 'landing');
      assert(landings.length === 1, `expected delayed LANDING row to merge into one landing, got ${landings.length}`);
      const landing = landings[0];
      assert(Array.isArray(landing.approachProfile) && landing.approachProfile.length > 0, 'merged landing lost the touchdown approach profile');
      assert(landing.touchdownDistance.distanceFt === landingPayload.touchdown_distance_ft, 'merged landing lost delayed LANDING touchdown distance');
      assert(landing.touchdownDistance.lateralOffsetFt === Math.abs(landingPayload.lateral_offset_ft), 'merged landing did not preserve LANDING row lateral offset');
      assert(landing.touchdownDistance.lateralOffsetSide === landingPayload.lateral_offset_side, 'merged landing did not preserve LANDING row lateral side');
      assert(landing.touchdownDistance.lateralOffsetSource === 'landing-row', 'merged landing lateral offset should come from LANDING row when present');
      assert(landing.ultimateStability?.score === landingPayload.ultimate_stability_score, 'merged landing lost delayed LANDING stability score');
      assert(landing.ultimateStability?.scoringContext?.criteriaSource === 'reconstructed', 'older merged landing lost reconstructed scoring context');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('timeline replay ignores persisted zero-sample insufficient stability when replay has samples', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bad-landing-stability-'));
    const csvPath = path.join(tmpDir, 'bad-landing-stability.csv');
    const touchdownTs = landingPayload.timestamp_ms;
    const touchdownLat = landingPayload.first_touchdown_lat;
    const touchdownLon = landingPayload.first_touchdown_lon;
    const approachBase = {
      flightId: 'bad-landing-stability',
      phase: 'APPROACH',
      onGround: false,
      ias: 140,
      vs: -700,
      gs: 135,
      altMsl: 800,
      lat: touchdownLat - 0.001,
      lon: touchdownLon - 0.001,
      hdgTrue: landingPayload.hdg_true_deg,
      gearDownLocked: 1,
      flaps: 30,
      flapsNotch: 3,
      spoilerPct: 0,
      spoiler_state: 'ARMED',
      thr1: 45,
      thr2: 45,
      pitch: 3,
      bank: 1,
      aircraft: landingPayload.aircraft,
    };

    const approachRows = [900, 700, 500, 300, 100].map((ra, index) => schemaFieldMap.buildRow({
      _recordType: 'SAMPLE',
      ...approachBase,
      timestampMs: touchdownTs - ((5 - index) * 1000),
      timestampIso: new Date(touchdownTs - ((5 - index) * 1000)).toISOString(),
      ra,
    }));
    const touchdownRow = schemaFieldMap.buildRow({
      _recordType: 'SAMPLE',
      ...approachBase,
      timestampMs: touchdownTs,
      timestampIso: new Date(touchdownTs).toISOString(),
      phase: 'LANDING',
      onGround: true,
      ias: landingPayload.ias_kts,
      vs: landingPayload.first_touchdown_vs_fpm,
      gs: landingPayload.gs_kts,
      ra: landingPayload.ra_ft,
      altMsl: landingPayload.alt_msl_ft,
      lat: touchdownLat,
      lon: touchdownLon,
    });
    const badLandingRow = schemaFieldMap.buildRow({
      _recordType: 'LANDING',
      flightId: 'bad-landing-stability',
      ...eventData,
      timestamp_ms: touchdownTs + 5000,
      timestamp_utc: new Date(touchdownTs + 5000).toISOString(),
      flight_elapsed_ms: landingPayload.flight_elapsed_ms + 5000,
      lat_deg: touchdownLat,
      lon_deg: touchdownLon,
      first_touchdown_lat: touchdownLat,
      first_touchdown_lon: touchdownLon,
      ultimate_stability_score: null,
      ultimate_stability_samples: 0,
      ultimate_stability_gate_stable: false,
      ultimate_stability_gate_failures: 'insufficient_data',
      ultimate_stability_breakdown: {
        speed_ok: 0,
        speed_trend_ok: 0,
        vs_ok: 0,
        glidepath_ok: 0,
        config_ok: 0,
        flaps_ok: 0,
        gear_ok: 0,
        spoilers_ok: 0,
        pitch_ok: 0,
        bank_ok: 0,
        thrust_ok: 0,
        thrust_not_idle_ok: 0,
        thrust_stable_ok: 0,
      },
      ultimate_stability_gear_ok_pct: 0,
      ultimate_stability_flaps_ok_pct: 0,
      ultimate_stability_spoilers_ok_pct: 0,
      ultimate_stability_config_ok_pct: 0,
      ultimate_stability_speed_ok_pct: 0,
      ultimate_stability_speed_trend_ok_pct: 0,
      ultimate_stability_vs_ok_pct: 0,
      ultimate_stability_glidepath_ok_pct: 0,
      ultimate_stability_glidepath_below_ok_pct: 0,
      ultimate_stability_glidepath_above_ok_pct: 0,
      ultimate_stability_thrust_ok_pct: 0,
      ultimate_stability_thrust_not_idle_ok_pct: 0,
      ultimate_stability_thrust_stable_ok_pct: 0,
      ultimate_stability_pitch_ok_pct: 0,
      ultimate_stability_bank_ok_pct: 0,
      ultimate_stability_lateral_offset_ok_pct: 0,
    });
    const content = [
      legacyReplayHeaders.join(','),
      ...approachRows.map((row) => csvLine(legacyReplayHeaders, row)),
      csvLine(legacyReplayHeaders, touchdownRow),
      csvLine(legacyReplayHeaders, badLandingRow),
    ].join('\n');
    fs.writeFileSync(csvPath, content, 'utf8');

    try {
      const replay = await timelineGenerator.generateFromCSV(csvPath);
      assert(replay.success === true, `timeline replay failed: ${replay.error}`);
      const landing = replay.timeline.events.find((event) => event.type === 'landing');
      assert(landing, 'expected replay touchdown landing');
      assert(landing.ultimateStability, 'expected replay stability to survive bad persisted row');
      assert(landing.ultimateStability.samples > 0, `expected replay samples, got ${landing.ultimateStability.samples}`);
      assert(
        landing.ultimateStability.gateFailures?.[0] !== 'insufficient_data',
        'bad persisted insufficient_data should not override replay score',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('damaged CSV rows fail closed consistently across timeline and logbook readers', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-damaged-csv-contract-'));
    const csvPath = path.join(tmpDir, 'damaged-flight.csv');
    const headers = ['record_type', 'ts', 'timestamp_utc', 'vs_fpm', 'grade'];
    const goodLanding = ['LANDING', 1770000000123, '2026-02-03T04:05:00.123Z', -300, 'Good'].join(',');
    const truncatedLanding = ['LANDING', 1770000001123, '2026-02-03T04:05:01.123Z', -400].join(',');
    // The trailing delimiter commits the malformed final row. Without it, the
    // legacy crash-tail policy correctly quarantines the partial EOF record.
    const content = `${[headers.join(','), goodLanding, truncatedLanding].join('\n')}\n`;
    fs.writeFileSync(csvPath, content, 'utf8');

    try {
      const replay = await timelineGenerator.generateFromCSV(csvPath);
      assert(replay.success === false, 'timeline replay should reject a malformed-width CSV row');
      assert(
        String(replay.error || '').includes('CSV row 3 has 4 columns; expected 5'),
        `unexpected timeline error: ${replay.error}`,
      );

      const entries = flightLogbook.parseLandingsFromContent(content, csvPath, parseCsvLine, gradeLanding, splitCsvLines);
      assert(entries.length === 0, `logbook should not ingest partial data from a damaged CSV, got ${entries.length}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\nCritical CSV event contract: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.log(`  ✗ unexpected failure: ${err.message}`);
  console.log(`\nCritical CSV event contract: ${passed} passed, ${failed + 1} failed`);
  process.exitCode = 1;
});
