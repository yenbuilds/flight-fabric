<script setup>
import { nextTick } from 'vue';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';
import { openVoiceSettings } from '../voice-settings-navigation.js';
import VoiceRestartHint from './VoiceRestartHint.vue';

const voice = useVoiceControlStore();
const tabs = useTabsStore();

async function openSetup() {
  await openVoiceSettings(tabs, voice);
}

async function dismiss(event) {
  const nextTarget = event.currentTarget.closest('[role="dialog"], nav')?.querySelector('[data-tab="settings"]');
  voice.dismissSetup();
  await nextTick();
  const candidates = [nextTarget, ...document.querySelectorAll('[data-tab="settings"], #mobile-more-btn')];
  candidates.find(element => element?.isConnected && element.getClientRects().length && !element.closest('[inert]'))?.focus({ preventScroll: true });
}
</script>

<template>
  <section v-if="voice.setupReminder" class="toolbar-setup-task voice-setup-task" aria-label="Voice control setup">
    <button type="button" class="toolbar-setup-open" data-voice-setup-trigger
      :aria-label="voice.setupReminder.action"
      :title="voice.restartHintVisible ? 'Voice could not start. Open voice settings for restart guidance.' : voice.setupReminder.action"
      aria-controls="settings-voice-control" @click="openSetup">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="2.5" width="6" height="12" rx="3" />
        <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
      </svg>
      <span class="toolbar-setup-copy"><strong>Voice control</strong><span v-if="!voice.restartHintVisible">{{ voice.setupReminder.detail }}</span><b>{{ voice.setupReminder.action }} <span aria-hidden="true">→</span></b></span>
    </button>
    <VoiceRestartHint class="toolbar-setup-copy" />
    <div v-if="voice.setupReminder.optional" class="toolbar-setup-copy toolbar-setup-meta">
      <span>Optional</span>
      <button type="button" data-voice-setup-dismiss title="Hide this suggestion. Voice control stays in Settings." @click="dismiss">Not now</button>
    </div>
  </section>
</template>
