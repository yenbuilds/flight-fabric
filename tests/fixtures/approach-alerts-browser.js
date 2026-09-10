import { createApp, h, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import TimelineInspectorShell from '../../frontend/src/vue/components/TimelineInspectorShell.vue';
import TimelineSummaryBar from '../../frontend/src/vue/components/TimelineSummaryBar.vue';
import AircraftArtwork from '../../frontend/src/vue/components/AircraftArtwork.vue';
import { useTimelineStore } from '../../frontend/src/vue/stores/timeline.js';
import { buildTimelineEventRows } from '../../frontend/src/timeline/events.js';
import { buildTimelineSummaryState } from '../../frontend/src/timeline/model.js';
import '../../frontend/index.css';

const pinia = createPinia(); setActivePinia(pinia);
const timeline = useTimelineStore();
const context = { assessment_version: 4, start_height_ft: 998, end_height_ft: 680,
  altitude_source: 'plane', duration_ms: 3000, threshold_exceedance_duration_ms: 3000,
  peak_sink_rate_fpm: -1171, reasons: ['high_sink_rate', 'steep_path_rate'], end_reason: 'recovered' };
const events = [
  { type: 'configuration_event', timestampMs: 0, eventType: 'flaps_changed', label: 'Flaps extended to 30' },
  { type: 'violation_start', timestampMs: 1000, ruleId: 'approach_vertical_profile', severity: 'caution', context },
  { type: 'violation_end', timestampMs: 4000, ruleId: 'approach_vertical_profile', severity: 'caution', context },
  { type: 'violation_start', timestampMs: 6000, ruleId: 'approach_airspeed', severity: 'caution', context: { ...context, reasons: ['airspeed_deviation'], start_height_ft: 380, peak_value: 155 } },
  { type: 'violation_end', timestampMs: 9000, ruleId: 'approach_airspeed', severity: 'caution', context },
  { type: 'violation_start', timestampMs: 14000, ruleId: 'approach_bank', severity: 'warning', context: { ...context, reasons: ['excessive_bank'], start_height_ft: 250, peak_value: 40 } },
  { type: 'violation_end', timestampMs: 17000, ruleId: 'approach_bank', severity: 'warning', context },
  { type: 'automation_event', timestampMs: 18000, label: 'Autopilot disengaged' },
  { type: 'flight_guidance_event', timestampMs: 19000, label: 'Selected altitude changed' },
];
timeline.inspectorFlightIdText = 'Approach assessment preview';
timeline.inspectorRouteText = 'YMML → YBSU'; timeline.inspectorRouteVisible = true;
timeline.setInspectorState({ flightIdText: timeline.inspectorFlightIdText, routeText: timeline.inspectorRouteText, routeVisible: true,
  rows: buildTimelineEventRows(events, { startMs: 0, rowOptions: { formatTimeOffset: ms => `${Math.round(ms / 1000)}s` } }), emptyVisible: false });
timeline.setSummary(buildTimelineSummaryState({ events, distanceNm: 874, durationMs: 7956000 }, events));
const knownProfile = ref('pmdg-737');
const thumbnailClicks = ref(0);
const artwork = (id, label, props) => h('section', { 'data-artwork-case': id, style: 'flex:1;min-width:0;padding:12px' }, [
  h('div', { style: 'font-size:11px;text-align:center' }, label),
  h(AircraftArtwork, { ...props, variant: 'hero', loading: 'eager', style: 'width:100%;height:100px' }),
]);
createApp({ render: () => h('main', { style: 'max-width:680px;margin:auto' }, [
  h('div', { class: 'rounded-lg overflow-hidden bg-surface-50' }, [h(TimelineInspectorShell), h(TimelineSummaryBar)]),
  h('div', { class: 'rounded-lg bg-surface-50', style: 'display:flex;margin-top:12px' }, [
    artwork('unknown', 'Unidentified', {}),
    artwork('missing', 'Boeing 747-400', { aircraftName: 'Boeing 747-400' }),
    artwork('known', 'Available picture', { profileId: knownProfile.value }),
  ]),
  h('div', { class: 'landing-aircraft-hero', 'data-placeholder-hero': '', style: 'margin-top:12px' }, [
    h('div', { class: 'landing-aircraft-hero__copy' }, [
      h('div', { class: 'telemetry-label' }, 'Landing summary'),
      h('div', { class: 'landing-aircraft-hero__name' }, 'iniBuilds Airbus A350-900'),
    ]),
    h(AircraftArtwork, { class: 'landing-aircraft-hero__art', variant: 'hero', profileId: 'inibuilds-a350-900' }),
    h('div', { class: 'landing-aircraft-hero__airport' }, [
      h('div', { style: 'font-size:10px' }, 'Airport / Runway'), h('div', {}, 'YSSY / 34L'),
    ]),
  ]),
  h('button', { 'data-thumbnail-button': '', style: 'display:flex;align-items:center;gap:12px;padding:12px', onClick: () => { thumbnailClicks.value++; } }, [
    h(AircraftArtwork, { class: 'logbook-aircraft-thumb logbook-aircraft-thumb--desktop', aircraftName: 'Boeing 747-400' }),
    h('span', {}, `Flight thumbnail (${thumbnailClicks.value} clicks)`),
  ]),
]) }).use(pinia).mount('#app');
window.timelinePresentationTest = { timeline, thumbnailClicks, settle: nextTick,
  async changeAircraft(id) { knownProfile.value = id; await nextTick(); } };
await nextTick(); window.approachTestReady = true;
