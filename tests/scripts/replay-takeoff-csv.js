#!/usr/bin/env node
'use strict';

// Optional, read-only replay of local recordings through the production runner.
// Usage: node tests/scripts/replay-takeoff-csv.js <csv-or-recordings-directory> [...]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

function number(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function boolean(value) {
  if (value === true || value === '1' || value === 1) return true;
  if (value === false || value === '0' || value === 0) return false;
  return null;
}

function takeoffFrameFromCsv(row) {
  const flapsPercent = number(row.flaps_pct);
  return {
    wow: boolean(row.on_ground), paused: boolean(row.sim_paused), inMenu: boolean(row.sim_in_menu),
    alt_msl: number(row.alt_msl_ft), lat: number(row.lat_deg), lon: number(row.lon_deg),
    display: { iasKts: number(row.ias_kts), gsKts: number(row.gs_kts), raFt: number(row.ra_ft) },
    simconnect: {
      lat: number(row.lat_deg), lon: number(row.lon_deg),
      hdgTrueDeg: number(row.hdg_true_deg), hdgMagDeg: number(row.hdg_mag_deg), magvarDeg: number(row.magvar_deg),
    },
    attitudeDebug: { pitchDegPrimary: number(row.pitch_deg), bankDegPrimary: number(row.bank_deg) },
    surface: {
      valid: boolean(row.surface_valid), onGround: boolean(row.surface_on_ground),
      onRunway: boolean(row.surface_on_runway), runwayLike: boolean(row.surface_runway_like),
      raw: number(row.surface_raw), name: row.surface_name, class: row.surface_class,
    },
    assists: { slewActive: boolean(row.assist_slew_active) },
    // CSV records percent, not the provider's normalized handle fraction. A
    // recorded notch is not a raw FLAPS HANDLE INDEX and cannot replace it.
    flaps: flapsPercent == null ? null : flapsPercent / 100,
    windSpeed: number(row.wind_speed_kts), windDir: number(row.wind_dir_deg),
  };
}

function replayTakeoffRows(rows, { createRunner, context = {} } = {}) {
  const { createTakeoffRunner } = require(resolveBackendRuntimeFile('takeoff', 'takeoff-runner.js'));
  const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));
  const runner = (createRunner || createTakeoffRunner)();
  const messages = [], finals = [], edges = [];
  let previousWow = null;
  const onFinal = (payload) => finals.push(payload);
  eventBus.on('takeoff:final', onFinal);
  try {
    for (const row of rows) {
      if (row.record_type && row.record_type !== 'SAMPLE') continue;
      const nowEpochMs = number(row.ts) ?? (row.timestamp_utc ? Date.parse(row.timestamp_utc) : null);
      if (nowEpochMs == null || !Number.isFinite(nowEpochMs)) continue;
      const frame = takeoffFrameFromCsv(row);
      if (previousWow === true && frame.wow === false) edges.push({ timestampMs: nowEpochMs, gsKts: frame.display.gsKts });
      previousWow = frame.wow;
      runner.update(frame, (message) => messages.push(message), {
        nowEpochMs, nowIso: new Date(nowEpochMs).toISOString(),
        flightStartIso: row.flight_start_iso || '',
        flightStartEpochMs: row.flight_start_iso ? Date.parse(row.flight_start_iso) : null,
      }, {
        aircraftName: row.aircraft, aircraftProfileId: row.aircraft_profile_id || 'generic', phase: row.phase,
        dataSource: row.data_source, simulator: row.data_source === 'xplane' ? 'xplane' : 'msfs', ...context,
      });
    }
  } finally {
    eventBus.off('takeoff:final', onFinal);
  }
  return { edges, messages, finals, pending: runner.isPending() };
}

function csvPaths(input) {
  const stat = fs.lstatSync(input);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return /\.csv$/i.test(input) ? [input] : [];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(input).sort().flatMap((name) => csvPaths(path.join(input, name)));
}

async function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) throw new Error('Supply a CSV file or recordings directory.');
  const { parseCSV } = require(resolveBackendRuntimeFile('events', 'timeline-csv-helpers.js'));
  let files = 0, failed = 0, edgeCount = 0, finalCount = 0;
  const recordings = [...new Set(inputs.flatMap((input) => csvPaths(path.resolve(input))))];
  if (!recordings.length) throw new Error('No CSV recordings found.');
  for (const file of recordings) {
    // The production parser has a process memory ceiling. Give each recording
    // its own process so a large batch cannot retain earlier parsed row heaps.
    if (recordings.length > 1) {
      const child = spawnSync(process.execPath, [__filename, file], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      let summary = null;
      for (const line of String(child.stdout || '').split(/\r?\n/).filter(Boolean)) {
        try { summary = JSON.parse(line).summary || summary; } catch { /* runner diagnostic */ }
        if (!line.startsWith('{"summary":')) console.log(line);
      }
      if (child.stderr) process.stderr.write(child.stderr);
      files += summary?.files ?? 1;
      failed += summary?.failed ?? 1;
      edgeCount += summary?.edges ?? 0;
      finalCount += summary?.finals ?? 0;
      if (!summary) console.log(JSON.stringify({ file, error: child.error?.message || `Replay exited ${child.status}` }));
      continue;
    }
    const parsed = await parseCSV(file, { sparseRows: true });
    files += 1;
    if (parsed.error) {
      failed += 1;
      console.log(JSON.stringify({ file, error: parsed.error }));
      continue;
    }
    const replay = replayTakeoffRows(parsed.rows);
    edgeCount += replay.edges.length;
    finalCount += replay.finals.length;
    console.log(JSON.stringify({ file, samples: parsed.rows.filter((row) => row.record_type === 'SAMPLE').length,
      edges: replay.edges, pending: replay.pending,
      results: replay.finals.map((result) => ({
        timestampMs: result.takeoff_liftoff_timestamp_ms, rollDistanceFt: result.takeoff_roll_distance_ft,
        rollDurationS: result.takeoff_roll_duration_s, startSource: result.takeoff_roll_start_source,
        grade: result.takeoff_runway_use_grade, geometrySource: result.runway_geometry_source,
        screen: result.takeoff_analysis?.screenHeight, flags: result.takeoff_analysis?.flags,
      })),
    }));
  }
  console.log(JSON.stringify({ summary: { files, failed, edges: edgeCount, finals: finalCount } }));
  process.exitCode = failed ? 1 : 0;
}

module.exports = { takeoffFrameFromCsv, replayTakeoffRows };
if (require.main === module) main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
