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

function gaugeField(
  id: string,
  name: string,
  unit: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return {
    id,
    sources: [{
      route: { type: 'lvar', name: `A:${name}`, unit },
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

function booleanField(
  id: string,
  name: string,
  trueValues: readonly (boolean | number | string)[] = [1],
): AircraftIntegrationField {
  return lvarField(id, name, {
    type: 'boolean',
    trueValues,
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

function numberField(
  id: string,
  name: string,
  precision = 0,
): AircraftIntegrationField {
  return lvarField(id, name, { type: 'number', precision });
}

function numberGaugeField(
  id: string,
  name: string,
  unit: string,
  precision = 0,
): AircraftIntegrationField {
  return gaugeField(id, name, unit, { type: 'number', precision });
}

function numberSimvarField(
  id: string,
  name: string,
  unit: string,
  precision = 0,
): AircraftIntegrationField {
  return simvarField(id, name, unit, { type: 'number', precision });
}

function enumField(
  id: string,
  name: string,
  values: Readonly<Record<number, string>>,
): AircraftIntegrationField {
  return lvarField(id, name, { type: 'enum', values });
}

// FlyByWire publishes the A380X flight-deck state used here for external
// hardware/software integrations. Raw A32NX-prefixed names stay confined to
// this adapter; the prefix is part of the documented A380X interface.
const FBW_A380X_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'propulsion.throttleLever1Angle': numberField(
    'propulsion.throttleLever1Angle',
    'A32NX_AUTOTHRUST_TLA:1',
    2,
  ),
  'propulsion.throttleLever2Angle': numberField(
    'propulsion.throttleLever2Angle',
    'A32NX_AUTOTHRUST_TLA:2',
    2,
  ),
  'propulsion.throttleLever3Angle': numberField(
    'propulsion.throttleLever3Angle',
    'A32NX_AUTOTHRUST_TLA:3',
    2,
  ),
  'propulsion.throttleLever4Angle': numberField(
    'propulsion.throttleLever4Angle',
    'A32NX_AUTOTHRUST_TLA:4',
    2,
  ),
  'flightGuidance.speedValue': numberField(
    'flightGuidance.speedValue',
    'A32NX_AUTOPILOT_SPEED_SELECTED',
  ),
  'flightGuidance.headingDeg': numberField(
    'flightGuidance.headingDeg',
    'A32NX_AUTOPILOT_HEADING_SELECTED',
  ),
  'flightGuidance.altitudeFt': numberGaugeField(
    'flightGuidance.altitudeFt',
    'AUTOPILOT ALTITUDE LOCK VAR:3',
    'Feet',
  ),
  'flightGuidance.verticalValue': numberField(
    'flightGuidance.verticalValue',
    'A32NX_AUTOPILOT_VS_SELECTED',
    1,
  ),
  'flightGuidance.ap1': booleanField(
    'flightGuidance.ap1',
    'A32NX_AUTOPILOT_1_ACTIVE',
  ),
  'flightGuidance.ap2': booleanField(
    'flightGuidance.ap2',
    'A32NX_AUTOPILOT_2_ACTIVE',
  ),
  'flightGuidance.autothrust': booleanField(
    'flightGuidance.autothrust',
    'A32NX_AUTOTHRUST_STATUS',
    [1, 2],
  ),
  'flightGuidance.autothrustStatus': enumField(
    'flightGuidance.autothrustStatus',
    'A32NX_AUTOTHRUST_STATUS',
    {
      0: 'disengaged',
      1: 'armed',
      2: 'active',
    },
  ),
  'flightGuidance.localizer': booleanField(
    'flightGuidance.localizer',
    'A32NX_FCU_LOC_MODE_ACTIVE',
  ),
  'flightGuidance.approach': booleanField(
    'flightGuidance.approach',
    'A32NX_FCU_APPR_MODE_ACTIVE',
  ),

  'lights.strobe': booleanSimvarField('lights.strobe', 'LIGHT STROBE'),
  'lights.beacon': booleanSimvarField('lights.beacon', 'LIGHT BEACON'),
  'lights.nav': booleanSimvarField('lights.nav', 'LIGHT NAV'),
  'lights.logo': booleanSimvarField('lights.logo', 'LIGHT LOGO'),
  'lights.wing': booleanSimvarField('lights.wing', 'LIGHT WING'),
  'lights.landing': booleanSimvarField('lights.landing', 'LIGHT LANDING'),
  'lights.taxi': booleanSimvarField('lights.taxi', 'LIGHT TAXI'),
  'lights.runwayTurnoff': booleanSimvarField('lights.runwayTurnoff', 'LIGHT TAXI:2'),

  'controls.flapsIndex': numberField(
    'controls.flapsIndex',
    'A32NX_FLAPS_HANDLE_INDEX',
  ),
  'controls.spoilersHandle': numberField(
    'controls.spoilersHandle',
    'A32NX_SPOILERS_HANDLE_POSITION',
    2,
  ),
  'controls.spoilersArmed': booleanField(
    'controls.spoilersArmed',
    'A32NX_SPOILERS_ARMED',
  ),
  'controls.parkingBrake': booleanField(
    'controls.parkingBrake',
    'A32NX_PARK_BRAKE_LEVER_POS',
  ),
  'controls.gearHandleDown': booleanSimvarField(
    'controls.gearHandleDown',
    'GEAR HANDLE POSITION',
  ),
  'controls.gearNosePct': numberSimvarField(
    'controls.gearNosePct',
    'GEAR CENTER POSITION',
    'Percent',
  ),
  'controls.gearLeftPct': numberSimvarField(
    'controls.gearLeftPct',
    'GEAR LEFT POSITION',
    'Percent',
  ),
  'controls.gearRightPct': numberSimvarField(
    'controls.gearRightPct',
    'GEAR RIGHT POSITION',
    'Percent',
  ),

  'systems.engine1N1': numberSimvarField('systems.engine1N1', 'TURB ENG N1:1', 'Percent', 1),
  'systems.engine2N1': numberSimvarField('systems.engine2N1', 'TURB ENG N1:2', 'Percent', 1),
  'systems.engine3N1': numberSimvarField('systems.engine3N1', 'TURB ENG N1:3', 'Percent', 1),
  'systems.engine4N1': numberSimvarField('systems.engine4N1', 'TURB ENG N1:4', 'Percent', 1),
  'systems.engine1Running': booleanSimvarField('systems.engine1Running', 'ENG COMBUSTION:1'),
  'systems.engine2Running': booleanSimvarField('systems.engine2Running', 'ENG COMBUSTION:2'),
  'systems.engine3Running': booleanSimvarField('systems.engine3Running', 'ENG COMBUSTION:3'),
  'systems.engine4Running': booleanSimvarField('systems.engine4Running', 'ENG COMBUSTION:4'),
  'systems.fuelTotalPct': numberSimvarField(
    'systems.fuelTotalPct',
    'FUEL SELECTED QUANTITY PERCENT:99',
    'Percent',
    1,
  ),
  'systems.fuelTotalWeightLbs': numberSimvarField(
    'systems.fuelTotalWeightLbs',
    'FUEL TOTAL QUANTITY WEIGHT EX1',
    'Pounds',
  ),
  'systems.grossWeightLbs': numberSimvarField(
    'systems.grossWeightLbs',
    'TOTAL WEIGHT',
    'Pounds',
  ),
  'systems.cabinAltitudeFt': numberSimvarField(
    'systems.cabinAltitudeFt',
    'PRESSURIZATION CABIN ALTITUDE',
    'Feet',
  ),
  'systems.cabinVerticalSpeedFpm': numberSimvarField(
    'systems.cabinVerticalSpeedFpm',
    'PRESSURIZATION CABIN ALTITUDE RATE',
    'Feet per minute',
  ),
  'systems.cabinDeltaPressurePsi': numberSimvarField(
    'systems.cabinDeltaPressurePsi',
    'PRESSURIZATION PRESSURE DIFFERENTIAL',
    'PSI',
    2,
  ),
  'systems.outsideAirTemperatureC': numberSimvarField(
    'systems.outsideAirTemperatureC',
    'AMBIENT TEMPERATURE',
    'Celsius',
    1,
  ),
  'systems.mach': numberSimvarField('systems.mach', 'AIRSPEED MACH', 'Mach', 3),
};

module.exports = {
  FBW_A380X_FIELDS,
};

export {};
