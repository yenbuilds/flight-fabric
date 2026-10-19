const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PMDG_737_ADAPTER_ID,
  PMDG_737_INTEGRATION,
  PMDG_737_600_PROFILE_KEY,
  PMDG_737_700_PROFILE_KEY,
  PMDG_737_800_PROFILE_KEY,
  PMDG_737_900_PROFILE_KEY,
} = require('../../../../aircraft/integration-engine/index');
const { defaultAircraftIntegrationRegistry } = require('../../../../aircraft/integration-engine');
const pmdg737Connector = require('../../../../telemetry-provider/sdk-connectors/pmdg-737-ng3-clientdata.json');
const profileLoader = require('../../../../aircraft/aircraft-profile-loader');
const { buildAircraftSpecificState } = require('../../../../aircraft/aircraft-specific-state');

const MCP_FIELD_IDS = [
  'mcp.altitudeFt',
  'mcp.headingDeg',
  'mcp.speed',
  'mcp.verticalSpeedFpm',
  'mcp.courseCaptainDeg',
  'mcp.courseFirstOfficerDeg',
];
const MCP_OBSERVED_AT = '2026-10-02T10:01:00.000Z';

function withMcpConfig(profileKey, run) {
  const originalProfileKey = profileLoader.getActiveProfileId();
  try {
    profileLoader.setActiveProfile(profileKey);
    const config = profileLoader.getAircraftSpecificConfig();
    assert.equal(config.integrationId, PMDG_737_ADAPTER_ID);
    assert.equal(config.profileKey, profileKey);
    assert.equal(config.templateId, 'pmdg-737');
    const fields = config.fields.filter(field => MCP_FIELD_IDS.includes(field.id));
    assert.deepEqual(fields.map(field => field.id).sort(), [...MCP_FIELD_IDS].sort());
    run({ ...config, fields });
  } finally {
    profileLoader.setActiveProfile(originalProfileKey);
  }
}

function mcpSdkSnapshot(selected = {}) {
  // Values at the existing Rust ClientData connector's normalized boundary.
  // The blank-window guards run there; no second SDK decoder is implemented here.
  return {
    adapterId: 'clientdata-manifest',
    status: 'running',
    snapshotSequence: 7,
    // An unchanged, current-generation CHANGED subscription can be silent for minutes.
    updatedAt: '2026-10-02T09:55:00.000Z',
    normalized: { automation: { ap: { selected: {
      altitudeFt: 18000,
      headingDeg: 273,
      iasMach: 250,
      vsFpm: -1800,
      courseLeftDeg: 269,
      courseRightDeg: 91,
      ...selected,
    } } } },
  };
}

function projectMcp(config, sdk) {
  return buildAircraftSpecificState({
    config,
    frame: { simconnect: { connected: true }, sdk },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse(MCP_OBSERVED_AT),
  });
}

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

  assert.equal(Object.keys(PMDG_737_INTEGRATION.fields).length, 130);
  assert.equal(Object.keys(PMDG_737_INTEGRATION.actions).length, 187);
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
  assert.deepEqual(PMDG_737_INTEGRATION.fields['systems.electrical.batteryMode'].sources[0], {
    route: { type: 'sdk', adapter: 'clientdata-manifest', path: 'systems.electrical.battery' },
    decode: { type: 'enum', values: { off: 'off', bat: 'bat', on: 'on' } },
  });
  assert.deepEqual(PMDG_737_INTEGRATION.fields['flightControls.flapHandleIndex'].sources[0], {
    route: { type: 'lvar', name: 'L:NGXFlapLever', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 0, 10: 1, 20: 2, 30: 3, 40: 4, 50: 5, 60: 6, 70: 7, 80: 8 } },
  });
  assert.deepEqual(PMDG_737_INTEGRATION.fields['lighting.afdsFloodPercent'].sources[0], {
    route: { type: 'lvar', name: 'L:CA_AFDS_FLOOD_LIGHT_CONTROL', unit: 'Number' },
    decode: { type: 'number', scale: 1 / 3, precision: 0 },
  });

  const connectorFields = Object.fromEntries(
    pmdg737Connector.fields.map((field) => [field.name, field]),
  );
  assert.equal(pmdg737Connector.clientData.size, 916, 'connector must retain the exact NG3 struct size');
  for (const [fieldName, offset] of [
    ['irs_mode_l', 11],
    ['irs_mode_r', 12],
    ['battery_selector', 133],
    ['standby_power_selector', 141],
    ['ground_power_available', 142],
    ['bus_transfer_auto', 144],
    ['apu_generator_off_bus', 155],
    ['transfer_bus_1_powered', 189],
    ['transfer_bus_2_powered', 190],
    ['window_heat_captain_forward', 230],
    ['window_heat_first_officer_side', 233],
    ['ground_connection_available', 658],
  ] as const) {
    assert.equal(connectorFields[fieldName]?.offset, offset, `${fieldName} must match the installed NG3 struct layout`);
  }

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

  const batteryOn = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'systems.electrical.battery.on',
  });
  assert.equal(batteryOn.routes[0].command, '#69633');
  assert.equal(batteryOn.routes[0].value, 2);
  assert.equal(batteryOn.routes[0].readback.fieldId, 'systems.electrical.batteryMode');
  assert.equal(batteryOn.routes[0].readback.expectedValue, 'on');

  const groundPowerConnect = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'systems.electrical.groundPower.connect',
  });
  assert.equal(groundPowerConnect.routes[0].transport, 'simconnect-sequence');
  assert.deepEqual(groundPowerConnect.routes[0].operations, [
    { type: 'event', name: 'ROTOR_BRAKE', value: 1702 },
    { type: 'event', name: 'ROTOR_BRAKE', value: 1704 },
  ]);
  assert.deepEqual(groundPowerConnect.routes[0].readbacks.map((readback) => ({
    fieldId: readback.fieldId,
    expectedValue: readback.expectedValue,
  })), [
    { fieldId: 'systems.electrical.transferBus1Powered', expectedValue: true },
    { fieldId: 'systems.electrical.transferBus2Powered', expectedValue: true },
  ]);

  const apuStart = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'systems.apu.start',
  });
  assert.equal(apuStart.routes.length, 1, 'do not fall back to the ineffective direct START value');
  assert.equal(apuStart.routes[0].transport, 'simconnect-sequence');
  assert.equal(apuStart.routes[0].requiredSdkAdapter, 'clientdata-manifest');
  assert.deepEqual(apuStart.routes[0].operations, [
    { type: 'event', name: 'ROTOR_BRAKE', value: 11801 },
    { type: 'delay', milliseconds: 500 },
    { type: 'event', name: 'ROTOR_BRAKE', value: 11801 },
    { type: 'delay', milliseconds: 500 },
    { type: 'event', name: 'ROTOR_BRAKE', value: 11804 },
  ]);
  assert.equal(apuStart.routes[0].confirmation, 'transport-acknowledged');
  assert.equal(apuStart.routes[0].readback, undefined);
  assert.deepEqual(apuStart.guard.skipWhen, [{ fieldId: 'systems.apuMode', expectedValue: 'start' }]);
  const apuContext = { adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY, actionId: 'systems.apu.start' };
  assert.equal(defaultAircraftIntegrationRegistry.selectActionRoute(apuContext, ['simconnect-sequence']), null);
  assert.equal(defaultAircraftIntegrationRegistry.selectActionRoute(apuContext, ['sdk']), null);
  assert.equal(defaultAircraftIntegrationRegistry.selectActionRoute(apuContext, ['sdk', 'simconnect-sequence']).transport,
    'simconnect-sequence');

  for (const [actionId, command, value, fieldId, expectedValue] of [
    ['gear.handle.off', '#70087', 1, 'gear.handleMode', 'off'],
    ['gear.autobrake.max', '#70092', 5, 'gear.autobrakeMode', 'max'],
    ['systems.air.packLeft.high', '#69832', 2, 'systems.packLeftMode', 'high'],
    ['systems.air.apuBleed.on', '#69843', 1, 'systems.apuBleed', true],
    ['systems.ice.wing.on', '#69788', 1, 'systems.wingAntiIce', true],
  ] as const) {
    const action = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: PMDG_737_ADAPTER_ID,
      profileKey: PMDG_737_800_PROFILE_KEY,
      actionId,
    });
    assert.equal(action.routes[0].command, command);
    assert.equal(action.routes[0].value, value);
    assert.equal(action.routes[0].readback.fieldId, fieldId);
    assert.equal(action.routes[0].readback.expectedValue, expectedValue);
  }

  for (const profileKey of PMDG_737_INTEGRATION.trustedProfileKeys) {
    for (const [target, event] of [['up', 'GEAR_UP'], ['down', 'GEAR_DOWN']]) {
      const context = { adapterId: PMDG_737_ADAPTER_ID, profileKey, actionId: `gear.handle.${target}` };
      const action = defaultAircraftIntegrationRegistry.resolveAction(context);
      assert.equal(action.routes.length, 1, 'no fallback after an unconfirmed gear selection');
      assert.equal(action.guard.retry, 'never');
      assert.deepEqual(action.routes[0].operations, [{ type: 'event', name: event, value: 0 }]);
      assert.deepEqual(action.routes[0].readback, { fieldId: 'gear.handleMode', expectedValue: target, timeoutMs: 2500 });
      assert.equal(defaultAircraftIntegrationRegistry.selectActionRoute(context, ['simconnect-sequence']), null);
      assert.equal(defaultAircraftIntegrationRegistry.selectActionRoute(context, ['sdk']), null);
      assert.equal(action.routes[0].requiredSdkAdapter, 'clientdata-manifest');
      assert.equal(defaultAircraftIntegrationRegistry.selectActionRoute(context, ['sdk', 'simconnect-sequence']).transport,
        'simconnect-sequence');
    }
  }

  for (const [actionId, command, fieldId, expectedValue] of [
    ['gear.parkingBrake.released', '#70325', 'gear.parkingBrake', false],
    ['gear.parkingBrake.set', '#70325', 'gear.parkingBrake', true],
    ['flightControls.speedbrake.disarm', '#76423', 'flightControls.speedbrakeArmed', false],
    ['flightControls.speedbrake.arm', '#76424', 'flightControls.speedbrakeArmed', true],
    ['flightControls.flaps.detent30', '#76780', 'flightControls.flapHandleIndex', 7],
    ['flightControls.stabTrimMainElectric.cutout', '#70341', 'flightControls.stabTrimMainElectricCutout', true],
  ] as const) {
    const action = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: PMDG_737_ADAPTER_ID,
      profileKey: PMDG_737_800_PROFILE_KEY,
      actionId,
    });
    assert.equal(action.routes[0].command, command);
    assert.deepEqual(action.routes[0].values, [0x20000000, 0x00020000]);
    assert.equal(action.routes[0].readback.fieldId, fieldId);
    assert.equal(action.routes[0].readback.expectedValue, expectedValue);
  }

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

  const courseCaptainSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'mcp.courseCaptain.set',
  });
  const courseFirstOfficerSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'mcp.courseFirstOfficer.set',
  });
  const courseBothSet = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'mcp.courseBoth.set',
  });
  assert.equal(courseCaptainSet.guard.groupId, 'pmdg737.mcp.course');
  assert.equal(courseFirstOfficerSet.guard.groupId, courseCaptainSet.guard.groupId);
  assert.equal(courseBothSet.guard.groupId, courseCaptainSet.guard.groupId);
  assert.deepEqual(courseBothSet.input, { type: 'number', min: 0, max: 359, step: 1 });
  assert.deepEqual(courseBothSet.routes[0].operations, [
    {
      type: 'event', name: '#84132',
      inputValue: { source: 'input', round: 'nearest' },
    },
    {
      type: 'event', name: '#84133',
      inputValue: { source: 'input', round: 'nearest' },
    },
  ]);
  assert.deepEqual(courseBothSet.routes[0].readbacks, [
    { fieldId: 'mcp.courseCaptainDeg', expectedInput: true, timeoutMs: 2500 },
    { fieldId: 'mcp.courseFirstOfficerDeg', expectedInput: true, timeoutMs: 2500 },
  ]);

  for (const [actionId, expectedLvars, expectedFields] of [
    [
      'lighting.cockpit.panels.set',
      [
        'L:OH_CB_PANEL_LIGHT_CONTROL',
        'L:OH_PANEL_LIGHT_CONTROL',
        'L:CA_MAIN_PANEL_LIGHT_CONTROL',
        'L:FO_MAIN_PANEL_LIGHT_CONTROL',
      ],
      [
        'lighting.overheadCircuitBreakerPercent',
        'lighting.overheadPanelPercent',
        'lighting.mainPanelCaptainPercent',
        'lighting.mainPanelFirstOfficerPercent',
      ],
    ],
    [
      'lighting.cockpit.ambient.set',
      [
        'L:CA_BACKGROUND_BRT_CONTROL',
        'L:CA_AFDS_FLOOD_LIGHT_CONTROL',
        'L:PED_FLOOD_LIGHT_CONTROL',
        'L:PED_PANEL_LIGHT_CONTROL',
      ],
      [
        'lighting.backgroundPercent',
        'lighting.afdsFloodPercent',
        'lighting.pedestalFloodPercent',
        'lighting.pedestalPanelPercent',
      ],
    ],
    [
      'lighting.cockpit.captainDisplays.set',
      [
        'L:CA_OUTBD_DU_BRIGHT_CONTROL',
        'L:CA_INBD_DU_BRIGHT_CONTROL',
        'L:CA_INBD_DU_RDR_BRIGHT_CONTROL',
        'L:CA_UPPER_DU_BRIGHT_CONTROL',
      ],
      [
        'lighting.displayCaptainOutboardPercent',
        'lighting.displayCaptainInboardPercent',
        'lighting.displayCaptainMapPercent',
        'lighting.displayUpperPercent',
      ],
    ],
    [
      'lighting.cockpit.firstOfficerDisplays.set',
      [
        'L:FO_OUTBD_DU_BRIGHT_CONTROL',
        'L:FO_INBD_DU_BRIGHT_CONTROL',
        'L:FO_INBD_DU_RDR_BRIGHT_CONTROL',
        'L:CA_LOWER_DU_BRIGHT_CONTROL',
      ],
      [
        'lighting.displayFirstOfficerOutboardPercent',
        'lighting.displayFirstOfficerInboardPercent',
        'lighting.displayFirstOfficerMapPercent',
        'lighting.displayLowerPercent',
      ],
    ],
  ] as const) {
    const action = defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: PMDG_737_ADAPTER_ID,
      profileKey: PMDG_737_800_PROFILE_KEY,
      actionId,
    });
    assert.deepEqual(action.input, { type: 'number', min: 0, max: 100, step: 1 });
    assert.equal(action.guard.groupId, 'pmdg737.lighting.cockpit');
    assert.equal(action.guard.cooldownMs, 0);
    assert.equal(action.routes[0].transport, 'simconnect-sequence');
    assert.deepEqual(action.routes[0].operations, expectedLvars.map((name) => ({
      type: 'lvar',
      name,
      unit: 'Number',
      inputValue: { source: 'input', scale: 3, round: 'nearest' },
    })));
    assert.deepEqual(action.routes[0].readbacks, expectedFields.map((fieldId) => ({
      fieldId,
      expectedInput: true,
      timeoutMs: 2500,
    })));
  }

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
    assert.deepEqual(action.routes[0].operations.filter(operation => operation.type === 'event'),
      rotorBrakeValues.map((value) => ({ type: 'event', name: 'ROTOR_BRAKE', value })));
    assert.deepEqual(action.routes[0].operations.filter(operation => operation.type === 'delay'),
      rotorBrakeValues.slice(1).map(() => ({ type: 'delay', milliseconds: 100 })));
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

  const navBothSetActive = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: PMDG_737_ADAPTER_ID,
    profileKey: PMDG_737_800_PROFILE_KEY,
    actionId: 'radios.navBoth.setActive',
  });
  assert.deepEqual(navBothSetActive.input, { type: 'number', min: 108, max: 117.95, step: 0.05 });
  assert.equal(navBothSetActive.guard.groupId, 'pmdg737.radios.navBoth');
  assert.deepEqual(navBothSetActive.routes[0].operations, [
    {
      type: 'event', name: 'NAV1_RADIO_SET',
      inputValue: { source: 'input', encoding: 'frequency-bcd16' },
    },
    {
      type: 'event', name: 'NAV2_RADIO_SET',
      inputValue: { source: 'input', encoding: 'frequency-bcd16' },
    },
  ]);
  assert.deepEqual(navBothSetActive.routes[0].readbacks, [
    { fieldId: 'radios.nav1ActiveMhz', expectedInput: true, timeoutMs: 2500 },
    { fieldId: 'radios.nav2ActiveMhz', expectedInput: true, timeoutMs: 2500 },
  ]);

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

test('PMDG 737 MCP fields project SDK targets for every trusted family profile', () => {
  for (const profileKey of [
    PMDG_737_600_PROFILE_KEY,
    PMDG_737_700_PROFILE_KEY,
    PMDG_737_800_PROFILE_KEY,
    PMDG_737_900_PROFILE_KEY,
  ]) {
    withMcpConfig(profileKey, config => {
      const state = projectMcp(config, mcpSdkSnapshot());
      assert.deepEqual(state.values, {
        'mcp.altitudeFt': 18000,
        'mcp.headingDeg': 273,
        'mcp.speed': 250,
        'mcp.verticalSpeedFpm': -1800,
        'mcp.courseCaptainDeg': 269,
        'mcp.courseFirstOfficerDeg': 91,
      }, profileKey);
      assert.deepEqual(state.unavailable, []);
      assert.deepEqual(state.sourceStatus, { overall: 'connected', sources: { sdk: 'connected' } });
      assert.deepEqual(state.valueUpdatedAt, Object.fromEntries(
        MCP_FIELD_IDS.map(id => [id, MCP_OBSERVED_AT]),
      ), 'a live CHANGED subscription retains current observations despite an old change timestamp');
      assert.equal(state.profileRevision, config.profileRevision);

      const mach = projectMcp(config, mcpSdkSnapshot({ iasMach: 0.7799999713897705 }));
      assert.equal(mach.values['mcp.speed'], 0.78, 'preserve Mach as a decimal, with two-digit precision');
      assert.deepEqual(mach.unavailable, []);
    });
  }
});

test('PMDG 737 MCP projection preserves valid zero targets and independent courses', () => {
  withMcpConfig(PMDG_737_800_PROFILE_KEY, config => {
    const state = projectMcp(config, mcpSdkSnapshot({
      altitudeFt: 0,
      headingDeg: 0,
      vsFpm: 0,
      courseLeftDeg: 0,
      courseRightDeg: 359,
    }));
    assert.deepEqual(state.values, {
      'mcp.altitudeFt': 0,
      'mcp.headingDeg': 0,
      'mcp.speed': 250,
      'mcp.verticalSpeedFpm': 0,
      'mcp.courseCaptainDeg': 0,
      'mcp.courseFirstOfficerDeg': 359,
    });
    assert.deepEqual(state.unavailable, []);
  });
});

test('PMDG 737 blank SDK windows remain unavailable without clearing other MCP targets', () => {
  withMcpConfig(PMDG_737_800_PROFILE_KEY, config => {
    for (const blankValue of [null, undefined]) {
      const state = projectMcp(config, mcpSdkSnapshot({ iasMach: blankValue, vsFpm: blankValue }));
      assert.deepEqual(state.values, {
        'mcp.altitudeFt': 18000,
        'mcp.headingDeg': 273,
        'mcp.courseCaptainDeg': 269,
        'mcp.courseFirstOfficerDeg': 91,
      });
      assert.deepEqual([...state.unavailable].sort(), ['mcp.speed', 'mcp.verticalSpeedFpm']);
      assert.equal(Object.hasOwn(state.valueUpdatedAt, 'mcp.speed'), false);
      assert.equal(Object.hasOwn(state.valueUpdatedAt, 'mcp.verticalSpeedFpm'), false);
      assert.equal(state.available, true);
    }
  });
});

test('PMDG 737 MCP projection never publishes malformed numeric SDK values', () => {
  withMcpConfig(PMDG_737_800_PROFILE_KEY, config => {
    // Deliberately invalid telemetry exercises failure handling, not aircraft behavior.
    const state = projectMcp(config, mcpSdkSnapshot({
      altitudeFt: '18000',
      headingDeg: Number.NaN,
      iasMach: Number.POSITIVE_INFINITY,
      vsFpm: false,
      courseLeftDeg: {},
      courseRightDeg: null,
    }));
    assert.deepEqual(state.values, {});
    assert.deepEqual([...state.unavailable].sort(), [...MCP_FIELD_IDS].sort());
    assert.equal(state.available, false);
  });
});

test('PMDG 737 MCP fields reject unusable SDK snapshots and retired generation data', () => {
  withMcpConfig(PMDG_737_800_PROFILE_KEY, config => {
    for (const [condition, changes, expectedStatus] of [
      ['wrong adapter', { adapterId: 'different-sdk' }, 'awaiting-values'],
      ['disconnected', { status: 'disconnected' }, 'disconnected'],
      ['stopped', { status: 'stopped' }, 'disconnected'],
      ['failed', { status: 'error' }, 'error'],
      ['missing current generation and stale timestamp', { snapshotSequence: 0 }, 'stale'],
      ['new generation awaiting its first snapshot', {
        snapshotSequence: 0, updatedAt: null, normalized: {},
      }, 'awaiting-values'],
    ] as const) {
      const state = projectMcp(config, { ...mcpSdkSnapshot(), ...changes });
      assert.deepEqual(state.values, {}, condition);
      assert.deepEqual([...state.unavailable].sort(), [...MCP_FIELD_IDS].sort(), condition);
      assert.equal(state.sourceStatus.sources.sdk, expectedStatus, condition);
    }
  });
});

test('PMDG 737 MCP fields do not authorize similarly named or other-aircraft profiles', () => {
  for (const profileKey of [
    'local/msfs/pmdg-737',
    'bundled/msfs/pmdg-737-custom',
    'bundled/msfs/pmdg-777',
    'bundled/msfs/fenix-a320',
    'bundled/msfs/generic',
  ]) {
    assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(PMDG_737_ADAPTER_ID, {
      profileKey,
    }), null, profileKey);
  }
});

test('PMDG 737 command readbacks use the registered MCP fields and current profile revision', () => {
  const { SimConnectTelemetryProvider } = require('../../../../telemetry-provider/simconnect-telemetry-provider');
  withMcpConfig(PMDG_737_800_PROFILE_KEY, config => {
    const provider = new SimConnectTelemetryProvider();
    let snapshot = mcpSdkSnapshot({ iasMach: 0.7799999713897705 });
    provider._sdkBridge = { getSnapshot: () => snapshot };
    const context = {
      profileKey: config.profileKey,
      profileRevision: config.profileRevision,
      adapterId: PMDG_737_ADAPTER_ID,
    };
    const expected = {
      'mcp.altitudeFt': 18000,
      'mcp.headingDeg': 273,
      'mcp.speed': 0.78,
      'mcp.verticalSpeedFpm': -1800,
      'mcp.courseCaptainDeg': 269,
      'mcp.courseFirstOfficerDeg': 91,
    };
    for (const [fieldId, expectedValue] of Object.entries(expected)) {
      const readback = { fieldId, expectedValue };
      const sample = provider._captureAircraftIntegrationReadback(null, readback, context);
      assert.equal(sample.observed, expectedValue, fieldId);
      assert.equal(sample.fresh, true, 'old change timestamps remain valid within a live SDK generation');
      assert.equal(provider._evaluateAircraftIntegrationReadback(sample, readback, sample).confirmed, false,
        'an unchanged snapshot cannot confirm a newly sent command');
      assert.equal(provider._evaluateAircraftIntegrationReadback(sample, readback, {
        ...sample, sequence: sample.sequence - 1,
      }).confirmed, true, 'a matching observation in a newer snapshot can confirm the target');

      const staleProfile = provider._captureAircraftIntegrationReadback(null, readback, {
        ...context, profileRevision: context.profileRevision - 1,
      });
      assert.equal(staleProfile.observed, null, 'retired requests cannot resolve the current field');
      assert.equal(staleProfile.fresh, false);
    }

    snapshot = mcpSdkSnapshot({ iasMach: null, vsFpm: null });
    for (const fieldId of ['mcp.speed', 'mcp.verticalSpeedFpm']) {
      assert.equal(provider._captureAircraftIntegrationReadback(null, { fieldId }, context).observed, null,
        'blank SDK windows remain unavailable for command confirmation as well as display');
    }
  });
});

export {};
