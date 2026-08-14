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
      groupId: `microsoft737Max8.${params.groupId}`,
      retry: 'never',
      ...(params.skipIfSatisfied === false ? { skipIfSatisfied: false } : {}),
    },
    routes: [{
      id: `microsoft737Max8.${params.actionId}.simconnectSequence`,
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
}): AircraftIntegrationAction {
  const operation: SimConnectSequenceOperation = {
    type: 'event',
    name: params.event,
    inputValue: { source: 'input' },
    ...(params.eventParameters ? { parameters: params.eventParameters } : {}),
  };
  return {
    id: params.actionId,
    input: params.input,
    guard: {
      cooldownMs: SELECTOR_COOLDOWN_MS,
      groupId: `microsoft737Max8.${params.groupId}`,
      retry: 'never',
    },
    routes: [{
      id: `microsoft737Max8.${params.actionId}.simconnectSequence`,
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
      groupId: `microsoft737Max8.${params.groupId}`,
      retry: 'never',
      skipIfSatisfied: false,
    },
    routes: [{
      id: `microsoft737Max8.${params.actionId}.simconnectSequence`,
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

// The included MSFS 2024 737 MAX 8 has no published Boeing-specific cockpit
// input catalogue. This compact first write layer therefore uses only the
// documented standard key events whose standard-SimVar readbacks are already
// in this exact-profile adapter. Toggle-only FD and A/T ARM requests remain
// target-state actions: fresh same-state readback makes them safe no-ops.
for (const [prefix, fieldId, offEvent, onEvent] of [
  ['flightGuidance.apMaster', 'afds.apMaster', 'AUTOPILOT_OFF', 'AUTOPILOT_ON'],
  ['flightGuidance.flightDirector', 'afds.flightDirector', 'TOGGLE_FLIGHT_DIRECTOR', 'TOGGLE_FLIGHT_DIRECTOR'],
  ['flightGuidance.autothrottleArmed', 'afds.autothrottleArmed', 'AUTO_THROTTLE_ARM', 'AUTO_THROTTLE_ARM'],
  ['flightGuidance.speedHold', 'afds.speed', 'AP_AIRSPEED_OFF', 'AP_AIRSPEED_ON'],
  ['flightGuidance.headingHold', 'afds.headingSelect', 'AP_HDG_HOLD_OFF', 'AP_HDG_HOLD_ON'],
  ['flightGuidance.altitudeHold', 'afds.altitudeHold', 'AP_ALT_HOLD_OFF', 'AP_ALT_HOLD_ON'],
  ['flightGuidance.verticalSpeedHold', 'afds.verticalSpeed', 'AP_VS_OFF', 'AP_VS_ON'],
  ['flightGuidance.navHold', 'afds.lnav', 'AP_NAV1_HOLD_OFF', 'AP_NAV1_HOLD_ON'],
  ['flightGuidance.approachHold', 'afds.approach', 'AP_APR_HOLD_OFF', 'AP_APR_HOLD_ON'],
  ['flightGuidance.flightLevelChange', 'afds.levelChange', 'FLIGHT_LEVEL_CHANGE_OFF', 'FLIGHT_LEVEL_CHANGE_ON'],
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

for (const [actionId, fieldId, event, input] of [
  ['flightGuidance.speed.set', 'mcp.speedKts', 'AP_SPD_VAR_SET', { type: 'number', min: 100, max: 399, step: 1 }],
  ['flightGuidance.heading.set', 'mcp.headingDeg', 'HEADING_BUG_SET', { type: 'number', min: 0, max: 359, step: 1 }],
  ['flightGuidance.altitude.set', 'mcp.altitudeFt', 'AP_ALT_VAR_SET_ENGLISH', { type: 'number', min: 0, max: 49000, step: 100 }],
  ['flightGuidance.verticalSpeed.set', 'mcp.verticalSpeedFpm', 'AP_VS_VAR_SET_ENGLISH', { type: 'number', min: -6000, max: 6000, step: 100 }],
] as const) {
  actions[actionId] = numericEventAction({
    actionId,
    event,
    eventParameters: [0],
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

for (const [actionId, expectedValue, eventValue] of [
  ['controls.parkingBrake.off', false, 0],
  ['controls.parkingBrake.on', true, 1],
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

const MICROSOFT_737_MAX_8_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze(actions);

module.exports = {
  MICROSOFT_737_MAX_8_ACTIONS,
};

export {};
