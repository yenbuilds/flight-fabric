import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import '../../frontend/app-settings-shared.js';
import AircraftTabShell from '../../frontend/src/vue/components/AircraftTabShell.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import { useSimbriefStore } from '../../frontend/src/vue/stores/simbrief.js';
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
const pushbackSent = [], pushbackReplies = [];
let pushbackMuted = false;
let pushbackState = { status: 'idle', active: false, canStart: true };
let departureEnabled = false;
const departureSent = [];
function taxiReplyLater(message) {
  taxiReplies.push(message);
  queueMicrotask(() => emitWsMessage(message));
}
const cduSent = [];
let cduError = null;
let taxiStatusMuted = false;
let taxiPreviewError = null;
let taxiState = { status: 'idle', active: false, canGuide: true, canStart: true, reason: 'Ready to taxi.' };
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
  if (fixtures.__pushbackE2E && ['pushback', 'autotaxi', 'requestTaxiGuidance'].includes(message.type)) {
    (message.type === 'pushback' ? pushbackSent : message.type === 'autotaxi' ? taxiSent : departureSent).push(message);
    fetch('/pushback-e2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) })
      .then(response => response.json()).then(emitWsMessage).catch(console.error);
    return true;
  }
  if (message.type === 'requestTaxiGuidance' && message.pushback) {
    departureSent.push(message);
    const points = [{ x: 30, z: 60 }, { x: 30, z: 30 }, { x: 25, z: 10 }, { x: 0, z: 0 }];
    const pushing = pushbackState.active;
    const reply = { type: 'toolbarTaxiState', ok: departureEnabled, requestId: message.requestId, ...taxiContext(),
      error: departureEnabled ? null : 'No pushback fixture for this journey.',
      pushbackPreview: { id: 'shown-' + message.runway, icao: message.icao, runway: message.runway,
        phase: pushing ? 'pushing' : pushbackState.status === 'complete' ? 'complete' : 'preview', valid: !pushing && pushbackState.status !== 'complete',
        lengthM: 78, remainingM: pushing ? 48 : 78, headingDeg: 0, points },
      aircraft: { ...points[pushing ? 1 : 0], headingDeg: 0, speedKts: pushing ? 2 : 0 },
      preview: { ...taxiRoute, runway: message.runway }, scene: taxiScene, sceneKey: taxiScene.key };
    queueMicrotask(() => emitWsMessage(reply)); return true;
  }
  if (message.type === 'pushback') {
    pushbackSent.push(message);
    if (message.operation === 'status' && pushbackMuted) return true;
    if (message.operation === 'start') pushbackState = { status: 'pushing', active: true, canStart: false,
      remainingM: 48, runway: message.runway, reason: `Pushing back for runway ${message.runway}.` };
    if (message.operation === 'stop') pushbackState = { status: 'stopped', active: false, canStart: true, reason: 'Pushback stopped.' };
    const reply = { type: 'pushbackState', ok: true, ...taxiContext(), ...pushbackState, requestId: message.requestId };
    pushbackReplies.push(reply);
    queueMicrotask(() => emitWsMessage(reply));
    return true;
  }
  if (['requestCduState', 'sendCduKey'].includes(message.type)) {
    cduSent.push(message);
    queueMicrotask(() => emitWsMessage({ ...message, ...active.cdu, type: 'cduState', ok: !cduError, ...(cduError ? { error: cduError } : {}) }));
    return true;
  }
  if (message.type !== 'autotaxi') return false;
  taxiSent.push(message);
  if (message.operation === 'status' && taxiStatusMuted) return true;
  if (message.operation === 'parkings') {
    const standOptions = [{ label: 'Gate D 12', typeLabel: 'Medium gate' }, { label: 'Gate D 14', typeLabel: 'Heavy gate' }];
    taxiReplyLater({ type: 'autotaxiState', ok: true, requestId: message.requestId,
      stands: standOptions.map(option => option.label), standOptions });
    return true;
  }
  if (message.operation === 'preview') {
    if (taxiPreviewError) {
      taxiReplyLater({ type: 'autotaxiState', ok: false, ...taxiContext(), requestId: message.requestId, error: taxiPreviewError });
      return true;
    }
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
  if (message.operation === 'release') taxiState = { status: 'idle', active: false, canGuide: true, canStart: true, reason: 'Controls released.' };
  taxiReplyLater({ type: 'autotaxiState', ok: true, ...taxiContext(), ...taxiState, requestId: message.requestId });
  return true;
});
controls.bindCommandAction(command => { sent.push(command); return true; });
specific.bindRuntimeActions({
  requestAction: (actionId, options) => controls.requestControlCommand({ control: 'aircraft-specific', operation: 'execute', actionId }, options),
  requestCommand: (commandId, input, options) => controls.requestControlCommand({ type: 'canonical', commandId, input }, options),
});
let active;
let sdkStatus = 'connected';
let sourceStatus = 'connected';
function publish() {
  if (!active) return;
  const updatedAt = new Date().toISOString();
  specific.ingestState({ profileKey: active.capabilities.aircraftCommands.profileKey, profileRevision: 1,
    templateId: active.templateId, available: true, sourceStatus: { overall: sourceStatus, sdk: sdkStatus, lvar: 'connected', simvar: 'connected',
      sources: { sdk: sdkStatus, lvar: 'connected', simvar: 'connected' } },
    actionCapabilities: active.capabilities.aircraftSpecific, values: active.values, updatedAt,
    valueUpdatedAt: Object.fromEntries(Object.keys(active.values).map(id => [id, updatedAt])), unavailable: [] });
}
window.layoutTest = {
  setSdkStatus(value) { sdkStatus = value; publish(); },
  setSourceStatus(value) { sourceStatus = value; publish(); },
  cduSent, cduDisconnect: emitWsClose,
  setCduError(error) { cduError = error; },
  taxiSent, taxiReplies,
  pushbackSent, pushbackReplies,
  departureSent,
  setDeparture(icao, runway) { departureEnabled = true; useSimbriefStore().plan = { origin: icao, departureRunway: runway }; },
  setPushbackState(state) { pushbackState = state; },
  mutePushbackStatus(value) { pushbackMuted = value; },
  muteTaxiStatus(value) { taxiStatusMuted = value; },
  setTaxiPreviewError(value) { taxiPreviewError = value; },
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
  setAircraftValues(values) { Object.assign(active.values, values); publish(); },
  async scenario(id) {
    cduError = null;
    sourceStatus = 'connected';
    active = fixtures[id];
    taxiState = { status: 'idle', active: false, canGuide: true, canStart: !fixtures.__autotaxiFixture,
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
