'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationActionPrecondition,
  AircraftIntegrationNumberInput,
  AircraftIntegrationPrimitive,
  SimConnectSequenceOperation,
} from '../types.js';

const DEFAULT_COOLDOWN_MS = 750;
const DEFAULT_READBACK_TIMEOUT_MS = 3000;

const actions: Record<string, AircraftIntegrationAction> = {};
const { addFbwCalibratedThrottleDetentActions } = require('../fbw-throttle-detents') as {
  addFbwCalibratedThrottleDetentActions: (params: {
    actions: Record<string, AircraftIntegrationAction>;
    adapterPrefix: 'fbwA32nx';
    leverCount: 2;
  }) => void;
};

function readback(
  fieldId: string,
  expectedValue: AircraftIntegrationPrimitive,
  timeoutMs = DEFAULT_READBACK_TIMEOUT_MS,
) {
  return {
    fieldId,
    expectedValue,
    timeoutMs,
  };
}

function setLvarAction(params: {
  actionId: string;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  lvar: string;
  rawValue: number;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: `fbwA32nx.${params.groupId}`,
      retry: 'never',
    },
    routes: [{
      id: `fbwA32nx.${params.actionId}.lvar`,
      transport: 'lvar',
      lvar: `L:${params.lvar}`,
      unit: 'Number',
      value: params.rawValue,
      readback: readback(params.fieldId, params.expectedValue),
    }],
    verification: 'untested',
  };
}

function setSequenceAction(params: {
  actionId: string;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  operations: readonly SimConnectSequenceOperation[];
  skipIfSatisfied?: boolean;
  timeoutMs?: number;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: `fbwA32nx.${params.groupId}`,
      retry: 'never',
      ...(params.skipIfSatisfied === false ? { skipIfSatisfied: false } : {}),
    },
    routes: [{
      id: `fbwA32nx.${params.actionId}.simconnectSequence`,
      transport: 'simconnect-sequence',
      operations: params.operations,
      readback: readback(params.fieldId, params.expectedValue, params.timeoutMs),
    }],
    verification: 'untested',
  };
}

function setEventAction(params: {
  actionId: string;
  event: string;
  eventValue?: number;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  timeoutMs?: number;
}): AircraftIntegrationAction {
  return setSequenceAction({
    ...params,
    operations: [{
      type: 'event',
      name: params.event,
      value: params.eventValue ?? 0,
    }],
  });
}

function setCustomEventInputAction(params: {
  actionId: string;
  event: string;
  fieldId: string;
  groupId: string;
  input: AircraftIntegrationNumberInput;
  inputOffset?: number;
  inputScale?: number;
  precondition?: AircraftIntegrationActionPrecondition;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    input: params.input,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: `fbwA32nx.${params.groupId}`,
      retry: 'never',
    },
    routes: [{
      id: `fbwA32nx.${params.actionId}.customEvent`,
      transport: 'simconnect-sequence',
      operations: [{
        type: 'event',
        name: params.event,
        inputValue: {
          source: 'input',
          ...(params.inputScale === undefined ? {} : { scale: params.inputScale }),
          ...(params.inputOffset === undefined ? {} : { offset: params.inputOffset }),
        },
      }],
      ...(params.precondition ? { precondition: params.precondition } : {}),
      readback: {
        fieldId: params.fieldId,
        expectedInput: true,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

function setCustomEventButtonAction(params: {
  actionId: string;
  event: string;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
}): AircraftIntegrationAction {
  return setEventAction({
    actionId: params.actionId,
    event: params.event,
    eventValue: 0,
    expectedValue: params.expectedValue,
    fieldId: params.fieldId,
    groupId: params.groupId,
  });
}

function addLvarPositions(params: {
  fieldId: string;
  groupId: string;
  lvar: string;
  positions: ReadonlyArray<Readonly<{
    expectedValue: AircraftIntegrationPrimitive;
    rawValue: number;
    suffix: string;
  }>>;
  prefix: string;
}): void {
  for (const position of params.positions) {
    const actionId = `${params.prefix}.${position.suffix}`;
    actions[actionId] = setLvarAction({
      actionId,
      expectedValue: position.expectedValue,
      fieldId: params.fieldId,
      groupId: params.groupId,
      lvar: params.lvar,
      rawValue: position.rawValue,
    });
  }
}

function addBooleanLvar(params: {
  falseSuffix?: string;
  fieldId: string;
  groupId?: string;
  lvar: string;
  prefix: string;
  trueSuffix?: string;
}): void {
  addLvarPositions({
    ...params,
    groupId: params.groupId || params.prefix,
    positions: [
      { suffix: params.falseSuffix || 'off', rawValue: 0, expectedValue: false },
      { suffix: params.trueSuffix || 'on', rawValue: 1, expectedValue: true },
    ],
  });
}

function addStandardDetents(params: {
  fieldId: string;
  groupId?: string;
  lvar: string;
  positions: ReadonlyArray<readonly [suffix: string, rawValue: number, expectedValue: AircraftIntegrationPrimitive]>;
  prefix: string;
}): void {
  addLvarPositions({
    ...params,
    groupId: params.groupId || params.prefix,
    positions: params.positions.map(([suffix, rawValue, expectedValue]) => ({
      expectedValue,
      rawValue,
      suffix,
    })),
  });
}

function addBooleanEvent(params: {
  event: string;
  falseSuffix?: string;
  fieldId: string;
  groupId?: string;
  offEvent?: string;
  offValue?: number;
  onEvent?: string;
  onValue?: number;
  prefix: string;
  trueSuffix?: string;
}): void {
  for (const target of [
    {
      suffix: params.falseSuffix || 'off',
      expectedValue: false,
      event: params.offEvent || params.event,
      eventValue: params.offValue,
    },
    {
      suffix: params.trueSuffix || 'on',
      expectedValue: true,
      event: params.onEvent || params.event,
      eventValue: params.onValue,
    },
  ] as const) {
    const actionId = `${params.prefix}.${target.suffix}`;
    actions[actionId] = setEventAction({
      actionId,
      event: target.event,
      eventValue: target.eventValue,
      expectedValue: target.expectedValue,
      fieldId: params.fieldId,
      groupId: params.groupId || params.prefix,
    });
  }
}

function strobeAction(params: {
  actionId: string;
  auto: boolean;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  lightOn: boolean;
  selectorPosition: number;
}): AircraftIntegrationAction {
  return setSequenceAction({
    actionId: params.actionId,
    expectedValue: params.expectedValue,
    fieldId: params.fieldId,
    groupId: 'lights.strobe',
    skipIfSatisfied: false,
    operations: [
      {
        type: 'lvar',
        name: 'L:LIGHTING_STROBE_0',
        unit: 'Number',
        value: params.selectorPosition,
      },
      {
        type: 'lvar',
        name: 'L:STROBE_0_AUTO',
        unit: 'Number',
        value: params.auto ? 1 : 0,
      },
      {
        type: 'event',
        name: 'STROBES_SET',
        value: params.lightOn ? 1 : 0,
      },
    ],
  });
}

// FlyByWire documents the selector animation, AUTO flag, and actual light
// circuit as separate interfaces. Keep them coordinated and confirm against
// the real light output for OFF/ON; AUTO confirms the dedicated mode flag
// because its actual output legitimately depends on weight-on-wheels.
actions['lights.strobe.off'] = strobeAction({
  actionId: 'lights.strobe.off',
  auto: false,
  expectedValue: false,
  fieldId: 'lights.strobeActive',
  lightOn: false,
  selectorPosition: 2,
});
actions['lights.strobe.auto'] = strobeAction({
  actionId: 'lights.strobe.auto',
  auto: true,
  expectedValue: true,
  fieldId: 'lights.strobeAuto',
  lightOn: true,
  selectorPosition: 1,
});
actions['lights.strobe.on'] = strobeAction({
  actionId: 'lights.strobe.on',
  auto: false,
  expectedValue: true,
  fieldId: 'lights.strobeActive',
  lightOn: true,
  selectorPosition: 0,
});

for (const [prefix, fieldId, event] of [
  ['lights.beacon', 'lights.beacon', 'BEACON_SET'],
  ['lights.wing', 'lights.wing', 'WING_SET'],
  ['lights.nav', 'lights.nav', 'NAV_LIGHTS_SET'],
  ['lights.logo', 'lights.logo', 'LOGO_LIGHTS_SET'],
] as const) {
  addBooleanEvent({
    event,
    fieldId,
    offValue: 0,
    onValue: 1,
    prefix,
  });
}

// FlyByWire documents dedicated circuit writes for the A320's coupled nose,
// landing and runway-turnoff lights. Landing-light ON additionally requires
// the lamp to extend for 8-10 seconds before its circuit is energized. These
// adapter-owned sequences use the midpoint (9 seconds), keep each physical
// selector serialized, and never retry a partially completed command.
const LANDING_LIGHT_EXTENSION_DELAY_MS = 9000;

for (const [suffix, expectedValue, operations] of [
  ['off', 'off', [
    { type: 'lvar', name: 'L:LIGHTING_LANDING_1', unit: 'Number', value: 2 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:17', unit: 'Bool', value: 0 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:20', unit: 'Bool', value: 0 },
  ]],
  ['taxi', 'taxi', [
    { type: 'lvar', name: 'L:LIGHTING_LANDING_1', unit: 'Number', value: 1 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:20', unit: 'Bool', value: 0 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:17', unit: 'Bool', value: 1 },
  ]],
  ['takeoff', 'takeoff', [
    { type: 'lvar', name: 'L:LIGHTING_LANDING_1', unit: 'Number', value: 0 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:17', unit: 'Bool', value: 1 },
    { type: 'simvar', name: 'CIRCUIT SWITCH ON:20', unit: 'Bool', value: 1 },
  ]],
] as const) {
  const actionId = `lights.nose.${suffix}`;
  actions[actionId] = setSequenceAction({
    actionId,
    expectedValue,
    fieldId: 'lights.noseMode',
    groupId: 'lights.nose',
    operations,
    skipIfSatisfied: false,
  });
}

for (const [suffix, expectedValue] of [
  ['off', false],
  ['on', true],
] as const) {
  const actionId = `lights.runwayTurnoff.${suffix}`;
  actions[actionId] = setSequenceAction({
    actionId,
    expectedValue,
    fieldId: 'lights.runwayTurnoff',
    groupId: 'lights.runwayTurnoff',
    operations: [
      { type: 'simvar', name: 'CIRCUIT SWITCH ON:21', unit: 'Bool', value: expectedValue },
      { type: 'simvar', name: 'CIRCUIT SWITCH ON:22', unit: 'Bool', value: expectedValue },
    ],
    // The logical state reads the left circuit; always dispatch so the paired
    // right circuit is reconciled even when the left side is already correct.
    skipIfSatisfied: false,
  });
}

for (const [prefix, selectorLvar, retractedLvar, circuitIndex, modeField, circuitField, retractedField] of [
  [
    'lights.landingLeft',
    'LIGHTING_LANDING_2',
    'LANDING_2_RETRACTED',
    18,
    'lights.landingLeftMode',
    'lights.landingLeftCircuitOn',
    'lights.landingLeftRetracted',
  ],
  [
    'lights.landingRight',
    'LIGHTING_LANDING_3',
    'LANDING_3_RETRACTED',
    19,
    'lights.landingRightMode',
    'lights.landingRightCircuitOn',
    'lights.landingRightRetracted',
  ],
] as const) {
  for (const [suffix, expectedValue, fieldId, operations] of [
    ['retract', true, retractedField, [
      { type: 'simvar', name: `CIRCUIT SWITCH ON:${circuitIndex}`, unit: 'Bool', value: 0 },
      { type: 'lvar', name: `L:${selectorLvar}`, unit: 'Number', value: 2 },
      { type: 'lvar', name: `L:${retractedLvar}`, unit: 'Number', value: 1 },
    ]],
    ['off', 'off', modeField, [
      { type: 'simvar', name: `CIRCUIT SWITCH ON:${circuitIndex}`, unit: 'Bool', value: 0 },
      { type: 'lvar', name: `L:${selectorLvar}`, unit: 'Number', value: 1 },
      { type: 'lvar', name: `L:${retractedLvar}`, unit: 'Number', value: 0 },
    ]],
    ['on', true, circuitField, [
      { type: 'lvar', name: `L:${selectorLvar}`, unit: 'Number', value: 0 },
      { type: 'lvar', name: `L:${retractedLvar}`, unit: 'Number', value: 0 },
      { type: 'delay', milliseconds: LANDING_LIGHT_EXTENSION_DELAY_MS },
      { type: 'simvar', name: `CIRCUIT SWITCH ON:${circuitIndex}`, unit: 'Bool', value: 1 },
    ]],
  ] as const) {
    const actionId = `${prefix}.${suffix}`;
    actions[actionId] = setSequenceAction({
      actionId,
      expectedValue,
      fieldId,
      groupId: prefix,
      operations,
      skipIfSatisfied: false,
    });
  }
}

addStandardDetents({
  fieldId: 'cabin.noSmokingMode',
  lvar: 'XMLVAR_SWITCH_OVHD_INTLT_NOSMOKING_POSITION',
  prefix: 'cabin.noSmoking',
  positions: [
    ['off', 2, 'off'],
    ['auto', 1, 'auto'],
    ['on', 0, 'on'],
  ],
});
addStandardDetents({
  fieldId: 'cabin.emergencyExitMode',
  lvar: 'XMLVAR_SWITCH_OVHD_INTLT_EMEREXIT_POSITION',
  prefix: 'cabin.emergencyExit',
  positions: [
    ['off', 2, 'off'],
    ['auto', 1, 'auto'],
    ['on', 0, 'on'],
  ],
});
addBooleanEvent({
  event: 'CABIN_SEATBELTS_ALERT_SWITCH_TOGGLE',
  fieldId: 'cabin.seatBelts',
  prefix: 'cabin.seatBelts',
});

for (const [prefix, fieldId, lvar, falseSuffix, trueSuffix] of [
  ['systems.battery1', 'systems.battery1', 'A32NX_OVHD_ELEC_BAT_1_PB_IS_AUTO', 'off', 'auto'],
  ['systems.battery2', 'systems.battery2', 'A32NX_OVHD_ELEC_BAT_2_PB_IS_AUTO', 'off', 'auto'],
  ['systems.externalPower', 'systems.externalPower', 'A32NX_OVHD_ELEC_EXT_PWR_PB_IS_ON', 'off', 'on'],
  ['systems.busTie', 'systems.busTie', 'A32NX_OVHD_ELEC_BUS_TIE_PB_IS_AUTO', 'off', 'auto'],
  ['systems.acEssFeed', 'systems.acEssFeed', 'A32NX_OVHD_ELEC_AC_ESS_FEED_PB_IS_NORMAL', 'alternate', 'normal'],
  ['systems.galleyAndCabin', 'systems.galleyAndCabin', 'A32NX_OVHD_ELEC_GALY_AND_CAB_PB_IS_AUTO', 'off', 'auto'],
  ['systems.commercial', 'systems.commercial', 'A32NX_OVHD_ELEC_COMMERCIAL_PB_IS_AUTO', 'off', 'auto'],
  ['systems.apuMaster', 'systems.apuMaster', 'A32NX_OVHD_APU_MASTER_SW_PB_IS_ON', 'off', 'on'],
  ['systems.apuStart', 'systems.apuStart', 'A32NX_OVHD_APU_START_PB_IS_ON', 'off', 'start'],
  ['systems.apuBleed', 'systems.apuBleed', 'A32NX_OVHD_PNEU_APU_BLEED_PB_IS_ON', 'off', 'on'],
  ['systems.pack1', 'systems.pack1', 'A32NX_OVHD_COND_PACK_1_PB_IS_ON', 'off', 'on'],
  ['systems.pack2', 'systems.pack2', 'A32NX_OVHD_COND_PACK_2_PB_IS_ON', 'off', 'on'],
  ['systems.hotAir', 'systems.hotAir', 'A32NX_OVHD_COND_HOT_AIR_PB_IS_ON', 'off', 'on'],
  ['systems.ramAir', 'systems.ramAir', 'A32NX_AIRCOND_RAMAIR_TOGGLE', 'off', 'on'],
  ['systems.probeWindowHeat', 'systems.probeWindowHeat', 'A32NX_MAN_PITOT_HEAT', 'auto', 'on'],
  ['systems.adr1', 'systems.adr1', 'A32NX_OVHD_ADIRS_ADR_1_PB_IS_ON', 'off', 'on'],
  ['systems.adr2', 'systems.adr2', 'A32NX_OVHD_ADIRS_ADR_2_PB_IS_ON', 'off', 'on'],
  ['systems.adr3', 'systems.adr3', 'A32NX_OVHD_ADIRS_ADR_3_PB_IS_ON', 'off', 'on'],
  ['systems.brakeFan', 'systems.brakeFan', 'A32NX_BRAKE_FAN_BTN_PRESSED', 'off', 'on'],
  ['systems.parkingBrake', 'systems.parkingBrake', 'A32NX_PARK_BRAKE_LEVER_POS', 'released', 'set'],
  ['navigation.terrainCaptain', 'navigation.terrainCaptain', 'A32NX_EFIS_TERR_L_ACTIVE', 'off', 'on'],
  ['navigation.terrainFirstOfficer', 'navigation.terrainFirstOfficer', 'A32NX_EFIS_TERR_R_ACTIVE', 'off', 'on'],
  ['surveillance.weatherRadarPws', 'surveillance.weatherRadarPws', 'A32NX_SWITCH_RADAR_PWS_POSITION', 'off', 'auto'],
  ['surveillance.altitudeReporting', 'surveillance.altitudeReporting', 'A32NX_SWITCH_ATC_ALT', 'off', 'on'],
  ['surveillance.rmpCaptainPower', 'surveillance.rmpCaptainPower', 'A32NX_RMP_L_TOGGLE_SWITCH', 'off', 'on'],
  ['surveillance.rmpFirstOfficerPower', 'surveillance.rmpFirstOfficerPower', 'A32NX_RMP_R_TOGGLE_SWITCH', 'off', 'on'],
  ['controls.cockpitDoorLocked', 'controls.cockpitDoorLocked', 'A32NX_COCKPIT_DOOR_LOCKED', 'unlocked', 'locked'],
] as const) {
  addBooleanLvar({
    falseSuffix,
    fieldId,
    lvar,
    prefix,
    trueSuffix,
  });
}

for (const [prefix, fieldId, lvar] of [
  ['systems.ir1', 'systems.ir1Mode', 'A32NX_OVHD_ADIRS_IR_1_MODE_SELECTOR_KNOB'],
  ['systems.ir2', 'systems.ir2Mode', 'A32NX_OVHD_ADIRS_IR_2_MODE_SELECTOR_KNOB'],
  ['systems.ir3', 'systems.ir3Mode', 'A32NX_OVHD_ADIRS_IR_3_MODE_SELECTOR_KNOB'],
] as const) {
  addStandardDetents({
    fieldId,
    lvar,
    prefix,
    positions: [
      ['off', 0, 'off'],
      ['nav', 1, 'nav'],
      ['att', 2, 'att'],
    ],
  });
}

addStandardDetents({
  fieldId: 'systems.crossBleedMode',
  lvar: 'A32NX_KNOB_OVHD_AIRCOND_XBLEED_POSITION',
  prefix: 'systems.crossBleed',
  positions: [
    ['closed', 0, 'closed'],
    ['auto', 1, 'auto'],
    ['open', 2, 'open'],
  ],
});
addStandardDetents({
  fieldId: 'systems.packFlowMode',
  lvar: 'A32NX_KNOB_OVHD_AIRCOND_PACKFLOW_POSITION',
  prefix: 'systems.packFlow',
  positions: [
    ['low', 0, 'low'],
    ['normal', 1, 'normal'],
    ['high', 2, 'high'],
  ],
});
addStandardDetents({
  fieldId: 'systems.autobrakeMode',
  lvar: 'A32NX_AUTOBRAKES_ARMED_MODE_SET',
  prefix: 'systems.autobrake',
  positions: [
    ['disarm', 0, 'disarmed'],
    ['low', 1, 'low'],
    ['medium', 2, 'medium'],
    ['max', 3, 'max'],
  ],
});

addStandardDetents({
  fieldId: 'flightGuidance.altitudeIncrementMode',
  lvar: 'A32NX_FCU_ALT_INCREMENT_1000',
  prefix: 'flightGuidance.altitudeIncrement',
  positions: [
    ['hundred', 0, 'hundred'],
    ['thousand', 1, 'thousand'],
  ],
});

// FlyByWire publishes these FCU controls as global custom client events.
// Numeric setters update the displayed selector only; managed/selected
// engagement is a separate push/pull action, matching the real Airbus model.
for (const params of [
  {
    actionId: 'flightGuidance.speed.set',
    fieldId: 'flightGuidance.speedValue',
    groupId: 'flightGuidance.speedSelector',
    input: { type: 'number', min: 100, max: 399, step: 1 },
    event: 'A32NX.FCU_SPD_SET',
    precondition: { fieldId: 'flightGuidance.machMode', expectedValue: false },
  },
  {
    actionId: 'flightGuidance.mach.set',
    fieldId: 'flightGuidance.speedValue',
    groupId: 'flightGuidance.speedSelector',
    input: { type: 'number', min: 0.4, max: 0.99, step: 0.01 },
    event: 'A32NX.FCU_SPD_SET',
    inputScale: 100,
    precondition: { fieldId: 'flightGuidance.machMode', expectedValue: true },
  },
  {
    actionId: 'flightGuidance.heading.set',
    fieldId: 'flightGuidance.headingDeg',
    groupId: 'flightGuidance.headingSelector',
    input: { type: 'number', min: 0, max: 359, step: 1 },
    event: 'A32NX.FCU_HDG_SET',
    precondition: { fieldId: 'flightGuidance.trkFpaMode', expectedValue: false },
  },
  {
    actionId: 'flightGuidance.altitude.set',
    fieldId: 'flightGuidance.altitudeFt',
    groupId: 'flightGuidance.altitudeSelector',
    input: { type: 'number', min: 100, max: 49_000, step: 100 },
    event: 'A32NX.FCU_ALT_SET',
  },
  {
    actionId: 'flightGuidance.verticalSpeed.set',
    fieldId: 'flightGuidance.verticalValue',
    groupId: 'flightGuidance.verticalSelector',
    input: { type: 'number', min: -6_000, max: 6_000, step: 100 },
    event: 'A32NX.FCU_VS_SET',
    precondition: { fieldId: 'flightGuidance.trkFpaMode', expectedValue: false },
  },
  {
    actionId: 'flightGuidance.flightPathAngle.set',
    fieldId: 'flightGuidance.verticalValue',
    groupId: 'flightGuidance.verticalSelector',
    input: { type: 'number', min: -9.9, max: 9.9, step: 0.1 },
    event: 'A32NX.FCU_VS_SET',
    inputScale: 10,
    precondition: { fieldId: 'flightGuidance.trkFpaMode', expectedValue: true },
  },
] satisfies readonly Parameters<typeof setCustomEventInputAction>[0][]) {
  actions[params.actionId] = setCustomEventInputAction(params);
}

for (const [prefix, fieldId, pushEvent, pullEvent] of [
  [
    'flightGuidance.speedManaged',
    'flightGuidance.speedManaged',
    'A32NX.FCU_SPD_PUSH',
    'A32NX.FCU_SPD_PULL',
  ],
  [
    'flightGuidance.headingManaged',
    'flightGuidance.headingManaged',
    'A32NX.FCU_HDG_PUSH',
    'A32NX.FCU_HDG_PULL',
  ],
  [
    'flightGuidance.altitudeManaged',
    'flightGuidance.altitudeManaged',
    'A32NX.FCU_ALT_PUSH',
    'A32NX.FCU_ALT_PULL',
  ],
] as const) {
  actions[`${prefix}.on`] = setCustomEventButtonAction({
    actionId: `${prefix}.on`,
    event: pushEvent,
    expectedValue: true,
    fieldId,
    groupId: prefix,
  });
  actions[`${prefix}.off`] = setCustomEventButtonAction({
    actionId: `${prefix}.off`,
    event: pullEvent,
    expectedValue: false,
    fieldId,
    groupId: prefix,
  });
}

for (const [suffix, expectedValue] of [['off', false], ['on', true]] as const) {
  const actionId = `flightGuidance.ap2.${suffix}`;
  actions[actionId] = setCustomEventButtonAction({
    actionId,
    event: 'A32NX.FCU_AP_2_PUSH',
    expectedValue,
    fieldId: 'flightGuidance.ap2',
    groupId: 'flightGuidance.ap2',
  });
}

for (const [prefix, fieldId, lvar] of [
  ['flightGuidance.baroUnitCaptain', 'flightGuidance.baroUnitCaptain', 'A32NX_FCU_EFIS_L_BARO_IS_INHG'],
  ['flightGuidance.baroUnitFirstOfficer', 'flightGuidance.baroUnitFirstOfficer', 'A32NX_FCU_EFIS_R_BARO_IS_INHG'],
] as const) {
  addBooleanLvar({
    falseSuffix: 'hpa',
    fieldId,
    lvar,
    prefix,
    trueSuffix: 'inhg',
  });
}

for (const [prefix, fieldId, lvar] of [
  ['navigation.ndCaptainMode', 'navigation.ndCaptainMode', 'A32NX_FCU_EFIS_L_EFIS_MODE'],
  ['navigation.ndFirstOfficerMode', 'navigation.ndFirstOfficerMode', 'A32NX_FCU_EFIS_R_EFIS_MODE'],
] as const) {
  addStandardDetents({
    fieldId,
    lvar,
    prefix,
    positions: [
      ['roseIls', 0, 'roseIls'],
      ['roseVor', 1, 'roseVor'],
      ['roseNav', 2, 'roseNav'],
      ['arc', 3, 'arc'],
      ['plan', 4, 'plan'],
    ],
  });
}
for (const [prefix, fieldId, lvar] of [
  ['navigation.ndCaptainRange', 'navigation.ndCaptainRange', 'A32NX_FCU_EFIS_L_EFIS_RANGE'],
  ['navigation.ndFirstOfficerRange', 'navigation.ndFirstOfficerRange', 'A32NX_FCU_EFIS_R_EFIS_RANGE'],
] as const) {
  addStandardDetents({
    fieldId,
    lvar,
    prefix,
    positions: [
      ['nm10', 0, '10'],
      ['nm20', 1, '20'],
      ['nm40', 2, '40'],
      ['nm80', 3, '80'],
      ['nm160', 4, '160'],
      ['nm320', 5, '320'],
    ],
  });
}
for (const [prefix, fieldId, lvar] of [
  ['navigation.navaidCaptain1', 'navigation.navaidCaptain1', 'A32NX_FCU_EFIS_L_NAVAID_1_MODE'],
  ['navigation.navaidCaptain2', 'navigation.navaidCaptain2', 'A32NX_FCU_EFIS_L_NAVAID_2_MODE'],
  ['navigation.navaidFirstOfficer1', 'navigation.navaidFirstOfficer1', 'A32NX_FCU_EFIS_R_NAVAID_1_MODE'],
  ['navigation.navaidFirstOfficer2', 'navigation.navaidFirstOfficer2', 'A32NX_FCU_EFIS_R_NAVAID_2_MODE'],
] as const) {
  addStandardDetents({
    fieldId,
    lvar,
    prefix,
    positions: [
      ['off', 0, 'off'],
      ['adf', 1, 'adf'],
      ['vor', 2, 'vor'],
    ],
  });
}

for (const [prefix, fieldId, lvar] of [
  ['switching.attitudeHeading', 'switching.attitudeHeading', 'A32NX_ATT_HDG_SWITCHING_KNOB'],
  ['switching.airData', 'switching.airData', 'A32NX_AIR_DATA_SWITCHING_KNOB'],
  ['switching.eisDmc', 'switching.eisDmc', 'A32NX_EIS_DMC_SWITCHING_KNOB'],
  ['switching.ecamNd', 'switching.ecamNd', 'A32NX_ECAM_ND_XFR_SWITCHING_KNOB'],
] as const) {
  addStandardDetents({
    fieldId,
    lvar,
    prefix,
    positions: [
      ['captain', 0, 'captain'],
      ['normal', 1, 'normal'],
      ['firstOfficer', 2, 'firstOfficer'],
    ],
  });
}

addStandardDetents({
  fieldId: 'surveillance.weatherRadarSystem',
  lvar: 'XMLVAR_A320_WEATHERRADAR_SYS',
  prefix: 'surveillance.weatherRadarSystem',
  positions: [
    ['system1', 0, 'system1'],
    ['off', 1, 'off'],
    ['system2', 2, 'system2'],
  ],
});
addStandardDetents({
  fieldId: 'surveillance.weatherRadarMode',
  lvar: 'XMLVAR_A320_WEATHERRADAR_MODE',
  prefix: 'surveillance.weatherRadarMode',
  positions: [
    ['weather', 0, 'weather'],
    ['weatherTerrain', 1, 'weatherTerrain'],
    ['turbulence', 2, 'turbulence'],
    ['map', 3, 'map'],
  ],
});
addStandardDetents({
  fieldId: 'surveillance.transponderMode',
  lvar: 'A32NX_TRANSPONDER_MODE',
  prefix: 'surveillance.transponderMode',
  positions: [
    ['standby', 0, 'standby'],
    ['auto', 1, 'auto'],
    ['on', 2, 'on'],
  ],
});
addStandardDetents({
  fieldId: 'surveillance.transponderSystem',
  lvar: 'A32NX_TRANSPONDER_SYSTEM',
  prefix: 'surveillance.transponderSystem',
  positions: [
    ['system1', 0, 'system1'],
    ['system2', 1, 'system2'],
  ],
});
addStandardDetents({
  fieldId: 'surveillance.tcasFilterMode',
  lvar: 'A32NX_SWITCH_TCAS_TRAFFIC_POSITION',
  prefix: 'surveillance.tcasFilter',
  positions: [
    ['threat', 0, 'threat'],
    ['all', 1, 'all'],
    ['above', 2, 'above'],
    ['below', 3, 'below'],
  ],
});
addStandardDetents({
  fieldId: 'surveillance.tcasMode',
  lvar: 'A32NX_SWITCH_TCAS_POSITION',
  prefix: 'surveillance.tcasMode',
  positions: [
    ['standby', 0, 'standby'],
    ['ta', 1, 'ta'],
    ['taRa', 2, 'taRa'],
  ],
});
for (const [prefix, fieldId, lvar] of [
  ['surveillance.rmpCaptainMode', 'surveillance.rmpCaptainMode', 'A32NX_RMP_L_SELECTED_MODE'],
  ['surveillance.rmpFirstOfficerMode', 'surveillance.rmpFirstOfficerMode', 'A32NX_RMP_R_SELECTED_MODE'],
] as const) {
  addStandardDetents({
    fieldId,
    lvar,
    prefix,
    positions: [
      ['select', 0, 'select'],
      ['vhf1', 1, 'vhf1'],
      ['vhf2', 2, 'vhf2'],
      ['vhf3', 3, 'vhf3'],
    ],
  });
}

addStandardDetents({
  fieldId: 'displays.annunciatorMode',
  lvar: 'A32NX_OVHD_INTLT_ANN',
  prefix: 'displays.annunciator',
  positions: [
    ['test', 0, 'test'],
    ['bright', 1, 'bright'],
    ['dim', 2, 'dim'],
  ],
});
addStandardDetents({
  fieldId: 'displays.ecamPage',
  lvar: 'A32NX_ECAM_SD_CURRENT_PAGE_INDEX',
  prefix: 'displays.ecamPage',
  positions: [
    ['none', -1, 'none'],
    ['engine', 0, 'engine'],
    ['bleed', 1, 'bleed'],
    ['press', 2, 'press'],
    ['electrical', 3, 'electrical'],
    ['hydraulic', 4, 'hydraulic'],
    ['fuel', 5, 'fuel'],
    ['apu', 6, 'apu'],
    ['conditioning', 7, 'conditioning'],
    ['door', 8, 'door'],
    ['wheel', 9, 'wheel'],
    ['flightControls', 10, 'flightControls'],
    ['status', 11, 'status'],
    ['cruise', 12, 'cruise'],
  ],
});
for (const [actionId, fieldId, lvar] of [
  ['displays.masterCaution.clear', 'displays.masterCaution', 'A32NX_MASTER_CAUTION'],
  ['displays.masterWarning.clear', 'displays.masterWarning', 'A32NX_MASTER_WARNING'],
] as const) {
  actions[actionId] = setLvarAction({
    actionId,
    expectedValue: false,
    fieldId,
    groupId: fieldId,
    lvar,
    rawValue: 0,
  });
}

for (const [prefix, fieldId, event, eventValue] of [
  ['systems.engineBleed1', 'systems.engineBleed1', 'ENGINE_BLEED_AIR_SOURCE_TOGGLE', 1],
  ['systems.engineBleed2', 'systems.engineBleed2', 'ENGINE_BLEED_AIR_SOURCE_TOGGLE', 2],
  ['systems.engineAntiIce1', 'systems.engineAntiIce1', 'ANTI_ICE_TOGGLE_ENG1', 0],
  ['systems.engineAntiIce2', 'systems.engineAntiIce2', 'ANTI_ICE_TOGGLE_ENG2', 0],
  ['systems.wingAntiIce', 'systems.wingAntiIce', 'TOGGLE_STRUCTURAL_DEICE', 0],
  ['flightGuidance.flightDirectorCaptain', 'flightGuidance.flightDirectorCaptain', 'TOGGLE_FLIGHT_DIRECTOR', 0],
  ['flightGuidance.localizer', 'flightGuidance.localizer', 'AP_LOC_HOLD', 0],
  ['flightGuidance.approach', 'flightGuidance.approach', 'AP_APR_HOLD', 0],
  ['flightGuidance.expedite', 'flightGuidance.expedite', 'AP_ATT_HOLD', 0],
  ['flightGuidance.machMode', 'flightGuidance.machMode', 'AP_MACH_HOLD', 0],
  ['flightGuidance.trkFpaMode', 'flightGuidance.trkFpaMode', 'AP_VS_HOLD', 0],
  ['controls.spoilersArmed', 'controls.spoilersArmed', 'SPOILERS_ARM_TOGGLE', 0],
] as const) {
  addBooleanEvent({
    event,
    fieldId,
    groupId: prefix,
    offValue: eventValue,
    onValue: eventValue,
    prefix,
  });
}

addBooleanEvent({
  event: 'AUTOPILOT_ON',
  fieldId: 'flightGuidance.ap1',
  offEvent: 'AUTOPILOT_OFF',
  prefix: 'flightGuidance.ap1',
});
addBooleanEvent({
  event: 'AUTO_THROTTLE_ARM',
  fieldId: 'flightGuidance.autothrust',
  offEvent: 'AUTO_THROTTLE_DISCONNECT',
  prefix: 'flightGuidance.autothrust',
});

// The official throttle API exposes each calibrated detent window and an
// independent TLA readback per lever. The calculator route validates both
// windows, targets their midpoints, and succeeds only when both TLAs confirm.
addFbwCalibratedThrottleDetentActions({
  actions,
  adapterPrefix: 'fbwA32nx',
  leverCount: 2,
});

for (const [prefix, fieldId, index] of [
  ['controls.engineMaster1', 'controls.engineMaster1', 1],
  ['controls.engineMaster2', 'controls.engineMaster2', 2],
] as const) {
  addBooleanEvent({
    event: 'FUELSYSTEM_VALVE_OPEN',
    fieldId,
    offEvent: 'FUELSYSTEM_VALVE_CLOSE',
    offValue: index,
    onValue: index,
    prefix,
  });
}

for (const [suffix, eventValue, expectedValue] of [
  ['crank', 0, 'crank'],
  ['normal', 1, 'normal'],
  ['ignition', 2, 'ignition'],
] as const) {
  const actionId = `controls.engineMode.${suffix}`;
  actions[actionId] = setSequenceAction({
    actionId,
    expectedValue,
    fieldId: 'controls.engineMode',
    groupId: 'controls.engineMode',
    operations: [
      { type: 'event', name: 'TURBINE_IGNITION_SWITCH_SET1', value: eventValue },
      { type: 'event', name: 'TURBINE_IGNITION_SWITCH_SET2', value: eventValue },
    ],
  });
}

for (const [suffix, eventValue, expectedValue] of [
  ['retracted', 0, 0],
  ['quarter', 4096, 0.25],
  ['half', 8192, 0.5],
  ['threeQuarter', 12288, 0.75],
  ['full', 16384, 1],
] as const) {
  const actionId = `controls.spoilers.${suffix}`;
  actions[actionId] = setEventAction({
    actionId,
    event: 'SPOILERS_SET',
    eventValue,
    expectedValue,
    fieldId: 'controls.spoilersHandle',
    groupId: 'controls.spoilers',
  });
}

const FBW_A32NX_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = actions;

module.exports = {
  FBW_A32NX_ACTIONS,
};

export {};
