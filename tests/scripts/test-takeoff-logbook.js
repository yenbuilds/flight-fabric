#!/usr/bin/env node
/**
 * Takeoff logbook: the local JSON log that feeds the Logbook's scored-takeoff
 * list. Proves takeoff:final payload -> entry -> stats, bundle-keyed pruning,
 * and that a corrupt file fails loudly instead of silently dropping takeoffs.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getRepoScratchAppData } = require('./repo-scratch');

const tempAppData = getRepoScratchAppData('takeoff-logbook-appdata');
fs.rmSync(tempAppData, { recursive: true, force: true });
fs.mkdirSync(tempAppData, { recursive: true });
process.env.APPDATA = tempAppData;

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const takeoffLogbook = require(resolveBackendRuntimeFile('takeoff', 'takeoff-logbook.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.stack || err.message}`);
    failed++;
  }
}

function payload(overrides = {}) {
  return {
    timestamp_ms: 1_700_300_032_200,
    timestamp_utc: '2023-11-18T10:13:52.200Z',
    flight_start: '2023-11-18T10:00:00.000Z',
    aircraft: 'PMDG 737-800',
    aircraft_profile_id: 'pmdg-737',
    icao: 'YSCB',
    runway: '35',
    ias_kts: 146,
    gs_kts: 142,
    pitch_deg: 9.1,
    flaps_notch: 1,
    wind_speed_kts: 8,
    wind_dir_deg: 90,
    xwind_kts: 8,
    takeoff_roll_distance_ft: 3812,
    takeoff_roll_duration_s: 30,
    takeoff_roll_start_source: 'standstill',
    takeoff_liftoff_distance_ft: 4024,
    takeoff_runway_remaining_ft: 1976,
    takeoff_runway_used_pct: 67.1,
    takeoff_runway_use_score: 95,
    takeoff_runway_use_grade: 'Good',
    takeoff_runway_use_zone: 'Comfortable margin',
    runway_physical_length_ft: 6000,
    runway_length_ft: 6000,
    runway_geometry_source: 'msfs-facilities',
    takeoff_screen_height_ft: 35,
    takeoff_screen_height_remaining_ft: 1200,
    takeoff_rotation_rate_deg_s: 2.5,
    takeoff_max_pitch_deg: 12.4,
    lateral_offset_ft: 4,
    lateral_offset_side: 'center',
    lateral_offset_grade: 'Perfect',
    lateral_offset_suspect: false,
    takeoff_hop_count: 0,
    takeoff_assessment: 'normal',
    runway_excursion: false,
    takeoff_analysis: { screenHeight: { reached: true }, flags: [] },
    ...overrides,
  };
}

test('starts empty and reports empty stats', () => {
  assert.deepEqual(takeoffLogbook.getEntries(), []);
  assert.equal(takeoffLogbook.getStats().total, 0);
  assert.equal(fs.existsSync(takeoffLogbook.TAKEOFF_LOG_FILE), false, 'no file until a takeoff is scored');
});

test('a scored takeoff becomes a newest-first entry with the fields the Logbook renders', () => {
  const entry = takeoffLogbook.addEntry(payload(), { bundleName: 'bundle-a', recordingSessionId: 'session-a', flightId: 'flight-a' });
  assert(entry);
  assert.equal(entry.timestampMs, 1_700_300_032_200);
  assert.equal(entry.timestamp, '2023-11-18T10:13:52.200Z');
  assert.equal(entry.aircraft, 'PMDG 737-800');
  assert.equal(entry.aircraftProfileId, 'pmdg-737');
  assert.equal(entry.icao, 'YSCB');
  assert.equal(entry.runway, '35');
  assert.equal(entry.iasKts, 146);
  assert.equal(entry.rollDistanceFt, 3812);
  assert.equal(entry.rollDurationS, 30);
  assert.equal(entry.rollStartSource, 'standstill');
  assert.equal(entry.runwayRemainingFt, 1976);
  assert.equal(entry.runwayUsedPct, 67.1);
  assert.equal(entry.runwayUseGrade, 'Good');
  assert.equal(entry.runwayUseZone, 'Comfortable margin');
  assert.equal(entry.runwayLengthFt, 6000);
  assert.equal(entry.screenHeightFt, 35);
  assert.equal(entry.screenHeightRemainingFt, 1200);
  assert.equal(entry.screenHeightReached, true);
  assert.equal(entry.rotationRateDegS, 2.5);
  assert.equal(entry.lateralOffsetSuspect, false);
  assert.equal(entry.hopCount, 0);
  assert.equal(entry.runwayExcursion, false);
  assert.deepEqual(entry.recording, { bundleName: 'bundle-a', recordingSessionId: 'session-a', flightId: 'flight-a' });
  assert.equal(fs.existsSync(takeoffLogbook.TAKEOFF_LOG_FILE), true);
  assert.equal(path.basename(takeoffLogbook.TAKEOFF_LOG_FILE), 'takeoff-log.json');

  takeoffLogbook.addEntry(payload({
    timestamp_ms: 1_700_400_000_000,
    timestamp_utc: null,
    icao: 'YSSY',
    runway: '34L',
    takeoff_runway_use_grade: 'Late Liftoff',
    takeoff_runway_remaining_ft: 300,
    takeoff_runway_used_pct: 95,
    takeoff_roll_distance_ft: 5500,
    takeoff_hop_count: 2,
    runway_excursion: '1',
    takeoff_analysis: { screenHeight: { reached: false }, flags: [
      { code: 'late_liftoff', label: 'Late liftoff with little runway remaining', severity: 'caution' },
      { label: 'no code' },
    ] },
  }), { bundleName: 'bundle-b' });
  const entries = takeoffLogbook.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].icao, 'YSSY', 'newest first');
  assert.equal(entries[0].timestamp, new Date(1_700_400_000_000).toISOString(), 'timestamp derives from epoch when the ISO text is missing');
  assert.equal(entries[0].hopCount, 2);
  assert.equal(entries[0].runwayExcursion, true);
  assert.equal(entries[0].screenHeightReached, false);
  assert.deepEqual(entries[0].flags, [{ code: 'late_liftoff', label: 'Late liftoff with little runway remaining', severity: 'caution' }]);
  assert.equal(entries[0].recording.bundleName, 'bundle-b');
  assert.equal(entries[0].recording.flightId, null);
});

test('stats summarise grades, cautions, roll and runway margin', () => {
  const stats = takeoffLogbook.getStats();
  assert.equal(stats.total, 2);
  assert.deepEqual(stats.grades, { Good: 1, 'Late Liftoff': 1 });
  assert.equal(stats.cautionCount, 1);
  assert.equal(stats.avgRollDistanceFt, 4656);
  assert.equal(stats.avgRunwayUsedPct, 81.1);
  assert.equal(stats.minRunwayRemainingFt, 300);
  assert.equal(stats.airports, 2);
  assert.equal(stats.aircraft, 1);
  assert.deepEqual(takeoffLogbook.computeStatsFromEntries([]), {
    total: 0, grades: {}, cautionCount: 0, avgRollDistanceFt: null, avgRunwayUsedPct: null, minRunwayRemainingFt: null, airports: 0, aircraft: 0,
  });
});

test('logbook response bounds entries without limiting aggregate stats', () => {
  const result = takeoffLogbook.getLogbook(1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].icao, 'YSSY', 'newest entry first');
  assert.equal(result.stats.total, 2, 'stats include entries outside the display limit');
  assert.deepEqual(result.stats, takeoffLogbook.getStats());
  for (const limit of [undefined, null, -1, 0, 'invalid']) {
    assert.equal(takeoffLogbook.getLogbook(limit).entries.length, 2, 'invalid limits use the default');
  }
});

test('deleting a flight bundle removes only its takeoffs', () => {
  assert.equal(takeoffLogbook.deleteEntriesForBundle('bundle-missing'), 0);
  assert.equal(takeoffLogbook.deleteEntriesForBundle(null), 0);
  assert.equal(takeoffLogbook.deleteEntriesForBundle('bundle-a'), 1);
  const entries = takeoffLogbook.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].recording.bundleName, 'bundle-b');
  assert.equal(takeoffLogbook.deleteEntry('nope'), false);
  assert.equal(takeoffLogbook.deleteEntry(entries[0].id), true);
  assert.equal(takeoffLogbook.getEntries().length, 0);
});

test('an invalid payload is ignored and a corrupt log is replaced by the next takeoff instead of disabling logging', () => {
  assert.equal(takeoffLogbook.addEntry(null), null);
  assert.equal(takeoffLogbook.addEntry('nope'), null);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    fs.writeFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, '{"entries": "broken"}');
    assert.deepEqual(takeoffLogbook.getEntries(), [], 'a damaged file reads as empty');
    assert.equal(takeoffLogbook.getStats().total, 0);
    assert.equal(warnings.length, 1, 'the damage is reported once');
    assert.match(warnings[0], /unreadable/);
    const entry = takeoffLogbook.addEntry(payload(), { bundleName: 'bundle-c' });
    assert(entry, 'the next scored takeoff still logs');
    assert.equal(takeoffLogbook.getEntries().length, 1, 'and replaces the damaged file');
    assert.equal(JSON.parse(fs.readFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, 'utf8')).entries.length, 1);
  } finally {
    console.warn = originalWarn;
  }
  takeoffLogbook.clearAll();
  assert.deepEqual(takeoffLogbook.getEntries(), []);
});

test('reads are served from cache until the file changes on disk', () => {
  takeoffLogbook.addEntry(payload(), { bundleName: 'bundle-d' });
  const first = takeoffLogbook.getEntries();
  assert.equal(first.length, 1);
  first.push({ id: 'tampered' });
  assert.equal(takeoffLogbook.getEntries().length, 1, 'callers get a copy, not the cached array');
  // An outside edit with a new size is noticed.
  const outside = { version: 1, entries: [{ id: 'outside-1', runwayUseGrade: 'Good', recording: {} }, { id: 'outside-2', runwayUseGrade: 'Good', recording: {} }] };
  fs.writeFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, JSON.stringify(outside, null, 2));
  assert.equal(takeoffLogbook.getEntries().length, 2, 'a changed file is re-read');
  takeoffLogbook.clearAll();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
