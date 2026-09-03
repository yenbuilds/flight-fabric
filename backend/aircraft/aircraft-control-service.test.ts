const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAircraftControlCapabilities,
  executeAircraftCommand,
  executeAircraftControl,
  resolveAircraftCommand,
  resolveAircraftControl,
} = require('./aircraft-control-service');
const {
  finalizeLoadedProfile,
  normalizeProfileDocument,
} = require('./aircraft-profile-model');
const genericProfileDocument = require('./profiles/bundled/msfs/generic.json');
const tristarProfileDocument = require('./profiles/bundled/msfs/inibuilds-tristar.json');
function buildProfile(overrides = {}) {
  return {
    id: 'generic',
    simulator: 'msfs',
    namespace: 'bundled',
    _profileKey: 'bundled/msfs/generic',
    integration: {},
    ...overrides,
  };
}

function buildLoadedProfile(rawProfile = {}) {
  return finalizeLoadedProfile(normalizeProfileDocument(rawProfile));
}

function buildBroadGenericControlProfile(overrides = {}) {
  return buildProfile({
    integration: {
      controls: {
        genericFallback: true,
      },
    },
    ...overrides,
  });
}

function buildTriStarProfile() {
  return buildProfile({
    ...tristarProfileDocument,
    _profileKey: 'bundled/msfs/inibuilds-tristar',
  });
}

function buildPmdg737Profile() {
  return buildProfile({
    id: 'pmdg-737',
    _profileKey: 'bundled/msfs/pmdg-737',
    integration: {
      aircraftSpecific: { adapter: 'pmdg-737' },
      controls: { genericFallback: false },
    },
  });
}

function buildFenixA32xProfile(variant: 'a319' | 'a320' | 'a321' = 'a320') {
  return buildProfile({
    id: `fenix-${variant}`,
    _profileKey: `bundled/msfs/fenix-${variant}`,
    integration: {
      aircraftSpecific: { adapter: 'fenix-a32x' },
      controls: { genericFallback: false },
    },
  });
}

function buildFbwA32nxProfile() {
  return buildProfile({
    id: 'fbw-a32nx',
    _profileKey: 'bundled/msfs/fbw-a32nx',
    integration: {
      aircraftSpecific: { adapter: 'fbw-a32nx' },
      controls: { genericFallback: false, standardSurfaceFallback: true },
    },
  });
}

function buildIniBuildsA350Profile(variant: '900' | '1000' = '900') {
  return buildProfile({
    id: `inibuilds-a350-${variant}`,
    _profileKey: `bundled/msfs/inibuilds-a350-${variant}`,
    integration: {
      aircraftSpecific: { adapter: 'inibuilds-a350' },
      controls: { genericFallback: false, standardSurfaceFallback: true },
    },
  });
}

function buildPmdg777Profile(
  variant: 'pmdg-777' | 'pmdg-777-200er' | 'pmdg-777-200lr' | 'pmdg-777f' = 'pmdg-777',
) {
  return buildProfile({
    id: variant,
    _profileKey: `bundled/msfs/${variant}`,
    integration: {
      aircraftSpecific: { adapter: 'pmdg-777' },
      controls: { genericFallback: false },
    },
  });
}

test('aircraft command catalogue treats generic fallback as a first-class configuration', () => {
  const capabilities = buildAircraftControlCapabilities(buildBroadGenericControlProfile(), {
    profileRevision: 4,
  });
  assert.equal(capabilities.aircraftCommands.configurationId, 'generic');
  assert.equal(capabilities.aircraftCommands.profileKey, 'bundled/msfs/generic');
  assert.equal(capabilities.aircraftCommands.profileRevision, 4);
  assert.equal(capabilities.aircraftIntegration.id, 'generic');
  assert.equal(capabilities.aircraftIntegration.family, 'Generic aircraft');
  assert.equal(capabilities.aircraftIntegration.fields.length, 24);
  assert.deepEqual(capabilities.aircraftIntegration.fields.slice(0, 4), [
    { id: 'surfaces.gear' },
    { id: 'surfaces.flaps' },
    { id: 'surfaces.parkingBrake' },
    { id: 'surfaces.spoilers' },
  ]);
  assert.equal(
    capabilities.aircraftIntegration.fields.some(({ id }) => id === 'flightGuidance.selectedHeading'),
    true,
  );
  assert.deepEqual(capabilities.aircraftIntegration.actions, []);
  const commands = new Map<string, any>(
    capabilities.aircraftCommands.commands.map((command) => [command.id, command]),
  );
  assert.deepEqual(commands.get('flightGuidance.heading.set').input, {
    kind: 'number', min: 0, max: 359, step: 1, units: 'degrees',
  });
  assert.equal(commands.has('surfaces.gear.set'), true);
  assert.equal(commands.has('surfaces.flaps.adjust'), true);
  const inventory = new Map<string, any>(
    capabilities.aircraftCommands.inventory.map((command) => [command.id, command]),
  );
  assert.equal(inventory.get('flightGuidance.heading.set').supported, true);
  assert.equal(
    inventory.get('flightGuidance.ins.toggle').supported,
    false,
    'configured but unavailable generic settings should remain in the integration inventory',
  );
  assert.deepEqual(commands.get('configuration.lights.takeoff'), {
    id: 'configuration.lights.takeoff',
    label: 'Takeoff lights',
    group: 'presets',
    kind: 'preset',
    input: { kind: 'none' },
    description: 'Landing ON · Taxi ON · Strobe ON',
    speech: {
      patterns: [
        'set lights for takeoff', 'set lights for take off',
        'set lights for a takeoff', 'set lights for a take off',
        'set takeoff lights', 'set take off lights',
        'takeoff lights', 'take off lights',
      ],
      hints: ['TAKEOFF LIGHTS', 'LIGHTS FOR TAKEOFF'],
    },
  });
});

test('PMDG 737 command configuration maps a canonical heading command to the trusted family action', () => {
  const result = resolveAircraftCommand({
    commandId: 'flightGuidance.heading.set',
    input: { value: 271 },
    profileKey: 'bundled/msfs/pmdg-737',
    profileRevision: 9,
  }, {
    profile: buildPmdg737Profile(),
    profileRevision: 9,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['sdk'],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.configurationId, 'pmdg-737');
  assert.equal(result.commandId, 'flightGuidance.heading.set');
  assert.equal(result.controlRequest.actionId, 'mcp.heading.set');
  assert.equal(result.controlRequest.value, 271);
  assert.deepEqual(result.action, {
    type: 'aircraft-integration',
    name: 'pmdg-737',
    verification: 'untested',
  });
});

test('FlyByWire A32NX catalogue exposes guarded FCU custom-event commands with native sequence support', () => {
  const capabilities = buildAircraftControlCapabilities(buildFbwA32nxProfile(), {
    profileRevision: 15,
    capabilities: {
      actionTypes: ['aircraft-integration', 'key-event'],
      integrationTransports: ['lvar', 'mobiflight-calculator', 'simconnect-sequence'],
    },
  });
  const commandIds = capabilities.aircraftCommands.commands.map((command) => command.id);
  assert.deepEqual(commandIds.slice(0, 17), [
    'flightGuidance.speed.set',
    'flightGuidance.mach.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitude.set',
    'flightGuidance.verticalSpeed.set',
    'flightGuidance.flightPathAngle.set',
    'flightGuidance.autopilot1.set',
    'flightGuidance.autopilot2.set',
    'flightGuidance.flightDirectorCaptain.set',
    'flightGuidance.autothrust.set',
    'flightGuidance.localizer.set',
    'flightGuidance.approach.set',
    'flightGuidance.expedite.set',
    'flightGuidance.speedMode.set',
    'flightGuidance.headingMode.set',
    'flightGuidance.altitudeMode.set',
    'propulsion.throttleDetent.set',
  ]);
  assert.equal(commandIds.length, 26);

  const options = {
    profile: buildFbwA32nxProfile(),
    profileRevision: 15,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration', 'key-event'],
      integrationTransports: ['lvar', 'mobiflight-calculator', 'simconnect-sequence'],
    },
  };
  for (const [commandId, value, actionId] of [
    ['flightGuidance.speed.set', 250, 'flightGuidance.speed.set'],
    ['flightGuidance.mach.set', 0.78, 'flightGuidance.mach.set'],
    ['flightGuidance.heading.set', 271, 'flightGuidance.heading.set'],
    ['flightGuidance.altitude.set', 12_000, 'flightGuidance.altitude.set'],
    ['flightGuidance.verticalSpeed.set', -1_200, 'flightGuidance.verticalSpeed.set'],
    ['flightGuidance.flightPathAngle.set', -2.5, 'flightGuidance.flightPathAngle.set'],
    ['flightGuidance.autopilot2.set', true, 'flightGuidance.ap2.on'],
    ['flightGuidance.speedMode.set', 'managed', 'flightGuidance.speedManaged.on'],
    ['flightGuidance.headingMode.set', 'selected', 'flightGuidance.headingManaged.off'],
    ['flightGuidance.altitudeMode.set', 'managed', 'flightGuidance.altitudeManaged.on'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: { value },
      profileKey: 'bundled/msfs/fbw-a32nx',
      profileRevision: 15,
    }, options);
    assert.equal(result.ok, true, `${commandId} should resolve with the native event bridge ready`);
    assert.equal(result.controlRequest.actionId, actionId);
    if (typeof value === 'number') assert.equal(result.controlRequest.value, value);
  }
});

test('FlyByWire A32NX voice intents map to guarded adapter and narrow surface routes', () => {
  const options = {
    profile: buildFbwA32nxProfile(),
    profileRevision: 15,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration', 'key-event'],
      integrationTransports: ['lvar', 'mobiflight-calculator', 'simconnect-sequence'],
    },
  };
  for (const [commandId, value, actionId] of [
    ['flightGuidance.autopilot1.set', true, 'flightGuidance.ap1.on'],
    ['flightGuidance.flightDirectorCaptain.set', false, 'flightGuidance.flightDirectorCaptain.off'],
    ['flightGuidance.autothrust.set', true, 'flightGuidance.autothrust.on'],
    ['flightGuidance.localizer.set', false, 'flightGuidance.localizer.off'],
    ['flightGuidance.approach.set', true, 'flightGuidance.approach.on'],
    ['flightGuidance.expedite.set', false, 'flightGuidance.expedite.off'],
    ['propulsion.throttleDetent.set', 'flex', 'propulsion.throttle.flexMct'],
    ['surfaces.parkingBrake.set', true, 'systems.parkingBrake.set'],
    ['surfaces.spoilersArmed.set', false, 'controls.spoilersArmed.off'],
    ['lights.beacon.set', true, 'lights.beacon.on'],
    ['lights.strobeMode.set', 'auto', 'lights.strobe.auto'],
    ['lights.nav.set', false, 'lights.nav.off'],
    ['lights.noseMode.set', 'taxi', 'lights.nose.taxi'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: { value },
      profileKey: 'bundled/msfs/fbw-a32nx',
      profileRevision: 15,
    }, options);
    assert.equal(result.ok, true, `${commandId} should resolve`);
    assert.equal(result.configurationId, 'fbw-a32nx');
    assert.equal(result.controlRequests.length, 1);
    assert.equal(result.controlRequest.actionId, actionId);
  }

  for (const [commandId, value, eventName] of [
    ['surfaces.gear.set', 'down', 'GEAR_DOWN'],
    ['surfaces.flaps.adjust', 'increase', 'FLAPS_INCR'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: { value },
      profileKey: 'bundled/msfs/fbw-a32nx',
      profileRevision: 15,
    }, options);
    assert.equal(result.ok, true, `${commandId} should resolve`);
    assert.equal(result.configurationId, 'fbw-a32nx');
    assert.equal(result.resolvedBy, 'generic');
    assert.equal(result.action.name, eventName);
  }
});

test('FlyByWire A32NX takeoff-light voice preset remains an ordered guarded recipe', () => {
  const result = resolveAircraftCommand({
    commandId: 'configuration.lights.takeoff',
    input: {},
    profileKey: 'bundled/msfs/fbw-a32nx',
    profileRevision: 15,
  }, {
    profile: buildFbwA32nxProfile(),
    profileRevision: 15,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stepCount, 6);
  assert.deepEqual(result.controlRequests.map((request) => request.actionId), [
    'lights.landingLeft.on',
    'lights.landingRight.on',
    'lights.runwayTurnoff.on',
    'lights.nose.takeoff',
    'lights.strobe.on',
    'lights.nav.on',
  ]);
});

test('Fenix A32X catalogue exposes one reviewed UI and voice command slice across all three variants', () => {
  const supportedCommandIds = [
    'flightGuidance.speed.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitudeHundred.set',
    'flightGuidance.altitudeThousand.set',
    'flightGuidance.autopilot1.set',
    'flightGuidance.autopilot2.set',
    'flightGuidance.autothrust.set',
    'flightGuidance.localizer.set',
    'flightGuidance.approach.set',
    'flightGuidance.expedite.set',
    'flightGuidance.speedMode.set',
    'flightGuidance.headingMode.set',
    'flightGuidance.altitudeMode.set',
    'propulsion.throttleDetent.set',
    'surfaces.parkingBrake.set',
    'lights.beacon.set',
    'lights.strobeMode.set',
    'lights.navLogoMode.set',
    'lights.noseMode.set',
    'configuration.lights.takeoff',
  ];

  for (const variant of ['a319', 'a320', 'a321'] as const) {
    const capabilities = buildAircraftControlCapabilities(buildFenixA32xProfile(variant), {
      profileRevision: 12,
      capabilities: {
        actionTypes: ['aircraft-integration'],
        integrationTransports: ['lvar', 'mobiflight-calculator', 'simconnect-sequence'],
      },
    });
    assert.equal(capabilities.aircraftCommands.configurationId, 'fenix-a32x');
    assert.equal(capabilities.aircraftCommands.profileKey, `bundled/msfs/fenix-${variant}`);
    assert.deepEqual(
      capabilities.aircraftCommands.commands.map((command) => command.id),
      supportedCommandIds,
    );
    assert.equal(
      capabilities.aircraftCommands.commands.every((command) => command.speech?.patterns?.length > 0),
      true,
      'every reviewed Fenix command must be reachable from the active voice catalogue',
    );
    const commands = new Map<string, any>(
      capabilities.aircraftCommands.commands.map((command) => [command.id, command]),
    );
    assert.deepEqual(commands.get('flightGuidance.altitudeHundred.set').speech.patterns, [
      'set altitude {value} in hundreds',
      'altitude {value} in hundreds',
      'set flight level {value} in hundreds',
      'flight level {value} in hundreds',
    ]);
    assert.deepEqual(commands.get('propulsion.throttleDetent.set').input.values, [
      'idle', 'climb', 'flex', 'toga',
    ]);
  }
});

test('Fenix A32X commands map canonical intent only to guarded adapter actions', () => {
  const profile = buildFenixA32xProfile();
  const options = {
    profile,
    profileRevision: 12,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['lvar', 'mobiflight-calculator', 'simconnect-sequence'],
    },
  };
  for (const [commandId, value, actionId] of [
    ['flightGuidance.autopilot1.set', true, 'flightGuidance.ap1.on'],
    ['flightGuidance.autopilot2.set', false, 'flightGuidance.ap2.off'],
    ['flightGuidance.autothrust.set', true, 'flightGuidance.autothrust.on'],
    ['flightGuidance.localizer.set', false, 'flightGuidance.localizer.off'],
    ['flightGuidance.approach.set', true, 'flightGuidance.approach.on'],
    ['flightGuidance.expedite.set', false, 'flightGuidance.expedite.off'],
    ['flightGuidance.speedMode.set', 'selected', 'flightGuidance.speedManaged.off'],
    ['flightGuidance.headingMode.set', 'managed', 'flightGuidance.headingManaged.on'],
    ['flightGuidance.altitudeMode.set', 'selected', 'flightGuidance.altitudeManaged.off'],
    ['propulsion.throttleDetent.set', 'flex', 'propulsion.throttle.flexMct'],
    ['surfaces.parkingBrake.set', true, 'systems.parkingBrake.set'],
    ['lights.strobeMode.set', 'auto', 'lights.strobe.auto'],
    ['lights.navLogoMode.set', 'logo', 'lights.navLogo.logo'],
    ['lights.noseMode.set', 'taxi', 'lights.nose.taxi'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: { value },
      profileKey: 'bundled/msfs/fenix-a320',
      profileRevision: 12,
    }, options);
    assert.equal(result.ok, true, `${commandId} should resolve`);
    assert.equal(result.configurationId, 'fenix-a32x');
    assert.equal(result.controlRequests.length, 1);
    assert.equal(result.controlRequest.actionId, actionId);
  }
});

test('Fenix A32X altitude voice commands preserve the explicit live FCU increment contract', () => {
  const options = {
    profile: buildFenixA32xProfile(),
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['mobiflight-calculator'],
    },
  };
  for (const [commandId, value, actionId] of [
    ['flightGuidance.altitudeHundred.set', 12500, 'flightGuidance.altitudeHundred.set'],
    ['flightGuidance.altitudeThousand.set', 12000, 'flightGuidance.altitudeThousand.set'],
  ] as const) {
    const result = resolveAircraftCommand({ commandId, input: { value } }, options);
    assert.equal(result.ok, true);
    assert.equal(result.controlRequest.actionId, actionId);
    assert.equal(result.controlRequest.value, value);
  }

  for (const [commandId, value] of [
    ['flightGuidance.altitudeHundred.set', 12550],
    ['flightGuidance.altitudeThousand.set', 12500],
  ] as const) {
    const result = resolveAircraftCommand({ commandId, input: { value } }, options);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_command_input');
  }
});

test('Fenix A32X takeoff-light voice preset remains an ordered guarded recipe', () => {
  const result = resolveAircraftCommand({
    commandId: 'configuration.lights.takeoff',
    input: {},
    profileKey: 'bundled/msfs/fenix-a320',
    profileRevision: 12,
  }, {
    profile: buildFenixA32xProfile(),
    profileRevision: 12,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['lvar'],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.controlRequests.map((request) => request.actionId), [
    'lights.landingLeft.on',
    'lights.landingRight.on',
    'lights.runwayTurnoff.on',
    'lights.nose.takeoff',
    'lights.strobe.on',
    'lights.navLogo.nav',
  ]);
});

test('iniBuilds A350 catalogue exposes the shared page controls to voice across both variants', () => {
  const expectedCommandIds = [
    'flightGuidance.speed.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitude.set',
    'flightGuidance.verticalSpeed.set',
    'surfaces.gear.set',
    'surfaces.flaps.adjust',
    'surfaces.parkingBrake.set',
    'surfaces.spoilersArmed.set',
    'surfaces.spoilers.set',
    'lights.strobeMode.set',
    'lights.nav.set',
    'lights.beacon.set',
    'lights.landing.set',
    'lights.noseMode.set',
    'configuration.lights.takeoff',
  ];

  for (const variant of ['900', '1000'] as const) {
    const capabilities = buildAircraftControlCapabilities(buildIniBuildsA350Profile(variant), {
      profileRevision: 16,
      capabilities: {
        actionTypes: ['aircraft-integration'],
        integrationTransports: ['simconnect-sequence', 'lvar'],
      },
    });
    assert.equal(capabilities.aircraftCommands.configurationId, 'inibuilds-a350');
    assert.equal(capabilities.aircraftCommands.profileKey, `bundled/msfs/inibuilds-a350-${variant}`);
    assert.deepEqual(
      capabilities.aircraftCommands.commands.map((command) => command.id),
      expectedCommandIds,
    );
    assert.equal(
      capabilities.aircraftCommands.commands.every((command) => command.speech?.patterns?.length > 0),
      true,
      'every A350 command in the active catalogue must be reachable by voice',
    );
    assert.equal(capabilities.aircraftIntegration.vendor, 'iniBuilds');
    assert.equal(capabilities.aircraftIntegration.family, 'A350');
  }
});

test('iniBuilds A350 commands map canonical voice intent only to guarded adapter actions', () => {
  const options = {
    profile: buildIniBuildsA350Profile(),
    profileRevision: 16,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence', 'lvar'],
    },
  };
  for (const [commandId, value, actionId] of [
    ['flightGuidance.speed.set', 245, 'flightGuidance.speed.set'],
    ['flightGuidance.heading.set', 273, 'flightGuidance.heading.set'],
    ['flightGuidance.altitude.set', 35000, 'flightGuidance.altitude.set'],
    ['flightGuidance.verticalSpeed.set', -1200, 'flightGuidance.verticalSpeed.set'],
    ['surfaces.gear.set', 'down', 'controls.gear.down'],
    ['surfaces.flaps.adjust', 'increase', 'controls.flaps.increase'],
    ['surfaces.parkingBrake.set', true, 'controls.parkingBrake.on'],
    ['surfaces.spoilersArmed.set', false, 'controls.spoilersArmed.off'],
    ['surfaces.spoilers.set', 'full', 'controls.speedbrake.set'],
    ['lights.strobeMode.set', 'auto', 'lights.strobe.auto'],
    ['lights.nav.set', true, 'lights.nav.nav1'],
    ['lights.beacon.set', false, 'lights.beacon.off'],
    ['lights.landing.set', true, 'lights.landing.on'],
    ['lights.noseMode.set', 'taxi', 'lights.nose.taxi'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: { value },
      profileKey: 'bundled/msfs/inibuilds-a350-900',
      profileRevision: 16,
    }, options);
    assert.equal(result.ok, true, `${commandId} should resolve`);
    assert.equal(result.configurationId, 'inibuilds-a350');
    assert.equal(result.controlRequest.actionId, actionId);
    if (commandId === 'surfaces.spoilers.set') assert.equal(result.controlRequest.value, 100);
  }

  for (const [commandId, value] of [
    ['flightGuidance.speed.set', 99],
    ['flightGuidance.heading.set', 360],
    ['flightGuidance.altitude.set', 35050],
    ['flightGuidance.verticalSpeed.set', 6100],
  ] as const) {
    const result = resolveAircraftCommand({ commandId, input: { value } }, options);
    assert.equal(result.ok, false, `${commandId}=${value} must fail closed`);
    assert.equal(result.code, 'invalid_command_input');
  }
});

test('iniBuilds A350 takeoff-light voice preset remains an ordered guarded recipe', () => {
  const result = resolveAircraftCommand({
    commandId: 'configuration.lights.takeoff',
    input: {},
    profileKey: 'bundled/msfs/inibuilds-a350-1000',
    profileRevision: 16,
  }, {
    profile: buildIniBuildsA350Profile('1000'),
    profileRevision: 16,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence', 'lvar'],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.controlRequests.map((request) => request.actionId), [
    'lights.landing.on',
    'lights.nose.takeoff',
    'lights.strobe.on',
    'lights.nav.nav1',
  ]);
});

test('PMDG 777 catalogue exposes one reviewed UI and voice command slice across all four variants', () => {
  const supportedCommandIds = [
    'flightGuidance.speed.set',
    'flightGuidance.mach.set',
    'flightGuidance.heading.set',
    'flightGuidance.altitude.set',
    'flightGuidance.verticalSpeed.set',
    'flightGuidance.flightPathAngle.set',
    'flightGuidance.flightDirectorCaptain.set',
    'flightGuidance.autopilot1.engage',
    'flightGuidance.autothrottleArmLeft.set',
    'flightGuidance.lnav.engage',
    'flightGuidance.vnav.engage',
    'flightGuidance.flightLevelChange.engage',
    'flightGuidance.headingHold.engage',
    'flightGuidance.verticalSpeed.engage',
    'flightGuidance.altitudeHold.engage',
    'flightGuidance.localizer.engage',
    'flightGuidance.approach.engage',
    'flightGuidance.autothrottleArmRight.set',
    'flightGuidance.autopilot2.engage',
    'flightGuidance.flightDirectorFirstOfficer.set',
    'flightGuidance.headingReference.set',
    'flightGuidance.verticalReference.set',
    'surfaces.gear.set',
    'surfaces.flaps.set',
    'surfaces.spoilersArmed.set',
    'surfaces.parkingBrake.set',
    'surfaces.autobrake.set',
    'lights.beacon.set',
    'lights.nav.set',
    'lights.strobe.set',
    'lights.taxi.set',
    'configuration.lights.takeoff',
  ];

  for (const variant of ['pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f'] as const) {
    const capabilities = buildAircraftControlCapabilities(buildPmdg777Profile(variant), {
      profileRevision: 14,
      capabilities: {
        actionTypes: ['aircraft-integration'],
        integrationTransports: ['sdk'],
      },
    });
    assert.equal(capabilities.aircraftCommands.configurationId, 'pmdg-777');
    assert.equal(capabilities.aircraftCommands.profileKey, `bundled/msfs/${variant}`);
    assert.deepEqual(
      capabilities.aircraftCommands.commands.map((command) => command.id),
      supportedCommandIds,
    );
    assert.equal(
      capabilities.aircraftCommands.commands.every((command) => command.speech?.patterns?.length > 0),
      true,
      'every reviewed PMDG 777 command must be reachable from the active voice catalogue',
    );
    if (variant === 'pmdg-777') {
      const commands = new Map<string, any>(
        capabilities.aircraftCommands.commands.map((command) => [command.id, command]),
      );
      assert.deepEqual(commands.get('flightGuidance.flightPathAngle.set').input, {
        kind: 'number', min: -9.9, max: 9.9, step: 0.1, units: 'degrees',
      });
      assert.equal(commands.get('flightGuidance.lnav.engage').speech.patterns.includes('l n a b'), true);
      assert.equal(commands.get('surfaces.autobrake.set').speech.patterns.includes('set otto brake {value}'), true);
      assert.equal(
        commands.get('configuration.lights.takeoff').speech.patterns.includes('set lights for a take off'),
        true,
      );
    }
  }
});

test('PMDG 777 commands map canonical intent only to guarded adapter actions', () => {
  const options = {
    profile: buildPmdg777Profile(),
    profileRevision: 14,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['sdk'],
    },
  };
  for (const [commandId, value, actionId] of [
    ['flightGuidance.flightDirectorCaptain.set', true, 'afds.flightDirectorCaptain.on'],
    ['flightGuidance.autothrottleArmLeft.set', false, 'afds.autothrottleArmLeft.off'],
    ['flightGuidance.headingReference.set', 'trk', 'afds.headingMode.trk'],
    ['flightGuidance.verticalReference.set', 'fpa', 'afds.verticalMode.fpa'],
    ['surfaces.gear.set', 'down', 'controls.gear.down'],
    ['surfaces.flaps.set', '20', 'controls.flaps.twenty'],
    ['surfaces.spoilersArmed.set', true, 'controls.speedbrake.armed'],
    ['surfaces.parkingBrake.set', false, 'controls.parkingBrake.off'],
    ['surfaces.autobrake.set', 'max', 'controls.autobrake.max'],
    ['lights.strobe.set', true, 'lights.strobe.on'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: { value },
      profileKey: 'bundled/msfs/pmdg-777',
      profileRevision: 14,
    }, options);
    assert.equal(result.ok, true, `${commandId} should resolve`);
    assert.equal(result.configurationId, 'pmdg-777');
    assert.equal(result.controlRequests.length, 1);
    assert.equal(result.controlRequest.actionId, actionId);
  }

  for (const [commandId, actionId] of [
    ['flightGuidance.autopilot1.engage', 'afds.apLeft.engage'],
    ['flightGuidance.autopilot2.engage', 'afds.apRight.engage'],
    ['flightGuidance.lnav.engage', 'afds.lnav.engage'],
    ['flightGuidance.vnav.engage', 'afds.vnav.engage'],
    ['flightGuidance.flightLevelChange.engage', 'afds.levelChange.engage'],
    ['flightGuidance.headingHold.engage', 'afds.headingHold.engage'],
    ['flightGuidance.verticalSpeed.engage', 'afds.verticalSpeed.engage'],
    ['flightGuidance.altitudeHold.engage', 'afds.altitudeHold.engage'],
    ['flightGuidance.localizer.engage', 'afds.vorLoc.engage'],
    ['flightGuidance.approach.engage', 'afds.approach.engage'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: {},
      profileKey: 'bundled/msfs/pmdg-777',
      profileRevision: 14,
    }, options);
    assert.equal(result.ok, true, `${commandId} should resolve`);
    assert.equal(result.controlRequest.actionId, actionId);
  }
});

test('PMDG 777 MCP commands preserve the exact guarded selector contracts', () => {
  const options = {
    profile: buildPmdg777Profile(),
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['sdk'],
    },
  };
  for (const [commandId, value, actionId] of [
    ['flightGuidance.speed.set', 245, 'mcp.ias.set'],
    ['flightGuidance.mach.set', 0.84, 'mcp.mach.set'],
    ['flightGuidance.heading.set', 273, 'mcp.heading.set'],
    ['flightGuidance.altitude.set', 35000, 'mcp.altitude.set'],
    ['flightGuidance.verticalSpeed.set', -1200, 'mcp.verticalSpeed.set'],
    ['flightGuidance.flightPathAngle.set', -2.5, 'mcp.fpa.set'],
  ] as const) {
    const result = resolveAircraftCommand({ commandId, input: { value } }, options);
    assert.equal(result.ok, true, `${commandId}=${value} should resolve`);
    assert.equal(result.controlRequest.actionId, actionId);
    assert.equal(result.controlRequest.value, value);
  }

  for (const [commandId, value] of [
    ['flightGuidance.speed.set', 99],
    ['flightGuidance.heading.set', 360],
    ['flightGuidance.altitude.set', 35050],
    ['flightGuidance.verticalSpeed.set', 6100],
    ['flightGuidance.flightPathAngle.set', -2.55],
    ['surfaces.flaps.set', '10'],
  ] as const) {
    const result = resolveAircraftCommand({ commandId, input: { value } }, options);
    assert.equal(result.ok, false, `${commandId}=${value} must fail closed`);
    assert.equal(result.code, 'invalid_command_input');
  }
});

test('PMDG 777 takeoff-light preset remains an ordered guarded recipe', () => {
  const result = resolveAircraftCommand({
    commandId: 'configuration.lights.takeoff',
    input: {},
    profileKey: 'bundled/msfs/pmdg-777f',
    profileRevision: 14,
  }, {
    profile: buildPmdg777Profile('pmdg-777f'),
    profileRevision: 14,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['sdk'],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stepCount, 8);
  assert.deepEqual(result.controlRequests.map((request) => request.actionId), [
    'lights.landingLeft.on',
    'lights.landingNose.on',
    'lights.landingRight.on',
    'lights.turnoffLeft.on',
    'lights.turnoffRight.on',
    'lights.taxi.on',
    'lights.strobe.on',
    'lights.nav.on',
  ]);
});

test('PMDG 737 catalogue exposes the complete reviewed UI and voice command slice', () => {
  const capabilities = buildAircraftControlCapabilities(buildPmdg737Profile(), {
    profileRevision: 9,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['sdk', 'simconnect-sequence'],
    },
  });
  const commands = new Map<string, any>(
    capabilities.aircraftCommands.commands.map((command) => [command.id, command]),
  );
  const inventory = new Map<string, any>(
    capabilities.aircraftCommands.inventory.map((command) => [command.id, command]),
  );

  assert.equal(capabilities.aircraftIntegration.id, 'pmdg-737');
  assert.equal(capabilities.aircraftIntegration.vendor, 'PMDG');
  assert.equal(capabilities.aircraftIntegration.family, '737');
  assert.equal(
    capabilities.aircraftIntegration.fields.some((field) => field.id === 'mcp.headingDeg'),
    true,
    'the integration guide should be derived from the complete adapter field registry',
  );
  assert.equal(
    capabilities.aircraftIntegration.actions.some((action) => action.id === 'mcp.heading.set'),
    true,
    'the integration guide should be derived from the complete adapter action registry',
  );
  assert.deepEqual(inventory.get('flightGuidance.heading.set').actionIds, ['mcp.heading.set']);
  assert.equal(inventory.get('flightGuidance.heading.set').supported, true);

  assert.deepEqual([...commands.keys()], [
    'flightGuidance.heading.set',
    'flightGuidance.course.setBoth',
    'flightGuidance.altitude.set',
    'flightGuidance.speed.set',
    'flightGuidance.mach.set',
    'flightGuidance.verticalSpeed.set',
    'flightGuidance.autopilot1.engage',
    'flightGuidance.headingSelect.engage',
    'flightGuidance.altitudeHold.engage',
    'flightGuidance.verticalSpeed.engage',
    'flightGuidance.flightLevelChange.engage',
    'flightGuidance.localizer.engage',
    'flightGuidance.approach.engage',
    'surfaces.gear.set',
    'surfaces.flaps.set',
    'surfaces.parkingBrake.set',
    'surfaces.spoilersArmed.set',
    'configuration.lighting.cockpit',
    'radios.nav.setBothActive',
    'lights.taxi.set',
    'configuration.lights.takeoff',
  ]);
  assert.deepEqual(commands.get('flightGuidance.altitude.set').speech.patterns, [
    'set altitude {value}',
    'altitude {value}',
    'set flight level {value}',
    'flight level {value}',
  ]);
  assert.equal(commands.get('flightGuidance.course.setBoth').kind, 'action');
  assert.deepEqual(commands.get('flightGuidance.course.setBoth').input, {
    kind: 'number', min: 0, max: 359, step: 1, units: 'degrees',
  });
  assert.deepEqual(commands.get('flightGuidance.course.setBoth').speech.patterns, [
    'set course {value}',
    'set courses {value}',
    'set both course {value}',
    'set both courses {value}',
    'set course windows {value}',
    'set both course windows {value}',
  ]);
  assert.deepEqual(commands.get('surfaces.flaps.set').input.values, [
    'up', '1', '2', '5', '10', '15', '25', '30', '40',
  ]);
  assert.deepEqual(commands.get('surfaces.parkingBrake.set').speech.patterns, [
    'parking brake {value}', '{value} parking brake',
  ]);
  assert.deepEqual(commands.get('surfaces.spoilersArmed.set').speech.patterns, [
    'ground spoilers {value}',
    '{value} ground spoilers',
    '{value} spoilers',
    'speed brake {value}',
    '{value} speed brake',
  ]);
  assert.equal(commands.get('surfaces.parkingBrake.set').kind, 'action');
  assert.equal(commands.get('surfaces.spoilersArmed.set').kind, 'action');
  assert.equal(commands.get('configuration.lighting.cockpit').kind, 'preset');
  assert.deepEqual(commands.get('configuration.lighting.cockpit').input, {
    kind: 'number', min: 0, max: 100, step: 1, units: 'percent',
  });
  assert.deepEqual(commands.get('configuration.lighting.cockpit').speech.patterns, [
    'set cockpit lighting {value}',
    'set cockpit lights {value}',
    'set all cockpit lights {value}',
  ]);
  assert.equal(commands.get('radios.nav.setBothActive').kind, 'action');
  assert.deepEqual(commands.get('radios.nav.setBothActive').input, {
    kind: 'number', min: 108, max: 117.95, step: 0.05, units: 'megahertz',
  });
  assert.deepEqual(commands.get('radios.nav.setBothActive').speech.patterns, [
    'set nav radios {value}',
    'set both nav radios {value}',
    'tune nav radios {value}',
  ]);
  assert.equal(commands.get('configuration.lights.takeoff').kind, 'preset');
  assert.equal(
    commands.get('configuration.lights.takeoff').description,
    'Landing L/R ON · Runway turnoffs ON · Taxi ON · Position STROBE + STEADY',
  );
});

test('PMDG 737 paired NAV command maps one validated frequency to one coordinated action', () => {
  const result = resolveAircraftCommand({
    commandId: 'radios.nav.setBothActive',
    input: { value: 110.3 },
    profileKey: 'bundled/msfs/pmdg-737',
    profileRevision: 9,
  }, {
    profile: buildPmdg737Profile(),
    profileRevision: 9,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.controlRequests.length, 1);
  assert.equal(result.controlRequest.actionId, 'radios.navBoth.setActive');
  assert.equal(result.controlRequest.value, 110.3);

  const invalid = resolveAircraftCommand({
    commandId: 'radios.nav.setBothActive',
    input: { value: 110.32 },
  }, {
    profile: buildPmdg737Profile(),
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_command_input');
});

test('PMDG 737 paired course command maps one validated course to one coordinated action', () => {
  const result = resolveAircraftCommand({
    commandId: 'flightGuidance.course.setBoth',
    input: { value: 273 },
    profileKey: 'bundled/msfs/pmdg-737',
    profileRevision: 9,
  }, {
    profile: buildPmdg737Profile(),
    profileRevision: 9,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.controlRequests.length, 1);
  assert.equal(result.controlRequest.actionId, 'mcp.courseBoth.set');
  assert.equal(result.controlRequest.value, 273);

  for (const value of [-1, 359.5, 360]) {
    const invalid = resolveAircraftCommand({
      commandId: 'flightGuidance.course.setBoth',
      input: { value },
    }, {
      profile: buildPmdg737Profile(),
      capabilities: {
        actionTypes: ['aircraft-integration'],
        integrationTransports: ['simconnect-sequence'],
      },
    });
    assert.equal(invalid.ok, false, `course ${value} must be rejected`);
    assert.equal(invalid.code, 'invalid_command_input');
  }
});

test('PMDG 737 normal surface commands map all four explicit boolean states', () => {
  for (const [commandId, value, actionId] of [
    ['surfaces.spoilersArmed.set', true, 'flightControls.speedbrake.arm'],
    ['surfaces.spoilersArmed.set', false, 'flightControls.speedbrake.disarm'],
    ['surfaces.parkingBrake.set', true, 'gear.parkingBrake.set'],
    ['surfaces.parkingBrake.set', false, 'gear.parkingBrake.released'],
  ] as const) {
    const result = resolveAircraftCommand({
      commandId,
      input: { value },
      profileKey: 'bundled/msfs/pmdg-737',
      profileRevision: 9,
    }, {
      profile: buildPmdg737Profile(),
      profileRevision: 9,
      requireProfileToken: true,
      capabilities: {
        actionTypes: ['aircraft-integration'],
        integrationTransports: ['sdk'],
      },
    });

    assert.equal(result.ok, true, `${commandId}=${value} should resolve`);
    assert.equal(result.controlRequests.length, 1, `${commandId} must dispatch exactly one action`);
    assert.equal(result.controlRequest.actionId, actionId);
  }
});

test('PMDG 737 takeoff-light preset resolves to one guarded aircraft-specific recipe', () => {
  const result = resolveAircraftCommand({
    commandId: 'configuration.lights.takeoff',
    input: {},
    profileKey: 'bundled/msfs/pmdg-737',
    profileRevision: 9,
  }, {
    profile: buildPmdg737Profile(),
    profileRevision: 9,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['sdk'],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stepCount, 8);
  assert.deepEqual(result.controlRequests.map((request) => request.actionId), [
    'lights.landingRetractableLeft.on',
    'lights.landingRetractableRight.on',
    'lights.landingLeft.on',
    'lights.landingRight.on',
    'lights.turnoffLeft.on',
    'lights.turnoffRight.on',
    'lights.taxi.on',
    'lights.position.strobeSteady',
  ]);
});

test('PMDG 737 cockpit-lighting preset maps one percentage to all four guarded groups', () => {
  const result = resolveAircraftCommand({
    commandId: 'configuration.lighting.cockpit',
    input: { value: 42 },
    profileKey: 'bundled/msfs/pmdg-737',
    profileRevision: 9,
  }, {
    profile: buildPmdg737Profile(),
    profileRevision: 9,
    requireProfileToken: true,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stepCount, 4);
  assert.deepEqual(result.controlRequests.map((request) => request.actionId), [
    'lighting.cockpit.panels.set',
    'lighting.cockpit.ambient.set',
    'lighting.cockpit.captainDisplays.set',
    'lighting.cockpit.firstOfficerDisplays.set',
  ]);
  assert.deepEqual(result.controlRequests.map((request) => request.value), [42, 42, 42, 42]);

  for (const value of [-1, 42.5, 101]) {
    const invalid = resolveAircraftCommand({
      commandId: 'configuration.lighting.cockpit',
      input: { value },
    }, {
      profile: buildPmdg737Profile(),
      capabilities: {
        actionTypes: ['aircraft-integration'],
        integrationTransports: ['simconnect-sequence'],
      },
    });
    assert.equal(invalid.ok, false, `cockpit lighting ${value} must be rejected`);
    assert.equal(invalid.code, 'invalid_command_input');
  }
});

test('aircraft command validation rejects out-of-range input before provider execution', async () => {
  let calls = 0;
  const result = await executeAircraftCommand({
    async executeAircraftControlAction() {
      calls += 1;
      return { ok: true };
    },
  }, {
    commandId: 'flightGuidance.heading.set',
    input: { value: 360 },
  }, {
    profile: buildBroadGenericControlProfile(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_command_input');
  assert.equal(calls, 0);
});

test('executeAircraftCommand preserves the canonical request while using the guarded legacy provider path', async () => {
  const calls = [];
  const provider = {
    aircraftControlCapabilities: { actionTypes: ['key-event'] },
    async executeAircraftControlAction(action, options) {
      calls.push({ action, options });
      return { ok: true, code: 'executed', type: 'forged-result', requestId: 'forged-request' };
    },
  };
  const result = await executeAircraftCommand(provider, {
    commandId: 'surfaces.gear.set',
    input: { value: 'down' },
    profileKey: 'bundled/msfs/generic',
    profileRevision: 3,
  }, {
    profile: buildBroadGenericControlProfile(),
    profileRevision: 3,
    requireProfileToken: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.commandId, 'surfaces.gear.set');
  assert.equal(result.type, undefined);
  assert.equal(result.requestId, undefined);
  assert.deepEqual(result.request.input, { value: 'down' });
  assert.deepEqual(result.controlRequest, {
    control: 'gear',
    operation: 'down',
    profileKey: 'bundled/msfs/generic',
    profileRevision: 3,
    requestId: null,
    target: '',
    value: undefined,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action.name, 'GEAR_DOWN');
});

test('executeAircraftCommand applies a takeoff-light preset in order through the shared provider path', async () => {
  const calls = [];
  const provider = {
    aircraftControlCapabilities: { actionTypes: ['key-event'] },
    async executeAircraftControlAction(action, options) {
      calls.push({ action, request: options.request });
      return { ok: true, code: 'executed' };
    },
  };

  const result = await executeAircraftCommand(provider, {
    commandId: 'configuration.lights.takeoff',
    input: {},
  }, {
    profile: buildBroadGenericControlProfile(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.commandId, 'configuration.lights.takeoff');
  assert.equal(result.completedStepCount, 3);
  assert.equal(result.stepCount, 3);
  assert.deepEqual(calls.map((call) => call.action.name), [
    'LANDING_LIGHTS_SET',
    'TAXI_LIGHTS_SET',
    'STROBES_SET',
  ]);
  assert.deepEqual(calls.map((call) => call.request.value), [true, true, true]);
});

test('takeoff-light preset stops after the first failed action and reports partial completion', async () => {
  const calls = [];
  const provider = {
    aircraftControlCapabilities: { actionTypes: ['key-event'] },
    async executeAircraftControlAction(action) {
      calls.push(action.name);
      return action.name === 'TAXI_LIGHTS_SET'
        ? { ok: false, code: 'write_failed', error: 'Taxi light write failed.' }
        : { ok: true, code: 'executed' };
    },
  };

  const result = await executeAircraftCommand(provider, {
    commandId: 'configuration.lights.takeoff',
    input: {},
  }, {
    profile: buildBroadGenericControlProfile(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'write_failed');
  assert.equal(result.completedStepCount, 1);
  assert.equal(result.executionStarted, true, 'a completed earlier step makes aircraft state uncertain');
  assert.equal(result.failedStepIndex, 1);
  assert.equal(result.failedStepLabel, 'Taxi lights ON');
  assert.deepEqual(calls, ['LANDING_LIGHTS_SET', 'TAXI_LIGHTS_SET']);
});

test('a first-step provider rejection does not imply that preset execution started', async () => {
  const provider = {
    aircraftControlCapabilities: { actionTypes: ['key-event'] },
    async executeAircraftControlAction() {
      return { ok: false, code: 'action_cooldown', error: 'Wait before retrying.' };
    },
  };

  const result = await executeAircraftCommand(provider, {
    commandId: 'configuration.lights.takeoff',
    input: {},
  }, {
    profile: buildBroadGenericControlProfile(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.completedStepCount, 0);
  assert.equal(result.steps.length, 1, 'the failed step remains available to privileged diagnostics');
  assert.equal(result.executionStarted, undefined);
});

test('executeAircraftCommand preserves one percentage across every cockpit-lighting group', async () => {
  const calls = [];
  const provider = {
    aircraftControlCapabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
    async executeAircraftControlAction(action, options) {
      calls.push({ action, request: options.request });
      return { ok: true, code: 'executed' };
    },
  };

  const result = await executeAircraftCommand(provider, {
    commandId: 'configuration.lighting.cockpit',
    input: { value: 42 },
  }, {
    profile: buildPmdg737Profile(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.completedStepCount, 4);
  assert.equal(result.stepCount, 4);
  assert.deepEqual(calls.map((call) => call.request.actionId), [
    'lighting.cockpit.panels.set',
    'lighting.cockpit.ambient.set',
    'lighting.cockpit.captainDisplays.set',
    'lighting.cockpit.firstOfficerDisplays.set',
  ]);
  assert.deepEqual(calls.map((call) => call.request.value), [42, 42, 42, 42]);
});

test('resolveAircraftControl uses generic MSFS fallback for gear down', () => {
  const result = resolveAircraftControl(
    { control: 'gear', operation: 'down' },
    { profile: buildProfile() }
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'generic');
  assert.equal(result.profileKey, 'bundled/msfs/generic');
  assert.deepEqual(result.action, {
    type: 'key-event',
    name: 'GEAR_DOWN',
  });
});

test('resolveAircraftControl uses profile override for FBW altitude selector writes', () => {
  const profile = buildProfile({
    id: 'fbw-a32nx',
    _profileKey: 'bundled/msfs/fbw-a32nx',
    integration: {
      controls: {
        autopilot: {
          selectorActions: {
            altitudeSet: {
              type: 'simvar',
              name: 'AUTOPILOT ALTITUDE LOCK VAR:3',
              unit: 'Feet',
            },
          },
        },
      },
    },
  });

  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'altitude', operation: 'set', value: 12000 },
    { profile }
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'profile');
  assert.equal(result.profileKey, 'bundled/msfs/fbw-a32nx');
  assert.deepEqual(result.action, {
    type: 'simvar',
    name: 'AUTOPILOT ALTITUDE LOCK VAR:3',
    unit: 'Feet',
    value: 12000,
  });
});

test('resolveAircraftControl blocks broad generic MSFS cockpit writes by default', () => {
  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'headingHold', operation: 'toggle' },
    { profile: buildProfile() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'unmapped_control');
  assert.equal(result.resolvedBy, 'profile');
});

test('resolveAircraftControl blocks generic spoiler and autobrake writes by default', () => {
  const cases = [
    { control: 'spoilers', operation: 'arm' },
    { control: 'autobrake', operation: 'increment' },
  ];

  for (const request of cases) {
    const result = resolveAircraftControl(request, { profile: buildProfile() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unmapped_control');
    assert.equal(result.resolvedBy, 'profile');
  }
});

test('resolveAircraftControl supports generic MSFS autopilot writes only when explicitly enabled', () => {
  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'headingHold', operation: 'toggle' },
    { profile: buildBroadGenericControlProfile() }
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'generic');
  assert.deepEqual(result.action, {
    type: 'key-event',
    name: 'AP_HDG_HOLD',
  });
});

test('bundled unmatched MSFS profile opts into only fixed generic simulator mappings', () => {
  const profile = buildProfile({
    ...genericProfileDocument,
    _profileKey: 'bundled/msfs/generic',
  });
  const cases = [
    {
      request: { control: 'parkingBrake', operation: 'set', value: true },
      action: { type: 'key-event', name: 'PARKING_BRAKE_SET', value: true },
    },
    {
      request: { control: 'lights', target: 'landing', operation: 'set', value: false },
      action: { type: 'key-event', name: 'LANDING_LIGHTS_SET', value: false },
    },
    {
      request: { control: 'spoilers', operation: 'set', value: 16383 },
      action: { type: 'key-event', name: 'SPOILERS_SET', value: 16383 },
    },
    {
      request: { control: 'autopilot', target: 'heading', operation: 'set', value: 273 },
      action: { type: 'key-event', name: 'HEADING_BUG_SET', parameters: [0], value: 273 },
    },
  ];

  assert.equal((profile as any).integration.controls.genericFallback, true);
  for (const { request, action } of cases) {
    const result = resolveAircraftControl(request, { profile });
    assert.equal(result.ok, true, JSON.stringify(request));
    assert.equal(result.resolvedBy, 'generic', JSON.stringify(request));
    assert.deepEqual(result.action, action, JSON.stringify(request));
  }
});

test('generic baseline rejects unknown light targets and out-of-range spoiler writes', () => {
  const profile = buildBroadGenericControlProfile();
  const unknownLight = resolveAircraftControl(
    { control: 'lights', target: 'logo', operation: 'set', value: true },
    { profile },
  );
  assert.equal(unknownLight.ok, false);
  assert.equal(unknownLight.code, 'unmapped_control');

  for (const value of [-1, 16384, 'full']) {
    const result = resolveAircraftControl(
      { control: 'spoilers', operation: 'set', value },
      { profile },
    );
    assert.equal(result.ok, false, `spoiler value ${value}`);
    assert.equal(result.code, 'invalid_value', `spoiler value ${value}`);
  }
});

test('buildAircraftControlCapabilities reports mapped or explicitly enabled UI writes', () => {
  const genericProfileCaps = buildAircraftControlCapabilities(buildProfile());
  assert.equal(genericProfileCaps.surface.gearDown, true);
  assert.equal(genericProfileCaps.surface.flapsIncrease, true);
  assert.equal(genericProfileCaps.surface.parkingBrake, false);
  assert.equal(genericProfileCaps.surface.spoilersPosition, false);
  assert.equal(genericProfileCaps.lights.landing, false);
  assert.equal(genericProfileCaps.autopilot.heading, false);
  assert.equal(genericProfileCaps.autopilot.loc, false);
  assert.equal(genericProfileCaps.autopilot.flightLevelChange, false);

  const noFallbackCaps = buildAircraftControlCapabilities(buildProfile({
    integration: {
      controls: {
        genericFallback: false,
      },
    },
  }));
  assert.equal(noFallbackCaps.surface.gearDown, false);
  assert.equal(noFallbackCaps.surface.flapsIncrease, false);

  const narrowSurfaceCaps = buildAircraftControlCapabilities(buildProfile({
    integration: {
      controls: {
        genericFallback: false,
        standardSurfaceFallback: true,
      },
    },
  }));
  assert.equal(narrowSurfaceCaps.surface.gearDown, true);
  assert.equal(narrowSurfaceCaps.surface.flapsIncrease, true);

  const broadGenericCaps = buildAircraftControlCapabilities(buildBroadGenericControlProfile());
  assert.equal(broadGenericCaps.surface.parkingBrake, true);
  assert.equal(broadGenericCaps.surface.spoilersPosition, true);
  assert.equal(broadGenericCaps.surface.spoilersArm, true);
  assert.equal(broadGenericCaps.lights.nav, true);
  assert.equal(broadGenericCaps.lights.beacon, true);
  assert.equal(broadGenericCaps.lights.strobe, true);
  assert.equal(broadGenericCaps.lights.landing, true);
  assert.equal(broadGenericCaps.lights.taxi, true);
  assert.equal(broadGenericCaps.autopilot.heading, true);
  assert.equal(broadGenericCaps.autopilot.loc, true);

  const profileMappedCaps = buildAircraftControlCapabilities(buildProfile({
    integration: {
      controls: {
        genericFallback: false,
        autopilot: {
          actions: {
            locOn: { type: 'key-event', name: 'AP_LOC_HOLD_ON' },
            locOff: { type: 'key-event', name: 'AP_LOC_HOLD_OFF' },
          },
        },
      },
    },
  }));
  assert.equal(profileMappedCaps.autopilot.loc, true);
  assert.equal(profileMappedCaps.autopilot.app, false);
});

test('aircraft-specific actions resolve only logical profile IDs and never use generic fallback', () => {
  const profile = buildBroadGenericControlProfile({
    id: 'specific-addon',
    _profileKey: 'local/msfs/specific-addon',
    integration: {
      controls: {
        genericFallback: true,
        aircraftSpecific: {
          actions: {
            'apu.start': {
              type: 'lvar',
              name: 'L:VERIFIED_APU_START_INPUT',
              unit: 'Number',
              value: 1,
            },
          },
        },
      },
    },
  });

  const resolved = resolveAircraftControl(
    { control: 'aircraft-specific', operation: 'execute', actionId: 'apu.start' },
    { profile },
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.resolvedBy, 'profile');
  assert.equal(resolved.request.target, 'apu.start');
  assert.deepEqual(resolved.action, {
    type: 'lvar',
    name: 'L:VERIFIED_APU_START_INPUT',
    unit: 'Number',
    value: 1,
  });

  const unknown = resolveAircraftControl(
    { control: 'aircraft-specific', operation: 'execute', actionId: 'apu.unknown' },
    { profile },
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unmapped_control');
  assert.equal(unknown.resolvedBy, 'profile');

  const malformed = resolveAircraftControl(
    { control: 'aircraft-specific', operation: 'execute', actionId: '__proto__.polluted' },
    { profile },
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'invalid_request');

  const clientValue = resolveAircraftControl(
    { control: 'aircraft-specific', operation: 'execute', actionId: 'apu.start', value: 0 },
    { profile },
  );
  assert.equal(clientValue.ok, false);
  assert.equal(clientValue.code, 'invalid_request');
});

test('aircraft-specific capabilities and execution remain provider and profile-token gated', async () => {
  const profile = buildProfile({
    id: 'specific-addon',
    _profileKey: 'local/msfs/specific-addon',
    integration: {
      controls: {
        aircraftSpecific: {
          actions: {
            'apu.start': { type: 'lvar', name: 'L:VERIFIED_APU_START_INPUT', value: 1 },
            'apu.stop': { type: 'input-event', name: 'VERIFIED_APU_STOP_INPUT' },
          },
        },
      },
    },
  });
  const capabilities = buildAircraftControlCapabilities(profile, {
    capabilities: { actionTypes: ['lvar'] },
  });
  assert.deepEqual(capabilities.aircraftSpecific, {
    'apu.start': true,
    'apu.stop': false,
  });

  const calls: Record<string, any>[] = [];
  const provider = {
    getAircraftControlCapabilities() {
      return { simulator: 'msfs', actionTypes: ['lvar'] };
    },
    async executeAircraftControlAction(action: Record<string, any>) {
      calls.push(action);
      return { ok: true, backendSource: 'fake-action-executor' };
    },
  };
  const result = await executeAircraftControl(provider, {
    control: 'aircraft-specific',
    operation: 'execute',
    actionId: 'apu.start',
    profileKey: 'local/msfs/specific-addon',
    profileRevision: 9,
  }, {
    profile,
    profileRevision: 9,
    requireProfileToken: true,
    requireStableSimState: true,
    simState: { simconnectConnected: true, inMenu: false },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'lvar',
    name: 'L:VERIFIED_APU_START_INPUT',
    value: 1,
  });
});

test('aircraft integration resolution rejects forged adapters, unknown actions, and prototype keys', () => {
  const capabilities = {
    actionTypes: ['aircraft-integration'],
    integrationTransports: ['sdk'],
  };
  const trustedProfile = buildProfile({
    id: 'fbw-a32nx',
    _profileKey: 'bundled/msfs/fbw-a32nx',
    integration: {
      aircraftSpecific: { adapter: 'fbw-a32nx' },
    },
  });

  for (const actionId of ['lights.unknown', 'constructor.prototype', 'toString.value']) {
    const result = resolveAircraftControl({
      control: 'aircraft-specific',
      operation: 'execute',
      actionId,
    }, { profile: trustedProfile, capabilities });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unmapped_control');
  }

  for (const adapter of ['unknown-adapter', 'constructor', '__proto__']) {
    const forgedProfile = {
      ...trustedProfile,
      integration: { aircraftSpecific: { adapter } },
    };
    const result = resolveAircraftControl({
      control: 'aircraft-specific',
      operation: 'execute',
      actionId: 'lights.taxi.on',
    }, { profile: forgedProfile, capabilities });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'untrusted_aircraft_integration');
  }
});

test('aircraft integration actions cannot be injected through declarative or generic controls', () => {
  const profile = buildProfile({
    integration: {
      controls: {
        gear: {
          downAction: {
            type: 'aircraft-integration',
            name: 'injected-adapter',
          },
        },
        aircraftSpecific: {
          actions: {
            'lights.taxi.on': {
              type: 'aircraft-integration',
              name: 'injected-adapter',
            },
          },
        },
      },
    },
  });
  const resolved = resolveAircraftControl(
    { control: 'gear', operation: 'down' },
    { profile, capabilities: { actionTypes: ['aircraft-integration'] } },
  );
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'invalid_action');
  assert.match(resolved.error, /aircraft-specific/);

  const injected = resolveAircraftControl({
    control: 'aircraft-specific',
    operation: 'execute',
    actionId: 'lights.taxi.on',
  }, {
    profile,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['sdk'],
    },
  });
  assert.equal(injected.ok, false);
  assert.equal(injected.code, 'untrusted_aircraft_integration');
});

test('trusted integrations disclose a sanitized MobiFlight dependency and live detection state', () => {
  const profile = buildProfile({
    id: 'fenix-a320',
    _profileKey: 'bundled/msfs/fenix-a320',
    integration: {
      aircraftSpecific: {
        adapter: 'fenix-a32x',
      },
    },
  });

  const missing = buildAircraftControlCapabilities(profile, {
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: [],
      mobiflight: { state: 'missing', connected: false, error: 'private provider detail' },
    },
  });
  assert.deepEqual(missing.aircraftSpecificDependencies, {
    mobiflightEventModule: {
      required: true,
      fallbackActive: false,
      connected: false,
      status: 'missing',
      scope: 'some-controls',
    },
  });
  assert.equal(missing.aircraftSpecific['lights.beacon.on'], false);
  assert.equal(JSON.stringify(missing.aircraftSpecificDependencies).includes('private provider detail'), false);

  const connected = buildAircraftControlCapabilities(profile, {
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['mobiflight-calculator'],
      mobiflight: { state: 'connected', connected: true },
    },
  });
  assert.equal(connected.aircraftSpecificDependencies.mobiflightEventModule.status, 'connected');
  assert.equal(connected.aircraftSpecificDependencies.mobiflightEventModule.connected, true);
  assert.equal(connected.aircraftSpecific['lights.beacon.on'], true);

  const futureDirectRoute = buildAircraftControlCapabilities(profile, {
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['lvar'],
      mobiflight: { state: 'missing', connected: false },
    },
  });
  assert.deepEqual(
    futureDirectRoute.aircraftSpecificDependencies,
    {
      mobiflightEventModule: {
        required: true,
        fallbackActive: true,
        connected: false,
        status: 'missing',
        scope: 'some-controls',
      },
    },
    'direct LVAR supports persistent controls but FCU calculator actions still require MobiFlight',
  );
  assert.equal(futureDirectRoute.aircraftSpecific['lights.beacon.on'], true);
  assert.equal(futureDirectRoute.aircraftSpecific['flightGuidance.ap1.on'], false);

  const typedSpeed = resolveAircraftControl({
    control: 'aircraft-specific',
    operation: 'execute',
    actionId: 'flightGuidance.speed.set',
    value: 250,
  }, {
    profile,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['mobiflight-calculator'],
    },
  });
  assert.equal(typedSpeed.ok, true, 'bounded Fenix speed target should resolve');
  assert.equal(typedSpeed.request.value, 250);

  const offStepAltitude = resolveAircraftControl({
    control: 'aircraft-specific',
    operation: 'execute',
    actionId: 'flightGuidance.altitudeHundred.set',
    value: 12550,
  }, {
    profile,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['mobiflight-calculator'],
    },
  });
  assert.equal(offStepAltitude.ok, false, 'off-step Fenix altitude target must fail closed');
  assert.equal(offStepAltitude.code, 'invalid_value');
});

test('FlyByWire calibrated throttles disclose a partial MobiFlight dependency', () => {
  const profile = buildProfile({
    id: 'fbw-a32nx',
    _profileKey: 'bundled/msfs/fbw-a32nx',
    integration: {
      aircraftSpecific: {
        adapter: 'fbw-a32nx',
      },
    },
  });

  const missing = buildAircraftControlCapabilities(profile, {
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence', 'lvar'],
      mobiflight: { state: 'missing', connected: false },
    },
  });
  assert.deepEqual(missing.aircraftSpecificDependencies, {
    mobiflightEventModule: {
      required: true,
      fallbackActive: false,
      connected: false,
      status: 'missing',
      scope: 'some-controls',
    },
  });
  assert.equal(missing.aircraftSpecific['lights.beacon.on'], true,
    'non-calculator A32NX controls remain available');
  assert.equal(missing.aircraftSpecific['propulsion.throttle.climb'], false,
    'calibrated throttle remains unavailable without MobiFlight');

  const connected = buildAircraftControlCapabilities(profile, {
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence', 'lvar', 'mobiflight-calculator'],
      mobiflight: { state: 'connected', connected: true },
    },
  });
  assert.equal(connected.aircraftSpecific['propulsion.throttle.climb'], true,
    'calibrated throttle becomes available when MobiFlight is healthy');
});

test('TriStar exposes all 13 AFCS momentary capabilities with the documented INS semantics', () => {
  const profile = buildTriStarProfile();
  const capabilities = buildAircraftControlCapabilities(profile, {
    capabilities: {
      actionTypes: ['key-event', 'aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });

  assert.deepEqual(capabilities.autopilotPulse, {
    autothrottle: true,
    verticalSpeedHold: true,
    altitudeHold: true,
    machHold: true,
    headingHold: true,
    flightDirector: true,
    apMaster: true,
    apDisconnect: true,
    app: true,
    loc: true,
    nav1: true,
    ins: true,
    backcourse: true,
  });
  assert.equal(Object.keys(capabilities.aircraftSpecific).length, 26);
  assert.equal(Object.values(capabilities.aircraftSpecific).every(Boolean), true);

  const altitudeStep = resolveAircraftControl({
    control: 'aircraft-specific',
    operation: 'execute',
    actionId: 'afcs.altitude.increase',
  }, {
    profile,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });
  assert.equal(altitudeStep.ok, true, 'vendor-documented selector step should resolve');
  assert.equal(altitudeStep.request.value, undefined);

  const unsupportedDirectTarget = resolveAircraftControl({
    control: 'aircraft-specific',
    operation: 'execute',
    actionId: 'afcs.altitude.set',
    value: 12500,
  }, {
    profile,
    capabilities: {
      actionTypes: ['aircraft-integration'],
      integrationTransports: ['simconnect-sequence'],
    },
  });
  assert.equal(unsupportedDirectTarget.ok, false, 'undocumented direct selector target must fail closed');
  assert.equal(capabilities.aircraftSpecific['afcs.altitude.set'], undefined);

  const pulseCases = [
    ['autothrottle', 'toggle', undefined, 'AP_AIRSPEED_HOLD'],
    ['verticalSpeedHold', 'toggle', undefined, 'AP_VS_HOLD'],
    ['altitudeHold', 'toggle', undefined, 'AP_ALT_HOLD'],
    ['machHold', 'toggle', undefined, 'AP_MACH_HOLD'],
    ['headingHold', 'toggle', undefined, 'AP_HDG_HOLD'],
    ['flightDirector', 'toggle', undefined, 'TOGGLE_FLIGHT_DIRECTOR'],
    ['master', 'toggle', undefined, 'AP_MASTER'],
    ['master', 'set', false, 'AUTOPILOT_OFF'],
    ['app', 'toggle', undefined, 'AP_APR_HOLD'],
    ['loc', 'toggle', undefined, 'AP_LOC_HOLD'],
    ['nav1', 'toggle', undefined, 'AP_NAV1_HOLD'],
    ['ins', 'toggle', undefined, 'TOGGLE_WATER_RUDDER'],
    ['backcourse', 'toggle', undefined, 'AP_BC_HOLD'],
  ] as const;

  for (const [target, operation, value, eventName] of pulseCases) {
    const result = resolveAircraftControl(
      {
        control: 'autopilot',
        target,
        operation,
        ...(value === undefined ? {} : { value }),
      },
      { profile },
    );
    assert.equal(result.ok, true, `${target} ${operation} should resolve`);
    assert.equal(result.resolvedBy, 'profile');
    assert.deepEqual(result.action, {
      type: 'key-event',
      name: eventName,
      verification: 'untested',
    });
  }

  const wrongYawMapping = resolveAircraftControl(
    { control: 'autopilot', target: 'yawDamper', operation: 'toggle' },
    { profile },
  );
  assert.equal(wrongYawMapping.ok, false);
  assert.equal(wrongYawMapping.code, 'unmapped_control');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (profile as any).integration.controls.autopilot.actions,
      'yawDamperToggle',
    ),
    false,
    'TOGGLE_WATER_RUDDER must not be presented as yaw damper',
  );
});

test('resolveAircraftControl can select the first profile control candidate without provider capabilities', () => {
  const profile = buildProfile({
    id: 'modern-msfs-addon',
    _profileKey: 'local/msfs/modern-msfs-addon',
    integration: {
      controls: {
        autopilot: {
          selectorActions: {
            headingSet: [
              {
                type: 'input-event',
                name: 'CUSTOM_HEADING_INPUT',
              },
              {
                type: 'lvar',
                name: 'L:CUSTOM_HEADING_FALLBACK',
                unit: 'Number',
              },
            ],
          },
        },
      },
    },
  });

  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'heading', operation: 'set', value: 123 },
    { profile }
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'profile');
  assert.deepEqual(result.action, {
    type: 'input-event',
    name: 'CUSTOM_HEADING_INPUT',
    value: 123,
  });
});

test('executeAircraftControl selects a supported profile control candidate from provider capabilities', async () => {
  const profile = buildProfile({
    id: 'modern-msfs-addon',
    _profileKey: 'local/msfs/modern-msfs-addon',
    integration: {
      controls: {
        autopilot: {
          selectorActions: {
            headingSet: [
              {
                type: 'input-event',
                name: 'CUSTOM_HEADING_INPUT',
              },
              {
                type: 'lvar',
                name: 'L:CUSTOM_HEADING_FALLBACK',
                unit: 'Number',
              },
              {
                type: 'key-event',
                name: 'HEADING_BUG_SET',
              },
            ],
          },
        },
      },
    },
  });
  const calls = [];
  const provider = {
    getAircraftControlCapabilities() {
      return {
        simulator: 'msfs',
        actionTypes: ['key-event', 'lvar', 'simvar'],
      };
    },
    async executeAircraftControlAction(action) {
      calls.push(action);
      return { ok: true, backendSource: 'mock-provider' };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'autopilot', target: 'heading', operation: 'set', value: 123 },
    { profile }
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'profile');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'lvar',
    name: 'L:CUSTOM_HEADING_FALLBACK',
    unit: 'Number',
    value: 123,
  });
});

test('executeAircraftControl reports unsupported mapped candidates before provider execution', async () => {
  const profile = buildProfile({
    id: 'modern-msfs-addon',
    _profileKey: 'local/msfs/modern-msfs-addon',
    integration: {
      controls: {
        autopilot: {
          selectorActions: {
            headingSet: [
              {
                type: 'input-event',
                name: 'CUSTOM_HEADING_INPUT',
              },
            ],
          },
        },
      },
    },
  });
  let called = false;
  const provider = {
    getAircraftControlCapabilities() {
      return {
        simulator: 'msfs',
        actionTypes: ['key-event', 'lvar', 'simvar'],
      };
    },
    async executeAircraftControlAction() {
      called = true;
      return { ok: true };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'autopilot', target: 'heading', operation: 'set', value: 123 },
    { profile }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported_action');
  assert.match(result.error, /input-event/);
  assert.equal(result.resolvedBy, 'profile');
});

test('executeAircraftControl rejects unsafe profile action names before provider execution', async () => {
  const profile = buildProfile({
    id: 'unsafe-addon',
    _profileKey: 'local/msfs/unsafe-addon',
    integration: {
      controls: {
        gear: {
          downAction: {
            type: 'key-event',
            name: 'GEAR_DOWN; Remove-Item C:\\Users',
          },
        },
      },
    },
  });
  let called = false;
  const provider = {
    async executeAircraftControlAction() {
      called = true;
      return { ok: true };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'gear', operation: 'down' },
    { profile }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_action');
  assert.match(result.error, /target contains unsupported characters/);
  assert.equal(result.resolvedBy, 'profile');
});

test('executeAircraftControl rejects unsafe profile action parameters before provider execution', async () => {
  const profile = buildProfile({
    id: 'unsafe-addon',
    _profileKey: 'local/msfs/unsafe-addon',
    integration: {
      controls: {
        autopilot: {
          selectorActions: {
            headingSet: {
              type: 'lvar',
              name: 'L:SAFE_HEADING_TARGET',
              unit: 'Number',
              parameters: ['1', 'bad;rm'],
            },
          },
        },
      },
    },
  });
  let called = false;
  const provider = {
    getAircraftControlCapabilities() {
      return {
        simulator: 'msfs',
        actionTypes: ['key-event', 'lvar', 'simvar'],
      };
    },
    async executeAircraftControlAction() {
      called = true;
      return { ok: true };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'autopilot', target: 'heading', operation: 'set', value: 123 },
    { profile }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_action');
  assert.match(result.error, /parameters are outside the safe control payload format/);
});

test('executeAircraftControl rejects key events that exceed the native secondary-parameter limit', async () => {
  const profile = buildProfile({
    id: 'oversized-key-event',
    _profileKey: 'local/msfs/oversized-key-event',
    integration: {
      controls: {
        autopilot: {
          selectorActions: {
            headingSet: {
              type: 'key-event',
              name: 'HEADING_BUG_SET',
              value: 123,
              parameters: [0, 1, 2, 3, 4],
            },
          },
        },
      },
    },
  });
  let called = false;
  const provider = {
    getAircraftControlCapabilities() {
      return { simulator: 'msfs', actionTypes: ['key-event'] };
    },
    async executeAircraftControlAction() {
      called = true;
      return { ok: true };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'autopilot', target: 'heading', operation: 'set', value: 123 },
    { profile },
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_action');
  assert.match(result.error, /native SimConnect limit/);
});

test('executeAircraftControl fails closed when any mapped candidate is invalid', async () => {
  const profile = buildProfile({
    id: 'unsafe-addon',
    _profileKey: 'local/msfs/unsafe-addon',
    integration: {
      controls: {
        gear: {
          downAction: [
            {
              type: 'key-event',
              name: 'GEAR_DOWN && start calc',
            },
            {
              type: 'key-event',
              name: 'GEAR_DOWN',
            },
          ],
        },
      },
    },
  });
  let called = false;
  const provider = {
    async executeAircraftControlAction() {
      called = true;
      return { ok: true };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'gear', operation: 'down' },
    { profile }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_action');
  assert.match(result.error, /target contains unsupported characters/);
});

test('executeAircraftControl strips unexpected profile action fields before provider execution', async () => {
  const profile = buildProfile({
    id: 'noisy-addon',
    _profileKey: 'local/msfs/noisy-addon',
    integration: {
      controls: {
        gear: {
          downAction: {
            type: 'key-event',
            name: ' GEAR_DOWN ',
            value: 0,
            danger: 'ignored',
            nested: { payload: true },
          },
        },
      },
    },
  });
  const calls = [];
  const provider = {
    async executeAircraftControlAction(action) {
      calls.push(action);
      return { ok: true };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'gear', operation: 'down' },
    { profile }
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'key-event',
    name: 'GEAR_DOWN',
    value: 0,
  });
});

test('resolveAircraftControl does not apply MSFS generic fallback to X-Plane profiles', () => {
  const result = resolveAircraftControl(
    { control: 'gear', operation: 'down' },
    {
      profile: buildProfile({
        id: 'flightfactor-777',
        simulator: 'xplane',
        namespace: 'bundled',
        _profileKey: 'bundled/xplane/flightfactor-777',
      }),
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'unmapped_control');
  assert.equal(result.simulator, 'xplane');
});

test('resolveAircraftControl resolves X-Plane command profile actions without MSFS fallback', () => {
  const result = resolveAircraftControl(
    { control: 'gear', operation: 'down' },
    {
      profile: buildProfile({
        id: 'xplane-aircraft',
        simulator: 'xplane',
        namespace: 'bundled',
        _profileKey: 'bundled/xplane/xplane-aircraft',
        integration: {
          controls: {
            backend: 'xplane',
            gear: {
              downAction: {
                type: 'command',
                name: 'sim/flight_controls/landing_gear_down',
              },
            },
          },
        },
      }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'profile');
  assert.equal(result.simulator, 'xplane');
  assert.deepEqual(result.action, {
    type: 'command',
    name: 'sim/flight_controls/landing_gear_down',
  });
});

test('executeAircraftControl leaves X-Plane command actions gated until provider support is implemented', async () => {
  let called = false;
  const provider = {
    getAircraftControlCapabilities() {
      return {
        simulator: 'xplane',
        actionTypes: [],
      };
    },
    async executeAircraftControlAction() {
      called = true;
      return { ok: true };
    },
  };
  const result = await executeAircraftControl(
    provider,
    { control: 'gear', operation: 'down' },
    {
      profile: buildProfile({
        id: 'xplane-aircraft',
        simulator: 'xplane',
        namespace: 'bundled',
        _profileKey: 'bundled/xplane/xplane-aircraft',
        integration: {
          controls: {
            backend: 'xplane',
            gear: {
              downAction: {
                type: 'command',
                name: 'sim/flight_controls/landing_gear_down',
              },
            },
          },
        },
      }),
    }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported_action');
  assert.match(result.error, /command/);
  assert.equal(result.simulator, 'xplane');
});

test('resolveAircraftControl respects profile opt-out from generic MSFS fallback', () => {
  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'speed', operation: 'set', value: 120 },
    {
      profile: buildProfile({
        id: 'complex-addon',
        _profileKey: 'local/msfs/complex-addon',
        integration: {
          controls: {
            backend: 'auto',
            genericFallback: false,
          },
        },
      }),
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'unmapped_control');
  assert.equal(result.profileKey, 'local/msfs/complex-addon');
});

test('resolveAircraftControl allows standard surface fallback without broad fallback', () => {
  const profile = buildProfile({
    id: 'complex-addon',
    _profileKey: 'local/msfs/complex-addon',
    integration: {
      controls: {
        backend: 'auto',
        genericFallback: false,
        standardSurfaceFallback: true,
      },
    },
  });

  const gearResult = resolveAircraftControl(
    { control: 'gear', operation: 'down' },
    { profile }
  );
  const flapsResult = resolveAircraftControl(
    { control: 'flaps', operation: 'decrement' },
    { profile }
  );
  const autopilotResult = resolveAircraftControl(
    { control: 'autopilot', target: 'speed', operation: 'set', value: 120 },
    { profile }
  );

  assert.equal(gearResult.ok, true);
  assert.equal(gearResult.resolvedBy, 'generic');
  assert.deepEqual(gearResult.action, {
    type: 'key-event',
    name: 'GEAR_DOWN',
  });
  assert.equal(flapsResult.ok, true);
  assert.equal(flapsResult.resolvedBy, 'generic');
  assert.deepEqual(flapsResult.action, {
    type: 'key-event',
    name: 'FLAPS_DECR',
  });
  assert.equal(autopilotResult.ok, false);
  assert.equal(autopilotResult.code, 'unmapped_control');
});

test('profile normalization preserves an ordinary profile fallback choice', () => {
  const profile = buildLoadedProfile({
    id: 'ordinary-addon',
    simulator: 'msfs',
    namespace: 'local',
    meta: {
      developer: 'Independent Vendor',
    },
    integration: {
      controls: {
        genericFallback: false,
        standardSurfaceFallback: true,
      },
    },
  });

  assert.equal(profile.integration.controls.genericFallback, false);
  assert.equal(profile.integration.controls.standardSurfaceFallback, true);
  assert.equal(resolveAircraftControl(
    { control: 'gear', operation: 'down' },
    { profile },
  ).ok, true);
});

test('executeAircraftControl forwards the resolved action to the active provider', async () => {
  const calls = [];
  const provider = {
    async executeAircraftControlAction(action) {
      calls.push(action);
      return {
        ok: true,
        backendSource: 'rust-sidecar',
      };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'autopilot', target: 'heading', operation: 'set', value: 275 },
    { profile: buildBroadGenericControlProfile() }
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'key-event',
    name: 'HEADING_BUG_SET',
    parameters: [0],
    value: 275,
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'generic');
  assert.equal(result.backendSource, 'rust-sidecar');
});

test('resolveAircraftControl rejects invalid autopilot selector values before provider execution', () => {
  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'altitude', operation: 'set', value: Number.NaN },
    { profile: buildBroadGenericControlProfile() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_value');
  assert.equal(result.error, 'A numeric value is required for this autopilot selector.');
});

test('resolveAircraftControl rejects empty autopilot selector values before provider execution', () => {
  for (const value of ['', '   ', null]) {
    const result = resolveAircraftControl(
      { control: 'autopilot', target: 'heading', operation: 'set', value },
      { profile: buildBroadGenericControlProfile() }
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_value');
    assert.equal(result.error, 'A numeric value is required for this autopilot selector.');
  }
});

test('resolveAircraftControl accepts numeric selector strings', () => {
  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'heading', operation: 'set', value: '275' },
    { profile: buildBroadGenericControlProfile() }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.action, {
    type: 'key-event',
    name: 'HEADING_BUG_SET',
    parameters: [0],
    value: '275',
  });
});

test('generic autopilot selectors include the explicit all-slots event parameter', () => {
  const cases = [
    ['speed', 245, 'AP_SPD_VAR_SET'],
    ['heading', 87, 'HEADING_BUG_SET'],
    ['altitude', 12000, 'AP_ALT_VAR_SET_ENGLISH'],
    ['verticalSpeed', -700, 'AP_VS_VAR_SET_ENGLISH'],
  ];

  for (const [target, value, name] of cases) {
    const result = resolveAircraftControl(
      { control: 'autopilot', target, operation: 'set', value },
      { profile: buildBroadGenericControlProfile() },
    );
    assert.equal(result.ok, true, `${target} should resolve through the generic baseline`);
    assert.deepEqual(result.action, {
      type: 'key-event',
      name,
      parameters: [0],
      value,
    });
  }
});

test('resolveAircraftControl rejects selector values outside guarded ranges', () => {
  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'verticalSpeed', operation: 'set', value: 25000 },
    { profile: buildBroadGenericControlProfile() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_value');
  assert.match(result.error, /between -9900 and 9900/);
});

test('executeAircraftControl returns a normalized unsupported-provider result', async () => {
  const result = await executeAircraftControl(
    null,
    { control: 'gear', operation: 'down' },
    { profile: buildProfile() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'provider_unsupported');
  assert.equal(result.executionStarted, undefined);
  assert.equal(result.error, 'The active simulator provider does not support aircraft control actions.');
  assert.equal(result.resolvedBy, 'generic');
  assert.deepEqual(result.action, {
    type: 'key-event',
    name: 'GEAR_DOWN',
  });
});

test('executeAircraftControl normalizes provider failures without letting provider fields replace the resolved request', async () => {
  const provider = {
    async executeAircraftControlAction() {
      return {
        ok: false,
        code: 'sidecar_unavailable',
        error: 'No sidecar.',
        request: { control: 'spoofed' },
        action: { type: 'spoofed' },
      };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'gear', operation: 'down' },
    { profile: buildProfile() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'sidecar_unavailable');
  assert.equal(result.error, 'No sidecar.');
  assert.equal(result.executionStarted, undefined);
  assert.equal(result.request.control, 'gear');
  assert.equal(result.action.type, 'key-event');
});

test('executeAircraftControl preserves an explicit provider dispatch boundary', async () => {
  const provider = {
    async executeAircraftControlAction() {
      return {
        ok: false,
        code: 'action_failed',
        error: 'The native write was not acknowledged.',
        executionStarted: true,
      };
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'gear', operation: 'down' },
    { profile: buildProfile() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.executionStarted, true);
});

test('executeAircraftControl catches provider exceptions as provider_error', async () => {
  const provider = {
    async executeAircraftControlAction() {
      throw new Error('bridge exploded');
    },
  };

  const result = await executeAircraftControl(
    provider,
    { control: 'gear', operation: 'down' },
    { profile: buildProfile() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'provider_error');
  assert.equal(result.error, 'bridge exploded');
  assert.equal(result.executionStarted, undefined);
});

test('resolveAircraftControl requires a current profile token when requested', () => {
  const result = resolveAircraftControl(
    { control: 'gear', operation: 'down' },
    {
      profile: buildProfile(),
      profileRevision: 7,
      requireProfileToken: true,
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'profile_token_required');
});

test('resolveAircraftControl rejects stale profile keys and revisions', () => {
  const profile = buildProfile();

  const wrongKey = resolveAircraftControl(
    {
      control: 'gear',
      operation: 'down',
      profileKey: 'local/msfs/wrong-aircraft',
      profileRevision: 7,
    },
    {
      profile,
      profileRevision: 7,
      requireProfileToken: true,
    }
  );

  assert.equal(wrongKey.ok, false);
  assert.equal(wrongKey.code, 'stale_profile');

  const staleRevision = resolveAircraftControl(
    {
      control: 'gear',
      operation: 'down',
      profileKey: profile._profileKey,
      profileRevision: 6,
    },
    {
      profile,
      profileRevision: 7,
      requireProfileToken: true,
    }
  );

  assert.equal(staleRevision.ok, false);
  assert.equal(staleRevision.code, 'stale_profile');
});

test('executeAircraftControl rejects blocked simulator states before provider execution', async () => {
  let called = false;
  const provider = {
    async executeAircraftControlAction() {
      called = true;
      return { ok: true };
    },
  };

  const result = await executeAircraftControl(
    provider,
    {
      control: 'gear',
      operation: 'down',
      profileKey: 'bundled/msfs/generic',
      profileRevision: 7,
    },
    {
      profile: buildProfile(),
      profileRevision: 7,
      requireProfileToken: true,
      requireStableSimState: true,
      simState: { type: 'simState', simconnectConnected: true, inMenu: true },
    }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'sim_state_blocked');
  assert.equal(result.executionStarted, undefined);
});

export {};
