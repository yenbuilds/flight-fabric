<script setup>
import {
  computed,
  ref,
  watch,
} from 'vue';
import { shortcutFromKeyboardEvent } from '../../voice/shortcut-recorder.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useVoiceControlStore } from '../stores/voice-control.js';

const props = defineProps({
  presentation: {
    type: String,
    default: 'page',
    validator: (value) => ['page', 'modal'].includes(value),
  },
});

const voice = useVoiceControlStore();
const aircraftControls = useAircraftControlsStore();
const shortcutDraft = ref(voice.runtime.shortcut);
const shortcutRecording = ref(false);
const shortcutSaving = ref(false);
const shortcutError = ref('');
const recognitionSaving = ref(false);
const isModalPresentation = computed(() => props.presentation === 'modal');

function sampleSpeechValue(command = {}) {
  const commandId = String(command.id || '').toLowerCase();
  if (commandId.includes('heading')) return '270';
  if (commandId.includes('altitude')) return '10,000';
  if (commandId.includes('verticalspeed')) return '1,000';
  if (commandId.includes('speed')) return '250';
  if (commandId.includes('mach')) return '0.78';
  if (command.input?.kind === 'boolean') return 'on';
  if (command.input?.kind === 'enum') return String(command.input.values?.[0] || 'on');
  if (command.input?.kind === 'number') return String(command.input.min ?? 1);
  return '';
}

function speechExample(command = {}) {
  const pattern = command?.speech?.patterns?.find((candidate) => typeof candidate === 'string');
  if (!pattern) return '';
  const phrase = pattern.replace('{value}', sampleSpeechValue(command)).trim();
  return phrase ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}` : '';
}

function prioritizeAltitudeTarget(commands = []) {
  const altitudeIndex = commands.findIndex((command) => (
    command?.input?.kind === 'number'
    && command.input.units === 'feet'
    && String(command.id || '').toLowerCase().includes('altitude')
  ));
  if (altitudeIndex <= 0) return commands;
  return [commands[altitudeIndex], ...commands.filter((_, index) => index !== altitudeIndex)];
}

function compactMicrophoneLabel(value = '') {
  return String(value || '')
    .replace(/^Default\s*-\s*/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim();
}

const examples = computed(() => prioritizeAltitudeTarget(
  Object.values(aircraftControls.aircraftCommandCatalogue.commands || {}),
)
  .map(speechExample)
  .filter(Boolean)
  .slice(0, 3));
const developmentTranscription = computed(() => voice.runtime.development
  && (aircraftControls.availability.enabled !== true || examples.value.length === 0));
const captureLocked = computed(() => voice.listening || voice.finishing);
const recognitionOff = computed(() => voice.runtime.enabled !== true);
const shortcutDirty = computed(() => Boolean(shortcutDraft.value)
  && shortcutDraft.value !== voice.runtime.shortcut);
const pushToTalkDisabled = computed(() => (
  recognitionOff.value
  || (!voice.ready && !voice.listening)
  || (!voice.listening
    && (aircraftControls.availability.enabled !== true || examples.value.length === 0)
    && !developmentTranscription.value)
));
const selectedInputMissing = computed(() => Boolean(voice.selectedInputDeviceId)
  && !voice.inputDevices.some((device) => device.deviceId === voice.selectedInputDeviceId));
const selectedInputLabel = computed(() => {
  const selected = voice.inputDevices.find((device) => device.deviceId === voice.selectedInputDeviceId);
  return compactMicrophoneLabel(selected?.label || voice.deviceLabel) || 'Default microphone';
});
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
watch(() => voice.runtime.shortcut, (value) => {
  shortcutDraft.value = value;
  shortcutRecording.value = false;
  shortcutError.value = '';
});

function press(event) {
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  void voice.pressToTalk();
}
function pressWithKeyboard(event) {
  if (!event.repeat) void voice.pressToTalk();
}
function release() { void voice.releaseToTalk(); }
function beginShortcutRecording() {
  if (recognitionOff.value || captureLocked.value || shortcutSaving.value) return;
  shortcutRecording.value = true;
  shortcutError.value = '';
}
function cancelShortcutEdit() {
  shortcutDraft.value = voice.runtime.shortcut;
  shortcutRecording.value = false;
  shortcutError.value = '';
}
function captureShortcut(event) {
  if (!shortcutRecording.value || event.repeat || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape'
    && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    cancelShortcutEdit();
    return;
  }

  const captured = shortcutFromKeyboardEvent(event);
  if (captured.reason === 'waiting-for-key') return;
  if (captured.reason === 'modifier-required') {
    shortcutError.value = 'Include Ctrl, Alt, Shift, or Windows with another key.';
    return;
  }
  if (captured.reason === 'unsupported-key') {
    shortcutError.value = 'That key cannot be used for push-to-talk. Try a letter, number, F-key, or navigation key.';
    return;
  }

  shortcutDraft.value = captured.accelerator;
  shortcutRecording.value = false;
  shortcutError.value = '';
}
async function saveShortcut() {
  if (recognitionOff.value || !shortcutDirty.value || shortcutRecording.value || shortcutSaving.value) return;
  shortcutSaving.value = true;
  shortcutError.value = '';
  const saved = await voice.setShortcut(shortcutDraft.value);
  if (!saved) shortcutError.value = 'That shortcut could not be registered. Choose another combination.';
  shortcutSaving.value = false;
}
async function toggleRecognition(event) {
  const target = event.currentTarget;
  const nextEnabled = target?.checked === true;
  recognitionSaving.value = true;
  const changed = await voice.setRecognitionEnabled(nextEnabled);
  if (!changed && target) target.checked = voice.runtime.enabled === true;
  recognitionSaving.value = false;
}
function selectMicrophone(event) { voice.selectInputDevice(event.currentTarget?.value || ''); }
function toggleSpokenReadbacks(event) { voice.toggleSpokenReadbacks(event.currentTarget?.checked === true); }
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
        <div id="voice-control-status" class="flex items-center gap-2 text-xs text-muted-fg" :class="isModalPresentation ? '' : 'mt-1.5'" role="status" aria-live="polite">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="statusDotClass" aria-hidden="true"></span>
          <span>{{ voice.statusText }}</span>
        </div>
        <p v-if="voice.transcript" class="mt-2 truncate text-sm text-gray-200" aria-live="polite">
          “{{ voice.transcript }}”
        </p>
        <p v-if="voice.lastCommand" class="mt-1 text-xs text-emerald-300">{{ voice.lastCommand }}</p>
      </div>

      <div class="flex flex-col items-stretch gap-2 sm:items-end">
        <label class="flex min-h-9 cursor-pointer items-center gap-2 text-xs font-medium text-gray-200" data-voice-recognition-toggle>
          <input
            class="peer sr-only"
            type="checkbox"
            role="switch"
            :checked="voice.runtime.enabled"
            :disabled="recognitionSaving"
            @change="toggleRecognition"
          >
          <span
            class="relative h-5 w-9 shrink-0 rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-100"
            :class="voice.runtime.enabled ? 'border-accent/60 bg-accent/35' : 'border-white/20 bg-white/5'"
            aria-hidden="true"
          >
            <span
              class="absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-gray-200 transition-transform"
              :class="voice.runtime.enabled ? 'translate-x-4' : 'translate-x-0'"
            ></span>
          </span>
          <span>{{ recognitionSaving ? 'Updating voice control' : 'Enable voice control' }}</span>
        </label>

        <button
          type="button"
          data-voice-push-to-talk
          class="flex min-h-16 min-w-44 select-none items-center justify-center gap-3 rounded-xl border px-5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="voice.listening ? 'border-red-400 bg-red-600 text-white' : 'border-accent/50 bg-accent/10 text-white hover:bg-accent/20'"
          :disabled="pushToTalkDisabled"
          aria-describedby="voice-control-status"
          @pointerdown.prevent="press"
          @pointerup.prevent="release"
          @pointercancel.prevent="release"
          @lostpointercapture="release"
          @keydown.space.prevent="pressWithKeyboard"
          @keyup.space.prevent="release"
          @keydown.enter.prevent="pressWithKeyboard"
          @keyup.enter.prevent="release"
        >
          <svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="2.5" width="6" height="12" rx="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
          </svg>
          <span class="flex flex-col">
            <span class="text-sm font-semibold">{{ pushToTalkLabel }}</span>
            <span class="mt-0.5 font-mono text-[10px] font-normal opacity-65">{{ voice.runtime.shortcut || 'On-screen only' }}</span>
          </span>
        </button>
      </div>
    </div>

    <div v-if="examples.length" class="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 text-xs">
      <span class="mr-1 text-muted-fg">Try saying</span>
      <span
        v-for="example in examples"
        :key="example"
        class="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-gray-300"
      >
        &ldquo;{{ example }}&rdquo;
      </span>
    </div>
    <p v-else-if="developmentTranscription" class="mt-3 border-t border-white/10 pt-3 text-xs text-muted-fg">
      Development mode: speak any phrase to inspect its transcription. Commands will not be sent.
    </p>
    <p v-else class="mt-3 border-t border-white/10 pt-3 text-xs text-muted-fg">
      No voice commands are exposed by the active aircraft configuration.
    </p>

    <details class="voice-settings mt-3 border-t border-white/10 pt-1 text-xs">
      <summary class="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-gray-200">
        <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />
        </svg>
        <span class="font-medium text-gray-300">Voice settings</span>
        <span v-if="recognitionOff" class="shrink-0 text-[11px] font-medium text-gray-400">Voice off</span>
        <span v-else-if="!voice.runtime.shortcut" class="shrink-0 text-[11px] font-medium text-amber-300">Set push-to-talk</span>
        <span class="min-w-0 flex-1 truncate text-right text-[11px]">{{ selectedInputLabel }}</span>
        <svg class="voice-settings__chevron h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>

      <div class="mt-2 grid gap-3 rounded-xl border border-white/10 bg-black/10 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div class="min-w-0">
          <label for="voice-input-device" class="mb-1.5 block text-muted-fg">Microphone</label>
          <div class="flex min-w-0 items-center gap-2">
            <select
              id="voice-input-device"
              class="min-h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-gray-200 disabled:opacity-50"
              :value="voice.selectedInputDeviceId"
              :disabled="recognitionOff || captureLocked"
              @change="selectMicrophone"
            >
              <option value="">Windows default input</option>
              <option v-if="selectedInputMissing" :value="voice.selectedInputDeviceId">Previously selected microphone (unavailable)</option>
              <option v-for="device in voice.inputDevices" :key="device.deviceId" :value="device.deviceId">
                {{ device.label }}
              </option>
            </select>
            <button
              type="button"
              class="min-h-10 rounded-lg border border-white/15 px-3 py-2 text-gray-200 transition-colors hover:bg-white/5 disabled:opacity-50"
              :disabled="recognitionOff || captureLocked"
              @click="voice.refreshInputDevices({ requestAccess: true })"
            >
              Detect microphones
            </button>
          </div>
        </div>

        <label class="flex min-h-10 shrink-0 cursor-pointer items-center gap-2 text-gray-300" title="Speaks command results using an installed local voice. Online voices are never selected.">
          <input
            class="peer sr-only"
            type="checkbox"
            role="switch"
            :checked="voice.spokenReadbacks"
            :disabled="captureLocked"
            @change="toggleSpokenReadbacks"
          >
          <span
            class="relative h-5 w-9 shrink-0 rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-100"
            :class="voice.spokenReadbacks ? 'border-accent/60 bg-accent/35' : 'border-white/20 bg-white/5'"
            aria-hidden="true"
          >
            <span
              class="absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-gray-200 transition-transform"
              :class="voice.spokenReadbacks ? 'translate-x-4' : 'translate-x-0'"
            ></span>
          </span>
          <span>Local spoken feedback</span>
        </label>

        <form class="flex flex-col gap-1.5 lg:col-span-2" @submit.prevent="saveShortcut">
          <label for="voice-ptt-shortcut" class="shrink-0 text-muted-fg">Push-to-talk shortcut</label>
          <div class="flex flex-wrap items-center gap-2">
            <button
              id="voice-ptt-shortcut"
              type="button"
              data-voice-shortcut-recorder
              class="min-h-10 min-w-40 rounded-lg border px-3 py-2 text-left font-mono transition-colors disabled:opacity-50"
              :class="shortcutRecording ? 'border-accent/70 bg-accent/10 text-white' : 'border-white/15 bg-black/20 text-gray-200 hover:bg-white/5'"
              :disabled="recognitionOff || captureLocked || shortcutSaving"
              :aria-label="shortcutRecording
                ? 'Press the new push-to-talk shortcut'
                : shortcutDraft
                  ? `Current push-to-talk shortcut: ${shortcutDraft}. Click to change.`
                  : 'No global push-to-talk shortcut is set. Click to record one.'"
              aria-describedby="voice-ptt-shortcut-help voice-ptt-shortcut-error"
              @click="beginShortcutRecording"
              @keydown="captureShortcut"
            >
              {{ shortcutRecording ? 'Press shortcut…' : (shortcutDraft || 'Set shortcut') }}
            </button>
            <button
              v-if="shortcutDirty"
              type="submit"
              class="min-h-10 rounded-lg border border-white/15 px-3 py-2 text-gray-200 transition-colors hover:bg-white/5 disabled:opacity-50"
              :disabled="recognitionOff || shortcutRecording || shortcutSaving || captureLocked"
            >
              {{ shortcutSaving ? 'Saving…' : 'Save' }}
            </button>
            <button
              v-if="shortcutRecording || shortcutDirty"
              type="button"
              class="min-h-10 rounded-lg px-3 py-2 text-muted-fg transition-colors hover:bg-white/5 hover:text-gray-200"
              @click="cancelShortcutEdit"
            >
              Cancel
            </button>
          </div>
          <p id="voice-ptt-shortcut-help" class="text-[11px] text-muted-fg">
            {{ recognitionOff
              ? 'Enable voice control before setting a global shortcut.'
              : shortcutRecording
              ? 'Hold one or more modifiers, then press a key. Escape cancels.'
              : shortcutDraft
                ? 'Click the shortcut to record a new key combination.'
                : 'No global shortcut is active. Click to record one.' }}
          </p>
          <p v-if="shortcutError" id="voice-ptt-shortcut-error" class="text-[11px] text-amber-300" role="alert">
            {{ shortcutError }}
          </p>
        </form>
        <p class="text-[11px] text-muted-fg lg:col-span-2">
          After release, the microphone remains active briefly to preserve the end of your speech, then closes after buffered audio is flushed. Audio remains local and is not saved.
        </p>
      </div>
    </details>

  </section>
</template>

<style scoped>
.voice-settings > summary {
  list-style: none;
}

.voice-settings > summary::-webkit-details-marker {
  display: none;
}

.voice-settings[open] .voice-settings__chevron {
  transform: rotate(180deg);
}

.voice-settings__chevron {
  transition: transform 140ms ease;
}
</style>
