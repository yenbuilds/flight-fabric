/**
 * Core module tests: units.js, message-types.js, event-bus.js, time-source.js
 * These are foundational modules that should have thorough test coverage.
 * 
 * Run: node tests/scripts/test-core-modules.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

// Test framework
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual, expected, tolerance = 0.001, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(msg || `Expected ~${expected}, got ${actual}`);
  }
}

function assertTrue(val, msg) {
  if (!val) throw new Error(msg || 'Expected true');
}

function assertThrows(fn, msg) {
  try {
    fn();
    throw new Error(msg || 'Expected to throw');
  } catch (e) {
    if (e.message === (msg || 'Expected to throw')) throw e;
    // Expected exception
  }
}

// =============================================================================
// units.js Tests
// =============================================================================

console.log('\n=== units.js Tests ===');

const units = require(resolveBackendRuntimeFile('utils', 'units.js'));

test('M_TO_FT constant is ~3.28', () => {
  assertApprox(units.M_TO_FT, 3.28084, 0.00001);
});

test('MS_TO_FPM constant is ~196.85', () => {
  assertApprox(units.MS_TO_FPM, 196.8504, 0.001);
});

test('FPM_TO_MS constant is ~0.00508', () => {
  assertApprox(units.FPM_TO_MS, 1/196.8504, 0.00001);
});

test('FPS_TO_FPM constant is 60', () => {
  assertEqual(units.FPS_TO_FPM, 60);
});

test('metersToFeet(100) = 328.084', () => {
  assertApprox(units.metersToFeet(100), 328.084, 0.01);
});

test('metersToFeet(0) = 0', () => {
  assertEqual(units.metersToFeet(0), 0);
});

test('metersToFeet(NaN) = 0 (defensive)', () => {
  assertEqual(units.metersToFeet(NaN), 0);
});

test('metersToFeet(null) = 0 (defensive)', () => {
  assertEqual(units.metersToFeet(null), 0);
});

test('metersToFeet(undefined) = 0 (defensive)', () => {
  assertEqual(units.metersToFeet(undefined), 0);
});

test('feetToMeters(328.084) ≈ 100', () => {
  assertApprox(units.feetToMeters(328.084), 100, 0.01);
});

test('metersToFeet ∘ feetToMeters = identity', () => {
  const val = 500;
  assertApprox(units.metersToFeet(units.feetToMeters(val)), val, 0.001);
});

test('msToFpm(-3.5) ≈ -689 fpm', () => {
  assertApprox(units.msToFpm(-3.5), -688.98, 0.1);
});

test('msToFpm(0) = 0', () => {
  assertEqual(units.msToFpm(0), 0);
});

test('msToFpm(NaN) = 0 (defensive)', () => {
  assertEqual(units.msToFpm(NaN), 0);
});

test('fpmToMs(-700) ≈ -3.556 m/s', () => {
  assertApprox(units.fpmToMs(-700), -3.556, 0.01);
});

test('msToFpm ∘ fpmToMs = identity', () => {
  const val = -500;
  assertApprox(units.msToFpm(units.fpmToMs(val)), val, 0.001);
});

test('MS_TO_KTS ≈ 1.944', () => {
  assertApprox(units.MS_TO_KTS, 1.94384, 0.0001);
});

test('sanity bounds: VS_MAX_MS = 50', () => {
  assertEqual(units.VS_MAX_MS, 50);
});

test('sanity bounds: RA_MAX_M = 15000', () => {
  assertEqual(units.RA_MAX_M, 15000);
});

// =============================================================================
// message-types.js Tests
// =============================================================================

console.log('\n=== message-types.js Tests ===');

const { MSG, PHASE, ENVELOPE_STATUS } = require(resolveBackendRuntimeFile('core', 'message-types.js'));

test('MSG is frozen (immutable)', () => {
  assertTrue(Object.isFrozen(MSG));
});

test('MSG.IAS = "ias"', () => {
  assertEqual(MSG.IAS, 'ias');
});

test('MSG.VS = "vs"', () => {
  assertEqual(MSG.VS, 'vs');
});

test('MSG.ALTITUDE = "altitude"', () => {
  assertEqual(MSG.ALTITUDE, 'altitude');
});

test('MSG.PHASE = "phase"', () => {
  assertEqual(MSG.PHASE, 'phase');
});

test('MSG.ENVELOPE_STATUS = "envelopeStatus"', () => {
  assertEqual(MSG.ENVELOPE_STATUS, 'envelopeStatus');
});

test('MSG.GEAR = "gear"', () => {
  assertEqual(MSG.GEAR, 'gear');
});

test('MSG.FLAPS = "flaps"', () => {
  assertEqual(MSG.FLAPS, 'flaps');
});

test('MSG.LANDING = "landing"', () => {
  assertEqual(MSG.LANDING, 'landing');
});

test('MSG.POSITION = "position"', () => {
  assertEqual(MSG.POSITION, 'position');
});

test('MSG.FLIGHT_VIOLATION = "flightViolation"', () => {
  assertEqual(MSG.FLIGHT_VIOLATION, 'flightViolation');
});

test('MSG.SHOW_BRANDING = "showBranding"', () => {
  assertEqual(MSG.SHOW_BRANDING, 'showBranding');
});

test('MSG.SIM_STATE = "simState"', () => {
  assertEqual(MSG.SIM_STATE, 'simState');
});

test('MSG.SAFETY_DATA = "safetyData"', () => {
  assertEqual(MSG.SAFETY_DATA, 'safetyData');
});

const broadcasters = require(resolveBackendRuntimeFile('events', 'broadcasters.js'));

test('environment broadcast can carry OAT without cabin altitude', () => {
  const payload = broadcasters.buildEnvironmentBroadcastPayload({
    cabinAltFt: null,
    cabinAltRateFpm: null,
    cabinAltTargetFt: null,
    oatC: 12.4,
  });

  assertEqual(payload.type, MSG.ENVIRONMENT);
  assertEqual(payload.cabinAltFt, null);
  assertEqual(payload.cabinAltRateFpm, null);
  assertEqual(payload.cabinAltTargetFt, null);
  assertEqual(payload.oatC, 12);
});

test('MSG.DESTINATION_TARGET = "destinationTarget"', () => {
  assertEqual(MSG.DESTINATION_TARGET, 'destinationTarget');
});

test('PHASE is frozen', () => {
  assertTrue(Object.isFrozen(PHASE));
});

test('PHASE.PARKED = "PARKED"', () => {
  assertEqual(PHASE.PARKED, 'PARKED');
});

test('PHASE.CRUISE = "CRUISE"', () => {
  assertEqual(PHASE.CRUISE, 'CRUISE');
});

test('PHASE.APPROACH = "APPROACH"', () => {
  assertEqual(PHASE.APPROACH, 'APPROACH');
});

test('PHASE.GO_AROUND = "GO_AROUND"', () => {
  assertEqual(PHASE.GO_AROUND, 'GO_AROUND');
});

test('ENVELOPE_STATUS is frozen', () => {
  assertTrue(Object.isFrozen(ENVELOPE_STATUS));
});

test('ENVELOPE_STATUS.IN_ENVELOPE = "IN_ENVELOPE"', () => {
  assertEqual(ENVELOPE_STATUS.IN_ENVELOPE, 'IN_ENVELOPE');
});

test('ENVELOPE_STATUS.OUT_OF_ENVELOPE = "OUT_OF_ENVELOPE"', () => {
  assertEqual(ENVELOPE_STATUS.OUT_OF_ENVELOPE, 'OUT_OF_ENVELOPE');
});

test('ENVELOPE_STATUS.NOT_APPLICABLE = "--"', () => {
  assertEqual(ENVELOPE_STATUS.NOT_APPLICABLE, '--');
});

// =============================================================================
// event-bus.js Tests
// =============================================================================

console.log('\n=== event-bus.js Tests ===');

// Import fresh for each run to reset state
const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));

test('on() returns unsubscribe function', () => {
  const unsub = eventBus.on('test:event', () => {});
  assertEqual(typeof unsub, 'function');
  unsub();
});

test('emit() delivers to subscribers', () => {
  let received = null;
  eventBus.on('test:delivery', (payload) => { received = payload; });
  eventBus.emit('test:delivery', { value: 42 });
  assertEqual(received?.value, 42);
});

test('unsubscribe stops delivery', () => {
  let count = 0;
  const unsub = eventBus.on('test:unsub', () => { count++; });
  eventBus.emit('test:unsub', {});
  assertEqual(count, 1);
  unsub();
  eventBus.emit('test:unsub', {});
  assertEqual(count, 1); // No change after unsubscribe
});

test('multiple subscribers receive same event', () => {
  let count = 0;
  eventBus.on('test:multi', () => { count++; });
  eventBus.on('test:multi', () => { count++; });
  eventBus.emit('test:multi', {});
  assertEqual(count, 2);
});

test('off() removes specific handler', () => {
  let count = 0;
  const handler = () => { count++; };
  eventBus.on('test:off', handler);
  eventBus.emit('test:off', {});
  assertEqual(count, 1);
  eventBus.off('test:off', handler);
  eventBus.emit('test:off', {});
  assertEqual(count, 1);
});

test('once() fires only once', () => {
  let count = 0;
  eventBus.once('test:once', () => { count++; });
  eventBus.emit('test:once', {});
  eventBus.emit('test:once', {});
  assertEqual(count, 1);
});

test('emit to non-existent event does not throw', () => {
  eventBus.emit('test:nonexistent', { data: 1 });
  // Should not throw
});

test('handler error does not break other handlers', () => {
  let secondCalled = false;
  eventBus.on('test:error', () => { throw new Error('Intentional'); });
  eventBus.on('test:error', () => { secondCalled = true; });
  eventBus.emit('test:error', {});
  assertTrue(secondCalled, 'Second handler should be called');
});

test('on() throws for non-function handler', () => {
  assertThrows(() => eventBus.on('test:bad', 'not-a-function'));
});

test('listenerCount returns correct count', () => {
  const event = 'test:count:' + Date.now();
  assertEqual(eventBus.listenerCount(event), 0);
  eventBus.on(event, () => {});
  assertEqual(eventBus.listenerCount(event), 1);
  eventBus.on(event, () => {});
  assertEqual(eventBus.listenerCount(event), 2);
});

test('removeAllListeners clears event', () => {
  const event = 'test:removeAll:' + Date.now();
  eventBus.on(event, () => {});
  eventBus.on(event, () => {});
  eventBus.removeAllListeners(event);
  assertEqual(eventBus.listenerCount(event), 0);
});

// =============================================================================
// time-source.js Tests
// =============================================================================

console.log('\n=== time-source.js Tests ===');

const timeSource = require(resolveBackendRuntimeFile('core', 'time-source.js'));

// Reset to wall clock before each test group
timeSource.resetTimeSource();

test('now() returns number', () => {
  assertEqual(typeof timeSource.now(), 'number');
});

test('now() returns reasonable timestamp', () => {
  const ts = timeSource.now();
  assertTrue(ts > 1700000000000, 'Should be after 2023');
  assertTrue(ts < 2000000000000, 'Should be before 2033');
});

test('nowIso() returns ISO string', () => {
  const iso = timeSource.nowIso();
  assertEqual(typeof iso, 'string');
  assertTrue(iso.includes('T'), 'Should contain T separator');
  assertTrue(iso.endsWith('Z'), 'Should end with Z');
});

test('nowIso() parses back to same time', () => {
  const before = timeSource.now();
  const iso = timeSource.nowIso();
  const parsed = new Date(iso).getTime();
  const after = timeSource.now();
  assertTrue(parsed >= before && parsed <= after, 'Parsed time should be in range');
});

test('setTimeSource injects custom time', () => {
  const fakeTime = 1234567890000;
  timeSource.setTimeSource(() => fakeTime);
  assertEqual(timeSource.now(), fakeTime);
  timeSource.resetTimeSource();
});

test('setTimeSource derives ISO from ms if not provided', () => {
  const fakeTime = 1609459200000; // 2021-01-01T00:00:00.000Z
  timeSource.setTimeSource(() => fakeTime);
  assertEqual(timeSource.nowIso(), '2021-01-01T00:00:00.000Z');
  timeSource.resetTimeSource();
});

test('setTimeSource accepts custom ISO function', () => {
  timeSource.setTimeSource(() => 0, () => 'CUSTOM-ISO');
  assertEqual(timeSource.nowIso(), 'CUSTOM-ISO');
  timeSource.resetTimeSource();
});

test('setTimeSource throws for non-function', () => {
  assertThrows(() => timeSource.setTimeSource('not-a-function'));
});

test('createFixedSource allows advancing time', () => {
  const source = timeSource.createFixedSource(1000);
  assertEqual(timeSource.now(), 1000);
  source.advance(500);
  assertEqual(timeSource.now(), 1500);
  timeSource.resetTimeSource();
});

test('createFixedSource allows setting time', () => {
  const source = timeSource.createFixedSource(1000);
  source.set(5000);
  assertEqual(timeSource.now(), 5000);
  timeSource.resetTimeSource();
});

test('resetTimeSource restores wall clock', () => {
  timeSource.setTimeSource(() => 0);
  assertEqual(timeSource.now(), 0);
  timeSource.resetTimeSource();
  assertTrue(timeSource.now() > 1700000000000, 'Should be back to wall clock');
});

test('createContext bundles time info', () => {
  const fakeTime = 1609459200000;
  timeSource.setTimeSource(() => fakeTime);
  
  const ctx = timeSource.createContext(1609459100000, '2021-01-01T00:00:00.000Z');
  assertEqual(ctx.nowEpochMs, fakeTime);
  assertEqual(ctx.nowIso, '2021-01-01T00:00:00.000Z');
  assertEqual(ctx.flightStartEpochMs, 1609459100000);
  assertEqual(ctx.flightStartIso, '2021-01-01T00:00:00.000Z');
  
  timeSource.resetTimeSource();
});

test('createContext without flight start', () => {
  timeSource.resetTimeSource();
  const ctx = timeSource.createContext();
  assertTrue(ctx.nowEpochMs > 0);
  assertEqual(ctx.flightStartEpochMs, null);
  assertEqual(ctx.flightStartIso, '');
});

// =============================================================================
// =============================================================================
// Summary
// =============================================================================

console.log('\n' + '─'.repeat(60));
console.log(`Core module tests: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(60));

if (failed > 0) {
  console.log('FAILED');
  process.exit(1);
}
console.log('All tests passed ✓');
