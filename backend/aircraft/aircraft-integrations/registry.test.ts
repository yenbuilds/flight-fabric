const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MOBIFLIGHT_EXECUTION_PREFIX,
  MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH,
  MOBIFLIGHT_MESSAGE_SIZE,
  isSafeMobiFlightCalculatorCode,
} = require('../../utils/mobiflight-protocol.js') as typeof import('../../utils/mobiflight-protocol.js');

const {
  FBW_A32NX_ADAPTER_ID,
  FBW_A32NX_INTEGRATION,
  FBW_A32NX_PROFILE_KEY,
  FBW_A380X_ADAPTER_ID,
  FBW_A380X_INTEGRATION,
  FBW_A380X_PROFILE_KEY,
  FENIX_A32X_ADAPTER_ID,
  FENIX_A32X_INTEGRATION,
  FENIX_A319_PROFILE_KEY,
  FENIX_A320_PROFILE_KEY,
  FENIX_A321_PROFILE_KEY,
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
  INIBUILDS_A350_ADAPTER_ID,
  INIBUILDS_A350_INTEGRATION,
  INIBUILDS_A350_900_PROFILE_KEY,
  INIBUILDS_A350_1000_PROFILE_KEY,
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

test('every bundled MobiFlight calculator route fits the official NUL-terminated command area', () => {
  const codeKeys = ['code', 'pressCode', 'releaseCode', 'decreaseCode', 'increaseCode'] as const;
  const audited: Array<{ adapterId: string; actionId: string; key: string; length: number }> = [];

  for (const integration of defaultAircraftIntegrationRegistry.list()) {
    for (const [actionId, action] of Object.entries(integration.actions) as Array<[string, any]>) {
      for (const route of action.routes) {
        if (route.transport !== 'mobiflight-calculator') continue;
        for (const key of codeKeys) {
          if (route[key] === undefined) continue;
          const code = route[key];
          assert.equal(isSafeMobiFlightCalculatorCode(code), true, `${integration.id}/${actionId}/${key}`);
          assert.ok(
            Buffer.byteLength(`${MOBIFLIGHT_EXECUTION_PREFIX}${code}`, 'ascii') < MOBIFLIGHT_MESSAGE_SIZE,
            `${integration.id}/${actionId}/${key} must leave a NUL byte`,
          );
          audited.push({ adapterId: integration.id, actionId, key, length: code.length });
        }
      }
    }
  }

  assert.ok(audited.length > 0);
  assert.ok(audited.some(({ adapterId }) => adapterId === FBW_A380X_ADAPTER_ID));
  assert.ok(Math.max(...audited.map(({ length }) => length)) <= MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH);
});

test('Microsoft / iniBuilds A320neo V2 and A321LR share a compact exact-profile standard-control adapter', () => {
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
  assert.equal(Object.keys(a320Integration.actions).length, 42);
  assert.deepEqual(a320Integration.fields['fcu.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  const expectedActionIds = [
    ...[
      'apMaster',
      'flightDirector',
      'autothrottleArmed',
      'speedHold',
      'headingHold',
      'altitudeHold',
      'verticalSpeedHold',
      'navHold',
      'approachHold',
    ].flatMap((name) => [`flightGuidance.${name}.off`, `flightGuidance.${name}.on`]),
    'flightGuidance.speed.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitude.set',
    'flightGuidance.verticalSpeed.set',
    ...['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi']
      .flatMap((name) => [`lights.${name}.off`, `lights.${name}.on`]),
    'controls.gear.up',
    'controls.gear.down',
    'controls.flaps.decrease',
    'controls.flaps.increase',
    'controls.parkingBrake.off',
    'controls.parkingBrake.on',
  ].sort();
  assert.deepEqual(Object.keys(a320Integration.actions).sort(), expectedActionIds);
  for (const action of Object.values(a320Integration.actions) as any[]) {
    assert.equal(action.verification, 'untested');
    assert.equal(action.guard.retry, 'never');
    assert.match(action.guard.groupId, /^microsoftIniBuildsA32x\./);
    assert.equal(action.routes.length, 1);
    assert.equal(action.routes[0].transport, 'simconnect-sequence');
    assert.ok(action.routes[0].readback, `${action.id} must require logical readback`);
  }

  assert.deepEqual(a320Integration.actions['flightGuidance.speed.set']?.input, {
    type: 'number', min: 100, max: 399, step: 1,
  });
  assert.deepEqual(a320Integration.actions['flightGuidance.verticalSpeed.set']?.input, {
    type: 'number', min: -6000, max: 6000, step: 100,
  });
  assert.deepEqual(a320Integration.actions['flightGuidance.altitude.set']?.routes[0], {
    id: 'microsoftIniBuildsA32x.flightGuidance.altitude.set.simconnectSequence',
    transport: 'simconnect-sequence',
    operations: [{
      type: 'event',
      name: 'AP_ALT_VAR_SET_ENGLISH',
      inputValue: { source: 'input' },
      parameters: [0],
    }],
    readback: { fieldId: 'fcu.altitudeFt', expectedInput: true, timeoutMs: 3000 },
  });
  assert.equal(a320Integration.actions['lights.landing.on']?.guard.skipIfSatisfied, false);
  assert.deepEqual(a320Integration.actions['controls.flaps.increase']?.routes[0].readback, {
    fieldId: 'controls.flapsIndex', confirmation: 'changed', timeoutMs: 3000,
  });

  for (const excludedAction of [
    'flightGuidance.ap1.on',
    'flightGuidance.ap2.on',
    'flightGuidance.localizer.on',
    'flightGuidance.flightLevelChange.on',
    'flightGuidance.speed.managed',
    'lights.runwayTurnoff.on',
    'controls.spoilersArmed.on',
    'controls.speedbrake.set',
  ]) {
    assert.equal(a320Integration.actions[excludedAction], undefined);
  }
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: MICROSOFT_INIBUILDS_A32X_ADAPTER_ID,
    profileKey: INIBUILDS_A321LR_PROFILE_KEY,
    actionId: 'lights.beacon.on',
  })?.routes[0].operations[0].name, 'BEACON_LIGHTS_SET');
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

test('Microsoft 737 MAX 8 adapter is exact-profile trusted with compact standard controls', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    MICROSOFT_737_MAX_8_ADAPTER_ID,
    { profileKey: MICROSOFT_737_MAX_8_PROFILE_KEY },
  );

  assert.equal(integration.id, MICROSOFT_737_MAX_8_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'microsoft-737-max-8');
  assert.deepEqual(integration.trustedProfileKeys, [MICROSOFT_737_MAX_8_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 44);
  assert.equal(Object.keys(integration.actions).length, 44);
  assert.deepEqual(integration.fields['mcp.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });

  const expectedActionIds = [
    ...[
      'apMaster',
      'flightDirector',
      'autothrottleArmed',
      'speedHold',
      'headingHold',
      'altitudeHold',
      'verticalSpeedHold',
      'navHold',
      'approachHold',
      'flightLevelChange',
    ].flatMap((name) => [`flightGuidance.${name}.off`, `flightGuidance.${name}.on`]),
    'flightGuidance.speed.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitude.set',
    'flightGuidance.verticalSpeed.set',
    ...['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi']
      .flatMap((name) => [`lights.${name}.off`, `lights.${name}.on`]),
    'controls.gear.up',
    'controls.gear.down',
    'controls.flaps.decrease',
    'controls.flaps.increase',
    'controls.parkingBrake.off',
    'controls.parkingBrake.on',
  ].sort();
  assert.deepEqual(Object.keys(integration.actions).sort(), expectedActionIds);

  const confirmationFields = new Set<string>();
  const eventNames = new Set<string>();
  for (const action of Object.values(integration.actions) as any[]) {
    assert.equal(action.verification, 'untested');
    assert.equal(action.guard.retry, 'never');
    assert.match(action.guard.groupId, /^microsoft737Max8\./);
    assert.equal(action.routes.length, 1);
    assert.equal(action.routes[0].transport, 'simconnect-sequence');
    assert.equal(action.routes[0].operations.length, 1);
    assert.equal(action.routes[0].operations[0].type, 'event');
    assert.ok(action.routes[0].readback, `${action.id} must require logical readback`);
    confirmationFields.add(action.routes[0].readback.fieldId);
    eventNames.add(action.routes[0].operations[0].name);
  }
  assert.equal(confirmationFields.size, 24);
  assert.equal(eventNames.size, 34);

  assert.deepEqual(integration.actions['flightGuidance.altitude.set'], {
    id: 'flightGuidance.altitude.set',
    input: { type: 'number', min: 0, max: 49000, step: 100 },
    guard: {
      cooldownMs: 300,
      groupId: 'microsoft737Max8.flightGuidance.altitude',
      retry: 'never',
    },
    routes: [{
      id: 'microsoft737Max8.flightGuidance.altitude.set.simconnectSequence',
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: 'AP_ALT_VAR_SET_ENGLISH',
        inputValue: { source: 'input' },
        parameters: [0],
      }],
      readback: { fieldId: 'mcp.altitudeFt', expectedInput: true, timeoutMs: 3000 },
    }],
    verification: 'untested',
  });
  assert.equal(
    integration.actions['flightGuidance.flightLevelChange.on'].routes[0].operations[0].name,
    'FLIGHT_LEVEL_CHANGE_ON',
  );
  assert.equal(
    integration.actions['flightGuidance.flightLevelChange.on'].routes[0].readback.fieldId,
    'afds.levelChange',
  );
  assert.equal(integration.actions['lights.nav.on'].guard.skipIfSatisfied, false);
  assert.equal(integration.actions['lights.nav.on'].routes[0].operations[0].name, 'NAV_LIGHTS_SET');
  assert.deepEqual(integration.actions['controls.flaps.increase'].routes[0].readback, {
    fieldId: 'controls.flapsIndex', confirmation: 'changed', timeoutMs: 3000,
  });
  for (const excludedAction of [
    'afds.cmdA.on',
    'afds.cmdB.on',
    'afds.vnav.on',
    'flightGuidance.vnav.on',
    'controls.autobrake.set',
    'controls.speedbrake.set',
    'lights.runwayTurnoff.on',
    'systems.engine1.start',
  ]) {
    assert.equal(integration.actions[excludedAction], undefined);
  }
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

test('iniBuilds A330 adapter exposes its bounded standard-SimVar read/write contract only for the exact profile', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    INIBUILDS_A330_ADAPTER_ID,
    { profileKey: INIBUILDS_A330_PROFILE_KEY },
  );

  assert.equal(integration.id, INIBUILDS_A330_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'inibuilds-a330');
  assert.deepEqual(integration.trustedProfileKeys, [INIBUILDS_A330_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 45);
  assert.equal(Object.keys(integration.actions).length, 47);
  assert.deepEqual(integration.fields['flightGuidance.altitudeFt'].sources[0], {
    route: { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });
  assert.deepEqual(integration.fields['controls.parkingBrake'].sources[0], {
    route: { type: 'simvar', name: 'BRAKE PARKING POSITION', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.deepEqual(integration.fields['controls.spoilersArmed'].sources[0], {
    route: { type: 'simvar', name: 'SPOILERS ARMED', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });

  const guidancePairs = [
    ['apMaster', 'flightGuidance.apMaster', 'AUTOPILOT_OFF', 'AUTOPILOT_ON'],
    ['flightDirector', 'flightGuidance.flightDirector', 'TOGGLE_FLIGHT_DIRECTOR', 'TOGGLE_FLIGHT_DIRECTOR'],
    ['autothrottleArmed', 'flightGuidance.autothrottleArmed', 'AUTO_THROTTLE_ARM', 'AUTO_THROTTLE_ARM'],
    ['speedHold', 'flightGuidance.speedHold', 'AP_AIRSPEED_OFF', 'AP_AIRSPEED_ON'],
    ['headingHold', 'flightGuidance.headingHold', 'AP_HDG_HOLD_OFF', 'AP_HDG_HOLD_ON'],
    ['altitudeHold', 'flightGuidance.altitudeHold', 'AP_ALT_HOLD_OFF', 'AP_ALT_HOLD_ON'],
    ['verticalSpeedHold', 'flightGuidance.verticalSpeedHold', 'AP_VS_OFF', 'AP_VS_ON'],
    ['navHold', 'flightGuidance.navHold', 'AP_NAV1_HOLD_OFF', 'AP_NAV1_HOLD_ON'],
    ['approachHold', 'flightGuidance.approachHold', 'AP_APR_HOLD_OFF', 'AP_APR_HOLD_ON'],
    ['flightLevelChange', 'flightGuidance.flightLevelChange', 'FLIGHT_LEVEL_CHANGE_OFF', 'FLIGHT_LEVEL_CHANGE_ON'],
  ] as const;
  for (const [name, fieldId, offEvent, onEvent] of guidancePairs) {
    for (const [suffix, expectedValue, event] of [
      ['off', false, offEvent],
      ['on', true, onEvent],
    ] as const) {
      const actionId = `flightGuidance.${name}.${suffix}`;
      const action = integration.actions[actionId];
      assert.equal(action?.verification, 'untested');
      assert.deepEqual(action?.guard, {
        cooldownMs: 750,
        groupId: `inibuildsA330.flightGuidance.${name}`,
        retry: 'never',
      });
      assert.deepEqual(action?.routes, [{
        id: `inibuildsA330.${actionId}.simconnectSequence`,
        transport: 'simconnect-sequence',
        operations: [{ type: 'event', name: event, value: 0 }],
        readback: { fieldId, expectedValue, timeoutMs: 3000 },
      }]);
    }
  }

  for (const [name, fieldId, event, min, max, step] of [
    ['speed', 'flightGuidance.speedValue', 'AP_SPD_VAR_SET', 100, 399, 1],
    ['heading', 'flightGuidance.headingDeg', 'HEADING_BUG_SET', 0, 359, 1],
    ['altitude', 'flightGuidance.altitudeFt', 'AP_ALT_VAR_SET_ENGLISH', 0, 49000, 100],
    ['verticalSpeed', 'flightGuidance.verticalSpeedFpm', 'AP_VS_VAR_SET_ENGLISH', -6000, 6000, 100],
  ] as const) {
    const actionId = `flightGuidance.${name}.set`;
    const action = integration.actions[actionId];
    assert.deepEqual(action?.input, { type: 'number', min, max, step });
    assert.deepEqual(action?.guard, {
      cooldownMs: 300,
      groupId: `inibuildsA330.flightGuidance.${name}`,
      retry: 'never',
    });
    assert.deepEqual(action?.routes, [{
      id: `inibuildsA330.${actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: event,
        inputValue: { source: 'input' },
        parameters: [0],
      }],
      readback: { fieldId, expectedInput: true, timeoutMs: 3000 },
    }]);
  }

  for (const [lightId, event] of [
    ['strobe', 'STROBES_SET'],
    ['beacon', 'BEACON_LIGHTS_SET'],
    ['nav', 'NAV_LIGHTS_SET'],
    ['logo', 'LOGO_LIGHTS_SET'],
    ['wing', 'WING_LIGHTS_SET'],
    ['landing', 'LANDING_LIGHTS_SET'],
    ['taxi', 'TAXI_LIGHTS_SET'],
  ] as const) {
    for (const [suffix, expectedValue, value] of [
      ['off', false, 0],
      ['on', true, 1],
    ] as const) {
      const actionId = `lights.${lightId}.${suffix}`;
      const action = integration.actions[actionId];
      assert.deepEqual(action?.guard, {
        cooldownMs: 750,
        groupId: `inibuildsA330.lights.${lightId}`,
        retry: 'never',
        skipIfSatisfied: false,
      });
      assert.deepEqual(action?.routes, [{
        id: `inibuildsA330.${actionId}.simconnectSequence`,
        transport: 'simconnect-sequence',
        operations: [{ type: 'event', name: event, value, parameters: [0] }],
        readback: { fieldId: `lights.${lightId}`, expectedValue, timeoutMs: 3000 },
      }]);
    }
  }

  for (const [suffix, expectedValue, event] of [
    ['off', false, 'SPOILERS_ARM_OFF'],
    ['on', true, 'SPOILERS_ARM_ON'],
  ] as const) {
    const actionId = `controls.spoilersArmed.${suffix}`;
    assert.deepEqual(integration.actions[actionId], {
      id: actionId,
      guard: {
        cooldownMs: 750,
        groupId: 'inibuildsA330.controls.spoilersArmed',
        retry: 'never',
      },
      routes: [{
        id: `inibuildsA330.${actionId}.simconnectSequence`,
        transport: 'simconnect-sequence',
        operations: [{ type: 'event', name: event, value: 0 }],
        readback: {
          fieldId: 'controls.spoilersArmed',
          expectedValue,
          timeoutMs: 3000,
        },
      }],
      verification: 'untested',
    });
  }

  assert.deepEqual(integration.actions['controls.flaps.increase'], {
    id: 'controls.flaps.increase',
    guard: {
      cooldownMs: 300,
      groupId: 'inibuildsA330.controls.flaps',
      retry: 'never',
      skipIfSatisfied: false,
    },
    routes: [{
      id: 'inibuildsA330.controls.flaps.increase.simconnectSequence',
      transport: 'simconnect-sequence',
      operations: [{ type: 'event', name: 'FLAPS_INCR', value: 0 }],
      readback: { fieldId: 'controls.flapsIndex', confirmation: 'changed', timeoutMs: 3000 },
    }],
    verification: 'untested',
  });
  assert.deepEqual(integration.actions['controls.speedbrake.set'], {
    id: 'controls.speedbrake.set',
    input: { type: 'number', min: 0, max: 100, step: 1 },
    guard: {
      cooldownMs: 300,
      groupId: 'inibuildsA330.controls.speedbrake',
      retry: 'never',
    },
    routes: [{
      id: 'inibuildsA330.controls.speedbrake.set.simconnectSequence',
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: 'SPOILERS_SET',
        inputValue: { source: 'input', scale: 163.83, round: 'nearest' },
      }],
      readback: { fieldId: 'controls.speedbrakePercent', expectedInput: true, timeoutMs: 3000 },
    }],
    verification: 'untested',
  });

  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: INIBUILDS_A330_ADAPTER_ID,
    profileKey: INIBUILDS_A330_PROFILE_KEY,
    actionId: 'flightGuidance.localizer.on',
  }), null, 'LOC must remain unavailable without an independent readback');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(INIBUILDS_A330_ADAPTER_ID, {
    profileKey: 'local/msfs/inibuilds-a330',
  }), null, 'untrusted local profiles must not activate the trusted A330 adapter');
});

test('iniBuilds A350 adapter shares one guarded LVAR and surface contract across both variants', () => {
  for (const profileKey of [
    INIBUILDS_A350_900_PROFILE_KEY,
    INIBUILDS_A350_1000_PROFILE_KEY,
  ]) {
    const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
      INIBUILDS_A350_ADAPTER_ID,
      { profileKey },
    );
    assert.equal(integration.id, INIBUILDS_A350_INTEGRATION.id);
    assert.equal(integration.presentation.templateId, 'inibuilds-a350');
    assert.deepEqual(integration.trustedProfileKeys, INIBUILDS_A350_INTEGRATION.trustedProfileKeys);
  }

  assert.equal(Object.keys(INIBUILDS_A350_INTEGRATION.fields).length, 52);
  assert.equal(Object.keys(INIBUILDS_A350_INTEGRATION.actions).length, 71);
  assert.deepEqual(INIBUILDS_A350_INTEGRATION.fields['lights.noseMode'].sources[0], {
    route: { type: 'lvar', name: 'L:INI_LIGHTS_NOSE', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'off', 1: 'taxi', 2: 'takeoff' } },
  });
  assert.deepEqual(INIBUILDS_A350_INTEGRATION.fields['controls.gearHandleDown'].sources[0], {
    route: { type: 'simvar', name: 'GEAR HANDLE POSITION', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });

  const altitude = INIBUILDS_A350_INTEGRATION.actions['flightGuidance.altitude.set'];
  assert.deepEqual(altitude.input, { type: 'number', min: 0, max: 49000, step: 100 });
  assert.deepEqual(altitude.routes, [{
    id: 'iniA350.flightGuidance.altitude.set.simconnectSequence',
    transport: 'simconnect-sequence',
    operations: [{
      type: 'lvar',
      name: 'L:INI_ALTITUDE_DIAL',
      unit: 'Number',
      inputValue: { source: 'input' },
    }],
    readback: {
      fieldId: 'flightGuidance.altitudeFt',
      expectedInput: true,
      timeoutMs: 3000,
    },
  }]);

  const noseTaxi = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: INIBUILDS_A350_ADAPTER_ID,
    profileKey: INIBUILDS_A350_900_PROFILE_KEY,
    actionId: 'lights.nose.taxi',
  });
  assert.equal(noseTaxi.guard.groupId, 'iniA350.lights.nose');
  assert.equal(noseTaxi.guard.retry, 'never');
  assert.equal(noseTaxi.routes[0].transport, 'mobiflight-calculator');
  assert.equal(noseTaxi.routes[0].code, '1 (>L:INI_LIGHTS_NOSE, Number)');
  assert.equal(noseTaxi.routes[0].readback.fieldId, 'lights.noseMode');
  assert.equal(noseTaxi.routes[0].readback.expectedValue, 'taxi');
  assert.equal(noseTaxi.routes[1].transport, 'lvar');
  assert.equal(noseTaxi.routes[1].value, 1);

  assert.equal(
    INIBUILDS_A350_INTEGRATION.actions['controls.flaps.increase'].routes[0].readback.confirmation,
    'changed',
  );
  assert.equal(INIBUILDS_A350_INTEGRATION.actions['flightGuidance.ap1'], undefined);
  assert.equal(INIBUILDS_A350_INTEGRATION.actions['flightGuidance.autothrust'], undefined);
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(INIBUILDS_A350_ADAPTER_ID, {
    profileKey: 'local/msfs/inibuilds-a350-900',
  }), null, 'copied profiles must not activate executable A350 routes');
});

test('FlyByWire A380X adapter exposes only its compact guarded read/write contract', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    FBW_A380X_ADAPTER_ID,
    { profileKey: FBW_A380X_PROFILE_KEY },
  );

  assert.equal(integration.id, FBW_A380X_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'fbw-a380x');
  assert.deepEqual(integration.trustedProfileKeys, [FBW_A380X_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 46);
  assert.equal(Object.keys(integration.actions).length, 38);
  assert.deepEqual(integration.fields['flightGuidance.altitudeFt'].sources[0], {
    route: { type: 'lvar', name: 'A:AUTOPILOT ALTITUDE LOCK VAR:3', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  });

  const expectedActionIds = [
    ...['ap1', 'autothrust', 'localizer', 'approach'].flatMap((name) => [
      `flightGuidance.${name}.off`,
      `flightGuidance.${name}.on`,
    ]),
    'flightGuidance.speed.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitude.set',
    'propulsion.throttle.idle',
    'propulsion.throttle.climb',
    'propulsion.throttle.flexMct',
    'propulsion.throttle.toga',
    ...['strobe', 'beacon', 'nav', 'logo', 'wing', 'landing', 'taxi'].flatMap((name) => [
      `lights.${name}.off`,
      `lights.${name}.on`,
    ]),
    'controls.parkingBrake.released',
    'controls.parkingBrake.set',
    'controls.spoilersArmed.off',
    'controls.spoilersArmed.on',
    'controls.spoilers.set',
    'controls.flaps.decrease',
    'controls.flaps.increase',
    'controls.gear.up',
    'controls.gear.down',
  ].sort();
  assert.deepEqual(Object.keys(integration.actions).sort(), expectedActionIds);
  for (const action of Object.values(integration.actions) as any[]) {
    assert.equal(action.verification, 'untested');
    assert.equal(action.guard.retry, 'never');
    assert.match(action.guard.groupId, /^fbwA380x\./);
    assert.equal(action.routes.length, 1);
    if (action.id.startsWith('propulsion.throttle.')) {
      assert.equal(action.routes[0].transport, 'mobiflight-calculator');
      assert.equal(action.routes[0].readbacks.length, 4, `${action.id} must confirm every A380X lever`);
    } else {
      assert.equal(action.routes[0].transport, 'simconnect-sequence');
      assert.ok(action.routes[0].readback, `${action.id} must require logical readback`);
    }
  }

  assert.deepEqual(integration.fields['propulsion.throttleLever4Angle'].sources[0], {
    route: { type: 'lvar', name: 'L:A32NX_AUTOTHRUST_TLA:4', unit: 'Number' },
    decode: { type: 'number', precision: 2 },
  });
  const a380Toga = integration.actions['propulsion.throttle.toga'];
  assert.equal(a380Toga.guard.groupId, 'fbwA380x.propulsion.throttle');
  assert.match(a380Toga.routes[0].code, /A32NX_THROTTLE_MAPPING_TOGA_LOW:1/);
  assert.match(a380Toga.routes[0].code, /THROTTLE4_AXIS_SET_EX1/);
  assert.deepEqual(a380Toga.routes[0].readbacks, [1, 2, 3, 4].map((index) => ({
    fieldId: `propulsion.throttleLever${index}Angle`,
    expectedValue: 45,
    timeoutMs: 3000,
  })));

  assert.deepEqual(integration.actions['flightGuidance.altitude.set'], {
    id: 'flightGuidance.altitude.set',
    input: { type: 'number', min: 0, max: 49000, step: 100 },
    guard: {
      cooldownMs: 300,
      groupId: 'fbwA380x.flightGuidance.altitude',
      retry: 'never',
    },
    routes: [{
      id: 'fbwA380x.flightGuidance.altitude.set.simconnectSequence',
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: 'AP_ALT_VAR_SET_ENGLISH',
        inputValue: { source: 'input' },
        parameters: [3],
      }],
      readback: { fieldId: 'flightGuidance.altitudeFt', expectedInput: true, timeoutMs: 3000 },
    }],
    verification: 'untested',
  });
  for (const actionId of ['flightGuidance.ap1.off', 'flightGuidance.ap1.on']) {
    assert.deepEqual(integration.actions[actionId].routes[0].operations, [{
      type: 'event',
      name: 'A32NX.FCU_AP_1_PUSH',
      value: 0,
    }], `${actionId} must use the vendor-documented A380X AP1 toggle event`);
    assert.equal(
      integration.actions[actionId].routes[0].readback.fieldId,
      'flightGuidance.ap1',
      `${actionId} must remain protected by fresh AP1 logical readback`,
    );
  }
  assert.deepEqual(integration.actions['controls.spoilers.set'].input, {
    type: 'number', min: 0, max: 1, step: 0.25,
  });
  assert.deepEqual(
    integration.actions['controls.spoilers.set'].routes[0].operations[0].inputValue,
    { source: 'input', scale: 16383, round: 'nearest' },
  );
  assert.equal(integration.actions['lights.strobe.on'].guard.skipIfSatisfied, false);
  assert.deepEqual(integration.actions['controls.flaps.increase'].routes[0].readback, {
    fieldId: 'controls.flapsIndex', confirmation: 'changed', timeoutMs: 3000,
  });

  for (const excludedAction of [
    'flightGuidance.ap2.on',
    'flightGuidance.verticalSpeed.set',
    'flightGuidance.speed.managed',
    'flightGuidance.altitude.selected',
    'lights.strobe.auto',
    'lights.runwayTurnoff.on',
    'systems.apuMaster.on',
    'systems.engine1Master.on',
    'propulsion.throttle.reverse',
    'propulsion.throttle.set',
  ]) {
    assert.equal(integration.actions[excludedAction], undefined);
  }
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FBW_A380X_ADAPTER_ID, {
    profileKey: 'local/msfs/fbw-a380x',
  }), null);
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FBW_A380X_ADAPTER_ID, {
    profileKey: FBW_A32NX_PROFILE_KEY,
  }), null);
});

test('iniBuilds TriStar adapter exposes its bounded read/write contract only for the exact profile', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    INIBUILDS_TRISTAR_ADAPTER_ID,
    { profileKey: INIBUILDS_TRISTAR_PROFILE_KEY },
  );

  assert.equal(integration.id, INIBUILDS_TRISTAR_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'inibuilds-tristar');
  assert.deepEqual(integration.trustedProfileKeys, [INIBUILDS_TRISTAR_PROFILE_KEY]);
  assert.equal(Object.keys(integration.fields).length, 41);
  assert.equal(Object.keys(integration.actions).length, 26);
  assert.deepEqual(integration.fields['systems.engine3N1'].sources[0], {
    route: { type: 'simvar', name: 'TURB ENG N1:3', unit: 'Percent' },
    decode: { type: 'number', precision: 1 },
  });
  assert.deepEqual(integration.fields['systems.engine3Epr'].sources[0], {
    route: { type: 'lvar', name: 'A:TURB ENG PRESSURE RATIO:3', unit: 'Ratio' },
    decode: { type: 'number', precision: 2 },
  });
  assert.deepEqual(integration.fields['systems.engine2FuelFlowPph'].sources[0], {
    route: { type: 'lvar', name: 'A:TURB ENG FUEL FLOW PPH:2', unit: 'Pounds per hour' },
    decode: { type: 'number', precision: 0 },
  });
  assert.deepEqual(integration.fields['lights.wing'].sources[0], {
    route: { type: 'simvar', name: 'LIGHT WING', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.deepEqual(integration.fields['systems.engine3Running'].sources[0], {
    route: { type: 'simvar', name: 'ENG COMBUSTION:3', unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  });
  assert.equal(integration.fields['flightGuidance.apMaster'], undefined);
  assert.equal(integration.fields['flightGuidance.headingHold'], undefined);
  assert.equal(integration.fields['flightGuidance.speedValue'], undefined);
  assert.equal(integration.fields['flightGuidance.headingDeg'], undefined);
  assert.equal(integration.fields['flightGuidance.altitudeFt'], undefined);
  assert.equal(integration.fields['flightGuidance.verticalSpeedFpm'], undefined);
  assert.equal(integration.fields['navigation.course1Deg'], undefined);
  assert.equal(integration.fields['navigation.course2Deg'], undefined);
  assert.equal(integration.fields['controls.speedbrakePercent'], undefined);

  const lightActions = [
    ['landing', 'LANDING_LIGHTS_OFF', 'LANDING_LIGHTS_ON'],
    ['taxi', 'TAXI_LIGHTS_OFF', 'TAXI_LIGHTS_ON'],
    ['strobe', 'STROBES_OFF', 'STROBES_ON'],
    ['beacon', 'BEACON_LIGHTS_OFF', 'BEACON_LIGHTS_ON'],
    ['nav', 'NAV_LIGHTS_OFF', 'NAV_LIGHTS_ON'],
    ['wing', 'WING_LIGHTS_OFF', 'WING_LIGHTS_ON'],
    ['logo', 'TOGGLE_LOGO_LIGHTS', 'TOGGLE_LOGO_LIGHTS'],
  ] as const;
  const selectorActions = [
    ['afcs.speed', 'AP_SPD_VAR_DEC', 'AP_SPD_VAR_INC'],
    ['afcs.heading', 'HEADING_BUG_DEC', 'HEADING_BUG_INC'],
    ['afcs.altitude', 'AP_ALT_VAR_DEC', 'AP_ALT_VAR_INC'],
    ['afcs.verticalSpeed', 'AP_VS_VAR_DEC', 'AP_VS_VAR_INC'],
    ['navigation.course1', 'VOR1_OBI_DEC', 'VOR1_OBI_INC'],
    ['navigation.course2', 'VOR2_OBI_DEC', 'VOR2_OBI_INC'],
  ] as const;
  const expectedActionIds: string[] = [];

  for (const [lightId, offEvent, onEvent] of lightActions) {
    for (const [suffix, expectedValue, event] of [
      ['setOff', false, offEvent],
      ['setOn', true, onEvent],
    ] as const) {
      const actionId = `lights.${lightId}.${suffix}`;
      expectedActionIds.push(actionId);
      const action = defaultAircraftIntegrationRegistry.resolveAction({
        adapterId: INIBUILDS_TRISTAR_ADAPTER_ID,
        profileKey: INIBUILDS_TRISTAR_PROFILE_KEY,
        actionId,
      });
      assert.equal(action?.id, actionId);
      assert.equal(action?.verification, 'untested');
      assert.deepEqual(action?.guard, {
        cooldownMs: 750,
        groupId: `inibuildsTristar.lights.${lightId}`,
        retry: 'never',
      });
      assert.deepEqual(action?.routes, [{
        id: `inibuildsTristar.${actionId}.simconnectSequence`,
        transport: 'simconnect-sequence',
        operations: [{ type: 'event', name: event, value: 0 }],
        readback: {
          fieldId: `lights.${lightId}`,
          expectedValue,
          timeoutMs: 3000,
        },
      }]);
    }
  }

  for (const [selectorId, decreaseEvent, increaseEvent] of selectorActions) {
    for (const [suffix, event] of [
      ['decrease', decreaseEvent],
      ['increase', increaseEvent],
    ] as const) {
      const actionId = `${selectorId}.${suffix}`;
      expectedActionIds.push(actionId);
      const action = defaultAircraftIntegrationRegistry.resolveAction({
        adapterId: INIBUILDS_TRISTAR_ADAPTER_ID,
        profileKey: INIBUILDS_TRISTAR_PROFILE_KEY,
        actionId,
      });
      assert.equal(action?.id, actionId);
      assert.equal(action?.verification, 'untested');
      assert.deepEqual(action?.guard, {
        cooldownMs: 300,
        groupId: `inibuildsTristar.${selectorId}`,
        retry: 'never',
        skipIfSatisfied: false,
      });
      assert.deepEqual(action?.routes, [{
        id: `inibuildsTristar.${actionId}.simconnectSequence`,
        transport: 'simconnect-sequence',
        operations: [{ type: 'event', name: event, value: 0 }],
        confirmation: 'transport-acknowledged',
      }]);
    }
  }

  assert.deepEqual(Object.keys(integration.actions).sort(), expectedActionIds.sort());
  assert.equal(JSON.stringify(integration.actions).includes('TOGGLE_WATER_RUDDER'), false,
    'INS is a profile AFCS pulse, not an adapter selector action');
  assert.equal(JSON.stringify(integration.actions).includes('_SET'), false,
    'unsupported direct selector target events must stay absent');
  assert.equal(defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: INIBUILDS_TRISTAR_ADAPTER_ID,
    profileKey: INIBUILDS_TRISTAR_PROFILE_KEY,
    actionId: 'flightGuidance.master.toggle',
  }), null, 'undocumented adapter action IDs stay unavailable');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(INIBUILDS_TRISTAR_ADAPTER_ID, {
    profileKey: 'local/msfs/inibuilds-tristar',
  }), null, 'untrusted local profiles must not activate the trusted TriStar adapter');
  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(INIBUILDS_TRISTAR_ADAPTER_ID, {
    profileKey: INIBUILDS_A330_PROFILE_KEY,
  }), null, 'another bundled iniBuilds profile must not activate the trusted TriStar adapter');
});

test('FlyByWire A32NX adapter exposes broad documented writes behind exact-profile guards and readback', () => {
  const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
    FBW_A32NX_ADAPTER_ID,
    { profileKey: FBW_A32NX_PROFILE_KEY },
  );

  assert.equal(integration, defaultAircraftIntegrationRegistry.resolveForProfile(FBW_A32NX_PROFILE_KEY));
  assert.equal(integration.id, FBW_A32NX_INTEGRATION.id);
  assert.equal(integration.presentation.templateId, 'fbw-a32nx');
  assert.equal(Object.keys(integration.fields).length, 126);
  assert.equal(Object.keys(integration.actions).length, 259);
  for (const [actionId, event, fieldId, input, precondition, inputScale] of [
    ['flightGuidance.speed.set', 'A32NX.FCU_SPD_SET', 'flightGuidance.speedValue', { type: 'number', min: 100, max: 399, step: 1 }, { fieldId: 'flightGuidance.machMode', expectedValue: false }, undefined],
    ['flightGuidance.mach.set', 'A32NX.FCU_SPD_SET', 'flightGuidance.speedValue', { type: 'number', min: 0.4, max: 0.99, step: 0.01 }, { fieldId: 'flightGuidance.machMode', expectedValue: true }, 100],
    ['flightGuidance.heading.set', 'A32NX.FCU_HDG_SET', 'flightGuidance.headingDeg', { type: 'number', min: 0, max: 359, step: 1 }, { fieldId: 'flightGuidance.trkFpaMode', expectedValue: false }, undefined],
    ['flightGuidance.altitude.set', 'A32NX.FCU_ALT_SET', 'flightGuidance.altitudeFt', { type: 'number', min: 100, max: 49_000, step: 100 }, undefined, undefined],
    ['flightGuidance.verticalSpeed.set', 'A32NX.FCU_VS_SET', 'flightGuidance.verticalValue', { type: 'number', min: -6_000, max: 6_000, step: 100 }, { fieldId: 'flightGuidance.trkFpaMode', expectedValue: false }, undefined],
    ['flightGuidance.flightPathAngle.set', 'A32NX.FCU_VS_SET', 'flightGuidance.verticalValue', { type: 'number', min: -9.9, max: 9.9, step: 0.1 }, { fieldId: 'flightGuidance.trkFpaMode', expectedValue: true }, 10],
  ] as const) {
    const action = integration.actions[actionId];
    const route = action.routes[0];
    assert.deepEqual(action.input, input);
    assert.equal(route.transport, 'simconnect-sequence');
    assert.deepEqual(route.operations, [{
      type: 'event',
      name: event,
      inputValue: {
        source: 'input',
        ...(inputScale === undefined ? {} : { scale: inputScale }),
      },
    }]);
    assert.deepEqual(route.precondition, precondition);
    assert.deepEqual(route.readback, {
      fieldId,
      expectedInput: true,
      timeoutMs: 3000,
    });
  }
  for (const [actionId, event, fieldId, expectedValue] of [
    ['flightGuidance.speedManaged.on', 'A32NX.FCU_SPD_PUSH', 'flightGuidance.speedManaged', true],
    ['flightGuidance.speedManaged.off', 'A32NX.FCU_SPD_PULL', 'flightGuidance.speedManaged', false],
    ['flightGuidance.headingManaged.on', 'A32NX.FCU_HDG_PUSH', 'flightGuidance.headingManaged', true],
    ['flightGuidance.headingManaged.off', 'A32NX.FCU_HDG_PULL', 'flightGuidance.headingManaged', false],
    ['flightGuidance.altitudeManaged.on', 'A32NX.FCU_ALT_PUSH', 'flightGuidance.altitudeManaged', true],
    ['flightGuidance.altitudeManaged.off', 'A32NX.FCU_ALT_PULL', 'flightGuidance.altitudeManaged', false],
    ['flightGuidance.ap2.on', 'A32NX.FCU_AP_2_PUSH', 'flightGuidance.ap2', true],
    ['flightGuidance.ap2.off', 'A32NX.FCU_AP_2_PUSH', 'flightGuidance.ap2', false],
  ] as const) {
    const route = integration.actions[actionId].routes[0];
    assert.equal(route.transport, 'simconnect-sequence');
    assert.deepEqual(route.operations, [{ type: 'event', name: event, value: 0 }]);
    assert.deepEqual(route.readback, { fieldId, expectedValue, timeoutMs: 3000 });
  }
  assert.deepEqual(integration.fields['propulsion.throttleLever1Angle'].sources[0], {
    route: { type: 'lvar', name: 'L:A32NX_AUTOTHRUST_TLA:1', unit: 'Number' },
    decode: { type: 'number', precision: 2 },
  });
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
  assert.deepEqual(integration.fields['lights.runwayTurnoff'].sources[0], {
    route: { type: 'lvar', name: 'A:CIRCUIT SWITCH ON:21', unit: 'Bool' },
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

  const runwayTurnoffOn = integration.actions['lights.runwayTurnoff.on'];
  assert.equal(runwayTurnoffOn.guard.groupId, 'fbwA32nx.lights.runwayTurnoff');
  assert.equal(runwayTurnoffOn.guard.skipIfSatisfied, false);
  assert.deepEqual(runwayTurnoffOn.routes[0].operations, [
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:21', unit: 'Bool', value: true },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:22', unit: 'Bool', value: true },
  ]);
  assert.equal(runwayTurnoffOn.routes[0].readback.fieldId, 'lights.runwayTurnoff');
  assert.equal(runwayTurnoffOn.routes[0].readback.expectedValue, true);

  const noseTakeoff = integration.actions['lights.nose.takeoff'];
  assert.equal(noseTakeoff.guard.groupId, 'fbwA32nx.lights.nose');
  assert.equal(noseTakeoff.guard.skipIfSatisfied, false);
  assert.deepEqual(noseTakeoff.routes[0].operations, [
    { type: 'lvar', name: 'L:LIGHTING_LANDING_1', unit: 'Number', value: 0 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:17', unit: 'Bool', value: 1 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:20', unit: 'Bool', value: 1 },
  ]);
  assert.equal(noseTakeoff.routes[0].readback.fieldId, 'lights.noseMode');
  assert.equal(noseTakeoff.routes[0].readback.expectedValue, 'takeoff');

  const landingLeftOn = integration.actions['lights.landingLeft.on'];
  assert.equal(landingLeftOn.guard.groupId, 'fbwA32nx.lights.landingLeft');
  assert.equal(landingLeftOn.guard.skipIfSatisfied, false);
  assert.deepEqual(landingLeftOn.routes[0].operations, [
    { type: 'lvar', name: 'L:LIGHTING_LANDING_2', unit: 'Number', value: 0 },
    { type: 'lvar', name: 'L:LANDING_2_RETRACTED', unit: 'Number', value: 0 },
    { type: 'delay', milliseconds: 9000 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:18', unit: 'Bool', value: 1 },
  ]);
  assert.equal(landingLeftOn.routes[0].readback.fieldId, 'lights.landingLeftCircuitOn');
  assert.equal(landingLeftOn.routes[0].readback.expectedValue, true);

  const landingRightRetract = integration.actions['lights.landingRight.retract'];
  assert.deepEqual(landingRightRetract.routes[0].operations, [
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:19', unit: 'Bool', value: 0 },
    { type: 'lvar', name: 'L:LIGHTING_LANDING_3', unit: 'Number', value: 2 },
    { type: 'lvar', name: 'L:LANDING_3_RETRACTED', unit: 'Number', value: 1 },
  ]);
  assert.equal(landingRightRetract.routes[0].readback.fieldId, 'lights.landingRightRetracted');
  assert.equal(landingRightRetract.routes[0].readback.expectedValue, true);

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

  const a32nxFlex = integration.actions['propulsion.throttle.flexMct'];
  assert.equal(a32nxFlex.guard.groupId, 'fbwA32nx.propulsion.throttle');
  assert.equal(a32nxFlex.routes[0].transport, 'mobiflight-calculator');
  assert.match(a32nxFlex.routes[0].code, /A32NX_THROTTLE_MAPPING_FLEXMCT_LOW:1/);
  assert.match(a32nxFlex.routes[0].code, /A32NX_THROTTLE_MAPPING_FLEXMCT_HIGH:2/);
  assert.match(a32nxFlex.routes[0].code, /THROTTLE1_AXIS_SET_EX1/);
  assert.match(a32nxFlex.routes[0].code, /THROTTLE2_AXIS_SET_EX1/);
  assert.deepEqual(a32nxFlex.routes[0].readbacks, [1, 2].map((index) => ({
    fieldId: `propulsion.throttleLever${index}Angle`,
    expectedValue: 35,
    timeoutMs: 3000,
  })));

  for (const excludedAction of [
    'systems.idg1.disconnect',
    'fire.apu.discharge',
    'oxygen.masks.deploy',
    'presets.aircraft.load',
    'pushback.move',
    'propulsion.throttle.reverse',
    'propulsion.throttle.set',
  ]) {
    assert.equal(integration.actions[excludedAction], undefined, `${excludedAction} must remain outside the trusted write surface`);
  }

  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FBW_A32NX_ADAPTER_ID, {
    profileKey: 'local/msfs/fbw-a32nx',
  }), null, 'untrusted local profiles must not activate executable FlyByWire routes');
});

test('Fenix A32x adapter shares one trusted contract across exact family profiles', () => {
  for (const profileKey of [
    FENIX_A319_PROFILE_KEY,
    FENIX_A320_PROFILE_KEY,
    FENIX_A321_PROFILE_KEY,
  ]) {
    const integration = defaultAircraftIntegrationRegistry.resolveIntegration(
      FENIX_A32X_ADAPTER_ID,
      { profileKey },
    );
    assert.equal(integration.id, FENIX_A32X_INTEGRATION.id);
    assert.deepEqual(integration.trustedProfileKeys, FENIX_A32X_INTEGRATION.trustedProfileKeys);
    assert.equal(integration.presentation.templateId, 'fenix-a32x');
  }

  assert.equal(Object.keys(FENIX_A32X_INTEGRATION.fields).length, 120);
  assert.equal(Object.keys(FENIX_A32X_INTEGRATION.actions).length, 277);
  for (const [fieldId, field] of Object.entries(
    FENIX_A32X_INTEGRATION.fields,
  ) as Array<[string, any]>) {
    assert.equal(field.sources.length, 1, `${fieldId} must expose only its minimum reviewed source`);
    assert.equal(field.sources[0].route.type, 'lvar');
    assert.match(field.sources[0].route.name, /^L:[A-Z0-9_]+$/);
    assert.equal(field.sources[0].route.unit, 'Number');
    assert.deepEqual(
      Object.keys(field.sources[0].route).sort(),
      ['name', 'type', 'unit'],
      `${fieldId} must not carry aircraft-shipped behavior metadata`,
    );
  }
  const fenixFcuActionIds = new Set([
    'flightGuidance.ap1.off',
    'flightGuidance.ap1.on',
    'flightGuidance.ap2.off',
    'flightGuidance.ap2.on',
    'flightGuidance.autothrust.off',
    'flightGuidance.autothrust.on',
    'flightGuidance.localizer.off',
    'flightGuidance.localizer.on',
    'flightGuidance.approach.off',
    'flightGuidance.approach.on',
    'flightGuidance.expedite.off',
    'flightGuidance.expedite.on',
    'flightGuidance.speedManaged.off',
    'flightGuidance.speedManaged.on',
    'flightGuidance.headingManaged.off',
    'flightGuidance.headingManaged.on',
    'flightGuidance.altitudeManaged.off',
    'flightGuidance.altitudeManaged.on',
    'flightGuidance.speed.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitudeHundred.set',
    'flightGuidance.altitudeThousand.set',
  ]);
  const fenixThrottleActionTargets = new Map([
    ['propulsion.throttle.idle', 2],
    ['propulsion.throttle.climb', 3],
    ['propulsion.throttle.flexMct', 4],
    ['propulsion.throttle.toga', 5],
  ]);
  const fenixConfirmationFields = new Set<string>();
  let fenixLegacyActionCount = 0;
  for (const [actionId, action] of Object.entries(
    FENIX_A32X_INTEGRATION.actions,
  ) as Array<[string, any]>) {
    assert.equal(action.guard.retry, 'never', `${actionId} must never retry`);
    assert.equal(action.guard.cooldownMs, 750, `${actionId} must use the family cooldown`);
    assert.match(action.guard.groupId, /^fenixA32x\./, `${actionId} must use a family-owned guard group`);
    for (const route of action.routes) {
      const readbacks = Array.isArray(route.readbacks) ? route.readbacks : [route.readback];
      for (const readback of readbacks) {
        assert.ok(FENIX_A32X_INTEGRATION.fields[readback.fieldId]);
        assert.equal(readback.timeoutMs, 3000);
        fenixConfirmationFields.add(readback.fieldId);
      }
    }
    if (fenixThrottleActionTargets.has(actionId)) {
      const target = fenixThrottleActionTargets.get(actionId);
      assert.equal(action.guard.groupId, 'fenixA32x.propulsion.throttle');
      assert.equal(action.routes.length, 1, `${actionId} must remain one coordinated route`);
      const [route] = action.routes as any[];
      assert.equal(route.transport, 'simconnect-sequence');
      assert.deepEqual(route.operations, [
        { type: 'lvar', name: 'L:A_FC_THROTTLE_LEFT_INPUT', unit: 'Number', value: target },
        { type: 'lvar', name: 'L:A_FC_THROTTLE_RIGHT_INPUT', unit: 'Number', value: target },
      ]);
      assert.deepEqual(route.readbacks, [
        { fieldId: 'propulsion.throttleLever1Position', expectedValue: target, timeoutMs: 3000 },
        { fieldId: 'propulsion.throttleLever2Position', expectedValue: target, timeoutMs: 3000 },
      ]);
      continue;
    }
    if (fenixFcuActionIds.has(actionId)) {
      assert.equal(action.routes.length, 1, `${actionId} must remain calculator-only`);
      assert.equal(action.routes[0].transport, 'mobiflight-calculator');
      continue;
    }
    fenixLegacyActionCount += 1;
    assert.equal(action.routes.length, 2, `${actionId} must expose only the reviewed preferred/fallback pair`);
    const [mobiflightRoute, directLvarRoute] = action.routes as any[];
    assert.equal(mobiflightRoute.transport, 'mobiflight-calculator');
    assert.equal(directLvarRoute.transport, 'lvar');
    assert.match(directLvarRoute.lvar, /^L:[A-Z0-9_]+$/);
    assert.equal(directLvarRoute.unit, 'Number');
    assert.equal(Number.isFinite(directLvarRoute.value), true);
    assert.equal(directLvarRoute.value >= 0 && directLvarRoute.value <= 2, true);
    assert.equal(
      mobiflightRoute.code,
      `${directLvarRoute.value} (>L:${directLvarRoute.lvar.slice(2)}, Number)`,
    );
    assert.deepEqual(mobiflightRoute.readback, directLvarRoute.readback);
  }
  assert.equal(fenixLegacyActionCount, 251);
  assert.equal(fenixFcuActionIds.size, 22);
  assert.equal(fenixThrottleActionTargets.size, 4);
  assert.equal(fenixConfirmationFields.size, 119);
  for (const [fieldId, lvar] of [
    ['propulsion.throttleLever1Position', 'A_FC_THROTTLE_LEFT_INPUT'],
    ['propulsion.throttleLever2Position', 'A_FC_THROTTLE_RIGHT_INPUT'],
  ] as const) {
    assert.deepEqual(FENIX_A32X_INTEGRATION.fields[fieldId].sources[0], {
      route: { type: 'lvar', name: `L:${lvar}`, unit: 'Number' },
      decode: { type: 'number', precision: 2 },
    });
  }
  assert.deepEqual(FENIX_A32X_INTEGRATION.fields['lights.strobeMode'].sources[0], {
    route: { type: 'lvar', name: 'L:S_OH_EXT_LT_STROBE', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'off', 1: 'auto', 2: 'on' } },
  });
  assert.deepEqual(FENIX_A32X_INTEGRATION.fields['flightGuidance.baroUnitCaptain'].sources[0], {
    route: { type: 'lvar', name: 'L:S_FCU_EFIS1_BARO_MODE', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'inhg', 1: 'hpa' } },
  });
  assert.deepEqual(FENIX_A32X_INTEGRATION.fields['flightGuidance.altitudeIncrementMode'].sources[0], {
    route: { type: 'lvar', name: 'L:S_FCU_ALTITUDE_SCALE', unit: 'Number' },
    decode: { type: 'enum', values: { 0: 'thousand', 1: 'hundred' } },
  });
  for (const [fieldId, lvar, precision] of [
    ['flightGuidance.speedValue', 'N_FCU_SPEED', 2],
    ['flightGuidance.headingDeg', 'N_FCU_HEADING', 0],
    ['flightGuidance.altitudeFt', 'N_FCU_ALTITUDE', 0],
    ['flightGuidance.verticalValue', 'N_FCU_VS', 2],
  ] as const) {
    assert.deepEqual(FENIX_A32X_INTEGRATION.fields[fieldId].sources[0], {
      route: { type: 'lvar', name: `L:${lvar}`, unit: 'Number' },
      decode: { type: 'number', precision },
    });
  }
  for (const [fieldId, lvar] of [
    ['flightGuidance.speedManaged', 'I_FCU_SPEED_MANAGED'],
    ['flightGuidance.headingManaged', 'I_FCU_HEADING_MANAGED'],
    ['flightGuidance.altitudeManaged', 'I_FCU_ALTITUDE_MANAGED'],
  ] as const) {
    assert.deepEqual(FENIX_A32X_INTEGRATION.fields[fieldId].sources[0], {
      route: { type: 'lvar', name: `L:${lvar}`, unit: 'Number' },
      decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
    });
  }

  for (const [prefix, fieldId, lvar] of [
    ['flightGuidance.ap1', 'flightGuidance.ap1', 'S_FCU_AP1'],
    ['flightGuidance.ap2', 'flightGuidance.ap2', 'S_FCU_AP2'],
    ['flightGuidance.autothrust', 'flightGuidance.autothrust', 'S_FCU_ATHR'],
    ['flightGuidance.localizer', 'flightGuidance.localizer', 'S_FCU_LOC'],
    ['flightGuidance.approach', 'flightGuidance.approach', 'S_FCU_APPR'],
    ['flightGuidance.expedite', 'flightGuidance.expedite', 'S_FCU_EXPED'],
  ] as const) {
    const code = `(L:${lvar}, Number) ++ (>L:${lvar}, Number)`;
    for (const [suffix, expectedValue] of [['off', false], ['on', true]] as const) {
      const actionId = `${prefix}.${suffix}`;
      const action = FENIX_A32X_INTEGRATION.actions[actionId];
      assert.deepEqual(action.guard, {
        cooldownMs: 750,
        groupId: `fenixA32x.${prefix}`,
        retry: 'never',
      });
      assert.equal(action.verification, 'untested');
      assert.deepEqual(action.routes, [{
        id: `fenixA32x.${actionId}.mobiflightPulse`,
        transport: 'mobiflight-calculator',
        mode: 'pulse',
        pressCode: code,
        releaseCode: code,
        delayMs: 100,
        readback: { fieldId, expectedValue, timeoutMs: 3000 },
      }]);
    }
  }

  for (const [prefix, fieldId, lvar, groupId] of [
    ['flightGuidance.speedManaged', 'flightGuidance.speedManaged', 'S_FCU_SPEED', 'flightGuidance.speed'],
    ['flightGuidance.headingManaged', 'flightGuidance.headingManaged', 'S_FCU_HEADING', 'flightGuidance.heading'],
    ['flightGuidance.altitudeManaged', 'flightGuidance.altitudeManaged', 'S_FCU_ALTITUDE', 'flightGuidance.altitude'],
  ] as const) {
    for (const [suffix, expectedValue, operator] of [
      ['off', false, '++'],
      ['on', true, '--'],
    ] as const) {
      const actionId = `${prefix}.${suffix}`;
      const action = FENIX_A32X_INTEGRATION.actions[actionId];
      assert.equal(action.guard.groupId, `fenixA32x.${groupId}`);
      assert.deepEqual(action.routes, [{
        id: `fenixA32x.${actionId}.mobiflight`,
        transport: 'mobiflight-calculator',
        mode: 'single',
        code: `(L:${lvar}, Number) ${operator} (>L:${lvar}, Number)`,
        readback: { fieldId, expectedValue, timeoutMs: 3000 },
      }]);
    }
  }
  for (const actionId of [
    'flightGuidance.altitudeIncrement.hundred',
    'flightGuidance.altitudeIncrement.thousand',
    'flightGuidance.altitudeManaged.off',
    'flightGuidance.altitudeManaged.on',
    'flightGuidance.altitudeHundred.set',
    'flightGuidance.altitudeThousand.set',
  ]) {
    assert.equal(
      FENIX_A32X_INTEGRATION.actions[actionId].guard.groupId,
      'fenixA32x.flightGuidance.altitude',
      `${actionId} must share the physical altitude-knob lock`,
    );
  }

  for (const [actionId, fieldId, lvar, min, max, step, circular, precondition] of [
    ['flightGuidance.speed.set', 'flightGuidance.speedValue', 'E_FCU_SPEED', 100, 399, 1, false, undefined],
    ['flightGuidance.heading.set', 'flightGuidance.headingDeg', 'E_FCU_HEADING', 0, 359, 1, true, undefined],
    ['flightGuidance.altitudeHundred.set', 'flightGuidance.altitudeFt', 'E_FCU_ALTITUDE', 0, 49000, 100, false, {
      fieldId: 'flightGuidance.altitudeIncrementMode', expectedValue: 'hundred',
    }],
    ['flightGuidance.altitudeThousand.set', 'flightGuidance.altitudeFt', 'E_FCU_ALTITUDE', 0, 49000, 1000, false, {
      fieldId: 'flightGuidance.altitudeIncrementMode', expectedValue: 'thousand',
    }],
  ] as const) {
    const action = FENIX_A32X_INTEGRATION.actions[actionId];
    assert.deepEqual(action.input, { type: 'number', min, max, step });
    const route = action.routes[0] as any;
    assert.equal(route.mode, 'step-to-target');
    assert.equal(route.decreaseCode, `(L:${lvar}, Number) -- (>L:${lvar}, Number)`);
    assert.equal(route.increaseCode, `(L:${lvar}, Number) ++ (>L:${lvar}, Number)`);
    assert.equal(route.maxSteps, 500);
    assert.equal(route.circular, circular ? true : undefined);
    assert.deepEqual(route.precondition, precondition);
    assert.deepEqual(route.readback, { fieldId, expectedInput: true, timeoutMs: 3000 });
  }
  assert.equal(FENIX_A32X_INTEGRATION.actions['flightGuidance.vertical.set'], undefined);
  assert.equal(FENIX_A32X_INTEGRATION.actions['flightGuidance.verticalManaged.on'], undefined);
  assert.equal(fenixConfirmationFields.has('flightGuidance.verticalValue'), false);

  const noseTaxi = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: FENIX_A32X_ADAPTER_ID,
    profileKey: FENIX_A320_PROFILE_KEY,
    actionId: 'lights.nose.taxi',
  });
  assert.equal(noseTaxi.guard.groupId, 'fenixA32x.lights.nose');
  assert.equal(noseTaxi.guard.retry, 'never');
  assert.equal(noseTaxi.routes[0].transport, 'mobiflight-calculator');
  assert.equal(noseTaxi.routes[0].code, '1 (>L:S_OH_EXT_LT_NOSE, Number)');
  assert.equal(noseTaxi.routes[0].readback.fieldId, 'lights.noseMode');
  assert.equal(noseTaxi.routes[0].readback.expectedValue, 'taxi');
  assert.equal(noseTaxi.routes[1].transport, 'lvar');
  assert.equal(noseTaxi.routes[1].lvar, 'L:S_OH_EXT_LT_NOSE');
  assert.equal(noseTaxi.routes[1].value, 1);

  const engineModeStart = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: FENIX_A32X_ADAPTER_ID,
    profileKey: FENIX_A320_PROFILE_KEY,
    actionId: 'systems.engineMode.start',
  });
  assert.equal(engineModeStart.guard.groupId, 'fenixA32x.systems.engineMode');
  assert.equal(engineModeStart.guard.cooldownMs, 750);
  assert.equal(engineModeStart.routes[0].code, '2 (>L:S_ENG_MODE, Number)');
  assert.equal(engineModeStart.routes[0].readback.fieldId, 'systems.engineMode');
  assert.equal(engineModeStart.routes[0].readback.expectedValue, 'start');
  assert.equal(engineModeStart.routes[0].readback.timeoutMs, 3000);

  const overheadHalf = defaultAircraftIntegrationRegistry.resolveAction({
    adapterId: FENIX_A32X_ADAPTER_ID,
    profileKey: FENIX_A320_PROFILE_KEY,
    actionId: 'lighting.overhead.half',
  });
  assert.equal(overheadHalf.routes[0].code, '0.5 (>L:A_OH_LIGHTING_OVD, Number)');
  assert.equal(overheadHalf.routes[1].lvar, 'L:A_OH_LIGHTING_OVD');
  assert.equal(overheadHalf.routes[1].value, 0.5);
  assert.equal(overheadHalf.routes[1].readback.expectedValue, 0.5);

  for (const excludedAction of [
    'fire.apu.discharge',
    'oxygen.crew.off',
    'systems.rat.deploy',
    'systems.ditching.on',
    'systems.flightControlElac1.off',
    'systems.idg1.disconnect',
    'evacuation.command.on',
    'controls.tillerDisconnectCaptain.on',
    'propulsion.throttle.reverse',
    'propulsion.throttle.set',
  ]) {
    assert.equal(
      FENIX_A32X_INTEGRATION.actions[excludedAction],
      undefined,
      `${excludedAction} must remain outside the trusted Fenix write surface`,
    );
  }

  assert.equal(defaultAircraftIntegrationRegistry.resolveIntegration(FENIX_A32X_ADAPTER_ID, {
    profileKey: 'local/msfs/fenix-a320',
  }), null, 'copied profiles must not activate executable Fenix routes');
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

  const multiReadbackCalculator = structuredClone(validBase);
  multiReadbackCalculator.id = 'multi-readback-calculator';
  multiReadbackCalculator.trustedProfileKeys = ['bundled/msfs/multi-readback-calculator'];
  (multiReadbackCalculator.actions['test.set'].routes[0] as any).readbacks = [
    { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
    { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
  ];
  assert.throws(
    () => createAircraftIntegrationRegistry([multiReadbackCalculator]),
    /invalid action route/,
    'coordinated readbacks must use distinct logical fields',
  );

  const overlongCalculator = structuredClone(validBase);
  overlongCalculator.id = 'overlong-calculator';
  overlongCalculator.trustedProfileKeys = ['bundled/msfs/overlong-calculator'];
  overlongCalculator.actions['test.set'].routes[0].code = 'X'.repeat(
    MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH + 1,
  );
  assert.throws(
    () => createAircraftIntegrationRegistry([overlongCalculator]),
    /invalid calculator route/,
  );

  const validPulse = structuredClone(validBase);
  validPulse.id = 'valid-pulse';
  validPulse.trustedProfileKeys = ['bundled/msfs/valid-pulse'];
  validPulse.actions['test.set'].routes = [{
    id: 'test.set.pulse',
    transport: 'mobiflight-calculator',
    mode: 'pulse',
    pressCode: '(L:test) ++ (>L:test)',
    releaseCode: '(L:test) ++ (>L:test)',
    delayMs: 100,
    readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
  }];
  assert.doesNotThrow(() => createAircraftIntegrationRegistry([validPulse]));

  for (const [name, mutate] of [
    ['unknown-mode', (route: any) => { route.mode = 'unknown'; }],
    ['missing-release', (route: any) => { delete route.releaseCode; }],
    ['zero-delay', (route: any) => { route.delayMs = 0; }],
    ['overlong-delay', (route: any) => { route.delayMs = 1001; }],
    ['fractional-delay', (route: any) => { route.delayMs = 1.5; }],
    ['mixed-pulse-code', (route: any) => { route.code = '1 (>L:test)'; }],
  ] as const) {
    const invalid = structuredClone(validPulse);
    invalid.id = name;
    invalid.trustedProfileKeys = [`bundled/msfs/${name}`];
    mutate(invalid.actions['test.set'].routes[0]);
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid calculator route/,
      name,
    );
  }

  const validStepped = structuredClone(validBase);
  validStepped.id = 'valid-stepped';
  validStepped.trustedProfileKeys = ['bundled/msfs/valid-stepped'];
  validStepped.actions['test.set'].input = { type: 'number', min: 0, max: 500, step: 1 };
  validStepped.actions['test.set'].routes = [{
    id: 'test.set.target',
    transport: 'mobiflight-calculator',
    mode: 'step-to-target',
    decreaseCode: '(L:test) -- (>L:test)',
    increaseCode: '(L:test) ++ (>L:test)',
    maxSteps: 500,
    circular: true,
    precondition: { fieldId: 'test.value', expectedValue: 1 },
    readback: { fieldId: 'test.value', expectedInput: true, timeoutMs: 100 },
  }];
  assert.doesNotThrow(() => createAircraftIntegrationRegistry([validStepped]));

  for (const [name, mutate] of [
    ['step-without-input', (_route: any, action: any) => { delete action.input; }],
    ['step-fixed-readback', (route: any) => { route.readback = { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 }; }],
    ['step-zero-max', (route: any) => { route.maxSteps = 0; }],
    ['step-over-max', (route: any) => { route.maxSteps = 501; }],
    ['step-fractional-max', (route: any) => { route.maxSteps = 1.5; }],
    ['step-false-circular', (route: any) => { route.circular = false; }],
    ['step-unsafe-increase', (route: any) => { route.increaseCode = '\n'; }],
    ['step-unsafe-decrease', (route: any) => { route.decreaseCode = '\n'; }],
    ['step-unknown-precondition', (route: any) => { route.precondition.fieldId = 'test.missing'; }],
    ['step-extra-precondition', (route: any) => { route.precondition.extra = true; }],
  ] as const) {
    const invalid = structuredClone(validStepped);
    invalid.id = name;
    invalid.trustedProfileKeys = [`bundled/msfs/${name}`];
    mutate(invalid.actions['test.set'].routes[0], invalid.actions['test.set']);
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid calculator route/,
      name,
    );
  }

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

  const parameterizedSequence = structuredClone(validBase);
  parameterizedSequence.id = 'parameterized-sequence';
  parameterizedSequence.trustedProfileKeys = ['bundled/msfs/parameterized-sequence'];
  parameterizedSequence.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{ type: 'event', name: 'HEADING_BUG_SET', value: 275, parameters: [0] }],
    readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
  }];
  assert.doesNotThrow(
    () => createAircraftIntegrationRegistry([parameterizedSequence]),
    'fixed secondary SimConnect parameters are part of the trusted route',
  );

  const sdkNamedSequence = structuredClone(parameterizedSequence);
  sdkNamedSequence.id = 'sdk-named-sequence';
  sdkNamedSequence.trustedProfileKeys = ['bundled/msfs/sdk-named-sequence'];
  sdkNamedSequence.actions['test.set'].routes[0].operations[0].name = '#84132';
  assert.doesNotThrow(
    () => createAircraftIntegrationRegistry([sdkNamedSequence]),
    'an exact five-digit third-party SDK event may be used by a trusted sequence',
  );
  for (const [id, name] of [
    ['short-sdk-sequence-name', '#8413'],
    ['long-sdk-sequence-name', '#841320'],
    ['unsafe-sdk-sequence-name', '#84A32'],
  ] as const) {
    const invalid = structuredClone(sdkNamedSequence);
    invalid.id = id;
    invalid.trustedProfileKeys = [`bundled/msfs/${id}`];
    invalid.actions['test.set'].routes[0].operations[0].name = name;
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid SimConnect sequence route/,
      id,
    );
  }

  const encodedInputSequence = structuredClone(validBase);
  encodedInputSequence.id = 'encoded-input-sequence';
  encodedInputSequence.trustedProfileKeys = ['bundled/msfs/encoded-input-sequence'];
  encodedInputSequence.actions['test.set'].input = {
    type: 'number', min: 108, max: 117.95, step: 0.05,
  };
  encodedInputSequence.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{
      type: 'event',
      name: 'NAV1_RADIO_SET',
      inputValue: { source: 'input', encoding: 'frequency-bcd16' },
    }],
    readback: { fieldId: 'test.value', expectedInput: true, timeoutMs: 100 },
  }];
  assert.doesNotThrow(
    () => createAircraftIntegrationRegistry([encodedInputSequence]),
    'the exact allowlisted BCD16 frequency encoding is valid for typed SimConnect input',
  );

  const lvarInputSequence = structuredClone(validBase);
  lvarInputSequence.id = 'lvar-input-sequence';
  lvarInputSequence.trustedProfileKeys = ['bundled/msfs/lvar-input-sequence'];
  lvarInputSequence.actions['test.set'].input = {
    type: 'number', min: 0, max: 100, step: 1,
  };
  lvarInputSequence.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{
      type: 'lvar',
      name: 'L:test',
      unit: 'Number',
      inputValue: { source: 'input', scale: 3, round: 'nearest' },
    }],
    readback: { fieldId: 'test.value', expectedInput: true, timeoutMs: 100 },
  }];
  assert.doesNotThrow(
    () => createAircraftIntegrationRegistry([lvarInputSequence]),
    'a trusted LVAR sequence may derive a bounded numeric write from typed input',
  );

  const preconditionedSequence = structuredClone(lvarInputSequence);
  preconditionedSequence.id = 'preconditioned-sequence';
  preconditionedSequence.trustedProfileKeys = ['bundled/msfs/preconditioned-sequence'];
  preconditionedSequence.actions['test.set'].routes[0].precondition = {
    fieldId: 'test.value',
    expectedValue: 0,
  };
  assert.doesNotThrow(
    () => createAircraftIntegrationRegistry([preconditionedSequence]),
    'a trusted SimConnect sequence may require a fixed logical precondition',
  );
  for (const [id, mutate] of [
    ['missing-precondition-field', (precondition: any) => { precondition.fieldId = 'test.missing'; }],
    ['extra-precondition-key', (precondition: any) => { precondition.event = 'unsafe'; }],
  ] as const) {
    const invalid = structuredClone(preconditionedSequence);
    invalid.id = id;
    invalid.trustedProfileKeys = [`bundled/msfs/${id}`];
    mutate(invalid.actions['test.set'].routes[0].precondition);
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid SimConnect sequence route/,
      id,
    );
  }

  for (const [id, mutate] of [
    ['lvar-input-with-fixed-value', (operation: any) => { operation.value = 1; }],
    ['lvar-input-encoding', (operation: any) => { operation.inputValue.encoding = 'frequency-bcd16'; }],
  ] as const) {
    const invalid = structuredClone(lvarInputSequence);
    invalid.id = id;
    invalid.trustedProfileKeys = [`bundled/msfs/${id}`];
    mutate(invalid.actions['test.set'].routes[0].operations[0]);
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid SimConnect sequence route/,
      id,
    );
  }

  for (const [id, mutate] of [
    ['unknown-input-encoding', (inputValue: any) => { inputValue.encoding = 'unknown'; }],
    ['mixed-input-encoding', (inputValue: any) => { inputValue.scale = 100; }],
  ] as const) {
    const invalid = structuredClone(encodedInputSequence);
    invalid.id = id;
    invalid.trustedProfileKeys = [`bundled/msfs/${id}`];
    mutate(invalid.actions['test.set'].routes[0].operations[0].inputValue);
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid SimConnect sequence route/,
      id,
    );
  }

  const multiReadbackSequence = structuredClone(validBase);
  multiReadbackSequence.id = 'multi-readback-sequence';
  multiReadbackSequence.trustedProfileKeys = ['bundled/msfs/multi-readback-sequence'];
  (multiReadbackSequence.fields as any)['test.second'] = {
    id: 'test.second',
    sources: [{
      route: { type: 'lvar', name: 'L:test_second', unit: 'Number' },
      decode: { type: 'number', precision: 0 },
    }],
  };
  multiReadbackSequence.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{ type: 'lvar', name: 'L:test', unit: 'Number', value: 1 }],
    readbacks: [
      { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
      { fieldId: 'test.second', expectedValue: 1, timeoutMs: 100 },
    ],
  }];
  assert.doesNotThrow(
    () => createAircraftIntegrationRegistry([multiReadbackSequence]),
    'a coordinated sequence may require multiple independent readbacks',
  );

  for (const [id, mutate] of [
    ['one-multi-readback', (route: any) => { route.readbacks.pop(); }],
    ['duplicate-multi-readback', (route: any) => { route.readbacks[1].fieldId = 'test.value'; }],
    ['mixed-single-and-multi-readback', (route: any) => {
      route.readback = { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 };
    }],
  ] as const) {
    const invalid = structuredClone(multiReadbackSequence);
    invalid.id = id;
    invalid.trustedProfileKeys = [`bundled/msfs/${id}`];
    mutate(invalid.actions['test.set'].routes[0]);
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid SimConnect sequence route/,
      id,
    );
  }

  for (const [id, parameters] of [
    ['too-many-sequence-parameters', [0, 1, 2, 3, 4]],
    ['non-numeric-sequence-parameter', [0, '1']],
    ['non-finite-sequence-parameter', [Number.NaN]],
  ] as const) {
    const invalid = structuredClone(parameterizedSequence);
    invalid.id = id;
    invalid.trustedProfileKeys = [`bundled/msfs/${id}`];
    invalid.actions['test.set'].routes[0].operations[0].parameters = parameters;
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid SimConnect sequence route/,
      id,
    );
  }

  const overlongSequenceDelay = structuredClone(validBase);
  overlongSequenceDelay.id = 'overlong-sequence-delay';
  overlongSequenceDelay.trustedProfileKeys = ['bundled/msfs/overlong-sequence-delay'];
  overlongSequenceDelay.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{ type: 'delay', milliseconds: 10001 }],
    readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
  }];
  assert.throws(
    () => createAircraftIntegrationRegistry([overlongSequenceDelay]),
    /invalid SimConnect sequence route/,
  );

  const unsafeSequenceSimvar = structuredClone(validBase);
  unsafeSequenceSimvar.id = 'unsafe-sequence-simvar';
  unsafeSequenceSimvar.trustedProfileKeys = ['bundled/msfs/unsafe-sequence-simvar'];
  unsafeSequenceSimvar.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{ type: 'simvar', name: 'CIRCUIT SWITCH ON:18;BAD', unit: 'Bool', value: 1 }],
    readback: { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 },
  }];
  assert.throws(
    () => createAircraftIntegrationRegistry([unsafeSequenceSimvar]),
    /invalid SimConnect sequence route/,
  );

  const acknowledgedSequence = structuredClone(validBase);
  acknowledgedSequence.id = 'acknowledged-sequence';
  acknowledgedSequence.trustedProfileKeys = ['bundled/msfs/acknowledged-sequence'];
  acknowledgedSequence.actions['test.set'].routes = [{
    id: 'test.set.sequence',
    transport: 'simconnect-sequence',
    operations: [{ type: 'event', name: 'HEADING_BUG_INC', value: 0 }],
    confirmation: 'transport-acknowledged',
  }];
  assert.doesNotThrow(
    () => createAircraftIntegrationRegistry([acknowledgedSequence]),
    'fixed documentation-backed pulses may complete on transport acknowledgement',
  );

  for (const [id, mutate] of [
    ['unknown-sequence-confirmation', (route: any) => { route.confirmation = 'unknown'; }],
    ['ambiguous-sequence-confirmation', (route: any) => {
      route.readback = { fieldId: 'test.value', expectedValue: 1, timeoutMs: 100 };
    }],
  ] as const) {
    const invalid = structuredClone(acknowledgedSequence);
    invalid.id = id;
    invalid.trustedProfileKeys = [`bundled/msfs/${id}`];
    mutate(invalid.actions['test.set'].routes[0]);
    assert.throws(
      () => createAircraftIntegrationRegistry([invalid]),
      /invalid SimConnect sequence route/,
      id,
    );
  }

  const unconfirmedSequence = structuredClone(acknowledgedSequence);
  unconfirmedSequence.id = 'unconfirmed-sequence';
  unconfirmedSequence.trustedProfileKeys = ['bundled/msfs/unconfirmed-sequence'];
  delete unconfirmedSequence.actions['test.set'].routes[0].confirmation;
  assert.throws(
    () => createAircraftIntegrationRegistry([unconfirmedSequence]),
    /write routes require readback/,
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
