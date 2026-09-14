<script setup>
import { nextTick, onMounted, ref, watch } from 'vue';
import { containDialogFocus } from '../../ui/dialog-focus.js';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import AircraftCommandBrowser from './AircraftCommandBrowser.vue';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);
const mounted = ref(false), panel = ref(null);
watch(() => props.open, open => {
  if (open) nextTick(() => panel.value?.querySelector('input[type="search"]')?.focus());
});
useBodyClass(() => props.open, 'ff-dialog-open');
useBodyClass(() => props.open, 'aircraft-controls-open');
useDocumentEvent('keydown', event => {
  if (!props.open || event.defaultPrevented) return;
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); }
  else containDialogFocus(event, panel.value);
});
onMounted(() => { mounted.value = true; });
</script>

<template>
  <Teleport to="body" :disabled="!mounted">
    <div v-if="open" id="aircraft-controls-modal" class="fixed inset-0 z-[260] flex items-center justify-center bg-black/75 p-0 backdrop-blur-sm sm:p-4"
      data-aircraft-controls-modal data-no-swipe @click.self="emit('close')">
      <section ref="panel" role="dialog" aria-modal="true" aria-labelledby="aircraft-controls-title"
        class="flex h-[var(--ff-visual-viewport-height,100dvh)] w-full flex-col overflow-hidden bg-surface-100 shadow-2xl sm:h-auto sm:max-h-[90vh] sm:max-w-5xl sm:rounded-2xl sm:border sm:border-white/10">
        <header class="flex shrink-0 items-center justify-between gap-4 border-b border-surface-200 px-4 py-4 sm:px-6">
          <div>
            <h2 id="aircraft-controls-title" class="text-xl font-semibold text-gray-100">Control library</h2>
            <p class="mt-1 text-xs text-muted-fg">Search available controls and their voice commands.</p>
          </div>
          <button type="button" class="ff-touch-target rounded-lg px-3 text-xl text-gray-300 hover:bg-white/10"
            aria-label="Close aircraft controls" @click="emit('close')">&times;</button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <AircraftCommandBrowser embedded />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
:global(body.aircraft-controls-open) {
  overflow: hidden;
}
</style>
