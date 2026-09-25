import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolbarPresetStream, toolbarPresetToken } from './toolbar-presets';
import { isClientMessageAuthorized, PRIVILEGED_CLIENT_MESSAGE_TYPES } from './client-message-authorization';

test('toolbar capability is separate from both desktop and aircraft-control access', () => {
  assert.equal(toolbarPresetToken(''), '');
  assert.notEqual(toolbarPresetToken('session'), 'session');
  assert.notEqual(toolbarPresetToken('session'), toolbarPresetToken('next-session'));
  const client = { __ffToolbarPresetClient: true };
  assert.equal(isClientMessageAuthorized(client, 'executeAircraftCommand'), true);
  for (const type of [...PRIVILEGED_CLIENT_MESSAGE_TYPES, 'executeAircraftControl', 'sendCduKey', 'autotaxi', 'unknown']) {
    assert.equal(isClientMessageAuthorized(client, type), false, type);
  }
});

test('preset readback keeps only required fields and preserves freshness at a bounded rate', () => {
  let now = 1000;
  const stream = createToolbarPresetStream(() => now);
  const catalogue = { profileKey: 'test', profileRevision: 1, commands: [
    { id: 'configuration.lighting.cockpit', kind: 'preset', brightnessFields: ['lighting.dimmer'] },
    { id: 'configuration.apu.start', kind: 'preset', observations: [{ fieldId: 'electrical.apuAvailable' }] },
  ] };
  stream(JSON.stringify({ type: 'aircraftProfile', controlCapabilities: { aircraftCommands: catalogue } }));
  const source = { type: 'aircraftSpecificState', profileKey: 'test', profileRevision: 1,
    available: true, sourceStatus: { overall: 'connected' }, updatedAt: '2026-09-25T00:00:00.000Z',
    values: { 'lighting.dimmer': 50, 'electrical.apuAvailable': true, 'unrelated.field': 'secret' },
    valueUpdatedAt: { 'lighting.dimmer': '2026-09-24T23:59:59.000Z' }, unavailable: [] };
  const payload = JSON.stringify(source);
  const first = JSON.parse(stream(payload));
  assert.equal(first.type, 'toolbarPresetState');
  assert.deepEqual(first.values, { 'lighting.dimmer': 50, 'electrical.apuAvailable': true });
  assert.equal(first.updatedAt, source.updatedAt);
  assert.equal(first.valueUpdatedAt['lighting.dimmer'], source.valueUpdatedAt['lighting.dimmer']);
  assert.equal(stream(payload), payload, 'intervening per-tick messages remain unsubscribed');
  now += 500;
  assert.equal(JSON.parse(stream(payload)).type, 'toolbarPresetState');
  now += 500;
  assert.equal(JSON.parse(stream(JSON.stringify({ ...source, profileRevision: 2 }))).type, 'aircraftSpecificState');
  stream(JSON.stringify({ type: 'aircraftChanged' }));
  assert.equal(stream(payload), payload, 'old aircraft cannot refresh preset readbacks');
});

test('MD-11 preset projection retains the vendor switches and power needed by freshness gates', async () => {
  const { readbackFields } = require('../../shared/aircraft-presets');
  const required = ['systems.busVoltage', 'lights.landingLeftPosition', 'lights.landingRightPosition',
    'lights.nosePosition', 'lights.turnoffLeft', 'lights.turnoffRight', 'lights.strobe', 'lights.nav'];
  const fields = readbackFields([{ id: 'configuration.lights.takeoff', kind: 'preset' }]);
  for (const field of required) assert.ok(fields.includes(field), field);
});
