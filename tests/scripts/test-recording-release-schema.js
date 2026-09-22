'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getRepoScratchPath } = require('./repo-scratch');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const baseline = require('../fixtures/csv-header-v0.10.0.json');
const { TAKEOFF_SCORING_ENABLED } = require('../../shared/app-settings-shared');

const scratch = getRepoScratchPath('recording-release-schema');
fs.mkdirSync(scratch, { recursive: true });
const outputDir = fs.mkdtempSync(path.join(scratch, 'recording-'));
// Isolate configuration/logbook paths before loading the writer. Recording output
// is also explicit so this check never opens the user's Flight Logs directory.
process.env.APPDATA = path.join(outputDir, 'app-data');
const writer = require(runtime('flight-recording', 'flight-csv-writer.js'));
const { parseCsvLine, splitCsvLines } = require(runtime('utils', 'csv.js'));

for (const [label, Writer] of [['inline', writer.FlightCSVWriter], ['worker', writer.WorkerFlightCSVWriter]]) {
  test(`${label} recording retains the exact 0.10.0 header and row width while takeoff scoring is disabled`, async () => {
    assert.equal(TAKEOFF_SCORING_ENABLED, false);
    assert.equal(baseline.columns.length, 331);
    assert.deepEqual(writer.getV1Columns(), baseline.columns);
    const recording = new Writer({ flightId: `release-schema-${label}`, outputDir: path.join(outputDir, label), syncIntervalMs: 60000 });
    try {
      assert.equal(recording.start(), true);
      assert.equal(recording.writeSample({ ias: 140, wow: false, takeoff_final: true, takeoff_runway_use_score: 100 }), true);
      assert.equal(recording.writeEvent('LANDING', { vs_fpm: -180, grade: 'GOOD', takeoff_roll_distance_ft: 2500 }), true);
    } finally {
      const stats = await recording.close();
      const lines = splitCsvLines(fs.readFileSync(stats.filePath, 'utf8'), { trimAndDropEmpty: true });
      const header = parseCsvLine(lines[0]);
      assert.deepEqual(header, baseline.columns, 'actual on-disk header matches the published schema, in order');
      const rows = lines.slice(1).map(line => parseCsvLine(line));
      assert.ok(rows.length >= 3, 'manifest, sample and landing rows were written');
      for (const row of rows) assert.equal(row.length, 331, 'every record has the published width');
      const recordTypes = rows.map(row => row[header.indexOf('record_type')]);
      assert.ok(recordTypes.includes('SAMPLE'));
      assert.ok(recordTypes.includes('LANDING'));
      assert.ok(!recordTypes.includes('TAKEOFF'));
      const landing = rows.find(row => row[header.indexOf('record_type')] === 'LANDING');
      assert.equal(landing[header.indexOf('vs_fpm')], '-180.0');
    }
  });
}
