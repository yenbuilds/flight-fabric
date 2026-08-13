'use strict';

import type {
  AircraftIntegrationDecoder,
  AircraftIntegrationField,
} from '../types.js';

function lvarField(
  id: string,
  name: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return {
    id,
    sources: [{
      route: { type: 'lvar', name: `L:${name}`, unit: 'Number' },
      decode,
    }],
  };
}

function simvarField(
  id: string,
  name: string,
  unit: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return {
    id,
    sources: [{
      route: { type: 'simvar', name, unit },
      decode,
    }],
  };
}

function booleanField(id: string, name: string): AircraftIntegrationField {
  return lvarField(id, name, {
    type: 'boolean',
    trueValues: [1],
    falseValues: [0],
  });
}

function booleanSimvarField(id: string, name: string): AircraftIntegrationField {
  return simvarField(id, name, 'Bool', {
    type: 'boolean',
    trueValues: [true, 1],
    falseValues: [false, 0],
  });
}

function booleanGaugeField(id: string, name: string): AircraftIntegrationField {
  return {
    id,
    sources: [{
      // The existing gauge subscription bridge supports bounded single A-var
      // expressions and gives action confirmation a sequenced fresh snapshot.
      route: { type: 'lvar', name: `A:${name}`, unit: 'Bool' },
      decode: {
        type: 'boolean',
        trueValues: [1, true],
        falseValues: [0, false],
      },
    }],
  };
}

function enumGaugeField(
  id: string,
  name: string,
  unit: string,
  values: Readonly<Record<number, string>>,
): AircraftIntegrationField {
  return {
    id,
    sources: [{
      route: { type: 'lvar', name: `A:${name}`, unit },
      decode: { type: 'enum', values },
    }],
  };
}

function numberField(id: string, name: string, precision = 0): AircraftIntegrationField {
  return lvarField(id, name, { type: 'number', precision });
}

function enumField(
  id: string,
  name: string,
  values: Readonly<Record<number, string>>,
): AircraftIntegrationField {
  return lvarField(id, name, { type: 'enum', values });
}

// FlyByWire publishes this interface for external hardware/software. Raw names,
// units, detents, and deprecated compatibility details stay inside the adapter.
const FBW_A32NX_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'flightGuidance.speedValue': numberField('flightGuidance.speedValue', 'A32NX_FCU_AFS_DISPLAY_SPD_MACH_VALUE', 2),
  'flightGuidance.speedDashes': booleanField('flightGuidance.speedDashes', 'A32NX_FCU_AFS_DISPLAY_SPD_MACH_DASHES'),
  'flightGuidance.speedManaged': booleanField('flightGuidance.speedManaged', 'A32NX_FCU_AFS_DISPLAY_SPD_MACH_MANAGED'),
  'flightGuidance.machMode': booleanField('flightGuidance.machMode', 'A32NX_FCU_AFS_DISPLAY_MACH_MODE'),
  'flightGuidance.headingDeg': numberField('flightGuidance.headingDeg', 'A32NX_FCU_AFS_DISPLAY_HDG_TRK_VALUE'),
  'flightGuidance.headingDashes': booleanField('flightGuidance.headingDashes', 'A32NX_FCU_AFS_DISPLAY_HDG_TRK_DASHES'),
  'flightGuidance.headingManaged': booleanField('flightGuidance.headingManaged', 'A32NX_FCU_AFS_DISPLAY_HDG_TRK_MANAGED'),
  'flightGuidance.altitudeFt': numberField('flightGuidance.altitudeFt', 'A32NX_FCU_AFS_DISPLAY_ALT_VALUE'),
  'flightGuidance.altitudeManaged': booleanField('flightGuidance.altitudeManaged', 'A32NX_FCU_AFS_DISPLAY_LVL_CH_MANAGED'),
  'flightGuidance.verticalValue': numberField('flightGuidance.verticalValue', 'A32NX_FCU_AFS_DISPLAY_VS_FPA_VALUE', 1),
  'flightGuidance.verticalDashes': booleanField('flightGuidance.verticalDashes', 'A32NX_FCU_AFS_DISPLAY_VS_FPA_DASHES'),
  'flightGuidance.trkFpaMode': booleanField('flightGuidance.trkFpaMode', 'A32NX_FCU_AFS_DISPLAY_TRK_FPA_MODE'),
  'flightGuidance.ap1': booleanField('flightGuidance.ap1', 'A32NX_FCU_AP_1_LIGHT_ON'),
  'flightGuidance.ap2': booleanField('flightGuidance.ap2', 'A32NX_FCU_AP_2_LIGHT_ON'),
  'flightGuidance.autothrust': booleanField('flightGuidance.autothrust', 'A32NX_FCU_ATHR_LIGHT_ON'),
  'flightGuidance.localizer': booleanField('flightGuidance.localizer', 'A32NX_FCU_LOC_LIGHT_ON'),
  'flightGuidance.approach': booleanField('flightGuidance.approach', 'A32NX_FCU_APPR_LIGHT_ON'),
  'flightGuidance.expedite': booleanField('flightGuidance.expedite', 'A32NX_FCU_EXPED_LIGHT_ON'),
  'flightGuidance.flightDirectorCaptain': booleanField(
    'flightGuidance.flightDirectorCaptain',
    'A32NX_FCU_EFIS_L_FD_LIGHT_ON',
  ),
  'flightGuidance.flightDirectorFirstOfficer': booleanField(
    'flightGuidance.flightDirectorFirstOfficer',
    'A32NX_FCU_EFIS_R_FD_LIGHT_ON',
  ),
  'flightGuidance.altitudeIncrementMode': enumField(
    'flightGuidance.altitudeIncrementMode',
    'A32NX_FCU_ALT_INCREMENT_1000',
    {
      0: 'hundred',
      1: 'thousand',
    },
  ),
  'flightGuidance.baroUnitCaptain': booleanField(
    'flightGuidance.baroUnitCaptain',
    'A32NX_FCU_EFIS_L_BARO_IS_INHG',
  ),
  'flightGuidance.baroUnitFirstOfficer': booleanField(
    'flightGuidance.baroUnitFirstOfficer',
    'A32NX_FCU_EFIS_R_BARO_IS_INHG',
  ),

  'lights.strobeMode': enumField('lights.strobeMode', 'LIGHTING_STROBE_0', {
    0: 'on',
    1: 'auto',
    2: 'off',
  }),
  'lights.strobeAuto': booleanField('lights.strobeAuto', 'STROBE_0_AUTO'),
  'lights.strobeActive': booleanGaugeField('lights.strobeActive', 'LIGHT STROBE'),
  'lights.beacon': booleanSimvarField('lights.beacon', 'LIGHT BEACON'),
  'lights.nav': booleanSimvarField('lights.nav', 'LIGHT NAV'),
  'lights.logo': booleanSimvarField('lights.logo', 'LIGHT LOGO'),
  'lights.wing': booleanSimvarField('lights.wing', 'LIGHT WING'),
  'lights.runwayTurnoff': booleanGaugeField('lights.runwayTurnoff', 'CIRCUIT SWITCH ON:21'),
  'lights.runwayTurnoffRight': booleanGaugeField('lights.runwayTurnoffRight', 'CIRCUIT SWITCH ON:22'),
  'lights.noseMode': enumField('lights.noseMode', 'LIGHTING_LANDING_1', {
    0: 'takeoff',
    1: 'taxi',
    2: 'off',
  }),
  'lights.landingLeftMode': enumField('lights.landingLeftMode', 'LIGHTING_LANDING_2', {
    0: 'on',
    1: 'off',
    2: 'retract',
  }),
  'lights.landingRightMode': enumField('lights.landingRightMode', 'LIGHTING_LANDING_3', {
    0: 'on',
    1: 'off',
    2: 'retract',
  }),
  'lights.landingLeftCircuitOn': booleanGaugeField('lights.landingLeftCircuitOn', 'CIRCUIT SWITCH ON:18'),
  'lights.landingRightCircuitOn': booleanGaugeField('lights.landingRightCircuitOn', 'CIRCUIT SWITCH ON:19'),
  'lights.landingLeftRetracted': booleanField('lights.landingLeftRetracted', 'LANDING_2_RETRACTED'),
  'lights.landingRightRetracted': booleanField('lights.landingRightRetracted', 'LANDING_3_RETRACTED'),

  'cabin.noSmokingMode': enumField('cabin.noSmokingMode', 'XMLVAR_SWITCH_OVHD_INTLT_NOSMOKING_POSITION', {
    0: 'on',
    1: 'auto',
    2: 'off',
  }),
  'cabin.emergencyExitMode': enumField('cabin.emergencyExitMode', 'XMLVAR_SWITCH_OVHD_INTLT_EMEREXIT_POSITION', {
    0: 'on',
    1: 'auto',
    2: 'off',
  }),
  'cabin.seatBelts': booleanGaugeField('cabin.seatBelts', 'CABIN SEATBELTS ALERT SWITCH'),

  'systems.battery1': booleanField('systems.battery1', 'A32NX_OVHD_ELEC_BAT_1_PB_IS_AUTO'),
  'systems.battery2': booleanField('systems.battery2', 'A32NX_OVHD_ELEC_BAT_2_PB_IS_AUTO'),
  'systems.battery1Voltage': numberField('systems.battery1Voltage', 'A32NX_ELEC_BAT_1_POTENTIAL', 1),
  'systems.battery2Voltage': numberField('systems.battery2Voltage', 'A32NX_ELEC_BAT_2_POTENTIAL', 1),
  'systems.externalPower': booleanField('systems.externalPower', 'A32NX_OVHD_ELEC_EXT_PWR_PB_IS_ON'),
  'systems.externalPowerAvailable': booleanField('systems.externalPowerAvailable', 'A32NX_EXT_PWR_AVAIL:1'),
  'systems.busTie': booleanField('systems.busTie', 'A32NX_OVHD_ELEC_BUS_TIE_PB_IS_AUTO'),
  'systems.acEssFeed': booleanField('systems.acEssFeed', 'A32NX_OVHD_ELEC_AC_ESS_FEED_PB_IS_NORMAL'),
  'systems.galleyAndCabin': booleanField('systems.galleyAndCabin', 'A32NX_OVHD_ELEC_GALY_AND_CAB_PB_IS_AUTO'),
  'systems.commercial': booleanField('systems.commercial', 'A32NX_OVHD_ELEC_COMMERCIAL_PB_IS_AUTO'),
  'systems.apuMaster': booleanField('systems.apuMaster', 'A32NX_OVHD_APU_MASTER_SW_PB_IS_ON'),
  'systems.apuMasterFault': booleanField('systems.apuMasterFault', 'A32NX_OVHD_APU_MASTER_SW_PB_HAS_FAULT'),
  'systems.apuStart': booleanField('systems.apuStart', 'A32NX_OVHD_APU_START_PB_IS_ON'),
  'systems.apuAvailable': booleanField('systems.apuAvailable', 'A32NX_OVHD_APU_START_PB_IS_AVAILABLE'),
  'systems.apuBleed': booleanField('systems.apuBleed', 'A32NX_OVHD_PNEU_APU_BLEED_PB_IS_ON'),
  'systems.apuBleedFault': booleanField('systems.apuBleedFault', 'A32NX_OVHD_PNEU_APU_BLEED_PB_HAS_FAULT'),
  'systems.engineBleed1': booleanField('systems.engineBleed1', 'A32NX_OVHD_PNEU_ENG_1_BLEED_PB_IS_AUTO'),
  'systems.engineBleed2': booleanField('systems.engineBleed2', 'A32NX_OVHD_PNEU_ENG_2_BLEED_PB_IS_AUTO'),
  'systems.crossBleedMode': enumField(
    'systems.crossBleedMode',
    'A32NX_KNOB_OVHD_AIRCOND_XBLEED_POSITION',
    {
      0: 'closed',
      1: 'auto',
      2: 'open',
    },
  ),
  'systems.pack1': booleanField('systems.pack1', 'A32NX_OVHD_COND_PACK_1_PB_IS_ON'),
  'systems.pack1Fault': booleanField('systems.pack1Fault', 'A32NX_OVHD_COND_PACK_1_PB_HAS_FAULT'),
  'systems.pack1ValveOpen': booleanField('systems.pack1ValveOpen', 'A32NX_COND_PACK_FLOW_VALVE_1_IS_OPEN'),
  'systems.pack2': booleanField('systems.pack2', 'A32NX_OVHD_COND_PACK_2_PB_IS_ON'),
  'systems.pack2Fault': booleanField('systems.pack2Fault', 'A32NX_OVHD_COND_PACK_2_PB_HAS_FAULT'),
  'systems.pack2ValveOpen': booleanField('systems.pack2ValveOpen', 'A32NX_COND_PACK_FLOW_VALVE_2_IS_OPEN'),
  'systems.packFlowMode': enumField('systems.packFlowMode', 'A32NX_KNOB_OVHD_AIRCOND_PACKFLOW_POSITION', {
    0: 'low',
    1: 'normal',
    2: 'high',
  }),
  'systems.hotAir': booleanField('systems.hotAir', 'A32NX_OVHD_COND_HOT_AIR_PB_IS_ON'),
  'systems.ramAir': booleanField('systems.ramAir', 'A32NX_AIRCOND_RAMAIR_TOGGLE'),
  'systems.engineAntiIce1': booleanField('systems.engineAntiIce1', 'A32NX_BUTTON_OVHD_ANTI_ICE_ENG_1_POSITION'),
  'systems.engineAntiIce2': booleanField('systems.engineAntiIce2', 'A32NX_BUTTON_OVHD_ANTI_ICE_ENG_2_POSITION'),
  'systems.wingAntiIce': booleanField('systems.wingAntiIce', 'A32NX_PNEU_WING_ANTI_ICE_SYSTEM_SELECTED'),
  'systems.probeWindowHeat': booleanField('systems.probeWindowHeat', 'A32NX_MAN_PITOT_HEAT'),
  'systems.ir1Mode': enumField('systems.ir1Mode', 'A32NX_OVHD_ADIRS_IR_1_MODE_SELECTOR_KNOB', {
    0: 'off',
    1: 'nav',
    2: 'att',
  }),
  'systems.ir1Fault': booleanField('systems.ir1Fault', 'A32NX_OVHD_ADIRS_IR_1_PB_HAS_FAULT'),
  'systems.ir2Mode': enumField('systems.ir2Mode', 'A32NX_OVHD_ADIRS_IR_2_MODE_SELECTOR_KNOB', {
    0: 'off',
    1: 'nav',
    2: 'att',
  }),
  'systems.ir2Fault': booleanField('systems.ir2Fault', 'A32NX_OVHD_ADIRS_IR_2_PB_HAS_FAULT'),
  'systems.ir3Mode': enumField('systems.ir3Mode', 'A32NX_OVHD_ADIRS_IR_3_MODE_SELECTOR_KNOB', {
    0: 'off',
    1: 'nav',
    2: 'att',
  }),
  'systems.ir3Fault': booleanField('systems.ir3Fault', 'A32NX_OVHD_ADIRS_IR_3_PB_HAS_FAULT'),
  'systems.adr1': booleanField('systems.adr1', 'A32NX_OVHD_ADIRS_ADR_1_PB_IS_ON'),
  'systems.adr2': booleanField('systems.adr2', 'A32NX_OVHD_ADIRS_ADR_2_PB_IS_ON'),
  'systems.adr3': booleanField('systems.adr3', 'A32NX_OVHD_ADIRS_ADR_3_PB_IS_ON'),
  'systems.adirsAlignmentSeconds': numberField('systems.adirsAlignmentSeconds', 'A32NX_ADIRS_REMAINING_IR_ALIGNMENT_TIME'),
  'systems.adirsOnBattery': booleanField('systems.adirsOnBattery', 'A32NX_OVHD_ADIRS_ON_BAT_IS_ILLUMINATED'),
  'systems.autobrakeMode': enumField('systems.autobrakeMode', 'A32NX_AUTOBRAKES_ARMED_MODE', {
    0: 'disarmed',
    1: 'low',
    2: 'medium',
    3: 'max',
  }),
  'systems.brakeFan': booleanField('systems.brakeFan', 'A32NX_BRAKE_FAN_BTN_PRESSED'),
  'systems.parkingBrake': booleanField('systems.parkingBrake', 'A32NX_PARK_BRAKE_LEVER_POS'),

  'navigation.ndCaptainMode': enumField('navigation.ndCaptainMode', 'A32NX_FCU_EFIS_L_EFIS_MODE', {
    0: 'roseIls',
    1: 'roseVor',
    2: 'roseNav',
    3: 'arc',
    4: 'plan',
  }),
  'navigation.ndFirstOfficerMode': enumField('navigation.ndFirstOfficerMode', 'A32NX_FCU_EFIS_R_EFIS_MODE', {
    0: 'roseIls',
    1: 'roseVor',
    2: 'roseNav',
    3: 'arc',
    4: 'plan',
  }),
  'navigation.ndCaptainRange': enumField('navigation.ndCaptainRange', 'A32NX_FCU_EFIS_L_EFIS_RANGE', {
    0: '10',
    1: '20',
    2: '40',
    3: '80',
    4: '160',
    5: '320',
  }),
  'navigation.ndFirstOfficerRange': enumField('navigation.ndFirstOfficerRange', 'A32NX_FCU_EFIS_R_EFIS_RANGE', {
    0: '10',
    1: '20',
    2: '40',
    3: '80',
    4: '160',
    5: '320',
  }),
  'navigation.navaidCaptain1': enumField('navigation.navaidCaptain1', 'A32NX_FCU_EFIS_L_NAVAID_1_MODE', {
    0: 'off',
    1: 'adf',
    2: 'vor',
  }),
  'navigation.navaidCaptain2': enumField('navigation.navaidCaptain2', 'A32NX_FCU_EFIS_L_NAVAID_2_MODE', {
    0: 'off',
    1: 'adf',
    2: 'vor',
  }),
  'navigation.navaidFirstOfficer1': enumField('navigation.navaidFirstOfficer1', 'A32NX_FCU_EFIS_R_NAVAID_1_MODE', {
    0: 'off',
    1: 'adf',
    2: 'vor',
  }),
  'navigation.navaidFirstOfficer2': enumField('navigation.navaidFirstOfficer2', 'A32NX_FCU_EFIS_R_NAVAID_2_MODE', {
    0: 'off',
    1: 'adf',
    2: 'vor',
  }),
  'navigation.terrainCaptain': booleanField('navigation.terrainCaptain', 'A32NX_EFIS_TERR_L_ACTIVE'),
  'navigation.terrainFirstOfficer': booleanField('navigation.terrainFirstOfficer', 'A32NX_EFIS_TERR_R_ACTIVE'),

  'switching.attitudeHeading': enumField('switching.attitudeHeading', 'A32NX_ATT_HDG_SWITCHING_KNOB', {
    0: 'captain',
    1: 'normal',
    2: 'firstOfficer',
  }),
  'switching.airData': enumField('switching.airData', 'A32NX_AIR_DATA_SWITCHING_KNOB', {
    0: 'captain',
    1: 'normal',
    2: 'firstOfficer',
  }),
  'switching.eisDmc': enumField('switching.eisDmc', 'A32NX_EIS_DMC_SWITCHING_KNOB', {
    0: 'captain',
    1: 'normal',
    2: 'firstOfficer',
  }),
  'switching.ecamNd': enumField('switching.ecamNd', 'A32NX_ECAM_ND_XFR_SWITCHING_KNOB', {
    0: 'captain',
    1: 'normal',
    2: 'firstOfficer',
  }),

  'surveillance.weatherRadarSystem': enumField('surveillance.weatherRadarSystem', 'XMLVAR_A320_WEATHERRADAR_SYS', {
    0: 'system1',
    1: 'off',
    2: 'system2',
  }),
  'surveillance.weatherRadarPws': booleanField('surveillance.weatherRadarPws', 'A32NX_SWITCH_RADAR_PWS_POSITION'),
  'surveillance.weatherRadarMode': enumField('surveillance.weatherRadarMode', 'XMLVAR_A320_WEATHERRADAR_MODE', {
    0: 'weather',
    1: 'weatherTerrain',
    2: 'turbulence',
    3: 'map',
  }),
  'surveillance.transponderMode': enumField('surveillance.transponderMode', 'A32NX_TRANSPONDER_MODE', {
    0: 'standby',
    1: 'auto',
    2: 'on',
  }),
  'surveillance.transponderSystem': enumField('surveillance.transponderSystem', 'A32NX_TRANSPONDER_SYSTEM', {
    0: 'system1',
    1: 'system2',
  }),
  'surveillance.altitudeReporting': booleanField('surveillance.altitudeReporting', 'A32NX_SWITCH_ATC_ALT'),
  'surveillance.tcasFilterMode': enumField('surveillance.tcasFilterMode', 'A32NX_SWITCH_TCAS_TRAFFIC_POSITION', {
    0: 'threat',
    1: 'all',
    2: 'above',
    3: 'below',
  }),
  'surveillance.tcasMode': enumField('surveillance.tcasMode', 'A32NX_SWITCH_TCAS_POSITION', {
    0: 'standby',
    1: 'ta',
    2: 'taRa',
  }),
  'surveillance.rmpCaptainMode': enumField('surveillance.rmpCaptainMode', 'A32NX_RMP_L_SELECTED_MODE', {
    0: 'select',
    1: 'vhf1',
    2: 'vhf2',
    3: 'vhf3',
  }),
  'surveillance.rmpCaptainPower': booleanField('surveillance.rmpCaptainPower', 'A32NX_RMP_L_TOGGLE_SWITCH'),
  'surveillance.rmpFirstOfficerMode': enumField('surveillance.rmpFirstOfficerMode', 'A32NX_RMP_R_SELECTED_MODE', {
    0: 'select',
    1: 'vhf1',
    2: 'vhf2',
    3: 'vhf3',
  }),
  'surveillance.rmpFirstOfficerPower': booleanField('surveillance.rmpFirstOfficerPower', 'A32NX_RMP_R_TOGGLE_SWITCH'),

  'displays.annunciatorMode': enumField('displays.annunciatorMode', 'A32NX_OVHD_INTLT_ANN', {
    0: 'test',
    1: 'bright',
    2: 'dim',
  }),
  'displays.ecamPage': enumField('displays.ecamPage', 'A32NX_ECAM_SD_CURRENT_PAGE_INDEX', {
    [-1]: 'none',
    0: 'engine',
    1: 'bleed',
    2: 'press',
    3: 'electrical',
    4: 'hydraulic',
    5: 'fuel',
    6: 'apu',
    7: 'conditioning',
    8: 'door',
    9: 'wheel',
    10: 'flightControls',
    11: 'status',
    12: 'cruise',
  }),
  'displays.masterCaution': booleanField('displays.masterCaution', 'A32NX_MASTER_CAUTION'),
  'displays.masterWarning': booleanField('displays.masterWarning', 'A32NX_MASTER_WARNING'),

  'controls.spoilersHandle': numberField('controls.spoilersHandle', 'A32NX_SPOILERS_HANDLE_POSITION', 2),
  'controls.spoilersArmed': booleanField('controls.spoilersArmed', 'A32NX_SPOILERS_ARMED'),
  'controls.engineMaster1': booleanGaugeField('controls.engineMaster1', 'FUELSYSTEM VALVE SWITCH:1'),
  'controls.engineMaster2': booleanGaugeField('controls.engineMaster2', 'FUELSYSTEM VALVE SWITCH:2'),
  'controls.engineMode': enumGaugeField('controls.engineMode', 'TURB ENG IGNITION SWITCH EX1:1', 'Number', {
    0: 'crank',
    1: 'normal',
    2: 'ignition',
  }),
  'controls.cockpitDoorLocked': booleanField('controls.cockpitDoorLocked', 'A32NX_COCKPIT_DOOR_LOCKED'),
};

module.exports = {
  FBW_A32NX_FIELDS,
};

export {};
