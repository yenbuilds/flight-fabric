const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FBW_A32NX_ADAPTER_ID,
  FBW_A32NX_INTEGRATION,
  FBW_A32NX_PROFILE_KEY,
  IFLY_737_MAX_8_ADAPTER_ID,
  IFLY_737_MAX_8_INTEGRATION,
  IFLY_737_MAX_8_PROFILE_KEY,
  MICROSOFT_747_8_ADAPTER_ID,
  MICROSOFT_747_8_INTEGRATION,
  MICROSOFT_747_8_PROFILE_KEY,
  MICROSOFT_787_10_ADAPTER_ID,
  MICROSOFT_787_10_INTEGRATION,
  MICROSOFT_787_10_PROFILE_KEY,
  INIBUILDS_A310_ADAPTER_ID,
  INIBUILDS_A310_INTEGRATION,
  INIBUILDS_A310_PROFILE_KEY,
  INIBUILDS_A330_ADAPTER_ID,
  INIBUILDS_A330_INTEGRATION,
  INIBUILDS_A330_PROFILE_KEY,
  INIBUILDS_TRISTAR_ADAPTER_ID,
  INIBUILDS_TRISTAR_INTEGRATION,
  INIBUILDS_TRISTAR_PROFILE_KEY,
  MICROSOFT_737_MAX_8_ADAPTER_ID,
  MICROSOFT_737_MAX_8_INTEGRATION,
  MICROSOFT_737_MAX_8_PROFILE_KEY,
  MICROSOFT_ATR_72_600_ADAPTER_ID,
  MICROSOFT_ATR_72_600_INTEGRATION,
  MICROSOFT_ATR_72_600_PROFILE_KEY,
  INIBUILDS_A320NEO_V2_PROFILE_KEY,
  INIBUILDS_A321LR_PROFILE_KEY,
  MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
  MICROSOFT_INIBUILDS_A32X_INTEGRATION,
  TFDI_MD_11_ADAPTER_ID,
  TFDI_MD_11_INTEGRATION,
  TFDI_MD_11_PROFILE_KEY,
  createAircraftIntegrationRegistry,
  defaultAircraftIntegrationRegistry,
} = require('./index');

test('Microsoft / iniBuilds A320neo V2 and A321LR share an exact-profile monitoring adapter', () => {
  const a320Integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
    { profileKey: INIBUILDS_A320NEO_V2_PROFILE_KEY },
  );
  const a321Integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
    { profileKey: INIBUILDS_A321LR_PROFILE_KEY },
  );

  assert.equal(a320Integration.id, MICROSOFT_INIBUILDS_A32X_INTEGRATION.id);
  assert.equal(a321Integration, a320Integration);
  assert.equal(a320Integration.aircraft.vendor, 'Microsoft / iniBuilds');
  assert.equal(a320Integration.aircraft.family, 'Airbus A320neo V2 / A321LR');
  assert.equal(a320Integration.presentation.templateId, 'microsoft-inibuilds-a32x');
  assert.deepEqual(a320Integration.trustedProfileKeys, [
    INIBUILDS_A320NEO_V2_PROFILE_KEY,
    INIBUILDS_A321LR_PROFILE_KEY,
  ]);
  assert.equal(Object.keys(a320Integration.fields).length, 44);
  assert.equal(Object.keys(a320Integration.actions).length, 0);
  assert.deepEqual(a320Integration.fields['fcu.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
    profileKey: INIBUILDS_A320NEO_V2_PROFILE_KEY,
    actionId: 'flightGuidance.apMaster.toggle',
  }), null);
  for (const profileKey of [
    'local/msfs/inibuilds-a320neo-v2',
    'local/msfs/inibuilds-a321lr',
    'bundled/msfs/inibuilds-a310',
  ]) {
    assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(
      MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
      { profileKey },
    ), null, `${profileKey} must not activate the trusted Microsoft/iniBuilds A32x adapter`);
  }
});

test('Microsoft / iniBuilds A310-300 adapter is exact-profile trusted and monitoring-only', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    INIBUILDS_A310_ADAPTER_ID,
    { profileKey: INIBUILDS_A310_PROFILE_KEY },
  );

  assert.equal(integration.id, INIBUILDS_A310_INTEGRATION.id);
  assert.equal(integration.aircraft.vendor, 'Microsoft / iniBuilds');
  assert.equal(integration.aircraft.family, 'Airbus A310-300');
  assert.equal(integration.presentation.templateId, 'inibuilds-a310');
  assert.deepEqual(integration.trustedProfileKeys, [INIBUILDS_A310_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 42);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['fcp.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.deepEqual(integration.fields['controls.parkingBrake'].sources[0], {
    route: { type: 'simvar', name: 'BRAKE PARKING POSITION', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.equal(integration.fields['fcp.localizer'], undefined);
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: INIBUILDS_A310_ADAPTER_ID,
    profileKey: INIBUILDS_A310_PROFILE_KEY,
    actionId: 'fcp.ap.toggle',
  }), null);
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(
    INIBUILDS_A310_ADAPTER_ID,
    { profileKey: 'local/msfs/inibuilds-a310' },
  ), null, 'untrusted local profiles must not activate the trusted A310 adapter');
});

test('Microsoft 737 MAX 8 adapter is exact-profile trusted and monitoring-only', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_737_MAX_8_ADAPTER_ID,
    { profileKey: MICROSOFT_737_MAX_8_PROFILE_KEY },
  );

  assert.equal(integration.id, MICROSOFT_737_MAX_8_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'microsoft-737-max-8');
  assert.deepEqual(integration.trustedProfileKeys, [MICROSOFT_737_MAX_8_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 44);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['mcp.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_737_MAX_8_ADAPTER_ID,
    { profileKey: 'local/msfs/microsoft-737-max-8' },
  ), null, 'untrusted local profiles must not activate the trusted Microsoft MAX adapter');
});

test('Microsoft / Asobo Boeing 747-8 adapter is exact-profile trusted, four-engine, and monitoring-only', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_747_8_ADAPTER_ID,
    { profileKey: MICROSOFT_747_8_PROFILE_KEY },
  );

  assert.equal(integration.id, MICROSOFT_747_8_INTEGRATION.id);
  assert.equal(integration.aircraft.vendor, 'Microsoft / Asobo Studio');
  assert.equal(integration.aircraft.family, 'Boeing 747-8i / 747-8F');
  assert.equal(integration.presentation.templateId, 'workingtitle-747-8');
  assert.deepEqual(integration.trustedProfileKeys, [MICROSOFT_747_8_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 48);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['systems.engine4N1'].sources[0], {
    route: { type: 'simvar', name: 'TURB ENG N1:4', unit: 'Percent' },
    decode: { type: 'number', precision: 1 },
  });
  assert.deepEqual(integration.fields['systems.engine4Running'].sources[0], {
    route: { type: 'simvar', name: 'ENG COMBUSTION:4', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.deepEqual(integration.fields['afds.navLockMirror'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT NAV1 LOCK', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: MICROSOFT_747_8_ADAPTER_ID,
    profileKey: MICROSOFT_747_8_PROFILE_KEY,
    actionId: 'afds.apMaster.toggle',
  }), null);
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_747_8_ADAPTER_ID,
    { profileKey: 'local/msfs/workingtitle-747-8' },
  ), null, 'untrusted local profiles must not activate the trusted stock 747-8 adapter');
});

test('Microsoft / Asobo Boeing 787-10 adapter rejects inherited and untrusted local profiles', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_787_10_ADAPTER_ID,
    { profileKey: MICROSOFT_787_10_PROFILE_KEY },
  );

  assert.equal(integration.id, MICROSOFT_787_10_INTEGRATION.id);
  assert.equal(integration.aircraft.vendor, 'Microsoft / Asobo Studio');
  assert.equal(integration.aircraft.family, 'Boeing 787-10 Dreamliner');
  assert.equal(integration.presentation.templateId, 'asobo-787');
  assert.deepEqual(integration.trustedProfileKeys, [MICROSOFT_787_10_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 44);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['mcp.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.deepEqual(integration.fields['afds.navLockMirror'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT NAV1 LOCK', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  for (const profileKey of [
    'local/msfs/asobo-787',
    'bundled/msfs/kuro-787-8',
    'bundled/msfs/horizon-787-9',
  ]) {
    assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(
      MICROSOFT_787_10_ADAPTER_ID,
      { profileKey },
    ), null, `${profileKey} must not activate the trusted stock 787-10 adapter`);
  }
});

test('Microsoft ATR 72-600 adapter exposes only documented read candidates', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_ATR_72_600_ADAPTER_ID,
    { profileKey: MICROSOFT_ATR_72_600_PROFILE_KEY },
  );

  assert.equal(integration.id, MICROSOFT_ATR_72_600_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'microsoft-atr-72-600');
  assert.deepEqual(integration.trustedProfileKeys, [MICROSOFT_ATR_72_600_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 34);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['fgcp.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.deepEqual(integration.fields['fgcp.apMaster'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT MASTER', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.equal(integration.fields['fgcp.vnav'], undefined);
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: MICROSOFT_ATR_72_600_ADAPTER_ID,
    profileKey: MICROSOFT_ATR_72_600_PROFILE_KEY,
    actionId: 'fgcp.ap.toggle',
  }), null);
});

test('TFDi Design MD-11 adapter is exact-profile trusted and monitoring-only', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    TFDI_MD_11_ADAPTER_ID,
    { profileKey: TFDI_MD_11_PROFILE_KEY },
  );

  assert.equal(integration.id, TFDI_MD_11_INTEGRATION.id);
  assert.equal(integration.aircraft.vendor, 'TFDi Design');
  assert.equal(integration.aircraft.family, 'McDonnell Douglas MD-11');
  assert.equal(integration.presentation.templateId, 'tfdi-md-11');
  assert.deepEqual(integration.trustedProfileKeys, [TFDI_MD_11_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 47);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['afs.apState'].sources[0], {
    route: { type: 'lvar', name: 'L:MD11_AP_STATE', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'off', 1: 'ap1', 2: 'ap2', 3: 'dual' } },
  });
  assert.deepEqual(integration.fields['afs.speedMode'].sources[0], {
    route: { type: 'lvar', name: 'L:MD11_AP_IAS_MACH', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'ias', 1: 'mach' } },
  });
  assert.deepEqual(integration.fields['afs.speedValue'].sources[0].decode, {
    type: 'number',
    precision: 3,
    unavailableValues: [-999],
  });
  assert.deepEqual(integration.fields['afs.headingValue'].sources[0].decode, {
    type: 'number',
    precision: 0,
    unavailableValues: [-999],
  });
  assert.deepEqual(integration.fields['afs.verticalValue'].sources[0].decode, {
    type: 'number',
    precision: 1,
    unavailableValues: [-9999],
  });
  assert.deepEqual(integration.fields['systems.engine3N1'].sources[0], {
    route: { type: 'simvar', name: 'TURB ENG N1:3', unit: 'Percent' },
    decode: { type: 'number', precision: 1 },
  });
  assert.equal(integration.fields['controls.speedbrakePercent'], undefined);
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: TFDI_MD_11_ADAPTER_ID,
    profileKey: TFDI_MD_11_PROFILE_KEY,
    actionId: 'afs.ap.toggle',
  }), null, 'TFDi CEVENT and state/control LVAR writes require documented routes');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(TFDI_MD_11_ADAPTER_ID, {
    profileKey: 'local/msfs/tfdi-md-11',
  }), null, 'untrusted local profiles must not activate the trusted TFDi adapter');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(TFDI_MD_11_ADAPTER_ID, {
    profileKey: 'bundled/msfs/inibuilds-tristar',
  }), null, 'another tri-jet profile must not activate the trusted TFDi adapter');
});

test('iFly 737 MAX 8 adapter exposes only its exact monitoring-only contract', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    IFLY_737_MAX_8_ADAPTER_ID,
    { profileKey: IFLY_737_MAX_8_PROFILE_KEY },
  );

  assert.equal(integration.id, IFLY_737_MAX_8_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'ifly-737-max-8');
  assert.deepEqual(integration.trustedProfileKeys, [IFLY_737_MAX_8_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 41);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['mcp.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.deepEqual(integration.fields['afds.cmdA'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT MASTER', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.equal(integration.fields['afds.vnav'], undefined);
  assert.equal(integration.fields['afds.vorLoc'], undefined);
  assert.equal(integration.fields['afds.cmdB'], undefined);
  assert.equal(integration.fields['afds.n1'], undefined);
  assert.equal(integration.fields['afds.speed'], undefined);
  assert.equal(JSON.stringify(integration.fields).includes('"type":"lvar"'), false);
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: IFLY_737_MAX_8_ADAPTER_ID,
    profileKey: IFLY_737_MAX_8_PROFILE_KEY,
    actionId: 'afds.cmdA.toggle',
  }), null, 'iFly monitoring rows must never be promoted to writes');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(IFLY_737_MAX_8_ADAPTER_ID, {
    profileKey: 'local/msfs/ifly-737-max-8',
  }), null, 'untrusted local profiles must not activate the trusted iFly adapter');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(IFLY_737_MAX_8_ADAPTER_ID, {
    profileKey: 'bundled/msfs/microsoft-737-max-8',
  }), null, 'the separate Microsoft MAX profile must not activate the iFly adapter');
});

test('iniBuilds A330 adapter exposes a trusted monitoring-only standard-SimVar contract', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    INIBUILDS_A330_ADAPTER_ID,
    { profileKey: INIBUILDS_A330_PROFILE_KEY },
  );

  assert.equal(integration.id, INIBUILDS_A330_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'inibuilds-a330');
  assert.deepEqual(integration.trustedProfileKeys, [INIBUILDS_A330_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 44);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['flightGuidance.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.deepEqual(integration.fields['controls.parkingBrake'].sources[0], {
    route: { type: 'simvar', name: 'BRAKE PARKING POSITION', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: INIBUILDS_A330_ADAPTER_ID,
    profileKey: INIBUILDS_A330_PROFILE_KEY,
    actionId: 'lights.beacon.on',
  }), null, 'the A330 adapter must not expose unverified aircraft writes');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(INIBUILDS_A330_ADAPTER_ID, {
    profileKey: 'local/msfs/inibuilds-a330',
  }), null, 'untrusted local profiles must not activate the trusted A330 adapter');
});

test('iniBuilds TriStar adapter exposes only reliable monitoring fields for its exact profile', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    INIBUILDS_TRISTAR_ADAPTER_ID,
    { profileKey: INIBUILDS_TRISTAR_PROFILE_KEY },
  );

  assert.equal(integration.id, INIBUILDS_TRISTAR_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'inibuilds-tristar');
  assert.deepEqual(integration.trustedProfileKeys, [INIBUILDS_TRISTAR_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 32);
  assert.equal(Object.keys(integration.actions).length, 0);
  assert.deepEqual(integration.fields['systems.engine3N1'].sources[0], {
    route: { type: 'simvar', name: 'TURB ENG N1:3', unit: 'Percent' },
    decode: { type: 'number', precision: 1 },
  });
  assert.deepEqual(integration.fields['systems.engine3Running'].sources[0], {
    route: { type: 'simvar', name: 'ENG COMBUSTION:3', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.equal(integration.fields['flightGuidance.apMaster'], undefined);
  assert.equal(integration.fields['flightGuidance.headingHold'], undefined);
  assert.equal(integration.fields['controls.speedbrakePercent'], undefined);
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: INIBUILDS_TRISTAR_ADAPTER_ID,
    profileKey: INIBUILDS_TRISTAR_PROFILE_KEY,
    actionId: 'flightGuidance.master.toggle',
  }), null, 'the trusted TriStar adapter must remain monitoring-only');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(INIBUILDS_TRISTAR_ADAPTER_ID, {
    profileKey: 'local/msfs/inibuilds-tristar',
  }), null, 'untrusted local profiles must not activate the trusted TriStar adapter');
});

test('FlyByWire A32NX adapter exposes broad documented writes behind exact-profile guards and readback', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    FBW_A32NX_ADAPTER_ID,
    { profileKey: FBW_A32NX_PROFILE_KEY },
  );

  assert.equal(integration, defaultAircraftIntegrationRegistry.resolveForProfile(FBW_A32NX_PROFILE_KEY));
  assert.equal(integration.id, FBW_A32NX_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'fbw-a32nx');
  assert.equal(Object.keys(integration.fields).length, 119);
  assert.equal(Object.keys(integration.actions).length, 230);
  assert.deepEqual(integration.fields['lights.strobeMode'].sources[0], {
    route: { type: 'lvar', name: 'L:LIGHTING_STROBE_0', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'on', 1: 'auto', 2: 'off' } },
  });
  assert.deepEqual(integration.fields['lights.beacon'].sources[0], {
    route: { type: 'simvar', name: 'LIGHT BEACON', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.deepEqual(integration.fields['lights.strobeActive'].sources[0], {
    route: { type: 'lvar', name: 'A:LIGHT STROBE', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [1, true], falseValues: [0, false] },
  });

  const strobeOff = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: FBW_A32NX_ADAPTER_ID,
    profileKey: FBW_A32NX_PROFILE_KEY,
    actionId: 'lights.strobe.off',
  });
  assert.equal(strobeOff.guard.groupId, 'fbwA32nx.lights.strobe');
  assert.equal(strobeOff.guard.retry, 'never');
  assert.equal(strobeOff.guard.skipIfSatisfied, false, 'actual output alone cannot prove the requested selector detent');
  assert.equal(strobeOff.routes[0].transport, 'simconnect-sequence');
  assert.deepEqual(strobeOff.routes[0].operations, [
    { type: 'lvar', name: 'L:LIGHTING_STROBE_0', unit: 'Number', value: 2 },
    { type: 'lvar', name: 'L:STROBE_0_AUTO', unit: 'Number', value: 0 },
    { type: 'event', name: 'STROBES_SET', value: 0 },
  ]);
  assert.equal(strobeOff.routes[0].readback.fieldId, 'lights.strobeActive');
  assert.equal(strobeOff.routes[0].readback.expectedValue, false);

  const strobeAuto = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: FBW_A32NX_ADAPTER_ID,
    profileKey: FBW_A32NX_PROFILE_KEY,
    actionId: 'lights.strobe.auto',
  });
  assert.equal(strobeAuto.routes[0].readback.fieldId, 'lights.strobeAuto');
  assert.equal(strobeAuto.routes[0].readback.expectedValue, true);

  const apuStart = integration.actions['systems.apuStart.start'];
  assert.equal(apuStart.guard.groupId, 'fbwA32nx.systems.apuStart');
  assert.equal(apuStart.guard.cooldownMs, 750);
  assert.equal(apuStart.guard.retry, 'never');
  assert.equal(apuStart.routes[0].transport, 'lvar');
  assert.equal(apuStart.routes[0].lvar, 'L:A32NX_OVHD_APU_START_PB_IS_ON');
  assert.equal(apuStart.routes[0].value, 1);
  assert.equal(apuStart.routes[0].readback.fieldId, 'systems.apuStart');
  assert.equal(apuStart.routes[0].readback.expectedValue, true);

  const autobrakeMedium = integration.actions['systems.autobrake.medium'];
  assert.equal(autobrakeMedium.routes[0].transport, 'lvar');
  assert.equal(autobrakeMedium.routes[0].lvar, 'L:A32NX_AUTOBRAKES_ARMED_MODE_SET');
  assert.equal(autobrakeMedium.routes[0].value, 2);
  assert.equal(autobrakeMedium.routes[0].readback.fieldId, 'systems.autobrakeMode');
  assert.equal(autobrakeMedium.routes[0].readback.expectedValue, 'medium');

  const engineBleed1On = integration.actions['systems.engineBleed1.on'];
  assert.equal(engineBleed1On.routes[0].transport, 'simconnect-sequence');
  assert.deepEqual(engineBleed1On.routes[0].operations, [
    { type: 'event', name: 'ENGINE_BLEED_AIR_SOURCE_TOGGLE', value: 1 },
  ]);
  assert.equal(engineBleed1On.routes[0].readback.fieldId, 'systems.engineBleed1');
  assert.equal(engineBleed1On.routes[0].readback.expectedValue, true);

  const spoilersFull = integration.actions['controls.spoilers.full'];
  assert.deepEqual(spoilersFull.routes[0].operations, [
    { type: 'event', name: 'SPOILERS_SET', value: 16384 },
  ]);
  assert.equal(spoilersFull.routes[0].readback.fieldId, 'controls.spoilersHandle');
  assert.equal(spoilersFull.routes[0].readback.expectedValue, 1);

  for (const excludedAction of [
    'systems.idg1.disconnect',
    'fire.apu.discharge',
    'oxygen.masks.deploy',
    'presets.aircraft.load',
    'pushback.move',
    'lights.landingLeft.on',
  ]) {
    assert.equal(integration.actions[excludedAction], undefined, `${excludedAction} must remain outside the trusted write surface`);
  }

  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FBW_A32NX_ADAPTER_ID, {
    profileKey: 'local/msfs/fbw-a32nx',
  }), null, 'untrusted local profiles must not activate executable FlyByWire routes');
});

test('adapter resolution requires an exact trusted profile and rejects inherited keys', () => {
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FBW_A32NX_ADAPTER_ID, {
    profileKey: 'local/msfs/fbw-a32nx',
  }), null);
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FBW_A32NX_ADAPTER_ID, {
    profileKey: 'bundled/msfs/fbw-a380x',
  }), null);
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    profileKey: FBW_A32NX_PROFILE_KEY,
    actionId: 'lights.beacon.on',
  }), null, 'logical action resolution also requires the declared adapter ID');

  for (const inheritedKey of ['constructor', 'toString', '__proto__']) {
    assert.equal(defaultAircraftIntegrationRegistry.getById(inheritedKey), null);
    assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
      adapterId: FBW_A32NX_ADAPTER_ID,
      profileKey: FBW_A32NX_PROFILE_KEY,
      actionId: inheritedKey,
    }), null);
    assert.equal(defaultAircraftIntegrationRegistry.resolveActionRoute({
      adapterId: FBW_A32NX_ADAPTER_ID,
      profileKey: FBW_A32NX_PROFILE_KEY,
      actionId: 'lights.beacon.on',
      routeId: inheritedKey,
    }), null);
  }
});

test('route selection exposes only opaque identity and provider re-resolution stays exact', () => {
  const registry = createAircraftIntegrationRegistry([{
    id: 'route-test',
    aircraft: { vendor: 'Test', family: 'Route' },
    trustedProfileKeys: ['bundled/msfs/route-test'],
    presentation: { templateId: 'route-test' },
    fields: {
      'test.value': {
        id: 'test.value',
        sources: [{
          route: { type: 'sdk', adapter: 'test-sdk', path: 'test.value' },
          decode: { type: 'number', precision: 0 },
        }],
      },
    },
    actions: {
      'test.set': {
        id: 'test.set',
        guard: { groupId: 'test.set', cooldownMs: 1, retry: 'never' },
        verification: 'untested',
        routes: [{
          id: 'route-test.set.sdk',
          transport: 'sdk',
          adapter: 'test-sdk',
          command: '#1',
          value: 1,
          readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
        }],
      },
    },
  }]);
  const context = {
    adapterId: 'route-test',
    profileKey: 'bundled/msfs/route-test',
    actionId: 'test.set',
  };
  assert.equal(registry.supportsAction(context, ['sdk']), true);
  assert.equal(registry.supportsAction(context, ['mobiflight-calculator']), false);

  const selected = registry.selectActionRoute(context, ['sdk']);
  assert.deepEqual(selected, {
    adapterId: 'route-test',
    actionId: 'test.set',
    routeId: 'route-test.set.sdk',
    transport: 'sdk',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(selected, 'command'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(selected, 'readback'), false);

  const executableRoute = registry.resolveActionRoute({
    ...context,
    routeId: selected.routeId,
  });
  assert.equal(executableRoute.id, selected.routeId);
  assert.equal(executableRoute.command, '#1');
  assert.equal(registry.resolveActionRoute({
    ...context,
    profileKey: 'local/msfs/route-test',
    routeId: selected.routeId,
  }), null);
});

test('registry clones and deeply freezes integration data', () => {
  const input: any = {
    id: 'test-aircraft',
    aircraft: { vendor: 'Test', family: 'One' },
    trustedProfileKeys: ['bundled/msfs/test-aircraft'],
    presentation: { templateId: 'test-aircraft' },
    fields: {
      'test.value': {
        id: 'test.value',
        sources: [{
          route: { type: 'lvar', name: 'L:test', unit: 'Number' },
          decode: { type: 'number', precision: 0 },
        }],
      },
    },
    actions: {
      'test.set': {
        id: 'test.set',
        guard: { groupId: 'test.set', cooldownMs: 1, retry: 'never' },
        verification: 'untested',
        routes: [{
          id: 'test.set.sdk',
          transport: 'sdk',
          adapter: 'test-sdk',
          command: 'set',
          value: 1,
          readback: {
            fieldId: 'test.value',
            expectedValue: 1,
            timeoutMs: 100,
          },
        }],
      },
    },
  };
  const registry = createAircraftIntegrationRegistry([input]);
  input.aircraft.family = 'Mutated';
  input.actions['test.set'].routes[0].command = 'mutated';

  const resolved = registry.resolveForProfile('bundled/msfs/test-aircraft');
  assert.equal(resolved.aircraft.family, 'One');
  assert.equal(resolved.actions['test.set'].routes[0].command, 'set');
  assert.equal(Object.isFrozen(resolved.aircraft), true);
  assert.equal(Object.isFrozen(resolved.actions['test.set'].routes), true);
});

test('registry rejects malformed future adapter sources, guards, and readbacks', () => {
  const validBase: any = {
    id: 'test-aircraft',
    aircraft: { vendor: 'Test', family: 'One' },
    trustedProfileKeys: ['bundled/msfs/test-aircraft'],
    presentation: { templateId: 'test-aircraft' },
    fields: {
      'test.value': {
        id: 'test.value',
        sources: [{
          route: { type: 'lvar', name: 'L:test', unit: 'Number' },
          decode: { type: 'number', precision: 0 },
        }],
      },
    },
    actions: {
      'test.set': {
        id: 'test.set',
        guard: { groupId: 'test.set', cooldownMs: 1, retry: 'never' },
        verification: 'untested',
        routes: [{
          id: 'test.set.mobiflight',
          transport: 'mobiflight-calculator',
          code: '1 (>L:test)',
          readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
        }],
      },
    },
  };

  const emptySources = structuredClone(validBase);
  emptySources.id = 'empty-sources';
  emptySources.trustedProfileKeys = ['bundled/msfs/empty-sources'];
  emptySources.fields['test.value'].sources = [];
  assert.throws(() => createAircraftIntegrationRegistry([emptySources]), /invalid field definition/);

  const retryingAction = structuredClone(validBase);
  retryingAction.id = 'retrying-action';
  retryingAction.trustedProfileKeys = ['bundled/msfs/retrying-action'];
  retryingAction.actions['test.set'].guard.retry = 'always';
  assert.throws(() => createAircraftIntegrationRegistry([retryingAction]), /invalid action definition/);

  for (const unavailableValues of [[], [-999, -999], [-999, Number.NaN], ['-999']]) {
    const invalidSentinelDecoder = structuredClone(validBase);
    invalidSentinelDecoder.id = 'invalid-sentinel';
    invalidSentinelDecoder.trustedProfileKeys = ['bundled/msfs/invalid-sentinel'];
    invalidSentinelDecoder.fields['test.value'].sources[0].decode.unavailableValues = unavailableValues;
    assert.throws(
      () => createAircraftIntegrationRegistry([invalidSentinelDecoder]),
      /invalid source/,
    );
  }

  const unknownReadback = structuredClone(validBase);
  unknownReadback.id = 'unknown-readback';
  unknownReadback.trustedProfileKeys = ['bundled/msfs/unknown-readback'];
  unknownReadback.actions['test.set'].routes[0].readback.fieldId = 'test.missing';
  assert.throws(() => createAircraftIntegrationRegistry([unknownReadback]), /invalid action readback/);

  const unsafeSequence = structuredClone(validBase);
  unsafeSequence.id = 'unsafe-sequence';
  unsafeSequence.trustedProfileKeys = ['bundled/msfs/unsafe-sequence'];
  unsafeSequence.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{ type: 'event', name: 'BAD;EVENT', value: 1 }],
    readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
  }];
  assert.throws(
    () => createAircraftIntegrationRegistry([unsafeSequence]),
    /invalid SimConnect sequence route/,
  );

  const unsafeDirectLvar = structuredClone(validBase);
  unsafeDirectLvar.id = 'unsafe-direct-lvar';
  unsafeDirectLvar.trustedProfileKeys = ['bundled/msfs/unsafe-direct-lvar'];
  unsafeDirectLvar.actions['test.set'].routes = [{
    id: 'test.set.lvar',
    transport: 'lvar',
    lvar: 'L:test;unsafe',
    unit: 'Number',
    value: 1,
    readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
  }];
  assert.throws(
    () => createAircraftIntegrationRegistry([unsafeDirectLvar]),
    /invalid direct LVAR route/,
  );

  const unconfirmedDirectLvar = structuredClone(validBase);
  unconfirmedDirectLvar.id = 'unconfirmed-direct-lvar';
  unconfirmedDirectLvar.trustedProfileKeys = ['bundled/msfs/unconfirmed-direct-lvar'];
  unconfirmedDirectLvar.actions['test.set'].routes = [{
    id: 'test.set.lvar',
    transport: 'lvar',
    lvar: 'L:test',
    unit: 'Number',
    value: 1,
  }];
  assert.throws(
    () => createAircraftIntegrationRegistry([unconfirmedDirectLvar]),
    /write routes require readback/,
  );
});

export {};
