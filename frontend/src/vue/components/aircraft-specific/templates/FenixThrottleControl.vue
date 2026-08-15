<script setup>
import { computed } from 'vue';
import {
  FENIX_THROTTLE_DETENTS,
  formatFenixThrottlePosition,
  normalizeFenixThrottlePosition,
  triggerFenixThrottleHaptic,
} from '../../../aircraft-specific/paired-throttle-detents.js';

const props = defineProps({
  leftPosition: { type: [Number, String], default: null },
  rightPosition: { type: [Number, String], default: null },
  sourceStatus: { type: String, default: 'awaiting-values' },
  controlEnabled: { type: Boolean, default: false },
  actionCapabilities: { type: Object, default: () => ({}) },
  pending: { type: Boolean, default: false },
  requestAction: { type: Function, default: () => false },
});

const leftAvailable = computed(() => normalizeFenixThrottlePosition(props.leftPosition) !== null);
const rightAvailable = computed(() => normalizeFenixThrottlePosition(props.rightPosition) !== null);
const bothReadbacksAvailable = computed(() => leftAvailable.value && rightAvailable.value);
const controlsReady = computed(() => (
  props.sourceStatus === 'connected'
  && props.controlEnabled
  && bothReadbacksAvailable.value
  && !props.pending
));
const currentDetent = computed(() => {
  const left = normalizeFenixThrottlePosition(props.leftPosition);
  const right = normalizeFenixThrottlePosition(props.rightPosition);
  if (left === null || right === null || !Object.is(left, right)) return null;
  return FENIX_THROTTLE_DETENTS.find((detent) => Object.is(detent.value, left)) || null;
});
const leversSplit = computed(() => (
  bothReadbacksAvailable.value
  && !Object.is(
    normalizeFenixThrottlePosition(props.leftPosition),
    normalizeFenixThrottlePosition(props.rightPosition),
  )
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
  if (accepted) triggerFenixThrottleHaptic();
  return accepted;
}

function buttonClass(detent) {
  if (currentDetent.value?.id === detent.id) {
    return 'border-emerald-400/70 bg-emerald-400/15 text-emerald-50';
  }
  return 'border-surface-300 bg-surface-100 text-gray-200 hover:border-cyan-400/50 hover:bg-surface-200';
}

const statusText = computed(() => {
  if (props.pending) return 'Command sent. Confirming both Fenix throttle levers…';
  if (props.sourceStatus !== 'connected') return 'Waiting for live Fenix throttle data.';
  if (!props.controlEnabled) return 'Aircraft control is unavailable in this browser session.';
  if (!bothReadbacksAvailable.value) return 'Both live throttle-lever readbacks are required.';
  if (!FENIX_THROTTLE_DETENTS.some(actionSupported)) return 'Compatible throttle write transport unavailable.';
  if (leversSplit.value) return 'Levers are split. Choose a detent to align both together.';
  return 'Tap one large detent to set both levers together.';
});
</script>

<template>
  <section
    class="rounded-xl border border-cyan-500/30 bg-cyan-500/[0.045] p-3 sm:p-4"
    data-fenix-section="virtual-throttle"
    data-aircraft-control-group="propulsion.throttle"
  >
    <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="dashboard-section-kicker">Virtual throttle</div>
        <h4 class="mt-1 text-sm font-semibold text-gray-100">Both levers · forward detents</h4>
      </div>
      <div class="grid grid-cols-2 gap-2 text-right font-mono text-[10px] tabular-nums">
        <span class="rounded-md border border-surface-300 bg-surface-100 px-2 py-1 text-gray-300">L {{ formatFenixThrottlePosition(leftPosition) }}</span>
        <span class="rounded-md border border-surface-300 bg-surface-100 px-2 py-1 text-gray-300">R {{ formatFenixThrottlePosition(rightPosition) }}</span>
      </div>
    </div>

    <div
      class="grid grid-cols-1 gap-2 sm:grid-cols-2"
      role="group"
      aria-label="Fenix virtual throttle detents"
    >
      <button
        v-for="detent in FENIX_THROTTLE_DETENTS"
        :key="detent.id"
        type="button"
        class="fenix-throttle-button min-h-[84px] rounded-xl border px-5 py-3 text-left transition duration-100 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-[76px]"
        :class="buttonClass(detent)"
        :data-aircraft-action="detent.actionId"
        :data-fenix-throttle-detent="detent.id"
        :aria-label="`Set both Fenix throttle levers to ${detent.label}`"
        :aria-pressed="currentDetent?.id === detent.id"
        :aria-busy="pending ? 'true' : 'false'"
        aria-describedby="fenix-throttle-status"
        :disabled="detentDisabled(detent)"
        @click="commit(detent)"
      >
        <span class="flex items-center justify-between gap-4">
          <span class="text-lg font-bold tracking-wide">{{ detent.label }}</span>
          <span class="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            {{ currentDetent?.id === detent.id ? 'Live' : 'Set both' }}
          </span>
        </span>
      </button>
    </div>

    <p
      id="fenix-throttle-status"
      class="mt-3 text-[11px] leading-relaxed"
      :class="leversSplit ? 'text-amber-300' : 'text-gray-400'"
      role="status"
      aria-live="polite"
    >{{ statusText }}</p>
    <p class="mt-1 text-[10px] leading-relaxed text-gray-500">
      Each tap sends one fixed detent command and verifies the left and right levers independently. Reverse thrust and arbitrary axis positions are intentionally unavailable.
    </p>
  </section>
</template>

<style scoped>
.fenix-throttle-button {
  touch-action: none;
}
</style>
