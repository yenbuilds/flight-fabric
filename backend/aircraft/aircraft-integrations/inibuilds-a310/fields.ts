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

function simvarNumber(id: string, name: string, unit: string, precision = 0): AircraftIntegrationField {
  return field(id, { type: 'simvar', name, unit }, { type: 'number', precision });
}

function simvarBoolean(id: string, name: string): AircraftIntegrationField {
  return field(id, { type: 'simvar', name, unit: 'Bool' }, {
    type: 'boolean',
    trueValues: [true, 1],
    falseValues: [false, 0],
  });
}

// No iniBuilds-published output contract with independent readback semantics is
// available. Keep the monitoring surface entirely on
// documented standard SimVars and fail unavailable when the aircraft does not
// mirror them. No aircraft-specific write is exposed.
const INIBUILDS_A310_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'fcp.speedKts': simvarNumber('fcp.speedKts', 'AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
  'fcp.headingDeg': simvarNumber('fcp.headingDeg', 'AUTOPILOT HEADING LOCK DIR', 'Degrees'),
  'fcp.altitudeFt': simvarNumber('fcp.altitudeFt', 'AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
  'fcp.verticalSpeedFpm': simvarNumber('fcp.verticalSpeedFpm', 'AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),
  'fcp.apMaster': simvarBoolean('fcp.apMaster', 'AUTOPILOT MASTER'),
  'fcp.flightDirector': simvarBoolean('fcp.flightDirector', 'AUTOPILOT FLIGHT DIRECTOR ACTIVE'),
  'fcp.autothrottleActive': simvarBoolean('fcp.autothrottleActive', 'AUTOTHROTTLE ACTIVE'),
  'fcp.speedHold': simvarBoolean('fcp.speedHold', 'AUTOPILOT AIRSPEED HOLD'),
  'fcp.lnav': simvarBoolean('fcp.lnav', 'AUTOPILOT NAV1 LOCK'),
  'fcp.headingSelect': simvarBoolean('fcp.headingSelect', 'AUTOPILOT HEADING LOCK'),
  'fcp.altitudeHold': simvarBoolean('fcp.altitudeHold', 'AUTOPILOT ALTITUDE LOCK'),
  'fcp.verticalSpeed': simvarBoolean('fcp.verticalSpeed', 'AUTOPILOT VERTICAL HOLD'),
  'fcp.levelChange': simvarBoolean('fcp.levelChange', 'AUTOPILOT FLIGHT LEVEL CHANGE'),

  'lights.strobe': simvarBoolean('lights.strobe', 'LIGHT STROBE'),
  'lights.beacon': simvarBoolean('lights.beacon', 'LIGHT BEACON'),
  'lights.nav': simvarBoolean('lights.nav', 'LIGHT NAV'),
  'lights.logo': simvarBoolean('lights.logo', 'LIGHT LOGO'),
  'lights.wing': simvarBoolean('lights.wing', 'LIGHT WING'),
  'lights.landing': simvarBoolean('lights.landing', 'LIGHT LANDING'),
  'lights.taxi': simvarBoolean('lights.taxi', 'LIGHT TAXI'),
  'lights.runwayTurnoff': simvarBoolean('lights.runwayTurnoff', 'LIGHT TAXI:2'),

  'controls.flapsPercent': simvarNumber('controls.flapsPercent', 'FLAPS HANDLE PERCENT', 'Percent'),
  'controls.flapsIndex': simvarNumber('controls.flapsIndex', 'FLAPS HANDLE INDEX', 'Number'),
  'controls.flapAngleDeg': simvarNumber('controls.flapAngleDeg', 'TRAILING EDGE FLAPS LEFT ANGLE', 'Degrees', 1),
  'controls.speedbrakePercent': simvarNumber('controls.speedbrakePercent', 'SPOILERS HANDLE POSITION', 'Percent'),
  'controls.gearHandleDown': simvarBoolean('controls.gearHandleDown', 'GEAR HANDLE POSITION'),
  'controls.gearNosePct': simvarNumber('controls.gearNosePct', 'GEAR CENTER POSITION', 'Percent'),
  'controls.gearLeftPct': simvarNumber('controls.gearLeftPct', 'GEAR LEFT POSITION', 'Percent'),
  'controls.gearRightPct': simvarNumber('controls.gearRightPct', 'GEAR RIGHT POSITION', 'Percent'),
  'controls.parkingBrake': simvarBoolean('controls.parkingBrake', 'BRAKE PARKING POSITION'),

  'systems.engine1N1': simvarNumber('systems.engine1N1', 'TURB ENG N1:1', 'Percent', 1),
  'systems.engine2N1': simvarNumber('systems.engine2N1', 'TURB ENG N1:2', 'Percent', 1),
  'systems.engine1Running': simvarBoolean('systems.engine1Running', 'ENG COMBUSTION:1'),
  'systems.engine2Running': simvarBoolean('systems.engine2Running', 'ENG COMBUSTION:2'),
  'systems.fuelTotalPct': simvarNumber('systems.fuelTotalPct', 'FUEL SELECTED QUANTITY PERCENT:99', 'Percent', 1),
  'systems.fuelTotalWeightLbs': simvarNumber('systems.fuelTotalWeightLbs', 'FUEL TOTAL QUANTITY WEIGHT EX1', 'Pounds'),
  'systems.grossWeightLbs': simvarNumber('systems.grossWeightLbs', 'TOTAL WEIGHT', 'Pounds'),
  'systems.cabinAltitudeFt': simvarNumber('systems.cabinAltitudeFt', 'PRESSURIZATION CABIN ALTITUDE', 'Feet'),
  'systems.cabinVerticalSpeedFpm': simvarNumber('systems.cabinVerticalSpeedFpm', 'PRESSURIZATION CABIN ALTITUDE RATE', 'Feet per minute'),
  'systems.cabinDeltaPressurePsi': simvarNumber('systems.cabinDeltaPressurePsi', 'PRESSURIZATION PRESSURE DIFFERENTIAL', 'PSI', 2),
  'systems.outsideAirTemperatureC': simvarNumber('systems.outsideAirTemperatureC', 'AMBIENT TEMPERATURE', 'Celsius', 1),
  'systems.mach': simvarNumber('systems.mach', 'AIRSPEED MACH', 'Mach', 3),
};

module.exports = {
  INIBUILDS_A310_FIELDS,
};

export {};
