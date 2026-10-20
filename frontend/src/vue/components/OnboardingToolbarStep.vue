<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useToolbarPanelStore } from '../stores/toolbar-panel.js';

defineProps({ disabled: Boolean });
const toolbar = useToolbarPanelStore();
const feedback = ref(null);
const rows = computed(() => toolbar.rows.filter(row => row.found));
const offersInstall = computed(() => rows.value.some(row => row.canInstall && row.status !== 'installed'));
const statusClasses = { good: 'ff-status-chip-success', warn: 'ff-status-chip-warning', danger: 'ff-status-chip-danger', muted: 'ff-status-chip' };

// Reuse Settings' detected installations and guarded desktop installer.
// Discovery alone never prevents finishing setup.
watch(() => toolbar.available, (available) => {
  if (available && !toolbar.busy) toolbar.refresh({ preserveError: true });
}, { immediate: true });

async function install(installId) {
  await toolbar.install(installId);
  await nextTick();
  feedback.value?.focus({ preventScroll: true });
  feedback.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
</script>

<template>
  <section class="onboarding-toolbar" aria-label="MSFS toolbar installation">
    <p v-if="!toolbar.available" class="onboarding-note" role="status">To install it, open the FlightFabric desktop app on your simulator PC.</p>
    <template v-else>
      <div class="onboarding-toolbar-tools">
        <p v-if="offersInstall" class="onboarding-note">Close MSFS before installing or updating.</p>
        <button type="button" class="ff-button-ghost onboarding-toolbar-refresh" :disabled="disabled || toolbar.busy" @click="toolbar.refresh()">
          {{ toolbar.loading ? 'Checking…' : 'Check again' }}
        </button>
      </div>
      <p v-if="toolbar.loading && !toolbar.hasLoaded" class="onboarding-note" role="status">Checking your MSFS 2024 installations…</p>
      <p v-else-if="toolbar.hasLoaded && !rows.length && !toolbar.error && !toolbar.sourceError" class="onboarding-note" role="status">No MSFS 2024 installation was found. FlightFabric checks the Microsoft Store and Steam locations on this PC.</p>
      <div v-for="row in rows" :key="row.key" class="onboarding-toolbar-install" :data-onboarding-install="row.installId">
        <div class="onboarding-toolbar-status">
          <strong>{{ row.label }}</strong>
          <span :class="statusClasses[row.tone]" data-onboarding-toolbar-status>{{ row.statusLabel }}</span>
        </div>
        <p v-if="row.detail && row.status !== 'installed'" class="onboarding-note">{{ row.detail }}</p>
        <button v-if="row.canInstall && row.status !== 'installed'" type="button" class="ff-button-secondary"
          :disabled="disabled || toolbar.busy || Boolean(toolbar.sourceError)" data-onboarding-toolbar-action
          @click="install(row.installId)">
          {{ toolbar.busyInstallId === row.installId ? 'Working…' : row.status === 'not_installed' ? 'Install toolbar' : row.actionLabel }}
        </button>
      </div>
      <p v-if="toolbar.error || toolbar.sourceError || toolbar.result" ref="feedback" tabindex="-1"
        :class="toolbar.error || toolbar.sourceError ? 'onboarding-error' : 'onboarding-note onboarding-toolbar-success'"
        :role="toolbar.error || toolbar.sourceError ? 'alert' : 'status'">
        {{ toolbar.error || toolbar.sourceError || (toolbar.result.action === 'install' ? 'Toolbar installed.' : toolbar.result.message) }}
        <template v-if="!toolbar.error && !toolbar.sourceError"> {{ toolbar.restartNotice }}</template>
      </p>
    </template>
    <p class="onboarding-note">After installing, load a flight and open <strong>FlightFabric</strong> from the in-flight toolbar. Keep the desktop app running.</p>
  </section>
</template>
