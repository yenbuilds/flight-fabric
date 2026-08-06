'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSourceOverlayContext,
  overlayParkingBrakeSources,
  resolveAutopilotSourceOverlay,
  resolveLightsForBroadcast,
  resolveSpoilersForBroadcast,
} = require('./source-overlays') as Record<string, any>;

function makeContext(frame = {}, secondary = [], profile = null) {
  return createSourceOverlayContext({
    frame,
    dataSourceInfo: { secondary },
    profile,
  });
}

test('source overlay context recognizes generic SDK sources and frame payloads', () => {
  const context = makeContext(
    {
      sdk: {
        normalized: { automation: { ap: { engaged: true } } },
        raw: { ap: 0 },
      },
      lvars: { values: { autopilot: 1 } },
    },
    [
      { type: 'lvar-sidecar', connected: true },
      { type: 'sdk', connected: true },
    ],
  );

  assert.equal(context.lvarSidecarConnected, true);
  assert.equal(context.sdkConnected, true);
  assert.equal(context.sdkHasData, true);
  assert.equal(context.sdkHasAutomationData, true);
  assert.equal(context.lvarHasAutomationData, true);
  assert.equal(context.lvarHasModeSelectorData, false);
  assert.deepEqual(context.lvarValues, { autopilot: 1 });
});

test('source overlay context treats populated LVAR MCP fields as automation data', () => {
  const context = makeContext(
    { lvars: { values: { autopilot: null, autothrottle: null, mode_lnav: true, mode_vnav: false } } },
    [{ type: 'lvar-sidecar', connected: true }],
  );

  assert.equal(context.lvarSidecarConnected, true);
  assert.equal(context.lvarHasAutopilotData, false);
  assert.equal(context.lvarHasAutothrottleData, false);
  assert.equal(context.lvarHasAutomationData, true);
  assert.equal(context.lvarHasModeSelectorData, true);
});

test('source overlay context trusts present SDK values even when source status lags', () => {
  const frame = {
    sdk: {
      normalized: {
        automation: {
          ap: { engaged: true },
        },
      },
    },
  };
  const context = makeContext(frame, [{ type: 'sdk', connected: false }]);

  assert.equal(context.sdkConnected, true);
  assert.equal(context.sdkHasData, true);
  assert.equal(context.sdkHasAutomationData, true);

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: { apMaster: false },
    profile: { dataSource: { preferred: 'sdk' } },
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, true);
});

test('lights resolve from SDK before profile LVAR and base values', () => {
  const frame = {
    sdk: {
      normalized: {
        lights: {
          nav: true,
          beacon: false,
          landing: { left: false, right: true },
          taxi: true,
          strobe: false,
        },
      },
    },
    lvars: {
      values: {
        light_nav: 0,
        light_beacon: 1,
      },
    },
  };
  const context = makeContext(frame, [
    { type: 'lvar-sidecar', connected: true },
    { type: 'sdk', connected: true },
  ]);

  const lights = resolveLightsForBroadcast({
    baseLights: { nav: false, beacon: true, landing: false, taxi: false, strobe: true },
    profile: { lights: { source: 'lvar' }, dataSource: { lvars: { lights: { nav: 'A', beacon: 'B' } } } },
    sourceContext: context,
  });

  assert.equal(lights.nav, true);
  assert.equal(lights.beacon, false);
  assert.equal(lights.landing, true);
  assert.equal(lights.taxi, true);
  assert.equal(lights.available, true);
});

test('lights ignore unrelated SDK payloads instead of forcing lights off', () => {
  const frame = {
    sdk: {
      normalized: {
        automation: { ap: { engaged: true } },
      },
    },
  };
  const context = makeContext(frame, [
    { type: 'sdk', connected: true },
  ]);

  const baseLights = { nav: true, beacon: true, landing: true, taxi: true, strobe: true, panel: true };
  const lights = resolveLightsForBroadcast({
    baseLights,
    profile: {},
    sourceContext: context,
  });

  assert.equal(lights, baseLights);
});

test('source overlay context does not count unrelated SDK payloads as automation data', () => {
  const frame = {
    sdk: {
      normalized: {
        lights: { nav: true },
      },
    },
  };
  const context = makeContext(frame, [
    { type: 'sdk', connected: true },
  ]);

  assert.equal(context.sdkHasData, true);
  assert.equal(context.sdkHasAutomationData, false);

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: { apMaster: false },
    profile: { dataSource: { preferred: 'sdk' } },
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, null);
});

test('source overlay context ignores null-only SDK automation shells', () => {
  const frame = {
    sdk: {
      normalized: {
        automation: {
          ap: {
            engaged: null,
            modes: {
              lnav: null,
              vnav: null,
            },
          },
          athr: {
            active: null,
          },
        },
      },
      raw: {
        ap: null,
        at: null,
      },
    },
  };
  const context = makeContext(frame, [
    { type: 'sdk', connected: true },
  ]);

  assert.equal(context.sdkConnected, true);
  assert.equal(context.sdkHasData, false);
  assert.equal(context.sdkHasAutomationData, false);
});

test('lights preserve base values for missing SDK light fields', () => {
  const frame = {
    sdk: {
      normalized: {
        lights: {
          nav: false,
        },
      },
    },
  };
  const context = makeContext(frame, [
    { type: 'sdk', connected: true },
  ]);

  const lights = resolveLightsForBroadcast({
    baseLights: { nav: true, beacon: true, landing: true, taxi: true, strobe: true },
    profile: {},
    sourceContext: context,
  });

  assert.equal(lights.nav, false);
  assert.equal(lights.beacon, true);
  assert.equal(lights.landing, true);
  assert.equal(lights.taxi, true);
  assert.equal(lights.available, true);
});

test('lights use configured profile LVAR mappings as optional overlays', () => {
  const lvarFrame = {
    lvars: {
      values: {
        light_nav: 1,
        light_beacon: 0,
        light_logo: 'true',
        light_wing: 'false',
      },
    },
  };
  const lights = resolveLightsForBroadcast({
    baseLights: {
      nav: false,
      beacon: true,
      landing: true,
      taxi: true,
      strobe: false,
      logo: false,
      wing: true,
    },
    profile: {
      dataSource: {
        lvars: {
          lights: {
            nav: 'ignored',
            beacon: 'ignored',
            logo: 'ignored',
            wing: 'ignored',
          },
        },
      },
    },
    sourceContext: makeContext(lvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(lights.nav, true);
  assert.equal(lights.beacon, false);
  assert.equal(lights.logo, true);
  assert.equal(lights.wing, false);
  assert.equal(lights.landing, true);
  assert.equal(lights.taxi, true);
  assert.equal(lights.available, true);

  const fallback = resolveLightsForBroadcast({
    baseLights: { nav: false, beacon: true, landing: true, taxi: true },
    profile: { dataSource: { lvars: { lights: { nav: 'ignored', beacon: 'ignored' } } } },
    sourceContext: makeContext({ lvars: { values: { light_nav: 1 } } }, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(fallback.nav, false);
  assert.equal(fallback.beacon, true);
  assert.equal(fallback.available, undefined);

  const optionalFallback = resolveLightsForBroadcast({
    baseLights: { nav: false, beacon: false, landing: false, taxi: false, strobe: false },
    profile: {
      lights: { source: 'lvar' },
      dataSource: {
        lvars: {
          lights: {
            beacon: 'required',
            nav: 'legacy-nav',
            strobe: 'legacy-strobe',
            _optional: 'nav,strobe',
          },
        },
      },
    },
    sourceContext: makeContext(
      { lvars: { values: { light_beacon: 1, light_nav: null, light_strobe: null } } },
      [{ type: 'lvar-sidecar', connected: true }],
    ),
  });

  assert.equal(optionalFallback.beacon, true);
  assert.equal(optionalFallback.nav, false);
  assert.equal(optionalFallback.strobe, false);
  assert.equal(optionalFallback.available, true);
});

test('partial LVAR lights preserve standard NAV and strobe telemetry when they are not mapped', () => {
  const lights = resolveLightsForBroadcast({
    baseLights: {
      nav: true,
      beacon: false,
      landing: false,
      taxi: false,
      strobe: true,
    },
    profile: {
      lights: { source: 'lvar' },
      dataSource: {
        lvars: {
          lights: {
            beacon: 'EXAMPLE_LIGHT_BEACON',
            landing_left: 'EXAMPLE_LIGHT_LANDING_LEFT',
            landing_right: 'EXAMPLE_LIGHT_LANDING_RIGHT',
            taxi: 'EXAMPLE_LIGHT_TAXI',
          },
        },
      },
    },
    sourceContext: makeContext(
      {
        lvars: {
          values: {
            light_beacon: 1,
            light_landing_left: 0,
            light_landing_right: 0,
            light_taxi: 0,
          },
        },
      },
      [{ type: 'lvar-sidecar', connected: true }],
    ),
  });

  assert.equal(lights.nav, true);
  assert.equal(lights.strobe, true);
  assert.equal(lights.beacon, true);
  assert.equal(lights.available, true);
});

test('standard gauge LIGHT STATES repairs a zero native mask before profile light overlays', () => {
  const lights = resolveLightsForBroadcast({
    baseLights: {
      nav: false,
      beacon: false,
      landing: false,
      taxi: false,
      strobe: false,
      raw: 0,
    },
    profile: {
      lights: { source: 'lvar' },
      dataSource: {
        lvars: {
          lights: {
            beacon: 'switch_124_73X',
            landing_left: 'switch_113_73X',
            landing_right: 'switch_114_73X',
            taxi: 'switch_117_73X',
          },
        },
      },
    },
    sourceContext: makeContext(
      {
        lvars: {
          values: {
            standard_light_states: 735,
            light_beacon: 1,
            light_landing_left: 1,
            light_landing_right: 1,
            light_taxi: 1,
          },
        },
      },
      [{ type: 'lvar-sidecar', connected: true }],
    ),
  });

  assert.equal(lights.nav, true);
  assert.equal(lights.strobe, true);
  assert.equal(lights.beacon, true);
  assert.equal(lights.raw, null);
  assert.equal(lights.available, true);
});

test('lights use SDK data even when profile LVAR source is unavailable', () => {
  const frame = {
    sdk: {
      normalized: {
        lights: {
          nav: true,
          beacon: false,
        },
      },
    },
  };
  const lights = resolveLightsForBroadcast({
    baseLights: { nav: false, beacon: true, landing: false, taxi: false, strobe: false },
    profile: { lights: { source: 'lvar' }, dataSource: { lvars: { lights: { nav: 'ignored' } } } },
    sourceContext: makeContext(frame, [
      { type: 'lvar-sidecar', connected: false },
      { type: 'sdk', connected: true },
    ]),
  });

  assert.equal(lights.nav, true);
  assert.equal(lights.beacon, false);
  assert.equal(lights.available, true);
});

test('lights allow authoritative source data when base SimConnect lights are unreliable', () => {
  const sdkFrame = {
    sdk: {
      normalized: {
        lights: {
          nav: true,
        },
      },
    },
  };
  const fromSdk = resolveLightsForBroadcast({
    baseLights: { nav: false, beacon: true, landing: false, taxi: false, strobe: false },
    profile: { lights: { simVarReliable: false } },
    sourceContext: makeContext(sdkFrame, [{ type: 'sdk', connected: true }]),
  });

  assert.equal(fromSdk.nav, true);
  assert.equal(fromSdk.available, true);

  const lvarFrame = { lvars: { values: { light_nav: 1, light_beacon: 0 } } };
  const fromLvar = resolveLightsForBroadcast({
    baseLights: { nav: false, beacon: true, landing: false, taxi: false, strobe: false },
    profile: {
      lights: { source: 'lvar', simVarReliable: false },
      dataSource: { lvars: { lights: { nav: 'ignored', beacon: 'ignored' } } },
    },
    sourceContext: makeContext(lvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(fromLvar.nav, true);
  assert.equal(fromLvar.beacon, false);
  assert.equal(fromLvar.available, true);

  const stringLvarFrame = { lvars: { values: { light_nav: '1', light_beacon: 'false' } } };
  const fromStringLvar = resolveLightsForBroadcast({
    baseLights: { nav: false, beacon: true, landing: false, taxi: false, strobe: false },
    profile: {
      lights: { source: 'lvar', simVarReliable: false },
      dataSource: { lvars: { lights: { nav: 'ignored', beacon: 'ignored' } } },
    },
    sourceContext: makeContext(stringLvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(fromStringLvar.nav, true);
  assert.equal(fromStringLvar.beacon, false);
  assert.equal(fromStringLvar.available, true);
});

test('autopilot overlay applies profile LVARs, then SDK values when present', () => {
  const frame = {
    lvars: {
      values: {
        autopilot: 1,
        autothrottle: 0,
        mode_lnav: 1,
        selected_altitude: 12000,
        selected_speed: 240,
      },
    },
    sdk: {
      normalized: {
        automation: {
          ap: {
            engaged: false,
            modes: { lnav: false, alt: true },
            selected: { altitudeFt: 14000 },
          },
          athr: { active: true },
        },
      },
    },
  };
  const context = makeContext(frame, [
    { type: 'lvar-sidecar', connected: true },
    { type: 'sdk', connected: true },
  ]);

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apMaster: false,
      athrActive: false,
      apAltHold: false,
      apLnavHold: null,
      apAltTargetFt: 10000,
      apSpeedTargetKts: 200,
    },
    profile: { dataSource: { preferred: 'sdk', lvars: { mcp: { speed: 'ignored' } } } },
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, false);
  assert.equal(overlay.athrActive, true);
  assert.equal(overlay.apLnavHold, false);
  assert.equal(overlay.apAltHold, true);
  assert.equal(overlay.apAltTargetFt, 14000);
  assert.equal(overlay.apSpeedTargetKts, 240);
});

test('autopilot overlay keeps SDK A/T armed and flight director values for SDK-preferred profiles', () => {
  const frame = {
    sdk: {
      normalized: {
        automation: {
          ap: {
            flightDirector: { left: false, right: true },
          },
          athr: {
            active: false,
            armed: true,
          },
        },
      },
    },
  };
  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apFdActive: false,
      athrActive: true,
      athrArmed: false,
    },
    profile: { dataSource: { preferred: 'sdk' } },
    sourceContext: makeContext(frame, [{ type: 'sdk', connected: true }]),
  });

  assert.equal(overlay.apFdActive, true);
  assert.equal(overlay.athrActive, false);
  assert.equal(overlay.athrArmed, true);
});

test('autopilot overlay reads raw SDK FD and A/T armed values when normalized shortcuts are absent', () => {
  const frame = {
    sdk: {
      raw: {
        fd_l: 0,
        fd_r: 0,
        at: 0,
        at_arm_l: 0,
        at_arm_r: 1,
      },
    },
  };
  const context = makeContext(frame, [{ type: 'sdk', connected: true }]);
  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apFdActive: true,
      athrActive: true,
      athrArmed: false,
    },
    profile: { dataSource: { preferred: 'sdk' } },
    sourceContext: context,
  });

  assert.equal(context.sdkHasAutomationData, true);
  assert.equal(overlay.apFdActive, false);
  assert.equal(overlay.athrActive, false);
  assert.equal(overlay.athrArmed, true);
});

test('autopilot overlay preserves base SimConnect mode flags when SimConnect is the preferred source', () => {
  const context = makeContext({}, []);
  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apFdActive: true,
      apHdgHold: true,
      apNavHold: true,
      apAltHold: true,
      apVsHold: true,
      apLnavHold: true,
      apVnavHold: true,
      apLocHold: true,
      apLvlChgHold: true,
      apFlcHold: true,
      apExpedHold: true,
      apApprHold: true,
      apSpeedHold: true,
      athrArmed: true,
    },
    profile: { dataSource: { preferred: 'simconnect' } },
    sourceContext: context,
  });

  assert.equal(overlay.apFdActive, true);
  assert.equal(overlay.apHdgHold, true);
  assert.equal(overlay.apNavHold, true);
  assert.equal(overlay.apAltHold, true);
  assert.equal(overlay.apVsHold, true);
  assert.equal(overlay.apLnavHold, true);
  assert.equal(overlay.apVnavHold, true);
  assert.equal(overlay.apLocHold, true);
  assert.equal(overlay.apLvlChgHold, true);
  assert.equal(overlay.apFlcHold, true);
  assert.equal(overlay.apExpedHold, true);
  assert.equal(overlay.apApprHold, true);
  assert.equal(overlay.apSpeedHold, true);
  assert.equal(overlay.athrArmed, true);
});

test('autopilot overlay keeps missing bridge mode data unknown for non-SimConnect preferred profiles', () => {
  const context = makeContext({}, []);
  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apFdActive: true,
      apHdgHold: true,
      apNavHold: true,
      apAltHold: true,
      apVsHold: true,
      apLnavHold: true,
      apVnavHold: true,
      apLocHold: true,
      apLvlChgHold: true,
      apFlcHold: false,
      apExpedHold: true,
      apApprHold: true,
      apSpeedHold: true,
      athrArmed: true,
    },
    profile: { dataSource: { preferred: 'fenix' } },
    sourceContext: context,
  });

  assert.equal(overlay.apFdActive, null);
  assert.equal(overlay.apHdgHold, null);
  assert.equal(overlay.apNavHold, null);
  assert.equal(overlay.apAltHold, null);
  assert.equal(overlay.apVsHold, null);
  assert.equal(overlay.apLnavHold, null);
  assert.equal(overlay.apVnavHold, null);
  assert.equal(overlay.apLocHold, null);
  assert.equal(overlay.apLvlChgHold, null);
  assert.equal(overlay.apFlcHold, null);
  assert.equal(overlay.apExpedHold, null);
  assert.equal(overlay.apApprHold, null);
  assert.equal(overlay.apSpeedHold, null);
  assert.equal(overlay.athrArmed, null);
});

test('autopilot overlay does not fall back to SimConnect engagement for missing external LVAR data', () => {
  const context = makeContext(
    { lvars: { values: { autopilot: null, autothrottle: null } } },
    [{ type: 'lvar-sidecar', connected: true }],
  );
  assert.equal(context.lvarSidecarConnected, true);
  assert.equal(context.lvarHasAutopilotData, false);
  assert.equal(context.lvarHasAutothrottleData, false);

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apMaster: false,
      athrActive: false,
      apHdgHold: true,
      apAltHold: true,
    },
    profile: {
      dataSource: {
        preferred: 'fenix',
        lvars: {
          autopilot: 'ignored',
          autothrottle: 'ignored',
        },
      },
    },
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, null);
  assert.equal(overlay.athrActive, null);
  assert.equal(overlay.apHdgHold, null);
  assert.equal(overlay.apAltHold, null);
});

test('autopilot overlay suppresses SimConnect AP engagement when profile marks it unreliable', () => {
  const context = makeContext({}, []);

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apMaster: false,
      apHdgHold: false,
      apAltHold: true,
      apAltTargetFt: 30800,
    },
    profile: {
      dataSource: {
        preferred: 'simconnect',
      },
      integration: {
        telemetry: {
          autopilot: { simVarReliable: false },
        },
      },
    },
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, null);
  assert.equal(overlay.apHdgHold, null);
  assert.equal(overlay.apAltHold, null);
  assert.equal(overlay.apAltTargetFt, 30800);
});

test('autopilot overlay treats false external LVAR engagement values as present data', () => {
  const context = makeContext(
    { lvars: { values: { autopilot: 0, autothrottle: false } } },
    [{ type: 'lvar-sidecar', connected: true }],
  );
  assert.equal(context.lvarHasAutopilotData, true);
  assert.equal(context.lvarHasAutothrottleData, true);

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apMaster: true,
      athrActive: true,
    },
    profile: {
      dataSource: {
        preferred: 'fenix',
        lvars: {
          autopilot: 'ignored',
          autothrottle: 'ignored',
        },
      },
    },
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, false);
  assert.equal(overlay.athrActive, false);
});

test('autopilot overlay parses string LVAR automation values', () => {
  const context = makeContext(
    {
      lvars: {
        values: {
          autopilot: '1',
          autothrottle: '0',
          mode_lnav: '1',
          selected_altitude: '12000',
          selected_speed: '0.78',
        },
      },
    },
    [{ type: 'lvar-sidecar', connected: true }],
  );

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apMaster: false,
      athrActive: true,
      apLnavHold: false,
      apAltTargetFt: 10000,
      apSpeedTargetKts: 240,
      apMachTarget: null,
    },
    profile: {
      dataSource: {
        preferred: 'lvar',
        lvars: {
          autopilot: 'ignored',
          autothrottle: 'ignored',
          mcp: { speed: 'ignored' },
        },
      },
    },
    sourceContext: context,
  });

  assert.equal(context.lvarHasAutopilotData, true);
  assert.equal(context.lvarHasAutothrottleData, true);
  assert.equal(overlay.apMaster, true);
  assert.equal(overlay.athrActive, false);
  assert.equal(overlay.apLnavHold, true);
  assert.equal(overlay.apAltTargetFt, 12000);
  assert.equal(overlay.apMachTarget, 0.78);
  assert.equal(overlay.apSpeedTargetKts, null);
});

test('autopilot overlay treats channel B as AP master engaged', () => {
  const profile = {
    dataSource: {
      preferred: 'lvar',
      lvars: {
        mcp: {
          cmdA: 'ignored',
          cmdB: 'ignored',
          speed: 'ignored',
          hdgMode: 'ignored',
        },
      },
    },
  };
  const context = makeContext(
    {
      lvars: {
        values: {
          ap_channel_a: 0,
          ap_channel_b: 1,
          selected_speed: 246,
          mode_speed: 1,
          mode_heading: 1,
        },
      },
    },
    [{ type: 'lvar-sidecar', connected: true }],
    profile,
  );

  assert.equal(context.lvarHasAutopilotData, true);

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apMaster: false,
      apHdgHold: false,
      apSpeedTargetKts: 240,
    },
    profile,
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, true);
  assert.equal(overlay.apHdgHold, true);
  assert.equal(overlay.apSpeedHold, true);
  assert.equal(overlay.apSpeedTargetKts, 246);
});

test('autopilot overlay ignores blank string LVAR selector values', () => {
  const context = makeContext(
    {
      lvars: {
        values: {
          autopilot: '1',
          selected_altitude: '',
          selected_speed: '   ',
        },
      },
    },
    [{ type: 'lvar-sidecar', connected: true }],
  );

  const overlay = resolveAutopilotSourceOverlay({
    baseFdm: {
      apMaster: false,
      apAltTargetFt: 10000,
      apSpeedTargetKts: 240,
      apMachTarget: 0.76,
    },
    profile: {
      dataSource: {
        preferred: 'lvar',
        lvars: {
          autopilot: 'ignored',
          mcp: { altitude: 'ignored', speed: 'ignored' },
        },
      },
    },
    sourceContext: context,
  });

  assert.equal(overlay.apMaster, true);
  assert.equal(overlay.apAltTargetFt, null);
  assert.equal(overlay.apSpeedTargetKts, null);
  assert.equal(overlay.apMachTarget, null);
});

test('spoilers suppress unreliable base values until a source bridge supplies data', () => {
  const noBridge = makeContext({}, []);
  const suppressed = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 12, fraction: 0.12, state: 'EXTENDED' },
    profile: { spoilers: { simVarReliable: false } },
    frame: {},
    sourceContext: noBridge,
  });

  assert.equal(suppressed.available, false);
  assert.equal(suppressed.percent, null);
  assert.equal(suppressed.state, null);

  const frame = {
    sdk: {
      normalized: {
        spoilers: { handlePercent: 35, state: 'extended' },
      },
    },
  };
  const withSdk = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 0, fraction: 0, state: 'STOWED' },
    profile: { spoilers: { simVarReliable: false } },
    frame,
    sourceContext: makeContext(frame, [{ type: 'sdk', connected: true }]),
  });

  assert.equal(withSdk.available, undefined);
  assert.equal(withSdk.percent, 35);
  assert.equal(withSdk.fraction, 0.35);
  assert.equal(withSdk.state, 'EXTENDED');
});

test('spoilers do not treat unrelated SDK payloads as trusted spoiler data', () => {
  const frame = {
    sdk: {
      normalized: {
        lights: { nav: true },
      },
    },
  };
  const spoilers = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 12, fraction: 0.12, state: 'EXTENDED' },
    profile: { spoilers: { simVarReliable: false } },
    frame,
    sourceContext: makeContext(frame, [{ type: 'sdk', connected: true }]),
  });

  assert.equal(spoilers.available, false);
  assert.equal(spoilers.percent, null);
  assert.equal(spoilers.fraction, null);
  assert.equal(spoilers.state, null);
});

test('spoilers keep profile LVAR data when base SimConnect spoilers are unreliable', () => {
  const frame = { lvars: { values: { spoilers_armed: false, spoilers_handle: 0.42 } } };
  const spoilers = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 0, fraction: 0, state: 'ARMED' },
    profile: {
      spoilers: { simVarReliable: false },
      dataSource: { lvars: { spoilers: { armed: 'ignored', handlePosition: 'ignored' } } },
    },
    frame,
    sourceContext: makeContext(frame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(spoilers.available, undefined);
  assert.equal(spoilers.state, 'EXTENDED');
  assert.equal(spoilers.percent, 42);
  assert.equal(spoilers.fraction, 0.42);
  assert.equal(spoilers._source, 'lvar');
});

test('spoilers treat boolean false LVAR as disarmed', () => {
  const frame = { lvars: { values: { spoilers_armed: false } } };
  const spoilers = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 0, fraction: 0, state: 'ARMED' },
    profile: { dataSource: { lvars: { spoilers: { armed: 'ignored' } } } },
    frame,
    sourceContext: makeContext(frame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(spoilers.state, 'STOWED');
  assert.equal(spoilers._source, 'lvar');
});

test('spoilers do not mix LVAR armed state with stale base handle percent', () => {
  const frame = { lvars: { values: { spoilers_armed: false } } };
  const spoilers = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 42, fraction: 0.42, state: 'EXTENDED' },
    profile: { dataSource: { lvars: { spoilers: { armed: 'ignored' } } } },
    frame,
    sourceContext: makeContext(frame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(spoilers.state, 'STOWED');
  assert.equal(spoilers.percent, 0);
  assert.equal(spoilers.fraction, 0);
  assert.equal(spoilers._source, 'lvar');
});

test('spoilers derive percent and state from LVAR handle position', () => {
  const frame = { lvars: { values: { spoilers_armed: false, spoilers_handle: 0.42 } } };
  const spoilers = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 0, fraction: 0, state: 'ARMED' },
    profile: { dataSource: { lvars: { spoilers: { armed: 'ignored', handlePosition: 'ignored' } } } },
    frame,
    sourceContext: makeContext(frame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(spoilers.state, 'EXTENDED');
  assert.equal(spoilers.percent, 42);
  assert.equal(spoilers.fraction, 0.42);
  assert.equal(spoilers._source, 'lvar');
});

test('spoilers parse string LVAR handle values without treating blanks as zero', () => {
  const stringFrame = { lvars: { values: { spoilers_armed: 'false', spoilers_handle: '42' } } };
  const fromString = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 0, fraction: 0, state: 'STOWED' },
    profile: {
      dataSource: { lvars: { spoilers: { armed: 'ignored', handlePosition: 'ignored' } } },
    },
    frame: stringFrame,
    sourceContext: makeContext(stringFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(fromString.state, 'EXTENDED');
  assert.equal(fromString.percent, 42);
  assert.equal(fromString.fraction, 0.42);

  const blankFrame = { lvars: { values: { spoilers_handle: '   ' } } };
  const fromBlank = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 0, fraction: 0, state: 'ARMED' },
    profile: {
      dataSource: { lvars: { spoilers: { armed: 'ignored', handlePosition: 'ignored' } } },
    },
    frame: blankFrame,
    sourceContext: makeContext(blankFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });

  assert.equal(fromBlank.available, false);
  assert.equal(fromBlank.state, null);
  assert.equal(fromBlank.percent, null);
  assert.equal(fromBlank.fraction, null);
});

test('spoilers suppress unreliable SimConnect when configured LVAR data is missing', () => {
  const spoilers = resolveSpoilersForBroadcast({
    baseSpoilers: { percent: 0, fraction: 0, state: 'ARMED' },
    profile: { dataSource: { lvars: { spoilers: { armed: 'ignored', handlePosition: 'ignored' } } } },
    frame: {},
    sourceContext: makeContext({}, [{ type: 'lvar-sidecar', connected: false }]),
  });

  assert.equal(spoilers.available, false);
  assert.equal(spoilers.state, null);
  assert.equal(spoilers.percent, null);
  assert.equal(spoilers.fraction, null);
});

test('source overlay context trusts present LVAR values even when source status lags', () => {
  const frame = { lvars: { values: { parking_brake: 1, spoilers_armed: false } } };
  const context = makeContext(frame, [{ type: 'lvar-sidecar', connected: false }]);

  assert.equal(context.lvarSidecarConnected, true);

  const gear = overlayParkingBrakeSources({
    gear: { parkingBrake: false },
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: context,
  });
  assert.equal(gear.parkingBrake, true);
});

test('parking brake overlays profile LVAR lever positions and SDK values', () => {
  const lvarFrame = { lvars: { values: { parking_brake: 1 } } };
  const fromLvar = overlayParkingBrakeSources({
    gear: { parkingBrake: false },
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: makeContext(lvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });
  assert.equal(fromLvar.parkingBrake, true);

  const falseLvarFrame = { lvars: { values: { parking_brake: 0 } } };
  const fromFalseLvar = overlayParkingBrakeSources({
    gear: { parkingBrake: true },
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: makeContext(falseLvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });
  assert.equal(fromFalseLvar.parkingBrake, false);

  const noisyOffLvarFrame = { lvars: { values: { parking_brake: 0.01 } } };
  const fromNoisyOffLvar = overlayParkingBrakeSources({
    gear: { parkingBrake: true },
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: makeContext(noisyOffLvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });
  assert.equal(fromNoisyOffLvar.parkingBrake, false);

  const percentLvarFrame = { lvars: { values: { parking_brake: 100 } } };
  const fromPercentLvar = overlayParkingBrakeSources({
    gear: { parkingBrake: false },
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: makeContext(percentLvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });
  assert.equal(fromPercentLvar.parkingBrake, true);

  const stringLvarFrame = { lvars: { values: { parking_brake: '1' } } };
  const fromStringLvar = overlayParkingBrakeSources({
    gear: { parkingBrake: false },
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: makeContext(stringLvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });
  assert.equal(fromStringLvar.parkingBrake, true);

  const stringFalseLvarFrame = { lvars: { values: { parking_brake: 'false' } } };
  const fromStringFalseLvar = overlayParkingBrakeSources({
    gear: { parkingBrake: true },
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: makeContext(stringFalseLvarFrame, [{ type: 'lvar-sidecar', connected: true }]),
  });
  assert.equal(fromStringFalseLvar.parkingBrake, false);

  const sdkFrame = {
    sdk: {
      raw: { parking_brake: 0 },
    },
  };
  const fromSdk = overlayParkingBrakeSources({
    gear: fromLvar,
    profile: { dataSource: { lvars: { parkingBrake: 'ignored' } } },
    sourceContext: makeContext(sdkFrame, [{ type: 'sdk', connected: true }]),
  });
  assert.equal(fromSdk.parkingBrake, false);
});
