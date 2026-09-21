import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseFlightVoiceCue as choose, buildFlightVoiceCues, flightPhaseBrief, isFlightCueDataLive } from './flight-cues-model.js';
import phases from '../../../shared/flight-phases.js';

const chooseFlightVoiceCue = options => choose({ activeProfileKey: 'active-profile', ...options });

const now = 100_000;
const liveStatus = { websocket: 'ready', simConnected: true, simInMenu: false };
const liveFlight = { mode: 'live', lastLiveTelemetryAt: now - 1000 };

function command(id, kind, patterns, input = { kind: 'none' }) {
  return { id, kind, label: id, speech: { patterns }, input };
}

function catalogue(commands) {
  return {
    configurationId: 'aircraft-v1',
    profileKey: 'active-profile',
    commands: Object.fromEntries(commands.map((item) => [item.id, item])),
  };
}

test('Flight cues rest when the simulator is offline, in menus, or telemetry is stale', () => {
  assert.equal(isFlightCueDataLive({ status: liveStatus, flight: liveFlight, now }), true);
  assert.equal(isFlightCueDataLive({ status: liveStatus, flight: { ...liveFlight, lastLiveTelemetryAt: now + 300 }, now }), true,
    'sub-second timestamps can be newer than the throttled cues clock');
  assert.equal(isFlightCueDataLive({ status: liveStatus, flight: { ...liveFlight, lastLiveTelemetryAt: now + 7000 }, now }), false,
    'a clock jump must not keep old data live indefinitely');
  assert.equal(isFlightCueDataLive({ status: { ...liveStatus, simInMenu: true }, flight: liveFlight, now }), false);
  assert.equal(isFlightCueDataLive({ status: liveStatus, flight: { ...liveFlight, lastLiveTelemetryAt: now - 7000 }, now }), false);
  assert.equal(isFlightCueDataLive({ status: { ...liveStatus, websocket: 'disconnected' }, flight: liveFlight, now }), false);
});

test('Flight cues show takeoff lights during taxi, before the detected takeoff phase', () => {
  const takeoffPreset = command('configuration.lights.takeoff', 'preset', ['set lights for takeoff']);
  const landingLights = command('lights.landing.set', 'action', ['landing lights {value}'], { kind: 'boolean' });
  const telemetry = { lights: { available: true, landing: false }, observedAt: { lights: Date.now() } };
  const preferred = chooseFlightVoiceCue({ phase: 'TAXI', telemetry, catalogue: catalogue([takeoffPreset, landingLights]), available: true, live: true });
  assert.equal(preferred.id, takeoffPreset.id);
  assert.equal(preferred.phrase, 'set lights for takeoff');
  assert.equal(preferred.title, 'Before takeoff');
  const fallback = chooseFlightVoiceCue({ phase: 'TAXI', telemetry, catalogue: catalogue([landingLights]), available: true, live: true });
  assert.equal(fallback.id, landingLights.id);
  assert.equal(fallback.phrase, 'landing lights on');
  assert.equal(chooseFlightVoiceCue({ phase: 'TAKEOFF', telemetry, catalogue: catalogue([takeoffPreset, landingLights]), available: true, live: true }), null,
    'the detected takeoff phase is already too late for setup lights');
  assert.equal(chooseFlightVoiceCue({ phase: 'TAXI', telemetry: { ...telemetry, observedAt: { lights: Date.now() - 7000 } }, catalogue: catalogue([landingLights]), available: true, live: true }), null,
    'an individual light cue needs fresh observed light state');
  assert.equal(chooseFlightVoiceCue({ phase: 'TAXI', telemetry, catalogue: catalogue([takeoffPreset]), available: true, live: true,
    pendingCommands: { 'aircraft-command:configuration.lights.takeoff': true } }), null,
  'a preset already pending should not be suggested again');
});

test('Flight cues never show unsupported, unadvertised, inappropriate, or unavailable commands', () => {
  const gear = command('surfaces.gear.set', 'action', ['gear {value}'], { kind: 'enum', values: ['up'] });
  const gearDown = chooseFlightVoiceCue({ phase: 'APPROACH', telemetry: { gearState: 'UP', observedAt: { gear: Date.now() } }, catalogue: catalogue([gear]), available: true, live: true });
  assert.equal(gearDown, null, 'a command without the requested input is not suggested');

  const correctGear = command('surfaces.gear.set', 'action', ['gear {value}'], { kind: 'enum', values: ['up', 'down'] });
  const freshGearUp = { gearState: 'UP', observedAt: { gear: Date.now() } };
  const validApproachCue = chooseFlightVoiceCue({ phase: 'APPROACH', telemetry: freshGearUp, catalogue: catalogue([correctGear]), available: true, live: true });
  assert.equal(validApproachCue?.phrase, 'gear down');
  assert.equal(chooseFlightVoiceCue({ phase: 'APPROACH', telemetry: { ...freshGearUp, observedAt: { gear: Date.now() - 7000 } }, catalogue: catalogue([correctGear]), available: true, live: true }), null,
    'a stale gear readback must not produce a configuration cue');
  assert.equal(chooseFlightVoiceCue({ phase: 'APPROACH', telemetry: freshGearUp, catalogue: catalogue([correctGear]), available: true, live: true, activeProfileKey: 'different-aircraft' }), null,
    'voice cues must match the active aircraft profile');
  assert.equal(chooseFlightVoiceCue({ phase: 'APPROACH', telemetry: { gearState: 'DOWN' }, catalogue: catalogue([correctGear]), available: true, live: true }), null);
  assert.equal(chooseFlightVoiceCue({ phase: 'APPROACH', telemetry: { gearState: 'UP' }, catalogue: catalogue([correctGear]), available: false, live: true }), null);
  assert.equal(chooseFlightVoiceCue({ phase: 'APPROACH', telemetry: { gearState: 'UP' }, catalogue: catalogue([correctGear]), available: true, live: false }), null);
  assert.equal(chooseFlightVoiceCue({ phase: 'GO_AROUND', telemetry: { gearState: 'DOWN' }, catalogue: catalogue([correctGear]), available: true, live: true }), null);
  assert.equal(chooseFlightVoiceCue({ phase: 'LANDING', telemetry: { gearState: 'UP' }, catalogue: catalogue([correctGear]), available: true, live: true }), null,
    'gear setup belongs to approach, not an already-detected landing');
});

test('every published phase has useful context, including generic aircraft and arrival at the stand', () => {
  const titles = new Set();
  for (const phase of phases.PUBLISHED_PHASES) {
    const brief = flightPhaseBrief(phase);
    assert.ok(brief.detail.length > 40, phase);
    assert.doesNotMatch(brief.title, /Waiting|No cue/);
    titles.add(brief.title);
  }
  assert.equal(titles.size, phases.PUBLISHED_PHASES.length);
  assert.match(flightPhaseBrief('PARKED', { arrived: true }).title, /after landing/);
  assert.match(flightPhaseBrief('UNKNOWN').title, /Waiting/);
});

test('flap reminders teach the aircraft detents without ordering full retraction in climb', () => {
  const flaps = command('surfaces.flaps.set', 'action', ['set flaps {value}'], { kind: 'enum', values: ['up', '1', '5', '15', '30', '40'] });
  const base = { phase: 'CLIMB', telemetry: { flapsExtended: true, observedAt: { flaps: now } }, now,
    catalogue: catalogue([flaps]), available: true, live: true };
  const cue = chooseFlightVoiceCue(base);
  assert.equal(cue.phrase, 'set flaps [next detent]');
  assert.match(cue.valueHint, /up, 1, 5, 15, 30, 40/);
  assert.equal(chooseFlightVoiceCue({ ...base, telemetry: { flaps: 'NaN', observedAt: { flaps: now } } }), null);
  const adjust = command('surfaces.flaps.adjust', 'action', ['flaps {value} one'], { kind: 'enum', values: ['increase', 'decrease'] });
  assert.equal(chooseFlightVoiceCue({ ...base, catalogue: catalogue([adjust]) }).phrase, 'flaps decrease one');
  assert.equal(chooseFlightVoiceCue({ ...base, catalogue: catalogue([flaps, adjust]), pendingCommands: { 'aircraft-command:surfaces.flaps.set': true } }), null);
});

test('missing observations, wrong input contracts and legacy pending commands cannot trigger configuration cues', () => {
  const lights = command('lights.landing.set', 'action', ['landing lights {value}'], { kind: 'boolean' });
  const base = { phase: 'TAXI', catalogue: catalogue([lights]), available: true, live: true, now,
    telemetry: { lights: { available: true }, observedAt: { lights: now } } };
  assert.equal(chooseFlightVoiceCue(base), null);
  const observedOff = { ...base, telemetry: { ...base.telemetry, lights: { available: true, landing: false } } };
  assert.ok(chooseFlightVoiceCue(observedOff));
  assert.equal(chooseFlightVoiceCue({ ...observedOff, pendingCommands: { 'light-set:landing': true } }), null);
  assert.equal(chooseFlightVoiceCue({ ...observedOff, catalogue: catalogue([{ ...lights, input: { kind: 'none' } }]) }), null);
  assert.equal(chooseFlightVoiceCue({ ...observedOff, activeProfileKey: '' }), null);
  assert.equal(chooseFlightVoiceCue({ ...observedOff, activeProfileRevision: 2, catalogue: { ...base.catalogue, profileRevision: 1 } }), null);
});

test('APU cues honor shared fault/starting/available observations only for the active profile and fresh sample', () => {
  const apu = command('configuration.apu.start', 'preset', ['start apu']);
  apu.observations = [{ fieldId: 'systems.apuAvailable', expectedValue: true, label: 'APU available', inhibitsRequest: true }];
  const snapshot = { available: true, activeProfileKey: 'active-profile', activeProfileRevision: 1,
    sourceStatus: 'connected', receivedAt: now, updatedAt: new Date(now).toISOString(),
    valueUpdatedAt: { 'systems.apuAvailable': new Date(now).toISOString() }, values: { 'systems.apuAvailable': true } };
  const base = { phase: 'PARKED', catalogue: { ...catalogue([apu]), profileRevision: 1 }, aircraftSnapshot: snapshot, available: true, live: true, now };
  assert.equal(chooseFlightVoiceCue(base), null);
  assert.ok(chooseFlightVoiceCue({ ...base, aircraftSnapshot: { ...snapshot, activeProfileKey: 'old-aircraft' } }));
  assert.ok(chooseFlightVoiceCue({ ...base, now: now + 3000 }), 'old data must not be treated as an observed outcome');
});

test('cruise readbacks use the actual query engine and disappear with stale or mismatched data', () => {
  const profileKey = 'bundled/msfs/pmdg-737';
  const snapshot = { available: true, activeProfileKey: profileKey, activeProfileRevision: 1,
    sourceStatus: 'connected', receivedAt: now, updatedAt: new Date(now).toISOString(),
    valueUpdatedAt: { 'mcp.altitudeFt': new Date(now).toISOString() }, values: { 'mcp.altitudeFt': 35000 } };
  const base = { phase: 'CRUISE', catalogue: { configurationId: 'pmdg-737', profileKey, profileRevision: 1, commands: {} },
    aircraftSnapshot: snapshot, activeProfileKey: profileKey, available: true, live: true, now };
  assert.equal(buildFlightVoiceCues(base)[0]?.phrase, 'what is selected altitude');
  assert.deepEqual(buildFlightVoiceCues({ ...base, now: now + 3000 }), []);
  assert.deepEqual(buildFlightVoiceCues({ ...base, aircraftSnapshot: { ...snapshot, activeProfileRevision: 2 } }), []);
});

test('PMDG preset cues respect the same SDK availability rule as the Aircraft page', () => {
  const takeoff = command('configuration.lights.takeoff', 'preset', ['set lights for takeoff']);
  const base = { phase: 'TAXI', catalogue: { ...catalogue([takeoff]), configurationId: 'pmdg-737', profileRevision: 1 },
    available: true, live: true, now };
  assert.equal(chooseFlightVoiceCue(base), null);
  const aircraftSnapshot = { activeProfileKey: 'active-profile', activeProfileRevision: 1,
    sourceStatus: 'connected', sourceStatuses: { sdk: 'connected' } };
  assert.ok(chooseFlightVoiceCue({ ...base, aircraftSnapshot }));
  assert.equal(chooseFlightVoiceCue({ ...base, aircraftSnapshot: { ...aircraftSnapshot, sourceStatuses: { sdk: 'stale' } } }), null);
});

test('Fenix phase choices separate departure MAX from landing braking without changing 737 or generic commands', () => {
  const brakes = command('surfaces.autobrake.set', 'action', ['set autobrake {value}'],
    { kind: 'enum', values: ['off', 'disarm', 'low', 'medium', 'max'] });
  const flaps = command('surfaces.flaps.set', 'action', ['set flaps {value}'],
    { kind: 'enum', values: ['up', '1', '2', '3', 'full'] });
  const fenix = { ...catalogue([brakes, flaps]), configurationId: 'fenix-a32x' };
  const original = JSON.stringify(fenix);
  const options = { activeProfileKey: fenix.profileKey, catalogue: fenix, now, available: true, live: true,
    telemetry: { flapsExtended: true, observedAt: { flaps: now } } };
  const taxi = buildFlightVoiceCues({ ...options, phase: 'TAXI' });
  assert.equal(taxi.find(c => c.id === brakes.id)?.phrase, 'set autobrake max');
  assert.deepEqual(taxi.find(c => c.id === flaps.id)?.valueChoices, ['1', '2', '3']);
  assert.deepEqual(buildFlightVoiceCues({ ...options, phase: 'CLIMB' })[0].valueChoices, ['up', '1', '2', '3']);
  const approach = buildFlightVoiceCues({ ...options, phase: 'APPROACH' });
  assert.deepEqual(approach.find(c => c.id === brakes.id)?.valueChoices, ['off', 'low', 'medium']);
  assert.deepEqual(approach.find(c => c.id === flaps.id)?.valueChoices, ['1', '2', '3', 'full']);
  const afterLanding = buildFlightVoiceCues({ ...options, phase: 'taxi_in' });
  assert.equal(afterLanding[0].phrase, 'set flaps up');
  assert.match(afterLanding[0].detail, /Once clear of the runway/);
  for (const phase of ['TAKEOFF', 'LANDING', 'GO_AROUND']) assert.deepEqual(buildFlightVoiceCues({ ...options, phase }), []);
  assert.equal(JSON.stringify(fenix), original, 'cue restrictions must not mutate the cockpit/voice catalogue');

  const boeing = { ...catalogue([{ ...brakes, input: { kind: 'enum', values: ['rto', 'off', '1', '2', '3', 'max'] } }]), configurationId: 'pmdg-737' };
  assert.equal(chooseFlightVoiceCue({ ...options, catalogue: boeing, phase: 'TAXI' }).phrase, 'set autobrake rto');
  assert.deepEqual(chooseFlightVoiceCue({ ...options, catalogue: boeing, phase: 'APPROACH' }).valueChoices, ['off', '1', '2', '3', 'max']);
  const generic = { ...fenix, configurationId: 'unknown-aircraft' };
  assert.equal(buildFlightVoiceCues({ ...options, catalogue: generic, phase: 'TAXI' }).some(c => c.id === brakes.id), false,
    'MAX must not be inferred to mean RTO on an unreviewed aircraft');
});

test('Fenix cue policies only narrow advertised inputs and retain availability and pending guards', () => {
  const flaps = command('surfaces.flaps.set', 'action', ['flaps {value}'], { kind: 'enum', values: ['2'] });
  const brakes = command('surfaces.autobrake.set', 'action', ['autobrake {value}'], { kind: 'enum', values: ['max'] });
  const options = { phase: 'TAXI', activeProfileKey: 'active-profile', now, available: true, live: true,
    catalogue: { ...catalogue([flaps, brakes]), configurationId: 'fenix-a32x', profileRevision: 1 }, activeProfileRevision: 1 };
  assert.deepEqual(buildFlightVoiceCues(options)[0].valueChoices, ['2']);
  const withoutMax = { ...options.catalogue, commands: { ...options.catalogue.commands,
    [brakes.id]: { ...brakes, input: { kind: 'enum', values: ['off', 'low', 'medium'] } } } };
  assert.equal(buildFlightVoiceCues({ ...options, catalogue: withoutMax }).some(c => c.id === brakes.id), false);
  assert.deepEqual(buildFlightVoiceCues({ ...options, phase: 'APPROACH', catalogue: { ...options.catalogue, commands: { [brakes.id]: brakes } } }), [],
    'an empty intersection must hide the cue, not fall back to MAX');
  for (const input of [{ kind: 'none' }, { kind: 'boolean' }, { kind: 'enum', values: ['up', 'full'] }, { kind: 'enum' }]) {
    assert.deepEqual(buildFlightVoiceCues({ ...options, catalogue: { ...options.catalogue, commands: { [flaps.id]: { ...flaps, input } } } }), []);
  }
  for (const patch of [{ available: false }, { live: false }, { activeProfileKey: 'previous-aircraft' }, { activeProfileRevision: 2 },
    { pendingCommands: { 'aircraft-command:surfaces.flaps.set': true, 'aircraft-command:surfaces.autobrake.set': true } }]) {
    assert.deepEqual(buildFlightVoiceCues({ ...options, ...patch }), []);
  }
});

test('LS display reminders require independently fresh OFF readings, supported commands and the preparation phase', () => {
  const profileKey = 'bundled/msfs/fenix-a320';
  const commands = ['captain', 'firstOfficer'].map(side => command(`navigation.${side}.ls`, 'action',
    [`${side === 'captain' ? 'captain' : 'first officer'} ls {value}`], { kind: 'boolean' }));
  const values = { 'navigation.captain.ls': false, 'navigation.firstOfficer.ls': false };
  const snapshot = { activeProfileKey: profileKey, activeProfileRevision: 1, available: true, sourceStatus: 'connected',
    receivedAt: now, updatedAt: new Date(now).toISOString(), values,
    valueUpdatedAt: Object.fromEntries(Object.keys(values).map(field => [field, new Date(now).toISOString()])) };
  const options = { phase: 'DESCENT', activeProfileKey: profileKey, activeProfileRevision: 1, now, available: true, live: true,
    catalogue: { ...catalogue(commands), configurationId: 'fenix-a32x', profileKey, profileRevision: 1 }, aircraftSnapshot: snapshot };
  assert.deepEqual(buildFlightVoiceCues(options).map(c => c.phrase), ['captain ls on', 'first officer ls on']);
  assert.match(buildFlightVoiceCues(options)[0].detail, /does not arm LOC or APPR/);
  for (const value of [true, null, 0, 'false']) {
    assert.deepEqual(buildFlightVoiceCues({ ...options, aircraftSnapshot: { ...snapshot, values: { ...values, 'navigation.captain.ls': value } } })
      .map(c => c.id), ['navigation.firstOfficer.ls']);
  }
  const missingCaptain = { ...snapshot.valueUpdatedAt };
  delete missingCaptain['navigation.captain.ls'];
  assert.deepEqual(buildFlightVoiceCues({ ...options, aircraftSnapshot: { ...snapshot, valueUpdatedAt: missingCaptain } }).map(c => c.id), ['navigation.firstOfficer.ls']);
  for (const aircraftSnapshot of [null, { ...snapshot, sourceStatus: 'disconnected' }, { ...snapshot, receivedAt: now - 2001 },
    { ...snapshot, activeProfileKey: 'old-aircraft' }, { ...snapshot, activeProfileRevision: 2 },
    { ...snapshot, valueUpdatedAt: Object.fromEntries(Object.keys(values).map(field => [field, new Date(now - 2001).toISOString()])) }]) {
    assert.deepEqual(buildFlightVoiceCues({ ...options, aircraftSnapshot }), []);
  }
  assert.deepEqual(buildFlightVoiceCues({ ...options, catalogue: { ...options.catalogue, commands: {} } }), []);
  assert.deepEqual(buildFlightVoiceCues({ ...options, pendingCommands: { 'aircraft-command:navigation.captain.ls': true } }).map(c => c.id), ['navigation.firstOfficer.ls']);
  for (const phase of ['TAXI', 'TAKEOFF', 'APPROACH', 'LANDING', 'GO_AROUND']) assert.deepEqual(buildFlightVoiceCues({ ...options, phase }), []);
});

function observedOptions(configurationId, commands, values = {}) {
  const profileKey = 'active-profile';
  return {
    activeProfileKey: profileKey, activeProfileRevision: 1, now, available: true, live: true,
    catalogue: { ...catalogue(commands), configurationId, profileRevision: 1 },
    telemetry: { flapsExtended: true, observedAt: { flaps: now } },
    aircraftSnapshot: { activeProfileKey: profileKey, activeProfileRevision: 1, available: true,
      sourceStatus: 'connected', sourceStatuses: { sdk: 'connected' }, receivedAt: now, updatedAt: new Date(now).toISOString(),
      values, valueUpdatedAt: Object.fromEntries(Object.keys(values).map(id => [id, new Date(now).toISOString()])) },
  };
}

const flapFamilies = [
  { id: 'pmdg-737', field: 'queries.flapsHandle', detents: ['up', '1', '2', '5', '10', '15', '25', '30', '40'],
    takeoff: ['1', '5', '10', '15', '25'], climb: ['up', '1', '2', '5', '10', '15', '25'], current: '5', lower: ['up', '1', '2'] },
  { id: 'pmdg-777', field: 'controls.flapsLabel', detents: ['up', '1', '5', '15', '20', '25', '30'],
    takeoff: ['5', '15', '20'], climb: ['up', '1', '5', '15', '20'], current: '15', lower: ['up', '1', '5'] },
  ...['fenix-a32x', 'fbw-a32nx'].map(id => ({ id, field: 'controls.flapsHandle', detents: ['up', '1', '2', '3', 'full'],
    takeoff: ['1', '2', '3'], climb: ['up', '1', '2', '3'], current: '2', lower: ['up', '1'] })),
];

for (const family of flapFamilies) {
  test(`${family.id}: phase choices and fresh flap handle readings narrow reminders without inventing targets`, () => {
    const flaps = command('surfaces.flaps.set', 'action', ['set flaps {value}'], { kind: 'enum', values: family.detents });
    const adjust = command('surfaces.flaps.adjust', 'action', ['flaps {value} one'], { kind: 'enum', values: ['increase', 'decrease'] });
    const base = observedOptions(family.id, [flaps, adjust]);
    const original = JSON.stringify(base.catalogue);
    assert.deepEqual(buildFlightVoiceCues({ ...base, phase: 'TAXI' })[0].valueChoices, family.takeoff);
    assert.deepEqual(buildFlightVoiceCues({ ...base, phase: 'CLIMB' })[0].valueChoices, family.climb);
    assert.deepEqual(buildFlightVoiceCues({ ...base, phase: 'APPROACH' })[0].valueChoices, family.detents.slice(1));
    assert.equal(buildFlightVoiceCues({ ...base, phase: 'TAXI-IN' })[0].phrase, 'set flaps up');
    const observed = { ...observedOptions(family.id, [flaps, adjust], { [family.field]: family.current }), phase: 'CLIMB' };
    assert.deepEqual(buildFlightVoiceCues(observed)[0].valueChoices, family.lower);
    for (const patch of [{ receivedAt: now - 2001 }, { sourceStatus: 'disconnected' }, { available: false },
      { activeProfileKey: 'old-aircraft' }, { activeProfileRevision: 2 }, { valueUpdatedAt: {} },
      { values: { [family.field]: 0 } }, { unavailable: [family.field] }]) {
      assert.deepEqual(buildFlightVoiceCues({ ...observed, aircraftSnapshot: { ...observed.aircraftSnapshot, ...patch } })[0].valueChoices,
        family.climb, 'unknown state must not narrow choices');
    }
    const up = observedOptions(family.id, [flaps, adjust], { [family.field]: family.id === 'pmdg-777' ? 'UP' : 'up' });
    for (const phase of ['CLIMB', 'TAXI-IN']) assert.deepEqual(buildFlightVoiceCues({ ...up, phase }), [], 'no repeat retraction or fallback once UP is selected');
    assert.deepEqual(buildFlightVoiceCues({ ...base, phase: 'CLIMB', pendingCommands: { 'aircraft-command:surfaces.flaps.adjust': true } }), []);
    assert.equal(JSON.stringify(base.catalogue), original);
  });
}

test('departure autobrake reminders retire only on fresh, unambiguous matching observations', () => {
  const brakes = command('surfaces.autobrake.set', 'action', ['set autobrake {value}'],
    { kind: 'enum', values: ['off', 'rto', 'max', 'low', 'medium'] });
  for (const [id, values, target] of [
    ['pmdg-737', { 'gear.autobrakeMode': 'rto' }, 'rto'],
    ['pmdg-777', { 'controls.autobrakeMode': 'rto' }, 'rto'],
    ['fbw-a32nx', { 'systems.autobrakeMode': 'max' }, 'max'],
    ['fenix-a32x', { 'baro.healthy': true, 'controls.autobrake.low': false, 'controls.autobrake.medium': false, 'controls.autobrake.max': true }, 'max'],
  ]) {
    const base = { ...observedOptions(id, [brakes], values), phase: 'TAXI' };
    assert.deepEqual(buildFlightVoiceCues(base), [], id);
    for (const patch of [{ receivedAt: now - 2001 }, { sourceStatus: 'disconnected' }, { activeProfileRevision: 2 }, { available: false }]) {
      assert.equal(buildFlightVoiceCues({ ...base, aircraftSnapshot: { ...base.aircraftSnapshot, ...patch } })[0].phrase, `set autobrake ${target}`);
    }
    for (const field of Object.keys(values)) {
      const valueUpdatedAt = { ...base.aircraftSnapshot.valueUpdatedAt };
      delete valueUpdatedAt[field];
      assert.equal(buildFlightVoiceCues({ ...base, aircraftSnapshot: { ...base.aircraftSnapshot, valueUpdatedAt } })[0].phrase, `set autobrake ${target}`);
    }
    if (id === 'fenix-a32x') {
      for (const changed of [{ 'baro.healthy': false }, { 'controls.autobrake.low': true }, { 'controls.autobrake.medium': 0 }]) {
        assert.ok(buildFlightVoiceCues({ ...base, aircraftSnapshot: { ...base.aircraftSnapshot, values: { ...values, ...changed } } }).length);
      }
    }
    if (id.startsWith('pmdg')) {
      assert.ok(buildFlightVoiceCues({ ...base, aircraftSnapshot: { ...base.aircraftSnapshot, sourceStatuses: { sdk: 'stale' } } }).length);
    }
    assert.ok(buildFlightVoiceCues({ ...base, phase: 'APPROACH' }).length, 'a planned landing choice is never inferred from the departure setting');
  }
});

test('spoiler arming reminders need a fresh stowed/disarmed reading, not an extended speedbrake', () => {
  const arm = command('surfaces.spoilersArmed.set', 'action', ['spoilers armed {value}'], { kind: 'boolean' });
  for (const [id, field, disarmed, armed, invalid] of [
    ['pmdg-737', 'flightControls.speedbrakeArmed', false, true, null],
    ['pmdg-777', 'controls.speedbrakeState', 'stowed', 'armed', 'extended'],
    ['fbw-a32nx', 'controls.spoilersArmed', false, true, 0],
    ['fbw-a380x', 'controls.spoilersArmed', false, true, 'false'],
    ['fenix-a32x', 'controls.speedbrakePosition', 1, 0, 2],
  ]) {
    const base = { ...observedOptions(id, [arm], { [field]: disarmed, 'baro.healthy': true }), phase: 'APPROACH' };
    assert.equal(buildFlightVoiceCues(base)[0].id, arm.id, id);
    for (const value of [armed, invalid]) {
      assert.deepEqual(buildFlightVoiceCues({ ...base, aircraftSnapshot: { ...base.aircraftSnapshot, values: { ...base.aircraftSnapshot.values, [field]: value } } }), []);
    }
    for (const patch of [{ receivedAt: now - 2001 }, { activeProfileKey: 'old-aircraft' }, { valueUpdatedAt: {} }, { available: false }]) {
      assert.deepEqual(buildFlightVoiceCues({ ...base, aircraftSnapshot: { ...base.aircraftSnapshot, ...patch } }), []);
    }
    for (const pendingId of [arm.id, 'surfaces.spoilers.set']) {
      assert.deepEqual(buildFlightVoiceCues({ ...base, pendingCommands: { [`aircraft-command:${pendingId}`]: true } }), []);
    }
    for (const phase of ['TAXI', 'CLIMB', 'TAKEOFF', 'LANDING', 'GO-AROUND']) assert.deepEqual(buildFlightVoiceCues({ ...base, phase }), []);
  }
});

test('one-detent aircraft get phase-appropriate flap reminders with readback and pending guards', () => {
  const adjust = command('surfaces.flaps.adjust', 'action', ['flaps {value} one'], { kind: 'enum', values: ['increase', 'decrease'] });
  const base = observedOptions('fbw-a380x', [adjust]);
  for (const [phase, extended, direction] of [['TAXI', false, 'increase'], ['CLIMB', true, 'decrease'], ['APPROACH', true, 'increase'], ['TAXI-IN', true, 'decrease']]) {
    const options = { ...base, phase, telemetry: { flapsExtended: extended, observedAt: { flaps: now } } };
    assert.equal(buildFlightVoiceCues(options)[0].phrase, `flaps ${direction} one`);
    for (const telemetry of [{}, { flapsExtended: extended, observedAt: { flaps: now - 7000 } }]) {
      assert.deepEqual(buildFlightVoiceCues({ ...options, telemetry }), []);
    }
    for (const id of ['surfaces.flaps.set', adjust.id]) {
      assert.deepEqual(buildFlightVoiceCues({ ...options, pendingCommands: { [`aircraft-command:${id}`]: true } }), []);
    }
  }
  assert.deepEqual(buildFlightVoiceCues({ ...base, phase: 'TAXI' }), [], 'do not blindly add more takeoff flap once extended');
});

test('spoiler readback is a live fallback and stays suppressed during either kind of spoiler change', () => {
  const arm = command('surfaces.spoilersArmed.set', 'action', ['spoilers armed {value}'], { kind: 'boolean' });
  const profileKey = 'bundled/msfs/fenix-a320';
  const fixture = observedOptions('fenix-a32x', [arm], { 'baro.healthy': true, 'controls.speedbrakePosition': 1 });
  const base = { ...fixture, phase: 'APPROACH', activeProfileKey: profileKey,
    catalogue: { ...fixture.catalogue, profileKey }, aircraftSnapshot: { ...fixture.aircraftSnapshot, activeProfileKey: profileKey } };
  assert.deepEqual(buildFlightVoiceCues(base).map(c => c.id), [arm.id]);
  const queryOnly = { ...base, catalogue: { ...base.catalogue, commands: {} } };
  assert.deepEqual(buildFlightVoiceCues(queryOnly).map(c => c.id), ['query:are spoilers armed']);
  assert.deepEqual(buildFlightVoiceCues({ ...queryOnly, now: now + 3000 }), []);
  for (const id of [arm.id, 'surfaces.spoilers.set', 'spoilersArm', 'spoilersExtend']) {
    const key = id.startsWith('surfaces.') ? `aircraft-command:${id}` : `control:${id}`;
    assert.deepEqual(buildFlightVoiceCues({ ...base, pendingCommands: { [key]: true } }), []);
    assert.deepEqual(buildFlightVoiceCues({ ...queryOnly, pendingCommands: { [key]: true } }), []);
  }
  const armed = { ...base, aircraftSnapshot: { ...base.aircraftSnapshot,
    values: { ...base.aircraftSnapshot.values, 'controls.speedbrakePosition': 0 } } };
  assert.deepEqual(buildFlightVoiceCues(armed).map(c => c.id), ['query:are spoilers armed']);
});
