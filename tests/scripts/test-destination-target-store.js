#!/usr/bin/env node
/**
 * test-destination-target-store.js
 * Unit tests for sanitizeTarget() in backend/core/destination-target-store.js
 *
 * Run: node tests/scripts/test-destination-target-store.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

// We only test the pure sanitizeTarget function — file I/O functions are
// excluded because they depend on the filesystem and app-data paths.
// We extract sanitizeTarget by requiring the module (it's exported).
const { sanitizeTarget } = require(resolveBackendRuntimeFile('core', 'destination-target-store.js'));

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

function assertNull(val, msg = '') {
  if (val !== null) throw new Error(`${msg} Expected null, got ${JSON.stringify(val)}`);
}

function assertTrue(val, msg = '') {
  if (!val) throw new Error(msg || 'Expected truthy');
}

console.log('\n=== sanitizeTarget Tests ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// Valid inputs
// ─────────────────────────────────────────────────────────────────────────────

console.log('--- Valid inputs ---\n');

test('valid 4-letter ICAO with lat/lon', () => {
  const result = sanitizeTarget({ icao: 'YSSY', name: 'Sydney', lat: -33.9461, lon: 151.1772 });
  assertTrue(result != null, 'should return object');
  assertEqual(result.icao, 'YSSY', 'icao');
  assertEqual(result.name, 'Sydney', 'name');
  assertEqual(result.lat, -33.9461, 'lat');
  assertEqual(result.lon, 151.1772, 'lon');
});

test('valid 3-letter ICAO', () => {
  const result = sanitizeTarget({ icao: 'LAX', lat: 33.9425, lon: -118.4081 });
  assertTrue(result != null, 'should return object');
  assertEqual(result.icao, 'LAX', 'icao');
});

test('ICAO is uppercased', () => {
  const result = sanitizeTarget({ icao: 'yssy', lat: -33.9461, lon: 151.1772 });
  assertTrue(result != null, 'should return object');
  assertEqual(result.icao, 'YSSY', 'icao should be uppercased');
});

test('name falls back to ICAO when not provided', () => {
  const result = sanitizeTarget({ icao: 'EGLL', lat: 51.4775, lon: -0.4614 });
  assertTrue(result != null, 'should return object');
  assertEqual(result.name, 'EGLL', 'name should fall back to ICAO');
});

test('name is trimmed and truncated to 200 chars', () => {
  const longName = 'A'.repeat(250);
  const result = sanitizeTarget({ icao: 'EGLL', name: longName, lat: 51.4775, lon: -0.4614 });
  assertTrue(result != null, 'should return object');
  assertEqual(result.name.length, 200, 'name should be truncated to 200 chars');
});

test('initialDistanceNm is preserved when positive', () => {
  const result = sanitizeTarget({ icao: 'YSSY', lat: -33.9461, lon: 151.1772, initialDistanceNm: 150 });
  assertTrue(result != null, 'should return object');
  assertEqual(result.initialDistanceNm, 150, 'initialDistanceNm');
});

test('initialDistanceNm is null when not provided', () => {
  const result = sanitizeTarget({ icao: 'YSSY', lat: -33.9461, lon: 151.1772 });
  assertTrue(result != null, 'should return object');
  assertNull(result.initialDistanceNm, 'initialDistanceNm should be null when not provided');
});

test('initialDistanceNm is null when zero or negative', () => {
  const result = sanitizeTarget({ icao: 'YSSY', lat: -33.9461, lon: 151.1772, initialDistanceNm: 0 });
  assertTrue(result != null, 'should return object');
  assertNull(result.initialDistanceNm, 'initialDistanceNm should be null when 0');

  const result2 = sanitizeTarget({ icao: 'YSSY', lat: -33.9461, lon: 151.1772, initialDistanceNm: -10 });
  assertTrue(result2 != null, 'should return object');
  assertNull(result2.initialDistanceNm, 'initialDistanceNm should be null when negative');
});

// ─────────────────────────────────────────────────────────────────────────────
// Invalid inputs — should return null
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Invalid inputs (should return null) ---\n');

test('null input returns null', () => {
  assertNull(sanitizeTarget(null), 'null input');
});

test('undefined input returns null', () => {
  assertNull(sanitizeTarget(undefined), 'undefined input');
});

test('non-object input returns null', () => {
  assertNull(sanitizeTarget('YSSY'), 'string input');
  assertNull(sanitizeTarget(42), 'number input');
});

test('missing ICAO returns null', () => {
  assertNull(sanitizeTarget({ lat: -33.9461, lon: 151.1772 }), 'missing ICAO');
});

test('empty ICAO returns null', () => {
  assertNull(sanitizeTarget({ icao: '', lat: -33.9461, lon: 151.1772 }), 'empty ICAO');
});

test('ICAO too short (2 chars) returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YS', lat: -33.9461, lon: 151.1772 }), '2-char ICAO');
});

test('ICAO too long (5+ chars) returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YSSYY', lat: -33.9461, lon: 151.1772 }), '5-char ICAO');
});

test('ICAO with special chars returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YS-Y', lat: -33.9461, lon: 151.1772 }), 'ICAO with hyphen');
});

test('invalid lat (>90) returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YSSY', lat: 91, lon: 151.1772 }), 'lat > 90');
});

test('invalid lat (<-90) returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YSSY', lat: -91, lon: 151.1772 }), 'lat < -90');
});

test('invalid lon (>180) returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YSSY', lat: -33.9461, lon: 181 }), 'lon > 180');
});

test('invalid lon (<-180) returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YSSY', lat: -33.9461, lon: -181 }), 'lon < -180');
});

test('non-finite lat returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YSSY', lat: NaN, lon: 151.1772 }), 'NaN lat');
  assertNull(sanitizeTarget({ icao: 'YSSY', lat: Infinity, lon: 151.1772 }), 'Infinity lat');
});

test('non-finite lon returns null', () => {
  assertNull(sanitizeTarget({ icao: 'YSSY', lat: -33.9461, lon: NaN }), 'NaN lon');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
