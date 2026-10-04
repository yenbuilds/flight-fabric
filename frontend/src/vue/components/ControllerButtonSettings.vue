<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
import SettingsSectionWatermark from './SettingsSectionWatermark.vue';

const props = defineProps({ disabled: Boolean });
const voice = useVoiceControlStore();
const tabs = useTabsStore();
const pending = ref(false);
const starting = ref(false);
let setupCancelled = false;
const error = ref('');
const notice = ref('');
const chooser = ref(null);
const saveButton = ref(null);
const setup = computed(() => voice.controllerSetup);
const controller = computed(() => voice.runtime.controller);
const locked = computed(() => props.disabled || pending.value || !voice.runtime.enabled);
const readyToSave = computed(() => setup.value.active && setup.value.phase === 'ready' && !setup.value.held);
const status = computed(() => {
  if (!voice.runtime.enabled) return 'Enable voice control to use a controller button.';
  return ({ unbound: 'No controller button selected.', inactive: 'Controller input is inactive.',
    disconnected: 'Controller disconnected. Reconnect it to use this button.',
    waiting: 'Press and release once. Then hold to talk.',
    'release-required': 'Release, then hold again to talk.',
    ready: 'Ready. Hold to talk; release to finish.',
    paused: 'Controller input is paused while Windows is locked or suspended.',
    error: controller.value.error || 'Controller input needs attention. Reconnect it or choose the button again.',
  })[controller.value.state] || 'Controller input is unavailable.';
});

async function perform(action, message = '') {
  if (pending.value) return;
  pending.value = true; error.value = ''; notice.value = '';
  starting.value = action === 'startControllerSetup';
  setupCancelled = false;
  const origin = document.activeElement;
  try {
    const changed = await voice[action]();
    if (starting.value && setupCancelled) return;
    if (!changed) throw new Error('The controller setting could not be changed. Try again.');
    notice.value = message;
  } catch (failure) {
    if (!starting.value || !setupCancelled) error.value = failure?.message || 'The controller setting could not be changed.';
  }
  finally { pending.value = false; starting.value = false; }
  await nextTick();
  if (tabs.activeTabId === 'settings' && (document.activeElement === document.body || document.activeElement === origin)) chooser.value?.focus();
}
function stopLearning() {
  if (starting.value) setupCancelled = true;
  if (setup.value.active || starting.value) void Promise.resolve(voice.cancelControllerSetup()).catch(() => {});
}
watch(() => [tabs.activeTabId, setup.value.active], ([tab]) => { if (tab !== 'settings') stopLearning(); });
watch(() => readyToSave.value && !locked.value, async (ready) => {
  if (!ready) return;
  await nextTick();
  if (tabs.activeTabId === 'settings' && readyToSave.value && !locked.value
      && document.activeElement === chooser.value) saveButton.value?.focus();
});
onBeforeUnmount(stopLearning);
</script>

<template>
  <section class="settings-panel--illustrated min-w-0 rounded-xl border border-border bg-panel-subtle p-4" aria-labelledby="voice-controller-title" data-voice-controller-settings>
    <SettingsSectionWatermark kind="controller" />
    <h5 id="voice-controller-title" class="text-sm font-semibold text-fg">Yoke or joystick button</h5>
    <p v-if="controller.binding" class="mt-3 break-words text-sm text-fg" data-voice-controller-saved>{{ controller.binding.label }} · Button {{ controller.binding.button }}</p>
    <p v-if="!setup.active" class="mt-2 text-xs text-muted-fg" role="status" data-voice-controller-status>{{ status }}</p>
    <div v-else class="mt-3 rounded-lg border border-border bg-bg/50 p-3" aria-live="polite" aria-atomic="true" data-voice-controller-test>
      <p class="text-sm font-medium text-fg">{{ setup.held ? 'Button pressed' : setup.phase === 'ready' ? 'Button released, ready to save' : 'Choose your button' }}</p>
      <p v-if="setup.selection" class="mt-1 break-words text-xs text-fg">{{ setup.selection.label }} · Button {{ setup.selection.button }}</p>
      <p class="mt-1 text-xs text-muted-fg">{{ setup.message }}</p>
      <p v-if="setup.phase === 'listening'" class="mt-2 text-xs text-muted-fg">The first press may only get the controller ready.</p>
      <p class="mt-2 text-xs text-muted-fg">Voice is paused. This check won't use your microphone or send commands.</p>
    </div>
    <div class="mt-3 flex flex-wrap gap-2">
      <button v-if="setup.active" ref="saveButton" type="button" class="min-h-10 disabled:opacity-50" :class="readyToSave ? 'ff-button-primary' : 'ff-button-secondary'" data-voice-controller-save :disabled="locked || !readyToSave" @click="perform('saveControllerButton', 'Controller button saved.')">Save button</button>
      <button ref="chooser" type="button" class="ff-button-secondary min-h-10 disabled:opacity-50" data-voice-controller-choose :disabled="locked" @click="perform('startControllerSetup')">
        {{ pending ? 'Updating…' : setup.active ? 'Choose another button' : controller.binding ? 'Change button' : 'Set button' }}
      </button>
      <button v-if="setup.active" type="button" class="ff-button-secondary min-h-10 disabled:opacity-50" data-voice-controller-cancel :disabled="pending" @click="perform('cancelControllerSetup')">Cancel</button>
      <button v-else-if="controller.binding" type="button" class="ff-button-secondary min-h-10 disabled:opacity-50" data-voice-controller-clear :disabled="props.disabled || pending" @click="perform('clearControllerButton', 'Controller button removed.')">Remove button</button>
    </div>
    <div v-if="controller.binding && !setup.active" class="mt-3 flex items-start gap-2 rounded-lg border border-border bg-bg/50 p-3 text-xs text-muted-fg">
      <svg class="pointer-events-none mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v1" stroke-linecap="round" />
      </svg>
      <div class="min-w-0">
        <p class="font-medium text-fg">First use</p>
        <p class="mt-1">After setup, a restart or reconnection, one extra press and release may be needed.</p>
      </div>
    </div>
    <p v-if="notice" class="mt-2 text-xs text-muted-fg" role="status">{{ notice }}</p>
    <p v-if="error" class="mt-2 text-xs text-warning" role="alert">{{ error }}</p>
  </section>
</template>
