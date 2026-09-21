<script setup>
import { computed } from 'vue';
import { SUPPORT_NOTE_SHORT } from '../../support/copy.js';
import { SUPPORT_URL as coffeeHref } from '../../support/links.js';
import { useSupportStore } from '../stores/support.js';

// Milestone card: shows what the app has done for this person, then asks
// once. Non-modal, never takes focus, and every path out of it is honoured.
const support = useSupportStore();
const prompt = computed(() => support.prompt);

const eyebrow = computed(() => (prompt.value ? `${prompt.value.milestone} flights recorded` : ''));
const title = computed(() => {
  if (!prompt.value) return '';
  const flights = `${prompt.value.total} flight${prompt.value.total === 1 ? '' : 's'}`;
  const airports = prompt.value.airports > 1 ? ` across ${prompt.value.airports} airports` : '';
  return `FlightFabric has recorded ${flights}${airports} for you.`;
});
</script>

<template>
  <div
    v-if="support.promptVisible"
    id="support-prompt"
    class="app-prompt"
    role="status"
    :data-support-stage="prompt.stage"
    :data-support-milestone="prompt.milestone"
  >
    <template v-if="prompt.stage === 'ask'">
      <div class="min-w-0">
        <div class="app-prompt-reason">{{ eyebrow }}</div>
        <div class="app-prompt-title">{{ title }}</div>
        <div class="app-prompt-intent">{{ SUPPORT_NOTE_SHORT }}</div>
      </div>
      <div class="app-prompt-actions">
        <a
          id="support-prompt-coffee"
          class="ff-button-primary px-3 py-1.5 text-xs"
          :href="coffeeHref"
          target="_blank"
          rel="noopener noreferrer"
          @click="support.coffeeClicked()"
        >
          Buy Yen a coffee
        </a>
        <button
          id="support-prompt-dismiss"
          type="button"
          class="ff-button-secondary px-3 py-1.5 text-xs"
          @click="support.dismissPrompt()"
        >
          Not now
        </button>
        <button
          id="support-prompt-mute"
          type="button"
          class="ff-button-ghost px-2 py-1.5 text-xs"
          @click="support.setMuted(true)"
        >
          Don't ask again
        </button>
      </div>
    </template>
    <template v-else>
      <div class="min-w-0">
        <div class="app-prompt-reason">Thank you</div>
        <div class="app-prompt-title">The support page opened in your browser.</div>
        <div class="app-prompt-intent">If you bought a coffee, tap below and I won't ask again. If not, no problem at all.</div>
      </div>
      <div class="app-prompt-actions">
        <button
          id="support-prompt-supported"
          type="button"
          class="ff-button-primary px-3 py-1.5 text-xs"
          @click="support.markSupportedFromPrompt()"
        >
          I've supported
        </button>
        <button
          id="support-prompt-close"
          type="button"
          class="ff-button-secondary px-3 py-1.5 text-xs"
          @click="support.dismissPrompt()"
        >
          Close
        </button>
      </div>
    </template>
  </div>
</template>
