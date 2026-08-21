<script setup>
import { computed } from 'vue';
import { useAircraftControlsStore } from '../../../stores/aircraft-controls.js';
import AircraftSectionRibbon from '../AircraftSectionRibbon.vue';
import FlyByWireThrottleControl from './FlyByWireThrottleControl.vue';

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  sourceStatuses: { type: Object, default: () => ({}) },
  actionCapabilities: { type: Object, default: () => ({}) },
  requestAction: { type: Function, default: () => false },
  isActionPending: { type: Function, default: () => false },
  controlSetupRequired: { type: Boolean, default: false },
});

const aircraftControls = useAircraftControlsStore();
const unavailableFields = computed(() => new Set(props.unavailable));
const controlSessionReady = computed(() => (
  props.sourceStatus === 'connected'
  && aircraftControls.availability.enabled === true
));

const mobileSections = Object.freeze([
  Object.freeze({ id: 'throttle', label: 'Throttle', title: 'Virtual Throttle' }),
  Object.freeze({ id: 'fcu', label: 'FCU', title: 'Flight Control Unit' }),
  Object.freeze({ id: 'flight-guidance', label: 'Guidance', title: 'Flight Guidance & EFIS' }),
  Object.freeze({ id: 'lights-signs', label: 'Lights', title: 'Exterior Lights & Signs' }),
  Object.freeze({ id: 'electrical-apu', label: 'Electrical', title: 'Electrical & APU' }),
  Object.freeze({ id: 'air-ice', label: 'Air / Ice', title: 'Pneumatic, Air Conditioning & Anti-Ice' }),
  Object.freeze({ id: 'adirs-navigation', label: 'ADIRS', title: 'ADIRS & Navigation' }),
  Object.freeze({ id: 'ground-engines', label: 'Engines', title: 'Ground & Engine Controls' }),
  Object.freeze({ id: 'surveillance', label: 'Radio', title: 'Radio & Surveillance' }),
  Object.freeze({ id: 'switching-displays', label: 'Displays', title: 'Switching & Displays' }),
  Object.freeze({ id: 'light-readback', label: 'Readback', title: 'Exterior Light Readback' }),
  Object.freeze({ id: 'status', label: 'Status', title: 'Aircraft System Status' }),
]);

const guidanceModes = [
  { id: 'flightGuidance.ap1', label: 'AP 1' },
  { id: 'flightGuidance.ap2', label: 'AP 2' },
  { id: 'flightGuidance.autothrust', label: 'A/THR' },
  { id: 'flightGuidance.localizer', label: 'LOC' },
  { id: 'flightGuidance.approach', label: 'APPR' },
  { id: 'flightGuidance.expedite', label: 'EXPED' },
  { id: 'flightGuidance.speedManaged', label: 'SPD MANAGED' },
  { id: 'flightGuidance.headingManaged', label: 'HDG MANAGED' },
  { id: 'flightGuidance.altitudeManaged', label: 'ALT MANAGED' },
];

function toggleControl(title, fieldId, prefix, labels = ['OFF', 'ON'], suffixes = ['off', 'on']) {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: [
      { id: `${prefix}.${suffixes[0]}`, label: labels[0], value: false },
      { id: `${prefix}.${suffixes[1]}`, label: labels[1], value: true },
    ],
  };
}

function detentControl(title, fieldId, prefix, positions) {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: positions.map(([suffix, label, actionValue]) => ({
      id: `${prefix}.${suffix}`,
      label,
      value: actionValue,
    })),
  };
}

function singleActionControl(title, fieldId, actionId, label, actionValue) {
  return {
    title,
    fieldId,
    groupId: fieldId,
    actions: [{ id: actionId, label, value: actionValue }],
  };
}

const controlSections = [
  {
    id: 'flight-guidance',
    title: 'Flight Guidance & EFIS',
    controls: [
      toggleControl('AUTOPILOT 1', 'flightGuidance.ap1', 'flightGuidance.ap1', ['DISCONNECT', 'ENGAGE']),
      toggleControl('AUTOTHRUST', 'flightGuidance.autothrust', 'flightGuidance.autothrust', ['DISCONNECT', 'ARM']),
      toggleControl('FD CAPT', 'flightGuidance.flightDirectorCaptain', 'flightGuidance.flightDirectorCaptain'),
      toggleControl('LOCALIZER', 'flightGuidance.localizer', 'flightGuidance.localizer'),
      toggleControl('APPROACH', 'flightGuidance.approach', 'flightGuidance.approach'),
      toggleControl('EXPEDITE', 'flightGuidance.expedite', 'flightGuidance.expedite'),
      toggleControl('SPD / MACH', 'flightGuidance.machMode', 'flightGuidance.machMode', ['SPD', 'MACH']),
      toggleControl('HDG/VS · TRK/FPA', 'flightGuidance.trkFpaMode', 'flightGuidance.trkFpaMode', ['HDG / VS', 'TRK / FPA']),
      detentControl('ALT STEP', 'flightGuidance.altitudeIncrementMode', 'flightGuidance.altitudeIncrement', [
        ['hundred', '100', 'hundred'],
        ['thousand', '1000', 'thousand'],
      ]),
      toggleControl(
        'BARO UNIT CAPT',
        'flightGuidance.baroUnitCaptain',
        'flightGuidance.baroUnitCaptain',
        ['hPa', 'inHg'],
        ['hpa', 'inhg'],
      ),
      toggleControl(
        'BARO UNIT F/O',
        'flightGuidance.baroUnitFirstOfficer',
        'flightGuidance.baroUnitFirstOfficer',
        ['hPa', 'inHg'],
        ['hpa', 'inhg'],
      ),
    ],
  },
  {
    id: 'lights-signs',
    title: 'Exterior Lights & Signs',
    note: 'Landing lights take about 9 seconds to extend before they illuminate.',
    controls: [
      detentControl('STROBE', 'lights.strobeMode', 'lights.strobe', [
        ['off', 'OFF', 'off'],
        ['auto', 'AUTO', 'auto'],
        ['on', 'ON', 'on'],
      ]),
      toggleControl('BEACON', 'lights.beacon', 'lights.beacon'),
      toggleControl('WING', 'lights.wing', 'lights.wing'),
      toggleControl('RWY TURNOFF', 'lights.runwayTurnoff', 'lights.runwayTurnoff'),
      detentControl('NOSE', 'lights.noseMode', 'lights.nose', [
        ['off', 'OFF', 'off'],
        ['taxi', 'TAXI', 'taxi'],
        ['takeoff', 'T.O.', 'takeoff'],
      ]),
      detentControl('LANDING LEFT', 'lights.landingLeftMode', 'lights.landingLeft', [
        ['retract', 'RETRACT', 'retract'],
        ['off', 'OFF', 'off'],
        ['on', 'ON', 'on'],
      ]),
      detentControl('LANDING RIGHT', 'lights.landingRightMode', 'lights.landingRight', [
        ['retract', 'RETRACT', 'retract'],
        ['off', 'OFF', 'off'],
        ['on', 'ON', 'on'],
      ]),
      toggleControl('NAV', 'lights.nav', 'lights.nav'),
      toggleControl('LOGO', 'lights.logo', 'lights.logo'),
      toggleControl('SEAT BELTS', 'cabin.seatBelts', 'cabin.seatBelts'),
      detentControl('NO SMOKING', 'cabin.noSmokingMode', 'cabin.noSmoking', [
        ['off', 'OFF', 'off'],
        ['auto', 'AUTO', 'auto'],
        ['on', 'ON', 'on'],
      ]),
      detentControl('EMER EXIT LT', 'cabin.emergencyExitMode', 'cabin.emergencyExit', [
        ['off', 'OFF', 'off'],
        ['auto', 'ARM', 'auto'],
        ['on', 'ON', 'on'],
      ]),
    ],
  },
  {
    id: 'electrical-apu',
    title: 'Electrical & APU',
    controls: [
      toggleControl('BATTERY 1', 'systems.battery1', 'systems.battery1', ['OFF', 'AUTO'], ['off', 'auto']),
      toggleControl('BATTERY 2', 'systems.battery2', 'systems.battery2', ['OFF', 'AUTO'], ['off', 'auto']),
      toggleControl('EXTERNAL POWER', 'systems.externalPower', 'systems.externalPower'),
      toggleControl('BUS TIE', 'systems.busTie', 'systems.busTie', ['OFF', 'AUTO'], ['off', 'auto']),
      toggleControl('AC ESS FEED', 'systems.acEssFeed', 'systems.acEssFeed', ['ALTN', 'NORM'], ['alternate', 'normal']),
      toggleControl('GALLEY & CAB', 'systems.galleyAndCabin', 'systems.galleyAndCabin', ['OFF', 'AUTO'], ['off', 'auto']),
      toggleControl('COMMERCIAL', 'systems.commercial', 'systems.commercial', ['OFF', 'AUTO'], ['off', 'auto']),
      toggleControl('APU MASTER', 'systems.apuMaster', 'systems.apuMaster'),
      toggleControl('APU START', 'systems.apuStart', 'systems.apuStart', ['RESET', 'START'], ['off', 'start']),
    ],
  },
  {
    id: 'air-ice',
    title: 'Pneumatic, Air Conditioning & Anti-Ice',
    controls: [
      toggleControl('APU BLEED', 'systems.apuBleed', 'systems.apuBleed'),
      toggleControl('ENG 1 BLEED', 'systems.engineBleed1', 'systems.engineBleed1'),
      toggleControl('ENG 2 BLEED', 'systems.engineBleed2', 'systems.engineBleed2'),
      detentControl('CROSS BLEED', 'systems.crossBleedMode', 'systems.crossBleed', [
        ['closed', 'SHUT', 'closed'],
        ['auto', 'AUTO', 'auto'],
        ['open', 'OPEN', 'open'],
      ]),
      toggleControl('PACK 1', 'systems.pack1', 'systems.pack1'),
      toggleControl('PACK 2', 'systems.pack2', 'systems.pack2'),
      detentControl('PACK FLOW', 'systems.packFlowMode', 'systems.packFlow', [
        ['low', 'LO', 'low'],
        ['normal', 'NORM', 'normal'],
        ['high', 'HI', 'high'],
      ]),
      toggleControl('HOT AIR', 'systems.hotAir', 'systems.hotAir'),
      toggleControl('RAM AIR', 'systems.ramAir', 'systems.ramAir'),
      toggleControl('ENG 1 ANTI-ICE', 'systems.engineAntiIce1', 'systems.engineAntiIce1'),
      toggleControl('ENG 2 ANTI-ICE', 'systems.engineAntiIce2', 'systems.engineAntiIce2'),
      toggleControl('WING ANTI-ICE', 'systems.wingAntiIce', 'systems.wingAntiIce'),
      toggleControl('PROBE/WINDOW HEAT', 'systems.probeWindowHeat', 'systems.probeWindowHeat', ['AUTO', 'ON'], ['auto', 'on']),
    ],
  },
  {
    id: 'adirs-navigation',
    title: 'ADIRS & Navigation Display',
    controls: [
      ...[
        ['IR 1', 'systems.ir1Mode', 'systems.ir1'],
        ['IR 2', 'systems.ir2Mode', 'systems.ir2'],
        ['IR 3', 'systems.ir3Mode', 'systems.ir3'],
      ].map(([title, fieldId, prefix]) => detentControl(title, fieldId, prefix, [
        ['off', 'OFF', 'off'],
        ['nav', 'NAV', 'nav'],
        ['att', 'ATT', 'att'],
      ])),
      toggleControl('ADR 1', 'systems.adr1', 'systems.adr1'),
      toggleControl('ADR 2', 'systems.adr2', 'systems.adr2'),
      toggleControl('ADR 3', 'systems.adr3', 'systems.adr3'),
      ...[
        ['ND MODE CAPT', 'navigation.ndCaptainMode', 'navigation.ndCaptainMode'],
        ['ND MODE F/O', 'navigation.ndFirstOfficerMode', 'navigation.ndFirstOfficerMode'],
      ].map(([title, fieldId, prefix]) => detentControl(title, fieldId, prefix, [
        ['roseIls', 'ILS', 'roseIls'],
        ['roseVor', 'VOR', 'roseVor'],
        ['roseNav', 'NAV', 'roseNav'],
        ['arc', 'ARC', 'arc'],
        ['plan', 'PLAN', 'plan'],
      ])),
      ...[
        ['ND RANGE CAPT', 'navigation.ndCaptainRange', 'navigation.ndCaptainRange'],
        ['ND RANGE F/O', 'navigation.ndFirstOfficerRange', 'navigation.ndFirstOfficerRange'],
      ].map(([title, fieldId, prefix]) => detentControl(title, fieldId, prefix, [
        ['nm10', '10', '10'],
        ['nm20', '20', '20'],
        ['nm40', '40', '40'],
        ['nm80', '80', '80'],
        ['nm160', '160', '160'],
        ['nm320', '320', '320'],
      ])),
      ...[
        ['NAVAID CAPT 1', 'navigation.navaidCaptain1', 'navigation.navaidCaptain1'],
        ['NAVAID CAPT 2', 'navigation.navaidCaptain2', 'navigation.navaidCaptain2'],
        ['NAVAID F/O 1', 'navigation.navaidFirstOfficer1', 'navigation.navaidFirstOfficer1'],
        ['NAVAID F/O 2', 'navigation.navaidFirstOfficer2', 'navigation.navaidFirstOfficer2'],
      ].map(([title, fieldId, prefix]) => detentControl(title, fieldId, prefix, [
        ['off', 'OFF', 'off'],
        ['adf', 'ADF', 'adf'],
        ['vor', 'VOR', 'vor'],
      ])),
      toggleControl('TERRAIN CAPT', 'navigation.terrainCaptain', 'navigation.terrainCaptain'),
      toggleControl('TERRAIN F/O', 'navigation.terrainFirstOfficer', 'navigation.terrainFirstOfficer'),
    ],
  },
  {
    id: 'ground-engines',
    title: 'Brakes, Spoilers, Engines & Door',
    controls: [
      toggleControl('PARKING BRAKE', 'systems.parkingBrake', 'systems.parkingBrake', ['RELEASE', 'SET'], ['released', 'set']),
      detentControl('AUTOBRAKE', 'systems.autobrakeMode', 'systems.autobrake', [
        ['disarm', 'DISARM', 'disarmed'],
        ['low', 'LO', 'low'],
        ['medium', 'MED', 'medium'],
        ['max', 'MAX', 'max'],
      ]),
      toggleControl('BRAKE FAN', 'systems.brakeFan', 'systems.brakeFan'),
      toggleControl('GROUND SPOILERS', 'controls.spoilersArmed', 'controls.spoilersArmed', ['DISARM', 'ARM']),
      detentControl('SPEED BRAKE', 'controls.spoilersHandle', 'controls.spoilers', [
        ['retracted', '0', 0],
        ['quarter', '25', 0.25],
        ['half', '50', 0.5],
        ['threeQuarter', '75', 0.75],
        ['full', '100', 1],
      ]),
      toggleControl('ENG MASTER 1', 'controls.engineMaster1', 'controls.engineMaster1', ['OFF', 'ON']),
      toggleControl('ENG MASTER 2', 'controls.engineMaster2', 'controls.engineMaster2', ['OFF', 'ON']),
      detentControl('ENG MODE', 'controls.engineMode', 'controls.engineMode', [
        ['crank', 'CRANK', 'crank'],
        ['normal', 'NORM', 'normal'],
        ['ignition', 'IGN/START', 'ignition'],
      ]),
      toggleControl(
        'COCKPIT DOOR',
        'controls.cockpitDoorLocked',
        'controls.cockpitDoorLocked',
        ['UNLOCK', 'LOCK'],
        ['unlocked', 'locked'],
      ),
    ],
  },
  {
    id: 'surveillance',
    title: 'Weather Radar, ATC/TCAS & Radio Panels',
    controls: [
      detentControl('WX RADAR SYS', 'surveillance.weatherRadarSystem', 'surveillance.weatherRadarSystem', [
        ['system1', 'SYS 1', 'system1'],
        ['off', 'OFF', 'off'],
        ['system2', 'SYS 2', 'system2'],
      ]),
      toggleControl('PREDICTIVE WINDSHEAR', 'surveillance.weatherRadarPws', 'surveillance.weatherRadarPws', ['OFF', 'AUTO'], ['off', 'auto']),
      detentControl('WX RADAR MODE', 'surveillance.weatherRadarMode', 'surveillance.weatherRadarMode', [
        ['weather', 'WX', 'weather'],
        ['weatherTerrain', 'WX+T', 'weatherTerrain'],
        ['turbulence', 'TURB', 'turbulence'],
        ['map', 'MAP', 'map'],
      ]),
      detentControl('ATC MODE', 'surveillance.transponderMode', 'surveillance.transponderMode', [
        ['standby', 'STBY', 'standby'],
        ['auto', 'AUTO', 'auto'],
        ['on', 'ON', 'on'],
      ]),
      detentControl('ATC SYSTEM', 'surveillance.transponderSystem', 'surveillance.transponderSystem', [
        ['system1', 'SYS 1', 'system1'],
        ['system2', 'SYS 2', 'system2'],
      ]),
      toggleControl('ALT REPORTING', 'surveillance.altitudeReporting', 'surveillance.altitudeReporting'),
      detentControl('TCAS FILTER', 'surveillance.tcasFilterMode', 'surveillance.tcasFilter', [
        ['threat', 'THRT', 'threat'],
        ['all', 'ALL', 'all'],
        ['above', 'ABV', 'above'],
        ['below', 'BLW', 'below'],
      ]),
      detentControl('TCAS MODE', 'surveillance.tcasMode', 'surveillance.tcasMode', [
        ['standby', 'STBY', 'standby'],
        ['ta', 'TA', 'ta'],
        ['taRa', 'TA/RA', 'taRa'],
      ]),
      toggleControl('RMP CAPT POWER', 'surveillance.rmpCaptainPower', 'surveillance.rmpCaptainPower'),
      detentControl('RMP CAPT MODE', 'surveillance.rmpCaptainMode', 'surveillance.rmpCaptainMode', [
        ['select', 'SEL', 'select'],
        ['vhf1', 'VHF1', 'vhf1'],
        ['vhf2', 'VHF2', 'vhf2'],
        ['vhf3', 'VHF3', 'vhf3'],
      ]),
      toggleControl('RMP F/O POWER', 'surveillance.rmpFirstOfficerPower', 'surveillance.rmpFirstOfficerPower'),
      detentControl('RMP F/O MODE', 'surveillance.rmpFirstOfficerMode', 'surveillance.rmpFirstOfficerMode', [
        ['select', 'SEL', 'select'],
        ['vhf1', 'VHF1', 'vhf1'],
        ['vhf2', 'VHF2', 'vhf2'],
        ['vhf3', 'VHF3', 'vhf3'],
      ]),
    ],
  },
  {
    id: 'switching-displays',
    title: 'Switching & Displays',
    controls: [
      ...[
        ['ATT/HDG', 'switching.attitudeHeading', 'switching.attitudeHeading'],
        ['AIR DATA', 'switching.airData', 'switching.airData'],
        ['EIS DMC', 'switching.eisDmc', 'switching.eisDmc'],
        ['ECAM/ND XFR', 'switching.ecamNd', 'switching.ecamNd'],
      ].map(([title, fieldId, prefix]) => detentControl(title, fieldId, prefix, [
        ['captain', 'CAPT', 'captain'],
        ['normal', 'NORM', 'normal'],
        ['firstOfficer', 'F/O', 'firstOfficer'],
      ])),
      detentControl('ANNUNCIATOR LIGHTS', 'displays.annunciatorMode', 'displays.annunciator', [
        ['test', 'TEST', 'test'],
        ['bright', 'BRT', 'bright'],
        ['dim', 'DIM', 'dim'],
      ]),
      detentControl('ECAM SYSTEM PAGE', 'displays.ecamPage', 'displays.ecamPage', [
        ['none', 'NONE', 'none'],
        ['engine', 'ENG', 'engine'],
        ['bleed', 'BLEED', 'bleed'],
        ['press', 'PRESS', 'press'],
        ['electrical', 'ELEC', 'electrical'],
        ['hydraulic', 'HYD', 'hydraulic'],
        ['fuel', 'FUEL', 'fuel'],
        ['apu', 'APU', 'apu'],
        ['conditioning', 'COND', 'conditioning'],
        ['door', 'DOOR', 'door'],
        ['wheel', 'WHEEL', 'wheel'],
        ['flightControls', 'F/CTL', 'flightControls'],
        ['status', 'STS', 'status'],
        ['cruise', 'CRUISE', 'cruise'],
      ]),
      singleActionControl('MASTER CAUTION', 'displays.masterCaution', 'displays.masterCaution.clear', 'CLEAR', false),
      singleActionControl('MASTER WARNING', 'displays.masterWarning', 'displays.masterWarning.clear', 'CLEAR', false),
    ],
  },
];

const exteriorIndicators = [
  { id: 'lights.strobeActive', label: 'STROBE ACTIVE' },
  { id: 'lights.beacon', label: 'BEACON' },
  { id: 'lights.nav', label: 'NAV' },
  { id: 'lights.logo', label: 'LOGO' },
  { id: 'lights.wing', label: 'WING' },
  { id: 'lights.runwayTurnoff', label: 'RWY L' },
  { id: 'lights.runwayTurnoffRight', label: 'RWY R' },
  { id: 'lights.noseMode', label: 'NOSE' },
  { id: 'lights.landingLeftMode', label: 'LANDING L' },
  { id: 'lights.landingRightMode', label: 'LANDING R' },
  { id: 'lights.landingLeftCircuitOn', label: 'LAND L LIT' },
  { id: 'lights.landingRightCircuitOn', label: 'LAND R LIT' },
];

const electricalIndicators = [
  { id: 'systems.battery1', label: 'BAT 1 AUTO' },
  { id: 'systems.battery2', label: 'BAT 2 AUTO' },
  { id: 'systems.externalPowerAvailable', label: 'EXT PWR AVAIL' },
  { id: 'systems.externalPower', label: 'EXT PWR ON' },
  { id: 'systems.apuAvailable', label: 'APU AVAIL' },
  { id: 'systems.pack1ValveOpen', label: 'PACK 1 FLOW' },
  { id: 'systems.pack2ValveOpen', label: 'PACK 2 FLOW' },
];

const protectionIndicators = [
  { id: 'systems.engineAntiIce1', label: 'ENG 1 A.ICE' },
  { id: 'systems.engineAntiIce2', label: 'ENG 2 A.ICE' },
  { id: 'systems.wingAntiIce', label: 'WING A.ICE' },
  { id: 'systems.ir1Mode', label: 'IR 1' },
  { id: 'systems.ir2Mode', label: 'IR 2' },
  { id: 'systems.ir3Mode', label: 'IR 3' },
  { id: 'systems.adirsOnBattery', label: 'ADIRS ON BAT', tone: 'warning' },
  { id: 'systems.parkingBrake', label: 'PARK BRK', tone: 'warning' },
];

const faultIndicators = [
  { id: 'systems.apuMasterFault', label: 'APU MASTER' },
  { id: 'systems.apuBleedFault', label: 'APU BLEED' },
  { id: 'systems.pack1Fault', label: 'PACK 1' },
  { id: 'systems.pack2Fault', label: 'PACK 2' },
  { id: 'systems.ir1Fault', label: 'IR 1' },
  { id: 'systems.ir2Fault', label: 'IR 2' },
  { id: 'systems.ir3Fault', label: 'IR 3' },
];

function hasValue(id) {
  return !unavailableFields.value.has(id)
    && Object.prototype.hasOwnProperty.call(props.values, id);
}

function value(id) {
  return hasValue(id) ? props.values[id] : null;
}

function numberValue(id) {
  const current = value(id);
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

function valueText(id) {
  const current = value(id);
  if (current === null) return '--';
  if (typeof current === 'boolean') return current ? 'ON' : 'OFF';
  if (typeof current === 'number') return Number.isFinite(current) ? String(current) : '--';
  return String(current).toUpperCase();
}

function speedText() {
  if (value('flightGuidance.speedDashes') === true) return '---';
  const current = numberValue('flightGuidance.speedValue');
  if (current === null) return '--';
  return value('flightGuidance.machMode') === true
    ? current.toFixed(2)
    : String(Math.round(current));
}

function headingText() {
  if (value('flightGuidance.headingDashes') === true) return '---';
  const current = numberValue('flightGuidance.headingDeg');
  return current === null ? '--' : String(Math.round(current)).padStart(3, '0');
}

function altitudeText() {
  const current = numberValue('flightGuidance.altitudeFt');
  return current === null ? '--' : Math.round(current).toLocaleString('en-US');
}

function verticalText() {
  if (value('flightGuidance.verticalDashes') === true) return '-----';
  const current = numberValue('flightGuidance.verticalValue');
  if (current === null) return '--';
  return value('flightGuidance.trkFpaMode') === true
    ? `${current.toFixed(1)}°`
    : `${Math.round(current)} fpm`;
}

function controlValue(control) {
  const current = value(control.fieldId);
  return (
    typeof current === 'boolean'
    || typeof current === 'string'
    || (typeof current === 'number' && Number.isFinite(current))
  ) ? current : null;
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

function actionDisabled(control, actionId) {
  return !controlSessionReady.value
    || controlValue(control) === null
    || !actionSupported(actionId)
    || groupPending(control.groupId);
}

function controlStatusId(control) {
  return `fbw-control-status-${control.groupId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function actionDisabledReason(control, actionId) {
  if (!actionDisabled(control, actionId)) return '';
  if (groupPending(control.groupId)) return 'Command pending.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (controlValue(control) === null) return 'Current aircraft state unavailable.';
  if (!actionSupported(actionId)) return 'Compatible write transport unavailable.';
  return 'Control temporarily unavailable.';
}

function requestControlAction(control, actionId) {
  if (actionDisabled(control, actionId)) return false;
  return props.requestAction(actionId, control.groupId);
}

function actionButtonClass(selected) {
  return selected
    ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100 shadow-sm'
    : 'border-surface-300 bg-surface-100 text-gray-300 hover:border-surface-400 hover:bg-surface-200';
}

function controlStatus(control) {
  if (groupPending(control.groupId)) return 'Command pending…';
  if (props.sourceStatus !== 'connected') return 'Waiting for the simulator.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (controlValue(control) === null) return 'Current aircraft state unavailable.';
  if (!control.actions.some((action) => actionSupported(action.id))) {
    return 'This control is unavailable.';
  }
  if (control.fieldId === 'lights.strobeMode') {
    if (controlValue(control) === 'auto') {
      return value('lights.strobeAuto') === true
        ? `AUTO armed; actual strobe output is ${value('lights.strobeActive') === true ? 'ON' : 'OFF'}.`
        : 'Waiting for the live AUTO-mode flag.';
    }
    return `Selector and actual strobe output are tracked independently; output is ${value('lights.strobeActive') === true ? 'ON' : 'OFF'}.`;
  }
  return 'Ready.';
}

function requestThrottleAction(actionId) {
  return props.requestAction(actionId, 'propulsion.throttle');
}

function controlGridClass(control) {
  if (control.actions.length >= 5) return 'grid-cols-3 sm:grid-cols-4';
  if (control.actions.length === 4) return 'grid-cols-2 sm:grid-cols-4';
  if (control.actions.length === 3) return 'grid-cols-3';
  if (control.actions.length === 2) return 'grid-cols-2';
  return 'grid-cols-1';
}

function indicatorClass(id, tone = 'positive') {
  const current = value(id);
  if (current === null) return 'border-surface-200 bg-surface-50 text-gray-500';
  const active = typeof current === 'boolean'
    ? current
    : current !== 'off' && current !== 'retract';
  if (!active) return 'border-surface-200 bg-surface-50 text-gray-400';
  if (tone === 'warning') return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
  return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
}

function faultClass(id) {
  if (!hasValue(id)) return 'border-surface-200 bg-surface-50 text-gray-500';
  return value(id) === true
    ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
    : 'border-surface-200 bg-surface-50 text-gray-400';
}

function voltageText(id) {
  const current = numberValue(id);
  return current === null ? '--' : `${current.toFixed(1)} V`;
}

function alignmentText() {
  const seconds = numberValue('systems.adirsAlignmentSeconds');
  if (seconds === null) return '--';
  if (seconds <= 0) return 'ALIGNED';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}
</script>

<template>
  <div class="p-3 sm:p-4 space-y-5" data-aircraft-template="fbw-a32nx">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h3 class="text-base font-semibold text-gray-100">FlyByWire Airbus A32NX</h3>
        <p class="text-xs text-gray-500">Live cockpit controls and aircraft status.</p>
      </div>
      <span class="text-[10px] uppercase tracking-widest text-gray-500">{{ sourceStatus }}</span>
    </div>

    <AircraftSectionRibbon
      :sections="mobileSections"
      section-id-prefix="fbw-a32nx-section-"
      aircraft-label="FlyByWire A32NX"
    />

    <div id="fbw-a32nx-section-throttle" class="aircraft-mobile-navigable-section" tabindex="-1">
      <FlyByWireThrottleControl
        aircraft-label="FlyByWire A32NX"
        :lever-positions="[
          values['propulsion.throttleLever1Angle'],
          values['propulsion.throttleLever2Angle'],
        ]"
        :lever-labels="['L', 'R']"
        :source-status="sourceStatus"
        :control-enabled="controlSessionReady"
        :setup-required="controlSetupRequired"
        :action-capabilities="actionCapabilities"
        :pending="groupPending('propulsion.throttle')"
        :request-action="requestThrottleAction"
      />
    </div>

    <div id="fbw-a32nx-section-fcu" class="aircraft-mobile-navigable-section" tabindex="-1">
      <div class="dashboard-section-kicker">Flight Control Unit</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">SPD / MACH</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ speedText() }}</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">HDG / TRK</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ headingText() }}°</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">ALTITUDE</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ altitudeText() }} ft</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">V/S / FPA</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ verticalText() }}</div>
        </div>
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <div
          v-for="mode in guidanceModes"
          :key="mode.id"
          class="rounded border px-2.5 py-1.5 text-[10px] font-semibold"
          :class="indicatorClass(mode.id)"
        >
          {{ mode.label }} <span class="opacity-70">{{ valueText(mode.id) }}</span>
        </div>
      </div>
    </div>

    <div
      v-for="section in controlSections"
      :key="section.id"
      :id="`fbw-a32nx-section-${section.id}`"
      class="aircraft-mobile-navigable-section"
      tabindex="-1"
      :data-aircraft-control-section="section.id"
    >
      <div class="dashboard-section-kicker">{{ section.title }}</div>
      <p v-if="section.note" class="mb-2 text-[10px] leading-relaxed text-gray-500">{{ section.note }}</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        <div
          v-for="control in section.controls"
          :key="control.groupId"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-[10px] font-semibold tracking-wide text-gray-200">{{ control.title }}</span>
            <span class="text-[9px] uppercase tracking-widest text-gray-500">{{ valueText(control.fieldId) }}</span>
          </div>
          <div class="grid gap-2" :class="controlGridClass(control)">
            <button
              v-for="action in control.actions"
              :key="action.id"
              type="button"
              class="min-h-11 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="actionButtonClass(controlValue(control) === action.value)"
              :data-aircraft-action="action.id"
              :aria-pressed="controlValue(control) === action.value"
              :aria-describedby="controlStatusId(control)"
              :title="actionDisabledReason(control, action.id) || undefined"
              :disabled="actionDisabled(control, action.id)"
              @click="requestControlAction(control, action.id)"
            >
              {{ action.label }}
            </button>
          </div>
          <p
            :id="controlStatusId(control)"
            class="mt-2 text-[10px] leading-relaxed text-gray-500"
          >
            {{ controlStatus(control) }}
          </p>
        </div>
      </div>
    </div>

    <div id="fbw-a32nx-section-light-readback" class="aircraft-mobile-navigable-section" tabindex="-1">
      <div class="dashboard-section-kicker">Exterior Light Readback</div>
      <p class="mb-2 text-[10px] leading-relaxed text-gray-500">
        Landing-light selector and illuminated-circuit states are tracked independently.
      </p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div
          v-for="indicator in exteriorIndicators"
          :key="indicator.id"
          class="rounded border px-2.5 py-2 text-[10px] font-semibold"
          :class="indicatorClass(indicator.id)"
        >
          {{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span>
        </div>
      </div>
    </div>

    <div id="fbw-a32nx-section-status" class="aircraft-mobile-navigable-section grid grid-cols-1 lg:grid-cols-2 gap-4" tabindex="-1">
      <div>
        <div class="dashboard-section-kicker">Electrical &amp; Pneumatic Snapshot</div>
        <div class="mb-2 grid grid-cols-2 gap-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3 text-xs text-gray-300">
            BAT 1 <span class="float-right font-semibold">{{ voltageText('systems.battery1Voltage') }}</span>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3 text-xs text-gray-300">
            BAT 2 <span class="float-right font-semibold">{{ voltageText('systems.battery2Voltage') }}</span>
          </div>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div
            v-for="indicator in electricalIndicators"
            :key="indicator.id"
            class="rounded border px-2.5 py-2 text-[10px] font-semibold"
            :class="indicatorClass(indicator.id)"
          >
            {{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span>
          </div>
        </div>
      </div>

      <div>
        <div class="dashboard-section-kicker">Protection &amp; Navigation</div>
        <div class="mb-2 rounded-lg border border-surface-200 bg-surface-50 p-3 text-xs text-gray-300">
          ADIRS ALIGNMENT <span class="float-right font-semibold">{{ alignmentText() }}</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div
            v-for="indicator in protectionIndicators"
            :key="indicator.id"
            class="rounded border px-2.5 py-2 text-[10px] font-semibold"
            :class="indicatorClass(indicator.id, indicator.tone)"
          >
            {{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div>
      <div class="dashboard-section-kicker">Overhead Faults</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <div
          v-for="indicator in faultIndicators"
          :key="indicator.id"
          class="rounded border px-2.5 py-2 text-[10px] font-semibold"
          :class="faultClass(indicator.id)"
        >
          {{ indicator.label }} <span class="float-right opacity-70">{{ value(indicator.id) === true ? 'FAULT' : (hasValue(indicator.id) ? 'OK' : '--') }}</span>
        </div>
      </div>
    </div>

    <p class="text-[10px] leading-relaxed text-amber-300/80">
      A32NX updates can affect compatibility. Confirm critical changes in the simulator.
    </p>
  </div>
</template>
