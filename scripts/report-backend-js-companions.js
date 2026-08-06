#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_ROOT = path.join(ROOT, 'backend');

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

function normalize(relPath) {
  return relPath.split(path.sep).join('/');
}

function classify(relPath) {
  if (relPath.includes('/test-support/')) return 'test-support';
  if (relPath.includes('/test/')) return 'test';
  if (relPath.endsWith('.test.js')) return 'test';
  return 'runtime';
}

function main() {
  const allFiles = walk(BACKEND_ROOT);
  const companionFiles = allFiles
    .filter((filePath) => filePath.endsWith('.js'))
    .filter((filePath) => fs.existsSync(filePath.slice(0, -3) + '.ts'))
    .map((filePath) => normalize(path.relative(ROOT, filePath)));

  const summary = {
    runtime: 0,
    test: 0,
    'test-support': 0,
  };

  for (const relPath of companionFiles) {
    summary[classify(relPath)] += 1;
  }

  console.log('Backend JS Companion Audit');
  console.log('=========================');
  console.log(`Total companion .js files: ${companionFiles.length}`);
  console.log(`Runtime: ${summary.runtime}`);
  console.log(`Test: ${summary.test}`);
  console.log(`Test-support: ${summary['test-support']}`);

  if (companionFiles.length > 0) {
    console.log('\nSample files:');
    for (const relPath of companionFiles.slice(0, 40)) {
      console.log(`  ${relPath}`);
    }
    if (companionFiles.length > 40) {
      console.log(`  ... ${companionFiles.length - 40} more`);
    }
  }

  if (process.argv.includes('--fail-on-any') && companionFiles.length > 0) {
    process.exitCode = 1;
  }
}

main();
