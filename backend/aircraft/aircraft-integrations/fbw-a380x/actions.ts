'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationNumberInput,
  AircraftIntegrationPrimitive,
  SimConnectSequenceOperation,
} from '../types.js';

const DEFAULT_COOLDOWN_MS = 750;
const SELECTOR_COOLDOWN_MS = 300;
const READBACK_TIMEOUT_MS = 3000;

const actions: Record<string, AircraftIntegrationAction> = {};

function eventAction(params: {
  actionId: string;
  event: string;
  eventParameters?: readonly number[];
  eventValue: number;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  cooldownMs?: number;
  skipIfSatisfied?: boolean;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: params.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      groupId: `fbwA380x.${params.groupId}`,
      retry: 'never',
      ...(params.skipIfSatisfied === false ? { skipIfSatisfied: false } : {}),
    },
    routes: [{
      id: `fbwA380x.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: params.event,
        value: params.eventValue,
        ...(params.eventParameters ? { parameters: params.eventParameters } : {}),
      }],
      readback: {
        fieldId: params.fieldId,
        expectedValue: params.expectedValue,
        timeoutMs: READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

function numericEventAction(params: {
  actionId: string;
  event: string;
  eventParameters?: readonly number[];
  fieldId: string;
  groupId: string;
  input: AircraftIntegrationNumberInput;
  inputValue?: Readonly<{
    round?: 'nearest';
    scale?: number;
    source: 'input';
  }>;
}): AircraftIntegrationAction {
  const operation: SimConnectSequenceOperation = {
    type: 'event',
    name: params.event,
    inputValue: params.inputValue || { source: 'input' },
    ...(params.eventParameters ? { parameters: params.eventParameters } : {}),
  };
  return {
    id: params.actionId,
    input: params.input,
    guard: {
      cooldownMs: SELECTOR_COOLDOWN_MS,
      groupId: `fbwA380x.${params.groupId}`,
      retry: 'never',
    },
    routes: [{
      id: `fbwA380x.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [operation],
      readback: {
        fieldId: params.fieldId,
        expectedInput: true,
        timeoutMs: READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

function relativeEventAction(params: {
  actionId: string;
  event: string;
  fieldId: string;
  groupId: string;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: SELECTOR_COOLDOWN_MS,
      groupId: `fbwA380x.${params.groupId}`,
      retry: 'never',
      skipIfSatisfied: false,
    },
    routes: [{
      id: `fbwA380x.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{ type: 'event', name: params.event, value: 0 }],
      readback: {
        fieldId: params.fieldId,
        confirmation: 'changed',
        timeoutMs: READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

// The A380X exposes AP1 and A/THR state directly. The vendor AP1, LOC and APPR
// inputs are toggle events, so explicit targets depend on a fresh logical
// readback and skip an already-satisfied request before dispatch.
for (const [prefix, fieldId, offEvent, onEvent] of [
  ['flightGuidance.ap1', 'flightGuidance.ap1', 'A32NX.FCU_AP_1_PUSH', 'A32NX.FCU_AP_1_PUSH'],
  ['flightGuidance.autothrust', 'flightGuidance.autothrust', 'AUTO_THROTTLE_DISCONNECT', 'AUTO_THROTTLE_ARM'],
  ['flightGuidance.localizer', 'flightGuidance.localizer', 'AP_LOC_HOLD', 'AP_LOC_HOLD'],
  ['flightGuidance.approach', 'flightGuidance.approach', 'AP_APR_HOLD', 'AP_APR_HOLD'],
] as const) {
  for (const [suffix, expectedValue, event] of [
    ['off', false, offEvent],
    ['on', true, onEvent],
  ] as const) {
    const actionId = `${prefix}.${suffix}`;
    actions[actionId] = eventAction({
      actionId,
      event,
      eventValue: 0,
      expectedValue,
      fieldId,
      groupId: prefix,
    });
  }
}

for (const [actionId, fieldId, event, eventParameters, input] of [
  [
    'flightGuidance.speed.set',
    'flightGuidance.speedValue',
    'AP_SPD_VAR_SET',
    [0],
    { type: 'number', min: 100, max: 399, step: 1 },
  ],
  [
    'flightGuidance.heading.set',
    'flightGuidance.headingDeg',
    'HEADING_BUG_SET',
    [0],
    { type: 'number', min: 0, max: 359, step: 1 },
  ],
  [
    'flightGuidance.altitude.set',
    'flightGuidance.altitudeFt',
    'AP_ALT_VAR_SET_ENGLISH',
    [3],
    { type: 'number', min: 0, max: 49000, step: 100 },
  ],
] as const) {
  actions[actionId] = numericEventAction({
    actionId,
    event,
    eventParameters,
    fieldId,
    groupId: actionId.replace(/\.set$/, ''),
    input,
  });
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
  for (const [suffix, expectedValue, eventValue] of [
    ['off', false, 0],
    ['on', true, 1],
  ] as const) {
    const actionId = `lights.${lightId}.${suffix}`;
    actions[actionId] = eventAction({
      actionId,
      event,
      eventParameters: [0],
      eventValue,
      expectedValue,
      fieldId: `lights.${lightId}`,
      groupId: `lights.${lightId}`,
      skipIfSatisfied: false,
    });
  }
}

for (const [actionId, expectedValue, eventValue] of [
  ['controls.parkingBrake.released', false, 0],
  ['controls.parkingBrake.set', true, 1],
] as const) {
  actions[actionId] = eventAction({
    actionId,
    event: 'PARKING_BRAKE_SET',
    eventValue,
    expectedValue,
    fieldId: 'controls.parkingBrake',
    groupId: 'controls.parkingBrake',
  });
}

for (const [suffix, expectedValue, event] of [
  ['off', false, 'SPOILERS_ARM_OFF'],
  ['on', true, 'SPOILERS_ARM_ON'],
] as const) {
  const actionId = `controls.spoilersArmed.${suffix}`;
  actions[actionId] = eventAction({
    actionId,
    event,
    eventValue: 0,
    expectedValue,
    fieldId: 'controls.spoilersArmed',
    groupId: 'controls.spoilersArmed',
  });
}

actions['controls.spoilers.set'] = numericEventAction({
  actionId: 'controls.spoilers.set',
  event: 'SPOILERS_SET',
  fieldId: 'controls.spoilersHandle',
  groupId: 'controls.spoilers',
  input: { type: 'number', min: 0, max: 1, step: 0.25 },
  inputValue: { source: 'input', scale: 16383, round: 'nearest' },
});

for (const [actionId, event] of [
  ['controls.flaps.decrease', 'FLAPS_DECR'],
  ['controls.flaps.increase', 'FLAPS_INCR'],
] as const) {
  actions[actionId] = relativeEventAction({
    actionId,
    event,
    fieldId: 'controls.flapsIndex',
    groupId: 'controls.flaps',
  });
}

for (const [actionId, event, expectedValue] of [
  ['controls.gear.up', 'GEAR_UP', false],
  ['controls.gear.down', 'GEAR_DOWN', true],
] as const) {
  actions[actionId] = eventAction({
    actionId,
    event,
    eventValue: 0,
    expectedValue,
    fieldId: 'controls.gearHandleDown',
    groupId: 'controls.gear',
  });
}

const FBW_A380X_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze(actions);

module.exports = {
  FBW_A380X_ACTIONS,
};

export {};
