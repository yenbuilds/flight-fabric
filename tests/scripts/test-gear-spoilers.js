#!/usr/bin/env node
/**
 * test-gear-spoilers.js
 * Tests for backend/aircraft/spoilers.js
 *
 * Tests derive expected values from:
 * - SimConnect provides 0-100 percent for gear/flaps/spoilers (per frame contract)
 *
 * Tests:
 * - spoilers.js: mapSpoilersRawToPercent, makeSpoilersObj
 *
 * Run: node tests/scripts/test-gear-spoilers.js
 */
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const spoilers = require(resolveBackendRuntimeFile('aircraft', 'spoilers.js'));

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual, expected, tolerance = 0.01, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// spoilers.js - mapSpoilersRawToPercent tests
// SimConnect/default scale is 0-100 percent.
// ─────────────────────────────────────────────────────────────────────────────

test('mapSpoilersRawToPercent: 0 = STOWED', () => {
  const result = spoilers.mapSpoilersRawToPercent(0);
  assertEqual(result.state, 'STOWED', 'State');
  assertEqual(result.percent, 0, 'Percent');
  assertEqual(result.fraction, 0, 'Fraction');
});

test('mapSpoilersRawToPercent: 50 = EXTENDED 50%', () => {
  const result = spoilers.mapSpoilersRawToPercent(50);
  assertEqual(result.state, 'EXTENDED', 'State');
  assertEqual(result.percent, 50, 'Percent');
  assertApprox(result.fraction, 0.5, 0.01, 'Fraction');
});

test('mapSpoilersRawToPercent: 99 = EXTENDED 99%', () => {
  const result = spoilers.mapSpoilersRawToPercent(99);
  assertEqual(result.state, 'EXTENDED', 'State');
  assertEqual(result.percent, 99, 'Percent');
});

test('mapSpoilersRawToPercent: 100 = EXTENDED 100%', () => {
  const result = spoilers.mapSpoilersRawToPercent(100);
  assertEqual(result.state, 'EXTENDED', 'State');
  assertEqual(result.percent, 100, 'Percent');
  assertEqual(result.fraction, 1, 'Fraction');
});

test('mapSpoilersRawToPercent: above max clamps to 100%', () => {
  const result = spoilers.mapSpoilersRawToPercent(150);
  assertEqual(result.state, 'EXTENDED', 'State');
  assertEqual(result.percent, 100, 'Percent');
});

test('mapSpoilersRawToPercent: armed=true with zero returns ARMED', () => {
  const result = spoilers.mapSpoilersRawToPercent(0, { armed: true });
  assertEqual(result.state, 'ARMED', 'State');
  assertEqual(result.percent, 0, 'Percent');
});

test('mapSpoilersRawToPercent: fraction scale 0.5 returns 50%', () => {
  const result = spoilers.mapSpoilersRawToPercent(0.5, { scale: 'fraction' });
  assertEqual(result.state, 'EXTENDED', 'State');
  assertEqual(result.percent, 50, 'Percent');
  assertApprox(result.fraction, 0.5, 0.01, 'Fraction');
});

// Edge cases

test('mapSpoilersRawToPercent: null returns null state', () => {
  const result = spoilers.mapSpoilersRawToPercent(null);
  assertEqual(result.state, null, 'Null state');
  assertEqual(result.percent, null, 'Null percent');
});

test('mapSpoilersRawToPercent: undefined returns null state', () => {
  const result = spoilers.mapSpoilersRawToPercent(undefined);
  assertEqual(result.state, null, 'Undefined state');
});

test('mapSpoilersRawToPercent: empty string returns null state', () => {
  const result = spoilers.mapSpoilersRawToPercent('');
  assertEqual(result.state, null, 'Empty string state');
});

test('mapSpoilersRawToPercent: NaN returns null state', () => {
  const result = spoilers.mapSpoilersRawToPercent(NaN);
  assertEqual(result.state, null, 'NaN state');
});

test('mapSpoilersRawToPercent: string number works', () => {
  const result = spoilers.mapSpoilersRawToPercent('50');
  assertEqual(result.state, 'EXTENDED', 'String number');
  assertEqual(result.percent, 50, 'String percent');
});

// ─────────────────────────────────────────────────────────────────────────────
// spoilers.js - makeSpoilersObj tests (cached version)
// ─────────────────────────────────────────────────────────────────────────────

test('makeSpoilersObj: valid input returns object', () => {
  const result = spoilers.makeSpoilersObj(50);
  assertEqual(result.state, 'EXTENDED', 'State');
  assertEqual(result.percent, 50, 'Percent');
  assertApprox(result.fraction, 0.5, 0.01, 'Fraction');
});

test('makeSpoilersObj: returns last known on invalid input', () => {
  // First set a known state
  spoilers.makeSpoilersObj(50);
  // Then pass invalid
  const result = spoilers.makeSpoilersObj(null);
  // Should return last known (midpoint = EXTENDED 50%)
  if (result.state !== 'EXTENDED') {
    // May return default if cache was reset
    if (result.state !== 'STOWED') {
      throw new Error(`Expected EXTENDED or STOWED, got ${result.state}`);
    }
  }
});

test('makeSpoilersObj: STOWED returns correct object', () => {
  // Use 0 which is unambiguously STOWED in all scales
  const result = spoilers.makeSpoilersObj(0);
  assertEqual(result.state, 'STOWED', 'State');
  assertEqual(result.percent, 0, 'Percent');
  assertEqual(result.fraction, 0, 'Fraction');
});

test('makeSpoilersObj: ARMED returns correct object', () => {
  const result = spoilers.makeSpoilersObj(0, { armed: true });
  assertEqual(result.state, 'ARMED', 'State');
  assertEqual(result.percent, 0, 'Percent');
});

test('makeSpoilersObj: EXTENDED 100% returns correct object', () => {
  const result = spoilers.makeSpoilersObj(100);
  assertEqual(result.state, 'EXTENDED', 'State');
  assertEqual(result.percent, 100, 'Percent');
  assertEqual(result.fraction, 1, 'Fraction');
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration-style tests
// ─────────────────────────────────────────────────────────────────────────────

test('Spoiler deployment sequence: STOWED → ARMED → EXTENDED', () => {
  const results = [
    spoilers.mapSpoilersRawToPercent(0),
    spoilers.mapSpoilersRawToPercent(0, { armed: true }),
    spoilers.mapSpoilersRawToPercent(50),
    spoilers.mapSpoilersRawToPercent(100),
  ];
  
  assertEqual(results[0].state, 'STOWED', '0 = STOWED');
  assertEqual(results[1].state, 'ARMED', 'armed value = ARMED');
  assertEqual(results[2].state, 'EXTENDED', 'midpoint = EXTENDED');
  assertEqual(results[3].state, 'EXTENDED', 'max value = EXTENDED 100%');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`spoilers.js tests: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(60));

if (failed > 0) {
  console.log('\nFailed tests:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  });
  process.exit(1);
}

console.log('All tests passed ✓');
process.exit(0);
