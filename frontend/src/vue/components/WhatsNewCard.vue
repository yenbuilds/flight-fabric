<script setup>
import { useWhatsNewStore } from '../stores/whats-new.js';

// Release highlights never carry a support ask: updates must respect the
// support opt-out, quiet period and lifetime limit too.
const whatsNew = useWhatsNewStore();
</script>

<template>
  <div
    v-if="whatsNew.visible"
    id="whats-new-card"
    class="app-prompt"
    role="status"
    :data-whats-new-version="whatsNew.version"
  >
    <div class="min-w-0">
      <div class="app-prompt-reason">Updated to {{ whatsNew.version }}</div>
      <div class="app-prompt-title">What's new</div>
      <ul class="app-prompt-list">
        <li v-for="(item, index) in whatsNew.highlights" :key="index">
          <span v-if="item.label" class="app-prompt-list-label">{{ item.label }}</span>
          {{ item.text }}
        </li>
      </ul>
    </div>
    <div class="app-prompt-actions">
      <button
        id="whats-new-dismiss"
        type="button"
        class="ff-button-primary px-3 py-1.5 text-xs"
        @click="whatsNew.dismiss()"
      >
        Got it
      </button>
      <a
        v-if="whatsNew.releaseNotesUrl"
        id="whats-new-release-notes"
        class="ff-button-secondary px-3 py-1.5 text-xs"
        :href="whatsNew.releaseNotesUrl"
        target="_blank"
        rel="noopener noreferrer"
      >
        Release notes
      </a>
    </div>
  </div>
</template>
