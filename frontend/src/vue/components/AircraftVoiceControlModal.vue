<script setup>
import {
  computed,
  nextTick,
  onMounted,
  ref,
  watch,
} from 'vue';
import { containDialogFocus } from '../../ui/dialog-focus.js';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import VoiceControlPanel from './VoiceControlPanel.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'open-guide', 'open-settings']);
const aircraftControls = useAircraftControlsStore();
const voice = useVoiceControlStore();
const mounted = ref(false);
const panelRef = ref(null);
const closeButtonRef = ref(null);

const voiceCommandCount = computed(() => Object.values(
  aircraftControls.aircraftCommandCatalogue.commands || {},
).filter((command) => Array.isArray(command?.speech?.patterns)
  && command.speech.patterns.some((pattern) => typeof pattern === 'string' && pattern.trim())).length);

const commandCountLabel = computed(() => (
  `${voiceCommandCount.value} voice command${voiceCommandCount.value === 1 ? '' : 's'}`
));

function closeModal() {
  emit('close');
}

function handleKeydown(event) {
  if (!props.open || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
    return;
  }
  containDialogFocus(event, panelRef.value);
}

watch(
  () => props.open,
  (open) => {
    if (open) nextTick(() => closeButtonRef.value?.focus?.({ preventScroll: true }));
  },
  { immediate: true },
);

useBodyClass(() => props.open, 'ff-dialog-open');
useDocumentEvent('keydown', handleKeydown);
onMounted(() => { mounted.value = true; });
</script>

<template>
  <Teleport to="body" :disabled="!mounted">
    <div
      v-if="open"
      id="aircraft-voice-control-modal"
      class="fixed inset-0 z-[260] flex items-center justify-center bg-black/75 p-0 backdrop-blur-sm sm:p-4"
      data-aircraft-voice-control-modal
      data-no-swipe
      @click.self="closeModal"
    >
      <section
        ref="panelRef"
        class="flex h-[var(--ff-visual-viewport-height,100dvh)] w-full flex-col overflow-hidden border-white/10 bg-surface-100 shadow-2xl sm:h-auto sm:max-h-[90vh] sm:max-w-4xl sm:rounded-2xl sm:border"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aircraft-voice-control-title"
        aria-describedby="aircraft-voice-control-description"
      >
        <header class="shrink-0 border-b border-white/10 bg-gradient-to-r from-emerald-500/[0.08] via-transparent to-sky-500/[0.05] px-4 py-4 sm:px-6 sm:py-5">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <h2 id="aircraft-voice-control-title" class="text-xl font-semibold text-white sm:text-2xl">
                {{ voice.bridgeAvailable ? 'Voice commands' : 'Voice phrases' }}
              </h2>
              <p id="aircraft-voice-control-description" class="mt-1 max-w-2xl text-xs leading-5 text-muted-fg sm:text-sm">
                <template v-if="voice.bridgeAvailable">Hold your push-to-talk button or the button below, say a phrase, then release.</template>
                <template v-else>Keep these phrases beside your cockpit. Voice runs on your simulator PC.</template>
              </p>
            </div>
            <button
              ref="closeButtonRef"
              type="button"
              class="ff-touch-target shrink-0 rounded-lg p-2 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
              :aria-label="voice.bridgeAvailable ? 'Close voice commands' : 'Close voice phrases'"
              @click="closeModal"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div v-if="voiceCommandCount > 0" class="mt-4 flex flex-wrap items-center gap-2">
            <button
              v-if="voiceCommandCount > 0"
              type="button"
              class="rounded-full border border-accent/30 bg-accent/[0.07] px-3 py-1.5 text-[11px] font-medium text-accent transition-colors hover:border-accent/55 hover:bg-accent/15"
              aria-haspopup="dialog"
              aria-controls="aircraft-integration-cheatsheet-modal"
              @click="emit('open-guide')"
            >
              Browse {{ commandCountLabel }}
            </button>
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          <VoiceControlPanel presentation="modal" @open-settings="emit('open-settings')" />
        </div>
      </section>
    </div>
  </Teleport>
</template>
