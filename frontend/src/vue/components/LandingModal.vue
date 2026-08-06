<script setup>
import LandingPanel from './LandingPanel.vue';
import { useLandingStore } from '../stores/landing.js';

const landing = useLandingStore();
</script>

<template>
  <div
    v-if="landing.landingModalOpen"
    id="landing-modal"
    class="landing-modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="landing-modal-title"
    @click.self="landing.closeLandingModal()"
  >
    <section class="landing-modal-shell">
      <header class="landing-modal-header">
        <div class="min-w-0">
          <div class="landing-modal-kicker">Landing Debrief</div>
          <div id="landing-modal-title" class="landing-modal-title">
            {{ landing.landingCard.airportText !== '--' ? landing.landingCard.airportText : 'Recorded landing' }}
            <span v-if="landing.landingCard.runwayText !== '--'" class="landing-modal-runway">{{ landing.landingCard.runwayText }}</span>
          </div>
        </div>
        <button
          id="landing-modal-close"
          type="button"
          class="landing-modal-close"
          aria-label="Close landing debrief"
          @click="landing.closeLandingModal()"
        >
          Close
        </button>
      </header>

      <div v-if="landing.landingModalLoading" id="landing-modal-loading" class="landing-modal-state" role="status">
        Loading landing details...
      </div>
      <div v-else-if="landing.landingModalError" id="landing-modal-error" class="landing-modal-state landing-modal-error" role="alert">
        {{ landing.landingModalError }}
      </div>
      <div v-else class="landing-modal-content">
        <LandingPanel />
      </div>
    </section>
  </div>
</template>
