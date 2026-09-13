const fs = require('node:fs') as typeof import('node:fs');
import path = require('node:path');
import { buildReport, profileKey } from './inventory';

// Read the installed runtime's definitions; volunteers do not need build tools.
// The CLI invokes this same function in its isolated report worker.
export function loadRuntimeReport(value: string) {
  const loader = require('../aircraft-profile-loader');
  const { defaultAircraftIntegrationRegistry: registry } = require('../aircraft-integrations');
  const { buildAircraftControlCapabilities } = require('../aircraft-control-service');
  const key = profileKey(value);
  const profile = loader.loadProfile(key);
  if (!profile || profile._profileKey !== key) throw new Error(`Bundled profile not found: ${key}`);
  const sourceProfiles = [];
  const seen = new Set();
  let nextKey = key;
  while (nextKey) {
    nextKey = profileKey(nextKey);
    if (seen.has(nextKey)) throw new Error('Profile inheritance cycle.');
    seen.add(nextKey);
    const file = path.join(loader.BUILTIN_ROOT_DIR, `${nextKey}.json`);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid bundled profile file.');
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

export function listSupportProfiles() {
  const loader = require('../aircraft-profile-loader');
  return loader.listProfiles().map(entry => ({
    profileKey: `bundled/${entry.simulator}/${entry.id}`, name: entry.name,
  })).sort((a, b) => a.name.localeCompare(b.name));
}
