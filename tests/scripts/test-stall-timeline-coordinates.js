#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { getRepoScratchAppData } = require('./repo-scratch');

const tempAppData = getRepoScratchAppData('stall-timeline-appdata');
fs.mkdirSync(tempAppData, { recursive: true });
process.env.APPDATA = tempAppData;

const timelineGenerator = require(resolveBackendRuntimeFile('events', 'timeline-generator.js'));

const TEST_NAME = 'stall timeline coordinate fallback';

function writeFixtureCsv(filePath) {
  const headers = [
    'flight_id',
    'timestamp_utc',
    'ts',
    'flight_elapsed_ms',
    'record_type',
    'phase',
    'lat_deg',
    'lon_deg',
    'ra_ft',
    'on_ground',
    'ias_kts',
    'vs_fpm',
    'hdg_true_deg',
    'aircraft',
    'warning_duration_ms'
  ];

  const baseTs = 1700000000000;
  const rows = [
    [
      'test-flight',
      new Date(baseTs).toISOString(),
      baseTs,
      0,
      'SAMPLE',
      'APPROACH',
      37.6188056,
      -122.3754167,
      800,
      'false',
      140,
      -700,
      280,
      'A320',
      ''
    ],
    [
      'test-flight',
      new Date(baseTs + 1000).toISOString(),
      baseTs + 1000,
      1000,
      'STALL',
      'STALL',
      0,
      0,
      750,
      'false',
      95,
      -900,
      280,
      'A320',
      ''
    ],
    [
      'test-flight',
      new Date(baseTs + 2000).toISOString(),
      baseTs + 2000,
      2000,
      'STALL_END',
      'STALL_END',
      0,
      0,
      700,
      'false',
      110,
      -800,
      280,
      'A320',
      1000
    ],
    [
      'test-flight',
      new Date(baseTs + 3000).toISOString(),
      baseTs + 3000,
      3000,
      'SAMPLE',
      'APPROACH',
      37.6192,
      -122.3749,
      650,
      'false',
      130,
      -650,
      280,
      'A320',
      ''
    ]
  ];

  const csv = [headers.join(',')]
    .concat(rows.map((row) => row.join(',')))
    .join('\n');

  fs.writeFileSync(filePath, csv, 'utf8');
}

function findEvent(events, predicate) {
  return events.find(predicate);
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stall-coords-'));
  const csvPath = path.join(tmpDir, 'stall-coords.csv');

  try {
    writeFixtureCsv(csvPath);

    const result = await timelineGenerator.generateFromCSV(csvPath);
    assert.strictEqual(result.success, true, 'timeline generation should succeed');

    const events = result.timeline.events;

    const stallStart = findEvent(events, (event) => event.type === 'violation_start' && event.ruleId === 'STALL');
    const stallEnd = findEvent(events, (event) => event.type === 'violation_end' && event.ruleId === 'STALL');

    assert.ok(stallStart, 'STALL start event should exist');
    assert.ok(stallEnd, 'STALL end event should exist');

    assert.notStrictEqual(stallStart.lat, 0, 'STALL start latitude must not be 0');
    assert.notStrictEqual(stallStart.lon, 0, 'STALL start longitude must not be 0');
    assert.notStrictEqual(stallEnd.lat, 0, 'STALL end latitude must not be 0');
    assert.notStrictEqual(stallEnd.lon, 0, 'STALL end longitude must not be 0');

    assert.ok(Number.isFinite(stallStart.lat), 'STALL start latitude should be numeric');
    assert.ok(Number.isFinite(stallStart.lon), 'STALL start longitude should be numeric');
    assert.ok(Number.isFinite(stallEnd.lat), 'STALL end latitude should be numeric');
    assert.ok(Number.isFinite(stallEnd.lon), 'STALL end longitude should be numeric');

    console.log(`✅ ${TEST_NAME} passed`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch(err => { console.error(err); process.exit(1); });
