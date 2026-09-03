<script setup>
import { computed, ref, watch } from 'vue';
import { mcpDraftKey, submitMcpDraft } from '../mcp-input.js';

const props = defineProps({
  profileKey: { type: String, default: '' },
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
  controlSetupRequired: { type: Boolean, default: false },
});

const unavailableFields = computed(() => new Set(props.unavailable));
const numericDrafts = ref({});
const variant = computed(() => (
  props.profileKey.includes('a350-1000') ? 'A350-1000' : 'A350-900'
));

watch(
  () => [props.profileKey, props.sourceStatus],
  () => { numericDrafts.value = {}; },
);

const sectionLinks = Object.freeze([
  { id: 'a350-fcu', label: 'FCU' },
  { id: 'a350-exterior', label: 'Exterior' },
  { id: 'a350-cabin', label: 'Cabin' },
  { id: 'a350-air', label: 'Air & APU' },
  { id: 'a350-surfaces', label: 'Controls' },
  { id: 'a350-systems', label: 'Systems' },
]);

const fcuControls = Object.freeze([
  {
    id: 'speed', label: 'SPD', fieldId: 'flightGuidance.speedValue',
    actionId: 'flightGuidance.speed.set', commandId: 'flightGuidance.speed.set',
    groupId: 'flightGuidance.speed', min: 100, max: 399, step: 1, unit: 'kt',
  },
  {
    id: 'heading', label: 'HDG', fieldId: 'flightGuidance.headingDeg',
    actionId: 'flightGuidance.heading.set', commandId: 'flightGuidance.heading.set',
    groupId: 'flightGuidance.heading', min: 0, max: 359, step: 1, unit: '°', digits: 3,
  },
  {
    id: 'altitude', label: 'ALT', fieldId: 'flightGuidance.altitudeFt',
    actionId: 'flightGuidance.altitude.set', commandId: 'flightGuidance.altitude.set',
    groupId: 'flightGuidance.altitude', min: 0, max: 49000, step: 100, unit: 'ft', locale: true,
  },
  {
    id: 'vertical-speed', label: 'V/S', fieldId: 'flightGuidance.verticalSpeedFpm',
    actionId: 'flightGuidance.verticalSpeed.set', commandId: 'flightGuidance.verticalSpeed.set',
    groupId: 'flightGuidance.verticalSpeed', min: -6000, max: 6000, step: 100, unit: 'fpm', signed: true,
  },
]);

function booleanControl(title, fieldId, prefix, commandId = '') {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: [
      {
        id: `${prefix}.off`, label: 'OFF', value: false,
        ...(commandId ? { commandId, commandInput: { value: false } } : {}),
      },
      {
        id: `${prefix}.on`, label: 'ON', value: true,
        ...(commandId ? { commandId, commandInput: { value: true } } : {}),
      },
    ],
  };
}

function detentControl(title, fieldId, prefix, positions, commandId = '') {
  return {
    title,
    fieldId,
    groupId: prefix,
    actions: positions.map(([id, label, commandValue = id]) => ({
      id: `${prefix}.${id}`,
      label,
      value: id,
      ...(commandId ? { commandId, commandInput: { value: commandValue } } : {}),
    })),
  };
}

const flightControls = Object.freeze([
  booleanControl('FD', 'flightGuidance.flightDirector', 'flightGuidance.flightDirector'),
  booleanControl('LS CAPT', 'flightGuidance.lsCaptain', 'flightGuidance.lsCaptain'),
  booleanControl('LS F/O', 'flightGuidance.lsFirstOfficer', 'flightGuidance.lsFirstOfficer'),
  booleanControl('VV CAPT', 'flightGuidance.verticalViewCaptain', 'flightGuidance.verticalViewCaptain'),
  booleanControl('VV F/O', 'flightGuidance.verticalViewFirstOfficer', 'flightGuidance.verticalViewFirstOfficer'),
  booleanControl('METRIC ALT', 'flightGuidance.metricAltitude', 'flightGuidance.metricAltitude'),
]);

const exteriorControls = Object.freeze([
  detentControl('STROBE', 'lights.strobeMode', 'lights.strobe', [
    ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
  ], 'lights.strobeMode.set'),
  booleanControl('BEACON', 'lights.beacon', 'lights.beacon', 'lights.beacon.set'),
  {
    ...detentControl('NAV', 'lights.navMode', 'lights.nav', [
      ['off', 'OFF'], ['nav2', 'NAV 2'], ['nav1', 'NAV 1'],
    ]),
    actions: [
      { id: 'lights.nav.off', label: 'OFF', value: 'off', commandId: 'lights.nav.set', commandInput: { value: false } },
      { id: 'lights.nav.nav2', label: 'NAV 2', value: 'nav2' },
      { id: 'lights.nav.nav1', label: 'NAV 1', value: 'nav1', commandId: 'lights.nav.set', commandInput: { value: true } },
    ],
  },
  detentControl('LOGO', 'lights.logoMode', 'lights.logo', [
    ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
  ]),
  booleanControl('WING', 'lights.wing', 'lights.wing'),
  booleanControl('LANDING', 'lights.landing', 'lights.landing', 'lights.landing.set'),
  detentControl('NOSE', 'lights.noseMode', 'lights.nose', [
    ['off', 'OFF'], ['taxi', 'TAXI'], ['takeoff', 'T.O'],
  ], 'lights.noseMode.set'),
]);

const cabinControls = Object.freeze([
  detentControl('SEAT BELTS', 'cabin.seatBeltsMode', 'cabin.seatBelts', [
    ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
  ]),
  detentControl('NO SMOKING', 'cabin.noSmokingMode', 'cabin.noSmoking', [
    ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
  ]),
  detentControl('NO MOBILE', 'cabin.noMobileMode', 'cabin.noMobile', [
    ['off', 'OFF'], ['auto', 'AUTO'], ['on', 'ON'],
  ]),
  detentControl('EMER EXIT LT', 'cabin.emergencyExitMode', 'cabin.emergencyExit', [
    ['off', 'OFF'], ['arm', 'ARM'], ['on', 'ON'],
  ]),
]);

const airControls = Object.freeze([
  booleanControl('APU MASTER', 'systems.apuMaster', 'systems.apuMaster'),
  {
    title: 'APU START',
    fieldId: 'systems.apuStart',
    groupId: 'systems.apuStart',
    actions: [{ id: 'systems.apuStart.start', label: 'START', value: true }],
  },
  detentControl('AIR FLOW', 'systems.airFlowMode', 'systems.airFlow', [
    ['manual', 'MAN'], ['low', 'LO'], ['normal', 'NORM'], ['high', 'HI'],
  ]),
  detentControl('X BLEED', 'systems.crossBleedMode', 'systems.crossBleed', [
    ['closed', 'CLOSE'], ['auto', 'AUTO'], ['open', 'OPEN'],
  ]),
  booleanControl('RAM AIR', 'systems.ramAir', 'systems.ramAir'),
  booleanControl('WING A.ICE', 'systems.wingAntiIce', 'systems.wingAntiIce'),
  detentControl('PROBE/WINDOW HEAT', 'systems.probeWindowHeatMode', 'systems.probeWindowHeat', [
    ['auto', 'AUTO'], ['on', 'ON'],
  ]),
]);

const surfaceControls = Object.freeze([
  {
    title: 'GEAR HANDLE', fieldId: 'controls.gearHandleDown', groupId: 'controls.gear',
    actions: [
      { id: 'controls.gear.up', label: 'UP', value: false, commandId: 'surfaces.gear.set', commandInput: { value: 'up' } },
      { id: 'controls.gear.down', label: 'DOWN', value: true, commandId: 'surfaces.gear.set', commandInput: { value: 'down' } },
    ],
  },
  {
    ...booleanControl('PARK BRAKE', 'controls.parkingBrake', 'controls.parkingBrake', 'surfaces.parkingBrake.set'),
    actions: [
      { id: 'controls.parkingBrake.off', label: 'RELEASE', value: false, commandId: 'surfaces.parkingBrake.set', commandInput: { value: false } },
      { id: 'controls.parkingBrake.on', label: 'SET', value: true, commandId: 'surfaces.parkingBrake.set', commandInput: { value: true } },
    ],
  },
  {
    ...booleanControl('GROUND SPOILERS', 'controls.spoilersArmed', 'controls.spoilersArmed', 'surfaces.spoilersArmed.set'),
    actions: [
      { id: 'controls.spoilersArmed.off', label: 'DISARM', value: false, commandId: 'surfaces.spoilersArmed.set', commandInput: { value: false } },
      { id: 'controls.spoilersArmed.on', label: 'ARM', value: true, commandId: 'surfaces.spoilersArmed.set', commandInput: { value: true } },
    ],
  },
]);

const flapControl = Object.freeze({
  title: 'FLAP HANDLE',
  fieldId: 'controls.flapsIndex',
  groupId: 'controls.flaps',
  actions: [
    { id: 'controls.flaps.decrease', label: 'DECREASE', commandId: 'surfaces.flaps.adjust', commandInput: { value: 'decrease' } },
    { id: 'controls.flaps.increase', label: 'INCREASE', commandId: 'surfaces.flaps.adjust', commandInput: { value: 'increase' } },
  ],
});

const speedbrakeControl = Object.freeze({
  id: 'speedbrake', label: 'SPEEDBRAKE', fieldId: 'controls.speedbrakePercent',
  actionId: 'controls.speedbrake.set', groupId: 'controls.speedbrake',
  min: 0, max: 100, step: 1, unit: '%',
});

const takeoffLightReadbackFields = Object.freeze([
  'lights.landing',
  'lights.noseMode',
  'lights.strobeMode',
  'lights.navMode',
]);

const controlSections = Object.freeze([
  { id: 'a350-exterior', kicker: 'Exterior Lights', controls: exteriorControls, columns: 'xl:grid-cols-4' },
  { id: 'a350-cabin', kicker: 'Cabin Signs', controls: cabinControls, columns: 'xl:grid-cols-4' },
  { id: 'a350-air', kicker: 'APU, Air & Anti-Ice', controls: airControls, columns: 'xl:grid-cols-4' },
]);

const systemIndicators = Object.freeze([
  { id: 'systems.ignitionMode', label: 'ENG MODE' },
  { id: 'systems.gravityGearCover', label: 'GRAV GEAR COVER', tone: 'warning' },
  { id: 'systems.gravityGearHandleMode', label: 'GRAV GEAR HANDLE', tone: 'warning' },
  { id: 'systems.cabinPressureAltitudeMode', label: 'CAB ALT' },
  { id: 'systems.cabinPressureVerticalSpeedMode', label: 'CAB V/S' },
  { id: 'systems.ditching', label: 'DITCHING', tone: 'warning' },
  { id: 'systems.crewSupply', label: 'CREW SUPPLY' },
  { id: 'systems.emergencyElectricalGenerator', label: 'EMER GEN', tone: 'warning' },
  { id: 'systems.groundControl', label: 'GND CTL' },
  { id: 'systems.electricalSideIsolation', label: 'SIDE ISOL' },
  { id: 'systems.electricalLoadManagement', label: 'ELM' },
  { id: 'systems.passengerSystems', label: 'PAX SYS' },
  { id: 'systems.galley', label: 'GALLEY' },
  { id: 'systems.busTie', label: 'BUS TIE' },
  { id: 'systems.evacuationCommand', label: 'EVAC CMD', tone: 'warning' },
]);

function hasValue(id) {
  return !unavailableFields.value.has(id)
    && Object.prototype.hasOwnProperty.call(props.values, id);
}

function value(id) {
  return hasValue(id) ? props.values[id] : null;
}

function controlValue(control) {
  const current = value(control.fieldId);
  return typeof current === 'boolean' || typeof current === 'string' ? current : null;
}

function valueText(id) {
  const current = value(id);
  if (current === null) return '--';
  if (typeof current === 'boolean') return current ? 'ON' : 'OFF';
  if (typeof current === 'number') return Number.isFinite(current) ? String(Math.round(current)) : '--';
  return String(current).replaceAll('-', ' ').toUpperCase();
}

function actionSupported(action) {
  return action.commandId
    ? props.isCommandSupported(action.commandId)
    : props.actionCapabilities[action.id] === true;
}

function groupPending(groupId) {
  return props.isActionPending(groupId) === true;
}

function actionDisabled(control, action) {
  return props.sourceStatus !== 'connected'
    || !hasValue(control.fieldId)
    || !actionSupported(action)
    || groupPending(control.groupId);
}

function controlStatusId(control) {
  return `inibuilds-a350-control-status-${control.groupId}`;
}

function actionDisabledReason(control, action) {
  if (!actionDisabled(control, action)) return '';
  if (groupPending(control.groupId)) return 'Command pending.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (!hasValue(control.fieldId)) return 'Live switch readback unavailable.';
  if (!actionSupported(action) && props.controlSetupRequired) return 'Requires MobiFlight Event Module setup.';
  if (!actionSupported(action)) return 'Compatible write transport unavailable.';
  return 'Control temporarily unavailable.';
}

function requestControlAction(control, action) {
  if (actionDisabled(control, action)) return false;
  if (action.commandId) {
    return props.requestCommand(action.commandId, control.groupId, action.commandInput || {});
  }
  return props.requestAction(action.id, control.groupId);
}

function actionButtonClass(selected) {
  return selected
    ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100 shadow-sm'
    : 'border-surface-300 bg-surface-100 text-gray-300 hover:border-surface-400 hover:bg-surface-200';
}

function controlStatus(control) {
  if (groupPending(control.groupId)) return 'Command pending…';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (!hasValue(control.fieldId)) return 'Live readback unavailable; control disabled.';
  if (!control.actions.some((action) => actionSupported(action))) {
    return props.controlSetupRequired
      ? 'Requires MobiFlight Event Module setup.'
      : 'Compatible write transport unavailable.';
  }
  return '';
}

function numericConfig(control) {
  const descriptor = control.commandId ? props.getCommand(control.commandId) : null;
  const input = descriptor?.input;
  return input?.kind === 'number'
    ? { ...control, min: input.min, max: input.max, step: input.step }
    : control;
}

function numericDraft(control) {
  const config = numericConfig(control);
  const key = mcpDraftKey(config, control.id);
  if (Object.prototype.hasOwnProperty.call(numericDrafts.value, key)) return numericDrafts.value[key];
  const current = value(control.fieldId);
  return typeof current === 'number' && Number.isFinite(current) ? current : '';
}

function updateNumericDraft(control, event) {
  const config = numericConfig(control);
  numericDrafts.value = {
    ...numericDrafts.value,
    [mcpDraftKey(config, control.id)]: event.target.value,
  };
}

function numericDisabled(control) {
  const config = numericConfig(control);
  return props.sourceStatus !== 'connected'
    || !hasValue(control.fieldId)
    || (config.commandId
      ? !props.isCommandSupported(config.commandId)
      : props.actionCapabilities[config.actionId] !== true)
    || groupPending(control.groupId);
}

function submitNumeric(control) {
  const config = numericConfig(control);
  const sent = submitMcpDraft({
    config,
    disabled: numericDisabled(control),
    groupId: control.groupId,
    rawValue: numericDraft(control),
    requestAction: props.requestAction,
    requestCommand: props.requestCommand,
  });
  if (sent !== false) {
    const next = { ...numericDrafts.value };
    delete next[mcpDraftKey(config, control.id)];
    numericDrafts.value = next;
  }
  return sent;
}

function formatNumeric(control) {
  const current = value(control.fieldId);
  if (typeof current !== 'number' || !Number.isFinite(current)) return '--';
  const rounded = Math.round(current);
  if (control.signed) return `${rounded >= 0 ? '+' : ''}${rounded}`;
  if (control.locale) return rounded.toLocaleString('en-US');
  if (control.digits) return String(rounded).padStart(control.digits, '0');
  return String(rounded);
}

function flapActionDisabled(action) {
  return props.sourceStatus !== 'connected'
    || !hasValue(flapControl.fieldId)
    || !props.isCommandSupported(action.commandId)
    || groupPending(flapControl.groupId);
}

function requestFlapAction(action) {
  if (flapActionDisabled(action)) return false;
  return props.requestCommand(action.commandId, flapControl.groupId, action.commandInput);
}

function takeoffLightsDisabled() {
  return props.sourceStatus !== 'connected'
    || takeoffLightReadbackFields.some((fieldId) => !hasValue(fieldId))
    || !props.isCommandSupported('configuration.lights.takeoff')
    || groupPending('lights.takeoffPreset');
}

function takeoffLightsDisabledReason() {
  if (!takeoffLightsDisabled()) return '';
  if (groupPending('lights.takeoffPreset')) return 'Command pending.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (takeoffLightReadbackFields.some((fieldId) => !hasValue(fieldId))) {
    return 'Required light readback unavailable.';
  }
  return 'Compatible write transport unavailable.';
}

function requestTakeoffLights() {
  if (takeoffLightsDisabled()) return false;
  return props.requestCommand('configuration.lights.takeoff', 'lights.takeoffPreset', {});
}

function indicatorClass(indicator) {
  const current = value(indicator.id);
  if (current === null) return 'border-surface-200 bg-surface-50 text-gray-500';
  const active = typeof current === 'boolean'
    ? current
    : !['off', 'closed', 'normal', 'auto', 'reset'].includes(current);
  if (!active) return 'border-surface-200 bg-surface-50 text-gray-400';
  if (indicator.tone === 'warning') return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
  return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
}

function scrollToSection(sectionId) {
  document.getElementById(sectionId)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <div
    class="space-y-5 p-3 sm:p-4"
    data-aircraft-template="inibuilds-a350"
    :data-inibuilds-a350-variant="variant"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h3 class="text-base font-semibold text-gray-100">iniBuilds Airbus {{ variant }}</h3>
        <p class="text-xs text-gray-500">Published A350 state with guarded, readback-confirmed controls and voice commands.</p>
      </div>
      <span class="text-[10px] uppercase tracking-widest text-gray-500">{{ sourceStatus }}</span>
    </div>

    <nav
      class="sticky top-0 z-10 -mx-3 flex gap-1 overflow-x-auto border-y border-surface-200 bg-surface-100/95 px-3 py-2 backdrop-blur sm:static sm:mx-0 sm:rounded-lg sm:border"
      aria-label="iniBuilds Airbus A350 page sections"
      data-aircraft-section-ribbon
      data-mobile-aircraft-navigation="section-ribbon"
    >
      <button
        v-for="section in sectionLinks"
        :key="section.id"
        type="button"
        class="min-h-9 shrink-0 rounded-md border border-surface-300 bg-surface-50 px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-300 hover:border-cyan-500/50 hover:text-cyan-200"
        @click="scrollToSection(section.id)"
      >
        {{ section.label }}
      </button>
    </nav>

    <section id="a350-fcu" class="aircraft-mobile-navigable-section scroll-mt-20" tabindex="-1">
      <div class="dashboard-section-kicker">Flight Control Unit</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <form
          v-for="control in fcuControls"
          :key="control.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-aircraft-control-group="control.groupId"
          @submit.prevent="submitNumeric(control)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{{ control.label }}</span>
            <span class="font-mono text-sm font-semibold text-cyan-100">{{ formatNumeric(control) }} {{ control.unit }}</span>
          </div>
          <div class="mt-2 flex gap-1.5">
            <input
              class="min-h-10 min-w-0 flex-1 rounded border border-surface-300 bg-surface-100 px-2 font-mono text-sm text-gray-100 outline-none focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-45"
              type="number"
              :value="numericDraft(control)"
              :min="numericConfig(control).min"
              :max="numericConfig(control).max"
              :step="numericConfig(control).step"
              :aria-label="`${control.label} target`"
              :disabled="numericDisabled(control)"
              :data-aircraft-command="control.commandId"
              @input="updateNumericDraft(control, $event)"
            >
            <button
              type="submit"
              class="min-h-10 rounded border border-cyan-500/45 bg-cyan-500/10 px-3 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              :disabled="numericDisabled(control)"
            >
              SET
            </button>
          </div>
        </form>
      </div>

      <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <div
          v-for="control in flightControls"
          :key="control.groupId"
          class="rounded-lg border border-surface-200 bg-surface-50 p-2.5"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="mb-2 flex items-center justify-between gap-2 text-[9px] font-semibold">
            <span class="text-gray-300">{{ control.title }}</span>
            <span class="text-gray-500">{{ valueText(control.fieldId) }}</span>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            <button
              v-for="action in control.actions"
              :key="action.id"
              type="button"
              class="min-h-9 rounded border px-1.5 py-1.5 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="actionButtonClass(controlValue(control) === action.value)"
              :data-aircraft-action="action.id"
              :aria-pressed="controlValue(control) === action.value"
              :title="actionDisabledReason(control, action) || undefined"
              :disabled="actionDisabled(control, action)"
              @click="requestControlAction(control, action)"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">
        FCU targets use iniBuilds' published direct set/read variables. AP1/AP2, A/THR, LOC, APPR and selector push/pull remain omitted because their published command variables auto-reset without stable mode confirmation.
      </p>
    </section>

    <section
      v-for="section in controlSections"
      :id="section.id"
      :key="section.id"
      class="aircraft-mobile-navigable-section scroll-mt-20"
      tabindex="-1"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="dashboard-section-kicker">{{ section.kicker }}</div>
        <button
          v-if="section.id === 'a350-exterior'"
          type="button"
          class="min-h-9 rounded border border-cyan-500/40 bg-cyan-500/10 px-3 text-[9px] font-semibold uppercase tracking-wider text-cyan-100 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-45"
          data-aircraft-command="configuration.lights.takeoff"
          :disabled="takeoffLightsDisabled()"
          :title="takeoffLightsDisabledReason() || undefined"
          @click="requestTakeoffLights"
        >
          Takeoff lights
        </button>
      </div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2" :class="section.columns">
        <div
          v-for="control in section.controls"
          :key="control.groupId"
          class="rounded-lg border border-surface-200 bg-surface-50 p-2.5"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="mb-2 flex items-center justify-between gap-2 text-[9px] font-semibold">
            <span class="text-gray-300">{{ control.title }}</span>
            <span class="text-gray-500">{{ valueText(control.fieldId) }}</span>
          </div>
          <div
            class="grid gap-1.5"
            :class="control.actions.length === 4 ? 'grid-cols-4' : (control.actions.length === 3 ? 'grid-cols-3' : (control.actions.length === 2 ? 'grid-cols-2' : 'grid-cols-1'))"
          >
            <button
              v-for="action in control.actions"
              :key="action.id"
              type="button"
              class="min-h-10 rounded border px-1.5 py-1.5 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="actionButtonClass(controlValue(control) === action.value)"
              :data-aircraft-action="action.id"
              :data-aircraft-command="action.commandId || undefined"
              :aria-pressed="controlValue(control) === action.value"
              :aria-describedby="actionDisabled(control, action) ? controlStatusId(control) : undefined"
              :title="actionDisabledReason(control, action) || undefined"
              :disabled="actionDisabled(control, action)"
              @click="requestControlAction(control, action)"
            >
              {{ action.label }}
            </button>
          </div>
          <p
            v-if="controlStatus(control)"
            :id="controlStatusId(control)"
            class="mt-1.5 text-[9px] leading-snug text-gray-500"
          >{{ controlStatus(control) }}</p>
        </div>
      </div>
    </section>

    <section id="a350-surfaces" class="aircraft-mobile-navigable-section scroll-mt-20" tabindex="-1">
      <div class="dashboard-section-kicker">Flight Controls, Gear & Brakes</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="control in surfaceControls"
          :key="control.groupId"
          class="rounded-lg border border-surface-200 bg-surface-50 p-2.5"
          :data-aircraft-control-group="control.groupId"
        >
          <div class="mb-2 flex items-center justify-between gap-2 text-[9px] font-semibold">
            <span class="text-gray-300">{{ control.title }}</span>
            <span class="text-gray-500">{{ valueText(control.fieldId) }}</span>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            <button
              v-for="action in control.actions"
              :key="action.id"
              type="button"
              class="min-h-10 rounded border px-1.5 py-1.5 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              :class="actionButtonClass(controlValue(control) === action.value)"
              :data-aircraft-action="action.id"
              :data-aircraft-command="action.commandId"
              :aria-pressed="controlValue(control) === action.value"
              :disabled="actionDisabled(control, action)"
              @click="requestControlAction(control, action)"
            >
              {{ action.label }}
            </button>
          </div>
        </div>

        <div class="rounded-lg border border-surface-200 bg-surface-50 p-2.5" :data-aircraft-control-group="flapControl.groupId">
          <div class="mb-2 flex items-center justify-between gap-2 text-[9px] font-semibold">
            <span class="text-gray-300">{{ flapControl.title }}</span>
            <span class="text-gray-500">INDEX {{ valueText(flapControl.fieldId) }}</span>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            <button
              v-for="action in flapControl.actions"
              :key="action.id"
              type="button"
              class="min-h-10 rounded border border-surface-300 bg-surface-100 px-1.5 py-1.5 text-[9px] font-semibold text-gray-300 hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-45"
              :data-aircraft-action="action.id"
              :data-aircraft-command="action.commandId"
              :disabled="flapActionDisabled(action)"
              @click="requestFlapAction(action)"
            >
              {{ action.label }}
            </button>
          </div>
        </div>

        <form
          class="rounded-lg border border-surface-200 bg-surface-50 p-2.5"
          :data-aircraft-control-group="speedbrakeControl.groupId"
          @submit.prevent="submitNumeric(speedbrakeControl)"
        >
          <div class="flex items-center justify-between gap-2 text-[9px] font-semibold">
            <span class="text-gray-300">{{ speedbrakeControl.label }}</span>
            <span class="text-gray-500">{{ formatNumeric(speedbrakeControl) }}%</span>
          </div>
          <div class="mt-2 flex gap-1.5">
            <input
              class="min-h-10 min-w-0 flex-1 rounded border border-surface-300 bg-surface-100 px-2 font-mono text-sm text-gray-100 outline-none focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-45"
              type="number"
              :value="numericDraft(speedbrakeControl)"
              :min="speedbrakeControl.min"
              :max="speedbrakeControl.max"
              :step="speedbrakeControl.step"
              aria-label="Speedbrake target percent"
              :disabled="numericDisabled(speedbrakeControl)"
              data-aircraft-action="controls.speedbrake.set"
              @input="updateNumericDraft(speedbrakeControl, $event)"
            >
            <button
              type="submit"
              class="min-h-10 rounded border border-cyan-500/45 bg-cyan-500/10 px-3 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              :disabled="numericDisabled(speedbrakeControl)"
            >SET</button>
          </div>
        </form>
      </div>
      <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div v-for="gear in ['Nose', 'Left', 'Right']" :key="gear" class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">
          {{ gear }} gear <span class="float-right font-mono text-gray-100">{{ valueText(`controls.gear${gear}Pct`) }}%</span>
        </div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] text-gray-300">
          Flap angle <span class="float-right font-mono text-gray-100">{{ valueText('controls.flapAngleDeg') }}°</span>
        </div>
      </div>
    </section>

    <section id="a350-systems" class="aircraft-mobile-navigable-section scroll-mt-20" tabindex="-1">
      <div class="dashboard-section-kicker">Systems Snapshot</div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div
          v-for="indicator in systemIndicators"
          :key="indicator.id"
          class="rounded border px-2.5 py-2 text-[10px] font-semibold"
          :class="indicatorClass(indicator)"
        >
          {{ indicator.label }} <span class="float-right opacity-70">{{ valueText(indicator.id) }}</span>
        </div>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">
        Engine mode, gravity gear, cabin pressure, ditching, evacuation and electrical states remain monitoring-only.
      </p>
    </section>

    <p class="text-[10px] leading-relaxed text-amber-300/80">
      Initial live validation is pending. Confirm each enabled remote or voice control against the cockpit before relying on it operationally.
    </p>
  </div>
</template>
