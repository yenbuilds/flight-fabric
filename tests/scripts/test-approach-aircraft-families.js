const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require(runtime('aircraft/aircraft-control-service.js'));
const { SimConnectTelemetryProvider } = require(runtime('telemetry-provider/simconnect-telemetry-provider.js'));
const { LvarSidecarBridge } = require(runtime('telemetry-provider/lvar-sidecar-bridge.js'));
const { defaultAircraftIntegrationRegistry: registry } = require(runtime('aircraft/integration-engine/index.js'));
const capabilities = { actionTypes: ['aircraft-integration'], integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator', 'input-event'] };
const families = {
  'pmdg-737': ['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900'],
  'pmdg-777': ['pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f'],
  'fenix-a32x': ['fenix-a319', 'fenix-a320', 'fenix-a321'],
  'inibuilds-a350': ['inibuilds-a350-900', 'inibuilds-a350-1000'],
  'tfdi-md-11': ['tfdi-md-11'],
};

function harness(profileId, initial) {
  loader.setActiveProfile(profileId); const config = loader.getAircraftSpecificConfig();
  const provider = new SimConnectTelemetryProvider(); provider._connected = true; provider._simRunning = true;
  let current = true;
  provider._getActiveAircraftIntegrationConfig = () => current ? config : null;
  provider._getMobiFlightHealth = () => ({ connected: true });
  const source = { profileId: config.profileKey, enabled: true, status: 'running', values: {}, valueUpdatedAt: {}, snapshotSequence: 1, updatedAt: new Date().toISOString() };
  const key = (id) => config.confirmationFields.find((f) => f.id === id).source.key;
  function publish(id, value, fresh = true) {
    source.values[key(id)] = value; source.snapshotSequence++; source.updatedAt = new Date().toISOString();
    if (fresh) source.valueUpdatedAt[key(id)] = source.updatedAt;
  }
  for (const [id, value] of Object.entries(initial)) publish(id, value);
  for (const name of Object.keys(source.valueUpdatedAt)) source.valueUpdatedAt[name] = new Date(Date.now() - 10).toISOString();
  const bridge = new LvarSidecarBridge(), calls = [];
  bridge.getSnapshot = () => source;
  bridge._sendWithAck = async (message) => { calls.push(message); return { ok: true }; };
  bridge.executeMobiFlightCode = async (code) => { calls.push(code); return { ok: true }; };
  const wait = provider._waitForAircraftIntegrationReadback.bind(provider);
  provider._waitForAircraftIntegrationReadback = (b, r, c, base) => wait(b, { ...r, timeoutMs: 30 }, c, base);
  return { provider, source, bridge, calls, key, publish, config, retire: () => { current = false; },
    run: (actionId, value) => provider._executeAircraftIntegrationAction(bridge, { name: config.integrationId }, 'test', {
      profileKey: config.profileKey, profileRevision: config.profileRevision, request: { actionId, ...(value === undefined ? {} : { value }) },
    }),
  };
}

test('every advertised exact flap target has a reviewed lever source rather than aerodynamic position', () => {
  const sources = {
    'pmdg-737': { type: 'lvar', name: 'L:NGXFlapLever' },
    'pmdg-777': { type: 'sdk', adapter: 'clientdata-manifest', path: 'flaps.label' },
    'fenix-a32x': { type: 'lvar', name: 'L:S_FC_FLAPS' },
    'fbw-a32nx': { type: 'lvar', name: 'L:A32NX_FLAPS_HANDLE_INDEX' },
    'inibuilds-a350': { type: 'simvar', name: 'FLAPS HANDLE PERCENT' },
    'inibuilds-a380': { type: 'simvar', name: 'FLAPS HANDLE INDEX' },
    'tfdi-md-11': { type: 'lvar', name: 'L:MD11_FLAP_RNG' },
  };
  const covered = new Set();
  for (const entry of loader.listProfiles().filter(p => p.simulator === 'msfs')) {
    const profileKey = `bundled/msfs/${entry.id}`, profile = loader.loadProfile(profileKey);
    const catalogue = buildAircraftControlCapabilities(profile, { capabilities }).aircraftCommands;
    const command = catalogue.commands.find(c => c.id === 'surfaces.flaps.set');
    if (!command) continue;
    covered.add(entry.id);
    for (const value of command.input.values) {
      const resolved = resolveAircraftCommand({ commandId: command.id, input: { value } }, { profile, capabilities });
      assert.equal(resolved.ok, true, profileKey);
      const adapterId = resolved.action.name;
      assert.ok(sources[adapterId], `${profileKey}: exact selection needs a reviewed lever source`);
      const action = registry.resolveAction({ adapterId, profileKey, actionId: resolved.controlRequest.actionId });
      const integration = registry.resolveIntegration(adapterId, { profileKey });
      for (const route of action.routes) {
        if (adapterId === 'inibuilds-a350') {
          assert.equal(route.readback.expectedInput, true);
          assert.equal(resolved.controlRequest.value, { up: 0, 1: 25, 2: 50, 3: 75, full: 100 }[value]);
          assert.equal(route.mode, 'step-to-target');
          assert.equal(route.maxSteps, 4);
        } else if (adapterId === 'tfdi-md-11') {
          assert.equal(route.readback.expectedInput, true);
          assert.equal(resolved.controlRequest.value, { up: 0, 0: 1, takeoff: 2, 28: 3, 35: 4, 50: 5 }[value]);
          assert.equal(route.mode, 'step-to-target');
          assert.equal(route.maxSteps, 5);
        } else assert.ok(Object.hasOwn(route.readback, 'expectedValue'), 'selection must match an exact target');
        assert.notEqual(route.readback.confirmation, 'changed');
        const field = integration.fields[route.readback.fieldId];
        assert.equal(field.sources[0].decode.type, 'enum', 'unknown lever values cannot round into a selection');
        for (const [key, sourceValue] of Object.entries(sources[adapterId])) assert.equal(field.sources[0].route[key], sourceValue);
        if (adapterId !== 'pmdg-777') assert.equal(route.readback.freshness, 'field');
      }
    }
  }
  assert.deepEqual([...covered].sort(), [
    ...families['pmdg-737'], ...families['pmdg-777'], ...families['fenix-a32x'], ...families['inibuilds-a350'], ...families['tfdi-md-11'], 'fbw-a32nx', 'inibuilds-a380-800-rr',
  ].sort(), 'fixed flap coverage must not disappear silently');
});

test('reported heading selected transcript resolves to the 737 HDG SEL button action', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  for (const profileId of [...families['pmdg-737'], ...families['pmdg-777']]) {
    const profile = loader.loadProfile(`bundled/msfs/${profileId}`), options = { profile, capabilities };
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    const supported = families['pmdg-737'].includes(profileId);
    for (const phrase of ['engage heading select', 'ENGAGE HEADING SELECTED', 'heading select', 'heading selected']) {
      const voice = interpret(phrase, catalogue);
      assert.equal(voice.ok, supported, `${profileId}: ${phrase}`);
      if (!supported) continue;
      assert.equal(voice.commandId, 'flightGuidance.headingSelect.engage');
      assert.deepEqual(voice.input, {});
      const resolved = resolveAircraftCommand(voice, options);
      const button = resolveAircraftCommand({ commandId: 'flightGuidance.headingSelect.engage', input: {} }, options);
      assert.equal(resolved.ok, true);
      assert.deepEqual(resolved.controlRequests, button.controlRequests);
      assert.equal(resolved.controlRequests.length, 1);
      assert.equal(resolved.controlRequests[0].actionId, 'afds.headingSelect.engage');
    }
    for (const phrase of ['do not engage heading selected',
      'disengage heading selected', 'engage heading selected off',
      'engage heading selected and approach']) {
      assert.equal(interpret(phrase, catalogue).ok, false, `${profileId}: ${phrase}`);
    }
  }
});

test('explicit mode names work with or without engage only where the aircraft advertises them', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  const modes = [
    ['headingSelect', ['heading select', 'heading selected']],
    ['headingHold', ['heading hold']],
    ['altitudeHold', ['altitude hold']],
    ['approach', ['approach', 'approach mode', 'app']],
    ['verticalSpeed', ['vertical speed', 'vertical speed mode']],
    ['flightLevelChange', ['level change', 'flight level change', 'flch']],
    ['localizer', ['localizer', 'loc', 'vor loc']],
    ['lnav', ['lnav']], ['vnav', ['vnav']],
    ['n1', ['n1', 'n one']], ['speed', ['mcp speed', 'speed mode']],
  ];
  for (const entry of loader.listProfiles()) {
    const profile = loader.loadProfile(`bundled/${entry.simulator}/${entry.id}`);
    const options = { profile, capabilities: entry.simulator === 'msfs' ? capabilities : {} };
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    for (const [mode, names] of modes) {
      const commandId = `flightGuidance.${mode}.engage`;
      const supported = catalogue.commands.some(command => command.id === commandId);
      if (entry.id === 'pmdg-737' && mode !== 'headingHold') assert.equal(supported, true, commandId);
      for (const name of names) for (const phrase of [name, `engage ${name}`]) {
        const voice = interpret(phrase, catalogue);
        assert.equal(voice.ok, supported, `${entry.id}: ${phrase}`);
        if (supported) {
          assert.equal(voice.commandId, commandId, `${entry.id}: ${phrase}`);
          assert.deepEqual(voice.input, {});
          const resolved = resolveAircraftCommand(voice, options);
          assert.equal(resolved.ok, true);
          assert.deepEqual(resolved.controlRequests,
            resolveAircraftCommand({ commandId, input: {} }, options).controlRequests);
        }
        for (const invalid of [`do not ${phrase}`, `don't ${phrase}`, `${phrase} and gear up`]) {
          assert.equal(interpret(invalid, catalogue).ok, false, `${entry.id}: ${invalid}`);
        }
        const off = interpret(`${phrase} off`, catalogue);
        if (off.ok) {
          // Some aircraft already expose an explicit OFF command. It must
          // retain that meaning instead of becoming a mode-engagement alias.
          assert.notEqual(off.commandId, commandId);
          assert.deepEqual(off.input, { value: false });
        }
      }
    }
    for (const phrase of ['heading', 'altitude', 'speed', 'altitude select', 'altitude selected']) {
      assert.equal(interpret(phrase, catalogue).ok, false, `${entry.id}: ${phrase}`);
    }
  }
});

test('all PMDG heading and approach catalogue bindings share canonical and direct observation-loss feedback', async () => {
  const { flightGuidanceObservationFailureText } = await import('../../frontend/src/aircraft/command-result-presentation.js');
  const { formatAviationReadback } = await import('../../frontend/src/voice/local-readback.js');
  const failure = { ok: false, executionStarted: true, code: 'aircraft_integration_readback_timeout' };
  for (const family of ['pmdg-737', 'pmdg-777']) for (const profileId of families[family]) {
    const profile = loader.loadProfile(`bundled/msfs/${profileId}`), options = { profile, capabilities };
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    for (const mode of [family === 'pmdg-737' ? 'headingSelect' : 'headingHold', 'approach']) {
      const commandId = `flightGuidance.${mode}.engage`, request = { commandId, input: {} };
      assert(catalogue.commands.some(command => command.id === commandId));
      const resolved = resolveAircraftCommand(request, options);
      assert.equal(resolved.ok, true, `${profileId}: ${commandId}`);
      const text = flightGuidanceObservationFailureText(failure, request);
      assert.match(text, /not confirmed\. Check the flight mode annunciator/);
      assert.equal(resolved.controlRequests.length, 1);
      assert.equal(flightGuidanceObservationFailureText(failure, resolved.controlRequests[0]), text);
      assert.equal(flightGuidanceObservationFailureText({ ...failure, code: 'sdk_execution_failed' }, request), null);
      if (mode === 'approach') assert.equal(formatAviationReadback({ commandId }),
        'Approach selected. Check the flight mode annunciator.');
    }
  }
});

test('every advertised spoiler command and its direct route share observation-loss feedback', async () => {
  const { spoilerObservationFailureText } = await import('../../frontend/src/aircraft/command-result-presentation.js');
  const failure = { ok: false, executionStarted: true, code: 'aircraft_integration_readback_timeout' };
  const covered = new Set(), directActions = new Set();
  // Exercise real catalogue bindings, including percentage sliders whose UI
  // uses the direct action instead of a fixed canonical position.
  for (const entry of loader.listProfiles().filter(p => p.simulator === 'msfs')) {
    const profile = loader.loadProfile(`bundled/msfs/${entry.id}`);
    const options = { profile, capabilities };
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    for (const command of catalogue.commands.filter(c => ['surfaces.spoilers.set', 'surfaces.spoilersArmed.set'].includes(c.id))) {
      covered.add(entry.id);
      for (const value of command.input.kind === 'boolean' ? [false, true] : command.input.values) {
        const request = { commandId: command.id, input: { value } };
        const resolved = resolveAircraftCommand(request, options);
        assert.equal(resolved.ok, true, `${entry.id}: ${command.id}/${value}`);
        const canonicalText = spoilerObservationFailureText(failure, request);
        assert.match(canonicalText, /selection not confirmed/);
        for (const direct of resolved.controlRequests) {
          directActions.add(direct.actionId);
          assert.equal(spoilerObservationFailureText(failure, direct), canonicalText,
            `${entry.id}: direct ${direct.actionId} must not report rejection when only observation failed`);
          assert.equal(spoilerObservationFailureText({ ...failure, executionStarted: false }, direct), null);
          assert.equal(spoilerObservationFailureText({ ...failure, code: 'aircraft_integration_simconnect_exception' }, direct), null);
          assert.equal(spoilerObservationFailureText({ ok: true, code: 'executed', confirmedValue: 0 }, direct), null);
        }
      }
    }
  }
  assert.deepEqual([...covered].sort(), [...families['pmdg-737'], ...families['pmdg-777'], ...families['fenix-a32x'],
    ...families['inibuilds-a350'], ...families['tfdi-md-11'], 'fbw-a32nx', 'fbw-a380x', 'inibuilds-a380-800-rr'].sort());
  assert(directActions.has('controls.spoilers.set'));
  assert(directActions.has('controls.speedbrake.set'));
  assert(directActions.has('controls.spoilersArmed.on'));
});

test('reviewed profiles accept only aircraft-appropriate flap, autobrake and speedbrake voice targets', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  const flaps = { 'pmdg-737': ['up', '1', '2', '5', '10', '15', '25', '30', '40'],
    'pmdg-777': ['up', '1', '5', '15', '20', '25', '30'], 'fenix-a32x': ['up', '1', '2', '3', 'full'], 'inibuilds-a350': ['up', '1', '2', '3', 'full'],
    'tfdi-md-11': ['up', '0', 'takeoff', '28', '35', '50'] };
  const brakes = { 'pmdg-737': ['rto', 'off', '1', '2', '3', 'max'], 'pmdg-777': ['rto', 'off', 'disarm', '1', '2', 'max'],
    'fenix-a32x': ['off', 'low', 'medium', 'max'], 'inibuilds-a350': [], 'tfdi-md-11': ['rto', 'off', 'min', 'med', 'max'] };
  for (const [family, profiles] of Object.entries(families)) for (const id of profiles) {
    loader.setActiveProfile(id); const profile = loader.getActiveProfile();
    const catalogue = buildAircraftControlCapabilities(profile, { capabilities }).aircraftCommands;
    for (const [prefix, commandId, choices] of [['flaps', 'surfaces.flaps.set', flaps[family]],
      ['autobrake', 'surfaces.autobrake.set', brakes[family]], ['speedbrake', 'surfaces.spoilers.set',
        family === 'tfdi-md-11' ? ['retract', 'one-third', 'two-thirds', 'full'] : ['retract', 'half', 'full']]]) {
      for (const value of choices) {
        const text = `${prefix} ${value}`, parsed = interpret(text, catalogue);
        assert.equal(parsed.ok, true, `${id}: ${text}: ${JSON.stringify(parsed)}`);
        assert.equal(parsed.commandId, commandId);
        assert.equal(parsed.input.value, value === 'retract' ? 'retracted' : value);
        assert.equal(resolveAircraftCommand({ commandId, input: parsed.input }, { profile, capabilities }).ok, true);
      }
    }
    for (const value of ['up', '1', '2', '3', '5', '10', '15', '20', '25', '30', '40', 'full'].filter(v => !flaps[family].includes(v))) {
      assert.equal(interpret(`flaps ${value}`, catalogue).ok, false, `${id}: unsupported flaps ${value}`);
    }
    for (const value of ['rto', 'low', 'medium', '3'].filter(v => !brakes[family].includes(v))) {
      assert.equal(interpret(`autobrake ${value}`, catalogue).ok, false, `${id}: unsupported autobrake ${value}`);
    }
    const local = { ...profile, _profileKey: `local/msfs/${id}` };
    assert.equal(buildAircraftControlCapabilities(local, { capabilities }).aircraftCommands.commands.some(c => c.id === 'surfaces.spoilers.set'), false);
  }
});

const brakeModes = ['off', 'low', 'medium', 'max'];
const brakeFields = (mode) => ({ 'baro.healthy': 1,
  ...Object.fromEntries(brakeModes.slice(1).map(m => [`controls.autobrake.${m}`, Number(m === mode)])) });

test('Fenix autobrake never treats unpowered or stale power indications as a confirmed selection', async () => {
  for (const profile of ['fenix-a319', 'fenix-a320', 'fenix-a321']) for (const target of brakeModes) {
    for (const current of new Set(['off', target])) for (const power of ['off', 'missing', 'stale']) {
      const h = harness(profile, brakeFields(current)), key = h.key('baro.healthy');
      if (power === 'off') h.publish('baro.healthy', 0);
      if (power === 'missing') delete h.source.values[key];
      if (power === 'stale') delete h.source.valueUpdatedAt[key];
      const result = await h.run(`controls.autobrake.${target}`);
      assert.equal(result.ok, false, `${profile}/${current}->${target}/${power}: ${JSON.stringify(result)}`);
      assert.deepEqual(h.calls, [], 'power must be established before sending a pulse or claiming a no-op');
    }
  }
});

test('Fenix autobrake losing power during a pulse releases the button without confirming OFF', async () => {
  const h = harness('fenix-a320', brakeFields('low'));
  h.bridge.executeMobiFlightCode = async code => {
    h.calls.push(code);
    for (const [field, value] of Object.entries({ ...brakeFields('off'), 'baro.healthy': 0 })) h.publish(field, value);
    return { ok: true };
  };
  const result = await h.run('controls.autobrake.off');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(h.calls.length, 2, 'the accepted press still receives its release');
  assert.equal(result.executionStarted, true);
});

test('Fenix autobrake confirmation cannot combine earlier matching fields with a later incompatible state', async () => {
  for (const drift of ['none', 'power', 'lamp', 'stale']) {
    const h = harness('fenix-a320', brakeFields('medium'));
    h.bridge.executeMobiFlightCode = async code => {
      h.calls.push(code);
      // LOW and power already match, while the MED lamp is still going out.
      h.publish('baro.healthy', 1);
      h.publish('controls.autobrake.low', 0);
      h.publish('controls.autobrake.max', 0);
      return { ok: true };
    };
    const wait = h.provider._waitForAircraftIntegrationReadback.bind(h.provider);
    h.provider._waitForAircraftIntegrationReadback = async (bridge, readback, context, baseline) => {
      const confirmation = await wait(bridge, readback, context, baseline);
      if (readback.fieldId === 'controls.autobrake.low' && confirmation.confirmed) {
        // A subsequent telemetry update finally clears MED, but contradicts
        // one of the fields that another waiter already considered confirmed.
        if (drift === 'power') h.publish('baro.healthy', 0);
        if (drift === 'lamp') h.publish('controls.autobrake.low', 1);
        if (drift === 'stale') delete h.source.valueUpdatedAt[h.key('controls.autobrake.low')];
        h.publish('controls.autobrake.medium', 0);
      }
      return confirmation;
    };
    const result = await h.run('controls.autobrake.off');
    assert.equal(result.ok, drift === 'none', `${drift}: ${JSON.stringify(result)}`);
    if (drift !== 'none') assert.equal(result.executionStarted, true);
    assert.equal(h.calls.length, 2, 'confirmation drift must never repeat the physical button pulse');
  }
});

test('Fenix all sixteen autobrake transitions press and release the intended counter exactly once, or no-op', async () => {
  for (const current of brakeModes) for (const target of brakeModes) {
    const h = harness('fenix-a320', brakeFields(current));
    h.bridge.executeMobiFlightCode = async code => {
      h.calls.push(code);
      // Change the indications immediately after press: release must use the frozen original button.
      for (const [field, value] of Object.entries(brakeFields(target))) h.publish(field, value);
      return { ok: true };
    };
    const result = await h.run(`controls.autobrake.${target}`);
    assert.equal(result.ok, true, `${current}->${target}: ${JSON.stringify(result)}`);
    if (current === target) { assert.equal(result.noOp, true); assert.deepEqual(h.calls, []); }
    else {
      const button = { low: 'LO', medium: 'MED', max: 'MAX' }[target === 'off' ? current : target];
      assert.deepEqual(h.calls, Array(2).fill(`(L:S_MIP_AUTOBRAKE_${button}, Number) ++ (>L:S_MIP_AUTOBRAKE_${button}, Number)`));
    }
  }
});

test('Fenix autobrake rejects missing, stale, invalid and contradictory indications without a press', async () => {
  for (const invalid of ['missing', 'stale', 'invalid', 'contradictory']) {
    const h = harness('fenix-a321', brakeFields('low')), key = h.key('controls.autobrake.max');
    if (invalid === 'missing') delete h.source.values[key];
    if (invalid === 'stale') delete h.source.valueUpdatedAt[key];
    if (invalid === 'invalid') h.source.values[key] = 2;
    if (invalid === 'contradictory') h.source.values[key] = 1;
    const result = await h.run('controls.autobrake.off');
    assert.equal(result.ok, false, `${invalid}: ${JSON.stringify(result)}`); assert.deepEqual(h.calls, []);
  }
});

test('Fenix pulse confirms all three own observations, releases after profile loss and never retries an inhibited press', async () => {
  for (const outcome of ['stale-low', 'stale-medium', 'stale-max', 'inhibited', 'profile', 'release-failed']) {
    const h = harness('fenix-a319', brakeFields('medium'));
    h.bridge.executeMobiFlightCode = async code => {
      h.calls.push(code);
      if (outcome !== 'inhibited') for (const [field, value] of Object.entries(brakeFields('off'))) {
        h.publish(field, value, outcome !== `stale-${field.split('.').at(-1)}`);
      }
      if (outcome === 'profile') h.retire();
      return { ok: !(outcome === 'release-failed' && h.calls.length === 2) };
    };
    const result = await h.run('controls.autobrake.off');
    assert.equal(result.ok, false, `${outcome}: ${JSON.stringify(result)}`);
    assert.deepEqual(h.calls, Array(2).fill('(L:S_MIP_AUTOBRAKE_MED, Number) ++ (>L:S_MIP_AUTOBRAKE_MED, Number)'));
  }
});

test('Fenix flap detents and speedbrake targets use native lever values, with zero reserved for ARM', async () => {
  for (const [prefix, field, lvar, targets] of [
    ['flaps', 'controls.flapsHandle', 'L:S_FC_FLAPS', [['up', 0], ['one', 1], ['two', 2], ['three', 3], ['full', 4]]],
    ['speedbrake', 'controls.speedbrakePosition', 'L:A_FC_SPEEDBRAKE', [['armed', 0], ['retracted', 1], ['half', 2], ['full', 3]]],
  ]) for (const [suffix, raw] of targets) {
    const h = harness('fenix-a320', { [field]: raw === 4 ? 0 : 4 });
    h.bridge._sendWithAck = async message => { h.calls.push(message); h.publish(field, raw); return { ok: true }; };
    const result = await h.run(`controls.${prefix}.${suffix}`);
    assert.equal(result.ok, true, `${prefix} ${suffix}: ${JSON.stringify(result)}`);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, lvar); assert.equal(h.calls[0].value, raw);
    h.provider._aircraftIntegrationActionLastAttemptAt.clear();
    assert.equal((await h.run(`controls.${prefix}.${suffix}`)).noOp, true); assert.equal(h.calls.length, 1);
  }
});

test('A350 HALF uses the existing 50 percent route and requires its own newly sampled handle readback', async () => {
  for (const profile of families['inibuilds-a350']) for (const fresh of [true, false]) {
    const field = 'controls.speedbrakePercent', h = harness(profile, { [field]: 0 });
    h.bridge._sendWithAck = async message => { h.calls.push(message); h.publish(field, 50, fresh); return { ok: true }; };
    const result = await h.run('controls.speedbrake.set', 50);
    assert.equal(result.ok, fresh, JSON.stringify(result));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, 'SPOILERS_SET'); assert.equal(h.calls[0].value, 8192);
  }
});

test('PMDG fixed SDK speedbrake targets use a complete click and confirm the matching handle position', async () => {
  for (const family of ['pmdg-737', 'pmdg-777']) for (const [target, percent] of [['retracted', 0], ['half', 50], ['full', 100]]) {
    const is777 = family === 'pmdg-777', field = is777 ? 'controls.speedbrakePercent' : 'flightControls.speedbrakePercent';
    const h = harness(family, is777 ? {} : { [field]: percent === 0 ? 50 : 0 });
    const sdk = { adapterId: 'clientdata-manifest', status: 'running', normalized: { spoilers: { handlePercent: percent === 0 ? 50 : 0 } },
      snapshotSequence: 1, updatedAt: new Date().toISOString() };
    h.provider._sdkBridge = { getSnapshot: () => sdk, isDataConnected: () => true };
    h.bridge.sendSdkEvent = async (name, value) => {
      h.calls.push({ name, value });
      // SDK lever position is independent of the requested surface fraction.
      if (is777) { sdk.normalized.spoilers.handlePercent = target === 'half' ? 75 : percent; sdk.snapshotSequence++; sdk.updatedAt = new Date().toISOString(); }
      else h.publish(field, percent);
      return { ok: true };
    };
    const result = await h.run(`${is777 ? 'controls' : 'flightControls'}.speedbrake.${is777 && target === 'retracted' ? 'stowed' : target}`);
    assert.equal(result.ok, true, `${family} ${target}: ${JSON.stringify(result)}`);
    const event = (is777 ? { retracted: 74613, half: 74616, full: 74615 } : { retracted: 76423, half: 76425, full: 76427 })[target];
    assert.deepEqual(h.calls, [{ name: `#${event}`, value: 0x20000000 }, { name: `#${event}`, value: 0x00020000 }]);
  }
});

test('state-selected pulse definitions reject malformed conditions and unsafe or incompatible routes', () => {
  const { defineAircraftIntegration } = require(runtime('aircraft/integration-engine/registry.js'));
  const { FENIX_A32X_INTEGRATION } = require(runtime('aircraft/integration-engine/index.js'));
  assert.equal(typeof defineAircraftIntegration, 'function');
  for (const mutate of [
    r => { r.pulses = []; }, r => { delete r.pulses[0].when[0].freshness; },
    r => { r.pulses[0].when[0].fieldId = 'controls.notConfirmed'; },
    r => { r.pulses[0].when.push(r.pulses[0].when[0]); },
    r => { r.pulses[0].pressCode = '1\n2'; }, r => { r.mode = 'single'; },
    r => { r.pressCode = '1'; r.releaseCode = '1'; },
    r => { r.readbacks.find(readback => readback.fieldId === 'controls.autobrake.low').freshness = undefined; },
  ]) {
    const definition = JSON.parse(JSON.stringify(FENIX_A32X_INTEGRATION));
    mutate(definition.actions['controls.autobrake.off'].routes[0]);
    assert.throws(() => defineAircraftIntegration(definition), TypeError);
  }
});

test('ambiguous pulse candidates cannot dispatch, and one physical autobrake group blocks overlapping requests', async () => {
  const h = harness('fenix-a320', brakeFields('low'));
  const { FENIX_A32X_INTEGRATION } = require(runtime('aircraft/integration-engine/index.js'));
  const action = FENIX_A32X_INTEGRATION.actions['controls.autobrake.off'];
  const route = JSON.parse(JSON.stringify(action.routes[0]));
  route.pulses.push(route.pulses[0]);
  const result = await h.provider._executeAircraftIntegrationMobiFlightRoute(h.bridge, route, action, undefined, undefined,
    { profileKey: h.config.profileKey, profileRevision: h.config.profileRevision, adapterId: h.config.integrationId });
  assert.equal(result.ok, false); assert.equal(result.code, 'aircraft_integration_precondition_failed'); assert.deepEqual(h.calls, []);
  let pressed, release;
  const atPress = new Promise(resolve => { pressed = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  h.bridge.executeMobiFlightCode = async code => {
    h.calls.push(code); pressed(); await hold;
    for (const [field, value] of Object.entries(brakeFields('off'))) h.publish(field, value);
    return { ok: true };
  };
  const first = h.run('controls.autobrake.off'); await atPress;
  try { assert.equal((await h.run('controls.autobrake.max')).ok, false); assert.equal(h.calls.length, 1); }
  finally { release(); }
  assert.equal((await first).ok, true); assert.equal(h.calls.length, 2);
});

test('PMDG speedbrake cannot confirm unchanged or retired telemetry and never repeats the click', async () => {
  for (const family of ['pmdg-737', 'pmdg-777']) for (const outcome of ['stale', 'profile']) {
    const is777 = family === 'pmdg-777', field = is777 ? 'controls.speedbrakePercent' : 'flightControls.speedbrakePercent';
    const h = harness(family, is777 ? {} : { [field]: 0 });
    const sdk = { adapterId: 'clientdata-manifest', status: 'running', normalized: { spoilers: { handlePercent: 0 } },
      snapshotSequence: 1, updatedAt: new Date().toISOString() };
    h.provider._sdkBridge = { getSnapshot: () => sdk, isDataConnected: () => true };
    h.bridge.sendSdkEvent = async (name, value) => {
      h.calls.push({ name, value });
      if (is777) sdk.normalized.spoilers.handlePercent = 75;
      else h.publish(field, 50, false);
      if (outcome === 'profile') h.retire();
      return { ok: true };
    };
    const result = await h.run(`${is777 ? 'controls' : 'flightControls'}.speedbrake.half`);
    assert.equal(result.ok, false, `${family} ${outcome}: ${JSON.stringify(result)}`); assert.equal(h.calls.length, 2);
  }
});
