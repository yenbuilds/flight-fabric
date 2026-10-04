import assert = require('node:assert/strict');
import test = require('node:test');

const { loadProfile } = require('./aircraft-profile-loader');
const { defaultAircraftIntegrationRegistry: registry } = require('./aircraft-integrations');
const { buildAircraftControlCapabilities, executeAircraftCommand, resolveAircraftCommand,
  resolveAircraftControl } = require('./aircraft-control-service');
const { SimConnectTelemetryProvider } = require('../telemetry-provider/simconnect-telemetry-provider');
const profileLoader = require('./aircraft-profile-loader');

const capabilities = { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event'],
  integrationTransports: ['simconnect-sequence'] };
const preset = { commandId: 'configuration.lights.takeoff', input: {} };
const lights = ['landing', 'taxi', 'strobe', 'nav'];
const standardLightProfiles = ['fbw-a380x', 'inibuilds-a320neo-v2', 'inibuilds-a321lr', 'inibuilds-tristar'];

for (const id of standardLightProfiles) {
  test(`${id}: takeoff preset uses existing fixed light actions and stops on failed confirmation`, async () => {
    const profile = loadProfile(`bundled/msfs/${id}`);
    const on = id === 'inibuilds-tristar' ? 'setOn' : 'on';
    const options = { profile, capabilities, profileRevision: 9 };
    const resolved = resolveAircraftCommand(preset, options);
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.controlRequests.map((r: any) => r.actionId), lights.map(light => `lights.${light}.${on}`));
    assert.ok(resolved.controlRequests.every((r: any) => r.control === 'aircraft-specific'));
    for (const light of lights) {
      const action = registry.resolveAction({ adapterId: profile.integration.aircraftSpecific.adapter,
        profileKey: profile._profileKey, actionId: `lights.${light}.${on}` });
      assert.equal(action.guard.retry, 'never');
      assert.deepEqual(action.routes[0].readback,
        { fieldId: `lights.${light}`, expectedValue: true, timeoutMs: 3000 });
      assert.equal(action.routes[0].transport, 'simconnect-sequence');
      assert.equal(action.routes[0].operations.length, 1);
      assert.match(action.routes[0].operations[0].name, /(?:_SET|_ON)$/);
    }
    const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
    for (const light of lights) {
      assert.ok(catalogue.commands.some((command: any) => command.id === `lights.${light}.set`));
    }
    const sent: string[] = [];
    const provider = { aircraftControlCapabilities: capabilities,
      async executeAircraftControlAction(_action: any, { request }: any) {
        sent.push(request.actionId);
        return request.actionId === `lights.taxi.${on}`
          ? { ok: false, code: 'readback_timeout', error: 'Taxi light did not confirm.' }
          : { ok: true, code: 'executed' };
      } };
    const failed = await executeAircraftCommand(provider, preset, options);
    assert.equal(failed.ok, false);
    assert.equal(failed.completedStepCount, 1);
    assert.equal(failed.failedStepLabel, 'Taxi lights ON');
    assert.deepEqual(sent, [`lights.landing.${on}`, `lights.taxi.${on}`]);
    sent.length = 0;
    const unavailable = await executeAircraftCommand(provider, preset,
      { ...options, capabilities: { ...capabilities, integrationTransports: [] } });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.completedStepCount, 0);
    assert.deepEqual(sent, [], 'a missing route must reject the entire recipe before any write');
  });
}

// Software orchestration only. These included-Airbus light mappings still need
// exact-variant cockpit acceptance; a mock success must not promote that status.
for (const id of ['inibuilds-a320neo-v2', 'inibuilds-a321lr']) {
  const recipes = {
    takeoff: ['lights.landing.on', 'lights.taxi.on', 'lights.strobe.on', 'lights.nav.on'],
    landing: ['lights.landing.on', 'lights.taxi.on', 'lights.strobe.on', 'lights.nav.on'],
    afterTakeoff: ['lights.landing.off', 'lights.taxi.off'],
    afterLanding: ['lights.strobe.off', 'lights.landing.off', 'lights.taxi.on'],
  };
  for (const [phase, actionIds] of Object.entries(recipes)) {
    test(`${id}: ${phase} preset stops at every failed step without retry or speculative rollback`, async () => {
      const profile = loadProfile(`bundled/msfs/${id}`);
      const options = { profile, capabilities, profileRevision: 9 };
      const request = { commandId: `configuration.lights.${phase}`, input: {} };
      const resolved = resolveAircraftCommand(request, options);
      assert.equal(resolved.ok, true);
      assert.deepEqual(resolved.controlRequests.map((step: any) => step.actionId), actionIds);
      for (const actionId of actionIds) {
        const action = registry.resolveAction({ adapterId: profile.integration.aircraftSpecific.adapter,
          profileKey: profile._profileKey, actionId });
        assert.equal(action.verification, 'untested', 'offline orchestration does not prove a cockpit mapping');
      }
      for (let failedIndex = -1; failedIndex < actionIds.length; failedIndex++) {
        const sent: string[] = [];
        const provider = { aircraftControlCapabilities: capabilities,
          async executeAircraftControlAction(_action: any, { request: step }: any) {
            sent.push(step.actionId);
            return step.actionId === actionIds[failedIndex]
              ? { ok: false, code: 'aircraft_integration_readback_timeout', error: 'Light did not confirm.' }
              : { ok: true, code: 'executed' };
          } };
        const result = await executeAircraftCommand(provider, request, options);
        assert.equal(result.ok, failedIndex === -1);
        assert.deepEqual(sent, failedIndex === -1 ? actionIds : actionIds.slice(0, failedIndex + 1),
          'never retry, continue after failure, or invent a restoration from a lamp Boolean');
        if (failedIndex !== -1) {
          assert.equal(result.completedStepCount, failedIndex, 'partial completion remains explicit');
          assert.ok(result.failedStepLabel, 'identify the unconfirmed step');
        }
        sent.length = 0;
        const unavailable = await executeAircraftCommand(provider, request,
          { ...options, capabilities: { ...capabilities, integrationTransports: [] } });
        assert.equal(unavailable.ok, false);
        assert.equal(unavailable.completedStepCount, 0);
        assert.deepEqual(sent, [], 'missing transport rejects the whole preset before dispatch');
      }
    });
  }
}

test('Microsoft MAX takeoff preset requires native transport and stops after any unconfirmed light group', async () => {
  const profile = loadProfile('bundled/msfs/microsoft-737-max-8');
  const nativeCapabilities = { ...capabilities, integrationTransports: ['simconnect-sequence', 'input-event'] };
  const options = { profile, capabilities: nativeCapabilities, profileRevision: 9 };
  const actionIds = ['lights.landing.on', 'lights.taxi.on', 'lights.position.strobeAndSteady'];
  const labels = ['Landing lights ON', 'Taxi lights ON', 'Navigation and strobe lights ON'];
  const resolved = resolveAircraftCommand(preset, options);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.controlRequests.map((request: any) => request.actionId), actionIds,
    'the shared POSITION selector needs one combined request, not conflicting individual NAV/strobe steps');
  for (const failedIndex of [-1, 0, 1, 2]) {
    const sent: string[] = [];
    const provider = { aircraftControlCapabilities: nativeCapabilities,
      async executeAircraftControlAction(_action: any, { request }: any) {
        sent.push(request.actionId);
        return request.actionId === actionIds[failedIndex]
          ? { ok: false, code: 'readback_timeout', error: 'Light group did not confirm.' }
          : { ok: true, code: 'executed' };
      } };
    const result = await executeAircraftCommand(provider, preset, options);
    assert.equal(result.ok, failedIndex === -1);
    assert.deepEqual(sent, failedIndex === -1 ? actionIds : actionIds.slice(0, failedIndex + 1));
    if (failedIndex !== -1) {
      assert.equal(result.completedStepCount, failedIndex);
      assert.equal(result.failedStepLabel, labels[failedIndex]);
    }
    sent.length = 0;
    const unavailable = await executeAircraftCommand(provider, preset, { ...options, capabilities });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.completedStepCount, 0);
    assert.deepEqual(sent, [], 'standard events alone cannot dispatch the native MAX recipe');
  }
});

// Native MAX per-switch freshness, paired writes and unchanged aggregate-mask
// behavior are covered by the provider tests; these profiles use standard events.
for (const id of standardLightProfiles) {
  test(`${id}: fixed light commands still dispatch when aggregate readback already matches`, async () => {
    profileLoader.setActiveProfile(id);
    const config = profileLoader.getLvarConfig().aircraftSpecific;
    const profile = loadProfile(`bundled/msfs/${id}`);
    for (const on of [false, true]) {
      const provider = new SimConnectTelemetryProvider();
      provider._getActiveAircraftIntegrationConfig = () => config;
      provider._getAircraftIntegrationTransportCapabilities = () => ({ 'simconnect-sequence': true });
      const snapshot = { profileId: profile._profileKey, status: 'running', snapshotSequence: 1,
        updatedAt: new Date().toISOString(), values: { standard_light_states: on ? 0xffff : 0 } };
      const writes: string[] = [];
      const bridge = { getSnapshot: () => snapshot,
        async setNamedVar() { throw new Error('Light events must not write LVars'); },
        async sendEvent(name: string) {
          writes.push(name);
          snapshot.snapshotSequence++;
          snapshot.updatedAt = new Date().toISOString();
          return { ok: true };
        } };
      provider._lvarBridge = bridge;
      const suffix = id === 'inibuilds-tristar' ? (on ? 'setOn' : 'setOff') : (on ? 'on' : 'off');
      for (const light of ['landing', 'taxi', 'strobe', 'nav', 'beacon', 'wing']) {
        const result = await provider._executeAircraftIntegrationAction(bridge,
          { name: profile.integration.aircraftSpecific.adapter }, 'test', {
            profileKey: profile._profileKey, profileRevision: config.profileRevision,
            request: { actionId: `lights.${light}.${suffix}` },
          });
        assert.equal(result.ok, true, `${light}: ${JSON.stringify(result)}`);
        assert.notEqual(result.noOp, true, `${light}: a general output flag cannot prove every switch is set`);
      }
      assert.equal(writes.length, 6, 'every fixed target must be sent once, including a repeated ON/OFF request');
      assert.ok(writes.every(name => /(?:_SET|_ON|_OFF)$/.test(name)), 'reapplied commands must never toggle');
    }
  });
}

test('light-only fallback is explicit and leaves other cockpit controls disabled', () => {
  for (const genericFallback of [undefined, false]) {
    const profile = { simulator: 'msfs', id: 'test', integration: {
      controls: { standardLightFallback: true, genericFallback, standardSurfaceFallback: false },
    } };
    assert.equal(resolveAircraftCommand(preset, { profile, capabilities }).ok, true);
    for (const request of [
      { control: 'autopilot', target: 'speed', operation: 'set', value: 250 },
      { control: 'spoilers', operation: 'set', value: 0 },
      { control: 'lights', target: 'unknown', operation: 'set', value: true },
    ]) assert.equal(resolveAircraftControl(request, { profile, capabilities }).ok, false);
    profile.integration.controls.standardLightFallback = false;
    assert.equal(resolveAircraftCommand(preset, { profile, capabilities }).ok, false);
  }
});

test('category presets retain fixed ON requests without enabling their unsupported derived add-ons', async () => {
  for (const id of ['ga-base', 'regional-jet', 'turboprop-base']) {
    const profile = loadProfile(`bundled/msfs/${id}`);
    const requests: any[] = [];
    const result = await executeAircraftCommand({ aircraftControlCapabilities: capabilities,
      async executeAircraftControlAction(action: any) {
        requests.push(action);
        return { ok: true, code: 'sent_unconfirmed' };
      },
    }, preset, { profile });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'sent_unconfirmed', 'transport delivery is not cockpit confirmation');
    assert.deepEqual(requests, ['LANDING_LIGHTS_SET', 'TAXI_LIGHTS_SET', 'STROBES_SET'].map(name =>
      ({ type: 'key-event', name, parameters: [0], value: true })));
  }
  for (const id of ['fss-e175', 'justflight-146', 'inibuilds-a400m', 'microsoft-atr-72-600']) {
    const profile = loadProfile(`bundled/msfs/${id}`);
    assert.equal(profile.integration.controls.standardLightFallback, false);
    assert.equal(resolveAircraftCommand(preset, { profile, capabilities }).ok, false);
  }
});
