import { INIBUILDS_A380_INTEGRATION as integration, INIBUILDS_A380_PROFILE_KEY as profileKey } from './index.js';
const test = require('node:test');
const assert = require('node:assert/strict');
const loader = require('../../aircraft-profile-loader');
const { buildAircraftControlCapabilities, resolveAircraftCommand } = require('../../aircraft-control-service');

const path = 'SimObjects\\Airplanes\\inibuilds-a380\\presets\\inibuilds\\a380-800_rr_basic\\config\\aircraft.CFG';
const profile = loader.loadProfile(profileKey);
const options = { profile, profileRevision: 7, capabilities: {
  simulator: 'msfs', actionTypes: ['aircraft-integration'], integrationTransports: ['input-event', 'simconnect-sequence'],
} };

test('A380 activates only for the installed vendor and RR Basic identity', () => {
  assert.equal(loader.detectProfile('A380-800 RR Basic', { hint: path })._profileKey, profileKey);
  assert.equal(loader.detectProfile('A380-800 RR Basic', { hint: path.toLowerCase().replaceAll('\\', '/') })._profileKey, profileKey);
  for (const hint of ['', path.replace('inibuilds-a380', 'flybywire-a380x'), path.replace('rr_basic', 'ea_basic'), path.replace('aircraft.CFG', 'other.cfg')]) {
    assert.notEqual(loader.detectProfile('A380-800 RR Basic', { hint })?._profileKey, profileKey);
  }
  assert.equal(profile.integration.controls.genericFallback, false);
  assert.equal(profile.integration.controls.standardSurfaceFallback, false);
  assert.equal(profile.aircraft.engines.count, 4);
});

test('A380 compiled subscriptions keep stable state distinct from command pulses', () => {
  loader.setActiveProfile(profileKey);
  const config = loader.getLvarConfig();
  assert.equal(config.aircraftSpecific.templateId, 'inibuilds-a380');
  assert.equal(config.aircraftSpecific.integrationId, 'inibuilds-a380');
  assert.equal(config.aircraftSpecific.fields.length, 51);
  assert.ok(config.aircraftSpecific.confirmationFields.some(field => field.id === 'systems.apuMaster'));
  assert.doesNotMatch(JSON.stringify(config), /_CMD|APU PCT RPM|EXTERNAL POWER ON/);
  loader.setActiveProfile('generic');
});

test('A380 COM1/2 opt in to guarded transactions and canonical controls', () => {
  const commands = buildAircraftControlCapabilities(profile, options).aircraftCommands.commands;
  for (const index of [1, 2]) {
    for (const operation of ['setStandby', 'swap', 'switchTo']) {
      const id = `radios.com${index}.${operation}`;
      const action = integration.actions[id];
      assert.ok(commands.some(command => command.id === id));
      assert.deepEqual((action.routes[0] as any).comRadio, { index, operation });
      assert.equal(action.guard.cooldownMs, 750);
      assert.equal(action.guard.retry, 'never');
      assert.equal(resolveAircraftCommand({ commandId: id, input: operation === 'swap' ? {} : { value: 118.005 } }, options).ok, true);
    }
    assert.equal(resolveAircraftCommand({ commandId: `radios.com${index}.setStandby`, input: { value: 137 } }, options).ok, false);
    assert.deepEqual(integration.fields[`radios.com${index}.standbyMhz`].sources[0].route,
      { type: 'simvar', name: `COM STANDBY FREQUENCY:${index}`, unit: 'MHz' });
  }
  assert.ok(!Object.keys(integration.actions).some(id => id.startsWith('radios.com3.')));
  const unavailable = buildAircraftControlCapabilities(profile, { ...options, capabilities: {
    ...options.capabilities, integrationTransports: ['input-event'],
  } }).aircraftCommands.commands;
  assert.ok(!unavailable.some(command => command.id.startsWith('radios.com')));
});

test('A380 light selector semantics cannot silently inherit A350 ON/OFF encoding', () => {
  for (const light of ['beacon', 'nav', 'landing', 'wing', 'runwayTurnoff']) {
    const on: any = integration.actions[`lights.${light}.on`].routes[0];
    const off: any = integration.actions[`lights.${light}.off`].routes[0];
    assert.equal(on.value, 0); assert.equal(on.readback.expectedValue, true);
    assert.equal(off.value, 1); assert.equal(off.readback.expectedValue, false);
    const decode: any = integration.fields[on.readback.fieldId].sources[0].decode;
    assert.equal(decode.values[0], true); assert.equal(decode.values[1], false);
    assert.equal(decode.values[2], undefined);
  }
  assert.equal((integration.actions['lights.nose.takeoff'].routes[0] as any).value, 0);
  assert.equal((integration.actions['lights.nose.taxi'].routes[0] as any).value, 1);
  assert.equal((integration.actions['lights.nose.off'].routes[0] as any).value, 2);
  for (const action of Object.values(integration.actions)) for (const route of action.routes) {
    assert.ok(['input-event', 'simconnect-sequence'].includes(route.transport));
    // COM transactions enforce independent per-field freshness in their executor.
    if (!('comRadio' in route)) for (const readback of ('readbacks' in route ? route.readbacks : [route.readback])) assert.equal(readback.freshness, 'field');
    assert.equal(action.guard.retry, 'never');
  }
});

test('A380 surfaces use installed detents and separate arming from extension', () => {
  const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
  const commands = Object.fromEntries(catalogue.commands.map(command => [command.id, command]));
  assert.deepEqual(commands['surfaces.flaps.set'].input.values, ['up', '1', '2', '3', 'full']);
  assert.equal(resolveAircraftCommand({ commandId: 'surfaces.flaps.set', input: { value: '5' } }, options).ok, false);
  assert.equal(resolveAircraftCommand({ commandId: 'surfaces.flaps.set', input: { value: 'full' } }, options).ok, true);
  assert.equal((integration.actions['controls.flaps.full'].routes[0] as any).value, 16384);
  assert.deepEqual((integration.actions['controls.speedbrake.half'].routes[0] as any).operations,
    [{ type: 'event', name: 'INI.SPOILERS_SET', value: 8192 }]);
  assert.deepEqual((integration.actions['controls.spoilersArmed.on'].routes[0] as any).operations,
    [{ type: 'event', name: 'INI.SPOILERS_ARM_ON', value: 0 }]);
  assert.doesNotMatch(JSON.stringify(integration), /AIRLINER_PED_SPOILERS|SPOILERS HANDLE POSITION/);
  const withoutEvents = buildAircraftControlCapabilities(profile, { ...options, capabilities: {
    ...options.capabilities, integrationTransports: ['input-event'],
  } }).aircraftCommands.commands;
  assert.ok(withoutEvents.some(command => command.id === 'surfaces.flaps.set'));
  assert.ok(!withoutEvents.some(command => command.id === 'surfaces.spoilers.set'));
});

test('A380 catalogue exposes verified lighting choices and a delayed APU preset, without generic fallback', () => {
  const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
  const commands = Object.fromEntries(catalogue.commands.map(command => [command.id, command]));
  assert.ok(commands['lights.beacon.set']);
  assert.deepEqual(commands['lights.noseMode.set'].input.values, ['off', 'taxi', 'takeoff']);
  assert.ok(commands['configuration.apu.start']);
  assert.deepEqual(commands['flightGuidance.speed.set'].input, { kind: 'number', min: 100, max: 350, step: 1, units: 'knots' });
  const { resolveAircraftCommandConfiguration } = require('../../aircraft-command-catalogue');
  const preset = resolveAircraftCommandConfiguration(profile).bindings.find(binding => binding.commandId === 'configuration.apu.start');
  assert.equal(preset.steps[0].settleMs, 5000);
  assert.equal(preset.observations.find(item => item.fieldId === 'systems.apuAvailable').inhibitsRequest, true);
  assert.equal(resolveAircraftCommand({ commandId: 'lights.noseMode.set', input: { value: 'auto' } }, options).ok, false);
  const disabled = buildAircraftControlCapabilities(profile, { ...options, capabilities: { ...options.capabilities, integrationTransports: [] } }).aircraftCommands;
  assert.equal(Object.keys(disabled.commands).length, 0);
});

test('A380 cabin sign intents resolve native selectors without inventing no-smoking support', () => {
  const catalogue = buildAircraftControlCapabilities(profile, options).aircraftCommands;
  const commands = Object.fromEntries(catalogue.commands.map(command => [command.id, command]));
  assert.deepEqual(commands['cabin.seatBelts.set'].input.values, ['off', 'auto', 'on']);
  assert.deepEqual(commands['cabin.emergencyExit.set'].input.values, ['off', 'arm', 'on']);
  assert.ok(commands['cabin.noMobile.set']);
  assert.equal(commands['cabin.noSmoking.set'], undefined);
  assert.equal((integration.actions['cabin.emergencyExit.arm'].routes[0] as any).value, 1);
  assert.equal((integration.actions['cabin.seatBelts.on'].routes[0] as any).value, 0);
  assert.equal((integration.actions['cabin.noMobile.off'].routes[0] as any).value, 2);
});

test('A380 air-system targets use guarded toggles for all four engines and both packs', () => {
  for (const target of ['apuBleed', 'engineBleed1', 'engineBleed2', 'engineBleed3', 'engineBleed4', 'pack1', 'pack2']) {
    const on: any = integration.actions[`systems.${target}.on`].routes[0];
    const off: any = integration.actions[`systems.${target}.off`].routes[0];
    assert.equal(on.value, 1); assert.equal(off.value, 1);
    assert.equal(on.inputEvent, off.inputEvent);
    assert.equal(on.readback.expectedValue, 'on'); assert.equal(off.readback.expectedValue, 'off');
    assert.equal(resolveAircraftCommand({ commandId: `systems.${target}.set`, input: { value: 'on' } }, options).ok, true);
    assert.equal(resolveAircraftCommand({ commandId: `systems.${target}.set`, input: { value: 'auto' } }, options).ok, false);
  }
});

test('A380 flight director confirms the vendor state instead of the unresponsive generic SimVar', () => {
  const field = integration.fields['flightGuidance.flightDirector'];
  assert.equal(field.sources.length, 1);
  assert.deepEqual(field.sources[0].route, { type: 'lvar', name: 'L:INI_FD_ON', unit: 'Number' });
  for (const value of [false, true]) {
    const route: any = integration.actions[`flightGuidance.flightDirector.${value ? 'on' : 'off'}`].routes[0];
    assert.equal(route.value, 1);
    assert.equal(route.readback.expectedValue, value);
    assert.equal(resolveAircraftCommand({ commandId: 'flightGuidance.flightDirector.set', input: { value } }, options).ok, true);
  }
});
