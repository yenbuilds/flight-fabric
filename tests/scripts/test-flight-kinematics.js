#!/usr/bin/env node
/**
 * test-flight-kinematics.js
 * Unit tests for backend/utils/flight-kinematics.js and backend/utils/rates.js
 *
 * Run: node tests/scripts/test-flight-kinematics.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { computeIasTrend, computePitchBankRates } = require(resolveBackendRuntimeFile('utils', 'flight-kinematics.js'));
const { computeRates } = require(resolveBackendRuntimeFile('utils', 'rates.js'));

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

function assertApprox(actual, expected, tolerance, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

const DEG_TO_RAD = Math.PI / 180;

console.log('\n=== computeIasTrend Tests ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// computeIasTrend
// ─────────────────────────────────────────────────────────────────────────────

test('positive trend when IAS increases', () => {
  const result = computeIasTrend({ ias: 150, previousIAS: 140 });
  assertEqual(result.trend, 10, 'trend should be +10');
  assertEqual(result.nextPreviousIAS, 150, 'nextPreviousIAS should be current IAS');
});

test('negative trend when IAS decreases', () => {
  const result = computeIasTrend({ ias: 130, previousIAS: 145 });
  assertEqual(result.trend, -15, 'trend should be -15');
  assertEqual(result.nextPreviousIAS, 130, 'nextPreviousIAS should be current IAS');
});

test('zero trend when IAS unchanged', () => {
  const result = computeIasTrend({ ias: 200, previousIAS: 200 });
  assertEqual(result.trend, 0, 'trend should be 0');
});

test('nextPreviousIAS always equals current IAS', () => {
  const result = computeIasTrend({ ias: 175, previousIAS: 100 });
  assertEqual(result.nextPreviousIAS, 175, 'nextPreviousIAS should be 175');
});

// ─────────────────────────────────────────────────────────────────────────────
// computeRates (rates.js)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== computeRates Tests ===\n');

test('zero rates when pitch and bank unchanged', () => {
  const result = computeRates(0, 0, 0, 0, 1.0);
  assertEqual(result.pitchRateDeg, 0, 'pitchRateDeg should be 0');
  assertEqual(result.bankRateDeg, 0, 'bankRateDeg should be 0');
});

test('positive pitch rate when pitching up', () => {
  // Pitch from 0 to 5 degrees in 1 second
  const prevPitch = 0;
  const currPitch = 5 * DEG_TO_RAD;
  const result = computeRates(prevPitch, 0, currPitch, 0, 1.0);
  assertApprox(result.pitchRateDeg, 5, 0.01, 'pitchRateDeg should be ~5 deg/s');
});

test('negative pitch rate when pitching down', () => {
  // Pitch from 5 to 0 degrees in 1 second
  const prevPitch = 5 * DEG_TO_RAD;
  const currPitch = 0;
  const result = computeRates(prevPitch, 0, currPitch, 0, 1.0);
  assertApprox(result.pitchRateDeg, -5, 0.01, 'pitchRateDeg should be ~-5 deg/s');
});

test('positive bank rate when rolling right', () => {
  // Bank from 0 to 10 degrees in 1 second
  const prevBank = 0;
  const currBank = 10 * DEG_TO_RAD;
  const result = computeRates(0, prevBank, 0, currBank, 1.0);
  assertApprox(result.bankRateDeg, 10, 0.01, 'bankRateDeg should be ~10 deg/s');
});

test('rate scales with dt (faster dt = higher rate)', () => {
  // Same angle change in 0.5s vs 1.0s
  const prevPitch = 0;
  const currPitch = 5 * DEG_TO_RAD;
  const result1s = computeRates(prevPitch, 0, currPitch, 0, 1.0);
  const result05s = computeRates(prevPitch, 0, currPitch, 0, 0.5);
  assertApprox(result05s.pitchRateDeg, result1s.pitchRateDeg * 2, 0.01, 'rate should double with half dt');
});

// ─────────────────────────────────────────────────────────────────────────────
// computePitchBankRates (flight-kinematics.js)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== computePitchBankRates Tests ===\n');

test('returns pitchRateDeg and bankRateDeg', () => {
  const result = computePitchBankRates({
    previousPitch: 0,
    previousBank: 0,
    pitch: 5 * DEG_TO_RAD,
    bank: 10 * DEG_TO_RAD,
    dtSeconds: 1.0,
  });
  assertApprox(result.pitchRateDeg, 5, 0.01, 'pitchRateDeg');
  assertApprox(result.bankRateDeg, 10, 0.01, 'bankRateDeg');
});

test('returns nextPreviousPitch and nextPreviousBank', () => {
  const pitch = 5 * DEG_TO_RAD;
  const bank = 10 * DEG_TO_RAD;
  const result = computePitchBankRates({
    previousPitch: 0,
    previousBank: 0,
    pitch,
    bank,
    dtSeconds: 1.0,
  });
  assertEqual(result.nextPreviousPitch, pitch, 'nextPreviousPitch should be current pitch');
  assertEqual(result.nextPreviousBank, bank, 'nextPreviousBank should be current bank');
});

test('zero rates when pitch and bank unchanged', () => {
  const pitch = 3 * DEG_TO_RAD;
  const bank = 7 * DEG_TO_RAD;
  const result = computePitchBankRates({
    previousPitch: pitch,
    previousBank: bank,
    pitch,
    bank,
    dtSeconds: 1.0,
  });
  assertEqual(result.pitchRateDeg, 0, 'pitchRateDeg should be 0 when unchanged');
  assertEqual(result.bankRateDeg, 0, 'bankRateDeg should be 0 when unchanged');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
