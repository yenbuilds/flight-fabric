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

const PMDG_777_FIELDS: Readonly<Record<string, AircraftIntegrationField>> = {
  'aircraft.model': enumField('aircraft.model', 'aircraft.model', {
    '777-200': '777-200',
    '777-200ER': '777-200ER',
    '777-300': '777-300',
    '777-200LR': '777-200LR',
    '777F': '777F',
    '777-300ER': '777-300ER',
  }),

  'flightGuidance.apEngaged': booleanField('flightGuidance.apEngaged', 'automation.ap.engaged'),
  'flightGuidance.apLeft': booleanField('flightGuidance.apLeft', 'automation.ap.leftEngaged'),
  'flightGuidance.apRight': booleanField('flightGuidance.apRight', 'automation.ap.rightEngaged'),
  'flightGuidance.fdLeft': booleanField('flightGuidance.fdLeft', 'automation.ap.flightDirector.left'),
  'flightGuidance.fdRight': booleanField('flightGuidance.fdRight', 'automation.ap.flightDirector.right'),
  'flightGuidance.autothrottleActive': booleanField('flightGuidance.autothrottleActive', 'automation.athr.active'),
  'flightGuidance.autothrottleArmed': booleanField('flightGuidance.autothrottleArmed', 'automation.athr.armed'),
  'flightGuidance.autothrottleArmedLeft': booleanField('flightGuidance.autothrottleArmedLeft', 'automation.athr.armedLeft'),
  'flightGuidance.autothrottleArmedRight': booleanField('flightGuidance.autothrottleArmedRight', 'automation.athr.armedRight'),
  'flightGuidance.lnav': booleanField('flightGuidance.lnav', 'automation.ap.modes.lnav'),
  'flightGuidance.vnav': booleanField('flightGuidance.vnav', 'automation.ap.modes.vnav'),
  'flightGuidance.flch': booleanField('flightGuidance.flch', 'automation.ap.modes.flch'),
  'flightGuidance.headingHold': booleanField('flightGuidance.headingHold', 'automation.ap.modes.hdg'),
  'flightGuidance.verticalSpeed': booleanField('flightGuidance.verticalSpeed', 'automation.ap.modes.vs'),
  'flightGuidance.altitudeHold': booleanField('flightGuidance.altitudeHold', 'automation.ap.modes.alt'),
  'flightGuidance.localizer': booleanField('flightGuidance.localizer', 'automation.ap.modes.loc'),
  'flightGuidance.approach': booleanField('flightGuidance.approach', 'automation.ap.modes.app'),
  'flightGuidance.speedKts': numberField('flightGuidance.speedKts', 'automation.ap.selected.speedKts'),
  'flightGuidance.mach': numberField('flightGuidance.mach', 'automation.ap.selected.mach', 3),
  'flightGuidance.headingDeg': numberField('flightGuidance.headingDeg', 'automation.ap.selected.headingDeg'),
  'flightGuidance.altitudeFt': numberField('flightGuidance.altitudeFt', 'automation.ap.selected.altitudeFt'),
  'flightGuidance.vsFpm': numberField('flightGuidance.vsFpm', 'automation.ap.selected.vsFpm'),
  'flightGuidance.fpaDeg': numberField('flightGuidance.fpaDeg', 'automation.ap.selected.fpaDeg', 1),
  'flightGuidance.headingMode': enumField('flightGuidance.headingMode', 'automation.ap.headingMode', { HDG: 'HDG', TRK: 'TRK' }),
  'flightGuidance.verticalMode': enumField('flightGuidance.verticalMode', 'automation.ap.verticalMode', { VS: 'VS', FPA: 'FPA' }),

  'lights.landingLeft': booleanField('lights.landingLeft', 'lights.landing.left'),
  'lights.landingRight': booleanField('lights.landingRight', 'lights.landing.right'),
  'lights.landingNose': booleanField('lights.landingNose', 'lights.landing.nose'),
  'lights.beacon': booleanField('lights.beacon', 'lights.beacon'),
  'lights.nav': booleanField('lights.nav', 'lights.nav'),
  'lights.logo': booleanField('lights.logo', 'lights.logo'),
  'lights.wing': booleanField('lights.wing', 'lights.wing'),
  'lights.turnoffLeft': booleanField('lights.turnoffLeft', 'lights.turnoff.left'),
  'lights.turnoffRight': booleanField('lights.turnoffRight', 'lights.turnoff.right'),
  'lights.taxi': booleanField('lights.taxi', 'lights.taxi'),
  'lights.strobe': booleanField('lights.strobe', 'lights.strobe'),
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

  'systems.adiruOn': booleanField('systems.adiruOn', 'systems.adiru.on'),
  'systems.thrustAsymCompMode': enumField(
    'systems.thrustAsymCompMode',
    'systems.flightControls.thrustAsymComp',
    { disconnect: 'disconnect', auto: 'auto' },
  ),
  'systems.serviceInterphoneOn': booleanField(
    'systems.serviceInterphoneOn',
    'systems.communications.serviceInterphone',
  ),

  'systems.electrical.standbyPowerMode': enumField(
    'systems.electrical.standbyPowerMode',
    'systems.electrical.standbyPower',
    { off: 'off', auto: 'auto', battery: 'battery' },
  ),
  'systems.electrical.cabinUtility': booleanField(
    'systems.electrical.cabinUtility',
    'systems.electrical.cabinUtility',
  ),
  'systems.electrical.ifePassengerSeats': booleanField(
    'systems.electrical.ifePassengerSeats',
    'systems.electrical.ifePassengerSeats',
  ),
  'systems.electrical.batteryOn': booleanField(
    'systems.electrical.batteryOn',
    'systems.electrical.battery',
  ),
  'systems.electrical.apuGeneratorOn': booleanField(
    'systems.electrical.apuGeneratorOn',
    'systems.electrical.apuGenerator',
  ),
  'systems.apuSelectorMode': enumField('systems.apuSelectorMode', 'systems.apu.selector', {
    off: 'off', on: 'on', start: 'start',
  }),
  'systems.electrical.busTieLeftMode': enumField(
    'systems.electrical.busTieLeftMode',
    'systems.electrical.busTieLeft',
    { off: 'off', auto: 'auto' },
  ),
  'systems.electrical.busTieRightMode': enumField(
    'systems.electrical.busTieRightMode',
    'systems.electrical.busTieRight',
    { off: 'off', auto: 'auto' },
  ),
  'systems.electrical.externalPowerPrimaryOn': booleanField(
    'systems.electrical.externalPowerPrimaryOn',
    'systems.electrical.externalPowerPrimary.on',
  ),
  'systems.electrical.externalPowerSecondaryOn': booleanField(
    'systems.electrical.externalPowerSecondaryOn',
    'systems.electrical.externalPowerSecondary.on',
  ),
  'systems.electrical.externalPowerPrimaryAvailable': booleanField(
    'systems.electrical.externalPowerPrimaryAvailable',
    'systems.electrical.externalPowerPrimary.available',
  ),
  'systems.electrical.externalPowerSecondaryAvailable': booleanField(
    'systems.electrical.externalPowerSecondaryAvailable',
    'systems.electrical.externalPowerSecondary.available',
  ),
  'systems.electrical.generatorLeftOn': booleanField(
    'systems.electrical.generatorLeftOn',
    'systems.electrical.generatorLeft',
  ),
  'systems.electrical.generatorRightOn': booleanField(
    'systems.electrical.generatorRightOn',
    'systems.electrical.generatorRight',
  ),
  'systems.electrical.backupGeneratorLeftOn': booleanField(
    'systems.electrical.backupGeneratorLeftOn',
    'systems.electrical.backupGeneratorLeft',
  ),
  'systems.electrical.backupGeneratorRightOn': booleanField(
    'systems.electrical.backupGeneratorRightOn',
    'systems.electrical.backupGeneratorRight',
  ),

  'systems.ice.windowHeatLeftSide': booleanField(
    'systems.ice.windowHeatLeftSide',
    'systems.ice.windowHeat.leftSide',
  ),
  'systems.ice.windowHeatLeftForward': booleanField(
    'systems.ice.windowHeatLeftForward',
    'systems.ice.windowHeat.leftForward',
  ),
  'systems.ice.windowHeatRightForward': booleanField(
    'systems.ice.windowHeatRightForward',
    'systems.ice.windowHeat.rightForward',
  ),
  'systems.ice.windowHeatRightSide': booleanField(
    'systems.ice.windowHeatRightSide',
    'systems.ice.windowHeat.rightSide',
  ),

  'systems.hydraulics.enginePumpLeftOn': booleanField(
    'systems.hydraulics.enginePumpLeftOn',
    'systems.hydraulics.enginePumpLeft',
  ),
  'systems.hydraulics.enginePumpRightOn': booleanField(
    'systems.hydraulics.enginePumpRightOn',
    'systems.hydraulics.enginePumpRight',
  ),
  'systems.hydraulics.electricPumpLeftOn': booleanField(
    'systems.hydraulics.electricPumpLeftOn',
    'systems.hydraulics.electricPumpLeft',
  ),
  'systems.hydraulics.electricPumpRightOn': booleanField(
    'systems.hydraulics.electricPumpRightOn',
    'systems.hydraulics.electricPumpRight',
  ),
  'systems.hydraulics.demandElectricLeftMode': enumField(
    'systems.hydraulics.demandElectricLeftMode',
    'systems.hydraulics.demandElectricLeft',
    { off: 'off', auto: 'auto', on: 'on' },
  ),
  'systems.hydraulics.demandElectricRightMode': enumField(
    'systems.hydraulics.demandElectricRightMode',
    'systems.hydraulics.demandElectricRight',
    { off: 'off', auto: 'auto', on: 'on' },
  ),
  'systems.hydraulics.demandAirLeftMode': enumField(
    'systems.hydraulics.demandAirLeftMode',
    'systems.hydraulics.demandAirLeft',
    { off: 'off', auto: 'auto', on: 'on' },
  ),
  'systems.hydraulics.demandAirRightMode': enumField(
    'systems.hydraulics.demandAirRightMode',
    'systems.hydraulics.demandAirRight',
    { off: 'off', auto: 'auto', on: 'on' },
  ),

  'systems.fuel.crossfeedForwardOn': booleanField(
    'systems.fuel.crossfeedForwardOn',
    'systems.fuel.crossfeedForward',
  ),
  'systems.fuel.crossfeedAftOn': booleanField(
    'systems.fuel.crossfeedAftOn',
    'systems.fuel.crossfeedAft',
  ),
  'systems.fuel.pumpForwardLeftOn': booleanField(
    'systems.fuel.pumpForwardLeftOn',
    'systems.fuel.pumpForwardLeft',
  ),
  'systems.fuel.pumpForwardRightOn': booleanField(
    'systems.fuel.pumpForwardRightOn',
    'systems.fuel.pumpForwardRight',
  ),
  'systems.fuel.pumpAftLeftOn': booleanField(
    'systems.fuel.pumpAftLeftOn',
    'systems.fuel.pumpAftLeft',
  ),
  'systems.fuel.pumpAftRightOn': booleanField(
    'systems.fuel.pumpAftRightOn',
    'systems.fuel.pumpAftRight',
  ),
  'systems.fuel.pumpCenterLeftOn': booleanField(
    'systems.fuel.pumpCenterLeftOn',
    'systems.fuel.pumpCenterLeft',
  ),
  'systems.fuel.pumpCenterRightOn': booleanField(
    'systems.fuel.pumpCenterRightOn',
    'systems.fuel.pumpCenterRight',
  ),

  'systems.wingAntiIce': enumField('systems.wingAntiIce', 'systems.ice.wing', {
    off: 'off', auto: 'auto', on: 'on',
  }),
  'systems.engineAntiIceLeft': enumField('systems.engineAntiIceLeft', 'systems.ice.engineLeft', {
    off: 'off', auto: 'auto', on: 'on',
  }),
  'systems.engineAntiIceRight': enumField('systems.engineAntiIceRight', 'systems.ice.engineRight', {
    off: 'off', auto: 'auto', on: 'on',
  }),
  'systems.packLeft': enumField('systems.packLeft', 'systems.air.packLeft', {
    false: 'off', true: 'auto',
  }),
  'systems.packRight': enumField('systems.packRight', 'systems.air.packRight', {
    false: 'off', true: 'auto',
  }),
  'systems.engineBleedLeft': enumField('systems.engineBleedLeft', 'systems.air.engineBleedLeft', {
    false: 'off', true: 'auto',
  }),
  'systems.engineBleedRight': enumField('systems.engineBleedRight', 'systems.air.engineBleedRight', {
    false: 'off', true: 'auto',
  }),
  'systems.apuBleed': enumField('systems.apuBleed', 'systems.air.apuBleed', {
    false: 'off', true: 'auto',
  }),
  'systems.air.trimAirLeftOn': booleanField(
    'systems.air.trimAirLeftOn',
    'systems.air.trimAirLeft',
  ),
  'systems.air.trimAirRightOn': booleanField(
    'systems.air.trimAirRightOn',
    'systems.air.trimAirRight',
  ),
  'systems.air.recircUpperOn': booleanField(
    'systems.air.recircUpperOn',
    'systems.air.recircUpper',
  ),
  'systems.air.recircLowerOn': booleanField(
    'systems.air.recircLowerOn',
    'systems.air.recircLower',
  ),
  'systems.air.equipmentCoolingMode': enumField(
    'systems.air.equipmentCoolingMode',
    'systems.air.equipmentCooling',
    { override: 'override', auto: 'auto' },
  ),
  'systems.air.gasperOn': booleanField('systems.air.gasperOn', 'systems.air.gasper'),
  'systems.air.outflowForwardMode': enumField(
    'systems.air.outflowForwardMode',
    'systems.air.outflowForward',
    { manual: 'manual', auto: 'auto' },
  ),
  'systems.air.outflowAftMode': enumField(
    'systems.air.outflowAftMode',
    'systems.air.outflowAft',
    { manual: 'manual', auto: 'auto' },
  ),
  'systems.air.mainDeckFlowMode': enumField(
    'systems.air.mainDeckFlowMode',
    'systems.air.mainDeckFlow',
    { high: 'high', normal: 'normal' },
  ),
  'comfort.flightDeckTemperaturePosition': numberField(
    'comfort.flightDeckTemperaturePosition',
    'comfort.temperature.flightDeck',
  ),
  'comfort.cabinTemperaturePosition': numberField(
    'comfort.cabinTemperaturePosition',
    'comfort.temperature.cabin',
  ),
  'comfort.leftShoulderHeatPercent': numberField(
    'comfort.leftShoulderHeatPercent',
    'comfort.shoulderHeat.left',
  ),
  'comfort.rightShoulderHeatPercent': numberField(
    'comfort.rightShoulderHeatPercent',
    'comfort.shoulderHeat.right',
  ),
  'comfort.leftFootHeatMode': enumField(
    'comfort.leftFootHeatMode',
    'comfort.footHeat.left',
    { off: 'off', low: 'low', high: 'high' },
  ),
  'comfort.rightFootHeatMode': enumField(
    'comfort.rightFootHeatMode',
    'comfort.footHeat.right',
    { off: 'off', low: 'low', high: 'high' },
  ),

  'systems.engine.eecLeftMode': enumField(
    'systems.engine.eecLeftMode',
    'systems.engine.eecLeft',
    { alternate: 'alternate', normal: 'normal' },
  ),
  'systems.engine.eecRightMode': enumField(
    'systems.engine.eecRightMode',
    'systems.engine.eecRight',
    { alternate: 'alternate', normal: 'normal' },
  ),
  'systems.engine.startLeftMode': enumField(
    'systems.engine.startLeftMode',
    'systems.engine.startLeft',
    { start: 'start', normal: 'normal' },
  ),
  'systems.engine.startRightMode': enumField(
    'systems.engine.startRightMode',
    'systems.engine.startRight',
    { start: 'start', normal: 'normal' },
  ),
  'systems.engine.autostartOn': booleanField(
    'systems.engine.autostartOn',
    'systems.engine.autostart',
  ),
  'systems.engine.fuelControlLeftMode': enumField(
    'systems.engine.fuelControlLeftMode',
    'systems.engine.fuelControlLeft',
    { cutoff: 'cutoff', run: 'run' },
  ),
  'systems.engine.fuelControlRightMode': enumField(
    'systems.engine.fuelControlRightMode',
    'systems.engine.fuelControlRight',
    { cutoff: 'cutoff', run: 'run' },
  ),

  'flightGuidance.bankLimitMode': enumField(
    'flightGuidance.bankLimitMode',
    'automation.ap.bankLimit',
    { auto: 'auto', 5: '5', 10: '10', 15: '15', 20: '20', 25: '25' },
  ),
  'flightGuidance.altitudeIncrementMode': enumField(
    'flightGuidance.altitudeIncrementMode',
    'automation.ap.altitudeIncrement',
    { auto: 'auto', 1000: '1000' },
  ),

  'displays.inboardLeftMode': enumField('displays.inboardLeftMode', 'displays.inboard.left', {
    nd: 'nd', nav: 'nav', mfd: 'mfd', eicas: 'eicas',
  }),
  'displays.inboardRightMode': enumField('displays.inboardRightMode', 'displays.inboard.right', {
    eicas: 'eicas', mfd: 'mfd', nd: 'nd', pfd: 'pfd',
  }),
  'displays.fmcSourceMode': enumField('displays.fmcSourceMode', 'displays.fmcSource', {
    left: 'left', auto: 'auto', right: 'right',
  }),

  'efis.captain.minimumsMode': enumField(
    'efis.captain.minimumsMode',
    'efis.captain.minimumsMode',
    { radio: 'radio', baro: 'baro' },
  ),
  'efis.captain.baroUnitsMode': enumField(
    'efis.captain.baroUnitsMode',
    'efis.captain.baroUnits',
    { inhg: 'inhg', hpa: 'hpa' },
  ),
  'efis.captain.bearingLeftMode': enumField(
    'efis.captain.bearingLeftMode',
    'efis.captain.bearingLeft',
    { vor: 'vor', off: 'off', adf: 'adf' },
  ),
  'efis.captain.bearingRightMode': enumField(
    'efis.captain.bearingRightMode',
    'efis.captain.bearingRight',
    { vor: 'vor', off: 'off', adf: 'adf' },
  ),
  'efis.captain.mapMode': enumField('efis.captain.mapMode', 'efis.captain.mapMode', {
    approach: 'approach', vor: 'vor', map: 'map', plan: 'plan',
  }),
  'efis.captain.rangeNm': enumField('efis.captain.rangeNm', 'efis.captain.rangeNm', {
    10: '10', 20: '20', 40: '40', 80: '80', 160: '160', 320: '320', 640: '640',
  }),
  'efis.firstOfficer.minimumsMode': enumField(
    'efis.firstOfficer.minimumsMode',
    'efis.firstOfficer.minimumsMode',
    { radio: 'radio', baro: 'baro' },
  ),
  'efis.firstOfficer.baroUnitsMode': enumField(
    'efis.firstOfficer.baroUnitsMode',
    'efis.firstOfficer.baroUnits',
    { inhg: 'inhg', hpa: 'hpa' },
  ),
  'efis.firstOfficer.bearingLeftMode': enumField(
    'efis.firstOfficer.bearingLeftMode',
    'efis.firstOfficer.bearingLeft',
    { vor: 'vor', off: 'off', adf: 'adf' },
  ),
  'efis.firstOfficer.bearingRightMode': enumField(
    'efis.firstOfficer.bearingRightMode',
    'efis.firstOfficer.bearingRight',
    { vor: 'vor', off: 'off', adf: 'adf' },
  ),
  'efis.firstOfficer.mapMode': enumField(
    'efis.firstOfficer.mapMode',
    'efis.firstOfficer.mapMode',
    { approach: 'approach', vor: 'vor', map: 'map', plan: 'plan' },
  ),
  'efis.firstOfficer.rangeNm': enumField(
    'efis.firstOfficer.rangeNm',
    'efis.firstOfficer.rangeNm',
    { 10: '10', 20: '20', 40: '40', 80: '80', 160: '160', 320: '320', 640: '640' },
  ),

  'chronometer.captain.timeDateMode': enumField(
    'chronometer.captain.timeDateMode',
    'chronometer.captain.timeDate',
    { utc: 'utc', manual: 'manual' },
  ),
  'chronometer.captain.setMode': enumField(
    'chronometer.captain.setMode',
    'chronometer.captain.set',
    { run: 'run', 'hold-year': 'hold-year', minutes: 'minutes', 'hours-date': 'hours-date' },
  ),
  'chronometer.captain.elapsedMode': enumField(
    'chronometer.captain.elapsedMode',
    'chronometer.captain.elapsed',
    { reset: 'reset', hold: 'hold', run: 'run' },
  ),
  'chronometer.firstOfficer.timeDateMode': enumField(
    'chronometer.firstOfficer.timeDateMode',
    'chronometer.firstOfficer.timeDate',
    { utc: 'utc', manual: 'manual' },
  ),
  'chronometer.firstOfficer.setMode': enumField(
    'chronometer.firstOfficer.setMode',
    'chronometer.firstOfficer.set',
    { run: 'run', 'hold-year': 'hold-year', minutes: 'minutes', 'hours-date': 'hours-date' },
  ),
  'chronometer.firstOfficer.elapsedMode': enumField(
    'chronometer.firstOfficer.elapsedMode',
    'chronometer.firstOfficer.elapsed',
    { reset: 'reset', hold: 'hold', run: 'run' },
  ),

  'transponder.sourceMode': enumField('transponder.sourceMode', 'transponder.source', {
    left: 'left', right: 'right',
  }),
  'transponder.altitudeSourceMode': enumField(
    'transponder.altitudeSourceMode',
    'transponder.altitudeSource',
    { normal: 'normal', alternate: 'alternate' },
  ),
  'transponder.mode': enumField('transponder.mode', 'transponder.mode', {
    standby: 'standby',
    'altitude-off': 'altitude-off',
    transponder: 'transponder',
    'ta-only': 'ta-only',
    'ta-ra': 'ta-ra',
  }),

  'lights.storm': booleanField('lights.storm', 'lights.storm'),
  'lighting.masterBrightOn': booleanField('lighting.masterBrightOn', 'lighting.masterBright.on'),
  'lighting.indicatorLightsMode': enumField(
    'lighting.indicatorLightsMode',
    'lighting.indicatorLights',
    { test: 'test', bright: 'bright', dim: 'dim' },
  ),
  'lighting.floorMode': enumField('lighting.floorMode', 'lighting.floor', {
    bright: 'bright', off: 'off', dim: 'dim',
  }),
  'lighting.domePercent': numberField('lighting.domePercent', 'lighting.domePercent'),
  'lighting.circuitBreakerPercent': numberField(
    'lighting.circuitBreakerPercent',
    'lighting.circuitBreakerPercent',
  ),
  'lighting.overheadPanelPercent': numberField(
    'lighting.overheadPanelPercent',
    'lighting.overheadPanelPercent',
  ),
  'lighting.glareshieldPanelPercent': numberField(
    'lighting.glareshieldPanelPercent',
    'lighting.glareshieldPanelPercent',
  ),
  'lighting.glareshieldFloodPercent': numberField(
    'lighting.glareshieldFloodPercent',
    'lighting.glareshieldFloodPercent',
  ),
  'lighting.masterBrightnessPercent': numberField(
    'lighting.masterBrightnessPercent',
    'lighting.masterBrightnessPercent',
  ),
  'lighting.leftPanelPercent': numberField('lighting.leftPanelPercent', 'lighting.leftPanelPercent'),
  'lighting.leftFloodPercent': numberField('lighting.leftFloodPercent', 'lighting.leftFloodPercent'),
  'lighting.leftOutboardDisplayPercent': numberField(
    'lighting.leftOutboardDisplayPercent',
    'lighting.leftOutboardDisplayPercent',
  ),
  'lighting.leftInboardDisplayPercent': numberField(
    'lighting.leftInboardDisplayPercent',
    'lighting.leftInboardDisplayPercent',
  ),
  'lighting.rightPanelPercent': numberField(
    'lighting.rightPanelPercent',
    'lighting.rightPanelPercent',
  ),
  'lighting.rightFloodPercent': numberField(
    'lighting.rightFloodPercent',
    'lighting.rightFloodPercent',
  ),
  'lighting.rightInboardDisplayPercent': numberField(
    'lighting.rightInboardDisplayPercent',
    'lighting.rightInboardDisplayPercent',
  ),
  'lighting.rightOutboardDisplayPercent': numberField(
    'lighting.rightOutboardDisplayPercent',
    'lighting.rightOutboardDisplayPercent',
  ),
  'lighting.upperDisplayPercent': numberField(
    'lighting.upperDisplayPercent',
    'lighting.upperDisplayPercent',
  ),
  'lighting.lowerDisplayPercent': numberField(
    'lighting.lowerDisplayPercent',
    'lighting.lowerDisplayPercent',
  ),
  'lighting.aislePanelPercent': numberField(
    'lighting.aislePanelPercent',
    'lighting.aislePanelPercent',
  ),
  'lighting.aisleFloodPercent': numberField(
    'lighting.aisleFloodPercent',
    'lighting.aisleFloodPercent',
  ),

  'systems.irsAligned': booleanField('systems.irsAligned', 'systems.irsAligned'),
  'systems.apuRunning': booleanField('systems.apuRunning', 'systems.apuRunning'),
  'warnings.masterWarning': booleanField('warnings.masterWarning', 'warnings.masterWarning'),
  'warnings.masterCaution': booleanField('warnings.masterCaution', 'warnings.masterCaution'),
  'controls.gearDown': booleanField('controls.gearDown', 'gear.down'),
  'controls.parkingBrake': booleanField('controls.parkingBrake', 'brakes.parking'),
  'controls.autobrakeMode': enumField('controls.autobrakeMode', 'brakes.autobrake', {
    rto: 'rto', off: 'off', disarm: 'disarm', 1: '1', 2: '2', max: 'max',
  }),
  'controls.speedbrakePercent': numberField('controls.speedbrakePercent', 'spoilers.handlePercent'),
  'controls.speedbrakeState': enumField('controls.speedbrakeState', 'spoilers.state', {
    stowed: 'stowed', armed: 'armed', extended: 'extended',
  }),
  'controls.flapsLabel': enumField('controls.flapsLabel', 'flaps.label', {
    UP: 'UP', 1: '1', 5: '5', 15: '15', 20: '20', 25: '25', 30: '30',
  }),
};

module.exports = {
  PMDG_777_FIELDS,
};

export {};
