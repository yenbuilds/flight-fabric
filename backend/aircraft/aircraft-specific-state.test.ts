'use strict';

const assert = require('node:assert/strict');

const {
  buildAircraftSpecificState,
  createAircraftSpecificStateProjector,
  decodeAircraftSpecificValue,
} = require('./aircraft-specific-state.js') as {
  buildAircraftSpecificState: (params: Record<string, any>) => Record<string, any>;
  createAircraftSpecificStateProjector: (params: Record<string, any>) => Record<string, any>;
  decodeAircraftSpecificValue: (rawValue: unknown, decoder: Record<string, any>) => unknown;
};
const {
  createAircraftSpecificBindingResolverRegistry,
} = require('./aircraft-specific-binding-resolvers.js') as {
  createAircraftSpecificBindingResolverRegistry: (resolvers?: Record<string, any>[]) => Record<string, any>;
};

let passed = 0;

function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const config = {
  profileKey: 'bundled/msfs/test-sdk-aircraft',
  profileRevision: 7,
  templateId: 'test-sdk-aircraft',
  fields: [
    { id: 'mcp.altitudeFt', source: { type: 'lvar', key: 'selected_altitude' }, decode: { type: 'number', precision: 0 } },
    { id: 'afds.cmdA', source: { type: 'lvar', key: 'ap_channel_a' }, decode: { type: 'boolean', trueValues: [1], falseValues: [0] } },
    { id: 'afds.cmdB', source: { type: 'lvar', key: 'ap_channel_b' }, decode: { type: 'boolean', trueValues: [1], falseValues: [0] } },
  ],
};

function connectedFrame(updatedAt = '2026-07-13T02:00:00.000Z') {
  return {
    simconnect: { connected: true },
    lvars: {
      enabled: true,
      profileId: config.profileKey,
      status: 'running',
      updatedAt,
      values: {
        selected_altitude: 12000.4,
        ap_channel_a: 1,
        ap_channel_b: 0,
      },
    },
  };
}

test('strict decoders preserve explicit false and reject implicit truthiness', () => {
  const booleanDecoder = { type: 'boolean', trueValues: [1], falseValues: [0] };
  assert.equal(decodeAircraftSpecificValue(1, booleanDecoder), true);
  assert.equal(decodeAircraftSpecificValue(0, booleanDecoder), false);
  assert.equal(decodeAircraftSpecificValue(2, booleanDecoder), undefined);
  assert.equal(decodeAircraftSpecificValue('1', booleanDecoder), undefined);
  assert.equal(decodeAircraftSpecificValue(12.345, { type: 'number', precision: 1 }), 12.3);
  assert.equal(decodeAircraftSpecificValue(-999, {
    type: 'number',
    scale: 10,
    offset: 1,
    unavailableValues: [-999],
  }), undefined, 'raw number sentinels must be rejected before transforms');
  assert.equal(decodeAircraftSpecificValue(-998.9, {
    type: 'number',
    unavailableValues: [-999],
  }), -998.9, 'sentinel matching must remain exact');
});

test('number sentinels become canonical unavailable fields instead of recorded values', () => {
  const sentinelConfig = {
    profileKey: 'bundled/msfs/tfdi-md-11',
    profileRevision: 8,
    integrationId: 'tfdi-md-11',
    templateId: 'tfdi-md-11',
    fields: [
      {
        id: 'afs.speedValue',
        source: { type: 'test-sentinel', rawValue: -999 },
        decode: { type: 'number', precision: 3, unavailableValues: [-999] },
      },
      {
        id: 'afs.headingValue',
        source: { type: 'test-sentinel', rawValue: -999 },
        decode: { type: 'number', precision: 0, unavailableValues: [-999] },
      },
      {
        id: 'afs.verticalValue',
        source: { type: 'test-sentinel', rawValue: -9999 },
        decode: { type: 'number', precision: 1, unavailableValues: [-9999] },
      },
      {
        id: 'afs.altitudeValue',
        source: { type: 'test-sentinel', rawValue: 12000 },
        decode: { type: 'number', precision: 0 },
      },
    ],
  };
  const state = buildAircraftSpecificState({
    config: sentinelConfig,
    nowEpochMs: 1_000,
    resolverRegistry: {
      resolve: (binding: Record<string, any>) => ({
        sourceId: 'lvar',
        status: 'connected',
        rawValue: binding.rawValue,
      }),
    },
  });

  assert.deepEqual(state.values, { 'afs.altitudeValue': 12000 });
  assert.deepEqual(state.unavailable, [
    'afs.speedValue',
    'afs.headingValue',
    'afs.verticalValue',
  ]);
  assert.equal(state.available, true, 'other usable fields keep the aircraft state available');
});

test('strict SimVar bindings project only approved normalized frame paths', () => {
  const resolverRegistry = createAircraftSpecificBindingResolverRegistry();
  const beaconBinding = resolverRegistry.compile(
    { type: 'simvar', name: 'LIGHT BEACON', unit: 'Bool' },
    { fieldId: 'lights.beacon', sourcePath: 'test' },
  );
  assert.deepEqual(beaconBinding, {
    type: 'simvar',
    name: 'LIGHT BEACON',
    path: 'lights.beacon',
    unit: 'Bool',
  });
  assert.equal(resolverRegistry.compile(
    { type: 'simvar', name: 'UNREVIEWED DYNAMIC VALUE', unit: 'Number' },
    { fieldId: 'test.unreviewed', sourcePath: 'test' },
  ), null);

  const altitudeBinding = resolverRegistry.compile(
    { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    { fieldId: 'flightGuidance.altitudeFt', sourcePath: 'test' },
  );
  assert.deepEqual(altitudeBinding, {
    type: 'simvar',
    name: 'AUTOPILOT ALTITUDE LOCK VAR',
    path: 'fdm.apAltTargetFt',
    unit: 'Feet',
  });

  const engine3N1Binding = resolverRegistry.compile(
    { type: 'simvar', name: 'TURB ENG N1:3', unit: 'Percent' },
    { fieldId: 'systems.engine3N1', sourcePath: 'test' },
  );
  const engine3RunningBinding = resolverRegistry.compile(
    { type: 'simvar', name: 'ENG COMBUSTION:3', unit: 'Bool' },
    { fieldId: 'systems.engine3Running', sourcePath: 'test' },
  );
  const engine4N1Binding = resolverRegistry.compile(
    { type: 'simvar', name: 'TURB ENG N1:4', unit: 'Percent' },
    { fieldId: 'systems.engine4N1', sourcePath: 'test' },
  );
  const engine4RunningBinding = resolverRegistry.compile(
    { type: 'simvar', name: 'ENG COMBUSTION:4', unit: 'Bool' },
    { fieldId: 'systems.engine4Running', sourcePath: 'test' },
  );
  assert.deepEqual(engine3N1Binding, {
    type: 'simvar',
    name: 'TURB ENG N1:3',
    path: 'fdm.eng3N1',
    unit: 'Percent',
  });
  assert.deepEqual(engine3RunningBinding, {
    type: 'simvar',
    name: 'ENG COMBUSTION:3',
    path: 'fdm.eng3Running',
    unit: 'Bool',
  });
  assert.deepEqual(engine4N1Binding, {
    type: 'simvar',
    name: 'TURB ENG N1:4',
    path: 'fdm.eng4N1',
    unit: 'Percent',
  });
  assert.deepEqual(engine4RunningBinding, {
    type: 'simvar',
    name: 'ENG COMBUSTION:4',
    path: 'fdm.eng4Running',
    unit: 'Bool',
  });

  const fourEngineMessage = buildAircraftSpecificState({
    config: {
      profileKey: 'bundled/msfs/workingtitle-747-8',
      profileRevision: 1,
      templateId: 'workingtitle-747-8',
      fields: [
        {
          id: 'systems.engine4N1',
          source: engine4N1Binding,
          decode: { type: 'number', precision: 1 },
        },
        {
          id: 'systems.engine4Running',
          source: engine4RunningBinding,
          decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
        },
      ],
    },
    frame: {
      simconnect: { connected: true },
      fdm: { eng4N1: 87.64, eng4Running: true },
    },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-15T02:00:00.000Z'),
    resolverRegistry,
  });
  assert.deepEqual(fourEngineMessage.values, {
    'systems.engine4N1': 87.6,
    'systems.engine4Running': true,
  });

  const message = buildAircraftSpecificState({
    config: {
      profileKey: 'bundled/msfs/fbw-a32nx',
      profileRevision: 1,
      templateId: 'fbw-a32nx',
      fields: [{
        id: 'lights.beacon',
        source: beaconBinding,
        decode: { type: 'boolean', trueValues: [true], falseValues: [false] },
      }],
    },
    frame: { simconnect: { connected: true }, lights: { beacon: false } },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-15T02:00:00.000Z'),
    resolverRegistry,
  });
  assert.deepEqual(message.values, { 'lights.beacon': false });
  assert.deepEqual(message.sourceStatus, { overall: 'connected', sources: { simvar: 'connected' } });

  const a330Message = buildAircraftSpecificState({
    config: {
      profileKey: 'bundled/msfs/inibuilds-a330',
      profileRevision: 2,
      templateId: 'inibuilds-a330',
      fields: [
        {
          id: 'flightGuidance.altitudeFt',
          source: altitudeBinding,
          decode: { type: 'number', precision: 0 },
        },
        {
          id: 'flightGuidance.apMaster',
          source: resolverRegistry.compile(
            { type: 'simvar', name: 'AUTOPILOT MASTER', unit: 'Bool' },
            { fieldId: 'flightGuidance.apMaster', sourcePath: 'test' },
          ),
          decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
        },
      ],
    },
    frame: {
      simconnect: { connected: true },
      fdm: { apAltTargetFt: 37000.4, apMaster: false },
    },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-15T02:00:00.000Z'),
    resolverRegistry,
  });
  assert.deepEqual(a330Message.values, {
    'flightGuidance.altitudeFt': 37000,
    'flightGuidance.apMaster': false,
  });

  const tristarMessage = buildAircraftSpecificState({
    config: {
      profileKey: 'bundled/msfs/inibuilds-tristar',
      profileRevision: 3,
      templateId: 'inibuilds-tristar',
      fields: [
        {
          id: 'systems.engine3N1',
          source: engine3N1Binding,
          decode: { type: 'number', precision: 1 },
        },
        {
          id: 'systems.engine3Running',
          source: engine3RunningBinding,
          decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
        },
      ],
    },
    frame: {
      simconnect: { connected: true },
      fdm: { eng3N1: 91.24, eng3Running: 0 },
    },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-18T02:00:00.000Z'),
    resolverRegistry,
  });
  assert.deepEqual(tristarMessage.values, {
    'systems.engine3N1': 91.2,
    'systems.engine3Running': false,
  });
});

test('TriStar standard A-var gauge bindings preserve zero and omit unavailable samples', () => {
  const resolverRegistry = createAircraftSpecificBindingResolverRegistry();
  const registeredRows: Record<string, string> = {};
  const runtimeKeys: Record<string, string> = {
    'A:TURB ENG PRESSURE RATIO:3': 'tristar_engine3_epr',
    'A:NAV OBS:1': 'tristar_course1',
    'A:TURB ENG FUEL FLOW PPH:2': 'tristar_engine2_fuel_flow',
  };
  const registerLvar = (generatedKey: string, rawValue: unknown) => {
    registeredRows[generatedKey] = String(rawValue);
    return runtimeKeys[String(rawValue)] || null;
  };
  const compile = (id: string, name: string, unit: string) => resolverRegistry.compile(
    { type: 'lvar', name, unit },
    { fieldId: id, sourcePath: `integration.fields.${id}`, registerLvar },
  );
  const eprBinding = compile('systems.engine3Epr', 'A:TURB ENG PRESSURE RATIO:3', 'Ratio');
  const courseBinding = compile('navigation.course1Deg', 'A:NAV OBS:1', 'Degrees');
  const fuelFlowBinding = compile(
    'systems.engine2FuelFlowPph',
    'A:TURB ENG FUEL FLOW PPH:2',
    'Pounds per hour',
  );

  assert.deepEqual(eprBinding, { type: 'lvar', key: 'tristar_engine3_epr' });
  assert.deepEqual(courseBinding, { type: 'lvar', key: 'tristar_course1' });
  assert.deepEqual(fuelFlowBinding, { type: 'lvar', key: 'tristar_engine2_fuel_flow' });
  assert.equal(
    registeredRows.aircraft_specific_systems_engine3_epr,
    'A:TURB ENG PRESSURE RATIO:3',
  );
  assert.equal(registeredRows.aircraft_specific_navigation_course1_deg, 'A:NAV OBS:1');

  const updatedAt = '2026-08-12T02:00:00.000Z';
  const message = buildAircraftSpecificState({
    config: {
      profileKey: 'bundled/msfs/inibuilds-tristar',
      profileRevision: 8,
      templateId: 'inibuilds-tristar',
      fields: [
        {
          id: 'systems.engine3Epr',
          source: eprBinding,
          decode: { type: 'number', precision: 2 },
        },
        {
          id: 'navigation.course1Deg',
          source: courseBinding,
          decode: { type: 'number', precision: 0 },
        },
        {
          id: 'systems.engine2FuelFlowPph',
          source: fuelFlowBinding,
          decode: { type: 'number', precision: 0 },
        },
      ],
    },
    frame: {
      simconnect: { connected: true },
      lvars: {
        enabled: true,
        profileId: 'bundled/msfs/inibuilds-tristar',
        status: 'running',
        updatedAt,
        values: {
          tristar_engine3_epr: 0,
          tristar_course1: 0,
          // A missing sample is unavailable; it must not be coerced to zero.
        },
      },
    },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse(updatedAt),
    resolverRegistry,
  });

  assert.deepEqual(message.values, {
    'systems.engine3Epr': 0,
    'navigation.course1Deg': 0,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(message.values, 'systems.engine2FuelFlowPph'), false);
  assert.equal(message.unavailable.includes('systems.engine2FuelFlowPph'), true);
});

test('LVAR mode-light projection preserves false and rejects unexpected values', () => {
  const resolverRegistry = createAircraftSpecificBindingResolverRegistry();
  const registeredRows: Record<string, string> = {};
  const registerLvar = (generatedKey: string, rawValue: unknown) => {
    registeredRows[generatedKey] = String(rawValue);
    if (rawValue === 'L:FF_TEST_AP_LIGHT') return 'autopilot';
    if (rawValue === 'L:FF_TEST_LNAV_LIGHT') return 'mode_lnav';
    return null;
  };
  const cmdABinding = resolverRegistry.compile(
    { type: 'lvar', name: 'L:FF_TEST_AP_LIGHT', unit: 'Number' },
    { fieldId: 'afds.cmdA', sourcePath: 'test', registerLvar },
  );
  const lnavBinding = resolverRegistry.compile(
    { type: 'lvar', name: 'L:FF_TEST_LNAV_LIGHT', unit: 'Number' },
    { fieldId: 'afds.lnav', sourcePath: 'test', registerLvar },
  );
  const altitudeBinding = resolverRegistry.compile(
    { type: 'simvar', name: 'AUTOPILOT ALTITUDE LOCK VAR', unit: 'Feet' },
    { fieldId: 'mcp.altitudeFt', sourcePath: 'test' },
  );

  assert.deepEqual(cmdABinding, { type: 'lvar', key: 'autopilot' });
  assert.deepEqual(lnavBinding, { type: 'lvar', key: 'mode_lnav' });
  assert.equal(registeredRows.aircraft_specific_afds_cmd_a, 'L:FF_TEST_AP_LIGHT');
  assert.equal(registeredRows.aircraft_specific_afds_lnav, 'L:FF_TEST_LNAV_LIGHT');

  const message = buildAircraftSpecificState({
    config: {
      profileKey: 'bundled/msfs/ifly-737-max-8',
      profileRevision: 4,
      templateId: 'ifly-737-max-8',
      fields: [
        {
          id: 'afds.cmdA',
          source: cmdABinding,
          decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
        },
        {
          id: 'afds.lnav',
          source: lnavBinding,
          decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
        },
        {
          id: 'mcp.altitudeFt',
          source: altitudeBinding,
          decode: { type: 'number', precision: 0 },
        },
      ],
    },
    frame: {
      simconnect: { connected: true },
      fdm: { apAltTargetFt: 18000.4 },
      lvars: {
        enabled: true,
        profileId: 'bundled/msfs/ifly-737-max-8',
        status: 'running',
        updatedAt: '2026-07-17T02:00:00.000Z',
        values: { autopilot: 0, mode_lnav: 2 },
      },
    },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-17T02:00:01.000Z'),
    resolverRegistry,
  });

  assert.deepEqual(message.values, {
    'afds.cmdA': false,
    'mcp.altitudeFt': 18000,
  });
  assert.deepEqual(message.unavailable, ['afds.lnav']);
  assert.deepEqual(message.sourceStatus, {
    overall: 'connected',
    sources: { lvar: 'connected', simvar: 'connected' },
  });
  assert.equal(JSON.stringify(message).includes('FF_TEST_AP_LIGHT'), false);
  assert.equal(JSON.stringify(message).includes('mode_lnav'), false);
});

test('connected projection publishes only logical fields and keeps false values', () => {
  const message = buildAircraftSpecificState({
    config,
    frame: connectedFrame(),
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-13T02:00:01.000Z'),
    timestampIso: '2026-07-13T02:00:01.000Z',
    actionCapabilities: { 'apu.start': true, invalid: 'yes' },
    dependencies: {
      mobiflightEventModule: {
        required: true,
        fallbackActive: false,
        connected: false,
        status: 'missing',
        scope: 'all-controls',
        error: 'must not cross the browser boundary',
      },
      forgedDependency: { required: true },
    },
  });

  assert.equal(message.type, 'aircraftSpecificState');
  assert.equal(message.available, true);
  assert.deepEqual(message.values, {
    'mcp.altitudeFt': 12000,
    'afds.cmdA': true,
    'afds.cmdB': false,
  });
  assert.deepEqual(message.unavailable, []);
  assert.deepEqual(message.sourceStatus, { overall: 'connected', sources: { lvar: 'connected' } });
  assert.deepEqual(message.actionCapabilities, { 'apu.start': true });
  assert.deepEqual(message.dependencies, {
    mobiflightEventModule: {
      required: true,
      fallbackActive: false,
      connected: false,
      status: 'missing',
      scope: 'all-controls',
    },
  });
  assert.equal(JSON.stringify(message).includes('selected_altitude'), false);
  assert.equal(JSON.stringify(message).includes('browser boundary'), false);
});

test('stale and disconnected sources mark every field unavailable', () => {
  const stale = buildAircraftSpecificState({
    config,
    frame: connectedFrame('2026-07-13T01:59:50.000Z'),
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-13T02:00:00.000Z'),
  });
  assert.equal(stale.sourceStatus.overall, 'stale');
  assert.equal(stale.sourceStatus.sources.lvar, 'stale');
  assert.equal(stale.available, false);
  assert.deepEqual(stale.values, {});
  assert.deepEqual(stale.unavailable, config.fields.map((field) => field.id));

  const disconnected = buildAircraftSpecificState({
    config,
    frame: { ...connectedFrame(), simconnect: { connected: false } },
    simState: { simconnectConnected: false, inMenu: false },
    nowEpochMs: Date.parse('2026-07-13T02:00:00.000Z'),
  });
  assert.equal(disconnected.sourceStatus.overall, 'disconnected');
  assert.deepEqual(disconnected.values, {});
});

test('mixed providers resolve per field so a stale LVAR does not suppress healthy adapter data', () => {
  const resolverRegistry = createAircraftSpecificBindingResolverRegistry([{
    type: 'test-adapter',
    resolve(binding: Record<string, any>, context: Record<string, any>) {
      return {
        sourceId: 'test-adapter',
        status: 'connected',
        rawValue: context.frame?.testAdapter?.values?.[binding.key],
      };
    },
  }]);
  const mixedConfig = {
    ...config,
    fields: [
      config.fields[0],
      {
        id: 'electrical.apuRunning',
        source: { type: 'test-adapter', key: 'apu_running' },
        decode: { type: 'boolean', trueValues: [1], falseValues: [0] },
      },
    ],
  };
  const frame: Record<string, any> = connectedFrame('2026-07-13T01:59:50.000Z');
  frame.testAdapter = { values: { apu_running: 0 } };
  const message = buildAircraftSpecificState({
    config: mixedConfig,
    frame,
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-13T02:00:00.000Z'),
    resolverRegistry,
  });

  assert.equal(message.available, true);
  assert.equal(message.sourceStatus.overall, 'connected');
  assert.deepEqual(message.sourceStatus.sources, { lvar: 'stale', 'test-adapter': 'connected' });
  assert.deepEqual(message.values, { 'electrical.apuRunning': false });
  assert.deepEqual(message.unavailable, ['mcp.altitudeFt']);
});

test('SDK bindings read only normalized own-property paths from the active adapter snapshot', () => {
  const sdkConfig = {
    ...config,
    fields: [{
      id: 'mcp.altitudeFt',
      source: { type: 'sdk', adapterId: 'test-sdk', path: 'automation.mcp.altitudeFt' },
      decode: { type: 'number', precision: 0 },
    }],
  };
  const message = buildAircraftSpecificState({
    config: sdkConfig,
    frame: {
      simconnect: { connected: true },
      sdk: {
        adapterId: 'test-sdk',
        status: 'running',
        // Event-driven ClientData is CHANGED-only. A current-generation snapshot must
        // remain usable while the cockpit is unchanged, regardless of age.
        updatedAt: '2026-07-13T01:59:00.000Z',
        snapshotSequence: 7,
        normalized: { automation: { mcp: { altitudeFt: 18000.4 } } },
        raw: { privateVendorField: 999 },
      },
    },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-13T02:00:01.000Z'),
  });

  assert.deepEqual(message.values, { 'mcp.altitudeFt': 18000 });
  assert.deepEqual(message.sourceStatus, { overall: 'connected', sources: { sdk: 'connected' } });
  assert.equal(JSON.stringify(message).includes('privateVendorField'), false);
});

test('missing and failing resolvers fail closed without affecting the projector', () => {
  const resolverRegistry = createAircraftSpecificBindingResolverRegistry([{
    type: 'broken-adapter',
    resolve() {
      throw new Error('adapter failed');
    },
  }]);
  const unavailableConfig = {
    ...config,
    fields: [
      {
        id: 'systems.missing',
        source: { type: 'missing-adapter', key: 'value' },
        decode: { type: 'number' },
      },
      {
        id: 'systems.broken',
        source: { type: 'broken-adapter', key: 'value' },
        decode: { type: 'number' },
      },
    ],
  };
  const message = buildAircraftSpecificState({
    config: unavailableConfig,
    frame: { simconnect: { connected: true } },
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-13T02:00:01.000Z'),
    resolverRegistry,
  });

  assert.equal(message.available, false);
  assert.equal(message.sourceStatus.overall, 'error');
  assert.deepEqual(message.sourceStatus.sources, {
    'missing-adapter': 'unsupported',
    'broken-adapter': 'error',
  });
  assert.deepEqual(message.unavailable, ['systems.missing', 'systems.broken']);
});

test('stateful projector deduplicates identical values and refreshes on profile revision', () => {
  const broadcasts: Record<string, any>[] = [];
  let revision = 7;
  let activeConfig = config;
  const projector = createAircraftSpecificStateProjector({
    broadcast: (message: Record<string, any>) => broadcasts.push(message),
    profileLoader: {
      getActiveProfileRevision: () => revision,
      getAircraftSpecificConfig: () => activeConfig,
    },
  });

  const input = {
    frame: connectedFrame(),
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-13T02:00:01.000Z'),
  };
  projector.update(input);
  projector.update({ ...input, nowEpochMs: Date.parse('2026-07-13T02:00:01.100Z') });
  assert.equal(broadcasts.length, 1);

  revision = 8;
  activeConfig = { ...config, profileRevision: 8 };
  projector.update(input);
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[1].profileRevision, 8);
});

test('projector observers receive every canonical state before broadcast deduplication', () => {
  const broadcasts: Record<string, any>[] = [];
  const observations: Record<string, any>[] = [];
  let resolveCount = 0;
  const resolverRegistry = createAircraftSpecificBindingResolverRegistry([{
    type: 'counted',
    resolve(binding: Record<string, any>) {
      resolveCount += 1;
      return { sourceId: 'counted', status: 'connected', rawValue: binding.value };
    },
  }]);
  const observedConfig = {
    profileKey: 'bundled/msfs/test-aircraft',
    profileRevision: 11,
    integrationId: 'test-aircraft',
    templateId: 'test-aircraft',
    fields: [{
      id: 'systems.testValue',
      source: { type: 'counted', value: 4.24, privateVendorPath: 'L:DO_NOT_BROADCAST' },
      decode: { type: 'number', precision: 1 },
    }],
  };
  const projector = createAircraftSpecificStateProjector({
    broadcast: (message: Record<string, any>) => broadcasts.push(message),
    onStateBuilt: (state: Record<string, any>, context: Record<string, any>) => {
      observations.push({ state, context });
    },
    profileLoader: {
      getActiveProfileRevision: () => observedConfig.profileRevision,
      getAircraftSpecificConfig: () => observedConfig,
    },
    resolverRegistry,
  });

  const firstTimeMs = Date.parse('2026-07-19T03:04:05.006Z');
  const secondTimeMs = firstTimeMs + 100;
  projector.update({ nowEpochMs: firstTimeMs, timestampIso: '2026-07-19T03:04:05.006Z' });
  projector.update({ nowEpochMs: secondTimeMs, timestampIso: '2026-07-19T03:04:05.106Z' });

  assert.equal(resolveCount, 2, 'each field should be resolved exactly once per projector tick');
  assert.equal(observations.length, 2, 'observer should run even when the broadcast state is unchanged');
  assert.equal(broadcasts.length, 1, 'unchanged browser state should remain deduplicated');
  assert.equal(observations[0].state, broadcasts[0], 'observer and broadcaster should share the same decoded object');
  assert.deepEqual(observations.map(({ context }) => ({
    nowEpochMs: context.nowEpochMs,
    timestampIso: context.timestampIso,
  })), [
    { nowEpochMs: firstTimeMs, timestampIso: '2026-07-19T03:04:05.006Z' },
    { nowEpochMs: secondTimeMs, timestampIso: '2026-07-19T03:04:05.106Z' },
  ]);
  assert.equal(observations[0].context.config, observedConfig);
  assert.deepEqual(observations[0].state.values, { 'systems.testValue': 4.2 });
  assert.equal(JSON.stringify(observations[0].context).includes('privateVendorPath'), true);
  assert.equal(JSON.stringify(broadcasts[0]).includes('privateVendorPath'), false);
});

test('projector observer failures are fail-open for browser broadcasts', () => {
  const broadcasts: Record<string, any>[] = [];
  const observerErrors: unknown[] = [];
  const projector = createAircraftSpecificStateProjector({
    broadcast: (message: Record<string, any>) => broadcasts.push(message),
    onStateBuilt: () => {
      throw new Error('recorder unavailable');
    },
    onStateObserverError: (error: unknown) => observerErrors.push(error),
    profileLoader: {
      getActiveProfileRevision: () => config.profileRevision,
      getAircraftSpecificConfig: () => config,
    },
  });

  projector.update({
    frame: connectedFrame(),
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: Date.parse('2026-07-19T04:00:00.000Z'),
  });

  assert.equal(observerErrors.length, 1);
  assert.match(String(observerErrors[0]), /recorder unavailable/);
  assert.equal(broadcasts.length, 1);
});

test('projector observers clear the last supported state when the active profile becomes unsupported', () => {
  const broadcasts: Record<string, any>[] = [];
  const observations: Array<{ state: Record<string, any>; context: Record<string, any> }> = [];
  const supportedConfig = {
    profileKey: 'bundled/msfs/test-supported',
    profileRevision: 20,
    integrationId: 'test-supported',
    templateId: 'test-supported',
    fields: [{
      id: 'systems.testValue',
      source: { type: 'lvar', key: 'selected_altitude' },
      decode: { type: 'number' },
    }],
  };
  const unsupportedConfig = {
    profileKey: 'generic',
    profileRevision: 21,
    integrationId: null,
    templateId: null,
    fields: [],
  };
  let activeConfig = supportedConfig;
  const projector = createAircraftSpecificStateProjector({
    broadcast: (message: Record<string, any>) => broadcasts.push(message),
    onStateBuilt: (state: Record<string, any>, context: Record<string, any>) => observations.push({ state, context }),
    profileLoader: {
      getActiveProfileRevision: () => activeConfig.profileRevision,
      getAircraftSpecificConfig: () => activeConfig,
    },
  });

  projector.update({
    frame: connectedFrame(),
    simState: { simconnectConnected: true, inMenu: false },
    nowEpochMs: 1000,
  });
  activeConfig = unsupportedConfig;
  projector.update({ nowEpochMs: 1100 });
  projector.update({ nowEpochMs: 1200 });

  assert.equal(observations.length, 2, 'unsupported transition should notify exactly once');
  assert.deepEqual(observations[1].state.values, {});
  assert.deepEqual(observations[1].state.unavailable, ['systems.testValue']);
  assert.equal(observations[1].state.available, false);
  assert.equal(observations[1].state.sourceStatus.overall, 'unsupported');
  assert.equal(observations[1].context.config, supportedConfig, 'clear event must retain the persisted field catalog');
  assert.equal(broadcasts.length, 1, 'synthetic recorder clear should not revive a retired UI template');
});

console.log(`PASS aircraft-specific-state ${passed}`);

export {};
