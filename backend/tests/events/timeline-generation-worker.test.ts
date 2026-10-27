'use strict';
import type { RecordingReadResult } from '../../events/timeline-generator';
// Source-relative fixtures and runtime paths retain their original base after relocation.
const ORIGINAL_SOURCE_DIR = require('node:path').resolve(__dirname, '../../events');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const timelineGenerator = require('../../events/timeline-generator') as {
  _generateFromCSVIsolated: (
    _csvPath: string,
    _options?: Record<string, any>,
  ) => Promise<RecordingReadResult>;
  _generateFromCSVInProcess: (
    _csvPath: string,
    _options?: Record<string, any>,
  ) => Promise<RecordingReadResult>;
};

test('isolated timeline worker returns a controlled failure without affecting the caller', async () => {
  const result = await timelineGenerator._generateFromCSVIsolated(
    path.join(ORIGINAL_SOURCE_DIR, 'missing-timeline-worker-fixture.csv'),
  );
  assert.equal(result.success, false);
  assert.match('error' in result ? result.error : '', /CSV read failed|could not start|safe/i);
});

test('isolated timeline generation bounds concurrent work and its queue', async () => {
  const missingPath = path.join(ORIGINAL_SOURCE_DIR, 'missing-concurrent-timeline-fixture.csv');
  const results = await Promise.all([
    timelineGenerator._generateFromCSVIsolated(missingPath),
    timelineGenerator._generateFromCSVIsolated(missingPath),
    timelineGenerator._generateFromCSVIsolated(missingPath),
  ]);

  assert.equal(results.filter((result) => /already busy/i.test('error' in result ? result.error : '')).length, 1);
  assert.equal(results.every((result) => result.success === false), true);
});

test('worker replay matches in-process landing results in recorded and preview modes after failures', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-worker-replay-'));
  const csvPath = path.join(directory, 'worker-landing.csv');
  try {
    const startMs = 1700000000000;
    const headers = ['flight_id', 'ts', 'flight_elapsed_ms', 'record_type', 'phase',
      'lat_deg', 'lon_deg', 'ra_ft', 'alt_msl_ft', 'alt_plane_ft', 'on_ground',
      'ias_kts', 'gs_kts', 'vs_fpm', 'hdg_true_deg', 'g_force', 'aircraft'];
    // A 140 kt approach covers 4,726 ft while descending 240 ft in 20 seconds,
    // followed by twelve seconds of straight rollout. No runway is fabricated.
    let distanceFt = 0;
    const rows = Array.from({ length: 33 }, (_, second) => {
      const speed = second <= 20 ? 140 : 140 - (second - 20) * 8;
      if (second > 0) distanceFt += speed * 6076.12 / 3600;
      const heightFt = Math.max(0, 240 - second * 12);
      return ['worker-landing', startMs + second * 1000, second * 1000, 'SAMPLE',
        second < 20 ? 'FINAL' : 'LANDING', 37 + distanceFt / (60 * 6076.12), -122,
        heightFt, 700 + heightFt, 700 + heightFt, second >= 20,
        speed, speed, second <= 20 ? -720 : 0, 360, second === 20 ? 1.2 : 1, 'Generic aircraft'];
    });
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map(row => row.join(',')), ''].join('\n'));
    const modes = ['recorded', 'current-preview'];
    const direct = await Promise.all(modes.map(scoringMode =>
      timelineGenerator._generateFromCSVInProcess(csvPath, { scoringMode })));
    const isolated = await Promise.all(modes.map(scoringMode =>
      timelineGenerator._generateFromCSVIsolated(csvPath, { scoringMode })));
    for (let index = 0; index < modes.length; index++) {
      const expected = direct[index];
      const actual = isolated[index];
      assert.equal(expected.success, true);
      assert.equal(actual.success, true);
      if (!expected.success || !actual.success) continue;
      assert.equal(actual.timeline.events.filter(event => event.type === 'landing').length, 1);
      const comparable = (result: RecordingReadResult) => {
        assert.equal(result.success, true);
        return result.success ? {
          ...result, timeline: { ...result.timeline, generatedAt: null },
        } : result;
      };
      assert.deepEqual(comparable(actual), comparable(expected), modes[index]);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

export {};
