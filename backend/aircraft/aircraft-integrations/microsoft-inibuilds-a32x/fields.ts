'use strict';

import type {
  AircraftIntegrationDecoder,
  AircraftIntegrationField,
} from '../types.js';

function simvarField(
  id: string,
  name: string,
  unit: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return {
    id,
    sources: [{ route: { type: 'simvar', name, unit }, decode }],
  };
}

function booleanField(id: string, name: string): AircraftIntegrationField {
  return simvarField(id, name, 'Bool', {
    type: 'boolean',
    trueValues: [true, 1],
    falseValues: [false, 0],
  });
}

function numberField(id: string, name: string, unit: string, precision = 0): AircraftIntegrationField {
  return simvarField(id, name, unit, { type: 'number', precision });
}

// The cited Microsoft and iniBuilds material does not define an A320neo V2 or
// A321LR custom integration catalogue. This shared adapter therefore keeps its
// reads to an explicit standard-SimVar allowlist. The compact action layer can
// confirm standard-event requests against these fields without claiming
// Airbus-private selector or managed-mode semantics.
const MICROSOFT_INIBUILDS_A32X_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'fcu.speedKts': numberField('fcu.speedKts', 'AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
  'fcu.headingDeg': numberField('fcu.headingDeg', 'AUTOPILOT HEADING LOCK DIR', 'Degrees'),
  'fcu.altitudeFt': numberField('fcu.altitudeFt', 'AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
  'fcu.verticalSpeedFpm': numberField('fcu.verticalSpeedFpm', 'AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),
  'flightGuidance.apMaster': booleanField('flightGuidance.apMaster', 'AUTOPILOT MASTER'),
  'flightGuidance.flightDirector': booleanField('flightGuidance.flightDirector', 'AUTOPILOT FLIGHT DIRECTOR ACTIVE'),
  'flightGuidance.autothrottleActive': booleanField('flightGuidance.autothrottleActive', 'AUTOTHROTTLE ACTIVE'),
  'flightGuidance.autothrottleArmed': booleanField('flightGuidance.autothrottleArmed', 'AUTOPILOT THROTTLE ARM'),
  'flightGuidance.speedHold': booleanField('flightGuidance.speedHold', 'AUTOPILOT AIRSPEED HOLD'),
  'flightGuidance.headingHold': booleanField('flightGuidance.headingHold', 'AUTOPILOT HEADING LOCK'),
  'flightGuidance.navHold': booleanField('flightGuidance.navHold', 'AUTOPILOT NAV1 LOCK'),
  'flightGuidance.altitudeHold': booleanField('flightGuidance.altitudeHold', 'AUTOPILOT ALTITUDE LOCK'),
  'flightGuidance.verticalSpeedHold': booleanField('flightGuidance.verticalSpeedHold', 'AUTOPILOT VERTICAL HOLD'),
  'flightGuidance.flightLevelChange': booleanField('flightGuidance.flightLevelChange', 'AUTOPILOT FLIGHT LEVEL CHANGE'),
  'flightGuidance.approachHold': booleanField('flightGuidance.approachHold', 'AUTOPILOT APPROACH HOLD'),

  'lights.strobe': booleanField('lights.strobe', 'LIGHT STROBE'),
  'lights.beacon': booleanField('lights.beacon', 'LIGHT BEACON'),
  'lights.nav': booleanField('lights.nav', 'LIGHT NAV'),
  'lights.logo': booleanField('lights.logo', 'LIGHT LOGO'),
  'lights.wing': booleanField('lights.wing', 'LIGHT WING'),
  'lights.landing': booleanField('lights.landing', 'LIGHT LANDING'),
  'lights.taxi': booleanField('lights.taxi', 'LIGHT TAXI'),
  'lights.runwayTurnoff': booleanField('lights.runwayTurnoff', 'LIGHT TAXI:2'),

  'controls.flapsPercent': numberField('controls.flapsPercent', 'FLAPS HANDLE PERCENT', 'Percent'),
  'controls.flapsIndex': numberField('controls.flapsIndex', 'FLAPS HANDLE INDEX', 'Number'),
  'controls.flapAngleDeg': numberField('controls.flapAngleDeg', 'TRAILING EDGE FLAPS LEFT ANGLE', 'Degrees', 1),
  'controls.speedbrakePercent': numberField('controls.speedbrakePercent', 'SPOILERS HANDLE POSITION', 'Percent'),
  'controls.gearHandleDown': booleanField('controls.gearHandleDown', 'GEAR HANDLE POSITION'),
  'controls.gearNosePct': numberField('controls.gearNosePct', 'GEAR CENTER POSITION', 'Percent'),
  'controls.gearLeftPct': numberField('controls.gearLeftPct', 'GEAR LEFT POSITION', 'Percent'),
  'controls.gearRightPct': numberField('controls.gearRightPct', 'GEAR RIGHT POSITION', 'Percent'),
  'controls.parkingBrake': booleanField('controls.parkingBrake', 'BRAKE PARKING POSITION'),

  'systems.engine1N1': numberField('systems.engine1N1', 'TURB ENG N1:1', 'Percent', 1),
  'systems.engine2N1': numberField('systems.engine2N1', 'TURB ENG N1:2', 'Percent', 1),
  'systems.engine1Running': booleanField('systems.engine1Running', 'ENG COMBUSTION:1'),
  'systems.engine2Running': booleanField('systems.engine2Running', 'ENG COMBUSTION:2'),
  'systems.fuelTotalPct': numberField('systems.fuelTotalPct', 'FUEL SELECTED QUANTITY PERCENT:99', 'Percent', 1),
  'systems.fuelTotalWeightLbs': numberField('systems.fuelTotalWeightLbs', 'FUEL TOTAL QUANTITY WEIGHT EX1', 'Pounds'),
  'systems.grossWeightLbs': numberField('systems.grossWeightLbs', 'TOTAL WEIGHT', 'Pounds'),
  'systems.cabinAltitudeFt': numberField('systems.cabinAltitudeFt', 'PRESSURIZATION CABIN ALTITUDE', 'Feet'),
  'systems.cabinVerticalSpeedFpm': numberField('systems.cabinVerticalSpeedFpm', 'PRESSURIZATION CABIN ALTITUDE RATE', 'Feet per minute'),
  'systems.cabinDeltaPressurePsi': numberField('systems.cabinDeltaPressurePsi', 'PRESSURIZATION PRESSURE DIFFERENTIAL', 'PSI', 2),
  'systems.outsideAirTemperatureC': numberField('systems.outsideAirTemperatureC', 'AMBIENT TEMPERATURE', 'Celsius', 1),
  'systems.mach': numberField('systems.mach', 'AIRSPEED MACH', 'Mach', 3),
};

module.exports = {
  MICROSOFT_INIBUILDS_A32X_FIELDS,
};

export {};
