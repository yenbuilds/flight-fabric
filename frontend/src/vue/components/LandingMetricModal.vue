<script setup>
import { useLandingStore } from '../stores/landing.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';

const landing = useLandingStore();

function handleKeydown(event) {
  if (event.key === 'Escape' && landing.stabilityMetricModal.open) {
    landing.closeStabilityMetricModal();
  }
}

useDocumentEvent('keydown', handleKeydown);
</script>

<template>
  <div id="stability-metric-modal" :class="landing.stabilityMetricModalClass" @click.self="landing.closeStabilityMetricModal()">
    <div class="modal-enter bg-surface-100 border border-surface-200 rounded-lg p-6 max-w-md w-full shadow-2xl">
      <div class="flex items-start justify-between mb-3 gap-3">
        <div>
          <h2 id="stability-metric-modal-title" class="text-lg font-semibold">{{ landing.stabilityMetricModal.title }}</h2>
          <div id="stability-metric-modal-score" class="text-sm text-gray-400 mt-0.5">{{ landing.stabilityMetricModal.scoreText }}</div>
        </div>
        <button
          id="stability-metric-modal-close"
          type="button"
          class="modal-close-button p-1 rounded-lg hover:bg-surface-200 transition-colors flex-shrink-0"
          aria-label="Close metric details"
          @click="landing.closeStabilityMetricModal()"
        >
          <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="space-y-3 text-sm">
        <div>
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-1">What it measures</div>
          <div id="stability-metric-modal-desc" class="text-gray-300 leading-relaxed">{{ landing.stabilityMetricModal.descriptionText }}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-1">Pass criteria</div>
          <div id="stability-metric-modal-criteria" class="text-gray-300 leading-relaxed">{{ landing.stabilityMetricModal.criteriaText }}</div>
        </div>
        <div id="stability-metric-modal-detail-wrap" :class="{ hidden: !landing.stabilityMetricModal.detailVisible }">
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-1">Observed</div>
          <div id="stability-metric-modal-detail" class="text-gray-300 leading-relaxed">{{ landing.stabilityMetricModal.detailText }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
