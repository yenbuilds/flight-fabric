'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationPrimitive,
} from '../types.js';

const SDK_ADAPTER_ID = 'clientdata-manifest';
const DEFAULT_COOLDOWN_MS = 450;
const DEFAULT_READBACK_TIMEOUT_MS = 1500;
const MOUSE_FLAG_LEFT_SINGLE = 0x20000000;
const MOUSE_FLAG_LEFT_RELEASE = 0x00020000;
const MOUSE_FLAG_WHEEL_UP = 0x00004000;
const MOUSE_FLAG_WHEEL_DOWN = 0x00002000;
const ROTOR_BRAKE_EVENT = 'ROTOR_BRAKE';
// PMDG's ROTOR_BRAKE compatibility encoding uses compact mouse action IDs,
// not the DWORD mouse flags used by the direct `#nnnnn` event route.
const ROTOR_BRAKE_LEFT_SINGLE = 1;
const ROTOR_BRAKE_WHEEL_UP = 7;
const ROTOR_BRAKE_WHEEL_DOWN = 8;

function setSdkPositionAction(params: {
  actionId: string;
  eventId: number;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  rawValue: number;
  rotorBrakeValues?: readonly number[];
}): AircraftIntegrationAction {
  const readback = {
    fieldId: params.fieldId,
    expectedValue: params.expectedValue,
    timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
  } as const;
  const sdkRoute = {
    id: `pmdg737.${params.actionId}.sdk`,
    transport: 'sdk' as const,
    adapter: SDK_ADAPTER_ID,
    command: `#${params.eventId}`,
    value: params.rawValue,
    readback,
  };
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: params.rotorBrakeValues
      ? [
        {
          id: `pmdg737.${params.actionId}.rotorBrake`,
          transport: 'simconnect-sequence',
          operations: params.rotorBrakeValues.map((value) => ({
            type: 'event' as const,
            name: ROTOR_BRAKE_EVENT,
            value,
          })),
          readback,
        },
        sdkRoute,
      ]
      : [sdkRoute],
    verification: 'untested',
  };
}

function setSdkNumberAction(params: {
  actionId: string;
  eventId: number;
  fieldId: string;
  groupId: string;
  input: Readonly<{ max: number; min: number; step: number }>;
  offset?: number;
  round?: 'nearest';
  scale?: number;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    input: { type: 'number', ...params.input },
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [{
      id: `pmdg737.${params.actionId}.sdk`,
      transport: 'sdk',
      adapter: SDK_ADAPTER_ID,
      command: `#${params.eventId}`,
      inputValue: {
        source: 'input',
        ...(params.scale === undefined ? {} : { scale: params.scale }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.round === undefined ? {} : { round: params.round }),
      },
      readback: {
        fieldId: params.fieldId,
        expectedInput: true,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

function pressSdkAction(params: {
  actionId: string;
  eventId: number;
  fieldId: string;
  groupId: string;
  expectedValue?: AircraftIntegrationPrimitive;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [{
      id: `pmdg737.${params.actionId}.sdk`,
      transport: 'sdk',
      adapter: SDK_ADAPTER_ID,
      command: `#${params.eventId}`,
      values: [MOUSE_FLAG_LEFT_SINGLE, MOUSE_FLAG_LEFT_RELEASE],
      readback: {
        fieldId: params.fieldId,
        ...(params.expectedValue === undefined
          ? { confirmation: 'changed' as const }
          : { expectedValue: params.expectedValue }),
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

function turnSdkRadioKnobAction(params: {
  actionId: string;
  eventId: number;
  fieldId: string;
  groupId: string;
  rotorBrakeValue: number;
  value: number;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: 175,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [
      {
        id: `pmdg737.${params.actionId}.rotorBrake`,
        transport: 'simconnect-sequence',
        operations: [{
          type: 'event',
          name: ROTOR_BRAKE_EVENT,
          value: params.rotorBrakeValue,
        }],
        readback: {
          fieldId: params.fieldId,
          confirmation: 'changed',
          timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
        },
      },
      {
        id: `pmdg737.${params.actionId}.sdk`,
        transport: 'sdk',
        adapter: SDK_ADAPTER_ID,
        command: `#${params.eventId}`,
        value: params.value,
        readback: {
          fieldId: params.fieldId,
          confirmation: 'changed',
          timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
        },
      },
    ],
    verification: 'untested',
  };
}

function pressSdkRadioTransferAction(params: {
  actionId: string;
  eventId: number;
  fieldId: string;
  groupId: string;
  rotorBrakeValue: number;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [
      {
        id: `pmdg737.${params.actionId}.rotorBrake`,
        transport: 'simconnect-sequence',
        operations: [{
          type: 'event',
          name: ROTOR_BRAKE_EVENT,
          value: params.rotorBrakeValue,
        }],
        readback: {
          fieldId: params.fieldId,
          confirmation: 'changed',
          timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
        },
      },
      {
        id: `pmdg737.${params.actionId}.sdk`,
        transport: 'sdk',
        adapter: SDK_ADAPTER_ID,
        command: `#${params.eventId}`,
        values: [MOUSE_FLAG_LEFT_SINGLE, MOUSE_FLAG_LEFT_RELEASE],
        readback: {
          fieldId: params.fieldId,
          confirmation: 'changed',
          timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
        },
      },
    ],
    verification: 'untested',
  };
}

const actions: Record<string, AircraftIntegrationAction> = {};

function addBooleanActions(params: {
  eventId: number;
  fieldId: string;
  groupId: string;
  prefix: string;
}): void {
  for (const [suffix, rawValue, expectedValue] of [
    ['off', 0, false],
    ['on', 1, true],
  ] as const) {
    const actionId = `${params.prefix}.${suffix}`;
    actions[actionId] = setSdkPositionAction({ ...params, actionId, rawValue, expectedValue });
  }
}

function addMouseToggleActions(params: {
  eventId: number;
  fieldId: string;
  groupId: string;
  prefix: string;
}): void {
  for (const [suffix, expectedValue] of [
    ['off', false],
    ['on', true],
  ] as const) {
    const actionId = `${params.prefix}.${suffix}`;
    actions[actionId] = pressSdkAction({
      ...params,
      actionId,
      expectedValue,
    });
  }
}

function addDetentActions(params: {
  eventId: number;
  fieldId: string;
  groupId: string;
  positions: ReadonlyArray<Readonly<{
    id: string;
    rawValue: number;
    rotorBrakeValues?: readonly number[];
    value: string;
  }>>;
  prefix: string;
}): void {
  for (const position of params.positions) {
    const actionId = `${params.prefix}.${position.id}`;
    actions[actionId] = setSdkPositionAction({
      ...params,
      actionId,
      expectedValue: position.value,
      rawValue: position.rawValue,
      rotorBrakeValues: position.rotorBrakeValues,
    });
  }
}

// PMDG's installed NG3 connection sample sends direct 0/1 positions to the logo-light
// event. Keep these two-state exterior lights distinct from controls such as the flight
// directors, for which the same sample sends mouse press/release flags.
for (const definition of [
  ['lights.landingLeft', 'lights.landingLeft', 69745],
  ['lights.landingRight', 'lights.landingRight', 69746],
  ['lights.turnoffLeft', 'lights.turnoffLeft', 69747],
  ['lights.turnoffRight', 'lights.turnoffRight', 69748],
  ['lights.taxi', 'lights.taxi', 69749],
  ['lights.logo', 'lights.logo', 69754],
  ['lights.beacon', 'lights.beacon', 69756],
  ['lights.wing', 'lights.wing', 69757],
  ['lights.wheelWell', 'lights.wheelWell', 69758],
] as const) {
  addBooleanActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg737.${definition[0]}`,
    eventId: definition[2],
  });
}

// MCP direct-set events from the installed PMDG NG3 SDK. Logical input ranges
// stay in cockpit units; the adapter owns PMDG's Mach and vertical-speed wire
// encodings so browser clients never send raw SDK parameters.
for (const definition of [
  ['mcp.courseCaptain.set', 'mcp.courseCaptainDeg', 84132, 0, 359, 1, 1, 0, 'pmdg737.mcp.courseCaptain'],
  ['mcp.ias.set', 'mcp.speed', 84134, 100, 399, 1, 1, 0, 'pmdg737.mcp.speed'],
  ['mcp.mach.set', 'mcp.speed', 84135, 0.4, 0.99, 0.01, 100, 0, 'pmdg737.mcp.speed'],
  ['mcp.heading.set', 'mcp.headingDeg', 84136, 0, 359, 1, 1, 0, 'pmdg737.mcp.heading'],
  ['mcp.altitude.set', 'mcp.altitudeFt', 84137, 0, 50000, 100, 1, 0, 'pmdg737.mcp.altitude'],
  ['mcp.verticalSpeed.set', 'mcp.verticalSpeedFpm', 84138, -7900, 6000, 100, 1, 10000, 'pmdg737.mcp.verticalSpeed'],
  ['mcp.courseFirstOfficer.set', 'mcp.courseFirstOfficerDeg', 84133, 0, 359, 1, 1, 0, 'pmdg737.mcp.courseFirstOfficer'],
] as const) {
  actions[definition[0]] = setSdkNumberAction({
    actionId: definition[0],
    fieldId: definition[1],
    eventId: definition[2],
    groupId: definition[8],
    input: { min: definition[3], max: definition[4], step: definition[5] },
    scale: definition[6],
    offset: definition[7],
    round: 'nearest',
  });
}

for (const definition of [
  ['afds.n1.engage', 'afds.n1', 70013],
  ['afds.speed.engage', 'afds.speed', 70014],
  ['afds.vnav.engage', 'afds.vnav', 70018],
  ['afds.levelChange.engage', 'afds.levelChange', 70023],
  ['afds.headingSelect.engage', 'afds.headingSelect', 70024],
  ['afds.approach.engage', 'afds.approach', 70025],
  ['afds.altitudeHold.engage', 'afds.altitudeHold', 70026],
  ['afds.verticalSpeed.engage', 'afds.verticalSpeed', 70027],
  ['afds.vorLoc.engage', 'afds.vorLoc', 70028],
  ['afds.lnav.engage', 'afds.lnav', 70029],
  ['afds.cmdA.engage', 'afds.cmdA', 70034],
  ['afds.cmdB.engage', 'afds.cmdB', 70035],
  ['afds.cwsA.engage', 'afds.cwsA', 70036],
  ['afds.cwsB.engage', 'afds.cwsB', 70037],
] as const) {
  actions[definition[0]] = pressSdkAction({
    actionId: definition[0],
    fieldId: definition[1],
    eventId: definition[2],
    groupId: `pmdg737.${definition[1]}`,
    expectedValue: true,
  });
}

// Live behavior currently uses 0 for ARM and 1 for OFF. The installed NG3
// header publishes this event but does not document its parameter polarity,
// so retain logical-state readback protection around this empirical mapping.
for (const [suffix, rawValue, expectedValue] of [
  ['off', 1, false],
  ['on', 0, true],
] as const) {
  const actionId = `afds.autothrottleArm.${suffix}`;
  actions[actionId] = setSdkPositionAction({
    actionId,
    eventId: 70012,
    fieldId: 'afds.autothrottleArm',
    groupId: 'pmdg737.afds.autothrottleArm',
    rawValue,
    expectedValue,
  });
}

// PMDG's installed NG3 connection sample operates the FD control with a
// complete mouse click rather than direct 0/1 event parameters. Apply those FD
// semantics to both crew-side counterparts. The provider reads the current
// switch first, so each logical ON/OFF action is still deterministic: an
// already-satisfied target is a no-op, otherwise one click is sent and the
// requested boolean state must be confirmed.
for (const definition of [
  ['afds.flightDirectorCaptain', 'afds.flightDirectorCaptain', 70010],
  ['afds.flightDirectorFirstOfficer', 'afds.flightDirectorFirstOfficer', 70039],
] as const) {
  addMouseToggleActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg737.${definition[0]}`,
    eventId: definition[2],
  });
}

for (const radio of [
  {
    id: 'nav1', activeField: 'radios.nav1ActiveMhz', standbyField: 'radios.nav1StandbyMhz',
    transferEvent: 70361, transferRotorBrakeControl: 729,
    innerEvent: 70364, innerRotorBrakeControl: 732,
    outerEvent: 70365, outerRotorBrakeControl: 733,
  },
  {
    id: 'nav2', activeField: 'radios.nav2ActiveMhz', standbyField: 'radios.nav2StandbyMhz',
    transferEvent: 70477, transferRotorBrakeControl: 845,
    innerEvent: 70481, innerRotorBrakeControl: 849,
    outerEvent: 70480, outerRotorBrakeControl: 848,
  },
] as const) {
  actions[`${radio.id}.transfer`] = pressSdkRadioTransferAction({
    actionId: `${radio.id}.transfer`,
    eventId: radio.transferEvent,
    fieldId: radio.activeField,
    groupId: `pmdg737.${radio.id}`,
    rotorBrakeValue: radio.transferRotorBrakeControl * 100 + ROTOR_BRAKE_LEFT_SINGLE,
  });
  for (const [selector, eventId, rotorBrakeControl] of [
    ['inner', radio.innerEvent, radio.innerRotorBrakeControl],
    ['outer', radio.outerEvent, radio.outerRotorBrakeControl],
  ] as const) {
    for (const [direction, value, rotorBrakeAction] of [
      ['decrement', MOUSE_FLAG_WHEEL_DOWN, ROTOR_BRAKE_WHEEL_DOWN],
      ['increment', MOUSE_FLAG_WHEEL_UP, ROTOR_BRAKE_WHEEL_UP],
    ] as const) {
      const actionId = `${radio.id}.${selector}.${direction}`;
      actions[actionId] = turnSdkRadioKnobAction({
        actionId,
        eventId,
        fieldId: radio.standbyField,
        groupId: `pmdg737.${radio.id}`,
        rotorBrakeValue: rotorBrakeControl * 100 + rotorBrakeAction,
        value,
      });
    }
  }
}

for (const definition of [
  ['lights.landingRetractableLeft', 'lights.landingRetractableLeftMode', 69743],
  ['lights.landingRetractableRight', 'lights.landingRetractableRightMode', 69744],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg737.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'retract', rawValue: 0, value: 'retract' },
      { id: 'extend', rawValue: 1, value: 'extend' },
      { id: 'on', rawValue: 2, value: 'on' },
    ],
  });
}

addDetentActions({
  prefix: 'lights.position',
  fieldId: 'lights.positionMode',
  groupId: 'pmdg737.lights.position',
  eventId: 69755,
  positions: [
    // The installed PMDG behavior drives this three-detent switch through
    // control 123. Values 12301 and 12302 move one detent toward the named
    // endpoint. Repeating an endpoint direction is bounded by the switch.
    { id: 'steady', rawValue: 0, value: 'steady', rotorBrakeValues: [12301, 12301] },
    { id: 'off', rawValue: 1, value: 'off', rotorBrakeValues: [12301, 12301, 12302] },
    { id: 'strobeSteady', rawValue: 2, value: 'strobe-steady', rotorBrakeValues: [12302, 12302] },
  ],
});

addDetentActions({
  prefix: 'lights.emergency',
  fieldId: 'lights.emergencyMode',
  groupId: 'pmdg737.lights.emergency',
  eventId: 69732,
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'armed', rawValue: 1, value: 'armed' },
    { id: 'on', rawValue: 2, value: 'on' },
  ],
});

for (const definition of [
  ['cabin.noSmoking', 'cabin.noSmokingMode', 69735],
  ['cabin.seatBelts', 'cabin.seatBeltsMode', 69736],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg737.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'auto', rawValue: 1, value: 'auto' },
      { id: 'on', rawValue: 2, value: 'on' },
    ],
  });
}

for (const definition of [
  ['visibility.wiperLeft', 'visibility.wiperLeftMode', 69668],
  ['visibility.wiperRight', 'visibility.wiperRightMode', 69741],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg737.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'intermittent', rawValue: 1, value: 'intermittent' },
      { id: 'low', rawValue: 2, value: 'low' },
      { id: 'high', rawValue: 3, value: 'high' },
    ],
  });
}

const PMDG_737_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = actions;

module.exports = {
  PMDG_737_ACTIONS,
};

export {};
