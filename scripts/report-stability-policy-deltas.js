#!/usr/bin/env node
'use strict';

// Read-only migration report. It compares the stability score persisted by an
// older build with a reconstruction under the current policy. Recordings with
// no persisted score are skipped because there is no trustworthy baseline.

const fs = require('node:fs');
const path = require('node:path');
const { resolveBackendRuntimeFile } = require('../tests/scripts/backend-runtime-paths');
const timelineGenerator = require(resolveBackendRuntimeFile('events', 'timeline-generator.js'));

const root = path.resolve(process.argv[2] || path.join(
  process.env.USERPROFILE || process.cwd(),
  'Documents',
  'Flight Fabric',
  'Flight Logs',
));

function listCsvFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listCsvFiles(target));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) result.push(target);
  }
  return result;
}

function withoutPersistedStability(rows) {
  return rows.map((row) => {
    const copy = { ...row };
    for (const key of Object.keys(copy)) {
      if (key.startsWith('ultimate_stability_')) copy[key] = null;
    }
    return copy;
  });
}

function landingRows(rows) {
  return rows.filter(row => String(row?.record_type || '').trim().toUpperCase() === 'LANDING');
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function main() {
  const deltas = [];
  let recordings = 0;
  let skippedWithoutBaseline = 0;
  let failed = 0;

  for (const csvPath of listCsvFiles(root)) {
    const parsed = await timelineGenerator.parseCSV(csvPath);
    if (parsed.error || !Array.isArray(parsed.rows)) {
      failed++;
      continue;
    }
    const rows = parsed.rows.filter(row => String(row?.record_type || '').trim().toUpperCase() !== 'RECORDING_MANIFEST');
    const persisted = landingRows(rows)
      .map(row => finiteNumber(row.ultimate_stability_score))
      .filter(value => value !== null);
    if (persisted.length === 0) {
      skippedWithoutBaseline++;
      continue;
    }

    const generated = timelineGenerator._generateTimelineFromRows(csvPath, withoutPersistedStability(rows), {
      includeAutomation: false,
    });
    if (!generated?.success) {
      failed++;
      continue;
    }
    recordings++;
    const reconstructed = generated.timeline.events
      .filter(event => event?.type === 'landing')
      .map(event => finiteNumber(event?.ultimateStability?.score));
    const count = Math.min(persisted.length, reconstructed.length);
    for (let index = 0; index < count; index++) {
      if (reconstructed[index] === null) continue;
      deltas.push({
        recording: path.basename(path.dirname(csvPath)),
        landing: index + 1,
        before: Math.round(persisted[index]),
        after: Math.round(reconstructed[index]),
        delta: Math.round(reconstructed[index] - persisted[index]),
      });
    }
  }

  const sorted = [...deltas].sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  const averageDelta = deltas.length
    ? deltas.reduce((sum, item) => sum + item.delta, 0) / deltas.length
    : 0;
  console.log(JSON.stringify({
    root,
    recordingsCompared: recordings,
    landingsCompared: deltas.length,
    skippedWithoutBaseline,
    failed,
    averageDelta: Math.round(averageDelta * 10) / 10,
    minDelta: deltas.length ? Math.min(...deltas.map(item => item.delta)) : null,
    maxDelta: deltas.length ? Math.max(...deltas.map(item => item.delta)) : null,
    largestChanges: sorted.slice(0, 20),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
