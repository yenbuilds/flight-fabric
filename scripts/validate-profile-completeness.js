#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

const { normalizeProfileDocument } = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-model.js'));

const PROFILES_DIR = path.resolve(__dirname, '../backend/aircraft/profiles/bundled');

const AIRLINER_PROFILE_PATTERNS = [
  /pmdg/i,
  /fbw/i,
  /flybywire/i,
  /fenix/i,
  /inibuilds/i,
  /ifly/i,
  /toliss/i,
  /leonardo/i,
  /majestic/i,
  /qualitywings/i,
  /blackbox/i,
];

const BASE_PROFILES = [
  'airbus-base',
  'boeing-base',
  'turboprop-base',
  'widebody-base',
  'regional-jet',
];

const REQUIRED_AIRLINER_CONFIG = {
  spoilers: {
    description: 'Spoilers telemetry configuration',
    validator: (config) => {
      if (!config) return 'Missing spoilers block';
      if (!config.scale && config.maxValue === undefined && !config.positions) {
        return 'Spoilers block missing scale or positions';
      }
      return null;
    },
  },
};

const OPTIONAL_AIRLINER_CONFIG = {
  flaps: {
    description: 'Source-backed flap configuration with notches',
    validator: (config) => {
      if (!config) return null;
      if (!Array.isArray(config.notches) || config.notches.length === 0) {
        return 'Flaps block missing notches array';
      }
      return null;
    },
  },
};

function listProfileFiles(rootDir) {
  const files = [];
  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(absolutePath);
      }
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir);
  return files;
}

function loadProfiles() {
  return listProfileFiles(PROFILES_DIR)
    .map((filePath) => {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const simulator = path.relative(PROFILES_DIR, filePath).split(path.sep)[0];
      const profile = normalizeProfileDocument(raw, {
        defaultNamespace: 'bundled',
        defaultSimulator: simulator,
      });
      profile._filePath = filePath;
      return profile;
    });
}

function isAirlinerProfile(profile) {
  if (['generic', 'ga-base', 'turboprop-base'].includes(profile.id)) return false;
  if (BASE_PROFILES.includes(profile.id)) return false;
  if (profile.abstract === true) return false;
  if (profile.simulator !== 'msfs') return false;

  for (const pattern of AIRLINER_PROFILE_PATTERNS) {
    if (pattern.test(profile.id) || pattern.test(profile.name || '')) {
      return true;
    }
  }

  if (profile.aircraft?.category === 'C' || profile.aircraft?.category === 'D') {
    return !profile.id?.includes('ga-');
  }

  return false;
}

function isBaseProfile(profile) {
  return BASE_PROFILES.includes(profile.id) || profile.abstract === true;
}

function getCompletenessView(profile) {
  return {
    spoilers: profile.integration?.telemetry?.spoilers || null,
    flaps: profile.aircraft?.flaps || null,
  };
}

function resolveInheritance(profile, allProfiles) {
  if (!profile.extends) return profile;
  const parent = allProfiles.find((candidate) => `${candidate.namespace}/${candidate.simulator}/${candidate.id}` === profile.extends);
  if (!parent) return profile;
  const resolvedParent = resolveInheritance(parent, allProfiles);
  return {
    ...resolvedParent,
    ...profile,
    aircraft: {
      ...(resolvedParent.aircraft || {}),
      ...(profile.aircraft || {}),
    },
    integration: {
      ...(resolvedParent.integration || {}),
      ...(profile.integration || {}),
      telemetry: {
        ...(resolvedParent.integration?.telemetry || {}),
        ...(profile.integration?.telemetry || {}),
      },
    },
  };
}

function validateProfile(profile, allProfiles) {
  const resolved = resolveInheritance(profile, allProfiles);
  const view = getCompletenessView(resolved);
  const issues = [];

  for (const [key, requirement] of Object.entries(REQUIRED_AIRLINER_CONFIG)) {
    const error = requirement.validator(view[key]);
    if (error) {
      issues.push({ field: key, error, description: requirement.description });
    }
  }

  for (const [key, requirement] of Object.entries(OPTIONAL_AIRLINER_CONFIG)) {
    const error = requirement.validator(view[key]);
    if (error) {
      issues.push({ field: key, error, description: requirement.description });
    }
  }

  return issues;
}

function main() {
  console.log('=== Aircraft Profile Completeness Check ===\n');
  console.log('Verifying all airliner profiles have required config blocks...\n');

  const allProfiles = loadProfiles();
  const baseProfiles = allProfiles.filter(isBaseProfile);
  const airlinerProfiles = allProfiles.filter(isAirlinerProfile);
  const failures = [];

  console.log('--- Base Profiles ---');
  for (const profile of baseProfiles) {
    const issues = validateProfile(profile, allProfiles);
    if (issues.length > 0) {
      console.log(`❌ ${profile.id}`);
      for (const issue of issues) {
        console.log(`   └─ ${issue.field}: ${issue.error}`);
      }
      failures.push({ profile: profile.id, issues, isBase: true });
    } else {
      console.log(`✅ ${profile.id}`);
    }
  }

  console.log('\n--- Airliner Profiles ---');
  for (const profile of airlinerProfiles) {
    const issues = validateProfile(profile, allProfiles);
    if (issues.length > 0) {
      console.log(`❌ ${profile.id}`);
      for (const issue of issues) {
        console.log(`   └─ ${issue.field}: ${issue.error}`);
      }
      failures.push({ profile: profile.id, issues, isBase: false });
    } else {
      console.log(`✅ ${profile.id}`);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Base profiles: ${baseProfiles.length}`);
  console.log(`Airliner profiles: ${airlinerProfiles.length}`);
  console.log(`Failures: ${failures.length}`);

  if (failures.length > 0) {
    console.log('\n❌ VALIDATION FAILED');
    console.log('\nMissing required config detected. Fix before release:');
    for (const failure of failures) {
      const prefix = failure.isBase ? '[BASE]' : '[AIRLINER]';
      console.log(`  ${prefix} ${failure.profile}: ${failure.issues.map((issue) => issue.field).join(', ')}`);
    }
    process.exit(1);
  }

  console.log('\n✅ All airliner profiles have required config');
}

main();
