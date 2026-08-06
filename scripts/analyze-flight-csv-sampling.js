#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { resolveFlightLogsDir } = require(resolveBackendRuntimeFile('utils', 'flight-logs-dir.js'));

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out;
}

function listRecentLogs(limit = 10) {
  const logDir = resolveFlightLogsDir();
  if (!fs.existsSync(logDir)) return [];

  return fs
    .readdirSync(logDir)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .map((name) => {
      const fullPath = path.join(logDir, name);
      const stat = fs.statSync(fullPath);
      return {
        filePath: fullPath,
        name,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

function topEntries(counter, limit = 8) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function increment(counter, key) {
  const normalized = (key ?? '').trim() || '(empty)';
  counter[normalized] = (counter[normalized] || 0) + 1;
}

function analyzeCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error(`CSV has no data rows: ${filePath}`);
  }

  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);

  const iType = idx('record_type');
  const iRate = idx('sample_rate_hz');
  const iPhase = idx('phase');
  const iEsc = idx('escalation_reason');
  const iMono = idx('timestamp_monotonic');

  if (iType < 0 || iRate < 0 || iPhase < 0 || iEsc < 0 || iMono < 0) {
    throw new Error(`CSV missing required columns: ${filePath}`);
  }

  let totalRows = 0;
  let sampleRows = 0;
  let eventRows = 0;

  const rateCounts = {};
  const phaseCounts = {};
  const escalationCounts = {};

  const monotonic = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    totalRows++;

    const recordType = (cols[iType] || 'SAMPLE').trim();
    if (recordType !== 'SAMPLE' && recordType !== '') {
      eventRows++;
      continue;
    }

    sampleRows++;
    increment(rateCounts, cols[iRate]);
    increment(phaseCounts, cols[iPhase]);
    increment(escalationCounts, cols[iEsc]);

    const mono = Number((cols[iMono] || '').trim());
    if (Number.isFinite(mono)) {
      monotonic.push(mono);
    }
  }

  let avgDtMs = null;
  if (monotonic.length >= 2) {
    let sum = 0;
    let count = 0;
    for (let i = 1; i < monotonic.length; i++) {
      const delta = monotonic[i] - monotonic[i - 1];
      if (delta >= 0) {
        sum += delta;
        count++;
      }
    }
    if (count > 0) {
      avgDtMs = sum / count;
    }
  }

  const estHz = avgDtMs && avgDtMs > 0 ? 1000 / avgDtMs : null;

  return {
    filePath,
    totalRows,
    sampleRows,
    eventRows,
    avgSampleDtMs: avgDtMs,
    estSampleHz: estHz,
    topSampleRates: topEntries(rateCounts),
    topPhases: topEntries(phaseCounts),
    topEscalations: topEntries(escalationCounts),
  };
}

function formatOne(result) {
  const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a');
  const lines = [];
  lines.push(`File: ${result.filePath}`);
  lines.push(`Rows: total=${result.totalRows}, sample=${result.sampleRows}, events=${result.eventRows}`);
  lines.push(`Cadence: avgDt=${fmt(result.avgSampleDtMs)} ms, estHz=${fmt(result.estSampleHz)}`);

  lines.push('Top sample_rate_hz:');
  for (const item of result.topSampleRates) {
    lines.push(`  - ${item.name}: ${item.count}`);
  }

  lines.push('Top phases:');
  for (const item of result.topPhases) {
    lines.push(`  - ${item.name}: ${item.count}`);
  }

  lines.push('Top escalations:');
  for (const item of result.topEscalations) {
    lines.push(`  - ${item.name}: ${item.count}`);
  }

  return lines.join('\n');
}

function main() {
  const arg = process.argv[2];
  let files = [];

  if (arg) {
    const resolved = path.resolve(arg);
    if (!fs.existsSync(resolved)) {
      console.error(`Not found: ${resolved}`);
      process.exit(1);
    }
    files = [{ filePath: resolved }];
  } else {
    files = listRecentLogs(3);
    if (files.length === 0) {
      console.error(`No CSV files found in ${resolveFlightLogsDir()}`);
      process.exit(1);
    }
  }

  for (let i = 0; i < files.length; i++) {
    const result = analyzeCsv(files[i].filePath);
    console.log(formatOne(result));
    if (i < files.length - 1) console.log('\n---\n');
  }
}

main();
