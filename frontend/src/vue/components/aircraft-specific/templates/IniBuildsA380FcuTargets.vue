<script setup>
import { reactive } from 'vue';
import { parseMcpDraftNumber, submitMcpDraft } from '../mcp-input.js';

const props = defineProps({
  value: { type: Function, required: true },
  controlsEnabled: Boolean, controlsDisabledReason: String,
  isActionPending: { type: Function, required: true },
  isCommandSupported: { type: Function, required: true },
  requestCommand: { type: Function, required: true },
  requestAction: { type: Function, required: true },
  actionCapabilities: { type: Object, required: true },
});
const drafts = reactive({});
const targets = [
  ['speed', 'Speed', 'kt', 100, 350, 1], ['heading', 'Heading', '°', 0, 359, 1],
  ['altitude', 'Altitude', 'ft', 100, 49000, 100], ['verticalSpeed', 'Vertical speed', 'ft/min', -6000, 6000, 100],
].map(([id, label, unit, min, max, step]) => ({ id, label, unit, min, max, step,
  fieldId: `flightGuidance.${id}Value`, commandId: `flightGuidance.${id}.set` }));
const group = 'flightGuidance.fcu';
const read = name => props.value(`flightGuidance.${name}`);
function baseReason() {
  if (!props.controlsEnabled) return props.controlsDisabledReason || 'Aircraft controls unavailable.';
  if (props.isActionPending(group)) return 'Command pending.';
  if (read('powered') !== true) return 'Waiting for powered FCU data.';
  return '';
}
function reason(target) {
  const base = baseReason(); if (base) return base;
  if (!props.isCommandSupported(target.commandId)) return 'Target control unavailable.';
  if (typeof props.value(target.fieldId) !== 'number') return 'Waiting for live target data.';
  if (target.id === 'speed' && (read('speedValue') < 100 || read('speedValue') > 350
    || read('speedDashed') !== false || read('speedManaged') !== false)) return 'Requires selected speed in knots.';
  if (['heading', 'verticalSpeed'].includes(target.id) && read('trackFpa') !== false) return 'Requires HDG / V/S mode.';
  if (target.id === 'heading' && (read('headingDashed') !== false || read('headingManaged') !== false)) return 'Requires selected heading.';
  if (target.id === 'verticalSpeed' && read('verticalSpeedDashed') !== false) return 'Show the V/S target before setting it.';
  return '';
}
function display(target) {
  if (reason(target) && !baseReason()) return '—';
  const current = props.value(target.fieldId);
  return typeof current === 'number' ? Math.floor(current).toLocaleString('en-US') : '—';
}
function submit(target) {
  if (reason(target)) return;
  const accepted = submitMcpDraft({ config: target, disabled: false, groupId: group,
    rawValue: drafts[target.id], requestCommand: props.requestCommand });
  if (accepted !== false) drafts[target.id] = '';
}
function revealReason() {
  return baseReason() || (read('trackFpa') !== false ? 'Requires HDG / V/S mode.' : '')
    || (!props.actionCapabilities['flightGuidance.verticalSpeed.reveal'] ? 'V/S control unavailable.' : '');
}
function reveal() {
  if (!revealReason()) props.requestAction('flightGuidance.verticalSpeed.reveal', group);
}
</script>

<template>
  <div class="mb-3" data-a380-fcu-targets>
    <p class="mb-2 text-xs text-muted-fg">FCU targets. Setting a value does not engage the autopilot or select a flight mode.</p>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <form v-for="target in targets" :key="target.id" class="rounded-lg border border-border bg-card p-3"
        :data-a380-target="target.id" :data-aircraft-control-group="group" @submit.prevent="submit(target)">
        <div class="mb-2 flex items-center justify-between gap-2 text-xs">
          <label :for="`a380-${target.id}-target`" class="font-semibold text-fg">{{ target.label }}</label>
          <span class="font-mono text-muted-fg">FCU {{ display(target) }} {{ target.unit }}</span>
        </div>
        <div class="flex gap-1.5">
          <input :id="`a380-${target.id}-target`" v-model="drafts[target.id]" type="number" inputmode="decimal"
            :min="target.min" :max="target.max" :step="target.step" :disabled="Boolean(reason(target))"
            :aria-label="`${target.label} target`" :aria-describedby="`a380-${target.id}-target-status`"
            class="min-h-11 w-full min-w-0 rounded border border-border bg-panel px-2 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
          <button type="submit" :aria-label="`Set ${target.label.toLowerCase()} target`" :data-aircraft-command="target.commandId"
            :disabled="Boolean(reason(target)) || parseMcpDraftNumber(drafts[target.id] ?? '', target) === null"
            class="min-h-11 rounded border border-border bg-panel px-3 text-xs font-semibold text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">Set</button>
        </div>
        <p :id="`a380-${target.id}-target-status`" class="mt-2 text-xs text-muted-fg">{{ reason(target) || `${target.min.toLocaleString('en-US')}–${target.max.toLocaleString('en-US')} ${target.unit}` }}</p>
        <button v-if="target.id === 'verticalSpeed' && read('verticalSpeedDashed') === true" type="button"
          :disabled="Boolean(revealReason())" @click="reveal"
          class="mt-2 min-h-11 rounded border border-border bg-panel px-3 text-xs text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">Show V/S target</button>
      </form>
    </div>
  </div>
</template>
