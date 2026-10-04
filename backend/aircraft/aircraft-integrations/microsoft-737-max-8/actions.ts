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
        ...(params.fieldId === 'lights.wing' ? { freshness: 'field' as const } : {}),
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

// Most routes use documented standard events. The POSITION light selector's
// native route below was established separately on the loaded passenger preset.
// Toggle-only FD and A/T ARM requests remain
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
    // The passenger MCP displays slot 3; slots 0/1 acknowledge without moving it.
    eventParameters: [actionId === 'flightGuidance.altitude.set' ? 3 : 0],
    fieldId,
    groupId: actionId.replace(/\.set$/, ''),
    input,
  });
}

for (const [lightId, event] of [
  ['beacon', 'BEACON_LIGHTS_SET'],
  ['logo', 'LOGO_LIGHTS_SET'],
  ['wing', 'WING_LIGHTS_SET'],
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

// Standard NAV/strobe events acknowledged without effect in the passenger
// preset. User-set STEADY and STROBE & STEADY read 0 and 2; native round trips
// established 1/OFF, 0/STEADY and 2/STROBE & STEADY with independent lamp
// readback. Preserve the other output of this shared selector: NAV requires
// strobes OFF, and strobes require NAV ON. Unknown state sends nothing.
// See docs/MICROSOFT-737-MAX-PROFILE-VALIDATION.md.
for (const [lightId, suffix, value, expectedValue, preservedField, preservedValue] of [
  ['nav', 'on', 0, true, 'lights.strobe', false],
  ['nav', 'off', 1, false, 'lights.strobe', false],
  ['strobe', 'on', 2, true, 'lights.nav', true],
  ['strobe', 'off', 0, false, 'lights.nav', true],
] as const) {
  const id = `lights.${lightId}.${suffix}`;
  actions[id] = {
    id,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: 'microsoft737Max8.lights.position',
      retry: 'never',
      skipIfSatisfied: false,
      requires: [{ fieldId: preservedField, expectedValue: preservedValue, freshness: 'field' }],
    },
    routes: [{
      id: `microsoft737Max8.${id}.native`,
      transport: 'input-event',
      inputEvent: 'LIGHTING_POSITION_LIGHT',
      value,
      readback: { fieldId: `lights.${lightId}`, expectedValue, timeoutMs: READBACK_TIMEOUT_MS, freshness: 'field' },
    }],
    verification: 'untested',
  };
}

// Native one-side probes established 0/ON, 1/OFF detents. Confirm the aircraft's
// scoped selector mirrors: lamp outputs also illuminate with TAXI AUTO and
// cannot prove the fixed switch positions. Confirm both fields under one lock.
for (const [suffix, value, expectedValue] of [['on', 0, true], ['off', 1, false]] as const) {
  const id = `lights.landing.${suffix}`;
  actions[id] = {
    id,
    guard: { cooldownMs: DEFAULT_COOLDOWN_MS, groupId: 'microsoft737Max8.lights.landing', retry: 'never', skipIfSatisfied: false },
    routes: [{
      id: `microsoft737Max8.${id}.native`, transport: 'input-event',
      events: [
        { inputEvent: 'LIGHTING_LANDING_LIGHT_FIXED_L', value },
        { inputEvent: 'LIGHTING_LANDING_LIGHT_FIXED_R', value },
      ],
      readbacks: ['lights.landingLeft', 'lights.landingRight'].map(fieldId => ({
        fieldId, expectedValue, timeoutMs: READBACK_TIMEOUT_MS, freshness: 'field' as const,
      })),
    }],
    verification: 'untested',
  };
}

// Standard TAXI_LIGHTS_SET also moves both turnoff and wheel-well switches.
// The native GEAR selector controls only the nose-gear light (ON index 3).
for (const [suffix, value, expectedValue] of [['on', 0, true], ['off', 1, false]] as const) {
  const id = `lights.taxi.${suffix}`;
  actions[id] = {
    id,
    guard: { cooldownMs: DEFAULT_COOLDOWN_MS, groupId: 'microsoft737Max8.lights.taxi', retry: 'never', skipIfSatisfied: false },
    routes: [{
      id: `microsoft737Max8.${id}.native`, transport: 'input-event',
      inputEvent: 'LIGHTING_TAXI_LIGHT_GEAR', value,
      readback: { fieldId: 'lights.taxi', expectedValue, timeoutMs: READBACK_TIMEOUT_MS, freshness: 'field' },
    }],
    verification: 'untested',
  };
}

// Presets explicitly request both outputs of POSITION in one operation.
// Individual NAV/strobe commands retain their preservation preconditions.
for (const [position, value, strobe] of [['steady', 0, false], ['strobeAndSteady', 2, true]] as const) {
  const id = `lights.position.${position}`;
  actions[id] = {
    id,
    guard: { cooldownMs: DEFAULT_COOLDOWN_MS, groupId: 'microsoft737Max8.lights.position', retry: 'never', skipIfSatisfied: false },
    routes: [{
      id: `microsoft737Max8.${id}.native`, transport: 'input-event', inputEvent: 'LIGHTING_POSITION_LIGHT', value,
      readbacks: [
        { fieldId: 'lights.nav', expectedValue: true, timeoutMs: READBACK_TIMEOUT_MS, freshness: 'field' },
        { fieldId: 'lights.strobe', expectedValue: strobe, timeoutMs: READBACK_TIMEOUT_MS, freshness: 'field' },
      ],
    }],
    verification: 'untested',
  };
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
