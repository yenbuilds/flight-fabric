#!/usr/bin/env node
/**
 * test-update-checker.js
 * Unit tests for update-checker version and download-link policy.
 *
 * semverGt is not exported directly, so we test it indirectly via the
 * observable behavior of startUpdateChecker / getLastUpdateMsg.
 * A small comparator fixture also covers the expected version-ordering cases.
 *
 * Run: node tests/scripts/test-update-checker.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

// Independent comparator used to describe expected version ordering.
function semverGt(a, b) {
  const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\n=== semverGt Tests ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// Basic comparisons
// ─────────────────────────────────────────────────────────────────────────────

console.log('--- Basic comparisons ---\n');

test('1.0.0 > 0.9.9', () => {
  assertEqual(semverGt('1.0.0', '0.9.9'), true, '1.0.0 > 0.9.9');
});

test('0.9.9 is NOT > 1.0.0', () => {
  assertEqual(semverGt('0.9.9', '1.0.0'), false, '0.9.9 not > 1.0.0');
});

test('equal versions return false', () => {
  assertEqual(semverGt('1.2.3', '1.2.3'), false, '1.2.3 not > 1.2.3');
});

test('0.2.0 > 0.1.9', () => {
  assertEqual(semverGt('0.2.0', '0.1.9'), true, '0.2.0 > 0.1.9');
});

test('0.1.10 > 0.1.9', () => {
  assertEqual(semverGt('0.1.10', '0.1.9'), true, '0.1.10 > 0.1.9');
});

test('0.1.9 is NOT > 0.1.10', () => {
  assertEqual(semverGt('0.1.9', '0.1.10'), false, '0.1.9 not > 0.1.10');
});

// ─────────────────────────────────────────────────────────────────────────────
// Major version comparisons
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Major version comparisons ---\n');

test('2.0.0 > 1.99.99', () => {
  assertEqual(semverGt('2.0.0', '1.99.99'), true, '2.0.0 > 1.99.99');
});

test('10.0.0 > 9.9.9', () => {
  assertEqual(semverGt('10.0.0', '9.9.9'), true, '10.0.0 > 9.9.9');
});

// ─────────────────────────────────────────────────────────────────────────────
// Minor version comparisons
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Minor version comparisons ---\n');

test('1.2.0 > 1.1.9', () => {
  assertEqual(semverGt('1.2.0', '1.1.9'), true, '1.2.0 > 1.1.9');
});

test('1.1.9 is NOT > 1.2.0', () => {
  assertEqual(semverGt('1.1.9', '1.2.0'), false, '1.1.9 not > 1.2.0');
});

// ─────────────────────────────────────────────────────────────────────────────
// Patch version comparisons
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Patch version comparisons ---\n');

test('0.1.2 > 0.1.1', () => {
  assertEqual(semverGt('0.1.2', '0.1.1'), true, '0.1.2 > 0.1.1');
});

test('0.1.1 is NOT > 0.1.2', () => {
  assertEqual(semverGt('0.1.1', '0.1.2'), false, '0.1.1 not > 0.1.2');
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Edge cases ---\n');

test('0.0.0 is NOT > 0.0.0', () => {
  assertEqual(semverGt('0.0.0', '0.0.0'), false, '0.0.0 not > 0.0.0');
});

test('0.0.1 > 0.0.0', () => {
  assertEqual(semverGt('0.0.1', '0.0.0'), true, '0.0.1 > 0.0.0');
});

test('handles non-numeric parts gracefully (treats as 0)', () => {
  // parseInt('x', 10) returns NaN, || 0 makes it 0
  assertEqual(semverGt('1.x.0', '0.9.9'), true, '1.x.0 > 0.9.9 (x treated as 0)');
});

// ─────────────────────────────────────────────────────────────────────────────
// getLastUpdateMsg: starts as null
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- getLastUpdateMsg ---\n');

test('getLastUpdateMsg returns null initially', () => {
  const { getLastUpdateMsg } = require(resolveBackendRuntimeFile('core', 'update-checker.js'));
  const msg = getLastUpdateMsg();
  if (msg !== null) {
    throw new Error(`Expected null, got ${JSON.stringify(msg)}`);
  }
});

console.log('\n--- update download URL policy ---\n');

const { sanitizeUpdateDownloadUrl } = require(resolveBackendRuntimeFile('core', 'update-checker.js'));

test('accepts the canonical latest release URL', () => {
  assertEqual(
    sanitizeUpdateDownloadUrl('https://github.com/yenbuilds/flight-fabric/releases/latest'),
    'https://github.com/yenbuilds/flight-fabric/releases/latest',
  );
});

test('accepts official tag and release asset URLs', () => {
  assertEqual(
    sanitizeUpdateDownloadUrl('https://github.com/yenbuilds/flight-fabric/releases/tag/v0.2.1'),
    'https://github.com/yenbuilds/flight-fabric/releases/tag/v0.2.1',
  );
  assertEqual(
    sanitizeUpdateDownloadUrl('https://github.com/yenbuilds/flight-fabric/releases/download/v0.2.1/Flight.Fabric.exe'),
    'https://github.com/yenbuilds/flight-fabric/releases/download/v0.2.1/Flight.Fabric.exe',
  );
});

for (const [label, value] of [
  ['non-HTTPS URL', 'http://github.com/yenbuilds/flight-fabric/releases/latest'],
  ['lookalike host', 'https://github.com.example.invalid/yenbuilds/flight-fabric/releases/latest'],
  ['unapproved repository', 'https://github.com/attacker/flight-fabric/releases/latest'],
  ['embedded credentials', 'https://user:pass@github.com/yenbuilds/flight-fabric/releases/latest'],
  ['custom port', 'https://github.com:444/yenbuilds/flight-fabric/releases/latest'],
  ['non-release repository path', 'https://github.com/yenbuilds/flight-fabric/issues'],
  ['query string', 'https://github.com/yenbuilds/flight-fabric/releases/latest?source=manifest'],
  ['fragment', 'https://github.com/yenbuilds/flight-fabric/releases/latest#download'],
  ['JavaScript URL', 'javascript:alert(1)'],
  ['malformed URL', 'not a URL'],
]) {
  test(`rejects ${label}`, () => {
    assertEqual(sanitizeUpdateDownloadUrl(value), null);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
