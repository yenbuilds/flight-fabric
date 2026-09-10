const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { buildAircraftControlCapabilities } = require(resolveBackendRuntimeFile('aircraft/aircraft-control-service.js'));
const loader = require(resolveBackendRuntimeFile('aircraft/aircraft-profile-loader.js'));

function catalogueFor(id) {
  loader.setActiveProfile(id);
  return buildAircraftControlCapabilities(loader.getActiveProfile(), {
    capabilities: { actionTypes: ['aircraft-integration', 'key-event'],
      integrationTransports: ['simconnect-sequence', 'lvar', 'sdk', 'mobiflight-calculator'] },
  }).aircraftCommands;
}

test('real A32NX catalogue recognizes exact flap, autobrake and speedbrake commands without arming ambiguity', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  const catalogue = catalogueFor('fbw-a32nx');
  for (const [text, commandId, value] of [
    ['flaps up', 'surfaces.flaps.set', 'up'], ['flaps one', 'surfaces.flaps.set', '1'],
    ['set flaps two', 'surfaces.flaps.set', '2'], ['flaps three', 'surfaces.flaps.set', '3'],
    ['flaps full', 'surfaces.flaps.set', 'full'],
    ['autobrake low', 'surfaces.autobrake.set', 'low'], ['auto brake medium', 'surfaces.autobrake.set', 'medium'],
    ['set autobrake med', 'surfaces.autobrake.set', 'medium'], ['autobrake off', 'surfaces.autobrake.set', 'off'],
    ['autobrake disarm', 'surfaces.autobrake.set', 'disarm'], ['autobrake max', 'surfaces.autobrake.set', 'max'],
    ['speedbrake retract', 'surfaces.spoilers.set', 'retracted'], ['retract speed brake', 'surfaces.spoilers.set', 'retracted'],
    ['speed brake half', 'surfaces.spoilers.set', 'half'], ['set speedbrake full', 'surfaces.spoilers.set', 'full'],
    ['spoilers retracted', 'surfaces.spoilers.set', 'retracted'],
    ['arm speedbrake', 'surfaces.spoilersArmed.set', true], ['speedbrake off', 'surfaces.spoilersArmed.set', false],
    ['disarm speed brake', 'surfaces.spoilersArmed.set', false], ['arm ground spoilers', 'surfaces.spoilersArmed.set', true],
    ['flaps increase one', 'surfaces.flaps.adjust', 'increase'],
  ]) {
    const result = interpret(text, catalogue);
    assert.equal(result.ok, true, `${text}: ${JSON.stringify(result)}`);
    assert.equal(result.commandId, commandId, text); assert.deepEqual(result.input, { value }, text);
  }
  for (const text of ['flaps five', 'flaps four', 'flaps twenty', 'autobrake rto', 'autobrake one',
    'speedbrake quarter', 'do not set flaps two', 'flaps two and speedbrake full', 'autobrake medium or low']) {
    assert.equal(interpret(text, catalogue).ok, false, text);
  }
});

test('Boeing flap detents and generic speedbrake scope remain aircraft-specific', async () => {
  const { interpretAircraftVoiceCommand: interpret } = await import('../../frontend/src/voice/command-interpreter.js');
  for (const [profile, accepted, rejected] of [
    ['pmdg-737', ['flaps five', 'flaps forty'], ['flaps three', 'flaps full', 'autobrake medium']],
    ['pmdg-777', ['flaps twenty', 'flaps thirty', 'autobrake rto'], ['flaps three', 'flaps full', 'autobrake medium']],
    ['generic', ['spoilers full', 'speedbrake retract'], ['speedbrake half', 'flaps three', 'autobrake medium']],
  ]) {
    const catalogue = catalogueFor(profile);
    for (const text of accepted) assert.equal(interpret(text, catalogue).ok, true, `${profile}: ${text}`);
    for (const text of rejected) assert.equal(interpret(text, catalogue).ok, false, `${profile}: ${text}`);
  }
});

test('spoken flap and speedbrake confirmations describe selection, with ground arming separate', async () => {
  const { formatAviationReadback: readback } = await import('../../frontend/src/voice/local-readback.js');
  assert.equal(readback({ commandId: 'surfaces.flaps.set', input: { value: '3' } }), 'Flaps 3 selected.');
  assert.equal(readback({ commandId: 'surfaces.spoilers.set', input: { value: 'half' } }), 'Speedbrake half selected.');
  assert.equal(readback({ commandId: 'surfaces.autobrake.set', input: { value: 'medium' } }), 'Autobrake medium set.');
  assert.equal(readback({ commandId: 'surfaces.spoilersArmed.set', input: { value: true } }), 'Ground spoilers armed.');
});
