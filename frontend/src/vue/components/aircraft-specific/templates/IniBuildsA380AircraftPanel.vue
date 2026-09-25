<script setup>
import { computed } from 'vue';
import { useAircraftPageSections } from '../aircraft-page-sections.js';
import IniBuildsA380FcuTargets from './IniBuildsA380FcuTargets.vue';

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  requestCommand: { type: Function, default: () => false },
  requestAction: { type: Function, default: () => false },
  actionCapabilities: { type: Object, default: () => ({}) },
  isCommandSupported: { type: Function, default: () => false },
  isActionPending: { type: Function, default: () => false },
  controlSetupRequired: { type: Boolean, default: false },
  controlsEnabled: { type: Boolean, default: false },
  controlsDisabledReason: { type: String, default: '' },
});
const unavailableFields = computed(() => new Set(props.unavailable));
const binary = [['OFF', false], ['ON', true]];
const automatic = [['OFF', 'off'], ['AUTO', 'auto'], ['ON', 'on']];
const lightControls = [
  { title: 'Strobe', field: 'strobeMode', group: 'strobe', choices: automatic },
  { title: 'Beacon', field: 'beacon', group: 'beacon', choices: binary },
  { title: 'Navigation', field: 'nav', group: 'nav', choices: binary },
  { title: 'Logo', field: 'logoMode', group: 'logo', choices: automatic },
  { title: 'Wing', field: 'wing', group: 'wing', choices: binary },
  { title: 'Runway turnoff & camera', field: 'runwayTurnoff', group: 'runwayTurnoff', choices: binary },
  { title: 'Landing', field: 'landing', group: 'landing', choices: binary },
  { title: 'Nose', field: 'noseMode', group: 'nose', choices: [['OFF', 'off'], ['TAXI', 'taxi'], ['T.O', 'takeoff']] },
].map(control => ({ ...control, field: `lights.${control.field}`, group: `lights.${control.group}`, command: `lights.${control.field}.set` }));
const sections = [
  { id: 'guidance', title: 'Flight guidance', controls: [
    { title: 'Flight director', field: 'flightGuidance.flightDirector', group: 'flightGuidance.flightDirector', command: 'flightGuidance.flightDirector.set', choices: binary },
  ] },
  { id: 'surfaces', title: 'Flight controls', controls: [
    { title: 'Flap lever', field: 'controls.flaps', group: 'controls.flaps', command: 'surfaces.flaps.set', choices: [['UP', 'up'], ['1', '1'], ['2', '2'], ['3', '3'], ['FULL', 'full']] },
    { title: 'Speedbrake lever', field: 'controls.speedbrake', group: 'controls.speedbrake', command: 'surfaces.spoilers.set', choices: [['STOW', 'retracted'], ['HALF', 'half'], ['FULL', 'full']] },
    { title: 'Ground spoilers', field: 'controls.spoilersArmed', group: 'controls.speedbrake', command: 'surfaces.spoilersArmed.set', choices: [['DISARM', false], ['ARM', true]] },
  ] },
  { id: 'exterior', title: 'Exterior lights', controls: lightControls },
  { id: 'cabin', title: 'Cabin signs', controls: [
    { title: 'Seat belts', field: 'cabin.seatBeltsMode', group: 'cabin.seatBelts', command: 'cabin.seatBelts.set', choices: automatic },
    { title: 'No mobile', field: 'cabin.noMobileMode', group: 'cabin.noMobile', command: 'cabin.noMobile.set', choices: automatic },
    { title: 'Emergency exit lights', field: 'cabin.emergencyExitMode', group: 'cabin.emergencyExit', command: 'cabin.emergencyExit.set', choices: [['OFF', 'off'], ['ARM', 'arm'], ['ON', 'on']] },
  ] },
  { id: 'air', title: 'Air conditioning & bleed', controls: [
    ['apuBleed', 'APU bleed'], ['engineBleed1', 'Engine 1 bleed'], ['engineBleed2', 'Engine 2 bleed'],
    ['engineBleed3', 'Engine 3 bleed'], ['engineBleed4', 'Engine 4 bleed'], ['pack1', 'Pack 1'], ['pack2', 'Pack 2'],
  ].map(([name, title]) => ({ title, field: `systems.${name}Mode`, group: `systems.${name}`, command: `systems.${name}.set`, choices: [['OFF', 'off'], ['ON', 'on']] })) },
];
const apuIndicators = [
  ['systems.apuMaster', 'Master', 'ON', 'OFF'],
  ['systems.apuStart', 'Start request', 'ON', 'OFF'],
  ['systems.apuAvailable', 'Availability', 'AVAIL', 'NOT AVAILABLE'],
  ['systems.apuMasterFault', 'Fault', 'FAULT', 'CLEAR'],
];
const sectionLinks = useAircraftPageSections([
  ...sections.map(section => ({ id: `a380-${section.id}`, label: section.title })),
  { id: 'a380-apu', label: 'APU' },
]);
function scrollToSection(id) {
  const target = document.getElementById(id);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target?.focus?.({ preventScroll: true });
}
function value(fieldId) {
  return props.sourceStatus === 'connected' && !unavailableFields.value.has(fieldId)
    && Object.hasOwn(props.values, fieldId) ? props.values[fieldId] : null;
}
function reason(control) {
  if (!props.controlsEnabled) return props.controlsDisabledReason || 'Aircraft controls unavailable.';
  if (props.isActionPending(control.group)) return 'Command pending.';
  if (props.sourceStatus !== 'connected') return 'Waiting for live aircraft data.';
  if (value(control.field) === null) return 'Live switch readback unavailable.';
  if (!props.isCommandSupported(control.command)) return props.controlSetupRequired
    ? 'Requires MobiFlight Event Module setup.' : 'Compatible aircraft controls unavailable.';
  return '';
}
function request(control, requestedValue) {
  if (reason(control)) return false;
  return props.requestCommand(control.command, control.group, { value: requestedValue });
}
function observed(control) {
  return control.choices.find(([, position]) => position === value(control.field))?.[0] || '--';
}
function apuMasterReason() {
  if (!props.controlsEnabled) return props.controlsDisabledReason || 'Aircraft controls unavailable.';
  if (props.isActionPending('systems.apuMaster')) return 'Command pending.';
  if (value('systems.apuMaster') === null) return 'Waiting for live APU data.';
  if (!props.actionCapabilities['systems.apuMaster.on'] || !props.actionCapabilities['systems.apuMaster.off']) return 'APU controls unavailable.';
  return '';
}
function requestMaster(on) {
  if (apuMasterReason()) return false;
  return props.requestAction(`systems.apuMaster.${on ? 'on' : 'off'}`, 'systems.apuMaster');
}
</script>

<template>
  <div class="space-y-5" data-aircraft-template="inibuilds-a380">
    <nav class="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-lg border border-border bg-panel p-2 sm:static"
      aria-label="iniBuilds A380 page sections" data-aircraft-section-ribbon data-mobile-aircraft-navigation="section-ribbon">
      <button v-for="section in sectionLinks" :key="section.id" type="button"
        class="min-h-11 shrink-0 rounded border border-border px-3 text-xs font-semibold text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        @click="scrollToSection(section.targetId || section.id)">{{ section.label }}</button>
    </nav>
    <section v-for="section in sections" :id="`a380-${section.id}`" :key="section.id" :aria-labelledby="`a380-${section.id}-title`"
      class="aircraft-mobile-navigable-section scroll-mt-20" tabindex="-1">
      <h3 :id="`a380-${section.id}-title`" class="dashboard-section-kicker">{{ section.title }}</h3>
      <IniBuildsA380FcuTargets v-if="section.id === 'guidance'" v-bind="props" :value="value" />
      <p v-if="section.id === 'air'" class="mb-2 text-xs text-muted-fg">Switch selections. Air supply depends on available sources.</p>
      <p v-if="section.id === 'surfaces'" class="mb-2 text-xs text-muted-fg">Lever selections. Surface travel depends on hydraulic power and aircraft conditions.</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div v-for="control in section.controls" :key="control.field"
          class="rounded-lg border border-border bg-card p-3"
          :data-aircraft-control-group="control.group">
          <div class="mb-2 flex items-center justify-between gap-2 text-xs">
            <span class="font-semibold text-fg">{{ control.title }}</span>
            <span class="font-mono text-muted-fg">{{ observed(control) }}</span>
          </div>
          <div class="flex gap-1.5">
            <button v-for="[label, position] in control.choices" :key="label" type="button"
              class="min-h-11 min-w-0 flex-1 rounded border px-2 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              :class="value(control.field) === position ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-panel text-fg hover:bg-card'"
              :aria-label="`${control.title} ${label}`"
              :aria-pressed="value(control.field) === position"
              :aria-describedby="reason(control) ? `a380-status-${control.field}` : undefined"
              :data-aircraft-command="control.command"
              :disabled="Boolean(reason(control))" @click="request(control, position)">
              {{ label }}
            </button>
          </div>
          <p v-if="reason(control)" :id="`a380-status-${control.field}`" class="mt-2 text-xs text-muted-fg">{{ reason(control) }}</p>
        </div>
      </div>
    </section>
    <section id="a380-apu" aria-labelledby="a380-apu-title" class="aircraft-mobile-navigable-section scroll-mt-20" tabindex="-1">
      <h3 id="a380-apu-title" class="dashboard-section-kicker">APU</h3>
      <div class="mb-2 rounded-lg border border-border bg-card p-3 sm:max-w-sm" data-aircraft-control-group="systems.apuMaster">
        <div class="mb-2 text-xs font-semibold text-fg">APU master</div>
        <div class="flex gap-1.5">
          <button v-for="[label, on] in binary" :key="label" type="button"
            class="min-h-11 flex-1 rounded border border-border bg-panel px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            :class="value('systems.apuMaster') === on ? 'border-primary text-primary' : 'text-fg'"
            :aria-label="`APU master ${label}`" :aria-pressed="value('systems.apuMaster') === on"
            :disabled="Boolean(apuMasterReason())" :aria-describedby="apuMasterReason() ? 'a380-apu-master-status' : undefined"
            @click="requestMaster(on)">{{ label }}</button>
        </div>
        <p v-if="apuMasterReason()" id="a380-apu-master-status" class="mt-2 text-xs text-muted-fg">{{ apuMasterReason() }}</p>
      </div>
      <dl class="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div v-for="[fieldId, label, on, off] in apuIndicators" :key="fieldId" class="rounded-lg border border-border bg-card p-3">
          <dt class="text-xs text-muted-fg">{{ label }}</dt>
          <dd class="mt-1 text-xs font-semibold" :class="fieldId === 'systems.apuMasterFault' && value(fieldId) === true ? 'text-warning' : 'text-fg'">
            {{ value(fieldId) === true ? on : value(fieldId) === false ? off : '--' }}
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>
