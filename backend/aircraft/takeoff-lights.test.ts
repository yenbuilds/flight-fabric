import assert = require('node:assert/strict');
import test = require('node:test');

const { loadProfile } = require('./aircraft-profile-loader');
const { defaultAircraftIntegrationRegistry: registry } = require('./aircraft-integrations');
const { buildAircraftControlCapabilities, executeAircraftCommand, resolveAircraftCommand,
  resolveAircraftControl } = require('./aircraft-control-service');

const capabilities = { simulator: 'msfs', actionTypes: ['aircraft-integration', 'key-event'],
  integrationTransports: ['simconnect-sequence'] };
const preset = { commandId: 'configuration.lights.takeoff', input: {} };
const lights = ['landing', 'taxi', 'strobe', 'nav'];

for (const id of ['fbw-a380x', 'microsoft-737-max-8', 'inibuilds-a320neo-v2', 'inibuilds-a321lr', 'inibuilds-tristar']) {
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
