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
    sources: [{
      route: { type: 'simvar', name, unit },
      decode,
    }],
  };
}

function booleanField(id: string, name: string): AircraftIntegrationField {
  return simvarField(id, name, 'Bool', {
    type: 'boolean',
    trueValues: [true, 1],
    falseValues: [false, 0],
  });
}

function numberField(
  id: string,
  name: string,
  unit: string,
  precision = 0,
): AircraftIntegrationField {
  return simvarField(id, name, unit, { type: 'number', precision });
}

// No vendor-published TriStar telemetry catalogue is available. Keep this
// monitoring surface on an explicit set of standard SimVars normalized into the
// Flight Fabric frame. AFCS engagement/mode booleans are deliberately absent
// because the standard autopilot fields do not provide the required AFCS state.
// The speedbrake field is also absent because the generic spoiler value can
// include DLC or roll-spoiler movement during normal flight.
const INIBUILDS_TRISTAR_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'flightGuidance.speedValue': numberField('flightGuidance.speedValue', 'AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
  'flightGuidance.headingDeg': numberField('flightGuidance.headingDeg', 'AUTOPILOT HEADING LOCK DIR', 'Degrees'),
  'flightGuidance.altitudeFt': numberField('flightGuidance.altitudeFt', 'AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
  'flightGuidance.verticalSpeedFpm': numberField('flightGuidance.verticalSpeedFpm', 'AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),

  'lights.strobe': booleanField('lights.strobe', 'LIGHT STROBE'),
  'lights.beacon': booleanField('lights.beacon', 'LIGHT BEACON'),
  'lights.nav': booleanField('lights.nav', 'LIGHT NAV'),
  'lights.logo': booleanField('lights.logo', 'LIGHT LOGO'),
  'lights.landing': booleanField('lights.landing', 'LIGHT LANDING'),
  'lights.taxi': booleanField('lights.taxi', 'LIGHT TAXI'),

  'controls.flapsPercent': numberField('controls.flapsPercent', 'FLAPS HANDLE PERCENT', 'Percent'),
  'controls.flapsIndex': numberField('controls.flapsIndex', 'FLAPS HANDLE INDEX', 'Number'),
  'controls.flapAngleDeg': numberField('controls.flapAngleDeg', 'TRAILING EDGE FLAPS LEFT ANGLE', 'Degrees', 1),
  'controls.gearHandleDown': booleanField('controls.gearHandleDown', 'GEAR HANDLE POSITION'),
  'controls.gearNosePct': numberField('controls.gearNosePct', 'GEAR CENTER POSITION', 'Percent'),
  'controls.gearLeftPct': numberField('controls.gearLeftPct', 'GEAR LEFT POSITION', 'Percent'),
  'controls.gearRightPct': numberField('controls.gearRightPct', 'GEAR RIGHT POSITION', 'Percent'),
  'controls.parkingBrake': booleanField('controls.parkingBrake', 'BRAKE PARKING POSITION'),

  'systems.engine1N1': numberField('systems.engine1N1', 'TURB ENG N1:1', 'Percent', 1),
  'systems.engine2N1': numberField('systems.engine2N1', 'TURB ENG N1:2', 'Percent', 1),
  'systems.engine3N1': numberField('systems.engine3N1', 'TURB ENG N1:3', 'Percent', 1),
  'systems.engine1Running': booleanField('systems.engine1Running', 'ENG COMBUSTION:1'),
  'systems.engine2Running': booleanField('systems.engine2Running', 'ENG COMBUSTION:2'),
  'systems.engine3Running': booleanField('systems.engine3Running', 'ENG COMBUSTION:3'),
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
  INIBUILDS_TRISTAR_FIELDS,
};

export {};
