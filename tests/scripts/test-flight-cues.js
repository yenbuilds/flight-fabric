const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require(runtime('aircraft/aircraft-control-service.js'));
const { PUBLISHED_PHASES } = require('../../shared/flight-phases.js');

const msfsCapabilities = {
  simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'simvar', 'lvar'],
  integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'],
};

// Verify real bundled catalogues and spoken phrases, not a second handwritten
// approximation of which aircraft supports which command.
for (const entry of loader.listProfiles()) {
  const profileKey = `bundled/${entry.simulator}/${entry.id}`;
  test(`${profileKey}: cues fit every flight phase and resolve to supported voice commands`, async () => {
    const [{ buildFlightVoiceCues, flightPhaseBrief }, { interpretAircraftVoiceCommand: interpret }, { answerAircraftStateQuery }] = await Promise.all([
      import('../../frontend/src/cues/flight-cues-model.js'), import('../../frontend/src/voice/command-interpreter.js'), import('../../frontend/src/voice/state-queries.js'),
    ]);
    const profile = loader.loadProfile(profileKey);
    const options = { profile, profileRevision: 7, capabilities: entry.simulator === 'msfs' ? msfsCapabilities
      : { simulator: 'xplane', actionTypes: [], integrationTransports: [] } };
    const raw = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    const catalogue = { ...raw, commands: Object.fromEntries(raw.commands.map(c => [c.id, c])) };
    const now = Date.now();
    const values = { 'mcp.altitudeFt': 35000, 'flightGuidance.altitudeFt': 35000, 'baro.healthy': true,
      'flightControls.speedbrakeArmed': false, 'controls.spoilersArmed': false, 'controls.speedbrakePosition': 1, 'controls.speedbrakeState': 'stowed',
      'navigation.captain.ls': false, 'navigation.firstOfficer.ls': false,
      'navigation.lsCaptain': false, 'navigation.lsFirstOfficer': false,
      'flightGuidance.lsCaptain': false, 'flightGuidance.lsFirstOfficer': false,
      'mcp.courseCaptainDeg': 270, 'mcp.courseFirstOfficerDeg': 270, 'radios.nav1ActiveMhz': 110.3, 'radios.nav2ActiveMhz': 110.3,
      'lights.landing': false, 'lights.noseMode': 'taxi', 'lights.strobeMode': 'auto', 'lights.navMode': 'on' };
    const aircraftSnapshot = { activeProfileKey: profileKey, activeProfileRevision: 7, available: true,
      sourceStatus: 'connected', sourceStatuses: { sdk: 'connected' }, receivedAt: now, updatedAt: new Date(now).toISOString(),
      values, valueUpdatedAt: Object.fromEntries(Object.keys(values).map(id => [id, new Date(now).toISOString()])) };
    const cuesByPhase = {};
    for (const phase of PUBLISHED_PHASES) {
      const telemetry = { gearState: phase === 'APPROACH' ? 'UP' : 'DOWN', gear: { parkingBrake: false },
        flapsExtended: phase !== 'TAXI', lights: { available: true, landing: phase === 'TAXI-IN', taxi: false },
        observedAt: { gear: now, flaps: now, lights: now } };
      const cues = buildFlightVoiceCues({ phase, telemetry, now, catalogue, activeProfileKey: profileKey,
        activeProfileRevision: 7, aircraftSnapshot, available: true, live: true });
      cuesByPhase[phase] = cues;
      assert.ok(flightPhaseBrief(phase).detail.length > 40);
      if (['TAKEOFF', 'LANDING', 'GO_AROUND'].includes(phase)) assert.deepEqual(cues, []);
      for (const cue of cues) {
        if (cue.kind === 'query') {
          assert.equal(answerAircraftStateQuery(cue.phrase, aircraftSnapshot, { profileKey, profileRevision: 7 }, now).ok, true);
          continue;
        }
        const descriptor = catalogue.commands[cue.id];
        assert.ok(descriptor, `${phase}: ${cue.id}`);
        let examples = [cue.phrase];
        if (cue.valueHint) {
          const input = descriptor.input;
          const choices = input.kind === 'enum' ? cue.valueChoices
            : [({ squawk: '0042', feet: '10000', degrees: '270', 'com-megahertz': '123.450', megahertz: '110.50', hpa: '1013' })[input.units] || String(input.min)];
          assert.ok(choices.length > 0, `${phase}: missing choices for ${cue.id}`);
          if (input.kind === 'enum') {
            assert.ok(choices.every(value => input.values.includes(value)), 'cue choices must remain inside the advertised contract');
            assert.ok(choices.every(value => cue.valueHint.includes(value)), 'each tested choice must be shown in the hint');
          }
          examples = choices.map(value => cue.phrase.replace(/\[[^\]]+\]/, value));
        }
        for (const phrase of examples) {
          const spoken = interpret(phrase, raw);
          assert.equal(spoken.ok, true, `${phase}: ${phrase}: ${JSON.stringify(spoken)}`);
          assert.equal(spoken.commandId, cue.id);
          assert.equal(resolveAircraftCommand({ commandId: spoken.commandId, input: spoken.input }, options).ok, true);
        }
      }
    }
    if (/^pmdg-737(?:-(600|700|900))?$/.test(entry.id)) {
      for (const phase of ['PARKED', 'TAXI', 'CLIMB', 'DESCENT', 'APPROACH', 'TAXI-IN']) {
        assert.ok(cuesByPhase[phase].length >= 2, `${phase}: expected several useful 737 reminders`);
      }
      assert.equal(cuesByPhase.TAXI[0].id, 'configuration.lights.takeoff');
      assert.ok(cuesByPhase.APPROACH.some(c => c.id === 'configuration.lights.landing' && c.phrase === 'set lights for landing'));
      assert.ok(!cuesByPhase.APPROACH.some(c => c.id === 'lights.landing.set'), 'the single-light fallback yields to the landing preset');
      assert.equal(cuesByPhase['TAXI-IN'][0].id, 'configuration.lights.afterLanding');
      assert.ok(!cuesByPhase['TAXI-IN'].some(c => c.id === 'lights.taxi.set'), 'taxi light fallback yields to the after-landing preset');
      assert.ok(!cuesByPhase.CLIMB.some(c => c.id === 'configuration.lights.afterTakeoff'), 'no climb-out light cue while the landing lights already read off');
      assert.ok(cuesByPhase.CRUISE.some(c => c.kind === 'query'));
      assert.ok(cuesByPhase.DESCENT.some(c => c.id === 'flightGuidance.course.setBoth'));
      assert.ok(cuesByPhase.APPROACH.some(c => c.id === 'surfaces.autobrake.set' && !c.valueHint.includes('rto')));
      assert.ok(cuesByPhase.APPROACH.find(c => c.id === 'surfaces.autobrake.set').valueChoices.includes('max'), '737 landing MAX must remain available');
    }
    if (['pmdg-737', 'pmdg-777', 'fbw-a32nx'].includes(catalogue.configurationId)) {
      const cue = (phase, id) => cuesByPhase[phase].find(c => c.id === id);
      const boeing = catalogue.configurationId.startsWith('pmdg');
      const departure = { 'pmdg-737': ['1', '5', '10', '15', '25'], 'pmdg-777': ['5', '15', '20'], 'fbw-a32nx': ['1', '2', '3'] };
      for (const phase of ['PARKED', 'TAXI', 'CLIMB', 'DESCENT', 'APPROACH', 'TAXI-IN']) {
        assert.ok(cuesByPhase[phase].length >= 2, `${entry.id}: useful ${phase} coverage`);
      }
      assert.ok(cue('CRUISE', 'query:what is selected altitude'));
      assert.deepEqual(cue('TAXI', 'surfaces.flaps.set').valueChoices, departure[catalogue.configurationId]);
      assert.equal(cue('TAXI', 'surfaces.autobrake.set').phrase, `set autobrake ${boeing ? 'rto' : 'max'}`);
      assert.equal(cue('APPROACH', 'surfaces.flaps.set').valueChoices.includes('up'), false);
      assert.ok(cue('APPROACH', 'surfaces.spoilersArmed.set'));
      assert.equal(cue('APPROACH', 'query:are spoilers armed'), undefined, 'one reminder per task');
      assert.equal(cue('APPROACH', 'surfaces.autobrake.set').valueChoices.includes('rto'), false);
      assert.equal(cue('APPROACH', 'surfaces.autobrake.set').valueChoices.includes('max'), boeing);
      assert.equal(cue('TAXI-IN', 'surfaces.flaps.set').phrase, 'set flaps up');
    }
    if (['fbw-a380x', 'ifly-737-max-8', 'microsoft-737-max-8'].includes(entry.id)) {
      assert.equal(catalogue.commands['surfaces.flaps.set'], undefined);
      for (const [phase, direction] of [['TAXI', 'increase'], ['CLIMB', 'decrease'], ['APPROACH', 'increase'], ['TAXI-IN', 'decrease']]) {
        const flapCue = cuesByPhase[phase].find(c => c.id === 'surfaces.flaps.adjust');
        assert.equal(flapCue?.phrase, `flaps ${direction} one`, `${entry.id}: ${phase}`);
      }
      if (entry.id === 'fbw-a380x') {
        assert.ok(cuesByPhase.APPROACH.some(c => c.id === 'surfaces.spoilersArmed.set'));
        assert.equal(cuesByPhase.TAXI.some(c => c.id === 'surfaces.autobrake.set'), false, 'A380X must not inherit A32NX MAX');
      }
    }
    if (['laminar-737-800', 'zibo-737-800'].includes(entry.id)) {
      assert.ok(Object.values(cuesByPhase).every(cues => cues.length === 0), 'read-only profiles retain phase context without fabricated voice routes');
    }
    if (/^fenix-a3(?:19|20|21)$/.test(entry.id)) {
      const expected = {
        PARKED: ['surfaces.parkingBrake.set', 'configuration.apu.start', 'surveillance.squawk.set', 'flightGuidance.altitude.set'],
        TAXI: ['configuration.lights.takeoff', 'surfaces.flaps.set', 'surfaces.autobrake.set'],
        CLIMB: ['surfaces.flaps.set', 'flightGuidance.altitude.set'],
        CRUISE: ['query:what is selected altitude'],
        DESCENT: ['baro.both.qnhHpa', 'navigation.captain.ls', 'navigation.firstOfficer.ls', 'flightGuidance.altitude.set'],
        APPROACH: ['surfaces.flaps.set', 'surfaces.spoilersArmed.set', 'surfaces.autobrake.set', 'configuration.lights.landing'],
        'TAXI-IN': ['configuration.lights.afterLanding', 'surfaces.flaps.set', 'configuration.apu.start'],
      };
      for (const [phase, ids] of Object.entries(expected)) {
        assert.deepEqual(cuesByPhase[phase].map(c => c.id), ids, `${entry.id}: useful ${phase} coverage`);
      }
      const cue = (phase, id) => cuesByPhase[phase].find(c => c.id === id);
      assert.equal(cue('TAXI', 'surfaces.autobrake.set').phrase, 'set autobrake max');
      assert.deepEqual(cue('TAXI', 'surfaces.flaps.set').valueChoices, ['1', '2', '3']);
      assert.deepEqual(cue('CLIMB', 'surfaces.flaps.set').valueChoices, ['up', '1', '2', '3']);
      assert.deepEqual(cue('APPROACH', 'surfaces.flaps.set').valueChoices, ['1', '2', '3', 'full']);
      assert.deepEqual(cue('APPROACH', 'surfaces.autobrake.set').valueChoices, ['off', 'low', 'medium']);
      assert.equal(cue('TAXI-IN', 'surfaces.flaps.set').phrase, 'set flaps up');
      for (const id of ['surfaces.gear.set', 'radios.com1.setStandby', 'radios.nav1.setStandby', 'approach.captain.minimumsMode']) {
        assert.equal(Object.hasOwn(catalogue.commands, id), false, `do not claim unimplemented Fenix support: ${id}`);
      }
      const base = { catalogue, activeProfileKey: profileKey, activeProfileRevision: 7, aircraftSnapshot, available: true, live: true, now };
      for (const patch of [{ live: false }, { available: false }, { activeProfileKey: 'previous-aircraft' }, { activeProfileRevision: 8 }]) {
        assert.deepEqual(buildFlightVoiceCues({ ...base, phase: 'TAXI', ...patch }), []);
      }
      for (const phase of ['CRUISE', 'APPROACH']) {
        for (const snapshot of [{ ...aircraftSnapshot, valueUpdatedAt: {} }, { ...aircraftSnapshot, sourceStatus: 'disconnected' },
          { ...aircraftSnapshot, activeProfileRevision: 6 }, { ...aircraftSnapshot, receivedAt: now - 3000 }]) {
          assert.equal(buildFlightVoiceCues({ ...base, phase, aircraftSnapshot: snapshot }).some(c => c.kind === 'query'), false);
        }
      }
      const noCaptainLs = { ...aircraftSnapshot, valueUpdatedAt: { ...aircraftSnapshot.valueUpdatedAt } };
      delete noCaptainLs.valueUpdatedAt['navigation.captain.ls'];
      const descent = buildFlightVoiceCues({ ...base, phase: 'DESCENT', aircraftSnapshot: noCaptainLs });
      assert.equal(descent.some(c => c.id === 'navigation.captain.ls'), false);
      assert.ok(descent.some(c => c.id === 'navigation.firstOfficer.ls'), 'each display needs its own reading');
      assert.equal(buildFlightVoiceCues({ ...base, phase: 'TAXI', pendingCommands: { 'aircraft-command:surfaces.autobrake.set': true } })
        .some(c => c.id === 'surfaces.autobrake.set'), false);
      assert.deepEqual(buildFlightVoiceCues({ ...base, phase: 'PARKED', arrived: true }).map(c => c.id), ['configuration.apu.start']);
    }
  });
}
