#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function candidateRealFlightsDirs(baseDir = __dirname) {
  return uniqueCandidates([
    process.env.FF_REAL_FLIGHTS_DIR,
    path.join(process.cwd(), 'tests/data/real-flights'),
    path.join(baseDir, '../data/real-flights'),
    path.join(baseDir, '../../tests/data/real-flights'),
    path.join(baseDir, '../../../tests/data/real-flights'),
  ]);
}

function listTopLevelFlightJsonFiles(realFlightsDir) {
  if (!realFlightsDir || !fs.existsSync(realFlightsDir)) return [];
  return fs.readdirSync(realFlightsDir)
    .filter((file) => file.endsWith('.json') && !file.includes('metadata'));
}

function resolveRealFlightsDir(options: { baseDir?: string; requireJson?: boolean } = {}) {
  const requireJson = options.requireJson !== false;
  const candidates = candidateRealFlightsDirs(options.baseDir || __dirname);
  const resolved = findRealFlightsDir(candidates, requireJson);
  if (resolved) return resolved;

  const searched = candidates.map((candidate) => `  - ${candidate}`).join('\n');
  throw new Error(
    'Real flight fixture directory not found or empty.\n'
    + 'Set FF_REAL_FLIGHTS_DIR or keep curated fixtures under tests/data/real-flights.\n'
    + `Searched:\n${searched}`
  );
}

function maybeResolveRealFlightsDir(options: { baseDir?: string; requireJson?: boolean } = {}) {
  const requireJson = options.requireJson !== false;
  const candidates = candidateRealFlightsDirs(options.baseDir || __dirname);
  return findRealFlightsDir(candidates, requireJson);
}

function findRealFlightsDir(candidates, requireJson) {
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
    if (!requireJson || listTopLevelFlightJsonFiles(candidate).length > 0) {
      return candidate;
    }
  }
  return null;
}

module.exports = {
  candidateRealFlightsDirs,
  listTopLevelFlightJsonFiles,
  maybeResolveRealFlightsDir,
  resolveRealFlightsDir,
};

export {};
