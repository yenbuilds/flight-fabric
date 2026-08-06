<script setup>
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';

const introCopy = 'Detection is read-only. It does not change simulator files.';
const settingsUi = useSettingsUiStore();

function closeModal() {
  settingsUi.closeMsfsInstallsModal();
}

function closeOnEscape(event) {
  if (event.key === 'Escape') {
    closeModal();
  }
}

async function detectInstalls() {
  await settingsUi.requestMsfsInstallDetection();
}

useDocumentEvent('keydown', closeOnEscape);
</script>

<template>
  <div
    id="msfs-installs-modal"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop"
    :class="{ hidden: !settingsUi.msfsInstallsModalOpen }"
    @click.self="closeModal"
  >
    <div class="modal-enter bg-surface-100 border border-surface-200 rounded-lg overflow-hidden max-w-lg w-full shadow-2xl">
      <div class="px-5 py-4 border-b border-surface-200 flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-semibold uppercase tracking-widest text-cyan-400" style="font-family: 'B612 Mono', monospace;">MSFS Install Locations</div>
          <div class="text-xs text-gray-500 mt-1">{{ introCopy }}</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            id="msfs-detect-btn"
            type="button"
            class="px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-medium hover:bg-cyan-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style="font-family: 'B612 Mono', monospace;"
            :disabled="settingsUi.msfsDetecting || !settingsUi.canDetectMsfsInstalls"
            @click="detectInstalls"
          >
            {{ settingsUi.msfsDetectButtonLabel }}
          </button>
          <button
            id="msfs-installs-modal-close"
            type="button"
            class="modal-close-button p-1 rounded-lg hover:bg-surface-200 transition-colors"
            aria-label="Close MSFS install locations"
            @click="closeModal"
          >
            <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div id="msfs-detect-results" class="divide-y divide-surface-200 max-h-96 overflow-y-auto">
        <div v-if="settingsUi.msfsDetectError" class="px-4 py-3 text-xs text-red-400">
          {{ settingsUi.msfsDetectError }}
        </div>
        <div v-else-if="settingsUi.msfsInstallRows.length === 0" class="px-4 py-3 text-xs text-gray-500">
          {{ settingsUi.msfsDetectEmptyMessage }}
        </div>
        <div v-for="entry in settingsUi.msfsInstallRows" :key="entry.key" class="px-4 py-3">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-gray-200" style="font-family: 'B612 Mono', monospace;">{{ entry.label }}</span>
            <span class="text-[10px]" :class="entry.badgeClass" style="font-family: 'B612 Mono', monospace;">{{ entry.badgeText }}</span>
          </div>
          <div
            v-for="path in entry.paths"
            :key="`${entry.key}-${path.key}`"
            class="mt-1"
          >
            <span class="text-[10px] uppercase tracking-widest text-gray-500" style="font-family: 'B612 Mono', monospace;">{{ path.label }}</span>
            <div class="text-xs text-gray-300 break-all mt-0.5" style="font-family: 'B612 Mono', monospace;">{{ path.value }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
