'use strict';

const path = require('path');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => arg !== '--dry-run');
  const requestedRoot = positional[0];
  if (!requestedRoot) {
    throw new Error('Usage: node scripts/migrate-flat-flight-logs.js [--dry-run] <absolute Flight Logs directory>');
  }
  if (positional.length !== 1) throw new Error('Migration accepts exactly one Flight Logs directory');
  if (!path.isAbsolute(requestedRoot)) {
    throw new Error('Flight Logs migration requires an absolute directory path');
  }
  const migration = require('../dist/backend/flight-recording/flat-flight-log-migration.js');
  const result = dryRun
    ? migration.inspectFlatFlightLogs(requestedRoot)
    : await migration.migrateFlatFlightLogs(requestedRoot);
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
