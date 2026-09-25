'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getRepoScratchPath } = require('./repo-scratch');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const baseline = require('../fixtures/csv-header-v0.10.0.json');
const { TAKEOFF_SCORING_ENABLED } = require('../../shared/app-settings-shared');
const takeoffColumns = [
  'takeoff_liftoff_timestamp_ms', 'takeoff_roll_distance_ft', 'takeoff_roll_duration_s', 'takeoff_roll_start_source',
  'takeoff_liftoff_distance_ft', 'takeoff_runway_remaining_ft', 'takeoff_runway_used_pct', 'takeoff_runway_use_score',
  'takeoff_runway_use_grade', 'takeoff_runway_use_zone', 'takeoff_screen_height_ft', 'takeoff_screen_height_distance_ft',
  'takeoff_screen_height_remaining_ft', 'takeoff_screen_height_elapsed_s', 'takeoff_rotation_rate_deg_s',
  'takeoff_max_pitch_deg', 'takeoff_max_lateral_offset_ft', 'takeoff_hop_count', 'takeoff_assessment',
  'takeoff_analysis', 'takeoff_final',
];
const expectedColumns = [...baseline.columns, ...(TAKEOFF_SCORING_ENABLED ? takeoffColumns : [])];

const scratch = getRepoScratchPath('recording-release-schema');
fs.mkdirSync(scratch, { recursive: true });
const outputDir = fs.mkdtempSync(path.join(scratch, 'recording-'));
// Isolate configuration/logbook paths before loading the writer. Recording output
// is also explicit so this check never opens the user's Flight Logs directory.
process.env.APPDATA = path.join(outputDir, 'app-data');
const writer = require(runtime('flight-recording', 'flight-csv-writer.js'));
const { parseCsvLine, splitCsvLines } = require(runtime('utils', 'csv.js'));

for (const [label, Writer] of [['inline', writer.FlightCSVWriter], ['worker', writer.WorkerFlightCSVWriter]]) {
  test(`${label} recording preserves the release CSV format for the takeoff gate`, async () => {
    assert.equal(TAKEOFF_SCORING_ENABLED, false);
    assert.equal(baseline.columns.length, 331);
    assert.deepEqual(writer.getV1Columns(), expectedColumns);
    const recording = new Writer({ flightId: `release-schema-${label}`, outputDir: path.join(outputDir, label), syncIntervalMs: 60000 });
    try {
      assert.equal(recording.start(), true);
      assert.equal(recording.writeSample({ ias: 140, wow: false, takeoff_final: true, takeoff_runway_use_score: 100 }), true);
      assert.equal(recording.writeEvent('LANDING', { vs_fpm: -180, grade: 'GOOD', takeoff_roll_distance_ft: 2500 }), true);
      if (TAKEOFF_SCORING_ENABLED) assert.equal(recording.writeEvent('TAKEOFF', { takeoff_final: true, takeoff_runway_use_score: 95, takeoff_assessment: 'caution',
        takeoff_analysis: { flags: [{ code: 'climb_incomplete', label: 'Climb-out incomplete', severity: 'caution' }] } }), true);
    } finally {
      const stats = await recording.close();
      const lines = splitCsvLines(fs.readFileSync(stats.filePath, 'utf8'), { trimAndDropEmpty: true });
      const header = parseCsvLine(lines[0]);
      assert.deepEqual(header, expectedColumns, 'on-disk columns follow the gate and retain the published prefix');
      const rows = lines.slice(1).map(line => parseCsvLine(line));
      assert.ok(rows.length >= 3, 'manifest, sample and landing rows were written');
      for (const row of rows) assert.equal(row.length, expectedColumns.length, 'every record matches the release header');
      const recordTypes = rows.map(row => row[header.indexOf('record_type')]);
      assert.ok(recordTypes.includes('SAMPLE'));
      assert.ok(recordTypes.includes('LANDING'));
      assert.equal(recordTypes.includes('TAKEOFF'), TAKEOFF_SCORING_ENABLED);
      if (TAKEOFF_SCORING_ENABLED) {
        const takeoff = rows.find(row => row[header.indexOf('record_type')] === 'TAKEOFF');
        assert.equal(takeoff[header.indexOf('takeoff_runway_use_score')], '95');
        assert.equal(JSON.parse(takeoff[header.indexOf('takeoff_analysis')]).flags[0].code, 'climb_incomplete');
      }
      const landing = rows.find(row => row[header.indexOf('record_type')] === 'LANDING');
      assert.equal(landing[header.indexOf('vs_fpm')], '-180.0');
    }
  });
}
