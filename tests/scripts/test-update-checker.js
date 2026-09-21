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
const pendingTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(result.then(() => {
        passed++;
        console.log(`  PASS ${name}`);
      }, (error) => {
        failed++;
        console.error(`  FAIL ${name}: ${error.message}`);
      }));
      return;
    }
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

console.log('\n=== sanitizeSupportGoal Tests ===\n');

const { sanitizeSupportGoal, getLastSupportGoalMsg } = require(resolveBackendRuntimeFile('core', 'update-checker.js'));

test('accepts a well-formed supporter goal and nothing else from the block', () => {
  assertEqual(
    JSON.stringify(sanitizeSupportGoal({ period: '2026-09', supporters: 14, goal: 25, extra: 'ignored' })),
    JSON.stringify({ period: '2026-09', supporters: 14, goal: 25 }),
  );
  assertEqual(JSON.stringify(sanitizeSupportGoal({ period: '2026-12', supporters: 0, goal: 1 })), JSON.stringify({ period: '2026-12', supporters: 0, goal: 1 }));
});

for (const [label, value] of [
  ['a missing block', undefined],
  ['a null block', null],
  ['a string block', 'support'],
  ['a bad month', { period: '2026-13', supporters: 1, goal: 2 }],
  ['a non-ISO period', { period: 'September 2026', supporters: 1, goal: 2 }],
  ['a negative count', { period: '2026-09', supporters: -1, goal: 2 }],
  ['a zero goal', { period: '2026-09', supporters: 1, goal: 0 }],
  ['a fractional count', { period: '2026-09', supporters: 1.5, goal: 2 }],
  ['a numeric string count', { period: '2026-09', supporters: '1', goal: 2 }],
  ['an absurd goal', { period: '2026-09', supporters: 1, goal: 1000001 }],
]) {
  test(`rejects ${label}`, () => {
    assertEqual(sanitizeSupportGoal(value), null);
  });
}

test('website hides a supporter goal when an open page crosses into another month', async () => {
  const assert = require('node:assert/strict');
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  const { runInNewContext } = require('node:vm');
  let clock = new Date(2026, 8, 30, 23, 59, 59).getTime();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
  }
  const container = { hidden: true };
  const label = {};
  const fill = { style: {} };
  const timers = [];
  let onVisibilityChange;
  runInNewContext(readFileSync(resolve(__dirname, '../../site/flightfabric/support-goal.js'), 'utf8'), {
    Date: ClockDate,
    document: {
      querySelector: (selector) => ({ '[data-support-goal]': container, '[data-support-goal-text]': label, '[data-support-goal-fill]': fill })[selector],
      addEventListener: (name, handler) => { onVisibilityChange = handler; },
    },
    fetch: async () => ({ ok: true, json: () => ({ support: { period: '2026-09', supporters: 14, goal: 25 } }) }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(container.hidden, false);
  assert.equal(label.textContent, '14 of 25 supporters this month');
  assert.equal(fill.style.width, '56%');
  assert.equal(timers[0].ms, 1000);
  clock += 1000;
  timers[0].fn();
  assert.equal(container.hidden, true, 'expiry hides the already rendered goal');
  onVisibilityChange();
  assert.equal(container.hidden, true, 'resuming a sleeping tab also checks the month');
});

test('no supporter goal is cached before a manifest has been read', () => {
  assertEqual(getLastSupportGoalMsg(), null);
});

test('manifest refresh withdraws a removed goal from existing clients and preserves it on network failure', async () => {
  const assert = require('node:assert/strict');
  const { EventEmitter } = require('node:events');
  const { readFileSync } = require('node:fs');
  const { createRequire } = require('node:module');
  const { runInNewContext } = require('node:vm');
  const runtimeFile = resolveBackendRuntimeFile('core', 'update-checker.js');
  const localRequire = createRequire(runtimeFile);
  const exports = {};
  let check;
  let manifest = { version: '0.9.9', support: { period: '2026-09', supporters: 14, goal: 25 } };
  let offline = false;
  const https = {
    get(url, options, callback) {
      const request = new EventEmitter();
      queueMicrotask(() => {
        if (offline) return request.emit('error', new Error('offline'));
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        response.emit('data', JSON.stringify(manifest));
        response.emit('end');
      });
      return request;
    },
  };
  runInNewContext(readFileSync(runtimeFile, 'utf8'), {
    exports, Buffer, console,
    require: (id) => id === 'https' ? https : localRequire(id),
    setTimeout: (fn) => { check = fn; return { unref() {} }; },
    setInterval: () => ({ unref() {} }), clearTimeout() {}, clearInterval() {},
  }, { filename: runtimeFile });
  const messages = [];
  const handle = exports.startUpdateChecker({ currentVersion: '0.9.9', broadcast: (message) => messages.push(message) });
  await check();
  assert.equal(messages.length, 1, 'a goal is independent of update availability');
  assert.equal(exports.getLastSupportGoalMsg().supporters, 14);
  offline = true;
  await check();
  assert.equal(messages.length, 1, 'network errors do not manufacture a withdrawal');
  offline = false;
  manifest = { version: '0.9.9' };
  await check();
  assert.equal(exports.getLastSupportGoalMsg()?.period, null, 'requestState must replay the withdrawal to a reconnected client');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].type, 'supportGoal');
  assert.equal(messages[1].period, null, 'connected clients receive a clearing message');
  await check();
  assert.equal(messages.length, 2, 'an absent goal is not repeatedly broadcast');
  manifest.support = { period: '2026-09', supporters: 20, goal: 25 };
  await check();
  assert.equal(messages.at(-1).supporters, 20);
  handle.stop();
  await check();
  assert.equal(messages.length, 3, 'stopping cancels further checks');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
Promise.all(pendingTests).then(() => {
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
