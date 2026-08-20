const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PMDG_737_ADAPTER_ID,
  PMDG_737_INTEGRATION,
  PMDG_737_600_PROFILE_KEY,
  PMDG_737_700_PROFILE_KEY,
  PMDG_737_800_PROFILE_KEY,
  PMDG_737_900_PROFILE_KEY,
} = require('./index');
const { defaultAircraftIntegrationRegistry } = require('..');

test('PMDG 737 adapter shares one trusted contract across exact family profiles', () => {
  for (const profileKey of [
    PMDG_737_600_PROFILE_KEY,
    PMDG_737_700_PROFILE_KEY,
    PMDG_737_800_PROFILE_KEY,
    PMDG_737_900_PROFILE_KEY,
  ]) {
    const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
      PMDG_737_ADAPTER_ID,
      { profileKey },
    );
    assert.equal(integration.id, PMDG_737_INTEGRATION.id);
    assert.deepEqual(integration.trustedProfileKeys, PMDG_737_INTEGRATION.trustedProfileKeys);
    assert.equal(integration.presentation.templateId, 'pmdg-737');
  }

  assert.equal(Object.keys(PMDG_737_INTEGRATION.fields).length, 81);
  assert.equal(Object.keys(PMDG_737_INTEGRATION.actions).length, 81);
  assert.equal(
    PMDG_737_INTEGRATION.fields['aircraft.model'].sources[0].decode.values['737-800 BBJ BW'],
    '737-800 BBJ BW',
  );
  assert.deepEqual(PMDG_737_INTEGRATION.fields['lights.beacon'].sources[0], {
    route: { type: 'sdk', adapter: 'clientdata-manifest', path: 'lights.beacon' },
    decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
  });
  assert.deepEqual(PMDG_737_INTEGRATION.fields['visibility.wiperLeftMode'].sources[0], {
    route: { type: 'sdk', adapter: 'clientdata-manifest', path: 'visibility.wipers.left' },
    decode: {
      type: 'enum',
      values: { off: 'off', intermittent: 'intermittent', low: 'low', high: 'high' },
    },
  });

  const beaconOn = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'lights.beacon.on',
  });
  assert.equal(beaconOn.guard.groupId, 'pmdg737.lights.beacon');
  assert.equal(beaconOn.guard.retry, 'never');
  assert.equal(beaconOn.routes[0].transport, 'sdk');
  assert.equal(beaconOn.routes[0].adapter, 'clientdata-manifest');
  assert.equal(beaconOn.routes[0].command, '#69756');
  assert.equal(beaconOn.routes[0].value, 1);
  assert.equal(beaconOn.routes[0].readback.fieldId, 'lights.beacon');
  assert.equal(beaconOn.routes[0].readback.expectedValue, true);

  const wiperHigh = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_900_PROFILE_KEY,
    actionId: 'visibility.wiperRight.high',
  });
  assert.equal(wiperHigh.routes[0].command, '#69741');
  assert.equal(wiperHigh.routes[0].value, 3);
  assert.equal(wiperHigh.routes[0].readback.fieldId, 'visibility.wiperRightMode');
  assert.equal(wiperHigh.routes[0].readback.expectedValue, 'high');

  const headingSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'mcp.heading.set',
  });
  assert.deepEqual(headingSet.input, { type: 'number', min: 0, max: 359, step: 1 });
  assert.equal(headingSet.routes[0].command, '#84136');
  assert.deepEqual(headingSet.routes[0].inputValue, {
    source: 'input', scale: 1, offset: 0, round: 'nearest',
  });
  assert.equal(headingSet.routes[0].readback.fieldId, 'mcp.headingDeg');
  assert.equal(headingSet.routes[0].readback.expectedInput, true);

  const verticalSpeedSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'mcp.verticalSpeed.set',
  });
  assert.equal(verticalSpeedSet.routes[0].command, '#84138');
  assert.equal(verticalSpeedSet.routes[0].inputValue.offset, 10000);

  const iasSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'mcp.ias.set',
  });
  const machSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'mcp.mach.set',
  });
  assert.equal(iasSet.guard.groupId, 'pmdg737.mcp.speed');
  assert.equal(machSet.guard.groupId, iasSet.guard.groupId,
    'IAS and Mach must serialize on the shared MCP speed selector');

  const flightDirectorOn = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'afds.flightDirectorCaptain.on',
  });
  assert.equal(flightDirectorOn.routes[0].command, '#70010');
  assert.deepEqual(flightDirectorOn.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(flightDirectorOn.routes[0].value, undefined);
  assert.equal(flightDirectorOn.routes[0].readback.fieldId, 'afds.flightDirectorCaptain');
  assert.equal(flightDirectorOn.routes[0].readback.expectedValue, true);

  const flightDirectorOff = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_900_PROFILE_KEY,
    actionId: 'afds.flightDirectorFirstOfficer.off',
  });
  assert.equal(flightDirectorOff.routes[0].command, '#70039');
  assert.deepEqual(flightDirectorOff.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(flightDirectorOff.routes[0].readback.expectedValue, false);

  const autothrottleArmOn = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'afds.autothrottleArm.on',
  });
  assert.equal(autothrottleArmOn.routes[0].command, '#70012');
  assert.equal(autothrottleArmOn.routes[0].value, 0);
  assert.equal(autothrottleArmOn.routes[0].readback.expectedValue, true);

  const autothrottleArmOff = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'afds.autothrottleArm.off',
  });
  assert.equal(autothrottleArmOff.routes[0].command, '#70012');
  assert.equal(autothrottleArmOff.routes[0].value, 1);
  assert.equal(autothrottleArmOff.routes[0].readback.expectedValue, false);

  for (const [actionId, expectedValue, rotorBrakeValues, sdkValue] of [
    ['lights.position.steady', 'steady', [12301, 12301], 0],
    ['lights.position.off', 'off', [12301, 12301, 12302], 1],
    ['lights.position.strobeSteady', 'strobe-steady', [12302, 12302], 2],
  ] as const) {
    const action = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: PMDG_737_ADAPTER_ID,
      profileKey: PMDG_737_800_PROFILE_KEY,
      actionId,
    });
    assert.equal(action.routes[0].transport, 'simconnect-sequence');
    assert.deepEqual(action.routes[0].operations, rotorBrakeValues.map((value) => ({
      type: 'event', name: 'ROTOR_BRAKE', value,
    })));
    assert.equal(action.routes[0].readback.fieldId, 'lights.positionMode');
    assert.equal(action.routes[0].readback.expectedValue, expectedValue);
    assert.equal(action.routes[1].command, '#69755');
    assert.equal(action.routes[1].value, sdkValue);
  }

  const nav1Transfer = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'nav1.transfer',
  });
  assert.equal(nav1Transfer.routes[0].transport, 'simconnect-sequence');
  assert.deepEqual(nav1Transfer.routes[0].operations, [
    { type: 'event', name: 'ROTOR_BRAKE', value: 72901 },
  ]);
  assert.equal(nav1Transfer.routes[0].readback.fieldId, 'radios.nav1ActiveMhz');
  assert.equal(nav1Transfer.routes[0].readback.confirmation, 'changed');
  assert.equal(nav1Transfer.routes[1].command, '#70361');
  assert.deepEqual(nav1Transfer.routes[1].values, [0x20000000, 0x00020000]);

  const nav2InnerIncrement = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_900_PROFILE_KEY,
    actionId: 'nav2.inner.increment',
  });
  assert.equal(nav2InnerIncrement.routes[0].transport, 'simconnect-sequence');
  assert.deepEqual(nav2InnerIncrement.routes[0].operations, [
    { type: 'event', name: 'ROTOR_BRAKE', value: 84907 },
  ]);
  assert.equal(nav2InnerIncrement.routes[0].readback.fieldId, 'radios.nav2StandbyMhz');
  assert.equal(nav2InnerIncrement.routes[1].command, '#70481');
  assert.equal(nav2InnerIncrement.routes[1].value, 0x00004000);

  for (const [actionId, rotorBrakeValue] of [
    ['nav1.transfer', 72901],
    ['nav1.inner.decrement', 73208],
    ['nav1.inner.increment', 73207],
    ['nav1.outer.decrement', 73308],
    ['nav1.outer.increment', 73307],
    ['nav2.transfer', 84501],
    ['nav2.inner.decrement', 84908],
    ['nav2.inner.increment', 84907],
    ['nav2.outer.decrement', 84808],
    ['nav2.outer.increment', 84807],
  ] as const) {
    const action = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: PMDG_737_ADAPTER_ID,
      profileKey: PMDG_737_800_PROFILE_KEY,
      actionId,
    });
    assert.deepEqual(action.routes[0].operations, [
      { type: 'event', name: 'ROTOR_BRAKE', value: rotorBrakeValue },
    ], `${actionId} must retain its reviewed PMDG compatibility encoding`);
  }

  const preferredNavRoute = defaultAircraftIntegrationRegistry.selectActionRoute({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'nav1.inner.increment',
  }, ['sdk', 'simconnect-sequence']);
  assert.ok(preferredNavRoute);
  assert.equal(preferredNavRoute.routeId, 'pmdg737.nav1.inner.increment.rotorBrake');
  assert.equal(preferredNavRoute.transport, 'simconnect-sequence');

  const sdkOnlyNavRoute = defaultAircraftIntegrationRegistry.selectActionRoute({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'nav1.inner.increment',
  }, ['sdk']);
  assert.ok(sdkOnlyNavRoute);
  assert.equal(sdkOnlyNavRoute.routeId, 'pmdg737.nav1.inner.increment.sdk');

  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(PMDG_737_ADAPTER_ID, {
    profileKey: 'local/msfs/pmdg-737',
  }), null, 'copied profiles must not activate executable PMDG SDK routes');
});

export {};
