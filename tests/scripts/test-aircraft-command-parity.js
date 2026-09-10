const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
const loader = require(runtime('aircraft/aircraft-profile-loader.js'));
const { buildAircraftControlCapabilities, resolveAircraftCommand, executeAircraftCommand } = require(runtime('aircraft/aircraft-control-service.js'));
const { aircraftParityBindings } = require(runtime('aircraft/aircraft-command-parity.js'));
const { defaultAircraftIntegrationRegistry: registry } = require(runtime('aircraft/aircraft-integrations/index.js'));
const capabilities = { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event', 'lvar', 'simvar'],
  integrationTransports: ['sdk', 'simconnect-sequence', 'lvar', 'mobiflight-calculator', 'simbridge-mcdu'] };
const hotwords = new Set(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../electron/resources/voice/hotwords.txt'), 'utf8')
  .split(/\r?\n/).map(line => line.split(':')[0].trim()));
const optionsFor = id => ({ profile: loader.loadProfile(`bundled/msfs/${id}`), capabilities, profileRevision: 7 });

test('every intended parity binding is advertised, guarded and voiced on every exact bundled variant', () => {
  let expanded = 0;
  for (const entry of loader.listProfiles()) {
    const profile = loader.loadProfile(`bundled/${entry.simulator}/${entry.id}`);
    const adapterId = profile.integration?.aircraftSpecific?.adapter;
    const bindings = aircraftParityBindings(adapterId);
    const options = { profile, capabilities: entry.simulator === 'msfs' ? capabilities : { simulator: 'xplane', actionTypes: [] } };
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    for (const command of catalogue.commands) assert.ok(command.speech?.patterns?.length, `${entry.id}: ${command.id} needs voice`);
    if (!bindings.length) continue;
    if (!registry.resolveForProfile(profile._profileKey)) {
      for (const binding of bindings) assert.ok(!catalogue.commands.some(command => command.id === binding.commandId), 'abstract bases cannot activate an adapter');
      continue;
    }
    expanded++;
    for (const binding of bindings) {
      const command = catalogue.commands.find(command => command.id === binding.commandId);
      assert.ok(command, `${entry.id}: ${binding.commandId} was silently dropped`);
      for (const hint of command.speech.hints || []) assert.ok(hotwords.has(hint), `Missing recognition hint: ${hint}`);
      const values = command.input.kind === 'boolean' ? [false, true] : command.input.kind === 'enum' ? command.input.values
        : command.input.kind === 'none' ? [undefined] : [command.input.min, command.input.max];
      for (const value of values) {
        const request = { commandId: command.id, input: value === undefined ? {} : { value } };
        const resolved = resolveAircraftCommand(request, options);
        assert.equal(resolved.ok, true, `${entry.id}: ${command.id} ${value}`);
        for (const control of resolved.controlRequests) {
          assert.equal(control.control, 'aircraft-specific', 'must not fall through to generic events');
          const action = registry.resolveAction({ adapterId, profileKey: profile._profileKey, actionId: control.actionId });
          assert.equal(action.guard.retry, 'never');
          assert.ok(action.routes.every(route => route.readback || route.readbacks));
        }
        assert.equal(resolveAircraftCommand(request, { ...options,
          capabilities: { ...capabilities, integrationTransports: [] } }).ok, false, 'no write transport, no command');
      }
    }
  }
  assert.equal(expanded, 19, 'all reviewed variants retain their new command coverage');
});

const routes = [
  ['pmdg-737', 'engage lnav', 'flightGuidance.lnav.engage', undefined, 'afds.lnav.engage'],
  ['pmdg-737-600', 'engage vnav', 'flightGuidance.vnav.engage', undefined, 'afds.vnav.engage'],
  ['pmdg-737-700', 'first officer flight director on', 'flightGuidance.flightDirectorFirstOfficer.set', true, 'afds.flightDirectorFirstOfficer.on'],
  ['pmdg-737-900', 'set autothrottle arm off', 'flightGuidance.autothrottleArm.set', false, 'afds.autothrottleArm.off'],
  ['pmdg-737', 'set first officer course two seven zero', 'flightGuidance.course.firstOfficer', 270, 'mcp.courseFirstOfficer.set'],
  ['pmdg-777', 'set pack one auto', 'systems.pack1.set', 'auto', 'systems.air.packLeft.auto'],
  ['pmdg-777f', 'set engine two anti ice auto', 'systems.engineAntiIce2.set', 'auto', 'systems.antiIce.engineRight.auto'],
  ['pmdg-737', 'set pack one high', 'systems.pack1.set', 'high', 'systems.air.packLeft.high'],
  ['fenix-a320', 'set pack one on', 'systems.pack1.set', 'on', 'systems.pack1.on'],
  ['fenix-a319', 'set seat belts off', 'cabin.seatBelts.set', 'off', 'cabin.seatBelts.off'],
  ['fenix-a321', 'set captain wiper slow', 'visibility.captain.wiper', 'slow', 'visibility.wiperCaptain.slow'],
  ['fbw-a32nx', 'set captain nd mode ils', 'navigation.captain.mode', 'ils', 'navigation.ndCaptainMode.roseIls'],
  ['fbw-a32nx', 'set emergency lights auto', 'cabin.emergencyExit.set', 'auto', 'cabin.emergencyExit.auto'],
  ['fbw-a32nx', 'set ay pee you bleed on', 'systems.apuBleed.set', 'on', 'systems.apuBleed.on'],
  ['fbw-a380x', 'autopilot one on', 'flightGuidance.autopilot1.set', true, 'flightGuidance.ap1.on'],
  ['fbw-a380x', 'autothrust off', 'flightGuidance.autothrust.set', false, 'flightGuidance.autothrust.off'],
  ['fbw-a380x', 'parking brake off', 'surfaces.parkingBrake.set', false, 'controls.parkingBrake.released'],
  ['inibuilds-a350-900', 'set seat belts auto', 'cabin.seatBelts.set', 'auto', 'cabin.seatBelts.auto'],
  ['inibuilds-a350-1000', 'set probe heat auto', 'systems.probeHeat.set', 'auto', 'systems.probeWindowHeat.auto'],
  ['inibuilds-tristar', 'set wing lights off', 'lights.wing.set', false, 'lights.wing.setOff'],
  ['microsoft-737-max-8', 'set speed two five zero', 'flightGuidance.speed.set', 250, 'flightGuidance.speed.set'],
  ['inibuilds-a320neo-v2', 'set heading two seven zero', 'flightGuidance.heading.set', 270, 'flightGuidance.heading.set'],
  ['inibuilds-a321lr', 'set flight director on', 'flightGuidance.flightDirector.set', true, 'flightGuidance.flightDirector.on'],
];
for (const [id, phrase, commandId, value, actionId] of routes) test(`${id}: ${phrase} selects the aircraft's actual control`, async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  const options = optionsFor(id), catalogue = buildAircraftControlCapabilities(options.profile, options).aircraftCommands;
  const voice = interpret(phrase, catalogue), input = value === undefined ? {} : { value };
  assert.equal(voice.ok, true, JSON.stringify(voice));
  assert.equal(voice.commandId, commandId); assert.deepEqual(voice.input, input);
  const result = resolveAircraftCommand({ commandId, input }, options);
  assert.equal(result.ok, true); assert.equal(result.controlRequest.actionId, actionId);
  if (typeof value === 'number') assert.equal(result.controlRequest.value, value);
});

test('aircraft detents stay distinct and incomplete or unsupported voice commands do not execute', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  for (const [id, phrase] of [
    ['pmdg-777', 'set pack one on'], ['pmdg-737', 'set engine one anti ice auto'],
    ['fenix-a320', 'set seat belts auto'], ['fbw-a380x', 'autopilot two on'],
    ['headwind-a330', 'set pack one on'], ['inibuilds-a350-900', 'set engine two anti ice on'],
    ['inibuilds-a321lr', 'set wing anti ice on'], ['pmdg-737', 'set apu bleed'],
    ['pmdg-737', 'set seat belts on and set wing anti ice off'], ['fenix-a320', 'set captain wiper'],
  ]) {
    const options = optionsFor(id);
    assert.equal(interpret(phrase, buildAircraftControlCapabilities(options.profile, options).aircraftCommands).ok, false, `${id}: ${phrase}`);
  }
});

test('new voice routes retain profile, lifecycle, value and no-retry failure gates', async () => {
  const options = optionsFor('pmdg-737'); const writes = [];
  const provider = { aircraftControlCapabilities: capabilities, async executeAircraftControlAction(action, context) {
    writes.push(context.request.actionId); return { ok: false, code: 'readback_timeout', error: 'Not confirmed.' };
  } };
  const request = { commandId: 'cabin.seatBelts.set', input: { value: 'auto' }, profileKey: options.profile._profileKey, profileRevision: 7 };
  for (const [change, context] of [
    [{ profileRevision: 6 }, { requireProfileToken: true }],
    [{ input: { value: 'invalid' } }, {}],
    [{}, { requireStableSimState: true, simState: { simconnectConnected: true, inMenu: true } }],
    [{}, { requireStableSimState: true, simState: { simconnectConnected: false } }],
  ]) assert.equal((await executeAircraftCommand(provider, { ...request, ...change }, { ...options, ...context })).ok, false);
  assert.deepEqual(writes, []);
  const cloned = { ...options.profile, _profileKey: 'local/msfs/copied-737' };
  assert.equal(resolveAircraftCommand(request, { ...options, profile: cloned }).ok, false);
  const failed = await executeAircraftCommand(provider, request, options);
  assert.equal(failed.ok, false); assert.deepEqual(writes, ['cabin.seatBelts.auto']);
});
