<script setup>
import { computed, ref, watch } from 'vue';
import AppTooltip from './AppTooltip.vue';
import AutopilotTargetEditor from './AutopilotTargetEditor.vue';
import GenericNavRadios from './GenericNavRadios.vue';
import AircraftSectionRibbon from './aircraft-specific/AircraftSectionRibbon.vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useFlightStore } from '../stores/flight.js';
import { getAircraftControlCommandPendingKey } from '../../aircraft/control-ui.js';

const aircraftControls = useAircraftControlsStore();
const flight = useFlightStore();

const modeButtonClass = 'controls-command-card ap-mode-btn w-full h-full p-4 text-center transition-all hover:border-accent/50';
const adjustButtonClass = 'controls-adjust-button ap-adj-btn w-11 h-11 text-lg font-bold';
const activeSelectorMode = ref('');
const aircraftControlContextKey = computed(() => {
  const catalogue = aircraftControls.aircraftCommandCatalogue;
  return [
    catalogue.configurationId || '',
    catalogue.profileKey || '',
    catalogue.profileRevision ?? '',
  ].join(':');
});
const hasNavRadios = computed(() => ['nav1', 'nav2'].some((id) => (
  aircraftControls.isAircraftCommandSupported(`radios.${id}.setStandby`)
)));
const sections = computed(() => [
  { id: 'surfaces', label: 'Surfaces', title: 'Surfaces', detail: 'Gear, flaps, brakes and spoilers' },
  { id: 'lights', label: 'Lights', title: 'Exterior lights', detail: 'Navigation, beacon, strobe, landing and taxi' },
  { id: 'autopilot', label: 'Autopilot', title: 'Autopilot', detail: 'Targets and flight guidance modes' },
  ...(hasNavRadios.value ? [{ id: 'radios', label: 'Radios', title: 'Navigation radios', detail: 'NAV 1 and NAV 2 standby tuning' }] : []),
]);
const feedbackSummary = computed(() => ({
  sending: 'Sending command…',
  sent: 'Command sent. Check the aircraft response.',
  failed: 'Command could not be completed. Check aircraft state and details.',
}[aircraftControls.feedback.status] || ''));
const diagnostics = ref(null);
function openDiagnostics() {
  if (!diagnostics.value) return;
  diagnostics.value.open = true;
  diagnostics.value.scrollIntoView({ block: 'start', behavior: 'auto' });
  diagnostics.value.querySelector('summary')?.focus({ preventScroll: true });
}

watch(aircraftControlContextKey, () => {
  closeSelectorTargetEditor();
});

watch(() => aircraftControls.availability.enabled, () => {
  closeSelectorTargetEditor();
});

const surfaceCommands = computed(() => {
  const telemetry = flight.telemetry;
  const hasLiveTelemetry = flight.mode === 'live';
  const gearState = hasLiveTelemetry ? (telemetry.gearState || '---') : '---';
  const flapsState = !hasLiveTelemetry
    ? '---'
    : (telemetry.flaps === 'UP'
    ? 'UP'
    : `${telemetry.flaps || '---'}${telemetry.flapsUnit || ''}`);
  const parkingBrakeState = !hasLiveTelemetry
    ? '---'
    : (telemetry.gear.parkingBrake === true ? 'SET' : 'RELEASED');
  const spoilersState = hasLiveTelemetry ? (telemetry.spoilers || '---') : '---';
  return [
    { id: 'ctrl-gear-up-btn', label: 'Gear', value: 'UP', readback: gearState, command: { type: 'control', id: 'gearUp' } },
    { id: 'ctrl-gear-down-btn', label: 'Gear', value: 'DOWN', readback: gearState, command: { type: 'control', id: 'gearDown' } },
    { id: 'ctrl-flaps-dec-btn', label: 'Flaps', value: 'LESS', readback: flapsState, command: { type: 'control', id: 'flapsDecrease' } },
    { id: 'ctrl-flaps-inc-btn', label: 'Flaps', value: 'MORE', readback: flapsState, command: { type: 'control', id: 'flapsIncrease' } },
    { id: 'ctrl-park-brake-release-btn', label: 'Park Brake', value: 'RELEASE', readback: parkingBrakeState, command: { type: 'control', id: 'parkingBrakeRelease' } },
    { id: 'ctrl-park-brake-set-btn', label: 'Park Brake', value: 'SET', readback: parkingBrakeState, command: { type: 'control', id: 'parkingBrakeSet' } },
    { id: 'ctrl-spoilers-retract-btn', label: 'Spoilers', value: 'RETRACT', readback: spoilersState, command: { type: 'control', id: 'spoilersRetract' } },
    { id: 'ctrl-spoilers-extend-btn', label: 'Spoilers', value: 'EXTEND', readback: spoilersState, command: { type: 'control', id: 'spoilersExtend' } },
    { id: 'ctrl-spoilers-disarm-btn', label: 'Ground Spoilers', value: 'DISARM', readback: spoilersState, command: { type: 'control', id: 'spoilersDisarm' } },
    { id: 'ctrl-spoilers-arm-btn', label: 'Ground Spoilers', value: 'ARM', readback: spoilersState, command: { type: 'control', id: 'spoilersArm' } },
  ];
});

const lightControls = Object.freeze([
  Object.freeze({ key: 'nav', label: 'NAV' }),
  Object.freeze({ key: 'beacon', label: 'BEACON' }),
  Object.freeze({ key: 'strobe', label: 'STROBE' }),
  Object.freeze({ key: 'landing', label: 'LANDING' }),
  Object.freeze({ key: 'taxi', label: 'TAXI' }),
]);

const selectors = [
  {
    mode: 'spd',
    label: 'SPD',
    units: 'KTS',
    valueId: 'ap-spd-value',
    valueClass: 'w-16',
    actions: [
      { action: 'dec10', label: '--' },
      { action: 'dec', label: '-' },
      { action: 'inc', label: '+' },
      { action: 'inc10', label: '++' },
    ],
  },
  {
    mode: 'hdg',
    label: 'HDG',
    units: 'DEG',
    valueId: 'ap-hdg-value',
    valueClass: 'w-16',
    actions: [
      { action: 'dec10', label: '--' },
      { action: 'dec', label: '-' },
      { action: 'inc', label: '+' },
      { action: 'inc10', label: '++' },
    ],
  },
  {
    mode: 'alt',
    label: 'ALT',
    units: 'FT',
    valueId: 'ap-alt-value',
    valueClass: 'w-20',
    actions: [
      { action: 'dec1000', label: '--' },
      { action: 'dec100', label: '-' },
      { action: 'inc100', label: '+' },
      { action: 'inc1000', label: '++' },
    ],
  },
  {
    mode: 'vs',
    label: 'V/S',
    units: 'FPM',
    valueId: 'ap-vs-value',
    valueClass: 'w-20',
    actions: [
      { action: 'dec500', label: '--' },
      { action: 'dec100', label: '-' },
      { action: 'inc100', label: '+' },
      { action: 'inc500', label: '++' },
    ],
  },
];

const availabilityButtonTitle = computed(() => (
  aircraftControls.availability.enabled ? null : aircraftControls.availability.reason
));

const apStatusActive = computed(() => aircraftControls.autopilot.master === true);
const apStatusText = computed(() => {
  if (aircraftControls.autopilot.master === true) return 'Engaged';
  if (aircraftControls.autopilot.master === false) return 'Disengaged';
  return 'Unknown';
});

function booleanStateLabel(value) {
  if (value === true) return 'ON';
  if (value === false) return 'OFF';
  return '---';
}

function getAthrStateLabel(autopilot) {
  if (autopilot.athrActive === true) return 'ACTIVE';
  if (autopilot.athrArmed === true) return 'ARMED';
  if (autopilot.athrActive === false && autopilot.athrArmed === false) return 'OFF';
  return '---';
}

const primaryModes = computed(() => {
  const autopilot = aircraftControls.autopilot;
  return [
    {
      id: 'ap-master-btn',
      label: 'AP Master',
      stateId: 'ap-master-state',
      dataMode: 'master',
      stateLabel: booleanStateLabel(autopilot.master),
      active: autopilot.master === true,
      command: { type: 'control', id: 'autopilotMasterToggle' },
    },
    {
      id: 'ap-athr-btn',
      label: 'A/T',
      stateId: 'ap-athr-state',
      dataMode: '',
      stateLabel: getAthrStateLabel(autopilot),
      active: autopilot.athrActive === true || autopilot.athrArmed === true,
      command: { type: 'control', id: 'autothrottleToggle' },
    },
  ];
});

const selectorStates = computed(() => {
  const autopilot = aircraftControls.autopilot;
  return {
    spd: { value: autopilot.spdDisplay, engaged: autopilot.spdHold === true, label: booleanStateLabel(autopilot.spdHold) },
    hdg: { value: autopilot.hdgDisplay, engaged: autopilot.hdgHold === true, label: booleanStateLabel(autopilot.hdgHold) },
    alt: { value: autopilot.altDisplay, engaged: autopilot.altHold === true, label: booleanStateLabel(autopilot.altHold) },
    vs: { value: autopilot.vsDisplay, engaged: autopilot.vsHold === true, label: booleanStateLabel(autopilot.vsHold) },
  };
});

const activeSelector = computed(() => (
  selectors.find((selector) => selector.mode === activeSelectorMode.value) || null
));

const navModes = computed(() => {
  const autopilot = aircraftControls.autopilot;
  return [
    { id: 'ap-fd-btn', stateId: 'ap-fd-btn-state', label: 'FD', active: autopilot.fdActive === true, command: { type: 'control', id: 'flightDirectorToggle' } },
    { id: 'ap-flc-btn', stateId: 'ap-flc-state', label: 'FLC', active: autopilot.flcHold === true, command: { type: 'control', id: 'flcToggle' } },
    { id: 'ap-loc-btn', stateId: 'ap-loc-state', label: 'LOC', active: autopilot.locHold === true, command: { type: 'control', id: 'locToggle' } },
    { id: 'ap-app-btn', stateId: 'ap-app-state', label: 'APP', active: autopilot.appHold === true, command: { type: 'control', id: 'appToggle' } },
  ];
});

const hasAnyAutopilotWriteCapability = computed(() => (
  Object.values(aircraftControls.controlCapabilities?.autopilot || {}).some((value) => value === true)
));

const autopilotCapabilityText = computed(() => (
  hasAnyAutopilotWriteCapability.value
    ? 'Standard simulator writes are enabled for this profile.'
    : 'Readback only for this profile.'
));

const unsupportedNavModeLabels = computed(() => (
  navModes.value
    .filter((mode) => aircraftControls.isCommandSupported(mode.command) !== true)
    .map((mode) => mode.label)
));

function getPendingKey(command) {
  return getAircraftControlCommandPendingKey(command);
}

function getSelectorHoldCommand(mode) {
  return { type: 'selector-hold', mode };
}

function getSelectorAdjustCommand(mode, action) {
  return { type: 'selector-adjust', mode, action };
}

function getSelectorSetCommand(mode, value = null) {
  return { type: 'selector-set', mode, value };
}

function getLightCommand(light, value) {
  return { type: 'light-set', light, value };
}

function getLightState(light) {
  if (flight.mode !== 'live' || flight.telemetry.lights.available !== true) return null;
  return flight.telemetry.lights[light] === true;
}

function getLightStateLabel(light) {
  const state = getLightState(light);
  return state === null ? '---' : (state ? 'ON' : 'OFF');
}

function isCommandBusy(command) {
  return aircraftControls.isCommandPending(command);
}

function isCommandDisabled(command) {
  return aircraftControls.isCommandDisabled(command);
}

function isSelectorTargetBusy(mode) {
  const selector = selectors.find((item) => item.mode === mode);
  if (!selector) return false;
  return aircraftControls.isCommandPending(getSelectorSetCommand(mode))
    || selector.actions.some((action) => (
      aircraftControls.isCommandPending(getSelectorAdjustCommand(mode, action.action))
    ));
}

function getSelectorTargetDisabledReason(mode) {
  const command = getSelectorSetCommand(mode);
  if (aircraftControls.isCommandSupported(command) !== true) {
    return 'Target adjustment is unavailable for this aircraft profile.';
  }
  if (aircraftControls.availability.enabled !== true) return aircraftControls.availability.reason;
  if (isSelectorTargetBusy(mode)) return 'A target command is already in progress.';
  return '';
}

function getSelectorTargetTitle(mode) {
  return getSelectorTargetDisabledReason(mode) || 'Open the large one-thumb target editor';
}

function getAdjustmentLabel(selector, action) {
  const amount = Number(action.action.replace(/^(inc|dec)/, '')) || 1;
  const direction = action.action.startsWith('dec') ? 'Decrease' : 'Increase';
  const name = { spd: 'speed', hdg: 'heading', alt: 'altitude', vs: 'vertical speed' }[selector.mode];
  return `${direction} selected ${name} by ${amount} ${selector.units}`;
}

function selectorLiveValue(mode) {
  const key = `${mode}Target`;
  const value = aircraftControls.autopilot[key];
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function openSelectorTargetEditor(mode) {
  activeSelectorMode.value = mode;
}

function closeSelectorTargetEditor() {
  activeSelectorMode.value = '';
}

function getCommandTitle(command) {
  if (isCommandBusy(command)) {
    return 'Command in progress';
  }
  if (aircraftControls.isCommandSupported(command) !== true) {
    return 'No mapped action is available for this aircraft profile';
  }
  return availabilityButtonTitle.value || undefined;
}

function requestControlCommand(command) {
  aircraftControls.requestControlCommand(command, {
    pendingKey: getPendingKey(command),
  });
}

function requestSelectorHold(mode) {
  const command = getSelectorHoldCommand(mode);
  aircraftControls.requestControlCommand(command, {
    pendingKey: getPendingKey(command),
  });
}

function requestSelectorAdjustment(mode, action) {
  if (isSelectorTargetBusy(mode)) return false;
  const command = getSelectorAdjustCommand(mode, action);
  return aircraftControls.requestControlCommand(command, {
    pendingKey: getPendingKey(command),
  });
}

function requestSelectorTarget({ mode, value }) {
  if (getSelectorTargetDisabledReason(mode)) return false;
  const command = getSelectorSetCommand(mode, value);
  return aircraftControls.requestControlCommand(command, {
    pendingKey: getPendingKey(command),
  });
}

function requestLightSet(light, value) {
  const command = getLightCommand(light, value);
  aircraftControls.requestControlCommand(command, {
    pendingKey: getPendingKey(command),
  });
}
</script>

<template>
  <div class="controls-shell page-stack">
    <AircraftSectionRibbon
      :key="`${aircraftControlContextKey}:${hasNavRadios}`"
      :sections="sections"
      section-id-prefix="generic-aircraft-section-"
      aircraft-label="Aircraft"
      :memory-key="aircraftControls.aircraftCommandCatalogue.profileKey ? `generic:${aircraftControls.aircraftCommandCatalogue.profileKey}` : ''"
    />
    <p v-if="!aircraftControls.availability.enabled" class="generic-availability" role="status">
      {{ aircraftControls.availability.reason }}
    </p>
    <div v-if="feedbackSummary" class="generic-feedback" :data-status="aircraftControls.feedback.status">
      <div role="status" aria-live="polite" aria-atomic="true">
        <strong>{{ aircraftControls.feedback.actionText }}</strong>
        <p>{{ feedbackSummary }}</p>
      </div>
      <button type="button" class="ff-touch-target" @click="openDiagnostics">Details</button>
    </div>
    <section id="generic-aircraft-section-surfaces" class="controls-section" tabindex="-1" aria-label="Surfaces">
      <div class="controls-section-header">
        <div>
          <div class="controls-kicker">Surfaces</div>
          <div class="text-xs text-gray-500 mt-1">Gear, flaps, brakes and spoilers.</div>
        </div>
      </div>
      <div class="controls-section-body grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
        <button
          v-for="command in surfaceCommands"
          :key="command.id"
          :id="command.id"
          :class="[modeButtonClass, isCommandDisabled(command.command) ? 'opacity-50 cursor-not-allowed' : '', isCommandBusy(command.command) ? 'border-accent/50 bg-accent/10' : '']"
          :disabled="isCommandDisabled(command.command)"
          :aria-label="`${command.label} ${command.value}`"
          :aria-busy="isCommandBusy(command.command) ? 'true' : 'false'"
          @click="requestControlCommand(command.command)"
        >
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-1">{{ command.label }}</div>
          <div class="text-lg font-semibold text-gray-200">{{ command.value }}</div>
          <div class="mt-1 text-[10px] uppercase tracking-wider text-gray-500">Now {{ command.readback }}</div>
          <div class="h-4 mt-2 text-[10px]" :class="isCommandBusy(command.command) ? 'text-accent' : 'text-transparent'">
            {{ isCommandBusy(command.command) ? 'Sending...' : '.' }}
          </div>
        </button>
      </div>
    </section>

    <section id="generic-aircraft-section-lights" class="controls-section" tabindex="-1" aria-label="Exterior lights">
      <div class="controls-section-header">
        <div>
          <div class="controls-kicker">Exterior Lights</div>
          <div class="text-xs text-gray-500 mt-1">Send OFF or ON even when the light state is unknown.</div>
        </div>
      </div>
      <div class="controls-section-body grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        <div
          v-for="light in lightControls"
          :key="light.key"
          class="generic-light-card"
          :data-generic-light="light.key"
          :data-aircraft-control-group="`generic-light-${light.key}`"
          :data-aircraft-search-label="`${light.label} light`"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-wider text-gray-300">{{ light.label }}</span>
            <span
              class="generic-light-state"
              :class="getLightState(light.key) === true ? 'text-accent' : 'text-gray-500'"
            >
              {{ getLightStateLabel(light.key) }}
            </span>
          </div>
          <div class="generic-light-actions">
            <button
              :id="`ctrl-light-${light.key}-off-btn`"
              class="generic-light-command"
              :class="getLightState(light.key) === false ? 'is-active' : ''"
              :disabled="isCommandDisabled(getLightCommand(light.key, false))"
              :aria-busy="isCommandBusy(getLightCommand(light.key, false)) ? 'true' : 'false'"
              :aria-pressed="getLightState(light.key) === false ? 'true' : 'false'"
              :aria-label="`${light.label} light off`"
              @click="requestLightSet(light.key, false)"
            >
              OFF
            </button>
            <button
              :id="`ctrl-light-${light.key}-on-btn`"
              class="generic-light-command"
              :class="getLightState(light.key) === true ? 'is-active' : ''"
              :disabled="isCommandDisabled(getLightCommand(light.key, true))"
              :aria-busy="isCommandBusy(getLightCommand(light.key, true)) ? 'true' : 'false'"
              :aria-pressed="getLightState(light.key) === true ? 'true' : 'false'"
              :aria-label="`${light.label} light on`"
              @click="requestLightSet(light.key, true)"
            >
              ON
            </button>
          </div>
        </div>
      </div>
    </section>

    <section id="generic-aircraft-section-autopilot" class="controls-section" tabindex="-1" aria-label="Autopilot">
      <div class="controls-section-header">
        <div>
          <div class="controls-kicker">Autopilot</div>
          <div
            id="ap-capability-note"
            class="text-xs mt-1"
            :class="hasAnyAutopilotWriteCapability ? 'text-gray-500' : 'text-amber-300'"
          >
            {{ autopilotCapabilityText }}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <div
            id="ap-status-indicator"
            class="w-2.5 h-2.5 rounded-full"
            :class="apStatusActive ? 'bg-accent' : 'bg-gray-600'"
          ></div>
          <span id="ap-status-text" class="text-sm" :class="apStatusActive ? 'text-accent' : 'text-gray-400'">
            {{ apStatusText }}
          </span>
        </div>
      </div>

      <div class="controls-section-body space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <AppTooltip
          v-for="mode in primaryModes"
          :key="mode.id"
          :content="getCommandTitle(mode.command)"
          anchor-class="controls-command-tooltip-anchor"
          placement="top"
        >
          <button
            :id="mode.id"
            :class="[modeButtonClass, mode.active ? 'border-accent bg-accent/10' : '', isCommandDisabled(mode.command) ? 'opacity-50 cursor-not-allowed' : '', isCommandBusy(mode.command) ? 'border-accent/50 bg-accent/10' : '']"
            :data-mode="mode.dataMode || undefined"
            :disabled="isCommandDisabled(mode.command)"
            :aria-busy="isCommandBusy(mode.command) ? 'true' : 'false'"
            @click="requestControlCommand(mode.command)"
          >
            <div class="text-xs text-gray-500 uppercase tracking-wider mb-1">{{ mode.label }}</div>
            <div :id="mode.stateId" class="text-xl font-semibold" :class="mode.active ? 'text-accent' : 'text-gray-400'">{{ mode.stateLabel }}</div>
            <div class="h-4 mt-2 text-[10px]" :class="isCommandBusy(mode.command) ? 'text-accent' : 'text-transparent'">
              {{ isCommandBusy(mode.command) ? 'Sending...' : '.' }}
            </div>
          </button>
        </AppTooltip>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div v-for="selector in selectors" :key="selector.mode" class="controls-selector-card p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-gray-500 uppercase tracking-wider">{{ selector.label }}</span>
            <AppTooltip
              :content="getCommandTitle(getSelectorHoldCommand(selector.mode))"
              placement="top"
            >
              <button
                :id="`ap-${selector.mode}-engage`"
                class="controls-engage-button ap-engage-btn ff-touch-target text-xs px-3 transition-colors"
                :class="[selectorStates[selector.mode].engaged ? 'border border-accent/50 bg-accent/10' : '', isCommandDisabled(getSelectorHoldCommand(selector.mode)) ? 'opacity-50 cursor-not-allowed' : '', isCommandBusy(getSelectorHoldCommand(selector.mode)) ? 'ring-1 ring-accent/40' : '']"
                :data-mode="selector.mode"
                data-action="engage"
                :aria-label="`Toggle ${selector.label} hold, currently ${selectorStates[selector.mode].label}`"
                :disabled="isCommandDisabled(getSelectorHoldCommand(selector.mode))"
                :aria-busy="isCommandBusy(getSelectorHoldCommand(selector.mode)) ? 'true' : 'false'"
                @click="requestSelectorHold(selector.mode)"
              >
                <span
                  :id="`ap-${selector.mode}-engaged`"
                  :class="selectorStates[selector.mode].engaged ? 'text-accent' : 'text-gray-400'"
                >
                  {{ isCommandBusy(getSelectorHoldCommand(selector.mode)) ? '...' : selectorStates[selector.mode].label }}
                </span>
              </button>
            </AppTooltip>
          </div>
          <div class="autopilot-selector-controls mb-2">
            <template v-for="(action, index) in selector.actions" :key="`${selector.mode}-${action.action}`">
              <AppTooltip
                v-if="index < 2"
                :content="getCommandTitle(getSelectorAdjustCommand(selector.mode, action.action)) || getAdjustmentLabel(selector, action)"
                anchor-class="autopilot-inline-adjustment"
                placement="top"
              >
                <button
                  :class="[adjustButtonClass, (isCommandDisabled(getSelectorAdjustCommand(selector.mode, action.action)) || isSelectorTargetBusy(selector.mode)) ? 'opacity-50 cursor-not-allowed' : '', isCommandBusy(getSelectorAdjustCommand(selector.mode, action.action)) ? 'ring-1 ring-accent/40' : '']"
                  :data-mode="selector.mode"
                  :data-action="action.action"
                  :aria-label="getAdjustmentLabel(selector, action)"
                  :disabled="isCommandDisabled(getSelectorAdjustCommand(selector.mode, action.action)) || isSelectorTargetBusy(selector.mode)"
                  :aria-busy="isCommandBusy(getSelectorAdjustCommand(selector.mode, action.action)) ? 'true' : 'false'"
                  @click="requestSelectorAdjustment(selector.mode, action.action)"
                >
                  {{ isCommandBusy(getSelectorAdjustCommand(selector.mode, action.action)) ? '...' : action.label }}
                </button>
              </AppTooltip>
            </template>
            <AppTooltip
              :content="getSelectorTargetTitle(selector.mode)"
              anchor-class="autopilot-target-open-anchor"
              placement="top"
            >
              <button
                type="button"
                class="autopilot-target-open ff-touch-target"
                :aria-label="`Tune ${selector.label}, current target ${selectorStates[selector.mode].value} ${selector.units}`"
                :aria-haspopup="true"
                @click="openSelectorTargetEditor(selector.mode)"
              >
                <span :id="selector.valueId" :class="['text-2xl font-semibold tabular text-center', selector.valueClass]">{{ selectorStates[selector.mode].value }}</span>
                <span class="autopilot-target-open-hint">TUNE</span>
              </button>
            </AppTooltip>
            <template v-for="(action, index) in selector.actions" :key="`${selector.mode}-${action.action}-right`">
              <AppTooltip
                v-if="index >= 2"
                :content="getCommandTitle(getSelectorAdjustCommand(selector.mode, action.action)) || getAdjustmentLabel(selector, action)"
                anchor-class="autopilot-inline-adjustment"
                placement="top"
              >
                <button
                  :class="[adjustButtonClass, (isCommandDisabled(getSelectorAdjustCommand(selector.mode, action.action)) || isSelectorTargetBusy(selector.mode)) ? 'opacity-50 cursor-not-allowed' : '', isCommandBusy(getSelectorAdjustCommand(selector.mode, action.action)) ? 'ring-1 ring-accent/40' : '']"
                  :data-mode="selector.mode"
                  :data-action="action.action"
                  :aria-label="getAdjustmentLabel(selector, action)"
                  :disabled="isCommandDisabled(getSelectorAdjustCommand(selector.mode, action.action)) || isSelectorTargetBusy(selector.mode)"
                  :aria-busy="isCommandBusy(getSelectorAdjustCommand(selector.mode, action.action)) ? 'true' : 'false'"
                  @click="requestSelectorAdjustment(selector.mode, action.action)"
                >
                  {{ isCommandBusy(getSelectorAdjustCommand(selector.mode, action.action)) ? '...' : action.label }}
                </button>
              </AppTooltip>
            </template>
          </div>
          <div class="text-xs text-gray-500 text-center">{{ selector.units }}</div>
          <div class="autopilot-mobile-tune-hint">Tap the value for large controls</div>
        </div>
      </div>

      <div class="space-y-2">
        <div class="text-xs text-gray-500 uppercase tracking-wider">Mode Controls</div>
        <div class="flex flex-wrap gap-2">
          <AppTooltip
            v-for="mode in navModes"
            :key="mode.id"
            :content="getCommandTitle(mode.command)"
            placement="top"
          >
            <button
              :id="mode.id"
              class="controls-nav-button ap-nav-btn px-4 py-2 text-sm font-medium transition-all hover:border-accent/50"
              :class="[mode.active ? 'border-accent bg-accent/10' : '', isCommandDisabled(mode.command) ? 'opacity-50 cursor-not-allowed' : '', isCommandBusy(mode.command) ? 'ring-1 ring-accent/40' : '']"
              :disabled="isCommandDisabled(mode.command)"
              :aria-busy="isCommandBusy(mode.command) ? 'true' : 'false'"
              @click="requestControlCommand(mode.command)"
            >
              <span :id="mode.stateId" :class="mode.active ? 'text-accent' : 'text-gray-400'">{{ isCommandBusy(mode.command) ? '...' : mode.label }}</span>
            </button>
          </AppTooltip>
        </div>
        <div v-if="unsupportedNavModeLabels.length" class="text-xs text-amber-300">
          Unavailable for this profile: {{ unsupportedNavModeLabels.join(', ') }}
        </div>
      </div>

      <div class="flex items-center gap-2 text-sm text-gray-500">
        <div
          id="ap-fd-indicator"
          class="w-2 h-2 rounded-full"
          :class="aircraftControls.autopilot.fdActive === true ? 'bg-accent' : 'bg-gray-600'"
        ></div>
        <span>
          Flight Director:
          <span id="ap-fd-state">{{ booleanStateLabel(aircraftControls.autopilot.fdActive) }}</span>
        </span>
      </div>
      </div>
    </section>

    <GenericNavRadios id="generic-aircraft-section-radios" tabindex="-1" />

    <details id="controls-diagnostics" ref="diagnostics" class="controls-status-panel">
      <summary id="controls-diagnostics-toggle" class="controls-status-header">
        <span class="controls-kicker">Control diagnostics</span>
        <span class="controls-status-summary">
          <span id="controls-availability-text" class="text-xs text-gray-400">{{ aircraftControls.availability.reason }}</span>
          <span class="controls-status-chevron" aria-hidden="true">⌄</span>
        </span>
      </summary>
      <div class="controls-status-context text-xs text-gray-500">
        Standard simulator controls are active because this aircraft does not have a dedicated control page. Some add-ons may ignore these commands.
      </div>
      <div class="controls-status-grid">
        <div class="controls-status-item">
          <div class="controls-status-label">Last Command</div>
          <div id="controls-last-action" class="text-sm font-semibold text-gray-200">{{ aircraftControls.feedback.actionText }}</div>
        </div>
        <div class="controls-status-item">
          <div class="controls-status-label">Resolution</div>
          <div id="controls-last-route" class="text-sm text-gray-300">{{ aircraftControls.feedback.routeText }}</div>
        </div>
        <div class="controls-status-item">
          <div class="controls-status-label">Profile</div>
          <div id="controls-last-profile" class="text-sm text-gray-300">{{ aircraftControls.feedback.profileText }}</div>
        </div>
      </div>
    </details>

    <AutopilotTargetEditor
      :open="Boolean(activeSelector)"
      :mode="activeSelector?.mode || ''"
      :display-value="activeSelector ? selectorStates[activeSelector.mode].value : '---'"
      :live-value="activeSelector ? selectorLiveValue(activeSelector.mode) : null"
      :busy="activeSelector ? isSelectorTargetBusy(activeSelector.mode) : false"
      :disabled-reason="activeSelector ? getSelectorTargetDisabledReason(activeSelector.mode) : ''"
      :feedback-status="aircraftControls.feedback.status"
      :feedback-command-key="aircraftControls.feedback.commandKey"
      :feedback-message="aircraftControls.feedback.routeText"
      :request-apply="requestSelectorTarget"
      @close="closeSelectorTargetEditor"
    />
  </div>
</template>

<style scoped>
.controls-shell {
  width: 100%;
  max-width: none;
  margin-inline: auto;
}

[id^='generic-aircraft-section-'], .controls-status-panel {
  scroll-margin-top: 4.25rem;
}

.generic-availability, .generic-feedback {
  padding: 0.75rem 1rem;
  border: 1px solid rgb(var(--border));
  border-radius: var(--ff-radius-card);
  background: rgb(var(--panel-subtle));
  font-size: 0.8125rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.generic-availability { color: rgb(var(--muted-foreground)); }
.generic-feedback { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.generic-feedback strong { display: block; font-weight: 600; }
.generic-feedback p { margin-top: 0.2rem; color: rgb(var(--muted-foreground)); }
.generic-feedback[data-status='failed'] { border-color: rgb(var(--danger) / 0.6); }
.generic-feedback button { flex-shrink: 0; min-height: 44px; padding: 0.5rem; text-decoration: underline; }

.controls-status-panel,
.controls-section,
.controls-command-card,
.controls-selector-card,
.controls-nav-button {
  border: 1px solid rgb(var(--border) / 0.72);
  border-radius: var(--ff-radius-card);
  box-shadow: var(--ff-shadow-soft);
}

.generic-light-card {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  border: 1px solid rgb(var(--border) / 0.72);
  border-radius: var(--ff-radius-card);
  background: rgb(var(--card) / 0.78);
  padding: 0.85rem;
}

.generic-light-state {
  font-family: var(--ff-font-mono);
  font-size: 0.72rem;
  font-weight: 700;
}

.generic-light-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.generic-light-command {
  min-height: 44px;
  border: 1px solid rgb(var(--border) / 0.78);
  border-radius: 8px;
  background: rgb(var(--panel-subtle) / 0.86);
  color: rgb(var(--muted-foreground));
  font-size: 0.78rem;
  font-weight: 700;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}

.generic-light-command:hover:not(:disabled),
.generic-light-command.is-active {
  border-color: rgb(var(--primary) / 0.6);
  background: rgb(var(--primary) / 0.12);
  color: rgb(var(--foreground));
}

.generic-light-command:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.controls-status-panel {
  overflow: hidden;
  background:
    linear-gradient(180deg, rgb(var(--card) / 0.97), rgb(var(--panel-subtle) / 0.96));
}

.controls-status-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  cursor: pointer;
  list-style: none;
  background: linear-gradient(180deg, rgb(var(--panel-subtle) / 0.88) 0%, rgb(var(--panel) / 0.68) 100%);
  padding: 0.9rem 1rem;
}

.controls-status-header::-webkit-details-marker {
  display: none;
}

.controls-status-panel[open] .controls-status-header {
  border-bottom: 1px solid rgb(var(--border) / 0.72);
}

.controls-status-summary {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.75rem;
}

.controls-status-chevron {
  color: rgb(var(--muted-foreground));
  font-size: 1rem;
  line-height: 1;
  transition: transform 140ms ease;
}

.controls-status-panel[open] .controls-status-chevron {
  transform: rotate(180deg);
}

.controls-status-context {
  border-bottom: 1px solid rgb(var(--border) / 0.58);
  padding: 0.75rem 1rem;
}

.controls-status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.controls-status-item {
  display: grid;
  align-content: start;
  gap: 0.22rem;
  min-height: 3.9rem;
  padding: 0.82rem 1rem 0.9rem;
}

.controls-status-item + .controls-status-item {
  border-left: 1px solid rgb(var(--border) / 0.58);
}

.controls-status-label {
  color: rgb(var(--muted-foreground));
  font-family: var(--ff-font-mono);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.controls-section {
  overflow: hidden;
  background:
    linear-gradient(180deg, rgb(var(--card) / 0.97), rgb(var(--panel-subtle) / 0.96));
}

.controls-section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgb(var(--border) / 0.72);
  background: linear-gradient(180deg, rgb(var(--panel-subtle) / 0.88) 0%, rgb(var(--panel) / 0.68) 100%);
  padding: 0.9rem 1rem;
}

.controls-section-body {
  padding: 1rem;
}

.controls-kicker {
  font-family: var(--ff-font-mono);
  text-transform: uppercase;
  font-weight: 700;
}

.controls-kicker {
  color: rgb(var(--primary));
  font-size: 0.72rem;
  letter-spacing: 0.18em;
}

.controls-command-card,
.controls-selector-card,
.controls-nav-button {
  background: rgb(var(--card) / 0.78);
}

.controls-command-card:hover,
.controls-nav-button:hover {
  background: rgb(var(--panel-elevated) / 0.55);
}

.controls-selector-card {
  min-width: 0;
}

.autopilot-selector-controls {
  display: grid;
  grid-template-columns: auto auto minmax(5.4rem, 1fr) auto auto;
  align-items: center;
  justify-content: center;
  gap: 0.28rem;
}

.autopilot-target-open-anchor {
  display: block;
  min-width: 0;
}

.autopilot-target-open {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 3rem;
  place-items: center;
  gap: 0.05rem;
  border: 1px solid rgb(var(--primary) / 0.24);
  border-radius: 8px;
  background: rgb(var(--background) / 0.45);
  color: rgb(var(--foreground));
}

.autopilot-target-open:hover:not(:disabled) {
  border-color: rgb(var(--primary) / 0.58);
  background: rgb(var(--primary) / 0.09);
}

.autopilot-target-open-hint {
  color: rgb(var(--primary));
  font-family: var(--ff-font-mono);
  font-size: 0.52rem;
  font-weight: 750;
  letter-spacing: 0.14em;
}

.autopilot-mobile-tune-hint {
  display: none;
  margin-top: 0.45rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.68rem;
  text-align: center;
}

.controls-adjust-button,
.controls-engage-button {
  border-radius: 7px;
  background: rgb(var(--panel-subtle) / 0.86);
  color: rgb(var(--muted-foreground));
}

.controls-adjust-button:hover,
.controls-engage-button:hover {
  background: rgb(var(--panel-elevated) / 0.82);
  color: rgb(var(--foreground));
}

.controls-nav-button {
  border-radius: 8px;
}

.controls-command-tooltip-anchor {
  width: 100%;
}

.controls-command-tooltip-anchor > .controls-command-card {
  width: 100%;
  height: 100%;
}

@media (max-width: 640px) {
  .controls-section-header {
    display: grid;
  }

  .controls-status-grid {
    grid-template-columns: 1fr;
  }

  .controls-status-item + .controls-status-item {
    border-top: 1px solid rgb(var(--border) / 0.58);
    border-left: 0;
  }

  .autopilot-selector-controls {
    grid-template-columns: minmax(0, 1fr);
  }

  :deep(.autopilot-inline-adjustment) {
    display: none;
  }

  .autopilot-target-open-anchor,
  .autopilot-target-open {
    width: 100%;
  }

  .autopilot-target-open {
    min-height: 4.5rem;
  }

  .autopilot-mobile-tune-hint {
    display: block;
  }
}

@media (pointer: coarse) {
  .controls-command-card,
  .controls-nav-button,
  .controls-adjust-button,
  .controls-engage-button {
    min-width: var(--ff-touch-target-flight);
    min-height: var(--ff-touch-target-flight);
  }
}
</style>
