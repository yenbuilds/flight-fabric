#!/usr/bin/env node
/**
 * SimConnect SimVar Unit Validator
 * 
 * Validates that simconnect-telemetry-provider.js SimVar definitions match
 * the verified manifest (simvar-manifest.json).
 * 
 * This catches:
 * 1. New SimVars added without manifest entry (unverified units)
 * 2. Unit mismatches between code and manifest
 * 3. SimVars in manifest but missing from code (stale entries)
 * 
 * Run: node scripts/validate-simvar-units.js
 * Regression: wired into the main npm test suite.
 */

const fs = require('fs');
const path = require('path');
const { resolveRepoSourcePath } = require('./backend-source-paths');

// Paths
const PROVIDER_PATH = resolveRepoSourcePath('backend/telemetry-provider/simconnect-telemetry-provider.js');
const MANIFEST_PATH = path.join(__dirname, '../backend/telemetry-provider/simvar-manifest.json');

// ANSI colors
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function log(color, prefix, msg) {
  console.log(`${color}${prefix}${RESET} ${msg}`);
}

/**
 * Parse SimVar definitions from simconnect-telemetry-provider.js
 * Extracts: { simvar: 'NAME', unit: 'unit' }
 */
function parseProviderSimVars(code) {
  const simvars = [];
  
  // Match the required prefix while allowing additional definition metadata
  // (for example `isolated: true`) after the unit field. Also handles indexed
  // SimVars like 'ENG EXHAUST GAS TEMPERATURE:1'.
  const regex = /{\s*name:\s*'[^']+',\s*simvar:\s*'([^']+)',\s*unit:\s*'([^']+)'(?=\s*[,}])/g;
  
  let match;
  while ((match = regex.exec(code)) !== null) {
    const simvarName = match[1].replace(/:\d+$/, ''); // Remove index suffix
    simvars.push({
      simvar: simvarName,
      unit: match[2],
      raw: match[0],
    });
  }
  
  return simvars;
}

/**
 * Load and parse the manifest
 */
function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const content = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Normalize unit strings for comparison
 */
function normalizeUnit(unit) {
  return unit
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/feet \( ft \)/g, 'feet')
    .replace(/knots?/g, 'knots')
    .replace(/kias/g, 'knots') // SimConnect reports KIAS values in knots.
    .trim();
}

/**
 * Main validation
 */
function validate() {
  console.log('\n' + '═'.repeat(60));
  console.log('  SIMCONNECT SIMVAR UNIT VALIDATION');
  console.log('═'.repeat(60) + '\n');

  // Load provider code
  if (!fs.existsSync(PROVIDER_PATH)) {
    log(RED, '✗', `Provider file not found: ${PROVIDER_PATH}`);
    process.exit(1);
  }
  const providerCode = fs.readFileSync(PROVIDER_PATH, 'utf8');
  const codeSimVars = parseProviderSimVars(providerCode);
  
  log(CYAN, 'ℹ', `Found ${codeSimVars.length} SimVar definitions in provider`);

  // Load manifest
  const manifest = loadManifest(MANIFEST_PATH);
  if (!manifest) {
    log(RED, '✗', `Manifest not found: ${MANIFEST_PATH}`);
    log(YELLOW, '!', 'Create manifest with verified SDK units for each SimVar');
    process.exit(1);
  }
  
  const manifestSimVars = Array.isArray(manifest.simvars) ? manifest.simvars : [];
  log(CYAN, 'ℹ', `Found ${manifestSimVars.length} SimVars in manifest`);
  log(CYAN, 'ℹ', `Manifest last verified: ${manifest._lastVerified || 'unknown'}`);
  console.log('');

  let errors = 0;
  let warnings = 0;

  // Build lookup maps
  const manifestByName = new Map();
  for (const entry of manifestSimVars) {
    manifestByName.set(entry.name, entry);
  }

  const codeByName = new Map();
  for (const entry of codeSimVars) {
    // Store first occurrence (some SimVars have multiple engines)
    if (!codeByName.has(entry.simvar)) {
      codeByName.set(entry.simvar, entry);
    }
  }

  // Check 0: Basic manifest shape
  console.log('0. Checking manifest shape...');
  const validConversions = new Set(['none', 'simconnect', 'manual']);
  const seenManifestNames = new Set();
  let manifestShapeErrors = 0;
  if (!Array.isArray(manifest.simvars)) {
    log(RED, '✗', 'Manifest "simvars" must be an array');
    manifestShapeErrors++;
  }
  for (const [index, entry] of manifestSimVars.entries()) {
    const label = typeof entry?.name === 'string' && entry.name.trim() ? entry.name : `entry #${index + 1}`;
    for (const field of ['name', 'sdkNativeUnit', 'ourRequestedUnit', 'conversion']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) {
        log(RED, '✗', `${label}: missing required string field "${field}"`);
        manifestShapeErrors++;
      }
    }
    if (typeof entry?.conversion === 'string' && !validConversions.has(entry.conversion)) {
      log(RED, '✗', `${label}: invalid conversion "${entry.conversion}"`);
      manifestShapeErrors++;
    }
    if (typeof entry?.name === 'string' && entry.name.trim()) {
      if (seenManifestNames.has(entry.name)) {
        log(RED, '✗', `${entry.name}: duplicate manifest entry`);
        manifestShapeErrors++;
      }
      seenManifestNames.add(entry.name);
    }
  }
  if (manifestShapeErrors > 0) {
    errors += manifestShapeErrors;
  } else {
    log(GREEN, '✓', 'Manifest shape is valid');
  }
  console.log('');

  // Check 1: SimVars in code but not in manifest (UNVERIFIED)
  console.log('1. Checking for unverified SimVars...');
  const unverified = [];
  for (const [simvar, entry] of codeByName) {
    if (!manifestByName.has(simvar)) {
      unverified.push(entry);
    }
  }
  
  if (unverified.length > 0) {
    log(YELLOW, '⚠', `${unverified.length} SimVars not in manifest (unverified units):`);
    for (const entry of unverified.slice(0, 10)) {
      console.log(`    - ${entry.simvar} (unit: ${entry.unit})`);
    }
    if (unverified.length > 10) {
      console.log(`    ... and ${unverified.length - 10} more`);
    }
    warnings += unverified.length;
  } else {
    log(GREEN, '✓', 'All SimVars are in manifest');
  }
  console.log('');

  // Check 2: Unit mismatches between code and manifest
  console.log('2. Checking for unit mismatches...');
  const mismatches = [];
  for (const [simvar, codeEntry] of codeByName) {
    const manifestEntry = manifestByName.get(simvar);
    if (!manifestEntry) continue;
    
    const codeUnit = normalizeUnit(codeEntry.unit);
    const manifestUnit = normalizeUnit(manifestEntry.ourRequestedUnit);
    
    if (codeUnit !== manifestUnit) {
      mismatches.push({
        simvar,
        codeUnit: codeEntry.unit,
        manifestUnit: manifestEntry.ourRequestedUnit,
        sdkNativeUnit: manifestEntry.sdkNativeUnit,
      });
    }
  }
  
  if (mismatches.length > 0) {
    log(RED, '✗', `${mismatches.length} unit mismatches found:`);
    for (const m of mismatches) {
      console.log(`    ${m.simvar}:`);
      console.log(`      Code requests: "${m.codeUnit}"`);
      console.log(`      Manifest says: "${m.manifestUnit}" (SDK native: ${m.sdkNativeUnit})`);
    }
    errors += mismatches.length;
  } else {
    log(GREEN, '✓', 'All verified SimVars have matching units');
  }
  console.log('');

  // Check 3: Stale manifest entries (in manifest but not in code)
  console.log('3. Checking for stale manifest entries...');
  const stale = [];
  for (const [simvar] of manifestByName) {
    if (!codeByName.has(simvar)) {
      stale.push(simvar);
    }
  }
  
  if (stale.length > 0) {
    log(YELLOW, '⚠', `${stale.length} manifest entries not found in code:`);
    for (const s of stale) {
      console.log(`    - ${s}`);
    }
    warnings += stale.length;
  } else {
    log(GREEN, '✓', 'No stale manifest entries');
  }
  console.log('');

  // Check 4: Manifest freshness
  console.log('4. Checking manifest freshness...');
  const lastVerified = manifest._lastVerified ? new Date(manifest._lastVerified) : null;
  if (lastVerified && !Number.isNaN(lastVerified.getTime())) {
    const rawDaysSince = Math.floor((Date.now() - lastVerified.getTime()) / (1000 * 60 * 60 * 24));
    const daysSince = Math.max(0, rawDaysSince);
    if (daysSince > 90) {
      log(YELLOW, '⚠', `Manifest last verified ${daysSince} days ago (recommend re-verification)`);
      warnings++;
    } else {
      log(GREEN, '✓', `Manifest verified ${daysSince} days ago`);
    }
  } else {
    log(YELLOW, '⚠', 'Manifest has no verification date');
    warnings++;
  }
  console.log('');

  // Summary
  console.log('═'.repeat(60));
  if (errors > 0) {
    log(RED, '✗', `FAILED: ${errors} error(s), ${warnings} warning(s)`);
    console.log('═'.repeat(60) + '\n');
    process.exit(1);
  } else if (warnings > 0) {
    log(YELLOW, '⚠', `FAILED with ${warnings} warning(s)`);
    console.log('');
    console.log('To fix warnings:');
    console.log('1. Add unverified SimVars to simvar-manifest.json');
    console.log('2. Verify units against MSFS SDK documentation');
    console.log('3. Update _lastVerified date after verification');
    console.log('═'.repeat(60) + '\n');
    process.exit(1);
  } else {
    log(GREEN, '✓', 'All checks passed!');
    console.log('═'.repeat(60) + '\n');
    process.exit(0);
  }
}

// Run
validate();
