#!/usr/bin/env node
/**
 * test-detect-flight-phase.js
 * Unit tests for backend/lifecycle/phase.js (detectFlightPhase)
 *
 * detectFlightPhase takes a single object: { ias, gs, wow, vs, ra, altMsl }
 *
 * Run: node tests/scripts/test-detect-flight-phase.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { detectFlightPhase } = require(resolveBackendRuntimeFile('lifecycle', 'phase.js'));
const { PHASES } = require(resolveBackendRuntimeFile('lifecycle', 'phases.js'));

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

// Helper: call detectFlightPhase with named args
function phase({ ias = 0, gs = 0, wow = false, vs = 0, ra = 0, altMsl = null } = {}) {
  return detectFlightPhase({ ias, gs, wow, vs, ra, altMsl });
}

console.log('\n=== detectFlightPhase Tests ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// Ground states
// ─────────────────────────────────────────────────────────────────────────────

console.log('--- Ground states ---\n');

test('PARKED: wow=true, speed=0', () => {
  const result = phase({ ias: 0, gs: 0, wow: true, vs: 0, ra: 0 });
  assertEqual(result, PHASES.PARKED, 'stationary on ground');
});

test('PARKED: wow=true ignores IAS when ground speed is zero', () => {
  const result = phase({ ias: 35, gs: 0, wow: true, vs: 0, ra: 0 });
  assertEqual(result, PHASES.PARKED, 'on-ground movement must come from ground speed only');
});

test('PARKED: wow=true high IAS does not become landing or taxi with zero ground speed', () => {
  const result = phase({ ias: 120, gs: 0, wow: true, vs: -300, ra: 0 });
  assertEqual(result, PHASES.PARKED, 'IAS alone must not drive ground phase movement');
});

test('PARKED or TAXI-IN: wow=true, speed=2 (very slow on ground)', () => {
  const result = phase({ ias: 2, gs: 2, wow: true, vs: 0, ra: 0 });
  // Speed=2 may be above the PARKED threshold — accept PARKED or TAXI-IN
  const valid = result === PHASES.PARKED || result === PHASES.TAXI_IN;
  if (!valid) throw new Error(`Expected PARKED or TAXI-IN, got ${result}`);
});

test('TAXI: wow=true, speed=15 kts', () => {
  const result = phase({ ias: 15, gs: 15, wow: true, vs: 0, ra: 0 });
  // Should be TAXI or TAXI-IN (both are valid ground movement states)
  const valid = result === PHASES.TAXI || result === PHASES.TAXI_IN;
  if (!valid) throw new Error(`Expected TAXI or TAXI-IN, got ${result}`);
});

test('LANDING: wow=true, high-speed low-RA rollout', () => {
  const result = phase({ ias: 120, gs: 120, wow: true, vs: -300, ra: 0 });
  assertEqual(result, PHASES.LANDING, 'high-speed touchdown/rollout');
});

test('WOW=true never reports airborne phases from high-energy telemetry', () => {
  const cases = [
    phase({ ias: 180, gs: 0, wow: true, vs: 1800, ra: 100, altMsl: 8000 }),
    phase({ ias: 250, gs: 0, wow: true, vs: 0, ra: 35000, altMsl: 35000 }),
    phase({ ias: 180, gs: 0, wow: true, vs: -1200, ra: 500, altMsl: 8000 }),
  ];
  const airborne = new Set([PHASES.TAKEOFF, PHASES.CLIMB, PHASES.CRUISE, PHASES.DESCENT, PHASES.APPROACH, PHASES.GO_AROUND]);
  for (const result of cases) {
    if (airborne.has(result)) {
      throw new Error(`WOW=true should not produce airborne phase, got ${result}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Airborne states
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Airborne states ---\n');

test('TAKEOFF or CLIMB: airborne, high IAS, positive VS, low RA', () => {
  // Low RA (500ft) with positive VS — could be TAKEOFF or CLIMB depending on thresholds
  const result = phase({ ias: 120, gs: 120, wow: false, vs: 1500, ra: 500 });
  const valid = result === PHASES.TAKEOFF || result === PHASES.CLIMB;
  if (!valid) throw new Error(`Expected TAKEOFF or CLIMB, got ${result}`);
});

test('CLIMB: airborne, positive VS, high RA', () => {
  const result = phase({ ias: 200, gs: 200, wow: false, vs: 1800, ra: 5000, altMsl: 8000 });
  assertEqual(result, PHASES.CLIMB, 'climbing at altitude');
});

test('CRUISE: airborne, near-level VS, high altitude', () => {
  const result = phase({ ias: 250, gs: 250, wow: false, vs: 50, ra: 35000, altMsl: 35000 });
  assertEqual(result, PHASES.CRUISE, 'cruise at FL350');
});

test('DESCENT: airborne, negative VS, high RA', () => {
  const result = phase({ ias: 220, gs: 220, wow: false, vs: -1500, ra: 10000, altMsl: 15000 });
  assertEqual(result, PHASES.DESCENT, 'descending from cruise');
});

test('APPROACH: airborne, low RA, descending', () => {
  const result = phase({ ias: 140, gs: 140, wow: false, vs: -700, ra: 800 });
  assertEqual(result, PHASES.APPROACH, 'on approach');
});

test('APPROACH: excessive speed still describes the low descending phase', () => {
  const result = phase({ ias: 250, gs: 250, wow: false, vs: -700, ra: 800 });
  assertEqual(result, PHASES.APPROACH, 'approach overspeed should be a violation, not a phase blocker');
});

test('APPROACH: low radio altitude takes precedence at a high-elevation airport', () => {
  const result = phase({ ias: 145, gs: 150, wow: false, vs: -801, ra: 800, altMsl: 6000 });
  assertEqual(result, PHASES.APPROACH, 'high field elevation should not hide a low-RA final approach');
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Edge cases ---\n');

test('CRUISE: level flight at high MSL altitude with slight positive VS noise', () => {
  const result = phase({ ias: 250, gs: 250, wow: false, vs: 100, ra: 35000, altMsl: 35000 });
  assertEqual(result, PHASES.CRUISE, 'level flight at cruise altitude with VS noise');
});

test('UNKNOWN: low-RA level frame does not become CRUISE just because MSL is high', () => {
  const result = phase({ ias: 120, gs: 15, wow: false, vs: 0, ra: 20, altMsl: 12000 });
  assertEqual(result, PHASES.UNKNOWN, 'near-ground level frames should not classify as cruise');
});

test('UNKNOWN: explicit zero GS blocks IAS-only low-RA takeoff/climb detection', () => {
  const result = phase({ ias: 160, gs: 0, wow: false, vs: 1500, ra: 100, altMsl: 500 });
  assertEqual(result, PHASES.UNKNOWN, 'low-RA airborne phase changes should not come from IAS with zero GS');
});

test('APPROACH: not LANDING when airborne with low RA', () => {
  // LANDING should only be detected when wow=true
  const result = phase({ ias: 130, gs: 130, wow: false, vs: -600, ra: 200 });
  if (result === PHASES.LANDING) {
    throw new Error('Should not detect LANDING when airborne (wow=false)');
  }
});

test('detectFlightPhase handles zero values gracefully', () => {
  // Should not throw with all-zero inputs
  const result = detectFlightPhase({ ias: 0, gs: 0, wow: false, vs: 0, ra: 0, altMsl: null });
  if (typeof result !== 'string') {
    throw new Error(`Expected string phase, got ${typeof result}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
