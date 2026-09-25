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

function lvarNumber(
  id: string,
  name: string,
  precision = 0,
  unavailableValues: readonly number[] = [],
): AircraftIntegrationField {
  const decode: AircraftIntegrationDecoder = {
    type: 'number',
    precision,
    ...(unavailableValues.length > 0 ? { unavailableValues } : {}),
  };
  return field(id, { type: 'lvar', name: `L:${name}`, unit: 'Number' }, decode);
}

function lvarBoolean(
  id: string,
  name: string,
  trueValues: readonly (boolean | number)[] = [true, 1],
  falseValues: readonly (boolean | number)[] = [false, 0],
): AircraftIntegrationField {
  return field(id, { type: 'lvar', name: `L:${name}`, unit: 'Number' }, {
    type: 'boolean',
    trueValues,
    falseValues,
  });
}

function lvarEnum(
  id: string,
  name: string,
  values: Readonly<Record<string, string>>,
): AircraftIntegrationField {
  return field(id, { type: 'lvar', name: `L:${name}`, unit: 'Number' }, {
    type: 'enum',
    values,
  });
}

function simvarNumber(
  id: string,
  name: string,
  unit: string,
  precision = 0,
): AircraftIntegrationField {
  return field(id, { type: 'simvar', name, unit }, { type: 'number', precision });
}

function simvarBoolean(id: string, name: string): AircraftIntegrationField {
  return field(id, { type: 'simvar', name, unit: 'Bool' }, {
    type: 'boolean',
    trueValues: [true, 1],
    falseValues: [false, 0],
  });
}

// TFDi publishes the MD11_AFS_*, AP/ATS, mode-flag, V-speed, and APU rows as
// read/integration variables. Light switch semantics were confirmed through
// reversible live transitions; see MD11-CONTROL-VALIDATION.md. Standard light
// bits did not follow those switches and must not confirm controls. Speedbrake telemetry is
// deliberately absent because the MD-11's Direct Lift Control can move spoiler
// panels during a normal approach.
const TFDI_MD_11_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'afs.speedValue': lvarNumber('afs.speedValue', 'MD11_AFS_SPD', 3, [-999]),
  'afs.headingValue': lvarNumber('afs.headingValue', 'MD11_AFS_HDG', 0, [-999]),
  'afs.altitudeValue': lvarNumber('afs.altitudeValue', 'MD11_AFS_ALT'),
  'afs.verticalValue': lvarNumber('afs.verticalValue', 'MD11_AFS_VS', 1, [-9999]),
  'afs.apState': lvarEnum('afs.apState', 'MD11_AP_STATE', {
    0: 'off',
    1: 'ap1',
    2: 'ap2',
    3: 'dual',
  }),
  'afs.apMaster': lvarBoolean('afs.apMaster', 'MD11_AP_STATE', [true, 1, 2, 3]),
  'afs.atsClamped': lvarBoolean('afs.atsClamped', 'MD11_ATS_CLAMP'),
  'afs.speedMode': lvarEnum('afs.speedMode', 'MD11_AP_IAS_MACH', {
    0: 'ias',
    1: 'mach',
  }),
  'afs.headingMode': lvarEnum('afs.headingMode', 'MD11_AP_HDG_TRK', {
    0: 'heading',
    1: 'track',
  }),
  'afs.verticalMode': lvarEnum('afs.verticalMode', 'MD11_AP_VS_FPA', {
    0: 'vertical-speed',
    1: 'flight-path-angle',
  }),
  'afs.altitudeUnit': lvarEnum('afs.altitudeUnit', 'MD11_AP_FT_M', {
    0: 'feet',
    1: 'metres',
  }),

  'performance.v1': lvarNumber('performance.v1', 'MD11_V1'),
  'performance.vr': lvarNumber('performance.vr', 'MD11_VR'),
  'performance.v2': lvarNumber('performance.v2', 'MD11_V2'),
  'performance.vsr': lvarNumber('performance.vsr', 'MD11_VSR'),
  'performance.vfr': lvarNumber('performance.vfr', 'MD11_VFR'),

  'systems.apuState': lvarEnum('systems.apuState', 'MD11_APU_STATE', {
    0: 'off',
    1: 'starting',
    2: 'running',
    3: 'stopping',
  }),
  'systems.apuN1': lvarNumber('systems.apuN1', 'MD11_APU_N1', 1),
  'systems.apuN2': lvarNumber('systems.apuN2', 'MD11_APU_N2', 1),

  // NAV/BCN/HI INT annunciators illuminate OFF; turnoff annunciators illuminate ON.
  // Flashing bulb-output LVARs cannot confirm a steady switch selection.
  'lights.strobe': lvarBoolean('lights.strobe', 'MD11_OVHD_LTS_HI_INT_LT', [0], [1]),
  'lights.beacon': lvarBoolean('lights.beacon', 'MD11_OVHD_LTS_BCN_LT', [0], [1]),
  'lights.nav': lvarBoolean('lights.nav', 'MD11_OVHD_LTS_NAV_LT', [0], [1]),
  'lights.logo': lvarBoolean('lights.logo', 'MD11_OVHD_LTS_LOGO_ON_LT'),
  'lights.turnoffLeft': lvarBoolean('lights.turnoffLeft', 'MD11_OVHD_LTS_RWY_TURNOFF_L_LT'),
  'lights.turnoffRight': lvarBoolean('lights.turnoffRight', 'MD11_OVHD_LTS_RWY_TURNOFF_R_LT'),
  'lights.landingLeftPosition': lvarNumber('lights.landingLeftPosition', 'MD11_OVHD_LTS_LDG_L_SW'),
  'lights.landingRightPosition': lvarNumber('lights.landingRightPosition', 'MD11_OVHD_LTS_LDG_R_SW'),
  'lights.nosePosition': lvarNumber('lights.nosePosition', 'MD11_OVHD_LTS_NOSE_SW'),

  'systems.busVoltage': field('systems.busVoltage',
    { type: 'lvar', name: 'A:ELECTRICAL MAIN BUS VOLTAGE:1', unit: 'Volts' }, { type: 'number', precision: 1 }),
  'baro.captain.value': lvarNumber('baro.captain.value', 'MD11_CAP_ALTIMETER', 2),
  'baro.firstOfficer.value': lvarNumber('baro.firstOfficer.value', 'MD11_FO_ALTIMETER', 2),
  'cabin.seatBeltsPosition': lvarNumber('cabin.seatBeltsPosition', 'MD11_OVHD_LTS_SEAT_BELTS_SW'),
  'cabin.noSmokingPosition': lvarNumber('cabin.noSmokingPosition', 'MD11_OVHD_LTS_NO_SMOKE_SW'),
  'approach.captain.minimums': lvarNumber('approach.captain.minimums', 'MD11_CAP_MINIMUMS'),
  'approach.firstOfficer.minimums': lvarNumber('approach.firstOfficer.minimums', 'MD11_FO_MINIMUMS'),
  'approach.captain.minimumsMode': lvarEnum('approach.captain.minimumsMode', 'MD11_LECP_MINIMUMS_KB', { 0: 'radio', 1: 'baro' }),
  'approach.firstOfficer.minimumsMode': lvarEnum('approach.firstOfficer.minimumsMode', 'MD11_RECP_MINIMUMS_KB', { 0: 'radio', 1: 'baro' }),

  'controls.flapsPercent': simvarNumber('controls.flapsPercent', 'FLAPS HANDLE PERCENT', 'Percent'),
  'controls.flapAngleDeg': simvarNumber('controls.flapAngleDeg', 'TRAILING EDGE FLAPS LEFT ANGLE', 'Degrees', 1),
  'controls.gearHandleDown': simvarBoolean('controls.gearHandleDown', 'GEAR HANDLE POSITION'),
  'controls.gearNosePct': simvarNumber('controls.gearNosePct', 'GEAR CENTER POSITION', 'Percent'),
  'controls.gearLeftPct': simvarNumber('controls.gearLeftPct', 'GEAR LEFT POSITION', 'Percent'),
  'controls.gearRightPct': simvarNumber('controls.gearRightPct', 'GEAR RIGHT POSITION', 'Percent'),
  'controls.parkingBrake': simvarBoolean('controls.parkingBrake', 'BRAKE PARKING POSITION'),

  'systems.engine1N1': simvarNumber('systems.engine1N1', 'TURB ENG N1:1', 'Percent', 1),
  'systems.engine2N1': simvarNumber('systems.engine2N1', 'TURB ENG N1:2', 'Percent', 1),
  'systems.engine3N1': simvarNumber('systems.engine3N1', 'TURB ENG N1:3', 'Percent', 1),
  'systems.engine1Running': simvarBoolean('systems.engine1Running', 'ENG COMBUSTION:1'),
  'systems.engine2Running': simvarBoolean('systems.engine2Running', 'ENG COMBUSTION:2'),
  'systems.engine3Running': simvarBoolean('systems.engine3Running', 'ENG COMBUSTION:3'),
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
  TFDI_MD_11_FIELDS,
};

export {};
