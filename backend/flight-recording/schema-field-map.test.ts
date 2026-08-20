#!/usr/bin/env node
/**
 * schema-field-map.test.js
 *
 * Tests for:
 *   1. fmt.* format helpers (null/NaN/edge-case handling, precision, rounding)
 *   2. Key extractor functions (fallback chains, scaling, nested paths)
 *   3. buildRow() — column completeness, value types
 */

'use strict';

const { FIELD_MAP, buildRow, fmt } = require('./schema-field-map');
const { VIOLATION_RULE } = require('../../shared/violation-rules.js');

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

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

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

function extractStabilityMetricColumnKeys() {
  return FIELD_MAP
    .map((field) => field.name)
    .filter((name) => /^ultimate_stability_.*_pct$/.test(name))
    .map((name) => name.replace(/^ultimate_stability_/, '').replace(/_pct$/, ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. fmt.* format helpers
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfmt.str');
test('str: returns string value', () => assert(fmt.str('hello') === 'hello', 'expected hello'));
test('str: null returns empty string', () => assert(fmt.str(null) === '', 'expected ""'));
test('str: undefined returns empty string', () => assert(fmt.str(undefined) === '', 'expected ""'));
test('str: number coerces to string', () => assert(fmt.str(42) === '42', 'expected "42"'));

console.log('\nfmt.int');
test('int: integer value', () => assert(fmt.int(35000) === '35000', 'expected "35000"'));
test('int: rounds float', () => assert(fmt.int(35000.6) === '35001', 'expected "35001"'));
test('int: rounds negative', () => assert(fmt.int(-850.4) === '-850', 'expected "-850"'));
test('int: null returns empty string', () => assert(fmt.int(null) === '', 'expected ""'));
test('int: undefined returns empty string', () => assert(fmt.int(undefined) === '', 'expected ""'));
test('int: NaN returns empty string', () => assert(fmt.int(NaN) === '', 'expected ""'));
test('int: Infinity returns empty string', () => assert(fmt.int(Infinity) === '', 'expected ""'));
test('int: -Infinity returns empty string', () => assert(fmt.int(-Infinity) === '', 'expected ""'));
test('int: numeric string is coerced', () => assert(fmt.int('35000') === '35000', 'expected "35000"'));
test('int: non-numeric string returns empty string', () => assert(fmt.int('abc') === '', 'expected ""'));
test('int: empty string returns empty string', () => assert(fmt.int('') === '', 'expected ""'));

console.log('\nfmt.real1');
test('real1: one decimal place', () => assert(fmt.real1(250) === '250.0', 'expected "250.0"'));
test('real1: IEEE-754 rounding (250.35 toFixed(1) = "250.3" in Node)', () => assert(fmt.real1(250.35) === '250.3', 'expected "250.3" — IEEE 754'));
test('real1: rounds up when unambiguous', () => assert(fmt.real1(250.16) === '250.2', 'expected "250.2"'));
test('real1: negative value', () => assert(fmt.real1(-850.7) === '-850.7', 'expected "-850.7"'));
test('real1: null returns empty string', () => assert(fmt.real1(null) === '', 'expected ""'));
test('real1: NaN returns empty string', () => assert(fmt.real1(NaN) === '', 'expected ""'));
test('real1: Infinity returns empty string', () => assert(fmt.real1(Infinity) === '', 'expected ""'));
test('real1: numeric string coerced', () => assert(fmt.real1('250.3') === '250.3', 'expected "250.3"'));
test('real1: zero formats correctly', () => assert(fmt.real1(0) === '0.0', 'expected "0.0"'));

console.log('\nfmt.real2');
test('real2: two decimal places', () => assert(fmt.real2(0.05) === '0.05', 'expected "0.05"'));
test('real2: rounds to 2', () => assert(fmt.real2(1.005) === '1.00' || fmt.real2(1.005) === '1.01', 'expected rounded'));
test('real2: null returns empty string', () => assert(fmt.real2(null) === '', 'expected ""'));
test('real2: NaN returns empty string', () => assert(fmt.real2(NaN) === '', 'expected ""'));

console.log('\nfmt.real3');
test('real3: three decimal places', () => assert(fmt.real3(0.82) === '0.820', 'expected "0.820"'));
test('real3: null returns empty string', () => assert(fmt.real3(null) === '', 'expected ""'));
test('real3: mach value', () => assert(fmt.real3(0.851) === '0.851', 'expected "0.851"'));

console.log('\nfmt.real4');
test('real4: four decimal places', () => assert(fmt.real4(51.4700) === '51.4700', 'expected "51.4700"'));
test('real4: null returns empty string', () => assert(fmt.real4(null) === '', 'expected ""'));
test('real4: rate value', () => assert(fmt.real4(0.0123) === '0.0123', 'expected "0.0123"'));

console.log('\nfmt.real6');
test('real6: preserves coordinate precision', () => assert(fmt.real6(-35.309912) === '-35.309912', 'expected "-35.309912"'));
test('real6: pads short coordinates', () => assert(fmt.real6(149.1944) === '149.194400', 'expected "149.194400"'));
test('real6: null returns empty string', () => assert(fmt.real6(null) === '', 'expected ""'));

console.log('\nfmt.bool');
test('bool: true returns "1"', () => assert(fmt.bool(true) === '1', 'expected "1"'));
test('bool: false returns "0"', () => assert(fmt.bool(false) === '0', 'expected "0"'));
test('bool: null returns empty string', () => assert(fmt.bool(null) === '', 'expected ""'));
test('bool: undefined returns empty string', () => assert(fmt.bool(undefined) === '', 'expected ""'));
test('bool: 1 returns "1"', () => assert(fmt.bool(1) === '1', 'expected "1"'));
test('bool: 0 returns "0"', () => assert(fmt.bool(0) === '0', 'expected "0"'));

console.log('\nfmt.json');
test('json: object serializes to JSON', () => assert(fmt.json({ gear_ok: 100 }) === '{"gear_ok":100}', 'expected JSON object'));
test('json: string passes through', () => assert(fmt.json('{"gear_ok":100}') === '{"gear_ok":100}', 'expected JSON string passthrough'));
test('json: null returns empty string', () => assert(fmt.json(null) === '', 'expected empty string'));

// ─────────────────────────────────────────────────────────────────────────────
// 2. Key extractor functions
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nExtractors: primary path');
test('ias_kts: reads f.ias', () => {
  const row = buildRow({ ias: 145.3, fdm: {} });
  assert(row.ias_kts === '145.3', `expected "145.3" got "${row.ias_kts}"`);
});
test('vs_fpm: reads f.vs', () => {
  const row = buildRow({ vs: -700, fdm: {} });
  assert(row.vs_fpm === '-700.0', `expected "-700.0" got "${row.vs_fpm}"`);
});
test('grade: reads f.grade', () => {
  const row = buildRow({ grade: 'FIRM', fdm: {} });
  assert(row.grade === 'FIRM', `expected "FIRM" got "${row.grade}"`);
});
test('alt_msl_ft: reads f.altMsl', () => {
  const row = buildRow({ altMsl: 3500, fdm: {} });
  assert(row.alt_msl_ft === '3500.0', `got "${row.alt_msl_ft}"`);
});
test('altitude diagnostics: read explicit flattened and FDM fields', () => {
  const row = buildRow({
    altMsl: 3500,
    altCalibratedFt: 3492.4,
    fdm: {
      altPlaneFt: 3489.1,
      aircraftAglFt: 810.2,
      aircraftAboveObstaclesFt: 770.3,
      planeAglFt: 770.1,
      planeAglMinusCgFt: 763.8,
      pressureAltFt: 3612.6,
      kohlsmanSettingMb: 1013.25,
      kohlsmanTunedMb: 1004.2,
      kohlsmanStd: true,
    },
  });
  assert(row.alt_indicated_ft === '3500.0', `got "${row.alt_indicated_ft}"`);
  assert(row.alt_calibrated_ft === '3492.4', `got "${row.alt_calibrated_ft}"`);
  assert(row.alt_plane_ft === '3489.1', `got "${row.alt_plane_ft}"`);
  assert(row.aircraft_agl_ft === '810.2', `got "${row.aircraft_agl_ft}"`);
  assert(row.aircraft_above_obstacles_ft === '770.3', `got "${row.aircraft_above_obstacles_ft}"`);
  assert(row.plane_agl_ft === '770.1', `got "${row.plane_agl_ft}"`);
  assert(row.plane_agl_minus_cg_ft === '763.8', `got "${row.plane_agl_minus_cg_ft}"`);
  assert(row.pressure_alt_ft === '3612.6', `got "${row.pressure_alt_ft}"`);
  assert(row.kohlsman_setting_mb === '1013.25', `got "${row.kohlsman_setting_mb}"`);
  assert(row.kohlsman_tuned_mb === '1004.20', `got "${row.kohlsman_tuned_mb}"`);
  assert(row.kohlsman_std === '1', `got "${row.kohlsman_std}"`);
});
test('ra_ft: reads f.ra', () => {
  const row = buildRow({ ra: 280, fdm: {} });
  assert(row.ra_ft === '280.0', `got "${row.ra_ft}"`);
});
test('gs_kts: reads f.gs', () => {
  const row = buildRow({ gs: 148, fdm: {} });
  assert(row.gs_kts === '148.0', `got "${row.gs_kts}"`);
});
test('oat_c: reads f.oat', () => {
  const row = buildRow({ oat: -45.5, fdm: {} });
  assert(row.oat_c === '-45.5', `got "${row.oat_c}"`);
});
test('tat_c: reads f.tat', () => {
  const row = buildRow({ tat: -33.2, fdm: {} });
  assert(row.tat_c === '-33.2', `got "${row.tat_c}"`);
});
test('sea_level_pressure_mb: falls back to f.fdm.seaLevelPressureMb', () => {
  const row = buildRow({ fdm: { seaLevelPressureMb: 1013.2 } });
  assert(row.sea_level_pressure_mb === '1013.2', `got "${row.sea_level_pressure_mb}"`);
});
test('precip_rate_mm: reads f.precip_rate_mm', () => {
  const row = buildRow({ precip_rate_mm: 1.25, fdm: {} });
  assert(row.precip_rate_mm === '1.25', `got "${row.precip_rate_mm}"`);
});
test('precip_state: reads f.precipState', () => {
  const row = buildRow({ precipState: 2, fdm: {} });
  assert(row.precip_state === '2', `got "${row.precip_state}"`);
});
test('in_cloud: reads f.inCloud', () => {
  const row = buildRow({ inCloud: true, fdm: {} });
  assert(row.in_cloud === '1', `got "${row.in_cloud}"`);
});
test('convective risk event fields: format replay-safe metrics', () => {
  const row = buildRow({
    rule_id: VIOLATION_RULE.CONVECTIVE_EXPOSURE,
    label: 'Convective Exposure Likelihood: HIGH',
    severity: 'critical',
    risk_level: 'HIGH',
    confidence_level: 'HIGH',
    convective_score: 0.9134,
    convective_duration_ms: 42321,
    convective_motion_score: 1,
    convective_weather_score: 0.71,
    convective_weather_available: true,
    convective_weather_aligned: false,
    convective_peak_load_excursion_g: 0.5621,
    convective_avg_load_excursion_g: 0.2418,
    convective_peak_load_jerk_gps: 0.7891,
    convective_peak_pitch_rate_dps: 14.18,
    convective_peak_roll_rate_dps: 21.24,
    convective_peak_yaw_rate_dps: 5.55,
    convective_peak_pitch_deg: 9.44,
    convective_peak_bank_deg: 31.66,
    convective_maneuver_ratio: 0.3821,
    convective_maneuver_suppressed: true,
    convective_vertical_reversals: 7,
    convective_vertical_reversal_rate_per_min: 3.456,
    convective_vertical_speed_activity_score: 0.5182,
    convective_ias_range_kts: 33.81,
    convective_vs_range_fpm: 1864.5,
    convective_in_cloud_ratio: 0.8122,
    convective_precip_ratio: 0.6234,
    convective_precip_rate_max_mm: 2.758,
    convective_density_alt_ft: 37150.2,
    convective_sample_count: 46,
    fdm: {},
  });
  assert(row.rule_id === VIOLATION_RULE.CONVECTIVE_EXPOSURE, `got "${row.rule_id}"`);
  assert(row.risk_level === 'HIGH', `got "${row.risk_level}"`);
  assert(row.confidence_level === 'HIGH', `got "${row.confidence_level}"`);
  assert(row.convective_score === '0.913', `got "${row.convective_score}"`);
  assert(row.convective_duration_ms === '42321', `got "${row.convective_duration_ms}"`);
  assert(row.convective_motion_score === '1.000', `got "${row.convective_motion_score}"`);
  assert(row.convective_weather_score === '0.710', `got "${row.convective_weather_score}"`);
  assert(row.convective_weather_available === '1', `got "${row.convective_weather_available}"`);
  assert(row.convective_weather_aligned === '0', `got "${row.convective_weather_aligned}"`);
  assert(row.convective_peak_load_excursion_g === '0.562', `got "${row.convective_peak_load_excursion_g}"`);
  assert(row.convective_avg_load_excursion_g === '0.242', `got "${row.convective_avg_load_excursion_g}"`);
  assert(row.convective_peak_load_jerk_gps === '0.789', `got "${row.convective_peak_load_jerk_gps}"`);
  assert(row.convective_peak_pitch_rate_dps === '14.2', `got "${row.convective_peak_pitch_rate_dps}"`);
  assert(row.convective_peak_roll_rate_dps === '21.2', `got "${row.convective_peak_roll_rate_dps}"`);
  assert(row.convective_peak_yaw_rate_dps === '5.5', `got "${row.convective_peak_yaw_rate_dps}"`);
  assert(row.convective_peak_pitch_deg === '9.4', `got "${row.convective_peak_pitch_deg}"`);
  assert(row.convective_peak_bank_deg === '31.7', `got "${row.convective_peak_bank_deg}"`);
  assert(row.convective_maneuver_ratio === '0.382', `got "${row.convective_maneuver_ratio}"`);
  assert(row.convective_maneuver_suppressed === '1', `got "${row.convective_maneuver_suppressed}"`);
  assert(row.convective_vertical_reversals === '7', `got "${row.convective_vertical_reversals}"`);
  assert(row.convective_vertical_reversal_rate_per_min === '3.46', `got "${row.convective_vertical_reversal_rate_per_min}"`);
  assert(row.convective_vertical_speed_activity_score === '0.518', `got "${row.convective_vertical_speed_activity_score}"`);
  assert(row.convective_ias_range_kts === '33.8', `got "${row.convective_ias_range_kts}"`);
  assert(row.convective_vs_range_fpm === '1864.5', `got "${row.convective_vs_range_fpm}"`);
  assert(row.convective_in_cloud_ratio === '0.812', `got "${row.convective_in_cloud_ratio}"`);
  assert(row.convective_precip_ratio === '0.623', `got "${row.convective_precip_ratio}"`);
  assert(row.convective_precip_rate_max_mm === '2.76', `got "${row.convective_precip_rate_max_mm}"`);
  assert(row.convective_density_alt_ft === '37150', `got "${row.convective_density_alt_ft}"`);
  assert(row.convective_sample_count === '46', `got "${row.convective_sample_count}"`);
});
test('approach overspeed event fields: format speed envelope metrics', () => {
  const row = buildRow({
    rule_id: VIOLATION_RULE.APPROACH_OVERSPEED,
    label: 'Approach overspeed',
    severity: 'warning',
    counts_as_upset: false,
    max_approach_kts: 165,
    approach_overspeed_limit_kts: 185,
    approach_overspeed_buffer_kts: 20,
    approach_overspeed_excess_kts: 16.4,
    fdm: {},
  });
  assert(row.rule_id === VIOLATION_RULE.APPROACH_OVERSPEED, `got "${row.rule_id}"`);
  assert(row.counts_as_upset === '0', `got "${row.counts_as_upset}"`);
  assert(row.max_approach_kts === '165.0', `got "${row.max_approach_kts}"`);
  assert(row.approach_overspeed_limit_kts === '185.0', `got "${row.approach_overspeed_limit_kts}"`);
  assert(row.approach_overspeed_buffer_kts === '20.0', `got "${row.approach_overspeed_buffer_kts}"`);
  assert(row.approach_overspeed_excess_kts === '16.4', `got "${row.approach_overspeed_excess_kts}"`);
});
test('surface_condition: reads f.surface_condition', () => {
  const row = buildRow({ surface_condition: 1, fdm: {} });
  assert(row.surface_condition === '1', `got "${row.surface_condition}"`);
});

console.log('\nExtractors: fdm fallback');
test('tas_kts: falls back to fdm.tasKts', () => {
  const row = buildRow({ fdm: { tasKts: 280.5 } });
  assert(row.tas_kts === '280.5', `got "${row.tas_kts}"`);
});
test('mach: falls back to fdm.mach', () => {
  const row = buildRow({ fdm: { mach: 0.82 } });
  assert(row.mach === '0.820', `got "${row.mach}"`);
});
test('oat_c: falls back to fdm.oatC', () => {
  const row = buildRow({ fdm: { oatC: -50 } });
  assert(row.oat_c === '-50.0', `got "${row.oat_c}"`);
});
test('eng1_n1_pct: reads f.eng1N1', () => {
  const row = buildRow({ eng1N1: 85.3, fdm: {} });
  assert(row.eng1_n1_pct === '85.3', `got "${row.eng1_n1_pct}"`);
});
test('eng1_n1_pct: falls back to fdm.eng1N1', () => {
  const row = buildRow({ fdm: { eng1N1: 86.1 } });
  assert(row.eng1_n1_pct === '86.1', `got "${row.eng1_n1_pct}"`);
});
test('eng3_n2_pct: reads f.eng3N2', () => {
  const row = buildRow({ eng3N2: 91.2, fdm: {} });
  assert(row.eng3_n2_pct === '91.2', `got "${row.eng3_n2_pct}"`);
});
test('eng2_egt_c: reads f.eng2Egt', () => {
  const row = buildRow({ eng2Egt: 640, fdm: {} });
  assert(row.eng2_egt_c === '640.0', `got "${row.eng2_egt_c}"`);
});
test('eng4_ff_pph: reads f.eng4FF', () => {
  const row = buildRow({ eng4FF: 4950, fdm: {} });
  assert(row.eng4_ff_pph === '4950.0', `got "${row.eng4_ff_pph}"`);
});

console.log('\nExtractors: yoke scaling');
test('yoke_x_pct: scales yokeX (±1) by 100', () => {
  const row = buildRow({ yokeX: 0.5, fdm: {} });
  assert(row.yoke_x_pct === '50.0', `expected "50.0" got "${row.yoke_x_pct}"`);
});
test('yoke_y_pct: scales yokeY (±1) by 100', () => {
  const row = buildRow({ yokeY: -0.25, fdm: {} });
  assert(row.yoke_y_pct === '-25.0', `expected "-25.0" got "${row.yoke_y_pct}"`);
});
test('yoke_x_pct: falls back to yoke.x * 100', () => {
  const row = buildRow({ yoke: { x: 0.1 }, fdm: {} });
  assert(row.yoke_x_pct === '10.0', `expected "10.0" got "${row.yoke_x_pct}"`);
});
test('yoke_x_pct: falls back to fdm.yokeXPct', () => {
  const row = buildRow({ fdm: { yokeXPct: 30 } });
  assert(row.yoke_x_pct === '30.0', `expected "30.0" got "${row.yoke_x_pct}"`);
});
test('yoke_x_pct: negative yokeX maps to negative', () => {
  const row = buildRow({ yokeX: -1.0, fdm: {} });
  assert(row.yoke_x_pct === '-100.0', `expected "-100.0" got "${row.yoke_x_pct}"`);
});

console.log('\nExtractors: spoiler_state');
test('spoiler_source: reads resolved source provenance', () => {
  const row = buildRow({ spoilerSource: 'sdk', fdm: {} });
  assert(row.spoiler_source === 'sdk', `expected "sdk" got "${row.spoiler_source}"`);
});
test('spoiler_available: formats resolved availability', () => {
  const row = buildRow({ spoilerAvailable: false, fdm: {} });
  assert(row.spoiler_available === '0', `expected "0" got "${row.spoiler_available}"`);
});
test('spoiler_state: reads f.spoilerState (flat field on enriched frame)', () => {
  const row = buildRow({ spoilerState: 'ARMED', fdm: {} });
  assert(row.spoiler_state === 'ARMED', `expected "ARMED" got "${row.spoiler_state}"`);
});
test('spoiler_state: reads landing payload f.spoiler_state', () => {
  const row = buildRow({ spoiler_state: 'ARMED', fdm: {} });
  assert(row.spoiler_state === 'ARMED', `expected "ARMED" got "${row.spoiler_state}"`);
});
test('spoiler_state: falls back to f.spoilers.state', () => {
  const row = buildRow({ spoilers: { state: 'EXTENDED' }, fdm: {} });
  assert(row.spoiler_state === 'EXTENDED', `expected "EXTENDED" got "${row.spoiler_state}"`);
});
test('spoiler_state: null when neither path present', () => {
  const row = buildRow({ fdm: {} });
  assert(row.spoiler_state === '', `expected "" got "${row.spoiler_state}"`);
});

console.log('\nExtractors: throttle fallback chain');
test('thr1_pct: reads f.thr1', () => {
  const row = buildRow({ thr1: 75.5, fdm: {} });
  assert(row.thr1_pct === '75.5', `got "${row.thr1_pct}"`);
});
test('thr3_pct: reads f.thr3', () => {
  const row = buildRow({ thr3: 62, fdm: {} });
  assert(row.thr3_pct === '62.0', `got "${row.thr3_pct}"`);
});
test('thr1_pct: falls back to throttle.eng1', () => {
  const row = buildRow({ throttle: { eng1: 80 }, fdm: {} });
  assert(row.thr1_pct === '80.0', `got "${row.thr1_pct}"`);
});
test('thr2_pct: falls back to throttle.eng2Pct', () => {
  const row = buildRow({ throttle: { eng2Pct: 82 }, fdm: {} });
  assert(row.thr2_pct === '82.0', `got "${row.thr2_pct}"`);
});

console.log('\nExtractors: boolean fields');
test('on_ground: formats true as "1"', () => {
  const row = buildRow({ onGround: true, fdm: {} });
  assert(row.on_ground === '1', `expected "1" got "${row.on_ground}"`);
});
test('on_ground: formats false as "0"', () => {
  const row = buildRow({ onGround: false, fdm: {} });
  assert(row.on_ground === '0', `expected "0" got "${row.on_ground}"`);
});
test('sim_paused: reads f.paused', () => {
  const row = buildRow({ paused: true, fdm: {} });
  assert(row.sim_paused === '1', `expected "1" got "${row.sim_paused}"`);
});
test('sim_in_menu: reads f.inMenu', () => {
  const row = buildRow({ inMenu: true, fdm: {} });
  assert(row.sim_in_menu === '1', `expected "1" got "${row.sim_in_menu}"`);
});
test('ap_master: reads from fdm.apMaster', () => {
  const row = buildRow({ fdm: { apMaster: true } });
  assert(row.ap_master === '1', `expected "1" got "${row.ap_master}"`);
});
test('ap_alt_hold: reads fdm.apAltHold', () => {
  const row = buildRow({ fdm: { apAltHold: true } });
  assert(row.ap_alt_hold === '1', `got "${row.ap_alt_hold}"`);
});
test('athr_active: reads f.athrActive', () => {
  const row = buildRow({ athrActive: false, fdm: {} });
  assert(row.athr_active === '0', `got "${row.athr_active}"`);
});
test('ap_fd_active: reads f.apFdActive', () => {
  const row = buildRow({ apFdActive: true, fdm: {} });
  assert(row.ap_fd_active === '1', `got "${row.ap_fd_active}"`);
});
test('ap_flc_hold: falls back to fdm.apLvlChgHold', () => {
  const row = buildRow({ fdm: { apLvlChgHold: true } });
  assert(row.ap_flc_hold === '1', `got "${row.ap_flc_hold}"`);
});
test('ap_speed_hold: reads f.ap_speed_hold', () => {
  const row = buildRow({ ap_speed_hold: false, fdm: {} });
  assert(row.ap_speed_hold === '0', `got "${row.ap_speed_hold}"`);
});
test('ap_reliable: reads f.apReliable', () => {
  const row = buildRow({ apReliable: false, fdm: {} });
  assert(row.ap_reliable === '0', `got "${row.ap_reliable}"`);
});
test('athr_reliable: reads f.athr_reliable', () => {
  const row = buildRow({ athr_reliable: true, fdm: {} });
  assert(row.athr_reliable === '1', `got "${row.athr_reliable}"`);
});
test('ap_reliability_reason: reads f.apReliabilityReason', () => {
  const row = buildRow({ apReliabilityReason: 'lvar-sidecar-absent:test-sdk-aircraft', fdm: {} });
  assert(row.ap_reliability_reason === 'lvar-sidecar-absent:test-sdk-aircraft', `got "${row.ap_reliability_reason}"`);
});
test('athr_armed: reads f.athrArmed', () => {
  const row = buildRow({ athrArmed: true, fdm: {} });
  assert(row.athr_armed === '1', `got "${row.athr_armed}"`);
});

console.log('\nExtractors: AP targets');
test('ap_alt_target_ft: reads fdm.apAltTargetFt', () => {
  const row = buildRow({ fdm: { apAltTargetFt: 10000 } });
  assert(row.ap_alt_target_ft === '10000', `got "${row.ap_alt_target_ft}"`);
});
test('ap_speed_target_kts: reads fdm.apSpeedTargetKts', () => {
  const row = buildRow({ fdm: { apSpeedTargetKts: 250 } });
  assert(row.ap_speed_target_kts === '250.0', `got "${row.ap_speed_target_kts}"`);
});
test('ap_mach_target: reads f.ap_mach_target', () => {
  const row = buildRow({ ap_mach_target: 0.78, fdm: {} });
  assert(row.ap_mach_target === '0.780', `got "${row.ap_mach_target}"`);
});

console.log('\nExtractors: cabin pressurization');
test('cabin_alt_ft: reads f.cabinAltFt', () => {
  const row = buildRow({ cabinAltFt: 7500, fdm: {} });
  assert(row.cabin_alt_ft === '7500', `got "${row.cabin_alt_ft}"`);
});
test('cabin_alt_rate_fpm: reads f.cabinAltRateFpm', () => {
  const row = buildRow({ cabinAltRateFpm: 200.5, fdm: {} });
  assert(row.cabin_alt_rate_fpm === '200.5', `got "${row.cabin_alt_rate_fpm}"`);
});
test('cabin_delta_p_psi: reads f.cabinDeltaPPsi', () => {
  const row = buildRow({ cabinDeltaPPsi: 7.82, fdm: {} });
  assert(row.cabin_delta_p_psi === '7.82', `got "${row.cabin_delta_p_psi}"`);
});
test('cabin_dump_switch: bool field reads f.cabinDumpSwitch', () => {
  const row = buildRow({ cabinDumpSwitch: false, fdm: {} });
  assert(row.cabin_dump_switch === '0', `got "${row.cabin_dump_switch}"`);
});

console.log('\nExtractors: surface');
test('surface_name: reads f.surfaceName', () => {
  const row = buildRow({ surfaceName: 'Asphalt', fdm: {} });
  assert(row.surface_name === 'Asphalt', `got "${row.surface_name}"`);
});
test('surface_name: falls back to f.surface.name', () => {
  const row = buildRow({ surface: { name: 'Concrete' }, fdm: {} });
  assert(row.surface_name === 'Concrete', `got "${row.surface_name}"`);
});
test('surface_raw/name/class: read landing payload snake_case aliases', () => {
  const row = buildRow({ surface_raw: 4, surface_name: 'Asphalt', surface_class: 'hard', fdm: {} });
  assert(row.surface_raw === '4', `got "${row.surface_raw}"`);
  assert(row.surface_name === 'Asphalt', `got "${row.surface_name}"`);
  assert(row.surface_class === 'hard', `got "${row.surface_class}"`);
});
test('surface_class: reads f.surfaceClass', () => {
  const row = buildRow({ surfaceClass: 'hard', fdm: {} });
  assert(row.surface_class === 'hard', `got "${row.surface_class}"`);
});
test('surface_runway_like: reads f.surfaceRunwayLike', () => {
  const row = buildRow({ surfaceRunwayLike: true, fdm: {} });
  assert(row.surface_runway_like === '1', `got "${row.surface_runway_like}"`);
});
test('surface_on_runway: reads explicit f.surface.onRunway separately from runwayLike', () => {
  const row = buildRow({ surface: { runwayLike: true, onRunway: false }, fdm: {} });
  assert(row.surface_runway_like === '1', `got "${row.surface_runway_like}"`);
  assert(row.surface_on_runway === '0', `got "${row.surface_on_runway}"`);
});
test('surface_on_ground: reads f.surface.onGround', () => {
  const row = buildRow({ surface: { onGround: false }, fdm: {} });
  assert(row.surface_on_ground === '0', `got "${row.surface_on_ground}"`);
});
test('surface_valid: reads f.surface_valid', () => {
  const row = buildRow({ surface_valid: true, fdm: {} });
  assert(row.surface_valid === '1', `got "${row.surface_valid}"`);
});

console.log('\nExtractors: new nav fields');
test('ias_trend_kts: reads f.iasTrend', () => {
  const row = buildRow({ iasTrend: -2.1, fdm: {} });
  assert(row.ias_trend_kts === '-2.1', `got "${row.ias_trend_kts}"`);
});
test('xwind_kts: reads f.xwind', () => {
  const row = buildRow({ xwind: 8, fdm: {} });
  assert(row.xwind_kts === '8.0', `got "${row.xwind_kts}"`);
});
test('xwind_kts: falls back to f.xwind_kts', () => {
  const row = buildRow({ xwind_kts: 12, fdm: {} });
  assert(row.xwind_kts === '12.0', `got "${row.xwind_kts}"`);
});
test('wind_speed_kts: reads f.windSpeed', () => {
  const row = buildRow({ windSpeed: 10, fdm: {} });
  assert(row.wind_speed_kts === '10.0', `got "${row.wind_speed_kts}"`);
});
test('wind_speed_kts: falls back to f.wind_speed_kts', () => {
  const row = buildRow({ wind_speed_kts: 14, fdm: {} });
  assert(row.wind_speed_kts === '14.0', `got "${row.wind_speed_kts}"`);
});
test('wind_dir_deg: reads f.windDir', () => {
  const row = buildRow({ windDir: 270, fdm: {} });
  assert(row.wind_dir_deg === '270.0', `got "${row.wind_dir_deg}"`);
});
test('wind_dir_deg: falls back to f.wind_dir_deg', () => {
  const row = buildRow({ wind_dir_deg: 320, fdm: {} });
  assert(row.wind_dir_deg === '320.0', `got "${row.wind_dir_deg}"`);
});
test('fdm_surface_condition: reads f.fdm_surface_condition', () => {
  const row = buildRow({ fdm_surface_condition: 1, fdm: {} });
  assert(row.fdm_surface_condition === '1', `got "${row.fdm_surface_condition}"`);
});
test('fdm_precip_state: reads f.fdm_precip_state', () => {
  const row = buildRow({ fdm_precip_state: 2, fdm: {} });
  assert(row.fdm_precip_state === '2', `got "${row.fdm_precip_state}"`);
});
test('fdm_precip_rate_mm: reads f.fdm_precip_rate_mm', () => {
  const row = buildRow({ fdm_precip_rate_mm: 0.85, fdm: {} });
  assert(row.fdm_precip_rate_mm === '0.85', `got "${row.fdm_precip_rate_mm}"`);
});
test('fdm_oat_c: reads f.fdm_oat_c', () => {
  const row = buildRow({ fdm_oat_c: 4.5, fdm: {} });
  assert(row.fdm_oat_c === '4.5', `got "${row.fdm_oat_c}"`);
});
test('landing event timestamps: reads snake_case payload aliases', () => {
  const row = buildRow({
    timestamp_ms: 1770000000123,
    timestamp_utc: '2026-02-03T04:05:00.123Z',
    flight_start: '2026-02-03T03:30:00.000Z',
    fdm: {},
  });
  assert(row.ts === '1770000000123', `got "${row.ts}"`);
  assert(row.timestamp_utc === '2026-02-03T04:05:00.123Z', `got "${row.timestamp_utc}"`);
  assert(row.flight_start_iso === '2026-02-03T03:30:00.000Z', `got "${row.flight_start_iso}"`);
});
test('landing final fields: persist runway and touchdown diagnostics', () => {
  const row = buildRow({
    approach_type: 'ILS',
    runway_geometry_source: 'ourairports',
    runway_geometry_provider_chain: 'msfs-facilities:miss,ourairports:hit',
    runway_geometry_fallback_reason: 'msfs-facilities:miss',
    runway_geometry_diagnostics: { providerChain: 'msfs-facilities:miss,ourairports:hit' },
    runway_reference_elev_ft: 21.35,
    runway_reference_elevation_source: 'msfs-facilities',
    runway_reference_elevation_kind: 'runway',
    runway_heading_true_deg: 335.2,
    runway_physical_length_ft: 9000,
    runway_surface: 'ASPHALT',
    runway_threshold_lat: 37.12345,
    runway_threshold_lon: -122.98765,
    runway_physical_threshold_lat: 37.12001,
    runway_physical_threshold_lon: -122.98123,
    runway_displaced_threshold_ft: 1000,
    touchdown_distance_zone: 'Before Threshold',
    short_landing: true,
    runway_condition: 'wet',
    runway_condition_source: 'inferred',
    runway_condition_confident: false,
    lateral_offset_ft: 42,
    lateral_offset_side: 'right',
    lateral_offset_score: 85,
    lateral_offset_grade: 'Marginal',
    lateral_offset_suspect: false,
    runway_width_ft: 150,
    runway_excursion: true,
    landing_final: true,
    ultimate_stability_verdict: 'marginal',
    ultimate_stability_breakdown: { gear_ok: 100 },
    ultimate_stability_context: {
      schemaVersion: 1,
      profile: { id: 'generic', name: 'Generic Aircraft', reliability: 'generic' },
      criteria: { speedMinusKts: 50, speedPlusKts: 100 },
      reference: { gateIasKts: 145 },
    },
    ultimate_stability_gear_ok_pct: 100,
    ultimate_stability_flaps_ok_pct: 95,
    ultimate_stability_spoilers_ok_pct: 90,
    ultimate_stability_config_ok_pct: 82,
    ultimate_stability_speed_ok_pct: 81,
    ultimate_stability_speed_trend_ok_pct: 79,
    ultimate_stability_vs_ok_pct: 77,
    ultimate_stability_glidepath_ok_pct: 74,
    ultimate_stability_glidepath_below_ok_pct: 73,
    ultimate_stability_glidepath_above_ok_pct: 72,
    ultimate_stability_thrust_ok_pct: 71,
    ultimate_stability_thrust_not_idle_ok_pct: 69,
    ultimate_stability_thrust_stable_ok_pct: 68,
    ultimate_stability_pitch_ok_pct: 80,
    ultimate_stability_bank_ok_pct: 75,
    ultimate_stability_lateral_offset_ok_pct: 70,
    first_touchdown_lat: 37.1234,
    first_touchdown_lon: -122.9876,
    first_touchdown_vs_fpm: -330,
    first_touchdown_gforce: 1.14,
    final_touchdown_lat: 37.1235,
    final_touchdown_lon: -122.9877,
    final_touchdown_vs_fpm: -420,
    final_touchdown_gforce: 1.28,
    fdm: {},
  });
  assert(row.approach_type === 'ILS', `got "${row.approach_type}"`);
  assert(row.runway_geometry_source === 'ourairports', `got "${row.runway_geometry_source}"`);
  assert(row.runway_geometry_provider_chain === 'msfs-facilities:miss,ourairports:hit', `got "${row.runway_geometry_provider_chain}"`);
  assert(row.runway_geometry_fallback_reason === 'msfs-facilities:miss', `got "${row.runway_geometry_fallback_reason}"`);
  assert(row.runway_geometry_diagnostics === '{"providerChain":"msfs-facilities:miss,ourairports:hit"}', `got "${row.runway_geometry_diagnostics}"`);
  assert(row.runway_reference_elev_ft === '21.4', `got "${row.runway_reference_elev_ft}"`);
  assert(row.runway_reference_elevation_source === 'msfs-facilities', `got "${row.runway_reference_elevation_source}"`);
  assert(row.runway_reference_elevation_kind === 'runway', `got "${row.runway_reference_elevation_kind}"`);
  assert(row.runway_heading_true_deg === '335.2', `got "${row.runway_heading_true_deg}"`);
  assert(row.runway_physical_length_ft === '9000', `got "${row.runway_physical_length_ft}"`);
  assert(row.runway_surface === 'ASPHALT', `got "${row.runway_surface}"`);
  assert(row.runway_threshold_lat === '37.123450', `got "${row.runway_threshold_lat}"`);
  assert(row.runway_threshold_lon === '-122.987650', `got "${row.runway_threshold_lon}"`);
  assert(row.runway_physical_threshold_lat === '37.120010', `got "${row.runway_physical_threshold_lat}"`);
  assert(row.runway_physical_threshold_lon === '-122.981230', `got "${row.runway_physical_threshold_lon}"`);
  assert(row.runway_displaced_threshold_ft === '1000', `got "${row.runway_displaced_threshold_ft}"`);
  assert(row.touchdown_distance_zone === 'Before Threshold', `got "${row.touchdown_distance_zone}"`);
  assert(row.short_landing === '1', `got "${row.short_landing}"`);
  assert(row.runway_condition === 'wet', `got "${row.runway_condition}"`);
  assert(row.runway_condition_source === 'inferred', `got "${row.runway_condition_source}"`);
  assert(row.runway_condition_confident === '0', `got "${row.runway_condition_confident}"`);
  assert(row.lateral_offset_ft === '42', `got "${row.lateral_offset_ft}"`);
  assert(row.lateral_offset_side === 'right', `got "${row.lateral_offset_side}"`);
  assert(row.lateral_offset_score === '85.0', `got "${row.lateral_offset_score}"`);
  assert(row.lateral_offset_grade === 'Marginal', `got "${row.lateral_offset_grade}"`);
  assert(row.lateral_offset_suspect === '0', `got "${row.lateral_offset_suspect}"`);
  assert(row.runway_width_ft === '150', `got "${row.runway_width_ft}"`);
  assert(row.runway_excursion === '1', `got "${row.runway_excursion}"`);
  assert(row.landing_final === '1', `got "${row.landing_final}"`);
  assert(row.ultimate_stability_verdict === 'marginal', `got "${row.ultimate_stability_verdict}"`);
  assert(row.ultimate_stability_breakdown === '{"gear_ok":100}', `got "${row.ultimate_stability_breakdown}"`);
  assert(
    row.ultimate_stability_context === '{"schemaVersion":1,"profile":{"id":"generic","name":"Generic Aircraft","reliability":"generic"},"criteria":{"speedMinusKts":50,"speedPlusKts":100},"reference":{"gateIasKts":145}}',
    `got "${row.ultimate_stability_context}"`,
  );
  assert(row.ultimate_stability_gear_ok_pct === '100.0', `got "${row.ultimate_stability_gear_ok_pct}"`);
  assert(row.ultimate_stability_flaps_ok_pct === '95.0', `got "${row.ultimate_stability_flaps_ok_pct}"`);
  assert(row.ultimate_stability_spoilers_ok_pct === '90.0', `got "${row.ultimate_stability_spoilers_ok_pct}"`);
  assert(!Object.prototype.hasOwnProperty.call(row, 'ultimate_stability_checklist_ok_pct'), 'checklist stability column should not be emitted');
  assert(row.ultimate_stability_config_ok_pct === '82.0', `got "${row.ultimate_stability_config_ok_pct}"`);
  assert(row.ultimate_stability_speed_ok_pct === '81.0', `got "${row.ultimate_stability_speed_ok_pct}"`);
  assert(row.ultimate_stability_speed_trend_ok_pct === '79.0', `got "${row.ultimate_stability_speed_trend_ok_pct}"`);
  assert(row.ultimate_stability_vs_ok_pct === '77.0', `got "${row.ultimate_stability_vs_ok_pct}"`);
  assert(row.ultimate_stability_glidepath_ok_pct === '74.0', `got "${row.ultimate_stability_glidepath_ok_pct}"`);
  assert(row.ultimate_stability_glidepath_below_ok_pct === '73.0', `got "${row.ultimate_stability_glidepath_below_ok_pct}"`);
  assert(row.ultimate_stability_glidepath_above_ok_pct === '72.0', `got "${row.ultimate_stability_glidepath_above_ok_pct}"`);
  assert(row.ultimate_stability_thrust_ok_pct === '71.0', `got "${row.ultimate_stability_thrust_ok_pct}"`);
  assert(row.ultimate_stability_thrust_not_idle_ok_pct === '69.0', `got "${row.ultimate_stability_thrust_not_idle_ok_pct}"`);
  assert(row.ultimate_stability_thrust_stable_ok_pct === '68.0', `got "${row.ultimate_stability_thrust_stable_ok_pct}"`);
  assert(row.ultimate_stability_pitch_ok_pct === '80.0', `got "${row.ultimate_stability_pitch_ok_pct}"`);
  assert(row.ultimate_stability_bank_ok_pct === '75.0', `got "${row.ultimate_stability_bank_ok_pct}"`);
  assert(row.ultimate_stability_lateral_offset_ok_pct === '70.0', `got "${row.ultimate_stability_lateral_offset_ok_pct}"`);
  assert(row.first_touchdown_lat === '37.123400', `got "${row.first_touchdown_lat}"`);
  assert(row.first_touchdown_lon === '-122.987600', `got "${row.first_touchdown_lon}"`);
  assert(row.first_touchdown_vs_fpm === '-330.0', `got "${row.first_touchdown_vs_fpm}"`);
  assert(row.first_touchdown_gforce === '1.14', `got "${row.first_touchdown_gforce}"`);
  assert(row.final_touchdown_lat === '37.123500', `got "${row.final_touchdown_lat}"`);
  assert(row.final_touchdown_lon === '-122.987700', `got "${row.final_touchdown_lon}"`);
  assert(row.final_touchdown_vs_fpm === '-420.0', `got "${row.final_touchdown_vs_fpm}"`);
  assert(row.final_touchdown_gforce === '1.28', `got "${row.final_touchdown_gforce}"`);
});

test('stability metric CSV columns stay fixed to the approved contract', () => {
  assertSameStringSet(
    extractStabilityMetricColumnKeys(),
    EXPECTED_STABILITY_BREAKDOWN_METRICS,
    'ultimate_stability_*_pct column metric set',
  );
});

test('magvar_deg: reads f.magvar', () => {
  const row = buildRow({ magvar: 5.2, fdm: {} });
  assert(row.magvar_deg === '5.20', `got "${row.magvar_deg}"`);
});

test('magvar_deg: reads canonical magvar_deg payload field', () => {
  const row = buildRow({ magvar_deg: -14.75, fdm: {} });
  assert(row.magvar_deg === '-14.75', `got "${row.magvar_deg}"`);
});

console.log('\nExtractors: flaps');
test('flaps_pct: number flaps uses directly', () => {
  const row = buildRow({ flaps: 15, fdm: {} });
  assert(row.flaps_pct === '15.0', `got "${row.flaps_pct}"`);
});
test('flaps_pct: object flaps uses percent', () => {
  const row = buildRow({ flaps: { percent: 40 }, fdm: {} });
  assert(row.flaps_pct === '40.0', `got "${row.flaps_pct}"`);
});
test('flaps_notch: reads flapsNotch (fmt.str passes number through)', () => {
  const row = buildRow({ flapsNotch: 3, fdm: {} });
  // fmt.str is a pass-through — for numeric input returns number, not string.
  // The CSV writer (escapeCSV) will call String() on it at write time.
  assert(String(row.flaps_notch) === '3', `got "${row.flaps_notch}"`);
});
test('flaps_source: preserves profile-backed provenance', () => {
  const row = buildRow({ flapsSource: 'profile', fdm: {} });
  assert(row.flaps_source === 'profile', `got "${row.flaps_source}"`);
});

console.log('\nExtractors: aero/nav fdm-sourced fields');
test('aoa_deg: reads f.aoa', () => {
  const row = buildRow({ aoa: 4.2, fdm: {} });
  assert(row.aoa_deg === '4.2', `got "${row.aoa_deg}"`);
});
test('aoa_deg: falls back to fdm.aoaDeg', () => {
  const row = buildRow({ fdm: { aoaDeg: 4.2 } });
  assert(row.aoa_deg === '4.2', `got "${row.aoa_deg}"`);
});
test('sideslip_deg: reads f.sideslip', () => {
  const row = buildRow({ sideslip: -1.5, fdm: {} });
  assert(row.sideslip_deg === '-1.5', `got "${row.sideslip_deg}"`);
});
test('sideslip_deg: falls back to fdm.sideslipDeg', () => {
  const row = buildRow({ fdm: { sideslipDeg: -1.5 } });
  assert(row.sideslip_deg === '-1.5', `got "${row.sideslip_deg}"`);
});
test('track_true_deg: reads f.trackTrue', () => {
  const row = buildRow({ trackTrue: 92.5, fdm: {} });
  assert(row.track_true_deg === '92.5', `got "${row.track_true_deg}"`);
});
test('track_true_deg: falls back to fdm.trackTrueDeg', () => {
  const row = buildRow({ fdm: { trackTrueDeg: 92.5 } });
  assert(row.track_true_deg === '92.5', `got "${row.track_true_deg}"`);
});
test('g_force_lateral: reads f.gForceLateral', () => {
  const row = buildRow({ gForceLateral: 0.15, fdm: {} });
  assert(row.g_force_lateral === '0.15', `got "${row.g_force_lateral}"`);
});
test('g_force_lateral: falls back to fdm.gForceLateral', () => {
  const row = buildRow({ fdm: { gForceLateral: 0.15 } });
  assert(row.g_force_lateral === '0.15', `got "${row.g_force_lateral}"`);
});
test('g_force_longitudinal: reads f.gForceLongitudinal', () => {
  const row = buildRow({ gForceLongitudinal: -0.08, fdm: {} });
  assert(row.g_force_longitudinal === '-0.08', `got "${row.g_force_longitudinal}"`);
});
test('g_force_longitudinal: falls back to fdm.gForceLongitudinal', () => {
  const row = buildRow({ fdm: { gForceLongitudinal: -0.08 } });
  assert(row.g_force_longitudinal === '-0.08', `got "${row.g_force_longitudinal}"`);
});
test('elev_trim_pct: reads f.elevTrimPct', () => {
  const row = buildRow({ elevTrimPct: -3.5, fdm: {} });
  assert(row.elev_trim_pct === '-3.5', `got "${row.elev_trim_pct}"`);
});
test('elev_trim_pct: falls back to fdm.elevTrimPct', () => {
  const row = buildRow({ fdm: { elevTrimPct: -3.5 } });
  assert(row.elev_trim_pct === '-3.5', `got "${row.elev_trim_pct}"`);
});
test('gs_deviation_dots: reads f.gsDeviation', () => {
  const row = buildRow({ gsDeviation: -0.5, fdm: {} });
  assert(row.gs_deviation_dots === '-0.50', `got "${row.gs_deviation_dots}"`);
});
test('gs_deviation_dots: falls back to fdm.gsDeviationDots', () => {
  const row = buildRow({ fdm: { gsDeviationDots: -0.5 } });
  assert(row.gs_deviation_dots === '-0.50', `got "${row.gs_deviation_dots}"`);
});
test('gs_deviation_dots: rejects implausible values and falls back', () => {
  const row = buildRow({ gsDeviation: 141.14, fdm: { gsDeviationDots: -0.5 } });
  assert(row.gs_deviation_dots === '-0.50', `got "${row.gs_deviation_dots}"`);
});
test('loc_deviation_dots: reads f.locDeviation', () => {
  const row = buildRow({ locDeviation: 0.25, fdm: {} });
  assert(row.loc_deviation_dots === '0.25', `got "${row.loc_deviation_dots}"`);
});
test('loc_deviation_dots: falls back to fdm.locDeviationDots', () => {
  const row = buildRow({ fdm: { locDeviationDots: 0.25 } });
  assert(row.loc_deviation_dots === '0.25', `got "${row.loc_deviation_dots}"`);
});
test('loc_deviation_dots: blanks impossible values', () => {
  const row = buildRow({ locDeviation: 141.14, fdm: { locDeviationDots: 89.76 } });
  assert(row.loc_deviation_dots === '', `got "${row.loc_deviation_dots}"`);
});
test('nav1 validity fields: reads flat enriched values', () => {
  const row = buildRow({
    nav1GsiRaw: 119,
    nav1CdiRaw: -127,
    nav1HasGlideSlope: true,
    nav1HasLocalizer: false,
    nav1Signal: 98,
    fdm: {},
  });
  assert(row.nav1_gsi_raw === '119.00', `got "${row.nav1_gsi_raw}"`);
  assert(row.nav1_cdi_raw === '-127.00', `got "${row.nav1_cdi_raw}"`);
  assert(row.nav1_has_glideslope === '1', `got "${row.nav1_has_glideslope}"`);
  assert(row.nav1_has_localizer === '0', `got "${row.nav1_has_localizer}"`);
  assert(row.nav1_signal === '98.00', `got "${row.nav1_signal}"`);
});
test('nav1 validity fields: fall back to fdm values', () => {
  const row = buildRow({
    fdm: {
      nav1GsiRaw: 42,
      nav1CdiRaw: -17,
      nav1HasGlideSlope: false,
      nav1HasLocalizer: true,
      nav1Signal: 73,
    },
  });
  assert(row.nav1_gsi_raw === '42.00', `got "${row.nav1_gsi_raw}"`);
  assert(row.nav1_cdi_raw === '-17.00', `got "${row.nav1_cdi_raw}"`);
  assert(row.nav1_has_glideslope === '0', `got "${row.nav1_has_glideslope}"`);
  assert(row.nav1_has_localizer === '1', `got "${row.nav1_has_localizer}"`);
  assert(row.nav1_signal === '73.00', `got "${row.nav1_signal}"`);
});

test('MSFS touchdown diagnostic fields are extracted and formatted', () => {
  const row = buildRow({
    touchdown_capture_source: 'msfs_last_touchdown',
    td_sim_trusted: true,
    td_sim_fresh: false,
    td_sim_reject_reason: 'stale',
    td_sim_position_delta_ft: 12.34,
    td_sim_lat_deg: 47.449888,
    td_sim_lon_deg: -122.308777,
    td_sim_hdg_true_deg: 164.24,
    td_sim_hdg_mag_deg: 149.12,
    td_sim_pitch_deg: 3.44,
    td_sim_bank_deg: -1.21,
    td_sim_normal_velocity_fps: 8.255,
    td_sim_normal_velocity_fpm: 495.3,
    td_sim_landing_vs_fpm: -495.3,
    fdm: {},
  });
  assert(row.touchdown_capture_source === 'msfs_last_touchdown', `got "${row.touchdown_capture_source}"`);
  assert(row.td_sim_trusted === '1', `got "${row.td_sim_trusted}"`);
  assert(row.td_sim_fresh === '0', `got "${row.td_sim_fresh}"`);
  assert(row.td_sim_reject_reason === 'stale', `got "${row.td_sim_reject_reason}"`);
  assert(row.td_sim_position_delta_ft === '12.3', `got "${row.td_sim_position_delta_ft}"`);
  assert(row.td_sim_lat_deg === '47.449888', `got "${row.td_sim_lat_deg}"`);
  assert(row.td_sim_lon_deg === '-122.308777', `got "${row.td_sim_lon_deg}"`);
  assert(row.td_sim_hdg_true_deg === '164.2', `got "${row.td_sim_hdg_true_deg}"`);
  assert(row.td_sim_hdg_mag_deg === '149.1', `got "${row.td_sim_hdg_mag_deg}"`);
  assert(row.td_sim_pitch_deg === '3.4', `got "${row.td_sim_pitch_deg}"`);
  assert(row.td_sim_bank_deg === '-1.2', `got "${row.td_sim_bank_deg}"`);
  assert(row.td_sim_normal_velocity_fps === '8.26', `got "${row.td_sim_normal_velocity_fps}"`);
  assert(row.td_sim_normal_velocity_fpm === '495.3', `got "${row.td_sim_normal_velocity_fpm}"`);
  assert(row.td_sim_landing_vs_fpm === '-495.3', `got "${row.td_sim_landing_vs_fpm}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('assist columns extract nested sample values and flat landing payload values', () => {
  const nestedRow = buildRow({
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
      slewActive: true,
      anyAssistActive: true,
    },
    fdm: {},
  });
  assert(nestedRow.assist_unlimited_fuel === '0', `got "${nestedRow.assist_unlimited_fuel}"`);
  assert(nestedRow.assist_landing_enabled === '1', `got "${nestedRow.assist_landing_enabled}"`);
  assert(nestedRow.assist_takeoff_enabled === '0', `got "${nestedRow.assist_takeoff_enabled}"`);
  assert(nestedRow.assist_ai_controls === '1', `got "${nestedRow.assist_ai_controls}"`);
  assert(nestedRow.assist_ai_autotrim === '0', `got "${nestedRow.assist_ai_autotrim}"`);
  assert(nestedRow.assist_ai_delegated === '1', `got "${nestedRow.assist_ai_delegated}"`);
  assert(nestedRow.assist_ai_antistall_state === '1', `got "${nestedRow.assist_ai_antistall_state}"`);
  assert(nestedRow.assist_ai_antistall_active === '1', `got "${nestedRow.assist_ai_antistall_active}"`);
  assert(nestedRow.assist_realism_pct === '75', `got "${nestedRow.assist_realism_pct}"`);
  assert(nestedRow.assist_full_realism === '0', `got "${nestedRow.assist_full_realism}"`);
  assert(nestedRow.assist_slew_active === '1', `got "${nestedRow.assist_slew_active}"`);
  assert(nestedRow.assist_any_active === '1', `got "${nestedRow.assist_any_active}"`);

  const flatRow = buildRow({
    assist_unlimited_fuel: true,
    assist_landing_enabled: false,
    assist_takeoff_enabled: true,
    assist_ai_controls: false,
    assist_ai_autotrim: true,
    assist_ai_delegated: false,
    assist_ai_antistall_state: 2,
    assist_ai_antistall_active: false,
    assist_realism_pct: 100,
    assist_full_realism: true,
    assist_slew_active: false,
    assist_any_active: false,
    fdm: {},
  });
  assert(flatRow.assist_unlimited_fuel === '1', `got "${flatRow.assist_unlimited_fuel}"`);
  assert(flatRow.assist_landing_enabled === '0', `got "${flatRow.assist_landing_enabled}"`);
  assert(flatRow.assist_takeoff_enabled === '1', `got "${flatRow.assist_takeoff_enabled}"`);
  assert(flatRow.assist_ai_controls === '0', `got "${flatRow.assist_ai_controls}"`);
  assert(flatRow.assist_ai_autotrim === '1', `got "${flatRow.assist_ai_autotrim}"`);
  assert(flatRow.assist_ai_delegated === '0', `got "${flatRow.assist_ai_delegated}"`);
  assert(flatRow.assist_ai_antistall_state === '2', `got "${flatRow.assist_ai_antistall_state}"`);
  assert(flatRow.assist_ai_antistall_active === '0', `got "${flatRow.assist_ai_antistall_active}"`);
  assert(flatRow.assist_realism_pct === '100', `got "${flatRow.assist_realism_pct}"`);
  assert(flatRow.assist_full_realism === '1', `got "${flatRow.assist_full_realism}"`);
  assert(flatRow.assist_slew_active === '0', `got "${flatRow.assist_slew_active}"`);
  assert(flatRow.assist_any_active === '0', `got "${flatRow.assist_any_active}"`);
});

// 3. buildRow() completeness
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildRow() completeness');
test('all FIELD_MAP columns present in output', () => {
  const row = buildRow({ fdm: {} });
  for (const field of FIELD_MAP) {
    assert(field.name in row, `column "${field.name}" missing from output`);
  }
});
test('no extra columns beyond FIELD_MAP', () => {
  const row = buildRow({ fdm: {} });
  const schemaNames = new Set(FIELD_MAP.map(f => f.name));
  for (const key of Object.keys(row)) {
    assert(schemaNames.has(key), `unexpected column "${key}" in output`);
  }
});
test('null frame fields produce empty strings, not crashes', () => {
  // All primary fields absent — should not throw
  const row = buildRow({ fdm: {} });
  assert(typeof row === 'object', 'expected object');
});
test('stability: reads f.stability', () => {
  const row = buildRow({ stability: 'STABLE', fdm: {} });
  assert(row.stability === 'STABLE', `got "${row.stability}"`);
});
test('sim_time_zulu_sec: reads f.simTimeZuluSec', () => {
  const row = buildRow({ simTimeZuluSec: 43200, fdm: {} });
  assert(row.sim_time_zulu_sec === '43200', `got "${row.sim_time_zulu_sec}"`);
});
test('sample_index: reads f.sampleIndex', () => {
  const row = buildRow({ sampleIndex: 42, fdm: {} });
  assert(row.sample_index === '42', `got "${row.sample_index}"`);
});
test('recorded_at aliases mirror capture timestamp', () => {
  const row = buildRow({
    timestampMs: 1770000000123,
    timestampIso: '2026-02-03T04:05:00.123Z',
    fdm: {},
  });
  assert(row.recorded_at_ms === '1770000000123', `got "${row.recorded_at_ms}"`);
  assert(row.recorded_at_utc === '2026-02-03T04:05:00.123Z', `got "${row.recorded_at_utc}"`);
});
test('sim datetime fields read enriched frame aliases', () => {
  const row = buildRow({
    simTimeZuluSec: 43200,
    simTimeLocalSec: 39600,
    simTimeZuluHms: '12:00:00',
    simTimeLocalHms: '11:00:00',
    simDateZulu: '2026-06-07',
    simDateLocal: '2026-06-07',
    simDatetimeUtc: '2026-06-07T12:00:00Z',
    simDatetimeLocal: '2026-06-07T11:00:00',
    simDatetimeSource: 'simconnect',
    simDatetimeValid: true,
    simTimezoneOffsetSec: -3600,
    simAbsoluteTimeSec: 63884995200,
    simTimeOfDay: 3,
    simZuluYear: 2026,
    simZuluMonth: 6,
    simZuluDay: 7,
    simZuluDayOfYear: 158,
    simZuluDayOfWeek: 0,
    simLocalYear: 2026,
    simLocalMonth: 6,
    simLocalDay: 7,
    simLocalDayOfYear: 158,
    simLocalDayOfWeek: 6,
    simZuluSunriseSec: 21000,
    simZuluSunsetSec: 69000,
    fdm: {},
  });
  assert(row.sim_time_local_sec === '39600', `got "${row.sim_time_local_sec}"`);
  assert(row.sim_time_zulu_hms === '12:00:00', `got "${row.sim_time_zulu_hms}"`);
  assert(row.sim_date_utc === '2026-06-07', `got "${row.sim_date_utc}"`);
  assert(row.sim_datetime_utc === '2026-06-07T12:00:00Z', `got "${row.sim_datetime_utc}"`);
  assert(row.sim_datetime_source === 'simconnect', `got "${row.sim_datetime_source}"`);
  assert(row.sim_datetime_valid === '1', `got "${row.sim_datetime_valid}"`);
  assert(row.sim_timezone_offset_sec === '-3600', `got "${row.sim_timezone_offset_sec}"`);
  assert(row.sim_time_of_day === '3', `got "${row.sim_time_of_day}"`);
  assert(row.sim_local_day_of_week === '6', `got "${row.sim_local_day_of_week}"`);
  assert(row.sim_zulu_sunrise_sec === '21000', `got "${row.sim_zulu_sunrise_sec}"`);
  assert(row.sim_zulu_sunset_sec === '69000', `got "${row.sim_zulu_sunset_sec}"`);
});
test('flight_start_iso: reads f.flightStartIso', () => {
  const row = buildRow({ flightStartIso: '2026-01-01T00:00:00.000Z', fdm: {} });
  assert(row.flight_start_iso === '2026-01-01T00:00:00.000Z', `got "${row.flight_start_iso}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✓ All ${passed} schema-field-map tests passed`);
  process.exit(0);
} else {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  process.exit(1);
}

export {};
