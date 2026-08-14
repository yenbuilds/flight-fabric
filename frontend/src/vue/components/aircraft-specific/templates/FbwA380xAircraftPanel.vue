<script>
function formatA380NumericDraft(rawValue) {
  const current = Number(rawValue);
  if (!Number.isFinite(current)) return '';
  return Number.isInteger(current) ? String(current) : String(Number(current.toFixed(2)));
}

export function reconcileA380NumericDraftState(state = {}, snapshot = {}, previous = []) {
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

  const hasPreviousSnapshot = previous[4] !== undefined;
  if (!contextChanged && hasPreviousSnapshot && pending) return next;
  if (next.dirty !== true) next.draft = formatA380NumericDraft(rawValue);
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
const controlSessionReady = computed(() => (
  props.sourceStatus === 'connected'
  && aircraftControls.availability.enabled === true
));

const selectorControls = Object.freeze([
  {
    id: 'speed',
    label: 'SPD',
    fieldId: 'flightGuidance.speedValue',
    actionId: 'flightGuidance.speed.set',
    groupId: 'flightGuidance.speed',
    min: 100,
    max: 399,
    step: 1,
    unit: 'kt',
    inputmode: 'numeric',
  },
  {
    id: 'heading',
    label: 'HDG',
    fieldId: 'flightGuidance.headingDeg',
    actionId: 'flightGuidance.heading.set',
    groupId: 'flightGuidance.heading',
    min: 0,
    max: 359,
    step: 1,
    unit: 'deg',
    inputmode: 'numeric',
  },
  {
    id: 'altitude',
    label: 'ALT',
    fieldId: 'flightGuidance.altitudeFt',
    actionId: 'flightGuidance.altitude.set',
    groupId: 'flightGuidance.altitude',
    min: 0,
    max: 49000,
    step: 100,
    unit: 'ft',
    inputmode: 'numeric',
  },
]);

const modeControls = Object.freeze([
  {
    id: 'ap1',
    label: 'AP1',
    fieldId: 'flightGuidance.ap1',
    prefix: 'flightGuidance.ap1',
    offLabel: 'DISCONNECT',
    onLabel: 'ENGAGE',
  },
  {
    id: 'autothrust',
    label: 'A/THR',
    fieldId: 'flightGuidance.autothrust',
    prefix: 'flightGuidance.autothrust',
    offLabel: 'DISCONNECT',
    onLabel: 'ARM',
  },
  {
    id: 'localizer',
    label: 'LOC',
    fieldId: 'flightGuidance.localizer',
    prefix: 'flightGuidance.localizer',
    offLabel: 'OFF',
    onLabel: 'ON',
  },
  {
    id: 'approach',
    label: 'APPR',
    fieldId: 'flightGuidance.approach',
    prefix: 'flightGuidance.approach',
    offLabel: 'OFF',
    onLabel: 'ON',
  },
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
    id: 'gear',
    label: 'GEAR HANDLE',
    fieldId: 'controls.gearHandleDown',
    groupId: 'controls.gear',
    offActionId: 'controls.gear.up',
    onActionId: 'controls.gear.down',
    offLabel: 'UP',
    onLabel: 'DOWN',
  },
  {
    id: 'parking-brake',
    label: 'PARK BRAKE',
    fieldId: 'controls.parkingBrake',
    groupId: 'controls.parkingBrake',
    offActionId: 'controls.parkingBrake.released',
    onActionId: 'controls.parkingBrake.set',
    offLabel: 'RELEASE',
    onLabel: 'SET',
  },
  {
    id: 'spoilers-arm',
    label: 'GROUND SPOILERS',
    fieldId: 'controls.spoilersArmed',
    groupId: 'controls.spoilersArmed',
    offActionId: 'controls.spoilersArmed.off',
    onActionId: 'controls.spoilersArmed.on',
    offLabel: 'DISARM',
    onLabel: 'ARM',
  },
]);

const flapControl = Object.freeze({
  id: 'flaps',
  label: 'FLAP HANDLE',
  fieldId: 'controls.flapsIndex',
  groupId: 'controls.flaps',
  decreaseActionId: 'controls.flaps.decrease',
  increaseActionId: 'controls.flaps.increase',
});

const spoilerControl = Object.freeze({
  id: 'spoilers',
  label: 'SPEED BRAKE',
  fieldId: 'controls.spoilersHandle',
  actionId: 'controls.spoilers.set',
  groupId: 'controls.spoilers',
});

const spoilerTargets = Object.freeze([
  { label: '0', value: 0 },
  { label: '25', value: 0.25 },
  { label: '50', value: 0.5 },
  { label: '75', value: 0.75 },
  { label: '100', value: 1 },
]);

const engineCards = Object.freeze([1, 2, 3, 4].map((number) => Object.freeze({
  number,
  n1Id: `systems.engine${number}N1`,
  runningId: `systems.engine${number}Running`,
})));

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
      const next = reconcileA380NumericDraftState({
        draft: selectorDrafts[control.id],
        dirty: selectorDirty[control.id],
        error: selectorErrors[control.id],
      }, {
        rawValue,
        unavailable,
        profileKey,
        sourceStatus,
        pending,
      }, previous);
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

function verticalText() {
  const current = numberValue('flightGuidance.verticalValue');
  if (current === null) return '----';
  const rounded = Math.round(current);
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`;
}

function booleanText(id, trueLabel = 'ON', falseLabel = 'OFF') {
  const current = booleanValue(id);
  if (current === true) return trueLabel;
  if (current === false) return falseLabel;
  return '--';
}

function statusText(id) {
  const current = value(id);
  if (typeof current === 'string' && current.trim()) return current.trim().toUpperCase();
  if (current === 0) return 'OFF';
  if (current === 1) return 'ARMED';
  if (current === 2) return 'ACTIVE';
  return '--';
}

function tonnesText(id) {
  const pounds = numberValue(id);
  return pounds === null ? '--' : (pounds * 0.00045359237).toFixed(1);
}

function spoilerPercentText() {
  const current = numberValue(spoilerControl.fieldId);
  return current === null ? '--' : String(Math.round(current * 100));
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function globalControlReason() {
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  return '';
}

function actionReadbackAvailable(control) {
  if (control === flapControl || control === spoilerControl) {
    return numberValue(control.fieldId) !== null;
  }
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

function controlStatusId(control) {
  const identity = control.groupId || control.id;
  return `a380-status-${identity.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function actionIdsFor(control) {
  if (control === flapControl) return [control.decreaseActionId, control.increaseActionId];
  if (control === spoilerControl) return [control.actionId];
  return [control.offActionId, control.onActionId];
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

function requestControlAction(control, actionId, inputValue) {
  if (actionDisabled(control, actionId)) return false;
  if (inputValue === undefined) return props.requestAction(actionId, control.groupId);
  return props.requestAction(actionId, control.groupId, inputValue);
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
  return `a380-target-status-${control.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
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
  return Math.round(current).toLocaleString('en-US');
}

function updateNumericDraft(control, event) {
  selectorDrafts[control.id] = event?.target?.value ?? '';
  selectorDirty[control.id] = true;
  selectorErrors[control.id] = '';
}

function numericValidationMessage(control) {
  return `Enter ${control.min.toLocaleString('en-US')} to ${control.max.toLocaleString('en-US')} in ${control.step.toLocaleString('en-US')} increments.`;
}

function submitNumeric(control) {
  if (numericDisabled(control)) return false;
  const rawValue = selectorDrafts[control.id];
  if (parseMcpDraftNumber(rawValue, control) === null) {
    selectorErrors[control.id] = numericValidationMessage(control);
    return false;
  }
  const sent = submitMcpDraft({
    config: control,
    disabled: false,
    groupId: control.groupId,
    rawValue,
    requestAction: props.requestAction,
  });
  if (sent === false) {
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

function pairedGearClass(leftId, rightId) {
  const left = numberValue(leftId);
  const right = numberValue(rightId);
  if (left === null || right === null) {
    return 'border-surface-200 bg-surface-50 text-gray-500';
  }
  if (left >= 99 && right >= 99) {
    return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
  }
  if (left <= 1 && right <= 1) {
    return 'border-surface-200 bg-surface-50 text-gray-400';
  }
  return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
}

const pageStatus = computed(() => {
  const globalReason = globalControlReason();
  if (globalReason) return globalReason;
  if ([...modeControls, ...lightControls, ...surfaceControls, flapControl, spoilerControl]
    .some((control) => groupPending(control.groupId))) {
    return 'Command in progress.';
  }
  if (selectorControls.some((control) => groupPending(control.groupId))) {
    return 'Target command in progress.';
  }
  return 'Controls ready.';
});
</script>

<template>
  <div
    class="space-y-5 p-3 sm:p-4"
    data-aircraft-template="fbw-a380x"
    :data-aircraft-profile-key="profileKey"
  >
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-gray-100">FlyByWire A380X</h3>
        <p class="mt-0.5 text-xs leading-relaxed text-gray-500">
          Compact FCU, exterior-light and flight-configuration controls with live aircraft readback.
        </p>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        <span class="rounded border border-surface-300 px-2 py-1 text-[9px] uppercase tracking-widest text-gray-400">{{ sourceStatus }}</span>
        <span class="rounded border border-cyan-500/35 bg-cyan-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-cyan-300">A380X controls</span>
        <span class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">Experimental</span>
      </div>
    </header>

    <p class="rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[10px] leading-relaxed text-gray-400" aria-live="polite">
      {{ pageStatus }} AP1 uses the documented direct AP1 push target and confirms fresh AP1 state. AP2 has no action and remains read-only, as do the vertical target and runway-turnoff lights.
    </p>

    <section data-a380-section="fcu-autopilot">
      <div class="dashboard-section-kicker">FCU &amp; Autopilot</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <form
          v-for="control in selectorControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-a380-selector="control.id"
          :data-aircraft-control-group="control.groupId"
          @submit.prevent="submitNumeric(control)"
        >
          <div class="flex items-center justify-between gap-3">
            <label class="text-[9px] font-semibold uppercase tracking-widest text-gray-500" :for="`a380-target-${control.id}`">{{ control.label }}</label>
            <span class="font-mono text-sm font-semibold text-cyan-100">{{ numericLiveText(control) }} <span class="text-[9px] text-gray-500">{{ control.unit }}</span></span>
          </div>
          <div class="mt-2 flex gap-2">
            <input
              :id="`a380-target-${control.id}`"
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

      <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="control in modeControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-a380-mode="control.id"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{{ control.label }}</span>
            <span class="font-mono text-xs font-semibold" :class="booleanValue(control.fieldId) === true ? 'text-emerald-300' : 'text-gray-400'">{{ booleanText(control.fieldId) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-1.5" role="group" :aria-label="`${control.label} state`">
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
      </div>

      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">
          AP 2 <span class="float-right font-mono font-semibold">{{ booleanText('flightGuidance.ap2') }}</span>
          <div class="mt-1 text-[9px] text-gray-500">Read only</div>
        </div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">
          VERTICAL TARGET <span class="float-right font-mono font-semibold">{{ verticalText() }}</span>
          <div class="mt-1 text-[9px] text-gray-500">Read only; no unit is inferred while V/S-FPA mode is ambiguous.</div>
        </div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">
          A/THR STATUS <span class="float-right font-mono font-semibold">{{ statusText('flightGuidance.autothrustStatus') }}</span>
          <div class="mt-1 text-[9px] text-gray-500">Aircraft-reported mode</div>
        </div>
      </div>
    </section>

    <section data-a380-section="exterior-lights">
      <div class="dashboard-section-kicker">Exterior Lights</div>
      <p class="mb-2 text-[10px] leading-relaxed text-gray-500">OFF and ON command lamp outputs. Airbus AUTO and multi-position selector modes remain in the cockpit.</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="control in lightControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-a380-light="control.id"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{{ control.label }}</span>
            <span class="font-mono text-xs font-semibold" :class="booleanValue(control.fieldId) === true ? 'text-emerald-300' : 'text-gray-400'">OUTPUT {{ booleanText(control.fieldId) }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-1.5" role="group" :aria-label="`${control.label} light output`">
            <button
              v-for="target in [{ label: 'OFF', value: false, actionId: control.offActionId }, { label: 'ON', value: true, actionId: control.onActionId }]"
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
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-a380-light="runway-turnoff-readonly">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">RUNWAY TURN OFF</span>
            <span class="font-mono text-xs font-semibold text-gray-400">{{ booleanText('lights.runwayTurnoff') }}</span>
          </div>
          <p class="mt-3 text-[9px] leading-relaxed text-gray-500">Read only. A distinct verified write route is not mapped.</p>
        </div>
      </div>
    </section>

    <section data-a380-section="flight-configuration">
      <div class="dashboard-section-kicker">Flight Configuration</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="control in surfaceControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-a380-surface="control.id"
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

        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-a380-surface="flaps" :data-aircraft-control-group="flapControl.groupId">
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

        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3 sm:col-span-2" data-a380-surface="spoilers" :data-aircraft-control-group="spoilerControl.groupId">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">SPEED BRAKE</span>
            <span class="font-mono text-xs font-semibold text-cyan-100">{{ spoilerPercentText() }}%</span>
          </div>
          <div class="mt-2 grid grid-cols-5 gap-1.5" role="group" aria-label="Speed brake target percent">
            <button
              v-for="target in spoilerTargets"
              :key="target.value"
              type="button"
              class="min-h-11 rounded-md border px-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="fixedActionClass(numberValue(spoilerControl.fieldId) === target.value)"
              :data-aircraft-action="spoilerControl.actionId"
              :data-aircraft-action-value="target.value"
              :disabled="actionDisabled(spoilerControl, spoilerControl.actionId)"
              :aria-pressed="numberValue(spoilerControl.fieldId) === target.value ? 'true' : 'false'"
              :aria-busy="groupPending(spoilerControl.groupId) ? 'true' : 'false'"
              :aria-describedby="controlStatusId(spoilerControl)"
              :title="actionDisabledReason(spoilerControl, spoilerControl.actionId) || undefined"
              @click="requestControlAction(spoilerControl, spoilerControl.actionId, target.value)"
            >{{ target.label }}%</button>
          </div>
          <p :id="controlStatusId(spoilerControl)" class="mt-1.5 text-[9px] text-gray-500" aria-live="polite">{{ controlStatus(spoilerControl) }}</p>
        </div>
      </div>

      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearNosePct')">
          NOSE GEAR <span class="float-right">{{ integerText('controls.gearNosePct') }}%</span>
        </div>
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="pairedGearClass('controls.gearLeftPct', 'controls.gearRightPct')">
          LEFT / RIGHT GEAR <span class="float-right">{{ integerText('controls.gearLeftPct') }} / {{ integerText('controls.gearRightPct') }}%</span>
        </div>
      </div>
    </section>

    <section data-a380-section="systems">
      <div class="dashboard-section-kicker">Four-Engine &amp; System Snapshot</div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div v-for="engine in engineCards" :key="engine.number" class="rounded-lg border border-surface-200 bg-surface-50 p-3" :data-a380-engine="engine.number">
          <div class="flex items-center justify-between text-[9px] uppercase tracking-widest text-gray-500">
            <span>ENG {{ engine.number }} N1</span>
            <span>{{ booleanText(engine.runningId, 'RUN', 'OFF') }}</span>
          </div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText(engine.n1Id) }}%</div>
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
