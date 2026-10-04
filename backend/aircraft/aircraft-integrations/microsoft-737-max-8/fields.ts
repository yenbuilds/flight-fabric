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

function booleanGaugeField(id: string, name: string): AircraftIntegrationField {
  return { id, sources: [{
    route: { type: 'lvar', name: `A:${name}`, unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  }] };
}

function booleanSelectorField(id: string, name: string): AircraftIntegrationField {
  return { id, sources: [{
    route: { type: 'lvar', name, unit: 'Bool' },
    decode: { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] },
  }] };
}

// This exact-profile adapter uses standard MSFS values and independently
// observed native selector mirrors. Its write layer confirms these fields; it makes
// no claims about Boeing CMD-channel or VNAV semantics, and unavailable mirrors
// are never replaced with guessed routes.
const MICROSOFT_737_MAX_8_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'mcp.speedKts': numberField('mcp.speedKts', 'AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
  'mcp.headingDeg': numberField('mcp.headingDeg', 'AUTOPILOT HEADING LOCK DIR', 'Degrees'),
  'mcp.altitudeFt': { id: 'mcp.altitudeFt', sources: [{
    route: { type: 'lvar', name: 'A:AUTOPILOT ALTITUDE LOCK VAR:3', unit: 'Feet' },
    decode: { type: 'number', precision: 0 },
  }] },
  'mcp.verticalSpeedFpm': numberField('mcp.verticalSpeedFpm', 'AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),
  'afds.apMaster': booleanField('afds.apMaster', 'AUTOPILOT MASTER'),
  'afds.flightDirector': booleanField('afds.flightDirector', 'AUTOPILOT FLIGHT DIRECTOR ACTIVE'),
  'afds.autothrottleActive': booleanField('afds.autothrottleActive', 'AUTOTHROTTLE ACTIVE'),
  'afds.autothrottleArmed': booleanField('afds.autothrottleArmed', 'AUTOPILOT THROTTLE ARM'),
  'afds.speed': booleanField('afds.speed', 'AUTOPILOT AIRSPEED HOLD'),
  'afds.headingSelect': booleanField('afds.headingSelect', 'AUTOPILOT HEADING LOCK'),
  'afds.lnav': booleanField('afds.lnav', 'AUTOPILOT NAV1 LOCK'),
  'afds.altitudeHold': booleanField('afds.altitudeHold', 'AUTOPILOT ALTITUDE LOCK'),
  'afds.verticalSpeed': booleanField('afds.verticalSpeed', 'AUTOPILOT VERTICAL HOLD'),
  'afds.levelChange': booleanField('afds.levelChange', 'AUTOPILOT FLIGHT LEVEL CHANGE'),
  'afds.approach': booleanField('afds.approach', 'AUTOPILOT APPROACH HOLD'),

  'lights.strobe': booleanField('lights.strobe', 'LIGHT STROBE'),
  'lights.beacon': booleanField('lights.beacon', 'LIGHT BEACON'),
  'lights.nav': booleanField('lights.nav', 'LIGHT NAV'),
  'lights.logo': booleanField('lights.logo', 'LIGHT LOGO'),
  // This preset omits wing from both LIGHT STATES masks. Read the documented
  // individual A-var through the existing gauge bridge instead of deriving it
  // from that mask. It is shared with the profile's broadcast light mapping.
  'lights.wing': booleanGaugeField('lights.wing', 'LIGHT WING'),
  'lights.landing': booleanField('lights.landing', 'LIGHT LANDING'),
  // Behavior debugger ValueCode reads these aircraft-scoped selector mirrors.
  // LIGHT LANDING ON:index also becomes true with TAXI AUTO and cannot confirm
  // fixed selector positions. Both sides were isolated with taxi OFF and AUTO.
  'lights.landingLeft': booleanSelectorField('lights.landingLeft', 'L:1:XMLVAR_LIGHT_LANDING_FIXED_L'),
  'lights.landingRight': booleanSelectorField('lights.landingRight', 'L:1:XMLVAR_LIGHT_LANDING_FIXED_R'),
  'lights.taxi': booleanGaugeField('lights.taxi', 'LIGHT TAXI ON:3'),
  // This shared binding resolves the normalized broadcast turnoff field,
  // supplied here by the profile's independently observed left/right reads.
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
  MICROSOFT_737_MAX_8_FIELDS,
};

export {};
