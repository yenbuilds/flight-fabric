'use strict';

const assert = require('node:assert/strict');

const {
  createSimbridgeRuntimeState,
  getReplayMessages,
  rememberReplayMessage,
  resetSimbridgeBroadcastState,
} = require('./simbridge-runtime-state.js') as {
  createSimbridgeRuntimeState: (params?: Record<string, any>) => Record<string, any>;
  getReplayMessages: (runtimeState: Record<string, any>, subscriptions?: ReadonlySet<string>) => Record<string, any>[];
  rememberReplayMessage: (runtimeState: Record<string, any>, message: Record<string, any>) => void;
  resetSimbridgeBroadcastState: (runtimeState: Record<string, any>) => void;
};

let passed = 0;

function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('createSimbridgeRuntimeState groups sim, target, and broadcast state', () => {
  const runtimeState = createSimbridgeRuntimeState({
    destinationTarget: { icao: 'KSEA' },
    originTarget: { icao: 'KLAX' },
  });

  assert.equal(runtimeState.sim.lastState, null);
  assert.equal(runtimeState.sim.latestTickFrame, null);
  assert.deepEqual(runtimeState.targets.destination, { icao: 'KSEA' });
  assert.deepEqual(runtimeState.targets.origin, { icao: 'KLAX' });
  assert.equal(runtimeState.broadcast.pendingSpoilersStateTicks, 0);
  assert.deepEqual(runtimeState.replay.latestMessages, {});
});

test('resetSimbridgeBroadcastState clears all change-detection sentinels together', () => {
  const runtimeState = createSimbridgeRuntimeState();
  runtimeState.broadcast.lastFlapsNotch = '30';
  runtimeState.broadcast.lastGearState = 'down';
  runtimeState.broadcast.lastGearParkingBrake = true;
  runtimeState.broadcast.lastSpoilersState = 'ARMED';
  runtimeState.broadcast.pendingSpoilersState = 'STOWED';
  runtimeState.broadcast.pendingSpoilersStateTicks = 2;

  resetSimbridgeBroadcastState(runtimeState);

  assert.equal(runtimeState.broadcast.lastFlapsNotch, undefined);
  assert.equal(runtimeState.broadcast.lastGearState, undefined);
  assert.equal(runtimeState.broadcast.lastGearParkingBrake, undefined);
  assert.equal(runtimeState.broadcast.lastSpoilersState, undefined);
  assert.equal(runtimeState.broadcast.pendingSpoilersState, undefined);
  assert.equal(runtimeState.broadcast.pendingSpoilersStateTicks, 0);
});

test('rememberReplayMessage stores latest state-like telemetry in deterministic replay order', () => {
  const runtimeState = createSimbridgeRuntimeState();

  rememberReplayMessage(runtimeState, { type: 'altitude', msl: 12000, ra: 2500 });
  rememberReplayMessage(runtimeState, { type: 'aircraftProfile', profile: { id: 'old', name: 'Old Aircraft' } });
  rememberReplayMessage(runtimeState, { type: 'aircraftSpecificState', profileKey: 'old', values: { 'afds.cmdA': true } });
  rememberReplayMessage(runtimeState, { type: 'altitude', msl: 17000, ra: 5000 });
  rememberReplayMessage(runtimeState, { type: 'ias', value: 280 });

  assert.deepEqual(
    getReplayMessages(runtimeState).map((message) => message.type),
    ['aircraftProfile', 'aircraftSpecificState', 'ias', 'altitude'],
  );
  assert.equal(getReplayMessages(runtimeState).find((message) => message.type === 'altitude')?.msl, 17000);
});

test('aircraft change and simulator disconnect clear stale live telemetry replay data', () => {
  const runtimeState = createSimbridgeRuntimeState();

  rememberReplayMessage(runtimeState, { type: 'aircraftProfile', profile: { id: 'a', name: 'A' } });
  rememberReplayMessage(runtimeState, { type: 'altitude', msl: 12000 });
  rememberReplayMessage(runtimeState, { type: 'ias', value: 250 });
  rememberReplayMessage(runtimeState, { type: 'aircraftChanged', previousTitle: 'A', newTitle: 'B' });

  assert.deepEqual(
    getReplayMessages(runtimeState).map((message) => message.type),
    ['aircraftProfile'],
  );

  rememberReplayMessage(runtimeState, { type: 'altitude', msl: 17000 });
  rememberReplayMessage(runtimeState, { type: 'simState', simconnectConnected: false, inMenu: false });

  assert.deepEqual(
    getReplayMessages(runtimeState).map((message) => message.type),
    ['simState', 'aircraftProfile'],
  );
});

test('replay keeps the latest simulator menu state for reconnect snapshots', () => {
  const runtimeState = createSimbridgeRuntimeState();

  rememberReplayMessage(runtimeState, {
    type: 'simState',
    simconnectConnected: true,
    inMenu: true,
    lifecycleState: 'IN_MENU',
  });
  rememberReplayMessage(runtimeState, {
    type: 'simState',
    simconnectConnected: true,
    inMenu: false,
    lifecycleState: 'ACTIVE',
  });

  const replayedSimState = getReplayMessages(runtimeState).find((message) => message.type === 'simState');
  assert.equal(replayedSimState?.inMenu, false);
  assert.equal(replayedSimState?.lifecycleState, 'ACTIVE');
});

test('latest unbroadcast simulator disconnect suppresses stale live telemetry replay data', () => {
  const runtimeState = createSimbridgeRuntimeState();

  rememberReplayMessage(runtimeState, { type: 'aircraftProfile', profile: { id: 'a', name: 'A' } });
  rememberReplayMessage(runtimeState, { type: 'altitude', msl: 12000 });
  rememberReplayMessage(runtimeState, { type: 'assists', data: { slewActive: true } });
  runtimeState.sim.lastState = { type: 'simState', simconnectConnected: false, inMenu: false };

  assert.deepEqual(
    getReplayMessages(runtimeState).map((message) => message.type),
    ['aircraftProfile'],
  );
});

test('capability updates keep the replayed aircraft profile current after SDK connection and loss', () => {
  const runtimeState = createSimbridgeRuntimeState();
  const profile = { _profileKey: 'bundled/msfs/pmdg-777', profileRevision: 3 };
  const unavailable = { aircraftCommands: { commands: [] } };
  const available = { aircraftCommands: { commands: [{ id: 'configuration.lights.takeoff' }] } };
  const initialMessage = { type: 'aircraftProfile', profile, controlCapabilities: unavailable };
  rememberReplayMessage(runtimeState, initialMessage);

  for (const controlCapabilities of [available, unavailable]) {
    rememberReplayMessage(runtimeState, {
      type: 'dataSources', profileKey: profile._profileKey,
      profileRevision: profile.profileRevision, controlCapabilities,
    });
    // Ordinary source updates omit the unchanged capability catalogue. They
    // must not erase the update when a page requests the latest state again.
    rememberReplayMessage(runtimeState, { type: 'dataSources', sources: [] });
    const replayedProfile = getReplayMessages(runtimeState).find(message => message.type === 'aircraftProfile');
    assert.deepEqual(replayedProfile.controlCapabilities, controlCapabilities);
  }
  assert.deepEqual(initialMessage.controlCapabilities, unavailable, 'do not mutate the original broadcast');
});

test('replay never applies capabilities from another aircraft or profile revision', () => {
  const runtimeState = createSimbridgeRuntimeState();
  const profile = { _profileKey: 'bundled/msfs/pmdg-777', profileRevision: 3 };
  const original = { aircraftCommands: { commands: [] } };
  rememberReplayMessage(runtimeState, { type: 'aircraftProfile', profile, controlCapabilities: original });

  for (const token of [
    { profileKey: 'bundled/msfs/pmdg-737', profileRevision: 3 },
    { profileKey: profile._profileKey, profileRevision: 2 },
    { profileKey: profile._profileKey },
    { profileRevision: 3 },
  ]) {
    rememberReplayMessage(runtimeState, {
      type: 'dataSources', ...token,
      controlCapabilities: { aircraftCommands: { commands: [{ id: 'configuration.lights.takeoff' }] } },
    });
    const replayedProfile = getReplayMessages(runtimeState).find(message => message.type === 'aircraftProfile');
    assert.deepEqual(replayedProfile.controlCapabilities, original);
  }
});

test('toolbar history is bounded, merges final assessments and is opt-in rather than replaying live alerts', () => {
  const state = createSimbridgeRuntimeState();
  rememberReplayMessage(state, { type: 'aircraftProfile', profile: { _profileKey: 'bundled/msfs/pmdg-737', aircraftTitle: '737' } });
  rememberReplayMessage(state, { type: 'flightTime', active: true, flightId: 'one' });
  rememberReplayMessage(state, { type: 'landing', final: false, grade: 'GOOD' });
  rememberReplayMessage(state, { type: 'landing', final: true, grade: 'HARD', runwayExcursion: true, approachProfile: Array(10000).fill({}) });
  rememberReplayMessage(state, { type: 'ultimateStabilityScore', score: 45, verdict: 'unstable', breakdown: Array(10000).fill({}) });
  for (let i = 0; i < 20; i++) rememberReplayMessage(state, { type: 'flightViolation', event: 'start', label: `Caution ${i}`, severity: 'critical', timestamp_ms: i });
  const history = getReplayMessages(state, new Set(['toolbarFlightHistory'])).at(-1);
  assert.equal(history?.type, 'toolbarFlightHistory');
  assert.equal(history?.landing.final, true);
  assert.equal(history?.landing.ultimateStability.score, 45);
  assert.equal(history?.landing.approachProfile, undefined);
  assert.equal(history?.cautions.length, 6);
  assert.equal(history?.cautions[0].label, 'Caution 19');
  assert.equal(history?.cautions[5].label, 'Caution 14');
  assert.ok(JSON.stringify(history).length < 3000);
  assert.ok(!getReplayMessages(state).some(message => ['toolbarFlightHistory', 'landing', 'flightViolation', 'ultimateStabilityScore'].includes(message.type)));
});

test('toolbar history survives transient disconnects but resets for another aircraft or new flight', () => {
  const state = createSimbridgeRuntimeState();
  const profile = { type: 'aircraftProfile', profile: { _profileKey: 'bundled/msfs/pmdg-737', aircraftTitle: '737', profileRevision: 1 } };
  const history = () => getReplayMessages(state, new Set(['toolbarFlightHistory'])).at(-1);
  rememberReplayMessage(state, profile);
  rememberReplayMessage(state, { type: 'flightTime', active: true, flightId: 'one' });
  rememberReplayMessage(state, { type: 'landing', final: true, grade: 'GOOD' });
  rememberReplayMessage(state, { type: 'flightViolation', event: 'start', label: 'Stall' });
  rememberReplayMessage(state, { type: 'simState', simconnectConnected: false });
  rememberReplayMessage(state, { ...profile, profile: { ...profile.profile, profileRevision: 2 } });
  assert.equal(history()?.landing?.grade, 'GOOD');
  rememberReplayMessage(state, { type: 'flightTime', active: false, flightId: 'one' });
  assert.ok(history()?.landing, 'end of flight preserves its last landing');
  rememberReplayMessage(state, { type: 'flightTime', active: true, flightId: 'two' });
  assert.equal(history()?.landing, null);
  assert.equal(history()?.cautions.length, 0);
  rememberReplayMessage(state, { type: 'landing', final: true, grade: 'FIRM' });
  rememberReplayMessage(state, { ...profile, profile: { ...profile.profile, aircraftTitle: 'Other 737' } });
  assert.equal(history()?.landing, null, 'changed identity is enough even without aircraftChanged');
  rememberReplayMessage(state, { type: 'landing', final: true, grade: 'GOOD' });
  rememberReplayMessage(state, { type: 'aircraftChanged' });
  rememberReplayMessage(state, { type: 'ultimateStabilityScore', score: 100, verdict: 'stable' });
  assert.equal(history()?.landing, null, 'late score cannot resurrect a cleared landing');
});

test('toolbar uses live startedAt boundaries and returns detached snapshots including score withdrawal', () => {
  const state = createSimbridgeRuntimeState();
  const profile = { type: 'aircraftProfile', profile: { _profileKey: 'bundled/msfs/pmdg-737', aircraftTitle: '737' } };
  const history = () => getReplayMessages(state, new Set(['toolbarFlightHistory'])).at(-1);
  rememberReplayMessage(state, profile);
  rememberReplayMessage(state, { type: 'flightTime', startedAt: '2026-09-21T01:00:00Z' });
  rememberReplayMessage(state, { type: 'landing', final: true, grade: 'GOOD', ultimateStability: { score: 95, verdict: 'stable' }, touchdownDistance: { distanceFt: 1200, bounceCount: 2, lateralOffsetFt: 45, lateralOffsetSide: 'right', shortLanding: true } });
  rememberReplayMessage(state, { type: 'ultimateStabilityScore', score: null, verdict: 'no_verdict' });
  const first = history();
  assert.equal(first?.landing.ultimateStability.score, null);
  assert.equal(first?.landing.touchdownDistance.shortLanding, true);
  first!.landing.grade = 'MUTATED';
  assert.equal(history()?.landing.grade, 'GOOD');
  rememberReplayMessage(state, { type: 'flightTime', startedAt: '2026-09-21T02:00:00Z' });
  assert.equal(history()?.landing, null);
  assert.equal(history()?.flightId, '2026-09-21T02:00:00Z');
});

test('a late rollout final after an aircraft change is ignored until the next touchdown', () => {
  const state = createSimbridgeRuntimeState();
  const profile = { type: 'aircraftProfile', profile: { _profileKey: 'bundled/msfs/pmdg-737', aircraftTitle: '737' } };
  const history = () => getReplayMessages(state, new Set(['toolbarFlightHistory'])).at(-1);
  rememberReplayMessage(state, profile);
  rememberReplayMessage(state, { type: 'landing', final: false, grade: 'GOOD' });
  rememberReplayMessage(state, { type: 'aircraftChanged' });
  rememberReplayMessage(state, { ...profile, profile: { ...profile.profile, aircraftTitle: 'Other 737' } });
  rememberReplayMessage(state, { type: 'landing', final: true, grade: 'HARD' });
  rememberReplayMessage(state, { type: 'ultimateStabilityScore', score: 45, verdict: 'unstable' });
  assert.equal(history()?.landing, null);
  rememberReplayMessage(state, { type: 'landing', final: false, grade: 'FIRM' });
  rememberReplayMessage(state, { type: 'landing', final: true, grade: 'FIRM' });
  assert.equal(history()?.landing?.final, true);
  assert.equal(history()?.landing?.grade, 'FIRM');
});

console.log(`PASS simbridge-runtime-state ${passed}`);

export {};
