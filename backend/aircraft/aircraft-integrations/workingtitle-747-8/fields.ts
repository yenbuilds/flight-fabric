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

// No first-party external LVAR/B-var/InputEvent catalogue is published for
// the included 747-8. Expose only an explicit standard-SimVar read allowlist;
// unavailable mirrors stay blank instead of being replaced by unverified values.
const MICROSOFT_747_8_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'mcp.speedKts': numberField('mcp.speedKts', 'AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
  'mcp.headingDeg': numberField('mcp.headingDeg', 'AUTOPILOT HEADING LOCK DIR', 'Degrees'),
  'mcp.altitudeFt': numberField('mcp.altitudeFt', 'AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
  'mcp.verticalSpeedFpm': numberField('mcp.verticalSpeedFpm', 'AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),
  'afds.apMaster': booleanField('afds.apMaster', 'AUTOPILOT MASTER'),
  'afds.flightDirector': booleanField('afds.flightDirector', 'AUTOPILOT FLIGHT DIRECTOR ACTIVE'),
  'afds.autothrottleActive': booleanField('afds.autothrottleActive', 'AUTOTHROTTLE ACTIVE'),
  'afds.autothrottleArmed': booleanField('afds.autothrottleArmed', 'AUTOPILOT THROTTLE ARM'),
  'afds.speed': booleanField('afds.speed', 'AUTOPILOT AIRSPEED HOLD'),
  'afds.headingSelect': booleanField('afds.headingSelect', 'AUTOPILOT HEADING LOCK'),
  'afds.navLockMirror': booleanField('afds.navLockMirror', 'AUTOPILOT NAV1 LOCK'),
  'afds.altitudeHold': booleanField('afds.altitudeHold', 'AUTOPILOT ALTITUDE LOCK'),
  'afds.verticalSpeed': booleanField('afds.verticalSpeed', 'AUTOPILOT VERTICAL HOLD'),
  'afds.levelChange': booleanField('afds.levelChange', 'AUTOPILOT FLIGHT LEVEL CHANGE'),
  'afds.approach': booleanField('afds.approach', 'AUTOPILOT APPROACH HOLD'),

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
  'systems.engine3N1': numberField('systems.engine3N1', 'TURB ENG N1:3', 'Percent', 1),
  'systems.engine4N1': numberField('systems.engine4N1', 'TURB ENG N1:4', 'Percent', 1),
  'systems.engine1Running': booleanField('systems.engine1Running', 'ENG COMBUSTION:1'),
  'systems.engine2Running': booleanField('systems.engine2Running', 'ENG COMBUSTION:2'),
  'systems.engine3Running': booleanField('systems.engine3Running', 'ENG COMBUSTION:3'),
  'systems.engine4Running': booleanField('systems.engine4Running', 'ENG COMBUSTION:4'),
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
  MICROSOFT_747_8_FIELDS,
};

export {};
