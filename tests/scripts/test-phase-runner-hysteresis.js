#!/usr/bin/env node
'use strict';

const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { createPhaseRunner } = require(resolveBackendRuntimeFile('lifecycle', 'phase-runner.js'));
const { PHASES } = require(resolveBackendRuntimeFile('lifecycle', 'phases.js'));
const { createHarness } = require(resolveBackendRuntimeFile('test-support', 'mini-test-harness.js'));

const { test, assertEqual, assertTrue, summary } = createHarness();

function makeClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(deltaMs) {
      nowMs += deltaMs;
      return nowMs;
    },
  };
}

function feed(runner, clock, frame, samples, dtMs = 1000) {
  for (let i = 0; i < samples; i++) {
    const nextFrame = typeof frame === 'function' ? frame(i) : frame;
    runner.updatePhase(nextFrame, () => {});
    clock.advance(dtMs);
  }
}

function cruiseFrame(overrides = {}) {
  return {
    iasKts: 250,
    wow: false,
    vsFpm: 0,
    raFt: 35000,
    gsKts: 450,
    altMslFt: 35000,
    aircraftName: 'Hysteresis Test Aircraft',
    ...overrides,
  };
}

function descentFrame(overrides = {}) {
  return {
    iasKts: 250,
    wow: false,
    vsFpm: -1200,
    raFt: 35000,
    gsKts: 450,
    altMslFt: 35000,
    aircraftName: 'Hysteresis Test Aircraft',
    ...overrides,
  };
}

function taxiFrame(overrides = {}) {
  return {
    iasKts: 15,
    wow: true,
    vsFpm: 0,
    raFt: 0,
    gsKts: 15,
    altMslFt: 300,
    aircraftName: 'Hysteresis Test Aircraft',
    ...overrides,
  };
}

function takeoffFrame(overrides = {}) {
  return {
    iasKts: 160,
    wow: false,
    vsFpm: 1500,
    raFt: 100,
    gsKts: 165,
    altMslFt: 500,
    aircraftName: 'Hysteresis Test Aircraft',
    ...overrides,
  };
}

function approachFrame(overrides = {}) {
  return {
    iasKts: 135,
    wow: false,
    vsFpm: -700,
    raFt: 700,
    gsKts: 140,
    altMslFt: 1000,
    aircraftName: 'Hysteresis Test Aircraft',
    ...overrides,
  };
}

function climbFrame(overrides = {}) {
  return {
    iasKts: 210,
    wow: false,
    vsFpm: 1800,
    raFt: 5000,
    gsKts: 250,
    altMslFt: 8000,
    aircraftName: 'Hysteresis Test Aircraft',
    ...overrides,
  };
}

console.log('\n=== Phase Runner Hysteresis Tests ===');

test('abandoned descent candidate does not poison later descent-to-cruise recovery', () => {
  const clock = makeClock(1_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, cruiseFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.CRUISE, 'phase should settle at CRUISE');

  feed(
    runner,
    clock,
    (i) => descentFrame({ altMslFt: 35000 - i * 50, raFt: 35000 - i * 50 }),
    10,
  );
  assertEqual(runner.getPhase(), PHASES.CRUISE, 'brief descent must not confirm before dwell');

  feed(runner, clock, cruiseFrame({ altMslFt: 34500, raFt: 34500 }), 2);
  assertEqual(
    runner.getState().descentEntryAltMsl,
    null,
    'abandoned descent candidate should clear its entry altitude',
  );

  feed(
    runner,
    clock,
    (i) => descentFrame({ altMslFt: 30000 - i * 50, raFt: 30000 - i * 50 }),
    50,
  );
  assertEqual(runner.getPhase(), PHASES.DESCENT, 'real sustained descent should confirm');
  assertTrue(
    runner.getState().descentEntryAltMsl <= 30000,
    'real descent entry altitude should come from the confirmed descent candidate',
  );

  feed(runner, clock, cruiseFrame({ altMslFt: 29500, raFt: 29500 }), 70);
  assertEqual(
    runner.getPhase(),
    PHASES.CRUISE,
    'small step-level after real descent should be allowed to recover to CRUISE',
  );
});

test('cruise remains locked out during early post-takeoff level-off', () => {
  const clock = makeClock(2_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.TAXI, 'phase should settle at TAXI');

  feed(runner, clock, takeoffFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.TAKEOFF, 'phase should settle at TAKEOFF');

  feed(runner, clock, climbFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.CLIMB, 'phase should settle at CLIMB');

  feed(runner, clock, cruiseFrame({ altMslFt: 15000, raFt: 15000 }), 120);
  assertEqual(
    runner.getPhase(),
    PHASES.CLIMB,
    'SID/ATC level-off should not become CRUISE inside the takeoff lockout',
  );

  feed(runner, clock, cruiseFrame({ altMslFt: 15000, raFt: 15000 }), 500);
  assertEqual(
    runner.getPhase(),
    PHASES.CRUISE,
    'sustained level flight should become CRUISE after the takeoff lockout expires',
  );
});

test('cruise ignores brief high-altitude climb bursts during altitude capture', () => {
  const clock = makeClock(2_700_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, cruiseFrame({ altMslFt: 36000, raFt: 35000 }), 9);
  assertEqual(runner.getPhase(), PHASES.CRUISE, 'phase should settle at CRUISE');

  feed(
    runner,
    clock,
    climbFrame({
      altMslFt: 36800,
      raFt: 36000,
      vsFpm: 850,
      iasKts: 262,
      gsKts: 480,
    }),
    20,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.CRUISE,
    'brief top-of-climb altitude capture should not re-enter CLIMB from CRUISE',
  );

  feed(runner, clock, cruiseFrame({ altMslFt: 37000, raFt: 36300 }), 100);
  assertEqual(
    runner.getPhase(),
    PHASES.CRUISE,
    'returning to level flight should keep CRUISE after the brief climb burst',
  );
});

test('cruise can re-enter climb during a sustained step climb', () => {
  const clock = makeClock(2_800_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, cruiseFrame({ altMslFt: 36000, raFt: 35000 }), 9);
  assertEqual(runner.getPhase(), PHASES.CRUISE, 'phase should settle at CRUISE');

  feed(
    runner,
    clock,
    climbFrame({
      altMslFt: 37200,
      raFt: 36200,
      vsFpm: 1200,
      iasKts: 270,
      gsKts: 490,
    }),
    60,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.CLIMB,
    'sustained step climb should still be allowed to re-enter CLIMB from CRUISE',
  );
});

test('parked does not advance to taxi from IAS-only ground speed noise', () => {
  const clock = makeClock(3_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame({ iasKts: 35, gsKts: 0 }), 9);
  assertEqual(
    runner.getPhase(),
    PHASES.PARKED,
    'WOW ground movement should require nonzero ground speed, not IAS',
  );
});

test('taxi does not advance to takeoff from IAS-only WOW dropout', () => {
  const clock = makeClock(4_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.TAXI, 'phase should settle at TAXI');

  feed(runner, clock, takeoffFrame({ gsKts: 0 }), 9);
  assertEqual(
    runner.getPhase(),
    PHASES.TAXI,
    'false liftoff/takeoff gating should require real ground speed',
  );
});

test('missing GS still allows normal airborne phase detection after liftoff', () => {
  const clock = makeClock(4_500_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.TAXI, 'phase should settle at TAXI');

  feed(runner, clock, takeoffFrame({ gsKts: undefined }), 9);
  assertEqual(
    runner.getPhase(),
    PHASES.TAKEOFF,
    'missing GS should not be treated the same as explicit zero GS',
  );
});

test('parked recovers to climb when the sim is already airborne', () => {
  const clock = makeClock(4_550_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame({ iasKts: 0, gsKts: 0 }), 9);
  assertEqual(runner.getPhase(), PHASES.PARKED, 'phase should settle at PARKED');

  feed(
    runner,
    clock,
    climbFrame({
      iasKts: 150,
      gsKts: 63,
      vsFpm: 3163,
      raFt: 9000,
      altMslFt: 9241,
    }),
    20,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.CLIMB,
    'sustained airborne climb telemetry should not remain stuck in PARKED',
  );
});

test('parked can enter takeoff on confirmed liftoff telemetry', () => {
  const clock = makeClock(4_575_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame({ iasKts: 0, gsKts: 0, onRunway: true }), 9);
  assertEqual(runner.getPhase(), PHASES.PARKED, 'phase should settle at PARKED');

  feed(runner, clock, takeoffFrame({ onRunway: false }), 9);
  assertEqual(
    runner.getPhase(),
    PHASES.TAKEOFF,
    'confirmed liftoff telemetry should not be blocked from PARKED',
  );
});

test('ground states recover to confirmed airborne detector phases', () => {
  const cases = [
    {
      from: PHASES.PARKED,
      seed: taxiFrame({ iasKts: 0, gsKts: 0 }),
      frame: cruiseFrame({ altMslFt: 14000, raFt: 12000, vsFpm: 0, gsKts: 230 }),
      expected: PHASES.CRUISE,
    },
    {
      from: PHASES.PARKED,
      seed: taxiFrame({ iasKts: 0, gsKts: 0 }),
      frame: descentFrame({ altMslFt: 9000, raFt: 8500, vsFpm: -1400, gsKts: 220 }),
      expected: PHASES.DESCENT,
    },
    {
      from: PHASES.PARKED,
      seed: taxiFrame({ iasKts: 0, gsKts: 0 }),
      frame: approachFrame({ raFt: 700, altMslFt: 1200, vsFpm: -700, gsKts: 140 }),
      expected: PHASES.APPROACH,
    },
    {
      from: PHASES.TAXI,
      seed: taxiFrame(),
      frame: climbFrame({ iasKts: 180, gsKts: 190, vsFpm: 1800, raFt: 3500, altMslFt: 5000 }),
      expected: PHASES.CLIMB,
    },
  ];

  cases.forEach((entry, index) => {
    const clock = makeClock(4_580_000 + index * 100_000);
    const runner = createPhaseRunner({ timeNow: clock.now });

    feed(runner, clock, entry.seed, 9);
    assertEqual(runner.getPhase(), entry.from, `case ${index + 1} should settle at ${entry.from}`);

    feed(runner, clock, entry.frame, 70);
    assertEqual(
      runner.getPhase(),
      entry.expected,
      `case ${index + 1} should recover to ${entry.expected}`,
    );
  });
});

test('normal runway takeoff still works after ON ANY RUNWAY becomes false airborne', () => {
  const clock = makeClock(4_600_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame({ onRunway: true }), 9);
  assertEqual(runner.getPhase(), PHASES.TAXI, 'phase should settle at TAXI on runway');

  feed(runner, clock, takeoffFrame({ onRunway: false }), 9);
  assertEqual(
    runner.getPhase(),
    PHASES.TAKEOFF,
    'takeoff should use the last WOW runway status, not current airborne runway status',
  );
});

test('taxi does not advance to takeoff from off-runway WOW dropout', () => {
  const clock = makeClock(4_700_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, taxiFrame({ onRunway: false }), 9);
  assertEqual(runner.getPhase(), PHASES.TAXI, 'phase should settle at TAXI off runway');

  feed(runner, clock, takeoffFrame({ onRunway: false }), 9);
  assertEqual(
    runner.getPhase(),
    PHASES.TAXI,
    'false liftoff/takeoff detection should not promote from an off-runway ground roll',
  );
});

test('high-speed ground movement off runway does not become landing', () => {
  const clock = makeClock(4_800_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(
    runner,
    clock,
    taxiFrame({ iasKts: 90, gsKts: 90, onRunway: false }),
    9,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.TAXI,
    'high-speed non-runway ground movement should remain TAXI instead of LANDING',
  );
});

test('cold start during a high-speed runway roll does not become landing', () => {
  const clock = makeClock(4_850_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(
    runner,
    clock,
    taxiFrame({ iasKts: 130, gsKts: 130, onRunway: true }),
    9,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.TAXI,
    'high-speed on-runway movement without touchdown history should remain TAXI',
  );

  feed(runner, clock, takeoffFrame({ onRunway: false }), 9);
  assertEqual(
    runner.getPhase(),
    PHASES.TAKEOFF,
    'the cold-start runway roll should still transition to TAKEOFF after liftoff',
  );
});

test('observed touchdown can enter landing while the prior phase is still unknown', () => {
  const clock = makeClock(4_875_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, approachFrame(), 1);
  assertEqual(runner.getPhase(), PHASES.UNKNOWN, 'one airborne sample should not settle the phase');

  feed(
    runner,
    clock,
    taxiFrame({ iasKts: 120, gsKts: 120, vsFpm: -250, raFt: 3, onRunway: true }),
    9,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.LANDING,
    'an observed air-to-ground transition should provide enough touchdown context',
  );
});

test('touchdown from approach can still enter landing when runway flag is false', () => {
  const clock = makeClock(4_900_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, approachFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.APPROACH, 'phase should settle at APPROACH');

  feed(
    runner,
    clock,
    taxiFrame({ iasKts: 120, gsKts: 120, vsFpm: -250, raFt: 3, onRunway: false }),
    9,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.LANDING,
    'actual touchdown from approach should not be blocked by an imperfect runway flag',
  );
});

test('low-RA emergency recovery from cruise does not force LANDING while airborne', () => {
  const clock = makeClock(5_000_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, cruiseFrame(), 9);
  assertEqual(runner.getPhase(), PHASES.CRUISE, 'phase should settle at CRUISE');

  feed(
    runner,
    clock,
    cruiseFrame({ wow: false, vsFpm: 0, raFt: 100, altMslFt: 12000, gsKts: 120 }),
    9,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.APPROACH,
    'low-RA airborne recovery should leave CRUISE without entering LANDING',
  );
});

test('short local circuit can transition directly from climb to approach', () => {
  const clock = makeClock(5_100_000);
  const runner = createPhaseRunner({ timeNow: clock.now });

  feed(runner, clock, climbFrame({ raFt: 1800, altMslFt: 2200 }), 9);
  assertEqual(runner.getPhase(), PHASES.CLIMB, 'phase should settle at CLIMB');

  // A short descent has not satisfied the normal 45-second DESCENT dwell when
  // the aircraft enters the final-approach radio-altitude envelope.
  feed(
    runner,
    clock,
    approachFrame({ raFt: 800, altMslFt: 1200, vsFpm: -700 }),
    20,
  );
  assertEqual(
    runner.getPhase(),
    PHASES.APPROACH,
    'a valid low-RA final should not remain stuck in CLIMB',
  );
});

summary('phase runner hysteresis tests');
