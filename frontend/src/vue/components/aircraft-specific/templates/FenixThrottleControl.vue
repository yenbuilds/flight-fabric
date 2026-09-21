<script setup>
import { computed } from 'vue';
import AirbusThrottleQuadrant from './AirbusThrottleQuadrant.vue';
import {
  FENIX_THROTTLE_DETENTS,
  FENIX_THROTTLE_REVERSE,
  formatFenixThrottlePosition,
  normalizeFenixThrottlePosition,
  triggerFenixThrottleHaptic,
} from '../../../aircraft-specific/paired-throttle-detents.js';
import {
  buildThrottleQuadrantAnchors,
  throttleKnobGlyph,
  throttleQuadrantTravelPercent,
} from '../../../aircraft-specific/throttle-quadrant-geometry.js';

const props = defineProps({
  leftPosition: { type: [Number, String], default: null },
  rightPosition: { type: [Number, String], default: null },
  sourceStatus: { type: String, default: 'awaiting-values' },
  controlEnabled: { type: Boolean, default: false },
  actionCapabilities: { type: Object, default: () => ({}) },
  pending: { type: Boolean, default: false },
  requestAction: { type: Function, default: () => false },
});

const QUADRANT_ANCHORS = buildThrottleQuadrantAnchors(FENIX_THROTTLE_DETENTS, {
  rawKey: 'value',
  reverse: FENIX_THROTTLE_REVERSE,
});
const LEVER_LABELS = Object.freeze(['L', 'R']);

const normalizedPositions = computed(() => [
  normalizeFenixThrottlePosition(props.leftPosition),
  normalizeFenixThrottlePosition(props.rightPosition),
]);
const bothReadbacksAvailable = computed(() => normalizedPositions.value.every((value) => value !== null));
const controlsReady = computed(() => (
  props.sourceStatus === 'connected'
  && props.controlEnabled
  && bothReadbacksAvailable.value
  && !props.pending
));
const currentDetent = computed(() => {
  const [left, right] = normalizedPositions.value;
  if (left === null || right === null || !Object.is(left, right)) return null;
  return FENIX_THROTTLE_DETENTS.find((detent) => Object.is(detent.value, left)) || null;
});
const leversSplit = computed(() => {
  const [left, right] = normalizedPositions.value;
  return bothReadbacksAvailable.value && !Object.is(left, right);
});

function leverState(position) {
  if (position === null) return 'missing';
  if (FENIX_THROTTLE_DETENTS.some((detent) => Object.is(detent.value, position))) return 'detent';
  if (position < FENIX_THROTTLE_DETENTS[FENIX_THROTTLE_DETENTS.length - 1].value) return 'reverse';
  return 'between';
}

const levers = computed(() => normalizedPositions.value.map((position, index) => ({
  label: LEVER_LABELS[index],
  glyph: throttleKnobGlyph(LEVER_LABELS[index], index),
  text: formatFenixThrottlePosition(index === 0 ? props.leftPosition : props.rightPosition),
  travelPercent: throttleQuadrantTravelPercent(position, QUADRANT_ANCHORS, FENIX_THROTTLE_DETENTS.length),
  state: leverState(position),
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
  if (accepted) triggerFenixThrottleHaptic();
  return accepted;
}

const statusText = computed(() => {
  if (props.pending) return 'Command sent. Confirming both Fenix throttle levers…';
  if (props.sourceStatus !== 'connected') return 'Waiting for live Fenix throttle data.';
  if (!props.controlEnabled) return 'Aircraft control is unavailable in this browser session.';
  if (!bothReadbacksAvailable.value) return 'Both live throttle-lever readbacks are required.';
  if (!FENIX_THROTTLE_DETENTS.some(actionSupported)) return 'Compatible throttle write transport unavailable.';
  if (leversSplit.value) return 'Levers are split. Tap a gate to align both together.';
  return 'Tap a gate to move both levers together.';
});

const footnote = 'Each tap sends one fixed detent command and verifies the left and right levers independently. Reverse thrust and positions between gates are intentionally unavailable.';
</script>

<template>
  <AirbusThrottleQuadrant
    vendor="fenix"
    aircraft-label="Fenix"
    heading="Both levers · forward detents"
    lever-count-label="both levers"
    :detents="FENIX_THROTTLE_DETENTS"
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
