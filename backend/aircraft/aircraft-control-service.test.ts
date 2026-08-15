const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAircraftControlCapabilities,
  executeAircraftControl,
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
  assert.equal(result.request.control, 'gear');
  assert.equal(result.action.type, 'key-event');
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
});

export {};
