<script>
function formatFenixSelectorDraft(rawValue) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return '';
  if (Number.isInteger(numeric)) return String(numeric);
  return String(Number(numeric.toFixed(2)));
}

const FENIX_SELECTOR_SEND_ERROR = 'Command could not be sent. Check the live control status and try again.';

export function resolveFenixSelectorSubmitState(state = {}, sent = false) {
  const next = {
    draft: typeof state.draft === 'string' ? state.draft : '',
    dirty: state.dirty === true,
    error: typeof state.error === 'string' ? state.error : '',
    accepted: state.accepted === true,
  };
  if (sent === false) {
    return {
      ...next,
      dirty: true,
      error: FENIX_SELECTOR_SEND_ERROR,
      accepted: false,
    };
  }
  return {
    ...next,
    dirty: false,
    error: '',
    accepted: true,
  };
}

export function reconcileFenixSelectorDraftState(state = {}, snapshot = {}, previous = []) {
  const {
    rawValue,
    unavailable = false,
    profileKey,
    profileRevision,
    sourceStatus,
    pending = false,
    machMode = false,
  } = snapshot;
  const next = {
    draft: typeof state.draft === 'string' ? state.draft : '',
    dirty: state.dirty === true,
    error: typeof state.error === 'string' ? state.error : '',
    accepted: state.accepted === true,
  };
  const profileChanged = previous[2] !== undefined
    && (previous[2] !== profileKey || previous[3] !== profileRevision);

  if (profileChanged || sourceStatus !== 'connected' || unavailable || machMode) {
    return {
      draft: '',
      dirty: false,
      error: '',
      accepted: false,
    };
  }

  // Preserve the requested value only while its accepted command owns the
  // physical-knob pending group. The aircraft value wins again afterwards,
  // including when a backend rejection produced no changed state packet.
  if (pending && next.accepted) return next;
  if (next.accepted || !next.dirty) {
    next.draft = formatFenixSelectorDraft(rawValue);
    next.accepted = false;
  } else if (pending) {
    next.draft = formatFenixSelectorDraft(rawValue);
    next.dirty = false;
    next.error = '';
  }
  return next;
}
</script>

<script setup>
import { computed, nextTick, reactive, watch } from 'vue';
import AircraftSectionRibbon from '../AircraftSectionRibbon.vue';
import { parseMcpDraftNumber, submitMcpDraft } from '../mcp-input.js';
import FenixThrottleControl from './FenixThrottleControl.vue';
import { useAircraftControlsStore } from '../../../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../../stores/aircraft-specific.js';

const props = defineProps({
  values: {
    type: Object,
    default: () => ({}),
  },
  unavailable: {
    type: Array,
    default: () => [],
  },
  sourceStatus: {
    type: String,
    default: 'awaiting-values',
  },
  sourceStatuses: {
    type: Object,
    default: () => ({}),
  },
  actionCapabilities: {
    type: Object,
    default: () => ({}),
  },
  requestAction: {
    type: Function,
    default: () => false,
  },
  requestCommand: {
    type: Function,
    default: () => false,
  },
  isCommandSupported: {
    type: Function,
    default: () => false,
  },
  getCommand: {
    type: Function,
    default: () => null,
  },
  isActionPending: {
    type: Function,
    default: () => false,
  },
  profileKey: {
    type: String,
    default: '',
  },
  controlSetupRequired: {
    type: Boolean,
    default: false,
  },
});

const aircraftControls = useAircraftControlsStore();
const aircraftSpecific = useAircraftSpecificStore();
const unavailableFields = computed(() => new Set(props.unavailable));
const controlSessionReady = computed(() => (
  props.sourceStatus === 'connected'
  && aircraftControls.availability.enabled === true
));

const variant = computed(() => {
  if (props.profileKey.endsWith('/fenix-a319')) return 'A319';
  if (props.profileKey.endsWith('/fenix-a321')) return 'A321';
  return 'A320';
});

const flightGuidanceControls = Object.freeze([
  {
    title: 'AUTOPILOT 1',
    fieldId: 'flightGuidance.ap1',
    groupId: 'flightGuidance.ap1',
    commandId: 'flightGuidance.autopilot1.set',
    actions: [
      { id: 'flightGuidance.ap1.off', label: 'DISCONNECT', value: false },
      { id: 'flightGuidance.ap1.on', label: 'ENGAGE', value: true },
    ],
  },
  {
    title: 'AUTOPILOT 2',
    fieldId: 'flightGuidance.ap2',
    groupId: 'flightGuidance.ap2',
    commandId: 'flightGuidance.autopilot2.set',
    actions: [
      { id: 'flightGuidance.ap2.off', label: 'DISCONNECT', value: false },
      { id: 'flightGuidance.ap2.on', label: 'ENGAGE', value: true },
    ],
  },
  {
    title: 'AUTOTHRUST',
    fieldId: 'flightGuidance.autothrust',
    groupId: 'flightGuidance.autothrust',
    commandId: 'flightGuidance.autothrust.set',
    actions: [
      { id: 'flightGuidance.autothrust.off', label: 'DISCONNECT', value: false },
      { id: 'flightGuidance.autothrust.on', label: 'ARM', value: true },
    ],
  },
  {
    title: 'LOCALIZER',
    fieldId: 'flightGuidance.localizer',
    groupId: 'flightGuidance.localizer',
    commandId: 'flightGuidance.localizer.set',
    actions: [
      { id: 'flightGuidance.localizer.off', label: 'OFF', value: false },
      { id: 'flightGuidance.localizer.on', label: 'ON', value: true },
    ],
  },
  {
    title: 'APPROACH',
    fieldId: 'flightGuidance.approach',
    groupId: 'flightGuidance.approach',
    commandId: 'flightGuidance.approach.set',
    actions: [
      { id: 'flightGuidance.approach.off', label: 'OFF', value: false },
      { id: 'flightGuidance.approach.on', label: 'ON', value: true },
    ],
  },
  {
    title: 'EXPEDITE',
    fieldId: 'flightGuidance.expedite',
    groupId: 'flightGuidance.expedite',
    commandId: 'flightGuidance.expedite.set',
    actions: [
      { id: 'flightGuidance.expedite.off', label: 'OFF', value: false },
      { id: 'flightGuidance.expedite.on', label: 'ON', value: true },
    ],
  },
]);

const managedModeControls = Object.freeze([
  {
    title: 'SPEED',
    fieldId: 'flightGuidance.speedManaged',
    groupId: 'flightGuidance.speed',
    commandId: 'flightGuidance.speedMode.set',
    actions: [
      { id: 'flightGuidance.speedManaged.off', label: 'PULL SELECTED', value: false, commandInput: 'selected' },
      { id: 'flightGuidance.speedManaged.on', label: 'PUSH MANAGED', value: true, commandInput: 'managed' },
    ],
  },
  {
    title: 'HEADING',
    fieldId: 'flightGuidance.headingManaged',
    groupId: 'flightGuidance.heading',
    commandId: 'flightGuidance.headingMode.set',
    actions: [
      { id: 'flightGuidance.headingManaged.off', label: 'PULL SELECTED', value: false, commandInput: 'selected' },
      { id: 'flightGuidance.headingManaged.on', label: 'PUSH MANAGED', value: true, commandInput: 'managed' },
    ],
  },
  {
    title: 'ALTITUDE',
    fieldId: 'flightGuidance.altitudeManaged',
    groupId: 'flightGuidance.altitude',
    commandId: 'flightGuidance.altitudeMode.set',
    actions: [
      { id: 'flightGuidance.altitudeManaged.off', label: 'PULL SELECTED', value: false, commandInput: 'selected' },
      { id: 'flightGuidance.altitudeManaged.on', label: 'PUSH MANAGED', value: true, commandInput: 'managed' },
    ],
  },
]);

const selectorControls = Object.freeze([
  {
    id: 'speed',
    label: 'SPD',
    fieldId: 'flightGuidance.speedValue',
    groupId: 'flightGuidance.speed',
    actionId: 'flightGuidance.speed.set',
    commandId: 'flightGuidance.speed.set',
    unit: 'KTS',
    inputmode: 'numeric',
    min: 100,
    max: 399,
    step: 1,
  },
  {
    id: 'heading',
    label: 'HDG / TRK',
    fieldId: 'flightGuidance.headingDeg',
    groupId: 'flightGuidance.heading',
    actionId: 'flightGuidance.heading.set',
    commandId: 'flightGuidance.heading.set',
    unit: 'DEG',
    inputmode: 'numeric',
    min: 0,
    max: 359,
    step: 1,
  },
  {
    id: 'altitude',
    label: 'ALT',
    fieldId: 'flightGuidance.altitudeFt',
    groupId: 'flightGuidance.altitude',
    unit: 'FT',
    inputmode: 'numeric',
    min: 0,
    max: 49000,
  },
]);

const selectorDrafts = reactive({});
const selectorDirty = reactive({});
const selectorErrors = reactive({});
const selectorAccepted = reactive({});

function applySelectorDraftSnapshot(selector, snapshot, previous = []) {
  const next = reconcileFenixSelectorDraftState({
    draft: selectorDrafts[selector.id],
    dirty: selectorDirty[selector.id],
    error: selectorErrors[selector.id],
    accepted: selectorAccepted[selector.id],
  }, snapshot, previous);
  selectorDrafts[selector.id] = next.draft;
  selectorDirty[selector.id] = next.dirty;
  selectorErrors[selector.id] = next.error;
  selectorAccepted[selector.id] = next.accepted;
}

function reconcileAcceptedSelector(selector) {
  if (selectorAccepted[selector.id] !== true || groupPending(selector.groupId)) return;
  applySelectorDraftSnapshot(selector, {
    rawValue: props.values[selector.fieldId],
    unavailable: props.unavailable.includes(selector.fieldId),
    profileKey: props.profileKey,
    profileRevision: aircraftSpecific.activeProfileRevision,
    sourceStatus: props.sourceStatus,
    pending: false,
    machMode: selectorIsMach(selector),
  });
}

for (const selector of selectorControls) {
  watch(
    () => [
      props.values[selector.fieldId],
      props.unavailable.includes(selector.fieldId),
      props.profileKey,
      aircraftSpecific.activeProfileRevision,
      props.sourceStatus,
      groupPending(selector.groupId),
      selectorIsMach(selector),
    ],
    ([rawValue, unavailable, profileKey, profileRevision, sourceStatus, pending, machMode], previous = []) => {
      applySelectorDraftSnapshot(selector, {
        rawValue,
        unavailable,
        profileKey,
        profileRevision,
        sourceStatus,
        pending,
        machMode,
      }, previous);
    },
    { immediate: true },
  );
}

function twoPosition(
  title,
  fieldId,
  prefix,
  falsePosition = ['off', 'OFF'],
  truePosition = ['on', 'ON'],
  options = {},
) {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: [
      { id: `${prefix}.${falsePosition[0]}`, label: falsePosition[1], value: false },
      { id: `${prefix}.${truePosition[0]}`, label: truePosition[1], value: true },
    ],
    ...options,
  };
}

function positions(title, fieldId, prefix, items, options = {}) {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: items.map(([suffix, label, value]) => ({
      id: `${prefix}.${suffix}`,
      label,
      value,
    })),
    ...options,
  };
}

const THREE_OFF_AUTO_ON = [
  ['off', 'OFF', 'off'],
  ['auto', 'AUTO', 'auto'],
  ['on', 'ON', 'on'],
];
const THREE_OFF_DIM_BRIGHT = [
  ['off', 'OFF', 'off'],
  ['dim', 'DIM', 'dim'],
  ['bright', 'BRT', 'bright'],
];
const THREE_SOURCE = [
  ['captain', 'CAPT', 'captain'],
  ['normal', 'NORM', 'normal'],
  ['firstOfficer', 'F/O', 'firstOfficer'],
];

const rawControlSections = [
  {
    id: 'exterior-lights',
    title: 'Exterior Lights',
    controls: [
      twoPosition('BEACON', 'lights.beacon', 'lights.beacon'),
      positions('STROBE', 'lights.strobeMode', 'lights.strobe', THREE_OFF_AUTO_ON),
      positions('NAV & LOGO', 'lights.navLogoMode', 'lights.navLogo', [
        ['off', 'OFF', 'off'],
        ['nav', 'NAV', 'nav'],
        ['logo', 'LOGO', 'logo'],
      ]),
      twoPosition('RWY TURNOFF', 'lights.runwayTurnoff', 'lights.runwayTurnoff'),
      positions('NOSE LIGHT', 'lights.noseMode', 'lights.nose', [
        ['off', 'OFF', 'off'],
        ['taxi', 'TAXI', 'taxi'],
        ['takeoff', 'T.O', 'takeoff'],
      ]),
      twoPosition('WING', 'lights.wing', 'lights.wing'),
      positions('LANDING LEFT', 'lights.landingLeftMode', 'lights.landingLeft', [
        ['retract', 'RETR', 'retract'],
        ['off', 'OFF', 'off'],
        ['on', 'ON', 'on'],
      ]),
      positions('LANDING RIGHT', 'lights.landingRightMode', 'lights.landingRight', [
        ['retract', 'RETR', 'retract'],
        ['off', 'OFF', 'off'],
        ['on', 'ON', 'on'],
      ]),
    ],
  },
  {
    id: 'cabin-visibility',
    title: 'Cabin & Visibility',
    controls: [
      twoPosition('SEAT BELTS', 'cabin.seatBelts', 'cabin.seatBelts'),
      positions('NO SMOKING', 'cabin.noSmokingMode', 'cabin.noSmoking', THREE_OFF_AUTO_ON),
      positions('EMER EXIT', 'cabin.emergencyExitMode', 'cabin.emergencyExit', [
        ['off', 'OFF', 'off'],
        ['arm', 'ARM', 'arm'],
        ['on', 'ON', 'on'],
      ]),
      positions('CAPT WIPER', 'visibility.wiperCaptainMode', 'visibility.wiperCaptain', [
        ['off', 'OFF', 'off'],
        ['slow', 'SLOW', 'slow'],
        ['fast', 'FAST', 'fast'],
      ]),
      positions('F/O WIPER', 'visibility.wiperFirstOfficerMode', 'visibility.wiperFirstOfficer', [
        ['off', 'OFF', 'off'],
        ['slow', 'SLOW', 'slow'],
        ['fast', 'FAST', 'fast'],
      ]),
    ],
  },
  {
    id: 'cockpit-lighting',
    title: 'Cockpit Lighting',
    note: 'Integral lighting uses five fixed, bounded levels from the Fenix-published 0–1 contract.',
    controls: [
      twoPosition('ICE / STBY COMPASS', 'displays.iceStandby', 'displays.iceStandby'),
      positions('DOME', 'displays.domeLightMode', 'displays.domeLight', THREE_OFF_DIM_BRIGHT),
      positions('ANNUNCIATORS', 'displays.annunciatorMode', 'displays.annunciator', [
        ['bright', 'BRT', 'bright'],
        ['dim', 'DIM', 'dim'],
        ['test', 'TEST', 'test'],
      ]),
      positions('CONSOLE/FLOOR CAPT', 'displays.consoleFloorCaptainMode', 'displays.consoleFloorCaptain', THREE_OFF_DIM_BRIGHT),
      positions('CONSOLE/FLOOR F/O', 'displays.consoleFloorFirstOfficerMode', 'displays.consoleFloorFirstOfficer', THREE_OFF_DIM_BRIGHT),
      twoPosition('CHART LIGHT CAPT', 'displays.chartLightCaptain', 'displays.chartLightCaptain'),
      twoPosition('CHART LIGHT F/O', 'displays.chartLightFirstOfficer', 'displays.chartLightFirstOfficer'),
      positions('FCU INTEGRAL', 'lighting.fcu', 'lighting.fcu', [
        ['off', '0%', 0],
        ['quarter', '25%', 0.25],
        ['half', '50%', 0.5],
        ['threeQuarter', '75%', 0.75],
        ['full', '100%', 1],
      ]),
      positions('OVERHEAD INTEGRAL', 'lighting.overhead', 'lighting.overhead', [
        ['off', '0%', 0],
        ['quarter', '25%', 0.25],
        ['half', '50%', 0.5],
        ['threeQuarter', '75%', 0.75],
        ['full', '100%', 1],
      ]),
      positions('PEDESTAL INTEGRAL', 'lighting.pedestal', 'lighting.pedestal', [
        ['off', '0%', 0],
        ['quarter', '25%', 0.25],
        ['half', '50%', 0.5],
        ['threeQuarter', '75%', 0.75],
        ['full', '100%', 1],
      ]),
    ],
  },
  {
    id: 'electrical-apu',
    title: 'Electrical & APU',
    controls: [
      twoPosition('BAT 1', 'systems.battery1', 'systems.battery1', ['off', 'OFF'], ['auto', 'AUTO']),
      twoPosition('BAT 2', 'systems.battery2', 'systems.battery2', ['off', 'OFF'], ['auto', 'AUTO']),
      twoPosition('GEN 1', 'systems.generator1', 'systems.generator1'),
      twoPosition('GEN 2', 'systems.generator2', 'systems.generator2'),
      twoPosition('GEN 1 LINE', 'systems.generator1Line', 'systems.generator1Line'),
      twoPosition('AC ESS FEED', 'systems.acEssFeedAlternate', 'systems.acEssFeed', ['normal', 'NORM'], ['alternate', 'ALTN']),
      twoPosition('COMMERCIAL', 'systems.commercial', 'systems.commercial'),
      twoPosition('GALLEY & CAB', 'systems.galleyAndCabin', 'systems.galleyAndCabin', ['off', 'OFF'], ['auto', 'AUTO']),
      twoPosition('APU GEN', 'systems.apuGenerator', 'systems.apuGenerator'),
      twoPosition('APU MASTER', 'systems.apuMaster', 'systems.apuMaster'),
    ],
  },
  {
    id: 'fuel',
    title: 'Fuel',
    controls: [
      twoPosition('LEFT PUMP 1', 'fuel.leftPump1', 'fuel.leftPump1'),
      twoPosition('LEFT PUMP 2', 'fuel.leftPump2', 'fuel.leftPump2'),
      twoPosition('RIGHT PUMP 1', 'fuel.rightPump1', 'fuel.rightPump1'),
      twoPosition('RIGHT PUMP 2', 'fuel.rightPump2', 'fuel.rightPump2'),
      twoPosition('CENTER PUMP 1', 'fuel.centerPump1', 'fuel.centerPump1', ['off', 'OFF'], ['on', 'ON'], { variants: ['A319', 'A320'] }),
      twoPosition('CENTER PUMP 2', 'fuel.centerPump2', 'fuel.centerPump2', ['off', 'OFF'], ['on', 'ON'], { variants: ['A319', 'A320'] }),
      twoPosition('CROSSFEED', 'fuel.crossfeedOpen', 'fuel.crossfeed', ['closed', 'SHUT'], ['open', 'OPEN']),
      twoPosition('MODE SELECT', 'fuel.modeManual', 'fuel.mode', ['auto', 'AUTO'], ['manual', 'MAN']),
      twoPosition('ACT TRANSFER', 'fuel.actTransfer', 'fuel.actTransfer', ['off', 'OFF'], ['on', 'ON'], { variants: ['A321'] }),
    ],
  },
  {
    id: 'pneumatic',
    title: 'Pneumatic, Air & Pressurization',
    controls: [
      twoPosition('ENG 1 BLEED', 'systems.engineBleed1', 'systems.engineBleed1'),
      twoPosition('ENG 2 BLEED', 'systems.engineBleed2', 'systems.engineBleed2'),
      twoPosition('APU BLEED', 'systems.apuBleed', 'systems.apuBleed'),
      twoPosition('PACK 1', 'systems.pack1', 'systems.pack1'),
      twoPosition('PACK 2', 'systems.pack2', 'systems.pack2'),
      positions('PACK FLOW', 'systems.packFlowMode', 'systems.packFlow', [
        ['low', 'LOW', 'low'],
        ['normal', 'NORM', 'normal'],
        ['high', 'HIGH', 'high'],
      ], { variants: ['A319', 'A320'] }),
      positions('CROSS BLEED', 'systems.crossBleedMode', 'systems.crossBleed', [
        ['shut', 'SHUT', 'shut'],
        ['auto', 'AUTO', 'auto'],
        ['open', 'OPEN', 'open'],
      ]),
      twoPosition('RAM AIR', 'systems.ramAir', 'systems.ramAir'),
      twoPosition('HOT AIR', 'systems.hotAir', 'systems.hotAir'),
      twoPosition('BLOWER', 'systems.blower', 'systems.blower'),
      twoPosition('EXTRACT', 'systems.extract', 'systems.extract'),
      twoPosition('CABIN FANS', 'systems.cabinFans', 'systems.cabinFans'),
      twoPosition('PRESS MODE', 'systems.pressurizationManual', 'systems.pressurization', ['auto', 'AUTO'], ['manual', 'MAN']),
      twoPosition('AFT CARGO HOT AIR', 'systems.cargoHotAir', 'systems.cargoHotAir'),
      twoPosition('AFT CARGO ISOL', 'systems.cargoAftIsolation', 'systems.cargoAftIsolation', ['closed', 'SHUT'], ['open', 'OPEN']),
    ],
  },
  {
    id: 'protection-hydraulics',
    title: 'Protection, Hydraulics & Brakes',
    controls: [
      twoPosition('ENG 1 ANTI-ICE', 'systems.engineAntiIce1', 'systems.engineAntiIce1'),
      twoPosition('ENG 2 ANTI-ICE', 'systems.engineAntiIce2', 'systems.engineAntiIce2'),
      twoPosition('WING ANTI-ICE', 'systems.wingAntiIce', 'systems.wingAntiIce'),
      twoPosition('PROBE / WINDOW HEAT', 'systems.probeHeat', 'systems.probeHeat', ['auto', 'AUTO'], ['on', 'ON']),
      twoPosition('ENG 1 HYD PUMP', 'systems.hydraulicEnginePump1', 'systems.hydraulicEnginePump1', ['off', 'OFF'], ['auto', 'AUTO']),
      twoPosition('ENG 2 HYD PUMP', 'systems.hydraulicEnginePump2', 'systems.hydraulicEnginePump2', ['off', 'OFF'], ['auto', 'AUTO']),
      twoPosition('HYD PTU', 'systems.hydraulicPtu', 'systems.hydraulicPtu', ['off', 'OFF'], ['auto', 'AUTO']),
      twoPosition('BLUE ELEC PUMP', 'systems.hydraulicBlueElectricPump', 'systems.hydraulicBlueElectricPump', ['off', 'OFF'], ['auto', 'AUTO']),
      twoPosition('BRAKE FAN', 'systems.brakeFan', 'systems.brakeFan'),
      twoPosition('ANTI-SKID', 'systems.antiSkid', 'systems.antiSkid'),
      twoPosition('PARK BRAKE', 'systems.parkingBrake', 'systems.parkingBrake', ['released', 'RELEASE'], ['set', 'SET']),
    ],
  },
  {
    id: 'engine-adirs',
    title: 'Engine & ADIRS Selectors',
    controls: [
      positions('IR 1', 'systems.ir1Mode', 'systems.ir1', [
        ['off', 'OFF', 'off'],
        ['nav', 'NAV', 'nav'],
        ['att', 'ATT', 'att'],
      ]),
      positions('IR 2', 'systems.ir2Mode', 'systems.ir2', [
        ['off', 'OFF', 'off'],
        ['nav', 'NAV', 'nav'],
        ['att', 'ATT', 'att'],
      ]),
      positions('IR 3', 'systems.ir3Mode', 'systems.ir3', [
        ['off', 'OFF', 'off'],
        ['nav', 'NAV', 'nav'],
        ['att', 'ATT', 'att'],
      ]),
      positions('ENGINE MODE', 'systems.engineMode', 'systems.engineMode', [
        ['crank', 'CRANK', 'crank'],
        ['normal', 'NORM', 'normal'],
        ['start', 'START', 'start'],
      ]),
      twoPosition('MAN START 1', 'systems.engineManualStart1', 'systems.engineManualStart1'),
      twoPosition('MAN START 2', 'systems.engineManualStart2', 'systems.engineManualStart2'),
      twoPosition('N1 MODE 1', 'systems.engineN1Mode1', 'systems.engineN1Mode1'),
      twoPosition('N1 MODE 2', 'systems.engineN1Mode2', 'systems.engineN1Mode2'),
      positions('CLOCK UTC', 'systems.clockUtcMode', 'systems.clockUtc', [
        ['gps', 'GPS', 'gps'],
        ['internal', 'INT', 'internal'],
        ['set', 'SET', 'set'],
      ]),
    ],
  },
  {
    id: 'efis-navigation',
    title: 'EFIS & Navigation Selectors',
    controls: [
      positions('CAPT BARO UNIT', 'flightGuidance.baroUnitCaptain', 'flightGuidance.baroUnitCaptain', [
        ['inhg', 'INHG', 'inhg'],
        ['hpa', 'HPA', 'hpa'],
      ]),
      positions('F/O BARO UNIT', 'flightGuidance.baroUnitFirstOfficer', 'flightGuidance.baroUnitFirstOfficer', [
        ['inhg', 'INHG', 'inhg'],
        ['hpa', 'HPA', 'hpa'],
      ]),
      positions('ALTITUDE STEP', 'flightGuidance.altitudeIncrementMode', 'flightGuidance.altitudeIncrement', [
        ['hundred', '100', 'hundred'],
        ['thousand', '1000', 'thousand'],
      ], { groupId: 'flightGuidance.altitude' }),
      positions('CAPT NAVAID 1', 'navigation.navaidCaptain1', 'navigation.navaidCaptain1', [
        ['adf', 'ADF', 'adf'],
        ['off', 'OFF', 'off'],
        ['vor', 'VOR', 'vor'],
      ]),
      positions('CAPT NAVAID 2', 'navigation.navaidCaptain2', 'navigation.navaidCaptain2', [
        ['adf', 'ADF', 'adf'],
        ['off', 'OFF', 'off'],
        ['vor', 'VOR', 'vor'],
      ]),
      positions('F/O NAVAID 1', 'navigation.navaidFirstOfficer1', 'navigation.navaidFirstOfficer1', [
        ['adf', 'ADF', 'adf'],
        ['off', 'OFF', 'off'],
        ['vor', 'VOR', 'vor'],
      ]),
      positions('F/O NAVAID 2', 'navigation.navaidFirstOfficer2', 'navigation.navaidFirstOfficer2', [
        ['adf', 'ADF', 'adf'],
        ['off', 'OFF', 'off'],
        ['vor', 'VOR', 'vor'],
      ]),
    ],
  },
  {
    id: 'switching',
    title: 'Source Switching',
    controls: [
      positions('ATT / HDG', 'switching.attitudeHeading', 'switching.attitudeHeading', THREE_SOURCE),
      positions('AIR DATA', 'switching.airData', 'switching.airData', THREE_SOURCE),
      positions('EIS / DMC', 'switching.eisDmc', 'switching.eisDmc', THREE_SOURCE),
      positions('ECAM / ND XFR', 'switching.ecamNd', 'switching.ecamNd', THREE_SOURCE),
      positions('AUDIO', 'switching.audio', 'switching.audio', THREE_SOURCE),
    ],
  },
  {
    id: 'surveillance-radio',
    title: 'Radio, Weather Radar & Transponder',
    controls: [
      twoPosition('RMP 1 POWER', 'surveillance.rmpCaptainPower', 'surveillance.rmpCaptainPower'),
      twoPosition('RMP 2 POWER', 'surveillance.rmpFirstOfficerPower', 'surveillance.rmpFirstOfficerPower'),
      twoPosition('RMP 3 POWER', 'surveillance.rmpThirdPower', 'surveillance.rmpThirdPower'),
      positions('WX RADAR SYS', 'surveillance.weatherRadarSystem', 'surveillance.weatherRadarSystem', [
        ['system1', 'SYS 1', 'system1'],
        ['off', 'OFF', 'off'],
        ['system2', 'SYS 2', 'system2'],
      ]),
      twoPosition('WX MULTISCAN', 'surveillance.weatherRadarMultiscanAuto', 'surveillance.weatherRadarMultiscan', ['manual', 'MAN'], ['auto', 'AUTO']),
      twoPosition('PRED W/S', 'surveillance.weatherRadarPwsAuto', 'surveillance.weatherRadarPws', ['off', 'OFF'], ['auto', 'AUTO']),
      positions('XPDR OPERATION', 'surveillance.transponderOperation', 'surveillance.transponderOperation', [
        ['standby', 'STBY', 'standby'],
        ['auto', 'AUTO', 'auto'],
        ['on', 'ON', 'on'],
      ]),
      positions('XPDR SYSTEM', 'surveillance.transponderSystem', 'surveillance.transponderSystem', [
        ['system1', 'SYS 1', 'system1'],
        ['system2', 'SYS 2', 'system2'],
      ]),
      twoPosition('ALT REPORTING', 'surveillance.altitudeReporting', 'surveillance.altitudeReporting'),
      positions('TCAS MODE', 'surveillance.transponderMode', 'surveillance.transponderMode', [
        ['standby', 'STBY', 'standby'],
        ['ta', 'TA', 'ta'],
        ['taRa', 'TA/RA', 'taRa'],
      ]),
    ],
  },
  {
    id: 'safety-misc',
    title: 'GPWS & Miscellaneous',
    controls: [
      twoPosition('GPWS SYSTEM', 'safety.gpwsSystemOff', 'safety.gpwsSystem', ['normal', 'NORM'], ['off', 'OFF']),
      twoPosition('GPWS TERRAIN', 'safety.gpwsTerrainOff', 'safety.gpwsTerrain', ['normal', 'NORM'], ['off', 'OFF']),
      twoPosition('GPWS G/S MODE', 'safety.gpwsGlideslopeOff', 'safety.gpwsGlideslope', ['normal', 'NORM'], ['off', 'OFF']),
      twoPosition('GPWS FLAP MODE', 'safety.gpwsFlapModeOff', 'safety.gpwsFlapMode', ['normal', 'NORM'], ['off', 'OFF']),
      twoPosition('LDG FLAP 3', 'safety.gpwsLandingFlap3', 'safety.gpwsLandingFlap3'),
      twoPosition('COCKPIT DOOR VIDEO', 'controls.cockpitDoorVideo', 'controls.cockpitDoorVideo'),
    ],
  },
];

const controlSections = computed(() => rawControlSections
  .map((section) => ({
    ...section,
    controls: section.controls.filter((control) => (
      !control.variants || control.variants.includes(variant.value)
    )),
  }))
  .filter((section) => section.controls.length > 0));

const fenixMobileLabels = Object.freeze({
  'exterior-lights': 'Exterior',
  'cabin-visibility': 'Cabin',
  'cockpit-lighting': 'Lighting',
  'electrical-apu': 'Electrical',
  fuel: 'Fuel',
  pneumatic: 'Air',
  'protection-hydraulics': 'Hyd / Ice',
  'engine-adirs': 'Engines',
  'efis-navigation': 'EFIS',
  switching: 'Switching',
  'surveillance-radio': 'Radio',
  'safety-misc': 'GPWS',
});
const sharedControlCommandIds = Object.freeze({
  'lights.beacon': 'lights.beacon.set',
  'lights.strobe': 'lights.strobeMode.set',
  'lights.navLogo': 'lights.navLogoMode.set',
  'lights.nose': 'lights.noseMode.set',
  'systems.parkingBrake': 'surfaces.parkingBrake.set',
});
const mobileSections = computed(() => [
  { id: 'throttle', label: 'Throttle', title: 'Virtual Throttle' },
  { id: 'fcu', label: 'FCU', title: 'Flight Guidance & FCU' },
  ...controlSections.value.map((section) => ({
    id: section.id,
    label: fenixMobileLabels[section.id] || section.title,
    title: section.title,
  })),
]);

function hasValue(id) {
  return !unavailableFields.value.has(id)
    && Object.prototype.hasOwnProperty.call(props.values, id);
}

function numberValue(id) {
  if (!hasValue(id)) return null;
  const current = props.values[id];
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

function fieldValue(id) {
  return hasValue(id) ? props.values[id] : null;
}

function controlValue(control) {
  if (!hasValue(control.fieldId)) return null;
  const current = props.values[control.fieldId];
  if (typeof current === 'boolean' || typeof current === 'string') return current;
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

function valueText(id) {
  if (!hasValue(id)) return '--';
  const current = props.values[id];
  if (typeof current === 'boolean') return current ? 'ON' : 'OFF';
  if (typeof current === 'string') return current.toUpperCase();
  if (typeof current === 'number' && Number.isFinite(current)) {
    return id.startsWith('lighting.')
      ? `${Math.round(Math.max(0, Math.min(1, current)) * 100)}%`
      : String(current);
  }
  return '--';
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function fenixCommandCatalogueActive() {
  return aircraftControls.aircraftCommandCatalogue?.configurationId === 'fenix-a32x';
}

function commandIdFor(control) {
  return control.commandId || sharedControlCommandIds[control.groupId] || '';
}

function actionFor(control, actionId) {
  return control.actions?.find((candidate) => candidate.id === actionId) || null;
}

function commandRouteSupported(control, actionId) {
  const commandId = commandIdFor(control);
  return fenixCommandCatalogueActive() && commandId
    ? props.isCommandSupported(commandId)
    : actionSupported(actionId);
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

function requestThrottleAction(actionId) {
  const detents = {
    'propulsion.throttle.idle': 'idle',
    'propulsion.throttle.climb': 'climb',
    'propulsion.throttle.flexMct': 'flex',
    'propulsion.throttle.toga': 'toga',
  };
  if (fenixCommandCatalogueActive()) {
    const value = detents[actionId];
    if (!value || !props.isCommandSupported('propulsion.throttleDetent.set')) return false;
    return props.requestCommand(
      'propulsion.throttleDetent.set',
      'propulsion.throttle',
      { value },
    );
  }
  return props.requestAction(actionId, 'propulsion.throttle');
}

function actionDisabled(control, actionId) {
  return !controlSessionReady.value
    || controlValue(control) === null
    || !commandRouteSupported(control, actionId)
    || groupPending(control.groupId);
}

function controlStatusId(control) {
  const identity = `${control.groupId}-${control.fieldId}`;
  return `fenix-control-status-${identity.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function actionDisabledReason(control, actionId) {
  if (!actionDisabled(control, actionId)) return '';
  if (groupPending(control.groupId)) return 'Command pending.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (controlValue(control) === null) return 'Live switch readback unavailable.';
  if (!commandRouteSupported(control, actionId) && props.controlSetupRequired) {
    return 'Requires MobiFlight Event Module setup.';
  }
  if (!commandRouteSupported(control, actionId)) return 'Compatible write transport unavailable.';
  return 'Control temporarily unavailable.';
}

function requestControlAction(control, actionId) {
  if (actionDisabled(control, actionId)) return false;
  const commandId = commandIdFor(control);
  if (fenixCommandCatalogueActive() && commandId) {
    const action = actionFor(control, actionId);
    return props.requestCommand(commandId, control.groupId, {
      value: action?.commandInput ?? action?.value,
    });
  }
  return props.requestAction(actionId, control.groupId);
}

function actionButtonClass(selected) {
  return selected
    ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100 shadow-sm'
    : 'border-surface-300 bg-surface-100 text-gray-300 hover:border-surface-400 hover:bg-surface-200';
}

function controlStatus(control) {
  if (groupPending(control.groupId)) return 'Command pending…';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (controlValue(control) === null) return 'Live switch readback unavailable; control disabled.';
  if (!control.actions.some((action) => commandRouteSupported(control, action.id))) {
    return props.controlSetupRequired
      ? 'Requires MobiFlight Event Module setup.'
      : 'Compatible write transport unavailable.';
  }
  return 'Ready.';
}

function altitudeIncrementMode() {
  const mode = fieldValue('flightGuidance.altitudeIncrementMode');
  return mode === 'hundred' || mode === 'thousand' ? mode : null;
}

function selectorActionId(control) {
  if (control.id !== 'altitude') return control.actionId;
  return altitudeIncrementMode() === 'thousand'
    ? 'flightGuidance.altitudeThousand.set'
    : 'flightGuidance.altitudeHundred.set';
}

function selectorConfig(control) {
  const altitudeStep = altitudeIncrementMode() === 'thousand' ? 1000 : 100;
  const configured = {
    ...control,
    actionId: selectorActionId(control),
    commandId: control.id === 'altitude'
      ? (altitudeIncrementMode() === 'thousand'
        ? 'flightGuidance.altitudeThousand.set'
        : 'flightGuidance.altitudeHundred.set')
      : control.commandId,
    step: control.id === 'altitude' ? altitudeStep : control.step,
  };
  if (!fenixCommandCatalogueActive()) return { ...configured, commandId: '' };
  const descriptor = props.getCommand(configured.commandId);
  return descriptor?.input?.kind === 'number'
    ? { ...configured, min: descriptor.input.min, max: descriptor.input.max, step: descriptor.input.step }
    : configured;
}

function selectorPending(control) {
  return groupPending(control.groupId);
}

function selectorIsMach(control) {
  const current = numberValue(control.fieldId);
  return control.id === 'speed' && current !== null && current < 100;
}

function selectorBaselineIssue(control) {
  const current = numberValue(control.fieldId);
  if (current === null) return 'unavailable';

  const config = selectorConfig(control);
  if (current < config.min || current > config.max) return 'range';

  const stepOffset = (current - config.min) / config.step;
  if (Math.abs(stepOffset - Math.round(stepOffset)) > 1e-7) return 'increment';

  return null;
}

function selectorDisabled(control) {
  const config = selectorConfig(control);
  return !controlSessionReady.value
    || numberValue(control.fieldId) === null
    || selectorIsMach(control)
    || (control.id === 'altitude' && altitudeIncrementMode() === null)
    || selectorBaselineIssue(control) !== null
    || (config.commandId
      ? !props.isCommandSupported(config.commandId)
      : !actionSupported(config.actionId))
    || selectorPending(control);
}

function selectorStatusId(control) {
  return `fenix-selector-status-${control.id}`;
}

function selectorErrorId(control) {
  return `fenix-selector-error-${control.id}`;
}

function selectorDescribedBy(control) {
  return [
    selectorStatusId(control),
    selectorErrors[control.id] ? selectorErrorId(control) : '',
  ].filter(Boolean).join(' ');
}

function selectorDisabledReason(control) {
  const config = selectorConfig(control);
  if (!selectorDisabled(control)) return '';
  if (selectorPending(control)) return 'Command pending; waiting for fresh FCU readback.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (numberValue(control.fieldId) === null) return 'Live FCU target readback unavailable.';
  if (selectorIsMach(control)) return 'Mach mode detected. Switch the FCU to SPD in the cockpit before setting knots.';
  if (control.id === 'altitude' && altitudeIncrementMode() === null) {
    return 'Live 100/1000 altitude increment state unavailable.';
  }
  const baselineIssue = selectorBaselineIssue(control);
  if (baselineIssue === 'range') {
    return `Live FCU value is outside the trusted ${config.min.toLocaleString('en-US')}-${config.max.toLocaleString('en-US')} ${control.unit} range; selector disabled.`;
  }
  if (baselineIssue === 'increment') {
    return `Live FCU value is not aligned to the active ${config.step.toLocaleString('en-US')} ${control.unit} increment; selector disabled.`;
  }
  const routeSupported = config.commandId
    ? props.isCommandSupported(config.commandId)
    : actionSupported(config.actionId);
  if (!routeSupported && props.controlSetupRequired) {
    return 'Requires MobiFlight Event Module setup for Fenix FCU writes.';
  }
  if (!routeSupported) return 'Compatible Fenix FCU write transport unavailable.';
  return 'FCU target temporarily unavailable.';
}

function selectorStatus(control) {
  const disabledReason = selectorDisabledReason(control);
  if (disabledReason) return disabledReason;
  const config = selectorConfig(control);
  if (control.id === 'altitude') {
    return `Ready. Valid ${config.step.toLocaleString('en-US')} ft increments; press Enter or Apply.`;
  }
  return `Ready. Valid range ${config.min.toLocaleString('en-US')}-${config.max.toLocaleString('en-US')} ${control.unit}; press Enter or Apply.`;
}

function selectorLiveText(control) {
  const current = numberValue(control.fieldId);
  if (current === null) return '--';
  if (selectorIsMach(control)) {
    return `MACH RAW ${formatMachRaw(current)}`;
  }
  if (control.id === 'heading') return String(Math.round(current)).padStart(3, '0');
  return Math.round(current).toLocaleString('en-US');
}

function selectorLiveUnit(control) {
  return selectorIsMach(control) ? '' : control.unit;
}

function formatMachRaw(current) {
  if (!Number.isFinite(current)) return '--';
  return Number.isInteger(current)
    ? String(current)
    : current.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 2 });
}

function updateSelectorDraft(control, event) {
  selectorDrafts[control.id] = event?.target?.value ?? '';
  selectorDirty[control.id] = true;
  selectorErrors[control.id] = '';
}

function selectorValidationMessage(config) {
  const stepText = config.step > 1
    ? ` in ${config.step.toLocaleString('en-US')} increments`
    : '';
  return `Enter a whole number from ${config.min.toLocaleString('en-US')} to ${config.max.toLocaleString('en-US')}${stepText}.`;
}

function submitSelector(control) {
  if (selectorDisabled(control)) return false;
  const config = selectorConfig(control);
  const rawValue = selectorDrafts[control.id];
  if (parseMcpDraftNumber(rawValue, config) === null) {
    selectorErrors[control.id] = selectorValidationMessage(config);
    return false;
  }
  const sent = submitMcpDraft({
    config,
    disabled: false,
    groupId: control.groupId,
    rawValue,
    requestAction: props.requestAction,
    requestCommand: props.requestCommand,
  });
  const next = resolveFenixSelectorSubmitState({
    draft: selectorDrafts[control.id],
    dirty: selectorDirty[control.id],
    error: selectorErrors[control.id],
    accepted: selectorAccepted[control.id],
  }, sent);
  selectorDrafts[control.id] = next.draft;
  selectorDirty[control.id] = next.dirty;
  selectorErrors[control.id] = next.error;
  selectorAccepted[control.id] = next.accepted;
  if (sent === false) return false;
  reconcileAcceptedSelector(control);
  void nextTick(() => reconcileAcceptedSelector(control));
  return true;
}

function verticalReadbackText() {
  const current = numberValue('flightGuidance.verticalValue');
  if (current === null) return '--';
  return Number.isInteger(current)
    ? current.toLocaleString('en-US')
    : current.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

const flightGuidanceStatusText = computed(() => {
  if (props.sourceStatus !== 'connected') return 'Waiting for live Fenix FCU data; flight-guidance controls are disabled.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (props.controlSetupRequired) {
    return 'Requires MobiFlight Event Module setup for Fenix FCU writes.';
  }
  const allGroups = [
    ...flightGuidanceControls,
    ...managedModeControls,
    ...selectorControls,
  ];
  if (allGroups.some((control) => groupPending(control.groupId))) {
    return 'FCU command in progress; waiting for a fresh aircraft readback.';
  }
  return 'Ready.';
});

function controlGridClass(control) {
  if (control.actions.length >= 5) return 'grid-cols-3 sm:grid-cols-5';
  if (control.actions.length === 4) return 'grid-cols-2 sm:grid-cols-4';
  if (control.actions.length === 3) return 'grid-cols-3';
  if (control.actions.length === 2) return 'grid-cols-2';
  return 'grid-cols-1';
}

</script>

<template>
  <div
    class="p-3 sm:p-4 space-y-5"
    data-aircraft-template="fenix-a32x"
    :data-fenix-variant="variant.toLowerCase()"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h3 class="text-base font-semibold text-gray-100">Fenix {{ variant }} compatibility</h3>
        <p class="text-xs text-gray-500">Guarded Fenix cockpit and FCU controls with cooldowns and live readback confirmation.</p>
      </div>
      <span class="text-[10px] uppercase tracking-widest text-gray-500">{{ sourceStatus }}</span>
    </div>

    <AircraftSectionRibbon
      :sections="mobileSections"
      section-id-prefix="fenix-section-"
      :aircraft-label="`Fenix ${variant}`"
      :memory-key="profileKey || 'bundled/msfs/fenix-a32x'"
    />

    <div id="fenix-section-throttle" class="aircraft-mobile-navigable-section" tabindex="-1">
      <FenixThrottleControl
        :left-position="fieldValue('propulsion.throttleLever1Position')"
        :right-position="fieldValue('propulsion.throttleLever2Position')"
        :source-status="sourceStatus"
        :control-enabled="controlSessionReady"
        :action-capabilities="actionCapabilities"
        :pending="groupPending('propulsion.throttle')"
        :request-action="requestThrottleAction"
      />
    </div>

    <section
      id="fenix-section-fcu"
      class="aircraft-mobile-navigable-section rounded-xl border border-cyan-500/25 bg-cyan-500/[0.035] p-3 sm:p-4"
      tabindex="-1"
      data-fenix-section="flight-guidance-fcu"
    >
      <div class="dashboard-section-kicker">Flight Guidance &amp; FCU</div>
      <p
        id="fenix-fcu-status"
        class="mb-3 text-[10px] leading-relaxed text-gray-400"
        role="status"
        aria-live="polite"
      >{{ flightGuidanceStatusText }}</p>

      <div class="mb-2 text-[9px] font-semibold uppercase tracking-widest text-gray-500">Mode targets</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="control in flightGuidanceControls"
          :key="control.groupId"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-fenix-fcu-mode="control.groupId"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-[10px] font-semibold tracking-wide text-gray-200">{{ control.title }}</span>
            <span class="text-[9px] uppercase tracking-widest text-gray-500">{{ valueText(control.fieldId) }}</span>
          </div>
          <div class="grid grid-cols-2 gap-2" role="group" :aria-label="`${control.title} target state`">
            <button
              v-for="action in control.actions"
              :key="action.id"
              type="button"
              class="min-h-11 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="actionButtonClass(controlValue(control) === action.value)"
              :data-aircraft-action="action.id"
              :aria-label="`${control.title}: ${action.label}`"
              :aria-pressed="controlValue(control) === action.value"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              :aria-describedby="controlStatusId(control)"
              :title="actionDisabledReason(control, action.id) || undefined"
              :disabled="actionDisabled(control, action.id)"
              @click="requestControlAction(control, action.id)"
            >
              {{ groupPending(control.groupId) ? 'SENDING...' : action.label }}
            </button>
          </div>
          <p
            :id="controlStatusId(control)"
            class="mt-2 text-[10px] leading-relaxed text-gray-500"
            role="status"
            aria-live="polite"
          >{{ controlStatus(control) }}</p>
        </article>
      </div>

      <div class="mb-2 mt-4 text-[9px] font-semibold uppercase tracking-widest text-gray-500">Selected targets</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <form
          v-for="control in selectorControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-fenix-fcu-selector="control.id"
          :data-aircraft-control-group="control.groupId"
          @submit.prevent="submitSelector(control)"
        >
          <div class="mb-2 flex items-start justify-between gap-2">
            <label
              :for="`fenix-selector-input-${control.id}`"
              class="text-[10px] font-semibold tracking-wide text-gray-200"
            >{{ control.label }}</label>
            <span class="text-right text-[9px] uppercase tracking-widest text-gray-500">
              LIVE {{ selectorLiveText(control) }}<template v-if="selectorLiveUnit(control)"> {{ selectorLiveUnit(control) }}</template>
            </span>
          </div>
          <div class="flex items-stretch gap-2">
            <input
              :id="`fenix-selector-input-${control.id}`"
              type="text"
              class="min-h-11 min-w-0 flex-1 rounded-lg border border-surface-300 bg-surface-100 px-3 py-2 font-mono text-base font-semibold tabular-nums text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-45"
              :value="selectorDrafts[control.id]"
              :inputmode="control.inputmode"
              enterkeyhint="done"
              autocomplete="off"
              :data-fenix-selector-input="control.id"
              :aria-label="`Set Fenix ${control.label} target in ${control.unit}`"
              :aria-describedby="selectorDescribedBy(control)"
              :aria-invalid="selectorErrors[control.id] ? 'true' : 'false'"
              :aria-busy="selectorPending(control) ? 'true' : 'false'"
              :title="selectorDisabledReason(control) || undefined"
              :disabled="selectorDisabled(control)"
              @input="updateSelectorDraft(control, $event)"
              @keydown.enter.prevent="submitSelector(control)"
            >
            <button
              type="submit"
              class="min-h-11 shrink-0 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[10px] font-semibold text-cyan-100 transition-colors hover:border-cyan-400/70 hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-45"
              :data-aircraft-action="selectorActionId(control)"
              :aria-label="`Apply Fenix ${control.label} target`"
              :aria-describedby="selectorDescribedBy(control)"
              :aria-busy="selectorPending(control) ? 'true' : 'false'"
              :title="selectorDisabledReason(control) || undefined"
              :disabled="selectorDisabled(control)"
            >{{ selectorPending(control) ? 'SENDING...' : 'APPLY' }}</button>
          </div>
          <p
            :id="selectorStatusId(control)"
            class="mt-2 text-[10px] leading-relaxed text-gray-500"
            role="status"
            aria-live="polite"
          >{{ selectorStatus(control) }}</p>
          <p
            v-if="selectorErrors[control.id]"
            :id="selectorErrorId(control)"
            class="mt-1 text-[10px] leading-relaxed text-rose-300"
            role="alert"
          >{{ selectorErrors[control.id] }}</p>
        </form>

        <article
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          data-fenix-fcu-readback="vertical"
        >
          <div class="text-[10px] font-semibold tracking-wide text-gray-200">V/S / FPA</div>
          <div class="mt-2 font-mono text-xl font-semibold tabular-nums text-gray-100">{{ verticalReadbackText() }}</div>
          <p class="mt-2 text-[10px] leading-relaxed text-gray-500">
            Read-only live FCU value. Units are mode-dependent (V/S or FPA); change this target in the cockpit.
          </p>
        </article>
      </div>

      <div class="mb-2 mt-4 text-[9px] font-semibold uppercase tracking-widest text-gray-500">Managed / selected</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="control in managedModeControls"
          :key="control.groupId"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-fenix-fcu-managed="control.groupId"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-[10px] font-semibold tracking-wide text-gray-200">{{ control.title }}</span>
            <span class="text-[9px] uppercase tracking-widest text-gray-500">{{ controlValue(control) === true ? 'MANAGED' : (controlValue(control) === false ? 'SELECTED' : '--') }}</span>
          </div>
          <div class="grid grid-cols-2 gap-2" role="group" :aria-label="`${control.title} managed or selected mode`">
            <button
              v-for="action in control.actions"
              :key="action.id"
              type="button"
              class="min-h-11 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="actionButtonClass(controlValue(control) === action.value)"
              :data-aircraft-action="action.id"
              :aria-label="`${control.title}: ${action.label}`"
              :aria-pressed="controlValue(control) === action.value"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              :aria-describedby="controlStatusId(control)"
              :title="actionDisabledReason(control, action.id) || undefined"
              :disabled="actionDisabled(control, action.id)"
              @click="requestControlAction(control, action.id)"
            >
              {{ groupPending(control.groupId) ? 'SENDING...' : action.label }}
            </button>
          </div>
          <p
            :id="controlStatusId(control)"
            class="mt-2 text-[10px] leading-relaxed text-gray-500"
            role="status"
            aria-live="polite"
          >{{ controlStatus(control) }}</p>
        </article>
      </div>
    </section>

    <div
      v-for="section in controlSections"
      :key="section.id"
      :id="`fenix-section-${section.id}`"
      class="aircraft-mobile-navigable-section"
      tabindex="-1"
      :data-aircraft-control-section="section.id"
    >
      <div class="dashboard-section-kicker">{{ section.title }}</div>
      <p v-if="section.note" class="mb-2 text-[10px] leading-relaxed text-gray-500">{{ section.note }}</p>
      <p
        v-if="section.id === 'pneumatic' && variant === 'A321'"
        class="mb-2 text-[10px] leading-relaxed text-gray-500"
      >
        The A321 uses ECON FLOW; the A319/A320 PACK FLOW selector is hidden.
      </p>
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
          <div class="grid gap-2" :class="controlGridClass(control)" role="group" :aria-label="`${control.title} position`">
            <button
              v-for="action in control.actions"
              :key="action.id"
              type="button"
              class="min-h-11 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="actionButtonClass(controlValue(control) === action.value)"
              :data-aircraft-action="action.id"
              :aria-pressed="controlValue(control) === action.value"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              :aria-describedby="actionDisabled(control, action.id) ? controlStatusId(control) : undefined"
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
            role="status"
            aria-live="polite"
          >{{ controlStatus(control) }}</p>
        </div>
      </div>
    </div>

    <p class="text-[10px] leading-relaxed text-gray-500">
      Only the listed states and validated FCU values can be sent. Controls require the bundled Fenix profile, a connected simulator, current aircraft data, and a supported write connection. Commands are rate limited, confirmed from the aircraft, and never retried automatically.
    </p>
    <p class="text-[10px] leading-relaxed text-gray-500">
      Unofficial Fenix A32X compatibility. Flight Fabric is not affiliated with FenixSim. A separately licensed Fenix aircraft is required, and no Fenix software is included.
    </p>
    <p class="text-[10px] leading-relaxed text-amber-300/80">
      These controls change the simulated aircraft. Most expanded controls still need live testing across every A319, A320, and A321 release. Check critical changes in the cockpit. Emergency, maintenance, circuit breaker, arbitrary axis, and reverse-thrust controls are not included.
    </p>
  </div>
</template>
