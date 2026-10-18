#!/usr/bin/env node
// Generate frontend/toolbar/voice-reference.json: the read-only voice
// question phrases the MSFS toolbar panel lists beside the live aircraft
// command catalogue.
//
// The desktop voice runtime owns these phrases (frontend/src/voice). The
// toolbar page runs in the simulator browser as plain script and cannot
// import those modules, so this file is generated from them and a test
// keeps it current:
//
//   node scripts/build-toolbar-voice-reference.mjs          # write
//   node scripts/build-toolbar-voice-reference.mjs --check  # verify

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { aircraftQueryFamily, stateQueryExamples } from '../frontend/src/voice/state-queries.js';
import { flightPlanQueryExamples } from '../frontend/src/voice/flight-plan-queries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadTypeScriptCommonJs } = require('./typescript-source-loader.js');
const DEFINITIONS_DIR = path.join(ROOT, 'backend', 'aircraft', 'aircraft-integrations');
const OUTPUT = path.join(ROOT, 'frontend', 'toolbar', 'voice-reference.json');

function bundledProfileKeys() {
  const { listBundledProfileSources } = loadTypeScriptCommonJs(path.join(ROOT, 'backend', 'aircraft', 'aircraft-profile-sources.ts'));
  return listBundledProfileSources(DEFINITIONS_DIR)
    .filter(({ simulator }) => simulator === 'msfs')
    .map(({ profileKey }) => profileKey)
    .sort();
}

export function buildVoiceReference() {
  const aircraftQueries = {};
  for (const profileKey of bundledProfileKeys()) {
    if (!aircraftQueryFamily(profileKey)) continue;
    const phrases = stateQueryExamples({ activeProfileKey: profileKey });
    if (phrases.length > 0) aircraftQueries[profileKey] = phrases;
  }
  return {
    generatedBy: 'scripts/build-toolbar-voice-reference.mjs',
    sources: [
      'frontend/src/voice/flight-plan-queries.js',
      'frontend/src/voice/state-queries.js',
    ],
    flightPlanQueries: flightPlanQueryExamples(),
    aircraftQueries,
  };
}

export function serializeVoiceReference(reference) {
  return `${JSON.stringify(reference, null, 2)}\n`;
}

function main(argv) {
  const text = serializeVoiceReference(buildVoiceReference());
  if (argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) {
      console.error(`[toolbar-voice-reference] ${path.relative(ROOT, OUTPUT)} is out of date. Run: node scripts/build-toolbar-voice-reference.mjs`);
      process.exit(1);
    }
    console.log('[toolbar-voice-reference] current');
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text);
  console.log(`[toolbar-voice-reference] wrote ${path.relative(ROOT, OUTPUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
