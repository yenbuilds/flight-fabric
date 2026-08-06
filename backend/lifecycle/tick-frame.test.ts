'use strict';

const { createTickFrame, createTickFrameFactory } = require('./tick-frame') as typeof import('./tick-frame');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message = ''): void {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: unknown, message = 'Expected truthy value'): void {
  if (!value) throw new Error(message);
}

function assertThrows(fn: () => void, message = 'Expected function to throw'): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

console.log('\n=== TickFrame Tests ===\n');

test('creates canonical metadata and keeps cadence aliases compatible', () => {
  const frame = createTickFrame(
    { ias: 250 },
    {
      tickNumber: 42,
      nowEpochMs: 1703419200000,
      pollRateMs: 50,
      actualDeltaMs: 125,
    },
  );

  assertEqual(frame.ias, 250);
  assertEqual(frame.meta.sequence, 42);
  assertEqual(frame.meta.timestampMs, 1703419200000);
  assertTrue(frame.meta.timestampIso.includes('2023-12-24'));
  assertEqual(frame.meta.actualDeltaMs, 125);
  assertEqual(frame.tickNumber, 42);
  assertEqual(frame.pollRateMs, 50);
  assertEqual(frame.deltaSec, 0.05);
});

test('owns and deeply freezes telemetry without freezing provider data', () => {
  const raw = {
    throttle: {
      engines: [{ pct: 85 }],
    },
  };
  const frame = createTickFrame(raw);
  const throttle = frame.throttle as { engines: Array<{ pct: number }> };

  assertTrue(frame.throttle !== raw.throttle, 'nested provider object was aliased');
  assertTrue(throttle.engines !== raw.throttle.engines, 'provider array was aliased');
  assertTrue(throttle.engines[0] !== raw.throttle.engines[0], 'array entry was aliased');
  assertTrue(Object.isFrozen(frame));
  assertTrue(Object.isFrozen(frame.meta));
  assertTrue(Object.isFrozen(throttle));
  assertTrue(Object.isFrozen(throttle.engines));
  assertTrue(Object.isFrozen(throttle.engines[0]));
  assertTrue(!Object.isFrozen(raw));
  assertTrue(!Object.isFrozen(raw.throttle));

  raw.throttle.engines[0].pct = 10;
  assertEqual(throttle.engines[0].pct, 85, 'provider mutation leaked into TickFrame');
  assertThrows(() => {
    throttle.engines[0].pct = 20;
  }, 'consumer mutation should fail');
});

test('provider fields cannot replace canonical metadata', () => {
  const frame = createTickFrame(
    {
      meta: { sequence: 999 },
      tickNumber: 999,
      timestampMs: 999,
      timestampIso: 'wrong',
      pollRateMs: 999,
      deltaSec: 999,
    },
    { tickNumber: 3, nowEpochMs: 1000, pollRateMs: 20 },
  );

  assertEqual(frame.meta.sequence, 3);
  assertEqual(frame.tickNumber, 3);
  assertEqual(frame.timestampMs, 1000);
  assertEqual(frame.timestampIso, new Date(1000).toISOString());
  assertEqual(frame.pollRateMs, 20);
  assertEqual(frame.deltaSec, 0.02);
});

test('rejects circular and non-plain telemetry', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertThrows(() => createTickFrame(circular), 'circular telemetry should fail');
  assertThrows(() => createTickFrame({ captured: new Date() }), 'Date telemetry should fail');
});

test('factory uses monotonic elapsed time and increments sequence', () => {
  let wallMs = 5000;
  let monotonicMs = 100;
  const factory = createTickFrameFactory({
    timeSource: { now: () => wallMs },
    monotonicTimeSource: { now: () => monotonicMs },
    pollRateMs: 20,
  });

  const first = factory.create({});
  wallMs = 4000;
  monotonicMs = 175;
  const second = factory.create({});

  assertEqual(first.meta.sequence, 0);
  assertEqual(first.meta.actualDeltaMs, null);
  assertEqual(second.meta.sequence, 1);
  assertEqual(second.meta.timestampMs, 4000);
  assertEqual(second.meta.actualDeltaMs, 75);
  assertEqual(factory.getTickCount(), 2);
});

test('factory reset clears sequence and elapsed-time baseline', () => {
  let monotonicMs = 100;
  const factory = createTickFrameFactory({
    monotonicTimeSource: { now: () => monotonicMs },
  });

  factory.create({});
  monotonicMs = 200;
  factory.create({});
  factory.reset();
  monotonicMs = 300;
  const resetFrame = factory.create({});

  assertEqual(resetFrame.meta.sequence, 0);
  assertEqual(resetFrame.meta.actualDeltaMs, null);
  assertEqual(factory.getTickCount(), 1);
});

console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);

export {};
