import test from 'node:test';
import assert from 'node:assert/strict';
import { presetSourceUnavailableReason } from './preset-observation.js';

// These are the families on the supported-aircraft list. A live simulator link
// alone must not enable a preset against missing or different aircraft data.
for (const configurationId of ['pmdg-737', 'pmdg-777', 'fenix-a32x', 'fbw-a32nx', 'inibuilds-a350', 'tfdi-md-11']) {
  test(`${configurationId}: phase presets require matching connected aircraft data`, () => {
    const now = Date.now(), at = new Date(now).toISOString();
    const catalogue = { configurationId, profileKey: `bundled/msfs/${configurationId}`, profileRevision: 7 };
    const values = { 'systems.busVoltage': 115, 'lights.landing': true, 'lights.noseMode': 'taxi',
      'lights.strobeMode': 'off', 'lights.navMode': 'nav1', 'lights.landingLeftPosition': 2,
      'lights.landingRightPosition': 2, 'lights.nosePosition': 2, 'lights.turnoffLeft': false,
      'lights.turnoffRight': false, 'lights.strobe': true, 'lights.nav': true };
    const snapshot = { templateId: configurationId, activeProfileKey: catalogue.profileKey, activeProfileRevision: 7,
      available: true, sourceStatus: 'connected', sourceStatuses: { sdk: 'connected' }, values,
      receivedAt: now, updatedAt: at, valueUpdatedAt: Object.fromEntries(Object.keys(values).map(id => [id, at])) };
    for (const phase of ['takeoff', 'afterTakeoff', 'landing', 'afterLanding']) {
      const command = { id: `configuration.lights.${phase}` };
      assert.equal(presetSourceUnavailableReason(command, snapshot, catalogue, now), '');
      for (const patch of [{ sourceStatus: 'disconnected' }, { sourceStatus: 'stale' },
        { activeProfileKey: 'bundled/msfs/another-aircraft' }, { activeProfileRevision: 6 }]) {
        assert.ok(presetSourceUnavailableReason(command, { ...snapshot, ...patch }, catalogue, now), `${phase}: ${JSON.stringify(patch)}`);
      }
      assert.ok(presetSourceUnavailableReason(command, null, catalogue, now), phase + ': no snapshot');
    }
  });
  if (configurationId !== 'tfdi-md-11') test(`${configurationId}: APU request also requires matching connected aircraft data`, () => {
    const catalogue = { configurationId, profileKey: `bundled/msfs/${configurationId}`, profileRevision: 2 };
    const snapshot = { templateId: configurationId, activeProfileKey: catalogue.profileKey, activeProfileRevision: 2,
      sourceStatus: 'connected', sourceStatuses: { sdk: 'connected' } };
    const command = { id: 'configuration.apu.start' };
    assert.equal(presetSourceUnavailableReason(command, snapshot, catalogue), '');
    assert.ok(presetSourceUnavailableReason(command, { ...snapshot, activeProfileRevision: 1 }, catalogue));
    assert.ok(presetSourceUnavailableReason(command, { ...snapshot, sourceStatus: 'disconnected' }, catalogue));
  });
}

test('generic phase presets do not require an aircraft-specific telemetry adapter', () => {
  assert.equal(presetSourceUnavailableReason({ id: 'configuration.lights.takeoff' }, null, { configurationId: 'generic' }), '');
});
