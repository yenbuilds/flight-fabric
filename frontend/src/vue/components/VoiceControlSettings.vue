<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createShortcutRecorder, SINGLE_MODIFIER_SHORTCUTS } from '../../voice/shortcut-recorder.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
import KeyboardShortcutKeys from './KeyboardShortcutKeys.vue';
import SettingsSectionWatermark from './SettingsSectionWatermark.vue';
import SetupIllustration from './SetupIllustration.vue';
import VoiceButtonTest from './VoiceButtonTest.vue';
import VoiceSetupTest from './VoiceSetupTest.vue';
import ControllerButtonSettings from './ControllerButtonSettings.vue';
import CloudVoiceSettings from './CloudVoiceSettings.vue';
import VoiceRestartHint from './VoiceRestartHint.vue';

const voice = useVoiceControlStore();
const tabs = useTabsStore();
const shortcutDraft = ref(voice.runtime.shortcut);
const shortcutRecording = ref(false);
const shortcutRecorder = createShortcutRecorder();
const shortcutPreparing = ref(false);
const shortcutLease = ref(false);
let shortcutEditRevision = 0;
const shortcutUnchanged = ref(false);
const shortcutSaving = ref(false);
const shortcutRemoving = ref(false);
const shortcutNotice = ref('');
const shortcutError = ref('');
const recognitionSaving = computed(() => voice.recognitionChanging);
const recognitionError = ref('');
const readbackSelectionError = ref('');
let readbackSelectionRevision = 0;
async function changeReadbackEngine(event) {
  const revision = ++readbackSelectionRevision;
  readbackSelectionError.value = '';
  const saved = await voice.setReadbackEngine(event.target.value);
  if (revision !== readbackSelectionRevision) return;
  if (!saved) readbackSelectionError.value = 'The voice choice could not be saved. Try again.';
  event.target.value = voice.runtime.readback.selectedEngine;
}
async function changeReadbackVoice(event) {
  const revision = ++readbackSelectionRevision;
  readbackSelectionError.value = '';
  const saved = await voice.setReadbackVoice(voice.runtime.readback.selectedEngine, event.target.value);
  if (revision !== readbackSelectionRevision) return;
  if (!saved) readbackSelectionError.value = 'The voice choice could not be saved. Try again.';
  event.target.value = voice.runtime.readback.selectedVoice;
}
const configurationOpen = ref(false);
const microphoneOpen = ref(false);
const inputChoice = ref(voice.runtime.controllerEnabled && voice.runtime.controller?.binding ? 'controller' : voice.runtime.shortcut ? 'keyboard' : 'screen');
const inputChoices = computed(() => [
  { id: 'screen', kind: 'touch', label: 'On screen' },
  { id: 'keyboard', kind: 'keyboard', label: 'Keyboard' },
  ...(voice.runtime.controllerEnabled ? [{ id: 'controller', kind: 'controller', label: 'Yoke or joystick' }] : []),
]);
let inputChoiceTouched = false;
function chooseInput(value) { inputChoiceTouched = true; inputChoice.value = value; }
watch(() => [voice.runtime.shortcut, voice.runtime.controller?.binding, voice.runtime.controllerEnabled], () => {
  if (!inputChoiceTouched) inputChoice.value = voice.runtime.controllerEnabled && voice.runtime.controller?.binding ? 'controller' : voice.runtime.shortcut ? 'keyboard' : 'screen';
  if (!voice.runtime.controllerEnabled && inputChoice.value === 'controller') inputChoice.value = 'screen';
});
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
  const origin = document.activeElement;
  configurationOpen.value = true;
  await nextTick();
  const target = document.querySelector('#settings-voice-control [data-voice-test]');
  if (tabs.activeTabId === 'settings' && target?.getClientRects().length) {
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (document.activeElement === origin || document.activeElement === document.body) {
      (target.querySelector('[data-voice-test-start]:not(:disabled)') || target.querySelector('h4'))?.focus({ preventScroll: true });
    }
  }
}

const captureLocked = computed(() => voice.listening || voice.finishing || voice.voiceTestBusy || voice.controllerSetup.active);
const shortcutSetupBusy = computed(() => shortcutPreparing.value || shortcutLease.value || voice.shortcutRecording.active);
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
  shortcutRecorder.reset();
  shortcutDraft.value = value;
  shortcutRecording.value = false;
  shortcutUnchanged.value = false;
  shortcutNotice.value = '';
  shortcutError.value = '';
});
watch(() => [voice.runtime.enabled, voice.recognitionChangeId], () => { recognitionError.value = ''; });

async function beginShortcutRecording() {
  if (recognitionOff.value || captureLocked.value || shortcutSaving.value || shortcutPreparing.value) return;
  shortcutRecorder.reset();
  const revision = ++shortcutEditRevision;
  shortcutUnchanged.value = false;
  shortcutNotice.value = '';
  shortcutError.value = '';
  if (shortcutLease.value) { shortcutRecording.value = true; return; }
  shortcutPreparing.value = true;
  let started = false;
  try { started = await voice.beginShortcutRecording(); } catch {}
  if (revision !== shortcutEditRevision) return;
  shortcutPreparing.value = false;
  shortcutLease.value = started === true;
  shortcutRecording.value = started === true;
  if (!started) shortcutError.value = 'Push-to-talk could not pause for shortcut setup. Try again.';
}

async function restoreShortcutFocus(origin) {
  if (!origin) return;
  await nextTick();
  if (tabs.activeTabId !== 'settings') return;
  // Save/Cancel/Remove may disappear. Keep keyboard position without taking focus
  // back from another control or a dialog opened during an asynchronous save.
  if (document.activeElement !== document.body && document.activeElement !== origin) return;
  const target = [document.getElementById('voice-ptt-shortcut'),
    document.querySelector('[data-voice-input-choice="keyboard"]')]
    .find(element => element?.getClientRects().length && !element.disabled && !element.closest('[inert]'));
  target?.focus({ preventScroll: true });
}

function cancelShortcutEdit(event) {
  if (shortcutSaving.value) return;
  shortcutDraft.value = voice.runtime.shortcut;
  void stopLearning();
  shortcutError.value = '';
  void restoreShortcutFocus(event?.currentTarget);
}
function captureShortcut(event) {
  if (!shortcutRecording.value) return;
  if (event.isComposing) { shortcutRecorder.reset(); return; }
  if (event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape'
    && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    cancelShortcutEdit();
    return;
  }

  applyCapturedShortcut(shortcutRecorder.keyDown(event));
}
function captureShortcutRelease(event) {
  if (!shortcutRecording.value) return;
  event.preventDefault();
  event.stopPropagation();
  applyCapturedShortcut(shortcutRecorder.keyUp(event));
}
function applyCapturedShortcut(captured) {
  if (captured.reason === 'waiting-for-key') return;
  if (captured.reason === 'unsupported-key') {
    shortcutError.value = 'That key cannot be used for push-to-talk. Try Caps Lock, a letter, number, F-key, or navigation key.';
    return;
  }

  shortcutDraft.value = captured.accelerator;
  shortcutRecorder.reset();
  shortcutRecording.value = false;
  shortcutUnchanged.value = captured.accelerator === voice.runtime.shortcut;
  shortcutError.value = '';
}
function selectModifierShortcut(event) {
  if (!shortcutLease.value || shortcutSaving.value || recognitionOff.value || captureLocked.value) return;
  const accelerator = event.currentTarget?.value;
  if (!SINGLE_MODIFIER_SHORTCUTS.includes(accelerator)) return;
  event.currentTarget.value = '';
  applyCapturedShortcut({ accelerator, reason: '' });
}
async function saveShortcut(event) {
  if (recognitionOff.value || captureLocked.value || !shortcutDirty.value || shortcutRecording.value || shortcutSaving.value) return;
  shortcutSaving.value = true;
  shortcutError.value = '';
  try {
    if (!await voice.setShortcut(shortcutDraft.value)) shortcutError.value = 'That shortcut could not be registered. Choose another key or combination.';
  } catch {
    shortcutError.value = 'That shortcut could not be registered. Choose another key or combination.';
  } finally {
    await stopLearning();
    shortcutSaving.value = false;
  }
  await restoreShortcutFocus(event?.submitter);
}

async function removeShortcut(event) {
  if (captureLocked.value || recognitionSaving.value || shortcutSaving.value
    || shortcutSetupBusy.value || shortcutDirty.value || !voice.runtime.shortcut) return;
  const origin = event?.currentTarget;
  // Keep the confirmation visible when removing the last saved binding.
  inputChoiceTouched = true;
  shortcutSaving.value = true;
  shortcutRemoving.value = true;
  shortcutNotice.value = '';
  shortcutError.value = '';
  try {
    if (!await voice.setShortcut('')) shortcutError.value = 'The keyboard shortcut could not be removed. Try again.';
    else if (!voice.runtime.shortcut) shortcutNotice.value = 'Keyboard shortcut removed.';
  } catch {
    shortcutError.value = 'The keyboard shortcut could not be removed. Try again.';
  } finally {
    shortcutRemoving.value = false;
    shortcutSaving.value = false;
  }
  await restoreShortcutFocus(origin);
}

// Settings stays mounted so an unsaved shortcut survives changing pages.
// Stop active input learning when its controls are no longer visible.
function stopLearning() {
  shortcutRecorder.reset();
  shortcutEditRevision++;
  shortcutRecording.value = false;
  shortcutPreparing.value = false;
  shortcutLease.value = false;
  shortcutUnchanged.value = false;
  return voice.endShortcutRecording();
}
function shortcutFocusOut(event) {
  if (shortcutSaving.value || event.currentTarget?.contains(event.relatedTarget)) return;
  void stopLearning();
}
function shortcutWindowBlur() { if (!shortcutSaving.value) void stopLearning(); }
watch(() => [tabs.activeTabId, voice.runtime.enabled], ([tab, enabled]) => {
  if (tab !== 'settings' || !enabled) stopLearning();
});
watch(() => voice.shortcutRecording.active, (active) => { if (!active && shortcutLease.value) void stopLearning(); });
onMounted(() => globalThis.addEventListener?.('blur', shortcutWindowBlur));
onBeforeUnmount(() => { globalThis.removeEventListener?.('blur', shortcutWindowBlur); void stopLearning(); });
async function backToAircraft() {
  if (!tabs.requestTabChange('autopilot')) return;
  voice.settingsReturnToAircraft = false;
  await nextTick();
  [document.querySelector('[data-aircraft-voice-setup]'), document.querySelector('[data-aircraft-voice-control-trigger]'), document.querySelector('.aircraft-tools-toggle'),
    document.getElementById('vue-main-root')]
    .find(element => element?.getClientRects().length && !element.closest('[inert]'))?.focus({ preventScroll: true });
}
async function toggleRecognition(event) {
  const target = event.currentTarget;
  const nextEnabled = target?.checked === true;
  recognitionError.value = '';
  const pending = voice.setRecognitionEnabled(nextEnabled);
  const changeId = voice.recognitionChangeId;
  const changed = await pending;
  if (changeId !== voice.recognitionChangeId) return;
  if (!changed) {
    if (target) target.checked = voice.runtime.enabled === true;
    recognitionError.value = voice.status === 'error' && voice.statusText
      ? voice.statusText : 'Voice control could not be updated. Try again.';
  }
}
function selectMicrophone(event) { voice.selectInputDevice(event.currentTarget?.value || ''); }
function toggleSpokenReadbacks(event) { voice.toggleSpokenReadbacks(event.currentTarget?.checked === true); }

</script>

<template>
  <section id="settings-voice-control" data-settings-section class="settings-panel settings-panel--illustrated scroll-mt-4" aria-labelledby="settings-voice-title" tabindex="-1" @settings-reveal="configurationOpen = true">
    <SettingsSectionWatermark kind="audio" />
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="settings-panel-header">
        <h3 id="settings-voice-title" class="settings-panel-title">Voice control</h3>
        <p class="settings-section-description">Test your microphone and set up push-to-talk.</p>
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
            :disabled="captureLocked || shortcutSetupBusy || shortcutDirty || shortcutSaving || recognitionSaving || microphonesBusy"
            @click="configurationOpen = !configurationOpen">{{ configurationOpen ? 'Hide setup' : voice.runtime.enabled ? 'Change settings' : 'Set up voice' }}</button>
          <button v-if="!configurationOpen && voice.runtime.enabled" type="button" class="ff-button-secondary text-sm" data-voice-open-test @click="openTest">Test microphone</button>
        </div>
      </div>
      <p v-if="recognitionError" class="mt-3 text-sm text-warning" data-voice-recognition-error role="alert">{{ recognitionError }}</p>
      <p v-if="voice.status === 'initializing'" class="mt-3 text-xs text-muted-fg" role="status">Starting voice control…</p>
      <p v-else-if="voice.runtime.enabled && !voice.runtime.available" class="mt-3 text-sm text-warning" role="status">{{ voice.runtime.error || 'Voice could not start. Try turning voice off and on again.' }}</p>
      <VoiceRestartHint />
      <div id="voice-settings-configuration" v-show="configurationOpen">
        <div class="voice-setup-grid mt-5">
          <div class="grid min-w-0 gap-8">
            <VoiceSetupTest :disabled="recognitionSaving || shortcutSetupBusy || shortcutSaving || voice.controllerSetup.active">
            <div class="voice-microphone-selection min-w-0">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="text-xs text-muted-fg">Microphone · {{ microphoneSummary }}</p>
                <button type="button" class="ff-button-secondary text-xs" :aria-expanded="microphoneOpen" aria-controls="voice-microphone-options" :disabled="captureLocked || microphonesBusy" @click="microphoneOpen = !microphoneOpen">Change microphone</button>
              </div>
              <div id="voice-microphone-options" v-show="microphoneOpen || voice.inputDevicesError" class="mt-3">
              <label for="voice-input-device" class="mb-1.5 block text-muted-fg">Microphone</label>
              <div class="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <select
                  id="voice-input-device"
                  class="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-panel-subtle px-3 py-2 text-fg disabled:opacity-50"
                  :value="voice.selectedInputDeviceId"
                  :aria-describedby="voice.inputDevicesError ? 'voice-microphone-error' : undefined"
                  :disabled="recognitionOff || captureLocked || shortcutSetupBusy"
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
                  :disabled="recognitionOff || captureLocked || shortcutSetupBusy || microphonesBusy"
                  @click="detectMicrophones"
                >
                  Detect microphones
                </button>
              </div>
              <p v-if="voice.inputDevicesError" id="voice-microphone-error" class="mt-2 text-xs text-warning" data-voice-microphone-error role="alert">{{ voice.inputDevicesError }}</p>
              </div>
            </div>
            </VoiceSetupTest>

            <section class="voice-feedback-settings" aria-labelledby="voice-feedback-title">
              <h4 id="voice-feedback-title" class="mb-3 text-sm font-semibold text-fg">Recognition &amp; spoken feedback</h4>
              <CloudVoiceSettings :disabled="captureLocked || shortcutSetupBusy || recognitionSaving || voice.status === 'sending'" />
            <div>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label class="flex min-h-10 shrink-0 cursor-pointer items-center gap-2 text-fg" title="Speaks command results entirely offline on this PC.">
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
              <div v-if="voice.runtime.readback.engines.length" class="mt-3 max-w-md">
                <label for="voice-readback-engine" class="mb-1 block text-xs font-medium text-fg">Speech engine</label>
                <select id="voice-readback-engine" class="w-full rounded-lg border border-border bg-surface-100 px-3 py-2 text-sm text-fg"
                  data-voice-readback-engine :value="voice.runtime.readback.selectedEngine" :disabled="captureLocked"
                  :aria-describedby="voice.runtime.readback.selectedEngine === 'kokoro' ? 'voice-neural-memory-warning' : undefined"
                  @change="changeReadbackEngine">
                  <option v-for="engine in voice.runtime.readback.engines" :key="engine.id" :value="engine.id">{{ engine.label }}</option>
                </select>
                <p v-if="voice.runtime.readback.selectedEngine === 'kokoro'" id="voice-neural-memory-warning" class="mt-2 text-xs text-warning">
                  Neural voices use significantly more RAM. Choose Windows TTS for lower memory use.
                </p>
                <div v-if="voice.runtime.readback.voices.length" class="mt-3">
                  <label for="voice-readback-voice" class="mb-1 block text-xs font-medium text-fg">Voice</label>
                  <select id="voice-readback-voice" class="w-full rounded-lg border border-border bg-surface-100 px-3 py-2 text-sm text-fg"
                    :value="voice.runtime.readback.selectedVoice" :disabled="captureLocked" @change="changeReadbackVoice">
                    <option v-for="option in voice.runtime.readback.voices" :key="option.id" :value="option.id">{{ option.label }}</option>
                  </select>
                </div>
                <p class="mt-1 text-xs text-muted-fg">All voices work offline.</p>
                <p v-if="voice.runtime.readback.preparing" class="mt-1 text-xs text-muted-fg" role="status">Preparing the selected voice…</p>
                <p v-if="readbackSelectionError" class="mt-1 text-xs text-warning" role="alert">{{ readbackSelectionError }}</p>
                <p v-if="voice.runtime.readback.fallbackReason" class="mt-1 text-xs text-warning" role="status">{{ voice.runtime.readback.fallbackReason }}</p>
                <button v-if="voice.runtime.readback.fallbackReason" type="button" class="ff-button-secondary mt-2 text-xs"
                  :disabled="captureLocked" @click="voice.setReadbackEngine(voice.runtime.readback.selectedEngine)">Retry selected voice</button>
              </div>
              <p v-if="voice.voiceTest.feedbackMessage" class="mt-2 text-xs text-muted-fg" role="status">{{ voice.voiceTest.feedbackMessage }}</p>
              <p v-if="voice.runtime.readbackError" class="text-[11px] text-warning" data-voice-readback-error>
                Last spoken readback failed: {{ voice.runtime.readbackError }} Speech uses the default output device.
              </p>
            </div>
            </section>
          </div>
          <section aria-labelledby="voice-ptt-title" data-voice-ptt-settings>
            <h4 id="voice-ptt-title" class="mb-3 text-base font-semibold text-fg">2. Set up push-to-talk</h4>
            <p class="mb-3 text-xs text-muted-fg">Hold to speak. Release for a response.</p>
            <p id="voice-input-choices-help" class="mb-3 text-xs text-muted-fg">Existing bindings stay configured until you remove them.</p>
            <div class="setup-input-choices" :class="{ 'setup-input-choices--two': inputChoices.length === 2 }" role="group" aria-label="Push-to-talk settings to view" aria-describedby="voice-input-choices-help">
              <button v-for="choice in inputChoices" :key="choice.id" type="button" :data-voice-input-choice="choice.id" :aria-pressed="inputChoice === choice.id" :disabled="captureLocked || shortcutSetupBusy || shortcutDirty || shortcutSaving" @click="chooseInput(choice.id)">
                <SetupIllustration :kind="choice.kind" /><span>{{ choice.label }}</span>
              </button>
            </div>
            <div class="mt-3 min-w-0 text-xs text-muted-fg" data-voice-input-bindings>
              <p class="font-medium text-fg">Saved bindings</p>
              <dl class="mt-2 grid min-w-0 gap-2">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <dt>Keyboard:</dt>
                  <dd class="min-w-0"><KeyboardShortcutKeys v-if="voice.runtime.shortcut" :shortcut="voice.runtime.shortcut" /><span v-else>Not set</span></dd>
                </div>
                <div v-if="voice.runtime.controllerEnabled" class="flex min-w-0 flex-wrap items-center gap-2">
                  <dt>Controller:</dt>
                  <dd class="min-w-0 break-words">{{ voice.runtime.controller?.binding ? `${voice.runtime.controller.binding.label} · Button ${voice.runtime.controller.binding.button}` : 'Not set' }}</dd>
                </div>
              </dl>
              <p v-if="!voice.runtime.enabled" class="mt-2">Voice control is off. Saved bindings are inactive.</p>
            </div>
            <p v-if="inputChoice === 'screen'" class="mt-3 text-sm text-muted-fg" data-voice-screen-choice>Use Hold to talk in Aircraft → Voice commands. No shortcut needed.</p>
            <div class="mt-3 grid min-w-0 gap-3">
              <form v-show="inputChoice === 'keyboard'" class="flex min-w-0 flex-col gap-3" aria-labelledby="voice-keyboard-title" @submit.prevent="saveShortcut" @focusout="shortcutFocusOut">
                <h5 id="voice-keyboard-title" class="text-sm font-semibold text-fg"><label for="voice-ptt-shortcut">Keyboard shortcut</label></h5>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    id="voice-ptt-shortcut"
                    type="button"
                    data-voice-shortcut-recorder
                    class="min-h-10 min-w-40 max-w-full rounded-lg border px-3 py-2 text-left font-mono transition-colors disabled:opacity-50"
                    :class="shortcutRecording ? 'border-accent/70 bg-accent/10 text-fg' : 'border-border bg-panel-subtle text-fg hover:bg-muted'"
                    :disabled="recognitionOff || captureLocked || shortcutSaving"
                    :aria-busy="shortcutPreparing ? 'true' : undefined"
                    :aria-label="shortcutPreparing
                      ? 'Pausing push-to-talk before shortcut setup'
                      : shortcutRecording
                      ? 'Press the new push-to-talk shortcut'
                      : shortcutDirty
                        ? `Unsaved push-to-talk shortcut: ${shortcutDraft}. Save shortcut to use it.`
                      : shortcutDraft
                        ? `Current push-to-talk shortcut: ${shortcutDraft}. Click to change.`
                        : 'No global push-to-talk shortcut is set. Click to record one.'"
                    aria-describedby="voice-ptt-shortcut-help voice-ptt-shortcut-foreground voice-ptt-shortcut-error"
                    @click="beginShortcutRecording"
                    @keydown="captureShortcut"
                    @keyup="captureShortcutRelease"
                  >
                    <KeyboardShortcutKeys v-if="!shortcutRecording && !shortcutPreparing && shortcutDraft" :shortcut="shortcutDraft" aria-hidden="true" />
                    <span v-else>{{ shortcutPreparing ? 'Pausing push-to-talk…' : shortcutRecording ? 'Press shortcut…' : 'Set shortcut' }}</span>
                  </button>
                  <button
                    v-if="voice.runtime.shortcut && !shortcutDirty && !shortcutSetupBusy"
                    type="button"
                    class="ff-button-secondary min-h-10 disabled:opacity-50"
                    data-voice-shortcut-remove
                    :disabled="captureLocked || shortcutSaving || recognitionSaving"
                    :aria-busy="shortcutRemoving ? 'true' : undefined"
                    @click="removeShortcut"
                  >{{ shortcutRemoving ? 'Removing…' : 'Remove shortcut' }}</button>
                  <button
                    v-if="shortcutDirty"
                    type="submit"
                    data-voice-shortcut-save
                    class="min-h-10 rounded-lg border border-border px-3 py-2 text-fg transition-colors hover:bg-muted disabled:opacity-50"
                    :disabled="recognitionOff || shortcutRecording || shortcutPreparing || shortcutSaving || captureLocked"
                  >
                    {{ shortcutSaving ? 'Saving…' : 'Save shortcut' }}
                  </button>
                  <button
                    v-if="shortcutRecording || shortcutPreparing || shortcutLease || shortcutDirty"
                    type="button"
                    class="min-h-10 rounded-lg px-3 py-2 text-muted-fg transition-colors hover:bg-muted hover:text-fg disabled:opacity-50"
                    :disabled="shortcutSaving"
                    data-voice-shortcut-cancel
                    @click="cancelShortcutEdit"
                  >
                    Cancel
                  </button>
                </div>
                <div v-if="shortcutLease" class="min-w-0">
                  <label for="voice-ptt-modifier" class="mb-1.5 block text-muted-fg">Or choose a single modifier key</label>
                  <select id="voice-ptt-modifier" value=""
                    class="min-h-10 w-full min-w-0 rounded-lg border border-border bg-panel-subtle px-3 py-2 text-fg disabled:opacity-50"
                    :disabled="shortcutSaving || recognitionOff || captureLocked"
                    aria-describedby="voice-ptt-shortcut-help voice-ptt-shortcut-foreground"
                    @change="selectModifierShortcut">
                    <option value="" disabled>Choose a modifier key</option>
                    <option v-for="modifier in SINGLE_MODIFIER_SHORTCUTS" :key="modifier" :value="modifier">
                      {{ modifier.replace('Control', 'Ctrl').replace('Super', 'Win').replace(/^(Left|Right)/, '$1 ') }}
                    </option>
                  </select>
                </div>
                <p id="voice-ptt-shortcut-help" class="text-[11px] text-muted-fg" role="status">
                  {{ shortcutRemoving
                    ? 'Removing keyboard shortcut…'
                    : shortcutNotice
                    ? shortcutNotice
                    : recognitionOff
                    ? 'Enable voice control before setting a global shortcut.'
                    : shortcutPreparing
                      ? 'Pausing push-to-talk before recording. You can cancel.'
                    : shortcutRecording
                    ? 'Push-to-talk is paused. Press a key or combination. For a modifier alone, press and release it. Escape cancels.'
                    : shortcutSaving
                      ? 'Saving shortcut…'
                    : shortcutDirty
                      ? shortcutLease
                        ? 'Not saved yet. Push-to-talk is paused until you Save shortcut or Cancel.'
                        : 'Not saved yet. Click Save shortcut to use it.'
                    : shortcutUnchanged
                      ? shortcutLease
                        ? 'This is already your saved shortcut. No changes to save. Push-to-talk is paused; click Cancel to finish.'
                        : 'This is already your saved shortcut. No changes to save.'
                    : shortcutDraft
                      ? 'Click the shortcut to record a new key or combination.'
                      : unassignedShortcutHelp }}
                </p>
                <p id="voice-ptt-shortcut-foreground" class="text-[11px] text-muted-fg">
                  The shortcut also reaches the app in front. Choose a key or combination that is unassigned in MSFS and other apps.
                  {{ shortcutDraft.split('+').includes('CapsLock') ? 'Caps Lock also toggles capitalisation.' : '' }}
                </p>
                <p v-if="voice.runtime.shortcut" class="text-[11px] text-muted-fg">
                  Removing this shortcut disables keyboard push-to-talk only.
                </p>
                <p v-if="shortcutError" id="voice-ptt-shortcut-error" class="text-[11px] text-warning" role="alert">
                  {{ shortcutError }}
                </p>
                <p v-if="voice.runtime.enabled && !voice.controllerSetup.active && !shortcutSetupBusy && voice.runtime.shortcut && !voice.runtime.shortcutRegistered" class="text-xs text-warning" role="status">
                  Saved shortcut unavailable: {{ voice.runtime.shortcutError || 'Choose another key or combination.' }}
                </p>
              </form>

              <ControllerButtonSettings v-if="voice.runtime.controllerEnabled" v-show="inputChoice === 'controller'" :disabled="recognitionSaving || shortcutSetupBusy || shortcutSaving || voice.listening || voice.finishing || voice.voiceTestBusy" />
            </div>

            <VoiceButtonTest :disabled="recognitionSaving || shortcutSetupBusy || shortcutDirty || shortcutSaving || voice.controllerSetup.active" :on-screen="inputChoice === 'screen'" />
          </section>

          <button type="button" class="justify-self-start" :class="voice.voiceTest.recognized ? 'ff-button-primary' : 'ff-button-secondary'" data-voice-setup-done :disabled="captureLocked || shortcutSetupBusy || shortcutDirty || shortcutSaving" @click="backToAircraft">Open Aircraft controls</button>
        </div>

      </div>
    </div>
  </section>
</template>
