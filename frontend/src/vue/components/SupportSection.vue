<script setup>
import { SUPPORT_NOTE, SUPPORT_THANKS } from '../../support/copy.js';
import { SUPPORT_URL as coffeeHref } from '../../support/links.js';
import { useSupportStore } from '../stores/support.js';

// The one place in the app that explains who builds it and why a coffee
// matters. Preferences here apply at once and live in this browser.
const support = useSupportStore();
</script>

<template>
  <div id="about-support" class="px-4 py-4 space-y-3">
    <div class="text-[10px] uppercase tracking-widest text-cyan-400" style="font-family: 'B612 Mono', monospace;">Support</div>
    <p id="about-support-note" class="text-xs leading-relaxed text-gray-400">{{ SUPPORT_NOTE }}</p>

    <div class="flex flex-wrap items-center gap-3">
      <a
        id="about-support-coffee"
        class="ff-button-secondary px-3 py-1.5 text-xs"
        :href="coffeeHref"
        target="_blank"
        rel="noopener noreferrer"
      >
        <svg class="h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true" focusable="false">
          <path stroke-linecap="round" stroke-linejoin="round" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
        </svg>
        Buy Yen a coffee
      </a>
      <span class="text-[11px] text-gray-500">Optional support. FlightFabric stays free.</span>
    </div>

    <div v-if="support.goalSummary" id="about-support-goal" class="support-goal">
      <div class="flex items-center justify-between gap-3 text-[11px] text-gray-400">
        <span>{{ support.goalSummary.label }}</span>
        <span class="font-mono text-gray-500">{{ support.goalSummary.percent }}%</span>
      </div>
      <div class="support-goal-track" aria-hidden="true">
        <div class="support-goal-fill" :style="{ width: `${support.goalSummary.percent}%` }"></div>
      </div>
    </div>

    <p id="about-support-thanks" class="text-xs leading-relaxed text-gray-500">{{ SUPPORT_THANKS }}</p>

    <div class="space-y-2 border-t border-surface-200 pt-3">
      <div v-if="support.supported" id="about-support-supporter" class="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span class="text-gray-200">
          <span class="text-primary" aria-hidden="true">&#9829;</span>
          You're a supporter. Thank you.
        </span>
        <button
          id="about-support-undo"
          type="button"
          class="ff-button-ghost px-2 py-1 text-[11px]"
          @click="support.setSupported(false)"
        >
          Undo
        </button>
      </div>
      <div v-else class="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span class="text-gray-400">Already bought a coffee?</span>
        <button
          id="about-support-mark"
          type="button"
          class="ff-button-secondary px-3 py-1 text-[11px]"
          @click="support.setSupported(true)"
        >
          I've supported
        </button>
      </div>

      <div class="flex items-start gap-3">
        <input
          id="about-support-prompts"
          type="checkbox"
          class="mt-0.5 h-4 w-4 rounded border-surface-300 bg-surface-100 text-cyan-400 focus:ring-cyan-500/30"
          :checked="support.promptsEnabled"
          :disabled="support.supported"
          aria-describedby="about-support-prompts-help"
          @change="support.setMuted(!$event.target.checked)"
        />
        <div class="min-w-0 flex-1">
          <label for="about-support-prompts" class="block cursor-pointer text-xs font-medium text-gray-200">Occasionally ask me to support</label>
          <p id="about-support-prompts-help" class="mt-0.5 text-[11px] leading-relaxed text-gray-500">
            At most five times ever, after a landing at 10, 50, 100, 250 and 500 recorded flights; never in your first week, never within 30 days of the last ask, and the card fades by itself. Off automatically once you've supported.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
