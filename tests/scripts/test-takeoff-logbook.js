#!/usr/bin/env node
/** Legacy takeoff JSON compatibility: preserve unmatched history while the
 * recording-backed index replaces entries proven recoverable from CSV. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resetRepoScratchDirectory } = require('./repo-scratch');
const tempAppData = path.join(resetRepoScratchDirectory('takeoff-logbook-appdata'), 'AppData', 'Roaming');
fs.mkdirSync(tempAppData, { recursive: true });
process.env.APPDATA = tempAppData;
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const takeoffLogbook = require(resolveBackendRuntimeFile('takeoff', 'takeoff-logbook.js'));
const { extractRecordedTakeoff } = require(resolveBackendRuntimeFile('takeoff', 'takeoff-record.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}\n${error.stack || error.message}`); failed++; }
}
function legacyEntry(id, overrides = {}) {
  return {
    id, timestamp: '2023-11-18T09:33:52.200Z', timestampMs: 1_700_300_032_200,
    aircraft: 'PMDG 737-800', icao: 'YSCB', runway: '35', runwayUseGrade: 'Good',
    rollDistanceFt: 3800, runwayUsedPct: 67, runwayRemainingFt: 2000,
    assessment: 'normal', flags: [], recording: { bundleName: 'bundle-a' }, ...overrides,
  };
}
function seed(entries) {
  fs.mkdirSync(path.dirname(takeoffLogbook.TAKEOFF_LOG_FILE), { recursive: true });
  fs.writeFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, JSON.stringify({ version: 1, entries }));
}

test('absent legacy history stays absent and empty', () => {
  assert.deepEqual(takeoffLogbook.getEntries(), []);
  assert.equal(takeoffLogbook.deleteEntriesByIds(['missing']), 0);
  assert.equal(fs.existsSync(takeoffLogbook.TAKEOFF_LOG_FILE), false);
});
test('old JSON-only entries remain readable without inventing rule provenance', () => {
  const entry = legacyEntry('original-random-id');
  seed([entry]);
  assert.deepEqual(takeoffLogbook.getEntries(), [entry]);
  assert.equal(takeoffLogbook.getEntries()[0].analysis, undefined);
  assert.equal(path.basename(takeoffLogbook.TAKEOFF_LOG_FILE), 'takeoff-log.json');
});
test('retirement removes only explicitly matched IDs and preserves unmatched history', () => {
  const unmatched = legacyEntry('unmatched', { icao: 'YSSY', recording: { bundleName: 'missing-recording' } });
  seed([legacyEntry('recoverable'), unmatched, legacyEntry('also-unmatched')]);
  assert.equal(takeoffLogbook.deleteEntriesByIds(['recoverable', 'not-present']), 1);
  assert.deepEqual(takeoffLogbook.getEntries().map((entry) => entry.id), ['unmatched', 'also-unmatched']);
  assert.deepEqual(JSON.parse(fs.readFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, 'utf8')).entries[0], unmatched);
  const unchanged = fs.readFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, 'utf8');
  assert.equal(takeoffLogbook.deleteEntriesByIds(['recoverable']), 0);
  assert.equal(takeoffLogbook.deleteEntriesByIds([]), 0);
  assert.equal(fs.readFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, 'utf8'), unchanged);
});
test('explicit bundle deletion prunes matching legacy entries only', () => {
  seed([legacyEntry('a'), legacyEntry('b', { recording: { bundleName: 'bundle-b' } }), legacyEntry('no-recording', { recording: {} })]);
  assert.equal(takeoffLogbook.deleteEntriesForBundle(null), 0);
  assert.equal(takeoffLogbook.deleteEntriesForBundle('missing'), 0);
  assert.equal(takeoffLogbook.deleteEntriesForBundle('bundle-a'), 1);
  assert.deepEqual(takeoffLogbook.getEntries().map((entry) => entry.id), ['b', 'no-recording']);
});
test('bundle deletion cannot remove a different recording that happens to share a legacy ID', () => {
  const otherRecording = legacyEntry('shared-id', { recording: { bundleName: 'bundle-b' }, rollDistanceFt: 1234 });
  seed([legacyEntry('shared-id'), otherRecording]);
  assert.equal(takeoffLogbook.deleteEntriesForBundle('bundle-a'), 1);
  assert.deepEqual(takeoffLogbook.getEntries(), [otherRecording]);
});
test('corrupt legacy bytes are preserved and cannot block recording-backed entries', () => {
  const damaged = '{"entries": "broken"}';
  fs.writeFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, damaged);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.deepEqual(takeoffLogbook.getEntries(), []);
    assert.deepEqual(takeoffLogbook.getEntries(), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /preserved/);
    assert.equal(takeoffLogbook.deleteEntriesByIds(['anything']), 0);
    assert.equal(takeoffLogbook.deleteEntriesForBundle('bundle-a'), 0);
    assert.equal(fs.readFileSync(takeoffLogbook.TAKEOFF_LOG_FILE, 'utf8'), damaged);
    assert(extractRecordedTakeoff({ timestamp_ms: 1_700_300_032_200, takeoff_runway_use_grade: 'Recorded' }),
      'valid recorded takeoffs remain projectable independently of the legacy file');
  } finally { console.warn = originalWarn; }
});
test('cached reads notice outside edits and do not expose the cached array', () => {
  seed([legacyEntry('cached')]);
  const first = takeoffLogbook.getEntries();
  first.push({ id: 'caller-only' });
  assert.equal(takeoffLogbook.getEntries().length, 1);
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]) === takeoffLogbook.TAKEOFF_LOG_FILE) reads++;
    return originalRead(...args);
  };
  try {
    takeoffLogbook.getEntries();
    takeoffLogbook.getEntries();
    assert.equal(reads, 0, 'unchanged files are not reparsed on every refresh');
    seed([legacyEntry('outside-one'), legacyEntry('outside-two')]);
    assert.equal(takeoffLogbook.getEntries().length, 2);
    assert.equal(reads, 1, 'an outside size change refreshes cached entries');
  } finally { fs.readFileSync = originalRead; }
});
test('shared statistics include recorded cautions without requiring legacy numerical grades', () => {
  const recorded = extractRecordedTakeoff({
    timestamp_ms: 1_700_400_000_000, aircraft: 'PMDG 737-800', icao: 'YSSY',
    takeoff_runway_use_grade: 'Recorded', takeoff_roll_distance_ft: 5400,
    takeoff_runway_used_pct: 95, takeoff_runway_remaining_ft: 300, takeoff_assessment: 'normal',
    takeoff_analysis: { flags: [{ code: 'heading_deviation', label: 'Runway-heading deviation', severity: 'warning' }] },
  });
  assert(recorded);
  assert.deepEqual(takeoffLogbook.computeStatsFromEntries([legacyEntry('old'), recorded]), {
    total: 2, grades: { Good: 1, Recorded: 1 }, cautionCount: 1,
    avgRollDistanceFt: 4600, avgRunwayUsedPct: 81, minRunwayRemainingFt: 300, airports: 2, aircraft: 1,
  });
  assert.deepEqual(takeoffLogbook.computeStatsFromEntries([]), {
    total: 0, grades: {}, cautionCount: 0, avgRollDistanceFt: null, avgRunwayUsedPct: null,
    minRunwayRemainingFt: null, airports: 0, aircraft: 0,
  });
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
