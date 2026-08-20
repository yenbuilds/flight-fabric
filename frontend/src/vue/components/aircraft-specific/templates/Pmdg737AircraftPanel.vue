<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue';
import { mcpDraftKey, submitMcpDraft } from '../mcp-input.js';
import { useDocumentEvent } from '../../../composables/useDocumentEvent.js';

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
const authorizationState = ref(electronApi ? 'unknown' : 'unavailable');
const eulaOpened = ref(false);
const eulaConfirmed = ref(false);
const authorizationBusy = ref(false);
const authorizationError = ref('');
const mcpDrafts = ref({});
const sectionRibbon = ref(null);
const sectionMenu = ref(null);
const sectionMenuButton = ref(null);
const activeSectionIndex = ref(0);
const sectionMenuOpen = ref(false);
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
  Object.freeze({ id: 'cabin', label: 'Cabin', title: 'Cabin & Visibility', detail: 'Signs, emergency lights and windshield wipers.' }),
  Object.freeze({ id: 'flight-controls', label: 'Controls', title: 'Flight Controls', detail: 'Flaps, speedbrake, yaw damper and trim status.' }),
  Object.freeze({ id: 'gear-brakes', label: 'Gear', title: 'Gear & Brakes', detail: 'Gear position, parking brake, autobrake and anti-skid.' }),
  Object.freeze({ id: 'systems', label: 'Systems', title: 'Systems Snapshot', detail: 'Packs, bleed air, anti-ice and warning state.' }),
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
  { id: 'mcp.headingDeg', actionId: 'mcp.heading.set', label: 'HEADING', unit: '\u00b0', digits: 3, min: 0, max: 359, step: 1 },
  { id: 'mcp.altitudeFt', actionId: 'mcp.altitude.set', label: 'ALTITUDE', unit: 'ft', locale: true, min: 0, max: 50000, step: 100 },
  { id: 'mcp.verticalSpeedFpm', actionId: 'mcp.verticalSpeed.set', label: 'VERT SPEED', unit: 'fpm', signed: true, min: -7900, max: 6000, step: 100 },
  { id: 'mcp.courseFirstOfficerDeg', actionId: 'mcp.courseFirstOfficer.set', label: 'COURSE R', unit: '\u00b0', digits: 3, min: 0, max: 359, step: 1 },
];

const afdsModes = [
  ['afds.flightDirectorCaptain', 'FD L', 'toggle'],
  ['afds.autothrottleArm', 'A/T ARM', 'toggle'],
  ['afds.autothrottleActive', 'A/T'],
  ['afds.n1', 'N1', 'engage'],
  ['afds.speed', 'SPEED', 'engage'],
  ['afds.levelChange', 'LVL CHG', 'engage'],
  ['afds.vnav', 'VNAV', 'engage'],
  ['afds.headingSelect', 'HDG SEL', 'engage'],
  ['afds.lnav', 'LNAV', 'engage'],
  ['afds.vorLoc', 'VOR/LOC', 'engage'],
  ['afds.approach', 'APP', 'engage'],
  ['afds.altitudeHold', 'ALT HLD', 'engage'],
  ['afds.verticalSpeed', 'V/S', 'engage'],
  ['afds.cmdA', 'CMD A', 'engage'],
  ['afds.cmdB', 'CMD B', 'engage'],
  ['afds.cwsA', 'CWS A', 'engage'],
  ['afds.cwsB', 'CWS B', 'engage'],
  ['afds.flightDirectorFirstOfficer', 'FD R', 'toggle'],
].map(([id, label, control]) => ({ id, label, control }));

const navRadios = [
  {
    id: 'nav1', label: 'NAV 1', active: 'radios.nav1ActiveMhz', standby: 'radios.nav1StandbyMhz',
  },
  {
    id: 'nav2', label: 'NAV 2', active: 'radios.nav2ActiveMhz', standby: 'radios.nav2StandbyMhz',
  },
];

function booleanControl(title, fieldId, prefix = fieldId) {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: [
      { id: `${prefix}.off`, label: 'OFF', value: false },
      { id: `${prefix}.on`, label: 'ON', value: true },
    ],
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
  booleanControl('TAXI', 'lights.taxi'),
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
  { id: 'systems.wingAntiIce', label: 'WING A.ICE' },
  { id: 'systems.engineAntiIceLeft', label: 'ENG A.ICE L' },
  { id: 'systems.engineAntiIceRight', label: 'ENG A.ICE R' },
  { id: 'systems.engineBleedLeft', label: 'ENG BLEED L' },
  { id: 'systems.engineBleedRight', label: 'ENG BLEED R' },
  { id: 'systems.apuBleed', label: 'APU BLEED' },
  { id: 'systems.irsAligned', label: 'IRS ALIGNED' },
  { id: 'warnings.masterCaution', label: 'MASTER CAUTION', tone: 'warning' },
  { id: 'warnings.masterWarning', label: 'MASTER WARNING', tone: 'danger' },
];

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
  if (field.id !== 'mcp.speed') return field;
  const machMode = typeof value(field.id) === 'number' && value(field.id) > 0 && value(field.id) < 10;
  return machMode
    ? { ...field, actionId: 'mcp.mach.set', min: 0.4, max: 0.99, step: 0.01 }
    : { ...field, actionId: 'mcp.ias.set', min: 100, max: 399, step: 1 };
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

function mcpDisabled(field) {
  const config = mcpInputConfig(field);
  return props.sourceStatus !== 'connected'
    || !hasValue(field.id)
    || !actionSupported(config.actionId)
    || groupPending(field.id);
}

function requestMcpAction(field) {
  const config = mcpInputConfig(field);
  const sent = submitMcpDraft({
    config,
    disabled: mcpDisabled(field),
    groupId: field.id,
    rawValue: mcpDraft(field),
    requestAction: props.requestAction,
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
    || !actionSupported(actionId)
    || groupPending(mode.id);
}

function requestAfdsAction(mode) {
  const actionId = afdsActionId(mode);
  if (afdsDisabled(mode)) return false;
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

function controlValue(control) {
  const current = value(control.fieldId);
  return typeof current === 'boolean' || typeof current === 'string' ? current : null;
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

function actionDisabled(control, actionId) {
  return props.sourceStatus !== 'connected'
    || controlValue(control) === null
    || !actionSupported(actionId)
    || groupPending(control.groupId);
}

function requestControlAction(control, actionId) {
  if (actionDisabled(control, actionId)) return false;
  return props.requestAction(actionId, control.groupId);
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

function goToSection(index) {
  const boundedIndex = Math.max(0, Math.min(mobileSections.length - 1, Number(index)));
  const target = sectionElement(boundedIndex);
  if (!target) return false;

  activeSectionIndex.value = boundedIndex;
  closeSectionMenu();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  target.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  target.focus?.({ preventScroll: true });
  return true;
}

function handleSectionButtonClick(index) {
  if (suppressRibbonClick) {
    suppressRibbonClick = false;
    return;
  }
  goToSection(index);
}

function handleRibbonPointerDown(event) {
  if (event?.button != null && event.button !== 0) return;
  ribbonSwipeStart = {
    pointerId: event.pointerId,
    x: Number(event.clientX),
    y: Number(event.clientY),
  };
  event.currentTarget?.setPointerCapture?.(event.pointerId);
}

function clearRibbonSwipe() {
  ribbonSwipeStart = null;
}

function handleRibbonPointerUp(event) {
  const start = ribbonSwipeStart;
  clearRibbonSwipe();
  if (!start || start.pointerId !== event.pointerId) return;

  const deltaX = Number(event.clientX) - start.x;
  const deltaY = Number(event.clientY) - start.y;
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
}

function scheduleSectionSync() {
  if (sectionSyncTimer != null) return;
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
        <p class="text-xs text-gray-500">Official PMDG SDK state with guarded MCP, radio, light, sign, and wiper controls.</p>
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
        @click="handleSectionButtonClick(activeSectionIndex + 1)"
      >
        <span>{{ nextSection?.label || 'End' }}</span>
        <span aria-hidden="true">&rsaquo;</span>
      </button>
    </nav>

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

    <section
      id="pmdg-737-section-mcp"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="mcp"
      tabindex="-1"
    >
      <div class="dashboard-section-kicker">Mode Control Panel</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        <form v-for="field in mcpWindows" :key="field.id" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="field.id" @submit.prevent="requestMcpAction(field)">
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
      <div class="dashboard-section-kicker">Navigation Radios</div>
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
    </section>

    <section
      id="pmdg-737-section-exterior"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="exterior"
      tabindex="-1"
    >
      <div class="dashboard-section-kicker">Exterior Lights</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div v-for="control in exteriorControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
          <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ valueText(control.fieldId) }}</span></div>
          <div class="grid gap-1.5" :class="control.actions.length === 3 ? 'grid-cols-3' : 'grid-cols-2'">
            <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold leading-tight disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
          </div>
        </div>
      </div>
    </section>

    <section
      id="pmdg-737-section-cabin"
      class="pmdg-mobile-navigable-section"
      data-pmdg-737-section="cabin"
      tabindex="-1"
    >
      <div class="dashboard-section-kicker">Cabin &amp; Visibility</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        <div v-for="control in cabinControls" :key="control.groupId" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-aircraft-control-group="control.groupId">
          <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-200"><span>{{ control.title }}</span><span class="text-[9px] text-gray-500">{{ valueText(control.fieldId) }}</span></div>
          <div class="grid gap-1.5" :class="control.actions.length === 4 ? 'grid-cols-4' : 'grid-cols-3'">
            <button v-for="action in control.actions" :key="action.id" type="button" class="min-h-10 rounded border px-1 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" :class="actionButtonClass(controlValue(control) === action.value)" :data-aircraft-action="action.id" :aria-pressed="controlValue(control) === action.value" :disabled="actionDisabled(control, action.id)" @click="requestControlAction(control, action.id)">{{ action.label }}</button>
          </div>
        </div>
      </div>
    </section>

    <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <section
        id="pmdg-737-section-flight-controls"
        class="pmdg-mobile-navigable-section"
        data-pmdg-737-section="flight-controls"
        tabindex="-1"
      >
        <div class="dashboard-section-kicker">Flight Controls</div>
        <div class="grid grid-cols-2 gap-2 mb-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3"><div class="text-[9px] uppercase tracking-widest text-gray-500">Flap needle L</div><div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ valueText('flightControls.flapNeedleLeft') }}</div></div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3"><div class="text-[9px] uppercase tracking-widest text-gray-500">Flap needle R</div><div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ valueText('flightControls.flapNeedleRight') }}</div></div>
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
        <div class="dashboard-section-kicker">Gear &amp; Brakes</div>
        <div class="grid grid-cols-3 gap-2 mb-2">
          <div v-for="gear in gearIndicators" :key="gear.label" class="rounded-lg border p-3 text-center" :class="gearClass(gear)"><div class="text-[10px] font-semibold">{{ gear.label }}</div><div class="mt-1 text-xs opacity-80">{{ gearState(gear).toUpperCase() }}</div></div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded border border-surface-200 bg-surface-50 p-2.5 text-[10px] text-gray-300">GEAR HANDLE <span class="float-right font-semibold">{{ valueText('gear.handleMode') }}</span></div>
          <div class="rounded border border-surface-200 bg-surface-50 p-2.5 text-[10px] text-gray-300">AUTOBRAKE <span class="float-right font-semibold">{{ valueText('gear.autobrakeMode') }}</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('gear.parkingBrake', 'warning')">PARKING BRAKE <span class="float-right opacity-70">{{ valueText('gear.parkingBrake') }}</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('gear.autobrakeDisarm', 'danger')">AUTOBRAKE DISARM <span class="float-right opacity-70">{{ valueText('gear.autobrakeDisarm') }}</span></div>
          <div class="col-span-2 rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('gear.antiSkidInoperative', 'danger')">ANTI-SKID INOP <span class="float-right opacity-70">{{ valueText('gear.antiSkidInoperative') }}</span></div>
        </div>
      </section>

      <section
        id="pmdg-737-section-systems"
        class="pmdg-mobile-navigable-section"
        data-pmdg-737-section="systems"
        tabindex="-1"
      >
        <div class="dashboard-section-kicker">Systems Snapshot</div>
        <p class="mb-2 text-[10px] text-gray-500">Monitoring-only in this pass.</p>
        <div class="grid grid-cols-2 gap-2 mb-2">
          <div class="rounded border border-surface-200 bg-surface-50 p-2.5 text-[10px] text-gray-300">PACK L <span class="float-right font-semibold">{{ valueText('systems.packLeftMode') }}</span></div>
          <div class="rounded border border-surface-200 bg-surface-50 p-2.5 text-[10px] text-gray-300">PACK R <span class="float-right font-semibold">{{ valueText('systems.packRightMode') }}</span></div>
          <div class="rounded border border-surface-200 bg-surface-50 p-2.5 text-[10px] text-gray-300">APU SELECTOR <span class="float-right font-semibold">{{ valueText('systems.apuMode') }}</span></div>
          <div class="rounded border border-surface-200 bg-surface-50 p-2.5 text-[10px] text-gray-300">APU EGT <span class="float-right font-semibold">{{ valueText('systems.apuEgt') }}</span></div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div v-for="indicator in systemIndicators" :key="indicator.id" class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass(indicator.id, indicator.tone)">{{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span></div>
        </div>
      </section>
    </div>

    <p class="text-[10px] leading-relaxed text-amber-300/80">
      Live NG3 SDK validation is still required for every 737 family variant. Confirm each enabled control against its cockpit switch before relying on it operationally.
    </p>
  </div>
</template>

<style scoped>
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
  .pmdg-mobile-section-ribbon {
    position: sticky;
    top: 4.75rem;
    z-index: 36;
    display: grid;
    grid-template-columns: minmax(0, 28fr) minmax(0, 44fr) minmax(0, 28fr);
    min-height: 3.75rem;
    overflow: hidden;
    border: 1px solid rgb(var(--border-strong) / 0.8);
    border-radius: 9px;
    background: rgb(var(--panel) / 0.98);
    box-shadow: 0 12px 28px rgb(0 0 0 / 0.38);
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
  }

  .pmdg-mobile-section-ribbon button {
    min-width: 0;
    min-height: 3.75rem;
    padding: 0.45rem 0.35rem;
  }

  .pmdg-mobile-section-ribbon__neighbor {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    color: rgb(var(--muted-foreground));
    font-family: var(--ff-font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .pmdg-mobile-section-ribbon__neighbor span:not([aria-hidden="true"]) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    display: grid;
    place-content: center;
    border-right: 1px solid rgb(var(--border) / 0.72);
    border-left: 1px solid rgb(var(--border) / 0.72);
    background: rgb(var(--primary) / 0.1);
    text-align: center;
  }

  .pmdg-mobile-section-ribbon__current strong,
  .pmdg-mobile-section-ribbon__current small {
    display: block;
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
    margin-top: 0.16rem;
    color: rgb(var(--muted-foreground));
    font-size: 0.58rem;
  }

  .pmdg-mobile-navigable-section {
    scroll-margin-top: 9rem;
  }

  .pmdg-mobile-navigable-section:focus {
    outline: none;
  }
}

@media (max-height: 500px) and (pointer: coarse) {
  .pmdg-mobile-section-ribbon {
    top: 3.35rem;
    min-height: 3.25rem;
  }

  .pmdg-mobile-section-ribbon button {
    min-height: 3.25rem;
  }

  .pmdg-mobile-navigable-section {
    scroll-margin-top: 7.25rem;
  }

  .pmdg-section-menu__choices {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: calc(var(--ff-visual-viewport-height, 100dvh) - 5.5rem);
  }
}
</style>
