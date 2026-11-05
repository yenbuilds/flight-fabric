<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useProfilesStore } from '../stores/profiles.js';
import { useStatusStore } from '../stores/status.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { createMobileVoiceClient } from '../../voice/mobile-voice-client.js';

const profiles = useProfilesStore(), connection = useStatusStore();
const voice = useVoiceControlStore();
const secure = window.location?.protocol === 'https:' && window.isSecureContext;
const captureAvailable = Boolean(navigator.mediaDevices?.getUserMedia);
const paired = computed(() => profiles.authorizationScope === 'aircraft-control');
const state = ref({ status: 'ready', message: 'Use this phone’s microphone. Recognition runs on your PC.', transcript: '', command: '' });
const busy = computed(() => ['starting', 'listening', 'finishing', 'sending'].includes(state.value.status));
const permitted = computed(() => secure && captureAvailable && paired.value && connection.websocket === 'ready');
const label = computed(() => state.value.status === 'listening' ? 'Release to send'
  : state.value.status === 'starting' ? 'Opening microphone…' : busy.value ? 'Processing…' : 'Hold to talk');
const client = createMobileVoiceClient({ canStart: () => permitted.value,
  onState: next => { state.value = { ...state.value, ...next }; } });
let held = false;
function press(event) {
  if (held || busy.value || !permitted.value || event.repeat || (event.button !== undefined && event.button !== 0)) return;
  held = true;
  if (event.pointerId !== undefined) event.currentTarget.setPointerCapture?.(event.pointerId);
  void client.begin();
}
function release() { if (held) { held = false; void client.finish(); } }
function cancel() { held = false; client.cancel(); }
async function openSetup() {
  voice.panelOpen = false;
  await nextTick();
  window.dispatchEvent(new Event('flightfabric:phone-microphone-setup'));
}
watch(permitted, allowed => { if (!allowed) cancel(); });
onBeforeUnmount(() => { held = false; client.dispose(); });
</script>

<template>
  <section class="space-y-4" aria-label="Phone voice control" data-mobile-voice-control>
    <div v-if="!secure" class="space-y-3">
      <p class="text-sm text-muted-fg">Enable this phone’s microphone to speak commands. The one-time setup opens here on your phone.</p>
      <button type="button" class="ff-button-primary" data-mobile-voice-setup-open @click="openSetup">Enable microphone</button>
    </div>
    <p v-else-if="!captureAvailable" class="text-sm text-muted-fg">Microphone access is unavailable in this browser. Open this page in Safari on iPhone or Chrome on Android, and check your device’s microphone restrictions.</p>
    <p v-else-if="!paired" class="text-sm text-muted-fg">Pair this phone for aircraft controls before using its microphone. Request controls from the phone connection page and approve the matching code on your PC.</p>
    <template v-else>
      <p id="mobile-voice-status" class="text-sm text-muted-fg" role="status" aria-live="polite">{{ state.message }}</p>
      <button type="button" class="ff-button-primary h-16 w-full touch-none select-none text-base"
        :disabled="!permitted || (busy && !held)" :aria-pressed="state.status === 'listening'" aria-describedby="mobile-voice-status"
        @pointerdown.prevent="press" @pointerup.prevent="release" @pointercancel="cancel" @lostpointercapture="held && cancel()"
        @keydown.space.prevent="press" @keyup.space.prevent="release" @keydown.enter.prevent="press" @keyup.enter.prevent="release" @blur="held && cancel()">
        {{ label }}
      </button>
      <button v-if="busy && state.status !== 'sending'" type="button" class="ff-button-secondary w-full" @click="cancel">Cancel recording</button>
      <dl v-if="state.transcript || state.command" class="space-y-2 rounded-xl border border-border p-3 text-sm">
        <div v-if="state.transcript"><dt class="text-muted-fg">Heard</dt><dd class="break-words">{{ state.transcript }}</dd></div>
        <div v-if="state.command"><dt class="text-muted-fg">Command</dt><dd class="break-words">{{ state.command }}</dd></div>
      </dl>
      <p class="text-xs text-muted-fg">Keep this page open while speaking. Audio travels over your encrypted home-network connection to FlightFabric and is not saved. Your PC does not need a microphone.</p>
    </template>
  </section>
</template>
