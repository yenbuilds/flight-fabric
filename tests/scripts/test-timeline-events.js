#!/usr/bin/env node
/**
 * test-timeline-events.js
 * Unit tests for backend/events/timeline-events.js (createTimelineStore)
 *
 * Run: node tests/scripts/test-timeline-events.js
 */

'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const {
  createTimelineStore,
  TIMELINE_EVENT_TYPE,
  SEVERITY,
  MARKER_TYPE,
  startTimeline,
  endTimeline,
  isRecording,
  getActiveStore,
} = require(resolveBackendRuntimeFile('events', 'timeline-events.js'));

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

function assertNull(val, msg = '') {
  if (val !== null) throw new Error(`${msg} Expected null, got ${JSON.stringify(val)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// createTimelineStore: basic construction
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== createTimelineStore Tests ===\n');

test('creates store with empty events', () => {
  const store = createTimelineStore({ flightId: 'test-001' });
  const tl = store.getTimeline();
  assertTrue(Array.isArray(tl.events), 'events should be array');
  assertEqual(tl.events.length, 0, 'events should be empty');
});

test('getTimeline returns flightId', () => {
  const store = createTimelineStore({ flightId: 'flight-abc' });
  const tl = store.getTimeline();
  assertEqual(tl.flightId, 'flight-abc', 'flightId');
});

test('initial currentPhase is null', () => {
  const store = createTimelineStore({ flightId: 'test' });
  assertNull(store.currentPhase, 'currentPhase should start null');
});

// ─────────────────────────────────────────────────────────────────────────────
// recordPhaseChange
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- recordPhaseChange ---\n');

test('recordPhaseChange adds a phase_start event', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('CLIMB', { timestampMs: 1000 });
  const tl = store.getTimeline();
  assertEqual(tl.events.length, 1, 'should have 1 event');
  assertEqual(tl.events[0].event_type, TIMELINE_EVENT_TYPE.PHASE_START, 'event_type');
  assertEqual(tl.events[0].phase_name, 'CLIMB', 'phase_name');
});

test('recordPhaseChange updates currentPhase', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('CRUISE', { timestampMs: 2000 });
  assertEqual(store.currentPhase, 'CRUISE', 'currentPhase should update');
});

test('recordPhaseChange records multiple phases in order', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('TAXI', { timestampMs: 1000 });
  store.recordPhaseChange('TAKEOFF', { timestampMs: 2000 });
  store.recordPhaseChange('CLIMB', { timestampMs: 3000 });
  const tl = store.getTimeline();
  // Each phase transition emits phase_end for previous + phase_start for new
  // 3 phases = 2 phase_end + 3 phase_start = 5 events
  const starts = tl.events.filter(e => e.event_type === TIMELINE_EVENT_TYPE.PHASE_START);
  assertEqual(starts.length, 3, 'should have 3 phase_start events');
  assertEqual(starts[0].phase_name, 'TAXI');
  assertEqual(starts[1].phase_name, 'TAKEOFF');
  assertEqual(starts[2].phase_name, 'CLIMB');
});

// ─────────────────────────────────────────────────────────────────────────────
// startViolation / endViolation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- startViolation / endViolation ---\n');

test('startViolation adds a violation_start event', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.startViolation('BANK_ANGLE', SEVERITY.WARNING, { bankDeg: 35 });
  const tl = store.getTimeline();
  const ev = tl.events.find(e => e.event_type === TIMELINE_EVENT_TYPE.VIOLATION_START);
  assertTrue(ev != null, 'should have violation_start event');
  assertEqual(ev.rule_id, 'BANK_ANGLE', 'rule_id');
  assertEqual(ev.severity, SEVERITY.WARNING, 'severity');
});

test('endViolation adds a violation_end event', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.startViolation('PITCH_UP', SEVERITY.CRITICAL, { pitchDeg: 25 });
  store.endViolation('PITCH_UP', -10);
  const tl = store.getTimeline();
  const endEv = tl.events.find(e => e.event_type === TIMELINE_EVENT_TYPE.VIOLATION_END);
  assertTrue(endEv != null, 'should have violation_end event');
  assertEqual(endEv.rule_id, 'PITCH_UP', 'rule_id');
});

test('endViolation without prior startViolation does not crash', () => {
  const store = createTimelineStore({ flightId: 'test' });
  // Should not throw
  store.endViolation('NONEXISTENT_RULE', 0);
  const tl = store.getTimeline();
  const endEv = tl.events.find(e => e.event_type === TIMELINE_EVENT_TYPE.VIOLATION_END);
  assertTrue(endEv == null, 'should not add violation_end for unknown rule');
});

// ─────────────────────────────────────────────────────────────────────────────
// recordMarker
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- recordMarker ---\n');

test('recordMarker adds a marker event', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordMarker(MARKER_TYPE.TOUCHDOWN, { timestampMs: 5000 });
  const tl = store.getTimeline();
  const ev = tl.events.find(e => e.event_type === TIMELINE_EVENT_TYPE.MARKER);
  assertTrue(ev != null, 'should have marker event');
  assertEqual(ev.marker_type, MARKER_TYPE.TOUCHDOWN, 'marker_type');
});

// ─────────────────────────────────────────────────────────────────────────────
// recordScoreChange / recordScoreFinal
// ─────────────────────────────────────────────────────────────────────────────

test('recordMarker preserves timestamp 0 from time source', () => {
  const times = [0, 1234];
  let index = 0;
  const store = createTimelineStore({
    flightId: 'test',
    timeNow: () => times[index++] ?? 9999,
  });
  store.recordMarker(MARKER_TYPE.TOUCHDOWN);
  const tl = store.getTimeline();
  assertEqual(tl.events[0].timestamp_ms, 0, 'timestamp_ms');
});

console.log('\n--- recordScoreChange / recordScoreFinal ---\n');

test('recordScoreChange adds a score_change event', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordScoreChange('bank_angle_penalty', -10, 'BANK_ANGLE', { bankDeg: 35 });
  const tl = store.getTimeline();
  const ev = tl.events.find(e => e.event_type === TIMELINE_EVENT_TYPE.SCORE_CHANGE);
  assertTrue(ev != null, 'should have score_change event');
  assertEqual(ev.score_delta, -10, 'score_delta');
});

test('recordScoreFinal adds a score_final event', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordScoreFinal('stability', 85, { glidepath_ok: true });
  const tl = store.getTimeline();
  const ev = tl.events.find(e => e.event_type === TIMELINE_EVENT_TYPE.SCORE_FINAL);
  assertTrue(ev != null, 'should have score_final event');
  assertEqual(ev.final_score, 85, 'final_score');
});

test('event IDs remain unique after the retained-event cap is exceeded', () => {
  const store = createTimelineStore({ flightId: 'cap-flight', timeNow: () => 1000 });
  for (let index = 0; index < 10000; index++) {
    store.recordScoreFinal('capacity', index);
  }
  const worst = store.recordScoreChange('worst', -10);
  store.recordScoreFinal('after-cap', 1);
  const timeline = store.finalize();
  const ids = timeline.events.map((event) => event.id);
  const worstMarkers = timeline.events.filter((event) => (
    event.event_type === TIMELINE_EVENT_TYPE.WORST_MOMENT
  ));

  assertEqual(timeline.events.length, 10000, 'retained event cap');
  assertEqual(new Set(ids).size, ids.length, 'retained event IDs must be unique');
  assertEqual(worst.id, 'cap-flight-10000', 'counter continues beyond retained length');
  assertEqual(worstMarkers.length, 1, 'one worst-moment marker');
  assertEqual(worstMarkers[0].worst_event_id, worst.id, 'worst marker references the original event');
  assertEqual(ids.filter((id) => id === worst.id).length, 1, 'worst_event_id resolves unambiguously');
});

// ─────────────────────────────────────────────────────────────────────────────
// getEventsInWindow
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- getEventsInWindow ---\n');

test('getEventsInWindow returns events within time range', () => {
  // NOTE: timeline-events uses Date.now() for timestamp_ms, not the passed-in timestampMs.
  // So we use violation events (which use the passed-in timestamp) for window testing.
  const store = createTimelineStore({ flightId: 'test' });
  const now = Date.now();
  store.startViolation('RULE_A', SEVERITY.WARNING, { ts: now - 5000 });
  store.startViolation('RULE_B', SEVERITY.WARNING, { ts: now });
  store.startViolation('RULE_C', SEVERITY.WARNING, { ts: now + 5000 });
  const tl = store.getTimeline();
  // All 3 events exist
  assertEqual(tl.events.length, 3, 'should have 3 events');
  // getEventsInWindow filters by timestamp_ms
  const allEvents = store.getEventsInWindow(0, now + 10000);
  assertTrue(allEvents.length >= 3, 'should return all events in wide window');
});

test('getEventsInWindow returns empty array when no events in range', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('TAXI', { timestampMs: 1000 });
  const window = store.getEventsInWindow(0, 1);
  assertEqual(window.length, 0, 'should return empty array for past range');
});

test('getEventsInWindow returns empty array when no events in range', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('TAXI', { timestampMs: 1000 });
  const window = store.getEventsInWindow(5000, 9000);
  assertEqual(window.length, 0, 'should return empty array');
});

// ─────────────────────────────────────────────────────────────────────────────
// reset
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- reset ---\n');

test('reset clears all events', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('TAXI', { timestampMs: 1000 });
  store.recordPhaseChange('TAKEOFF', { timestampMs: 2000 });
  store.reset();
  const tl = store.getTimeline();
  assertEqual(tl.events.length, 0, 'events should be empty after reset');
});

test('reset clears currentPhase', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('CRUISE', { timestampMs: 1000 });
  store.reset();
  assertNull(store.currentPhase, 'currentPhase should be null after reset');
});

test('reset restarts event IDs for the cleared store', () => {
  const store = createTimelineStore({ flightId: 'reset-flight' });
  assertEqual(store.recordScoreFinal('before-reset', 1).id, 'reset-flight-0');
  store.reset();
  assertEqual(store.recordScoreFinal('after-reset', 1).id, 'reset-flight-0');
});

// ─────────────────────────────────────────────────────────────────────────────
// finalize
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- finalize ---\n');

test('finalize returns timeline object', () => {
  const store = createTimelineStore({ flightId: 'test' });
  store.recordPhaseChange('TAXI', { timestampMs: 1000 });
  const result = store.finalize();
  assertTrue(result != null, 'finalize should return a result');
  assertTrue(Array.isArray(result.events), 'result should have events array');
});

// ─────────────────────────────────────────────────────────────────────────────
// Singleton management: startTimeline / endTimeline / isRecording
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- Singleton management ---\n');

test('isRecording returns false before startTimeline', () => {
  endTimeline();
  assertEqual(isRecording(), false, 'should not be recording initially');
});

test('startTimeline makes isRecording return true', () => {
  endTimeline();
  startTimeline('flight-singleton-test');
  assertEqual(isRecording(), true, 'should be recording after startTimeline');
  endTimeline();
});

test('endTimeline makes isRecording return false', () => {
  startTimeline('flight-singleton-test-2');
  endTimeline();
  assertEqual(isRecording(), false, 'should not be recording after endTimeline');
});

test('getActiveStore returns null when not recording', () => {
  endTimeline();
  assertNull(getActiveStore(), 'getActiveStore should return null when not recording');
});

test('getActiveStore returns store when recording', () => {
  endTimeline();
  startTimeline('flight-active-store-test');
  const store = getActiveStore();
  assertTrue(store != null, 'getActiveStore should return store when recording');
  endTimeline();
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
