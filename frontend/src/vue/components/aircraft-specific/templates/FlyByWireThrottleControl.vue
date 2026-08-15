<script setup>
import { computed } from 'vue';
import {
  FBW_THROTTLE_DETENTS,
  formatFbwThrottleAngle,
  normalizeFbwThrottleAngle,
  triggerFbwThrottleHaptic,
} from '../../../aircraft-specific/flybywire-throttle-detents.js';

const props = defineProps({
  aircraftLabel: { type: String, required: true },
  leverPositions: { type: Array, default: () => [] },
  leverLabels: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  controlEnabled: { type: Boolean, default: false },
  setupRequired: { type: Boolean, default: false },
  actionCapabilities: { type: Object, default: () => ({}) },
  pending: { type: Boolean, default: false },
  requestAction: { type: Function, default: () => false },
});

const normalizedPositions = computed(() => (
  props.leverPositions.map((value) => normalizeFbwThrottleAngle(value))
));
const allReadbacksAvailable = computed(() => (
  normalizedPositions.value.length >= 2
  && normalizedPositions.value.every((value) => value !== null)
));
const controlsReady = computed(() => (
  props.sourceStatus === 'connected'
  && props.controlEnabled
  && allReadbacksAvailable.value
  && !props.pending
));
const currentDetent = computed(() => {
  if (!allReadbacksAvailable.value) return null;
  const [first, ...rest] = normalizedPositions.value;
  if (!rest.every((value) => Object.is(value, first))) return null;
  return FBW_THROTTLE_DETENTS.find((detent) => Object.is(detent.angle, first)) || null;
});
const leversSplit = computed(() => {
  if (!allReadbacksAvailable.value) return false;
  const [first, ...rest] = normalizedPositions.value;
  return rest.some((value) => !Object.is(value, first));
});
const leverCountLabel = computed(() => (
  props.leverPositions.length === 2 ? 'both levers' : `all ${props.leverPositions.length} levers`
));

function actionSupported(detent) {
  return props.actionCapabilities[detent.actionId] === true;
}

function detentDisabled(detent) {
  return !controlsReady.value || !actionSupported(detent);
}

function commit(detent) {
  if (!detent || detentDisabled(detent)) return false;
  const accepted = props.requestAction(detent.actionId) !== false;
  if (accepted) triggerFbwThrottleHaptic();
  return accepted;
}

function buttonClass(detent) {
  if (currentDetent.value?.id === detent.id) {
    return 'border-emerald-400/70 bg-emerald-400/15 text-emerald-50';
  }
  return 'border-surface-300 bg-surface-100 text-gray-200 hover:border-cyan-400/50 hover:bg-surface-200';
}

function leverLabel(index) {
  return props.leverLabels[index] || `ENG ${index + 1}`;
}

const statusText = computed(() => {
  if (props.pending) return `Command sent. Confirming ${leverCountLabel.value} independently\u2026`;
  if (props.sourceStatus !== 'connected') return `Waiting for live ${props.aircraftLabel} throttle data.`;
  if (!props.controlEnabled) return 'Aircraft control is unavailable in this browser session.';
  if (!allReadbacksAvailable.value) return `Fresh readback from ${leverCountLabel.value} is required.`;
  if (props.setupRequired) return 'MobiFlight Event Module setup is required for calibrated throttle detents.';
  if (!FBW_THROTTLE_DETENTS.some(actionSupported)) return 'Compatible calibrated throttle transport unavailable.';
  if (leversSplit.value) return `Levers are split. Choose a detent to align ${leverCountLabel.value}.`;
  return `Tap one large detent to set ${leverCountLabel.value} together.`;
});
</script>

<template>
  <section
    class="rounded-xl border border-cyan-500/30 bg-cyan-500/[0.045] p-3 sm:p-4"
    data-fbw-section="virtual-throttle"
    data-aircraft-control-group="propulsion.throttle"
    :data-throttle-lever-count="leverPositions.length"
  >
    <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="dashboard-section-kicker">Virtual throttle</div>
        <h4 class="mt-1 text-sm font-semibold text-gray-100">{{ leverCountLabel }} &middot; calibrated forward detents</h4>
      </div>
      <div class="flex max-w-full flex-wrap justify-end gap-2 text-right font-mono text-[10px] tabular-nums">
        <span
          v-for="(position, index) in leverPositions"
          :key="index"
          class="rounded-md border border-surface-300 bg-surface-100 px-2 py-1 text-gray-300"
          :data-fbw-throttle-lever="index + 1"
        >{{ leverLabel(index) }} {{ formatFbwThrottleAngle(position) }}</span>
      </div>
    </div>

    <div
      class="grid grid-cols-1 gap-2 sm:grid-cols-2"
      role="group"
      :aria-label="`${aircraftLabel} virtual throttle detents`"
    >
      <button
        v-for="detent in FBW_THROTTLE_DETENTS"
        :key="detent.id"
        type="button"
        class="fbw-throttle-button min-h-[84px] rounded-xl border px-5 py-3 text-left transition duration-100 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-[76px]"
        :class="buttonClass(detent)"
        :data-aircraft-action="detent.actionId"
        :data-fbw-throttle-detent="detent.id"
        :aria-label="`Set ${leverCountLabel} on ${aircraftLabel} to ${detent.label}`"
        :aria-pressed="currentDetent?.id === detent.id"
        :aria-busy="pending ? 'true' : 'false'"
        aria-describedby="fbw-throttle-status"
        :disabled="detentDisabled(detent)"
        @click="commit(detent)"
      >
        <span class="flex items-center justify-between gap-4">
          <span class="text-lg font-bold tracking-wide">{{ detent.label }}</span>
          <span class="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            {{ currentDetent?.id === detent.id ? 'Live' : `Set ${leverPositions.length}` }}
          </span>
        </span>
      </button>
    </div>

    <p
      id="fbw-throttle-status"
      class="mt-3 text-[11px] leading-relaxed"
      :class="leversSplit ? 'text-amber-300' : 'text-gray-400'"
      role="status"
      aria-live="polite"
    >{{ statusText }}</p>
    <p class="mt-1 text-[10px] leading-relaxed text-gray-500">
      Each tap uses this aircraft's saved calibration, then verifies every lever independently. Reverse thrust and arbitrary axis positions are intentionally unavailable.
    </p>
  </section>
</template>

<style scoped>
.fbw-throttle-button {
  touch-action: none;
}
</style>
