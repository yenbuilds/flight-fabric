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

test('buildAircraftControlCapabilities reports mapped or explicitly enabled UI writes', () => {
  const genericProfileCaps = buildAircraftControlCapabilities(buildProfile());
  assert.equal(genericProfileCaps.surface.gearDown, true);
  assert.equal(genericProfileCaps.surface.flapsIncrease, true);
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

test('resolveAircraftControl supports profile-only autopilot target toggles', () => {
  const profile = buildProfile({
    id: 'inibuilds-tristar',
    _profileKey: 'bundled/msfs/inibuilds-tristar',
    integration: {
      controls: {
        backend: 'simconnect',
        genericFallback: false,
        autopilot: {
          actions: {
            yawDamperToggle: {
              type: 'key-event',
              name: 'TOGGLE_WATER_RUDDER',
              verification: 'untested',
            },
          },
        },
      },
    },
  });

  const result = resolveAircraftControl(
    { control: 'autopilot', target: 'yawDamper', operation: 'toggle' },
    { profile }
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'profile');
  assert.deepEqual(result.action, {
    type: 'key-event',
    name: 'TOGGLE_WATER_RUDDER',
    verification: 'untested',
  });
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
    value: '275',
  });
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
