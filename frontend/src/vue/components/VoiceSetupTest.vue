<script setup>
import { computed, nextTick, onBeforeUnmount, watch } from 'vue';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
import { VOICE_TEST_PHRASE } from '../../voice/voice-setup-test.js';

const props = defineProps({ disabled: Boolean });
const voice = useVoiceControlStore();
const tabs = useTabsStore();
const state = computed(() => voice.voiceTest);
const blocked = computed(() => props.disabled || voice.listening || voice.finishing || voice.status === 'sending');
watch(() => state.value.phase, async () => {
  const origin = document.activeElement;
  if (!origin?.closest('[data-voice-test]')) return;
  await nextTick();
  if (tabs.activeTabId !== 'settings'
      || (document.activeElement !== document.body && document.activeElement !== origin)
      || (origin.isConnected && !origin.disabled)) return;
  document.querySelector('[data-voice-test-cancel], [data-voice-test-start]:not(:disabled)')?.focus({ preventScroll: true });
});
watch(() => tabs.activeTabId, (tab) => { if (tab !== 'settings') void voice.cancelVoiceTest(); });
onBeforeUnmount(() => { void voice.cancelVoiceTest(); });
</script>

<template>
  <section class="rounded-lg border border-border bg-panel-subtle p-3 sm:p-4" aria-labelledby="voice-test-title" data-voice-test>
    <h4 id="voice-test-title" class="text-sm font-semibold text-fg">Test voice</h4>
    <p class="mt-1 text-xs text-muted-fg">Check your microphone and speech recognition without MSFS. Test only — no aircraft commands will be sent.</p>
    <p class="mt-3 text-sm text-fg">Say: <strong>“{{ VOICE_TEST_PHRASE }}”</strong></p>
    <p class="mt-1 text-xs text-muted-fg">Records up to five seconds using your selected microphone. FlightFabric keeps a temporary recording for playback and clears it when you leave Settings.</p>
    <p v-if="voice.runtime.mode === 'cloud'" class="mt-1 text-xs text-muted-fg">Cloud mode sends this recording to {{ voice.runtime.cloud.providerLabel }} when recording finishes and uses your provider API account.</p>
    <p v-if="!voice.runtime.enabled" id="voice-test-unavailable" class="mt-2 text-xs text-muted-fg">Enable voice control above to run the test.</p>
    <p v-else-if="!voice.runtime.available" id="voice-test-unavailable" class="mt-2 text-xs text-warning">{{ voice.runtime.error || 'Speech recognition is unavailable. Try turning voice control off and on again.' }}</p>
    <p v-else-if="blocked" class="mt-2 text-xs text-muted-fg">Finish the current voice action or shortcut setup before testing.</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button type="button" class="ff-button-secondary text-xs disabled:opacity-50" data-voice-test-start
        :disabled="voice.voiceTestBusy || blocked || !voice.runtime.enabled || !voice.runtime.available"
        :aria-describedby="!voice.runtime.enabled || !voice.runtime.available ? 'voice-test-unavailable' : undefined"
        @click="voice.startVoiceTest">{{ state.phase === 'idle' || voice.voiceTestBusy ? 'Start voice test' : 'Test again' }}</button>
      <button v-if="state.phase === 'listening'" type="button" class="ff-button-secondary text-xs" data-voice-test-finish @click="voice.finishVoiceTest">Finish recording</button>
      <button v-if="voice.voiceTestBusy" type="button" class="ff-button-secondary text-xs" data-voice-test-cancel @click="voice.cancelVoiceTest">Cancel test</button>
      <button v-if="state.playbackAvailable" type="button" class="ff-button-secondary text-xs disabled:opacity-50" data-voice-test-play
        :disabled="voice.voiceTestBusy || blocked" @click="voice.playVoiceTest">Play recording</button>
    </div>
    <div v-if="state.phase === 'listening'" class="mt-3">
      <label for="voice-test-level" class="text-xs text-muted-fg">Input level · {{ state.deviceLabel || 'Selected microphone' }}</label>
      <meter id="voice-test-level" class="mt-1 block h-3 w-full accent-primary" min="0" max="100" :value="state.level">{{ state.level }}%</meter>
    </div>
    <p class="mt-2 text-xs" :class="state.phase === 'error' ? 'text-warning' : state.recognized ? 'text-success' : 'text-muted-fg'" role="status" aria-live="polite" data-voice-test-status>{{ state.phase === 'playing' ? 'Playing your recording…' : state.message }}</p>
    <p v-if="state.transcript" class="mt-2 break-words text-sm text-fg" data-voice-test-transcript><span class="text-muted-fg">{{ state.interpreted ? 'Interpreted:' : 'Heard:' }}</span> {{ state.transcript }}</p>
  </section>
</template>
