'use strict';

import type {
  AircraftIntegrationDecoder,
  AircraftIntegrationField,
} from '../types.js';

const fields: Record<string, AircraftIntegrationField> = {};

function lvarField(
  id: string,
  lvar: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return {
    id,
    sources: [{
      route: { type: 'lvar', name: `L:${lvar}`, unit: 'Number' },
      decode,
    }],
  };
}

function addBooleanField(id: string, lvar: string): void {
  fields[id] = lvarField(id, lvar, {
    type: 'boolean',
    trueValues: [1],
    falseValues: [0],
  });
}

function addNumberField(id: string, lvar: string, precision = 0): void {
  fields[id] = lvarField(id, lvar, { type: 'number', precision });
}

function addEnumField(
  id: string,
  lvar: string,
  values: Readonly<Record<number, string>>,
): void {
  fields[id] = lvarField(id, lvar, { type: 'enum', values });
}

// Logical fields are shared across the Fenix A319/A320/A321 family. Every
// active name below was reviewed against the interaction templates shipped in
// the current licensed Fenix aircraft package. Only the explicitly reviewed
// FCU momentary subset and the four fixed forward throttle detents are
// writable; unrelated momentary buttons, guarded emergency controls, circuit
// breakers, continuous axes, reverse thrust, and maintenance-only interactions
// deliberately remain outside this adapter.
for (const [id, lvar] of [
  ['flightGuidance.ap1', 'I_FCU_AP1'],
  ['flightGuidance.ap2', 'I_FCU_AP2'],
  ['flightGuidance.approach', 'I_FCU_APPR'],
  ['flightGuidance.autothrust', 'I_FCU_ATHR'],
  ['flightGuidance.expedite', 'I_FCU_EXPED'],
  ['flightGuidance.localizer', 'I_FCU_LOC'],
  ['flightGuidance.speedManaged', 'I_FCU_SPEED_MANAGED'],
  ['flightGuidance.headingManaged', 'I_FCU_HEADING_MANAGED'],
  ['flightGuidance.altitudeManaged', 'I_FCU_ALTITUDE_MANAGED'],

  ['lights.beacon', 'S_OH_EXT_LT_BEACON'],
  ['lights.runwayTurnoff', 'S_OH_EXT_LT_RWY_TURNOFF'],
  ['lights.wing', 'S_OH_EXT_LT_WING'],

  ['cabin.seatBelts', 'S_OH_SIGNS'],
  ['displays.iceStandby', 'S_OH_IN_LT_ICE'],
  ['displays.chartLightCaptain', 'S_CHART_LIGHT_TEMP_CAPT'],
  ['displays.chartLightFirstOfficer', 'S_CHART_LIGHT_TEMP_FO'],

  ['systems.apuBleed', 'S_OH_PNEUMATIC_APU_BLEED'],
  ['systems.apuGenerator', 'S_OH_ELEC_APU_GENERATOR'],
  ['systems.apuMaster', 'S_OH_ELEC_APU_MASTER'],
  ['systems.battery1', 'S_OH_ELEC_BAT1'],
  ['systems.battery2', 'S_OH_ELEC_BAT2'],
  ['systems.commercial', 'S_OH_ELEC_COMMERCIAL'],
  ['systems.galleyAndCabin', 'S_OH_ELEC_GALY'],
  ['systems.generator1', 'S_OH_ELEC_GEN1'],
  ['systems.generator2', 'S_OH_ELEC_GEN2'],
  ['systems.generator1Line', 'S_OH_ELEC_GEN1_LINE'],
  ['systems.acEssFeedAlternate', 'S_OH_ELEC_AC_ESS_FEED'],

  ['systems.hydraulicEnginePump1', 'S_OH_HYD_ENG_1_PUMP'],
  ['systems.hydraulicEnginePump2', 'S_OH_HYD_ENG_2_PUMP'],
  ['systems.hydraulicPtu', 'S_OH_HYD_PTU'],
  ['systems.hydraulicBlueElectricPump', 'S_OH_HYD_BLUE_ELEC_PUMP'],

  ['fuel.leftPump1', 'S_OH_FUEL_LEFT_1'],
  ['fuel.leftPump2', 'S_OH_FUEL_LEFT_2'],
  ['fuel.rightPump1', 'S_OH_FUEL_RIGHT_1'],
  ['fuel.rightPump2', 'S_OH_FUEL_RIGHT_2'],
  ['fuel.centerPump1', 'S_OH_FUEL_CENTER_1'],
  ['fuel.centerPump2', 'S_OH_FUEL_CENTER_2'],
  ['fuel.crossfeedOpen', 'S_OH_FUEL_XFEED'],
  ['fuel.modeManual', 'S_OH_FUEL_MODE_SEL'],
  ['fuel.actTransfer', 'S_OH_FUEL_ACT'],

  ['systems.engineAntiIce1', 'S_OH_PNEUMATIC_ENG1_ANTI_ICE'],
  ['systems.engineAntiIce2', 'S_OH_PNEUMATIC_ENG2_ANTI_ICE'],
  ['systems.engineBleed1', 'S_OH_PNEUMATIC_ENG1_BLEED'],
  ['systems.engineBleed2', 'S_OH_PNEUMATIC_ENG2_BLEED'],
  ['systems.pack1', 'S_OH_PNEUMATIC_PACK_1'],
  ['systems.pack2', 'S_OH_PNEUMATIC_PACK_2'],
  ['systems.wingAntiIce', 'S_OH_PNEUMATIC_WING_ANTI_ICE'],
  ['systems.ramAir', 'S_OH_PNEUMATIC_RAM_AIR'],
  ['systems.hotAir', 'S_OH_PNEUMATIC_HOT_AIR'],
  ['systems.probeHeat', 'S_OH_PROBE_HEAT'],
  ['systems.pressurizationManual', 'S_OH_PNEUMATIC_PRESS_MODE'],
  ['systems.blower', 'S_OH_PNEUMATIC_BLOWER'],
  ['systems.extract', 'S_OH_PNEUMATIC_EXTRACT'],
  ['systems.cabinFans', 'S_OH_PNEUMATIC_CAB_FANS'],
  ['systems.cargoHotAir', 'S_OH_PNEUMATIC_HOT_AIR_AFT_CARGO'],
  ['systems.cargoAftIsolation', 'S_OH_PNEUMATIC_CARGO_AFT_ISOL_VALVE'],

  ['systems.brakeFan', 'S_MIP_BRAKE_FAN'],
  ['systems.antiSkid', 'S_FC_MIP_ANTI_SKID'],
  ['systems.parkingBrake', 'S_MIP_PARKING_BRAKE'],
  ['systems.engineManualStart1', 'S_OH_ENG_MANSTART_1'],
  ['systems.engineManualStart2', 'S_OH_ENG_MANSTART_2'],
  ['systems.engineN1Mode1', 'S_OH_ENG_N1_MODE_1'],
  ['systems.engineN1Mode2', 'S_OH_ENG_N1_MODE_2'],

  ['safety.gpwsSystemOff', 'S_OH_GPWS_SYS'],
  ['safety.gpwsTerrainOff', 'S_OH_GPWS_TERR'],
  ['safety.gpwsGlideslopeOff', 'S_OH_GPWS_GS_MODE'],
  ['safety.gpwsFlapModeOff', 'S_OH_GPWS_FLAP_MODE'],
  ['safety.gpwsLandingFlap3', 'S_OH_GPWS_LDG_FLAP3'],

  ['surveillance.rmpCaptainPower', 'S_PED_RMP1_POWER'],
  ['surveillance.rmpFirstOfficerPower', 'S_PED_RMP2_POWER'],
  ['surveillance.rmpThirdPower', 'S_PED_RMP3_POWER'],
  ['surveillance.weatherRadarMultiscanAuto', 'S_WR_MULTISCAN'],
  ['surveillance.weatherRadarPwsAuto', 'S_WR_PRED_WS'],
  ['surveillance.altitudeReporting', 'S_XPDR_ALTREPORTING'],

  ['controls.cockpitDoorVideo', 'S_OH_COCKPIT_DOOR_VIDEO'],
] as const) {
  addBooleanField(id, lvar);
}

for (const [id, lvar, precision] of [
  // Keep the live lever inputs numeric: physical axes can report values
  // between detents, while the virtual throttle writes fixed detent values.
  ['propulsion.throttleLever1Position', 'A_FC_THROTTLE_LEFT_INPUT', 2],
  ['propulsion.throttleLever2Position', 'A_FC_THROTTLE_RIGHT_INPUT', 2],
  ['flightGuidance.speedValue', 'N_FCU_SPEED', 2],
  ['flightGuidance.headingDeg', 'N_FCU_HEADING', 0],
  ['flightGuidance.altitudeFt', 'N_FCU_ALTITUDE', 0],
  // This is display-only: N_FCU_VS represents either V/S or FPA depending on
  // the active FCU mode, so the adapter deliberately exposes no target action.
  ['flightGuidance.verticalValue', 'N_FCU_VS', 2],
] as const) {
  addNumberField(id, lvar, precision);
}

for (const [id, lvar, values] of [
  ['lights.landingLeftMode', 'S_OH_EXT_LT_LANDING_L', {
    0: 'retract', 1: 'off', 2: 'on',
  }],
  ['lights.landingRightMode', 'S_OH_EXT_LT_LANDING_R', {
    0: 'retract', 1: 'off', 2: 'on',
  }],
  ['lights.navLogoMode', 'S_OH_EXT_LT_NAV_LOGO', {
    0: 'off', 1: 'nav', 2: 'logo',
  }],
  ['lights.noseMode', 'S_OH_EXT_LT_NOSE', {
    0: 'off', 1: 'taxi', 2: 'takeoff',
  }],
  ['lights.strobeMode', 'S_OH_EXT_LT_STROBE', {
    0: 'off', 1: 'auto', 2: 'on',
  }],

  ['cabin.emergencyExitMode', 'S_OH_INT_LT_EMER', {
    0: 'off', 1: 'arm', 2: 'on',
  }],
  ['cabin.noSmokingMode', 'S_OH_SIGNS_SMOKING', {
    0: 'off', 1: 'auto', 2: 'on',
  }],
  ['visibility.wiperCaptainMode', 'S_MISC_WIPER_CAPT', {
    0: 'off', 1: 'slow', 2: 'fast',
  }],
  ['visibility.wiperFirstOfficerMode', 'S_MISC_WIPER_FO', {
    0: 'off', 1: 'slow', 2: 'fast',
  }],

  ['displays.domeLightMode', 'S_OH_INT_LT_DOME', {
    0: 'off', 1: 'dim', 2: 'bright',
  }],
  ['displays.annunciatorMode', 'S_OH_IN_LT_ANN_LT', {
    0: 'bright', 1: 'dim', 2: 'test',
  }],
  ['displays.consoleFloorCaptainMode', 'S_MIP_LIGHT_CONSOLEFLOOR_CAPT', {
    0: 'off', 1: 'dim', 2: 'bright',
  }],
  ['displays.consoleFloorFirstOfficerMode', 'S_MIP_LIGHT_CONSOLEFLOOR_FO', {
    0: 'off', 1: 'dim', 2: 'bright',
  }],

  ['systems.crossBleedMode', 'S_OH_PNEUMATIC_XBLEED_SELECTOR', {
    0: 'shut', 1: 'auto', 2: 'open',
  }],
  ['systems.ir1Mode', 'S_OH_NAV_IR1_MODE', {
    0: 'off', 1: 'nav', 2: 'att',
  }],
  ['systems.ir2Mode', 'S_OH_NAV_IR2_MODE', {
    0: 'off', 1: 'nav', 2: 'att',
  }],
  ['systems.ir3Mode', 'S_OH_NAV_IR3_MODE', {
    0: 'off', 1: 'nav', 2: 'att',
  }],
  ['systems.packFlowMode', 'S_OH_PNEUMATIC_PACK_FLOW', {
    0: 'low', 1: 'normal', 2: 'high',
  }],
  ['systems.engineMode', 'S_ENG_MODE', {
    0: 'crank', 1: 'normal', 2: 'start',
  }],
  ['systems.clockUtcMode', 'S_MIP_CLOCK_UTC', {
    0: 'gps', 1: 'internal', 2: 'set',
  }],

  // Fenix reports 0=INHG, 1=HPA and, for the altitude-scale toggle,
  // 0=1000 ft, 1=100 ft. The latter ordering is explicit in the shipped
  // toggle template's ANIMTIP_0/ANIMTIP_1 mapping.
  ['flightGuidance.baroUnitCaptain', 'S_FCU_EFIS1_BARO_MODE', {
    0: 'inhg', 1: 'hpa',
  }],
  ['flightGuidance.baroUnitFirstOfficer', 'S_FCU_EFIS2_BARO_MODE', {
    0: 'inhg', 1: 'hpa',
  }],
  ['flightGuidance.altitudeIncrementMode', 'S_FCU_ALTITUDE_SCALE', {
    0: 'thousand', 1: 'hundred',
  }],

  ['navigation.navaidCaptain1', 'S_FCU_EFIS1_NAV1', {
    0: 'adf', 1: 'off', 2: 'vor',
  }],
  ['navigation.navaidCaptain2', 'S_FCU_EFIS1_NAV2', {
    0: 'adf', 1: 'off', 2: 'vor',
  }],
  ['navigation.navaidFirstOfficer1', 'S_FCU_EFIS2_NAV1', {
    0: 'adf', 1: 'off', 2: 'vor',
  }],
  ['navigation.navaidFirstOfficer2', 'S_FCU_EFIS2_NAV2', {
    0: 'adf', 1: 'off', 2: 'vor',
  }],

  ['switching.attitudeHeading', 'S_DISPLAY_ATT_HDG', {
    0: 'captain', 1: 'normal', 2: 'firstOfficer',
  }],
  ['switching.airData', 'S_DISPLAY_AIR_DATA', {
    0: 'captain', 1: 'normal', 2: 'firstOfficer',
  }],
  ['switching.eisDmc', 'S_DISPLAY_EIS_DMC', {
    0: 'captain', 1: 'normal', 2: 'firstOfficer',
  }],
  ['switching.ecamNd', 'S_DISPLAY_ECAM_ND_XFR', {
    0: 'captain', 1: 'normal', 2: 'firstOfficer',
  }],
  ['switching.audio', 'S_AUDIO_SWITCHING', {
    0: 'captain', 1: 'normal', 2: 'firstOfficer',
  }],

  ['surveillance.weatherRadarSystem', 'S_WR_SYS', {
    0: 'system1', 1: 'off', 2: 'system2',
  }],
  ['surveillance.transponderOperation', 'S_XPDR_OPERATION', {
    0: 'standby', 1: 'auto', 2: 'on',
  }],
  ['surveillance.transponderSystem', 'S_XPDR_ATC', {
    0: 'system1', 1: 'system2',
  }],
  ['surveillance.transponderMode', 'S_XPDR_MODE', {
    0: 'standby', 1: 'ta', 2: 'taRa',
  }],
] as const) {
  addEnumField(id, lvar, values);
}

for (const [id, lvar] of [
  ['lighting.fcu', 'A_FCU_LIGHTING'],
  ['lighting.overhead', 'A_OH_LIGHTING_OVD'],
  ['lighting.pedestal', 'A_PED_LIGHTING_PEDESTAL'],
] as const) {
  addNumberField(id, lvar, 2);
}

const FENIX_A32X_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = fields;

module.exports = {
  FENIX_A32X_FIELDS,
};

export {};
