<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { shortcutFromKeyboardEvent } from '../../voice/shortcut-recorder.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
import KeyboardShortcutKeys from './KeyboardShortcutKeys.vue';
import SettingsSectionWatermark from './SettingsSectionWatermark.vue';
import VoiceSetupTest from './VoiceSetupTest.vue';
import ControllerButtonSettings from './ControllerButtonSettings.vue';
import CloudVoiceSettings from './CloudVoiceSettings.vue';

const voice = useVoiceControlStore();
const tabs = useTabsStore();
const shortcutDraft = ref(voice.runtime.shortcut);
const shortcutRecording = ref(false);
const shortcutUnchanged = ref(false);
const shortcutSaving = ref(false);
const shortcutError = ref('');
const recognitionSaving = ref(false);
const recognitionError = ref('');
const configurationOpen = ref(false);
const microphonesBusy = ref(false);
const modeSummary = computed(() => voice.runtime.mode === 'cloud'
  ? `Cloud · ${voice.runtime.cloud.providerLabel} · ${voice.runtime.cloud.keyConfigured ? 'Key saved' : 'Key needed'}`
  : 'Offline · On this PC');
const microphoneSummary = computed(() => voice.inputDevices.find(device => device.deviceId === voice.selectedInputDeviceId)?.label
  || (voice.selectedInputDeviceId ? 'Previously selected microphone' : 'Windows default input'));

async function detectMicrophones() {
  microphonesBusy.value = true;
  try { await voice.refreshInputDevices({ requestAccess: true }); }
  finally { microphonesBusy.value = false; }
}

async function openTest() {
  configurationOpen.value = true;
  await nextTick();
  const target = document.querySelector('#settings-voice-control [data-voice-test]');
  if (tabs.activeTabId === 'settings' && target?.getClientRects().length) {
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
}

const captureLocked = computed(() => voice.listening || voice.finishing || voice.voiceTestBusy || voice.controllerSetup.active);
const recognitionOff = computed(() => voice.runtime.enabled !== true);
const shortcutDirty = computed(() => Boolean(shortcutDraft.value)
  && shortcutDraft.value !== voice.runtime.shortcut);
const selectedInputMissing = computed(() => Boolean(voice.selectedInputDeviceId)
  && !voice.inputDevices.some((device) => device.deviceId === voice.selectedInputDeviceId));
const unassignedShortcutHelp = computed(() => {
  if (!voice.runtime.controllerEnabled) return 'No global shortcut is active. Set one to talk while MSFS is in front, or use the on-screen button on Aircraft.';
  if (voice.runtime.controller.binding) return 'A keyboard shortcut is optional. Your controller button is configured; the on-screen button on Aircraft is also available.';
  return 'Choose a keyboard shortcut or set a yoke or joystick button to talk while MSFS is in front. You can also use the on-screen button on Aircraft.';
});

watch(() => voice.runtime.shortcut, (value) => {
  shortcutDraft.value = value;
  shortcutRecording.value = false;
  shortcutUnchanged.value = false;
  shortcutError.value = '';
});
watch(() => voice.runtime.enabled, () => { recognitionError.value = ''; });

function beginShortcutRecording() {
  if (recognitionOff.value || captureLocked.value || shortcutSaving.value) return;
  shortcutRecording.value = true;
  shortcutUnchanged.value = false;
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
  shortcutUnchanged.value = false;
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
  shortcutUnchanged.value = captured.accelerator === voice.runtime.shortcut;
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

// Settings stays mounted so an unsaved shortcut survives changing pages.
// Stop active input learning when its controls are no longer visible.
function stopLearning() {
  shortcutRecording.value = false;
  shortcutUnchanged.value = false;
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
  <section id="settings-voice-control" data-settings-section class="settings-panel settings-panel--illustrated scroll-mt-4" aria-labelledby="settings-voice-title" tabindex="-1" @settings-reveal="configurationOpen = true">
    <SettingsSectionWatermark kind="audio" />
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="settings-panel-header">
        <div class="settings-panel-kicker">On this PC</div>
        <h3 id="settings-voice-title" class="settings-panel-title">Voice control</h3>
        <p class="settings-section-description">Choose your microphone, how to talk and spoken feedback. Voice preferences apply immediately on this PC.</p>
      </div>
      <button v-if="voice.settingsReturnToAircraft" type="button" class="ff-button-secondary text-xs" data-voice-back-to-aircraft @click="backToAircraft">Back to Aircraft</button>
    </div>
    <div>
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
      <div class="settings-voice-summary">
        <div class="min-w-0">
          <p class="text-sm text-fg">{{ modeSummary }}</p>
          <p class="settings-section-description">{{ microphoneSummary }}<template v-if="voice.runtime.shortcut"> · {{ voice.runtime.shortcut }}</template></p>
        </div>
        <div class="settings-summary-actions">
          <button type="button" class="ff-button-secondary text-sm" data-voice-configuration-toggle
            :aria-expanded="configurationOpen" aria-controls="voice-settings-configuration"
            :disabled="captureLocked || shortcutRecording || shortcutDirty || shortcutSaving || recognitionSaving || microphonesBusy"
            @click="configurationOpen = !configurationOpen">{{ configurationOpen ? 'Hide setup' : voice.runtime.enabled ? 'Change settings' : 'Set up voice' }}</button>
          <button type="button" class="ff-button-secondary text-sm" data-voice-open-test @click="openTest">Test voice</button>
        </div>
      </div>
      <p v-if="recognitionError" class="mt-3 text-sm text-warning" data-voice-recognition-error role="alert">{{ recognitionError }}</p>
      <p v-if="voice.status === 'initializing'" class="mt-3 text-xs text-muted-fg" role="status">Starting voice control…</p>
      <p v-else-if="voice.runtime.enabled && !voice.runtime.available" class="mt-3 text-sm text-warning" role="status">{{ voice.runtime.error || 'Voice could not start. Try turning voice off and on again.' }}</p>
      <div id="voice-settings-configuration" v-show="configurationOpen">
        <p class="mt-3 text-xs text-muted-fg">{{ voice.runtime.controllerEnabled
          ? 'Voice preferences apply immediately on this PC. Use Save shortcut or Save button to confirm a new way to talk.'
          : 'Voice changes apply immediately on this PC. Use Save shortcut to activate a new key combination.' }}</p>
        <CloudVoiceSettings :disabled="captureLocked || recognitionSaving || voice.status === 'sending'" />
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
                :disabled="recognitionOff || captureLocked || microphonesBusy"
                @click="detectMicrophones"
              >
                Detect microphones
              </button>
            </div>
            <p v-if="voice.inputDevicesError" id="voice-microphone-error" class="mt-2 text-xs text-warning" data-voice-microphone-error role="alert">{{ voice.inputDevicesError }}</p>
          </div>

          <section aria-labelledby="voice-ptt-title" data-voice-ptt-settings>
            <h4 id="voice-ptt-title" class="mb-3 text-base font-semibold text-fg">Push-to-talk</h4>
            <div class="grid min-w-0 gap-3" :class="voice.runtime.controllerEnabled ? 'lg:grid-cols-2' : ''">
              <form class="settings-panel--illustrated flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-panel-subtle p-4" aria-labelledby="voice-keyboard-title" @submit.prevent="saveShortcut">
                <SettingsSectionWatermark kind="keyboard" />
                <h5 id="voice-keyboard-title" class="text-sm font-semibold text-fg"><label for="voice-ptt-shortcut">Keyboard shortcut</label></h5>
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
                <p id="voice-ptt-shortcut-help" class="text-[11px] text-muted-fg" role="status">
                  {{ recognitionOff
                    ? 'Enable voice control before setting a global shortcut.'
                    : shortcutRecording
                    ? 'Hold one or more modifiers, then press a key. Escape cancels.'
                    : shortcutSaving
                      ? 'Saving shortcut…'
                    : shortcutDirty
                      ? 'Not saved yet. Click Save shortcut to use it.'
                    : shortcutUnchanged
                      ? 'This is already your saved shortcut. No changes to save.'
                    : shortcutDraft
                      ? 'Click the shortcut to record a new key combination.'
                      : unassignedShortcutHelp }}
                </p>
                <p v-if="shortcutError" id="voice-ptt-shortcut-error" class="text-[11px] text-warning" role="alert">
                  {{ shortcutError }}
                </p>
                <p v-if="voice.runtime.enabled && !voice.controllerSetup.active && voice.runtime.shortcut && !voice.runtime.shortcutRegistered" class="text-xs text-warning" role="status">
                  Saved shortcut unavailable: {{ voice.runtime.shortcutError || 'Choose another key combination.' }}
                </p>
              </form>

              <ControllerButtonSettings v-if="voice.runtime.controllerEnabled" :disabled="recognitionSaving || shortcutRecording || shortcutSaving || voice.listening || voice.finishing || voice.voiceTestBusy" />
            </div>

            <p class="mt-3 text-[11px] text-muted-fg">
              After release, the microphone remains active briefly to preserve the end of your speech, then closes after buffered audio is flushed. {{ voice.runtime.mode === 'cloud' ? `Cloud preview sends the audio and supported aircraft controls to ${voice.runtime.cloud.providerLabel} using your API key.` : 'Audio remains local and is not saved.' }}
            </p>
          </section>

          <VoiceSetupTest :disabled="recognitionSaving || shortcutRecording || shortcutSaving || voice.controllerSetup.active" />

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
        </div>

      </div>
    </div>
  </section>
</template>
