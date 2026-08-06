<script setup>
import { useSettingsFormStore } from '../stores/settings-form.js';

const settingsForm = useSettingsFormStore();
const teleportToBody = typeof document !== 'undefined' && !!document.body;
</script>

<template>
  <Teleport to="body" :disabled="!teleportToBody">
    <div
      id="settings-pending-bar"
      class="settings-pending-bar"
      :class="{ hidden: !settingsForm.pendingVisible, 'is-visible': settingsForm.pendingVisible }"
    >
      <div class="settings-pending-shell">
        <div class="settings-pending-copy">
          <div id="settings-pending-title" class="settings-pending-title">{{ settingsForm.pendingTitle }}</div>
          <div id="settings-pending-meta" class="settings-pending-meta">{{ settingsForm.pendingMeta }}</div>
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
