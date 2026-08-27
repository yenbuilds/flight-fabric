<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue';
import AircraftHotGroupModal from '../AircraftHotGroupModal.vue';
import { useAircraftSectionMemory } from '../aircraft-section-memory.js';
import { mcpDraftKey, submitMcpDraft } from '../mcp-input.js';
import { useDocumentEvent } from '../../../composables/useDocumentEvent.js';

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  sourceStatuses: { type: Object, default: () => ({}) },
  actionCapabilities: { type: Object, default: () => ({}) },
  requestAction: { type: Function, default: () => false },
  requestCommand: { type: Function, default: () => false },
  isCommandSupported: { type: Function, default: () => false },
  getCommand: { type: Function, default: () => null },
  isActionPending: { type: Function, default: () => false },
  profileKey: { type: String, default: '' },
});

const unavailableFields = computed(() => new Set(props.unavailable));
const electronApi = typeof window !== 'undefined' ? window.electronAPI : null;
const authorizationState = ref(electronApi ? 'unknown' : 'unavailable');
const eulaOpened = ref(false);
const eulaConfirmed = ref(false);
const authorizationBusy = ref(false);
const authorizationError = ref('');
const mcpDrafts = ref({});
const bothCourseDraft = ref('');
const bothNavFrequencyDraft = ref('');
const cockpitLightingDraft = ref('50');
const sectionRibbon = ref(null);
const sectionMenu = ref(null);
const sectionMenuButton = ref(null);
const activeSectionIndex = ref(0);
const sectionMenuOpen = ref(false);
const initialPowerOpen = ref(false);
let sectionScrollTarget = null;
let sectionSyncTimer = null;
let ribbonSwipeStart = null;
let suppressRibbonClick = false;
let suppressRibbonClickTimer = null;
const sdkSourceStatus = computed(() => (
  typeof props.sourceStatuses.sdk === 'string' && props.sourceStatuses.sdk
    ? props.sourceStatuses.sdk
    : props.sourceStatus
));

const mobileSections = Object.freeze([
  Object.freeze({ id: 'mcp', label: 'MCP', title: 'Mode Control Panel', detail: 'Targets, flight directors and AFDS modes.' }),
  Object.freeze({ id: 'radios', label: 'Radios', title: 'Navigation Radios', detail: 'NAV active, standby and frequency transfer.' }),
  Object.freeze({ id: 'exterior', label: 'Exterior', title: 'Exterior Lights', detail: 'Landing, taxi, position and exterior lighting.' }),
  Object.freeze({ id: 'cockpit-lighting', label: 'Lighting', title: 'Cockpit Lighting', detail: 'Panel backlighting, flood lights and display brightness.' }),
  Object.freeze({ id: 'cabin', label: 'Cabin', title: 'Cabin & Visibility', detail: 'Signs, emergency lights and windshield wipers.' }),
  Object.freeze({ id: 'flight-controls', label: 'Controls', title: 'Flight Controls', detail: 'Flaps, speedbrake, yaw damper and trim status.' }),
  Object.freeze({ id: 'gear-brakes', label: 'Gear', title: 'Gear & Brakes', detail: 'Gear position, parking brake, autobrake and anti-skid.' }),
  Object.freeze({ id: 'systems', label: 'Systems', title: 'Air & Systems', detail: 'Packs, bleed air, anti-ice, APU and warning state.' }),
]);

const activeSection = computed(() => mobileSections[activeSectionIndex.value]);
const previousSection = computed(() => mobileSections[activeSectionIndex.value - 1] || null);
const nextSection = computed(() => mobileSections[activeSectionIndex.value + 1] || null);

const variant = computed(() => {
  const liveModel = props.values['aircraft.model'];
  if (typeof liveModel === 'string' && liveModel) return liveModel;
  if (props.profileKey.endsWith('/pmdg-737-600')) return '737-600';
  if (props.profileKey.endsWith('/pmdg-737-700')) return '737-700';
  if (props.profileKey.endsWith('/pmdg-737-900')) return '737-900ER';
  return '737-800';
});

const showAuthorization = computed(() => (
  authorizationState.value === 'required'
  || (authorizationState.value === 'unavailable' && sdkSourceStatus.value === 'disabled')
));

const sdkStatusNotice = computed(() => {
  if (showAuthorization.value || sdkSourceStatus.value === 'connected') return null;
  const messages = {
    stale: 'PMDG SDK data stopped updating. Check EnableDataBroadcast=1 and restart the aircraft or simulator.',
    disconnected: 'The PMDG SDK data connection is offline. Check EnableDataBroadcast=1 and restart the aircraft or simulator.',
    disabled: 'PMDG SDK data is disabled. Confirm desktop SDK authorization and EnableDataBroadcast=1, then restart Flight Fabric.',
    error: 'The PMDG SDK data connection failed. Check the desktop logs and PMDG data-broadcast setting.',
    unsupported: 'This installation cannot start the PMDG 737 SDK connector.',
    'awaiting-values': 'Waiting for the first PMDG SDK data snapshot. Confirm EnableDataBroadcast=1 if this does not clear.',
    paused: 'PMDG SDK data is paused while the simulator is in a menu.',
  };
  return messages[sdkSourceStatus.value] || messages['awaiting-values'];
});

const mcpWindows = [
  { id: 'mcp.courseCaptainDeg', actionId: 'mcp.courseCaptain.set', label: 'COURSE L', unit: '\u00b0', digits: 3, min: 0, max: 359, step: 1 },
  { id: 'mcp.speed', label: 'IAS / MACH' },
  { id: 'mcp.headingDeg', actionId: 'mcp.heading.set', commandId: 'flightGuidance.heading.set', label: 'HEADING', unit: '\u00b0', digits: 3, min: 0, max: 359, step: 1 },
  { id: 'mcp.altitudeFt', actionId: 'mcp.altitude.set', commandId: 'flightGuidance.altitude.set', label: 'ALTITUDE', unit: 'ft', locale: true, min: 0, max: 50000, step: 100 },
  { id: 'mcp.verticalSpeedFpm', actionId: 'mcp.verticalSpeed.set', commandId: 'flightGuidance.verticalSpeed.set', label: 'VERT SPEED', unit: 'fpm', signed: true, min: -7900, max: 6000, step: 100 },
  { id: 'mcp.courseFirstOfficerDeg', actionId: 'mcp.courseFirstOfficer.set', label: 'COURSE R', unit: '\u00b0', digits: 3, min: 0, max: 359, step: 1 },
];

const afdsModes = [
  ['afds.flightDirectorCaptain', 'FD L', 'toggle'],
  ['afds.autothrottleArm', 'A/T ARM', 'toggle'],
  ['afds.autothrottleActive', 'A/T'],
  ['afds.n1', 'N1', 'engage'],
  ['afds.speed', 'SPEED', 'engage'],
  ['afds.levelChange', 'LVL CHG', 'engage', 'flightGuidance.flightLevelChange.engage'],
  ['afds.vnav', 'VNAV', 'engage'],
  ['afds.headingSelect', 'HDG SEL', 'engage', 'flightGuidance.headingSelect.engage'],
  ['afds.lnav', 'LNAV', 'engage'],
  ['afds.vorLoc', 'VOR/LOC', 'engage', 'flightGuidance.localizer.engage'],
  ['afds.approach', 'APP', 'engage', 'flightGuidance.approach.engage'],
  ['afds.altitudeHold', 'ALT HLD', 'engage', 'flightGuidance.altitudeHold.engage'],
  ['afds.verticalSpeed', 'V/S', 'engage', 'flightGuidance.verticalSpeed.engage'],
  ['afds.cmdA', 'CMD A', 'engage', 'flightGuidance.autopilot1.engage'],
  ['afds.cmdB', 'CMD B', 'engage'],
  ['afds.cwsA', 'CWS A', 'engage'],
  ['afds.cwsB', 'CWS B', 'engage'],
  ['afds.flightDirectorFirstOfficer', 'FD R', 'toggle'],
].map(([id, label, control, commandId]) => ({ id, label, control, commandId }));

const navRadios = [
  {
    id: 'nav1', label: 'NAV 1', active: 'radios.nav1ActiveMhz', standby: 'radios.nav1StandbyMhz',
  },
  {
    id: 'nav2', label: 'NAV 2', active: 'radios.nav2ActiveMhz', standby: 'radios.nav2StandbyMhz',
  },
];
const bothCourseCommandId = 'flightGuidance.course.setBoth';
const bothCourseControlGroup = 'mcp.courseBoth';
const bothNavCommandId = 'radios.nav.setBothActive';
const bothNavControlGroup = 'radios.navBoth';
const cockpitLightingCommandId = 'configuration.lighting.cockpit';
const cockpitLightingControlGroup = 'lighting.cockpit';
const cockpitLightingGroups = Object.freeze([
  Object.freeze({
    label: 'Panels',
    fields: Object.freeze([
      'lighting.overheadCircuitBreakerPercent',
      'lighting.overheadPanelPercent',
      'lighting.mainPanelCaptainPercent',
      'lighting.mainPanelFirstOfficerPercent',
    ]),
  }),
  Object.freeze({
    label: 'Flood & background',
    fields: Object.freeze([
      'lighting.backgroundPercent',
      'lighting.afdsFloodPercent',
      'lighting.pedestalFloodPercent',
      'lighting.pedestalPanelPercent',
    ]),
  }),
  Object.freeze({
    label: 'Flight displays',
    fields: Object.freeze([
      'lighting.displayCaptainOutboardPercent',
      'lighting.displayCaptainInboardPercent',
      'lighting.displayCaptainMapPercent',
      'lighting.displayUpperPercent',
      'lighting.displayLowerPercent',
      'lighting.displayFirstOfficerOutboardPercent',
      'lighting.displayFirstOfficerInboardPercent',
      'lighting.displayFirstOfficerMapPercent',
    ]),
  }),
]);
const cockpitLightingFieldIds = Object.freeze(
  cockpitLightingGroups.flatMap((group) => group.fields),
);

function booleanControl(title, fieldId, prefix = fieldId, commandId = '') {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: [
      { id: `${prefix}.off`, label: 'OFF', value: false, ...(commandId ? { commandId, commandInput: { value: false } } : {}) },
      { id: `${prefix}.on`, label: 'ON', value: true, ...(commandId ? { commandId, commandInput: { value: true } } : {}) },
    ],
  };
}

function detentControl(title, fieldId, prefix, positions, commandId = '', toCommandValue = null) {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: positions.map(([id, label, value = id]) => {
      const commandValue = typeof toCommandValue === 'function' ? toCommandValue(id, value) : undefined;
      return {
        id: `${prefix}.${id}`,
        label,
        value,
        ...(commandId && commandValue !== undefined
          ? { commandId, commandInput: { value: commandValue } }
          : {}),
      };
    }),
  };
}

const exteriorControls = [
  {
    title: 'RETRACT LANDING L', fieldId: 'lights.landingRetractableLeftMode', groupId: 'lights.landingRetractableLeft',
    actions: [['retract', 'RETRACT'], ['extend', 'EXTEND'], ['on', 'ON']].map(([value, label]) => ({ id: `lights.landingRetractableLeft.${value}`, value, label })),
  },
  {
    title: 'RETRACT LANDING R', fieldId: 'lights.landingRetractableRightMode', groupId: 'lights.landingRetractableRight',
    actions: [['retract', 'RETRACT'], ['extend', 'EXTEND'], ['on', 'ON']].map(([value, label]) => ({ id: `lights.landingRetractableRight.${value}`, value, label })),
  },
  booleanControl('FIXED LANDING L', 'lights.landingLeft'),
  booleanControl('FIXED LANDING R', 'lights.landingRight'),
  booleanControl('TURNOFF L', 'lights.turnoffLeft'),
  booleanControl('TURNOFF R', 'lights.turnoffRight'),
  booleanControl('TAXI', 'lights.taxi', 'lights.taxi', 'lights.taxi.set'),
  booleanControl('LOGO', 'lights.logo'),
  {
    title: 'POSITION', fieldId: 'lights.positionMode', groupId: 'lights.position',
    actions: [
      { id: 'lights.position.steady', value: 'steady', label: 'STEADY' },
      { id: 'lights.position.off', value: 'off', label: 'OFF' },
      { id: 'lights.position.strobeSteady', value: 'strobe-steady', label: 'STROBE + STEADY' },
    ],
  },
  booleanControl('BEACON', 'lights.beacon'),
  booleanControl('WING', 'lights.wing'),
  booleanControl('WHEEL WELL', 'lights.wheelWell'),
];

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

const flapHandleControl = detentControl(
  'FLAP HANDLE',
  'flightControls.flapHandleIndex',
  'flightControls.flaps',
  [
    ['up', 'UP', 0], ['detent1', '1', 1], ['detent2', '2', 2],
    ['detent5', '5', 3], ['detent10', '10', 4], ['detent15', '15', 5],
    ['detent25', '25', 6], ['detent30', '30', 7], ['detent40', '40', 8],
  ],
  'surfaces.flaps.set',
  (id) => id === 'up' ? 'up' : id.replace('detent', ''),
);

const flightControlSelectors = [
  booleanControl('YAW DAMPER', 'flightControls.yawDamper'),
  detentControl(
    'SPEEDBRAKE',
    'flightControls.speedbrakeArmed',
    'flightControls.speedbrake',
    [['disarm', 'DISARM', false], ['arm', 'ARM', true]],
    'surfaces.spoilersArmed.set',
    (_id, value) => value,
  ),
  detentControl(
    'STAB TRIM MAIN ELECTRIC',
    'flightControls.stabTrimMainElectricCutout',
    'flightControls.stabTrimMainElectric',
    [['normal', 'NORMAL', false], ['cutout', 'CUTOUT', true]],
  ),
];

const gearHandleControl = detentControl(
  'GEAR HANDLE',
  'gear.handleMode',
  'gear.handle',
  [['up', 'UP'], ['off', 'OFF'], ['down', 'DOWN']],
  'surfaces.gear.set',
  (id) => id === 'off' ? undefined : id,
);

const autobrakeControl = detentControl(
  'AUTOBRAKE',
  'gear.autobrakeMode',
  'gear.autobrake',
  [['rto', 'RTO'], ['off', 'OFF'], ['level1', '1', '1'], ['level2', '2', '2'], ['level3', '3', '3'], ['max', 'MAX']],
);

const parkingBrakeControl = detentControl(
  'PARKING BRAKE',
  'gear.parkingBrake',
  'gear.parkingBrake',
  [['released', 'RELEASED', false], ['set', 'SET', true]],
  'surfaces.parkingBrake.set',
  (_id, value) => value,
);

const airControls = [
  detentControl('PACK L', 'systems.packLeftMode', 'systems.air.packLeft', [['off', 'OFF'], ['auto', 'AUTO'], ['high', 'HIGH']]),
  detentControl('PACK R', 'systems.packRightMode', 'systems.air.packRight', [['off', 'OFF'], ['auto', 'AUTO'], ['high', 'HIGH']]),
  booleanControl('ENG BLEED L', 'systems.engineBleedLeft', 'systems.air.engineBleedLeft'),
  booleanControl('APU BLEED', 'systems.apuBleed', 'systems.air.apuBleed'),
  booleanControl('ENG BLEED R', 'systems.engineBleedRight', 'systems.air.engineBleedRight'),
];

const antiIceControls = [
  booleanControl('WING ANTI-ICE', 'systems.wingAntiIce', 'systems.ice.wing'),
  booleanControl('ENG ANTI-ICE L', 'systems.engineAntiIceLeft', 'systems.ice.engineLeft'),
  booleanControl('ENG ANTI-ICE R', 'systems.engineAntiIceRight', 'systems.ice.engineRight'),
];

const apuSelectorControl = detentControl(
  'APU SELECTOR',
  'systems.apuMode',
  'systems.apu',
  [['off', 'OFF'], ['on', 'ON'], ['start', 'START']],
);

const flightControlIndicators = [
  { id: 'flightControls.leadingEdgeExtended', label: 'LE FLAPS EXT' },
  { id: 'flightControls.leadingEdgeTransit', label: 'LE FLAPS TRANSIT', tone: 'warning' },
  { id: 'flightControls.speedbrakeArmed', label: 'SPEEDBRAKE ARMED' },
  { id: 'flightControls.speedbrakeDoNotArm', label: 'SPEEDBRAKE DO NOT ARM', tone: 'danger' },
  { id: 'flightControls.speedbrakeExtended', label: 'SPEEDBRAKES EXTENDED', tone: 'warning' },
  { id: 'flightControls.yawDamper', label: 'YAW DAMPER' },
  { id: 'flightControls.autoSlatFail', label: 'AUTO SLAT FAIL', tone: 'danger' },
  { id: 'flightControls.stabTrimMainElectricCutout', label: 'STAB TRIM CUTOUT', tone: 'danger' },
];

const systemIndicators = [
  { id: 'systems.irsAligned', label: 'IRS ALIGNED' },
  { id: 'warnings.masterCaution', label: 'MASTER CAUTION', tone: 'warning' },
  { id: 'warnings.masterWarning', label: 'MASTER WARNING', tone: 'danger' },
];

const coldDarkControls = Object.freeze([
  Object.freeze({
    stage: 'power', title: 'BATTERY', fieldId: 'systems.electrical.batteryMode',
    target: 'on', targetLabel: 'ON', actionId: 'systems.electrical.battery.on', groupId: 'systems.electrical.battery',
  }),
  Object.freeze({
    stage: 'power', title: 'STANDBY POWER', fieldId: 'systems.electrical.standbyPowerMode',
    target: 'auto', targetLabel: 'AUTO', actionId: 'systems.electrical.standbyPower.auto', groupId: 'systems.electrical.standbyPower',
  }),
  Object.freeze({
    stage: 'power', title: 'BUS TRANSFER', fieldId: 'systems.electrical.busTransferAuto',
    target: true, targetLabel: 'AUTO', actionId: 'systems.electrical.busTransfer.on', groupId: 'systems.electrical.busTransfer',
  }),
  Object.freeze({
    stage: 'irs', title: 'IRS LEFT', fieldId: 'systems.irs.leftMode',
    target: 'nav', targetLabel: 'NAV', actionId: 'systems.irs.left.nav', groupId: 'systems.irs.left',
  }),
  Object.freeze({
    stage: 'irs', title: 'IRS RIGHT', fieldId: 'systems.irs.rightMode',
    target: 'nav', targetLabel: 'NAV', actionId: 'systems.irs.right.nav', groupId: 'systems.irs.right',
  }),
  Object.freeze({
    stage: 'related', title: 'YAW DAMPER', fieldId: 'flightControls.yawDamper',
    target: true, targetLabel: 'ON', actionId: 'flightControls.yawDamper.on', groupId: 'flightControls.yawDamper',
  }),
  Object.freeze({
    stage: 'related', title: 'EMERGENCY LIGHTS', fieldId: 'lights.emergencyMode',
    target: 'armed', targetLabel: 'ARMED', actionId: 'lights.emergency.armed', groupId: 'lights.emergency',
  }),
  Object.freeze({
    stage: 'related', title: 'WINDOW HEAT · CAPT FORWARD', fieldId: 'systems.windowHeatCaptainForward',
    target: true, targetLabel: 'ON', actionId: 'systems.windowHeatCaptainForward.on', groupId: 'systems.windowHeatCaptainForward',
  }),
  Object.freeze({
    stage: 'related', title: 'WINDOW HEAT · F/O FORWARD', fieldId: 'systems.windowHeatFirstOfficerForward',
    target: true, targetLabel: 'ON', actionId: 'systems.windowHeatFirstOfficerForward.on', groupId: 'systems.windowHeatFirstOfficerForward',
  }),
  Object.freeze({
    stage: 'related', title: 'WINDOW HEAT · CAPT SIDE', fieldId: 'systems.windowHeatCaptainSide',
    target: true, targetLabel: 'ON', actionId: 'systems.windowHeatCaptainSide.on', groupId: 'systems.windowHeatCaptainSide',
  }),
  Object.freeze({
    stage: 'related', title: 'WINDOW HEAT · F/O SIDE', fieldId: 'systems.windowHeatFirstOfficerSide',
    target: true, targetLabel: 'ON', actionId: 'systems.windowHeatFirstOfficerSide.on', groupId: 'systems.windowHeatFirstOfficerSide',
  }),
]);

const coldDarkLive = computed(() => (
  props.sourceStatus === 'connected' && sdkSourceStatus.value === 'connected'
));
const coldDarkSummary = computed(() => {
  if (!coldDarkLive.value) return 'PMDG readback unavailable';
  const groundPower = value('systems.electrical.groundPowerAvailable') === true ? 'AVAILABLE' : 'NOT AVAILABLE';
  return `BATTERY ${coldDarkValueText('systems.electrical.batteryMode')} · GPU ${groundPower} · IRS ${coldDarkValueText('systems.irs.leftMode')}/${coldDarkValueText('systems.irs.rightMode')}`;
});
const coldDarkPowerControls = computed(() => coldDarkControls.filter((control) => control.stage === 'power'));
const coldDarkIrsControls = computed(() => coldDarkControls.filter((control) => control.stage === 'irs'));
const coldDarkRelatedControls = computed(() => coldDarkControls.filter((control) => control.stage === 'related'));
const transferBusesPowered = computed(() => (
  coldDarkLive.value
  && value('systems.electrical.transferBus1Powered') === true
  && value('systems.electrical.transferBus2Powered') === true
));
const apuSourceState = computed(() => {
  if (!coldDarkLive.value || !hasValue('systems.apuMode')) return 'unavailable';
  if (value('systems.apuFault') === true || value('systems.apuOverspeed') === true) return 'fault';
  if (value('systems.electrical.apuGeneratorOffBus') === true) return 'ready';
  const mode = value('systems.apuMode');
  if (mode === 'start' || mode === 'on') return 'starting';
  return 'off';
});
const gearIndicators = [
  { label: 'NOSE', safe: 'gear.noseSafe', unsafe: 'gear.noseUnsafe' },
  { label: 'LEFT', safe: 'gear.leftSafe', unsafe: 'gear.leftUnsafe' },
  { label: 'RIGHT', safe: 'gear.rightSafe', unsafe: 'gear.rightUnsafe' },
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

function formatWindow(field) {
  const current = value(field.id);
  if (typeof current !== 'number' || !Number.isFinite(current)) return '---';
  if (field.id === 'mcp.speed' && current > 0 && current < 10) return current.toFixed(2);
  const rounded = Math.round(current);
  if (field.signed) return `${rounded >= 0 ? '+' : ''}${rounded}`;
  if (field.locale) return rounded.toLocaleString();
  if (field.digits) return String(rounded).padStart(field.digits, '0');
  return String(rounded);
}

function mcpInputConfig(field) {
  let config = field;
  if (field.id === 'mcp.speed') {
    const machMode = typeof value(field.id) === 'number' && value(field.id) > 0 && value(field.id) < 10;
    config = machMode
      ? { ...field, actionId: 'mcp.mach.set', commandId: 'flightGuidance.mach.set', min: 0.4, max: 0.99, step: 0.01 }
      : { ...field, actionId: 'mcp.ias.set', commandId: 'flightGuidance.speed.set', min: 100, max: 399, step: 1 };
  }
  const descriptor = config.commandId ? props.getCommand(config.commandId) : null;
  const input = descriptor?.input;
  return input?.kind === 'number'
    ? { ...config, min: input.min, max: input.max, step: input.step }
    : config;
}

function mcpDraft(field) {
  const config = mcpInputConfig(field);
  const draftKey = mcpDraftKey(config, field.id);
  if (Object.prototype.hasOwnProperty.call(mcpDrafts.value, draftKey)) return mcpDrafts.value[draftKey];
  const current = value(field.id);
  return typeof current === 'number' && Number.isFinite(current) ? current : '';
}

function updateMcpDraft(field, event) {
  const config = mcpInputConfig(field);
  mcpDrafts.value = { ...mcpDrafts.value, [mcpDraftKey(config, field.id)]: event.target.value };
}

function mcpControlGroup(field) {
  return field.id === 'mcp.courseCaptainDeg' || field.id === 'mcp.courseFirstOfficerDeg'
    ? bothCourseControlGroup
    : field.id;
}

function mcpDisabled(field) {
  const config = mcpInputConfig(field);
  return props.sourceStatus !== 'connected'
    || !hasValue(field.id)
    || (config.commandId
      ? !props.isCommandSupported(config.commandId)
      : !actionSupported(config.actionId))
    || groupPending(mcpControlGroup(field));
}

function requestMcpAction(field) {
  const config = mcpInputConfig(field);
  const sent = submitMcpDraft({
    config,
    disabled: mcpDisabled(field),
    groupId: mcpControlGroup(field),
    rawValue: mcpDraft(field),
    requestAction: props.requestAction,
    requestCommand: props.requestCommand,
  });
  if (sent !== false) {
    const nextDrafts = { ...mcpDrafts.value };
    delete nextDrafts[mcpDraftKey(config, field.id)];
    mcpDrafts.value = nextDrafts;
  }
  return sent;
}

function afdsActionId(mode) {
  if (mode.control === 'engage') return `${mode.id}.engage`;
  if (mode.control === 'toggle') return `${mode.id}.${value(mode.id) === true ? 'off' : 'on'}`;
  return '';
}

function afdsDisabled(mode) {
  const actionId = afdsActionId(mode);
  return !actionId
    || props.sourceStatus !== 'connected'
    || !hasValue(mode.id)
    || (mode.control === 'engage' && value(mode.id) === true)
    || (mode.commandId
      ? !props.isCommandSupported(mode.commandId)
      : !actionSupported(actionId))
    || groupPending(mode.id);
}

function requestAfdsAction(mode) {
  const actionId = afdsActionId(mode);
  if (afdsDisabled(mode)) return false;
  if (mode.commandId) return props.requestCommand(mode.commandId, mode.id, {});
  return props.requestAction(actionId, mode.id);
}

function formatFrequency(fieldId) {
  const current = value(fieldId);
  return typeof current === 'number' && Number.isFinite(current) ? current.toFixed(2) : '---.--';
}

function radioActionDisabled(radio, actionId) {
  const readbackField = actionId.endsWith('.transfer') ? radio.active : radio.standby;
  return props.sourceStatus !== 'connected'
    || !hasValue(readbackField)
    || !actionSupported(actionId)
    || groupPending(radio.id);
}

function requestRadioAction(radio, actionId) {
  if (radioActionDisabled(radio, actionId)) return false;
  return props.requestAction(actionId, radio.id);
}

function commandNumberInput(commandId, fallback) {
  const descriptor = props.getCommand(commandId);
  return descriptor?.input?.kind === 'number' ? descriptor.input : fallback;
}

function steppedNumber(rawValue, input) {
  if (typeof rawValue === 'string' && !rawValue.trim()) return null;
  const numericValue = Number(rawValue);
  const position = (numericValue - input.min) / input.step;
  return Number.isFinite(numericValue)
    && numericValue >= input.min
    && numericValue <= input.max
    && Math.abs(position - Math.round(position)) < 1e-7
    ? numericValue
    : null;
}

function bothCourseInput() {
  return commandNumberInput(
    bothCourseCommandId,
    { min: 0, max: 359, step: 1 },
  );
}

function bothCourseValue() {
  return steppedNumber(bothCourseDraft.value, bothCourseInput());
}

function bothCourseDisabled() {
  return props.sourceStatus !== 'connected'
    || !hasValue('mcp.courseCaptainDeg')
    || !hasValue('mcp.courseFirstOfficerDeg')
    || !props.isCommandSupported(bothCourseCommandId)
    || bothCourseValue() === null
    || groupPending(bothCourseControlGroup);
}

function requestBothCourse() {
  const course = bothCourseValue();
  if (bothCourseDisabled() || course === null) return false;
  const sent = props.requestCommand(
    bothCourseCommandId,
    bothCourseControlGroup,
    { value: course },
  );
  if (sent !== false) bothCourseDraft.value = '';
  return sent;
}

function bothNavInput() {
  return commandNumberInput(
    bothNavCommandId,
    { min: 108, max: 117.95, step: 0.05 },
  );
}

function bothNavFrequency() {
  return steppedNumber(bothNavFrequencyDraft.value, bothNavInput());
}

function bothNavDisabled() {
  return props.sourceStatus !== 'connected'
    || !hasValue('radios.nav1ActiveMhz')
    || !hasValue('radios.nav2ActiveMhz')
    || !props.isCommandSupported(bothNavCommandId)
    || bothNavFrequency() === null
    || groupPending(bothNavControlGroup);
}

function requestBothNavFrequency() {
  const frequency = bothNavFrequency();
  if (bothNavDisabled() || frequency === null) return false;
  const sent = props.requestCommand(
    bothNavCommandId,
    bothNavControlGroup,
    { value: frequency },
  );
  if (sent !== false) bothNavFrequencyDraft.value = '';
  return sent;
}

function cockpitLightingInput() {
  return commandNumberInput(
    cockpitLightingCommandId,
    { min: 0, max: 100, step: 1 },
  );
}

function cockpitLightingValue() {
  return steppedNumber(cockpitLightingDraft.value, cockpitLightingInput());
}

function cockpitLightingGroupText(fieldIds) {
  if (!fieldIds.every(hasValue)) return '--';
  const values = fieldIds.map((fieldId) => value(fieldId));
  if (!values.every((current) => typeof current === 'number' && Number.isFinite(current))) return '--';
  return values.every((current) => current === values[0]) ? `${values[0]}%` : 'MIXED';
}

function cockpitLightingDisabled() {
  return props.sourceStatus !== 'connected'
    || !cockpitLightingFieldIds.every(hasValue)
    || !props.isCommandSupported(cockpitLightingCommandId)
    || cockpitLightingValue() === null
    || groupPending(cockpitLightingControlGroup);
}

function requestCockpitLighting() {
  const brightness = cockpitLightingValue();
  if (cockpitLightingDisabled() || brightness === null) return false;
  return props.requestCommand(
    cockpitLightingCommandId,
    cockpitLightingControlGroup,
    { value: brightness },
  );
}

function controlValue(control) {
  const current = value(control.fieldId);
  return typeof current === 'boolean'
    || typeof current === 'string'
    || (typeof current === 'number' && Number.isFinite(current))
    ? current
    : null;
}

function controlValueText(control) {
  const current = controlValue(control);
  const activeAction = control.actions?.find((action) => Object.is(action.value, current));
  return activeAction?.label || valueText(control.fieldId);
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

function actionDisabled(control, actionId) {
  const action = control.actions?.find((candidate) => candidate.id === actionId);
  const target = action?.value;
  return props.sourceStatus !== 'connected'
    || controlValue(control) === null
    || Object.is(controlValue(control), target)
    || (action?.commandId
      ? !props.isCommandSupported(action.commandId)
      : !actionSupported(actionId))
    || groupPending(control.groupId);
}

function requestControlAction(control, actionId) {
  if (actionDisabled(control, actionId)) return false;
  const action = control.actions?.find((candidate) => candidate.id === actionId);
  if (action?.commandId) {
    return props.requestCommand(action.commandId, control.groupId, action.commandInput || {});
  }
  return props.requestAction(actionId, control.groupId);
}

function coldDarkControlAtTarget(control) {
  return coldDarkLive.value
    && hasValue(control.fieldId)
    && Object.is(value(control.fieldId), control.target);
}

function coldDarkValueText(id) {
  return coldDarkLive.value ? valueText(id) : '--';
}

function coldDarkIntentDisabled(intent) {
  if (!intent || !coldDarkLive.value || !actionSupported(intent.actionId)) return true;
  if (intent.fieldId && !hasValue(intent.fieldId)) return true;
  if (groupPending(intent.groupId)) return true;
  if (intent.actionId === 'systems.electrical.groundPower.connect') {
    return transferBusesPowered.value || value('systems.electrical.groundPowerAvailable') !== true;
  }
  if (intent.actionId === 'systems.apu.start') return apuSourceState.value !== 'off';
  if (intent.actionId === 'systems.electrical.apuGenerators.connect') {
    return transferBusesPowered.value || apuSourceState.value !== 'ready';
  }
  return coldDarkControlAtTarget(intent);
}

function requestColdDarkIntent(intent) {
  if (coldDarkIntentDisabled(intent)) return false;
  return props.requestAction(intent.actionId, intent.groupId);
}

function coldDarkTargetButtonLabel(control) {
  return coldDarkControlAtTarget(control) ? control.targetLabel : `SET ${control.targetLabel}`;
}

function sourceStatusClass(ready, warning = false) {
  if (!coldDarkLive.value) return 'border-surface-200 bg-surface-50 text-gray-500';
  if (ready) return 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200';
  if (warning) return 'border-red-500/45 bg-red-500/10 text-red-200';
  return 'border-amber-500/35 bg-amber-500/5 text-gray-200';
}

function actionButtonClass(selected) {
  return selected
    ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100'
    : 'border-surface-300 bg-surface-100 text-gray-300 hover:border-surface-400 hover:bg-surface-200';
}

function indicatorClass(id, tone = 'positive') {
  if (!hasValue(id)) return 'border-surface-200 bg-surface-50 text-gray-500';
  if (value(id) !== true) return 'border-surface-200 bg-surface-50 text-gray-400';
  if (tone === 'danger') return 'border-red-500/50 bg-red-500/15 text-red-300';
  if (tone === 'warning') return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
  return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
}

function gearState(gear) {
  if (!hasValue(gear.safe) || !hasValue(gear.unsafe)) return 'unavailable';
  if (value(gear.unsafe) === true) return 'unsafe';
  if (value(gear.safe) === true) return 'down';
  return 'up';
}

function gearClass(gear) {
  const state = gearState(gear);
  if (state === 'unsafe') return 'border-red-500/50 bg-red-500/15 text-red-300';
  if (state === 'down') return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
  return 'border-surface-200 bg-surface-50 text-gray-400';
}

function sectionElement(index) {
  const section = mobileSections[index];
  return section ? document.getElementById(`pmdg-737-section-${section.id}`) : null;
}

function closeSectionMenu({ restoreFocus = false } = {}) {
  sectionMenuOpen.value = false;
  if (restoreFocus) nextTick(() => sectionMenuButton.value?.focus?.({ preventScroll: true }));
}

function openSectionMenu() {
  if (suppressRibbonClick) {
    suppressRibbonClick = false;
    return;
  }
  sectionMenuOpen.value = true;
  nextTick(() => {
    sectionMenu.value?.querySelector?.('[data-pmdg-section-choice]')?.focus?.({ preventScroll: true });
  });
}

function goToSection(index, options = {}) {
  const numericIndex = Number(index);
  if (!Number.isFinite(numericIndex)) return false;
  const boundedIndex = Math.max(0, Math.min(mobileSections.length - 1, Math.trunc(numericIndex)));
  const section = mobileSections[boundedIndex];
  const target = sectionElement(boundedIndex);
  if (!section || !target) return false;

  activeSectionIndex.value = boundedIndex;
  if (options.remember !== false) rememberSection(section.id);
  closeSectionMenu();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  target.scrollIntoView?.({
    behavior: options.behavior || (reducedMotion ? 'auto' : 'smooth'),
    block: 'start',
  });
  if (options.focus !== false) target.focus?.({ preventScroll: true });
  return true;
}

const { aircraftTabIsActive, rememberSection } = useAircraftSectionMemory({
  memoryKey: () => props.profileKey || 'bundled/msfs/pmdg-737',
  sections: () => mobileSections,
  onRestore: (sectionId) => {
    const index = mobileSections.findIndex((section) => section.id === sectionId);
    return index >= 0
      ? goToSection(index, { behavior: 'auto', focus: false, remember: false })
      : false;
  },
});

function handleSectionButtonClick(index) {
  if (suppressRibbonClick) {
    suppressRibbonClick = false;
    return;
  }
  goToSection(index);
}

function handleRibbonPointerDown(event) {
  if (event?.button != null && event.button !== 0) return;
  // Keep the two dedicated arrow targets as unambiguous taps. Swiping remains
  // available across the wider centre target, while a small pointer wobble on
  // an arrow can no longer suppress its subsequent click.
  if (event?.target?.closest?.('.pmdg-mobile-section-ribbon__neighbor')) {
    clearRibbonSwipe();
    return;
  }
  const x = Number(event?.clientX);
  const y = Number(event?.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    clearRibbonSwipe();
    return;
  }
  ribbonSwipeStart = {
    pointerId: event.pointerId,
    x,
    y,
  };
}

function clearRibbonSwipe() {
  ribbonSwipeStart = null;
}

function handleRibbonPointerUp(event) {
  const start = ribbonSwipeStart;
  clearRibbonSwipe();
  if (!start || start.pointerId !== event.pointerId) return;

  const endX = Number(event?.clientX);
  const endY = Number(event?.clientY);
  if (!Number.isFinite(endX) || !Number.isFinite(endY)) return;
  const deltaX = endX - start.x;
  const deltaY = endY - start.y;
  const ribbonWidth = sectionRibbon.value?.getBoundingClientRect?.().width || 320;
  const threshold = Math.max(44, ribbonWidth * 0.16);
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;

  const nextIndex = activeSectionIndex.value + (deltaX < 0 ? 1 : -1);
  if (nextIndex < 0 || nextIndex >= mobileSections.length) return;

  event.preventDefault?.();
  suppressRibbonClick = true;
  if (suppressRibbonClickTimer != null) window.clearTimeout(suppressRibbonClickTimer);
  suppressRibbonClickTimer = window.setTimeout(() => {
    suppressRibbonClick = false;
    suppressRibbonClickTimer = null;
  }, 400);
  goToSection(nextIndex);
}

function syncActiveSection() {
  sectionSyncTimer = null;
  if (!aircraftTabIsActive()) return;
  const ribbonBottom = sectionRibbon.value?.getBoundingClientRect?.().bottom || 0;
  const anchorY = ribbonBottom + 16;
  let nextIndex = 0;

  for (let index = 0; index < mobileSections.length; index += 1) {
    const target = sectionElement(index);
    if (!target || target.getBoundingClientRect().top > anchorY) break;
    nextIndex = index;
  }

  const scroller = sectionScrollTarget;
  if (
    scroller
    && scroller !== window
    && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24
  ) {
    nextIndex = mobileSections.length - 1;
  }
  activeSectionIndex.value = nextIndex;
  rememberSection(mobileSections[nextIndex]?.id);
}

function scheduleSectionSync() {
  if (sectionSyncTimer != null || !aircraftTabIsActive()) return;
  sectionSyncTimer = window.setTimeout(syncActiveSection, 32);
}

function handleDocumentKeydown(event) {
  if (!sectionMenuOpen.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSectionMenu({ restoreFocus: true });
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = Array.from(sectionMenu.value?.querySelectorAll?.('button:not(:disabled)') || []);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

useDocumentEvent('keydown', handleDocumentKeydown);

async function refreshAuthorization() {
  if (typeof electronApi?.getPmdg737SdkEulaStatus !== 'function') {
    authorizationState.value = 'unavailable';
    return;
  }
  const result = await electronApi.getPmdg737SdkEulaStatus();
  authorizationState.value = result?.accepted === true ? 'accepted' : 'required';
}

async function openSdkEula() {
  authorizationBusy.value = true;
  authorizationError.value = '';
  try {
    const result = await electronApi?.openPmdg737SdkEula?.();
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
    const result = await electronApi?.acceptPmdg737SdkEula?.();
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

  sectionScrollTarget = document.getElementById('vue-main-root') || window;
  sectionScrollTarget.addEventListener?.('scroll', scheduleSectionSync, { passive: true });
  window.addEventListener('resize', scheduleSectionSync, { passive: true });
  nextTick(scheduleSectionSync);
});

onBeforeUnmount(() => {
  sectionScrollTarget?.removeEventListener?.('scroll', scheduleSectionSync);
  window.removeEventListener('resize', scheduleSectionSync);
  if (sectionSyncTimer != null) window.clearTimeout(sectionSyncTimer);
  if (suppressRibbonClickTimer != null) window.clearTimeout(suppressRibbonClickTimer);
  sectionScrollTarget = null;
  sectionSyncTimer = null;
  suppressRibbonClickTimer = null;
});
</script>

<template>
  <div
    class="p-3 sm:p-4 space-y-5"
    data-aircraft-template="pmdg-737"
    :data-pmdg-737-variant="variant"
    :data-aircraft-sdk-status="sdkSourceStatus"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h3 class="text-base font-semibold text-gray-100">PMDG Boeing {{ variant }}</h3>
      </div>
      <span class="text-[10px] uppercase tracking-widest text-gray-500">{{ sdkSourceStatus }}</span>
    </div>

    <div v-if="showAuthorization" class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <div class="text-sm font-semibold text-amber-200">PMDG 737 SDK authorization required</div>
      <p class="mt-1 text-xs leading-relaxed text-amber-100/75">
        PMDG requires SDK applications to show its SDK EULA and obtain your explicit acceptance. This can only be completed in the Flight Fabric desktop app.
      </p>
      <template v-if="electronApi">
        <button type="button" class="ff-button-secondary mt-3 px-3 py-2 text-xs" :disabled="authorizationBusy" @click="openSdkEula">Open installed PMDG SDK EULA</button>
        <label class="mt-3 flex items-start gap-2 text-xs text-gray-300">
          <input v-model="eulaConfirmed" type="checkbox" class="mt-0.5" :disabled="!eulaOpened || authorizationBusy" />
          <span>I have read and accept the installed PMDG 737 SDK EULA.</span>
        </label>
        <button type="button" class="ff-button-primary mt-3 px-3 py-2 text-xs" :disabled="!eulaOpened || !eulaConfirmed || authorizationBusy" @click="acceptSdkEula">Accept and restart Flight Fabric</button>
      </template>
      <p v-else class="mt-3 text-xs text-gray-400">Open this Aircraft page in the desktop app to authorize the SDK host; phones cannot accept it.</p>
      <p v-if="authorizationError" class="mt-2 text-xs text-red-300">{{ authorizationError }}</p>
    </div>

    <div
      v-else-if="sdkStatusNotice"
      class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
      role="status"
      data-aircraft-sdk-notice="pmdg-737"
    >
      <div class="text-sm font-semibold text-amber-200">PMDG 737 SDK not ready</div>
      <p class="mt-1 text-xs leading-relaxed text-amber-100/75">{{ sdkStatusNotice }}</p>
    </div>

    <div class="pmdg-mobile-section-ribbon-anchor">
      <nav
        ref="sectionRibbon"
        class="pmdg-mobile-section-ribbon"
        aria-label="PMDG 737 page sections"
        data-no-swipe
        @pointerdown="handleRibbonPointerDown"
        @pointerup="handleRibbonPointerUp"
        @pointercancel="clearRibbonSwipe"
      >
        <button
          type="button"
          class="pmdg-mobile-section-ribbon__neighbor"
          :disabled="!previousSection"
          :aria-label="previousSection ? `Open previous section: ${previousSection.title}` : 'Already at the first section'"
          @pointerdown.stop="clearRibbonSwipe"
          @pointerup.stop="clearRibbonSwipe"
          @click="handleSectionButtonClick(activeSectionIndex - 1)"
        >
          <span aria-hidden="true">&lsaquo;</span>
          <span>{{ previousSection?.label || 'Start' }}</span>
        </button>
        <button
          ref="sectionMenuButton"
          type="button"
          class="pmdg-mobile-section-ribbon__current"
          aria-haspopup="dialog"
          :aria-expanded="sectionMenuOpen ? 'true' : 'false'"
          aria-controls="pmdg-737-section-menu"
          aria-label="Open all PMDG 737 sections"
          @click="openSectionMenu"
        >
          <strong>{{ activeSection.label }}</strong>
          <small>{{ activeSectionIndex + 1 }} of {{ mobileSections.length }} &middot; All sections</small>
        </button>
        <button
          type="button"
          class="pmdg-mobile-section-ribbon__neighbor"
          :disabled="!nextSection"
          :aria-label="nextSection ? `Open next section: ${nextSection.title}` : 'Already at the final section'"
          @pointerdown.stop="clearRibbonSwipe"
          @pointerup.stop="clearRibbonSwipe"
          @click="handleSectionButtonClick(activeSectionIndex + 1)"
        >
          <span>{{ nextSection?.label || 'End' }}</span>
          <span aria-hidden="true">&rsaquo;</span>
        </button>
      </nav>
    </div>

    <button
      type="button"
      class="pmdg-hot-group-launcher"
      data-pmdg-hot-group-launcher="initial-power"
      aria-haspopup="dialog"
      aria-controls="pmdg-737-initial-power"
      :aria-expanded="initialPowerOpen ? 'true' : 'false'"
      @click="initialPowerOpen = true"
    >
      <span class="pmdg-hot-group-launcher__copy">
        <strong>Initial power</strong>
        <small>{{ coldDarkSummary }}</small>
      </span>
      <span class="pmdg-hot-group-launcher__open">OPEN <span aria-hidden="true">&#8594;</span></span>
    </button>

    <div
      v-if="sectionMenuOpen"
      id="pmdg-737-section-menu"
      class="pmdg-section-menu-overlay ff-keyboard-safe-overlay"
      data-no-swipe
      @click.self="closeSectionMenu({ restoreFocus: true })"
    >
      <section
        ref="sectionMenu"
        class="pmdg-section-menu"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pmdg-737-section-menu-title"
      >
        <header class="pmdg-section-menu__header">
          <div>
            <div class="dashboard-section-kicker">PMDG 737</div>
            <h4 id="pmdg-737-section-menu-title">Choose a section</h4>
          </div>
          <button type="button" class="pmdg-section-menu__close" aria-label="Close section menu" @click="closeSectionMenu({ restoreFocus: true })">&times;</button>
        </header>
        <div class="pmdg-section-menu__choices">
          <button
            v-for="(section, index) in mobileSections"
            :key="section.id"
            type="button"
            data-pmdg-section-choice
            :aria-current="index === activeSectionIndex ? 'location' : undefined"
            @click="goToSection(index)"
          >
            <span class="pmdg-section-menu__number">{{ index + 1 }}</span>
            <span class="min-w-0">
              <strong>{{ section.title }}</strong>
              <small>{{ section.detail }}</small>
            </span>
          </button>
        </div>
      </section>
    </div>

    <AircraftHotGroupModal
      :open="initialPowerOpen"
      modal-id="pmdg-737-initial-power"
      title="Initial power"
      description="Reference shortcuts — use your normal procedure."
      close-label="Close Initial power quick group"
      @close="initialPowerOpen = false"
    >
      <div class="space-y-3" data-pmdg-hot-group="initial-power">

      <div class="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <article class="rounded-xl border border-surface-200 bg-surface-50 p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div>
              <div class="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">Electrical</div>
              <h5 class="mt-0.5 text-xs font-semibold text-gray-200">Common electrical starting point</h5>
            </div>
            <span class="pmdg-location-tag" data-pmdg-location="forward-overhead">FORWARD OVERHEAD</span>
          </div>
          <div class="space-y-2">
            <div
              v-for="control in coldDarkPowerControls"
              :key="control.fieldId"
              class="flex min-h-12 items-center gap-2 rounded-lg border border-surface-200 bg-surface-100 p-2 text-gray-200"
              :data-aircraft-control-group="control.groupId"
            >
              <div class="min-w-0 flex-1">
                <div class="text-[9px] font-semibold tracking-wide">{{ control.title }}</div>
                <div class="mt-0.5 font-mono text-xs">{{ coldDarkValueText(control.fieldId) }}</div>
              </div>
              <button
                type="button"
                class="min-h-9 min-w-20 rounded border border-current/40 px-2 text-[9px] font-bold disabled:opacity-55"
                :data-aircraft-action="control.actionId"
                :disabled="coldDarkIntentDisabled(control)"
                @click="requestColdDarkIntent(control)"
              >{{ coldDarkTargetButtonLabel(control) }}</button>
            </div>
          </div>
          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-gray-500">
            <span :class="coldDarkLive && value('systems.electrical.batteryDischarge') === true ? 'text-amber-300' : ''">BAT DISCHARGE {{ coldDarkValueText('systems.electrical.batteryDischarge') }}</span>
            <span :class="coldDarkLive && value('systems.electrical.standbyPowerOff') === true ? 'text-amber-300' : ''">STBY PWR OFF {{ coldDarkValueText('systems.electrical.standbyPowerOff') }}</span>
          </div>
        </article>

        <article class="rounded-xl border border-surface-200 bg-surface-50 p-3">
          <div class="mb-2 flex items-start justify-between gap-2">
            <div>
              <div class="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">Power source</div>
              <h5 class="mt-0.5 text-xs font-semibold text-gray-200">Use ground power or the APU as appropriate</h5>
            </div>
            <span class="pmdg-location-tag" data-pmdg-location="forward-overhead">FORWARD OVERHEAD</span>
          </div>
          <div class="space-y-2">
            <div class="rounded-lg border p-2.5" :class="sourceStatusClass(transferBusesPowered)">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[9px] font-semibold tracking-wide">AC TRANSFER BUSES</span>
                <span class="font-mono text-[10px] font-bold">{{ !coldDarkLive ? 'READBACK UNAVAILABLE' : transferBusesPowered ? 'POWERED' : 'NOT POWERED' }}</span>
              </div>
              <div class="mt-1 flex gap-3 text-[9px] opacity-75">
                <span>BUS 1 {{ coldDarkValueText('systems.electrical.transferBus1Powered') }}</span>
                <span>BUS 2 {{ coldDarkValueText('systems.electrical.transferBus2Powered') }}</span>
              </div>
            </div>
            <div class="flex min-h-14 items-center gap-2 rounded-lg border border-surface-200 bg-surface-100 p-2.5">
              <div class="min-w-0 flex-1">
                <div class="text-[9px] font-semibold text-gray-300">GROUND POWER</div>
                <div class="mt-0.5 text-[9px] text-gray-500">{{ !coldDarkLive ? '--' : value('systems.electrical.groundPowerAvailable') === true ? 'AVAILABLE' : 'NOT AVAILABLE' }}</div>
              </div>
              <button
                type="button"
                class="min-h-9 rounded border border-cyan-400/45 bg-cyan-400/10 px-3 text-[9px] font-bold text-cyan-100 disabled:opacity-40"
                data-aircraft-action="systems.electrical.groundPower.connect"
                :disabled="coldDarkIntentDisabled({ actionId: 'systems.electrical.groundPower.connect', groupId: 'systems.electrical.powerSource' })"
                @click="requestColdDarkIntent({ actionId: 'systems.electrical.groundPower.connect', groupId: 'systems.electrical.powerSource' })"
              >CONNECT GPU</button>
            </div>
            <div class="flex min-h-14 items-center gap-2 rounded-lg border p-2.5" :class="sourceStatusClass(apuSourceState === 'ready', apuSourceState === 'fault')">
              <div class="min-w-0 flex-1">
                <div class="text-[9px] font-semibold">APU · {{ apuSourceState.toUpperCase() }}</div>
                <div class="mt-0.5 font-mono text-[9px] opacity-75">SELECTOR {{ coldDarkValueText('systems.apuMode') }} · EGT {{ coldDarkValueText('systems.apuEgt') }} · LOW OIL {{ coldDarkValueText('systems.apuLowOilPressure') }}</div>
              </div>
              <button
                v-if="apuSourceState === 'off'"
                type="button"
                class="min-h-9 rounded border border-cyan-400/45 bg-cyan-400/10 px-3 text-[9px] font-bold text-cyan-100 disabled:opacity-40"
                data-aircraft-action="systems.apu.start"
                :disabled="coldDarkIntentDisabled({ actionId: 'systems.apu.start', groupId: 'systems.apu' })"
                @click="requestColdDarkIntent({ actionId: 'systems.apu.start', groupId: 'systems.apu' })"
              >START APU</button>
              <button
                v-else-if="apuSourceState === 'ready'"
                type="button"
                class="min-h-9 rounded border border-cyan-400/45 bg-cyan-400/10 px-3 text-[9px] font-bold text-cyan-100 disabled:opacity-40"
                data-aircraft-action="systems.electrical.apuGenerators.connect"
                :disabled="coldDarkIntentDisabled({ actionId: 'systems.electrical.apuGenerators.connect', groupId: 'systems.electrical.powerSource' })"
                @click="requestColdDarkIntent({ actionId: 'systems.electrical.apuGenerators.connect', groupId: 'systems.electrical.powerSource' })"
              >CONNECT APU</button>
              <span v-else class="text-[9px] font-semibold opacity-70">{{ apuSourceState === 'starting' ? 'MONITOR' : 'CHECK' }}</span>
            </div>
          </div>
        </article>

        <article class="rounded-xl border border-surface-200 bg-surface-50 p-3">
          <div class="mb-2 flex items-start justify-between gap-2">
            <div>
              <div class="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">IRS</div>
              <h5 class="mt-0.5 text-xs font-semibold text-gray-200">Mode selectors and alignment indications</h5>
            </div>
            <span class="pmdg-location-tag" data-pmdg-location="aft-overhead">AFT OVERHEAD</span>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <div
              v-for="control in coldDarkIrsControls"
              :key="control.fieldId"
              class="flex min-h-12 items-center gap-2 rounded-lg border border-surface-200 bg-surface-100 p-2 text-gray-200"
              :data-aircraft-control-group="control.groupId"
            >
              <div class="min-w-0 flex-1">
                <div class="text-[9px] font-semibold tracking-wide">{{ control.title }}</div>
                <div class="mt-0.5 font-mono text-xs">{{ coldDarkValueText(control.fieldId) }}</div>
              </div>
              <button type="button" class="min-h-9 rounded border border-current/40 px-2 text-[9px] font-bold disabled:opacity-55" :data-aircraft-action="control.actionId" :disabled="coldDarkIntentDisabled(control)" @click="requestColdDarkIntent(control)">{{ coldDarkTargetButtonLabel(control) }}</button>
            </div>
          </div>
          <div class="mt-2 flex flex-wrap gap-2 text-[9px] text-gray-500">
            <span>IRS L ALIGN {{ coldDarkValueText('systems.irs.leftAlign') }}</span>
            <span>IRS R ALIGN {{ coldDarkValueText('systems.irs.rightAlign') }}</span>
            <span :class="coldDarkLive && (value('systems.irs.leftFault') === true || value('systems.irs.rightFault') === true) ? 'text-red-300' : ''">IRS FAULT {{ !coldDarkLive ? '--' : value('systems.irs.leftFault') === true || value('systems.irs.rightFault') === true ? 'ON' : 'OFF' }}</span>
          </div>
        </article>
      </div>

      <details class="rounded-xl border border-surface-200 bg-surface-50">
        <summary class="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-gray-200 marker:content-none">
          <span>
            <span class="block text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">Related overhead shortcuts</span>
            <span class="mt-0.5 block text-xs font-semibold">Yaw damper, emergency lights and window heat</span>
          </span>
          <span class="shrink-0 text-[9px] text-gray-500">{{ coldDarkRelatedControls.length }} CONTROLS · OPTIONAL</span>
        </summary>
        <div class="border-t border-surface-200 p-3">
          <p class="mb-2 text-[9px] leading-relaxed text-gray-500">
            Convenience controls often used around initial setup. Each value is an independent PMDG readback.
          </p>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <div v-for="control in coldDarkRelatedControls" :key="control.fieldId" class="flex min-h-12 items-center gap-2 rounded-lg border border-surface-200 bg-surface-100 p-2 text-gray-200" :data-aircraft-control-group="control.groupId">
              <div class="min-w-0 flex-1"><div class="text-[9px] font-semibold tracking-wide">{{ control.title }}</div><div class="mt-0.5 font-mono text-xs">{{ coldDarkValueText(control.fieldId) }}</div></div>
              <button type="button" class="min-h-9 rounded border border-current/40 px-2 text-[9px] font-bold disabled:opacity-55" :data-aircraft-action="control.actionId" :disabled="coldDarkIntentDisabled(control)" @click="requestColdDarkIntent(control)">{{ coldDarkTargetButtonLabel(control) }}</button>
            </div>
          </div>
        </div>
      </details>
      </div>
    </AircraftHotGroupModal>

    <section
      id="pmdg-737-section-mcp"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="mcp"
      tabindex="-1"
    >
      <div class="pmdg-section-heading">
        <div class="dashboard-section-kicker">Mode Control Panel</div>
        <span class="pmdg-location-tag" data-pmdg-location="glareshield">GLARESHIELD</span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        <form v-for="field in mcpWindows" :key="field.id" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="mcpControlGroup(field)" @submit.prevent="requestMcpAction(field)">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">{{ field.label }}</div>
          <div class="mt-1 flex items-baseline gap-1"><span class="font-mono text-lg font-semibold text-gray-100">{{ formatWindow(field) }}</span><span v-if="field.unit" class="text-[10px] text-gray-500">{{ field.unit }}</span></div>
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
      <form
        class="mt-3 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] p-3"
        data-aircraft-control-group="mcp.courseBoth"
        data-pmdg-course-both-control
        @submit.prevent="requestBothCourse"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div class="min-w-0 flex-1">
            <div class="text-[10px] font-semibold tracking-widest text-cyan-100">SET BOTH COURSE WINDOWS</div>
            <p class="mt-1 text-[11px] leading-relaxed text-gray-400">
              Set the captain and first-officer MCP courses together. Voice: &ldquo;set courses two seven zero&rdquo;.
            </p>
          </div>
          <div class="flex min-w-0 gap-1.5 sm:w-72">
            <div class="relative min-w-0 flex-1">
              <input
                v-model="bothCourseDraft"
                class="h-10 w-full rounded border border-surface-300 bg-surface-100 px-2 pr-8 font-mono text-sm text-gray-100 disabled:opacity-45"
                type="number"
                inputmode="numeric"
                :min="bothCourseInput().min"
                :max="bothCourseInput().max"
                :step="bothCourseInput().step"
                placeholder="270"
                aria-label="Set both MCP course windows"
              />
              <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[9px] text-gray-500">&deg;</span>
            </div>
            <button
              type="submit"
              class="h-10 rounded border border-cyan-400/50 bg-cyan-400/10 px-3 text-[10px] font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-45"
              data-aircraft-command="flightGuidance.course.setBoth"
              :disabled="bothCourseDisabled()"
            >
              SET BOTH
            </button>
          </div>
        </div>
      </form>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <button v-for="mode in afdsModes" :key="mode.id" type="button" class="rounded border px-2 py-1 text-[10px] font-semibold tracking-wide disabled:cursor-not-allowed disabled:opacity-60" :class="indicatorClass(mode.id)" :data-aircraft-action="afdsActionId(mode) || undefined" :disabled="afdsDisabled(mode)" @click="requestAfdsAction(mode)">{{ mode.label }} <span class="opacity-70">{{ valueText(mode.id) }}</span></button>
      </div>
    </section>

    <section
      id="pmdg-737-section-radios"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="radios"
      tabindex="-1"
    >
      <div class="pmdg-section-heading">
        <div class="dashboard-section-kicker">Navigation Radios</div>
        <span class="pmdg-location-tag" data-pmdg-location="pedestal">PEDESTAL</span>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div v-for="radio in navRadios" :key="radio.id" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="radio.id">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[10px] font-semibold tracking-widest text-gray-300">{{ radio.label }}</div>
            <div class="flex items-baseline gap-2 font-mono"><span class="text-sm text-gray-400">{{ formatFrequency(radio.active) }}</span><span class="text-gray-600">/</span><span class="text-lg font-semibold text-cyan-100">{{ formatFrequency(radio.standby) }}</span></div>
          </div>
          <div class="mt-2 grid grid-cols-5 gap-1.5">
            <button type="button" class="min-h-9 rounded border border-surface-300 bg-surface-100 text-[10px] font-semibold text-gray-300 disabled:opacity-45" :data-aircraft-action="`${radio.id}.outer.decrement`" :disabled="radioActionDisabled(radio, `${radio.id}.outer.decrement`)" @click="requestRadioAction(radio, `${radio.id}.outer.decrement`)">-1</button>
            <button type="button" class="min-h-9 rounded border border-surface-300 bg-surface-100 text-[10px] font-semibold text-gray-300 disabled:opacity-45" :data-aircraft-action="`${radio.id}.inner.decrement`" :disabled="radioActionDisabled(radio, `${radio.id}.inner.decrement`)" @click="requestRadioAction(radio, `${radio.id}.inner.decrement`)">-.05</button>
            <button type="button" class="min-h-9 rounded border border-cyan-400/50 bg-cyan-400/10 text-sm font-semibold text-cyan-100 disabled:opacity-45" :data-aircraft-action="`${radio.id}.transfer`" :disabled="radioActionDisabled(radio, `${radio.id}.transfer`)" @click="requestRadioAction(radio, `${radio.id}.transfer`)">&#x21C4;</button>
            <button type="button" class="min-h-9 rounded border border-surface-300 bg-surface-100 text-[10px] font-semibold text-gray-300 disabled:opacity-45" :data-aircraft-action="`${radio.id}.inner.increment`" :disabled="radioActionDisabled(radio, `${radio.id}.inner.increment`)" @click="requestRadioAction(radio, `${radio.id}.inner.increment`)">+.05</button>
            <button type="button" class="min-h-9 rounded border border-surface-300 bg-surface-100 text-[10px] font-semibold text-gray-300 disabled:opacity-45" :data-aircraft-action="`${radio.id}.outer.increment`" :disabled="radioActionDisabled(radio, `${radio.id}.outer.increment`)" @click="requestRadioAction(radio, `${radio.id}.outer.increment`)">+1</button>
          </div>
          <div class="mt-1.5 flex justify-between text-[9px] uppercase tracking-wider text-gray-600"><span>Active</span><span>Standby tuned by PMDG event</span></div>
        </div>
      </div>
      <form
        class="mt-3 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] p-3"
        data-aircraft-control-group="radios.navBoth"
        data-pmdg-nav-both-control
        @submit.prevent="requestBothNavFrequency"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div class="min-w-0 flex-1">
            <div class="text-[10px] font-semibold tracking-widest text-cyan-100">SET BOTH ACTIVE</div>
            <p class="mt-1 text-[11px] leading-relaxed text-gray-400">
              Tune NAV 1 and NAV 2 active frequencies together. Voice: &ldquo;set nav radios one one zero decimal three&rdquo;.
            </p>
          </div>
          <div class="flex min-w-0 gap-1.5 sm:w-72">
            <div class="relative min-w-0 flex-1">
              <input
                v-model="bothNavFrequencyDraft"
                class="h-10 w-full rounded border border-surface-300 bg-surface-100 px-2 pr-12 font-mono text-sm text-gray-100 disabled:opacity-45"
                type="number"
                inputmode="decimal"
                :min="bothNavInput().min"
                :max="bothNavInput().max"
                :step="bothNavInput().step"
                placeholder="110.30"
                aria-label="Set both active NAV radio frequencies"
              />
              <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[9px] text-gray-500">MHz</span>
            </div>
            <button
              type="submit"
              class="h-10 rounded border border-cyan-400/50 bg-cyan-400/10 px-3 text-[10px] font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-45"
              data-aircraft-command="radios.nav.setBothActive"
              :disabled="bothNavDisabled()"
            >
              SET BOTH
            </button>
          </div>
        </div>
      </form>
    </section>

    <section
      id="pmdg-737-section-exterior"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="exterior"
      tabindex="-1"
    >
      <div class="pmdg-section-heading">
        <div class="dashboard-section-kicker">Exterior Lights</div>
        <span class="pmdg-location-tag" data-pmdg-location="forward-overhead">FORWARD OVERHEAD</span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div v-for="control in exteriorControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
          <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(control) }}</span></div>
          <div class="grid gap-1.5" :class="control.actions.length === 3 ? 'grid-cols-3' : 'grid-cols-2'">
            <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold leading-tight disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
          </div>
        </div>
      </div>
    </section>

    <section
      id="pmdg-737-section-cockpit-lighting"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="cockpit-lighting"
      tabindex="-1"
    >
      <div class="pmdg-section-heading">
        <div class="dashboard-section-kicker">Cockpit Lighting</div>
        <span class="text-[9px] font-semibold tracking-widest text-gray-500">16 DIMMERS</span>
      </div>
      <form
        class="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.06] p-4"
        data-aircraft-control-group="lighting.cockpit"
        data-pmdg-cockpit-lighting-control
        @submit.prevent="requestCockpitLighting"
      >
        <div class="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-gray-100">Set the flight deck together</div>
            <p class="mt-1 max-w-3xl text-xs leading-relaxed text-gray-400">
              Applies one level to panel backlighting, AFDS and pedestal flood lighting, plus every operable captain, First Officer, upper and lower display-unit dimmer. Voice: &ldquo;set cockpit lighting fifty percent&rdquo;.
            </p>
            <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div v-for="group in cockpitLightingGroups" :key="group.label" class="rounded-lg border border-surface-200 bg-surface-100/70 px-3 py-2">
                <div class="text-[9px] uppercase tracking-widest text-gray-500">{{ group.label }}</div>
                <div class="mt-1 font-mono text-sm font-semibold text-gray-200">{{ cockpitLightingGroupText(group.fields) }}</div>
              </div>
            </div>
          </div>
          <div class="w-full rounded-lg border border-surface-200 bg-surface-100 p-3 lg:w-[25rem]">
            <div class="mb-2 flex items-center justify-between gap-3">
              <label for="pmdg-737-cockpit-lighting" class="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Target brightness</label>
              <output class="font-mono text-lg font-semibold text-cyan-100">{{ cockpitLightingValue() ?? '--' }}%</output>
            </div>
            <input
              id="pmdg-737-cockpit-lighting"
              v-model="cockpitLightingDraft"
              class="h-8 w-full cursor-pointer accent-cyan-400 disabled:cursor-not-allowed disabled:opacity-45"
              type="range"
              :min="cockpitLightingInput().min"
              :max="cockpitLightingInput().max"
              :step="cockpitLightingInput().step"
              :disabled="!props.isCommandSupported(cockpitLightingCommandId) || groupPending(cockpitLightingControlGroup)"
              aria-label="Cockpit lighting target percentage"
            />
            <div class="mt-2 flex gap-2">
              <div class="relative min-w-0 flex-1">
                <input
                  v-model="cockpitLightingDraft"
                  class="h-10 w-full rounded border border-surface-300 bg-surface-50 px-2 pr-9 font-mono text-sm text-gray-100 disabled:opacity-45"
                  type="number"
                  inputmode="numeric"
                  :min="cockpitLightingInput().min"
                  :max="cockpitLightingInput().max"
                  :step="cockpitLightingInput().step"
                  aria-label="Cockpit lighting percentage"
                />
                <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-gray-500">%</span>
              </div>
              <button
                type="submit"
                class="h-10 rounded border border-cyan-400/55 bg-cyan-400/12 px-4 text-[10px] font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-45"
                data-aircraft-command="configuration.lighting.cockpit"
                :disabled="cockpitLightingDisabled()"
              >
                SET ALL
              </button>
            </div>
          </div>
        </div>
        <p class="mt-3 text-[10px] leading-relaxed text-gray-500">
          Discrete dome and spot lights, chart/map light mechanisms, EFB buttons and the inoperative lower-DU inner knob are intentionally unchanged.
        </p>
      </form>
    </section>

    <section
      id="pmdg-737-section-cabin"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="cabin"
      tabindex="-1"
    >
      <div class="pmdg-section-heading">
        <div class="dashboard-section-kicker">Cabin &amp; Visibility</div>
        <span class="pmdg-location-tag" data-pmdg-location="forward-overhead">FORWARD OVERHEAD</span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        <div v-for="control in cabinControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
          <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(control) }}</span></div>
          <div class="grid gap-1.5" :class="control.actions.length === 4 ? 'grid-cols-4' : 'grid-cols-3'">
            <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
          </div>
        </div>
      </div>
    </section>

    <div class="grid grid-cols-1 gap-4 2xl:grid-cols-2">
      <section
        id="pmdg-737-section-flight-controls"
        class="pmdg-mobile-navigable-section"
        data-pmdg-737-section="flight-controls"
        tabindex="-1"
      >
        <div class="pmdg-section-heading">
          <div class="dashboard-section-kicker">Flight Controls</div>
        </div>
        <div class="grid grid-cols-2 gap-2 mb-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3"><div class="text-[9px] uppercase tracking-widest text-gray-500">Flap needle L</div><div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ valueText('flightControls.flapNeedleLeft') }}</div></div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3"><div class="text-[9px] uppercase tracking-widest text-gray-500">Flap needle R</div><div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ valueText('flightControls.flapNeedleRight') }}</div></div>
        </div>
        <div class="mb-2 rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="flapHandleControl.groupId">
          <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ flapHandleControl.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(flapHandleControl) }}</span></div>
          <div class="grid grid-cols-3 gap-1.5 sm:grid-cols-9">
            <button v-for="action in flapHandleControl.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(flapHandleControl) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(flapHandleControl) === action.value" :disabled="actionDisabled(flapHandleControl, action.id)" @click="requestControlAction(flapHandleControl, action.id)">{{ action.label }}</button>
          </div>
        </div>
        <div class="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div v-for="control in flightControlSelectors" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
            <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(control) }}</span></div>
            <div class="grid grid-cols-2 gap-1.5">
              <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
            </div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div v-for="indicator in flightControlIndicators" :key="indicator.id" class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass(indicator.id, indicator.tone)">{{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span></div>
        </div>
      </section>

      <section
        id="pmdg-737-section-gear-brakes"
        class="pmdg-mobile-navigable-section"
        data-pmdg-737-section="gear-brakes"
        tabindex="-1"
      >
        <div class="pmdg-section-heading">
          <div class="dashboard-section-kicker">Gear &amp; Brakes</div>
          <span class="pmdg-location-tag" data-pmdg-location="main-panel-control-stand">MAIN PANEL · CONTROL STAND</span>
        </div>
        <div class="grid grid-cols-3 gap-2 mb-2">
          <div v-for="gear in gearIndicators" :key="gear.label" class="rounded-lg border p-3 text-center" :class="gearClass(gear)"><div class="text-[10px] font-semibold">{{ gear.label }}</div><div class="mt-1 text-xs opacity-80">{{ gearState(gear).toUpperCase() }}</div></div>
        </div>
        <div class="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div v-for="control in [gearHandleControl, parkingBrakeControl]" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
            <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(control) }}</span></div>
            <div class="grid gap-1.5" :class="control.actions.length === 3 ? 'grid-cols-3' : 'grid-cols-2'">
              <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
            </div>
          </div>
        </div>
        <div class="mb-2 rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="autobrakeControl.groupId">
          <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ autobrakeControl.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(autobrakeControl) }}</span></div>
          <div class="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
            <button v-for="action in autobrakeControl.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(autobrakeControl) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(autobrakeControl) === action.value" :disabled="actionDisabled(autobrakeControl, action.id)" @click="requestControlAction(autobrakeControl, action.id)">{{ action.label }}</button>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('gear.autobrakeDisarm', 'danger')">AUTOBRAKE DISARM <span class="float-right opacity-70">{{ valueText('gear.autobrakeDisarm') }}</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('gear.antiSkidInoperative', 'danger')">ANTI-SKID INOP <span class="float-right opacity-70">{{ valueText('gear.antiSkidInoperative') }}</span></div>
        </div>
      </section>

      <section
        id="pmdg-737-section-systems"
        class="pmdg-mobile-navigable-section 2xl:col-span-2"
        data-pmdg-737-section="systems"
        tabindex="-1"
      >
        <div class="pmdg-section-heading">
          <div class="dashboard-section-kicker">Air &amp; Systems</div>
          <span class="pmdg-location-tag" data-pmdg-location="forward-overhead">FORWARD OVERHEAD</span>
        </div>
        <div class="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="apuSelectorControl.groupId">
            <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ apuSelectorControl.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(apuSelectorControl) }}</span></div>
            <div class="grid grid-cols-3 gap-1.5">
              <button v-for="action in apuSelectorControl.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(apuSelectorControl) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(apuSelectorControl) === action.value" :disabled="actionDisabled(apuSelectorControl, action.id)" @click="requestControlAction(apuSelectorControl, action.id)">{{ action.label }}</button>
            </div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">APU EGT</div>
            <div class="mt-2 font-mono text-lg font-semibold text-gray-100">{{ valueText('systems.apuEgt') }}</div>
          </div>
        </div>
        <div class="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="control in airControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
            <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(control) }}</span></div>
            <div class="grid gap-1.5" :class="control.actions.length === 3 ? 'grid-cols-3' : 'grid-cols-2'">
              <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
            </div>
          </div>
        </div>
        <div class="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div v-for="control in antiIceControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
            <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ controlValueText(control) }}</span></div>
            <div class="grid grid-cols-2 gap-1.5">
              <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
            </div>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div v-for="indicator in systemIndicators" :key="indicator.id" class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass(indicator.id, indicator.tone)">{{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span></div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pmdg-section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.pmdg-location-tag {
  flex: 0 0 auto;
  border: 1px solid rgb(148 163 184 / 0.2);
  border-radius: 999px;
  padding: 0.125rem 0.4rem;
  color: rgb(148 163 184 / 0.72);
  font-size: 0.48rem;
  font-weight: 700;
  letter-spacing: 0.11em;
  line-height: 1.2;
  text-transform: uppercase;
  white-space: nowrap;
}

.pmdg-hot-group-launcher {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-height: 3.7rem;
  align-items: center;
  gap: 1rem;
  width: 100%;
  padding: 0.7rem 0.85rem;
  border: 1px solid rgb(var(--primary) / 0.32);
  border-radius: 11px;
  background:
    linear-gradient(110deg, rgb(var(--primary) / 0.11), transparent 34%),
    rgb(var(--panel-subtle) / 0.84);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.025);
  color: rgb(var(--foreground));
  text-align: left;
  transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
}

.pmdg-hot-group-launcher:hover,
.pmdg-hot-group-launcher:focus-visible {
  border-color: rgb(var(--primary) / 0.64);
  background-color: rgb(var(--primary) / 0.055);
}

.pmdg-hot-group-launcher:active {
  transform: translateY(1px);
}

.pmdg-hot-group-launcher__copy {
  display: block;
  min-width: 0;
}

.pmdg-hot-group-launcher__copy strong,
.pmdg-hot-group-launcher__copy small {
  display: block;
}

.pmdg-hot-group-launcher__copy strong {
  font-size: 0.86rem;
  font-weight: 720;
}

.pmdg-hot-group-launcher__copy small {
  overflow: hidden;
  margin-top: 0.12rem;
  color: rgb(var(--muted-foreground));
  font-family: var(--ff-font-mono);
  font-size: 0.58rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pmdg-hot-group-launcher__open {
  color: rgb(var(--primary));
  font-family: var(--ff-font-mono);
  font-size: 0.61rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.pmdg-mobile-section-ribbon-anchor,
.pmdg-mobile-section-ribbon {
  display: none;
}

.pmdg-section-menu-overlay {
  z-index: 125;
  display: grid;
  align-items: end;
  margin: 0 !important;
  padding: 0.75rem max(0.75rem, env(safe-area-inset-right, 0px)) max(0.75rem, env(safe-area-inset-bottom, 0px)) max(0.75rem, env(safe-area-inset-left, 0px));
  background: rgb(0 0 0 / 0.72);
  overscroll-behavior: contain;
  touch-action: none;
}

.pmdg-section-menu {
  width: min(100%, 34rem);
  max-height: calc(var(--ff-visual-viewport-height, 100dvh) - 1.5rem);
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid rgb(var(--border-strong) / 0.82);
  border-radius: 14px 14px 8px 8px;
  background: rgb(var(--panel) / 0.995);
  box-shadow: 0 -24px 70px rgb(0 0 0 / 0.62);
  touch-action: pan-y;
}

.pmdg-section-menu__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 0.9rem;
  border-bottom: 1px solid rgb(var(--border) / 0.72);
}

.pmdg-section-menu__header h4 {
  margin-top: 0.2rem;
  color: rgb(var(--foreground));
  font-size: 1rem;
  font-weight: 700;
}

.pmdg-section-menu__close {
  width: 3rem;
  min-width: 3rem;
  height: 3rem;
  border: 1px solid rgb(var(--border) / 0.8);
  border-radius: 8px;
  color: rgb(var(--muted-foreground));
  font-size: 1.5rem;
}

.pmdg-section-menu__choices {
  display: grid;
  gap: 0.55rem;
  max-height: min(70dvh, 36rem);
  padding: 0.75rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.pmdg-section-menu__choices > button {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr);
  min-height: 4rem;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid rgb(var(--border) / 0.78);
  border-radius: 9px;
  background: rgb(var(--panel-subtle) / 0.74);
  text-align: left;
}

.pmdg-section-menu__choices > button[aria-current="location"] {
  border-color: rgb(var(--primary) / 0.62);
  background: rgb(var(--primary) / 0.12);
}

.pmdg-section-menu__number {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border-radius: 9999px;
  background: rgb(var(--panel-elevated) / 0.9);
  color: rgb(var(--primary));
  font-family: var(--ff-font-mono);
  font-size: 0.72rem;
  font-weight: 700;
}

.pmdg-section-menu__choices strong,
.pmdg-section-menu__choices small {
  display: block;
}

.pmdg-section-menu__choices strong {
  color: rgb(var(--foreground));
  font-size: 0.82rem;
}

.pmdg-section-menu__choices small {
  margin-top: 0.18rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.68rem;
  line-height: 1.35;
}

@media (max-width: 760px), (max-height: 500px) and (pointer: coarse) {
  .pmdg-hot-group-launcher {
    grid-template-columns: minmax(0, 1fr) auto;
    min-height: 3.6rem;
    gap: 0.75rem;
    padding: 0.62rem 0.7rem;
  }

  .pmdg-hot-group-launcher__copy strong {
    font-size: 0.8rem;
  }

  .pmdg-mobile-section-ribbon-anchor {
    position: sticky;
    top: max(0.5rem, env(safe-area-inset-top, 0px));
    z-index: 45;
    display: block;
    height: 2.75rem;
    overflow: visible;
    pointer-events: none;
  }

  .pmdg-mobile-section-ribbon {
    display: grid;
    grid-template-columns: 2.75rem minmax(0, 1fr) 2.75rem;
    width: min(100%, 32rem);
    margin-left: auto;
    min-height: 2.75rem;
    overflow: hidden;
    border: 1px solid rgb(var(--border-strong) / 0.72);
    border-radius: 9px;
    background: rgb(var(--panel-elevated) / 0.98);
    box-shadow: 0 10px 24px rgb(0 0 0 / 0.3);
    pointer-events: auto;
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
  }

  .pmdg-mobile-section-ribbon button {
    min-width: 0;
    min-height: 2.75rem;
    padding: 0.3rem;
  }

  .pmdg-mobile-section-ribbon__neighbor {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    color: rgb(var(--muted-foreground));
    font-family: var(--ff-font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .pmdg-mobile-section-ribbon__neighbor span:not([aria-hidden="true"]) {
    display: none;
  }

  .pmdg-mobile-section-ribbon__neighbor span[aria-hidden="true"] {
    flex: 0 0 auto;
    color: rgb(var(--primary));
    font-size: 1.25rem;
  }

  .pmdg-mobile-section-ribbon__neighbor:disabled {
    opacity: 0.38;
  }

  .pmdg-mobile-section-ribbon__current {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border-right: 1px solid rgb(var(--border) / 0.72);
    border-left: 1px solid rgb(var(--border) / 0.72);
    background: rgb(var(--panel-subtle) / 0.9);
    text-align: center;
  }

  .pmdg-mobile-section-ribbon__current strong,
  .pmdg-mobile-section-ribbon__current small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pmdg-mobile-section-ribbon__current strong {
    color: rgb(var(--primary));
    font-size: 0.78rem;
    font-weight: 750;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .pmdg-mobile-section-ribbon__current small {
    color: rgb(var(--muted-foreground));
    font-size: 0.62rem;
  }

  .pmdg-mobile-navigable-section {
    scroll-margin-top: 4.25rem;
  }

  .pmdg-mobile-navigable-section:focus {
    outline: none;
  }
}

@media (max-height: 500px) and (pointer: coarse) {
  .pmdg-mobile-section-ribbon { min-height: 2.5rem; }

  .pmdg-mobile-section-ribbon button {
    min-height: 2.5rem;
  }

  .pmdg-mobile-navigable-section {
    scroll-margin-top: 4rem;
  }

  .pmdg-section-menu__choices {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: calc(var(--ff-visual-viewport-height, 100dvh) - 5.5rem);
  }
}
</style>
