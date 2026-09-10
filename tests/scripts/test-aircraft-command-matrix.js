const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require(runtime('aircraft/aircraft-control-service.js'));

const msfsCapabilities = {
  simulator: 'msfs',
  actionTypes: ['aircraft-integration', 'key-event', 'simvar', 'lvar'],
  integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator'],
};
const liveState = { simconnectConnected: true, inMenu: false };

// Explicit coverage expectations prevent a missing binding from passing merely
// because the command disappeared from the advertised catalogue.
const takeoffLightsProfiles = new Set([
  'generic', 'widebody-base', 'ga-base', 'regional-jet', 'turboprop-base',
  'fbw-a32nx', 'fbw-a380x', 'fenix-a319', 'fenix-a320', 'fenix-a321',
  'pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900',
  'pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f',
  'inibuilds-a350-900', 'inibuilds-a350-1000',
  'microsoft-737-max-8', 'inibuilds-a320neo-v2', 'inibuilds-a321lr', 'inibuilds-tristar',
]);

function candidateValues(input) {
  if (input.kind === 'none') return [undefined];
  if (input.kind === 'boolean') return [false, true];
  if (input.kind === 'enum') return input.values;
  return [...new Set([input.min, input.max, +(input.min + input.step).toFixed(8), 0, 100, 1000])]
    .filter(value => value >= input.min && value <= input.max
      && Math.abs((value - input.min) / input.step - Math.round((value - input.min) / input.step)) < 1e-7);
}

function spokenValue(pattern, input, value) {
  let spoken = typeof value === 'boolean' ? value ? 'on' : 'off' : String(value);
  if (input.units === 'degrees' || input.units === 'squawk') {
    spoken = spoken.padStart(input.units === 'degrees' ? 3 : 4, '0');
  }
  if (input.units === 'feet') {
    if (pattern.includes('flight level')) {
      if (value % 100) return null;
      spoken = String(value / 100);
    } else spoken += ' feet';
  }
  return pattern.replace('{value}', spoken);
}

// Exercise the contract between bundled profiles, backend resolution and the
// frontend interpreter. This intentionally does not simulate cockpit readback.
for (const entry of loader.listProfiles()) {
  const profileKey = `bundled/${entry.simulator}/${entry.id}`;
  test(`${profileKey}: advertised commands, voice values and lifecycle gates agree`, async (t) => {
    const [{ interpretAircraftVoiceCommand: interpret }, { parseComRadioFrequency },
      { parseNavRadioFrequency }, { parseSquawk }] = await Promise.all([
      import('../../frontend/src/voice/command-interpreter.js'),
      import('../../frontend/src/aircraft/com-radio.js'),
      import('../../frontend/src/aircraft/nav-radio.js'),
      import('../../frontend/src/aircraft/transponder.js'),
    ]);
    const profile = loader.loadProfile(profileKey);
    assert.equal(profile._profileKey, profileKey);
    const options = {
      profile, profileRevision: 7,
      capabilities: entry.simulator === 'msfs' ? msfsCapabilities
        : { simulator: 'xplane', actionTypes: [], integrationTransports: [] },
    };
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    const mainLights = entry.simulator === 'msfs' && (takeoffLightsProfiles.has(entry.id) || entry.id === 'headwind-a330');
    const turnoffLights = entry.simulator === 'msfs'
      && /^(?:pmdg-(?:737|777)(?:-.+|f)?|fenix-a3(?:19|20|21)|fbw-a(?:32nx|380x)|headwind-a330)$/.test(entry.id);
    for (const [target, names] of [['landing', ['landing']], ['taxi', ['taxi']],
      ['runwayTurnoff', ['runway turnoff', 'runway turn off']]]) {
      const available = target === 'runwayTurnoff' ? turnoffLights : mainLights;
      for (const name of names) for (const [phrase, value] of [[`set ${name} lights`, true],
        [`${name} lights on`, true], [`set ${name} lights off`, false], [`turn off ${name} lights`, false]]) {
        const voice = interpret(phrase, catalogue);
        assert.equal(voice.ok, available, `${profileKey}: ${phrase}`);
        const resolved = resolveAircraftCommand({ commandId: `lights.${target}.set`, input: { value } }, options);
        assert.equal(resolved.ok, available, `${profileKey}: individual ${target} coverage`);
        if (available) { assert.equal(voice.commandId, `lights.${target}.set`); assert.deepEqual(voice.input, { value }); }
      }
    }
    for (const phrase of ['landing', 'set landing', 'runway turn off', 'taxi lights almost off']) {
      assert.equal(interpret(phrase, catalogue).ok, false, phrase);
    }
    const supportsBrightness = /^(?:pmdg-(?:737|777)(?:-.+|f)?|fenix-a3(?:19|20|21)|fbw-a(?:32nx|380x)|headwind-a330)$/.test(entry.id)
      && entry.simulator === 'msfs';
    for (const [target, phrases] of [
      ['cockpit', ['set cockpit lighting fifty percent']],
      ['displays', ['set display brightness fifty percent', 'set all screens fifty percent',
        'set all PFDs fifty percent', 'set all pee eff dees fifty percent', 'set p f d brightness fifty percent']],
    ]) {
      for (const phrase of phrases) {
        const voice = interpret(phrase, catalogue);
        assert.equal(voice.ok, supportsBrightness, `${profileKey}: ${phrase} coverage`);
        assert.equal(resolveAircraftCommand({ commandId: `configuration.lighting.${target}`, input: { value: 50 } }, options).ok,
          supportsBrightness, `${profileKey}: brightness route coverage`);
        if (supportsBrightness) {
          assert.equal(voice.commandId, `configuration.lighting.${target}`);
          assert.deepEqual(voice.input, { value: 50 });
          const descriptor = catalogue.commands.find(command => command.id === voice.commandId);
          assert.ok(descriptor.brightnessFields.length >= 6);
        }
      }
    }
    for (const phrase of ['set all pee eff fifty percent', 'set all screens one hundred one percent',
      'set display brightness minus five percent']) assert.equal(interpret(phrase, catalogue).ok, false, phrase);
    const supportsTakeoffLights = entry.simulator === 'msfs' && takeoffLightsProfiles.has(entry.id);
    for (const phrase of ['set takeoff lights', 'set take off lights', 'set lights for takeoff']) {
      const voice = interpret(phrase, catalogue);
      assert.equal(voice.ok, supportsTakeoffLights, `${profileKey}: ${phrase} coverage`);
      const resolved = resolveAircraftCommand({ commandId: 'configuration.lights.takeoff', input: {} }, options);
      assert.equal(resolved.ok, supportsTakeoffLights, `${profileKey}: direct preset coverage`);
      if (supportsTakeoffLights) {
        assert.equal(voice.commandId, 'configuration.lights.takeoff');
        assert.deepEqual(voice.input, {});
        assert.ok(resolved.stepCount >= 3);
      }
    }
    assert.equal(catalogue.inventory.find(command => command.id === 'configuration.lights.takeoff')?.supported,
      supportsTakeoffLights, `${profileKey}: inventory explains whether the preset is available`);
    const supportsStd = ['fbw-a32nx', 'fbw-a380x', 'fenix-a319', 'fenix-a320', 'fenix-a321'].includes(entry.id);
    for (const [phrase, target] of [['set baro standard', 'both'], ['set captain baro standard', 'captain'],
      ['set first officer baro standard', 'firstOfficer']]) {
      const voice = interpret(phrase, catalogue);
      assert.equal(voice.ok, supportsStd, `${profileKey}: ${phrase} coverage`);
      if (supportsStd) {
        assert.equal(voice.commandId, `baro.${target}.std`);
        assert.deepEqual(voice.input, {});
        assert.equal(resolveAircraftCommand({ commandId: voice.commandId, input: voice.input }, options).ok, true);
      }
    }
    if (/^(?:pmdg-(?:737|777)|fenix-a3(?:19|20|21)$|fbw-a(?:32nx|380x)$)/.test(entry.id)) {
      for (const target of ['speed', 'mach', 'heading', 'altitude', 'verticalSpeed']) {
        assert.ok(catalogue.commands.some(command => command.id === `flightGuidance.${target}.set`),
          `${entry.id} must expose the main ${target} target to both page and voice`);
      }
      const { submitMcpDraft } = await import('../../frontend/src/vue/components/aircraft-specific/mcp-input.js');
      for (const [target, value, phrase] of [
        ['speed', 250, 'set speed two five zero'],
        ['mach', 0.78, 'set mach decimal seven eight'],
        ['heading', 270, 'set heading two seven zero'],
        ['altitude', 12000, 'set altitude twelve thousand feet'],
        ['verticalSpeed', -1800, 'set vertical speed minus one thousand eight hundred'],
      ]) {
        const commandId = `flightGuidance.${target}.set`;
        const voice = interpret(phrase, catalogue);
        assert.equal(voice.ok, true, `${entry.id}: ${phrase}`);
        assert.equal(voice.commandId, commandId);
        assert.deepEqual(voice.input, { value });
        const descriptor = catalogue.commands.find(command => command.id === commandId);
        let page;
        submitMcpDraft({ config: { ...descriptor.input, commandId }, disabled: false,
          rawValue: String(value), groupId: target,
          requestCommand: (id, _group, input) => { page = { commandId: id, input }; return true; } });
        assert.deepEqual(page, { commandId: voice.commandId, input: voice.input });
        assert.equal(resolveAircraftCommand(page, options).ok, true);
      }
    }
    if (entry.simulator === 'xplane') assert.equal(catalogue.commands.length, 0, 'the read-only provider advertises no writes');
    let requestCount = 0, phraseCount = 0;
    for (const command of catalogue.commands) {
      const input = command.input;
      const values = candidateValues(input).filter(value => {
        if (input.units === 'squawk') return parseSquawk(String(value).padStart(4, '0')) !== null;
        if (input.units === 'com-megahertz') return parseComRadioFrequency(value) !== null;
        if (input.units === 'megahertz') return parseNavRadioFrequency(value) !== null;
        return true;
      });
      assert.ok(values.length, `${command.id} has an executable sample`);
      for (const value of values) {
        const request = { commandId: command.id, input: value === undefined ? {} : { value },
          profileKey, profileRevision: options.profileRevision };
        const guarded = { ...options, requireProfileToken: true, requireStableSimState: true, simState: liveState };
        const resolved = resolveAircraftCommand(request, guarded);
        assert.equal(resolved.ok, true, `${command.id} ${JSON.stringify(request.input)}: ${JSON.stringify(resolved)}`);
        requestCount++;
        for (const pattern of command.speech?.patterns || []) {
          if (command.speech?.fixedInputs?.[pattern] && command.speech.fixedInputs[pattern].value !== value) continue;
          const phrase = spokenValue(pattern, input, value);
          if (phrase === null) continue;
          const result = interpret(phrase, catalogue);
          assert.equal(result.ok, true, `${phrase}: ${JSON.stringify(result)}`);
          assert.equal(result.commandId, command.id, phrase);
          assert.deepEqual(result.input, request.input, phrase);
          phraseCount++;
        }
        // Repeat at the facade used by both page and voice, including presets.
        for (const token of [{ profileKey: 'local/msfs/obsolete' }, { profileRevision: 6 }]) {
          assert.equal(resolveAircraftCommand({ ...request, ...token }, guarded).code, 'stale_profile', command.id);
        }
        for (const [simState, code] of [
          [{ simconnectConnected: false }, 'sim_disconnected'],
          [{ ...liveState, inMenu: true }, 'sim_state_blocked'],
          [{ ...liveState, lifecycleState: 'loading' }, 'sim_state_blocked'],
        ]) {
          assert.equal(resolveAircraftCommand(request, { ...guarded, simState }).code, code, command.id);
        }
      }
      if (input.kind === 'number') {
        for (const value of [input.min - input.step, input.max + input.step]) {
          assert.equal(resolveAircraftCommand({ commandId: command.id, input: { value } }, options).ok, false,
            `${command.id} rejects out-of-range ${value}`);
        }
      }
    }
    t.diagnostic(`${catalogue.commands.length} commands; ${requestCount} valid inputs; ${phraseCount} voice phrases`);
  });
}
