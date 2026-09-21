<script setup>
import {
  computed,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import { shortcutFromKeyboardEvent } from '../../voice/shortcut-recorder.js';
import { describeJoystickBinding } from '../../voice/joystick-binding.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useVoicePushToTalk } from '../composables/useVoicePushToTalk.js';
import { canQueryAircraftState, stateQueryExamples } from '../../voice/state-queries.js';
import { flightPlanQueryExamples } from '../../voice/flight-plan-queries.js';
import { voiceCommandExamples } from '../../voice/command-examples.js';

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
const queryExamples = computed(() => stateQueryExamples(specific));
const shortcutDraft = ref(voice.runtime.shortcut);
const shortcutRecording = ref(false);
const shortcutSaving = ref(false);
const shortcutError = ref('');
const recognitionSaving = ref(false);
const joystickDraft = ref(voice.runtime.joystick);
const joystickSaving = ref(false);
const joystickError = ref('');
const isModalPresentation = computed(() => props.presentation === 'modal');

function compactMicrophoneLabel(value = '') {
  return String(value || '')
    .replace(/^Default\s*-\s*/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim();
}

const examples = computed(() => voiceCommandExamples(
  Object.values(aircraftControls.aircraftCommandCatalogue.commands || {}),
));
const developmentTranscription = computed(() => voice.runtime.development
  && !queriesAvailable.value
  && (aircraftControls.availability.enabled !== true || examples.value.length === 0));
// Flight plan questions need no aircraft data, only a session that can dispatch.
const flightPlanExamples = flightPlanQueryExamples();
const flightPlanQueriesAvailable = computed(() => !developmentTranscription.value
  && (queriesAvailable.value || (aircraftControls.availability.enabled === true && examples.value.length > 0)));
const captureLocked = computed(() => voice.listening || voice.finishing);
const recognitionOff = computed(() => voice.runtime.enabled !== true);
const shortcutDirty = computed(() => Boolean(shortcutDraft.value)
  && shortcutDraft.value !== voice.runtime.shortcut);
const joystickLearning = computed(() => voice.joystickLearn?.active === true);
const joystickDirty = computed(() => Boolean(joystickDraft.value)
  && JSON.stringify(joystickDraft.value) !== JSON.stringify(voice.runtime.joystick));
const joystickDraftLabel = computed(() => describeJoystickBinding(joystickDraft.value));
const joystickBoundName = computed(() => voice.runtime.joystick?.name || 'The bound joystick');
const joystickDetected = computed(() => (voice.joystickLearn?.devices || []).map((device) => device.name).join(', '));
const joystickHelp = computed(() => {
  if (recognitionOff.value) return 'Enable voice control before binding a joystick button.';
  if (joystickLearning.value) {
    return joystickDetected.value
      ? `Listening on ${joystickDetected.value}. Press the button to use; Escape cancels.`
      : 'Looking for joysticks… Press the button to use; Escape cancels.';
  }
  if (joystickDirty.value) return 'Save to use this button. The simulator sees it too, so choose one nothing else uses.';
  if (voice.runtime.joystick && !voice.runtime.joystickConnected) {
    return `${joystickBoundName.value} is not connected. The binding stays and works again once it is plugged in.`;
  }
  if (voice.runtime.joystick) return 'Click to choose a different button. The simulator sees this button too.';
  return 'No joystick button is bound. Click, then press the button on your stick.';
});
// What the main control says it can be held with, besides itself.
const globalHoldLabel = computed(() => [voice.runtime.shortcut, describeJoystickBinding(voice.runtime.joystick)]
  .filter(Boolean)
  .join(' · ') || 'On-screen only');
const pushToTalkDisabled = computed(() => (
  recognitionOff.value
  || (!voice.ready && !voice.listening)
  || (!voice.listening
    && (aircraftControls.availability.enabled !== true || examples.value.length === 0)
    && !queriesAvailable.value
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
watch(() => voice.runtime.joystick, (value) => {
  joystickDraft.value = value;
  joystickError.value = '';
});
watch(() => voice.joystickLearn?.captured, (captured) => {
  if (!captured) return;
  joystickDraft.value = { ...captured };
  joystickError.value = '';
});
watch(() => voice.joystickLearn?.error, (error) => {
  if (error) joystickError.value = error;
});

const { press, pressWithKeyboard, release, cancelLocalPress } = useVoicePushToTalk(voice);
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
function beginJoystickLearn() {
  if (recognitionOff.value || captureLocked.value || joystickSaving.value || joystickLearning.value) return;
  joystickError.value = '';
  void voice.startJoystickLearn();
}
function cancelJoystickEdit() {
  if (joystickLearning.value) void voice.stopJoystickLearn();
  joystickDraft.value = voice.runtime.joystick;
  joystickError.value = '';
}
async function saveJoystick() {
  if (recognitionOff.value || !joystickDirty.value || joystickLearning.value || joystickSaving.value) return;
  joystickSaving.value = true;
  joystickError.value = '';
  const saved = await voice.setJoystick(joystickDraft.value);
  if (!saved) joystickError.value = 'That joystick button could not be bound. Try again.';
  joystickSaving.value = false;
}
async function removeJoystick() {
  if (recognitionOff.value || !voice.runtime.joystick || joystickLearning.value || joystickSaving.value) return;
  joystickSaving.value = true;
  joystickError.value = '';
  const removed = await voice.setJoystick(null);
  if (!removed) joystickError.value = 'The joystick button could not be removed. Try again.';
  joystickSaving.value = false;
}
// A closed panel cannot show a captured button; stop the helper listening.
onBeforeUnmount(() => {
  if (joystickLearning.value) void voice.stopJoystickLearn();
});
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
          <span class="flex flex-col">
            <span class="text-sm font-semibold">{{ pushToTalkLabel }}</span>
            <span class="mt-0.5 font-mono text-[10px] font-normal opacity-65">{{ globalHoldLabel }}</span>
          </span>
        </button>
      </div>
    </div>

    <div v-if="queriesAvailable" class="mt-3 border-t border-white/10 pt-3 text-xs text-muted-fg" data-state-query-guide>
      <p class="font-semibold">Ask about the aircraft</p>
      <p class="mt-1">{{ queryExamples.slice(0, 3).join(' · ') }}</p>
      <details v-if="queryExamples.length > 3" class="mt-2" data-more-state-queries>
        <summary class="cursor-pointer py-1">More questions ({{ queryExamples.length - 3 }})</summary>
        <ul class="mt-1 grid gap-1 sm:grid-cols-2">
          <li v-for="example in queryExamples.slice(3)" :key="example">{{ example }}</li>
        </ul>
      </details>
      <p class="mt-1">Replies use fresh aircraft data. Enable spoken readbacks to hear the answer.</p>
    </div>
    <div v-if="flightPlanQueriesAvailable" class="mt-3 border-t border-white/10 pt-3 text-xs text-muted-fg" data-flight-plan-query-guide>
      <p class="font-semibold">Ask about the flight plan</p>
      <p class="mt-1">{{ flightPlanExamples.join(' · ') }}</p>
      <p class="mt-1">Reads the airports, runways, SID, STAR, transitions and planned altitude from the OFP loaded on the SimBrief tab.</p>
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
        <span v-else-if="!voice.runtime.shortcut && !voice.runtime.joystick" class="shrink-0 text-[11px] font-medium text-amber-300">Set push-to-talk</span>
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
        <p v-if="voice.runtime.readbackError" class="text-[11px] text-amber-300 lg:col-span-2" data-voice-readback-error>
          Last spoken readback failed: {{ voice.runtime.readbackError }} Windows speech uses the default output device.
        </p>

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

        <form v-if="voice.runtime.joystickAvailable" class="flex flex-col gap-1.5 lg:col-span-2" data-voice-joystick-binding @submit.prevent="saveJoystick">
          <label for="voice-ptt-joystick" class="shrink-0 text-muted-fg">Joystick push-to-talk button</label>
          <div class="flex flex-wrap items-center gap-2">
            <button
              id="voice-ptt-joystick"
              type="button"
              data-voice-joystick-recorder
              class="min-h-10 min-w-40 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50"
              :class="joystickLearning ? 'border-accent/70 bg-accent/10 text-white' : 'border-white/15 bg-black/20 text-gray-200 hover:bg-white/5'"
              :disabled="recognitionOff || captureLocked || joystickSaving"
              :aria-label="joystickLearning
                ? 'Press the joystick button to use for push-to-talk'
                : joystickDraftLabel
                  ? `Current joystick push-to-talk button: ${joystickDraftLabel}. Click to change.`
                  : 'No joystick push-to-talk button is bound. Click to detect one.'"
              aria-describedby="voice-ptt-joystick-help voice-ptt-joystick-error"
              @click="joystickLearning ? cancelJoystickEdit() : beginJoystickLearn()"
              @keydown.escape.prevent="cancelJoystickEdit"
            >
              {{ joystickLearning ? 'Press a joystick button…' : (joystickDraftLabel || 'Set joystick button') }}
            </button>
            <button
              v-if="joystickDirty"
              type="submit"
              class="min-h-10 rounded-lg border border-white/15 px-3 py-2 text-gray-200 transition-colors hover:bg-white/5 disabled:opacity-50"
              :disabled="recognitionOff || joystickLearning || joystickSaving || captureLocked"
            >
              {{ joystickSaving ? 'Saving…' : 'Save' }}
            </button>
            <button
              v-if="joystickLearning || joystickDirty"
              type="button"
              class="min-h-10 rounded-lg px-3 py-2 text-muted-fg transition-colors hover:bg-white/5 hover:text-gray-200"
              @click="cancelJoystickEdit"
            >
              Cancel
            </button>
            <button
              v-else-if="voice.runtime.joystick"
              type="button"
              data-voice-joystick-remove
              class="min-h-10 rounded-lg px-3 py-2 text-muted-fg transition-colors hover:bg-white/5 hover:text-gray-200 disabled:opacity-50"
              :disabled="recognitionOff || joystickSaving || captureLocked"
              @click="removeJoystick"
            >
              Remove
            </button>
            <span
              v-if="voice.runtime.joystick && !joystickLearning"
              class="text-[11px]"
              :class="voice.runtime.joystickConnected ? 'text-emerald-300' : 'text-amber-300'"
              data-voice-joystick-connection
            >
              {{ voice.runtime.joystickConnected ? 'Connected' : 'Not connected' }}
            </span>
          </div>
          <p id="voice-ptt-joystick-help" class="text-[11px] text-muted-fg">{{ joystickHelp }}</p>
          <p v-if="joystickError" id="voice-ptt-joystick-error" class="text-[11px] text-amber-300" role="alert">
            {{ joystickError }}
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
