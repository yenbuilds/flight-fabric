#!/usr/bin/env node
/**
 * test-helpers.js
 * Regression tests for backend/helpers.js utility functions.
 *
 * Tests:
 * - computeCrosswind: crosswind calculation from wind/heading
 * - decodeSurfaceType: runway surface type mapping
 * - decodeGearState: gear position decode from raw values
 * - decodeWOW/decodeLights: telemetry bit/boolean decoders
 *
 * Run: node tests/scripts/test-helpers.js
 */
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require(resolveBackendRuntimeFile('utils', 'helpers.js'));

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

function assertNull(actual, msg = '') {
  if (actual !== null) {
    throw new Error(`${msg} Expected null, got ${actual}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computeCrosswind tests
// NOTE: As of 2025-01, this function expects DEGREES (pre-converted at boundary).
// ─────────────────────────────────────────────────────────────────────────────

test('computeCrosswind: direct headwind returns 0', () => {
  // Wind from 360/0°, heading 360/0° → pure headwind, no crosswind
  const xw = helpers.computeCrosswind(20, 360, 360);
  assertApprox(xw, 0, 0.5, 'Headwind');
});

test('computeCrosswind: direct tailwind returns 0', () => {
  // Wind from 180°, heading 360/0° → pure tailwind, no crosswind
  const xw = helpers.computeCrosswind(20, 180, 360);
  assertApprox(xw, 0, 0.5, 'Tailwind');
});

test('computeCrosswind: 90° right crosswind returns positive', () => {
  // Wind from 090°, heading 360° → pure right crosswind
  const xw = helpers.computeCrosswind(20, 90, 360);
  assertApprox(xw, 20, 0.5, '90° right');
});

test('computeCrosswind: 90° left crosswind returns negative', () => {
  // Wind from 270°, heading 360° → pure left crosswind
  const xw = helpers.computeCrosswind(20, 270, 360);
  assertApprox(xw, -20, 0.5, '90° left');
});

test('computeCrosswind: 45° quartering wind', () => {
  // Wind from 045°, heading 360° → 45° quartering from right
  // sin(45°) ≈ 0.707, so crosswind ≈ 20 * 0.707 ≈ 14.14
  const xw = helpers.computeCrosswind(20, 45, 360);
  assertApprox(xw, 14.1, 0.5, '45° quartering');
});

test('computeCrosswind: handles 0/360 wrap correctly', () => {
  // Wind from 350°, heading 010° → 20° angle, slight left crosswind
  const xw = helpers.computeCrosswind(20, 350, 10);
  // sin(-20°) ≈ -0.342, xw ≈ -6.84
  assertApprox(xw, -6.8, 0.5, '0/360 wrap');
});

test('computeCrosswind: zero wind speed returns 0', () => {
  const xw = helpers.computeCrosswind(0, 90, 360);
  assertEqual(xw, 0, 'Zero wind');
});

test('computeCrosswind: very small wind treated as calm', () => {
  const xw = helpers.computeCrosswind(0.05, 90, 360);
  assertEqual(xw, 0, 'Very small wind');
});

test('computeCrosswind: missing or invalid inputs remain unknown', () => {
  assertEqual(helpers.computeCrosswind(NaN, 0, 0), null, 'NaN speed');
  assertEqual(helpers.computeCrosswind(10, NaN, 0), null, 'NaN wind dir');
  assertEqual(helpers.computeCrosswind(10, 0, NaN), null, 'NaN heading');
  assertEqual(helpers.computeCrosswind(null, 0, 0), null, 'Missing speed');
});

// ─────────────────────────────────────────────────────────────────────────────
// decodeSurfaceType tests
// Returns an object: { raw, name, class, runwayLike, onGround, valid }
// ─────────────────────────────────────────────────────────────────────────────

test('decodeSurfaceType: concrete (0) returns CONCRETE name, PAVED class', () => {
  const surface = helpers.decodeSurfaceType(0, true);
  assertEqual(surface.name, 'CONCRETE', 'Name');
  assertEqual(surface.class, 'PAVED', 'Class');
  assertEqual(surface.runwayLike, true, 'Runway-like');
});

test('decodeSurfaceType: grass (1) returns GRASS name, UNPAVED class', () => {
  const surface = helpers.decodeSurfaceType(1, true);
  assertEqual(surface.name, 'GRASS', 'Name');
  assertEqual(surface.class, 'UNPAVED', 'Class');
  assertEqual(surface.runwayLike, false, 'Not runway-like');
});

test('decodeSurfaceType: water (2) returns WATER class', () => {
  const surface = helpers.decodeSurfaceType(2, true);
  assertEqual(surface.name, 'WATER', 'Name');
  assertEqual(surface.class, 'WATER', 'Class');
});

test('decodeSurfaceType: asphalt (4) returns PAVED class', () => {
  const surface = helpers.decodeSurfaceType(4, true);
  assertEqual(surface.name, 'ASPHALT', 'Name');
  assertEqual(surface.class, 'PAVED', 'Class');
});

test('decodeSurfaceType: unknown value returns UNKNOWN class', () => {
  const surface = helpers.decodeSurfaceType(99, true);
  assertEqual(surface.name, 'UNKNOWN', 'Name');
  assertEqual(surface.class, 'UNKNOWN', 'Class');
});

test('decodeSurfaceType: null raw returns invalid result', () => {
  const surface = helpers.decodeSurfaceType(null, true);
  assertEqual(surface.valid, false, 'Not valid');
  assertNull(surface.raw, 'Raw is null');
});

test('decodeSurfaceType: WOW=false (airborne) returns UNKNOWN class', () => {
  const surface = helpers.decodeSurfaceType(0, false);
  assertEqual(surface.class, 'UNKNOWN', 'Airborne class');
  assertEqual(surface.onGround, false, 'Not on ground');
  assertEqual(surface.valid, false, 'Not valid when airborne');
});

test('decodeSurfaceType: tarmac (23) is PAVED and runway-like', () => {
  const surface = helpers.decodeSurfaceType(23, true);
  assertEqual(surface.name, 'TARMAC', 'Name');
  assertEqual(surface.class, 'PAVED', 'Class');
  assertEqual(surface.runwayLike, true, 'Runway-like');
});

// ─────────────────────────────────────────────────────────────────────────────
// decodeGearState tests - SimConnect provides gear positions as percent (0-100)
// Takes an object: { gearHandle, gearLeft, gearRight, gearNose, gearDownLocked }
// Returns: { left, right, nose, locked }
// ─────────────────────────────────────────────────────────────────────────────

test('decodeGearState: all retracted (0,0,0) returns fractions near 0', () => {
  const gear = helpers.decodeGearState({
    gearHandle: 0,
    gearNose: 0,
    gearLeft: 0,
    gearRight: 0,
    gearDownLocked: 0
  });
  assertEqual(gear.nose, 0, 'Nose retracted');
  assertEqual(gear.left, 0, 'Left retracted');
  assertEqual(gear.right, 0, 'Right retracted');
  assertEqual(gear.locked, false, 'Not locked');
});

test('decodeGearState: all extended (100%) returns fractions near 1', () => {
  // SimConnect provides 0-100 percent for gear positions
  // gearDownLocked is 0 or 1 (set by telemetry provider when all legs >= 99%)
  const gear = helpers.decodeGearState({
    gearHandle: 1,
    gearNose: 100,
    gearLeft: 100,
    gearRight: 100,
    gearDownLocked: 1
  });
  assertApprox(gear.nose, 1, 0.001, 'Nose extended');
  assertApprox(gear.left, 1, 0.001, 'Left extended');
  assertApprox(gear.right, 1, 0.001, 'Right extended');
  assertEqual(gear.locked, true, 'Locked');
});

test('decodeGearState: partial extension (50%)', () => {
  // 50% = half extended (SimConnect percent)
  const gear = helpers.decodeGearState({
    gearHandle: 1,
    gearNose: 50,
    gearLeft: 50,
    gearRight: 50,
    gearDownLocked: 0
  });
  assertApprox(gear.nose, 0.5, 0.01, 'Nose 50%');
  assertApprox(gear.left, 0.5, 0.01, 'Left 50%');
  assertApprox(gear.right, 0.5, 0.01, 'Right 50%');
  assertEqual(gear.locked, false, 'Not locked during transit');
});

test('decodeGearState: locked bits partially set', () => {
  // gearDownLocked is produced as 0 or 1 — any value other than 1 means not locked
  const gear = helpers.decodeGearState({
    gearHandle: 1,
    gearNose: 100,
    gearLeft: 100,
    gearRight: 100,
    gearDownLocked: 0  // 0 = not all legs confirmed >= 99%
  });
  assertEqual(gear.locked, false, 'Not fully locked');
});

// ─────────────────────────────────────────────────────────────────────────────
// decodeWOW tests (weight on wheels)
// ─────────────────────────────────────────────────────────────────────────────

test('decodeWOW: 0 returns false (airborne)', () => {
  const wow = helpers.decodeWOW(0);
  assertEqual(wow, false, 'Airborne');
});

test('decodeWOW: 1 returns true (on ground)', () => {
  const wow = helpers.decodeWOW(1);
  assertEqual(wow, true, 'On ground');
});

test('decodeWOW: any positive returns true', () => {
  assertEqual(helpers.decodeWOW(100), true, 'Large value');
  assertEqual(helpers.decodeWOW(0.5), true, 'Fractional');
});

// ─────────────────────────────────────────────────────────────────────────────
// gearDown tests (bitmask check)
// Returns true if bits 0,1,2 are all set
// ─────────────────────────────────────────────────────────────────────────────

test('gearDown: 0b000 (none down) returns false', () => {
  assertEqual(helpers.gearDown(0b000), false, 'None');
});

test('gearDown: 0b111 (all down) returns true', () => {
  assertEqual(helpers.gearDown(0b111), true, 'All down');
});

test('gearDown: 0b011 (partial) returns false', () => {
  assertEqual(helpers.gearDown(0b011), false, 'Partial');
});

test('gearDown: 0b110 (partial) returns false', () => {
  assertEqual(helpers.gearDown(0b110), false, 'Partial 2');
});

test('gearDown: 0b1111 (extra bits) returns true', () => {
  // Extra bits shouldn't matter
  assertEqual(helpers.gearDown(0b1111), true, 'Extra bits');
});

// ─────────────────────────────────────────────────────────────────────────────
// decodeLights tests
// ─────────────────────────────────────────────────────────────────────────────

test('decodeLights: 0 returns all lights off', () => {
  const lights = helpers.decodeLights(0);
  assertEqual(lights.nav, false, 'Nav off');
  assertEqual(lights.beacon, false, 'Beacon off');
  assertEqual(lights.landing, false, 'Landing off');
  assertEqual(lights.taxi, false, 'Taxi off');
  assertEqual(lights.strobe, false, 'Strobe off');
});

test('decodeLights: bit 0 (nav) set', () => {
  const lights = helpers.decodeLights(1);
  assertEqual(lights.nav, true, 'Nav on');
  assertEqual(lights.beacon, false, 'Beacon off');
});

test('decodeLights: bit 1 (beacon) set', () => {
  const lights = helpers.decodeLights(2);
  assertEqual(lights.beacon, true, 'Beacon on');
  assertEqual(lights.nav, false, 'Nav off');
});

test('decodeLights: multiple bits set', () => {
  const lights = helpers.decodeLights(0b11111); // First 5 bits
  assertEqual(lights.nav, true, 'Nav');
  assertEqual(lights.beacon, true, 'Beacon');
  assertEqual(lights.landing, true, 'Landing');
  assertEqual(lights.taxi, true, 'Taxi');
  assertEqual(lights.strobe, true, 'Strobe');
});

test('decodeLights: logo bit (8)', () => {
  const lights = helpers.decodeLights(1 << 8);
  assertEqual(lights.logo, true, 'Logo on');
  assertEqual(lights.nav, false, 'Nav off');
});

test('decodeLights: raw value preserved', () => {
  const lights = helpers.decodeLights(0b10101);
  assertEqual(lights.raw, 0b10101, 'Raw preserved');
});

// ─────────────────────────────────────────────────────────────────────────────
// rad2deg tests
// ─────────────────────────────────────────────────────────────────────────────

test('rad2deg: 0 radians = 0 degrees', () => {
  assertEqual(helpers.rad2deg(0), 0, '0 rad');
});

test('rad2deg: π radians = 180 degrees', () => {
  assertApprox(helpers.rad2deg(Math.PI), 180, 0.0001, 'π rad');
});

test('rad2deg: π/2 radians = 90 degrees', () => {
  assertApprox(helpers.rad2deg(Math.PI / 2), 90, 0.0001, 'π/2 rad');
});

test('rad2deg: 2π radians = 360 degrees', () => {
  assertApprox(helpers.rad2deg(2 * Math.PI), 360, 0.0001, '2π rad');
});

test('rad2deg: negative radians', () => {
  assertApprox(helpers.rad2deg(-Math.PI), -180, 0.0001, '-π rad');
});

// ─────────────────────────────────────────────────────────────────────────────
test('resolveExistingDirectory: uses the nearest existing parent for a future flight logs path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-disk-check-'));
  try {
    const futureLogsDir = path.join(root, 'redirected-documents', 'Flight Fabric', 'Flight Logs');
    assertEqual(helpers.resolveExistingDirectory(futureLogsDir), root, 'Nearest existing parent');

    const redirectedDocuments = path.join(root, 'redirected-documents');
    fs.mkdirSync(redirectedDocuments);
    assertEqual(
      helpers.resolveExistingDirectory(futureLogsDir),
      redirectedDocuments,
      'Redirected Documents volume should be checked',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`helpers.js tests: ${passed} passed, ${failed} failed`);
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
