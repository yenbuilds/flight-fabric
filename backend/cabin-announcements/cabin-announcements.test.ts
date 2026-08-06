'use strict';

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = require('node:events') as typeof import('node:events');

const { startCabinAnnouncements } = require('./cabin-announcements') as {
  startCabinAnnouncements: (options: {
    eventBus: InstanceType<typeof EventEmitter>;
    broadcast: (message: {
      type: string;
      phase: string;
      style: string;
    }) => void;
    config: {
      cabinAnnouncements: {
        enabled: boolean;
        style: string;
        startupGraceMs: number;
      };
    };
    timeNow: () => number;
    setTimer: (listener: () => void, delayMs: number) => object;
    clearTimer: (timer: object) => void;
  }) => void;
};

type Harness = {
  eventBus: InstanceType<typeof EventEmitter>;
  messages: Array<{ type: string; phase: string; style: string }>;
  setNow: (ms: number) => void;
};

function createHarness(): Harness {
  const eventBus = new EventEmitter();
  const messages: Array<{ type: string; phase: string; style: string }> = [];
  let nowMs = 0;
  let nextTimerId = 1;
  const timers: Array<{
    id: number;
    dueMs: number;
    listener: () => void;
    cleared: boolean;
  }> = [];

  function runDueTimers(): void {
    for (let guard = 0; guard < 100; guard += 1) {
      timers.sort((a, b) => a.dueMs - b.dueMs || a.id - b.id);
      const timer = timers.find((candidate) => !candidate.cleared && candidate.dueMs <= nowMs);
      if (!timer) return;
      timer.cleared = true;
      timer.listener();
    }
    throw new Error('timer loop did not settle');
  }

  startCabinAnnouncements({
    eventBus,
    broadcast: (message) => {
      messages.push(message);
    },
    config: {
      cabinAnnouncements: {
        enabled: true,
        style: 'standard',
        startupGraceMs: 5_000,
      },
    },
    timeNow: () => nowMs,
    setTimer: (listener, delayMs) => {
      const timer = {
        id: nextTimerId,
        dueMs: nowMs + Math.max(0, delayMs),
        listener,
        cleared: false,
      };
      nextTimerId += 1;
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared?: boolean }).cleared = true;
    },
  });

  return {
    eventBus,
    messages,
    setNow(ms: number) {
      nowMs = ms;
      runDueTimers();
    },
  };
}

test('cabin announcements suppress startup phase flips until grace expires', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'APPROACH' });
  assert.deepEqual(messages, [], 'initial phase should seed baseline without playing audio');

  setNow(1_000);
  eventBus.emit('telemetry:phase', { value: 'TAXI-IN' });
  assert.deepEqual(messages, [], 'phase flips during startup grace should stay silent');

  setNow(5_001);
  eventBus.emit('telemetry:frame', { alt_msl: 3_000, wow: false, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'cabinAnnouncement');
  assert.equal(messages[0].phase, 'APPROACH');
});

test('cabin announcements suppress menu taxi phases before aircraft load', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', {
    alt_msl: 400,
    wow: true,
    display: { raFt: 0 },
    inMenu: true,
    simconnect: { connected: true, inFlightContext: false },
  });
  eventBus.emit('telemetry:phase', { value: 'PARKED' });

  setNow(7_000);
  eventBus.emit('telemetry:frame', {
    alt_msl: 410,
    wow: true,
    display: { raFt: 0 },
    inMenu: true,
    simconnect: { connected: true, inFlightContext: false },
  });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });

  assert.deepEqual(messages, [], 'menu camera or pre-load taxi phases must not queue pushback PA audio');
});

test('cabin announcements restart startup grace after flight reset', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'APPROACH' });
  setNow(5_001);
  eventBus.emit('telemetry:frame', { alt_msl: 3_000, wow: false, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:frame', { alt_msl: 100, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'TAXI-IN' });
  assert.equal(messages.length, 1, 'sanity check: later transition should still announce');

  setNow(20_000);
  eventBus.emit('flight:started', { flightId: 'test-flight' });

  setNow(20_001);
  eventBus.emit('telemetry:phase', { value: 'TAXI-IN' });
  assert.equal(messages.length, 1, 'reset baseline should not replay immediately on first phase sample');

  setNow(22_500);
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });
  assert.equal(messages.length, 1, 'transient phase flips inside reset grace should stay silent');

  setNow(25_001);
  eventBus.emit('telemetry:frame', { alt_msl: 3_000, wow: false, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:frame', { alt_msl: 100, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'TAXI-IN' });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].phase, 'TAXI-IN');
});

test('cabin announcements play taxi safety demo after flight-start grace and dwell', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(1_000);
  eventBus.emit('telemetry:frame', { alt_msl: 420, wow: true, display: { raFt: 0 } });
  eventBus.emit('flight:started', { flightId: 'pushback-test' });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });

  assert.deepEqual(messages, [], 'TAXI phase should wait for startup grace and dwell');

  setNow(6_001);
  assert.deepEqual(messages, [], 'startup grace expiry should start the TAXI dwell, not fire yet');

  setNow(11_001);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'cabinAnnouncement');
  assert.equal(messages[0].phase, 'TAXI');
});

test('cabin announcements retain TAXI when production phase update precedes flight start', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(1_000);
  eventBus.emit('telemetry:frame', { alt_msl: 420, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'PARKED' });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });
  eventBus.emit('flight:started', { flightId: 'phase-before-start-test' });

  assert.deepEqual(messages, [], 'flight start should restart grace without dropping TAXI');

  setNow(6_001);
  assert.deepEqual(messages, [], 'TAXI should begin its dwell after the restarted grace');

  setNow(11_001);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'TAXI');
});

test('cabin announcements do not replay TAXI after a delayed flight start', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:frame', { alt_msl: 420, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'PARKED' });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });

  setNow(5_000);
  setNow(10_000);
  assert.deepEqual(
    messages,
    [{ type: 'cabinAnnouncement', phase: 'TAXI', style: 'standard' }],
    'sanity check: TAXI should have completed before the lifecycle start',
  );

  eventBus.emit('flight:started', { flightId: 'delayed-flight-start-test' });
  setNow(15_000);
  setNow(20_000);

  assert.equal(messages.length, 1, 'delayed flight start must not replay completed TAXI audio');
});

test('cabin announcements do not carry stale TAXI state into the next flight', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:frame', { alt_msl: 420, wow: true, display: { raFt: 0 } });
  eventBus.emit('flight:started', { flightId: 'first-flight' });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });
  setNow(5_000);
  setNow(10_000);
  assert.equal(messages.length, 1, 'sanity check: first flight should announce TAXI');

  eventBus.emit('flight:ended', { flightId: 'first-flight' });
  eventBus.emit('telemetry:phase', { value: 'PARKED' });
  setNow(12_000);
  eventBus.emit('telemetry:phase', { value: 'TAXI' });
  eventBus.emit('flight:started', { flightId: 'second-flight' });

  setNow(17_000);
  setNow(22_000);
  assert.deepEqual(
    messages.map((message) => message.phase),
    ['TAXI', 'TAXI'],
    'each flight should get its own TAXI announcement',
  );
});

test('cabin announcements wait for ground telemetry before taxi safety demo', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(1_000);
  eventBus.emit('flight:started', { flightId: 'manual-start-before-frame-test' });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });

  setNow(6_001);
  assert.deepEqual(messages, [], 'TAXI should not fire without a telemetry frame');

  setNow(7_000);
  eventBus.emit('telemetry:frame', { alt_msl: 420, wow: true, display: { raFt: 0 } });
  assert.deepEqual(messages, [], 'first ground frame should start dwell, not fire immediately');

  setNow(12_000);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'TAXI');
});

test('cabin announcements cancel pending taxi safety demo when takeoff starts first', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(1_000);
  eventBus.emit('telemetry:frame', { alt_msl: 420, wow: true, display: { raFt: 0 } });
  eventBus.emit('flight:started', { flightId: 'quick-takeoff-test' });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });

  setNow(6_001);
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });

  setNow(11_001);
  assert.deepEqual(messages, [], 'TAXI safety demo must not fire after the phase leaves TAXI');
});

test('cabin announcements walk normal flight phases with dwell and telemetry guards', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(1_000);
  eventBus.emit('telemetry:frame', { alt_msl: 420, wow: true, display: { raFt: 0 } });
  eventBus.emit('flight:started', { flightId: 'full-phase-walk-test' });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });

  setNow(6_001);
  setNow(11_001);

  setNow(12_000);
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: false, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });
  setNow(42_000);

  setNow(43_000);
  eventBus.emit('telemetry:phase', { value: 'CRUISE' });
  setNow(163_000);

  setNow(164_000);
  eventBus.emit('telemetry:phase', { value: 'DESCENT' });
  setNow(344_000);

  setNow(345_000);
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });

  setNow(346_000);
  eventBus.emit('telemetry:phase', { value: 'LANDING' });
  eventBus.emit('telemetry:frame', { alt_msl: 430, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'TAXI-IN' });

  assert.deepEqual(
    messages.map((message) => message.phase),
    ['TAXI', 'CLIMB', 'CRUISE', 'DESCENT', 'APPROACH', 'TAXI-IN'],
  );
});

test('cabin announcements suppress stale taxi safety audio after takeoff', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:frame', { alt_msl: 450, wow: false, display: { raFt: 250 } });
  eventBus.emit('telemetry:phase', { value: 'TAXI' });

  assert.deepEqual(messages, [], 'pre-departure TAXI audio must not fire after airborne telemetry');
});

test('cabin announcements suppress climb audio while telemetry still says ground', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:frame', { alt_msl: 20, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });

  assert.deepEqual(messages, [], 'CLIMB audio must not queue while still on the ground');
});

test('cabin announcements retry a phase when telemetry arrives after the transition', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });
  assert.deepEqual(messages, [], 'CLIMB should wait for usable airborne telemetry');

  setNow(7_000);
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: false, display: { raFt: 1_500 } });

  setNow(37_000);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'CLIMB');
});

test('cabin announcements retry after dwell finishes on transiently invalid telemetry', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 1_500, wow: false, display: { raFt: 900 } });
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });

  setNow(36_000);
  assert.deepEqual(messages, [], 'CLIMB should remain suppressed below its minimum radio altitude');

  setNow(37_000);
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: false, display: { raFt: 1_500 } });

  assert.equal(messages.length, 1, 'the satisfied dwell should not restart from zero');
  assert.equal(messages[0].phase, 'CLIMB');
});

test('cabin announcements keep a satisfied dwell suppressed while telemetry remains invalid', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 1_500, wow: false, display: { raFt: 900 } });
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });

  setNow(36_000);
  eventBus.emit('telemetry:frame', { alt_msl: 1_600, wow: false, display: { raFt: 950 } });
  setNow(66_000);

  assert.deepEqual(messages, [], 'retries must not bypass the CLIMB radio-altitude guard');
});

test('cabin announcements cancel a retry when the phase changes before telemetry recovers', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });
  eventBus.emit('telemetry:phase', { value: 'CRUISE' });

  setNow(7_000);
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: false, display: { raFt: 1_500 } });
  setNow(37_000);

  assert.deepEqual(messages, [], 'the abandoned CLIMB retry must not fire during CRUISE');
});

test('cabin announcements require a fresh dwell after leaving and returning to a phase', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 1_500, wow: false, display: { raFt: 900 } });
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });
  setNow(36_000);

  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: false, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });

  setNow(65_999);
  assert.deepEqual(messages, [], 'a completed dwell from the abandoned CLIMB must not be reused');

  setNow(66_000);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'CLIMB');
});

test('cabin announcements clear satisfied dwell state when a new flight starts', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 1_500, wow: false, display: { raFt: 900 } });
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });
  setNow(36_000);

  setNow(37_000);
  eventBus.emit('flight:started', { flightId: 'replacement-flight' });
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: false, display: { raFt: 1_500 } });

  setNow(43_000);
  eventBus.emit('telemetry:phase', { value: 'TAKEOFF' });
  eventBus.emit('telemetry:phase', { value: 'CLIMB' });

  setNow(72_999);
  assert.deepEqual(messages, [], 'a new flight must not inherit the previous flight dwell');

  setNow(73_000);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'CLIMB');
});

test('cabin announcements retry an immediate phase after telemetry recovers', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'DESCENT' });

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 3_000, wow: false, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });
  assert.deepEqual(messages, [], 'APPROACH should wait while airborne telemetry is inconsistent');

  setNow(7_000);
  eventBus.emit('telemetry:frame', { alt_msl: 2_500, wow: false, display: { raFt: 1_500 } });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'APPROACH');
});

test('cabin announcements do not treat WOW false at zero RA as airborne', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'CRUISE' });

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 400, wow: false, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });

  assert.deepEqual(
    messages,
    [],
    'ground-level WOW dropout must not unlock airborne phase PA audio',
  );
});

test('cabin announcements suppress approach and taxi-in before airborne history exists', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'CRUISE' });

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 200, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });
  eventBus.emit('telemetry:phase', { value: 'TAXI-IN' });

  assert.deepEqual(
    messages,
    [],
    'arrival audio must not play from ground/stale phase changes before the flight was airborne',
  );
});

test('cabin announcements allow taxi-in only after airborne then ground telemetry', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'APPROACH' });

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 3_000, wow: false, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:frame', { alt_msl: 100, wow: true, display: { raFt: 0 } });
  eventBus.emit('telemetry:phase', { value: 'TAXI-IN' });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'TAXI-IN');
});

test('cabin announcements suppress approach when ground state and radio altitude are unknown', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'CRUISE' });

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 12_000 });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });

  assert.deepEqual(messages, [], 'altitude alone must not prove airborne for immediate PA audio');
});

test('cabin announcements allow radio altitude to confirm airborne without explicit ground state', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'CRUISE' });

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 3_000, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'APPROACH');
});

test('cabin announcements do not replay an already announced immediate phase', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:phase', { value: 'CRUISE' });

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 3_000, wow: false, display: { raFt: 1_500 } });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });
  eventBus.emit('telemetry:phase', { value: 'CRUISE' });
  eventBus.emit('telemetry:phase', { value: 'APPROACH' });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'APPROACH');
});

test('cabin announcements suppress altitude crossings during startup grace', () => {
  const { eventBus, messages, setNow } = createHarness();

  eventBus.emit('telemetry:frame', { alt_msl: 12_500, wow: false });

  setNow(1_000);
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: true });
  assert.deepEqual(messages, [], 'startup altitude crossing should stay silent');

  setNow(5_001);
  eventBus.emit('telemetry:frame', { alt_msl: 2_000, wow: true });
  assert.deepEqual(messages, [], 'post-grace ground baseline should not replay BELOW_10K');
});

test('cabin announcements suppress stale high-to-ground below 10k crossing', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 12_500, wow: false });

  setNow(7_000);
  eventBus.emit('telemetry:frame', { alt_msl: 500, wow: true });
  assert.deepEqual(messages, [], 'ground frame after stale high frame should not play BELOW_10K');
});

test('cabin announcements suppress altitude crossing during ground-level WOW dropout', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 12_500, wow: false, display: { raFt: 12_000 } });

  setNow(7_000);
  eventBus.emit('telemetry:frame', { alt_msl: 9_500, wow: false, display: { raFt: 0 } });

  assert.deepEqual(
    messages,
    [],
    'WOW false with runway-height RA must not play BELOW_10K',
  );
});

test('cabin announcements still announce real airborne 10k crossings', () => {
  const { eventBus, messages, setNow } = createHarness();

  setNow(6_000);
  eventBus.emit('telemetry:frame', { alt_msl: 12_500, wow: false });

  setNow(7_000);
  eventBus.emit('telemetry:frame', { alt_msl: 9_500, wow: false });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'cabinAnnouncement');
  assert.equal(messages[0].phase, 'BELOW_10K');
});

export {};
