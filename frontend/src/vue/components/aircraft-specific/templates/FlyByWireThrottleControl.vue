<script>
export const FBW_THROTTLE_DETENTS = Object.freeze([
  Object.freeze({ id: 'toga', label: 'TOGA', engraving: 'TO GA', angle: 45, actionId: 'propulsion.throttle.toga' }),
  Object.freeze({ id: 'flexMct', label: 'FLX / MCT', engraving: 'FLX MCT', angle: 35, actionId: 'propulsion.throttle.flexMct' }),
  Object.freeze({ id: 'climb', label: 'CLB', engraving: 'CL', angle: 25, actionId: 'propulsion.throttle.climb' }),
  Object.freeze({ id: 'idle', label: 'IDLE', engraving: 'IDLE', angle: 0, actionId: 'propulsion.throttle.idle' }),
]);

// Reverse readback angles reported by the FlyByWire throttle lever axis. They
// are drawn in the locked reverse zone of the quadrant but never commanded.
export const FBW_THROTTLE_REVERSE = Object.freeze({ idle: -6, full: -20 });

export function normalizeFbwThrottleAngle(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatFbwThrottleAngle(value) {
  const numeric = normalizeFbwThrottleAngle(value);
  if (numeric === null) return '--';
  const detent = FBW_THROTTLE_DETENTS.find((candidate) => Object.is(candidate.angle, numeric));
  if (detent) return detent.label;
  if (Object.is(numeric, FBW_THROTTLE_REVERSE.idle)) return 'REV IDLE';
  if (Object.is(numeric, FBW_THROTTLE_REVERSE.full)) return 'FULL REV';
  return `BETWEEN (${Number(numeric.toFixed(2))}°)`;
}

export function triggerFbwThrottleHaptic(navigatorRef = globalThis.navigator) {
  if (typeof navigatorRef?.vibrate !== 'function') return false;
  try {
    return navigatorRef.vibrate(12) === true;
  } catch {
    return false;
  }
}
</script>

<script setup>
import { computed } from 'vue';
import AirbusThrottleQuadrant from './AirbusThrottleQuadrant.vue';
import {
  buildThrottleQuadrantAnchors,
  throttleKnobGlyph,
  throttleQuadrantTravelPercent,
} from '../../../aircraft-specific/throttle-quadrant-geometry.js';

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

const QUADRANT_ANCHORS = buildThrottleQuadrantAnchors(FBW_THROTTLE_DETENTS, {
  rawKey: 'angle',
  reverse: FBW_THROTTLE_REVERSE,
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
const heading = computed(() => `${leverCountLabel.value} · calibrated forward detents`);

function leverLabel(index) {
  return props.leverLabels[index] || `ENG ${index + 1}`;
}

function leverState(angle) {
  if (angle === null) return 'missing';
  if (FBW_THROTTLE_DETENTS.some((detent) => Object.is(detent.angle, angle))) return 'detent';
  if (angle < FBW_THROTTLE_DETENTS[FBW_THROTTLE_DETENTS.length - 1].angle) return 'reverse';
  return 'between';
}

const levers = computed(() => normalizedPositions.value.map((angle, index) => ({
  label: leverLabel(index),
  glyph: throttleKnobGlyph(leverLabel(index), index),
  text: formatFbwThrottleAngle(props.leverPositions[index]),
  travelPercent: throttleQuadrantTravelPercent(angle, QUADRANT_ANCHORS, FBW_THROTTLE_DETENTS.length),
  state: leverState(angle),
})));

function actionSupported(detent) {
  return props.actionCapabilities[detent.actionId] === true;
}

function detentDisabled(detent) {
  return !controlsReady.value || !actionSupported(detent);
}

function requestDetent(detent) {
  if (!detent || detentDisabled(detent)) return false;
  const accepted = props.requestAction(detent.actionId) !== false;
  if (accepted) triggerFbwThrottleHaptic();
  return accepted;
}

const statusText = computed(() => {
  if (props.pending) return `Command sent. Confirming ${leverCountLabel.value} independently…`;
  if (props.sourceStatus !== 'connected') return `Waiting for live ${props.aircraftLabel} throttle data.`;
  if (!props.controlEnabled) return 'Aircraft control is unavailable in this browser session.';
  if (!allReadbacksAvailable.value) return `Fresh readback from ${leverCountLabel.value} is required.`;
  if (props.setupRequired) return 'MobiFlight Event Module setup is required for calibrated throttle detents.';
  if (!FBW_THROTTLE_DETENTS.some(actionSupported)) return 'Compatible calibrated throttle transport unavailable.';
  if (leversSplit.value) return `Levers are split. Tap a gate to align ${leverCountLabel.value}.`;
  return `Tap a gate to move ${leverCountLabel.value} together.`;
});

const footnote = 'Each tap uses this aircraft’s saved calibration, then verifies every lever independently. Reverse thrust and positions between gates are intentionally unavailable.';
</script>

<template>
  <AirbusThrottleQuadrant
    vendor="fbw"
    :aircraft-label="aircraftLabel"
    :heading="heading"
    :lever-count-label="leverCountLabel"
    :detents="FBW_THROTTLE_DETENTS"
    :levers="levers"
    :current-detent-id="currentDetent?.id || null"
    :levers-split="leversSplit"
    :pending="pending"
    :detent-disabled="detentDisabled"
    :request-detent="requestDetent"
    :status-text="statusText"
    :footnote="footnote"
  />
</template>
