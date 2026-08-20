<script setup>
import { computed, onMounted, ref } from 'vue';
import { mcpDraftKey, submitMcpDraft } from '../mcp-input.js';

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  sourceStatuses: { type: Object, default: () => ({}) },
  actionCapabilities: { type: Object, default: () => ({}) },
  requestAction: { type: Function, default: () => false },
  isActionPending: { type: Function, default: () => false },
  profileKey: { type: String, default: '' },
});

const unavailableFields = computed(() => new Set(props.unavailable));
const electronApi = typeof window !== 'undefined' ? window.electronAPI : null;
const authorizationState = ref('unknown');
const eulaOpened = ref(false);
const eulaConfirmed = ref(false);
const authorizationBusy = ref(false);
const authorizationError = ref('');
const mcpDrafts = ref({});
const directDrafts = ref({});
const sdkSourceStatus = computed(() => (
  typeof props.sourceStatuses.sdk === 'string' && props.sourceStatuses.sdk
    ? props.sourceStatuses.sdk
    : props.sourceStatus
));

const variant = computed(() => {
  const liveModel = props.values['aircraft.model'];
  if (typeof liveModel === 'string' && liveModel) return liveModel;
  if (props.profileKey.endsWith('/pmdg-777-200er')) return '777-200ER';
  if (props.profileKey.endsWith('/pmdg-777-200lr')) return '777-200LR';
  if (props.profileKey.endsWith('/pmdg-777f')) return '777F';
  return '777-300ER';
});

const showAuthorization = computed(() => (
  authorizationState.value === 'required'
  || (authorizationState.value === 'unavailable' && sdkSourceStatus.value === 'disabled')
));

const sdkStatusNotice = computed(() => {
  if (showAuthorization.value || sdkSourceStatus.value === 'connected') return null;
  const messages = {
    stale: 'PMDG SDK data stopped updating. Check EnableDataBroadcast=1 and reload the aircraft or simulator.',
    disconnected: 'The PMDG SDK data connection is offline. Check EnableDataBroadcast=1 and reload the aircraft or simulator.',
    disabled: 'PMDG SDK data is disabled. Confirm desktop SDK authorization and EnableDataBroadcast=1, then restart Flight Fabric.',
    error: 'The PMDG SDK data connection failed. Check the desktop logs and PMDG data-broadcast setting.',
    unsupported: 'This installation cannot start the PMDG 777 SDK connector.',
    'awaiting-values': 'Waiting for the first PMDG SDK data snapshot. Confirm EnableDataBroadcast=1 if this does not clear.',
    paused: 'PMDG SDK data is paused while the simulator is in a menu.',
  };
  return messages[sdkSourceStatus.value] || messages['awaiting-values'];
});

const mcpWindows = [
  { key: 'speed', label: 'IAS / MACH', groupId: 'mcp.speed' },
  { key: 'heading', label: 'HDG / TRK', groupId: 'mcp.heading' },
  { key: 'altitude', label: 'ALTITUDE', groupId: 'mcp.altitude' },
  { key: 'vertical', label: 'V/S / FPA', groupId: 'mcp.vertical' },
];

const afdsModes = [
  { id: 'flightGuidance.fdLeft', label: 'FD L', control: 'toggle', actionPrefix: 'afds.flightDirectorCaptain' },
  { id: 'flightGuidance.apLeft', label: 'AP L', control: 'engage', actionPrefix: 'afds.apLeft' },
  { id: 'flightGuidance.autothrottleArmedLeft', label: 'A/T ARM L', control: 'toggle', actionPrefix: 'afds.autothrottleArmLeft' },
  { id: 'flightGuidance.autothrottleActive', label: 'A/T' },
  { id: 'flightGuidance.lnav', label: 'LNAV', control: 'engage', actionPrefix: 'afds.lnav' },
  { id: 'flightGuidance.vnav', label: 'VNAV', control: 'engage', actionPrefix: 'afds.vnav' },
  { id: 'flightGuidance.flch', label: 'FLCH', control: 'engage', actionPrefix: 'afds.levelChange' },
  { id: 'flightGuidance.headingHold', label: 'HDG HOLD', control: 'engage', actionPrefix: 'afds.headingHold' },
  { id: 'flightGuidance.verticalSpeed', label: 'V/S FPA', control: 'engage', actionPrefix: 'afds.verticalSpeed' },
  { id: 'flightGuidance.altitudeHold', label: 'ALT HOLD', control: 'engage', actionPrefix: 'afds.altitudeHold' },
  { id: 'flightGuidance.localizer', label: 'LOC', control: 'engage', actionPrefix: 'afds.vorLoc' },
  { id: 'flightGuidance.approach', label: 'APP', control: 'engage', actionPrefix: 'afds.approach' },
  { id: 'flightGuidance.autothrottleArmedRight', label: 'A/T ARM R', control: 'toggle', actionPrefix: 'afds.autothrottleArmRight' },
  { id: 'flightGuidance.apRight', label: 'AP R', control: 'engage', actionPrefix: 'afds.apRight' },
  { id: 'flightGuidance.fdRight', label: 'FD R', control: 'toggle', actionPrefix: 'afds.flightDirectorFirstOfficer' },
];

const selectorControls = [
  {
    title: 'HDG / TRK', fieldId: 'flightGuidance.headingMode', groupId: 'mcp.heading',
    actions: [
      { id: 'afds.headingMode.hdg', label: 'HDG', value: 'HDG' },
      { id: 'afds.headingMode.trk', label: 'TRK', value: 'TRK' },
    ],
  },
  {
    title: 'V/S / FPA', fieldId: 'flightGuidance.verticalMode', groupId: 'mcp.vertical',
    actions: [
      { id: 'afds.verticalMode.vs', label: 'V/S', value: 'VS' },
      { id: 'afds.verticalMode.fpa', label: 'FPA', value: 'FPA' },
    ],
  },
];

const exteriorControls = [
  ['LANDING L', 'lights.landingLeft', 'lights.landingLeft'],
  ['LANDING NOSE', 'lights.landingNose', 'lights.landingNose'],
  ['LANDING R', 'lights.landingRight', 'lights.landingRight'],
  ['BEACON', 'lights.beacon', 'lights.beacon'],
  ['NAV', 'lights.nav', 'lights.nav'],
  ['LOGO', 'lights.logo', 'lights.logo'],
  ['WING', 'lights.wing', 'lights.wing'],
  ['TURNOFF L', 'lights.turnoffLeft', 'lights.turnoffLeft'],
  ['TURNOFF R', 'lights.turnoffRight', 'lights.turnoffRight'],
  ['TAXI', 'lights.taxi', 'lights.taxi'],
  ['STROBE', 'lights.strobe', 'lights.strobe'],
].map(([title, fieldId, prefix]) => ({
  title,
  fieldId,
  groupId: prefix,
  actions: [
    { id: `${prefix}.off`, label: 'OFF', value: false },
    { id: `${prefix}.on`, label: 'ON', value: true },
  ],
}));

const cabinControls = [
  {
    title: 'EMERGENCY LIGHTS', fieldId: 'lights.emergencyMode', groupId: 'lights.emergency',
    actions: [['off', 'OFF'], ['armed', 'ARMED'], ['on', 'ON']].map(([value, label]) => ({ id: `lights.emergency.${value}`, value, label })),
  },
  {
    title: 'NO SMOKING', fieldId: 'cabin.noSmokingMode', groupId: 'cabin.noSmoking',
    actions: [['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON']].map(([value, label]) => ({ id: `cabin.noSmoking.${value}`, value, label })),
  },
  {
    title: 'SEAT BELTS', fieldId: 'cabin.seatBeltsMode', groupId: 'cabin.seatBelts',
    actions: [['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON']].map(([value, label]) => ({ id: `cabin.seatBelts.${value}`, value, label })),
  },
  {
    title: 'LEFT WIPER', fieldId: 'visibility.wiperLeftMode', groupId: 'visibility.wiperLeft',
    actions: [['off', 'OFF'], ['intermittent', 'INT'], ['low', 'LOW'], ['high', 'HIGH']].map(([value, label]) => ({ id: `visibility.wiperLeft.${value}`, value, label })),
  },
  {
    title: 'RIGHT WIPER', fieldId: 'visibility.wiperRightMode', groupId: 'visibility.wiperRight',
    actions: [['off', 'OFF'], ['intermittent', 'INT'], ['low', 'LOW'], ['high', 'HIGH']].map(([value, label]) => ({ id: `visibility.wiperRight.${value}`, value, label })),
  },
];

function booleanControl(title, fieldId, prefix, offLabel = 'OFF', onLabel = 'ON') {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: [
      { id: `${prefix}.off`, label: offLabel, value: false },
      { id: `${prefix}.on`, label: onLabel, value: true },
    ],
  };
}

function detentControl(title, fieldId, prefix, positions, options = {}) {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: positions.map(([id, label, value = id]) => ({ id: `${prefix}.${id}`, label, value })),
    ...options,
  };
}

const controlSections = [
  {
    title: 'Electrical, APU & General',
    description: 'Persistent overhead switch positions; external-power requests confirm the PMDG ON annunciator.',
    open: true,
    controls: [
      booleanControl('BATTERY', 'systems.electrical.batteryOn', 'systems.electrical.battery'),
      detentControl('STANDBY POWER', 'systems.electrical.standbyPowerMode', 'systems.electrical.standbyPower', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['battery', 'BAT'],
      ]),
      detentControl('APU SELECTOR', 'systems.apuSelectorMode', 'systems.apuSelector', [
        ['off', 'OFF'], ['on', 'ON'],
      ]),
      booleanControl('APU GENERATOR', 'systems.electrical.apuGeneratorOn', 'systems.electrical.apuGenerator'),
      detentControl('BUS TIE L', 'systems.electrical.busTieLeftMode', 'systems.electrical.busTieLeft', [
        ['off', 'OFF'], ['auto', 'AUTO'],
      ]),
      detentControl('BUS TIE R', 'systems.electrical.busTieRightMode', 'systems.electrical.busTieRight', [
        ['off', 'OFF'], ['auto', 'AUTO'],
      ]),
      booleanControl('EXTERNAL POWER PRI', 'systems.electrical.externalPowerPrimaryOn', 'systems.electrical.externalPowerPrimary'),
      booleanControl('EXTERNAL POWER SEC', 'systems.electrical.externalPowerSecondaryOn', 'systems.electrical.externalPowerSecondary'),
      booleanControl('GENERATOR L', 'systems.electrical.generatorLeftOn', 'systems.electrical.generatorLeft'),
      booleanControl('GENERATOR R', 'systems.electrical.generatorRightOn', 'systems.electrical.generatorRight'),
      booleanControl('BACKUP GEN L', 'systems.electrical.backupGeneratorLeftOn', 'systems.electrical.backupGeneratorLeft'),
      booleanControl('BACKUP GEN R', 'systems.electrical.backupGeneratorRightOn', 'systems.electrical.backupGeneratorRight'),
      booleanControl('CABIN UTILITY', 'systems.electrical.cabinUtility', 'systems.electrical.cabinUtility'),
      booleanControl('IFE / PASS SEATS', 'systems.electrical.ifePassengerSeats', 'systems.electrical.ifePassengerSeats'),
      booleanControl('ADIRU', 'systems.adiruOn', 'systems.adiru'),
      detentControl('THRUST ASYM COMP', 'systems.thrustAsymCompMode', 'systems.thrustAsymComp', [
        ['disconnect', 'DISC'], ['auto', 'AUTO'],
      ]),
      booleanControl('SERVICE INTERPHONE', 'systems.serviceInterphoneOn', 'systems.serviceInterphone'),
    ],
  },
  {
    title: 'Hydraulics & Ice Protection',
    description: 'Only unguarded pump, heat, and anti-ice selector positions are available.',
    controls: [
      booleanControl('HYD ENG PUMP L', 'systems.hydraulics.enginePumpLeftOn', 'systems.hydraulics.enginePumpLeft'),
      booleanControl('HYD ENG PUMP R', 'systems.hydraulics.enginePumpRightOn', 'systems.hydraulics.enginePumpRight'),
      booleanControl('HYD ELEC PUMP L', 'systems.hydraulics.electricPumpLeftOn', 'systems.hydraulics.electricPumpLeft'),
      booleanControl('HYD ELEC PUMP R', 'systems.hydraulics.electricPumpRightOn', 'systems.hydraulics.electricPumpRight'),
      detentControl('DEMAND ELEC L', 'systems.hydraulics.demandElectricLeftMode', 'systems.hydraulics.demandElectricLeft', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
      ]),
      detentControl('DEMAND ELEC R', 'systems.hydraulics.demandElectricRightMode', 'systems.hydraulics.demandElectricRight', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
      ]),
      detentControl('DEMAND AIR L', 'systems.hydraulics.demandAirLeftMode', 'systems.hydraulics.demandAirLeft', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
      ]),
      detentControl('DEMAND AIR R', 'systems.hydraulics.demandAirRightMode', 'systems.hydraulics.demandAirRight', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
      ]),
      booleanControl('WINDOW HEAT L SIDE', 'systems.ice.windowHeatLeftSide', 'systems.ice.windowHeatLeftSide'),
      booleanControl('WINDOW HEAT L FWD', 'systems.ice.windowHeatLeftForward', 'systems.ice.windowHeatLeftForward'),
      booleanControl('WINDOW HEAT R FWD', 'systems.ice.windowHeatRightForward', 'systems.ice.windowHeatRightForward'),
      booleanControl('WINDOW HEAT R SIDE', 'systems.ice.windowHeatRightSide', 'systems.ice.windowHeatRightSide'),
      detentControl('WING ANTI-ICE', 'systems.wingAntiIce', 'systems.antiIce.wing', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
      ]),
      detentControl('ENGINE ANTI-ICE L', 'systems.engineAntiIceLeft', 'systems.antiIce.engineLeft', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
      ]),
      detentControl('ENGINE ANTI-ICE R', 'systems.engineAntiIceRight', 'systems.antiIce.engineRight', [
        ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
      ]),
    ],
  },
  {
    title: 'Fuel & Engines',
    description: 'These are normal cockpit selectors, but fuel-control and start-switch commands can stop or start engines. Use only with the aircraft in the intended configuration.',
    warning: true,
    controls: [
      booleanControl('XFEED FWD', 'systems.fuel.crossfeedForwardOn', 'systems.fuel.crossfeedForward'),
      booleanControl('XFEED AFT', 'systems.fuel.crossfeedAftOn', 'systems.fuel.crossfeedAft'),
      booleanControl('FUEL PUMP FWD L', 'systems.fuel.pumpForwardLeftOn', 'systems.fuel.pumpForwardLeft'),
      booleanControl('FUEL PUMP FWD R', 'systems.fuel.pumpForwardRightOn', 'systems.fuel.pumpForwardRight'),
      booleanControl('FUEL PUMP AFT L', 'systems.fuel.pumpAftLeftOn', 'systems.fuel.pumpAftLeft'),
      booleanControl('FUEL PUMP AFT R', 'systems.fuel.pumpAftRightOn', 'systems.fuel.pumpAftRight'),
      booleanControl('FUEL PUMP CTR L', 'systems.fuel.pumpCenterLeftOn', 'systems.fuel.pumpCenterLeft'),
      booleanControl('FUEL PUMP CTR R', 'systems.fuel.pumpCenterRightOn', 'systems.fuel.pumpCenterRight'),
      detentControl('EEC L', 'systems.engine.eecLeftMode', 'systems.engine.eecLeft', [
        ['alternate', 'ALTN'], ['normal', 'NORM'],
      ]),
      detentControl('EEC R', 'systems.engine.eecRightMode', 'systems.engine.eecRight', [
        ['alternate', 'ALTN'], ['normal', 'NORM'],
      ]),
      detentControl('START SELECTOR L', 'systems.engine.startLeftMode', 'systems.engine.startLeft', [
        ['start', 'START'], ['normal', 'NORM'],
      ]),
      detentControl('START SELECTOR R', 'systems.engine.startRightMode', 'systems.engine.startRight', [
        ['start', 'START'], ['normal', 'NORM'],
      ]),
      booleanControl('AUTOSTART', 'systems.engine.autostartOn', 'systems.engine.autostart'),
      detentControl('FUEL CONTROL L', 'systems.engine.fuelControlLeftMode', 'systems.engine.fuelControlLeft', [
        ['cutoff', 'CUTOFF'], ['run', 'RUN'],
      ]),
      detentControl('FUEL CONTROL R', 'systems.engine.fuelControlRightMode', 'systems.engine.fuelControlRight', [
        ['cutoff', 'CUTOFF'], ['run', 'RUN'],
      ]),
    ],
  },
  {
    title: 'Air & Pressurization',
    description: 'Cockpit switch positions only; the page does not infer resulting valve, temperature, or pressure behavior.',
    controls: [
      detentControl('PACK L', 'systems.packLeft', 'systems.air.packLeft', [['off', 'OFF'], ['auto', 'AUTO']]),
      detentControl('PACK R', 'systems.packRight', 'systems.air.packRight', [['off', 'OFF'], ['auto', 'AUTO']]),
      detentControl('ENGINE BLEED L', 'systems.engineBleedLeft', 'systems.air.engineBleedLeft', [['off', 'OFF'], ['auto', 'AUTO']]),
      detentControl('ENGINE BLEED R', 'systems.engineBleedRight', 'systems.air.engineBleedRight', [['off', 'OFF'], ['auto', 'AUTO']]),
      detentControl('APU BLEED', 'systems.apuBleed', 'systems.air.apuBleed', [['off', 'OFF'], ['auto', 'AUTO']]),
      booleanControl('TRIM AIR L', 'systems.air.trimAirLeftOn', 'systems.air.trimAirLeft'),
      booleanControl('TRIM AIR R', 'systems.air.trimAirRightOn', 'systems.air.trimAirRight'),
      booleanControl('RECIRC UPPER', 'systems.air.recircUpperOn', 'systems.air.recircUpper'),
      booleanControl('RECIRC LOWER', 'systems.air.recircLowerOn', 'systems.air.recircLower'),
      detentControl('EQUIP COOLING', 'systems.air.equipmentCoolingMode', 'systems.air.equipmentCooling', [
        ['override', 'OVRD'], ['auto', 'AUTO'],
      ]),
      booleanControl('GASPER', 'systems.air.gasperOn', 'systems.air.gasper'),
      detentControl('OUTFLOW FWD', 'systems.air.outflowForwardMode', 'systems.air.outflowForward', [
        ['manual', 'MAN'], ['auto', 'AUTO'],
      ]),
      detentControl('OUTFLOW AFT', 'systems.air.outflowAftMode', 'systems.air.outflowAft', [
        ['manual', 'MAN'], ['auto', 'AUTO'],
      ]),
      detentControl('MAIN DECK FLOW', 'systems.air.mainDeckFlowMode', 'systems.air.mainDeckFlow', [
        ['high', 'HIGH'], ['normal', 'NORM'],
      ], { freighterOnly: true }),
    ],
  },
  {
    title: 'Gear, Brakes & High-Lift Controls',
    description: 'Fixed lever/detent targets only. Arbitrary speedbrake and flight-control axes remain unavailable.',
    warning: true,
    controls: [
      detentControl('GEAR LEVER', 'controls.gearDown', 'controls.gear', [
        ['up', 'UP', false], ['down', 'DOWN', true],
      ]),
      detentControl('AUTOBRAKE', 'controls.autobrakeMode', 'controls.autobrake', [
        ['rto', 'RTO'], ['off', 'OFF'], ['disarm', 'DISARM'], ['one', '1', '1'], ['two', '2', '2'], ['max', 'MAX'],
      ]),
      detentControl('FLAPS', 'controls.flapsLabel', 'controls.flaps', [
        ['up', 'UP', 'UP'], ['one', '1', '1'], ['five', '5', '5'], ['fifteen', '15', '15'],
        ['twenty', '20', '20'], ['twentyFive', '25', '25'], ['thirty', '30', '30'],
      ]),
      detentControl('SPEEDBRAKE', 'controls.speedbrakePercent', 'controls.speedbrake', [
        ['stowed', 'STOW', 0], ['armed', 'ARM', 25],
      ]),
      booleanControl('PARKING BRAKE', 'controls.parkingBrake', 'controls.parkingBrake'),
    ],
  },
  {
    title: 'EFIS, Displays & Transponder',
    description: 'Persistent selector positions with exact crew-side readback.',
    controls: [
      detentControl('BANK LIMIT', 'flightGuidance.bankLimitMode', 'mcp.bankLimit', [
        ['auto', 'AUTO'], ['five', '5', '5'], ['ten', '10', '10'], ['fifteen', '15', '15'],
        ['twenty', '20', '20'], ['twentyFive', '25', '25'],
      ]),
      detentControl('ALT INCREMENT', 'flightGuidance.altitudeIncrementMode', 'mcp.altitudeIncrement', [
        ['auto', 'AUTO'], ['thousand', '1000', '1000'],
      ]),
      detentControl('INBOARD DISPLAY L', 'displays.inboardLeftMode', 'displays.inboardLeft', [
        ['nd', 'ND'], ['nav', 'NAV'], ['mfd', 'MFD'], ['eicas', 'EICAS'],
      ]),
      detentControl('INBOARD DISPLAY R', 'displays.inboardRightMode', 'displays.inboardRight', [
        ['eicas', 'EICAS'], ['mfd', 'MFD'], ['nd', 'ND'], ['pfd', 'PFD'],
      ]),
      detentControl('FMC SOURCE', 'displays.fmcSourceMode', 'displays.fmcSource', [
        ['left', 'L'], ['auto', 'AUTO'], ['right', 'R'],
      ]),
      detentControl('CAPT MINIMUMS', 'efis.captain.minimumsMode', 'efis.captain.minimums', [
        ['radio', 'RADIO'], ['baro', 'BARO'],
      ]),
      detentControl('CAPT BARO UNITS', 'efis.captain.baroUnitsMode', 'efis.captain.baroUnits', [
        ['inhg', 'IN'], ['hpa', 'HPA'],
      ]),
      detentControl('CAPT BRG L', 'efis.captain.bearingLeftMode', 'efis.captain.bearingLeft', [
        ['vor', 'VOR'], ['off', 'OFF'], ['adf', 'ADF'],
      ]),
      detentControl('CAPT BRG R', 'efis.captain.bearingRightMode', 'efis.captain.bearingRight', [
        ['vor', 'VOR'], ['off', 'OFF'], ['adf', 'ADF'],
      ]),
      detentControl('CAPT MAP MODE', 'efis.captain.mapMode', 'efis.captain.mapMode', [
        ['approach', 'APP'], ['vor', 'VOR'], ['map', 'MAP'], ['plan', 'PLAN'],
      ]),
      detentControl('CAPT RANGE', 'efis.captain.rangeNm', 'efis.captain.range', [
        ['ten', '10', '10'], ['twenty', '20', '20'], ['forty', '40', '40'], ['eighty', '80', '80'],
        ['oneSixty', '160', '160'], ['threeTwenty', '320', '320'], ['sixForty', '640', '640'],
      ]),
      detentControl('F/O MINIMUMS', 'efis.firstOfficer.minimumsMode', 'efis.firstOfficer.minimums', [
        ['radio', 'RADIO'], ['baro', 'BARO'],
      ]),
      detentControl('F/O BARO UNITS', 'efis.firstOfficer.baroUnitsMode', 'efis.firstOfficer.baroUnits', [
        ['inhg', 'IN'], ['hpa', 'HPA'],
      ]),
      detentControl('F/O BRG L', 'efis.firstOfficer.bearingLeftMode', 'efis.firstOfficer.bearingLeft', [
        ['vor', 'VOR'], ['off', 'OFF'], ['adf', 'ADF'],
      ]),
      detentControl('F/O BRG R', 'efis.firstOfficer.bearingRightMode', 'efis.firstOfficer.bearingRight', [
        ['vor', 'VOR'], ['off', 'OFF'], ['adf', 'ADF'],
      ]),
      detentControl('F/O MAP MODE', 'efis.firstOfficer.mapMode', 'efis.firstOfficer.mapMode', [
        ['approach', 'APP'], ['vor', 'VOR'], ['map', 'MAP'], ['plan', 'PLAN'],
      ]),
      detentControl('F/O RANGE', 'efis.firstOfficer.rangeNm', 'efis.firstOfficer.range', [
        ['ten', '10', '10'], ['twenty', '20', '20'], ['forty', '40', '40'], ['eighty', '80', '80'],
        ['oneSixty', '160', '160'], ['threeTwenty', '320', '320'], ['sixForty', '640', '640'],
      ]),
      detentControl('XPDR SOURCE', 'transponder.sourceMode', 'transponder.source', [
        ['left', 'L'], ['right', 'R'],
      ]),
      detentControl('ALT SOURCE', 'transponder.altitudeSourceMode', 'transponder.altitudeSource', [
        ['normal', 'NORM'], ['alternate', 'ALTN'],
      ]),
      detentControl('XPDR MODE', 'transponder.mode', 'transponder.mode', [
        ['standby', 'STBY'], ['altitudeOff', 'ALT OFF', 'altitude-off'], ['transponder', 'XPDR'],
        ['taOnly', 'TA', 'ta-only'], ['taRa', 'TA/RA', 'ta-ra'],
      ]),
    ],
  },
  {
    title: 'Chronometers',
    description: 'Stable selector detents only; momentary reset/clock buttons are excluded.',
    controls: [
      detentControl('CAPT TIME/DATE', 'chronometer.captain.timeDateMode', 'chronometer.captain.timeDate', [
        ['utc', 'UTC'], ['manual', 'MAN'],
      ]),
      detentControl('CAPT SET', 'chronometer.captain.setMode', 'chronometer.captain.set', [
        ['run', 'RUN'], ['holdYear', 'HLD/Y', 'hold-year'], ['minutes', 'MM'], ['hoursDate', 'HD', 'hours-date'],
      ]),
      detentControl('CAPT ELAPSED', 'chronometer.captain.elapsedMode', 'chronometer.captain.elapsed', [
        ['hold', 'HOLD'], ['run', 'RUN'],
      ]),
      detentControl('F/O TIME/DATE', 'chronometer.firstOfficer.timeDateMode', 'chronometer.firstOfficer.timeDate', [
        ['utc', 'UTC'], ['manual', 'MAN'],
      ]),
      detentControl('F/O SET', 'chronometer.firstOfficer.setMode', 'chronometer.firstOfficer.set', [
        ['run', 'RUN'], ['holdYear', 'HLD/Y', 'hold-year'], ['minutes', 'MM'], ['hoursDate', 'HD', 'hours-date'],
      ]),
      detentControl('F/O ELAPSED', 'chronometer.firstOfficer.elapsedMode', 'chronometer.firstOfficer.elapsed', [
        ['hold', 'HOLD'], ['run', 'RUN'],
      ]),
    ],
  },
  {
    title: 'Interior Lighting',
    description: 'Direct switch and 0?100 position controls; no repeated wheel-event macros.',
    controls: [
      booleanControl('STORM', 'lights.storm', 'lighting.storm'),
      booleanControl('MASTER BRIGHT', 'lighting.masterBrightOn', 'lighting.masterBright'),
      detentControl('INDICATOR LIGHTS', 'lighting.indicatorLightsMode', 'lighting.indicatorLights', [
        ['test', 'TEST'], ['bright', 'BRT'], ['dim', 'DIM'],
      ]),
      detentControl('FLOOR LIGHTS', 'lighting.floorMode', 'lighting.floor', [
        ['bright', 'BRT'], ['off', 'OFF'], ['dim', 'DIM'],
      ]),
    ],
  },
  {
    title: 'Crew Comfort',
    description: 'Direct position controls; temperature values are selector positions, not degrees.',
    controls: [
      detentControl('FOOT HEAT L', 'comfort.leftFootHeatMode', 'comfort.leftFootHeat', [
        ['off', 'OFF'], ['low', 'LOW'], ['high', 'HIGH'],
      ]),
      detentControl('FOOT HEAT R', 'comfort.rightFootHeatMode', 'comfort.rightFootHeat', [
        ['off', 'OFF'], ['low', 'LOW'], ['high', 'HIGH'],
      ]),
    ],
  },
];

const visibleControlSections = computed(() => controlSections.map((section) => ({
  ...section,
  controls: section.controls.filter((control) => !control.freighterOnly || variant.value === '777F'),
})).filter((section) => section.controls.length > 0));

const numericControlSections = [
  {
    title: 'Interior Lighting Levels',
    controls: [
      ['DOME', 'lighting.domePercent', 'lighting.dome.set', 0, 100, '%'],
      ['CIRCUIT BREAKER', 'lighting.circuitBreakerPercent', 'lighting.circuitBreaker.set', 0, 100, '%'],
      ['OVERHEAD PANEL', 'lighting.overheadPanelPercent', 'lighting.overheadPanel.set', 0, 100, '%'],
      ['GLARESHIELD PANEL', 'lighting.glareshieldPanelPercent', 'lighting.glareshieldPanel.set', 0, 100, '%'],
      ['GLARESHIELD FLOOD', 'lighting.glareshieldFloodPercent', 'lighting.glareshieldFlood.set', 0, 100, '%'],
      ['MASTER BRIGHTNESS', 'lighting.masterBrightnessPercent', 'lighting.masterBrightness.set', 0, 100, '%'],
      ['LEFT PANEL', 'lighting.leftPanelPercent', 'lighting.leftPanel.set', 0, 100, '%'],
      ['LEFT FLOOD', 'lighting.leftFloodPercent', 'lighting.leftFlood.set', 0, 100, '%'],
      ['LEFT OUTBD DISPLAY', 'lighting.leftOutboardDisplayPercent', 'lighting.leftOutboardDisplay.set', 0, 100, '%'],
      ['LEFT INBD DISPLAY', 'lighting.leftInboardDisplayPercent', 'lighting.leftInboardDisplay.set', 0, 100, '%'],
      ['RIGHT PANEL', 'lighting.rightPanelPercent', 'lighting.rightPanel.set', 0, 100, '%'],
      ['RIGHT FLOOD', 'lighting.rightFloodPercent', 'lighting.rightFlood.set', 0, 100, '%'],
      ['RIGHT INBD DISPLAY', 'lighting.rightInboardDisplayPercent', 'lighting.rightInboardDisplay.set', 0, 100, '%'],
      ['RIGHT OUTBD DISPLAY', 'lighting.rightOutboardDisplayPercent', 'lighting.rightOutboardDisplay.set', 0, 100, '%'],
      ['UPPER DISPLAY', 'lighting.upperDisplayPercent', 'lighting.upperDisplay.set', 0, 100, '%'],
      ['LOWER DISPLAY', 'lighting.lowerDisplayPercent', 'lighting.lowerDisplay.set', 0, 100, '%'],
      ['AISLE PANEL', 'lighting.aislePanelPercent', 'lighting.aislePanel.set', 0, 100, '%'],
      ['AISLE FLOOD', 'lighting.aisleFloodPercent', 'lighting.aisleFlood.set', 0, 100, '%'],
    ],
  },
  {
    title: 'Temperature & Shoulder Heat Positions',
    controls: [
      ['FLIGHT DECK TEMP', 'comfort.flightDeckTemperaturePosition', 'comfort.flightDeckTemperature.set', 0, 60, 'pos'],
      ['CABIN TEMP', 'comfort.cabinTemperaturePosition', 'comfort.cabinTemperature.set', 0, 60, 'pos'],
      ['SHOULDER HEAT L', 'comfort.leftShoulderHeatPercent', 'comfort.leftShoulderHeat.set', 0, 100, '%'],
      ['SHOULDER HEAT R', 'comfort.rightShoulderHeatPercent', 'comfort.rightShoulderHeat.set', 0, 100, '%'],
    ],
  },
].map((section) => ({
  ...section,
  controls: section.controls.map(([title, fieldId, actionId, min, max, unit]) => ({
    title, fieldId, actionId, min, max, unit, step: 1, groupId: fieldId,
  })),
}));

const systemIndicators = [
  { id: 'systems.apuRunning', label: 'APU RUNNING' },
  { id: 'systems.irsAligned', label: 'IRS ALIGNED' },
  { id: 'warnings.masterCaution', label: 'MASTER CAUTION', tone: 'warning' },
  { id: 'warnings.masterWarning', label: 'MASTER WARNING', tone: 'danger' },
];

function hasValue(id) {
  return !unavailableFields.value.has(id) && Object.prototype.hasOwnProperty.call(props.values, id);
}

function value(id) {
  return hasValue(id) ? props.values[id] : null;
}

function valueText(id) {
  const current = value(id);
  if (current === null) return '--';
  if (typeof current === 'boolean') return current ? 'ON' : 'OFF';
  return String(current).toUpperCase();
}

function mcpInputConfig(field) {
  if (field.key === 'speed') {
    if (hasValue('flightGuidance.mach') && !hasValue('flightGuidance.speedKts')) {
      return {
        fieldId: 'flightGuidance.mach', actionId: 'mcp.mach.set', label: 'MACH', unit: '',
        min: 0.4, max: 0.99, step: 0.01, precision: 3,
      };
    }
    return {
      fieldId: 'flightGuidance.speedKts', actionId: 'mcp.ias.set', label: 'IAS', unit: 'kt',
      min: 100, max: 399, step: 1,
    };
  }
  if (field.key === 'heading') {
    return {
      fieldId: 'flightGuidance.headingDeg', actionId: 'mcp.heading.set',
      label: value('flightGuidance.headingMode') === 'TRK' ? 'TRACK' : 'HEADING', unit: '\u00b0',
      min: 0, max: 359, step: 1, digits: 3,
    };
  }
  if (field.key === 'altitude') {
    return {
      fieldId: 'flightGuidance.altitudeFt', actionId: 'mcp.altitude.set', label: 'ALTITUDE', unit: 'ft',
      min: 0, max: 50000, step: 100, locale: true,
    };
  }
  const fpaMode = value('flightGuidance.verticalMode') === 'FPA'
    || (!hasValue('flightGuidance.vsFpm') && hasValue('flightGuidance.fpaDeg'));
  return fpaMode
    ? {
      fieldId: 'flightGuidance.fpaDeg', actionId: 'mcp.fpa.set', label: 'FPA', unit: '\u00b0',
      min: -9.9, max: 9.9, step: 0.1, precision: 1, signed: true,
    }
    : {
      fieldId: 'flightGuidance.vsFpm', actionId: 'mcp.verticalSpeed.set', label: 'VERT SPEED', unit: 'fpm',
      min: -7900, max: 6000, step: 100, signed: true,
    };
}

function formatMcpWindow(field) {
  const config = mcpInputConfig(field);
  const current = value(config.fieldId);
  if (typeof current !== 'number' || !Number.isFinite(current)) return '---';
  if (config.precision !== undefined) {
    const formatted = current.toFixed(config.precision);
    return config.signed && current > 0 ? `+${formatted}` : formatted;
  }
  const rounded = Math.round(current);
  if (config.signed) return `${rounded >= 0 ? '+' : ''}${rounded}`;
  if (config.locale) return rounded.toLocaleString();
  if (config.digits) return String(rounded).padStart(config.digits, '0');
  return String(rounded);
}

function mcpDraft(field) {
  const config = mcpInputConfig(field);
  const draftKey = mcpDraftKey(config, field.key);
  if (Object.prototype.hasOwnProperty.call(mcpDrafts.value, draftKey)) return mcpDrafts.value[draftKey];
  const current = value(config.fieldId);
  return typeof current === 'number' && Number.isFinite(current) ? current : '';
}

function updateMcpDraft(field, event) {
  const config = mcpInputConfig(field);
  mcpDrafts.value = { ...mcpDrafts.value, [mcpDraftKey(config, field.key)]: event.target.value };
}

function mcpDisabled(field) {
  const config = mcpInputConfig(field);
  return sdkSourceStatus.value !== 'connected'
    || !hasValue(config.fieldId)
    || !actionSupported(config.actionId)
    || groupPending(field.groupId);
}

function requestMcpAction(field) {
  const config = mcpInputConfig(field);
  const sent = submitMcpDraft({
    config,
    disabled: mcpDisabled(field),
    groupId: field.groupId,
    rawValue: mcpDraft(field),
    requestAction: props.requestAction,
  });
  if (sent !== false) {
    const nextDrafts = { ...mcpDrafts.value };
    delete nextDrafts[mcpDraftKey(config, field.key)];
    mcpDrafts.value = nextDrafts;
  }
  return sent;
}

function afdsActionId(mode) {
  if (mode.control === 'engage') return `${mode.actionPrefix}.engage`;
  if (mode.control === 'toggle') return `${mode.actionPrefix}.${value(mode.id) === true ? 'off' : 'on'}`;
  return '';
}

function afdsDisabled(mode) {
  const actionId = afdsActionId(mode);
  return !actionId
    || sdkSourceStatus.value !== 'connected'
    || !hasValue(mode.id)
    || (mode.control === 'engage' && value(mode.id) === true)
    || !actionSupported(actionId)
    || groupPending(mode.id);
}

function requestAfdsAction(mode) {
  const actionId = afdsActionId(mode);
  if (afdsDisabled(mode)) return false;
  return props.requestAction(actionId, mode.id);
}

function controlValue(control) {
  const current = value(control.fieldId);
  return typeof current === 'boolean'
    || typeof current === 'string'
    || (typeof current === 'number' && Number.isFinite(current))
    ? current
    : null;
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

function actionDisabled(control, actionId) {
  return sdkSourceStatus.value !== 'connected'
    || controlValue(control) === null
    || !actionSupported(actionId)
    || groupPending(control.groupId);
}

function requestControlAction(control, actionId) {
  if (actionDisabled(control, actionId)) return false;
  return props.requestAction(actionId, control.groupId);
}

function directDraft(control) {
  const key = mcpDraftKey(control, control.fieldId);
  if (Object.prototype.hasOwnProperty.call(directDrafts.value, key)) return directDrafts.value[key];
  const current = value(control.fieldId);
  return typeof current === 'number' && Number.isFinite(current) ? current : '';
}

function updateDirectDraft(control, event) {
  directDrafts.value = {
    ...directDrafts.value,
    [mcpDraftKey(control, control.fieldId)]: event.target.value,
  };
}

function directDisabled(control) {
  return sdkSourceStatus.value !== 'connected'
    || typeof value(control.fieldId) !== 'number'
    || !actionSupported(control.actionId)
    || groupPending(control.groupId);
}

function requestDirectAction(control) {
  const sent = submitMcpDraft({
    config: control,
    disabled: directDisabled(control),
    groupId: control.groupId,
    rawValue: directDraft(control),
    requestAction: props.requestAction,
  });
  if (sent !== false) {
    const nextDrafts = { ...directDrafts.value };
    delete nextDrafts[mcpDraftKey(control, control.fieldId)];
    directDrafts.value = nextDrafts;
  }
  return sent;
}

function actionButtonClass(selected) {
  return selected
    ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100'
    : 'border-surface-300 bg-surface-100 text-gray-300 hover:border-surface-400 hover:bg-surface-200';
}

function indicatorClass(id, tone = 'positive') {
  if (!hasValue(id)) return 'border-surface-200 bg-surface-50 text-gray-500';
  const active = value(id) === true;
  if (!active) return 'border-surface-200 bg-surface-50 text-gray-400';
  if (tone === 'danger') return 'border-red-500/50 bg-red-500/15 text-red-300';
  if (tone === 'warning') return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
  return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
}

async function refreshAuthorization() {
  if (typeof electronApi?.getPmdg777SdkEulaStatus !== 'function') {
    authorizationState.value = 'unavailable';
    return;
  }
  const result = await electronApi.getPmdg777SdkEulaStatus();
  authorizationState.value = result?.accepted === true ? 'accepted' : 'required';
}

async function openSdkEula() {
  authorizationBusy.value = true;
  authorizationError.value = '';
  try {
    const result = await electronApi?.openPmdg777SdkEula?.();
    if (result?.success !== true) throw new Error(result?.error || 'Could not open the installed PMDG SDK EULA.');
    eulaOpened.value = true;
  } catch (error) {
    authorizationError.value = error?.message || String(error);
  } finally {
    authorizationBusy.value = false;
  }
}

async function acceptSdkEula() {
  if (!eulaOpened.value || !eulaConfirmed.value) return;
  authorizationBusy.value = true;
  authorizationError.value = '';
  try {
    const result = await electronApi?.acceptPmdg777SdkEula?.();
    if (result?.success !== true) throw new Error(result?.error || 'Could not save SDK authorization.');
    authorizationState.value = 'accepted';
    await electronApi?.restartApp?.();
  } catch (error) {
    authorizationError.value = error?.message || String(error);
  } finally {
    authorizationBusy.value = false;
  }
}

onMounted(() => {
  refreshAuthorization().catch((error) => {
    authorizationError.value = error?.message || String(error);
    authorizationState.value = 'unavailable';
  });
});
</script>

<template>
  <div
    class="p-3 sm:p-4 space-y-5"
    data-aircraft-template="pmdg-777"
    :data-pmdg-777-variant="variant"
    :data-aircraft-sdk-status="sdkSourceStatus"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h3 class="text-base font-semibold text-gray-100">PMDG Boeing {{ variant }}</h3>
        <p class="text-xs text-gray-500">Official PMDG SDK state with fixed-target, readback-confirmed flight-deck controls.</p>
      </div>
      <span class="text-[10px] uppercase tracking-widest text-gray-500">{{ sdkSourceStatus }}</span>
    </div>

    <div v-if="showAuthorization" class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <div class="text-sm font-semibold text-amber-200">PMDG 777 SDK authorization required</div>
      <p class="mt-1 text-xs leading-relaxed text-amber-100/75">
        PMDG requires SDK applications to show its SDK EULA and obtain your explicit acceptance. This can only be completed in the Flight Fabric desktop app.
      </p>
      <template v-if="electronApi">
        <button type="button" class="ff-button-secondary mt-3 px-3 py-2 text-xs" :disabled="authorizationBusy" @click="openSdkEula">
          Open installed PMDG SDK EULA
        </button>
        <label class="mt-3 flex items-start gap-2 text-xs text-gray-300">
          <input v-model="eulaConfirmed" type="checkbox" class="mt-0.5" :disabled="!eulaOpened || authorizationBusy" />
          <span>I have read and accept the installed PMDG 777 SDK EULA.</span>
        </label>
        <button type="button" class="ff-button-primary mt-3 px-3 py-2 text-xs" :disabled="!eulaOpened || !eulaConfirmed || authorizationBusy" @click="acceptSdkEula">
          Accept and restart Flight Fabric
        </button>
      </template>
      <p v-else class="mt-3 text-xs text-gray-400">Open this Aircraft page in the desktop app to authorize the SDK host; phones cannot accept it.</p>
      <p v-if="authorizationError" class="mt-2 text-xs text-red-300">{{ authorizationError }}</p>
    </div>

    <div
      v-else-if="sdkStatusNotice"
      class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
      role="status"
      data-aircraft-sdk-notice="pmdg-777"
    >
      <div class="text-sm font-semibold text-amber-200">PMDG 777 SDK not ready</div>
      <p class="mt-1 text-xs leading-relaxed text-amber-100/75">{{ sdkStatusNotice }}</p>
    </div>

    <div>
      <div class="dashboard-section-kicker">Mode Control Panel</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
        <form
          v-for="field in mcpWindows"
          :key="field.key"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-aircraft-control-group="field.groupId"
          @submit.prevent="requestMcpAction(field)"
        >
          <div class="text-[9px] uppercase tracking-widest text-gray-500">{{ mcpInputConfig(field).label }}</div>
          <div class="mt-1 flex items-baseline gap-1">
            <span class="font-mono text-lg font-semibold text-gray-100">{{ formatMcpWindow(field) }}</span>
            <span v-if="mcpInputConfig(field).unit" class="text-[10px] text-gray-500">{{ mcpInputConfig(field).unit }}</span>
          </div>
          <div class="mt-2 flex gap-1.5">
            <input
              class="min-w-0 flex-1 rounded border border-surface-300 bg-surface-100 px-2 py-1.5 font-mono text-sm text-gray-100 disabled:opacity-45"
              type="number"
              inputmode="decimal"
              :min="mcpInputConfig(field).min"
              :max="mcpInputConfig(field).max"
              :step="mcpInputConfig(field).step"
              :value="mcpDraft(field)"
              :disabled="mcpDisabled(field)"
              :aria-label="`Set ${field.label}`"
              @input="updateMcpDraft(field, $event)"
            />
            <button type="submit" class="rounded border border-cyan-400/50 bg-cyan-400/10 px-3 text-[10px] font-semibold text-cyan-100 disabled:opacity-45" :data-aircraft-action="mcpInputConfig(field).actionId" :disabled="mcpDisabled(field)">SET</button>
          </div>
        </form>
      </div>

      <div class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div v-for="control in selectorControls" :key="control.fieldId" class="rounded-lg border border-surface-200 bg-surface-50 p-2.5" :data-aircraft-control-group="control.groupId">
          <div class="mb-2 flex items-center justify-between text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ valueText(control.fieldId) }}</span></div>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-9 rounded border px-2 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :disabled="actionDisabled(control, action.id)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
          </div>
        </div>
      </div>

      <div class="mt-2 flex flex-wrap gap-1.5">
        <button v-for="mode in afdsModes" :key="mode.id" type="button" class="rounded border px-2.5 py-1.5 text-[10px] font-semibold tracking-wide disabled:cursor-not-allowed disabled:opacity-60" :class="indicatorClass(mode.id)" :data-aircraft-action="afdsActionId(mode) || undefined" :disabled="afdsDisabled(mode)" @click="requestAfdsAction(mode)">{{ mode.label }} <span class="opacity-70">{{ valueText(mode.id) }}</span></button>
      </div>

      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">The official 777 SDK does not expose 737-style NAV frequency or course-selector controls, so those remain intentionally unavailable.</p>
    </div>

    <div>
      <div class="dashboard-section-kicker">Exterior Lights</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
        <div v-for="control in exteriorControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
          <div class="mb-2 flex items-center justify-between text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ valueText(control.fieldId) }}</span></div>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-2 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :disabled="actionDisabled(control, action.id)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
          </div>
        </div>
      </div>
    </div>

    <div>
      <div class="dashboard-section-kicker">Cabin &amp; Visibility</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div v-for="control in cabinControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
          <div class="mb-2 flex items-center justify-between text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ valueText(control.fieldId) }}</span></div>
          <div class="grid gap-1.5" :class="control.actions.length === 4 ? 'grid-cols-4' : 'grid-cols-3'">
            <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :disabled="actionDisabled(control, action.id)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
          </div>
        </div>
      </div>
    </div>

    <details
      v-for="section in visibleControlSections"
      :key="section.title"
      class="rounded-lg border border-surface-200 bg-surface-50/40"
      :open="section.open || undefined"
    >
      <summary class="cursor-pointer select-none px-3 py-2.5 text-xs font-semibold text-gray-200">
        {{ section.title }}
        <span class="ml-1 text-[9px] font-normal text-gray-500">({{ section.controls.length }} controls)</span>
      </summary>
      <div class="border-t border-surface-200 p-3">
        <p
          class="mb-3 text-[10px] leading-relaxed"
          :class="section.warning ? 'text-amber-300/80' : 'text-gray-500'"
        >
          {{ section.description }}
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
          <div
            v-for="control in section.controls"
            :key="control.groupId"
            class="rounded-lg border border-surface-200 bg-surface-50 p-2.5"
            :data-aircraft-control-group="control.groupId"
          >
            <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200">
              <span>{{ control.title }}</span>
              <span class="text-[9px] text-gray-500">{{ valueText(control.fieldId) }}</span>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <button
                v-for="action in control.actions"
                :key="action.id"
                type="button"
                class="min-h-9 rounded border px-1.5 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45"
                :class="actionButtonClass(controlValue(control) === action.value)"
                :disabled="actionDisabled(control, action.id)"
                :data-aircraft-action="action.id"
                :aria-pressed="controlValue(control) === action.value"
                @click="requestControlAction(control, action.id)"
              >
                {{ action.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </details>

    <details
      v-for="section in numericControlSections"
      :key="section.title"
      class="rounded-lg border border-surface-200 bg-surface-50/40"
    >
      <summary class="cursor-pointer select-none px-3 py-2.5 text-xs font-semibold text-gray-200">
        {{ section.title }}
        <span class="ml-1 text-[9px] font-normal text-gray-500">({{ section.controls.length }} direct setters)</span>
      </summary>
      <div class="grid grid-cols-1 gap-2 border-t border-surface-200 p-3 sm:grid-cols-2 xl:grid-cols-4">
        <form
          v-for="control in section.controls"
          :key="control.actionId"
          class="rounded-lg border border-surface-200 bg-surface-50 p-2.5"
          :data-aircraft-control-group="control.groupId"
          @submit.prevent="requestDirectAction(control)"
        >
          <div class="flex items-center justify-between gap-2 text-[9px] font-semibold text-gray-300">
            <span>{{ control.title }}</span>
            <span class="font-mono text-gray-500">{{ valueText(control.fieldId) }} {{ control.unit }}</span>
          </div>
          <div class="mt-2 flex gap-1.5">
            <input
              class="min-w-0 flex-1 rounded border border-surface-300 bg-surface-100 px-2 py-1.5 font-mono text-sm text-gray-100 disabled:opacity-45"
              type="number"
              inputmode="numeric"
              :min="control.min"
              :max="control.max"
              :step="control.step"
              :value="directDraft(control)"
              :disabled="directDisabled(control)"
              :aria-label="`Set ${control.title}`"
              @input="updateDirectDraft(control, $event)"
            />
            <button
              type="submit"
              class="rounded border border-cyan-400/50 bg-cyan-400/10 px-3 text-[10px] font-semibold text-cyan-100 disabled:opacity-45"
              :data-aircraft-action="control.actionId"
              :disabled="directDisabled(control)"
            >
              SET
            </button>
          </div>
        </form>
      </div>
    </details>

    <div>
      <div class="dashboard-section-kicker">Read-only System Outcome</div>
      <p class="mb-2 text-[10px] text-gray-500">
        These indicators describe system outcomes or warnings; they are not used as substitute selector controls.
      </p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div v-for="indicator in systemIndicators" :key="indicator.id" class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass(indicator.id, indicator.tone)">{{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span></div>
      </div>
    </div>

    <p class="text-[10px] leading-relaxed text-amber-300/80">
      Installed-SDK mappings are structurally audited but broad live validation is still pending. Test low-risk controls while parked before relying on them operationally.
    </p>
  </div>
</template>
