#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require(resolveBackendRuntimeFile('aircraft', 'aircraft-control-service.js'));
const { normalizeProfileDocument, finalizeLoadedProfile } = require(resolveBackendRuntimeFile('aircraft', 'aircraft-profile-model.js'));
let interpretAircraftVoiceCommand;
let collectVoiceHints;
before(async () => {
  ({ interpretAircraftVoiceCommand, collectVoiceHints } = await import(pathToFileURL(path.resolve(__dirname, '../../frontend/src/voice/command-interpreter.js'))));
});

function loadFixture(id) {
  const document = require(resolveBackendRuntimeFile('aircraft', 'profiles', 'bundled', 'msfs', `${id}.json`));
  const profile = finalizeLoadedProfile(normalizeProfileDocument(document));
  profile._profileKey = `bundled/msfs/${id}`;
  const { aircraftCommands: catalogue } = buildAircraftControlCapabilities(profile, {
    profileRevision: 7,
    capabilities: { actionTypes: ['key-event', 'aircraft-integration'], integrationTransports: ['sdk', 'simconnect-sequence'] },
  });
  return { profile, catalogue };
}

for (const id of ['generic', 'widebody-base']) {
  test(`${id}: spoken NAV standby and swap resolve through the real catalogue and command service`, () => {
    const { profile, catalogue } = loadFixture(id);
    for (const [index, word] of [[1, 'one'], [2, 'two']]) {
      const phrases = [
        [`set nav ${word} standby one one zero decimal three`, 'setStandby', 110.3],
        [`set nav ${index} standby to 110.35`, 'setStandby', 110.35],
        [`tune nav radio ${word} standby one seventeen decimal niner five megahertz`, 'setStandby', 117.95],
        [`nav ${word} standby 108.00`, 'setStandby', 108],
        [`swap nav ${word}`, 'swap'],
        [`swap nav radio ${index}`, 'swap'],
        [`nav ${index} swap`, 'swap'],
      ];
      for (const [phrase, operation, value] of phrases) {
        const match = interpretAircraftVoiceCommand(phrase, catalogue);
        assert.equal(match.ok, true, phrase);
        assert.equal(match.commandId, `radios.nav${index}.${operation}`, phrase);
        assert.deepEqual(match.input, operation === 'swap' ? {} : { value }, phrase);
        const result = resolveAircraftCommand({
          commandId: match.commandId, input: match.input,
          profileKey: catalogue.profileKey, profileRevision: 7,
        }, { profile, profileRevision: 7, requireProfileToken: true });
        assert.equal(result.ok, true, phrase);
        assert.equal(result.resolvedBy, 'generic', phrase);
        assert.equal(result.action.name, operation === 'swap' ? `NAV${index}_RADIO_SWAP` : `NAV${index}_STBY_SET`, phrase);
      }
      assert.ok(collectVoiceHints(catalogue).includes(`NAV ${word.toUpperCase()} STANDBY`));
    }
  });

  test(`${id}: every NAV channel is accepted without changing its receiver or frequency`, () => {
    const { catalogue } = loadFixture(id);
    const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
    for (const [index, word] of [[1, 'one'], [2, 'two']]) {
      for (let channel = 2160; channel <= 2359; channel++) {
        const value = channel / 20;
        const spoken = [...value.toFixed(2)].map(char => char === '.' ? 'decimal' : digits[Number(char)]).join(' ');
        const match = interpretAircraftVoiceCommand(`set nav ${word} standby ${spoken}`, catalogue);
        assert.equal(match.ok, true, `${index}: ${spoken}`);
        assert.equal(match.commandId, `radios.nav${index}.setStandby`);
        assert.equal(match.input.value, value);
      }
    }
  });

  test(`${id}: missing/ambiguous receivers, active tuning and invalid channels never match`, () => {
    const { catalogue } = loadFixture(id);
    for (const phrase of [
      'swap nav', 'swap nav three', 'swap nav one and two', 'swap nav one 110.30',
      'set nav standby 110.30', 'set nav three standby 110.30',
      'set nav one and two standby 110.30', 'set nav one active 110.30',
      'set nav radios 110.30', 'set nav one standby',
      'set nav one standby 107.95', 'set nav two standby 118.00',
      'set nav one standby 110.32', 'set nav two standby 110.325',
      'set nav one standby minus one one zero decimal three',
    ]) assert.equal(interpretAircraftVoiceCommand(phrase, catalogue).ok, false, phrase);
  });
}

test('aircraft-specific opt-outs remain unavailable to generic NAV voice commands', () => {
  for (const id of ['workingtitle-747-8', 'inibuilds-a330', 'pmdg-737']) {
    const { catalogue } = loadFixture(id);
    for (const receiver of ['one', 'two']) {
      assert.equal(interpretAircraftVoiceCommand(`set nav ${receiver} standby 110.30`, catalogue).ok, false, id);
      assert.equal(interpretAircraftVoiceCommand(`swap nav ${receiver}`, catalogue).ok, false, id);
    }
  }
  const match = interpretAircraftVoiceCommand('set nav radios one one zero decimal three', loadFixture('pmdg-737').catalogue);
  assert.equal(match.commandId, 'radios.nav.setBothActive', 'the separate PMDG paired active-radio command keeps its meaning');
});
