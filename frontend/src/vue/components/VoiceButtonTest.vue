<script setup>
import { computed, nextTick, onBeforeUnmount, watch } from 'vue';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
const props = defineProps({ disabled: Boolean, onScreen: Boolean });
const voice = useVoiceControlStore();
const tabs = useTabsStore();
const active = computed(() => ['waiting', 'held'].includes(voice.buttonTest.phase));
function press(event) {
  if (event.repeat || (event.pointerType && event.button !== 0)) return;
  if (Number.isFinite(event.pointerId)) event.currentTarget?.setPointerCapture?.(event.pointerId);
  voice.practiceButtonEvent('down');
}
watch(() => voice.buttonTest.phase, async () => {
  const origin = document.activeElement;
  if (!origin?.closest('[data-voice-button-test]')) return;
  await nextTick();
  if (tabs.activeTabId === 'settings' && (!origin.isConnected || origin.disabled)
    && [origin, document.body].includes(document.activeElement)) {
    document.querySelector('[data-voice-button-practice], [data-voice-button-cancel], [data-voice-button-check]:not(:disabled)')?.focus({ preventScroll: true });
  }
});
watch(() => [tabs.activeTabId, props.onScreen], () => voice.cancelButtonTest());
onBeforeUnmount(() => voice.cancelButtonTest());
</script>

<template>
  <div class="mt-4 rounded-lg border border-border p-3" data-voice-button-test>
    <p class="text-sm font-medium text-fg">Check your button</p>
    <p class="mt-1 text-xs text-muted-fg">A practice press only. No microphone or aircraft commands.</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button type="button" class="ff-button-secondary text-xs" data-voice-button-check
        :disabled="disabled || voice.voiceTestBusy || voice.listening || voice.finishing || !voice.runtime.enabled"
        @click="voice.startButtonTest(onScreen ? 'screen' : 'global')">{{ voice.buttonTest.phase === 'complete' ? 'Check again' : 'Test button' }}</button>
      <button v-if="active && onScreen" type="button" class="ff-button-primary select-none text-xs" data-voice-button-practice
        @pointerdown.prevent="press" @pointerup.prevent="voice.practiceButtonEvent('up')"
        @pointercancel="voice.practiceButtonEvent('cancel')" @lostpointercapture="voice.practiceButtonEvent('cancel')"
        @keydown.space.prevent="press" @keyup.space.prevent="voice.practiceButtonEvent('up')"
        @keydown.enter.prevent="press" @keyup.enter.prevent="voice.practiceButtonEvent('up')"
        @blur="voice.practiceButtonEvent('cancel')">Hold to practise</button>
      <button v-if="active" type="button" class="ff-button-secondary text-xs" data-voice-button-cancel @click="voice.cancelButtonTest">Cancel check</button>
    </div>
    <p class="mt-2 text-xs" :class="voice.buttonTest.phase === 'complete' ? 'text-success' : voice.buttonTest.phase === 'error' ? 'text-warning' : 'text-muted-fg'" role="status">{{ voice.buttonTest.message }}</p>
  </div>
</template>
