<script setup>
import { computed } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useVoicePushToTalk } from '../composables/useVoicePushToTalk.js';
import { canQueryAircraftState } from '../../voice/state-queries.js';
import { voiceCommandExamples } from '../../voice/command-examples.js';
import { createContext } from '../../voice/cloud-intent.js';
import KeyboardShortcutKeys from './KeyboardShortcutKeys.vue';
import VoiceRestartHint from './VoiceRestartHint.vue';

const props = defineProps({
  presentation: {
    type: String,
    default: 'page',
    validator: (value) => ['page', 'modal'].includes(value),
  },
});

const voice = useVoiceControlStore();
const aircraftControls = useAircraftControlsStore();
const specific = useAircraftSpecificStore();
const queriesAvailable = computed(() => canQueryAircraftState(specific));
const isModalPresentation = computed(() => props.presentation === 'modal');

const examples = computed(() => {
  const catalogue = aircraftControls.aircraftCommandCatalogue;
  const commands = Object.values(catalogue.commands || {});
  if (voice.runtime.mode !== 'cloud') return voiceCommandExamples(commands);
  try {
    const ids = new Set(createContext(catalogue).commands.map(command => command.id));
    return voiceCommandExamples(commands.filter(command => ids.has(command.id)));
  } catch { return []; }
});
const developmentTranscription = computed(() => voice.runtime.development
  && !queriesAvailable.value
  && (aircraftControls.availability.enabled !== true || examples.value.length === 0));
const recognitionOff = computed(() => voice.runtime.enabled !== true);
const pushToTalkDisabled = computed(() => (
  recognitionOff.value
  || (!voice.ready && !voice.listening)
  || (!voice.listening
    && (aircraftControls.availability.enabled !== true || examples.value.length === 0)
    && !queriesAvailable.value
    && !developmentTranscription.value)
));
const attentionStatuses = Object.freeze(['error', 'failed', 'blocked', 'unavailable', 'unmatched']);
const busyStatuses = Object.freeze(['initializing', 'finishing', 'sending']);
const tone = computed(() => {
  if (voice.listening) return 'border-red-500/60 bg-red-950/20';
  if (attentionStatuses.includes(voice.status)) return 'border-amber-500/40 bg-amber-950/10';
  if (busyStatuses.includes(voice.status)) return 'border-sky-500/40 bg-sky-950/10';
  return 'border-white/10 bg-black/15';
});
const statusDotClass = computed(() => {
  if (voice.listening) return 'bg-red-400 animate-pulse';
  if (voice.status === 'disabled') return 'bg-gray-500';
  if (attentionStatuses.includes(voice.status)) return 'bg-amber-400';
  if (busyStatuses.includes(voice.status)) return 'bg-sky-400 animate-pulse';
  return 'bg-emerald-400';
});
const pushToTalkLabel = computed(() => {
  if (recognitionOff.value) return 'Voice control off';
  if (voice.status === 'initializing') return 'Starting voice control';
  if (voice.status === 'starting') return 'Release to cancel';
  if (voice.status === 'listening') {
    return developmentTranscription.value ? 'Release to transcribe' : 'Release to execute';
  }
  if (voice.status === 'finishing') return 'Processing';
  if (voice.status === 'sending') return 'Sending command';
  return 'Hold to talk';
});
const { press, pressWithKeyboard, release, cancelLocalPress } = useVoicePushToTalk(voice);
const emit = defineEmits(['open-settings']);
</script>

<template>
  <section
    class="transition-colors"
    :class="isModalPresentation ? 'p-0' : ['mb-4 rounded-xl border p-4', tone]"
    :aria-labelledby="isModalPresentation ? undefined : 'voice-control-title'"
    data-voice-control-panel
    :data-voice-control-presentation="presentation"
  >
    <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 v-if="!isModalPresentation" id="voice-control-title" class="text-sm font-semibold text-white">Voice control</h2>
        </div>
        <div v-if="voice.bridgeAvailable" id="voice-control-status" class="flex items-center gap-2 text-xs text-muted-fg" :class="isModalPresentation ? '' : 'mt-1.5'" role="status" aria-live="polite">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="statusDotClass" aria-hidden="true"></span>
          <span>{{ voice.statusText }}</span>
        </div>
        <button v-if="voice.bridgeAvailable" type="button" class="ff-button-secondary mt-3 text-xs" data-voice-settings-link @click="emit('open-settings')">{{ voice.settingsAction }}</button>
        <p v-if="!voice.bridgeAvailable" class="mt-2 text-xs text-muted-fg">Speak into the microphone connected to your simulator PC.</p>
        <p v-else-if="recognitionOff" class="mt-2 text-xs text-muted-fg">Enable voice control in Settings to talk.</p>
        <p v-else-if="voice.setupTask" class="mt-2 text-xs text-muted-fg">{{ voice.setupTask.detail }}</p>
        <VoiceRestartHint />
        <p v-if="voice.transcript" class="mt-2 truncate text-sm text-gray-200" aria-live="polite">
          “{{ voice.transcript }}”
        </p>
        <p v-if="voice.lastCommand" class="mt-1 text-xs text-emerald-300">{{ voice.lastCommand }}</p>
      </div>

      <div v-if="voice.bridgeAvailable" class="flex flex-col items-stretch gap-2 sm:items-end">
        <button
          type="button"
          data-voice-push-to-talk
          class="flex min-h-16 min-w-44 select-none items-center justify-center gap-3 rounded-xl border px-5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="voice.listening ? 'border-red-400 bg-red-600 text-white' : 'border-accent/50 bg-accent/10 text-white hover:bg-accent/20'"
          :disabled="pushToTalkDisabled"
          aria-describedby="voice-control-status"
          @pointerdown.prevent="press"
          @pointerup.prevent="release"
          @pointercancel.prevent="cancelLocalPress"
          @lostpointercapture="release"
          @blur="cancelLocalPress"
          @keydown.space.prevent="pressWithKeyboard"
          @keyup.space.prevent="release"
          @keydown.enter.prevent="pressWithKeyboard"
          @keyup.enter.prevent="release"
        >
          <svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="2.5" width="6" height="12" rx="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
          </svg>
          <span class="flex min-w-0 flex-col">
            <span class="text-sm font-semibold">{{ pushToTalkLabel }}</span>
            <span class="mt-1 flex flex-wrap items-center gap-1 font-mono text-[10px] font-normal">
              <KeyboardShortcutKeys v-if="voice.runtime.shortcut" :shortcut="voice.runtime.shortcut" />
              <span v-if="voice.runtime.controllerEnabled && voice.runtime.controller.binding" class="break-words">Controller Button {{ voice.runtime.controller.binding.button }}</span>
              <span v-else-if="!voice.runtime.shortcut" class="opacity-65">On-screen only</span>
            </span>
          </span>
        </button>
      </div>
    </div>

    <p v-if="!examples.length && developmentTranscription" class="mt-3 border-t border-white/10 pt-3 text-xs text-muted-fg">
      Development mode: speak any phrase to inspect its transcription. Commands will not be sent.
    </p>
    <p v-else-if="!examples.length" class="mt-3 border-t border-white/10 pt-3 text-xs text-muted-fg">
      No voice commands are exposed for this aircraft.
    </p>

    <p v-if="voice.runtime.mode === 'cloud' && voice.cloudUsage" class="mt-3 text-[11px] text-muted-fg">Last {{ voice.runtime.cloud.providerLabel }} request: {{ voice.cloudUsage.inputTokens }} input tokens · {{ voice.cloudUsage.outputTokens }} output tokens. Check your provider account for billed usage.</p>
    <details v-if="voice.bridgeAvailable" class="setup-details mt-3 text-xs text-muted-fg">
      <summary>About microphone use</summary>
      <p>After release, the microphone remains active briefly, then closes after buffered audio is flushed. {{ voice.runtime.mode === 'cloud' ? `Cloud preview sends the audio and supported aircraft controls to ${voice.runtime.cloud.providerLabel} using your API key.` : 'Audio remains local and is not saved.' }}</p>
    </details>
  </section>
</template>
