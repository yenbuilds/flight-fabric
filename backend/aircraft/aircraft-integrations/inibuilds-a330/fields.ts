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

// There is no published exact A330 LVAR/InputEvent catalogue. This adapter is
// intentionally limited to an explicit set of standard MSFS 2024 SimVars
// normalized into Flight Fabric's telemetry frame. Raw names stay backend-only
// and can later be replaced by A330-specific sources without changing the UI.
const INIBUILDS_A330_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'flightGuidance.speedValue': numberField('flightGuidance.speedValue', 'AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
  'flightGuidance.headingDeg': numberField('flightGuidance.headingDeg', 'AUTOPILOT HEADING LOCK DIR', 'Degrees'),
  'flightGuidance.altitudeFt': numberField('flightGuidance.altitudeFt', 'AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
  'flightGuidance.verticalSpeedFpm': numberField('flightGuidance.verticalSpeedFpm', 'AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),
  'flightGuidance.apMaster': booleanField('flightGuidance.apMaster', 'AUTOPILOT MASTER'),
  'flightGuidance.flightDirector': booleanField('flightGuidance.flightDirector', 'AUTOPILOT FLIGHT DIRECTOR ACTIVE'),
  'flightGuidance.autothrottleActive': booleanField('flightGuidance.autothrottleActive', 'AUTOTHROTTLE ACTIVE'),
  'flightGuidance.autothrottleArmed': booleanField('flightGuidance.autothrottleArmed', 'AUTOPILOT THROTTLE ARM'),
  'flightGuidance.altitudeHold': booleanField('flightGuidance.altitudeHold', 'AUTOPILOT ALTITUDE LOCK'),
  'flightGuidance.headingHold': booleanField('flightGuidance.headingHold', 'AUTOPILOT HEADING LOCK'),
  'flightGuidance.navHold': booleanField('flightGuidance.navHold', 'AUTOPILOT NAV1 LOCK'),
  'flightGuidance.approachHold': booleanField('flightGuidance.approachHold', 'AUTOPILOT APPROACH HOLD'),
  'flightGuidance.verticalSpeedHold': booleanField('flightGuidance.verticalSpeedHold', 'AUTOPILOT VERTICAL HOLD'),
  'flightGuidance.flightLevelChange': booleanField('flightGuidance.flightLevelChange', 'AUTOPILOT FLIGHT LEVEL CHANGE'),
  'flightGuidance.speedHold': booleanField('flightGuidance.speedHold', 'AUTOPILOT AIRSPEED HOLD'),

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
  'controls.spoilersArmed': booleanField('controls.spoilersArmed', 'SPOILERS ARMED'),
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
  INIBUILDS_A330_FIELDS,
};

export {};
