'use strict';

type TestFn = () => void;

type HarnessStats = {
  passed: number;
  failed: number;
};

type Harness = {
  test: (name: string, fn: TestFn) => void;
  assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
  assertTrue: (value: unknown, message?: string) => void;
  summary: (label: string) => void;
  getStats: () => HarnessStats;
};

function createHarness(): Harness {
  let passed = 0;
  let failed = 0;

  function test(name: string, fn: TestFn): void {
    try {
      fn();
      passed++;
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAIL ${name}\n  ${message}`);
    }
  }

  function assertEqual(actual: unknown, expected: unknown, message = ''): void {
    if (actual !== expected) {
      throw new Error(`${message} expected=${expected} actual=${actual}`);
    }
  }

  function assertTrue(value: unknown, message = 'Expected true'): void {
    if (!value) {
      throw new Error(message);
    }
  }

  function summary(label: string): void {
    console.log(`\n${label}: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      process.exit(1);
    }
  }

  return {
    test,
    assertEqual,
    assertTrue,
    summary,
    getStats: (): HarnessStats => ({ passed, failed }),
  };
}

module.exports = { createHarness };

export {};
