<script setup>
import { computed } from 'vue';
import { useDataSourcesUiStore } from '../stores/data-sources-ui.js';
import { useStatusStore } from '../stores/status.js';

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

const connectedSources = computed(() => sources.value.filter((source) => source?.connected));

function shortSourceName(source) {
  if (source?.type === 'lvar-sidecar') return 'LVAR';
  if (source?.type === 'sdk' || (Array.isArray(source?.categories) && source.categories.includes('sdk'))) {
    return 'SDK';
  }
  return source?.name || source?.type || '--';
}

const label = computed(() => {
  const visibleSources = sources.value;
  if (visibleSources.length === 0) return '--';

  const visibleNames = visibleSources.slice(0, 3).map(shortSourceName);
  const extraCount = visibleSources.length - visibleNames.length;
  return extraCount > 0
    ? `${visibleNames.join(' + ')} +${extraCount}`
    : visibleNames.join(' + ');
});

const labelClass = computed(() => (connectedSources.value.length > 0 ? 'text-success' : 'text-muted-fg'));
</script>

<template>
  <button
    type="button"
    class="ff-toolbar-button"
    aria-label="View active data sources"
    @click="dataSourcesUi.openModal()"
  >
    <span :class="labelClass">{{ label }}</span>
  </button>
</template>
