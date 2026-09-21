/** One JSONL file per autotaxi session, for offline debugging, controller replay and training data. */
import type { TaxiRecord } from './session.js';
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');

export type TaxiRecorderOptions = {
  /** Directory for the session files; created on the first row of a session. */
  dir: () => string;
  log?: (message: string) => void;
  /** Per-file cap; the session stops logging once it is reached. */
  maxFileBytes?: number;
};
const TAXI_LOG_SCHEMA_VERSION = 1;
// A 30-minute session at 4 Hz is roughly 10 MB; the cap only catches a runaway.
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

// File names are built only from these characters, so no row value can name a path.
const safeName = (value: string) => value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/** Rows arrive from the session in order; a session_start row opens a new file and every row is appended as it comes. */
export function createTaxiRecorder(options: TaxiRecorderOptions) {
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? Math.max(1, options.maxFileBytes!) : DEFAULT_MAX_FILE_BYTES;
  let file: string | null = null;
  let bytes = 0;
  let seq = 0;
  let failed = false;
  function stop(message: string) {
    failed = true;
    options.log?.(`[Autotaxi] ${message}; logging stops until the next session.`);
  }
  function open(row: Extract<TaxiRecord, { type: 'autotaxi_session_start' }>) {
    const dir = options.dir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(row.timeMs).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
    const destination = row.parking ? `stand-${safeName(row.parking)}` : `rwy-${safeName(row.runway || '')}`;
    file = path.join(dir, `${stamp}-${safeName(row.icao)}-${destination}.jsonl`);
    bytes = 0; seq = 0;
    // Same first-row shape as the flight-bundle sidecars: identity and schema version, seq 1.
    append({ type: 'autotaxi_manifest', timeMs: row.timeMs, schemaVersion: TAXI_LOG_SCHEMA_VERSION, sessionId: crypto.randomUUID(),
      icao: row.icao, runway: row.runway, parking: row.parking, profileKey: row.profileKey, profileRevision: row.profileRevision });
  }
  function append(row: { type: string; timeMs: number } & Record<string, unknown>) {
    const { type, timeMs, ...rest } = row;
    const line = JSON.stringify({ seq: ++seq, type, timeMs, timestampIso: new Date(timeMs).toISOString(), ...rest }) + '\n';
    bytes += Buffer.byteLength(line, 'utf8');
    if (bytes > maxFileBytes) { stop(`session log reached ${Math.round(maxFileBytes / 1024 / 1024)} MB`); return; }
    // Each row is one synchronous append, so a crash mid-session keeps every tick written so far.
    fs.appendFileSync(file!, line);
  }
  return {
    record(row: TaxiRecord) {
      try {
        if (row.type === 'autotaxi_session_start') { failed = false; open(row); }
        if (!file || failed) return;
        append(row);
        if (row.type === 'autotaxi_session_end') file = null;
      } catch (err) {
        stop(`session log write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    currentFile: () => file,
  };
}
