#!/usr/bin/env node
/**
 * test-flight-violation-runner.js
 * Unit tests for backend/flight-violations/flight-violation-runner.js
 *
 * Run: node tests/scripts/test-flight-violation-runner.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const {
  createFlightViolationRunner,
  UPSET_RULE,
  LOAD_FACTOR_RULE,
  APPROACH_SPEED_RULE,
} = require(resolveBackendRuntimeFile('flight-violations', 'flight-violation-runner.js'));

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

function assertTrue(val, msg = '') {
  if (!val) throw new Error(msg || 'Expected truthy');
}

// Helper: create a minimal broadcast spy
function makeBroadcastSpy() {
  const calls = [];
  const broadcast = (payload) => calls.push(payload);
  return { broadcast, calls };
}

function makeCsvWriterSpy() {
  const events = [];
  return {
    events,
    writer: {
      isRecording: () => true,
      writeEvent: (eventType, payload) => events.push({ eventType, payload }),
    },
  };
}

// Helper: build a minimal telemetry frame + timeCtx
// update(frame, broadcast, timeCtx, ctx) — timeCtx is a separate 3rd argument
function makeFrame(overrides = {}) {
  return {
    pitch: 0,
    bank: 0,
    gforce: 1.0,
    wow: false,
    ...overrides,
  };
}

function makeTimeCtx(nowEpochMs = Date.now()) {
  return { nowEpochMs, nowIso: new Date(nowEpochMs).toISOString() };
}

console.log('\n=== FlightViolationRunner Tests ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// UPSET_RULE constants
// ─────────────────────────────────────────────────────────────────────────────

console.log('--- UPSET_RULE constants ---\n');

test('UPSET_RULE exports are defined', () => {
  assertTrue(typeof UPSET_RULE === 'object', 'UPSET_RULE should be an object');
  assertTrue(Object.keys(UPSET_RULE).length > 0, 'UPSET_RULE should have entries');
});

// ─────────────────────────────────────────────────────────────────────────────
// createFlightViolationRunner: factory
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- createFlightViolationRunner ---\n');

test('createFlightViolationRunner returns update and reset functions', () => {
  const runner = createFlightViolationRunner();
  assertTrue(typeof runner.update === 'function', 'should have update()');
  assertTrue(typeof runner.reset === 'function', 'should have reset()');
});

test('update does not throw with normal in-envelope frame', () => {
  const runner = createFlightViolationRunner();
  const { broadcast } = makeBroadcastSpy();
  const frame = makeFrame({ pitch: 5, bank: 10, gforce: 1.1 });
  const timeCtx = makeTimeCtx();
  runner.update(frame, broadcast, timeCtx);
  // Successful completion verifies that missing callbacks are tolerated.
  assertTrue(true, 'update should not throw');
});

test('update does not broadcast violation for normal flight', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  // Normal cruise: pitch=5, bank=10, gforce=1.1
  const frame = makeFrame({ pitch: 5, bank: 10, gforce: 1.1 });
  const timeCtx = makeTimeCtx(1000);
  runner.update(frame, broadcast, timeCtx);
  const violations = calls.filter(c => c.type === 'flightViolation');
  assertEqual(violations.length, 0, 'should not broadcast violation for normal flight');
});

test('update does not broadcast violation when wow=true (on ground)', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  // Extreme pitch but on ground — should be ignored
  const frame = makeFrame({ pitch: 45, bank: 60, gforce: 3.5, wow: true });
  const timeCtx = makeTimeCtx(1000);
  runner.update(frame, broadcast, timeCtx);
  const violations = calls.filter(c => c.type === 'flightViolation');
  assertEqual(violations.length, 0, 'should not broadcast violation when on ground');
});

test('reset clears state without throwing', () => {
  const runner = createFlightViolationRunner();
  const { broadcast } = makeBroadcastSpy();
  const frame = makeFrame({ pitch: 5, bank: 10, gforce: 1.1 });
  const timeCtx = makeTimeCtx();
  runner.update(frame, broadcast, timeCtx);
  runner.reset();
  assertTrue(true, 'reset should not throw');
});

test('update after reset does not throw', () => {
  const runner = createFlightViolationRunner();
  const { broadcast } = makeBroadcastSpy();
  runner.reset();
  const frame = makeFrame({ pitch: 5, bank: 10, gforce: 1.1 });
  const timeCtx = makeTimeCtx();
  runner.update(frame, broadcast, timeCtx);
  assertTrue(true, 'update after reset should not throw');
});

test('update skips attitude rules when pitch/bank are null', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const frame = makeFrame({ pitch: null, bank: null, gforce: 1.0 });
  const timeCtx = makeTimeCtx(1000);
  runner.update(frame, broadcast, timeCtx);
  const violations = calls.filter(c => c.type === 'flightViolation');
  assertEqual(violations.length, 0, 'should not broadcast violation when pitch/bank are null');
});

test('update skips G rules when gforce is null', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const frame = makeFrame({ pitch: 5, bank: 10, gforce: null });
  const timeCtx = makeTimeCtx(1000);
  runner.update(frame, broadcast, timeCtx);
  const violations = calls.filter(c => c.type === 'flightViolation');
  assertEqual(violations.length, 0, 'should not broadcast violation when gforce is null');
});

// ─────────────────────────────────────────────────────────────────────────────
// Jitter guard: violation only fires after MIN_VIOLATION_DURATION_MS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Jitter guard ---\n');

test('violation does not fire immediately (jitter guard)', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  // Extreme bank angle — should trigger violation rule
  // But jitter guard requires it to persist for MIN_VIOLATION_DURATION_MS (500ms)
  const t = 1000;
  const frame = makeFrame({ pitch: 0, bank: 60 * Math.PI / 180, gforce: 1.0, wow: false });
  const timeCtx = makeTimeCtx(t);
  runner.update(frame, broadcast, timeCtx, { phase: 'CRUISE' });
  // Only 1 frame — jitter guard should prevent announcement
  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 0, 'violation should not fire immediately (jitter guard)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
test('sustained extreme bank is recorded as a bank upset violation in CSV', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const { events, writer } = makeCsvWriterSpy();
  const t = 4000;
  const bank60 = 60 * Math.PI / 180;
  const bank40 = 40 * Math.PI / 180;
  const ctx = { phase: 'CRUISE', flightCsvWriter: writer };

  runner.update(makeFrame({ pitch: 0, bank: bank60, wow: false }), broadcast, makeTimeCtx(t), ctx);
  runner.update(makeFrame({ pitch: 0, bank: bank60, wow: false }), broadcast, makeTimeCtx(t + 600), ctx);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(starts.length, 1, 'bank upset should broadcast after debounce');
  assertEqual(starts[0].rule_id, UPSET_RULE.BANK, 'sustained bank angle should map to upset_bank');
  assertEqual(starts[0].severity, 'critical', 'bank upset should be critical like pitch upset');
  assertTrue(Math.abs(starts[0].metrics.bankDeg - 60) < 0.001, 'broadcast should include bank angle in degrees');

  assertEqual(events.length, 1, 'CSV should receive one start event while violation is active');
  assertEqual(events[0].eventType, 'FLIGHT_VIOLATION_START', 'CSV should record violation start row');
  assertEqual(events[0].payload.rule_id, UPSET_RULE.BANK, 'CSV start row should identify upset_bank');
  assertEqual(events[0].payload.severity, 'critical', 'CSV start row should carry critical severity');
  assertTrue(Math.abs(events[0].payload.bank_deg - 60) < 0.001, 'CSV start row should include bank_deg');

  runner.update(makeFrame({ pitch: 0, bank: bank40, wow: false }), broadcast, makeTimeCtx(t + 1600), ctx);

  const ends = calls.filter(c => c.type === 'flightViolation' && c.event === 'end');
  assertEqual(ends.length, 1, 'bank upset should broadcast an end event after clearing below hysteresis');
  assertEqual(ends[0].rule_id, UPSET_RULE.BANK, 'end event should identify upset_bank');
  assertEqual(events.length, 2, 'CSV should receive start and end rows');
  assertEqual(events[1].eventType, 'FLIGHT_VIOLATION_END', 'CSV should record violation end row');
  assertEqual(events[1].payload.rule_id, UPSET_RULE.BANK, 'CSV end row should identify upset_bank');
  assertEqual(events[1].payload.duration_ms, 1600, 'CSV end row should include duration from initial threshold breach');
});

test('positive pitch is nose-up and triggers nose-up upset after debounce', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 1000;
  runner.update(makeFrame({ pitch: 30 * Math.PI / 180, bank: 0, wow: false }), broadcast, makeTimeCtx(t), { phase: 'CRUISE' });
  runner.update(makeFrame({ pitch: 30 * Math.PI / 180, bank: 0, wow: false }), broadcast, makeTimeCtx(t + 600), { phase: 'CRUISE' });
  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 1, 'nose-up violation should fire after debounce');
  assertEqual(violations[0].rule_id, UPSET_RULE.PITCH_NOSE_UP, 'positive pitch should map to nose-up');
});

test('negative pitch is nose-down and triggers nose-down upset after debounce', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 2000;
  runner.update(makeFrame({ pitch: -15 * Math.PI / 180, bank: 0, wow: false }), broadcast, makeTimeCtx(t), { phase: 'CRUISE' });
  runner.update(makeFrame({ pitch: -15 * Math.PI / 180, bank: 0, wow: false }), broadcast, makeTimeCtx(t + 600), { phase: 'CRUISE' });
  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 1, 'nose-down violation should fire after debounce');
  assertEqual(violations[0].rule_id, UPSET_RULE.PITCH_NOSE_DOWN, 'negative pitch should map to nose-down');
});

test('top-level gforce is accepted for high-load-factor rules', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 3000;
  runner.update(makeFrame({ gforce: 2.8, wow: false }), broadcast, makeTimeCtx(t), { phase: 'CRUISE' });
  runner.update(makeFrame({ gforce: 2.8, wow: false }), broadcast, makeTimeCtx(t + 600), { phase: 'CRUISE' });
  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 1, 'G-force violation should fire after debounce');
  assertEqual(violations[0].rule_id, UPSET_RULE.GFORCE_HIGH, 'top-level gforce should be evaluated');
  assertEqual(violations[0].counts_as_upset, true, 'high load-factor alert should count as an upset event');
});

test('warmup suppresses violation arming until stable telemetry resumes', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 4000;

  runner.update(makeFrame({ gforce: 2.8, wow: false }), broadcast, makeTimeCtx(t), { phase: 'CRUISE', warmup: true });
  runner.update(makeFrame({ gforce: 2.8, wow: false }), broadcast, makeTimeCtx(t + 1000), { phase: 'CRUISE', warmup: true });

  let violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 0, 'warmup samples should not arm or announce G-force violations');

  runner.update(makeFrame({ gforce: 2.8, wow: false }), broadcast, makeTimeCtx(t + 1100), { phase: 'CRUISE', warmup: false });
  runner.update(makeFrame({ gforce: 2.8, wow: false }), broadcast, makeTimeCtx(t + 1700), { phase: 'CRUISE', warmup: false });

  violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 1, 'post-warmup sustained G-force violation should still fire');
  assertEqual(violations[0].rule_id, UPSET_RULE.GFORCE_HIGH, 'post-warmup violation should use hard G-force rule');
});

test('load factor advisory fires below the generic high-load threshold without counting as upset', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const { events, writer } = makeCsvWriterSpy();
  const t = 4500;
  const ctx = { phase: 'CRUISE', flightCsvWriter: writer };

  runner.update(makeFrame({ gforce: 1.9, wow: false }), broadcast, makeTimeCtx(t), ctx);
  runner.update(makeFrame({ gforce: 1.9, wow: false }), broadcast, makeTimeCtx(t + 600), ctx);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(starts.length, 1, 'load factor advisory should broadcast after debounce');
  assertEqual(starts[0].rule_id, LOAD_FACTOR_RULE.ADVISORY, 'advisory should use its own rule id');
  assertEqual(starts[0].severity, 'warning', 'advisory should be a warning-level caution');
  assertEqual(starts[0].counts_as_upset, false, 'advisory should not count as an upset event');
  assertEqual(starts[0].metrics.gForce, 1.9, 'advisory should include the measured G-force');

  assertEqual(events.length, 1, 'CSV should receive one advisory start row');
  assertEqual(events[0].payload.rule_id, LOAD_FACTOR_RULE.ADVISORY, 'CSV should identify load factor advisory');
  assertEqual(events[0].payload.counts_as_upset, false, 'CSV should preserve advisory upset-count flag');
});

test('approach overspeed allows category buffer before warning', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 5000;
  const frame = makeFrame({
    display: { iasKts: 160, raFt: 800, vsFpm: -700 },
    wow: false,
  });

  runner.update(frame, broadcast, makeTimeCtx(t), { phase: 'APPROACH' });
  runner.update(frame, broadcast, makeTimeCtx(t + 2100), { phase: 'APPROACH' });

  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 0, 'Cat C max 140 + 20 kt buffer should not warn at 160 kt');
});

test('approach overspeed requires sustained exceedance before warning', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 5500;
  const frame = makeFrame({
    display: { iasKts: 181, raFt: 800, vsFpm: -700 },
    wow: false,
  });

  runner.update(frame, broadcast, makeTimeCtx(t), { phase: 'APPROACH' });
  runner.update(frame, broadcast, makeTimeCtx(t + 600), { phase: 'APPROACH' });

  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 0, 'approach overspeed should use the longer 2s debounce');
});

test('sustained approach overspeed is recorded with speed envelope metrics', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const { events, writer } = makeCsvWriterSpy();
  const t = 6000;
  const ctx = { phase: 'APPROACH', flightCsvWriter: writer };
  const fastFrame = makeFrame({
    display: { iasKts: 181, raFt: 800, vsFpm: -700 },
    wow: false,
  });
  const clearFrame = makeFrame({
    display: { iasKts: 149, raFt: 700, vsFpm: -600 },
    wow: false,
  });

  runner.update(fastFrame, broadcast, makeTimeCtx(t), ctx);
  runner.update(fastFrame, broadcast, makeTimeCtx(t + 2100), ctx);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(starts.length, 1, 'approach overspeed should broadcast after debounce');
  assertEqual(starts[0].rule_id, APPROACH_SPEED_RULE.APPROACH_OVERSPEED, 'rule id should identify approach overspeed');
  assertEqual(starts[0].severity, 'warning', 'approach overspeed should be warning severity');
  assertEqual(starts[0].metrics.maxApproachKts, 140, 'Cat C max approach threshold should be recorded');
  assertEqual(starts[0].metrics.approachOverspeedLimitKts, 160, '20 kt buffer should be applied');
  assertEqual(starts[0].metrics.approachOverspeedExcessKts, 21, 'excess over buffered limit should be recorded');

  assertEqual(events.length, 1, 'CSV should receive one start row while active');
  assertEqual(events[0].payload.rule_id, APPROACH_SPEED_RULE.APPROACH_OVERSPEED, 'CSV start row should identify approach overspeed');
  assertEqual(events[0].payload.ias_kts, 181, 'CSV start row should include IAS');
  assertEqual(events[0].payload.max_approach_kts, 140, 'CSV start row should include category max approach');
  assertEqual(events[0].payload.approach_overspeed_limit_kts, 160, 'CSV start row should include buffered limit');

  runner.update(clearFrame, broadcast, makeTimeCtx(t + 3600), ctx);

  const ends = calls.filter(c => c.type === 'flightViolation' && c.event === 'end');
  assertEqual(ends.length, 1, 'approach overspeed should clear with hysteresis');
  assertEqual(ends[0].rule_id, APPROACH_SPEED_RULE.APPROACH_OVERSPEED, 'end event should identify approach overspeed');
  assertEqual(events.length, 2, 'CSV should receive start and end rows');
  assertEqual(events[1].payload.duration_ms, 3600, 'CSV end row should include duration from threshold breach');
});

test('approach overspeed does not arm outside the approach gate', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 7000;
  const frame = makeFrame({
    display: { iasKts: 250, raFt: 1500, vsFpm: -700 },
    wow: false,
  });

  runner.update(frame, broadcast, makeTimeCtx(t), { phase: 'DESCENT' });
  runner.update(frame, broadcast, makeTimeCtx(t + 2100), { phase: 'DESCENT' });

  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 0, 'high descent speed above approach gate should not be an approach overspeed');
});

test('approach overspeed requires the lifecycle approach phase', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 8000;
  const frame = makeFrame({
    display: { iasKts: 250, raFt: 800, vsFpm: -700 },
    wow: false,
  });

  runner.update(frame, broadcast, makeTimeCtx(t), { phase: 'DESCENT' });
  runner.update(frame, broadcast, makeTimeCtx(t + 2100), { phase: 'DESCENT' });

  const violations = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  assertEqual(violations.length, 0, 'low descending high speed should not warn until phase is APPROACH');
});

test('approach overspeed does not announce after leaving approach before debounce completes', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const t = 9000;
  const frame = makeFrame({
    display: { iasKts: 250, raFt: 800, vsFpm: -700 },
    wow: false,
  });

  runner.update(frame, broadcast, makeTimeCtx(t), { phase: 'APPROACH' });
  runner.update(frame, broadcast, makeTimeCtx(t + 2100), { phase: 'DESCENT' });

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const ends = calls.filter(c => c.type === 'flightViolation' && c.event === 'end');
  assertEqual(starts.length, 0, 'approach overspeed should not start once phase has left approach');
  assertEqual(ends.length, 0, 'unannounced approach overspeed should clear silently');
});

test('spoiler movement never produces a flight violation', () => {
  const runner = createFlightViolationRunner();
  const { broadcast, calls } = makeBroadcastSpy();
  const { events, writer } = makeCsvWriterSpy();
  const t = 11000;
  const ctx = { phase: 'APPROACH', flightCsvWriter: writer };
  const deployedFrame = makeFrame({
    display: { iasKts: 138, raFt: 700, vsFpm: -650 },
    spoilers: { percent: 76, state: 'EXTENDED' },
    wow: false,
  });
  const clearFrame = makeFrame({
    display: { iasKts: 135, raFt: 500, vsFpm: -600 },
    spoilers: { percent: 0, state: 'STOWED' },
    wow: false,
  });

  runner.update(deployedFrame, broadcast, makeTimeCtx(t), ctx);
  runner.update(deployedFrame, broadcast, makeTimeCtx(t + 2500), ctx);
  runner.update(clearFrame, broadcast, makeTimeCtx(t + 4000), ctx);

  const starts = calls.filter(c => c.type === 'flightViolation' && c.event === 'start');
  const ends = calls.filter(c => c.type === 'flightViolation' && c.event === 'end');
  assertEqual(starts.length, 0, 'deployed spoilers should not broadcast a violation');
  assertEqual(ends.length, 0, 'stowing spoilers should not broadcast a violation end');
  assertEqual(events.length, 0, 'spoiler movement should not write violation rows to CSV');
});

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
