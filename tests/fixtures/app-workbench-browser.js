import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import '../../frontend/index.css';
import '../../frontend/ui-polish.css';
import '../../frontend/src/maps/runtime.js';
import AppShell from '../../frontend/src/vue/components/AppShell.vue';
import { setAppServices } from '../../frontend/app-shared.js';
import { emitAppSettings, emitWsMessage, emitWsMessageReceived } from '../../frontend/src/app/runtime-signals.js';
import { useAppSettingsStore } from '../../frontend/src/vue/stores/app-settings.js';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import { useFlightStore } from '../../frontend/src/vue/stores/flight.js';
import { useTakeoffStore } from '../../frontend/src/vue/stores/takeoff.js';
import { useSettingsEditorStore } from '../../frontend/src/vue/stores/settings-editor.js';
import { useSimbriefStore } from '../../frontend/src/vue/stores/simbrief.js';
import { useStatusStore } from '../../frontend/src/vue/stores/status.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import { useTimelineStore } from '../../frontend/src/vue/stores/timeline.js';
import { useShellStore } from '../../frontend/src/vue/stores/shell.js';
import { useProfilesStore } from '../../frontend/src/vue/stores/profiles.js';
import { useToolbarPanelStore } from '../../frontend/src/vue/stores/toolbar-panel.js';

const fixture = await (await fetch('/workbench-fixture')).json();
const query = new URLSearchParams(location.search);
let scope = query.get('scope') || 'full-control';
const disconnected = query.get('disconnected') === '1';
const toolbarFixture = { status: 'not_installed', reads: 0, writes: [] };
if (query.get('toolbar') === '1') window.electronAPI = {
  toolbarPanel: {
    async getStatus() {
      toolbarFixture.reads++;
      return { ok: true, packageVersion: '0.10.2', installs: [{ installId: 'msfs2024-steam', label: 'MSFS 2024 — Steam', found: true,
        status: toolbarFixture.status, canInstall: true, communityFolder: 'C:/MSFS/Packages/Community' }] };
    },
    async install(id) { toolbarFixture.writes.push(['install', id]); toolbarFixture.status = 'installed'; return { ok: true, restartRequired: true }; },
    async uninstall(id) { toolbarFixture.writes.push(['uninstall', id]); toolbarFixture.status = 'not_installed'; return { ok: true, removed: true }; },
  },
};
// Simulate upgrading a browser that previously chose a different navigation order.
localStorage.setItem('ff_workspace_v1', 'planning');
localStorage.setItem('ff_workspace_suggestions_v1', 'on');
localStorage.setItem('ff.liveMap.followMode.v1', 'paused');
localStorage.setItem('ff.liveMap.view.v1', JSON.stringify({ lat: -35.8, lon: 148, zoom: 6 }));
const pinia = createPinia();
setActivePinia(pinia);
const tabs = useTabsStore(), status = useStatusStore(), flight = useFlightStore();
const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const settings = useAppSettingsStore(), timeline = useTimelineStore(), simbrief = useSimbriefStore();
const settingsValue = window.FlightFabricAppSettings.normalizeAppSettings({ network: { onlineMapTiles: false }, cabinAnnouncements: { enabled: false } });
const plan = {
  origin: 'YSSY', originName: 'Sydney Kingsford Smith', destination: 'YMML', destinationName: 'Melbourne', alternate: 'YMAV',
  departureRunway: '16R', arrivalRunway: '16',
  aircraft: 'B738', callsign: 'QFA437', flightNumber: '437', registration: 'VH-VXR',
  route: 'DCT WOL H65 RAZZI Q29 LIZZI DCT', cruiseAltFl: 'FL340', cruiseMach: '0.78',
  eteSeconds: 4620, fuelLbs: 6450, weightUnit: 'kg', costIndex: 25, fetchedAt: Date.now(),
  fuel: { taxi: 220, trip: 3610, contingency: 180, alternate: 540, reserve: 1250, extra: 650, takeoff: 6230, landing: 2620 },
  weights: { passengers: 162, payload: 16420, zeroFuel: 57120, takeoff: 63350, landing: 59740, maxTakeoff: 79015, maxLanding: 66360 },
  weather: { originMetar: 'YSSY 200200Z 17012KT 9999 FEW025 19/11 Q1020', destinationMetar: 'YMML 200200Z 24015KT 9999 SCT035 16/08 Q1018' },
  performance: { routeDistance: 397, greatCircleDistance: 381, cruiseTas: 448, averageWindComponent: -18 },
  scheduledOut: 1790038800, scheduledOff: 1790039700, scheduledOn: 1790044320, scheduledIn: 1790044920,
  taxiOutSeconds: 900, taxiInSeconds: 600, blockSeconds: 6120,
  navlog: ['YSSY', 'WOL', 'RAZZI', 'LIZZI', 'YMML'].map((ident, index) => ({ ident, altitude: index === 2 ? 34000 : index === 1 || index === 3 ? 16000 : 100, distance: 82, time: 900 })),
};
simbrief.plan = plan;
simbrief.username = 'FlightFabric';
simbrief.status = 'OFP loaded successfully.';
settings.apply({ settings: scope === 'full-control' ? settingsValue : { network: { onlineMapTiles: false } }, backendVersion: '0.9.9' });
if (scope === 'full-control') useSettingsEditorStore().applySettings(settingsValue);
const startedAt = Date.parse('2026-09-19T02:35:00Z');
const flights = Array.from({ length: 12 }, (_, index) => ({
  filePath: `recorded-${index}.csv`, flightId: `FF-${index}`, route: index % 2 ? 'YMML-YSSY' : 'YSSY-YMML',
  aircraft: 'Boeing 737-800', aircraftProfileId: 'pmdg-737', timestamp: new Date(startedAt - index * 86400000).toISOString(),
  recordingStartIso: new Date(startedAt - index * 86400000).toISOString(), durationMs: 4620000, distanceNm: 397, eventCount: 1450,
}));
const track = Array.from({ length: 45 }, (_, index) => {
  const fraction = index / 44;
  return { lat: -33.9461 + (-37.6733 + 33.9461) * fraction, lon: 151.1772 + (144.8433 - 151.1772) * fraction,
    timestampMs: startedAt + fraction * 4620000, hdgTrueDeg: 232, iasKts: index < 5 ? 180 : 280,
    altFt: Math.min(34000, index * 6000, (44 - index) * 5500) };
});
const events = [
  { type: 'phase_start', newPhase: 'TAKEOFF', previousPhase: 'TAXI', timestampMs: startedAt, lat: -33.9461, lon: 151.1772 },
  { type: 'phase_start', newPhase: 'CLIMB', previousPhase: 'TAKEOFF', timestampMs: startedAt + 180000, lat: -34.2, lon: 150.8 },
  { type: 'phase_start', newPhase: 'CRUISE', previousPhase: 'CLIMB', timestampMs: startedAt + 900000, lat: -34.8, lon: 149.7 },
  { type: 'phase_start', newPhase: 'DESCENT', previousPhase: 'CRUISE', timestampMs: startedAt + 3300000, lat: -36.7, lon: 146.4 },
  { type: 'phase_start', newPhase: 'APPROACH', previousPhase: 'DESCENT', timestampMs: startedAt + 4150000, lat: -37.4, lon: 145.3 },
  { type: 'landing', timestampMs: startedAt + 4620000, lat: -37.6733, lon: 144.8433, ias_kts: 138, vs_fpm: -184,
    grade: 'PERFECT', pitch_deg: 3.4, runway: { airport_icao: 'YMML', runway_id: '16', length_ft: 11998 },
    touchdownDistance: { distanceFt: 960, grade: 'Outstanding', zone: 'within zone', score: 95, lateralOffsetFt: 8, bounceCount: 0 },
    ultimateStability: { verdict: 'stable', score: 96, samples: 40, gateStable: true, gateFailures: [] } },
];
const recorded = { ...flights[0], startTime: new Date(startedAt).toISOString(), simDateTimeLocal: '2026-09-19T12:35:00',
  simDateTimeUtc: new Date(startedAt).toISOString(), eventCount: events.length, events, track };
const sent = [];
function send(message) {
  sent.push(message);
  if (scope !== 'full-control' && ['requestTimelineList', 'requestTimeline', 'saveAppSettings', 'requestAppSettings', 'setDestinationTarget', 'setOriginTarget'].includes(message.type)) return false;
  if (message.type === 'requestTimelineList') queueMicrotask(() => {
    const payload = { type: 'timelineList', requestId: message.requestId, flights };
    timeline.ingestMessage(payload); emitWsMessage(payload);
  });
  else if (message.type === 'requestTimeline') queueMicrotask(() => emitWsMessage({ type: 'timeline', requestId: message.requestId, timeline: recorded }));
  else return false;
  return true;
}
setAppServices({ getAuthorizationScope: () => scope, isAuthorizationAcknowledged: () => !disconnected, getAppSettings: () => scope === 'full-control' ? settingsValue : null,
  sendWs: send, getWs: () => ({ readyState: WebSocket.OPEN, send: text => send(JSON.parse(text)) }) });
timeline.bindRequestActions({ onRequestList: send, onRequestTimeline: send });
controls.applyControlCapabilities(fixture.capabilities);
controls.setAvailability({ enabled: ['full-control', 'aircraft-control'].includes(scope) && !disconnected,
  reason: disconnected ? 'Waiting for the FlightFabric PC.' : scope === 'read-only' ? 'Pair this device to enable aircraft controls.' : '' });
controls.bindCommandAction(command => { sent.push(command); return false; });
specific.applyProfile({ _profileKey: fixture.capabilities.aircraftCommands.profileKey, profileRevision: 1, aircraftSpecificTemplateId: 'pmdg-737' });
tabs.setActiveTab('livemap');
status.setWebsocket(disconnected ? 'disconnected' : 'ready');
status.ingestMessage({ type: 'simState', simconnectConnected: true, inMenu: false, inFlightContext: true, lifecycleState: 'active' });
status.ingestMessage({ type: 'aircraftProfile', profile: { id: 'pmdg-737', name: 'PMDG 737-800', aircraftTitle: 'Boeing 737-800', _profileKey: fixture.capabilities.aircraftCommands.profileKey } });
status.ingestMessage({ type: 'phase', value: 'CRUISE' });
status.ingestMessage({ type: 'flightTime', elapsedHms: '00:48:12' });
status.ingestMessage({ type: 'flightRecording', status: 'recording', fileName: 'QFA437.csv' });
status.ingestMessage({ type: 'dataSources', primary: { name: 'SimConnect', connected: true } });
status.bindHeaderActions({ onStartRecordingManual: () => false, onEndFlightManual: () => false });
flight.setFlightState(disconnected ? 'disconnected' : 'live');
function publishTelemetry() {
  if (disconnected) return;
  const updatedAt = new Date().toISOString();
  specific.ingestState({ templateId: 'pmdg-737', profileKey: fixture.capabilities.aircraftCommands.profileKey, profileRevision: 1,
    available: true, sourceStatus: { overall: 'connected', sdk: 'connected', lvar: 'connected', simvar: 'connected' },
    actionCapabilities: fixture.capabilities.aircraftSpecific, values: fixture.values, updatedAt,
    valueUpdatedAt: Object.fromEntries(Object.keys(fixture.values).map(key => [key, updatedAt])), unavailable: [] });
  for (const message of [
    { type: 'ias', value: 284 }, { type: 'gs', value: 432 }, { type: 'vs', value: 0 },
    { type: 'altitude', msl: 34000, indicated: 34000, ra: 32350 }, { type: 'heading', true: 232, magnetic: 221 },
    { type: 'fuel', totalGal: 1680, totalWeightLbs: 11256 },
    { type: 'xwind', value: -12 }, { type: 'gear', data: { left: 0, right: 0, nose: 0, parkingBrake: false } },
    { type: 'flaps', value: { notch: 0, percent: 0 } }, { type: 'spoilers', value: { state: 'DOWN' } },
    { type: 'lights', data: { nav: true, beacon: true, strobe: true, landing: false, taxi: false } },
    { type: 'engines', data: { count: 2, eng1Text: 'N1 88.2%', eng2Text: 'N1 88.5%' } },
    { type: 'environment', oatC: -45, cabinAltFt: 6200, cabinAltRateFpm: 0 },
  ]) { flight.ingestMessage(message); emitWsMessageReceived(message); emitWsMessage(message); }
}
createApp(AppShell).use(pinia).mount('#vue-app-root');
await nextTick();
useProfilesStore().setAuthorizationScope(scope, query.get('pairing') || (scope === 'aircraft-control' ? 'accepted' : 'not-requested'));
if (scope === 'full-control') emitAppSettings({ settings: settingsValue, backendVersion: '0.9.9' });
publishTelemetry();
// Exercise the actual map route/track renderer with deterministic offline data.
emitWsMessage({ type: 'originTarget', target: { icao: 'YSSY', name: 'Sydney', lat: -33.9461, lon: 151.1772 } });
emitWsMessage({ type: 'destinationTarget', target: { icao: 'YMML', name: 'Melbourne', lat: -37.6733, lon: 144.8433 } });
emitWsMessage({ type: 'flightPlan', ...plan });
for (const point of (disconnected ? [] : track.slice(0, 30))) {
  const message = { type: 'position', lat: point.lat, lon: point.lon, timestampMs: point.timestampMs, heading: 232 };
  emitWsMessageReceived(message); emitWsMessage(message);
}
if (scope === 'full-control') timeline.ingestMessage({ type: 'timelineList', flights });
else timeline.markListRestricted();
setInterval(publishTelemetry, 800);
window.workbenchTest = { tabs, status, flight, controls, takeoff: useTakeoffStore(), profiles: useProfilesStore(), timeline, shell: useShellStore(), sent, nextTick,
  toolbar: useToolbarPanelStore(), toolbarFixture,
  async open(tab) { timeline.closeTimelineMobileViewer(); tabs.requestTabChange(tab); await nextTick(); },
  async review() { timeline.requestTimeline(flights[0].filePath, flights[0].flightId, { flightLabel: flights[0].route }); await nextTick(); },
  async authorize(nextScope, pairing = 'not-requested') {
    scope = nextScope;
    useProfilesStore().setAuthorizationScope(scope, pairing);
    controls.setAvailability({ enabled: ['full-control', 'aircraft-control'].includes(scope) && !disconnected,
      reason: scope === 'read-only' ? 'Pair this device to enable aircraft controls.' : '' });
    if (scope === 'full-control') {
      settings.apply({ settings: settingsValue, backendVersion: '0.9.9' });
      emitAppSettings({ settings: settingsValue, backendVersion: '0.9.9' });
      timeline.ingestMessage({ type: 'timelineList', flights });
    } else timeline.markListRestricted();
    await nextTick();
  },
};
