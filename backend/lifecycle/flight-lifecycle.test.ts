#!/usr/bin/env node
// flight-lifecycle.test.js
// Assertion-based tests for lifecycle core logic.

const {
  LifecycleState,
  computeInFlightContext,
  checkFlightStartEligibility,
  updateActiveFlightEndGuard,
  updateManualAutoStartSuppression,
  updateMotionDetector,
} = require('./flight-lifecycle');
const { createHarness } = require('../../tests/support/mini-test-harness');

const { test, assertEqual, assertTrue, summary } = createHarness();

test('computeInFlightContext gates menu/paused/disconnected', () => {
  const disconnected = computeInFlightContext({ simconnectConnected: false });
  assertEqual(disconnected.inFlightContext, false, 'Disconnected gate');
  assertEqual(disconnected.reason, 'simconnect_disconnected', 'Disconnected reason');

  const menu = computeInFlightContext({
    simconnectConnected: true,
    simRunning: true,
    userInputEnabled: false,
    aircraftLoadedName: 'B737',
  });
  assertEqual(menu.inFlightContext, false, 'Menu gate');
  assertEqual(menu.reason, 'user_input_disabled', 'Menu reason');

  const good = computeInFlightContext({
    simconnectConnected: true,
    simRunning: true,
    userInputEnabled: true,
    aircraftLoadedName: 'B737',
    paused: false,
  });
  assertEqual(good.inFlightContext, true, 'Valid in-flight context');
  assertEqual(good.reason, 'ok', 'Valid reason');
});

test('checkFlightStartEligibility blocks menu/globe and allows valid airborne start', () => {
  const now = Date.now();

  const inMenu = checkFlightStartEligibility({
    flightActive: false,
    simconnectConnected: true,
    inFlightContext: false,
    nowEpochMs: now,
  });
  assertEqual(inMenu.eligible, false, 'Menu should not be eligible');
  assertEqual(inMenu.state, LifecycleState.IN_MENU, 'Menu state');

  const globe = checkFlightStartEligibility({
    flightActive: false,
    simconnectConnected: true,
    inFlightContext: true,
    altMslFt: 100001,
    nowEpochMs: now,
  });
  assertEqual(globe.eligible, false, 'Globe view should not be eligible');
  assertEqual(globe.state, LifecycleState.IN_MENU, 'Globe state');

  const airborne = checkFlightStartEligibility({
    flightActive: false,
    simconnectConnected: true,
    inFlightContext: true,
    altMslFt: 1500,
    iasKnots: 75,
    gsKnots: 85,
    raFeet: 1000,
    wow: false,
    motionDetected: false,
    activeFieldCount: 10,
    nowEpochMs: now,
  });
  assertTrue(airborne.eligible, 'Valid airborne frame should be eligible');
  assertEqual(airborne.state, LifecycleState.READY, 'Eligible state should be READY');

  const iasOnlyAirborne = checkFlightStartEligibility({
    flightActive: false,
    simconnectConnected: true,
    inFlightContext: true,
    altMslFt: 1500,
    iasKnots: 75,
    gsKnots: 0,
    raFeet: 1000,
    wow: false,
    motionDetected: false,
    activeFieldCount: 10,
    nowEpochMs: now,
  });
  assertEqual(iasOnlyAirborne.eligible, false, 'Airborne recovery should not start from IAS without ground speed');
});

test('sequence replay over realistic approach frames remains eligible', () => {
  const frames = [
    { timestampMs: 1769007205054, iasKts: 75, gsKts: 85, raFt: 1000, altMslFt: 1500, wow: false },
    { timestampMs: 1769007205154, iasKts: 74.99, gsKts: 84.99, raFt: 998, altMslFt: 1498, wow: false },
    { timestampMs: 1769007205254, iasKts: 74.98, gsKts: 84.98, raFt: 996, altMslFt: 1496, wow: false },
  ];

  const eligibility = frames.map((frame) =>
    checkFlightStartEligibility({
      flightActive: false,
      simconnectConnected: true,
      inFlightContext: true,
      altMslFt: frame.altMslFt,
      iasKnots: frame.iasKts,
      gsKnots: frame.gsKts,
      raFeet: frame.raFt,
      wow: frame.wow,
      motionDetected: false,
      activeFieldCount: 10,
      nowEpochMs: frame.timestampMs,
    })
  );

  assertTrue(eligibility.every((result) => result.eligible === true), 'All replay frames should be eligible');
});

test('checkFlightStartEligibility allows on-ground movement start', () => {
  const eligibility = checkFlightStartEligibility({
    flightActive: false,
    simconnectConnected: true,
    inFlightContext: true,
    altMslFt: 320,
    iasKnots: 0,
    gsKnots: 5,
    raFeet: 0,
    wow: true,
    motionDetected: true,
    activeFieldCount: 10,
    nowEpochMs: Date.now(),
  });

  assertEqual(eligibility.eligible, true, 'On-ground aircraft movement should start recording');
  assertEqual(eligibility.checks.startConditionMet, true, 'Movement should satisfy the start condition');
});

test('manual auto-start suppression remains active while the same aircraft is airborne', () => {
  const result = updateManualAutoStartSuppression({
    suppression: {
      active: true,
      sinceMs: 1000,
      aircraftTitle: 'A320',
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    },
    nowEpochMs: 60000,
    simconnectConnected: true,
    inFlightContext: true,
    aircraftTitle: 'A320',
    phase: 'CLIMB',
    wow: false,
    iasKnots: 180,
    gsKnots: 190,
    maxEnginePct: 85,
  });

  assertEqual(result.suppressed, true, 'Same airborne context should remain suppressed');
  assertEqual(result.cleared, false, 'Same airborne context should not clear suppression');
  assertTrue(result.blockers.includes('manual_stop_auto_start_suppressed'), 'Suppression blocker should be visible');
});

test('manual auto-start suppression remains active through a connected simulator pause', () => {
  const first = updateManualAutoStartSuppression({
    suppression: {
      active: true,
      sinceMs: 1000,
      aircraftTitle: 'A320',
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    },
    nowEpochMs: 10000,
    simconnectConnected: true,
    simRunning: true,
    inFlightContext: false,
    paused: true,
    aircraftTitle: 'A320',
    phase: 'CLIMB',
    wow: false,
    iasKnots: 180,
    gsKnots: 190,
    maxEnginePct: 85,
    contextResetDwellMs: 5000,
  });

  const second = updateManualAutoStartSuppression({
    suppression: first.suppression,
    nowEpochMs: 60000,
    simconnectConnected: true,
    simRunning: true,
    inFlightContext: false,
    paused: true,
    aircraftTitle: 'A320',
    phase: 'CLIMB',
    wow: false,
    iasKnots: 180,
    gsKnots: 190,
    maxEnginePct: 85,
    contextResetDwellMs: 5000,
  });

  assertEqual(second.suppressed, true, 'Connected pause should preserve manual-stop suppression');
  assertEqual(second.cleared, false, 'Connected pause should not re-arm auto-start');
  assertEqual(second.suppression.contextResetSinceMs, null, 'Connected pause should not start a context-reset timer');
});

test('manual auto-start suppression clears after parked engines-off dwell', () => {
  const first = updateManualAutoStartSuppression({
    suppression: {
      active: true,
      sinceMs: 1000,
      aircraftTitle: 'A320',
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    },
    nowEpochMs: 10000,
    simconnectConnected: true,
    inFlightContext: true,
    aircraftTitle: 'A320',
    phase: 'PARKED',
    wow: true,
    iasKnots: 0,
    gsKnots: 0,
    anyEngineRunning: false,
    parkedResetDwellMs: 30000,
  });

  assertEqual(first.suppressed, true, 'Initial parked frame should start the re-arm dwell');
  assertEqual(first.suppression.parkedResetSinceMs, 10000, 'Parked dwell start should be tracked');

  const second = updateManualAutoStartSuppression({
    suppression: first.suppression,
    nowEpochMs: 40000,
    simconnectConnected: true,
    inFlightContext: true,
    aircraftTitle: 'A320',
    phase: 'PARKED',
    wow: true,
    iasKnots: 0,
    gsKnots: 0,
    anyEngineRunning: false,
    parkedResetDwellMs: 30000,
  });

  assertEqual(second.suppressed, false, 'Parked engines-off dwell should re-arm auto-start');
  assertEqual(second.cleared, true, 'Parked engines-off dwell should clear suppression');
  assertEqual(second.clearReason, 'parked_engines_off', 'Clear reason should identify parked reset');
});

test('manual auto-start suppression clears after aircraft context reset dwell', () => {
  const first = updateManualAutoStartSuppression({
    suppression: {
      active: true,
      sinceMs: 1000,
      aircraftTitle: 'A320',
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    },
    nowEpochMs: 5000,
    simconnectConnected: false,
    inFlightContext: false,
    aircraftTitle: null,
    contextResetDwellMs: 5000,
  });

  assertEqual(first.suppressed, true, 'Initial context reset should start the re-arm dwell');
  assertEqual(first.suppression.contextResetSinceMs, 5000, 'Context reset dwell start should be tracked');

  const second = updateManualAutoStartSuppression({
    suppression: first.suppression,
    nowEpochMs: 10000,
    simconnectConnected: false,
    inFlightContext: false,
    aircraftTitle: null,
    contextResetDwellMs: 5000,
  });

  assertEqual(second.suppressed, false, 'Context reset dwell should re-arm auto-start');
  assertEqual(second.cleared, true, 'Context reset dwell should clear suppression');
  assertEqual(second.clearReason, 'context_reset', 'Clear reason should identify context reset');
});

test('manual auto-start suppression clears after connected simulator-stop dwell', () => {
  const first = updateManualAutoStartSuppression({
    suppression: {
      active: true,
      sinceMs: 1000,
      aircraftTitle: 'A320',
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    },
    nowEpochMs: 5000,
    simconnectConnected: true,
    simRunning: false,
    inFlightContext: false,
    paused: true,
    aircraftTitle: 'A320',
    contextResetDwellMs: 5000,
  });

  const second = updateManualAutoStartSuppression({
    suppression: first.suppression,
    nowEpochMs: 10000,
    simconnectConnected: true,
    simRunning: false,
    inFlightContext: false,
    paused: true,
    aircraftTitle: 'A320',
    contextResetDwellMs: 5000,
  });

  assertEqual(second.suppressed, false, 'Simulator-stop dwell should re-arm auto-start');
  assertEqual(second.cleared, true, 'Simulator-stop dwell should clear suppression');
  assertEqual(second.clearReason, 'context_reset', 'Simulator-stop clear should identify context reset');
});

test('manual auto-start suppression clears immediately when aircraft changes', () => {
  const result = updateManualAutoStartSuppression({
    suppression: {
      active: true,
      sinceMs: 1000,
      aircraftTitle: 'A320',
      parkedResetSinceMs: null,
      contextResetSinceMs: null,
    },
    nowEpochMs: 2000,
    simconnectConnected: true,
    inFlightContext: true,
    aircraftTitle: 'B738',
    phase: 'PARKED',
    wow: true,
    iasKnots: 0,
    gsKnots: 0,
    anyEngineRunning: false,
  });

  assertEqual(result.suppressed, false, 'Aircraft change should re-arm auto-start immediately');
  assertEqual(result.cleared, true, 'Aircraft change should clear suppression');
  assertEqual(result.clearReason, 'aircraft_changed', 'Clear reason should identify aircraft change');
});

test('active flight end guard ends after SimConnect disconnect grace', () => {
  const first = updateActiveFlightEndGuard({
    state: null,
    flightActive: true,
    nowEpochMs: 1000,
    simconnectConnected: false,
    disconnectGraceMs: 5000,
  });

  assertEqual(first.pendingReasonStarted, 'simconnect_disconnect', 'Initial disconnect should start a pending end');
  assertEqual(first.state.simconnectDisconnectedSinceMs, 1000, 'Disconnect start should be tracked');
  assertEqual(first.endReason, null, 'Initial disconnect frame should stay inside grace period');

  const second = updateActiveFlightEndGuard({
    state: first.state,
    flightActive: true,
    nowEpochMs: 6000,
    simconnectConnected: false,
    disconnectGraceMs: 5000,
  });

  assertEqual(second.endReason, 'simconnect_disconnect:5s', 'Disconnect grace expiry should request flight end');
  assertEqual(second.endElapsedMs, 5000, 'Disconnect elapsed time should be reported');
});

test('active flight end guard ends when simulator stops while SimConnect remains connected', () => {
  const connected = updateActiveFlightEndGuard({
    state: null,
    flightActive: true,
    nowEpochMs: 1000,
    simconnectConnected: true,
    simRunning: true,
    simStoppedGraceMs: 5000,
  });

  assertEqual(connected.state.lastSimconnectConnectedMs, 1000, 'Connected frame should update the last connected timestamp');

  const stopped = updateActiveFlightEndGuard({
    state: connected.state,
    flightActive: true,
    nowEpochMs: 2000,
    simconnectConnected: true,
    simRunning: false,
    simStoppedGraceMs: 5000,
  });

  assertEqual(stopped.pendingReasonStarted, 'sim_stopped', 'SimStop should start a pending end even while connected');
  assertEqual(stopped.state.simStoppedSinceMs, 2000, 'SimStop start should be tracked');
  assertEqual(stopped.endReason, null, 'Initial SimStop frame should stay inside grace period');

  const ended = updateActiveFlightEndGuard({
    state: stopped.state,
    flightActive: true,
    nowEpochMs: 7000,
    simconnectConnected: true,
    simRunning: false,
    simStoppedGraceMs: 5000,
  });

  assertEqual(ended.endReason, 'sim_stopped:5s', 'SimStop grace expiry should request flight end');
  assertEqual(ended.endElapsedMs, 5000, 'SimStop elapsed time should be reported');
});

test('active flight end guard clears pending ends when simulator recovers before grace expiry', () => {
  const connected = updateActiveFlightEndGuard({
    state: null,
    flightActive: true,
    nowEpochMs: 1000,
    simconnectConnected: true,
    simRunning: true,
    disconnectGraceMs: 5000,
    simStoppedGraceMs: 5000,
  });

  const stopped = updateActiveFlightEndGuard({
    state: connected.state,
    flightActive: true,
    nowEpochMs: 2000,
    simconnectConnected: true,
    simRunning: false,
    disconnectGraceMs: 5000,
    simStoppedGraceMs: 5000,
  });

  const resumed = updateActiveFlightEndGuard({
    state: stopped.state,
    flightActive: true,
    nowEpochMs: 3000,
    simconnectConnected: true,
    simRunning: true,
    disconnectGraceMs: 5000,
    simStoppedGraceMs: 5000,
  });

  assertEqual(resumed.endReason, null, 'Recovered SimStop should not end the active flight');
  assertEqual(resumed.state.pendingReason, null, 'Recovered SimStop should clear the pending reason');
  assertEqual(resumed.state.simStoppedSinceMs, null, 'Recovered SimStop should clear the stopped timer');

  const disconnected = updateActiveFlightEndGuard({
    state: resumed.state,
    flightActive: true,
    nowEpochMs: 4000,
    simconnectConnected: false,
    disconnectGraceMs: 5000,
    simStoppedGraceMs: 5000,
  });

  const reconnected = updateActiveFlightEndGuard({
    state: disconnected.state,
    flightActive: true,
    nowEpochMs: 5000,
    simconnectConnected: true,
    simRunning: true,
    disconnectGraceMs: 5000,
    simStoppedGraceMs: 5000,
  });

  assertEqual(reconnected.endReason, null, 'Recovered SimConnect disconnect should not end the active flight');
  assertEqual(reconnected.state.pendingReason, null, 'Recovered SimConnect disconnect should clear the pending reason');
  assertEqual(reconnected.state.simconnectDisconnectedSinceMs, null, 'Recovered SimConnect disconnect should clear the disconnect timer');
});

test('active flight end guard keeps recording open during a connected simulator pause', () => {
  const result = updateActiveFlightEndGuard({
    state: null,
    flightActive: true,
    nowEpochMs: 60000,
    simconnectConnected: true,
    simRunning: true,
    disconnectGraceMs: 5000,
    simStoppedGraceMs: 5000,
  });

  assertEqual(result.endReason, null, 'Connected pause should not end the active recording');
  assertEqual(result.state.pendingReason, null, 'Connected pause should not start an end timer');
});

test('updateMotionDetector ignores IAS-only changes while waiting for ground-speed movement', () => {
  const first = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 1000,
    iasKnots: 100,
    gs: 0,
    baseline: null,
  });

  const second = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 4000,
    iasKnots: 103,
    gs: 0,
    baseline: first.baseline,
  });

  assertEqual(second.motionOverWindow, false, 'IAS delta alone should not satisfy movement after the window');
  assertEqual(second.motionDebug.dIas, 3, 'IAS delta should be tracked for diagnostics');
});

test('updateMotionDetector does not detect movement before the configured window elapses', () => {
  const first = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 1000,
    iasKnots: 100,
    gs: 0,
    baseline: null,
  });

  const second = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 1100,
    iasKnots: 100,
    gs: 2.1,
    baseline: first.baseline,
  });

  assertEqual(second.motionOverWindow, false, 'Movement should not be detected before the window elapses');
  assertEqual(second.motionDebug.ageMs, 100, 'Motion diagnostics should report the elapsed window age');
});

test('updateMotionDetector detects GS delta after the configured window', () => {
  const first = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 1000,
    iasKnots: 100,
    gs: 0,
    baseline: null,
  });

  const second = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 4000,
    iasKnots: 100,
    gs: 2.1,
    baseline: first.baseline,
  });

  assertEqual(second.motionOverWindow, true, 'GS delta should satisfy movement after the window');
  assertEqual(second.motionDebug.dGs, 2.1, 'GS delta should be tracked for diagnostics');
});

test('updateMotionDetector detects sustained GS movement after the configured window', () => {
  const first = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 1000,
    iasKnots: 0,
    gs: 5,
    baseline: null,
  });

  const second = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 4000,
    iasKnots: 0,
    gs: 5,
    baseline: first.baseline,
  });

  assertEqual(second.motionOverWindow, true, 'steady taxi movement should satisfy movement after the window');
  assertEqual(second.motionDebug.dGs, 0, 'steady GS should not require a fresh acceleration delta');
});

test('updateMotionDetector detects GS movement when IAS is unavailable', () => {
  const first = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 1000,
    iasKnots: null,
    gs: 0,
    baseline: null,
  });

  const second = updateMotionDetector({
    flightActive: false,
    requireMovement: true,
    windowMs: 3000,
    minIasDeltaKts: 2,
    minGsDeltaKts: 2,
    nowEpochMs: 4000,
    iasKnots: null,
    gs: 2.1,
    baseline: first.baseline,
  });

  assertEqual(second.motionOverWindow, true, 'GS movement should not require IAS telemetry');
  assertEqual(second.telemetryValidForMotion, true, 'GS alone is valid movement telemetry');
});

summary('flight-lifecycle tests');

export {};
