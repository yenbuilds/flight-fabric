<script setup>
import { computed } from 'vue';
import { getAircraftControlCommandPendingKey } from '../../../../aircraft/control-ui.js';
import { useAircraftControlsStore } from '../../../stores/aircraft-controls.js';

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

const flapDetents = Object.freeze(['UP', '4', '10', '22', '33', '42']);

const selectorControls = Object.freeze([
  {
    id: 'speed',
    label: 'SPD',
    groupId: 'afcs.speed',
    decreaseActionId: 'afcs.speed.decrease',
    increaseActionId: 'afcs.speed.increase',
    help: 'IAS selector knob',
  },
  {
    id: 'heading',
    label: 'HDG',
    groupId: 'afcs.heading',
    decreaseActionId: 'afcs.heading.decrease',
    increaseActionId: 'afcs.heading.increase',
    help: 'Heading selector knob',
  },
  {
    id: 'altitude',
    label: 'ALTITUDE',
    groupId: 'afcs.altitude',
    decreaseActionId: 'afcs.altitude.decrease',
    increaseActionId: 'afcs.altitude.increase',
    help: 'Altitude selector knob; the aircraft may accelerate repeated adjustments',
  },
  {
    id: 'vertical-speed',
    label: 'V/S',
    groupId: 'afcs.verticalSpeed',
    decreaseActionId: 'afcs.verticalSpeed.decrease',
    increaseActionId: 'afcs.verticalSpeed.increase',
    help: 'Vertical-speed selector knob',
  },
  {
    id: 'course-1',
    label: 'CRS 1',
    groupId: 'navigation.course1',
    decreaseActionId: 'navigation.course1.decrease',
    increaseActionId: 'navigation.course1.increase',
    help: 'Captain course selector knob',
  },
  {
    id: 'course-2',
    label: 'CRS 2',
    groupId: 'navigation.course2',
    decreaseActionId: 'navigation.course2.decrease',
    increaseActionId: 'navigation.course2.increase',
    help: 'First-officer course selector knob',
  },
]);

const afcsPulseCommands = Object.freeze([
  { id: 'autothrottle', label: 'AT', accessibleLabel: 'Autothrottle momentary control' },
  { id: 'verticalSpeedHold', label: 'V/S', accessibleLabel: 'Vertical speed hold momentary control' },
  { id: 'altitudeHold', label: 'ALT', accessibleLabel: 'Altitude hold momentary control' },
  { id: 'machHold', label: 'MACH', accessibleLabel: 'Mach hold momentary control' },
  { id: 'headingHold', label: 'HDG', accessibleLabel: 'Heading hold momentary control' },
  { id: 'flightDirector', label: 'CAPT FD', accessibleLabel: 'Captain flight director momentary control' },
  { id: 'apMaster', label: 'AP A', accessibleLabel: 'Autopilot A momentary control' },
  { id: 'apDisconnect', label: 'AP DISC', accessibleLabel: 'Autopilot disconnect momentary control', critical: true },
  { id: 'app', label: 'ILS / APP', accessibleLabel: 'ILS approach momentary control' },
  { id: 'loc', label: 'LOC', accessibleLabel: 'Localizer momentary control' },
  { id: 'nav1', label: 'VOR', accessibleLabel: 'VOR navigation momentary control' },
  { id: 'ins', label: 'INS', accessibleLabel: 'INS course capture momentary control' },
  { id: 'backcourse', label: 'BC', accessibleLabel: 'Back course momentary control' },
].map((item) => Object.freeze({
  ...item,
  command: Object.freeze({ type: 'autopilot-pulse', id: item.id }),
})));

const lightControls = Object.freeze([
  { id: 'landing', label: 'LANDING', fieldId: 'lights.landing' },
  { id: 'taxi', label: 'TAXI', fieldId: 'lights.taxi' },
  { id: 'strobe', label: 'STROBE', fieldId: 'lights.strobe' },
  { id: 'beacon', label: 'BEACON', fieldId: 'lights.beacon' },
  { id: 'nav', label: 'NAV', fieldId: 'lights.nav' },
  { id: 'wing', label: 'WING', fieldId: 'lights.wing' },
  { id: 'logo', label: 'LOGO', fieldId: 'lights.logo' },
].map((item) => Object.freeze({
  ...item,
  groupId: `lights.${item.id}`,
  offActionId: `lights.${item.id}.setOff`,
  onActionId: `lights.${item.id}.setOn`,
})));

const surfaceCommands = Object.freeze([
  { id: 'gear-up', key: 'gearUp', label: 'Gear Up', command: Object.freeze({ type: 'preset', id: 'gearUp' }) },
  { id: 'gear-down', key: 'gearDown', label: 'Gear Down', command: Object.freeze({ type: 'preset', id: 'gearDown' }) },
  { id: 'flaps-less', key: 'flapsDecrease', label: 'Flaps Less', command: Object.freeze({ type: 'preset', id: 'flapsDecrease' }) },
  { id: 'flaps-more', key: 'flapsIncrease', label: 'Flaps More', command: Object.freeze({ type: 'preset', id: 'flapsIncrease' }) },
]);

const engines = Object.freeze([
  {
    number: 1,
    station: 'LEFT WING',
    eprId: 'systems.engine1Epr',
    n1Id: 'systems.engine1N1',
    n2Id: 'systems.engine1N2',
    fuelFlowId: 'systems.engine1FuelFlowPph',
    reverseId: 'systems.engine1ReversePct',
    runningId: 'systems.engine1Running',
  },
  {
    number: 2,
    station: 'TAIL',
    eprId: 'systems.engine2Epr',
    n1Id: 'systems.engine2N1',
    n2Id: 'systems.engine2N2',
    fuelFlowId: 'systems.engine2FuelFlowPph',
    reverseId: 'systems.engine2ReversePct',
    runningId: 'systems.engine2Running',
  },
  {
    number: 3,
    station: 'RIGHT WING',
    eprId: 'systems.engine3Epr',
    n1Id: 'systems.engine3N1',
    n2Id: 'systems.engine3N2',
    fuelFlowId: 'systems.engine3FuelFlowPph',
    reverseId: 'systems.engine3ReversePct',
    runningId: 'systems.engine3Running',
  },
]);

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

function integerText(id, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : Math.round(current).toLocaleString('en-US');
}

function decimalText(id, precision = 1, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : current.toFixed(precision);
}

function flapDetentText() {
  const index = numberValue('controls.flapsIndex');
  if (index === null || !Number.isInteger(index) || index < 0 || index >= flapDetents.length) return '--';
  return flapDetents[index];
}

function booleanText(id, trueLabel = 'ON', falseLabel = 'OFF') {
  const current = value(id);
  if (current === true) return trueLabel;
  if (current === false) return falseLabel;
  return '--';
}

function indicatorClass(id, warning = false) {
  const current = value(id);
  if (current !== true) return 'border-surface-200 bg-surface-50 text-gray-500';
  return warning
    ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
    : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
}

function gearClass(id) {
  const current = numberValue(id);
  if (current === null) return 'border-surface-200 bg-surface-50 text-gray-500';
  if (current >= 99) return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
  if (current <= 1) return 'border-surface-200 bg-surface-50 text-gray-400';
  return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
}

function tonnesText(id) {
  const pounds = numberValue(id);
  return pounds === null ? '--' : (pounds * 0.00045359237).toFixed(1);
}

function actionSupported(actionId) {
  return props.actionCapabilities[actionId] === true;
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

function actionReadbackAvailable(control) {
  return typeof value(control.fieldId) === 'boolean';
}

function actionDisabled(control, actionId) {
  return !controlSessionReady.value
    || (control.fieldId && !actionReadbackAvailable(control))
    || !actionSupported(actionId)
    || groupPending(control.groupId);
}

function actionDisabledReason(control, actionId) {
  if (!actionDisabled(control, actionId)) return '';
  if (groupPending(control.groupId)) return 'Command pending.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (control.fieldId && !actionReadbackAvailable(control)) return 'Live cockpit readback unavailable.';
  if (!actionSupported(actionId)) return 'Compatible SimConnect event transport unavailable.';
  return 'Control temporarily unavailable.';
}

function controlStatusId(control) {
  return `tristar-control-status-${control.groupId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function controlStatus(control) {
  if (groupPending(control.groupId)) return 'Command pending; waiting for live readback.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (control.fieldId && !actionReadbackAvailable(control)) return 'Live cockpit readback unavailable; control disabled.';
  const actionIds = control.offActionId
    ? [control.offActionId, control.onActionId]
    : [control.decreaseActionId, control.increaseActionId];
  if (!actionIds.some((actionId) => actionSupported(actionId))) {
    return 'Compatible SimConnect event transport unavailable.';
  }
  return control.offActionId
    ? 'Fixed target; fresh live readback confirms the requested state.'
    : 'Ready. Each press sends one documented knob event; confirm the value on the cockpit display.';
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

function isCommandPending(command) {
  return aircraftControls.isCommandPending(getAircraftControlCommandPendingKey(command));
}

function isCommandDisabled(command) {
  return props.sourceStatus !== 'connected' || aircraftControls.isCommandDisabled(command);
}

function commandTitle(command) {
  if (isCommandPending(command)) return 'Command in progress.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (aircraftControls.isCommandSupported(command) !== true) {
    return 'No mapped action is available for this exact aircraft profile.';
  }
  return aircraftControls.availability.reason || undefined;
}

const afcsModeStatusText = computed(() => {
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data; AFCS mode controls are disabled.';
  if (aircraftControls.availability.enabled !== true) {
    return aircraftControls.availability.reason || 'Aircraft control is unavailable in this browser session.';
  }
  if (afcsPulseCommands.some((item) => isCommandPending(item.command))) {
    return 'AFCS command in progress; wait for delivery before pressing another control in that group.';
  }
  const unavailableCount = afcsPulseCommands.filter(
    (item) => aircraftControls.isCommandSupported(item.command) !== true,
  ).length;
  if (unavailableCount > 0) {
    return `${unavailableCount} AFCS mode control${unavailableCount === 1 ? ' is' : 's are'} unavailable for this exact aircraft profile.`;
  }
  return 'Ready. Each press sends one bounded momentary event; repeated presses are briefly throttled.';
});

function requestCommand(command) {
  if (isCommandDisabled(command)) return false;
  return aircraftControls.requestControlCommand(command, {
    pendingKey: getAircraftControlCommandPendingKey(command),
  });
}
</script>

<template>
  <div
    class="space-y-5 p-3 sm:p-4"
    data-aircraft-template="inibuilds-tristar"
    data-inibuilds-tristar-scope="msfs-2024-l-1011-500"
    :data-aircraft-profile-key="profileKey"
  >
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-gray-100">iniBuilds L-1011-500 compatibility</h3>
        <p class="mt-0.5 text-xs leading-relaxed text-gray-500">
          A focused remote panel for the TriStar's AFCS, exterior lights, flight configuration and RB211 indications.
        </p>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        <span class="rounded border border-surface-300 px-2 py-1 text-[9px] uppercase tracking-widest text-gray-400">{{ sourceStatus }}</span>
        <span class="rounded border border-cyan-500/35 bg-cyan-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-cyan-300">Official SimConnect events</span>
        <span class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">Experimental</span>
      </div>
    </header>

    <section data-tristar-section="afcs-selectors">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="dashboard-section-kicker">AFCS Selector Knobs</div>
        <span class="text-[9px] font-semibold uppercase tracking-widest text-cyan-300/80">Documented step controls</span>
      </div>
      <p class="mb-2 text-[10px] leading-relaxed text-gray-500">
        iniBuilds documents the decrement and increment events, but not a reliable remote value source or direct target event.
        Use the cockpit windows as the source of truth.
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="control in selectorControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-tristar-afcs-selector="control.id"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-[9px] uppercase tracking-widest text-gray-500">{{ control.label }}</div>
              <div class="mt-1 text-[10px] leading-relaxed text-gray-400">{{ control.help }}</div>
            </div>
            <div class="grid shrink-0 grid-cols-2 gap-1.5" :aria-label="`${control.label} adjustment`" role="group">
              <button
                type="button"
                class="min-h-11 min-w-11 rounded-md border border-surface-300 bg-surface-100 px-3 text-base font-semibold text-gray-200 transition-colors hover:border-cyan-500/45 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-45"
                :data-aircraft-action="control.decreaseActionId"
                :disabled="actionDisabled(control, control.decreaseActionId)"
                :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
                :aria-describedby="actionDisabled(control, control.decreaseActionId) ? controlStatusId(control) : undefined"
                :title="actionDisabledReason(control, control.decreaseActionId) || undefined"
                @click="requestControlAction(control, control.decreaseActionId)"
              >
                <span aria-hidden="true">&minus;</span><span class="sr-only">Decrease {{ control.label }}</span>
              </button>
              <button
                type="button"
                class="min-h-11 min-w-11 rounded-md border border-surface-300 bg-surface-100 px-3 text-base font-semibold text-gray-200 transition-colors hover:border-cyan-500/45 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-45"
                :data-aircraft-action="control.increaseActionId"
                :disabled="actionDisabled(control, control.increaseActionId)"
                :aria-busy="groupPending(control.groupId) ? 'true' : 'false'"
                :aria-describedby="actionDisabled(control, control.increaseActionId) ? controlStatusId(control) : undefined"
                :title="actionDisabledReason(control, control.increaseActionId) || undefined"
                @click="requestControlAction(control, control.increaseActionId)"
              >
                <span aria-hidden="true">+</span><span class="sr-only">Increase {{ control.label }}</span>
              </button>
            </div>
          </div>
          <p :id="controlStatusId(control)" class="mt-1.5 text-[10px] leading-relaxed text-gray-500">{{ controlStatus(control) }}</p>
        </div>
      </div>
    </section>

    <section class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-tristar-section="afcs-modes">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div class="dashboard-section-kicker">AFCS Mode Keys</div>
          <p class="text-[10px] leading-relaxed text-gray-500">Each button sends one documented momentary event. Mode state is not inferred.</p>
        </div>
        <span
          class="rounded border px-2 py-1 text-[9px] uppercase tracking-widest"
          :class="controlSessionReady
            ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
            : 'border-surface-300 text-gray-500'"
          data-tristar-afcs-readiness
          :data-ready="controlSessionReady ? 'true' : 'false'"
        >{{ controlSessionReady ? 'Ready' : 'Unavailable' }}</span>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" role="group" aria-label="Momentary AFCS mode keys">
        <button
          v-for="item in afcsPulseCommands"
          :key="item.id"
          type="button"
          class="min-h-11 rounded-lg border px-2.5 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
          :class="[
            item.critical
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-200 hover:border-amber-400/75 hover:bg-amber-500/15'
              : 'border-surface-300 bg-surface-100 text-gray-200 hover:border-cyan-500/45 hover:bg-cyan-500/[0.06]',
            isCommandPending(item.command) ? 'border-cyan-500/55 bg-cyan-500/10 text-cyan-200' : '',
          ]"
          :data-tristar-pulse-command="item.id"
          :disabled="isCommandDisabled(item.command)"
          :aria-busy="isCommandPending(item.command) ? 'true' : 'false'"
          :aria-label="item.accessibleLabel"
          aria-describedby="tristar-afcs-mode-status tristar-afcs-mode-help"
          :title="commandTitle(item.command)"
          @click="requestCommand(item.command)"
        >
          {{ isCommandPending(item.command) ? 'Sending...' : item.label }}
        </button>
      </div>
      <p id="tristar-afcs-mode-status" class="mt-2 text-[10px] leading-relaxed text-gray-400" role="status" aria-live="polite">
        {{ afcsModeStatusText }}
      </p>
      <p id="tristar-afcs-mode-help" class="mt-1 text-[10px] leading-relaxed text-amber-200/80" role="note">
        Delivery does not prove engagement. Confirm every AFCS mode and autopilot disconnect in the cockpit.
      </p>
    </section>

    <section data-tristar-section="exterior-lights">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="dashboard-section-kicker">Exterior Lights</div>
        <span class="text-[9px] font-semibold uppercase tracking-widest text-cyan-300/80">Fixed target + readback</span>
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="control in lightControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-tristar-light-control="control.id"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-[10px] font-semibold tracking-wide text-gray-200">{{ control.label }}</span>
            <span class="rounded border px-2 py-0.5 text-[9px] font-semibold" :class="indicatorClass(control.fieldId)">
              {{ booleanText(control.fieldId) }}
            </span>
          </div>
          <div class="grid grid-cols-2 gap-2" :aria-label="`${control.label} light position`" role="group">
            <button
              type="button"
              class="min-h-11 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="fixedActionClass(value(control.fieldId) === false)"
              :data-aircraft-action="control.offActionId"
              :aria-pressed="value(control.fieldId) === false"
              :aria-describedby="actionDisabled(control, control.offActionId) ? controlStatusId(control) : undefined"
              :disabled="actionDisabled(control, control.offActionId)"
              :title="actionDisabledReason(control, control.offActionId) || undefined"
              @click="requestControlAction(control, control.offActionId)"
            >OFF</button>
            <button
              type="button"
              class="min-h-11 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="fixedActionClass(value(control.fieldId) === true)"
              :data-aircraft-action="control.onActionId"
              :aria-pressed="value(control.fieldId) === true"
              :aria-describedby="actionDisabled(control, control.onActionId) ? controlStatusId(control) : undefined"
              :disabled="actionDisabled(control, control.onActionId)"
              :title="actionDisabledReason(control, control.onActionId) || undefined"
              @click="requestControlAction(control, control.onActionId)"
            >ON</button>
          </div>
          <p :id="controlStatusId(control)" class="mt-2 text-[10px] leading-relaxed text-gray-500">{{ controlStatus(control) }}</p>
        </div>
      </div>
    </section>

    <section data-tristar-section="engine-deck">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="dashboard-section-kicker">RB211 Engine Deck</div>
        <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">EPR primary</span>
      </div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <article
          v-for="engine in engines"
          :key="engine.number"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-tristar-engine="engine.number"
        >
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="text-[9px] uppercase tracking-widest text-gray-500">ENGINE {{ engine.number }}</div>
              <div class="mt-0.5 text-[10px] font-semibold tracking-wide text-gray-300">{{ engine.station }}</div>
            </div>
            <span class="rounded border px-2 py-1 text-[9px] font-semibold" :class="indicatorClass(engine.runningId)">
              {{ booleanText(engine.runningId, 'RUNNING', 'STOPPED') }}
            </span>
          </div>
          <div class="mt-3 rounded border border-surface-200 bg-surface-100 px-3 py-2">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">EPR</div>
            <div class="mt-0.5 font-mono text-2xl font-semibold tabular-nums text-gray-100">{{ decimalText(engine.eprId, 2) }}</div>
          </div>
          <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
            <div class="flex justify-between gap-2"><dt class="text-gray-500">N1</dt><dd class="font-mono text-gray-200">{{ decimalText(engine.n1Id) }}%</dd></div>
            <div class="flex justify-between gap-2"><dt class="text-gray-500">N2</dt><dd class="font-mono text-gray-200">{{ decimalText(engine.n2Id) }}%</dd></div>
            <div class="flex justify-between gap-2"><dt class="text-gray-500">FUEL FLOW</dt><dd class="font-mono text-gray-200">{{ integerText(engine.fuelFlowId) }} lb/h</dd></div>
            <div class="flex justify-between gap-2"><dt class="text-gray-500">REV</dt><dd class="font-mono text-gray-200">{{ decimalText(engine.reverseId) }}%</dd></div>
          </dl>
        </article>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">
        EPR, N2, fuel-flow and reverser values use standard simulator engine variables and remain neutral when the aircraft does not publish them.
      </p>
    </section>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section data-tristar-section="flight-configuration">
        <div class="dashboard-section-kicker">Flight Configuration</div>
        <div class="grid grid-cols-3 gap-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP DETENT</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ flapDetentText() }}</div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">HANDLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText('controls.flapsPercent') }}<span class="text-xs text-gray-500">%</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP ANGLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('controls.flapAngleDeg') }}<span class="text-xs text-gray-500">&deg;</span></div>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.gearHandleDown')">HANDLE <span class="float-right">{{ booleanText('controls.gearHandleDown', 'DOWN', 'UP') }}</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearNosePct')">NOSE <span class="float-right">{{ integerText('controls.gearNosePct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearLeftPct')">LEFT <span class="float-right">{{ integerText('controls.gearLeftPct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearRightPct')">RIGHT <span class="float-right">{{ integerText('controls.gearRightPct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.parkingBrake', true)">PARK <span class="float-right">{{ booleanText('controls.parkingBrake') }}</span></div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Gear and flap commands">
          <button
            v-for="item in surfaceCommands"
            :key="item.key"
            type="button"
            class="min-h-11 rounded-lg border border-surface-300 bg-surface-100 px-2.5 py-2 text-[10px] font-semibold text-gray-200 transition-colors hover:border-cyan-500/45 disabled:cursor-not-allowed disabled:opacity-45"
            :class="isCommandPending(item.command) ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200' : ''"
            :data-tristar-generic-command="item.key"
            :disabled="isCommandDisabled(item.command)"
            :aria-busy="isCommandPending(item.command) ? 'true' : 'false'"
            :title="commandTitle(item.command)"
            @click="requestCommand(item.command)"
          >{{ isCommandPending(item.command) ? 'Sending...' : item.label }}</button>
        </div>
      </section>

      <section data-tristar-section="aircraft-summary">
        <div class="dashboard-section-kicker">Fuel, Weight &amp; Pressurization</div>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FUEL</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('systems.fuelTotalPct') }}<span class="text-xs text-gray-500">%</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FUEL WEIGHT</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ tonnesText('systems.fuelTotalWeightLbs') }} <span class="text-xs text-gray-500">t</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">GROSS WEIGHT</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ tonnesText('systems.grossWeightLbs') }} <span class="text-xs text-gray-500">t</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">OAT / MACH</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('systems.outsideAirTemperatureC') }}&deg; / {{ decimalText('systems.mach', 3) }}</div>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-1 gap-2 text-[10px] text-gray-300 sm:grid-cols-3">
          <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB ALT <span class="float-right font-semibold">{{ integerText('systems.cabinAltitudeFt') }} ft</span></div>
          <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB V/S <span class="float-right font-semibold">{{ integerText('systems.cabinVerticalSpeedFpm') }} fpm</span></div>
          <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">DELTA P <span class="float-right font-semibold">{{ decimalText('systems.cabinDeltaPressurePsi', 2) }} psi</span></div>
        </div>
      </section>
    </div>

    <footer class="space-y-1.5 border-t border-surface-200 pt-3">
      <p class="text-[10px] leading-relaxed text-gray-500">
        Aircraft-specific writes are limited to iniBuilds-published or Microsoft-documented standard MSFS event IDs. Light and selector targets require fresh readback; no free-form simulator code, raw axis input, automatic retry or multi-control macro is accepted.
      </p>
      <p class="text-[10px] leading-relaxed text-gray-500">
        Unofficial compatibility with the iniBuilds TriStar Airliner; not affiliated with or endorsed by iniBuilds. Requires a separately licensed aircraft; no iniBuilds software is included.
      </p>
      <p class="text-[10px] leading-relaxed text-amber-300/80">
        Experimental integration: verify critical aircraft and AFCS state in the simulator. Controls without documented semantics or reliable readback are intentionally excluded.
      </p>
    </footer>
  </div>
</template>
