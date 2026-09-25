#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { selectSimConnectDllSource } = require('../electron/build-electron');
const {
  SIMCONNECT_DLL_RELATIVE,
  verifyLatestSimConnectRuntime,
  assertSimConnectDllMatches,
} = require('./simconnect-sdk');

async function main(argv) {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--packaged-backend'
    || !argv[1] || argv[1].startsWith('--'))) {
    throw new Error('Usage: node scripts/verify-simconnect-sdk.js [--packaged-backend <directory>]');
  }
  const source = selectSimConnectDllSource();
  const sdk = await verifyLatestSimConnectRuntime({ dllPath: source?.path });
  if (argv.length) {
    assertSimConnectDllMatches(path.join(path.resolve(argv[1]), SIMCONNECT_DLL_RELATIVE), sdk);
  }
  console.log(`SimConnect.dll matches latest MSFS 2024 retail SDK ${sdk.version} (SHA-256 ${sdk.sha256}).`);
  console.log(`Verified build source: ${source.path}`);
  if (argv.length) console.log(`Verified packaged backend: ${path.resolve(argv[1])}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`[simconnect-sdk] ${err.message}`);
    process.exitCode = 1;
  });
}
