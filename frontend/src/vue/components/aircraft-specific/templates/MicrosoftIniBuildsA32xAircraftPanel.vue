<script>
function formatMicrosoftIniBuildsA32xDraft(rawValue) {
  const current = Number(rawValue);
  if (!Number.isFinite(current)) return '';
  return Number.isInteger(current) ? String(current) : String(Number(current.toFixed(2)));
}

export function reconcileMicrosoftIniBuildsA32xNumericDraftState(state = {}, snapshot = {}, previous = []) {
  const {
    rawValue,
    unavailable = false,
    profileKey,
    sourceStatus,
    pending = false,
  } = snapshot;
  const next = {
    draft: typeof state.draft === 'string' ? state.draft : '',
    dirty: state.dirty === true,
    error: typeof state.error === 'string' ? state.error : '',
  };
  const contextChanged = previous[2] !== undefined
    && (previous[2] !== profileKey || previous[3] !== sourceStatus);

  if (contextChanged || sourceStatus !== 'connected' || unavailable) {
    next.dirty = false;
    next.error = '';
  }
  if (unavailable || sourceStatus !== 'connected') {
    next.draft = '';
    return next;
  }
  if (!contextChanged && previous[4] !== undefined && pending) return next;
  if (!next.dirty) next.draft = formatMicrosoftIniBuildsA32xDraft(rawValue);
  return next;
}
</script>

<script setup>
import { computed, reactive, watch } from 'vue';
import { useAircraftControlsStore } from '../../../stores/aircraft-controls.js';
import { parseMcpDraftNumber, submitMcpDraft } from '../mcp-input.js';

const props = defineProps({
  profileKey: { type: String, default: '' },
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  sourceStatuses: { type: Object, default: () => ({}) },
  actionCapabilities: { type: Object, default: () => ({}) },
  requestAction: { type: Function, default: () => false },
  isActionPending: { type: Function, default: () => false },
});

const aircraftControls = useAircraftControlsStore();
const unavailableFields = computed(() => new Set(props.unavailable));
const title = computed(() => (
  props.profileKey.endsWith('/inibuilds-a321lr')
    ? 'Microsoft / iniBuilds Airbus A321LR'
    : 'Microsoft / iniBuilds Airbus A320neo V2'
));
const controlSessionReady = computed(() => (
  props.sourceStatus === 'connected'
  && aircraftControls.availability.enabled === true
));

const selectorControls = Object.freeze([
  {
    id: 'speed', label: 'SPD', fieldId: 'fcu.speedKts', actionId: 'flightGuidance.speed.set',
    groupId: 'flightGuidance.speed', min: 100, max: 399, step: 1, unit: 'kt', inputmode: 'numeric',
  },
  {
    id: 'heading', label: 'HDG', fieldId: 'fcu.headingDeg', actionId: 'flightGuidance.heading.set',
    groupId: 'flightGuidance.heading', min: 0, max: 359, step: 1, unit: 'deg', inputmode: 'numeric',
  },
  {
    id: 'altitude', label: 'ALT', fieldId: 'fcu.altitudeFt', actionId: 'flightGuidance.altitude.set',
    groupId: 'flightGuidance.altitude', min: 0, max: 49000, step: 100, unit: 'ft', inputmode: 'numeric',
  },
  {
    id: 'vertical-speed', label: 'V/S', fieldId: 'fcu.verticalSpeedFpm', actionId: 'flightGuidance.verticalSpeed.set',
    groupId: 'flightGuidance.verticalSpeed', min: -6000, max: 6000, step: 100, unit: 'fpm', inputmode: 'decimal',
  },
]);

const modeControls = Object.freeze([
  { id: 'ap', label: 'AP MASTER', fieldId: 'flightGuidance.apMaster', prefix: 'flightGuidance.apMaster' },
  { id: 'fd', label: 'FD', fieldId: 'flightGuidance.flightDirector', prefix: 'flightGuidance.flightDirector' },
  { id: 'athr', label: 'A/THR ARM', fieldId: 'flightGuidance.autothrottleArmed', prefix: 'flightGuidance.autothrottleArmed' },
  { id: 'speed', label: 'SPD', fieldId: 'flightGuidance.speedHold', prefix: 'flightGuidance.speedHold' },
  { id: 'heading', label: 'HDG', fieldId: 'flightGuidance.headingHold', prefix: 'flightGuidance.headingHold' },
  { id: 'altitude', label: 'ALT', fieldId: 'flightGuidance.altitudeHold', prefix: 'flightGuidance.altitudeHold' },
  { id: 'vertical-speed', label: 'V/S', fieldId: 'flightGuidance.verticalSpeedHold', prefix: 'flightGuidance.verticalSpeedHold' },
  { id: 'nav', label: 'NAV', fieldId: 'flightGuidance.navHold', prefix: 'flightGuidance.navHold' },
  { id: 'approach', label: 'APPR', fieldId: 'flightGuidance.approachHold', prefix: 'flightGuidance.approachHold' },
].map((control) => Object.freeze({
  ...control,
  groupId: control.prefix,
  offActionId: `${control.prefix}.off`,
  onActionId: `${control.prefix}.on`,
})));

const lightControls = Object.freeze([
  { id: 'strobe', label: 'STROBE' },
  { id: 'beacon', label: 'BEACON' },
  { id: 'nav', label: 'NAV' },
  { id: 'logo', label: 'LOGO' },
  { id: 'wing', label: 'WING' },
  { id: 'landing', label: 'LANDING' },
  { id: 'taxi', label: 'TAXI' },
].map((control) => Object.freeze({
  ...control,
  fieldId: `lights.${control.id}`,
  groupId: `lights.${control.id}`,
  offActionId: `lights.${control.id}.off`,
  onActionId: `lights.${control.id}.on`,
})));

const surfaceControls = Object.freeze([
  {
    id: 'gear', label: 'GEAR HANDLE', fieldId: 'controls.gearHandleDown', groupId: 'controls.gear',
    offActionId: 'controls.gear.up', onActionId: 'controls.gear.down', offLabel: 'UP', onLabel: 'DOWN',
  },
  {
    id: 'parking-brake', label: 'PARK BRAKE', fieldId: 'controls.parkingBrake', groupId: 'controls.parkingBrake',
    offActionId: 'controls.parkingBrake.off', onActionId: 'controls.parkingBrake.on', offLabel: 'RELEASE', onLabel: 'SET',
  },
]);

const flapControl = Object.freeze({
  id: 'flaps',
  fieldId: 'controls.flapsIndex',
  groupId: 'controls.flaps',
  decreaseActionId: 'controls.flaps.decrease',
  increaseActionId: 'controls.flaps.increase',
});

const selectorDrafts = reactive({});
const selectorDirty = reactive({});
const selectorErrors = reactive({});

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

function booleanValue(id) {
  const current = value(id);
  return typeof current === 'boolean' ? current : null;
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

for (const control of selectorControls) {
  watch(
    () => [
      props.values[control.fieldId],
      props.unavailable.includes(control.fieldId),
      props.profileKey,
      props.sourceStatus,
      groupPending(control.groupId),
    ],
    ([rawValue, unavailable, profileKey, sourceStatus, pending], previous = []) => {
      const next = reconcileMicrosoftIniBuildsA32xNumericDraftState({
        draft: selectorDrafts[control.id],
        dirty: selectorDirty[control.id],
        error: selectorErrors[control.id],
      }, { rawValue, unavailable, profileKey, sourceStatus, pending }, previous);
      selectorDrafts[control.id] = next.draft;
      selectorDirty[control.id] = next.dirty;
      selectorErrors[control.id] = next.error;
    },
    { immediate: true },
  );
}

function integerText(id, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : Math.round(current).toLocaleString('en-US');
}

function decimalText(id, precision = 1, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : current.toFixed(precision);
}

function booleanText(id, trueLabel = 'ON', falseLabel = 'OFF') {
  const current = booleanValue(id);
  if (current === true) return trueLabel;
  if (current === false) return falseLabel;
  return '--';
}

function tonnesText(id) {
  const pounds = numberValue(id);
  return pounds === null ? '--' : (pounds * 0.00045359237).toFixed(1);
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function globalControlReason() {
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (!aircraftControls.availability.enabled) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  return '';
}

function actionReadbackAvailable(control) {
  if (control === flapControl) return numberValue(control.fieldId) !== null;
  return booleanValue(control.fieldId) !== null;
}

function actionDisabled(control, actionId) {
  return !controlSessionReady.value
    || !actionReadbackAvailable(control)
    || !actionSupported(actionId)
    || groupPending(control.groupId);
}

function actionDisabledReason(control, actionId) {
  if (!actionDisabled(control, actionId)) return '';
  if (groupPending(control.groupId)) return 'Command in progress.';
  const globalReason = globalControlReason();
  if (globalReason) return globalReason;
  if (!actionReadbackAvailable(control)) return 'Live aircraft readback unavailable.';
  if (!actionSupported(actionId)) return 'Compatible aircraft control unavailable.';
  return 'Control temporarily unavailable.';
}

function actionIdsFor(control) {
  if (control === flapControl) return [control.decreaseActionId, control.increaseActionId];
  return [control.offActionId, control.onActionId];
}

function controlStatusId(control) {
  return `microsoft-inibuilds-a32x-status-${control.groupId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function controlStatus(control) {
  if (groupPending(control.groupId)) return 'Command in progress.';
  const globalReason = globalControlReason();
  if (globalReason) return globalReason;
  if (!actionReadbackAvailable(control)) return 'Live aircraft readback unavailable.';
  if (actionIdsFor(control).some((actionId) => !actionSupported(actionId))) {
    return 'Compatible aircraft control unavailable.';
  }
  return 'Ready.';
}

function requestControlAction(control, actionId) {
  if (actionDisabled(control, actionId)) return false;
  return props.requestAction(actionId, control.groupId);
}

function fixedActionClass(selected) {
  return selected
    ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100 shadow-sm'
    : 'border-surface-300 bg-surface-100 text-gray-300 hover:border-surface-400 hover:bg-surface-200';
}

function numericDisabled(control) {
  return !controlSessionReady.value
    || numberValue(control.fieldId) === null
    || !actionSupported(control.actionId)
    || groupPending(control.groupId);
}

function numericDisabledReason(control) {
  if (!numericDisabled(control)) return '';
  if (groupPending(control.groupId)) return 'Command in progress.';
  const globalReason = globalControlReason();
  if (globalReason) return globalReason;
  if (numberValue(control.fieldId) === null) return 'Live target readback unavailable.';
  if (!actionSupported(control.actionId)) return 'Compatible target control unavailable.';
  return 'Target control temporarily unavailable.';
}

function numericStatusId(control) {
  return `microsoft-inibuilds-a32x-target-status-${control.id}`;
}

function numericStatus(control) {
  const reason = numericDisabledReason(control);
  if (reason) return reason;
  return `Enter ${control.min.toLocaleString('en-US')} to ${control.max.toLocaleString('en-US')} in ${control.step.toLocaleString('en-US')} ${control.unit} increments.`;
}

function numericLiveText(control) {
  const current = numberValue(control.fieldId);
  if (current === null) return control.id === 'heading' ? '---' : '--';
  if (control.id === 'heading') return String(Math.round(current)).padStart(3, '0');
  const rounded = Math.round(current);
  return `${control.id === 'vertical-speed' && rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`;
}

function updateNumericDraft(control, event) {
  selectorDrafts[control.id] = event?.target?.value ?? '';
  selectorDirty[control.id] = true;
  selectorErrors[control.id] = '';
}

function submitNumeric(control) {
  if (numericDisabled(control)) return false;
  const rawValue = selectorDrafts[control.id];
  if (parseMcpDraftNumber(rawValue, control) === null) {
    selectorErrors[control.id] = numericStatus(control);
    return false;
  }
  const sent = submitMcpDraft({
    config: control,
    disabled: false,
    groupId: control.groupId,
    rawValue,
    requestAction: props.requestAction,
  });
  if (!sent) {
    selectorErrors[control.id] = 'Command could not be sent.';
    return false;
  }
  selectorErrors[control.id] = '';
  selectorDirty[control.id] = false;
  return true;
}

function gearClass(id) {
  const current = numberValue(id);
  if (current === null) return 'border-surface-200 bg-surface-50 text-gray-500';
  if (current >= 99) return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
  if (current <= 1) return 'border-surface-200 bg-surface-50 text-gray-400';
  return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
}

function pairedGearClass() {
  const left = numberValue('controls.gearLeftPct');
  const right = numberValue('controls.gearRightPct');
  if (left === null || right === null) return 'border-surface-200 bg-surface-50 text-gray-500';
  if (left >= 99 && right >= 99) return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
  if (left <= 1 && right <= 1) return 'border-surface-200 bg-surface-50 text-gray-400';
  return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
}

const pageStatus = computed(() => {
  const globalReason = globalControlReason();
  if (globalReason) return globalReason;
  if ([...selectorControls, ...modeControls, ...lightControls, ...surfaceControls, flapControl]
    .some((control) => groupPending(control.groupId))) return 'Command in progress.';
  return 'Controls ready.';
});
</script>

<template>
  <div class="space-y-5 p-3 sm:p-4" data-aircraft-template="microsoft-inibuilds-a32x" :data-aircraft-profile-key="profileKey">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-gray-100">{{ title }}</h3>
        <p class="mt-0.5 text-xs leading-relaxed text-gray-500">Compact FCU, exterior-light and flight-configuration controls with standard live readback.</p>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        <span class="rounded border border-surface-300 px-2 py-1 text-[9px] uppercase tracking-widest text-gray-400">{{ sourceStatus }}</span>
        <span class="rounded border border-cyan-500/35 bg-cyan-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-cyan-300">Standard controls</span>
        <span class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">Experimental</span>
      </div>
    </header>

    <p class="rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[10px] leading-relaxed text-gray-400" aria-live="polite">
      {{ pageStatus }} A/THR active, FLC, speedbrake and runway-turnoff remain read-only.
    </p>

    <section data-microsoft-inibuilds-a32x-section="fcu">
      <div class="dashboard-section-kicker">Flight Control Unit</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <form
          v-for="control in selectorControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-microsoft-inibuilds-a32x-selector="control.id"
          :data-aircraft-control-group="control.groupId"
          @submit.prevent="submitNumeric(control)"
        >
          <div class="flex items-center justify-between gap-3">
            <label class="text-[9px] font-semibold uppercase tracking-widest text-gray-500" :for="`microsoft-inibuilds-a32x-target-${control.id}`">{{ control.label }}</label>
            <span class="font-mono text-sm font-semibold text-cyan-100">{{ numericLiveText(control) }} <span class="text-[9px] text-gray-500">{{ control.unit }}</span></span>
          </div>
          <div class="mt-2 flex gap-2">
            <input
              :id="`microsoft-inibuilds-a32x-target-${control.id}`"
              type="text"
              class="min-h-11 min-w-0 flex-1 rounded-md border border-surface-300 bg-surface-100 px-3 font-mono text-sm text-gray-100 outline-none focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-45"
              :value="selectorDrafts[control.id]"
              :inputmode="control.inputmode"
              autocomplete="off"
              spellcheck="false"
              :aria-label="`${control.label} target in ${control.unit}`"
              :aria-describedby="numericStatusId(control)"
              :aria-invalid="selectorErrors[control.id] ? 'true' : 'false'"
              :disabled="numericDisabled(control)"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              @input="updateNumericDraft(control, $event)"
            >
            <button
              type="submit"
              class="min-h-11 rounded-md border border-cyan-500/45 bg-cyan-500/10 px-4 text-[10px] font-semibold uppercase tracking-wider text-cyan-100 transition-colors hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-45"
              :data-aircraft-action="control.actionId"
              :disabled="numericDisabled(control)"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              :title="numericDisabledReason(control) || undefined"
            >Apply</button>
          </div>
          <p v-if="selectorErrors[control.id]" class="mt-1.5 text-[10px] text-rose-300" role="alert">{{ selectorErrors[control.id] }}</p>
          <p :id="numericStatusId(control)" class="mt-1.5 text-[9px] leading-relaxed text-gray-500">{{ numericStatus(control) }}</p>
        </form>
      </div>

      <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <div
          v-for="control in modeControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-microsoft-inibuilds-a32x-mode="control.id"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{{ control.label }}</span>
            <span class="font-mono text-xs font-semibold" :class="booleanValue(control.fieldId) ? 'text-emerald-300' : 'text-gray-400'">{{ booleanText(control.fieldId) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-1.5" role="group" :aria-label="`${control.label} state`">
            <button
              v-for="target in [{ label: 'OFF', value: false, actionId: control.offActionId }, { label: 'ON', value: true, actionId: control.onActionId }]"
              :key="target.actionId"
              type="button"
              class="min-h-11 rounded-md border px-2.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="fixedActionClass(booleanValue(control.fieldId) === target.value)"
              :data-aircraft-action="target.actionId"
              :disabled="actionDisabled(control, target.actionId)"
              :aria-pressed="booleanValue(control.fieldId) === target.value ? 'true' : 'false'"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              :aria-describedby="controlStatusId(control)"
              :title="actionDisabledReason(control, target.actionId) || undefined"
              @click="requestControlAction(control, target.actionId)"
            >{{ target.label }}</button>
          </div>
          <p :id="controlStatusId(control)" class="mt-1.5 text-[9px] text-gray-500" aria-live="polite">{{ controlStatus(control) }}</p>
        </div>
      </div>

      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">
          A/THR ACTIVE <span class="float-right font-mono font-semibold">{{ booleanText('flightGuidance.autothrottleActive') }}</span>
          <div class="mt-1 text-[9px] text-gray-500">Read only</div>
        </div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">
          FLC <span class="float-right font-mono font-semibold">{{ booleanText('flightGuidance.flightLevelChange') }}</span>
          <div class="mt-1 text-[9px] text-gray-500">Read only</div>
        </div>
      </div>
    </section>

    <section data-microsoft-inibuilds-a32x-section="exterior-lights">
      <div class="dashboard-section-kicker">Exterior Lights</div>
      <p class="mb-2 text-[10px] leading-relaxed text-gray-500">OFF and ON send fixed commands. The lamp output is readback, not selector-position confirmation.</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="control in lightControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-microsoft-inibuilds-a32x-light="control.id"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{{ control.label }}</span>
            <span class="font-mono text-xs font-semibold" :class="booleanValue(control.fieldId) ? 'text-emerald-300' : 'text-gray-400'">OUTPUT {{ booleanText(control.fieldId) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-1.5" role="group" :aria-label="`${control.label} light command`">
            <button
              v-for="target in [{ label: 'OFF', actionId: control.offActionId }, { label: 'ON', actionId: control.onActionId }]"
              :key="target.actionId"
              type="button"
              class="min-h-11 rounded-md border border-surface-300 bg-surface-100 px-2.5 text-[10px] font-semibold text-gray-300 transition-colors hover:border-surface-400 hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-45"
              :data-aircraft-action="target.actionId"
              :disabled="actionDisabled(control, target.actionId)"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              :aria-describedby="controlStatusId(control)"
              :title="actionDisabledReason(control, target.actionId) || undefined"
              @click="requestControlAction(control, target.actionId)"
            >{{ target.label }}</button>
          </div>
          <p :id="controlStatusId(control)" class="mt-1.5 text-[9px] text-gray-500" aria-live="polite">{{ controlStatus(control) }}</p>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-microsoft-inibuilds-a32x-light="runway-turnoff-readonly">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">RUNWAY TURN OFF</span>
            <span class="font-mono text-xs font-semibold text-gray-400">{{ booleanText('lights.runwayTurnoff') }}</span>
          </div>
          <p class="mt-3 text-[9px] leading-relaxed text-gray-500">Read only. No distinct compatible write route is mapped.</p>
        </div>
      </div>
    </section>

    <section data-microsoft-inibuilds-a32x-section="configuration">
      <div class="dashboard-section-kicker">Flight Configuration</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div
          v-for="control in surfaceControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-microsoft-inibuilds-a32x-surface="control.id"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{{ control.label }}</span>
            <span class="font-mono text-xs font-semibold text-gray-300">{{ booleanText(control.fieldId, control.onLabel, control.offLabel) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-1.5" role="group" :aria-label="control.label">
            <button
              v-for="target in [{ label: control.offLabel, value: false, actionId: control.offActionId }, { label: control.onLabel, value: true, actionId: control.onActionId }]"
              :key="target.actionId"
              type="button"
              class="min-h-11 rounded-md border px-2.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="fixedActionClass(booleanValue(control.fieldId) === target.value)"
              :data-aircraft-action="target.actionId"
              :disabled="actionDisabled(control, target.actionId)"
              :aria-pressed="booleanValue(control.fieldId) === target.value ? 'true' : 'false'"
              :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
              :aria-describedby="controlStatusId(control)"
              :title="actionDisabledReason(control, target.actionId) || undefined"
              @click="requestControlAction(control, target.actionId)"
            >{{ target.label }}</button>
          </div>
          <p :id="controlStatusId(control)" class="mt-1.5 text-[9px] text-gray-500" aria-live="polite">{{ controlStatus(control) }}</p>
        </div>

        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-microsoft-inibuilds-a32x-surface="flaps" :data-aircraft-control-group="flapControl.groupId">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">FLAP HANDLE</span>
            <span class="font-mono text-xs font-semibold text-gray-300">INDEX {{ integerText('controls.flapsIndex') }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-1.5" role="group" aria-label="Flap handle movement">
            <button
              v-for="target in [{ label: 'LESS', actionId: flapControl.decreaseActionId }, { label: 'MORE', actionId: flapControl.increaseActionId }]"
              :key="target.actionId"
              type="button"
              class="min-h-11 rounded-md border border-surface-300 bg-surface-100 px-2.5 text-[10px] font-semibold text-gray-300 transition-colors hover:border-surface-400 hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-45"
              :data-aircraft-action="target.actionId"
              :disabled="actionDisabled(flapControl, target.actionId)"
              :aria-busy="groupPending(flapControl.groupId) ? 'true' : 'false'"
              :aria-describedby="controlStatusId(flapControl)"
              :title="actionDisabledReason(flapControl, target.actionId) || undefined"
              @click="requestControlAction(flapControl, target.actionId)"
            >{{ target.label }}</button>
          </div>
          <p :id="controlStatusId(flapControl)" class="mt-1.5 text-[9px] text-gray-500" aria-live="polite">{{ controlStatus(flapControl) }}</p>
        </div>
      </div>

      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearNosePct')">NOSE GEAR <span class="float-right">{{ integerText('controls.gearNosePct') }}%</span></div>
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="pairedGearClass()">LEFT / RIGHT GEAR <span class="float-right">{{ integerText('controls.gearLeftPct') }} / {{ integerText('controls.gearRightPct') }}%</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">FLAPS <span class="float-right font-semibold">{{ decimalText('controls.flapsPercent') }}% / {{ decimalText('controls.flapAngleDeg') }}&deg;</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300 sm:col-span-3">SPEEDBRAKE <span class="float-right font-semibold">{{ decimalText('controls.speedbrakePercent') }}%</span><div class="mt-1 text-[9px] text-gray-500">Read only</div></div>
      </div>
    </section>

    <section data-microsoft-inibuilds-a32x-section="systems">
      <div class="dashboard-section-kicker">Two-Engine &amp; System Snapshot</div>
      <div class="grid grid-cols-2 gap-2">
        <div v-for="engine in [1, 2]" :key="engine" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-microsoft-inibuilds-a32x-engine="engine">
          <div class="flex items-center justify-between text-[9px] uppercase tracking-widest text-gray-500">
            <span>ENG {{ engine }} N1</span>
            <span>{{ booleanText(`systems.engine${engine}Running`, 'RUN', 'OFF') }}</span>
          </div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText(`systems.engine${engine}N1`) }}%</div>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-2 gap-2 text-[10px] text-gray-300 sm:grid-cols-4">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">FUEL <span class="float-right font-semibold">{{ decimalText('systems.fuelTotalPct') }}%</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">FUEL WT <span class="float-right font-semibold">{{ tonnesText('systems.fuelTotalWeightLbs') }} t</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">GROSS WT <span class="float-right font-semibold">{{ tonnesText('systems.grossWeightLbs') }} t</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB ALT <span class="float-right font-semibold">{{ integerText('systems.cabinAltitudeFt') }} ft</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB V/S <span class="float-right font-semibold">{{ integerText('systems.cabinVerticalSpeedFpm') }} fpm</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">DELTA P <span class="float-right font-semibold">{{ decimalText('systems.cabinDeltaPressurePsi', 2) }} psi</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">OAT <span class="float-right font-semibold">{{ decimalText('systems.outsideAirTemperatureC') }}&deg;C</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">MACH <span class="float-right font-semibold">{{ decimalText('systems.mach', 3) }}</span></div>
      </div>
    </section>
  </div>
</template>
