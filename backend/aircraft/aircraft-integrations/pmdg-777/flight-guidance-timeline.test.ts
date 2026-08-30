'use strict';

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  createPmdg777FlightGuidanceProjector,
  pmdgFlightGuidanceEventMatchesAutomation,
} = require('./flight-guidance-timeline.js') as {
  createPmdg777FlightGuidanceProjector: (_options?: Record<string, unknown>) => {
    consume: (_row: Record<string, unknown>) => void;
    finish: () => Record<string, any>;
  };
  pmdgFlightGuidanceEventMatchesAutomation: (
    _automationEvent: Record<string, unknown>,
    _guidanceEvent: Record<string, unknown>,
  ) => boolean;
};

const FIELD_TYPES = Object.freeze({
  'flightGuidance.apEngaged': 'boolean',
  'flightGuidance.autothrottleArmed': 'boolean',
  'flightGuidance.lnav': 'boolean',
  'flightGuidance.vnav': 'boolean',
  'flightGuidance.flch': 'boolean',
  'flightGuidance.headingHold': 'boolean',
  'flightGuidance.verticalSpeed': 'boolean',
  'flightGuidance.altitudeHold': 'boolean',
  'flightGuidance.localizer': 'boolean',
  'flightGuidance.approach': 'boolean',
  'flightGuidance.speedKts': 'number',
  'flightGuidance.mach': 'number',
  'flightGuidance.headingDeg': 'number',
  'flightGuidance.altitudeFt': 'number',
  'flightGuidance.vsFpm': 'number',
  'flightGuidance.fpaDeg': 'number',
  'flightGuidance.headingMode': 'enum',
  'flightGuidance.verticalMode': 'enum',
});

function createProjector(options: Record<string, unknown> = {}) {
  const projector = createPmdg777FlightGuidanceProjector(options);
  projector.consume({
    schemaVersion: 2,
    seq: 1,
    type: 'aircraft_specific_manifest',
    timeMs: 1_700_000_000_000,
    flightStartIso: new Date(1_700_000_000_000).toISOString(),
    flightElapsedMs: 0,
  });
  projector.consume({
    schemaVersion: 2,
    seq: 2,
    type: 'aircraft_specific_config',
    flightElapsedMs: 0,
    configId: 1,
    profileKey: 'bundled/msfs/pmdg-777',
    integrationId: 'pmdg-777',
    templateId: 'pmdg-777',
    fieldTypes: FIELD_TYPES,
  });
  return projector;
}

function connectedCheckpoint(
  projector: ReturnType<typeof createProjector>,
  flightElapsedMs: number,
  values: Record<string, unknown>,
) {
  projector.consume({
    schemaVersion: 2,
    type: 'aircraft_specific_checkpoint',
    flightElapsedMs,
    configId: 1,
    sourceStatus: { overall: 'connected', sources: { sdk: 'connected' } },
    available: true,
    values,
    unavailable: Object.keys(FIELD_TYPES).filter((fieldId) => !Object.prototype.hasOwnProperty.call(values, fieldId)),
  });
}

test('establishes a silent baseline and emits a stable conservative LOC selection', () => {
  const projector = createProjector();
  connectedCheckpoint(projector, 0, {
    'flightGuidance.localizer': false,
    'flightGuidance.headingMode': 'HDG',
    'flightGuidance.verticalMode': 'VS',
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 100,
    configId: 1,
    valuesSet: { 'flightGuidance.localizer': true },
  });
  connectedCheckpoint(projector, 700, {
    'flightGuidance.localizer': true,
    'flightGuidance.headingMode': 'HDG',
    'flightGuidance.verticalMode': 'VS',
  });

  const result = projector.finish();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].label, 'LOC selected');
  assert.equal(result.events[0].eventType, 'guidance_mode_selected');
  assert.equal(result.events[0].flightElapsedMs, 100);
  assert.equal(result.events[0].confirmedAtElapsedMs, 700);
  assert.equal(JSON.stringify(result.events).includes('captured'), false);
});

test('covers the requested PMDG AFDS selections with conservative labels', () => {
  const projector = createProjector();
  const baseline = {
    'flightGuidance.apEngaged': false,
    'flightGuidance.autothrottleArmed': false,
    'flightGuidance.lnav': false,
    'flightGuidance.vnav': false,
    'flightGuidance.flch': false,
    'flightGuidance.headingHold': false,
    'flightGuidance.verticalSpeed': false,
    'flightGuidance.altitudeHold': false,
    'flightGuidance.localizer': false,
    'flightGuidance.approach': false,
    'flightGuidance.headingMode': 'HDG',
    'flightGuidance.verticalMode': 'VS',
  };
  connectedCheckpoint(projector, 0, baseline);
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 100,
    configId: 1,
    valuesSet: Object.fromEntries(
      Object.keys(baseline)
        .filter((fieldId) => typeof baseline[fieldId as keyof typeof baseline] === 'boolean')
        .map((fieldId) => [fieldId, true]),
    ),
  });
  connectedCheckpoint(projector, 700, {
    ...baseline,
    ...Object.fromEntries(
      Object.keys(baseline)
        .filter((fieldId) => typeof baseline[fieldId as keyof typeof baseline] === 'boolean')
        .map((fieldId) => [fieldId, true]),
    ),
  });

  const labels = projector.finish().events.map((event: Record<string, any>) => event.label).sort();
  assert.deepEqual(labels, [
    'A/T armed',
    'ALT HOLD selected',
    'AP engaged',
    'APP selected',
    'FLCH selected',
    'HDG HOLD selected',
    'LNAV selected',
    'LOC selected',
    'V/S selected',
    'VNAV selected',
  ].sort());
});

test('drops an unstable A to B to A oscillation', () => {
  const projector = createProjector();
  connectedCheckpoint(projector, 0, { 'flightGuidance.lnav': false });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 100,
    configId: 1,
    valuesSet: { 'flightGuidance.lnav': true },
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 300,
    configId: 1,
    valuesSet: { 'flightGuidance.lnav': false },
  });
  connectedCheckpoint(projector, 1000, { 'flightGuidance.lnav': false });
  assert.deepEqual(projector.finish().events, []);
});

test('coalesces a rotary target burst to the final stable before and after values', () => {
  const projector = createProjector();
  connectedCheckpoint(projector, 0, { 'flightGuidance.altitudeFt': 12_000 });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 1000,
    configId: 1,
    valuesSet: { 'flightGuidance.altitudeFt': 11_000 },
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 2000,
    configId: 1,
    valuesSet: { 'flightGuidance.altitudeFt': 9000 },
  });
  connectedCheckpoint(projector, 4000, { 'flightGuidance.altitudeFt': 9000 });

  const result = projector.finish();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventType, 'mcp_target_changed');
  assert.equal(result.events[0].previous, 12_000);
  assert.equal(result.events[0].current, 9000);
  assert.equal(result.events[0].summary, '12,000 ft -> 9,000 ft');
  assert.equal(result.events[0].flightElapsedMs, 2000);
});

test('treats VS and FPA as discriminated targets and baselines after selector changes', () => {
  const projector = createProjector();
  connectedCheckpoint(projector, 0, {
    'flightGuidance.verticalMode': 'VS',
    'flightGuidance.vsFpm': -1000,
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 100,
    configId: 1,
    valuesSet: {
      'flightGuidance.verticalMode': 'FPA',
      'flightGuidance.fpaDeg': -3,
    },
    valuesRemoved: ['flightGuidance.vsFpm'],
    unavailableAdded: ['flightGuidance.vsFpm'],
    unavailableRemoved: ['flightGuidance.fpaDeg'],
  });
  connectedCheckpoint(projector, 700, {
    'flightGuidance.verticalMode': 'FPA',
    'flightGuidance.fpaDeg': -3,
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 1000,
    configId: 1,
    valuesSet: { 'flightGuidance.fpaDeg': -3.2 },
  });
  connectedCheckpoint(projector, 3000, {
    'flightGuidance.verticalMode': 'FPA',
    'flightGuidance.fpaDeg': -3.2,
  });

  const events = projector.finish().events;
  assert.equal(events.filter((event: Record<string, any>) => event.eventType === 'guidance_reference_changed').length, 1);
  const target = events.find((event: Record<string, any>) => event.eventType === 'mcp_target_changed');
  assert(target);
  assert.equal(target.previous, -3);
  assert.equal(target.current, -3.2);
  assert.equal(target.summary, '-3.0 deg -> -3.2 deg');
  assert.equal(events.some((event: Record<string, any>) => event.previous === -1000 && event.current === -3), false);
});

test('source loss and recovery establish a new baseline without a false AP event', () => {
  const projector = createProjector();
  connectedCheckpoint(projector, 0, { 'flightGuidance.apEngaged': true });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 100,
    configId: 1,
    valuesRemoved: ['flightGuidance.apEngaged'],
    unavailableAdded: ['flightGuidance.apEngaged'],
    sourceStatusChanged: {
      overall: 'disconnected',
      sourcesSet: { sdk: 'disconnected' },
    },
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 500,
    configId: 1,
    valuesSet: { 'flightGuidance.apEngaged': false },
    unavailableRemoved: ['flightGuidance.apEngaged'],
    sourceStatusChanged: {
      overall: 'connected',
      sourcesSet: { sdk: 'connected' },
    },
  });
  connectedCheckpoint(projector, 1200, { 'flightGuidance.apEngaged': false });
  const result = projector.finish();
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.coverage.map((interval: Record<string, any>) => [
    interval.startElapsedMs,
    interval.endElapsedMs,
  ]), [[0, 100], [500, 1200]]);
});

test('normalizes heading wrap and caps optional events without failing projection', () => {
  const projector = createProjector({ modeSettleMs: 0, targetSettleMs: 0, maxEvents: 1 });
  connectedCheckpoint(projector, 0, {
    'flightGuidance.headingDeg': 360,
    'flightGuidance.lnav': false,
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 100,
    configId: 1,
    valuesSet: { 'flightGuidance.headingDeg': 0, 'flightGuidance.lnav': true },
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 200,
    configId: 1,
    valuesSet: { 'flightGuidance.lnav': false },
  });
  connectedCheckpoint(projector, 300, {
    'flightGuidance.headingDeg': 0,
    'flightGuidance.lnav': false,
  });

  const result = projector.finish();
  assert.equal(result.events.some((event: Record<string, any>) => event.target === 'heading'), false);
  assert.equal(result.events.length, 1);
  assert.equal(result.truncatedCount, 1);
  assert.equal(result.coverage.length, 1);
});

test('bounds fresh-source coverage intervals and emits nothing outside retained coverage', () => {
  const projector = createProjector({
    modeSettleMs: 0,
    maxCoverageIntervals: 1,
  });
  connectedCheckpoint(projector, 0, { 'flightGuidance.lnav': false });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 100,
    configId: 1,
    sourceStatusChanged: {
      overall: 'disconnected',
      sourcesSet: { sdk: 'disconnected' },
    },
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 200,
    configId: 1,
    sourceStatusChanged: {
      overall: 'connected',
      sourcesSet: { sdk: 'connected' },
    },
    valuesSet: { 'flightGuidance.lnav': false },
  });
  projector.consume({
    type: 'aircraft_specific_delta',
    flightElapsedMs: 300,
    configId: 1,
    valuesSet: { 'flightGuidance.lnav': true },
  });
  connectedCheckpoint(projector, 400, { 'flightGuidance.lnav': true });

  const result = projector.finish();
  assert.equal(result.coverage.length, 1);
  assert.equal(result.coverageTruncatedCount, 1);
  assert.deepEqual(result.events, []);
});

test('dedupe matching requires the corresponding exact PMDG event', () => {
  assert.equal(pmdgFlightGuidanceEventMatchesAutomation(
    { eventType: 'loc_captured', current: true },
    { eventType: 'guidance_mode_selected', mode: 'LOC' },
  ), true);
  assert.equal(pmdgFlightGuidanceEventMatchesAutomation(
    { eventType: 'vertical_mode_changed', current: 'LVL_CHG' },
    { eventType: 'guidance_mode_selected', mode: 'FLCH' },
  ), true);
  assert.equal(pmdgFlightGuidanceEventMatchesAutomation(
    { eventType: 'ap_engaged', current: true },
    { eventType: 'guidance_mode_selected', mode: 'LOC' },
  ), false);
});
