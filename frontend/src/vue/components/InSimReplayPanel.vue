<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import '../../../toolbar/replay.js';
import '../../../toolbar/replay.css';
import { getAuthorizationScope, getWs, sendWs } from '../../../app-shared.js';
import { subscribeWsMessage, subscribeWsClose, subscribeWsOpen } from '../../app/runtime-signals.js';
import { useTimelineStore } from '../stores/timeline.js';
import { useInSimReplayStore } from '../stores/in-sim-replay.js';

const timeline = useTimelineStore();
const replay = useInSimReplayStore();
const host = ref(null);
const stage = ref('idle');
const visible = computed(() => (replay.enabled || replay.blocked) && stage.value !== 'idle');
let panel;
let cleanup = [];
function update() {
  panel?.update({ connected: getWs()?.readyState === 1, authorized: getAuthorizationScope() === 'full-control',
    selection: timeline.loadedTimelineFilePath && !timeline.timelineLoading && !timeline.timelineLoadError
      ? { filePath: timeline.loadedTimelineFilePath, label: timeline.loadedTimelineFlightLabel || timeline.loadedTimelineAircraftLabel } : null });
}
onMounted(() => {
  panel = window.FlightFabricReplayPanel.createReplayPanel({ document, send: sendWs, onState: state => { stage.value = state.error ? 'error' : state.state; } });
  host.value.appendChild(panel.element);
  cleanup = [subscribeWsMessage(message => { replay.receive(message); panel.receive(message); if (message.type === 'authorizationScope') update(); }),
    subscribeWsClose(() => { replay.disconnect(); panel.update({ connected: false }); }),
    subscribeWsOpen(() => { update(); sendWs({ type: 'inSimReplay', operation: 'status' }); })];
  update();
  if (getWs()?.readyState === 1) sendWs({ type: 'inSimReplay', operation: 'status' });
});
watch(() => [timeline.loadedTimelineFilePath, timeline.timelineLoading, timeline.timelineLoadError], update);
onUnmounted(() => { cleanup.forEach(fn => fn()); panel?.destroy(); replay.$reset(); });
</script>

<template><div v-show="visible" ref="host" class="in-sim-replay-host" /></template>

<style>
.in-sim-replay-host { margin: 0 0 16px; --replay-bg: rgb(var(--panel)); --replay-fg: rgb(var(--foreground)); --replay-muted: rgb(var(--muted-foreground)); --replay-border: rgb(var(--border)); --replay-button: rgb(var(--muted)); --replay-warn: rgb(var(--warning)); --replay-focus: rgb(var(--primary)); }
</style>
