'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationNumberInput,
  AircraftIntegrationPrimitive,
  SimConnectSequenceOperation,
} from '../types.js';

const DEFAULT_COOLDOWN_MS = 500;
const SELECTOR_COOLDOWN_MS = 300;
const DEFAULT_READBACK_TIMEOUT_MS = 3000;

function setLvarAction(params: {
  actionId: string;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  lvar: string;
  rawValue: number;
}): AircraftIntegrationAction {
  const routeStem = `iniA350.${params.actionId}`;
  const readback = {
    fieldId: params.fieldId,
    expectedValue: params.expectedValue,
    timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
  } as const;
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [
      {
        id: `${routeStem}.mobiflight`,
        transport: 'mobiflight-calculator',
        code: `${params.rawValue} (>L:${params.lvar}, Number)`,
        readback,
      },
      {
        id: `${routeStem}.lvar`,
        transport: 'lvar',
        lvar: `L:${params.lvar}`,
        unit: 'Number',
        value: params.rawValue,
        readback,
      },
    ],
    verification: 'untested',
  };
}

function numericLvarAction(params: {
  actionId: string;
  fieldId: string;
  groupId: string;
  input: AircraftIntegrationNumberInput;
  lvar: string;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    input: params.input,
    guard: {
      cooldownMs: SELECTOR_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [{
      id: `iniA350.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{
        type: 'lvar',
        name: `L:${params.lvar}`,
        unit: 'Number',
        inputValue: { source: 'input' },
      }],
      readback: {
        fieldId: params.fieldId,
        expectedInput: true,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

function eventAction(params: {
  actionId: string;
  event: string;
  eventValue: number;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [{
      id: `iniA350.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{ type: 'event', name: params.event, value: params.eventValue }],
      readback: {
        fieldId: params.fieldId,
        expectedValue: params.expectedValue,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
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
      groupId: params.groupId,
      retry: 'never',
      skipIfSatisfied: false,
    },
    routes: [{
      id: `iniA350.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [{ type: 'event', name: params.event, value: 0 }],
      readback: {
        fieldId: params.fieldId,
        confirmation: 'changed',
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

function numericEventAction(params: {
  actionId: string;
  event: string;
  fieldId: string;
  groupId: string;
  input: AircraftIntegrationNumberInput;
  inputValue?: SimConnectSequenceOperation & { inputValue: { source: 'input' } };
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    input: params.input,
    guard: {
      cooldownMs: SELECTOR_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [{
      id: `iniA350.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: [params.inputValue || {
        type: 'event',
        name: params.event,
        inputValue: { source: 'input' },
      }],
      readback: {
        fieldId: params.fieldId,
        expectedInput: true,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

const actions: Record<string, AircraftIntegrationAction> = {};

function addBooleanActions(params: {
  fieldId: string;
  groupId: string;
  lvar: string;
  prefix: string;
}): void {
  for (const [suffix, rawValue, expectedValue] of [
    ['off', 0, false],
    ['on', 1, true],
  ] as const) {
    const actionId = `${params.prefix}.${suffix}`;
    actions[actionId] = setLvarAction({
      actionId,
      expectedValue,
      fieldId: params.fieldId,
      groupId: params.groupId,
      lvar: params.lvar,
      rawValue,
    });
  }
}

function addDetentActions(params: {
  fieldId: string;
  groupId: string;
  lvar: string;
  positions: ReadonlyArray<Readonly<{ id: string; rawValue: number; value: string }>>;
  prefix: string;
}): void {
  for (const position of params.positions) {
    const actionId = `${params.prefix}.${position.id}`;
    actions[actionId] = setLvarAction({
      actionId,
      expectedValue: position.value,
      fieldId: params.fieldId,
      groupId: params.groupId,
      lvar: params.lvar,
      rawValue: position.rawValue,
    });
  }
}

for (const [actionId, fieldId, lvar, input] of [
  ['flightGuidance.speed.set', 'flightGuidance.speedValue', 'INI_AIRSPEED_DIAL', { type: 'number', min: 100, max: 399, step: 1 }],
  ['flightGuidance.heading.set', 'flightGuidance.headingDeg', 'INI_HEADING_DIAL', { type: 'number', min: 0, max: 359, step: 1 }],
  ['flightGuidance.altitude.set', 'flightGuidance.altitudeFt', 'INI_ALTITUDE_DIAL', { type: 'number', min: 0, max: 49000, step: 100 }],
  ['flightGuidance.verticalSpeed.set', 'flightGuidance.verticalSpeedFpm', 'INI_VVI_DIAL', { type: 'number', min: -6000, max: 6000, step: 100 }],
] as const) {
  actions[actionId] = numericLvarAction({
    actionId,
    fieldId,
    groupId: `iniA350.${actionId.replace(/\.set$/, '')}`,
    input,
    lvar,
  });
}

for (const control of [
  ['flightGuidance.flightDirector', 'INI_FD_ON', 'flightGuidance.flightDirector'],
  ['flightGuidance.lsCaptain', 'INI_LS_CAPTAIN', 'flightGuidance.lsCaptain'],
  ['flightGuidance.lsFirstOfficer', 'INI_LS_FO', 'flightGuidance.lsFirstOfficer'],
  ['flightGuidance.verticalViewCaptain', 'INI_VV_LEFT', 'flightGuidance.verticalViewCaptain'],
  ['flightGuidance.verticalViewFirstOfficer', 'INI_VV_RIGHT', 'flightGuidance.verticalViewFirstOfficer'],
  ['flightGuidance.metricAltitude', 'INI_FCU_METRIC_STATE', 'flightGuidance.metricAltitude'],
] as const) {
  addBooleanActions({
    fieldId: control[0],
    groupId: `iniA350.${control[2]}`,
    lvar: control[1],
    prefix: control[2],
  });
}

addDetentActions({
  fieldId: 'lights.strobeMode',
  groupId: 'iniA350.lights.strobe',
  lvar: 'INI_LIGHTS_STROBE',
  prefix: 'lights.strobe',
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'auto', rawValue: 1, value: 'auto' },
    { id: 'on', rawValue: 2, value: 'on' },
  ],
});
addBooleanActions({
  fieldId: 'lights.beacon',
  groupId: 'iniA350.lights.beacon',
  lvar: 'INI_LIGHTS_BEACON',
  prefix: 'lights.beacon',
});
addDetentActions({
  fieldId: 'lights.navMode',
  groupId: 'iniA350.lights.nav',
  lvar: 'INI_LIGHTS_NAV',
  prefix: 'lights.nav',
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'nav2', rawValue: 1, value: 'nav2' },
    { id: 'nav1', rawValue: 2, value: 'nav1' },
  ],
});
addDetentActions({
  fieldId: 'lights.logoMode',
  groupId: 'iniA350.lights.logo',
  lvar: 'INI_LIGHTS_LOGO',
  prefix: 'lights.logo',
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'auto', rawValue: 1, value: 'auto' },
    { id: 'on', rawValue: 2, value: 'on' },
  ],
});
for (const control of [
  ['lights.wing', 'INI_LIGHTS_WING', 'lights.wing'],
  ['lights.landing', 'INI_LIGHTS_LANDING', 'lights.landing'],
] as const) {
  addBooleanActions({
    fieldId: control[0],
    groupId: `iniA350.${control[2]}`,
    lvar: control[1],
    prefix: control[2],
  });
}
addDetentActions({
  fieldId: 'lights.noseMode',
  groupId: 'iniA350.lights.nose',
  lvar: 'INI_LIGHTS_NOSE',
  prefix: 'lights.nose',
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'taxi', rawValue: 1, value: 'taxi' },
    { id: 'takeoff', rawValue: 2, value: 'takeoff' },
  ],
});

for (const control of [
  ['cabin.seatBeltsMode', 'INI_SEATBELTS_SWITCH', 'cabin.seatBelts'],
  ['cabin.noSmokingMode', 'INI_NO_SMOKING_SWITCH', 'cabin.noSmoking'],
  ['cabin.noMobileMode', 'INI_SIGNS_NO_MOBILE', 'cabin.noMobile'],
] as const) {
  addDetentActions({
    fieldId: control[0],
    groupId: `iniA350.${control[2]}`,
    lvar: control[1],
    prefix: control[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'auto', rawValue: 1, value: 'auto' },
      { id: 'on', rawValue: 2, value: 'on' },
    ],
  });
}
addDetentActions({
  fieldId: 'cabin.emergencyExitMode',
  groupId: 'iniA350.cabin.emergencyExit',
  lvar: 'INI_EMER_EXIT_SWITCH',
  prefix: 'cabin.emergencyExit',
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'arm', rawValue: 1, value: 'arm' },
    { id: 'on', rawValue: 2, value: 'on' },
  ],
});

addBooleanActions({
  fieldId: 'systems.apuMaster',
  groupId: 'iniA350.systems.apuMaster',
  lvar: 'INI_APU_MASTER_SWITCH',
  prefix: 'systems.apuMaster',
});
actions['systems.apuStart.start'] = setLvarAction({
  actionId: 'systems.apuStart.start',
  expectedValue: true,
  fieldId: 'systems.apuStart',
  groupId: 'iniA350.systems.apuStart',
  lvar: 'INI_APU_START_BUTTON',
  rawValue: 1,
});
addDetentActions({
  fieldId: 'systems.airFlowMode',
  groupId: 'iniA350.systems.airFlow',
  lvar: 'INI_AIR_FLOW_MODE',
  prefix: 'systems.airFlow',
  positions: [
    { id: 'manual', rawValue: 0, value: 'manual' },
    { id: 'low', rawValue: 1, value: 'low' },
    { id: 'normal', rawValue: 2, value: 'normal' },
    { id: 'high', rawValue: 3, value: 'high' },
  ],
});
addDetentActions({
  fieldId: 'systems.crossBleedMode',
  groupId: 'iniA350.systems.crossBleed',
  lvar: 'INI_AIR_X_BLEED',
  prefix: 'systems.crossBleed',
  positions: [
    { id: 'closed', rawValue: 0, value: 'closed' },
    { id: 'auto', rawValue: 1, value: 'auto' },
    { id: 'open', rawValue: 2, value: 'open' },
  ],
});
for (const control of [
  ['systems.ramAir', 'INI_RAM_AIR_STATE', 'systems.ramAir'],
  ['systems.wingAntiIce', 'INI_WING_ANTI_ICE1_STATE', 'systems.wingAntiIce'],
] as const) {
  addBooleanActions({
    fieldId: control[0],
    groupId: `iniA350.${control[2]}`,
    lvar: control[1],
    prefix: control[2],
  });
}
addDetentActions({
  fieldId: 'systems.probeWindowHeatMode',
  groupId: 'iniA350.systems.probeWindowHeat',
  lvar: 'INI_PROBE_WINDOW_HEAT1_STATE',
  prefix: 'systems.probeWindowHeat',
  positions: [
    { id: 'auto', rawValue: 0, value: 'auto' },
    { id: 'on', rawValue: 1, value: 'on' },
  ],
});

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
    groupId: 'iniA350.controls.gear',
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
    groupId: 'iniA350.controls.flaps',
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
      groupId: `iniA350.${prefix}`,
    });
  }
}
actions['controls.speedbrake.set'] = numericEventAction({
  actionId: 'controls.speedbrake.set',
  event: 'SPOILERS_SET',
  fieldId: 'controls.speedbrakePercent',
  groupId: 'iniA350.controls.speedbrake',
  input: { type: 'number', min: 0, max: 100, step: 1 },
  inputValue: {
    type: 'event',
    name: 'SPOILERS_SET',
    inputValue: { source: 'input', scale: 163.83, round: 'nearest' },
  },
});

const INIBUILDS_A350_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = Object.freeze(actions);

module.exports = {
  INIBUILDS_A350_ACTIONS,
};

export {};
