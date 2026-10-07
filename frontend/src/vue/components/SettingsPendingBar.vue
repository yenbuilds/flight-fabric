<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useSettingsFormStore } from '../stores/settings-form.js';

const settingsForm = useSettingsFormStore();
const teleportToBody = typeof document !== 'undefined' && !!document.body;
const bar = ref(null);
let observer = null;
let revision = 0;
function reserveSpace() {
  const main = document.getElementById('vue-main-root');
  const height = settingsForm.pendingVisible ? (bar.value?.getBoundingClientRect().height || 0) + 24 : 0;
  main?.style.setProperty('--settings-pending-space', `${height}px`);
  if (main && bar.value && settingsForm.pendingVisible) {
    const bounds = main.getBoundingClientRect();
    bar.value.style.bottom = `${Math.max(16, window.innerHeight - bounds.bottom + 8)}px`;
    bar.value.style.left = `${bounds.left + 16}px`;
    bar.value.style.right = `${window.innerWidth - bounds.right + 16}px`;
  }
}
watch(() => settingsForm.pendingVisible, async () => {
  const current = ++revision;
  observer?.disconnect();
  await nextTick();
  if (current !== revision) return;
  reserveSpace();
  if (bar.value && settingsForm.pendingVisible) {
    observer = new ResizeObserver(reserveSpace);
    observer.observe(bar.value);
    const main = document.getElementById('vue-main-root');
    if (main) observer.observe(main);
  }
});
onBeforeUnmount(() => {
  revision++;
  observer?.disconnect();
  document.getElementById('vue-main-root')?.style.removeProperty('--settings-pending-space');
});
</script>

<template>
  <Teleport to="body" :disabled="!teleportToBody">
    <div
      id="settings-pending-bar"
      ref="bar"
      class="settings-pending-bar"
      :class="{ hidden: !settingsForm.pendingVisible, 'is-visible': settingsForm.pendingVisible }"
    >
      <div class="settings-pending-shell">
        <div class="settings-pending-copy">
          <div id="settings-pending-title" class="settings-pending-title">{{ settingsForm.statusTone === 'error' ? 'Settings not confirmed' : settingsForm.pendingTitle }}</div>
          <div id="settings-pending-meta" class="settings-pending-meta" :class="{ 'text-danger': settingsForm.statusTone === 'error' }">{{ settingsForm.statusTone === 'error' ? settingsForm.statusMessage : settingsForm.pendingMeta }}</div>
        </div>

        <div class="settings-pending-actions">
          <button
            id="settings-pending-save-btn"
            type="button"
            class="settings-btn-accent settings-pending-btn px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            :disabled="settingsForm.saveButtonDisabled"
            @click="settingsForm.requestSave()"
          >
            {{ settingsForm.pendingSaveButtonLabel }}
          </button>
          <button
            id="settings-pending-reload-btn"
            type="button"
            class="settings-pending-btn px-3 py-1.5 rounded-lg bg-surface-200 border border-surface-300 text-gray-300 text-sm font-medium hover:bg-surface-300 transition-colors"
            :disabled="settingsForm.reloadButtonDisabled"
            @click="settingsForm.requestReload()"
          >
            {{ settingsForm.pendingReloadButtonLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
