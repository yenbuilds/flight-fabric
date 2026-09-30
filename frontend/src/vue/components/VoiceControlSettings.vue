<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { shortcutFromKeyboardEvent } from '../../voice/shortcut-recorder.js';
import { describeJoystickBinding } from '../../voice/joystick-binding.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
import KeyboardShortcutKeys from './KeyboardShortcutKeys.vue';
import SettingsSectionWatermark from './SettingsSectionWatermark.vue';
import VoiceSetupTest from './VoiceSetupTest.vue';

const voice = useVoiceControlStore();
const tabs = useTabsStore();
const shortcutDraft = ref(voice.runtime.shortcut);
const shortcutRecording = ref(false);
const shortcutSaving = ref(false);
const shortcutError = ref('');
const recognitionSaving = ref(false);
const recognitionError = ref('');
const joystickDraft = ref(voice.runtime.joystick);
const joystickSaving = ref(false);
const joystickError = ref('');

const captureLocked = computed(() => voice.listening || voice.finishing || voice.voiceTestBusy);
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

const selectedInputMissing = computed(() => Boolean(voice.selectedInputDeviceId)
  && !voice.inputDevices.some((device) => device.deviceId === voice.selectedInputDeviceId));

watch(() => voice.runtime.shortcut, (value) => {
  shortcutDraft.value = value;
  shortcutRecording.value = false;
  shortcutError.value = '';
});
watch(() => voice.runtime.enabled, () => { recognitionError.value = ''; });
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


function beginShortcutRecording() {
  if (recognitionOff.value || captureLocked.value || shortcutSaving.value) return;
  shortcutRecording.value = true;
  shortcutError.value = '';
}

async function restoreShortcutFocus(origin) {
  if (!origin) return;
  await nextTick();
  if (tabs.activeTabId !== 'settings') return;
  // Save/Cancel may disappear. Keep keyboard position without taking focus
  // back from another control or a dialog opened during an asynchronous save.
  if (document.activeElement !== document.body && document.activeElement !== origin) return;
  const recorder = document.getElementById('voice-ptt-shortcut');
  if (recorder?.getClientRects().length && !recorder.disabled && !recorder.closest('[inert]')) {
    recorder.focus({ preventScroll: true });
  }
}

function cancelShortcutEdit(event) {
  if (shortcutSaving.value) return;
  shortcutDraft.value = voice.runtime.shortcut;
  shortcutRecording.value = false;
  shortcutError.value = '';
  void restoreShortcutFocus(event?.currentTarget);
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
async function saveShortcut(event) {
  if (recognitionOff.value || captureLocked.value || !shortcutDirty.value || shortcutRecording.value || shortcutSaving.value) return;
  shortcutSaving.value = true;
  shortcutError.value = '';
  const saved = await voice.setShortcut(shortcutDraft.value);
  if (!saved) shortcutError.value = 'That shortcut could not be registered. Choose another combination.';
  shortcutSaving.value = false;
  await restoreShortcutFocus(event?.submitter);
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

// Settings stays mounted so an unsaved shortcut survives changing pages.
// Stop active input learning when its controls are no longer visible.
function stopLearning() {
  shortcutRecording.value = false;
  if (joystickLearning.value) void voice.stopJoystickLearn();
}
watch(() => [tabs.activeTabId, voice.runtime.enabled], ([tab, enabled]) => {
  if (tab !== 'settings' || !enabled) stopLearning();
});
onBeforeUnmount(stopLearning);
async function backToAircraft() {
  if (!tabs.requestTabChange('autopilot')) return;
  voice.settingsReturnToAircraft = false;
  await nextTick();
  document.querySelector('[data-aircraft-voice-control-trigger]')?.focus({ preventScroll: true });
}
async function toggleRecognition(event) {
  const target = event.currentTarget;
  const nextEnabled = target?.checked === true;
  recognitionSaving.value = true;
  recognitionError.value = '';
  const changed = await voice.setRecognitionEnabled(nextEnabled);
  if (!changed) {
    if (target) target.checked = voice.runtime.enabled === true;
    recognitionError.value = voice.status === 'error' && voice.statusText
      ? voice.statusText : 'Voice control could not be updated. Try again.';
  }
  recognitionSaving.value = false;
}
function selectMicrophone(event) { voice.selectInputDevice(event.currentTarget?.value || ''); }
function toggleSpokenReadbacks(event) { voice.toggleSpokenReadbacks(event.currentTarget?.checked === true); }

</script>

<template>
  <section id="settings-voice-control" class="settings-panel settings-panel--illustrated scroll-mt-4" aria-labelledby="settings-voice-title" tabindex="-1">
    <SettingsSectionWatermark kind="audio" />
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">On this PC</div>
        <h3 id="settings-voice-title" class="settings-panel-title">Voice control</h3>
        <p class="mt-2 text-sm text-muted-fg">Choose your microphone, push-to-talk shortcut and spoken feedback.</p>
      </div>
      <button v-if="voice.settingsReturnToAircraft" type="button" class="ff-button-secondary text-xs" data-voice-back-to-aircraft @click="backToAircraft">Back to Aircraft</button>
    </div>
    <div class="mt-4 max-w-3xl">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <label class="flex min-h-9 cursor-pointer items-center gap-2 text-xs font-medium text-fg" data-voice-recognition-toggle>
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
            :class="voice.runtime.enabled ? 'border-accent/60 bg-accent/35' : 'border-border bg-muted'"
            aria-hidden="true"
          >
            <span
              class="absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-gray-200 transition-transform"
              :class="voice.runtime.enabled ? 'translate-x-4' : 'translate-x-0'"
            ></span>
          </span>
          <span>{{ recognitionSaving ? 'Updating voice control' : 'Enable voice control' }}</span>
        </label>


        <span class="text-xs text-muted-fg">{{ voice.runtime.enabled ? 'On' : 'Off' }}</span>
      </div>
      <p class="mt-3 text-xs text-muted-fg">Voice changes apply immediately on this PC. Use Save shortcut to activate a new key combination.</p>
      <p v-if="recognitionError" class="mt-3 text-sm text-warning" data-voice-recognition-error role="alert">{{ recognitionError }}</p>
      <p v-if="voice.status === 'initializing'" class="mt-3 text-xs text-muted-fg" role="status">Starting offline voice control…</p>
      <p v-else-if="voice.runtime.enabled && !voice.runtime.available" class="mt-3 text-sm text-warning" role="status">{{ voice.runtime.error || 'Voice could not start. Try turning voice off and on again.' }}</p>
      <div class="mt-5 grid gap-5">
        <div class="min-w-0">
          <label for="voice-input-device" class="mb-1.5 block text-muted-fg">Microphone</label>
          <div class="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <select
              id="voice-input-device"
              class="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-panel-subtle px-3 py-2 text-fg disabled:opacity-50"
              :value="voice.selectedInputDeviceId"
              :aria-describedby="voice.inputDevicesError ? 'voice-microphone-error' : undefined"
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
              data-voice-detect-microphones
              class="min-h-10 rounded-lg border border-border px-3 py-2 text-fg transition-colors hover:bg-muted disabled:opacity-50"
              :disabled="recognitionOff || captureLocked"
              @click="voice.refreshInputDevices({ requestAccess: true })"
            >
              Detect microphones
            </button>
          </div>
          <p v-if="voice.inputDevicesError" id="voice-microphone-error" class="mt-2 text-xs text-warning" data-voice-microphone-error role="alert">{{ voice.inputDevicesError }}</p>
        </div>

        <VoiceSetupTest :disabled="recognitionSaving || shortcutRecording || shortcutSaving || joystickLearning || joystickSaving" />

        <div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label class="flex min-h-10 shrink-0 cursor-pointer items-center gap-2 text-fg" title="Speaks command results using an installed local voice. Online voices are never selected.">
            <input
              class="peer sr-only"
              type="checkbox"
              role="switch"
              :checked="voice.spokenReadbacks"
              data-voice-spoken-feedback
              :disabled="captureLocked"
              @change="toggleSpokenReadbacks"
            >
            <span
              class="relative h-5 w-9 shrink-0 rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-100"
              :class="voice.spokenReadbacks ? 'border-accent/60 bg-accent/35' : 'border-border bg-muted'"
              aria-hidden="true"
            >
              <span
                class="absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-gray-200 transition-transform"
                :class="voice.spokenReadbacks ? 'translate-x-4' : 'translate-x-0'"
              ></span>
            </span>
            <span>Spoken feedback</span>
          </label>
          <button type="button" class="ff-button-secondary text-xs disabled:opacity-50" data-voice-test-feedback
            :disabled="captureLocked || recognitionSaving || voice.status === 'sending'" @click="voice.testSpokenFeedback">Test spoken feedback</button>
          </div>
          <p v-if="voice.voiceTest.feedbackMessage" class="mt-2 text-xs text-muted-fg" role="status">{{ voice.voiceTest.feedbackMessage }}</p>
          <p v-if="voice.runtime.readbackError" class="text-[11px] text-warning" data-voice-readback-error>
            Last spoken readback failed: {{ voice.runtime.readbackError }} Windows speech uses the default output device.
          </p>
        </div>

        <form class="flex flex-col gap-1.5" @submit.prevent="saveShortcut">
          <label for="voice-ptt-shortcut" class="shrink-0 text-muted-fg">Push-to-talk shortcut</label>
          <div class="flex flex-wrap items-center gap-2">
            <button
              id="voice-ptt-shortcut"
              type="button"
              data-voice-shortcut-recorder
              class="min-h-10 min-w-40 max-w-full rounded-lg border px-3 py-2 text-left font-mono transition-colors disabled:opacity-50"
              :class="shortcutRecording ? 'border-accent/70 bg-accent/10 text-fg' : 'border-border bg-panel-subtle text-fg hover:bg-muted'"
              :disabled="recognitionOff || captureLocked || shortcutSaving"
              :aria-label="shortcutRecording
                ? 'Press the new push-to-talk shortcut'
                : shortcutDirty
                  ? `Unsaved push-to-talk shortcut: ${shortcutDraft}. Save shortcut to use it.`
                : shortcutDraft
                  ? `Current push-to-talk shortcut: ${shortcutDraft}. Click to change.`
                  : 'No global push-to-talk shortcut is set. Click to record one.'"
              aria-describedby="voice-ptt-shortcut-help voice-ptt-shortcut-error"
              @click="beginShortcutRecording"
              @keydown="captureShortcut"
            >
              <KeyboardShortcutKeys v-if="!shortcutRecording && shortcutDraft" :shortcut="shortcutDraft" aria-hidden="true" />
              <span v-else>{{ shortcutRecording ? 'Press shortcut…' : 'Set shortcut' }}</span>
            </button>
            <button
              v-if="shortcutDirty"
              type="submit"
              data-voice-shortcut-save
              class="min-h-10 rounded-lg border border-border px-3 py-2 text-fg transition-colors hover:bg-muted disabled:opacity-50"
              :disabled="recognitionOff || shortcutRecording || shortcutSaving || captureLocked"
            >
              {{ shortcutSaving ? 'Saving…' : 'Save shortcut' }}
            </button>
            <button
              v-if="shortcutRecording || shortcutDirty"
              type="button"
              class="min-h-10 rounded-lg px-3 py-2 text-muted-fg transition-colors hover:bg-muted hover:text-fg disabled:opacity-50"
              :disabled="shortcutSaving"
              data-voice-shortcut-cancel
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
              : shortcutSaving
                ? 'Saving shortcut…'
              : shortcutDirty
                ? 'Not saved yet. Click Save shortcut to use it.'
              : shortcutDraft
                ? 'Click the shortcut to record a new key combination.'
                : 'No global shortcut is active. Set one to talk while MSFS is in front, or use the on-screen button on Aircraft.' }}
          </p>
          <p v-if="shortcutError" id="voice-ptt-shortcut-error" class="text-[11px] text-warning" role="alert">
            {{ shortcutError }}
          </p>
          <p v-if="voice.runtime.enabled && voice.runtime.shortcut && !voice.runtime.shortcutRegistered" class="text-xs text-warning" role="status">
            Saved shortcut unavailable: {{ voice.runtime.shortcutError || 'Choose another key combination.' }}
          </p>
        </form>

        <form v-if="voice.runtime.joystickAvailable" class="flex flex-col gap-1.5" data-voice-joystick-binding @submit.prevent="saveJoystick">
          <label for="voice-ptt-joystick" class="shrink-0 text-muted-fg">Joystick push-to-talk button</label>
          <div class="flex flex-wrap items-center gap-2">
            <button
              id="voice-ptt-joystick"
              type="button"
              data-voice-joystick-recorder
              class="min-h-10 min-w-40 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50"
              :class="joystickLearning ? 'border-accent/70 bg-accent/10 text-fg' : 'border-border bg-panel-subtle text-fg hover:bg-muted'"
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
              class="min-h-10 rounded-lg border border-border px-3 py-2 text-fg transition-colors hover:bg-muted disabled:opacity-50"
              :disabled="recognitionOff || joystickLearning || joystickSaving || captureLocked"
            >
              {{ joystickSaving ? 'Saving…' : 'Save' }}
            </button>
            <button
              v-if="joystickLearning || joystickDirty"
              type="button"
              class="min-h-10 rounded-lg px-3 py-2 text-muted-fg transition-colors hover:bg-muted hover:text-fg"
              @click="cancelJoystickEdit"
            >
              Cancel
            </button>
            <button
              v-else-if="voice.runtime.joystick"
              type="button"
              data-voice-joystick-remove
              class="min-h-10 rounded-lg px-3 py-2 text-muted-fg transition-colors hover:bg-muted hover:text-fg disabled:opacity-50"
              :disabled="recognitionOff || joystickSaving || captureLocked"
              @click="removeJoystick"
            >
              Remove
            </button>
            <span
              v-if="voice.runtime.joystick && !joystickLearning"
              class="text-[11px]"
              :class="voice.runtime.joystickConnected ? 'text-success' : 'text-warning'"
              data-voice-joystick-connection
            >
              {{ voice.runtime.joystickConnected ? 'Connected' : 'Not connected' }}
            </span>
          </div>
          <p id="voice-ptt-joystick-help" class="text-[11px] text-muted-fg">{{ joystickHelp }}</p>
          <p v-if="joystickError" id="voice-ptt-joystick-error" class="text-[11px] text-warning" role="alert">
            {{ joystickError }}
          </p>
        </form>
        <p class="text-[11px] text-muted-fg">
          After release, the microphone remains active briefly to preserve the end of your speech, then closes after buffered audio is flushed. Audio remains local and is not saved.
        </p>
      </div>

    </div>
  </section>
</template>
