<script setup>
import { ref } from 'vue';
import AppTooltip from './AppTooltip.vue';
import { useLandingStore } from '../stores/landing.js';

const props = defineProps({
  debriefMode: {
    type: Boolean,
    default: false,
  },
});

const stabilityExpanded = ref(!props.debriefMode);
const approachProfileExpanded = ref(!props.debriefMode);
const topdownProfileExpanded = ref(!props.debriefMode);
const detailedMetricsExpanded = ref(false);
const landing = useLandingStore();
</script>

<template>
  <div
    id="landing-waiting-state"
    class="landing-waiting-panel"
    :class="{ hidden: !landing.waitingVisible }"
    role="status"
    aria-live="polite"
  >
    <div class="landing-waiting-copy">
      <div class="landing-waiting-kicker">Landing Capture</div>
      <div class="landing-waiting-title">Ready for the next arrival</div>
      <div class="landing-waiting-description">No scored landing in this session yet.</div>
    </div>
    <div class="landing-waiting-status">
      <span class="landing-live-dot"></span>
      <span
        class="landing-waiting-status-text"
        style="font-family:'B612 Mono',monospace;"
      >SimConnect monitoring</span>
    </div>
  </div>

  <div
    id="landing-card"
    class="landing-gradient border border-surface-200 overflow-hidden"
    :class="{ hidden: !landing.cardVisible }"
  >
    <div
      id="landing-excursion-banner"
      class="bg-red-900/80 border-b border-red-500 px-6 py-3"
      :class="{ hidden: !landing.landingCard.runwayExcursionVisible }"
    >
      <div class="flex items-center gap-3">
        <svg class="w-6 h-6 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <div>
          <div class="text-red-300 font-bold" style="font-family:'B612 Mono', monospace; letter-spacing: 0.1em;">
            RUNWAY EXCURSION
          </div>
          <div class="text-red-400 text-sm">Aircraft departed runway surface during rollout</div>
        </div>
      </div>
    </div>

    <div class="p-6 pb-4 border-b border-surface-200/30">
      <div class="telemetry-label mb-3">Landing Summary</div>
      <div class="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-4 lg:gap-8">
        <div>
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Touchdown rate grade</div>
          <div
            id="landing-grade"
            :key="landing.landingCard.gradeAnimationNonce"
            class="grade-pop text-2xl font-semibold"
            :style="[landing.landingGradeStyle, { fontFamily: '\'B612 Mono\', monospace', letterSpacing: '0.08em' }]"
          >{{ landing.landingCard.gradeText }}</div>
          <div
            id="landing-grade-breakdown"
            class="text-xs text-gray-400 mt-1"
            :class="{ hidden: !landing.landingCard.gradeBreakdownVisible }"
            style="font-family:'B612 Mono', monospace;"
          >{{ landing.landingCard.gradeBreakdownText }}</div>
          <div class="mt-2 flex items-baseline gap-2">
            <span class="text-[10px] text-gray-500 uppercase tracking-widest">Touchdown rate</span>
            <span id="landing-vs" class="text-lg font-semibold tabular telemetry-value" :style="landing.landingVsStyle">{{ landing.landingCard.vsText }}</span>
            <span class="telemetry-unit text-xs">fpm</span>
          </div>
          <div id="landing-gforce" class="text-xs text-gray-400 mt-1">{{ landing.landingCard.gforceText }}</div>
        </div>
        <div>
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Approach</div>
          <div
            id="landing-summary-approach"
            class="text-2xl font-semibold tabular"
            :class="landing.landingCard.approach.stabilityTone"
            style="font-family:'B612 Mono', monospace;"
          >{{ landing.landingCard.approach.stabilityText }}</div>
          <div id="landing-summary-approach-score" class="mt-1 text-xs text-gray-500">
            {{ landing.landingCard.approach.stabilityNoteText }}
          </div>
        </div>
        <div>
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Bounce</div>
          <div
            id="landing-summary-bounce"
            class="text-2xl font-semibold tabular"
            :class="landing.landingCard.touchdown.bounceTone"
            style="font-family:'B612 Mono', monospace;"
          >{{ landing.landingCard.touchdown.bounceText }}</div>
          <div id="landing-summary-bounce-detail" class="mt-1 text-xs" :class="landing.landingCard.touchdown.bounceGradeTone">
            {{ landing.landingCard.touchdown.bounceGradeText }}
          </div>
        </div>
        <div class="lg:ml-auto text-right">
          <div id="landing-airport" class="text-xl font-semibold">{{ landing.landingCard.airportText }}</div>
          <div id="landing-runway" class="text-sm text-gray-400">{{ landing.landingCard.runwayText }}</div>
        </div>
      </div>
    </div>

    <div
      id="landing-debrief-factors"
      class="border-t border-surface-200/30 px-6 py-4"
      :class="{ hidden: !landing.landingCard.debrief.visible }"
    >
      <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Debrief Factors</div>
          <div id="landing-debrief-reasons" class="flex flex-wrap gap-1.5">
            <span
              v-for="reason in landing.landingCard.debrief.reasons"
              :key="reason.key"
              class="rounded border px-2 py-1 text-[11px] font-medium"
              :style="{ color: reason.color, backgroundColor: reason.backgroundColor, borderColor: reason.borderColor }"
            >{{ reason.text }}</span>
          </div>
        </div>
        <div class="shrink-0 rounded border border-surface-200/50 bg-surface-100/40 px-3 py-2 text-right">
          <div class="text-[10px] uppercase tracking-widest text-gray-600">Telemetry confidence</div>
          <div id="landing-data-confidence" class="text-sm font-semibold" :class="landing.landingCard.debrief.confidenceToneClass">
            {{ landing.landingCard.debrief.confidenceText }}
          </div>
          <div
            id="landing-data-confidence-reason"
            class="max-w-[15rem] text-[11px] text-gray-500"
            :class="{ hidden: !landing.landingCard.debrief.confidenceReason }"
          >{{ landing.landingCard.debrief.confidenceReason }}</div>
        </div>
      </div>
    </div>

    <div
      id="landing-rollout-analysis"
      class="border-t border-surface-200/30 px-6 py-4"
      :class="{ hidden: !landing.landingCard.rollout.visible }"
    >
      <div class="flex items-center justify-between gap-3 mb-3">
        <div>
          <div class="text-[10px] text-gray-700 uppercase tracking-widest">Rollout Analysis</div>
          <div class="text-[11px] text-gray-500">Ground-roll control after touchdown</div>
        </div>
        <div
          id="landing-rollout-assessment"
          class="text-sm font-semibold tracking-wide"
          :class="landing.landingCard.rollout.assessmentToneClass"
        >{{ landing.landingCard.rollout.assessmentText }}</div>
      </div>
      <div id="landing-rollout-metrics" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div
          v-for="metric in landing.landingCard.rollout.metrics"
          :key="metric.key"
          class="rounded-lg bg-surface-200 px-3 py-2"
        >
          <div class="text-[10px] text-gray-500">{{ metric.label }}</div>
          <div class="text-sm font-semibold tabular text-gray-200">{{ metric.value }}</div>
        </div>
      </div>
      <div
        id="landing-rollout-note"
        class="mt-3 text-[11px] text-gray-500"
        :class="{ hidden: !landing.landingCard.rollout.noteText }"
      >{{ landing.landingCard.rollout.noteText }}</div>
    </div>

    <div id="stability-breakdown-section" class="border-t border-surface-200/30" :class="{ hidden: !landing.stabilityBreakdownVisible }">
      <button
        id="stability-toggle-btn"
        type="button"
        class="w-full p-3 flex items-center justify-between text-sm text-gray-400 hover:bg-surface-200/30 transition-colors"
        @click="stabilityExpanded = !stabilityExpanded"
      >
        <span>Stability Breakdown</span>
        <svg
          id="stability-chevron"
          class="w-4 h-4 transition-transform"
          :class="{ 'rotate-180': stabilityExpanded }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div id="stability-breakdown-content" class="px-6 pb-4" :class="{ hidden: !stabilityExpanded }">
        <div
          v-if="landing.stabilityContextText"
          class="mb-3 rounded border px-3 py-2 text-xs"
          :class="landing.stabilityContextGeneric
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'border-surface-200/50 bg-surface-100/40 text-gray-400'"
        >
          <div class="font-medium">{{ landing.stabilityContextText }}</div>
          <div v-if="landing.stabilityContextDetail" class="mt-0.5 text-[11px] opacity-80">
            {{ landing.stabilityContextDetail }}
          </div>
        </div>
        <div id="stability-breakdown-grid" class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <AppTooltip
            v-for="metric in landing.stabilityMetrics"
            :key="metric.key"
            :content="[metric.tooltip, metric.explanation].filter(Boolean).join(' - ')"
            anchor-class="w-full"
            placement="top"
          >
            <button
              type="button"
              class="stability-metric-card flex flex-col rounded-lg px-3 py-2 text-left w-full hover:ring-1 hover:ring-surface-300 focus:outline-none focus:ring-2 focus:ring-accent transition"
              :class="metric.backgroundClass"
              @click="landing.openStabilityMetricModal(metric.modal)"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-400 flex items-center gap-1">{{ metric.label }}
                  <svg class="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                </span>
                <span class="font-semibold tabular" :class="metric.valueClass">{{ metric.valueText }}</span>
              </div>
              <div v-if="metric.explanation" class="text-xs text-gray-500 mt-1 truncate">{{ metric.explanation }}</div>
            </button>
          </AppTooltip>
          <div
            v-if="landing.stabilitySamplesText"
            class="flex items-center justify-between bg-surface-200 rounded-lg px-3 py-2 col-span-2 sm:col-span-3"
          >
            <span class="text-sm text-gray-400">Samples analyzed</span>
            <span class="font-semibold tabular text-gray-300">{{ landing.stabilitySamplesText }}</span>
          </div>
        </div>
      </div>
    </div>

    <div id="approach-profile-section" class="border-t border-surface-200/30" :class="{ hidden: !landing.approachProfile.visible }">
      <button
        id="approach-profile-toggle-btn"
        type="button"
        class="w-full p-3 flex items-center justify-between text-sm text-gray-400 hover:bg-surface-200/30 transition-colors"
        @click="approachProfileExpanded = !approachProfileExpanded"
      >
        <span>Approach Profile</span>
        <svg
          id="approach-profile-chevron"
          class="w-4 h-4 transition-transform"
          :class="{ 'rotate-180': approachProfileExpanded }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div id="approach-profile-content" class="px-4 pb-4" :class="{ hidden: !approachProfileExpanded }">
        <div
          id="approach-profile-gate-label"
          class="mb-2 text-[10px] uppercase tracking-widest text-gray-600"
          style="font-family:'B612 Mono',monospace;"
          :class="{ hidden: !landing.approachProfile.gateLabel }"
        >{{ landing.approachProfile.gateLabel }}</div>
        <div
          id="approach-profile-svg-container"
          class="w-full bg-surface-100/50 rounded-lg overflow-hidden"
          style="min-height: 220px;"
          v-html="landing.approachProfile.svgHtml"
        ></div>
      </div>
    </div>

    <div id="topdown-profile-section" class="border-t border-surface-200/30" :class="{ hidden: !landing.topdownProfile.visible }">
      <button
        id="topdown-profile-toggle-btn"
        type="button"
        class="w-full p-3 flex items-center justify-between text-sm text-gray-400 hover:bg-surface-200/30 transition-colors"
        @click="topdownProfileExpanded = !topdownProfileExpanded"
      >
        <span>Ground Track</span>
        <svg
          id="topdown-profile-chevron"
          class="w-4 h-4 transition-transform"
          :class="{ 'rotate-180': topdownProfileExpanded }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div id="topdown-profile-content" class="px-4 pb-4" :class="{ hidden: !topdownProfileExpanded }">
        <div
          id="topdown-profile-svg-container"
          class="w-full bg-surface-100/50 rounded-lg overflow-hidden"
          style="min-height: 220px;"
          v-html="landing.topdownProfile.svgHtml"
        ></div>
      </div>
    </div>

    <div id="detailed-metrics-section" class="border-t border-surface-200/30">
      <button
        id="detailed-metrics-toggle-btn"
        type="button"
        class="w-full p-3 flex items-center justify-between text-sm text-gray-400 hover:bg-surface-200/30 transition-colors"
        @click="detailedMetricsExpanded = !detailedMetricsExpanded"
      >
        <span>Detailed Metrics</span>
        <svg
          id="detailed-metrics-chevron"
          class="w-4 h-4 transition-transform"
          :class="{ 'rotate-180': detailedMetricsExpanded }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div id="detailed-metrics-content" :class="{ hidden: !detailedMetricsExpanded }">
        <div class="px-6 pt-4 pb-2">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Touchdown</div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Distance</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">From threshold</div>
              <div id="landing-tdz-value" class="text-xl font-semibold tabular text-gray-100">{{ landing.landingCard.touchdown.distanceText }}</div>
              <div id="landing-tdz-grade" class="text-xs mt-0.5" :class="landing.landingCard.touchdown.distanceGradeTone">{{ landing.landingCard.touchdown.distanceGradeText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">1,000 ft target</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">From landing threshold</div>
              <div
                id="landing-tdz-achieved"
                class="text-xl font-semibold"
                :class="landing.landingCard.touchdown.achievedTone"
                style="font-family:'B612 Mono', monospace;"
              >{{ landing.landingCard.touchdown.achievedText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Lateral</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Offset from centerline - L/R</div>
              <div id="landing-lateral-value" class="text-xl font-semibold tabular" :class="landing.landingCard.touchdown.lateralTone">{{ landing.landingCard.touchdown.lateralText }}</div>
              <div id="landing-lateral-grade" class="text-xs mt-0.5" :class="landing.landingCard.touchdown.lateralGradeTone">{{ landing.landingCard.touchdown.lateralGradeText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Bounce</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Post-touchdown bounces</div>
              <div id="landing-bounce-value" class="text-xl font-semibold tabular" :class="landing.landingCard.touchdown.bounceTone">{{ landing.landingCard.touchdown.bounceText }}</div>
              <div id="landing-bounce-grade" class="text-xs mt-0.5" :class="landing.landingCard.touchdown.bounceGradeTone">{{ landing.landingCard.touchdown.bounceGradeText }}</div>
            </div>
          </div>
        </div>

        <div class="px-6 pt-4 pb-2">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Approach</div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Approach verdict</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">{{ landing.landingCard.approach.stabilityNoteText }}</div>
              <div
                id="landing-stability-score"
                class="text-xl font-semibold tabular"
                :class="landing.landingCard.approach.stabilityTone"
              >{{ landing.landingCard.approach.stabilityText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Speed</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">IAS at touchdown</div>
              <div id="landing-ias" class="text-xl font-semibold tabular text-gray-100">{{ landing.landingCard.approach.speedText }}</div>
              <div id="landing-gs" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.approach.gsText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Crosswind</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Wind across runway - L/R = from</div>
              <div id="landing-crosswind" class="text-xl font-semibold tabular" :class="landing.landingCard.approach.crosswindTone">{{ landing.landingCard.approach.crosswindText }}</div>
              <div id="landing-wind-total" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.approach.windTotalText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Type</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Approach category</div>
              <div
                id="landing-approach-type"
                class="text-xl font-semibold text-gray-100"
                style="font-family:'B612 Mono', monospace;"
              >{{ landing.landingCard.approach.typeText }}</div>
            </div>
          </div>
        </div>

        <div class="px-6 pt-4 pb-4">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Attitude</div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Pitch</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Nose angle - + = nose up</div>
              <div id="landing-pitch" class="text-xl font-semibold tabular" :class="landing.landingCard.attitude.pitchTone">{{ landing.landingCard.attitude.pitchText }}</div>
              <div id="landing-pitch-grade" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.attitude.pitchGradeText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Bank</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Wing tilt - L/R = wing down</div>
              <div id="landing-bank" class="text-xl font-semibold tabular" :class="landing.landingCard.attitude.bankTone">{{ landing.landingCard.attitude.bankText }}</div>
              <div id="landing-bank-grade" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.attitude.bankGradeText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">Runway Alignment</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Aircraft heading vs runway heading</div>
              <div id="landing-centerline" class="text-xl font-semibold tabular" :class="landing.landingCard.attitude.centerlineTone">{{ landing.landingCard.attitude.centerlineText }}</div>
              <div id="landing-centerline-grade" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.attitude.centerlineGradeText }}</div>
            </div>
            <div class="text-center">
              <div class="text-[11px] text-gray-500 mb-0.5">In-Flight Upsets</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Upset / load-limit events</div>
              <div id="landing-upset-count" class="text-xl font-semibold tabular" :class="landing.landingCard.attitude.upsetTone">{{ landing.landingCard.attitude.upsetCountText }}</div>
              <div id="landing-upset-grade" class="text-xs mt-0.5" :class="landing.landingCard.attitude.upsetGradeTone">{{ landing.landingCard.attitude.upsetGradeText }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="landing-inflight-section" class="border-t border-surface-200/30" :class="{ hidden: !landing.landingCard.inflight.visible }">
      <div class="px-6 pt-4 pb-4">
        <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Flight Summary &amp; Events</div>
        <div id="landing-inflight-stats" class="flex flex-wrap gap-x-4 gap-y-1 items-center mb-3">
          <template v-for="(stat, index) in landing.landingCard.inflight.stats" :key="stat.key">
            <span v-if="index > 0" class="text-gray-700 mx-1">&middot;</span>
            <span class="flex items-center gap-1">
              <span class="text-[10px] text-gray-500 uppercase">{{ stat.label }}</span>
              <span class="text-sm font-semibold" :class="stat.toneClass">{{ stat.value }}</span>
            </span>
          </template>
        </div>
        <div id="landing-inflight-violations" class="space-y-1.5">
          <div
            v-for="row in landing.landingCard.inflight.violations"
            :key="row.key"
            class="flex justify-between items-center px-2 py-1 rounded border-l-2"
            :class="row.containerClass"
          >
            <span class="text-xs" :class="row.empty ? 'text-gray-600' : 'text-gray-300'">{{ row.label }}</span>
            <span v-if="row.value" class="text-xs font-medium" :class="row.valueClass">{{ row.value }}</span>
          </div>
        </div>
      </div>
    </div>

  </div>

  <div id="landing-empty" class="landing-mobile-empty sm:hidden" :class="{ hidden: landing.cardVisible || landing.waitingVisible }">
    <div class="landing-mobile-empty-title">No landing data yet</div>
    <div class="landing-mobile-empty-copy">Waiting for touchdown capture.</div>
  </div>
</template>
