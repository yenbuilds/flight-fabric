#!/usr/bin/env node
'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { createPhaseRunner } = require(resolveBackendRuntimeFile('lifecycle', 'phase-runner.js'));
const { PHASES } = require(resolveBackendRuntimeFile('lifecycle', 'phases.js'));
const eventBus = require(resolveBackendRuntimeFile('core', 'event-bus.js'));
const { createHarness } = require(resolveBackendRuntimeFile('test-support', 'mini-test-harness.js'));

const { test, assertEqual, assertTrue, summary } = createHarness();

function makeClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (deltaMs) => {
      nowMs += deltaMs;
      return nowMs;
    },
    set: (valueMs) => {
      nowMs = valueMs;
      return nowMs;
    }
  };
}

function approachFrame(overrides = {}) {
  return {
    iasKts: 145,
    wow: false,
    vsFpm: -700,
    raFt: 800,
    gsKts: 145,
    altMslFt: 4000,
    aircraftName: 'Test Aircraft',
    ...overrides,
  };
}

function climbFrame(overrides = {}) {
  return {
    iasKts: 150,
    wow: false,
    vsFpm: 1100,
    raFt: 700,
    gsKts: 150,
    altMslFt: 4200,
    aircraftName: 'Test Aircraft',
    ...overrides,
  };
}

function descentFrame(overrides = {}) {
  return {
    iasKts: 165,
    wow: false,
    vsFpm: -900,
    raFt: 1800,
    gsKts: 170,
    altMslFt: 4200,
    aircraftName: 'Test Aircraft',
    ...overrides,
  };
}

function taxiFrame(overrides = {}) {
  return {
    iasKts: 15,
    wow: true,
    vsFpm: 0,
    raFt: 5,
    gsKts: 15,
    altMslFt: 300,
    aircraftName: 'Test Aircraft',
    ...overrides,
  };
}

function feed(runner, clock, frames, dtMs = 1000) {
  for (const frame of frames) {
    runner.updatePhase(frame, () => {});
    clock.advance(dtMs);
  }
}

function withGoAroundCapture(fn) {
  const events = [];
  const off = eventBus.on('phase:goAround', (payload) => {
    events.push(payload);
  });

  try {
    fn(events);
  } finally {
    off();
  }
}

console.log('\n=== Go-Around Detection Tests ===');

test('emits go-around phase when APPROACH transitions to missed approach', () => {
  const clock = makeClock(1_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(runner, clock, Array.from({ length: 9 }, () => approachFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Phase should settle at APPROACH');

    // Need >= HOLD_SAMPLES and >= CLIMB_CONFIRM_MS (8s default)
    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame()), 1000);

    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'Phase should first settle at GO_AROUND');
    assertEqual(events.length, 1, 'Exactly one go-around event expected');
    assertEqual(events[0].previous_phase, PHASES.APPROACH, 'Previous phase should be APPROACH');
    assertTrue(Number.isFinite(events[0].altitude_ft), 'Payload should include altitude');

    feed(runner, clock, Array.from({ length: 2 }, () => climbFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Phase should then settle at CLIMB after climb-out continues');
  });
});

test('configured approach remains a go-around after gear/flaps begin retracting', () => {
  const clock = makeClock(1_500_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => approachFrame({ approachConfigured: true })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Configured final should settle at APPROACH');

    // Retraction can begin before the phase transition confirms, so the detector
    // must retain the recent configured-approach evidence through the climb dwell.
    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => climbFrame({ approachConfigured: false })),
      1000,
    );

    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'Configured missed approach should enter GO_AROUND');
    assertEqual(events.length, 1, 'Configured missed approach should emit one event');
  });
});

test('configuration completed during a level MDA segment still arms a go-around', () => {
  const clock = makeClock(1_600_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => approachFrame({ approachConfigured: false })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Final should settle at APPROACH');

    feed(
      runner,
      clock,
      Array.from({ length: 3 }, () => approachFrame({
        vsFpm: -100,
        approachConfigured: true,
      })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Level MDA segment should retain APPROACH context');

    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => climbFrame({ approachConfigured: false })),
      1000,
    );

    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'MDA missed approach should enter GO_AROUND');
    assertEqual(events.length, 1, 'MDA missed approach should emit one event');
  });
});

test('stale configuration availability falls back to phase-only go-around detection', () => {
  const clock = makeClock(1_650_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    // Establish that configuration telemetry was once available and clean.
    feed(
      runner,
      clock,
      Array.from({ length: 50 }, () => descentFrame({ approachConfigured: false })),
      1000,
    );
    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => climbFrame({ approachConfigured: false })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Known-clean reversal should remain CLIMB');
    assertEqual(events.length, 0, 'Known-clean reversal should remain suppressed');

    // The source then becomes unavailable. Once its last known sample is stale,
    // null must restore the legacy phase-only behavior instead of suppressing all
    // later genuine go-arounds for the rest of the runner lifetime.
    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => approachFrame({ approachConfigured: null })),
      1000,
    );
    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => climbFrame({ approachConfigured: null })),
      1000,
    );

    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'Unavailable configuration should use legacy detection');
    assertEqual(events.length, 1, 'Later phase-only go-around should emit one event');
  });
});

test('clean mountainous descent and climb reversals do not become go-arounds', () => {
  const clock = makeClock(1_750_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    // Regression case: low radio altitude over terrain, but gear and flaps were
    // up. The first reversal came directly from DESCENT.
    feed(
      runner,
      clock,
      Array.from({ length: 50 }, () => descentFrame({
        iasKts: 188,
        gsKts: 210,
        raFt: 1800,
        altMslFt: 3100,
        approachConfigured: false,
      })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.DESCENT, 'Terrain-limited segment should settle at DESCENT');

    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => climbFrame({
        iasKts: 188,
        raFt: 1700,
        altMslFt: 3300,
        approachConfigured: false,
      })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Clean reversal should remain an ordinary CLIMB');
    assertEqual(events.length, 0, 'Clean DESCENT reversal must not emit a go-around');

    // The second false positive briefly entered APPROACH solely because terrain
    // reduced RA below the phase threshold.
    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => approachFrame({
        iasKts: 213,
        gsKts: 220,
        raFt: 350,
        altMslFt: 2600,
        approachConfigured: false,
      })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Low terrain clearance may still classify as APPROACH');

    feed(
      runner,
      clock,
      Array.from({ length: 9 }, () => climbFrame({
        iasKts: 213,
        raFt: 500,
        altMslFt: 3200,
        approachConfigured: false,
      })),
      1000,
    );
    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Clean terrain climb should remain CLIMB');
    assertEqual(events.length, 0, 'Clean APPROACH-shaped reversal must not emit a go-around');
  });
});

test('suppresses go-around for touch-and-go climb within touchdown window', () => {
  const clock = makeClock(2_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(runner, clock, Array.from({ length: 9 }, () => approachFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Phase should settle at APPROACH');

    // Single touchdown sample sets lastTouchdownTs, but should not move phase away from APPROACH yet.
    feed(runner, clock, [taxiFrame({ iasKts: 40, gsKts: 40, raFt: 8 })], 1000);

    // Rapid liftoff and climb within 30s touch-and-go suppression window.
    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame({ raFt: 300, altMslFt: 1200 })), 1000);

    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Phase should still transition to CLIMB');
    assertEqual(events.length, 0, 'No go-around event expected for touch-and-go suppression');
  });
});

test('normal touchdown transitions through LANDING before taxi-in', () => {
  const clock = makeClock(2_500_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, Array.from({ length: 9 }, () => approachFrame()), 1000);
  assertEqual(runner.getPhase(), PHASES.APPROACH, 'Phase should settle at APPROACH');

  feed(runner, clock, Array.from({ length: 9 }, () => taxiFrame({
    iasKts: 120,
    gsKts: 120,
    raFt: 4,
    vsFpm: -300,
  })), 1000);
  assertEqual(runner.getPhase(), PHASES.LANDING, 'High-speed touchdown should settle at LANDING');

  feed(runner, clock, Array.from({ length: 9 }, () => taxiFrame({
    iasKts: 20,
    gsKts: 20,
    raFt: 2,
    vsFpm: 0,
  })), 1000);
  assertEqual(runner.getPhase(), PHASES.TAXI_IN, 'Low-speed rollout should settle at TAXI-IN after LANDING');
});

test('does not emit go-around on normal initial takeoff sequence', () => {
  const clock = makeClock(3_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    // Start on ground and taxi.
    feed(runner, clock, Array.from({ length: 4 }, () => taxiFrame()), 1000);

    // Initial takeoff roll / liftoff / climb.
    feed(runner, clock, Array.from({ length: 10 }, () => climbFrame({ raFt: 250, altMslFt: 800 })), 1000);

    assertTrue([PHASES.TAKEOFF, PHASES.CLIMB].includes(runner.getPhase()), 'Should be in takeoff/climb flow');
    assertEqual(events.length, 0, 'No go-around event expected on initial takeoff');
  });
});

test('emits GO_AROUND phase from low-altitude DESCENT missed approach', () => {
  const clock = makeClock(4_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(runner, clock, Array.from({ length: 50 }, () => descentFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.DESCENT, 'Phase should settle at DESCENT');

    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame({ raFt: 1700, altMslFt: 4300 })), 1000);

    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'Phase should transition to GO_AROUND first');
    assertEqual(events.length, 1, 'DESCENT missed approach should emit one go-around event');
    assertEqual(events[0].previous_phase, PHASES.DESCENT, 'Previous phase should reflect the missed-approach descent');
    assertEqual(events[0].armed_from_phase, PHASES.DESCENT, 'Approach context should be armed from DESCENT');

    feed(runner, clock, Array.from({ length: 2 }, () => climbFrame({ raFt: 2200, altMslFt: 4800 })), 1000);
    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Missed approach should settle into CLIMB after the transient go-around phase');
  });
});

test('detects second go-around on same circuit (DESCENT missed approach after first go-around)', () => {
  const clock = makeClock(5_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    // First approach → go-around
    feed(runner, clock, Array.from({ length: 9 }, () => approachFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Phase should settle at APPROACH');

    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'Phase should enter GO_AROUND on first missed approach');

    // Climb out resolves GO_AROUND; this should reset goAroundRecordedThisApproach
    feed(runner, clock, Array.from({ length: 2 }, () => climbFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Phase should settle into CLIMB after first go-around');
    assertEqual(events.length, 1, 'First go-around event recorded');

    // Descend again toward the runway — arm the approach context at low altitude
    feed(runner, clock, Array.from({ length: 50 }, () => descentFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.DESCENT, 'Phase should enter DESCENT on second approach');

    // Second missed approach from DESCENT without entering APPROACH phase
    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame({ raFt: 1700, altMslFt: 4300 })), 1000);
    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'Phase should detect second go-around');
    assertEqual(events.length, 2, 'Second go-around event must be recorded');
    assertEqual(events[1].previous_phase, PHASES.DESCENT, 'Second go-around previous phase should be DESCENT');
  });
});

test('detects go-around after high-speed bounce (GS never drops below threshold)', () => {
  const clock = makeClock(6_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(runner, clock, Array.from({ length: 9 }, () => approachFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Phase should settle at APPROACH');

    // High-speed bounce: WOW=true but GS stays at 130 kts (never slows down).
    // This is within the 30s time window but GS check should override suppression.
    feed(runner, clock, [taxiFrame({ iasKts: 130, gsKts: 130, raFt: 8 })], 1000);

    // Immediate climb after bounce — within 30s window but not a real landing.
    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame({ raFt: 300, altMslFt: 1200 })), 1000);

    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'High-speed bounce should be treated as go-around, not touch-and-go');
    assertEqual(events.length, 1, 'Go-around event should fire for bounced landing');
  });
});

test('detects go-around after high-speed bounce when GS is missing but IAS stays high', () => {
  const clock = makeClock(6_500_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(runner, clock, Array.from({ length: 9 }, () => approachFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Phase should settle at APPROACH');

    feed(runner, clock, [taxiFrame({ iasKts: 130, gsKts: undefined, raFt: 8 })], 1000);

    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame({ raFt: 300, altMslFt: 1200 })), 1000);

    assertEqual(runner.getPhase(), PHASES.GO_AROUND, 'High-speed bounce should not be suppressed just because GS is missing');
    assertEqual(events.length, 1, 'Go-around event should fire when IAS shows a high-speed bounce');
  });
});

test('suppresses go-around for proper airliner touch-and-go (GS drops below threshold)', () => {
  const clock = makeClock(7_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  withGoAroundCapture((events) => {
    feed(runner, clock, Array.from({ length: 9 }, () => approachFrame()), 1000);
    assertEqual(runner.getPhase(), PHASES.APPROACH, 'Phase should settle at APPROACH');

    // Proper touch-and-go: GS decelerates well below 80 kts threshold during rollout.
    feed(runner, clock, [
      taxiFrame({ iasKts: 120, gsKts: 120, raFt: 8 }),
      taxiFrame({ iasKts: 90,  gsKts: 90,  raFt: 6 }),
      taxiFrame({ iasKts: 60,  gsKts: 60,  raFt: 5 }),
      taxiFrame({ iasKts: 40,  gsKts: 40,  raFt: 5 }),
    ], 1000);

    // Climb within 30s window — this is intentional circuit continuation.
    feed(runner, clock, Array.from({ length: 9 }, () => climbFrame({ raFt: 300, altMslFt: 1200 })), 1000);

    assertEqual(runner.getPhase(), PHASES.CLIMB, 'Proper touch-and-go should be suppressed');
    assertEqual(events.length, 0, 'No go-around event expected for proper touch-and-go');
  });
});

summary('go-around detection tests');
