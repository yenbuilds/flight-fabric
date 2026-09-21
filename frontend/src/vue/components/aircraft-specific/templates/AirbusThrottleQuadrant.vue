<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  THROTTLE_FORWARD_ROW_UNITS,
  THROTTLE_REVERSE_ROW_UNITS,
} from '../../../aircraft-specific/throttle-quadrant-geometry.js';

// Presentational Airbus-style thrust-lever quadrant. It draws a pedestal with
// one gate row per forward detent (TO GA at the top, IDLE at the bottom), a
// locked reverse zone underneath, and one lever knob per engine placed at its
// live readback position. Every gate row is a plain one-tap button; there is
// no axis, no pointer tracking and nothing to pull. The aircraft-specific
// wrappers own the readback maths and the command dispatch.

const props = defineProps({
  vendor: { type: String, required: true },
  aircraftLabel: { type: String, required: true },
  heading: { type: String, required: true },
  leverCountLabel: { type: String, required: true },
  detents: { type: Array, required: true },
  levers: { type: Array, default: () => [] },
  currentDetentId: { type: String, default: null },
  leversSplit: { type: Boolean, default: false },
  pending: { type: Boolean, default: false },
  detentDisabled: { type: Function, default: () => true },
  requestDetent: { type: Function, default: () => false },
  statusText: { type: String, default: '' },
  footnote: { type: String, default: '' },
});

const sectionAttr = computed(() => `data-${props.vendor}-section`);
const detentAttr = computed(() => `data-${props.vendor}-throttle-detent`);
const leverAttr = computed(() => `data-${props.vendor}-throttle-lever`);
const statusId = computed(() => `${props.vendor}-throttle-status`);

const pendingDetentId = ref(null);
let pendingClearTimer = null;

function clearPendingTarget() {
  if (pendingClearTimer) {
    clearTimeout(pendingClearTimer);
    pendingClearTimer = null;
  }
  pendingDetentId.value = null;
}

watch(() => props.pending, (isPending) => {
  if (!isPending) clearPendingTarget();
});

onBeforeUnmount(clearPendingTarget);

function commit(detent) {
  if (!detent || props.detentDisabled(detent)) return false;
  const accepted = props.requestDetent(detent) === true;
  if (!accepted) return false;
  pendingDetentId.value = detent.id;
  if (pendingClearTimer) clearTimeout(pendingClearTimer);
  // Safety net: if the command never reaches a pending state (rejected before
  // dispatch, or already verified), the target highlight must not stick.
  pendingClearTimer = setTimeout(() => {
    if (!props.pending) clearPendingTarget();
  }, 1500);
  return true;
}

function isLive(detent) {
  return props.currentDetentId === detent.id;
}

function isTarget(detent) {
  return props.pending && pendingDetentId.value === detent.id;
}

function gateTag(detent) {
  if (isTarget(detent)) return 'Sending';
  if (isLive(detent)) return 'Live';
  return `Set ${props.levers.length}`;
}

function gateClass(detent) {
  return {
    'is-live': isLive(detent),
    'is-target': isTarget(detent),
  };
}

const trackStyle = computed(() => ({
  gridTemplateRows: `repeat(${props.detents.length}, var(--ff-throttle-row)) calc(var(--ff-throttle-row) * ${THROTTLE_REVERSE_ROW_UNITS / THROTTLE_FORWARD_ROW_UNITS})`,
}));

const quadrantStyle = computed(() => ({
  '--ff-throttle-knob-w': props.levers.length > 2 ? '2.25rem' : '2.9rem',
}));

const idleTravelPercent = computed(() => {
  const idleIndex = Math.max(0, props.detents.length - 1);
  const totalUnits = props.detents.length * THROTTLE_FORWARD_ROW_UNITS + THROTTLE_REVERSE_ROW_UNITS;
  const idleUnits = idleIndex * THROTTLE_FORWARD_ROW_UNITS + THROTTLE_FORWARD_ROW_UNITS / 2;
  return Number(((idleUnits / totalUnits) * 100).toFixed(3));
});

function knobStyle(lever) {
  // No readback yet: park a ghost knob on the idle gate so the quadrant still
  // reads as a throttle rather than an empty slot.
  const percent = typeof lever.travelPercent === 'number' ? lever.travelPercent : idleTravelPercent.value;
  return { top: `${percent}%` };
}

function leverState(lever) {
  return lever.state || 'missing';
}

function readoutClass(lever) {
  switch (leverState(lever)) {
    case 'detent': return 'is-detent';
    case 'between': return 'is-between';
    case 'reverse': return 'is-reverse';
    default: return 'is-missing';
  }
}
</script>

<template>
  <section
    class="airbus-throttle rounded-xl border border-cyan-500/30 bg-cyan-500/[0.045] p-3 sm:p-4"
    :[sectionAttr]="'virtual-throttle'"
    data-aircraft-control-group="propulsion.throttle"
    :data-throttle-lever-count="levers.length"
    :data-throttle-split="leversSplit ? 'true' : 'false'"
  >
    <div class="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div class="min-w-0">
        <div class="dashboard-section-kicker">Virtual throttle</div>
        <h4 class="mt-1 text-sm font-semibold text-gray-100">{{ heading }}</h4>
      </div>
      <div class="airbus-throttle-readouts flex max-w-full flex-wrap justify-end gap-1.5 font-mono text-[10px] tabular-nums" aria-label="Live lever readback">
        <span
          v-for="(lever, index) in levers"
          :key="index"
          class="airbus-throttle-readout"
          :class="readoutClass(lever)"
          :[leverAttr]="index + 1"
          :data-lever-state="leverState(lever)"
        >{{ lever.label }} {{ lever.text }}</span>
      </div>
    </div>

    <div class="airbus-throttle-quadrant" :style="quadrantStyle">
      <div class="airbus-throttle-pedestal" :data-pending="pending ? 'true' : 'false'">
        <span class="airbus-throttle-screw is-tl" aria-hidden="true"></span>
        <span class="airbus-throttle-screw is-tr" aria-hidden="true"></span>
        <span class="airbus-throttle-screw is-bl" aria-hidden="true"></span>
        <span class="airbus-throttle-screw is-br" aria-hidden="true"></span>

        <div class="airbus-throttle-track">
          <div
            class="airbus-throttle-rows"
            :style="trackStyle"
            role="group"
            :aria-label="`${aircraftLabel} virtual throttle detents`"
          >
            <button
              v-for="detent in detents"
              :key="detent.id"
              type="button"
              class="airbus-throttle-detent min-h-[84px]"
              :class="gateClass(detent)"
              :data-aircraft-action="detent.actionId"
              :[detentAttr]="detent.id"
              :aria-label="`Set ${leverCountLabel} on ${aircraftLabel} to ${detent.label}`"
              :aria-pressed="isLive(detent)"
              :aria-busy="pending ? 'true' : 'false'"
              :aria-describedby="statusId"
              :disabled="detentDisabled(detent)"
              @click="commit(detent)"
            >
              <span class="airbus-throttle-plate">
                <span class="airbus-throttle-engraving">{{ detent.engraving || detent.label }}</span>
                <span class="airbus-throttle-tag">{{ gateTag(detent) }}</span>
              </span>
              <span class="airbus-throttle-gate" aria-hidden="true">
                <span class="airbus-throttle-gate-line"></span>
              </span>
            </button>

            <div class="airbus-throttle-reverse" aria-hidden="true">
              <span class="airbus-throttle-plate">
                <span class="airbus-throttle-engraving is-reverse">REV</span>
                <span class="airbus-throttle-tag">Locked</span>
              </span>
              <span class="airbus-throttle-gate is-reverse">
                <span class="airbus-throttle-gate-line"></span>
              </span>
            </div>
          </div>

          <div class="airbus-throttle-levers" aria-hidden="true">
            <div
              v-for="(lever, index) in levers"
              :key="index"
              class="airbus-throttle-channel"
              :data-lever-state="leverState(lever)"
            >
              <span class="airbus-throttle-stem" :style="knobStyle(lever)"></span>
              <span class="airbus-throttle-knob" :style="knobStyle(lever)">
                <span class="airbus-throttle-knob-grip"></span>
                <span class="airbus-throttle-knob-glyph">{{ lever.glyph }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p
      :id="statusId"
      class="mt-3 text-[11px] leading-relaxed"
      :class="leversSplit ? 'text-amber-300' : 'text-gray-400'"
      role="status"
      aria-live="polite"
    >{{ statusText }}</p>
    <p v-if="footnote" class="mt-1 text-[10px] leading-relaxed text-gray-500">{{ footnote }}</p>
  </section>
</template>

<style scoped>
.airbus-throttle {
  --ff-throttle-row: 84px;
  --ff-throttle-plate-w: clamp(6.5rem, 36%, 10rem);
  --ff-throttle-knob-w: 2.9rem;
  --ff-throttle-knob-h: 2.1rem;
  --ff-throttle-metal-hi: #4a5058;
  --ff-throttle-metal: #2b3037;
  --ff-throttle-metal-lo: #1a1d22;
  --ff-throttle-slot: #07090c;
  --ff-throttle-engrave: #cfd5dc;
  --ff-throttle-live: 52 211 153;
  --ff-throttle-target: 34 211 238;
  --ff-throttle-split: 251 191 36;
}

.airbus-throttle-quadrant {
  max-width: 42rem;
}

/* Four-engine quadrants give the slot column a little more room on phones. */
.airbus-throttle:not([data-throttle-lever-count='2']) {
  --ff-throttle-plate-w: clamp(6rem, 33%, 10rem);
}
.airbus-throttle:not([data-throttle-lever-count='2']) .airbus-throttle-levers {
  padding: 0 0.3rem;
}

.airbus-throttle-pedestal {
  position: relative;
  padding: 0.85rem 0.6rem;
  border-radius: 1rem;
  background:
    radial-gradient(120% 90% at 50% 0%, rgba(255, 255, 255, 0.05), transparent 60%),
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.012) 0 2px, transparent 2px 4px),
    linear-gradient(180deg, var(--ff-throttle-metal), var(--ff-throttle-metal-lo));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.6),
    inset 0 0 0 1px rgba(0, 0, 0, 0.45),
    0 18px 30px -18px rgba(0, 0, 0, 0.8);
}

.airbus-throttle-screw {
  position: absolute;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: radial-gradient(circle at 35% 35%, #6b727b, #23272c 70%);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.6), 0 1px 0 rgba(255, 255, 255, 0.06);
}
.airbus-throttle-screw::after {
  content: '';
  position: absolute;
  inset: 45% 20%;
  height: 1px;
  background: rgba(0, 0, 0, 0.7);
  transform: rotate(35deg);
}
.airbus-throttle-screw.is-tl { top: 0.35rem; left: 0.35rem; }
.airbus-throttle-screw.is-tr { top: 0.35rem; right: 0.35rem; }
.airbus-throttle-screw.is-bl { bottom: 0.35rem; left: 0.35rem; }
.airbus-throttle-screw.is-br { bottom: 0.35rem; right: 0.35rem; }

.airbus-throttle-track {
  position: relative;
}

.airbus-throttle-rows {
  display: grid;
  gap: 0;
  border-radius: 0.75rem;
  overflow: hidden;
  background: linear-gradient(180deg, var(--ff-throttle-metal-hi), var(--ff-throttle-metal) 55%, var(--ff-throttle-metal-lo));
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.55), inset 0 2px 6px rgba(0, 0, 0, 0.45);
}

.airbus-throttle-detent,
.airbus-throttle-reverse {
  display: grid;
  grid-template-columns: var(--ff-throttle-plate-w) 1fr;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.55);
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
}

.airbus-throttle-detent {
  touch-action: none;
  cursor: pointer;
  transition: background-color 120ms ease;
  -webkit-tap-highlight-color: transparent;
}
.airbus-throttle-detent:hover:not(:disabled) {
  background: rgba(var(--ff-throttle-target) / 0.06);
}
.airbus-throttle-detent:active:not(:disabled) .airbus-throttle-plate {
  transform: translateY(1px);
}
.airbus-throttle-detent:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.airbus-throttle-detent:focus-visible {
  outline: 2px solid rgb(var(--ff-throttle-target) / 0.7);
  outline-offset: -3px;
}
.airbus-throttle-detent.is-live {
  background: rgba(var(--ff-throttle-live) / 0.08);
}
.airbus-throttle-detent.is-target {
  background: rgba(var(--ff-throttle-target) / 0.1);
}

.airbus-throttle-plate {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.2rem;
  min-width: 0;
  padding: 0.5rem 0.5rem 0.5rem 0.85rem;
  border-right: 1px solid rgba(0, 0, 0, 0.6);
  box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.05);
  transition: transform 80ms ease;
}

.airbus-throttle-engraving {
  font-family: 'Avenir Next Condensed', 'Segoe UI Variable Display', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  font-size: clamp(0.95rem, 4.6vw, 1.3rem);
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.06em;
  color: var(--ff-throttle-engrave);
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.08), 0 -1px 0 rgba(0, 0, 0, 0.75);
  white-space: nowrap;
}
.is-live .airbus-throttle-engraving {
  color: rgb(var(--ff-throttle-live));
  text-shadow: 0 0 10px rgba(var(--ff-throttle-live) / 0.5), 0 -1px 0 rgba(0, 0, 0, 0.75);
}
.is-target .airbus-throttle-engraving {
  color: rgb(var(--ff-throttle-target));
}
.airbus-throttle-engraving.is-reverse {
  color: #7d8590;
}

.airbus-throttle-tag {
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #8a939e;
}
.is-live .airbus-throttle-tag { color: rgb(var(--ff-throttle-live) / 0.9); }
.is-target .airbus-throttle-tag { color: rgb(var(--ff-throttle-target)); }

/* Gate notch: a horizontal bar across the lever slot at the detent's centre. */
.airbus-throttle-gate {
  position: relative;
  display: block;
  min-width: 0;
}
.airbus-throttle-gate-line {
  position: absolute;
  left: 0.55rem;
  right: 0.55rem;
  top: 50%;
  height: 3px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0.55));
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08);
}
.airbus-throttle-gate-line::before {
  content: '';
  position: absolute;
  left: -0.45rem;
  top: 50%;
  border: 0.3rem solid transparent;
  border-left-color: rgba(207, 213, 220, 0.55);
  transform: translateY(-50%);
}
.is-live .airbus-throttle-gate-line {
  background: rgb(var(--ff-throttle-live));
  box-shadow: 0 0 10px rgba(var(--ff-throttle-live) / 0.55);
}
.is-live .airbus-throttle-gate-line::before {
  border-left-color: rgb(var(--ff-throttle-live));
}
.is-target .airbus-throttle-gate-line {
  background: rgb(var(--ff-throttle-target));
  box-shadow: 0 0 10px rgba(var(--ff-throttle-target) / 0.55);
  animation: airbus-throttle-pulse 900ms ease-in-out infinite;
}
.is-target .airbus-throttle-gate-line::before {
  border-left-color: rgb(var(--ff-throttle-target));
}
.airbus-throttle-gate.is-reverse .airbus-throttle-gate-line {
  height: 0;
  border-top: 2px dashed rgba(125, 133, 144, 0.45);
  background: none;
  box-shadow: none;
}
.airbus-throttle-gate.is-reverse .airbus-throttle-gate-line::before {
  display: none;
}

.airbus-throttle-reverse {
  border-bottom: 0;
  background:
    repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.045) 0 6px, transparent 6px 16px),
    rgba(0, 0, 0, 0.35);
}
.airbus-throttle-reverse .airbus-throttle-plate {
  gap: 0.1rem;
}
.airbus-throttle-reverse .airbus-throttle-engraving {
  font-size: 0.95rem;
}

/* Lever overlay: one channel per engine over the slot column. Pointer events
   pass straight through to the gate buttons underneath. */
.airbus-throttle-levers {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  left: var(--ff-throttle-plate-w);
  display: flex;
  padding: 0 0.55rem;
  pointer-events: none;
}
.airbus-throttle-channel {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
}
.airbus-throttle-channel::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0.8rem;
  bottom: 0.8rem;
  width: 0.55rem;
  transform: translateX(-50%);
  border-radius: 999px;
  background: var(--ff-throttle-slot);
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.9),
    0 1px 0 rgba(255, 255, 255, 0.07);
}

.airbus-throttle-knob {
  position: absolute;
  left: 50%;
  top: 0;
  /* Never wider than the channel, so four knobs stay apart on a 320px phone. */
  width: min(var(--ff-throttle-knob-w), calc(100% - 0.3rem));
  height: var(--ff-throttle-knob-h);
  transform: translate(-50%, -50%);
  border-radius: 0.55rem;
  background:
    linear-gradient(180deg, #9aa1ab 0%, #6e7681 45%, #4b525b 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -2px 0 rgba(0, 0, 0, 0.45),
    0 6px 10px -3px rgba(0, 0, 0, 0.85),
    0 0 0 1px rgba(0, 0, 0, 0.6);
  transition: top 420ms cubic-bezier(0.22, 0.9, 0.3, 1), opacity 200ms ease, box-shadow 200ms ease;
}
.airbus-throttle-stem {
  /* stem from the knob down into the slot; drawn before the knob so it sits
     behind it */
  position: absolute;
  left: 50%;
  top: 0;
  width: 0.42rem;
  height: 1.6rem;
  transform: translateX(-50%);
  border-radius: 0 0 999px 999px;
  background: linear-gradient(180deg, #3a4048, #101317);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.7);
  transition: top 420ms cubic-bezier(0.22, 0.9, 0.3, 1);
}
.airbus-throttle-knob-grip {
  position: absolute;
  left: 0.45rem;
  right: 0.45rem;
  top: 0.35rem;
  height: 0.35rem;
  border-radius: 999px;
  background:
    repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.35) 0 2px, transparent 2px 5px);
  opacity: 0.8;
}
.airbus-throttle-knob-glyph {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0.2rem;
  text-align: center;
  font-family: ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Menlo, monospace;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.05em;
  color: #0f1216;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.3);
}

.airbus-throttle-channel[data-lever-state='missing'] .airbus-throttle-knob {
  opacity: 0.32;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.airbus-throttle-channel[data-lever-state='missing'] .airbus-throttle-stem {
  display: none;
}
.airbus-throttle-channel[data-lever-state='detent'] .airbus-throttle-knob {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -2px 0 rgba(0, 0, 0, 0.45),
    0 6px 10px -3px rgba(0, 0, 0, 0.85),
    0 0 0 1px rgba(0, 0, 0, 0.6),
    0 0 12px rgba(var(--ff-throttle-live) / 0.35);
}
.airbus-throttle[data-throttle-split='true'] .airbus-throttle-channel .airbus-throttle-knob {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -2px 0 rgba(0, 0, 0, 0.45),
    0 6px 10px -3px rgba(0, 0, 0, 0.85),
    0 0 0 1px rgba(var(--ff-throttle-split) / 0.8),
    0 0 12px rgba(var(--ff-throttle-split) / 0.35);
}
.airbus-throttle-channel[data-lever-state='reverse'] .airbus-throttle-knob {
  background: linear-gradient(180deg, #8c8f94 0%, #5c6169 45%, #3f444b 100%);
}

/* Readout chips: small LCD-style readback per lever. */
.airbus-throttle-readout {
  padding: 0.2rem 0.5rem;
  border-radius: 0.375rem;
  border: 1px solid rgba(0, 0, 0, 0.65);
  background: linear-gradient(180deg, #0b0f12, #06090b);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.9), 0 1px 0 rgba(255, 255, 255, 0.05);
  color: #8a939e;
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.airbus-throttle-readout.is-detent { color: rgb(var(--ff-throttle-live)); text-shadow: 0 0 6px rgba(var(--ff-throttle-live) / 0.5); }
.airbus-throttle-readout.is-between { color: rgb(var(--ff-throttle-split)); }
.airbus-throttle-readout.is-reverse { color: #c8cfd8; }

@keyframes airbus-throttle-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@media (min-width: 640px) {
  .airbus-throttle-pedestal {
    padding: 1rem 0.9rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .airbus-throttle-knob,
  .airbus-throttle-stem {
    transition: none;
  }
  .is-target .airbus-throttle-gate-line {
    animation: none;
  }
}
</style>
