<script setup>
import { computed } from 'vue';
import { useDataSourcesUiStore } from '../stores/data-sources-ui.js';
import { useStatusStore } from '../stores/status.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';

const dataSourcesUi = useDataSourcesUiStore();
const status = useStatusStore();

const sources = computed(() => {
  const flatSources = Array.isArray(status.dataSources)
    ? status.dataSources.filter(Boolean)
    : [];
  if (flatSources.length > 0) return flatSources;
  return [
    status.primarySource,
    ...(Array.isArray(status.secondarySources) ? status.secondarySources : []),
  ].filter(Boolean);
});

const hasSources = computed(() => sources.value.length > 0);

function sourceName(source) {
  return source?.name || source?.type || 'Unknown';
}

function sourceKey(source, index) {
  return `${source?.type || 'source'}-${source?.name || 'unknown'}-${index}`;
}

function sourceDotClass(source) {
  return source?.connected ? 'bg-success pulse-dot' : 'bg-gray-500';
}

function sourceStatusText(source) {
  if (source?.description) return source.description;
  if (Array.isArray(source?.categories) && source.categories.length > 0) {
    return `Active: ${source.categories.join(', ')}`;
  }
  return source?.connected ? 'Connected' : 'Not connected';
}

function closeOnEscape(event) {
  if (event.key === 'Escape' && dataSourcesUi.modalOpen) {
    dataSourcesUi.closeModal();
  }
}

useDocumentEvent('keydown', closeOnEscape);
</script>

<template>
  <div
    v-if="dataSourcesUi.modalOpen"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop"
    @click.self="dataSourcesUi.closeModal()"
  >
    <div class="modal-enter bg-surface-100 border border-surface-200 rounded-lg p-6 max-w-sm w-full shadow-2xl">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold">Data Sources</h2>
        <button type="button" class="modal-close-button p-1 rounded-lg hover:bg-surface-200 transition-colors" aria-label="Close data sources" @click="dataSourcesUi.closeModal()">
          <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="space-y-4">
        <div v-if="hasSources">
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Sources</div>
          <div class="space-y-2">
            <div
              v-for="(source, index) in sources"
              :key="sourceKey(source, index)"
              class="flex items-center gap-3 bg-surface-200 rounded-lg px-4 py-3"
            >
              <div class="w-2.5 h-2.5 rounded-full" :class="sourceDotClass(source)"></div>
              <div class="flex-1">
                <div class="font-medium">{{ sourceName(source) }}</div>
                <div class="text-xs text-gray-500">{{ sourceStatusText(source) }}</div>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="flex items-center gap-3 bg-surface-200 rounded-lg px-4 py-3">
          <div class="w-2.5 h-2.5 rounded-full bg-gray-500"></div>
          <div>
            <div class="font-medium">No sources reported</div>
            <div class="text-xs text-gray-500">Waiting for telemetry status</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
