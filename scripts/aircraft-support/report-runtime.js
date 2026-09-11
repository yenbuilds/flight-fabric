'use strict';

// Load executable backend definitions in a separate process: importing its
// config initializes/migrates settings, and its profile loader caches results.
// The parent supplies an isolated environment and consumes stdout as JSON.
const fs = require('node:fs');
const path = require('node:path');
const { profileKey, buildReport } = require('./inventory');
const { resolveBackendRuntimeFile: runtime } = require('../backend-runtime-paths');

function loadRuntimeReport(keyValue) {
  const key = profileKey(keyValue);
  const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
  const { defaultAircraftIntegrationRegistry: registry } = require(runtime('aircraft/aircraft-integrations/index.js'));
  const { buildAircraftControlCapabilities } = require(runtime('aircraft/aircraft-control-service.js'));
  const profile = loader.loadProfile(key);
  if (!profile || profile._profileKey !== key) throw new Error(`Bundled profile not found: ${key}`);
  const sourceProfiles = [];
  let nextKey = key;
  const seen = new Set();
  while (nextKey) {
    nextKey = profileKey(nextKey);
    if (seen.has(nextKey)) throw new Error('Profile inheritance cycle.');
    seen.add(nextKey);
    const file = path.join(__dirname, '../../backend/aircraft/profiles', `${nextKey}.json`);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Expected a profile JSON file no larger than 32 MB.');
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    sourceProfiles.push({ key: nextKey, document });
    nextKey = document.extends;
  }
  const integration = registry.resolveIntegration(profile.integration?.aircraftSpecific?.adapter, { profileKey: key });
  const capabilities = profile.simulator === 'msfs' ? {
    simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'simvar', 'lvar'],
    integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator', 'simbridge-mcdu'],
  } : { simulator: 'xplane', actionTypes: [], integrationTransports: [] };
  const catalogue = buildAircraftControlCapabilities(profile, { profileRevision: 0, capabilities }).aircraftCommands;
  return buildReport({ profile, integration, catalogue, sourceProfiles });
}

if (require.main === module) {
  // Backend startup notices must not corrupt the machine-readable result.
  console.log = console.error;
  console.info = console.error;
  try { process.stdout.write(JSON.stringify(loadRuntimeReport(process.argv[2]))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
