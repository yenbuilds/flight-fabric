'use strict';

import type {
  AircraftIntegrationDecoder,
  AircraftIntegrationField,
} from '../types.js';

const SDK_ADAPTER_ID = 'clientdata-manifest';

function sdkField(
  id: string,
  path: string,
  decode: AircraftIntegrationDecoder,
): AircraftIntegrationField {
  return {
    id,
    sources: [{
      route: { type: 'sdk', adapter: SDK_ADAPTER_ID, path },
      decode,
    }],
  };
}

function simvarNumberField(
  id: string,
  name: string,
  unit: string,
  precision = 2,
): AircraftIntegrationField {
  return {
    id,
    sources: [{
      route: { type: 'simvar', name, unit },
      decode: { type: 'number', precision },
    }],
  };
}

function booleanField(id: string, path: string): AircraftIntegrationField {
  return sdkField(id, path, {
    type: 'boolean',
    trueValues: [true],
    falseValues: [false],
  });
}

function numberField(id: string, path: string, precision = 0): AircraftIntegrationField {
  return sdkField(id, path, { type: 'number', precision });
}

function enumField(
  id: string,
  path: string,
  values: Readonly<Record<string, string>>,
): AircraftIntegrationField {
  return sdkField(id, path, { type: 'enum', values });
}

const PMDG_737_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'aircraft.model': enumField('aircraft.model', 'aircraft.model', {
    '737-600': '737-600',
    '737-700': '737-700',
    '737-700 BW': '737-700 BW',
    '737-700 SSW': '737-700 SSW',
    '737-800': '737-800',
    '737-800 BW': '737-800 BW',
    '737-800 SSW': '737-800 SSW',
    '737-900': '737-900',
    '737-900 BW': '737-900 BW',
    '737-900 SSW': '737-900 SSW',
    '737-900ER BW': '737-900ER BW',
    '737-900ER SSW': '737-900ER SSW',
    '737-700 BDSF BW': '737-700 BDSF BW',
    '737-700 BDSF SSW': '737-700 BDSF SSW',
    '737-800 BDSF BW': '737-800 BDSF BW',
    '737-800 BDSF SSW': '737-800 BDSF SSW',
    '737-800 BCF BW': '737-800 BCF BW',
    '737-800 BCF SSW': '737-800 BCF SSW',
    '737-700 BBJ BW': '737-700 BBJ BW',
    '737-700 BBJ SSW': '737-700 BBJ SSW',
    '737-800 BBJ BW': '737-800 BBJ BW',
  }),

  'mcp.altitudeFt': numberField('mcp.altitudeFt', 'automation.ap.selected.altitudeFt'),
  'mcp.headingDeg': numberField('mcp.headingDeg', 'automation.ap.selected.headingDeg'),
  'mcp.speed': numberField('mcp.speed', 'automation.ap.selected.iasMach', 2),
  'mcp.verticalSpeedFpm': numberField('mcp.verticalSpeedFpm', 'automation.ap.selected.vsFpm'),
  'mcp.courseCaptainDeg': numberField('mcp.courseCaptainDeg', 'automation.ap.selected.courseLeftDeg'),
  'mcp.courseFirstOfficerDeg': numberField('mcp.courseFirstOfficerDeg', 'automation.ap.selected.courseRightDeg'),

  // PMDG's NG3 ClientData contract does not publish radio frequencies. These
  // standard MSFS readbacks are used only for the PMDG radio UI and for
  // confirming PMDG SDK knob/transfer events.
  'radios.nav1ActiveMhz': simvarNumberField('radios.nav1ActiveMhz', 'NAV ACTIVE FREQUENCY:1', 'MHz'),
  'radios.nav1StandbyMhz': simvarNumberField('radios.nav1StandbyMhz', 'NAV STANDBY FREQUENCY:1', 'MHz'),
  'radios.nav2ActiveMhz': simvarNumberField('radios.nav2ActiveMhz', 'NAV ACTIVE FREQUENCY:2', 'MHz'),
  'radios.nav2StandbyMhz': simvarNumberField('radios.nav2StandbyMhz', 'NAV STANDBY FREQUENCY:2', 'MHz'),

  'afds.apEngaged': booleanField('afds.apEngaged', 'automation.ap.engaged'),
  'afds.autothrottleActive': booleanField('afds.autothrottleActive', 'automation.athr.active'),
  'afds.altitudeHold': booleanField('afds.altitudeHold', 'automation.ap.modes.alt'),
  'afds.approach': booleanField('afds.approach', 'automation.ap.modes.app'),
  'afds.autothrottleArm': booleanField('afds.autothrottleArm', 'automation.athr.armed'),
  'afds.cmdA': booleanField('afds.cmdA', 'automation.ap.leftEngaged'),
  'afds.cmdB': booleanField('afds.cmdB', 'automation.ap.rightEngaged'),
  'afds.cwsA': booleanField('afds.cwsA', 'automation.ap.cwsLeft'),
  'afds.cwsB': booleanField('afds.cwsB', 'automation.ap.cwsRight'),
  'afds.flightDirectorCaptain': booleanField('afds.flightDirectorCaptain', 'automation.ap.flightDirector.left'),
  'afds.flightDirectorFirstOfficer': booleanField('afds.flightDirectorFirstOfficer', 'automation.ap.flightDirector.right'),
  'afds.headingSelect': booleanField('afds.headingSelect', 'automation.ap.modes.hdg'),
  'afds.lnav': booleanField('afds.lnav', 'automation.ap.modes.lnav'),
  'afds.levelChange': booleanField('afds.levelChange', 'automation.ap.modes.flch'),
  'afds.n1': booleanField('afds.n1', 'automation.ap.modes.n1'),
  'afds.speed': booleanField('afds.speed', 'automation.ap.modes.speed'),
  'afds.vnav': booleanField('afds.vnav', 'automation.ap.modes.vnav'),
  'afds.vorLoc': booleanField('afds.vorLoc', 'automation.ap.modes.loc'),
  'afds.verticalSpeed': booleanField('afds.verticalSpeed', 'automation.ap.modes.vs'),

  'lights.landingRetractableLeftMode': enumField(
    'lights.landingRetractableLeftMode',
    'lights.landing.retractableLeft',
    { retract: 'retract', extend: 'extend', on: 'on' },
  ),
  'lights.landingRetractableRightMode': enumField(
    'lights.landingRetractableRightMode',
    'lights.landing.retractableRight',
    { retract: 'retract', extend: 'extend', on: 'on' },
  ),
  'lights.landingLeft': booleanField('lights.landingLeft', 'lights.landing.left'),
  'lights.landingRight': booleanField('lights.landingRight', 'lights.landing.right'),
  'lights.turnoffLeft': booleanField('lights.turnoffLeft', 'lights.turnoff.left'),
  'lights.turnoffRight': booleanField('lights.turnoffRight', 'lights.turnoff.right'),
  'lights.taxi': booleanField('lights.taxi', 'lights.taxi'),
  'lights.logo': booleanField('lights.logo', 'lights.logo'),
  'lights.positionMode': enumField('lights.positionMode', 'lights.position', {
    steady: 'steady', off: 'off', 'strobe-steady': 'strobe-steady',
  }),
  'lights.beacon': booleanField('lights.beacon', 'lights.beacon'),
  'lights.wing': booleanField('lights.wing', 'lights.wing'),
  'lights.wheelWell': booleanField('lights.wheelWell', 'lights.wheelWell'),
  'lights.emergencyMode': enumField('lights.emergencyMode', 'lights.emergency', {
    off: 'off', armed: 'armed', on: 'on',
  }),

  'cabin.noSmokingMode': enumField('cabin.noSmokingMode', 'cabin.signs.noSmoking', {
    off: 'off', auto: 'auto', on: 'on',
  }),
  'cabin.seatBeltsMode': enumField('cabin.seatBeltsMode', 'cabin.signs.seatBelts', {
    off: 'off', auto: 'auto', on: 'on',
  }),
  'visibility.wiperLeftMode': enumField('visibility.wiperLeftMode', 'visibility.wipers.left', {
    off: 'off', intermittent: 'intermittent', low: 'low', high: 'high',
  }),
  'visibility.wiperRightMode': enumField('visibility.wiperRightMode', 'visibility.wipers.right', {
    off: 'off', intermittent: 'intermittent', low: 'low', high: 'high',
  }),

  'systems.wingAntiIce': booleanField('systems.wingAntiIce', 'systems.ice.wing'),
  'systems.engineAntiIceLeft': booleanField('systems.engineAntiIceLeft', 'systems.ice.engineLeft'),
  'systems.engineAntiIceRight': booleanField('systems.engineAntiIceRight', 'systems.ice.engineRight'),
  'systems.packLeftMode': enumField('systems.packLeftMode', 'systems.air.packLeft', {
    off: 'off', auto: 'auto', high: 'high',
  }),
  'systems.packRightMode': enumField('systems.packRightMode', 'systems.air.packRight', {
    off: 'off', auto: 'auto', high: 'high',
  }),
  'systems.engineBleedLeft': booleanField('systems.engineBleedLeft', 'systems.air.engineBleedLeft'),
  'systems.engineBleedRight': booleanField('systems.engineBleedRight', 'systems.air.engineBleedRight'),
  'systems.apuBleed': booleanField('systems.apuBleed', 'systems.air.apuBleed'),
  'systems.irsAligned': booleanField('systems.irsAligned', 'systems.irsAligned'),
  'systems.apuMode': enumField('systems.apuMode', 'systems.apu.selector', {
    off: 'off', on: 'on', start: 'start',
  }),
  'systems.apuEgt': numberField('systems.apuEgt', 'systems.apu.egt', 0),
  'warnings.masterWarning': booleanField('warnings.masterWarning', 'warnings.masterWarning'),
  'warnings.masterCaution': booleanField('warnings.masterCaution', 'warnings.masterCaution'),

  'flightControls.flapNeedleLeft': numberField('flightControls.flapNeedleLeft', 'flaps.needleLeft', 1),
  'flightControls.flapNeedleRight': numberField('flightControls.flapNeedleRight', 'flaps.needleRight', 1),
  'flightControls.leadingEdgeExtended': booleanField('flightControls.leadingEdgeExtended', 'flaps.leadingEdgeExtended'),
  'flightControls.leadingEdgeTransit': booleanField('flightControls.leadingEdgeTransit', 'flaps.leadingEdgeTransit'),
  'flightControls.speedbrakeArmed': booleanField('flightControls.speedbrakeArmed', 'spoilers.armed'),
  'flightControls.speedbrakeDoNotArm': booleanField('flightControls.speedbrakeDoNotArm', 'spoilers.doNotArm'),
  'flightControls.speedbrakeExtended': booleanField('flightControls.speedbrakeExtended', 'spoilers.extended'),
  'flightControls.yawDamper': booleanField('flightControls.yawDamper', 'flightControls.yawDamper'),
  'flightControls.autoSlatFail': booleanField('flightControls.autoSlatFail', 'flightControls.autoSlatFail'),
  'flightControls.stabTrimMainElectricCutout': booleanField(
    'flightControls.stabTrimMainElectricCutout',
    'flightControls.stabTrimMainElectricCutout',
  ),

  'gear.noseUnsafe': booleanField('gear.noseUnsafe', 'gear.noseTransit'),
  'gear.noseSafe': booleanField('gear.noseSafe', 'gear.noseLocked'),
  'gear.leftUnsafe': booleanField('gear.leftUnsafe', 'gear.leftTransit'),
  'gear.rightUnsafe': booleanField('gear.rightUnsafe', 'gear.rightTransit'),
  'gear.leftSafe': booleanField('gear.leftSafe', 'gear.leftLocked'),
  'gear.rightSafe': booleanField('gear.rightSafe', 'gear.rightLocked'),
  'gear.handleMode': enumField('gear.handleMode', 'gear.handle', {
    up: 'up', off: 'off', down: 'down',
  }),
  'gear.autobrakeMode': enumField('gear.autobrakeMode', 'brakes.autobrake', {
    rto: 'rto', off: 'off', 1: '1', 2: '2', 3: '3', max: 'max',
  }),
  'gear.autobrakeDisarm': booleanField('gear.autobrakeDisarm', 'brakes.autobrakeDisarm'),
  'gear.antiSkidInoperative': booleanField('gear.antiSkidInoperative', 'brakes.antiSkidInoperative'),
  'gear.parkingBrake': booleanField('gear.parkingBrake', 'brakes.parking'),
};

module.exports = {
  PMDG_737_FIELDS,
};

export {};
