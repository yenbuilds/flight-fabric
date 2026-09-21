<script setup>
import { computed, ref, watch } from 'vue';
import { useVoicePushToTalk } from '../composables/useVoicePushToTalk.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useVoiceFirstCommandStore } from '../stores/voice-first-command.js';

// The first voice moment: one quotable phrase and the button to say it into,
// right on the card, so nobody has to find the Aircraft page first. Non-modal,
// never takes focus, and a sent command is the only thing that changes it.
const card = useVoiceFirstCommandStore();
const voice = useVoiceControlStore();
const { press, pressWithKeyboard, release, cancelLocalPress } = useVoicePushToTalk(voice);
const enabling = ref(false);

const ATTENTION_STATUSES = Object.freeze(['error', 'failed', 'blocked', 'unavailable', 'unmatched']);

const voiceOff = computed(() => voice.runtime.enabled !== true);
const eyebrow = computed(() => (
  card.prompt?.aircraftName ? `Voice control · ${card.prompt.aircraftName}` : 'Voice control'
));
const holdDisabled = computed(() => !voice.ready && !voice.listening);
const holdLabel = computed(() => {
  if (voice.listening) return 'Release to send';
  if (voice.status === 'starting') return 'Release to cancel';
  if (voice.status === 'initializing') return 'Starting voice';
  if (voice.finishing || voice.status === 'sending') return 'Processing';
  return 'Hold to talk';
});
// Only the outcomes worth reading: what was heard, or why nothing happened.
// The ready hint is already on the button.
const note = computed(() => {
  if (voiceOff.value) return '';
  const heard = voice.transcript ? `Heard: “${voice.transcript}”` : '';
  const problem = ATTENTION_STATUSES.includes(voice.status) ? voice.statusText : '';
  return [heard, problem].filter(Boolean).join(' · ');
});

// The card can be withdrawn while the button is held (sim into a menu,
// another card taking the slot); a detached button may never see pointerup.
watch(() => card.visible, (visible) => {
  if (!visible) cancelLocalPress();
});
const doneDetail = computed(() => voice.lastCommand || voice.statusText || 'Command sent.');

async function enableVoice() {
  if (enabling.value) return;
  enabling.value = true;
  try {
    await voice.setRecognitionEnabled(true);
  } finally {
    enabling.value = false;
  }
}
</script>

<template>
  <div
    v-if="card.visible"
    id="voice-first-command-card"
    class="app-prompt"
    role="status"
    :data-voice-first-command-stage="card.prompt.stage"
  >
    <template v-if="card.prompt.stage === 'try'">
      <div class="min-w-0">
        <div class="app-prompt-reason">{{ eyebrow }}</div>
        <div class="app-prompt-title">Try one voice command</div>
        <div class="app-prompt-intent">
          <template v-if="voiceOff">
            Turn on voice, hold the button, say
            <strong id="voice-first-command-example" class="text-fg">“{{ card.prompt.example }}”</strong>,
            then let go. Recognition runs on this PC; audio never leaves it.
          </template>
          <template v-else>
            Hold the button, say
            <strong id="voice-first-command-example" class="text-fg">“{{ card.prompt.example }}”</strong>,
            then let go. Watch the flight deck, then listen for the readback.
          </template>
        </div>
        <div v-if="note" id="voice-first-command-note" class="app-prompt-footnote" aria-live="polite">{{ note }}</div>
      </div>
      <div class="app-prompt-actions">
        <button
          v-if="voiceOff"
          id="voice-first-command-enable"
          type="button"
          class="ff-button-primary px-3 py-1.5 text-xs"
          :disabled="enabling"
          @click="enableVoice"
        >
          {{ enabling ? 'Turning on voice…' : 'Turn on voice' }}
        </button>
        <button
          v-else
          id="voice-first-command-talk"
          type="button"
          class="ff-button flex select-none items-center gap-2 border px-3 py-1.5 text-xs font-medium"
          :class="voice.listening ? 'voice-first-command-talk--listening' : 'ff-button-primary'"
          :disabled="holdDisabled"
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
          <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="2.5" width="6" height="12" rx="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
          </svg>
          {{ holdLabel }}
        </button>
        <button
          id="voice-first-command-dismiss"
          type="button"
          class="ff-button-secondary px-3 py-1.5 text-xs"
          @click="card.dismiss()"
        >
          Not now
        </button>
        <button
          id="voice-first-command-mute"
          type="button"
          class="ff-button-ghost px-2 py-1.5 text-xs"
          @click="card.mute()"
        >
          Don't show again
        </button>
      </div>
    </template>
    <template v-else>
      <div class="min-w-0">
        <div class="app-prompt-reason">Voice control</div>
        <div class="app-prompt-title">That was voice control.</div>
        <div id="voice-first-command-result" class="app-prompt-intent text-fg">{{ doneDetail }}</div>
        <div class="app-prompt-intent">
          <template v-if="voice.runtime.shortcut">
            Hold <kbd class="rounded border border-white/15 bg-black/20 px-1 font-mono text-[11px]">{{ voice.runtime.shortcut }}</kbd>
            with the simulator in front and FlightFabric listens the same way.
          </template>
          <template v-else>
            Set a push-to-talk shortcut under Aircraft › Voice control to use it with the simulator in front.
          </template>
        </div>
      </div>
      <div class="app-prompt-actions">
        <button
          id="voice-first-command-done"
          type="button"
          class="ff-button-primary px-3 py-1.5 text-xs"
          @click="card.dismiss()"
        >
          Done
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The shared primary button colours are !important; listening swaps the
   class out entirely so the red state cannot lose to them. */
.voice-first-command-talk--listening {
  border-color: rgb(248 113 113 / 0.8) !important;
  background: rgb(220 38 38) !important;
  color: white !important;
}
</style>
