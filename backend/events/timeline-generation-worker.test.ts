'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const timelineGenerator = require('./timeline-generator') as {
  _generateFromCSVIsolated: (
    _csvPath: string,
    _options?: Record<string, any>,
  ) => Promise<{ success: boolean; error?: string }>;
};

test('isolated timeline worker returns a controlled failure without affecting the caller', async () => {
  const result = await timelineGenerator._generateFromCSVIsolated(
    path.join(__dirname, 'missing-timeline-worker-fixture.csv'),
  );
  assert.equal(result.success, false);
  assert.match(result.error || '', /CSV read failed|could not start|safe/i);
});

test('isolated timeline generation bounds concurrent work and its queue', async () => {
  const missingPath = path.join(__dirname, 'missing-concurrent-timeline-fixture.csv');
  const results = await Promise.all([
    timelineGenerator._generateFromCSVIsolated(missingPath),
    timelineGenerator._generateFromCSVIsolated(missingPath),
    timelineGenerator._generateFromCSVIsolated(missingPath),
  ]);

  assert.equal(results.filter((result) => /already busy/i.test(result.error || '')).length, 1);
  assert.equal(results.every((result) => result.success === false), true);
});

export {};
