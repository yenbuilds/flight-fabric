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
      groupId: `inibuildsA330.${params.groupId}`,
      retry: 'never',
      ...(params.skipIfSatisfied === false ? { skipIfSatisfied: false } : {}),
    },
    routes: [{
      id: `inibuildsA330.${params.actionId}.simconnectSequence`,
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
      groupId: `inibuildsA330.${params.groupId}`,
      retry: 'never',
    },
    routes: [{
      id: `inibuildsA330.${params.actionId}.simconnectSequence`,
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
      groupId: `inibuildsA330.${params.groupId}`,
      retry: 'never',
      skipIfSatisfied: false,
    },
    routes: [{
      id: `inibuildsA330.${params.actionId}.simconnectSequence`,
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

// The included A330 does not publish an external AP1/AP2 or Airbus
// managed/selected InputEvent contract. This first write layer therefore uses
// only Microsoft-documented standard events whose normalized A-var state is
// already present in the adapter. Toggle-only FD and A/THR inputs remain safe
// explicit targets because a fresh same-state readback becomes a no-op.
for (const [prefix, fieldId, offEvent, onEvent] of [
  ['flightGuidance.apMaster', 'flightGuidance.apMaster', 'AUTOPILOT_OFF', 'AUTOPILOT_ON'],
  ['flightGuidance.flightDirector', 'flightGuidance.flightDirector', 'TOGGLE_FLIGHT_DIRECTOR', 'TOGGLE_FLIGHT_DIRECTOR'],
  ['flightGuidance.autothrottleArmed', 'flightGuidance.autothrottleArmed', 'AUTO_THROTTLE_ARM', 'AUTO_THROTTLE_ARM'],
  ['flightGuidance.speedHold', 'flightGuidance.speedHold', 'AP_AIRSPEED_OFF', 'AP_AIRSPEED_ON'],
  ['flightGuidance.headingHold', 'flightGuidance.headingHold', 'AP_HDG_HOLD_OFF', 'AP_HDG_HOLD_ON'],
  ['flightGuidance.altitudeHold', 'flightGuidance.altitudeHold', 'AP_ALT_HOLD_OFF', 'AP_ALT_HOLD_ON'],
  ['flightGuidance.verticalSpeedHold', 'flightGuidance.verticalSpeedHold', 'AP_VS_OFF', 'AP_VS_ON'],
  ['flightGuidance.navHold', 'flightGuidance.navHold', 'AP_NAV1_HOLD_OFF', 'AP_NAV1_HOLD_ON'],
  ['flightGuidance.approachHold', 'flightGuidance.approachHold', 'AP_APR_HOLD_OFF', 'AP_APR_HOLD_ON'],
  ['flightGuidance.flightLevelChange', 'flightGuidance.flightLevelChange', 'FLIGHT_LEVEL_CHANGE_OFF', 'FLIGHT_LEVEL_CHANGE_ON'],
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
  ['flightGuidance.speed.set', 'flightGuidance.speedValue', 'AP_SPD_VAR_SET', { type: 'number', min: 100, max: 399, step: 1 }],
  ['flightGuidance.heading.set', 'flightGuidance.headingDeg', 'HEADING_BUG_SET', { type: 'number', min: 0, max: 359, step: 1 }],
  ['flightGuidance.altitude.set', 'flightGuidance.altitudeFt', 'AP_ALT_VAR_SET_ENGLISH', { type: 'number', min: 0, max: 49000, step: 100 }],
  ['flightGuidance.verticalSpeed.set', 'flightGuidance.verticalSpeedFpm', 'AP_VS_VAR_SET_ENGLISH', { type: 'number', min: -6000, max: 6000, step: 100 }],
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

for (const [prefix, fieldId, offEvent, offValue, onEvent, onValue] of [
  ['controls.parkingBrake', 'controls.parkingBrake', 'PARKING_BRAKE_SET', 0, 'PARKING_BRAKE_SET', 1],
  ['controls.spoilersArmed', 'controls.spoilersArmed', 'SPOILERS_ARM_OFF', 0, 'SPOILERS_ARM_ON', 0],
] as const) {
  for (const [suffix, expectedValue, event, eventValue] of [
    ['off', false, offEvent, offValue],
    ['on', true, onEvent, onValue],
  ] as const) {
    const actionId = `${prefix}.${suffix}`;
    actions[actionId] = eventAction({
      actionId,
      event,
      eventValue,
      expectedValue,
      fieldId,
      groupId: prefix,
    });
  }
}

actions['controls.speedbrake.set'] = numericEventAction({
  actionId: 'controls.speedbrake.set',
  event: 'SPOILERS_SET',
  fieldId: 'controls.speedbrakePercent',
  groupId: 'controls.speedbrake',
  input: { type: 'number', min: 0, max: 100, step: 1 },
  inputValue: { source: 'input', scale: 163.83, round: 'nearest' },
});

const INIBUILDS_A330_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze(actions);

module.exports = {
  INIBUILDS_A330_ACTIONS,
};

export {};
