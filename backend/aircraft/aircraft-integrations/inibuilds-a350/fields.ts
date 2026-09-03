'use strict';

import type {
  AircraftIntegrationDecoder,
  AircraftIntegrationField,
} from '../types.js';

function field(
  id: string,
  route: AircraftIntegrationField['sources'][number]['route'],
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return { id, sources: [{ route, decode }] };
}

function lvarField(
  id: string,
  name: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return field(id, { type: 'lvar', name: `L:${name}`, unit: 'Number' }, decode);
}

function simvarField(
  id: string,
  name: string,
  unit: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return field(id, { type: 'simvar', name, unit }, decode);
}

function booleanLvar(id: string, name: string): AircraftIntegrationField {
  return lvarField(id, name, {
    type: 'boolean',
    trueValues: [1],
    falseValues: [0],
  });
}

function numberLvar(id: string, name: string, precision = 0): AircraftIntegrationField {
  return lvarField(id, name, { type: 'number', precision });
}

function enumLvar(
  id: string,
  name: string,
  values: Readonly<Record<number, string>>,
): AircraftIntegrationField {
  return lvarField(id, name, { type: 'enum', values });
}

function booleanSimvar(id: string, name: string): AircraftIntegrationField {
  return simvarField(id, name, 'Bool', {
    type: 'boolean',
    trueValues: [true, 1],
    falseValues: [false, 0],
  });
}

function numberSimvar(
  id: string,
  name: string,
  unit: string,
  precision = 0,
): AircraftIntegrationField {
  return simvarField(id, name, unit, { type: 'number', precision });
}

// iniBuilds publishes these exact A350 variables for external hardware and
// software. Raw names and selector detents remain private to this family
// adapter; standard surface state is explicitly named below.
const INIBUILDS_A350_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = Object.freeze({
  'flightGuidance.speedValue': numberLvar('flightGuidance.speedValue', 'INI_AIRSPEED_DIAL'),
  'flightGuidance.headingDeg': numberLvar('flightGuidance.headingDeg', 'INI_HEADING_DIAL'),
  'flightGuidance.altitudeFt': numberLvar('flightGuidance.altitudeFt', 'INI_ALTITUDE_DIAL'),
  'flightGuidance.verticalSpeedFpm': numberLvar('flightGuidance.verticalSpeedFpm', 'INI_VVI_DIAL'),
  'flightGuidance.flightDirector': booleanLvar('flightGuidance.flightDirector', 'INI_FD_ON'),
  'flightGuidance.lsCaptain': booleanLvar('flightGuidance.lsCaptain', 'INI_LS_CAPTAIN'),
  'flightGuidance.lsFirstOfficer': booleanLvar('flightGuidance.lsFirstOfficer', 'INI_LS_FO'),
  'flightGuidance.verticalViewCaptain': booleanLvar('flightGuidance.verticalViewCaptain', 'INI_VV_LEFT'),
  'flightGuidance.verticalViewFirstOfficer': booleanLvar('flightGuidance.verticalViewFirstOfficer', 'INI_VV_RIGHT'),
  'flightGuidance.metricAltitude': booleanLvar('flightGuidance.metricAltitude', 'INI_FCU_METRIC_STATE'),

  'lights.strobeMode': enumLvar('lights.strobeMode', 'INI_LIGHTS_STROBE', {
    0: 'off',
    1: 'auto',
    2: 'on',
  }),
  'lights.beacon': booleanLvar('lights.beacon', 'INI_LIGHTS_BEACON'),
  'lights.navMode': enumLvar('lights.navMode', 'INI_LIGHTS_NAV', {
    0: 'off',
    1: 'nav2',
    2: 'nav1',
  }),
  'lights.logoMode': enumLvar('lights.logoMode', 'INI_LIGHTS_LOGO', {
    0: 'off',
    1: 'auto',
    2: 'on',
  }),
  'lights.wing': booleanLvar('lights.wing', 'INI_LIGHTS_WING'),
  'lights.landing': booleanLvar('lights.landing', 'INI_LIGHTS_LANDING'),
  'lights.noseMode': enumLvar('lights.noseMode', 'INI_LIGHTS_NOSE', {
    0: 'off',
    1: 'taxi',
    2: 'takeoff',
  }),

  'cabin.seatBeltsMode': enumLvar('cabin.seatBeltsMode', 'INI_SEATBELTS_SWITCH', {
    0: 'off',
    1: 'auto',
    2: 'on',
  }),
  'cabin.noSmokingMode': enumLvar('cabin.noSmokingMode', 'INI_NO_SMOKING_SWITCH', {
    0: 'off',
    1: 'auto',
    2: 'on',
  }),
  'cabin.noMobileMode': enumLvar('cabin.noMobileMode', 'INI_SIGNS_NO_MOBILE', {
    0: 'off',
    1: 'auto',
    2: 'on',
  }),
  'cabin.emergencyExitMode': enumLvar('cabin.emergencyExitMode', 'INI_EMER_EXIT_SWITCH', {
    0: 'off',
    1: 'arm',
    2: 'on',
  }),

  'systems.ignitionMode': enumLvar('systems.ignitionMode', 'INI_IGNITION_KNOB', {
    0: 'crank',
    1: 'normal',
    2: 'ign-start',
  }),
  'systems.gravityGearCover': booleanLvar('systems.gravityGearCover', 'INI_GRAVITY_GEAR_COVER'),
  'systems.gravityGearHandleMode': enumLvar('systems.gravityGearHandleMode', 'INI_GRAVITY_GEAR_HANDLE_STATE', {
    0: 'reset',
    1: 'off',
    2: 'down',
  }),
  'systems.apuMaster': booleanLvar('systems.apuMaster', 'INI_APU_MASTER_SWITCH'),
  'systems.apuStart': booleanLvar('systems.apuStart', 'INI_APU_START_BUTTON'),
  'systems.airFlowMode': enumLvar('systems.airFlowMode', 'INI_AIR_FLOW_MODE', {
    0: 'manual',
    1: 'low',
    2: 'normal',
    3: 'high',
  }),
  'systems.crossBleedMode': enumLvar('systems.crossBleedMode', 'INI_AIR_X_BLEED', {
    0: 'closed',
    1: 'auto',
    2: 'open',
  }),
  'systems.ramAir': booleanLvar('systems.ramAir', 'INI_RAM_AIR_STATE'),
  'systems.wingAntiIce': booleanLvar('systems.wingAntiIce', 'INI_WING_ANTI_ICE1_STATE'),
  'systems.probeWindowHeatMode': enumLvar('systems.probeWindowHeatMode', 'INI_PROBE_WINDOW_HEAT1_STATE', {
    0: 'auto',
    1: 'on',
  }),
  'systems.cabinPressureAltitudeMode': enumLvar(
    'systems.cabinPressureAltitudeMode',
    'INI_CABIN_PRESS_ALTITUDE_MANUAL_MODE',
    { 0: 'auto', 1: 'manual' },
  ),
  'systems.cabinPressureVerticalSpeedMode': enumLvar(
    'systems.cabinPressureVerticalSpeedMode',
    'INI_CABIN_PRESS_VS_MODE',
    { 0: 'auto', 1: 'manual' },
  ),
  'systems.ditching': booleanLvar('systems.ditching', 'INI_DITCHING_STATE'),
  'systems.crewSupply': booleanLvar('systems.crewSupply', 'INI_CREW_SUPPLY'),
  'systems.emergencyElectricalGenerator': booleanLvar(
    'systems.emergencyElectricalGenerator',
    'INI_EMER_ELEC_GEN_STATUS',
  ),
  'systems.groundControl': booleanLvar('systems.groundControl', 'INI_GND_CTL'),
  'systems.electricalSideIsolation': booleanLvar('systems.electricalSideIsolation', 'INI_ELEC_SIDE_ISOL'),
  'systems.electricalLoadManagement': booleanLvar('systems.electricalLoadManagement', 'INI_ELEC_ELM'),
  'systems.passengerSystems': booleanLvar('systems.passengerSystems', 'INI_ELEC_PAX_SYS'),
  'systems.galley': booleanLvar('systems.galley', 'INI_ELEC_GALLEY'),
  'systems.busTie': booleanLvar('systems.busTie', 'INI_BUS_TIE'),
  'systems.evacuationCommand': booleanLvar('systems.evacuationCommand', 'INI_EVAC_STATE'),

  'controls.flapsIndex': numberSimvar('controls.flapsIndex', 'FLAPS HANDLE INDEX', 'Number'),
  'controls.flapAngleDeg': numberSimvar('controls.flapAngleDeg', 'TRAILING EDGE FLAPS LEFT ANGLE', 'Degrees', 1),
  'controls.speedbrakePercent': numberSimvar('controls.speedbrakePercent', 'SPOILERS HANDLE POSITION', 'Percent'),
  'controls.spoilersArmed': booleanSimvar('controls.spoilersArmed', 'SPOILERS ARMED'),
  'controls.gearHandleDown': booleanSimvar('controls.gearHandleDown', 'GEAR HANDLE POSITION'),
  'controls.gearNosePct': numberSimvar('controls.gearNosePct', 'GEAR CENTER POSITION', 'Percent'),
  'controls.gearLeftPct': numberSimvar('controls.gearLeftPct', 'GEAR LEFT POSITION', 'Percent'),
  'controls.gearRightPct': numberSimvar('controls.gearRightPct', 'GEAR RIGHT POSITION', 'Percent'),
  'controls.parkingBrake': booleanSimvar('controls.parkingBrake', 'BRAKE PARKING POSITION'),
});

module.exports = {
  INIBUILDS_A350_FIELDS,
};

export {};
