'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationPrimitive,
} from '../types.js';

const SDK_ADAPTER_ID = 'clientdata-manifest';
const DEFAULT_COOLDOWN_MS = 650;
const DEFAULT_READBACK_TIMEOUT_MS = 2500;
const MOUSE_FLAG_LEFT_SINGLE = 0x20000000;
const MOUSE_FLAG_LEFT_RELEASE = 0x00020000;

function setSdkPositionAction(params: {
  actionId: string;
  eventId: number;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  rawValue: number;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [{
      id: `pmdg777.${params.actionId}.sdk`,
      transport: 'sdk',
      adapter: SDK_ADAPTER_ID,
      command: `#${params.eventId}`,
      value: params.rawValue,
      readback: {
        fieldId: params.fieldId,
        expectedValue: params.expectedValue,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
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
      id: `pmdg777.${params.actionId}.sdk`,
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
  expectedValue: AircraftIntegrationPrimitive;
}): AircraftIntegrationAction {
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: params.groupId,
      retry: 'never',
    },
    routes: [{
      id: `pmdg777.${params.actionId}.sdk`,
      transport: 'sdk',
      adapter: SDK_ADAPTER_ID,
      command: `#${params.eventId}`,
      values: [MOUSE_FLAG_LEFT_SINGLE, MOUSE_FLAG_LEFT_RELEASE],
      readback: {
        fieldId: params.fieldId,
        expectedValue: params.expectedValue,
        timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
      },
    }],
    verification: 'untested',
  };
}

const actions: Record<string, AircraftIntegrationAction> = {};

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
  positions: ReadonlyArray<Readonly<{ id: string; rawValue: number; value: string }>>;
  prefix: string;
}): void {
  for (const position of params.positions) {
    const actionId = `${params.prefix}.${position.id}`;
    actions[actionId] = setSdkPositionAction({
      ...params,
      actionId,
      expectedValue: position.value,
      rawValue: position.rawValue,
    });
  }
}

// PMDG's documented direct MCP events accept logical cockpit values after the
// event-specific wire transforms declared in PMDG_777X_SDK.h.
for (const definition of [
  ['mcp.ias.set', 'flightGuidance.speedKts', 84134, 100, 399, 1, 1, 0, 'pmdg777.mcp.speed'],
  ['mcp.mach.set', 'flightGuidance.mach', 84135, 0.4, 0.99, 0.01, 1000, 0, 'pmdg777.mcp.speed'],
  ['mcp.heading.set', 'flightGuidance.headingDeg', 84136, 0, 359, 1, 1, 0, 'pmdg777.mcp.heading'],
  ['mcp.altitude.set', 'flightGuidance.altitudeFt', 84137, 0, 50000, 100, 1, 0, 'pmdg777.mcp.altitude'],
  ['mcp.verticalSpeed.set', 'flightGuidance.vsFpm', 84138, -7900, 6000, 100, 1, 10000, 'pmdg777.mcp.vertical'],
  ['mcp.fpa.set', 'flightGuidance.fpaDeg', 84139, -9.9, 9.9, 0.1, 10, 100, 'pmdg777.mcp.vertical'],
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

// The installed PMDG sample operates FD switches with a complete mouse click.
// Reading the current switch first keeps logical ON/OFF requests idempotent.
for (const definition of [
  ['afds.flightDirectorCaptain', 'flightGuidance.fdLeft', 69834],
  ['afds.flightDirectorFirstOfficer', 'flightGuidance.fdRight', 69862],
] as const) {
  addMouseToggleActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
  });
}

for (const definition of [
  ['afds.headingMode.hdg', 'flightGuidance.headingMode', 'HDG', 69848, 'pmdg777.mcp.heading'],
  ['afds.headingMode.trk', 'flightGuidance.headingMode', 'TRK', 69848, 'pmdg777.mcp.heading'],
  ['afds.verticalMode.vs', 'flightGuidance.verticalMode', 'VS', 69852, 'pmdg777.mcp.vertical'],
  ['afds.verticalMode.fpa', 'flightGuidance.verticalMode', 'FPA', 69852, 'pmdg777.mcp.vertical'],
] as const) {
  actions[definition[0]] = pressSdkAction({
    actionId: definition[0],
    fieldId: definition[1],
    expectedValue: definition[2],
    eventId: definition[3],
    groupId: definition[4],
  });
}

for (const definition of [
  ['afds.autothrottleArmLeft', 'flightGuidance.autothrottleArmedLeft', 69836],
  ['afds.autothrottleArmRight', 'flightGuidance.autothrottleArmedRight', 69837],
] as const) {
  addMouseToggleActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
  });
}

for (const definition of [
  ['afds.apLeft.engage', 'flightGuidance.apLeft', 69835],
  ['afds.apRight.engage', 'flightGuidance.apRight', 69861],
  ['afds.lnav.engage', 'flightGuidance.lnav', 69843],
  ['afds.vnav.engage', 'flightGuidance.vnav', 69844],
  ['afds.levelChange.engage', 'flightGuidance.flch', 69845],
  ['afds.headingHold.engage', 'flightGuidance.headingHold', 69851],
  ['afds.verticalSpeed.engage', 'flightGuidance.verticalSpeed', 69855],
  ['afds.altitudeHold.engage', 'flightGuidance.altitudeHold', 69858],
  ['afds.vorLoc.engage', 'flightGuidance.localizer', 69859],
  ['afds.approach.engage', 'flightGuidance.approach', 69860],
] as const) {
  actions[definition[0]] = pressSdkAction({
    actionId: definition[0],
    fieldId: definition[1],
    eventId: definition[2],
    groupId: `pmdg777.${definition[1]}`,
    expectedValue: true,
  });
}

for (const definition of [
  ['lights.landingLeft', 'lights.landingLeft', 69654],
  ['lights.landingNose', 'lights.landingNose', 69655],
  ['lights.landingRight', 'lights.landingRight', 69656],
  ['lights.beacon', 'lights.beacon', 69746],
  ['lights.nav', 'lights.nav', 69747],
  ['lights.logo', 'lights.logo', 69748],
  ['lights.wing', 'lights.wing', 69749],
  ['lights.turnoffLeft', 'lights.turnoffLeft', 69751],
  ['lights.turnoffRight', 'lights.turnoffRight', 69752],
  ['lights.taxi', 'lights.taxi', 69753],
  ['lights.strobe', 'lights.strobe', 69754],
] as const) {
  addMouseToggleActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
  });
}

addDetentActions({
  prefix: 'lights.emergency',
  fieldId: 'lights.emergencyMode',
  groupId: 'pmdg777.lights.emergency',
  eventId: 69681,
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'armed', rawValue: 1, value: 'armed' },
    { id: 'on', rawValue: 2, value: 'on' },
  ],
});

for (const definition of [
  ['cabin.noSmoking', 'cabin.noSmokingMode', 69661],
  ['cabin.seatBelts', 'cabin.seatBeltsMode', 69662],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'auto', rawValue: 1, value: 'auto' },
      { id: 'on', rawValue: 2, value: 'on' },
    ],
  });
}

for (const definition of [
  ['visibility.wiperLeft', 'visibility.wiperLeftMode', 69652],
  ['visibility.wiperRight', 'visibility.wiperRightMode', 69755],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'intermittent', rawValue: 1, value: 'intermittent' },
      { id: 'low', rawValue: 2, value: 'low' },
      { id: 'high', rawValue: 3, value: 'high' },
    ],
  });
}

// The remainder of this catalog is restricted to persistent cockpit controls
// that have a matching PMDG ClientData readback. Two-state controls use one
// complete mouse click only when the requested state differs from fresh
// readback, avoiding unverified per-control numeric position polarity.
// Guarded emergency/maintenance controls, spring-loaded controls without an
// outcome readback, doors, trim, thrust axes, fire controls, oxygen deployment,
// IDG disconnects, RAT, and fuel jettison stay excluded.

for (const definition of [
  ['systems.adiru', 'systems.adiruOn', 69691],
  ['systems.electrical.cabinUtility', 'systems.electrical.cabinUtility', 69650],
  ['systems.electrical.ifePassengerSeats', 'systems.electrical.ifePassengerSeats', 69649],
  ['systems.electrical.battery', 'systems.electrical.batteryOn', 69633],
  ['systems.electrical.apuGenerator', 'systems.electrical.apuGeneratorOn', 69634],
  ['systems.electrical.generatorLeft', 'systems.electrical.generatorLeftOn', 69641],
  ['systems.electrical.generatorRight', 'systems.electrical.generatorRightOn', 69642],
  ['systems.electrical.backupGeneratorLeft', 'systems.electrical.backupGeneratorLeftOn', 69643],
  ['systems.electrical.backupGeneratorRight', 'systems.electrical.backupGeneratorRightOn', 69644],
  ['systems.ice.windowHeatLeftSide', 'systems.ice.windowHeatLeftSide', 69677],
  ['systems.ice.windowHeatLeftForward', 'systems.ice.windowHeatLeftForward', 69678],
  ['systems.ice.windowHeatRightForward', 'systems.ice.windowHeatRightForward', 69679],
  ['systems.ice.windowHeatRightSide', 'systems.ice.windowHeatRightSide', 69680],
  ['systems.hydraulics.enginePumpLeft', 'systems.hydraulics.enginePumpLeftOn', 69671],
  ['systems.hydraulics.enginePumpRight', 'systems.hydraulics.enginePumpRightOn', 69674],
  ['systems.hydraulics.electricPumpLeft', 'systems.hydraulics.electricPumpLeftOn', 69672],
  ['systems.hydraulics.electricPumpRight', 'systems.hydraulics.electricPumpRightOn', 69673],
  ['systems.fuel.crossfeedForward', 'systems.fuel.crossfeedForwardOn', 69739],
  ['systems.fuel.crossfeedAft', 'systems.fuel.crossfeedAftOn', 69740],
  ['systems.fuel.pumpForwardLeft', 'systems.fuel.pumpForwardLeftOn', 69735],
  ['systems.fuel.pumpForwardRight', 'systems.fuel.pumpForwardRightOn', 69736],
  ['systems.fuel.pumpAftLeft', 'systems.fuel.pumpAftLeftOn', 69737],
  ['systems.fuel.pumpAftRight', 'systems.fuel.pumpAftRightOn', 69738],
  ['systems.fuel.pumpCenterLeft', 'systems.fuel.pumpCenterLeftOn', 69741],
  ['systems.fuel.pumpCenterRight', 'systems.fuel.pumpCenterRightOn', 69742],
  ['systems.air.trimAirLeft', 'systems.air.trimAirLeftOn', 69769],
  ['systems.air.trimAirRight', 'systems.air.trimAirRightOn', 69770],
  ['systems.air.recircUpper', 'systems.air.recircUpperOn', 69774],
  ['systems.air.recircLower', 'systems.air.recircLowerOn', 69775],
  ['systems.air.gasper', 'systems.air.gasperOn', 69777],
  ['systems.engine.autostart', 'systems.engine.autostartOn', 69728],
  ['systems.serviceInterphone', 'systems.serviceInterphoneOn', 69683],
] as const) {
  addMouseToggleActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
  });
}

for (const definition of [
  ['systems.electrical.busTieLeft', 'systems.electrical.busTieLeftMode', 69637],
  ['systems.electrical.busTieRight', 'systems.electrical.busTieRightMode', 69638],
  ['systems.air.packLeft', 'systems.packLeft', 69767],
  ['systems.air.packRight', 'systems.packRight', 69768],
  ['systems.air.engineBleedLeft', 'systems.engineBleedLeft', 69761],
  ['systems.air.engineBleedRight', 'systems.engineBleedRight', 69762],
  ['systems.air.apuBleed', 'systems.apuBleed', 69763],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'auto', rawValue: 1, value: 'auto' },
    ],
  });
}

addDetentActions({
  prefix: 'systems.electrical.standbyPower',
  fieldId: 'systems.electrical.standbyPowerMode',
  groupId: 'pmdg777.systems.electrical.standbyPower',
  eventId: 69713,
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'auto', rawValue: 1, value: 'auto' },
    { id: 'battery', rawValue: 2, value: 'battery' },
  ],
});

addDetentActions({
  prefix: 'systems.apuSelector',
  fieldId: 'systems.apuSelectorMode',
  groupId: 'pmdg777.systems.apuSelector',
  eventId: 69635,
  // START is spring-loaded and APURunning can take much longer than the
  // confirmation window, so only stable OFF/ON positions are exposed.
  positions: [
    { id: 'off', rawValue: 0, value: 'off' },
    { id: 'on', rawValue: 1, value: 'on' },
  ],
});

addDetentActions({
  prefix: 'systems.thrustAsymComp',
  fieldId: 'systems.thrustAsymCompMode',
  groupId: 'pmdg777.systems.thrustAsymComp',
  eventId: 69686,
  positions: [
    { id: 'disconnect', rawValue: 0, value: 'disconnect' },
    { id: 'auto', rawValue: 1, value: 'auto' },
  ],
});

for (const definition of [
  ['systems.hydraulics.demandElectricLeft', 'systems.hydraulics.demandElectricLeftMode', 69667],
  ['systems.hydraulics.demandElectricRight', 'systems.hydraulics.demandElectricRightMode', 69670],
  ['systems.hydraulics.demandAirLeft', 'systems.hydraulics.demandAirLeftMode', 69668],
  ['systems.hydraulics.demandAirRight', 'systems.hydraulics.demandAirRightMode', 69669],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'auto', rawValue: 1, value: 'auto' },
      { id: 'on', rawValue: 2, value: 'on' },
    ],
  });
}

for (const definition of [
  ['systems.antiIce.wing', 'systems.wingAntiIce', 69743],
  ['systems.antiIce.engineLeft', 'systems.engineAntiIceLeft', 69744],
  ['systems.antiIce.engineRight', 'systems.engineAntiIceRight', 69745],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'auto', rawValue: 1, value: 'auto' },
      { id: 'on', rawValue: 2, value: 'on' },
    ],
  });
}

for (const definition of [
  ['systems.air.equipmentCooling', 'systems.air.equipmentCoolingMode', 69776, 'override', 'auto'],
  ['systems.air.outflowForward', 'systems.air.outflowForwardMode', 69759, 'manual', 'auto'],
  ['systems.air.outflowAft', 'systems.air.outflowAftMode', 69760, 'manual', 'auto'],
  ['systems.air.mainDeckFlow', 'systems.air.mainDeckFlowMode', 70685, 'high', 'normal'],
  ['systems.engine.eecLeft', 'systems.engine.eecLeftMode', 69722, 'alternate', 'normal'],
  ['systems.engine.eecRight', 'systems.engine.eecRightMode', 69724, 'alternate', 'normal'],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: definition[3], rawValue: 0, value: definition[3] },
      { id: definition[4], rawValue: 1, value: definition[4] },
    ],
  });
}

for (const definition of [
  ['systems.engine.startLeft', 'systems.engine.startLeftMode', 69726],
  ['systems.engine.startRight', 'systems.engine.startRightMode', 69727],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'start', rawValue: 0, value: 'start' },
      { id: 'normal', rawValue: 1, value: 'normal' },
    ],
  });
}

for (const definition of [
  ['systems.engine.fuelControlLeft', 'systems.engine.fuelControlLeftMode', 70152],
  ['systems.engine.fuelControlRight', 'systems.engine.fuelControlRightMode', 70153],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'cutoff', rawValue: 0, value: 'cutoff' },
      { id: 'run', rawValue: 1, value: 'run' },
    ],
  });
}

// External-power pushbuttons are momentary controls. Their persistent ON
// annunciators provide the requested-state readback needed to make logical
// ON/OFF requests deterministic.
for (const definition of [
  ['systems.electrical.externalPowerPrimary', 'systems.electrical.externalPowerPrimaryOn', 69640],
  ['systems.electrical.externalPowerSecondary', 'systems.electrical.externalPowerSecondaryOn', 69639],
] as const) {
  addMouseToggleActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
  });
}

for (const [suffix, rawValue, expectedValue] of [
  ['up', 0, false],
  ['down', 1, true],
] as const) {
  const actionId = `controls.gear.${suffix}`;
  actions[actionId] = setSdkPositionAction({
    actionId,
    eventId: 69927,
    fieldId: 'controls.gearDown',
    groupId: 'pmdg777.controls.gear',
    rawValue,
    expectedValue,
  });
}

addDetentActions({
  prefix: 'controls.autobrake',
  fieldId: 'controls.autobrakeMode',
  groupId: 'pmdg777.controls.autobrake',
  eventId: 69924,
  positions: [
    { id: 'rto', rawValue: 0, value: 'rto' },
    { id: 'off', rawValue: 1, value: 'off' },
    { id: 'disarm', rawValue: 2, value: 'disarm' },
    { id: 'one', rawValue: 3, value: '1' },
    { id: 'two', rawValue: 4, value: '2' },
    { id: 'max', rawValue: 5, value: 'max' },
  ],
});

// PMDG publishes dedicated mouse events for every flap and speedbrake target.
// Use the sample's complete press/release sequence; zero is not a mouse action.
for (const [suffix, eventId, expectedValue] of [
  ['up', 74703, 'UP'],
  ['one', 74704, '1'],
  ['five', 74705, '5'],
  ['fifteen', 74706, '15'],
  ['twenty', 74707, '20'],
  ['twentyFive', 74708, '25'],
  ['thirty', 74709, '30'],
] as const) {
  const actionId = `controls.flaps.${suffix}`;
  actions[actionId] = pressSdkAction({
    actionId,
    eventId,
    fieldId: 'controls.flapsLabel',
    groupId: 'pmdg777.controls.flaps',
    expectedValue,
  });
}

for (const [suffix, eventId, expectedValue] of [
  ['stowed', 74613, 0],
  ['armed', 74614, 25],
] as const) {
  const actionId = `controls.speedbrake.${suffix}`;
  actions[actionId] = pressSdkAction({
    actionId,
    eventId,
    fieldId: 'controls.speedbrakePercent',
    groupId: 'pmdg777.controls.speedbrake',
    expectedValue,
  });
}

addMouseToggleActions({
  prefix: 'controls.parkingBrake',
  fieldId: 'controls.parkingBrake',
  groupId: 'pmdg777.controls.parkingBrake',
  eventId: 70147,
});

for (const definition of [
  ['displays.inboardLeft', 'displays.inboardLeftMode', 69947, [
    ['nd', 0, 'nd'], ['nav', 1, 'nav'], ['mfd', 2, 'mfd'], ['eicas', 3, 'eicas'],
  ]],
  ['displays.inboardRight', 'displays.inboardRightMode', 69922, [
    ['eicas', 0, 'eicas'], ['mfd', 1, 'mfd'], ['nd', 2, 'nd'], ['pfd', 3, 'pfd'],
  ]],
  ['displays.fmcSource', 'displays.fmcSourceMode', 69923, [
    ['left', 0, 'left'], ['auto', 1, 'auto'], ['right', 2, 'right'],
  ]],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: definition[3].map(([id, rawValue, value]) => ({ id, rawValue, value })),
  });
}

for (const side of [
  {
    id: 'captain',
    minimumsEvent: 69813,
    vorAdfLeftEvent: 69816,
    modeEvent: 69817,
    rangeEvent: 69819,
    vorAdfRightEvent: 69821,
    baroUnitsEvent: 69822,
  },
  {
    id: 'firstOfficer',
    minimumsEvent: 69880,
    vorAdfLeftEvent: 69883,
    modeEvent: 69884,
    rangeEvent: 69886,
    vorAdfRightEvent: 69888,
    baroUnitsEvent: 69889,
  },
] as const) {
  addDetentActions({
    prefix: `efis.${side.id}.minimums`,
    fieldId: `efis.${side.id}.minimumsMode`,
    groupId: `pmdg777.efis.${side.id}.minimums`,
    eventId: side.minimumsEvent,
    positions: [
      { id: 'radio', rawValue: 0, value: 'radio' },
      { id: 'baro', rawValue: 1, value: 'baro' },
    ],
  });
  addDetentActions({
    prefix: `efis.${side.id}.baroUnits`,
    fieldId: `efis.${side.id}.baroUnitsMode`,
    groupId: `pmdg777.efis.${side.id}.baroUnits`,
    eventId: side.baroUnitsEvent,
    positions: [
      { id: 'inhg', rawValue: 0, value: 'inhg' },
      { id: 'hpa', rawValue: 1, value: 'hpa' },
    ],
  });
  for (const [selector, eventId] of [
    ['left', side.vorAdfLeftEvent],
    ['right', side.vorAdfRightEvent],
  ] as const) {
    addDetentActions({
      prefix: `efis.${side.id}.bearing${selector === 'left' ? 'Left' : 'Right'}`,
      fieldId: `efis.${side.id}.bearing${selector === 'left' ? 'Left' : 'Right'}Mode`,
      groupId: `pmdg777.efis.${side.id}.bearing.${selector}`,
      eventId,
      positions: [
        { id: 'vor', rawValue: 0, value: 'vor' },
        { id: 'off', rawValue: 1, value: 'off' },
        { id: 'adf', rawValue: 2, value: 'adf' },
      ],
    });
  }
  addDetentActions({
    prefix: `efis.${side.id}.mapMode`,
    fieldId: `efis.${side.id}.mapMode`,
    groupId: `pmdg777.efis.${side.id}.mapMode`,
    eventId: side.modeEvent,
    positions: [
      { id: 'approach', rawValue: 0, value: 'approach' },
      { id: 'vor', rawValue: 1, value: 'vor' },
      { id: 'map', rawValue: 2, value: 'map' },
      { id: 'plan', rawValue: 3, value: 'plan' },
    ],
  });
  addDetentActions({
    prefix: `efis.${side.id}.range`,
    fieldId: `efis.${side.id}.rangeNm`,
    groupId: `pmdg777.efis.${side.id}.range`,
    eventId: side.rangeEvent,
    positions: [
      { id: 'ten', rawValue: 0, value: '10' },
      { id: 'twenty', rawValue: 1, value: '20' },
      { id: 'forty', rawValue: 2, value: '40' },
      { id: 'eighty', rawValue: 3, value: '80' },
      { id: 'oneSixty', rawValue: 4, value: '160' },
      { id: 'threeTwenty', rawValue: 5, value: '320' },
      { id: 'sixForty', rawValue: 6, value: '640' },
    ],
  });
}

addDetentActions({
  prefix: 'mcp.bankLimit',
  fieldId: 'flightGuidance.bankLimitMode',
  groupId: 'pmdg777.mcp.heading',
  eventId: 71813,
  positions: [
    { id: 'auto', rawValue: 0, value: 'auto' },
    { id: 'five', rawValue: 1, value: '5' },
    { id: 'ten', rawValue: 2, value: '10' },
    { id: 'fifteen', rawValue: 3, value: '15' },
    { id: 'twenty', rawValue: 4, value: '20' },
    { id: 'twentyFive', rawValue: 5, value: '25' },
  ],
});

addDetentActions({
  prefix: 'mcp.altitudeIncrement',
  fieldId: 'flightGuidance.altitudeIncrementMode',
  groupId: 'pmdg777.mcp.altitude',
  eventId: 69857,
  positions: [
    { id: 'auto', rawValue: 0, value: 'auto' },
    { id: 'thousand', rawValue: 1, value: '1000' },
  ],
});

for (const side of [
  { id: 'captain', timeDateEvent: 69804, elapsedEvent: 69805, setEvent: 69806 },
  { id: 'firstOfficer', timeDateEvent: 69912, elapsedEvent: 69913, setEvent: 69914 },
] as const) {
  addDetentActions({
    prefix: `chronometer.${side.id}.timeDate`,
    fieldId: `chronometer.${side.id}.timeDateMode`,
    groupId: `pmdg777.chronometer.${side.id}.timeDate`,
    eventId: side.timeDateEvent,
    positions: [
      { id: 'utc', rawValue: 0, value: 'utc' },
      { id: 'manual', rawValue: 1, value: 'manual' },
    ],
  });
  addDetentActions({
    prefix: `chronometer.${side.id}.set`,
    fieldId: `chronometer.${side.id}.setMode`,
    groupId: `pmdg777.chronometer.${side.id}.set`,
    eventId: side.setEvent,
    positions: [
      { id: 'run', rawValue: 0, value: 'run' },
      { id: 'holdYear', rawValue: 1, value: 'hold-year' },
      { id: 'minutes', rawValue: 2, value: 'minutes' },
      { id: 'hoursDate', rawValue: 3, value: 'hours-date' },
    ],
  });
  addDetentActions({
    prefix: `chronometer.${side.id}.elapsed`,
    fieldId: `chronometer.${side.id}.elapsedMode`,
    groupId: `pmdg777.chronometer.${side.id}.elapsed`,
    eventId: side.elapsedEvent,
    // RESET is spring-loaded back to HOLD and therefore has no stable target.
    positions: [
      { id: 'hold', rawValue: 1, value: 'hold' },
      { id: 'run', rawValue: 2, value: 'run' },
    ],
  });
}

addDetentActions({
  prefix: 'transponder.source',
  fieldId: 'transponder.sourceMode',
  groupId: 'pmdg777.transponder.source',
  eventId: 70383,
  positions: [
    { id: 'left', rawValue: 0, value: 'left' },
    { id: 'right', rawValue: 1, value: 'right' },
  ],
});

addDetentActions({
  prefix: 'transponder.altitudeSource',
  fieldId: 'transponder.altitudeSourceMode',
  groupId: 'pmdg777.transponder.altitudeSource',
  eventId: 70375,
  positions: [
    { id: 'normal', rawValue: 0, value: 'normal' },
    { id: 'alternate', rawValue: 1, value: 'alternate' },
  ],
});

addDetentActions({
  prefix: 'transponder.mode',
  fieldId: 'transponder.mode',
  groupId: 'pmdg777.transponder.mode',
  eventId: 70381,
  positions: [
    { id: 'standby', rawValue: 0, value: 'standby' },
    { id: 'altitudeOff', rawValue: 1, value: 'altitude-off' },
    { id: 'transponder', rawValue: 2, value: 'transponder' },
    { id: 'taOnly', rawValue: 3, value: 'ta-only' },
    { id: 'taRa', rawValue: 4, value: 'ta-ra' },
  ],
});

for (const definition of [
  ['lighting.storm', 'lights.storm', 69659],
] as const) {
  addMouseToggleActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
  });
}

addMouseToggleActions({
  prefix: 'lighting.masterBright',
  fieldId: 'lighting.masterBrightOn',
  groupId: 'pmdg777.lighting.masterBright',
  eventId: 72433,
});

addDetentActions({
  prefix: 'lighting.indicatorLights',
  fieldId: 'lighting.indicatorLightsMode',
  groupId: 'pmdg777.lighting.indicatorLights',
  eventId: 69750,
  positions: [
    { id: 'test', rawValue: 0, value: 'test' },
    { id: 'bright', rawValue: 1, value: 'bright' },
    { id: 'dim', rawValue: 2, value: 'dim' },
  ],
});

addDetentActions({
  prefix: 'lighting.floor',
  fieldId: 'lighting.floorMode',
  groupId: 'pmdg777.lighting.floor',
  eventId: 70367,
  positions: [
    { id: 'bright', rawValue: 0, value: 'bright' },
    { id: 'off', rawValue: 1, value: 'off' },
    { id: 'dim', rawValue: 2, value: 'dim' },
  ],
});

for (const definition of [
  ['lighting.dome.set', 'lighting.domePercent', 69658],
  ['lighting.circuitBreaker.set', 'lighting.circuitBreakerPercent', 72133],
  ['lighting.overheadPanel.set', 'lighting.overheadPanelPercent', 69657],
  ['lighting.glareshieldPanel.set', 'lighting.glareshieldPanelPercent', 69653],
  ['lighting.glareshieldFlood.set', 'lighting.glareshieldFloodPercent', 71733],
  ['lighting.masterBrightness.set', 'lighting.masterBrightnessPercent', 69660],
  ['lighting.leftPanel.set', 'lighting.leftPanelPercent', 69954],
  ['lighting.leftFlood.set', 'lighting.leftFloodPercent', 72852],
  ['lighting.leftOutboardDisplay.set', 'lighting.leftOutboardDisplayPercent', 69952],
  ['lighting.leftInboardDisplay.set', 'lighting.leftInboardDisplayPercent', 69953],
  ['lighting.rightPanel.set', 'lighting.rightPanelPercent', 69917],
  ['lighting.rightFlood.set', 'lighting.rightFloodPercent', 72482],
  ['lighting.rightInboardDisplay.set', 'lighting.rightInboardDisplayPercent', 69918],
  ['lighting.rightOutboardDisplay.set', 'lighting.rightOutboardDisplayPercent', 69919],
  ['lighting.upperDisplay.set', 'lighting.upperDisplayPercent', 70112],
  ['lighting.lowerDisplay.set', 'lighting.lowerDisplayPercent', 70113],
  ['lighting.aislePanel.set', 'lighting.aislePanelPercent', 70368],
  ['lighting.aisleFlood.set', 'lighting.aisleFloodPercent', 70369],
] as const) {
  actions[definition[0]] = setSdkNumberAction({
    actionId: definition[0],
    fieldId: definition[1],
    eventId: definition[2],
    groupId: `pmdg777.${definition[1]}`,
    input: { min: 0, max: 100, step: 1 },
    round: 'nearest',
  });
}

for (const definition of [
  ['comfort.flightDeckTemperature.set', 'comfort.flightDeckTemperaturePosition', 69771, 0, 60],
  ['comfort.cabinTemperature.set', 'comfort.cabinTemperaturePosition', 69772, 0, 60],
  ['comfort.leftShoulderHeat.set', 'comfort.leftShoulderHeatPercent', 69950, 0, 100],
  ['comfort.rightShoulderHeat.set', 'comfort.rightShoulderHeatPercent', 69921, 0, 100],
] as const) {
  actions[definition[0]] = setSdkNumberAction({
    actionId: definition[0],
    fieldId: definition[1],
    eventId: definition[2],
    groupId: `pmdg777.${definition[1]}`,
    input: { min: definition[3], max: definition[4], step: 1 },
    round: 'nearest',
  });
}

for (const definition of [
  ['comfort.leftFootHeat', 'comfort.leftFootHeatMode', 69951],
  ['comfort.rightFootHeat', 'comfort.rightFootHeatMode', 69920],
] as const) {
  addDetentActions({
    prefix: definition[0],
    fieldId: definition[1],
    groupId: `pmdg777.${definition[0]}`,
    eventId: definition[2],
    positions: [
      { id: 'off', rawValue: 0, value: 'off' },
      { id: 'low', rawValue: 1, value: 'low' },
      { id: 'high', rawValue: 2, value: 'high' },
    ],
  });
}

const PMDG_777_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = actions;

module.exports = {
  PMDG_777_ACTIONS,
};

export {};
