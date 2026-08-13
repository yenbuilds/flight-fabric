'use strict';

import type { AircraftIntegrationAction } from '../types.js';

const LIGHT_COOLDOWN_MS = 750;
const SELECTOR_COOLDOWN_MS = 300;
const READBACK_TIMEOUT_MS = 3000;

const actions: Record<string, AircraftIntegrationAction> = {};

function fixedEventAction(params: {
  actionId: string;
  event: string;
  expectedValue: boolean;
  fieldId: string;
  groupId: string;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: LIGHT_COOLDOWN_MS,
      groupId: `inibuildsTristar.${params.groupId}`,
      retry: 'never',
    },
    routes: [{
      id: `inibuildsTristar.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: params.event,
        value: 0,
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

function momentaryEventAction(params: {
  actionId: string;
  event: string;
  groupId: string;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: SELECTOR_COOLDOWN_MS,
      groupId: `inibuildsTristar.${params.groupId}`,
      retry: 'never',
      skipIfSatisfied: false,
    },
    routes: [{
      id: `inibuildsTristar.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: params.event,
        value: 0,
      }],
      confirmation: 'transport-acknowledged',
    }],
    verification: 'untested',
  };
}

for (const light of [
  {
    id: 'landing',
    fieldId: 'lights.landing',
    offEvent: 'LANDING_LIGHTS_OFF',
    onEvent: 'LANDING_LIGHTS_ON',
  },
  {
    id: 'taxi',
    fieldId: 'lights.taxi',
    offEvent: 'TAXI_LIGHTS_OFF',
    onEvent: 'TAXI_LIGHTS_ON',
  },
  {
    id: 'strobe',
    fieldId: 'lights.strobe',
    offEvent: 'STROBES_OFF',
    onEvent: 'STROBES_ON',
  },
  {
    id: 'beacon',
    fieldId: 'lights.beacon',
    offEvent: 'BEACON_LIGHTS_OFF',
    onEvent: 'BEACON_LIGHTS_ON',
  },
  {
    id: 'nav',
    fieldId: 'lights.nav',
    offEvent: 'NAV_LIGHTS_OFF',
    onEvent: 'NAV_LIGHTS_ON',
  },
  {
    id: 'wing',
    fieldId: 'lights.wing',
    offEvent: 'WING_LIGHTS_OFF',
    onEvent: 'WING_LIGHTS_ON',
  },
] as const) {
  for (const state of [
    { suffix: 'setOff', expectedValue: false, event: light.offEvent },
    { suffix: 'setOn', expectedValue: true, event: light.onEvent },
  ] as const) {
    const actionId = `lights.${light.id}.${state.suffix}`;
    actions[actionId] = fixedEventAction({
      actionId,
      event: state.event,
      expectedValue: state.expectedValue,
      fieldId: light.fieldId,
      groupId: `lights.${light.id}`,
    });
  }
}

// iniBuilds publishes only a toggle event for the logo lights. The provider's
// fresh preflight readback makes these explicit intents safe and idempotent: a
// same-state request is acknowledged without firing the toggle.
for (const state of [
  { suffix: 'setOff', expectedValue: false },
  { suffix: 'setOn', expectedValue: true },
] as const) {
  const actionId = `lights.logo.${state.suffix}`;
  actions[actionId] = fixedEventAction({
    actionId,
    event: 'TOGGLE_LOGO_LIGHTS',
    expectedValue: state.expectedValue,
    fieldId: 'lights.logo',
    groupId: 'lights.logo',
  });
}

for (const selector of [
  {
    id: 'afcs.speed',
    decreaseEvent: 'AP_SPD_VAR_DEC',
    increaseEvent: 'AP_SPD_VAR_INC',
  },
  {
    id: 'afcs.heading',
    decreaseEvent: 'HEADING_BUG_DEC',
    increaseEvent: 'HEADING_BUG_INC',
  },
  {
    id: 'afcs.altitude',
    decreaseEvent: 'AP_ALT_VAR_DEC',
    increaseEvent: 'AP_ALT_VAR_INC',
  },
  {
    id: 'afcs.verticalSpeed',
    decreaseEvent: 'AP_VS_VAR_DEC',
    increaseEvent: 'AP_VS_VAR_INC',
  },
  {
    id: 'navigation.course1',
    decreaseEvent: 'VOR1_OBI_DEC',
    increaseEvent: 'VOR1_OBI_INC',
  },
  {
    id: 'navigation.course2',
    decreaseEvent: 'VOR2_OBI_DEC',
    increaseEvent: 'VOR2_OBI_INC',
  },
] as const) {
  for (const direction of [
    { suffix: 'decrease', event: selector.decreaseEvent },
    { suffix: 'increase', event: selector.increaseEvent },
  ] as const) {
    const actionId = `${selector.id}.${direction.suffix}`;
    actions[actionId] = momentaryEventAction({
      actionId,
      event: direction.event,
      groupId: selector.id,
    });
  }
}

const INIBUILDS_TRISTAR_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze(actions);

module.exports = {
  INIBUILDS_TRISTAR_ACTIONS,
};

export {};
