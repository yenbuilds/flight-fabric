/**
 * VRE Evaluator Tests
 * 
 * Tests the Variable Rate Encoding system for correctness of:
 * - Escalation triggers (VS, acceleration, rates, config transitions)
 * - Sampling bands (BASELINE, ELEVATED, HIGH_FIDELITY)
 * - Hysteresis and decay logic
 * - Metadata generation
 */

'use strict';

const assert = require('assert');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const {
  createVreEvaluator,
  BAND,
  BAND_RATES,
  BAND_INTERVALS_MS,
  ESCALATION,
  THRESHOLDS,
  HYSTERESIS,
  escalationToString,
} = require(resolveBackendRuntimeFile('events', 'vre-evaluator.js'));

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    testsFailed++;
  }
}

console.log('=== VRE Evaluator Tests ===\n');

// ─────────────────────────────────────────────────────────────────────────
// Constants Tests
// ─────────────────────────────────────────────────────────────────────────

console.log('--- Constants ---');

test('BAND has four levels', () => {
  assert.strictEqual(Object.keys(BAND).length, 4);
  assert.ok(BAND.BASELINE);
  assert.ok(BAND.ELEVATED);
  assert.ok(BAND.HIGH_FIDELITY);
  assert.ok(BAND.ULTRA_FIDELITY);
});

test('BAND_RATES are bounded correctly', () => {
  assert.strictEqual(BAND_RATES[BAND.BASELINE], 1);
  assert.ok(BAND_RATES[BAND.ELEVATED] >= 2 && BAND_RATES[BAND.ELEVATED] <= 5);
  assert.ok(BAND_RATES[BAND.HIGH_FIDELITY] <= 10);
  assert.strictEqual(BAND_RATES[BAND.ULTRA_FIDELITY], 10);
  assert.strictEqual(BAND_INTERVALS_MS[BAND.ULTRA_FIDELITY], 100);
  assert.strictEqual(THRESHOLDS.ULTRA_FIDELITY_MAX_SAMPLES, 600);
});

test('ESCALATION bitmask values are unique powers of 2', () => {
  const values = Object.values(ESCALATION).filter(v => v !== 0);
  const uniqueSet = new Set(values);
  assert.strictEqual(values.length, uniqueSet.size);
  for (const v of values) {
    // Check it's a power of 2
    assert.ok((v & (v - 1)) === 0 || v === 1, `${v} is not a power of 2`);
  }
});

test('THRESHOLDS has VS, acceleration, rate, and proximity values', () => {
  assert.ok(THRESHOLDS.VS_ELEVATED > 0);
  assert.ok(THRESHOLDS.VS_HIGH_FIDELITY > THRESHOLDS.VS_ELEVATED);
  assert.ok(THRESHOLDS.ACCEL_Z_ELEVATED > 0);
  assert.ok(THRESHOLDS.GROUND_PROXIMITY_RA > 0);
});

test('HYSTERESIS has hold and decay parameters', () => {
  assert.ok(HYSTERESIS.HOLD_MS > 0);
  assert.ok(HYSTERESIS.DECAY_CALM_MS > 0);
  assert.ok(HYSTERESIS.DECAY_STEP_MS > 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Escalation String Tests
// ─────────────────────────────────────────────────────────────────────────

console.log('\n--- Escalation String ---');

test('escalationToString handles NONE', () => {
  assert.strictEqual(escalationToString(ESCALATION.NONE), 'none');
  assert.strictEqual(escalationToString(0), 'none');
});

test('escalationToString handles INTERVAL', () => {
  assert.strictEqual(escalationToString(ESCALATION.INTERVAL), 'interval');
});

test('escalationToString handles single reasons', () => {
  assert.strictEqual(escalationToString(ESCALATION.VS_MAGNITUDE), 'vs_magnitude');
  assert.strictEqual(escalationToString(ESCALATION.GROUND_PROXIMITY), 'ground_proximity');
  assert.strictEqual(escalationToString(ESCALATION.GEAR_TRANSITION), 'gear_transition');
  assert.strictEqual(escalationToString(ESCALATION.GROUND_ROLL), 'ground_roll');
});

test('escalationToString handles combined reasons', () => {
  const combined = ESCALATION.VS_MAGNITUDE | ESCALATION.GROUND_PROXIMITY;
  const result = escalationToString(combined);
  assert.ok(result.includes('vs_magnitude'));
  assert.ok(result.includes('ground_proximity'));
});

// ─────────────────────────────────────────────────────────────────────────
// Factory Tests
// ─────────────────────────────────────────────────────────────────────────

console.log('\n--- Factory ---');

test('createVreEvaluator returns evaluator object', () => {
  const evaluator = createVreEvaluator();
  assert.ok(typeof evaluator.evaluate === 'function');
  assert.ok(typeof evaluator.reset === 'function');
  assert.ok(typeof evaluator.getState === 'function');
  assert.ok(typeof evaluator.forceSample === 'function');
});

test('evaluator starts in BASELINE band', () => {
  const evaluator = createVreEvaluator();
  const state = evaluator.getState();
  assert.strictEqual(state.band, BAND.BASELINE);
  assert.strictEqual(state.rateHz, 1);
});

test('evaluator accepts custom time source', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // First evaluation
  mockTime = 1000;
  evaluator.evaluate({ vs: 0, ra: 5000 });
  
  // Advance time by 1 second (BASELINE interval)
  mockTime = 2000;
  const result = evaluator.evaluate({ vs: 0, ra: 5000 });
  
  assert.ok(result.shouldSample);
});

// ─────────────────────────────────────────────────────────────────────────
// Escalation Trigger Tests
// ─────────────────────────────────────────────────────────────────────────

console.log('\n--- Escalation Triggers ---');

test('VS magnitude triggers ELEVATED at threshold', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  mockTime = 1000;
  const result = evaluator.evaluate({ vs: -1100, ra: 5000 }); // > 1000 fpm
  
  assert.ok(result.escalationReasons & ESCALATION.VS_MAGNITUDE);
  assert.strictEqual(result.band, BAND.ELEVATED);
});

test('VS magnitude at high altitude caps to ELEVATED (anti-spam)', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  mockTime = 1000;
  const result = evaluator.evaluate({ vs: -1600, ra: 5000, wow: false }); // > 1500 fpm, high altitude
  
  assert.ok(result.escalationReasons & ESCALATION.VS_MAGNITUDE);
  assert.strictEqual(result.band, BAND.ELEVATED);
});

test('steady high-altitude climb does not escalate from VS magnitude alone', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  const result = evaluator.evaluate({ vs: 1800, ra: 5000, wow: false, pitchRate: 0, rollRate: 0 });

  assert.equal(result.escalationReasons & ESCALATION.VS_MAGNITUDE, 0);
  assert.strictEqual(result.band, BAND.BASELINE);
});

test('low-altitude climb can still escalate from VS magnitude', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  const result = evaluator.evaluate({ vs: 1800, ra: 400, wow: false });

  assert.ok(result.escalationReasons & ESCALATION.VS_MAGNITUDE);
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);
});

test('VS magnitude near ground can trigger HIGH_FIDELITY', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  const result = evaluator.evaluate({ vs: -1600, ra: 200, wow: false }); // low altitude

  assert.ok(result.escalationReasons & ESCALATION.VS_MAGNITUDE);
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);
});

test('Ground proximity triggers escalation', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  mockTime = 1000;
  const result = evaluator.evaluate({ vs: -500, ra: 300 }); // RA < 500, descending
  
  assert.ok(result.escalationReasons & ESCALATION.GROUND_PROXIMITY);
});

test('Ground proximity ignores on-ground vertical-speed noise', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  const result = evaluator.evaluate({ vs: -1, ra: 10, wow: true, gs: 0 });

  assert.equal(result.escalationReasons & ESCALATION.GROUND_PROXIMITY, 0);
  assert.strictEqual(result.band, BAND.BASELINE);
});

test('High-speed ground roll triggers elevated sampling', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  const result = evaluator.evaluate({ vs: 0, ra: 10, wow: true, gs: 55, spoilerState: 'EXTENDED' });

  assert.ok(result.escalationReasons & ESCALATION.GROUND_ROLL);
  assert.strictEqual(result.band, BAND.ELEVATED);
  assert.strictEqual(result.rateHz, BAND_RATES[BAND.ELEVATED]);
});

test('Rollout decays from touchdown high-fidelity to elevated while still fast', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 0;
  evaluator.evaluate({ vs: -500, ra: 80, wow: false, gs: 130 });

  mockTime = 100;
  let result = evaluator.evaluate({ vs: -100, ra: 10, wow: true, gs: 80 });
  assert.ok(result.escalationReasons & ESCALATION.TOUCHDOWN);
  assert.ok(result.escalationReasons & ESCALATION.GROUND_ROLL);
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);

  mockTime = 2200;
  result = evaluator.evaluate({ vs: 0, ra: 10, wow: true, gs: 55 });
  assert.ok(result.escalationReasons & ESCALATION.GROUND_ROLL);
  assert.strictEqual(result.band, BAND.ELEVATED);
});

test('Slow taxi and parked frames stay baseline without ground roll trigger', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  const result = evaluator.evaluate({ vs: -0.3, ra: 10, wow: true, gs: 3, spoilerState: 'EXTENDED' });

  assert.equal(result.escalationReasons & ESCALATION.GROUND_ROLL, 0);
  assert.equal(result.escalationReasons & ESCALATION.GROUND_PROXIMITY, 0);
  assert.strictEqual(result.band, BAND.BASELINE);
});

test('RA delta at cruise altitude does not trigger high-rate terrain-following sampling', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  evaluator.evaluate({ vs: 7, ra: 33356, wow: false, phase: 'CRUISE' });

  mockTime = 2000;
  const result = evaluator.evaluate({ vs: 7, ra: 33000, wow: false, phase: 'CRUISE' });

  assert.equal(result.escalationReasons & ESCALATION.RA_DELTA, 0);
  assert.strictEqual(result.band, BAND.BASELINE);
});

test('RA delta near the ground still triggers high-fidelity sampling', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 1000;
  evaluator.evaluate({ vs: -500, ra: 1200, wow: false, phase: 'APPROACH' });

  mockTime = 2000;
  const result = evaluator.evaluate({ vs: -500, ra: 1050, wow: false, phase: 'APPROACH' });

  assert.ok(result.escalationReasons & ESCALATION.RA_DELTA);
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);
});

test('Gear transition triggers HIGH_FIDELITY', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // Initial state with gear up
  mockTime = 1000;
  evaluator.evaluate({ vs: 0, ra: 1000, gearDown: false });
  
  // Gear down transition
  mockTime = 1100;
  const result = evaluator.evaluate({ vs: 0, ra: 1000, gearDown: true });
  
  assert.ok(result.escalationReasons & ESCALATION.GEAR_TRANSITION);
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);
});

test('Flaps transition triggers ELEVATED', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // Initial state
  mockTime = 1000;
  evaluator.evaluate({ vs: 0, ra: 1000, flapsNotch: 'UP' });
  
  // Flaps change
  mockTime = 1100;
  const result = evaluator.evaluate({ vs: 0, ra: 1000, flapsNotch: 'FLAPS 1' });
  
  assert.ok(result.escalationReasons & ESCALATION.FLAPS_TRANSITION);
});

test('Touchdown (WOW transition) triggers HIGH_FIDELITY', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // Airborne
  mockTime = 1000;
  evaluator.evaluate({ vs: -500, ra: 10, wow: false });
  
  // Touchdown
  mockTime = 1100;
  const result = evaluator.evaluate({ vs: -100, ra: 0, wow: true });
  
  assert.ok(result.escalationReasons & ESCALATION.TOUCHDOWN);
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);
});

test('VS delta uses evaluation cadence, not last sampled cadence', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  // First sampled baseline frame
  mockTime = 1000;
  evaluator.evaluate({ vs: 0, ra: 5000, wow: false });

  // Intermediate calm frame that should not be sampled in BASELINE
  mockTime = 1500;
  evaluator.evaluate({ vs: 0, ra: 5000, wow: false });

  // Rapid change over 100ms should still trigger on this evaluation
  mockTime = 1600;
  const result = evaluator.evaluate({ vs: 100, ra: 5000, wow: false });

  assert.ok(result.escalationReasons & ESCALATION.VS_DELTA);
  assert.strictEqual(result.band, BAND.ELEVATED);
});

test('flare-zone ULTRA_FIDELITY is not downgraded by config transitions', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 0;
  evaluator.evaluate({
    vs: -500,
    ra: 80,
    wow: false,
    gearDown: false,
    flapsNotch: '0',
    spoilerState: 'STOWED',
  });

  mockTime = 100;
  const result = evaluator.evaluate({
    vs: -500,
    ra: 40,
    wow: false,
    gearDown: true,
    flapsNotch: '1',
    spoilerState: 'ARMED',
  });

  assert.ok(result.escalationReasons & ESCALATION.FLARE_ZONE, 'flare zone should be recorded');
  assert.ok(result.escalationReasons & ESCALATION.GEAR_TRANSITION, 'gear transition should still be recorded');
  assert.ok(result.escalationReasons & ESCALATION.FLAPS_TRANSITION, 'flap transition should still be recorded');
  assert.strictEqual(result.band, BAND.ULTRA_FIDELITY, 'lower-priority transition triggers must not downgrade flare sampling');
});

test('missing config values do not create false transitions', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 0;
  evaluator.evaluate({
    vs: 0,
    ra: 1000,
    gearDown: false,
    flapsNotch: '0',
    spoilerState: 'STOWED',
  });

  mockTime = 100;
  const result = evaluator.evaluate({
    vs: 0,
    ra: 1000,
    gearDown: null,
    flapsNotch: null,
    spoilerState: null,
  });

  assert.equal(result.escalationReasons & ESCALATION.GEAR_TRANSITION, 0, 'unknown gear state is not a gear transition');
  assert.equal(result.escalationReasons & ESCALATION.FLAPS_TRANSITION, 0, 'unknown flap state is not a flap transition');
  assert.equal(result.escalationReasons & ESCALATION.SPOILERS_TRANSITION, 0, 'unknown spoiler state is not a spoiler transition');
});

test('numeric and string flap notches compare as the same state', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 0;
  evaluator.evaluate({ vs: 0, ra: 1000, flapsNotch: 3 });

  mockTime = 100;
  const result = evaluator.evaluate({ vs: 0, ra: 1000, flapsNotch: '3' });

  assert.equal(result.escalationReasons & ESCALATION.FLAPS_TRANSITION, 0);
});

test('non-finite numeric inputs fall back without poisoning evaluator state', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 0;
  let result = evaluator.evaluate({ vs: NaN, ra: NaN, gForce: NaN, pitchRate: NaN });
  assert.strictEqual(result.band, BAND.BASELINE);

  mockTime = 100;
  result = evaluator.evaluate({ vs: 0, ra: 10000, gForce: 1, pitchRate: 0 });
  assert.equal(result.escalationReasons & ESCALATION.VS_DELTA, 0, 'NaN previous values must not create VS delta');
  assert.equal(result.escalationReasons & ESCALATION.RA_DELTA, 0, 'NaN previous values must not create RA delta');
  assert.equal(result.escalationReasons & ESCALATION.ACCEL_Z, 0, 'NaN previous values must not create acceleration delta');
});

// ─────────────────────────────────────────────────────────────────────────
// Sampling Interval Tests
// ─────────────────────────────────────────────────────────────────────────

console.log('\n--- Sampling Intervals ---');

test('BASELINE samples at ~1 Hz', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // First sample
  mockTime = 0;
  let result = evaluator.evaluate({ vs: 0, ra: 5000 });
  assert.ok(result.shouldSample, 'First sample should always be taken');
  
  // 500ms later - should NOT sample
  mockTime = 500;
  result = evaluator.evaluate({ vs: 0, ra: 5000 });
  assert.ok(!result.shouldSample, 'Should not sample at 500ms');
  
  // 1000ms later - should sample
  mockTime = 1000;
  result = evaluator.evaluate({ vs: 0, ra: 5000 });
  assert.ok(result.shouldSample, 'Should sample at 1000ms');
});

test('HIGH_FIDELITY samples at ~10 Hz', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // Trigger HIGH_FIDELITY with touchdown
  mockTime = 0;
  evaluator.evaluate({ vs: -500, ra: 10, wow: false });
  mockTime = 100;
  let result = evaluator.evaluate({ vs: -100, ra: 0, wow: true });
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);
  
  // 50ms later - should NOT sample
  mockTime = 150;
  result = evaluator.evaluate({ vs: 0, ra: 0, wow: true });
  assert.ok(!result.shouldSample, 'Should not sample at 50ms in HIGH_FIDELITY');
  
  // 100ms later - should sample
  mockTime = 200;
  result = evaluator.evaluate({ vs: 0, ra: 0, wow: true });
  assert.ok(result.shouldSample, 'Should sample at 100ms in HIGH_FIDELITY');
});

test('ULTRA_FIDELITY never samples faster than 10 Hz', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  let result = evaluator.evaluate({ vs: -300, ra: 40, wow: false });
  assert.strictEqual(result.band, BAND.ULTRA_FIDELITY);
  assert.ok(result.shouldSample, 'First Ultra sample should be taken');

  mockTime = 50;
  result = evaluator.evaluate({ vs: -300, ra: 40, wow: false });
  assert.ok(!result.shouldSample, 'Ultra must not sample again after only 50ms');

  mockTime = 100;
  result = evaluator.evaluate({ vs: -300, ra: 40, wow: false });
  assert.ok(result.shouldSample, 'Ultra may sample again after 100ms');
});

test('continuous ULTRA_FIDELITY survives 100 ticks but respects the 60-second hard cap', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  let result = evaluator.evaluate({ vs: -50, ra: 40, wow: false, gs: 130 });
  assert.strictEqual(result.band, BAND.ULTRA_FIDELITY);

  for (let tick = 1; tick < 600; tick++) {
    mockTime = tick * 100;
    result = evaluator.evaluate({
      vs: -50,
      ra: 35 + ((tick % 20) / 2),
      wow: false,
      gs: 130,
    });

    if (tick === 100) {
      assert.strictEqual(result.band, BAND.ULTRA_FIDELITY, '100 ordinary Ultra ticks must not be treated as stuck');
      assert.strictEqual(evaluator.getState().ultraFidelityDisabled, false);
    }
  }

  assert.strictEqual(result.band, BAND.ULTRA_FIDELITY, 'Ultra should remain available immediately before the hard cap');
  assert.strictEqual(evaluator.getState().ultraFidelitySampleCount, 599);

  mockTime = 60000;
  result = evaluator.evaluate({ vs: -50, ra: 40, wow: false, gs: 130 });
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY, 'Ultra should step down at the hard cap');
  assert.strictEqual(evaluator.getState().ultraFidelityDisabled, true);
  assert.strictEqual(evaluator.getState().ultraFidelitySampleCount, 600);
});

test('ULTRA_FIDELITY duration cap is independent of sample count and reset re-arms it', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  let result = evaluator.evaluate({ vs: -50, ra: 40, wow: false, gs: 130 });
  for (let tick = 1; tick <= 60; tick++) {
    mockTime = tick * 1000;
    result = evaluator.evaluate({ vs: -50, ra: 40, wow: false, gs: 130 });
  }

  let state = evaluator.getState();
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY, 'duration cap should step Ultra down after 60 seconds');
  assert.strictEqual(state.ultraFidelityDisabled, true);
  assert.strictEqual(state.ultraFidelityTotalMs, 60000);
  assert.strictEqual(state.ultraFidelitySampleCount, 60, 'duration cap should not depend on reaching 600 samples');

  evaluator.reset();
  state = evaluator.getState();
  assert.strictEqual(state.ultraFidelityDisabled, false);
  assert.strictEqual(state.ultraFidelityTotalMs, 0);
  assert.strictEqual(state.ultraFidelitySampleCount, 0);
  assert.strictEqual(state.ultraFidelityConsecutiveEvals, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Hysteresis Tests
// ─────────────────────────────────────────────────────────────────────────

console.log('\n--- Hysteresis ---');

test('Escalated band is held for minimum duration', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // Trigger HIGH_FIDELITY via non-VS dynamics
  mockTime = 0;
  evaluator.evaluate({ vs: -300, ra: 2000, wow: false, pitchRate: 7 }); // HIGH_FIDELITY
  
  // Calm conditions but still within hold period
  mockTime = 1000; // 1s later (< HOLD_MS)
  let result = evaluator.evaluate({ vs: 0, ra: 5000 });
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY, 'Should hold band during hold period');
});

test('Escalation reason persists while an escalated band is held', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 0;
  let result = evaluator.evaluate({ vs: -300, ra: 2000, wow: false, pitchRate: 7 });
  assert.ok(result.escalationReasons & ESCALATION.PITCH_RATE, 'initial escalation should record pitch rate');
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY);

  mockTime = 1000;
  result = evaluator.evaluate({ vs: 0, ra: 2000, wow: false, pitchRate: 0 });
  assert.strictEqual(result.band, BAND.HIGH_FIDELITY, 'hysteresis should hold high-fidelity sampling');
  assert.ok(result.escalationReasons & ESCALATION.PITCH_RATE, 'held high-rate sample should preserve the trigger reason');
  assert.notStrictEqual(result.escalationString, 'interval', 'held high-rate sample should not be encoded as interval');
});

test('Reset clears all state', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });
  
  // Escalate
  mockTime = 0;
  evaluator.evaluate({ vs: -1600, ra: 5000 });
  
  // Reset
  evaluator.reset();
  const state = evaluator.getState();
  
  assert.strictEqual(state.band, BAND.BASELINE);
  assert.strictEqual(state.escalationReasons, ESCALATION.NONE);
});

// ─────────────────────────────────────────────────────────────────────────
// Result Summary
// ─────────────────────────────────────────────────────────────────────────

test('ULTRA_FIDELITY re-arms after go-around before next flare', () => {
  let mockTime = 0;
  const evaluator = createVreEvaluator({ timeNow: () => mockTime });

  mockTime = 0;
  let result = evaluator.evaluate({ vs: -500, ra: 40, wow: false, gs: 140 });
  assert.strictEqual(result.band, BAND.ULTRA_FIDELITY, 'first flare should enter ULTRA_FIDELITY');

  mockTime = 100;
  evaluator.evaluate({ vs: 700, ra: 120, wow: false, gs: 145 });
  assert.strictEqual(evaluator.getState().ultraFidelityDisabled, true, 'go-around should suppress flare capture while exiting');

  mockTime = 300;
  evaluator.evaluate({ vs: 700, ra: 500, wow: false, gs: 150 });
  assert.strictEqual(evaluator.getState().ultraFidelityDisabled, false, 'airborne recovery should re-arm flare capture');

  mockTime = 500;
  result = evaluator.evaluate({ vs: -500, ra: 40, wow: false, gs: 140 });
  assert.strictEqual(result.band, BAND.ULTRA_FIDELITY, 'next approach should enter ULTRA_FIDELITY again');
});

console.log('\n' + '='.repeat(50));
if (testsFailed === 0) {
  console.log(`✅ All ${testsPassed} VRE evaluator tests passed!`);
} else {
  console.log(`❌ ${testsFailed} tests failed, ${testsPassed} passed`);
  process.exit(1);
}
