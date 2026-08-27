<script setup>
import {
  computed,
  nextTick,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import VoiceControlPanel from './VoiceControlPanel.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'open-guide']);
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
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(panelRef.value?.querySelectorAll?.(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  ) || []);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
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
              <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">Desktop voice</div>
              <h2 id="aircraft-voice-control-title" class="mt-1 text-xl font-semibold text-white sm:text-2xl">
                Voice control
              </h2>
              <p id="aircraft-voice-control-description" class="mt-1 max-w-2xl text-xs leading-5 text-muted-fg sm:text-sm">
                Keep Flight Fabric in the background and use the global push-to-talk shortcut while flying. Open this panel only when you need the on-screen button or microphone settings.
              </p>
            </div>
            <button
              ref="closeButtonRef"
              type="button"
              class="ff-touch-target shrink-0 rounded-lg p-2 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Close voice control"
              @click="closeModal"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <span class="rounded-full border border-white/10 bg-black/15 px-3 py-1.5 font-mono text-[11px] text-gray-300">
              {{ voice.runtime.shortcut }}
            </span>
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
          <VoiceControlPanel presentation="modal" />
        </div>
      </section>
    </div>
  </Teleport>
</template>
