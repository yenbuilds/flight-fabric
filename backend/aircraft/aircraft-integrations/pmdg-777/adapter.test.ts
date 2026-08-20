const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PMDG_777_ADAPTER_ID,
  PMDG_777_INTEGRATION,
  PMDG_777_300ER_PROFILE_KEY,
  PMDG_777_200ER_PROFILE_KEY,
  PMDG_777_200LR_PROFILE_KEY,
  PMDG_777F_PROFILE_KEY,
} = require('./index');
const { defaultAircraftIntegrationRegistry } = require('..');

test('PMDG 777 adapter shares one official-SDK contract across exact family profiles', () => {
  for (const profileKey of [
    PMDG_777_300ER_PROFILE_KEY,
    PMDG_777_200ER_PROFILE_KEY,
    PMDG_777_200LR_PROFILE_KEY,
    PMDG_777F_PROFILE_KEY,
  ]) {
    const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
      PMDG_777_ADAPTER_ID,
      { profileKey },
    );
    assert.equal(integration.id, PMDG_777_INTEGRATION.id);
    assert.deepEqual(integration.trustedProfileKeys, PMDG_777_INTEGRATION.trustedProfileKeys);
    assert.equal(integration.presentation.templateId, 'pmdg-777');
  }

  assert.equal(PMDG_777_INTEGRATION.presentation.templateId, 'pmdg-777');
  assert.equal(Object.keys(PMDG_777_INTEGRATION.fields).length, 169);
  assert.equal(Object.keys(PMDG_777_INTEGRATION.actions).length, 340);
  assert.deepEqual(PMDG_777_INTEGRATION.fields['lights.beacon'].sources[0], {
    route: { type: 'sdk', adapter: 'clientdata-manifest', path: 'lights.beacon' },
    decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
  });

  const beaconOn = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'lights.beacon.on',
  });
  assert.equal(beaconOn.routes[0].transport, 'sdk');
  assert.equal(beaconOn.routes[0].adapter, 'clientdata-manifest');
  assert.equal(beaconOn.routes[0].command, '#69746');
  assert.deepEqual(beaconOn.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(beaconOn.routes[0].readback.fieldId, 'lights.beacon');
  assert.equal(beaconOn.routes[0].readback.expectedValue, true);

  assert.deepEqual(PMDG_777_INTEGRATION.fields['flightGuidance.autothrottleArmedLeft'].sources[0], {
    route: { type: 'sdk', adapter: 'clientdata-manifest', path: 'automation.athr.armedLeft' },
    decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
  });

  assert.deepEqual(PMDG_777_INTEGRATION.fields['systems.wingAntiIce'].sources[0].decode, {
    type: 'enum', values: { off: 'off', auto: 'auto', on: 'on' },
  }, 'anti-ice must preserve the SDK OFF/AUTO/ON selector positions');
  assert.deepEqual(PMDG_777_INTEGRATION.fields['systems.packLeft'].sources[0].decode, {
    type: 'enum', values: { false: 'off', true: 'auto' },
  }, 'pack switches must label the documented AUTO position instead of generic ON');

  const machSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'mcp.mach.set',
  });
  assert.deepEqual(machSet.input, { type: 'number', min: 0.4, max: 0.99, step: 0.01 });
  assert.equal(machSet.guard.groupId, 'pmdg777.mcp.speed');
  assert.equal(machSet.routes[0].command, '#84135');
  assert.deepEqual(machSet.routes[0].inputValue, {
    source: 'input', scale: 1000, offset: 0, round: 'nearest',
  });
  assert.equal(machSet.routes[0].readback.fieldId, 'flightGuidance.mach');
  assert.equal(machSet.routes[0].readback.expectedInput, true);

  const iasSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'mcp.ias.set',
  });
  assert.equal(iasSet.guard.groupId, machSet.guard.groupId, 'IAS and Mach must serialize on one selector');

  const fpaSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'mcp.fpa.set',
  });
  assert.equal(fpaSet.guard.groupId, 'pmdg777.mcp.vertical');
  assert.equal(fpaSet.routes[0].command, '#84139');
  assert.deepEqual(fpaSet.routes[0].inputValue, {
    source: 'input', scale: 10, offset: 100, round: 'nearest',
  });

  const verticalSpeedSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'mcp.verticalSpeed.set',
  });
  assert.equal(verticalSpeedSet.guard.groupId, fpaSet.guard.groupId, 'VS and FPA must serialize on one selector');
  assert.equal(verticalSpeedSet.routes[0].inputValue.offset, 10000);

  const flightDirectorOn = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'afds.flightDirectorCaptain.on',
  });
  assert.equal(flightDirectorOn.routes[0].command, '#69834');
  assert.deepEqual(flightDirectorOn.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(flightDirectorOn.routes[0].readback.fieldId, 'flightGuidance.fdLeft');
  assert.equal(flightDirectorOn.routes[0].readback.expectedValue, true);

  const autothrottleArmRightOff = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'afds.autothrottleArmRight.off',
  });
  assert.equal(autothrottleArmRightOff.routes[0].command, '#69837');
  assert.deepEqual(autothrottleArmRightOff.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(autothrottleArmRightOff.routes[0].readback.fieldId, 'flightGuidance.autothrottleArmedRight');

  const apLeftEngage = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'afds.apLeft.engage',
  });
  assert.equal(apLeftEngage.routes[0].command, '#69835');
  assert.deepEqual(apLeftEngage.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(apLeftEngage.routes[0].readback.fieldId, 'flightGuidance.apLeft');
  assert.equal(apLeftEngage.routes[0].readback.expectedValue, true);

  const headingTrack = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'afds.headingMode.trk',
  });
  assert.equal(headingTrack.guard.groupId, 'pmdg777.mcp.heading');
  assert.equal(headingTrack.routes[0].command, '#69848');
  assert.deepEqual(headingTrack.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(headingTrack.routes[0].readback.expectedValue, 'TRK');

  const headingSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'mcp.heading.set',
  });
  assert.equal(headingSet.guard.groupId, headingTrack.guard.groupId, 'heading value and mode must serialize');

  const verticalFpa = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'afds.verticalMode.fpa',
  });
  assert.equal(verticalFpa.guard.groupId, fpaSet.guard.groupId, 'vertical value and mode must serialize');
  assert.equal(verticalFpa.routes[0].command, '#69852');
  assert.equal(verticalFpa.routes[0].readback.expectedValue, 'FPA');

  const emergencyArmed = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'lights.emergency.armed',
  });
  assert.equal(emergencyArmed.routes[0].command, '#69681');
  assert.equal(emergencyArmed.routes[0].value, 1);
  assert.equal(emergencyArmed.routes[0].readback.expectedValue, 'armed');

  const batteryOn = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'systems.electrical.battery.on',
  });
  assert.equal(batteryOn.routes[0].command, '#69633');
  assert.deepEqual(batteryOn.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(batteryOn.routes[0].readback.fieldId, 'systems.electrical.batteryOn');
  assert.equal(batteryOn.routes[0].readback.expectedValue, true);

  const demandAirAuto = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'systems.hydraulics.demandAirRight.auto',
  });
  assert.equal(demandAirAuto.routes[0].command, '#69669');
  assert.equal(demandAirAuto.routes[0].value, 1);
  assert.equal(demandAirAuto.routes[0].readback.expectedValue, 'auto');

  for (const [suffix, eventId, expectedValue] of [
    ['up', 74703, 'UP'],
    ['one', 74704, '1'],
    ['five', 74705, '5'],
    ['fifteen', 74706, '15'],
    ['twenty', 74707, '20'],
    ['twentyFive', 74708, '25'],
    ['thirty', 74709, '30'],
  ] as const) {
    const flapAction = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: PMDG_777_ADAPTER_ID,
      profileKey: PMDG_777_300ER_PROFILE_KEY,
      actionId: `controls.flaps.${suffix}`,
    });
    assert.equal(flapAction.routes[0].command, `#${eventId}`);
    assert.deepEqual(flapAction.routes[0].values, [0x20000000, 0x00020000]);
    assert.equal(flapAction.routes[0].readback.expectedValue, expectedValue);
  }

  for (const [suffix, eventId, expectedValue] of [
    ['stowed', 74613, 0],
    ['armed', 74614, 25],
  ] as const) {
    const speedbrakeAction = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: PMDG_777_ADAPTER_ID,
      profileKey: PMDG_777_300ER_PROFILE_KEY,
      actionId: `controls.speedbrake.${suffix}`,
    });
    assert.equal(speedbrakeAction.routes[0].command, `#${eventId}`);
    assert.deepEqual(speedbrakeAction.routes[0].values, [0x20000000, 0x00020000]);
    assert.equal(speedbrakeAction.routes[0].readback.expectedValue, expectedValue);
  }

  const parkingBrakeOff = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'controls.parkingBrake.off',
  });
  assert.equal(parkingBrakeOff.routes[0].command, '#70147');
  assert.deepEqual(parkingBrakeOff.routes[0].values, [0x20000000, 0x00020000]);
  assert.equal(parkingBrakeOff.routes[0].readback.fieldId, 'controls.parkingBrake');
  assert.equal(parkingBrakeOff.routes[0].readback.expectedValue, false);

  const captainRange = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'efis.captain.range.threeTwenty',
  });
  assert.equal(captainRange.routes[0].command, '#69819');
  assert.equal(captainRange.routes[0].value, 5);
  assert.equal(captainRange.routes[0].readback.expectedValue, '320');

  const domeSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_777_ADAPTER_ID,
    profileKey: PMDG_777_300ER_PROFILE_KEY,
    actionId: 'lighting.dome.set',
  });
  assert.deepEqual(domeSet.input, { type: 'number', min: 0, max: 100, step: 1 });
  assert.equal(domeSet.routes[0].command, '#69658');
  assert.equal(domeSet.routes[0].readback.fieldId, 'lighting.domePercent');
  assert.equal(domeSet.routes[0].readback.expectedInput, true);

  for (const action of Object.values(PMDG_777_INTEGRATION.actions) as any[]) {
    assert.equal(action.guard.retry, 'never', `${action.id} must never retry a PMDG write`);
    assert.ok(action.guard.cooldownMs >= 650, `${action.id} must retain the PMDG cooldown`);
    for (const route of action.routes) {
      assert.equal(route.transport, 'sdk');
      assert.equal(route.adapter, 'clientdata-manifest');
      assert.ok(route.readback, `${action.id} must require fresh SDK readback`);
      assert.ok(PMDG_777_INTEGRATION.fields[route.readback.fieldId], `${action.id} readback must resolve`);
    }
  }

  for (const excludedPrefix of [
    'fire.',
    'oxygen.',
    'systems.electrical.idg',
    'systems.fuel.jettison',
    'systems.hydraulics.rat',
    'controls.trim',
    'doors.',
  ]) {
    assert.equal(
      Object.keys(PMDG_777_INTEGRATION.actions).some((id) => id.startsWith(excludedPrefix)),
      false,
      `${excludedPrefix} actions must stay outside the normal remote-control surface`,
    );
  }

  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(PMDG_777_ADAPTER_ID, {
    profileKey: 'local/msfs/pmdg-777',
  }), null, 'copied profiles must not activate executable PMDG SDK routes');
});

export {};
