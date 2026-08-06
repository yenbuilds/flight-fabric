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

// Microsoft/S&H do not publish an external MSATR_* variable contract for this
// aircraft. Keep the adapter entirely on documented standard MSFS SimVars and
// fail unavailable if the ATR does not mirror a given state.
const MICROSOFT_ATR_72_600_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'fgcp.speedKts': simvarNumber('fgcp.speedKts', 'AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
  'fgcp.headingDeg': simvarNumber('fgcp.headingDeg', 'AUTOPILOT HEADING LOCK DIR', 'Degrees'),
  'fgcp.altitudeFt': simvarNumber('fgcp.altitudeFt', 'AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
  'fgcp.verticalSpeedFpm': simvarNumber('fgcp.verticalSpeedFpm', 'AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),
  'fgcp.apMaster': simvarBoolean('fgcp.apMaster', 'AUTOPILOT MASTER'),
  'fgcp.flightDirector': simvarBoolean('fgcp.flightDirector', 'AUTOPILOT FLIGHT DIRECTOR ACTIVE'),
  'fgcp.headingSelect': simvarBoolean('fgcp.headingSelect', 'AUTOPILOT HEADING LOCK'),
  'fgcp.altitudeMode': simvarBoolean('fgcp.altitudeMode', 'AUTOPILOT ALTITUDE LOCK'),
  'fgcp.verticalSpeedMode': simvarBoolean('fgcp.verticalSpeedMode', 'AUTOPILOT VERTICAL HOLD'),
  'fgcp.approach': simvarBoolean('fgcp.approach', 'AUTOPILOT APPROACH HOLD'),

  'lights.strobe': simvarBoolean('lights.strobe', 'LIGHT STROBE'),
  'lights.beacon': simvarBoolean('lights.beacon', 'LIGHT BEACON'),
  'lights.nav': simvarBoolean('lights.nav', 'LIGHT NAV'),
  'lights.logo': simvarBoolean('lights.logo', 'LIGHT LOGO'),
  'lights.wing': simvarBoolean('lights.wing', 'LIGHT WING'),
  'lights.landing': simvarBoolean('lights.landing', 'LIGHT LANDING'),
  'lights.taxi': simvarBoolean('lights.taxi', 'LIGHT TAXI'),

  'controls.flapsPercent': simvarNumber('controls.flapsPercent', 'FLAPS HANDLE PERCENT', 'Percent'),
  'controls.flapsIndex': simvarNumber('controls.flapsIndex', 'FLAPS HANDLE INDEX', 'Number'),
  'controls.flapAngleDeg': simvarNumber('controls.flapAngleDeg', 'TRAILING EDGE FLAPS LEFT ANGLE', 'Degrees', 1),
  'controls.gearHandleDown': simvarBoolean('controls.gearHandleDown', 'GEAR HANDLE POSITION'),
  'controls.gearNosePct': simvarNumber('controls.gearNosePct', 'GEAR CENTER POSITION', 'Percent'),
  'controls.gearLeftPct': simvarNumber('controls.gearLeftPct', 'GEAR LEFT POSITION', 'Percent'),
  'controls.gearRightPct': simvarNumber('controls.gearRightPct', 'GEAR RIGHT POSITION', 'Percent'),
  'controls.parkingBrake': simvarBoolean('controls.parkingBrake', 'BRAKE PARKING POSITION'),

  'systems.engine1Running': simvarBoolean('systems.engine1Running', 'ENG COMBUSTION:1'),
  'systems.engine2Running': simvarBoolean('systems.engine2Running', 'ENG COMBUSTION:2'),
  'systems.fuelTotalPct': simvarNumber('systems.fuelTotalPct', 'FUEL SELECTED QUANTITY PERCENT:99', 'Percent', 1),
  'systems.fuelTotalWeightLbs': simvarNumber('systems.fuelTotalWeightLbs', 'FUEL TOTAL QUANTITY WEIGHT EX1', 'Pounds'),
  'systems.grossWeightLbs': simvarNumber('systems.grossWeightLbs', 'TOTAL WEIGHT', 'Pounds'),
  'systems.cabinAltitudeFt': simvarNumber('systems.cabinAltitudeFt', 'PRESSURIZATION CABIN ALTITUDE', 'Feet'),
  'systems.cabinVerticalSpeedFpm': simvarNumber('systems.cabinVerticalSpeedFpm', 'PRESSURIZATION CABIN ALTITUDE RATE', 'Feet per minute'),
  'systems.cabinDeltaPressurePsi': simvarNumber('systems.cabinDeltaPressurePsi', 'PRESSURIZATION PRESSURE DIFFERENTIAL', 'PSI', 2),
  'systems.outsideAirTemperatureC': simvarNumber('systems.outsideAirTemperatureC', 'AMBIENT TEMPERATURE', 'Celsius', 1),
};

module.exports = {
  MICROSOFT_ATR_72_600_FIELDS,
};

export {};
