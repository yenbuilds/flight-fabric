#!/usr/bin/env node
/**
 * validate-env-completeness.js - Check local .env drift against config.ts.
 *
 * Usage: npm run env:validate
 *
 * This is a static check for local developer overrides. A .env file is optional:
 * packaged/user builds should work from config defaults and app settings without
 * requiring one.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'backend', 'core', 'config.ts');
const envPath = path.join(__dirname, '..', '.env');

const configSource = fs.readFileSync(configPath, 'utf8');
const envExists = fs.existsSync(envPath);
const envSource = envExists ? fs.readFileSync(envPath, 'utf8') : '';

const patterns = [
  /int\s*\(\s*['"]([A-Z_0-9]+)['"]\s*,/g,
  /bool\s*\(\s*['"]([A-Z_0-9]+)['"]\s*,/g,
  /str\s*\(\s*['"]([A-Z_0-9]+)['"]\s*,/g,
  /float\s*\(\s*['"]([A-Z_0-9]+)['"]\s*,/g,
  /intHex\s*\(\s*['"]([A-Z_0-9]+)['"]\s*,/g,
];

const configVars = new Set();
for (const pattern of patterns) {
  let match;
  while ((match = pattern.exec(configSource)) !== null) {
    configVars.add(match[1]);
  }
}

const envVars = new Set();
for (const line of envSource.split('\n')) {
  const match = line.match(/^#?\s*([A-Z_0-9]+)\s*=/);
  if (match) {
    envVars.add(match[1]);
  }
}

function isKnownExternal(varName) {
  const externals = [
    'DEBUG_WS_URL',
    'SIMBRIDGE_MOCK',
    'LANDING_ROLLOUT_WINDOW_MS',
    'LANDING_TOUCHDOWN_COOLDOWN_MS',
    'ELECTRON_PACKAGED',
    'AT_THR3_ADDR',
    'AT_THR4_ADDR',
    'FLIGHT_LOG_REQUIRE_FLIGHT_START',
    'SIMBRIDGE_DEBUG_SOURCES',
  ];
  return externals.includes(varName);
}

const missing = [];
for (const varName of configVars) {
  if (!envVars.has(varName) && !isKnownExternal(varName)) {
    missing.push(varName);
  }
}

const stale = [];
for (const varName of envVars) {
  if (!configVars.has(varName) && !isKnownExternal(varName)) {
    stale.push(varName);
  }
}

console.log('\n.env Completeness Check\n');
console.log(`Config vars (config.ts): ${configVars.size}`);
console.log(`Env vars (.env):         ${envVars.size}`);

if (!envExists) {
  console.log('\nOK: No local .env file present; config.ts defaults and app settings are the active source of truth.\n');
  process.exit(0);
}

if (missing.length === 0 && stale.length === 0) {
  console.log('\nOK: All config.ts vars are documented in .env\n');
  process.exit(0);
}

if (missing.length > 0) {
  console.log(`\nMISSING from .env (${missing.length}):\n`);
  for (const varName of missing.sort()) {
    console.log(`   ${varName}`);
  }
  console.log('\n   Add these to .env with defaults for discoverability');
}

if (stale.length > 0) {
  console.log(`\nIn .env but NOT in config.ts (${stale.length}):\n`);
  for (const varName of stale.sort()) {
    console.log(`   ${varName}`);
  }
  console.log('\n   Either remove from .env or add to config.ts');
}

console.log('');
process.exit(missing.length > 0 ? 1 : 0);
