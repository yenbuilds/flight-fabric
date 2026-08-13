'use strict';

import type {
  AircraftIntegrationAction,
  AircraftIntegrationPrimitive,
} from '../types.js';

const DEFAULT_COOLDOWN_MS = 750;
const DEFAULT_READBACK_TIMEOUT_MS = 3000;

const actions: Record<string, AircraftIntegrationAction> = {};

function setLvarAction(params: {
  actionId: string;
  expectedValue: AircraftIntegrationPrimitive;
  fieldId: string;
  groupId: string;
  lvar: string;
  rawValue: number;
}): AircraftIntegrationAction {
  const routeStem = `fenixA32x.${params.actionId}`;
  const readback = {
    fieldId: params.fieldId,
    expectedValue: params.expectedValue,
    timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
  };
  return {
    id: params.actionId,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: `fenixA32x.${params.groupId}`,
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

function addPositions(params: {
  fieldId: string;
  groupId?: string;
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
      groupId: params.groupId || params.prefix,
      lvar: params.lvar,
      rawValue: position.rawValue,
    });
  }
}

function addBooleanActions(params: {
  falseSuffix?: string;
  fieldId: string;
  groupId?: string;
  lvar: string;
  prefix: string;
  trueSuffix?: string;
}): void {
  addPositions({
    ...params,
    positions: [
      {
        suffix: params.falseSuffix || 'off',
        rawValue: 0,
        expectedValue: false,
      },
      {
        suffix: params.trueSuffix || 'on',
        rawValue: 1,
        expectedValue: true,
      },
    ],
  });
}

function addDetentActions(params: {
  fieldId: string;
  groupId?: string;
  lvar: string;
  positions: ReadonlyArray<readonly [
    suffix: string,
    rawValue: number,
    expectedValue: AircraftIntegrationPrimitive,
  ]>;
  prefix: string;
}): void {
  addPositions({
    ...params,
    positions: params.positions.map(([suffix, rawValue, expectedValue]) => ({
      expectedValue,
      rawValue,
      suffix,
    })),
  });
}

function calculatorCode(lvar: string, operator: '++' | '--'): string {
  return `(L:${lvar}, Number) ${operator} (>L:${lvar}, Number)`;
}

function addMomentaryTargetActions(params: {
  fieldId: string;
  lvar: string;
  prefix: string;
}): void {
  const pulseCode = calculatorCode(params.lvar, '++');
  for (const [suffix, expectedValue] of [
    ['off', false],
    ['on', true],
  ] as const) {
    const actionId = `${params.prefix}.${suffix}`;
    actions[actionId] = {
      id: actionId,
      guard: {
        cooldownMs: DEFAULT_COOLDOWN_MS,
        groupId: `fenixA32x.${params.prefix}`,
        retry: 'never',
      },
      routes: [{
        id: `fenixA32x.${actionId}.mobiflightPulse`,
        transport: 'mobiflight-calculator',
        mode: 'pulse',
        pressCode: pulseCode,
        releaseCode: pulseCode,
        delayMs: 100,
        readback: {
          fieldId: params.fieldId,
          expectedValue,
          timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
        },
      }],
      verification: 'untested',
    };
  }
}

function addManagedTargetActions(params: {
  commandLvar: string;
  fieldId: string;
  groupId: string;
  prefix: string;
}): void {
  for (const [suffix, expectedValue, operator] of [
    ['off', false, '++'], // Pull the selector for a selected target.
    ['on', true, '--'], // Push the selector for managed guidance.
  ] as const) {
    const actionId = `${params.prefix}.${suffix}`;
    actions[actionId] = {
      id: actionId,
      guard: {
        cooldownMs: DEFAULT_COOLDOWN_MS,
        groupId: `fenixA32x.${params.groupId}`,
        retry: 'never',
      },
      routes: [{
        id: `fenixA32x.${actionId}.mobiflight`,
        transport: 'mobiflight-calculator',
        mode: 'single',
        code: calculatorCode(params.commandLvar, operator),
        readback: {
          fieldId: params.fieldId,
          expectedValue,
          timeoutMs: DEFAULT_READBACK_TIMEOUT_MS,
        },
      }],
      verification: 'untested',
    };
  }
}

function addSteppedTargetAction(params: {
  actionId: string;
  circular?: true;
  fieldId: string;
  groupId: string;
  input: Readonly<{ max: number; min: number; step: number; type: 'number' }>;
  lvar: string;
  precondition?: Readonly<{
    expectedValue: AircraftIntegrationPrimitive;
    fieldId: string;
  }>;
}): void {
  actions[params.actionId] = {
    id: params.actionId,
    input: params.input,
    guard: {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      groupId: `fenixA32x.${params.groupId}`,
      retry: 'never',
    },
    routes: [{
      id: `fenixA32x.${params.actionId}.mobiflightTarget`,
      transport: 'mobiflight-calculator',
      mode: 'step-to-target',
      decreaseCode: calculatorCode(params.lvar, '--'),
      increaseCode: calculatorCode(params.lvar, '++'),
      maxSteps: 500,
      ...(params.circular ? { circular: true as const } : {}),
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

// Two-position switches and latched buttons. These are exact assignments, not
// toggles: repeating a command is idempotent, every route has fresh logical
// readback, and no failed command retries automatically.
for (const [
  prefix,
  fieldId,
  lvar,
  falseSuffix,
  trueSuffix,
] of [
  ['lights.beacon', 'lights.beacon', 'S_OH_EXT_LT_BEACON', 'off', 'on'],
  ['lights.runwayTurnoff', 'lights.runwayTurnoff', 'S_OH_EXT_LT_RWY_TURNOFF', 'off', 'on'],
  ['lights.wing', 'lights.wing', 'S_OH_EXT_LT_WING', 'off', 'on'],

  ['cabin.seatBelts', 'cabin.seatBelts', 'S_OH_SIGNS', 'off', 'on'],
  ['displays.iceStandby', 'displays.iceStandby', 'S_OH_IN_LT_ICE', 'off', 'on'],
  ['displays.chartLightCaptain', 'displays.chartLightCaptain', 'S_CHART_LIGHT_TEMP_CAPT', 'off', 'on'],
  ['displays.chartLightFirstOfficer', 'displays.chartLightFirstOfficer', 'S_CHART_LIGHT_TEMP_FO', 'off', 'on'],

  ['systems.apuBleed', 'systems.apuBleed', 'S_OH_PNEUMATIC_APU_BLEED', 'off', 'on'],
  ['systems.apuGenerator', 'systems.apuGenerator', 'S_OH_ELEC_APU_GENERATOR', 'off', 'on'],
  ['systems.apuMaster', 'systems.apuMaster', 'S_OH_ELEC_APU_MASTER', 'off', 'on'],
  ['systems.battery1', 'systems.battery1', 'S_OH_ELEC_BAT1', 'off', 'auto'],
  ['systems.battery2', 'systems.battery2', 'S_OH_ELEC_BAT2', 'off', 'auto'],
  ['systems.commercial', 'systems.commercial', 'S_OH_ELEC_COMMERCIAL', 'off', 'on'],
  ['systems.galleyAndCabin', 'systems.galleyAndCabin', 'S_OH_ELEC_GALY', 'off', 'auto'],
  ['systems.generator1', 'systems.generator1', 'S_OH_ELEC_GEN1', 'off', 'on'],
  ['systems.generator2', 'systems.generator2', 'S_OH_ELEC_GEN2', 'off', 'on'],
  ['systems.generator1Line', 'systems.generator1Line', 'S_OH_ELEC_GEN1_LINE', 'off', 'on'],
  ['systems.acEssFeed', 'systems.acEssFeedAlternate', 'S_OH_ELEC_AC_ESS_FEED', 'normal', 'alternate'],

  ['systems.hydraulicEnginePump1', 'systems.hydraulicEnginePump1', 'S_OH_HYD_ENG_1_PUMP', 'off', 'auto'],
  ['systems.hydraulicEnginePump2', 'systems.hydraulicEnginePump2', 'S_OH_HYD_ENG_2_PUMP', 'off', 'auto'],
  ['systems.hydraulicPtu', 'systems.hydraulicPtu', 'S_OH_HYD_PTU', 'off', 'auto'],
  ['systems.hydraulicBlueElectricPump', 'systems.hydraulicBlueElectricPump', 'S_OH_HYD_BLUE_ELEC_PUMP', 'off', 'auto'],

  ['fuel.leftPump1', 'fuel.leftPump1', 'S_OH_FUEL_LEFT_1', 'off', 'on'],
  ['fuel.leftPump2', 'fuel.leftPump2', 'S_OH_FUEL_LEFT_2', 'off', 'on'],
  ['fuel.rightPump1', 'fuel.rightPump1', 'S_OH_FUEL_RIGHT_1', 'off', 'on'],
  ['fuel.rightPump2', 'fuel.rightPump2', 'S_OH_FUEL_RIGHT_2', 'off', 'on'],
  ['fuel.centerPump1', 'fuel.centerPump1', 'S_OH_FUEL_CENTER_1', 'off', 'on'],
  ['fuel.centerPump2', 'fuel.centerPump2', 'S_OH_FUEL_CENTER_2', 'off', 'on'],
  ['fuel.crossfeed', 'fuel.crossfeedOpen', 'S_OH_FUEL_XFEED', 'closed', 'open'],
  ['fuel.mode', 'fuel.modeManual', 'S_OH_FUEL_MODE_SEL', 'auto', 'manual'],
  ['fuel.actTransfer', 'fuel.actTransfer', 'S_OH_FUEL_ACT', 'off', 'on'],

  ['systems.engineAntiIce1', 'systems.engineAntiIce1', 'S_OH_PNEUMATIC_ENG1_ANTI_ICE', 'off', 'on'],
  ['systems.engineAntiIce2', 'systems.engineAntiIce2', 'S_OH_PNEUMATIC_ENG2_ANTI_ICE', 'off', 'on'],
  ['systems.engineBleed1', 'systems.engineBleed1', 'S_OH_PNEUMATIC_ENG1_BLEED', 'off', 'on'],
  ['systems.engineBleed2', 'systems.engineBleed2', 'S_OH_PNEUMATIC_ENG2_BLEED', 'off', 'on'],
  ['systems.pack1', 'systems.pack1', 'S_OH_PNEUMATIC_PACK_1', 'off', 'on'],
  ['systems.pack2', 'systems.pack2', 'S_OH_PNEUMATIC_PACK_2', 'off', 'on'],
  ['systems.wingAntiIce', 'systems.wingAntiIce', 'S_OH_PNEUMATIC_WING_ANTI_ICE', 'off', 'on'],
  ['systems.ramAir', 'systems.ramAir', 'S_OH_PNEUMATIC_RAM_AIR', 'off', 'on'],
  ['systems.hotAir', 'systems.hotAir', 'S_OH_PNEUMATIC_HOT_AIR', 'off', 'on'],
  ['systems.probeHeat', 'systems.probeHeat', 'S_OH_PROBE_HEAT', 'auto', 'on'],
  ['systems.pressurization', 'systems.pressurizationManual', 'S_OH_PNEUMATIC_PRESS_MODE', 'auto', 'manual'],
  ['systems.blower', 'systems.blower', 'S_OH_PNEUMATIC_BLOWER', 'off', 'on'],
  ['systems.extract', 'systems.extract', 'S_OH_PNEUMATIC_EXTRACT', 'off', 'on'],
  ['systems.cabinFans', 'systems.cabinFans', 'S_OH_PNEUMATIC_CAB_FANS', 'off', 'on'],
  ['systems.cargoHotAir', 'systems.cargoHotAir', 'S_OH_PNEUMATIC_HOT_AIR_AFT_CARGO', 'off', 'on'],
  ['systems.cargoAftIsolation', 'systems.cargoAftIsolation', 'S_OH_PNEUMATIC_CARGO_AFT_ISOL_VALVE', 'closed', 'open'],

  ['systems.brakeFan', 'systems.brakeFan', 'S_MIP_BRAKE_FAN', 'off', 'on'],
  ['systems.antiSkid', 'systems.antiSkid', 'S_FC_MIP_ANTI_SKID', 'off', 'on'],
  ['systems.parkingBrake', 'systems.parkingBrake', 'S_MIP_PARKING_BRAKE', 'released', 'set'],
  ['systems.engineManualStart1', 'systems.engineManualStart1', 'S_OH_ENG_MANSTART_1', 'off', 'on'],
  ['systems.engineManualStart2', 'systems.engineManualStart2', 'S_OH_ENG_MANSTART_2', 'off', 'on'],
  ['systems.engineN1Mode1', 'systems.engineN1Mode1', 'S_OH_ENG_N1_MODE_1', 'off', 'on'],
  ['systems.engineN1Mode2', 'systems.engineN1Mode2', 'S_OH_ENG_N1_MODE_2', 'off', 'on'],

  ['safety.gpwsSystem', 'safety.gpwsSystemOff', 'S_OH_GPWS_SYS', 'normal', 'off'],
  ['safety.gpwsTerrain', 'safety.gpwsTerrainOff', 'S_OH_GPWS_TERR', 'normal', 'off'],
  ['safety.gpwsGlideslope', 'safety.gpwsGlideslopeOff', 'S_OH_GPWS_GS_MODE', 'normal', 'off'],
  ['safety.gpwsFlapMode', 'safety.gpwsFlapModeOff', 'S_OH_GPWS_FLAP_MODE', 'normal', 'off'],
  ['safety.gpwsLandingFlap3', 'safety.gpwsLandingFlap3', 'S_OH_GPWS_LDG_FLAP3', 'off', 'on'],

  ['surveillance.rmpCaptainPower', 'surveillance.rmpCaptainPower', 'S_PED_RMP1_POWER', 'off', 'on'],
  ['surveillance.rmpFirstOfficerPower', 'surveillance.rmpFirstOfficerPower', 'S_PED_RMP2_POWER', 'off', 'on'],
  ['surveillance.rmpThirdPower', 'surveillance.rmpThirdPower', 'S_PED_RMP3_POWER', 'off', 'on'],
  ['surveillance.weatherRadarMultiscan', 'surveillance.weatherRadarMultiscanAuto', 'S_WR_MULTISCAN', 'manual', 'auto'],
  ['surveillance.weatherRadarPws', 'surveillance.weatherRadarPwsAuto', 'S_WR_PRED_WS', 'off', 'auto'],
  ['surveillance.altitudeReporting', 'surveillance.altitudeReporting', 'S_XPDR_ALTREPORTING', 'off', 'on'],

  ['controls.cockpitDoorVideo', 'controls.cockpitDoorVideo', 'S_OH_COCKPIT_DOOR_VIDEO', 'off', 'on'],
] as const) {
  addBooleanActions({
    falseSuffix,
    fieldId,
    lvar,
    prefix,
    trueSuffix,
  });
}

for (const [prefix, fieldId, lvar, positions] of [
  ['lights.landingLeft', 'lights.landingLeftMode', 'S_OH_EXT_LT_LANDING_L', [
    ['retract', 0, 'retract'],
    ['off', 1, 'off'],
    ['on', 2, 'on'],
  ]],
  ['lights.landingRight', 'lights.landingRightMode', 'S_OH_EXT_LT_LANDING_R', [
    ['retract', 0, 'retract'],
    ['off', 1, 'off'],
    ['on', 2, 'on'],
  ]],
  ['lights.navLogo', 'lights.navLogoMode', 'S_OH_EXT_LT_NAV_LOGO', [
    ['off', 0, 'off'],
    ['nav', 1, 'nav'],
    ['logo', 2, 'logo'],
  ]],
  ['lights.nose', 'lights.noseMode', 'S_OH_EXT_LT_NOSE', [
    ['off', 0, 'off'],
    ['taxi', 1, 'taxi'],
    ['takeoff', 2, 'takeoff'],
  ]],
  ['lights.strobe', 'lights.strobeMode', 'S_OH_EXT_LT_STROBE', [
    ['off', 0, 'off'],
    ['auto', 1, 'auto'],
    ['on', 2, 'on'],
  ]],

  ['cabin.emergencyExit', 'cabin.emergencyExitMode', 'S_OH_INT_LT_EMER', [
    ['off', 0, 'off'],
    ['arm', 1, 'arm'],
    ['on', 2, 'on'],
  ]],
  ['cabin.noSmoking', 'cabin.noSmokingMode', 'S_OH_SIGNS_SMOKING', [
    ['off', 0, 'off'],
    ['auto', 1, 'auto'],
    ['on', 2, 'on'],
  ]],
  ['visibility.wiperCaptain', 'visibility.wiperCaptainMode', 'S_MISC_WIPER_CAPT', [
    ['off', 0, 'off'],
    ['slow', 1, 'slow'],
    ['fast', 2, 'fast'],
  ]],
  ['visibility.wiperFirstOfficer', 'visibility.wiperFirstOfficerMode', 'S_MISC_WIPER_FO', [
    ['off', 0, 'off'],
    ['slow', 1, 'slow'],
    ['fast', 2, 'fast'],
  ]],

  ['displays.domeLight', 'displays.domeLightMode', 'S_OH_INT_LT_DOME', [
    ['off', 0, 'off'],
    ['dim', 1, 'dim'],
    ['bright', 2, 'bright'],
  ]],
  ['displays.annunciator', 'displays.annunciatorMode', 'S_OH_IN_LT_ANN_LT', [
    ['bright', 0, 'bright'],
    ['dim', 1, 'dim'],
    ['test', 2, 'test'],
  ]],
  ['displays.consoleFloorCaptain', 'displays.consoleFloorCaptainMode', 'S_MIP_LIGHT_CONSOLEFLOOR_CAPT', [
    ['off', 0, 'off'],
    ['dim', 1, 'dim'],
    ['bright', 2, 'bright'],
  ]],
  ['displays.consoleFloorFirstOfficer', 'displays.consoleFloorFirstOfficerMode', 'S_MIP_LIGHT_CONSOLEFLOOR_FO', [
    ['off', 0, 'off'],
    ['dim', 1, 'dim'],
    ['bright', 2, 'bright'],
  ]],

  ['systems.crossBleed', 'systems.crossBleedMode', 'S_OH_PNEUMATIC_XBLEED_SELECTOR', [
    ['shut', 0, 'shut'],
    ['auto', 1, 'auto'],
    ['open', 2, 'open'],
  ]],
  ['systems.ir1', 'systems.ir1Mode', 'S_OH_NAV_IR1_MODE', [
    ['off', 0, 'off'],
    ['nav', 1, 'nav'],
    ['att', 2, 'att'],
  ]],
  ['systems.ir2', 'systems.ir2Mode', 'S_OH_NAV_IR2_MODE', [
    ['off', 0, 'off'],
    ['nav', 1, 'nav'],
    ['att', 2, 'att'],
  ]],
  ['systems.ir3', 'systems.ir3Mode', 'S_OH_NAV_IR3_MODE', [
    ['off', 0, 'off'],
    ['nav', 1, 'nav'],
    ['att', 2, 'att'],
  ]],
  ['systems.packFlow', 'systems.packFlowMode', 'S_OH_PNEUMATIC_PACK_FLOW', [
    ['low', 0, 'low'],
    ['normal', 1, 'normal'],
    ['high', 2, 'high'],
  ]],
  ['systems.engineMode', 'systems.engineMode', 'S_ENG_MODE', [
    ['crank', 0, 'crank'],
    ['normal', 1, 'normal'],
    ['start', 2, 'start'],
  ]],
  ['systems.clockUtc', 'systems.clockUtcMode', 'S_MIP_CLOCK_UTC', [
    ['gps', 0, 'gps'],
    ['internal', 1, 'internal'],
    ['set', 2, 'set'],
  ]],

  ['flightGuidance.baroUnitCaptain', 'flightGuidance.baroUnitCaptain', 'S_FCU_EFIS1_BARO_MODE', [
    ['inhg', 0, 'inhg'],
    ['hpa', 1, 'hpa'],
  ]],
  ['flightGuidance.baroUnitFirstOfficer', 'flightGuidance.baroUnitFirstOfficer', 'S_FCU_EFIS2_BARO_MODE', [
    ['inhg', 0, 'inhg'],
    ['hpa', 1, 'hpa'],
  ]],
  ['navigation.navaidCaptain1', 'navigation.navaidCaptain1', 'S_FCU_EFIS1_NAV1', [
    ['adf', 0, 'adf'],
    ['off', 1, 'off'],
    ['vor', 2, 'vor'],
  ]],
  ['navigation.navaidCaptain2', 'navigation.navaidCaptain2', 'S_FCU_EFIS1_NAV2', [
    ['adf', 0, 'adf'],
    ['off', 1, 'off'],
    ['vor', 2, 'vor'],
  ]],
  ['navigation.navaidFirstOfficer1', 'navigation.navaidFirstOfficer1', 'S_FCU_EFIS2_NAV1', [
    ['adf', 0, 'adf'],
    ['off', 1, 'off'],
    ['vor', 2, 'vor'],
  ]],
  ['navigation.navaidFirstOfficer2', 'navigation.navaidFirstOfficer2', 'S_FCU_EFIS2_NAV2', [
    ['adf', 0, 'adf'],
    ['off', 1, 'off'],
    ['vor', 2, 'vor'],
  ]],

  ['switching.attitudeHeading', 'switching.attitudeHeading', 'S_DISPLAY_ATT_HDG', [
    ['captain', 0, 'captain'],
    ['normal', 1, 'normal'],
    ['firstOfficer', 2, 'firstOfficer'],
  ]],
  ['switching.airData', 'switching.airData', 'S_DISPLAY_AIR_DATA', [
    ['captain', 0, 'captain'],
    ['normal', 1, 'normal'],
    ['firstOfficer', 2, 'firstOfficer'],
  ]],
  ['switching.eisDmc', 'switching.eisDmc', 'S_DISPLAY_EIS_DMC', [
    ['captain', 0, 'captain'],
    ['normal', 1, 'normal'],
    ['firstOfficer', 2, 'firstOfficer'],
  ]],
  ['switching.ecamNd', 'switching.ecamNd', 'S_DISPLAY_ECAM_ND_XFR', [
    ['captain', 0, 'captain'],
    ['normal', 1, 'normal'],
    ['firstOfficer', 2, 'firstOfficer'],
  ]],
  ['switching.audio', 'switching.audio', 'S_AUDIO_SWITCHING', [
    ['captain', 0, 'captain'],
    ['normal', 1, 'normal'],
    ['firstOfficer', 2, 'firstOfficer'],
  ]],

  ['surveillance.weatherRadarSystem', 'surveillance.weatherRadarSystem', 'S_WR_SYS', [
    ['system1', 0, 'system1'],
    ['off', 1, 'off'],
    ['system2', 2, 'system2'],
  ]],
  ['surveillance.transponderOperation', 'surveillance.transponderOperation', 'S_XPDR_OPERATION', [
    ['standby', 0, 'standby'],
    ['auto', 1, 'auto'],
    ['on', 2, 'on'],
  ]],
  ['surveillance.transponderSystem', 'surveillance.transponderSystem', 'S_XPDR_ATC', [
    ['system1', 0, 'system1'],
    ['system2', 1, 'system2'],
  ]],
  ['surveillance.transponderMode', 'surveillance.transponderMode', 'S_XPDR_MODE', [
    ['standby', 0, 'standby'],
    ['ta', 1, 'ta'],
    ['taRa', 2, 'taRa'],
  ]],
] as const) {
  addDetentActions({
    fieldId,
    lvar,
    positions,
    prefix,
  });
}

addDetentActions({
  prefix: 'flightGuidance.altitudeIncrement',
  fieldId: 'flightGuidance.altitudeIncrementMode',
  groupId: 'flightGuidance.altitude',
  lvar: 'S_FCU_ALTITUDE_SCALE',
  positions: [
    ['hundred', 1, 'hundred'],
    ['thousand', 0, 'thousand'],
  ],
});

for (const [prefix, fieldId, lvar] of [
  ['lighting.fcu', 'lighting.fcu', 'A_FCU_LIGHTING'],
  ['lighting.overhead', 'lighting.overhead', 'A_OH_LIGHTING_OVD'],
  ['lighting.pedestal', 'lighting.pedestal', 'A_PED_LIGHTING_PEDESTAL'],
] as const) {
  addDetentActions({
    fieldId,
    lvar,
    prefix,
    positions: [
      ['off', 0, 0],
      ['quarter', 0.25, 0.25],
      ['half', 0.5, 0.5],
      ['threeQuarter', 0.75, 0.75],
      ['full', 1, 1],
    ],
  });
}

// Fenix momentary FCU buttons publish stable I_FCU_* outcomes but require the
// shipped S_FCU_* counter to advance once for press and once for release.
for (const [prefix, fieldId, lvar] of [
  ['flightGuidance.ap1', 'flightGuidance.ap1', 'S_FCU_AP1'],
  ['flightGuidance.ap2', 'flightGuidance.ap2', 'S_FCU_AP2'],
  ['flightGuidance.autothrust', 'flightGuidance.autothrust', 'S_FCU_ATHR'],
  ['flightGuidance.localizer', 'flightGuidance.localizer', 'S_FCU_LOC'],
  ['flightGuidance.approach', 'flightGuidance.approach', 'S_FCU_APPR'],
  ['flightGuidance.expedite', 'flightGuidance.expedite', 'S_FCU_EXPED'],
] as const) {
  addMomentaryTargetActions({ fieldId, lvar, prefix });
}

for (const [prefix, fieldId, commandLvar, groupId] of [
  ['flightGuidance.speedManaged', 'flightGuidance.speedManaged', 'S_FCU_SPEED', 'flightGuidance.speed'],
  ['flightGuidance.headingManaged', 'flightGuidance.headingManaged', 'S_FCU_HEADING', 'flightGuidance.heading'],
  ['flightGuidance.altitudeManaged', 'flightGuidance.altitudeManaged', 'S_FCU_ALTITUDE', 'flightGuidance.altitude'],
] as const) {
  addManagedTargetActions({ commandLvar, fieldId, groupId, prefix });
}

addSteppedTargetAction({
  actionId: 'flightGuidance.speed.set',
  fieldId: 'flightGuidance.speedValue',
  groupId: 'flightGuidance.speed',
  input: { type: 'number', min: 100, max: 399, step: 1 },
  lvar: 'E_FCU_SPEED',
});

addSteppedTargetAction({
  actionId: 'flightGuidance.heading.set',
  circular: true,
  fieldId: 'flightGuidance.headingDeg',
  groupId: 'flightGuidance.heading',
  input: { type: 'number', min: 0, max: 359, step: 1 },
  lvar: 'E_FCU_HEADING',
});

addSteppedTargetAction({
  actionId: 'flightGuidance.altitudeHundred.set',
  fieldId: 'flightGuidance.altitudeFt',
  groupId: 'flightGuidance.altitude',
  input: { type: 'number', min: 0, max: 49000, step: 100 },
  lvar: 'E_FCU_ALTITUDE',
  precondition: {
    fieldId: 'flightGuidance.altitudeIncrementMode',
    expectedValue: 'hundred',
  },
});

addSteppedTargetAction({
  actionId: 'flightGuidance.altitudeThousand.set',
  fieldId: 'flightGuidance.altitudeFt',
  groupId: 'flightGuidance.altitude',
  input: { type: 'number', min: 0, max: 49000, step: 1000 },
  lvar: 'E_FCU_ALTITUDE',
  precondition: {
    fieldId: 'flightGuidance.altitudeIncrementMode',
    expectedValue: 'thousand',
  },
});

const FENIX_A32X_ACTIONS: Readonly<Record<string, AircraftIntegrationAction>> = actions;

module.exports = {
  FENIX_A32X_ACTIONS,
};

export {};
