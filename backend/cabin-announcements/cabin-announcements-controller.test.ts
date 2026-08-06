'use strict';

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

type Listener = (_payload?: unknown) => void;

function createEventBusHarness() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    eventBus: {
      on(eventName: string, listener: Listener) {
        if (!listeners.has(eventName)) listeners.set(eventName, new Set());
        listeners.get(eventName)!.add(listener);
        return () => listeners.get(eventName)?.delete(listener);
      },
    },
    emit(eventName: string, payload?: unknown) {
      for (const listener of listeners.get(eventName) || []) {
        listener(payload);
      }
    },
    listenerCount(eventName: string) {
      return listeners.get(eventName)?.size || 0;
    },
    totalListenerCount() {
      return [...listeners.values()].reduce((total, handlers) => total + handlers.size, 0);
    },
  };
}

function createTimerHarness() {
  let nowMs = 0;
  let nextTimerId = 1;
  const timers: Array<{
    id: number;
    dueMs: number;
    listener: () => void;
    cleared: boolean;
  }> = [];

  function runDueTimers() {
    for (let guard = 0; guard < 100; guard += 1) {
      timers.sort((a, b) => a.dueMs - b.dueMs || a.id - b.id);
      const timer = timers.find((candidate) => !candidate.cleared && candidate.dueMs <= nowMs);
      if (!timer) return;
      timer.cleared = true;
      timer.listener();
    }
    throw new Error('timer loop did not settle');
  }

  return {
    timeNow: () => nowMs,
    setTimer(listener: () => void, delayMs: number) {
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
    clearTimer(timer: { cleared: boolean }) {
      timer.cleared = true;
    },
    setNow(nextNowMs: number) {
      nowMs = nextNowMs;
      runDueTimers();
    },
  };
}

const SUBSCRIBED_EVENTS = [
  'flight:started',
  'flight:ended',
  'simconnect:aircraftChanged',
  'telemetry:phase',
  'telemetry:frame',
];

test('cabin announcement controller enables, disables, and reconfigures without duplicate listeners', () => {
  const { createCabinAnnouncementsController } = require('./cabin-announcements-controller') as {
    createCabinAnnouncementsController: (_options: {
      eventBus: ReturnType<typeof createEventBusHarness>['eventBus'];
      broadcast: () => void;
    }) => {
      reconfigure: (_config: {
        cabinAnnouncements: {
          enabled: boolean;
          style: string;
          startupGraceMs: number;
        };
      }) => { changed: boolean; enabled: boolean };
      stop: () => void;
    };
  };
  const harness = createEventBusHarness();
  const controller = createCabinAnnouncementsController({
    eventBus: harness.eventBus,
    broadcast() {},
  });

  assert.deepEqual(
    controller.reconfigure({
      cabinAnnouncements: { enabled: false, style: 'standard', startupGraceMs: 5_000 },
    }),
    { changed: true, enabled: false },
  );
  assert.equal(harness.totalListenerCount(), 0);

  const enabledConfig = {
    cabinAnnouncements: { enabled: true, style: 'standard', startupGraceMs: 5_000 },
  };
  assert.deepEqual(controller.reconfigure(enabledConfig), { changed: true, enabled: true });
  for (const eventName of SUBSCRIBED_EVENTS) {
    assert.equal(harness.listenerCount(eventName), 1, `${eventName} should have one listener`);
  }

  assert.deepEqual(
    controller.reconfigure(enabledConfig),
    { changed: false, enabled: true },
    'reapplying identical settings should be a no-op',
  );
  for (const eventName of SUBSCRIBED_EVENTS) {
    assert.equal(harness.listenerCount(eventName), 1, `${eventName} should not gain a duplicate`);
  }

  assert.deepEqual(
    controller.reconfigure({
      cabinAnnouncements: { enabled: true, style: 'concise', startupGraceMs: 7_500 },
    }),
    { changed: true, enabled: true },
  );
  for (const eventName of SUBSCRIBED_EVENTS) {
    assert.equal(harness.listenerCount(eventName), 1, `${eventName} should replace its listener`);
  }

  assert.deepEqual(
    controller.reconfigure({
      cabinAnnouncements: { enabled: false, style: 'concise', startupGraceMs: 7_500 },
    }),
    { changed: true, enabled: false },
  );
  assert.equal(harness.totalListenerCount(), 0);

  controller.stop();
  controller.stop();
  assert.equal(harness.totalListenerCount(), 0, 'stop should be idempotent');
});

test('disabled cabin announcement settings are idempotent regardless of inactive style fields', () => {
  const { createCabinAnnouncementsController } = require('./cabin-announcements-controller');
  const harness = createEventBusHarness();
  const controller = createCabinAnnouncementsController({
    eventBus: harness.eventBus,
    broadcast() {},
  });

  controller.reconfigure({
    cabinAnnouncements: { enabled: false, style: 'standard', startupGraceMs: 5_000 },
  });
  assert.deepEqual(
    controller.reconfigure({
      cabinAnnouncements: { enabled: false, style: 'another-pack', startupGraceMs: 20_000 },
    }),
    { changed: false, enabled: false },
  );
  assert.equal(harness.totalListenerCount(), 0);
});

test('failed enabled reconfiguration preserves the existing cabin announcement listeners', () => {
  const { startCabinAnnouncements } = require('./cabin-announcements');
  const { createCabinAnnouncementsController } = require('./cabin-announcements-controller');
  const harness = createEventBusHarness();
  let starts = 0;
  const controller = createCabinAnnouncementsController({
    eventBus: harness.eventBus,
    broadcast() {},
    startAnnouncements(options) {
      starts += 1;
      if (starts === 2) {
        throw new Error('fixture startup failure');
      }
      const handle = startCabinAnnouncements(options);
      return {
        stop: () => handle.stop(),
      };
    },
  });
  const originalConfig = {
    cabinAnnouncements: { enabled: true, style: 'standard', startupGraceMs: 5_000 },
  };

  controller.reconfigure(originalConfig);
  assert.throws(
    () => controller.reconfigure({
      cabinAnnouncements: { enabled: true, style: 'concise', startupGraceMs: 5_000 },
    }),
    /fixture startup failure/,
  );
  for (const eventName of SUBSCRIBED_EVENTS) {
    assert.equal(
      harness.listenerCount(eventName),
      1,
      `${eventName} should retain the original listener after replacement fails`,
    );
  }
  assert.deepEqual(
    controller.reconfigure(originalConfig),
    { changed: false, enabled: true },
    'failed replacement should retain the original active configuration',
  );
});

test('style change during climb preserves state and announces cruise once with the new style', () => {
  const { createCabinAnnouncementsController } = require('./cabin-announcements-controller');
  const eventHarness = createEventBusHarness();
  const timerHarness = createTimerHarness();
  const messages: Array<{ phase: string; style: string }> = [];
  let currentPhase = 'TAKEOFF';
  let latestFrame = {
    alt_msl: 2_000,
    wow: false,
    display: { raFt: 1_500 },
  };
  const controller = createCabinAnnouncementsController({
    eventBus: eventHarness.eventBus,
    broadcast(message) {
      messages.push(message);
    },
    getCurrentPhase: () => currentPhase,
    getLatestTelemetryFrame: () => latestFrame,
    timeNow: timerHarness.timeNow,
    setTimer: timerHarness.setTimer,
    clearTimer: timerHarness.clearTimer,
  });

  controller.reconfigure({
    cabinAnnouncements: { enabled: true, style: 'standard', startupGraceMs: 0 },
  });
  currentPhase = 'CLIMB';
  eventHarness.emit('telemetry:phase', { value: currentPhase });
  timerHarness.setNow(30_000);
  assert.deepEqual(messages, [{ type: 'cabinAnnouncement', phase: 'CLIMB', style: 'standard' }]);

  controller.reconfigure({
    cabinAnnouncements: { enabled: true, style: 'concise', startupGraceMs: 0 },
  });
  assert.equal(eventHarness.listenerCount('telemetry:phase'), 1, 'style update should stay in-place');

  currentPhase = 'CRUISE';
  latestFrame = {
    alt_msl: 35_000,
    wow: false,
    display: { raFt: 34_000 },
  };
  eventHarness.emit('telemetry:frame', latestFrame);
  eventHarness.emit('telemetry:phase', { value: currentPhase });
  timerHarness.setNow(150_000);

  assert.deepEqual(
    messages,
    [
      { type: 'cabinAnnouncement', phase: 'CLIMB', style: 'standard' },
      { type: 'cabinAnnouncement', phase: 'CRUISE', style: 'concise' },
    ],
  );
});

test('enabling while parked seeds current state so the next taxi phase announces after grace and dwell', () => {
  const { createCabinAnnouncementsController } = require('./cabin-announcements-controller');
  const eventHarness = createEventBusHarness();
  const timerHarness = createTimerHarness();
  const messages: Array<{ phase: string; style: string }> = [];
  let currentPhase = 'PARKED';
  const latestFrame = {
    alt_msl: 420,
    wow: true,
    display: { raFt: 0 },
  };
  const controller = createCabinAnnouncementsController({
    eventBus: eventHarness.eventBus,
    broadcast(message) {
      messages.push(message);
    },
    getCurrentPhase: () => currentPhase,
    getLatestTelemetryFrame: () => latestFrame,
    timeNow: timerHarness.timeNow,
    setTimer: timerHarness.setTimer,
    clearTimer: timerHarness.clearTimer,
  });

  controller.reconfigure({
    cabinAnnouncements: { enabled: false, style: 'standard', startupGraceMs: 5_000 },
  });
  controller.reconfigure({
    cabinAnnouncements: { enabled: true, style: 'standard', startupGraceMs: 5_000 },
  });

  currentPhase = 'TAXI';
  timerHarness.setNow(1_000);
  eventHarness.emit('telemetry:phase', { value: currentPhase });
  timerHarness.setNow(5_000);
  assert.deepEqual(messages, [], 'grace expiry should begin the TAXI dwell');

  timerHarness.setNow(10_000);
  assert.deepEqual(
    messages,
    [{ type: 'cabinAnnouncement', phase: 'TAXI', style: 'standard' }],
  );
});

test('live cabin reconfiguration preserves environment-overridden effective fields', () => {
  const {
    resolveCabinAnnouncementsReconfigureSettings,
  } = require('./cabin-announcements-controller');

  assert.deepEqual(
    resolveCabinAnnouncementsReconfigureSettings(
      {
        cabinAnnouncements: {
          enabled: true,
          style: 'saved-style',
          startupGraceMs: 12_000,
        },
      },
      {
        enabled: false,
        style: 'env-style',
        startupGraceMs: 2_500,
        envOverrides: {
          enabled: true,
          style: false,
          startupGraceMs: true,
        },
      },
    ),
    {
      cabinAnnouncements: {
        enabled: false,
        style: 'saved-style',
        startupGraceMs: 2_500,
      },
    },
  );
});

export {};
