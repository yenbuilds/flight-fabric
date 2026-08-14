<script setup>
import { computed, ref } from 'vue';
import AppTooltip from './AppTooltip.vue';
import AircraftArtwork from './AircraftArtwork.vue';
import LandingSummaryWatermark from './LandingSummaryWatermark.vue';
import { useLandingStore } from '../stores/landing.js';
import { useStatusStore } from '../stores/status.js';
import { useTimelineStore } from '../stores/timeline.js';

const props = defineProps({
  debriefMode: {
    type: Boolean,
    default: false,
  },
});

const stabilityExpanded = ref(true);
const approachProfileExpanded = ref(true);
const topdownProfileExpanded = ref(true);
const detailedMetricsExpanded = ref(true);
const landing = useLandingStore();
const status = useStatusStore();
const timeline = useTimelineStore();

const landingAircraftEvent = computed(() => (
  props.debriefMode && timeline.selectedLandingEvent
    ? timeline.selectedLandingEvent
    : null
));
const landingAircraftFlight = computed(() => {
  if (!props.debriefMode) return null;
  const flights = Array.isArray(timeline.flights) ? timeline.flights : [];
  const loadedFlightId = String(timeline.loadedTimelineFlightId || '').trim();
  const loadedFilePath = String(timeline.loadedTimelineFilePath || '')
    .trim()
    .replaceAll('\\', '/')
    .toLowerCase();

  if (loadedFilePath) {
    const pathMatch = flights.find((flight) => String(flight?.filePath || flight?.file_path || '')
      .trim()
      .replaceAll('\\', '/')
      .toLowerCase() === loadedFilePath);
    if (pathMatch) return pathMatch;
  }

  if (!loadedFlightId) return null;
  const idMatches = flights.filter((flight) => (
    String(flight?.flightId || flight?.flight_id || '').trim() === loadedFlightId
  ));
  return idMatches.length === 1 ? idMatches[0] : null;
});
const landingAircraftName = computed(() => {
  const event = landingAircraftEvent.value;
  const flight = landingAircraftFlight.value;
  const historicalName = props.debriefMode
    ? event?.aircraft
      || event?.aircraftName
      || timeline.loadedTimelineAircraftLabel
      || flight?.aircraft
      || flight?.aircraftName
    : '';
  const liveName = props.debriefMode
    ? ''
    : status.aircraftProfile.aircraftName || status.aircraftProfile.aircraftTitle;
  const name = String(historicalName || liveName || '').trim();
  if (name && name !== '--') return name;
  return props.debriefMode ? 'Recorded aircraft' : 'Aircraft';
});
const landingAircraftProfileId = computed(() => {
  const event = landingAircraftEvent.value;
  const flight = landingAircraftFlight.value;
  const profileId = props.debriefMode
    ? event?.aircraftProfileId
      || event?.aircraft_profile_id
      || flight?.aircraftProfileId
      || flight?.aircraft_profile_id
    : status.aircraftProfile.profileId;
  return String(profileId || '').trim();
});
const landingAircraftProfileKey = computed(() => (
  props.debriefMode ? '' : String(status.aircraftProfile.profileKey || '').trim()
));
const landingAircraftContext = computed(() => {
  if (props.debriefMode) {
    return landingAircraftName.value === 'Recorded aircraft'
      ? 'Aircraft identity unavailable in this record'
      : 'Recorded aircraft';
  }
  const profileName = String(status.aircraftProfile.profileName || '').trim();
  return profileName && profileName !== landingAircraftName.value ? profileName : 'Current aircraft';
});

const accordionButtonClass = 'group flex w-full cursor-pointer items-center justify-between gap-3 bg-surface-200/60 px-4 py-3.5 text-sm font-medium text-gray-200 transition-colors hover:bg-surface-300 hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';
const accordionIndicatorClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-surface-300 bg-surface-100 text-gray-300 transition-colors group-hover:border-gray-500 group-hover:text-gray-100';
const detailedMetricClass = 'landing-detail-metric text-center';

function detailedMetricAttentionLevel(...toneClasses) {
  const tones = toneClasses.filter(Boolean).join(' ');
  if (tones.includes('text-red-') || tones.includes('text-danger')) return 'danger';
  if (tones.includes('text-amber-') || tones.includes('text-warning')) return 'warning';
  return null;
}

function detailedMetricAttentionClass(...toneClasses) {
  const level = detailedMetricAttentionLevel(...toneClasses);
  return level ? `landing-detail-metric--${level}` : '';
}

const detailedAttention = computed(() => {
  const { touchdown, approach, attitude } = landing.landingCard;
  const levels = [
    detailedMetricAttentionLevel(touchdown.distanceGradeTone),
    detailedMetricAttentionLevel(touchdown.achievedTone),
    detailedMetricAttentionLevel(touchdown.lateralTone, touchdown.lateralGradeTone),
    detailedMetricAttentionLevel(touchdown.bounceTone, touchdown.bounceGradeTone),
    detailedMetricAttentionLevel(approach.stabilityTone),
    detailedMetricAttentionLevel(attitude.pitchTone),
    detailedMetricAttentionLevel(attitude.bankTone),
    detailedMetricAttentionLevel(attitude.centerlineTone),
    detailedMetricAttentionLevel(attitude.upsetTone, attitude.upsetGradeTone),
  ].filter(Boolean);

  return {
    count: levels.length,
    badgeClass: levels.includes('danger')
      ? 'border-red-500/40 bg-red-500/10 text-red-300'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  };
});

const bounceDetailVisible = computed(() => {
  const bounceValue = String(landing.landingCard.touchdown.bounceText || '').trim().toLowerCase();
  const bounceDetail = String(landing.landingCard.touchdown.bounceGradeText || '').trim().toLowerCase();
  return bounceDetail !== '' && bounceDetail !== '--' && bounceDetail !== bounceValue;
});
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

    <div class="p-4 sm:p-6 pb-4 border-b border-surface-200/30">
      <div
        class="landing-aircraft-hero mb-3"
        :class="{ 'landing-aircraft-hero--debrief': props.debriefMode }"
      >
        <div class="landing-aircraft-hero__copy">
          <div class="telemetry-label">Landing Summary</div>
          <div class="landing-aircraft-hero__name">{{ landingAircraftName }}</div>
          <div class="landing-aircraft-hero__context">{{ landingAircraftContext }}</div>
        </div>
        <AircraftArtwork
          class="landing-aircraft-hero__art"
          :profile-id="landingAircraftProfileId"
          :profile-key="landingAircraftProfileKey"
          :aircraft-name="landingAircraftName"
          variant="hero"
          loading="eager"
        />
        <div class="landing-aircraft-hero__airport">
          <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Airport / Runway</div>
          <div class="flex items-baseline justify-end gap-2 text-sm font-semibold tabular text-gray-200" style="font-family:'B612 Mono', monospace;">
            <span id="landing-airport">{{ landing.landingCard.airportText }}</span>
            <span class="text-gray-700" aria-hidden="true">/</span>
            <span id="landing-runway">{{ landing.landingCard.runwayText }}</span>
          </div>
        </div>
      </div>
      <section
        v-if="landing.landingCard.wind.available"
        id="landing-wind-context"
        class="mb-3 flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        role="group"
        :aria-label="landing.landingCard.wind.ariaLabel"
      >
        <div class="flex min-w-0 items-center gap-3">
          <div
            id="landing-wind-compass"
            class="relative h-16 w-16 shrink-0 rounded-full border border-surface-300 bg-surface-100/80 text-[8px] font-semibold text-gray-500"
            aria-hidden="true"
          >
            <span class="absolute left-1/2 top-0.5 -translate-x-1/2">N</span>
            <span class="absolute right-1 top-1/2 -translate-y-1/2">E</span>
            <span class="absolute bottom-0.5 left-1/2 -translate-x-1/2">S</span>
            <span class="absolute left-1 top-1/2 -translate-y-1/2">W</span>
            <svg class="absolute inset-0 h-full w-full" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-width="1" class="text-surface-300" />
              <g
                v-if="landing.landingCard.wind.arrowVisible"
                class="text-accent"
                :style="{
                  transform: `rotate(${landing.landingCard.wind.arrowRotationDeg}deg)`,
                  transformOrigin: '32px 32px',
                }"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.5"
              >
                <path d="M32 55V19" />
                <path d="m25 27 7-8 7 8" />
              </g>
              <circle v-if="landing.landingCard.wind.arrowVisible" cx="32" cy="32" r="2" class="fill-accent" />
            </svg>
            <span
              v-if="!landing.landingCard.wind.arrowVisible"
              class="absolute inset-0 flex items-center justify-center text-[9px] tracking-wider text-gray-400"
            >{{ landing.landingCard.wind.calm ? 'CALM' : '--' }}</span>
          </div>

          <div class="min-w-0">
            <div class="mb-1 text-[10px] font-semibold uppercase tracking-widest text-accent">Wind at touchdown</div>
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" style="font-family:'B612 Mono', monospace;">
              <span
                v-if="landing.landingCard.wind.directionPrefixText"
                id="landing-wind-direction-prefix"
                class="text-xs font-semibold tracking-wider text-gray-400"
              >{{ landing.landingCard.wind.directionPrefixText }}</span>
              <span id="landing-wind-direction" class="text-2xl font-semibold tabular text-gray-100">
                {{ landing.landingCard.wind.directionText }}
              </span>
              <span class="text-gray-600" aria-hidden="true">·</span>
              <span id="landing-wind-speed" class="text-2xl font-semibold tabular text-gray-100">
                {{ landing.landingCard.wind.speedText }}
              </span>
            </div>
            <div v-if="landing.landingCard.wind.cardinalText" id="landing-wind-reference" class="mt-0.5 text-[11px] text-gray-500">
              True north · wind source {{ landing.landingCard.wind.cardinalText }}
            </div>
            <div v-else-if="!landing.landingCard.wind.calm" id="landing-wind-reference" class="mt-0.5 text-[11px] text-gray-500">
              Direction unavailable
            </div>
          </div>
        </div>

        <div class="shrink-0 border-t border-surface-300/70 pt-2 sm:min-w-[11rem] sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0 sm:text-right">
          <div class="text-[9px] uppercase tracking-widest text-gray-600">Runway component</div>
          <div id="landing-wind-crosswind" class="mt-0.5 text-sm font-semibold text-gray-300" style="font-family:'B612 Mono', monospace;">
            {{ landing.landingCard.wind.crosswindDetailText }}
          </div>
        </div>
      </section>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-px overflow-hidden rounded-lg border border-surface-200/50 bg-surface-200/50">
        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="grade" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Touchdown rate grade</div>
            <div
              id="landing-grade"
              :key="landing.landingCard.gradeAnimationNonce"
              class="grade-pop text-2xl font-semibold"
              :style="[landing.landingGradeStyle, { fontFamily: '\'B612 Mono\', monospace', letterSpacing: '0.08em' }]"
            >{{ landing.landingCard.gradeText }}</div>
          </div>
        </div>

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="rate" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Touchdown rate</div>
            <div class="flex items-baseline gap-2">
              <span id="landing-vs" class="text-2xl font-semibold tabular telemetry-value" :style="landing.landingVsStyle">{{ landing.landingCard.vsText }}</span>
              <span class="telemetry-unit text-xs">fpm</span>
            </div>
            <div id="landing-gforce" class="text-xs text-gray-500 mt-1">{{ landing.landingCard.gforceText }}</div>
          </div>
        </div>

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="zone" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Touchdown zone</div>
            <div
              id="landing-summary-tdz"
              class="text-2xl font-semibold tabular text-gray-200"
              style="font-family:'B612 Mono', monospace;"
            >{{ landing.landingCard.touchdown.distanceText }}</div>
            <div
              id="landing-summary-tdz-detail"
              class="mt-1 text-xs"
              :class="landing.landingCard.touchdown.distanceGradeTone"
            >{{ landing.landingCard.touchdown.distanceGradeText }}</div>
          </div>
        </div>

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="approach" />
          <div class="relative z-10">
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
        </div>

        <div class="relative isolate min-h-[7.5rem] min-w-0 overflow-hidden bg-surface-100/80 px-4 py-3">
          <LandingSummaryWatermark kind="bounce" />
          <div class="relative z-10">
            <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Bounce</div>
            <div
              id="landing-summary-bounce"
              class="text-2xl font-semibold tabular"
              :class="landing.landingCard.touchdown.bounceTone"
              style="font-family:'B612 Mono', monospace;"
            >{{ landing.landingCard.touchdown.bounceText }}</div>
            <div
              v-if="bounceDetailVisible"
              id="landing-summary-bounce-detail"
              class="mt-1 text-xs"
              :class="landing.landingCard.touchdown.bounceGradeTone"
            >
              {{ landing.landingCard.touchdown.bounceGradeText }}
            </div>
          </div>
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
        :class="accordionButtonClass"
        :aria-expanded="stabilityExpanded"
        aria-controls="stability-breakdown-content"
        @click="stabilityExpanded = !stabilityExpanded"
      >
        <span>Stability Breakdown</span>
        <span :class="accordionIndicatorClass">
          <svg
            id="stability-chevron"
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-180': stabilityExpanded }"
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
        id="stability-breakdown-content"
        class="px-6 pb-4 pt-4"
        :class="{ hidden: !stabilityExpanded }"
        role="region"
        aria-labelledby="stability-toggle-btn"
      >
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
        :class="accordionButtonClass"
        :aria-expanded="approachProfileExpanded"
        aria-controls="approach-profile-content"
        @click="approachProfileExpanded = !approachProfileExpanded"
      >
        <span>Approach Profile</span>
        <span :class="accordionIndicatorClass">
          <svg
            id="approach-profile-chevron"
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-180': approachProfileExpanded }"
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
        id="approach-profile-content"
        class="px-4 pb-4 pt-4"
        :class="{ hidden: !approachProfileExpanded }"
        role="region"
        aria-labelledby="approach-profile-toggle-btn"
      >
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
        :class="accordionButtonClass"
        :aria-expanded="topdownProfileExpanded"
        aria-controls="topdown-profile-content"
        @click="topdownProfileExpanded = !topdownProfileExpanded"
      >
        <span>Ground Track</span>
        <span :class="accordionIndicatorClass">
          <svg
            id="topdown-profile-chevron"
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-180': topdownProfileExpanded }"
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
        id="topdown-profile-content"
        class="px-4 pb-4 pt-4"
        :class="{ hidden: !topdownProfileExpanded }"
        role="region"
        aria-labelledby="topdown-profile-toggle-btn"
      >
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
        :class="accordionButtonClass"
        :aria-expanded="detailedMetricsExpanded"
        aria-controls="detailed-metrics-content"
        @click="detailedMetricsExpanded = !detailedMetricsExpanded"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span>Detailed Metrics</span>
          <span
            v-if="detailedAttention.count > 0"
            id="detailed-metrics-attention-count"
            class="rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
            :class="detailedAttention.badgeClass"
          >{{ detailedAttention.count }} {{ detailedAttention.count === 1 ? 'item needs' : 'items need' }} attention</span>
        </span>
        <span :class="accordionIndicatorClass">
          <svg
            id="detailed-metrics-chevron"
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
        id="detailed-metrics-content"
        :class="{ hidden: !detailedMetricsExpanded }"
        role="region"
        aria-labelledby="detailed-metrics-toggle-btn"
      >
        <div class="px-6 pt-4 pb-2">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Touchdown</div>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.touchdown.distanceGradeTone)]"
              data-detail-metric="touchdown-distance"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.touchdown.distanceGradeTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Distance</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">From threshold</div>
              <div id="landing-tdz-value" class="text-xl font-semibold tabular text-gray-100">{{ landing.landingCard.touchdown.distanceText }}</div>
              <div id="landing-tdz-grade" class="text-xs mt-0.5" :class="landing.landingCard.touchdown.distanceGradeTone">{{ landing.landingCard.touchdown.distanceGradeText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.touchdown.achievedTone)]"
              data-detail-metric="touchdown-target"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.touchdown.achievedTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">1,000 ft target</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">From landing threshold</div>
              <div
                id="landing-tdz-achieved"
                class="text-xl font-semibold"
                :class="landing.landingCard.touchdown.achievedTone"
                style="font-family:'B612 Mono', monospace;"
              >{{ landing.landingCard.touchdown.achievedText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.touchdown.lateralTone, landing.landingCard.touchdown.lateralGradeTone)]"
              data-detail-metric="touchdown-lateral"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.touchdown.lateralTone, landing.landingCard.touchdown.lateralGradeTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Lateral</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Offset from centerline - L/R</div>
              <div id="landing-lateral-value" class="text-xl font-semibold tabular" :class="landing.landingCard.touchdown.lateralTone">{{ landing.landingCard.touchdown.lateralText }}</div>
              <div id="landing-lateral-grade" class="text-xs mt-0.5" :class="landing.landingCard.touchdown.lateralGradeTone">{{ landing.landingCard.touchdown.lateralGradeText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.touchdown.bounceTone, landing.landingCard.touchdown.bounceGradeTone)]"
              data-detail-metric="touchdown-bounce"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.touchdown.bounceTone, landing.landingCard.touchdown.bounceGradeTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Bounce</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Post-touchdown bounces</div>
              <div id="landing-bounce-value" class="text-xl font-semibold tabular" :class="landing.landingCard.touchdown.bounceTone">{{ landing.landingCard.touchdown.bounceText }}</div>
              <div id="landing-bounce-grade" class="text-xs mt-0.5" :class="landing.landingCard.touchdown.bounceGradeTone">{{ landing.landingCard.touchdown.bounceGradeText }}</div>
            </div>
          </div>
        </div>

        <div class="px-6 pt-4 pb-2">
          <div class="text-[10px] text-gray-700 uppercase tracking-widest mb-2">Approach</div>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.approach.stabilityTone)]"
              data-detail-metric="approach-verdict"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.approach.stabilityTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Approach verdict</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">{{ landing.landingCard.approach.stabilityNoteText }}</div>
              <div
                id="landing-stability-score"
                class="text-xl font-semibold tabular"
                :class="landing.landingCard.approach.stabilityTone"
              >{{ landing.landingCard.approach.stabilityText }}</div>
            </div>
            <div :class="detailedMetricClass" data-detail-metric="approach-speed">
              <div class="text-[11px] text-gray-500 mb-0.5">Speed</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">IAS at touchdown</div>
              <div id="landing-ias" class="text-xl font-semibold tabular text-gray-100">{{ landing.landingCard.approach.speedText }}</div>
              <div id="landing-gs" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.approach.gsText }}</div>
            </div>
            <div :class="detailedMetricClass" data-detail-metric="approach-crosswind">
              <div class="text-[11px] text-gray-500 mb-0.5">Crosswind</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Wind across runway - L/R = from</div>
              <div id="landing-crosswind" class="text-xl font-semibold tabular" :class="landing.landingCard.approach.crosswindTone">{{ landing.landingCard.approach.crosswindText }}</div>
              <div id="landing-wind-total" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.approach.windTotalText }}</div>
            </div>
            <div :class="detailedMetricClass" data-detail-metric="approach-type">
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
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.attitude.pitchTone)]"
              data-detail-metric="attitude-pitch"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.attitude.pitchTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Pitch</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Nose angle - + = nose up</div>
              <div id="landing-pitch" class="text-xl font-semibold tabular" :class="landing.landingCard.attitude.pitchTone">{{ landing.landingCard.attitude.pitchText }}</div>
              <div id="landing-pitch-grade" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.attitude.pitchGradeText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.attitude.bankTone)]"
              data-detail-metric="attitude-bank"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.attitude.bankTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Bank</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Wing tilt - L/R = wing down</div>
              <div id="landing-bank" class="text-xl font-semibold tabular" :class="landing.landingCard.attitude.bankTone">{{ landing.landingCard.attitude.bankText }}</div>
              <div id="landing-bank-grade" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.attitude.bankGradeText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.attitude.centerlineTone)]"
              data-detail-metric="attitude-alignment"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.attitude.centerlineTone)"
            >
              <div class="text-[11px] text-gray-500 mb-0.5">Runway Alignment</div>
              <div class="text-[9px] text-gray-600 -mt-0.5 mb-0.5">Aircraft heading vs runway heading</div>
              <div id="landing-centerline" class="text-xl font-semibold tabular" :class="landing.landingCard.attitude.centerlineTone">{{ landing.landingCard.attitude.centerlineText }}</div>
              <div id="landing-centerline-grade" class="text-xs text-gray-500 mt-0.5">{{ landing.landingCard.attitude.centerlineGradeText }}</div>
            </div>
            <div
              :class="[detailedMetricClass, detailedMetricAttentionClass(landing.landingCard.attitude.upsetTone, landing.landingCard.attitude.upsetGradeTone)]"
              data-detail-metric="attitude-upsets"
              :data-attention="detailedMetricAttentionLevel(landing.landingCard.attitude.upsetTone, landing.landingCard.attitude.upsetGradeTone)"
            >
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
      <div class="px-4 py-5 sm:px-6">
        <div class="mb-3 text-[10px] uppercase tracking-widest text-gray-500">Flight Summary</div>
        <div id="landing-inflight-stats" class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <div
            v-for="stat in landing.landingCard.inflight.stats"
            :id="`landing-inflight-stat-${stat.key}`"
            :key="stat.key"
            class="min-w-0 rounded-lg border border-surface-200 bg-surface-100/60 px-3.5 py-3"
          >
            <div class="text-[10px] uppercase tracking-widest text-gray-500">{{ stat.label }}</div>
            <div class="mt-1 text-sm font-semibold leading-5" :class="stat.toneClass">{{ stat.value }}</div>
          </div>
        </div>

        <div class="mt-5 border-t border-surface-200/50 pt-4">
          <div class="mb-2 text-[10px] uppercase tracking-widest text-gray-500">Events</div>
          <div id="landing-inflight-violations" class="grid grid-cols-1 gap-2 lg:grid-cols-2">
            <div
              v-for="row in landing.landingCard.inflight.violations"
              :key="row.key"
              class="flex items-start justify-between gap-3 rounded-lg border border-l-2 px-3 py-2.5"
              :class="[row.containerClass, { 'lg:col-span-2': row.empty }]"
            >
              <span class="text-xs leading-5" :class="row.empty ? 'text-gray-500' : 'text-gray-300'">{{ row.label }}</span>
              <span v-if="row.value" class="shrink-0 text-xs font-medium leading-5" :class="row.valueClass">{{ row.value }}</span>
            </div>
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

<style scoped>
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
