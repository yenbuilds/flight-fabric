import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import '../../frontend/app-settings-shared.js';
import AircraftTabShell from '../../frontend/src/vue/components/AircraftTabShell.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import '../../frontend/index.css';
import { setAppService } from '../../frontend/app-shared.js';
import { emitWsMessage, emitWsClose, emitWsOpen } from '../../frontend/src/app/runtime-signals.js';

const fixtures = await (await fetch('/aircraft-layout-fixtures')).json();
// Visibility follows the production release setting. All requests below use
// fake transport and never connect to an application or simulator.
const pinia = createPinia();
setActivePinia(pinia);
const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
useTabsStore().setActiveTab('autopilot');
const sent = [];
const taxiSent = [];
const taxiReplies = [];
function taxiReplyLater(message) {
  taxiReplies.push(message);
  queueMicrotask(() => emitWsMessage(message));
}
const cduSent = [];
let cduError = null;
let taxiState = { status: 'idle', active: false, canStart: true, reason: 'Ready to taxi.' };
const taxiContext = () => ({ support: active?.taxiSupport,
  currentProfileKey: active?.capabilities.aircraftCommands.profileKey,
  currentProfileRevision: active?.capabilities.aircraftCommands.profileRevision });
// Diagram context the real backend sends once per plan, plus a live aircraft position.
const taxiRoute = { points: [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 110, z: 100 }], lengthM: 210, runway: '16', runwayTravelM: 0, holdShort: { x: 140, z: 100 } };
const taxiScene = { key: 1, origin: { lat: -37.67, lon: 144.84 }, marginM: 300, bounds: { minX: -300, maxX: 480, minZ: -300, maxZ: 400 },
  runways: [{ id: '16', reciprocal: '34', ends: [{ x: 175, z: 400 }, { x: 175, z: -300 }],
    corners: [{ x: 197.5, z: 400 }, { x: 197.5, z: -300 }, { x: 152.5, z: -300 }, { x: 152.5, z: 400 }] }],
  links: [{ a: { x: 0, z: -200 }, b: { x: 0, z: 100 }, widthM: 23, runway: false }, { a: { x: 0, z: 100 }, b: { x: 175, z: 100 }, widthM: 23, runway: false },
    { a: { x: -150, z: 100 }, b: { x: 0, z: 100 }, widthM: 23, runway: false }, { a: { x: 175, z: 400 }, b: { x: 175, z: -300 }, widthM: 45, runway: true }] };
const taxiAircraft = { x: 0.4, z: 12, headingDeg: 3, speedKts: 2.4 };
setAppService('sendWs', message => {
  if (['requestCduState', 'sendCduKey'].includes(message.type)) {
    cduSent.push(message);
    queueMicrotask(() => emitWsMessage({ ...message, ...active.cdu, type: 'cduState', ok: !cduError, ...(cduError ? { error: cduError } : {}) }));
    return true;
  }
  if (message.type !== 'autotaxi') return false;
  taxiSent.push(message);
  if (message.operation === 'parkings') {
    const standOptions = [{ label: 'Gate D 12', typeLabel: 'Medium gate' }, { label: 'Gate D 14', typeLabel: 'Heavy gate' }];
    taxiReplyLater({ type: 'autotaxiState', ok: true, requestId: message.requestId,
      stands: standOptions.map(option => option.label), standOptions });
    return true;
  }
  if (message.operation === 'preview') {
    // Like the backend, the scene and aircraft position persist on later status replies.
    taxiState = { ...taxiState, sceneKey: taxiScene.key, aircraft: taxiAircraft };
    taxiReplyLater({ type: 'autotaxiState', ok: true, ...taxiContext(), ...taxiState, requestId: message.requestId,
      preview: taxiRoute, scene: taxiScene });
    return true;
  }
  if (message.operation === 'start') taxiState = { status: 'taxiing', active: true, canStart: false, reason: 'Taxiing to hold short of runway 16.',
    remainingM: 200, observedSpeedKts: 2.4, commanded: { throttle: 0.06, brake: 0, steering: 0.25 },
    route: taxiRoute, scene: taxiScene, sceneKey: taxiScene.key, aircraft: taxiAircraft };
  if (message.operation === 'stop') taxiState = { status: 'stopped', active: true, canStart: false, reason: 'Stopped. Brakes held.',
    route: taxiRoute, sceneKey: taxiScene.key, aircraft: taxiAircraft };
  if (message.operation === 'release') taxiState = { status: 'idle', active: false, canStart: true, reason: 'Controls released.' };
  taxiReplyLater({ type: 'autotaxiState', ok: true, ...taxiContext(), ...taxiState, requestId: message.requestId });
  return true;
});
controls.bindCommandAction(command => { sent.push(command); return true; });
let active;
function publish() {
  if (!active) return;
  const updatedAt = new Date().toISOString();
  specific.ingestState({ profileKey: active.capabilities.aircraftCommands.profileKey, profileRevision: 1,
    templateId: active.templateId, available: true, sourceStatus: { overall: 'connected', sdk: 'connected', lvar: 'connected', simvar: 'connected' },
    actionCapabilities: active.capabilities.aircraftSpecific, values: active.values, updatedAt,
    valueUpdatedAt: Object.fromEntries(Object.keys(active.values).map(id => [id, updatedAt])), unavailable: [] });
}
window.layoutTest = {
  cduSent, cduDisconnect: emitWsClose,
  setCduError(error) { cduError = error; },
  taxiSent, taxiReplies,
  taxiDisconnect: emitWsClose,
  taxiReconnect: emitWsOpen,
  async remount() {
    mountedApp.unmount();
    mountedApp = createApp(AircraftTabShell).use(pinia);
    mountedApp.mount('#app');
    await nextTick();
  },
  setTaxiState(next) {
    taxiState = { ...taxiState, ...next };
    emitWsMessage({ type: 'autotaxiState', ok: true, ...taxiContext(), ...taxiState });
  },
  taxiReply: emitWsMessage,
  // A fresh sample, as parsed WebSocket JSON would be; the panel's next status poll carries it.
  moveAircraft(pose) { taxiState = { ...taxiState, aircraft: { ...taxiState.aircraft, ...pose } }; },
  controls, specific, sent,
  async scenario(id) {
    cduError = null;
    active = fixtures[id];
    taxiState = { status: 'idle', active: false, canStart: !fixtures.__autotaxiFixture,
      reason: fixtures.__autotaxiFixture ? 'Live acceptance is pending for this aircraft.' : 'Ready to taxi.' };
    controls.applyControlCapabilities(active.capabilities);
    controls.setAvailability({ enabled: true });
    specific.applyProfile({ _profileKey: active.capabilities.aircraftCommands.profileKey,
      profileRevision: 1, aircraftSpecificTemplateId: active.templateId });
    publish();
    await nextTick();
  },
  async settle() { await nextTick(); },
};
await window.layoutTest.scenario('pmdg-737');
let mountedApp = createApp(AircraftTabShell).use(pinia);
mountedApp.mount('#app');
setInterval(publish, 500);
