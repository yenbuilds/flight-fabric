'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('NAV radio readback is broadcast with aircraft generation for remote clients', () => {
  const { sendBasicStreams } = require('../../events/broadcasters');
  const { projectServerMessageForClient } = require('../../core/server-message-projection');
  const navRadios = { profileKey: 'bundled/msfs/generic', profileRevision: 3, radios: {
    nav1: { installed: true, activeMhz: 108, standbyMhz: 110.30 },
    nav2: { installed: false, activeMhz: null, standbyMhz: null },
  } };
  const messages = [];
  sendBasicStreams((message) => messages.push(message), { navRadios });
  const message = messages.find((entry) => entry.type === 'navRadios');
  assert.deepEqual(message, { type: 'navRadios', data: navRadios });
  assert.deepEqual(projectServerMessageForClient({}, message), message);
});
const {
  assessAutopilotReliability,
  buildAltitudeBroadcastPayload,
  buildAutopilotBroadcastPayload,
  buildFuelBroadcastPayload,
} = require('../../events/broadcasters') as {
  assessAutopilotReliability: (context?: Record<string, any> | null) => {
    apReliable: boolean;
    athrReliable: boolean;
    reason: string;
  };
  buildAltitudeBroadcastPayload: (payload: Record<string, any>) => Record<string, any>;
  buildAutopilotBroadcastPayload: (ap?: Record<string, any> | null, reliability?: Record<string, any>) => Record<string, any> | null;
  buildFuelBroadcastPayload: (fuel?: Record<string, any> | null) => Record<string, any> | null;
};

test('altitude broadcasts keep legacy indicated altitude and expose independent diagnostics', () => {
  const payload = buildAltitudeBroadcastPayload({
    alt_msl_ft: 4321.4,
    altIndicatedFt: 4321.4,
    altCalibratedFt: 4012.6,
    altPlaneFt: 4008.2,
    raFeet: 612.7,
    aircraftAglFt: 590.2,
    aircraftAboveObstaclesFt: 551.8,
    planeAglFt: 551.7,
    planeAglMinusCgFt: 545.4,
    pressureAltFt: 4388.6,
    kohlsmanSettingMb: 1013.25,
    kohlsmanTunedMb: 1002.37,
    kohlsmanStd: true,
  });

  assert.deepEqual(payload, {
    type: 'altitude',
    msl: 4321,
    indicated: 4321,
    calibrated: 4013,
    plane: 4008,
    ra: 613,
    aircraftAgl: 590,
    aircraftAboveObstacles: 552,
    planeAgl: 552,
    planeAglMinusCg: 545,
    pressureAlt: 4389,
    kohlsmanSettingMb: 1013.25,
    kohlsmanTunedMb: 1002.37,
    kohlsmanStd: true,
  });
});

test('fuel broadcasts retain simulator-provided total fuel mass', () => {
  const payload = buildFuelBroadcastPayload({ totalGal: 410.4, totalWeightLbs: 2801.6, totalPct: 42.2 });
  assert.deepEqual(payload, {
    type: 'fuel',
    totalGal: 410,
    totalWeightLbs: 2802,
    totalPct: 42,
  });
});

test('fuel broadcasts support X-Plane authoritative mass without invented gallons', () => {
  const payload = buildFuelBroadcastPayload({ totalGal: null, totalWeightLbs: 11023.1 });
  assert.deepEqual(payload, {
    type: 'fuel',
    totalGal: null,
    totalWeightLbs: 11023,
    totalPct: null,
  });
});

test('assessAutopilotReliability trusts SDK only after payload data is present', () => {
  const reliable = assessAutopilotReliability({
    profile: { id: 'test-sdk-aircraft', dataSource: { preferred: 'sdk' } },
    sdkConnected: true,
    sdkHasData: true,
  });

  assert.equal(reliable.apReliable, true);
  assert.equal(reliable.athrReliable, true);
  assert.equal(reliable.reason, 'sdk-connected');
});

test('assessAutopilotReliability does not mark empty SDK frames as profile-confirmed', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const unreliable = assessAutopilotReliability({
      profile: { id: 'test-sdk-aircraft', dataSource: { preferred: 'sdk' } },
      sdkConnected: true,
      sdkHasData: false,
    });

    assert.equal(unreliable.apReliable, false);
    assert.equal(unreliable.athrReliable, false);
    assert.equal(unreliable.reason, 'lvar-sidecar-absent:test-sdk-aircraft');
  } finally {
    console.warn = originalWarn;
  }
});

test('assessAutopilotReliability does not treat unrelated SDK payloads as AP data', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const unreliable = assessAutopilotReliability({
      profile: { id: 'test-sdk-aircraft', dataSource: { preferred: 'sdk' } },
      sdkConnected: true,
      sdkHasData: true,
      sdkHasAutomationData: false,
    });

    assert.equal(unreliable.apReliable, false);
    assert.equal(unreliable.athrReliable, false);
    assert.equal(unreliable.reason, 'lvar-sidecar-absent:test-sdk-aircraft');
  } finally {
    console.warn = originalWarn;
  }
});

test('assessAutopilotReliability keeps SimConnect-only profiles reliable without SDK data', () => {
  const reliable = assessAutopilotReliability({
    profile: { id: 'generic', dataSource: { preferred: 'simconnect' } },
    sdkConnected: true,
    sdkHasData: false,
  });

  assert.equal(reliable.apReliable, true);
  assert.equal(reliable.athrReliable, true);
  assert.equal(reliable.reason, 'simconnect-only');
});

test('assessAutopilotReliability can suppress generic SimConnect AP readback per profile', () => {
  const unreliable = assessAutopilotReliability({
    profile: {
      id: 'inibuilds-tristar',
      dataSource: { preferred: 'simconnect' },
      integration: {
        telemetry: {
          autopilot: { simVarReliable: false },
        },
      },
    },
  });

  assert.equal(unreliable.apReliable, false);
  assert.equal(unreliable.athrReliable, true);
  assert.equal(unreliable.reason, 'simconnect-ap-unreliable:inibuilds-tristar');
});

test('buildAutopilotBroadcastPayload masks unreliable AP booleans but keeps selector values', () => {
  const payload = buildAutopilotBroadcastPayload({
    apMaster: false,
    apFdActive: false,
    apHdgHold: false,
    apAltHold: true,
    apHdgTargetDeg: 271,
    apAltTargetFt: 30800,
  }, {
    apReliable: false,
    athrReliable: true,
    reason: 'simconnect-ap-unreliable:inibuilds-tristar',
  });

  assert.equal(payload?.master, null);
  assert.equal(payload?.fdActive, null);
  assert.equal(payload?.hdgHold, null);
  assert.equal(payload?.altHold, null);
  assert.equal(payload?.hdgTarget, 271);
  assert.equal(payload?.altTarget, 30800);
  assert.equal(payload?.apReliable, false);
});

test('buildAutopilotBroadcastPayload treats blank selected V/S sentinels as unavailable', () => {
  const payload = buildAutopilotBroadcastPayload({
    apVsTargetFpm: -20000,
  }, {
    apReliable: true,
    athrReliable: true,
    reason: 'simconnect-only',
  });

  assert.equal(payload?.vsTarget, null);
});

test('assessAutopilotReliability treats SimConnect-preferred profile LVARs as optional enhancements', () => {
  const reliable = assessAutopilotReliability({
    profile: {
      id: 'fbw-a32nx',
      dataSource: {
        preferred: 'simconnect',
        lvars: {
          autopilot: 'A32NX_AUTOPILOT_1_ACTIVE',
          autothrottle: 'A32NX_AUTOTHRUST_STATUS',
        },
      },
    },
    lvarSidecarConnected: true,
    lvarHasAutopilotData: false,
    lvarHasAutothrottleData: false,
  });

  assert.equal(reliable.apReliable, true);
  assert.equal(reliable.athrReliable, true);
  assert.equal(reliable.reason, 'simconnect-only');
});

test('assessAutopilotReliability requires populated LVAR AP and A/THR values', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const unreliable = assessAutopilotReliability({
      profile: {
        id: 'fenix-a320',
        dataSource: {
          preferred: 'fenix',
          lvars: {
            autopilot: 'I_FCU_AP1',
            autothrottle: 'I_FCU_ATHR',
          },
        },
      },
      lvarSidecarConnected: true,
      lvarHasAutopilotData: false,
      lvarHasAutothrottleData: false,
      lvarSource: { status: 'running' },
    });

    assert.equal(unreliable.apReliable, false);
    assert.equal(unreliable.athrReliable, false);
    assert.equal(unreliable.reason, 'lvar-sidecar-running:fenix-a320');
  } finally {
    console.warn = originalWarn;
  }
});

test('assessAutopilotReliability treats false LVAR AP and A/THR values as reliable data', () => {
  const reliable = assessAutopilotReliability({
    profile: {
      id: 'fenix-a320',
      dataSource: {
        preferred: 'fenix',
        lvars: {
          autopilot: 'I_FCU_AP1',
          autothrottle: 'I_FCU_ATHR',
        },
      },
    },
    lvarSidecarConnected: true,
    lvarHasAutopilotData: true,
    lvarHasAutothrottleData: true,
  });

  assert.equal(reliable.apReliable, true);
  assert.equal(reliable.athrReliable, true);
  assert.equal(reliable.reason, 'lvar-sidecar-connected');
});

test('assessAutopilotReliability trusts MCP LVAR automation without requiring AP master LVARs', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const partial = assessAutopilotReliability({
      profile: {
        id: 'fenix-a320',
        dataSource: {
          preferred: 'fenix',
          lvars: {
            mcp: {
              lnav: 'I_FCU_LNAV',
              vnav: 'I_FCU_VNAV',
            },
          },
        },
      },
      lvarSidecarConnected: true,
      lvarHasAutomationData: true,
      lvarHasModeSelectorData: true,
      lvarHasAutopilotData: false,
      lvarHasAutothrottleData: false,
      lvarSource: { status: 'running' },
    });

    assert.equal(partial.apReliable, true);
    assert.equal(partial.athrReliable, false);
    assert.equal(partial.reason, 'lvar-sidecar-running:fenix-a320');
  } finally {
    console.warn = originalWarn;
  }
});

test('assessAutopilotReliability does not treat A/T-only LVAR data as AP MCP evidence', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const partial = assessAutopilotReliability({
      profile: {
        id: 'fenix-a320',
        dataSource: {
          preferred: 'fenix',
          lvars: {
            autothrottle: 'I_FCU_ATHR',
            mcp: {
              lnav: 'I_FCU_LNAV',
              vnav: 'I_FCU_VNAV',
            },
          },
        },
      },
      lvarSidecarConnected: true,
      lvarHasAutomationData: true,
      lvarHasModeSelectorData: false,
      lvarHasAutopilotData: false,
      lvarHasAutothrottleData: true,
      lvarSource: { status: 'running' },
    });

    assert.equal(partial.apReliable, false);
    assert.equal(partial.athrReliable, true);
    assert.equal(partial.reason, 'lvar-sidecar-running:fenix-a320');
  } finally {
    console.warn = originalWarn;
  }
});

test('assessAutopilotReliability handles partial LVAR AP and A/THR availability independently', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const partial = assessAutopilotReliability({
      profile: {
        id: 'fenix-a320',
        dataSource: {
          preferred: 'fenix',
          lvars: {
            autopilot: 'I_FCU_AP1',
            autothrottle: 'I_FCU_ATHR',
          },
        },
      },
      lvarSidecarConnected: true,
      lvarHasAutopilotData: true,
      lvarHasAutothrottleData: false,
      lvarSource: { status: 'running' },
    });

    assert.equal(partial.apReliable, true);
    assert.equal(partial.athrReliable, false);
    assert.equal(partial.reason, 'lvar-sidecar-running:fenix-a320');
  } finally {
    console.warn = originalWarn;
  }
});

test('telemetry senders skip absent payloads and tolerate unavailable transports', () => {
  const { sendAttitude, sendSurface, sendAutopilot } = require('../../events/broadcasters');
  const reliability = { apReliable: true, athrReliable: true, reason: 'simconnect-only' };
  const cases = [
    [sendAttitude, { valid: true, pitchDeg: 2.5, bankDeg: -1 }],
    [sendSurface, { onGround: true, valid: false, raw: null, name: null, class: 'unknown', runwayLike: false }],
    [sendAutopilot, { apMaster: false, athrArmed: false }],
  ];
  for (const [send, payload] of cases) {
    const messages = [];
    for (const missing of [null, undefined]) send((message) => messages.push(message), missing, { reliability });
    assert.deepEqual(messages, []);
    assert.doesNotThrow(() => send(null, payload, { reliability }));
    assert.doesNotThrow(() => send(() => { throw new Error('transport closed'); }, payload, { reliability }));
  }
});

test('attitude and surface senders preserve unknown data instead of inventing valid readings', () => {
  const { sendAttitude, sendSurface } = require('../../events/broadcasters');
  const messages = [];
  const surface = { onGround: true, valid: false, raw: null, name: null, class: 'unknown', runwayLike: false };
  sendAttitude((message) => messages.push(message), { valid: false, pitchDeg: null, bankDeg: null });
  sendSurface((message) => messages.push(message), surface);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'attitude');
  assert.equal(messages[0].valid, false);
  assert.equal(messages[0].pitchDeg, null);
  assert.equal(messages[0].bankDeg, null);
  assert.deepEqual(messages[1], { type: 'surface', value: surface });
});

test('autopilot sender preserves precomputed recording reliability over other context', () => {
  const { sendAutopilot } = require('../../events/broadcasters');
  const messages = [];
  const reliability = { apReliable: false, athrReliable: true, reason: 'recorded-source-unavailable' };
  const ap = { apMaster: true, athrArmed: false, apHdgTargetDeg: 271 };
  sendAutopilot((message) => messages.push(message), ap, { reliability, sdkConnected: true, sdkHasAutomationData: true });
  sendAutopilot((message) => messages.push(message), ap, { reliability });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], messages[1]);
  assert.equal(messages[1].master, null);
  assert.equal(messages[1].athrArmed, false);
  assert.equal(messages[1].hdgTarget, 271);
  assert.equal(messages[1].reliabilityReason, reliability.reason);
});

test('autopilot sender still computes reliability when none is supplied', () => {
  const { sendAutopilot } = require('../../events/broadcasters');
  const messages = [];
  sendAutopilot((message) => messages.push(message), { apMaster: false, athrArmed: false }, {
    profile: { id: 'generic', dataSource: { preferred: 'simconnect' } },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].master, false);
  assert.equal(messages[0].athrArmed, false);
  assert.equal(messages[0].apReliable, true);
  assert.equal(messages[0].athrReliable, true);
  assert.equal(messages[0].reliabilityReason, 'simconnect-only');
});

export {};
