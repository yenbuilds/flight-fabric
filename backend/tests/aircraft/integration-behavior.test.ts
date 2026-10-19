const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultAircraftIntegrationRegistry, defineAircraftIntegration } = require('../../aircraft/integration-engine');
const { resolveProfileKeyEventPolicy, getAircraftReadbackFailureHint } = require('../../aircraft/aircraft-control-policy');
const { resolveLightingOverlay } = require('../../aircraft/lighting-overlay');

function changed(id, mutate) {
  const definition = structuredClone(defaultAircraftIntegrationRegistry.getById(id));
  mutate(definition.behavior, definition);
  return definition;
}

test('malformed projection authoring cannot select a mode outside its visible field catalogue', () => {
  // Deliberately invalid authoring: the field exists in the integration, but the
  // projector only reads its explicitly selected projection.fields catalogue.
  const invalid = changed('pmdg-777', behavior => {
    behavior.flightGuidanceProjection.booleanModes.push({ fieldId: 'lights.nav', label: 'NAV' });
  });
  assert.ok(invalid.fields['lights.nav']);
  assert.throws(() => defineAircraftIntegration(invalid), /flight guidance references/);
});

test('malformed projection authoring cannot claim another family through its historical profile leaf', () => {
  const invalid = changed('pmdg-777', behavior => {
    behavior.flightGuidanceProjection.profileLeaves.push('fbw-a32nx');
  });
  assert.throws(() => defineAircraftIntegration(invalid), /flight guidance references/);
  const supported = changed('pmdg-777', behavior => {
    behavior.flightGuidanceProjection.profileLeaves = ['pmdg-777f'];
  });
  assert.doesNotThrow(() => defineAircraftIntegration(supported), 'a declared trusted variant remains supported');
});

test('behavior definitions reject closed-shape, range, field-reference and duplicate-mode mistakes', () => {
  for (const mutate of [
    behavior => { behavior.flightGuidanceProjection.maxEvents = 100001; },
    behavior => { behavior.flightGuidanceProjection.modeSettleMs = -1; },
    behavior => { behavior.flightGuidanceProjection.fields.headingDeg = 'missing.heading'; },
    behavior => { behavior.flightGuidanceProjection.booleanModes.push(behavior.flightGuidanceProjection.booleanModes[0]); },
    behavior => { behavior.flightGuidanceProjection.execute = 'arbitrary'; },
  ]) assert.throws(() => defineAircraftIntegration(changed('pmdg-777', mutate)), /integration behavior|flight guidance references/);
  for (const mutate of [
    behavior => { behavior.lightingOverlay.inputs.power.min = 131; },
    behavior => { behavior.lightingOverlay.outputs.nav.any[0].input = 'missing'; },
    behavior => { behavior.lightingOverlay.inputs.nav.coerceNumber = true; },
    behavior => { behavior.lightingOverlay.freshnessMs = 60001; },
  ]) assert.throws(() => defineAircraftIntegration(changed('tfdi-md-11', mutate)), /integration behavior|lighting overlay references/);
  for (const mutate of [
    behavior => { behavior.keyEventPolicy.cooldownMs = -1; },
    behavior => { behavior.keyEventPolicy.eventGroups = {}; },
    behavior => { behavior.keyEventPolicy.retry = 'automatic'; },
  ]) assert.throws(() => defineAircraftIntegration(changed('inibuilds-tristar', mutate)), /integration behavior/);
});

test('shared key-event policy and failure hints preserve exact profile and action authority', () => {
  const groups = { AP_AIRSPEED_HOLD: 'autothrottle', AP_VS_HOLD: 'verticalSpeedHold', AP_ALT_HOLD: 'altitudeHold',
    AP_MACH_HOLD: 'machHold', AP_HDG_HOLD: 'headingHold', TOGGLE_FLIGHT_DIRECTOR: 'flightDirector', AP_MASTER: 'apMaster',
    AUTOPILOT_OFF: 'apMaster', AP_APR_HOLD: 'app', AP_LOC_HOLD: 'loc', AP_NAV1_HOLD: 'nav1', TOGGLE_WATER_RUDDER: 'ins', AP_BC_HOLD: 'backcourse' };
  for (const [eventName, groupId] of Object.entries(groups)) {
    assert.deepEqual(resolveProfileKeyEventPolicy('bundled/msfs/inibuilds-tristar', eventName), {
      groupId, cooldownMs: 600, inFlightError: 'The TriStar AFCS control is already being sent.',
      cooldownError: 'Wait briefly before sending the TriStar AFCS control again.',
    });
    assert.equal(resolveProfileKeyEventPolicy('local/msfs/inibuilds-tristar', eventName), null);
    assert.equal(resolveProfileKeyEventPolicy('bundled/msfs/fbw-a32nx', eventName), null);
  }
  for (const name of ['toString', 'constructor', 'AP_UNKNOWN']) assert.equal(resolveProfileKeyEventPolicy('bundled/msfs/inibuilds-tristar', name), null);
  assert.match(getAircraftReadbackFailureHint('pmdg-777', 'controls.parkingBrake.set'), /^ PMDG Realistic parking-brake mode/);
  assert.equal(getAircraftReadbackFailureHint('pmdg-737', 'controls.parkingBrake.set'), '');
  assert.equal(getAircraftReadbackFailureHint('pmdg-777', 'controls.parkingBrakeWrong.set'), '');
});

test('lighting metadata retains own-field freshness, strict selector values, power and trusted profile checks', () => {
  const now = 10000;
  const values = {
    aircraft_specific_lights_nav: 0, aircraft_specific_lights_beacon: 0, aircraft_specific_lights_strobe: 1,
    aircraft_specific_lights_logo: 1, aircraft_specific_lights_landing_left_position: 0, aircraft_specific_lights_landing_right_position: 2,
    aircraft_specific_lights_nose_position: 1, aircraft_specific_lights_turnoff_left: 0, aircraft_specific_lights_turnoff_right: 1,
    aircraft_specific_systems_bus_voltage: '115',
  };
  const baseline = { profileId: 'bundled/msfs/tfdi-md-11', status: 'running', values,
    valueUpdatedAt: Object.fromEntries(Object.keys(values).map(key => [key, new Date(now).toISOString()])) };
  assert.deepEqual(resolveLightingOverlay(baseline, 'tfdi-md-11', now), {
    nav: true, beacon: true, strobe: false, logo: true, landing: true, taxi: true, turnoff: true,
  });
  for (const mutate of [
    snapshot => { snapshot.profileId = 'local/msfs/tfdi-md-11'; },
    snapshot => { snapshot.status = 'connecting'; },
    snapshot => { snapshot.values.aircraft_specific_systems_bus_voltage = 89; },
    snapshot => { snapshot.values.aircraft_specific_lights_nav = '0'; },
    snapshot => { snapshot.values.aircraft_specific_lights_nose_position = 3; },
    snapshot => { snapshot.valueUpdatedAt.aircraft_specific_lights_nav = new Date(now - 2501).toISOString(); },
    snapshot => { snapshot.valueUpdatedAt.aircraft_specific_lights_nav = new Date(now + 5001).toISOString(); },
    snapshot => { delete snapshot.valueUpdatedAt.aircraft_specific_lights_nav; },
  ]) {
    const snapshot = structuredClone(baseline); mutate(snapshot);
    assert.equal(resolveLightingOverlay(snapshot, 'tfdi-md-11', now), null);
  }
  assert.equal(resolveLightingOverlay(baseline, 'pmdg-777', now), null);
});

export {};
