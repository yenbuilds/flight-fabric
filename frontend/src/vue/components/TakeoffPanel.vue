<script setup>
import { computed, ref } from 'vue';
import AircraftArtwork from './AircraftArtwork.vue';
import LandingSummaryWatermark from './LandingSummaryWatermark.vue';
import { useTakeoffStore } from '../stores/takeoff.js';
import { useStatusStore } from '../stores/status.js';

const detailedMetricsExpanded = ref(false);
const takeoff = useTakeoffStore();
const status = useStatusStore();

const aircraftName = computed(() => {
  const name = String(status.aircraftProfile.aircraftName || status.aircraftProfile.aircraftTitle || '').trim();
  return name && name !== '--' ? name : 'Aircraft';
});
const aircraftProfileId = computed(() => String(status.aircraftProfile.profileId || '').trim());
const aircraftProfileKey = computed(() => String(status.aircraftProfile.profileKey || '').trim());
const aircraftContext = computed(() => {
  const profileName = String(status.aircraftProfile.profileName || '').trim();
  return profileName && profileName !== aircraftName.value ? profileName : 'Current aircraft';
});

const accordionButtonClass = 'group flex w-full cursor-pointer items-center justify-between gap-3 bg-surface-200/60 px-4 py-3.5 text-sm font-medium text-gray-200 transition-colors hover:bg-surface-300 hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';
const accordionIndicatorClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-surface-300 bg-surface-100 text-gray-300 transition-colors group-hover:border-gray-500 group-hover:text-gray-100';
const detailedMetricClass = 'landing-detail-metric text-center';

function detailedMetricAttentionLevel(...toneClasses) {
  const tones = toneClasses.filter(Boolean).join(' ');
  if (tones.includes('text-red-') || tones.includes('text-danger')) return 'danger';
  if (tones.includes('text-amber-') || tones.includes('text-orange-') || tones.includes('text-warning')) return 'warning';
  return null;
}

function detailedMetricAttentionClass(...toneClasses) {
  const level = detailedMetricAttentionLevel(...toneClasses);
  return level ? `landing-detail-metric--${level}` : '';
}

const detailedAttention = computed(() => {
  const { liftoff, alignment } = takeoff.takeoffCard;
  const levels = [
    detailedMetricAttentionLevel(liftoff.hopTone, liftoff.hopDetailTone),
    detailedMetricAttentionLevel(liftoff.pitchTone),
    detailedMetricAttentionLevel(alignment.lateralTone, alignment.lateralGradeTone),
  ].filter(Boolean);

  return {
    count: levels.length,
    badgeClass: levels.includes('danger')
      ? 'border-red-500/40 bg-red-500/10 text-red-300'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  };
});
</script>

<template>
  <div
    id="takeoff-waiting-state"
    class="landing-waiting-panel"
    :class="{ hidden: !takeoff.waitingVisible }"
    role="status"
    aria-live="polite"
  >
    <div class="landing-waiting-copy">
      <div class="landing-waiting-kicker">Takeoff Capture</div>
      <div class="landing-waiting-title">Ready for the next departure</div>
      <div id="takeoff-waiting-description" class="landing-waiting-description">{{ takeoff.waitingDescription }}</div>
    </div>
    <div class="landing-waiting-status">
      <span class="landing-live-dot"></span>
      <span
        class="landing-waiting-status-text"
        style="font-family:'B612 Mono',monospace;"
      >{{ takeoff.pending ? 'Measuring climb-out' : 'SimConnect monitoring' }}</span>
    </div>
  </div>

  <div
    id="takeoff-card"
    tabindex="-1"
    role="region"
    aria-label="Takeoff report"
    class="landing-gradient border border-surface-200 overflow-hidden"
    :class="{ hidden: !takeoff.cardVisible }"
  >

    <div class="p-4 sm:p-6 pb-4 border-b border-surface-200/30">
      <div class="landing-aircraft-hero mb-3">
        <div class="landing-aircraft-hero__copy">
          <div class="telemetry-label">Takeoff Summary</div>
          <div class="landing-aircraft-hero__name">{{ aircraftName }}</div>
          <div class="landing-aircraft-hero__context">{{ aircraftContext }}</div>
        </div>
        <AircraftArtwork
          class="landing-aircraft-hero__art"
          :profile-id="aircraftProfileId"
          :profile-key="aircraftProfileKey"
          :aircraft-name="aircraftName"
          variant="hero"
          loading="eager"
        />
        <div class="landing-aircraft-hero__airport">
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Airport / Runway</div>
          <div class="flex items-baseline justify-end gap-2 text-sm font-semibold tabular text-gray-200" style="font-family:'B612 Mono', monospace;">
            <span id="takeoff-airport">{{ takeoff.takeoffCard.airportText }}</span>
            <span class="text-gray-700" aria-hidden="true">/</span>
            <span id="takeoff-runway">{{ takeoff.takeoffCard.runwayText }}</span>
          </div>
        </div>
      </div>

      <section id="takeoff-debrief-factors" class="mb-4 rounded-lg border border-surface-200 bg-surface-100/40 p-3 sm:p-4" aria-label="Takeoff findings and data quality">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-muted-fg mb-2">Recorded findings</div>
            <ul v-if="takeoff.takeoffCard.debrief.reasons.length" id="takeoff-debrief-reasons" class="space-y-2">
              <li v-for="reason in takeoff.takeoffCard.debrief.reasons" :key="reason.key"
                class="rounded border px-3 py-2 text-sm leading-relaxed"
                :class="reason.tone === 'danger' ? 'border-danger/40 bg-danger/10 text-danger' : reason.tone === 'warning' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-surface-200 text-muted-fg'"
              >{{ reason.text }}</li>
            </ul>
            <p v-else class="text-sm text-muted-fg">No additional findings were recorded.</p>
          </div>
          <div class="min-w-0 lg:w-64 lg:shrink-0">
            <div class="text-xs font-semibold text-muted-fg">Telemetry confidence</div>
            <div id="takeoff-data-confidence" class="mt-1 text-sm font-semibold" :class="takeoff.takeoffCard.debrief.confidenceToneClass">{{ takeoff.takeoffCard.debrief.confidenceText }}</div>
            <p v-if="takeoff.takeoffCard.debrief.confidenceReason" id="takeoff-data-confidence-reason" class="mt-1 text-xs leading-relaxed text-muted-fg">{{ takeoff.takeoffCard.debrief.confidenceReason }}</p>
          </div>
        </div>
      </section>

      <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-fg">
        <span>{{ takeoff.takeoffCard.gradeLabel }}</span>
        <span id="takeoff-grade" :style="takeoff.takeoffGradeStyle" class="font-semibold">{{ takeoff.takeoffCard.gradeText }}</span>
        <span v-if="takeoff.takeoffCard.scoreText" id="takeoff-grade-detail">{{ takeoff.takeoffCard.scoreText }}</span>
      </div>

      <p class="text-xs text-muted-fg mb-4">Covers the takeoff roll and liftoff; capture normally finishes around 50 ft. Runway use and rotation are measured observations. More runway remaining does not mean a better takeoff.</p>

      <section
        v-if="takeoff.takeoffCard.wind.available"
        id="takeoff-wind-context"
        class="mb-3 flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        role="group"
        :aria-label="takeoff.takeoffCard.wind.ariaLabel"
      >
        <div class="min-w-0">
          <div class="mb-1 text-[10px] font-semibold uppercase tracking-widest text-accent">Wind at liftoff</div>
          <div id="takeoff-wind-total" class="text-sm font-semibold tabular text-gray-100" style="font-family:'B612 Mono', monospace;">
            {{ takeoff.takeoffCard.wind.totalText }}
          </div>
        </div>
        <div class="shrink-0 border-t border-surface-300/70 pt-2 sm:min-w-[11rem] sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0 sm:text-right">
          <div class="text-[9px] uppercase tracking-widest text-gray-600">Runway component</div>
          <div id="takeoff-wind-crosswind" class="mt-0.5 text-sm font-semibold text-gray-300" style="font-family:'B612 Mono', monospace;">
            {{ takeoff.takeoffCard.wind.crosswindDetailText }}
          </div>
        </div>
      </section>

      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-px overflow-hidden rounded-lg border border-surface-200/50 bg-surface-200/50">

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="liftoff" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Runway remaining</div>
            <div
              id="takeoff-summary-remaining"
              class="text-2xl font-semibold tabular"
              :class="takeoff.takeoffCard.runwayUse.remainingTone"
              style="font-family:'B612 Mono', monospace;"
            >{{ takeoff.takeoffCard.runwayUse.remainingText }}</div>
            <div
              id="takeoff-summary-remaining-detail"
              class="mt-1 text-xs"
              :class="takeoff.takeoffCard.runwayUse.remainingDetailTone"
            >{{ takeoff.takeoffCard.runwayUse.remainingDetailText }}</div>
          </div>
        </div>

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="roll" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">{{ takeoff.takeoffCard.roll.label }}</div>
            <div
              id="takeoff-summary-roll"
              class="text-2xl font-semibold tabular text-gray-200"
              style="font-family:'B612 Mono', monospace;"
            >{{ takeoff.takeoffCard.roll.distanceText }}</div>
            <div id="takeoff-summary-roll-detail" class="mt-1 text-xs text-gray-500">
              {{ takeoff.takeoffCard.roll.durationText }} · liftoff {{ takeoff.takeoffCard.liftoff.iasText }}
            </div>
            <div v-if="takeoff.takeoffCard.roll.startNoteText" class="mt-1 text-xs text-muted-fg">{{ takeoff.takeoffCard.roll.startNoteText }}</div>
          </div>
        </div>

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="climb" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">{{ takeoff.takeoffCard.climb.screenLabel }}</div>
            <div
              id="takeoff-summary-screen"
              class="text-2xl font-semibold tabular"
              :class="takeoff.takeoffCard.climb.screenTone"
              style="font-family:'B612 Mono', monospace;"
            >{{ takeoff.takeoffCard.climb.screenText }}</div>
            <div
              id="takeoff-summary-screen-detail"
              class="mt-1 text-xs"
              :class="takeoff.takeoffCard.climb.screenDetailTone"
            >{{ takeoff.takeoffCard.climb.screenDetailText }}</div>
          </div>
        </div>

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="rotation" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Rotation</div>
            <div
              id="takeoff-summary-rotation"
              class="text-2xl font-semibold tabular"
              :class="takeoff.takeoffCard.climb.rotationTone"
              style="font-family:'B612 Mono', monospace;"
            >{{ takeoff.takeoffCard.climb.rotationText }}</div>
            <div id="takeoff-summary-rotation-detail" class="mt-1 text-xs text-gray-500">
              {{ takeoff.takeoffCard.climb.rotationDetailText }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="takeoff-detailed-metrics-section" class="border-t border-surface-200/30">
      <button
        id="takeoff-detailed-metrics-toggle-btn"
        type="button"
        :class="accordionButtonClass"
        :aria-expanded="detailedMetricsExpanded"
        aria-controls="takeoff-detailed-metrics-content"
        @click="detailedMetricsExpanded = !detailedMetricsExpanded"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span>Detailed Metrics</span>
          <span
            v-if="detailedAttention.count > 0"
            id="takeoff-detailed-metrics-attention-count"
            class="rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
            :class="detailedAttention.badgeClass"
          >{{ detailedAttention.count }} {{ detailedAttention.count === 1 ? 'item needs' : 'items need' }} attention</span>
        </span>
        <span :class="accordionIndicatorClass">
          <svg
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-180': detailedMetricsExpanded }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>
      <div
        id="takeoff-detailed-metrics-content"
        :class="{ hidden: !detailedMetricsExpanded }"
        role="region"
        aria-labelledby="takeoff-detailed-metrics-toggle-btn"
      >
        <div class="px-6 pt-4 pb-2">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Runway</div>
          <div class="grid grid-cols-2 gap-3">

            <div :class="detailedMetricClass" data-detail-metric="runway-liftoff-point">
              <div class="text-[11px] text-gray-500 mb-0.5">Liftoff point</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">From runway start</div>
              <div id="takeoff-liftoff-distance" class="text-xl font-semibold tabular text-gray-100">{{ takeoff.takeoffCard.runwayUse.liftoffDistanceText }}</div>
              <div id="takeoff-runway-used" class="text-xs text-gray-500 mt-0.5">{{ takeoff.takeoffCard.runwayUse.usedText }}</div>
            </div>
            <div :class="detailedMetricClass" data-detail-metric="runway-length">
              <div class="text-[11px] text-gray-500 mb-0.5">Runway length</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Physical runway length</div>
              <div id="takeoff-runway-length" class="text-xl font-semibold tabular text-gray-100">{{ takeoff.takeoffCard.runwayUse.runwayLengthText }}</div>
            </div>

          </div>
        </div>

        <div class="px-6 pt-4 pb-2">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Liftoff observations</div>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-3">

            <div :class="detailedMetricClass" data-detail-metric="liftoff-speed">
              <div class="text-[11px] text-gray-500 mb-0.5">Ground speed</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">At liftoff (kt)</div>
              <div id="takeoff-gs" class="text-xl font-semibold tabular text-gray-100">{{ takeoff.takeoffCard.liftoff.gsText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(takeoff.takeoffCard.liftoff.pitchTone)]"
              data-detail-metric="liftoff-pitch"
              :data-attention="detailedMetricAttentionLevel(takeoff.takeoffCard.liftoff.pitchTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Pitch</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">At liftoff - + = nose up</div>
              <div id="takeoff-pitch" class="text-xl font-semibold tabular" :class="takeoff.takeoffCard.liftoff.pitchTone">{{ takeoff.takeoffCard.liftoff.pitchText }}</div>
              <div id="takeoff-max-pitch" class="text-xs text-gray-500 mt-0.5">Peak {{ takeoff.takeoffCard.climb.maxPitchText }} during capture</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(takeoff.takeoffCard.liftoff.hopTone, takeoff.takeoffCard.liftoff.hopDetailTone)]"
              data-detail-metric="liftoff-settle"
              :data-attention="detailedMetricAttentionLevel(takeoff.takeoffCard.liftoff.hopTone, takeoff.takeoffCard.liftoff.hopDetailTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Settle-backs</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Ground contacts after liftoff</div>
              <div id="takeoff-hops" class="text-xl font-semibold tabular" :class="takeoff.takeoffCard.liftoff.hopTone">{{ takeoff.takeoffCard.liftoff.hopText }}</div>
              <div id="takeoff-hops-grade" class="text-xs mt-0.5" :class="takeoff.takeoffCard.liftoff.hopDetailTone">{{ takeoff.takeoffCard.liftoff.hopDetailText }}</div>
            </div>
          </div>
        </div>

        <div class="px-6 pt-4 pb-4">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Control</div>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-3">

            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(takeoff.takeoffCard.alignment.lateralTone, takeoff.takeoffCard.alignment.lateralGradeTone)]"
              data-detail-metric="control-lateral"
              :data-attention="detailedMetricAttentionLevel(takeoff.takeoffCard.alignment.lateralTone, takeoff.takeoffCard.alignment.lateralGradeTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Lateral</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Offset from centerline at liftoff - L/R</div>
              <div id="takeoff-lateral-value" class="text-xl font-semibold tabular" :class="takeoff.takeoffCard.alignment.lateralTone">{{ takeoff.takeoffCard.alignment.lateralText }}</div>
              <div id="takeoff-lateral-grade" class="text-xs mt-0.5" :class="takeoff.takeoffCard.alignment.lateralGradeTone">{{ takeoff.takeoffCard.alignment.lateralGradeText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(takeoff.takeoffCard.alignment.headingTone)]"
              data-detail-metric="control-alignment"
              :data-attention="detailedMetricAttentionLevel(takeoff.takeoffCard.alignment.headingTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Heading at liftoff</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Difference from runway heading; not ground track</div>
              <div id="takeoff-heading" class="text-xl font-semibold tabular" :class="takeoff.takeoffCard.alignment.headingTone">{{ takeoff.takeoffCard.alignment.headingText }}</div>
              <div id="takeoff-heading-grade" class="text-xs text-gray-500 mt-0.5">{{ takeoff.takeoffCard.alignment.headingGradeText }}</div>
            </div>

            <div :class="detailedMetricClass" data-detail-metric="liftoff-flaps">
              <div class="text-[11px] text-muted-fg mb-0.5">Flaps at liftoff</div>
              <div id="takeoff-flaps" class="text-xl font-semibold tabular text-fg">{{ takeoff.takeoffCard.liftoff.flapsText }}</div>
              <div class="text-xs text-muted-fg mt-0.5">Recorded position</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="takeoff-empty" class="landing-mobile-empty sm:hidden" :class="{ hidden: takeoff.cardVisible || takeoff.waitingVisible }">
    <div class="landing-mobile-empty-title">No takeoff data yet</div>
    <div class="landing-mobile-empty-copy">Waiting for liftoff capture.</div>
  </div>
</template>

<style scoped>
@media (max-width: 640px) {
  .landing-aircraft-hero {
    grid-template-columns: minmax(0, 1fr);
  }

  .landing-aircraft-hero__copy {
    max-width: 100%;
  }
}
.landing-detail-metric {
  position: relative;
  min-width: 0;
  min-height: 5.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
}

.landing-detail-metric--warning {
  border-color: rgb(245 158 11 / 0.4);
  background: linear-gradient(135deg, rgb(245 158 11 / 0.1), rgb(245 158 11 / 0.025));
  box-shadow: inset 3px 0 0 rgb(245 158 11 / 0.75);
}

.landing-detail-metric--danger {
  border-color: rgb(239 68 68 / 0.48);
  background: linear-gradient(135deg, rgb(239 68 68 / 0.12), rgb(239 68 68 / 0.025));
  box-shadow: inset 3px 0 0 rgb(239 68 68 / 0.85);
}

.landing-detail-metric--warning::after,
.landing-detail-metric--danger::after {
  position: absolute;
  top: 0.55rem;
  right: 0.55rem;
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 9999px;
  content: '';
}

.landing-detail-metric--warning::after {
  background: rgb(251 191 36);
  box-shadow: 0 0 0.55rem rgb(245 158 11 / 0.5);
}

.landing-detail-metric--danger::after {
  background: rgb(248 113 113);
  box-shadow: 0 0 0.65rem rgb(239 68 68 / 0.58);
}
</style>
