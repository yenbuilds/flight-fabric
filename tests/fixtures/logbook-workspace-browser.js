import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import '../../frontend/index.css';
import '../../frontend/ui-polish.css';
import TimelineTabShell from '../../frontend/src/vue/components/TimelineTabShell.vue';
import { useTimelineStore } from '../../frontend/src/vue/stores/timeline.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import { useStatusStore } from '../../frontend/src/vue/stores/status.js';
import { setAppService } from '../../frontend/app-shared.js';

const pinia = createPinia();
setActivePinia(pinia);
setAppService('getAuthorizationScope', () => 'full-control');
setAppService('sendWs', () => false);
const timeline = useTimelineStore();
const status = useStatusStore();
status.setWebsocket('ready');
useTabsStore().setActiveTab('timeline');
createApp(TimelineTabShell).use(pinia).mount('#app');
await nextTick();

const flights = Array.from({ length: 18 }, (_, index) => ({
  filePath: `flight-${index}.csv`, flightId: `RECORDED-${index}`,
  route: index % 2 ? 'EGLL-LFPG' : 'YSSY-YMML', aircraft: index % 2 ? 'Airbus A320' : 'Boeing 737-800',
  displayRouteLabel: index % 2 ? 'EGLL → LFPG' : 'YSSY → YMML',
  departureCountry: index % 2 ? 'GB' : 'AU', arrivalCountry: index % 2 ? 'FR' : 'AU',
  recordingStartIso: '2026-09-19T02:35:00Z', timestamp: 1758249300000 - index * 86400000,
  durationMs: 5400000, distanceNm: 384, eventCount: 1200,
  recordingBundleSizeBytes: 1048576,
  latestLandingEvent: index === 0 ? { id: 'landing-0', type: 'landing' } : null,
}));
Object.assign(flights[2], { displayRouteLabel: 'NEAR TA61 → NEAR K90F', departureCountry: 'US', arrivalCountry: 'US', aircraft: '' });
Object.assign(flights[3], { displayRouteLabel: 'NEAR A VERY LONG AIRPORT NAME → NEAR ANOTHER LONG AIRPORT', aircraft: 'A very long recorded aircraft variant and livery name' });
const storage = { dir: 'C:/Users/Pilot/Documents/Flight Fabric/Flight Logs', exists: true, fileCount: 18, totalBytes: 18874368 };
const actions = { landing: '', deletePrompt: '', deleted: '', storage: '' };
let requests = 0;
let holdResponse = false;
function loadFlight(flight = flights[0]) {
  timeline.clearTimelineLoading();
  timeline.setLoadedTimelineIdentity({ ...flight, startTime: flight.recordingStartIso,
    simDateTimeLocal: '2026-09-19T12:35:00', simDateTimeUtc: '2026-09-19T02:35:00Z' });
  timeline.setInspectorState({ flightIdText: '1h 30m', routeText: flight.route, routeVisible: true,
    emptyVisible: false, eventListVisible: true,
    rows: Array.from({ length: 24 }, (_, index) => ({ rowKey: `event-${index}`, index,
      type: index === 22 ? 'landing' : 'phase_start', event: { type: index === 22 ? 'landing' : 'phase_start' },
      title: index === 22 ? 'Landing at YMML 16' : ['Pushback', 'Taxi', 'Takeoff', 'Climb', 'Cruise', 'Descent'][index % 6],
      subtitle: index === 22 ? 'Recorded touchdown · 138 kt' : 'Recorded flight phase', timeOffsetText: `${index * 4}m`, badges: [] })),
  });
  timeline.setSummary({ visible: true, eventCountText: '24', cautionCountText: '1', violationCountText: '0', durationText: '1h 30m', distanceText: '384 NM', fuelBurnText: '--' });
}
timeline.bindRequestActions({
  onRequestList: payload => { queueMicrotask(() => timeline.ingestMessage({ type: 'timelineList', flights, requestId: payload.requestId })); return true; },
  onRequestTimeline: payload => { requests++; if (!holdResponse) loadFlight(flights.find(f => f.filePath === payload.filePath) || flights[0]); return true; },
  onDeleteFlight: payload => { actions.deleted = payload.filePath; return true; },
});
timeline.bindPanelActions({
  confirmDeleteFlight: (_prompt, flight) => { actions.deletePrompt = flight.filePath; return false; },
  openStorageFolder: dir => { actions.storage = dir; return true; },
});
timeline.bindDetailActions({
  onOpenSelectedLanding: () => true,
  onOpenFlightLanding: flight => { actions.landing = flight.filePath; return true; },
});
timeline.bindInspectorActions({ onSelectRow: () => {
  timeline.setDetail({ visible: true, type: 'phase_start', title: 'Recorded climb', metricSections: [
    { key: 'recorded', title: 'Recorded measurements', rows: [{ key: 'alt', label: 'Altitude', value: '12,000 ft' }], noteText: '', emptyText: '' },
  ] });
} });
timeline.ingestMessage({ type: 'timelineList', flights, storage });
window.logbookTest = { timeline, actions, settle: nextTick, requests: () => requests,
  restricted() { timeline.markListRestricted(); },
  restore() { status.setWebsocket('ready'); timeline.ingestMessage({ type: 'timelineList', flights }); },
  holdResponse(value) { holdResponse = value; },
  disconnect() { status.setWebsocket('disconnected'); },
};
