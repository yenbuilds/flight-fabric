<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { sendWs } from '../../../../app-shared.js';
import { subscribeWsMessage, subscribeWsClose, subscribeWsOpen } from '../../../app/runtime-signals.js';
import { useAircraftControlsStore } from '../../stores/aircraft-controls.js';
import { createDeparturePreview } from '../../../aircraft/departure-preview.js';
import { createPushbackControls } from '../../../aircraft/pushback-controls.js';

const props = defineProps({ icao: { type: String, default: '' }, runway: { type: String, default: '' }, disabled: Boolean,
  allowPreview: { type: Boolean, default: true }, primary: { type: Boolean, default: true } });
const emit = defineEmits(['active', 'complete', 'preview']);
const controls = useAircraftControlsStore(), connected = ref(true);
const previewState = ref({ data: null, fresh: false, loading: false, error: '' });
const status = ref({ state: { active: false }, active: false, completed: false, pending: '', fresh: false, canStart: false, reason: '' });
const state = computed(() => status.value.state), active = computed(() => status.value.active);
const completed = computed(() => status.value.completed), pending = computed(() => status.value.pending);
const fresh = computed(() => status.value.fresh), canStart = computed(() => status.value.canStart), reason = computed(() => status.value.reason);
let controller, departurePreview, cleanup, closeCleanup, openCleanup;
function context() {
  const catalogue = controls.aircraftCommandCatalogue;
  return { connected: connected.value, enabled: controls.availability.enabled,
    unavailableReason: controls.availability.reason, disabled: props.disabled,
    profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision,
    icao: props.icao, runway: props.runway, preview: previewState.value };
}
function update() {
  const next = context();
  controller?.update(next);
  departurePreview?.update({ ...next, enabled: next.enabled && props.allowPreview });
}
watch(() => [props.icao, props.runway, props.allowPreview, props.disabled, connected.value, controls.availability.enabled,
  controls.availability.reason, controls.aircraftCommandCatalogue.profileKey, controls.aircraftCommandCatalogue.profileRevision], update, { flush: 'sync' });
function send(operation) { controller?.request(operation); }
onMounted(() => {
  controller = createPushbackControls({ send: sendWs, setTimeout, clearTimeout,
    changed: snapshot => { const changed = status.value.active !== snapshot.active; status.value = snapshot; if (changed) emit('active', snapshot.active); }, complete: () => emit('complete') });
  departurePreview = createDeparturePreview({ send: sendWs, setTimeout, clearTimeout,
    changed: snapshot => { previewState.value = snapshot; emit('preview', snapshot); controller.update(context()); } });
  cleanup = subscribeWsMessage(message => { if (!departurePreview.receive(message)) controller.receive(message); });
  closeCleanup = subscribeWsClose(() => { connected.value = false; });
  openCleanup = subscribeWsOpen(() => { connected.value = true; });
  update();
});
onBeforeUnmount(() => {
  controller?.destroy(); emit('active', false);
  cleanup?.(); closeCleanup?.(); openCleanup?.(); departurePreview?.destroy();
});
</script>

<template>
  <div data-taxi-pushback class="space-y-2">
    <button v-if="!completed" type="button" :data-pushback-start="!active ? '' : undefined" :data-pushback-stop="active ? '' : undefined"
      class="min-h-[48px] disabled:opacity-50" :class="active ? 'ff-button-secondary border-warning text-warning' : primary ? 'ff-button-primary' : 'ff-button-secondary'"
      :disabled="active ? pending === 'stop' : !canStart" @keydown="$event.repeat && ['Enter', ' '].includes($event.key) && $event.preventDefault()"
      @click="send(active ? 'stop' : 'start')">{{ active ? (pending === 'stop' ? 'Stopping…' : 'Stop pushback') : 'Push back' }}</button>
    <p v-if="active && fresh && Number.isFinite(state.remainingM)" class="text-sm text-fg">{{ Math.round(state.remainingM) }} m remaining · Runway {{ state.runway }}</p>
    <p v-if="reason" class="text-xs" :class="completed ? 'font-medium text-success' : 'text-muted-fg'" role="status">{{ reason }}</p>
  </div>
</template>

<style scoped>
/* Match the assistant's targets over the shell's compact button rules. */
button { min-height: 3rem !important; }
</style>
