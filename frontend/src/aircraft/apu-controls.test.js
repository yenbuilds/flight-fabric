import test from 'node:test';
import assert from 'node:assert/strict';
import { presetObservation } from './preset-observation.js';
import { interpretAircraftVoiceCommand } from '../voice/command-interpreter.js';
import { formatAviationReadback } from '../voice/local-readback.js';
import { createPinia, setActivePinia } from 'pinia';
import { useAircraftControlsStore } from '../vue/stores/aircraft-controls.js';
import { createAircraftControlController } from './control-controller.js';

const apu = { id: 'configuration.apu.start', label: 'Start APU', input: { kind: 'none' },
  speech: { patterns: ['start apu', 'start the apu', 'apu start', 'start a p u', 'start the a p u',
    'a p u start', 'start auxiliary power unit', 'start the auxiliary power unit'] },
  observations: [
    { fieldId: 'systems.apuAvailable', expectedValue: true, label: 'APU available', inhibitsRequest: true },
    { fieldId: 'systems.apuStart', expectedValue: true, label: 'APU starting', inhibitsRequest: true },
  ],
};
test('explicit APU start phrases resolve one no-input preset; ambiguous and unsupported requests do not', () => {
  const catalogue = { commands: { apu } };
  for (const phrase of [...apu.speech.patterns,
    'start ay pee you', 'start a p you', 'start the aye pea ewe',
    'ay pee you start', 'start A.P.U.', 'start A. P. U.',
  ]) {
    const result = interpretAircraftVoiceCommand(phrase, catalogue);
    assert.equal(result.ok, true, phrase);
    assert.equal(result.commandId, apu.id);
    assert.deepEqual(result.input, {});
    assert.equal(formatAviationReadback(result), 'A P U start requested.');
  }
  for (const phrase of ['apu', 'apu on', 'stop apu', 'start apu and turn on bleed', 'do not start apu',
    'start a p', 'start ap', 'start ay pee', 'start a you', 'start ay pee you and turn on bleed',
    'do not start ay pee you',
  ]) {
    assert.equal(interpretAircraftVoiceCommand(phrase, catalogue).ok, false, phrase);
  }
  assert.equal(interpretAircraftVoiceCommand('start apu', { commands: {} }).ok, false);
});
test('APU status uses fresh observations and never master ON or elapsed startup time', () => {
  const now = Date.now();
  const snapshot = { available: true, sourceStatus: 'connected', updatedAt: new Date(now).toISOString(),
    receivedAt: now, valueUpdatedAt: Object.fromEntries(apu.observations.map(({ fieldId }) => [fieldId, new Date(now).toISOString()])),
    unavailable: [], values: { 'systems.apuMaster': true } };
  assert.equal(presetObservation(apu, snapshot, now), null);
  snapshot.values['systems.apuStart'] = true;
  assert.equal(presetObservation(apu, snapshot, now).label, 'APU starting');
  assert.equal(presetObservation(apu, snapshot, now + 6000), null);
  snapshot.values['systems.apuAvailable'] = true;
  assert.equal(presetObservation(apu, snapshot, now).label, 'APU available');
  assert.equal(presetObservation(apu, { ...snapshot, sourceStatus: 'disconnected' }, now), null);
  assert.equal(presetObservation(apu, { ...snapshot, values: {}, updatedAt: null }, now), null);
});

test('APU status and START inhibition require fresh individual observations and local delivery', () => {
  const now = Date.now(), timestamp = new Date(now).toISOString();
  const snapshot = { available: true, sourceStatus: 'connected', updatedAt: timestamp, receivedAt: now,
    unavailable: [], values: { 'systems.apuAvailable': true, 'systems.apuStart': false },
    valueUpdatedAt: { 'systems.apuAvailable': timestamp, 'systems.apuStart': timestamp } };
  for (const patch of [
    { valueUpdatedAt: { ...snapshot.valueUpdatedAt, 'systems.apuAvailable': new Date(now - 60000).toISOString() } },
    { valueUpdatedAt: {} },
    { receivedAt: now - 60000 },
  ]) assert.equal(presetObservation(apu, { ...snapshot, ...patch }, now), null,
    'a current aggregate publication cannot revive a stale APU indication');
  const mixed = presetObservation(apu, { ...snapshot,
    values: { ...snapshot.values, 'systems.apuStart': true },
    valueUpdatedAt: { ...snapshot.valueUpdatedAt, 'systems.apuAvailable': new Date(now - 60000).toISOString() },
  }, now);
  assert.equal(mixed.label, 'APU starting', 'stale availability must not hide the fresh START observation');
  assert.equal(mixed.inhibitsRequest, true);
});

test('a fault indication cannot hide a simultaneous observation that inhibits START', () => {
  const now = Date.now();
  const command = { ...apu, observations: [
    { fieldId: 'systems.apuMasterFault', expectedValue: true, label: 'APU fault' },
    ...apu.observations,
  ] };
  const snapshot = { available: true, sourceStatus: 'connected', updatedAt: new Date(now).toISOString(),
    receivedAt: now, valueUpdatedAt: Object.fromEntries(command.observations.map(({ fieldId }) => [fieldId, new Date(now).toISOString()])),
    unavailable: [], values: { 'systems.apuMasterFault': true, 'systems.apuAvailable': true } };
  const observation = presetObservation(command, snapshot, now);
  assert.equal(observation.label, 'APU fault', 'the fault remains visible');
  assert.equal(observation.inhibitsRequest, true, 'fresh availability must still disable START');
  snapshot.unavailable = ['systems.apuAvailable'];
  assert.equal(presetObservation(command, snapshot, now).inhibitsRequest, false,
    'an unavailable indication cannot inhibit a request');
  assert.equal(presetObservation(command, snapshot, now + 6000), null);
});

test('UI releases pending START on acknowledgement, blocks overlap, and preserves partial failure labels', () => {
  setActivePinia(createPinia());
  const controls = useAircraftControlsStore();
  const sent = [];
  const toasts = [];
  const controller = createAircraftControlController({
    WebSocketRef: { OPEN: 1 }, getWs: () => ({ readyState: 1 }),
    getWsSend: () => (message) => sent.push(message),
    getAuthorizationScope: () => 'full-control', getSimconnectConnected: () => true,
    aircraftControlsStore: controls, showToast: (...toast) => toasts.push(toast),
  });
  controller.setActiveProfileToken({ _profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1 });
  controller.applyControlCapabilities({ aircraftCommands: {
    profileKey: 'bundled/msfs/fbw-a32nx', profileRevision: 1, commands: [apu],
  } });
  assert.equal(controller.sendCommand(apu.id), true);
  assert.equal(controller.sendCommand(apu.id), false, 'a repeated UI click cannot overlap');
  const key = `aircraft-command:${apu.id}`;
  assert.equal(controls.isCommandPending(key), true);
  controller.handleResult({ requestId: sent[0].requestId, commandId: apu.id,
    ok: true, code: 'executed', transportAcknowledged: true, stepCount: 2, completedStepCount: 2 });
  assert.equal(controls.isCommandPending(key), false);
  assert.equal(controls.feedback.actionText, 'APU start requested');
  assert.match(controls.feedback.routeText, /not yet confirmed/);
  assert.equal(sent.length, 1);
  assert.equal(controller.sendCommand(apu.id), true);
  controller.handleResult({ requestId: sent[1].requestId, commandId: apu.id, ok: false,
    stepCount: 2, completedStepCount: 1, executionStarted: true,
    acceptedStepLabels: ['APU master ON'], failedStepLabel: 'APU START', error: 'START rejected.' });
  assert.equal(controls.isCommandPending(key), false);
  assert.match(toasts.at(-1)[2], /Accepted: APU master ON.*Failed step: APU START/);
  assert.equal(sent.length, 2, 'failure cannot schedule another START');
});
