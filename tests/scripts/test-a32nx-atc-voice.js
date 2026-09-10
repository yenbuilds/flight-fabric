const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { buildAircraftControlCapabilities } = require(resolveBackendRuntimeFile('aircraft/aircraft-control-service.js'));
const loader = require(resolveBackendRuntimeFile('aircraft/aircraft-profile-loader.js'));

test('squawk text and spoken confirmations retain leading zeroes', async () => {
  const { describeAircraftCommandRequest } = await import('../../frontend/src/aircraft/control-ui.js');
  const { formatAviationReadback } = await import('../../frontend/src/voice/local-readback.js');
  const request = { commandId: 'surveillance.squawk.set', input: { value: 42 } };
  assert.equal(describeAircraftCommandRequest(request, { label: 'Squawk' }), 'Squawk 0042');
  assert.equal(formatAviationReadback(request), 'Squawk zero zero four two set.');
});

test('real A32NX catalogue parses squawk, IDENT, sided ND/LS and numeric minimums exactly', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  loader.setActiveProfile('fbw-a32nx');
  const catalogue = buildAircraftControlCapabilities(loader.getActiveProfile(), {
    capabilities: { actionTypes: ['aircraft-integration', 'key-event'], integrationTransports: ['lvar', 'simconnect-sequence', 'simbridge-mcdu'] },
  }).aircraftCommands;
  for (const [text, commandId, input] of [
    ['squawk zero zero four two', 'surveillance.squawk.set', { value: 42 }],
    ['set squawk 0000', 'surveillance.squawk.set', { value: 0 }],
    ['squawk seven seven seven seven', 'surveillance.squawk.set', { value: 7777 }],
    ['ident', 'surveillance.ident.activate', {}], ['squawk ident', 'surveillance.ident.activate', {}],
    ['captain range ten', 'navigation.captain.range', { value: '10' }],
    ['first officer range one hundred sixty', 'navigation.firstOfficer.range', { value: '160' }],
    ['captain range three two zero', 'navigation.captain.range', { value: '320' }],
    ['captain ls on', 'navigation.captain.ls', { value: true }],
    ['first officer l s off', 'navigation.firstOfficer.ls', { value: false }],
    ['baro minimums four two zero feet', 'approach.minimums.baro', { value: 420 }],
    ['set radio minimums 200 feet', 'approach.minimums.radio', { value: 200 }],
  ]) {
    const result = interpret(text, catalogue);
    assert.equal(result.ok, true, `${text}: ${JSON.stringify(result)}`); assert.equal(result.commandId, commandId); assert.deepEqual(result.input, input);
  }
  for (const text of ['squawk 42', 'squawk four two', 'squawk one two eight nine', 'squawk 1289', 'squawk 12345',
    'squawk one thousand two hundred', 'squawk 12.34', 'do not squawk 1234', 'squawk 1234 and ident',
    'captain range fifteen', 'captain ls maybe', 'radio minimums 5001', 'baro minimums 40000', 'minimums 420']) {
    assert.equal(interpret(text, catalogue).ok, false, text);
  }
});

test('read-only queries require current profile and every individual sample, including COM power', async () => {
  const { answerAircraftStateQuery: answer, freshAircraftValue } = await import('../../frontend/src/voice/state-queries.js');
  const now = Date.now();
  const values = { 'baro.healthy': true, 'flightGuidance.altitudeFt': 12000, 'controls.spoilersArmed': false,
    'controls.flapsHandle': '3', 'systems.autobrakeMode': 'medium', 'surveillance.powered': true, 'surveillance.squawk': 42,
    'radios.com1.installed': true, 'radios.com1.status': 0, 'radios.com1.activeMhz': 123.45 };
  const serverTime = now;
  const state = { activeProfileKey: 'bundled/msfs/fbw-a32nx', activeProfileRevision: 7, sourceStatus: 'connected', values,
    unavailable: [], updatedAt: new Date(serverTime).toISOString(), receivedAt: now,
    valueUpdatedAt: Object.fromEntries(Object.keys(values).map((key) => [key, new Date(serverTime - 100).toISOString()])) };
  const context = { profileKey: state.activeProfileKey, profileRevision: 7 };
  for (const [text, expected] of [['what is selected altitude', 'Selected altitude 12000 feet.'],
    ['are spoilers armed', 'Ground spoilers disarmed.'], ['what are the flaps', 'Flaps 3 selected.'],
    ['what is autobrake', 'Autobrake medium.'], ['what is the squawk', 'Squawk 0 0 4 2.'],
    ['what is com one active', 'Com 1 active 1 2 3 decimal 4 5 0.']]) {
    assert.equal(answer(text, state, context, now).text, expected);
  }
  const field = 'flightGuidance.altitudeFt';
  assert.equal(answer('what is selected altitude', state, { ...context, profileRevision: 8 }, now).ok, false);
  assert.equal(answer('what is selected altitude', state, context, now + 2100).ok, false);
  assert.equal(answer('what is selected altitude', { ...state, receivedAt: now + 60000 }, context, now + 60000).ok, false,
    'replaying an old message after reconnect must not make it fresh');
  assert.equal(answer('set altitude 12000', state, context, now), null);
  assert.equal(answer('do not ask what is selected altitude', state, context, now), null);
  state.values['radios.com1.status'] = 1;
  assert.equal(answer('com one active', state, context, now).ok, false);
  delete state.valueUpdatedAt[field];
  assert.equal(freshAircraftValue(state, field, now), null);
  assert.equal(answer('what is selected altitude', state, context, now).ok, false);
});
