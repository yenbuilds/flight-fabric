<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { isRemoteView } from '../../app/remote-view.js';
import { getReconnect } from '../../../app-shared.js';
import { useAppSettingsStore } from '../stores/app-settings.js';
import { useProfilesStore } from '../stores/profiles.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useToolbarPanelStore } from '../stores/toolbar-panel.js';
import { useSystemHostStore } from '../stores/system-host.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useTabsStore } from '../stores/tabs.js';
import { openVoiceSettings } from '../settings-navigation.js';
import OnboardingToolbarStep from './OnboardingToolbarStep.vue';

const emit = defineEmits(['ready']);
const settings = useAppSettingsStore();
const profiles = useProfilesStore();
const voice = useVoiceControlStore();
const toolbar = useToolbarPanelStore();
const systemHost = useSystemHostStore();
const settingsUi = useSettingsUiStore();
const dialog = ref(null);
const tabs = useTabsStore();
const main = ref(null);
const heading = ref(null);
const errorMessage = ref(null);
const required = ref(false);
const step = ref(1);
const voiceEnabled = ref('keep');
const automaticRecording = ref(null);
const toolbarChoice = ref('later');
const saving = ref(false);
const error = ref('');
const recovering = ref(false);
const recoveryError = ref('');
let initialized = false;
let voiceInitialized = false;
let attempted = false;
let disposed = false;
const canSave = computed(() => profiles.authorizationScope === 'full-control' && settings.saveActionBound);
const canChooseVoice = computed(() => voice.bridgeAvailable && voice.runtimeLoaded);
const recordingChanged = computed(() => typeof automaticRecording.value === 'boolean'
  && automaticRecording.value !== settings.settings?.recording?.autoStart);
const voiceComplete = computed(() => canChooseVoice.value
  ? typeof voiceEnabled.value === 'boolean' : voiceEnabled.value === 'keep');
const recordingComplete = computed(() => typeof automaticRecording.value === 'boolean');
const toolbarComplete = computed(() => toolbarChoice.value === 'later'
  || (toolbarChoice.value === 'install' && toolbar.available && toolbar.hasLoaded
    && !toolbar.busy && !toolbar.error && !toolbar.sourceError
    && toolbar.rows.some(row => row.found && row.status === 'installed')));
const choicesComplete = computed(() => voiceComplete.value && recordingComplete.value && toolbarComplete.value);
const stepComplete = computed(() => [voiceComplete.value, recordingComplete.value, toolbarComplete.value][step.value - 1]);
const busy = computed(() => saving.value || Boolean(toolbar.busyInstallId));
// A missing startup reply is not evidence that setup is complete. Keep the
// native modal open until both authorization and the PC's preferences arrive.
// Once resolved (including confirmed viewers), reconnects must not interrupt
// normal app use again. Remote views never manage these PC preferences.
const loading = ref(!isRemoteView());
const loadingSlow = ref(false);
let reconnectDelay = null;
// Allow the connection's ten-second deadline and three-second automatic retry
// before suggesting manual recovery. Preferences still resolve immediately.
const RECONNECT_DELAY_MS = 15000;
const open = computed(() => loading.value || required.value || settingsUi.introOpen);
const canStartService = computed(() => typeof systemHost.electronApi?.startBackend === 'function'
  && ['stopped', 'error'].includes(systemHost.backendStatus));
// Socket attempts can briefly fail while the service is still starting.
// Give automatic retries the same grace period as other startup replies.
const showReconnect = computed(() => loading.value && !canStartService.value && !recovering.value
  && loadingSlow.value);
const loadingMessage = computed(() => {
  if (recovering.value) return 'Starting FlightFabric’s service…';
  if (canStartService.value) return 'FlightFabric’s service is not running. Start it to load your preferences.';
  return loadingSlow.value ? 'Loading your preferences is taking longer than usual. You can retry the connection.' : 'Loading your preferences…';
});

function resetReconnectDelay() {
  clearTimeout(reconnectDelay);
  reconnectDelay = null;
  loadingSlow.value = false;
  if (disposed || !loading.value) return;
  reconnectDelay = setTimeout(() => {
    reconnectDelay = null;
    if (!disposed && loading.value) loadingSlow.value = true;
  }, RECONNECT_DELAY_MS);
}

// The timer only controls the recovery affordance, never the startup gate.
// Clear it as soon as startup resolves, and give manual retries a fresh wait.
onMounted(resetReconnectDelay);
watch(loading, resetReconnectDelay);

watch([showReconnect, canStartService, recovering], async () => {
  const active = dialog.value?.ownerDocument.activeElement;
  if (!loading.value || active?.tagName !== 'BUTTON' || !dialog.value?.contains(active)) return;
  await nextTick();
  if (!disposed && loading.value && (!active.isConnected || active.disabled)) {
    heading.value?.focus({ preventScroll: true });
  }
});

function reconnect() {
  if (!showReconnect.value || systemHost.isBusy) return;
  recoveryError.value = '';
  resetReconnectDelay();
  getReconnect()?.();
}

async function startService() {
  if (!loading.value || !canStartService.value || recovering.value || systemHost.isBusy) return;
  recovering.value = true;
  recoveryError.value = '';
  try {
    const started = await systemHost.startBackend();
    // The socket may have recovered automatically while native status refreshed.
    // Do not restart that connection or move focus after setup has appeared.
    if (disposed || !loading.value) return;
    if (!started || canStartService.value) {
      recoveryError.value = systemHost.lastError || 'The service did not start. Try again.';
      await nextTick();
      if (!disposed && loading.value) errorMessage.value?.focus({ preventScroll: true });
    } else {
      resetReconnectDelay();
      getReconnect()?.();
    }
  } finally {
    if (!disposed) recovering.value = false;
  }
}
const steps = [
  {
    label: 'Voice', title: 'Fly with your voice',
    intro: 'Use spoken commands with supported aircraft. Choose your microphone and push-to-talk button in Settings next.',
    caption: 'Your cockpit, within reach.',
    artwork: new URL('../../../assets/onboarding/voice.svg', import.meta.url).href,
    next: 'Next: flight recording',
  },
  {
    label: 'Recording', title: 'Choose how flights are recorded',
    intro: 'Save flight data on this PC for your Logbook and debrief. Voice works with either choice.',
    caption: 'Your flights, worth keeping.',
    artwork: new URL('../../../assets/onboarding/recording.svg', import.meta.url).href,
    next: 'Next: MSFS toolbar',
  },
  {
    label: 'Toolbar', title: 'Add FlightFabric to MSFS',
    intro: 'View your plan, voice phrases and landing report, and use aircraft presets inside MSFS 2024.',
    caption: 'Stay in the cockpit.',
    artwork: new URL('../../../assets/onboarding/toolbar.svg', import.meta.url).href,
    next: 'Save and finish',
  },
];
const currentStep = computed(() => steps[step.value - 1]);

// The PC owns these preferences. Paired phone / toolbar viewers cannot write
// settings and must not be trapped behind a setup they cannot complete.
watch([() => settings.settings, () => profiles.authorizationScope, () => profiles.authorizationAcknowledged], ([current, scope, acknowledged]) => {
  if (isRemoteView() || !acknowledged) return;
  if (scope !== 'full-control') {
    loading.value = false;
    return;
  }
  if (!current) return;
  loading.value = false;
  if (!initialized) {
    initialized = true;
    required.value = current.onboarding?.completed !== true;
    automaticRecording.value = current.recording?.autoStart !== false;
    if (!required.value) emit('ready');
  } else if (!settingsUi.introOpen && !attempted && current.onboarding?.completed === true) {
    required.value = false;
    emit('ready');
  }
}, { immediate: true });

// Replaying is local UI state: keep the durable completion flag and initialize
// each visit from the current saved preferences, not the last dialog's draft.
watch(() => settingsUi.introOpen, (requested) => {
  if (!requested) return;
  if (loading.value || required.value || settingsUi.introBlockedReason) {
    settingsUi.introOpen = false;
    return;
  }
  error.value = '';
  step.value = 1;
  attempted = false;
  automaticRecording.value = settings.settings.recording?.autoStart !== false;
  toolbarChoice.value = 'later';
  voiceInitialized = canChooseVoice.value;
  voiceEnabled.value = voiceInitialized ? voice.runtime.enabled : 'keep';
});

watch(canChooseVoice, (ready) => {
  if (!ready) return;
  if (!voiceInitialized) {
    voiceInitialized = true;
    voiceEnabled.value = voice.runtime.needsInitialPreference && !settingsUi.introOpen ? true : voice.runtime.enabled;
  }
  // Use the actual saved preference once it arrives. Until then, preserve it
  // without guessing that voice is off or writing an unavailable preference.
  if (voiceEnabled.value === 'keep') voiceEnabled.value = voice.runtime.enabled;
}, { immediate: true });

watch([open, required, dialog], async ([visible, , element]) => {
  if (!element) return;
  if (visible) {
    if (!element.open) element.showModal();
    await nextTick();
    if (!disposed && open.value) heading.value?.focus();
  } else if (element.open) {
    element.close();
  }
}, { flush: 'post' });

// Loading without actions keeps focus on the heading. This also covers the
// second press of a double click after Reconnect disappears under the pointer.
function retainLoadingFocus(event) {
  if (loading.value && !dialog.value?.querySelector('button:not(:disabled)')) {
    event.preventDefault();
    heading.value?.focus({ preventScroll: true });
  }
}

function handleKeydown(event) {
  event.stopPropagation();
  if (event.key === 'Tab') retainLoadingFocus(event);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeIntro();
  }
}

function closeIntro() {
  if (!busy.value) settingsUi.introOpen = false;
}

async function changeStep(value) {
  if (busy.value || value < 1 || value > steps.length || (value > step.value && !stepComplete.value)) return;
  if (step.value === 1 && value > 1) voiceInitialized = true;
  step.value = value;
  await nextTick();
  if (main.value) main.value.scrollTop = 0;
  heading.value?.focus({ preventScroll: true });
}

async function finish() {
  if (busy.value || !canSave.value || step.value !== steps.length || !choicesComplete.value) return;
  const firstVisit = required.value;
  saving.value = true;
  attempted = true;
  error.value = '';
  try {
    // Keep the existing Electron preference owner. Setup does not open a
    // microphone or require working recognition hardware to finish.
    if (canChooseVoice.value && (voice.recognitionSaveFailed || voice.runtime.needsInitialPreference || voiceEnabled.value !== voice.runtime.enabled)) {
      const saved = await voice.setRecognitionEnabled(voiceEnabled.value, { requestMicrophoneAccess: false });
      if (!saved) throw new Error('Your voice preference could not be saved. Try again, or go back to review your choice.');
    }
    if (disposed) return;
    if (!canSave.value) throw new Error('Reconnect to FlightFabric and try saving again.');
    // Send only the changed preference and completion, so unrelated settings
    // updated since the dialog opened survive the backend's merge.
    const patch = { onboarding: { completed: true } };
    if (recordingChanged.value) patch.recording = { autoStart: automaticRecording.value };
    const result = await settings.saveSettingsConfirmed(patch);
    if (disposed) return;
    if (!result.ok || result.settings?.onboarding?.completed !== true) {
      throw new Error(result.error || 'Setup could not be saved. Your choices are kept; try again.');
    }
    required.value = false;
    settingsUi.introOpen = false;
    await nextTick();
    if (!disposed) {
      emit('ready');
      if (firstVisit) {
        if (canChooseVoice.value && voiceEnabled.value) await openVoiceSettings(tabs, voice, { fromAircraft: true });
        else tabs.requestTabChange('autopilot');
      }
    }
  } catch (failure) {
    if (!disposed) {
      error.value = failure?.message || 'Setup could not be saved. Try again.';
      await nextTick();
      if (!disposed) {
        errorMessage.value?.focus({ preventScroll: true });
        errorMessage.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      }
    }
  } finally {
    if (!disposed) saving.value = false;
  }
}

onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(reconnectDelay);
  settingsUi.introOpen = false;
  dialog.value?.close();
});
</script>

<template>
  <dialog ref="dialog" class="onboarding-dialog" :class="{ 'onboarding-loading': loading }" aria-labelledby="onboarding-title" aria-describedby="onboarding-intro"
    @cancel.prevent="closeIntro" @keydown="handleKeydown" @pointerdown="retainLoadingFocus">
    <section v-if="loading" class="onboarding-loading-content onboarding-header">
      <h2 id="onboarding-title" ref="heading" tabindex="-1">Opening FlightFabric</h2>
      <p id="onboarding-intro" class="onboarding-loading-status" role="status">
        <span v-if="!canStartService || recovering" class="onboarding-loading-indicator h-4 w-4 flex-shrink-0 rounded-full border-2 border-primary/25 border-t-primary animate-spin motion-reduce:animate-none" aria-hidden="true"></span>
        <span>{{ loadingMessage }}</span>
      </p>
      <div v-if="recoveryError" ref="errorMessage" class="onboarding-error" role="alert" tabindex="-1">{{ recoveryError }}</div>
      <div v-if="canStartService || recovering || showReconnect" class="onboarding-actions">
        <button v-if="canStartService || recovering" type="button" class="ff-button-primary" data-start-service :disabled="recovering || systemHost.isBusy" @click="startService">{{ recovering ? 'Starting…' : 'Start service' }}</button>
        <button v-if="showReconnect" type="button" class="ff-button-secondary" data-reconnect :disabled="systemHost.isBusy" @click="reconnect">Reconnect</button>
      </div>
    </section>
    <form v-else-if="required || settingsUi.introOpen" class="onboarding-form" :data-onboarding-step="step" :aria-busy="busy" @submit.prevent="step < steps.length ? changeStep(step + 1) : finish()">
      <button v-if="settingsUi.introOpen" type="button" class="ff-icon-button onboarding-close" aria-label="Close setup" data-close-intro-top :disabled="busy" @click="closeIntro">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
      <div class="onboarding-artwork" aria-hidden="true">
        <div class="onboarding-brand"><img src="/assets/app-mark.svg" alt="" width="28" height="28">FlightFabric</div>
        <picture :key="step" class="onboarding-illustration">
          <!-- Select the static SVG fragment from the page's media preference.
               A distinct query also prevents reuse of a cached animated image. -->
          <source media="(prefers-reduced-motion: reduce)" :srcset="`${currentStep.artwork}?motion=still#still`">
          <img :src="currentStep.artwork" alt="" width="600" height="600" draggable="false">
        </picture>
        <p class="onboarding-caption">{{ currentStep.caption }}</p>
      </div>
      <div ref="main" class="onboarding-main">
        <header class="onboarding-header">
          <ol class="onboarding-progress" aria-label="Setup progress">
            <li v-for="(item, index) in steps" :key="item.label" :class="{ complete: index < step }" :aria-current="index === step - 1 ? 'step' : undefined">{{ index + 1 }}. {{ item.label }}</li>
          </ol>
          <h2 id="onboarding-title" ref="heading" tabindex="-1">{{ currentStep.title }}</h2>
          <p id="onboarding-intro">{{ currentStep.intro }}</p>
        </header>

        <div class="onboarding-content">
          <fieldset v-if="step === 1 && canChooseVoice" :disabled="busy">
            <legend>Would you like to use voice control?</legend>
            <label class="onboarding-choice">
              <input v-model="voiceEnabled" type="radio" name="onboarding-voice" :value="true">
              <span><strong>Use voice control</strong><small>Try your microphone next. Saving these choices won’t open it.</small></span>
            </label>
            <label class="onboarding-choice">
              <input v-model="voiceEnabled" type="radio" name="onboarding-voice" :value="false">
              <span><strong>Leave voice control off</strong><small>You can enable it in Settings whenever you’re ready.</small></span>
            </label>
          </fieldset>
          <fieldset v-else-if="step === 1" :disabled="busy">
            <legend>Voice control</legend>
            <p class="onboarding-note" role="status">{{ voice.bridgeAvailable ? 'Voice preferences are unavailable. You can check them in Settings afterwards.' : 'Voice control is available in the desktop app.' }}</p>
            <label class="onboarding-choice">
              <input v-model="voiceEnabled" type="radio" name="onboarding-voice-unavailable" value="keep" @click="voiceInitialized = true">
              <span><strong>Keep my current voice preference</strong><small>Continue setup without changing voice control.</small></span>
            </label>
          </fieldset>
          <fieldset v-else-if="step === 2" :disabled="busy">
            <legend>When should recording start?</legend>
            <label class="onboarding-choice">
              <input v-model="automaticRecording" type="radio" name="onboarding-recording" :value="true">
              <span><strong>Record automatically</strong><small>Save flight data as you fly. Flight REC shows the recording size.</small></span>
            </label>
            <label class="onboarding-choice">
              <input v-model="automaticRecording" type="radio" name="onboarding-recording" :value="false">
              <span><strong>I’ll start recording manually</strong><small>Use Start REC to save a flight to your Logbook.</small></span>
            </label>
          </fieldset>
          <template v-if="step === 3">
            <fieldset :disabled="busy" class="onboarding-toolbar-choices">
              <legend>Would you like to use the MSFS toolbar?</legend>
              <label class="onboarding-choice">
                <input v-model="toolbarChoice" type="radio" name="onboarding-toolbar" value="install">
                <span><strong>Use the MSFS toolbar</strong><small>Use an installed copy, or install below to continue.</small></span>
              </label>
              <label class="onboarding-choice">
                <input v-model="toolbarChoice" type="radio" name="onboarding-toolbar" value="later">
                <span><strong>Set up later</strong><small>Install whenever you’re ready in Settings.</small></span>
              </label>
            </fieldset>
            <OnboardingToolbarStep :disabled="saving || !canSave || toolbarChoice !== 'install'" />
            <p v-if="!voiceComplete" class="onboarding-note" role="status">Voice preferences changed. Go back to Voice to confirm your choice.</p>
          </template>
          <p v-if="step === 2 && recordingChanged" class="onboarding-note">Restart FlightFabric after setup to apply this change. The current recording continues until you end the flight.</p>
          <p v-if="error" ref="errorMessage" class="onboarding-error" role="alert" tabindex="-1">{{ error }}</p>
          <p v-if="!canSave" class="onboarding-note" role="status">Waiting for the connection to FlightFabric before saving.</p>
        </div>
      </div>

      <footer class="onboarding-footer">
        <p>You can change these choices in Settings.</p>
        <div class="onboarding-actions">
          <button v-if="settingsUi.introOpen" type="button" class="ff-button-secondary" data-close-intro :disabled="busy" @click="closeIntro">Close</button>
          <button v-if="step > 1" type="button" class="ff-button-secondary" data-onboarding-back :disabled="busy" @click="changeStep(step - 1)">Back</button>
          <button type="submit" class="ff-button-primary" :disabled="busy || !stepComplete || (step === steps.length && (!canSave || !choicesComplete))">{{ saving ? 'Saving…' : currentStep.next }}</button>
        </div>
      </footer>
    </form>
  </dialog>
</template>

<style src="../../styles/onboarding.css"></style>
