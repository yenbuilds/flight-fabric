<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { sendWs } from '../../../../app-shared.js';
import { subscribeWsMessage, subscribeWsClose, subscribeWsOpen } from '../../../app/runtime-signals.js';
import { useAircraftControlsStore } from '../../stores/aircraft-controls.js';
import { useSimbriefStore } from '../../stores/simbrief.js';
import PushbackControls from './PushbackControls.vue';
import TaxiPushbackMap from './TaxiPushbackMap.vue';
import { pushbackCaption } from '../../../aircraft/pushback-map.js';
import { splitRoute } from '../../../aircraft/taxi-progress.js';
import { aircraftSprite, createChaseCamera, projectTaxiScene, readTaxiView, smoothRoute, writeTaxiView } from '../../../aircraft/autotaxi-chase-view.js';

const controls = useAircraftControlsStore();
const simbrief = useSimbriefStore();
const pushbackActive = ref(false);
const departure = ref({ data: null, fresh: false });
const departureView = ref(true);
const showPushback = computed(() => !controlling.value && departureView.value && departure.value.data?.pushbackPreview);
function receiveDeparture(snapshot) {
  const previous = departure.value.data?.pushbackPreview.phase;
  departure.value = snapshot;
  if (snapshot.data?.pushbackPreview.phase === 'complete' && previous !== 'complete') departureView.value = false;
}
function pushbackActivity(active) {
  pushbackActive.value = active;
  if (active) {
    routeError.value = '';
    preview.value = null; hiddenSceneKey.value = state.value.sceneKey ?? null;
    departureView.value = true; open.value = true;
  }
}
const icao = ref('');
const runway = ref('');
const destinationOpen = ref(true);
const destinationForm = ref(null);
const editingDestination = () => typeof document !== 'undefined' && destinationForm.value?.contains(document.activeElement);
// Destination: hold short of a runway before departure, or a named stand after landing.
const mode = ref('runway');
const stand = ref('');
const stands = ref([]);
const selectedStandType = computed(() => stands.value.find(option => option.label.toUpperCase() === stand.value.trim().toUpperCase())?.typeLabel);
const state = ref({ status: 'idle', active: false, canStart: false, canGuide: false, reason: 'Waiting for taxi guidance.' });
const statusClock = ref(performance.now());
const lastStatusAt = ref(null);
// A live socket does not guarantee live replies. Expire display/readiness
// locally too, without changing backend ownership or sending control commands.
const statusFresh = computed(() => lastStatusAt.value !== null && statusClock.value - lastStatusAt.value <= 2000);
const guidanceUnavailable = computed(() => statusFresh.value ? state.value.guidanceUnavailableReason : 'Waiting for live taxi status.');
const error = ref('');
// A direct taxi route can fail while the departure pushback route is valid.
// Keep that planning result with the taxi view, without hiding control faults.
const routeError = ref('');
const visibleError = computed(() => error.value || state.value.error
  || (!showPushback.value && !pushbackActive.value ? routeError.value : ''));
const pending = ref('');
const preview = ref(null);
const hiddenSceneKey = ref(null);
const scene = ref(null);
const headingUp = ref(true);
// Collapsed by default; an active session always shows its controls and map.
const open = ref(false);
const automationOpen = ref(false);
// After a stop the session sets the parking brake and hands the axes back; it
// then only holds the map and reason until Release or a new plan clears it.
const controlling = computed(() => state.value.active && !state.value.handedOver);
const automationBusy = computed(() => controlling.value || state.value.status === 'planning' || ['start', 'preview'].includes(pending.value));
const isBusy = computed(() => pushbackActive.value || automationBusy.value);
const unavailable = computed(() => !controls.availability.enabled ? controls.availability.reason
  : !statusFresh.value ? 'Waiting for live taxi status.' : state.value.unavailableReason);
const support = computed(() => state.value.support || null);
const setupInstructions = computed(() => support.value?.setupInstructions || []);
const destination = computed(() => (mode.value === 'stand' ? stand.value : runway.value).trim());
const hasDestination = computed(() => !isBusy.value && !pending.value && icao.value.trim() && destination.value);
const canPlan = computed(() => hasDestination.value && statusFresh.value && state.value.canGuide);
const canStart = computed(() => hasDestination.value && statusFresh.value && state.value.canStart && controls.availability.enabled);
// Use the planned departure without replacing a runway the pilot entered.
watch(() => [simbrief.plan?.origin || '', simbrief.plan?.departureRunway || ''], (next, previous = ['', '']) => {
  if (isBusy.value || mode.value !== 'runway') return;
  if (!icao.value || icao.value === previous[0]) icao.value = next[0];
  if (icao.value === next[0] && (!runway.value || runway.value === previous[1])) {
    runway.value = next[1];
    if (icao.value && runway.value && !editingDestination()) destinationOpen.value = false;
  }
}, { immediate: true });
watch([icao, runway, stand, mode], () => {
  routeError.value = '';
  preview.value = null;
  departure.value = { data: null, fresh: false }; departureView.value = true;
  // After handover the backend still reports its completed route. Editing a
  // destination must hide that route on every subsequent status reply too.
  if (!controlling.value) hiddenSceneKey.value = state.value.sceneKey ?? null;
});
// Invalidate immediately when the airport changes, including during debounce.
let standsTimer;
let standsRequest = null;
const airportCode = () => icao.value.trim().toUpperCase();
function clearStands() {
  stands.value = []; standsRequest = null; clearTimeout(standsTimer);
}
function loadStands() {
  clearStands();
  if (/^[A-Z0-9]{3,8}$/.test(airportCode())) standsTimer = setTimeout(() => send('parkings'), 600);
}
watch(icao, loadStands, { flush: 'sync' });

// Map view. Scenery metres east/north become SVG x/-y. While the aircraft is
// known the world rotates around it heading-up, like a driving visualiser;
// otherwise the route is fitted north-up.
const VIEW = { w: 360, h: 300, ax: 180, ay: 212, pxPerM: 0.9 };
const manualRoute = computed(() => !controlling.value && hiddenSceneKey.value !== null && hiddenSceneKey.value === state.value.sceneKey
  ? null : state.value.route || preview.value);
const route = computed(() => manualRoute.value || (!controlling.value ? departure.value.data?.route : null));
const departureRoute = computed(() => !manualRoute.value && Boolean(departure.value.data?.route));
const futureTaxiRoute = computed(() => departureRoute.value && departure.value.data?.pushbackPreview.phase !== 'complete');
const diagramScene = computed(() => departureRoute.value ? departure.value.data.scene : scene.value);
watch(() => Boolean(route.value), shown => { if (!shown || !editingDestination()) destinationOpen.value = !shown; });
const aircraft = computed(() => departureRoute.value ? (departure.value.fresh ? departure.value.data.aircraft : null)
  : statusFresh.value ? state.value.aircraft || null : null);
// Keep the rotation continuous so the CSS transition never spins the long way round.
const heading = ref(0);
watch(() => aircraft.value?.headingDeg, h => { if (Number.isFinite(h)) heading.value += ((h - heading.value + 540) % 360) - 180; }, { immediate: true });
const view = computed(() => {
  if (!route.value) return null;
  if (aircraft.value && headingUp.value) {
    const s = VIEW.pxPerM, a = aircraft.value;
    return { scale: s, rotation: heading.value, transform: `translate(${VIEW.ax}px, ${VIEW.ay}px) rotate(${-heading.value}deg) scale(${s}) translate(${-a.x}px, ${a.z}px)` };
  }
  const all = [...route.value.points, route.value.holdShort, ...(aircraft.value ? [aircraft.value] : [])];
  const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
  const minZ = Math.min(...all.map(p => p.z)), maxZ = Math.max(...all.map(p => p.z));
  const s = Math.min((VIEW.w - 60) / Math.max(40, maxX - minX), (VIEW.h - 60) / Math.max(40, maxZ - minZ));
  return { scale: s, rotation: 0, transform: `translate(${VIEW.w / 2}px, ${VIEW.h / 2}px) scale(${s}) translate(${-(minX + maxX) / 2}px, ${(minZ + maxZ) / 2}px)` };
});
const pt = p => `${p.x},${-p.z}`;
const line = points => points.map(pt).join(' ');

// 3D view: a chase camera rigid to the aircraft, so the aircraft holds still and the world moves.
// The pose it follows is eased between 4 Hz samples in JS, as CSS eases the 2D world transform.
const storage = () => { try { return globalThis.localStorage; } catch { return null; } };
const viewMode = ref(readTaxiView(storage()));
watch(viewMode, mode => writeTaxiView(storage(), mode));
const chaseCamera = createChaseCamera(VIEW);
const sprite = aircraftSprite(chaseCamera);
const shown = ref(null);
let tween = null;
let frameId = 0;
const turn = (from, to) => ((to - from + 540) % 360) - 180;
function animate(now) {
  frameId = 0;
  if (!tween) return;
  const t = Math.min(1, (now - tween.start) / 250), { from, to } = tween;
  if (t < 1) {
    shown.value = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t, headingDeg: from.headingDeg + turn(from.headingDeg, to.headingDeg) * t };
    frameId = requestAnimationFrame(animate);
  } else { shown.value = to; tween = null; }
}
// Only while the panel is open: a collapsed panel paints nothing, so its world need not move.
watch([aircraft, () => viewMode.value === '3d' && open.value], ([next, on]) => {
  if (frameId) cancelAnimationFrame(frameId);
  frameId = 0; tween = null;
  if (!on || !next) { shown.value = null; return; }
  const to = { x: next.x, z: next.z, headingDeg: next.headingDeg };
  if (!shown.value || typeof requestAnimationFrame !== 'function') { shown.value = to; return; }
  // A parked aircraft reports the same pose 4 times a second; nothing to ease.
  const { x, z, headingDeg } = shown.value;
  if (Math.abs(to.x - x) < 0.01 && Math.abs(to.z - z) < 0.01 && Math.abs(turn(headingDeg, to.headingDeg)) < 0.01) return;
  tween = { from: shown.value, to, start: performance.now() };
  frameId = requestAnimationFrame(animate);
});
// The 3D ribbon rounds the route's corners for display; the controller still follows the straight legs.
const smoothPoints = computed(() => (route.value ? smoothRoute(route.value.points) : null));
const chase = computed(() => {
  if (!(viewMode.value === '3d' && route.value && shown.value)) return null;
  const { done, ahead } = splitRoute(smoothPoints.value, shown.value);
  return projectTaxiScene(chaseCamera, { scene: diagramScene.value, route: route.value, aircraft: shown.value, done, ahead });
});
// The compass follows the continuous 2D heading in both views, so switching never spins it a full turn.
const compassRotation = computed(() => (chase.value ? heading.value : view.value.rotation));
function toggleHeadingUp() { if (!chase.value) headingUp.value = !headingUp.value; }
const progress = computed(() => (route.value ? splitRoute(route.value.points, aircraft.value) : null));
const offRoute = computed(() => progress.value?.distanceM > 25);
const holdBar = computed(() => {
  const r = route.value;
  if (!r) return null;
  const from = r.points.at(-1), to = r.holdShort;
  const len = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  const nx = -(to.z - from.z) / len * 14, nz = (to.x - from.x) / len * 14;
  return { ax: to.x + nx, ay: -(to.z + nz), bx: to.x - nx, by: -(to.z - nz), dash: line([from, to]) };
});
const px = n => (view.value ? n / view.value.scale : n);
const remainingM = computed(() => {
  if (!aircraft.value || offRoute.value) return null;
  if (controlling.value && Number.isFinite(state.value.remainingM)) return state.value.remainingM;
  return progress.value?.ahead.reduce((sum, p, i, points) => sum + (i ? Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) : 0), progress.value.distanceM);
});
const atDestination = computed(() => {
  const end = route.value?.points.at(-1), a = aircraft.value;
  return !controlling.value && end && a && Math.hypot(end.x - a.x, end.z - a.z) <= 5;
});

// A late response from a previously mounted panel must not match a new request.
const requestScope = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
let sequence = 0;
let contextRevision = 0;
let connectionOpen = true;
let pendingId = null;
let timer;
let ticks = 0;
let cleanup;
let closeCleanup;
let openCleanup;
function syncDesktopActivity(active) {
  try { Promise.resolve(globalThis.electronAPI?.setAutotaxiBackgroundActive?.(active)).catch(() => {}); } catch {}
}
const needsHeartbeat = computed(() => pushbackActive.value || controlling.value || ['start', 'preview'].includes(pending.value));
watch(needsHeartbeat, active => syncDesktopActivity(active && connectionOpen), { flush: 'sync' });
watch([() => controls.aircraftCommandCatalogue.profileKey, () => controls.aircraftCommandCatalogue.profileRevision], () => {
  contextRevision += 1;
  lastStatusAt.value = null; hiddenSceneKey.value = null;
  state.value = { status: 'idle', active: false, canStart: false, canGuide: false, reason: 'Checking taxi guidance.' };
  preview.value = null; scene.value = null; error.value = ''; routeError.value = ''; pending.value = ''; pendingId = null;
  clearStands();
  send('status'); loadStands();
}, { flush: 'sync' });
function send(operation) {
  if (operation === 'preview' || operation === 'start') routeError.value = '';
  if (operation === 'preview' || operation === 'start') departureView.value = false;
  if (!connectionOpen && ['status', 'parkings'].includes(operation)) return;
  const requestId = `autotaxi-${requestScope}-${contextRevision}-${++sequence}`;
  const catalogue = controls.aircraftCommandCatalogue;
  if (operation === 'parkings') standsRequest = { requestId, icao: airportCode() };
  if (!['status', 'parkings'].includes(operation)) { pending.value = operation; pendingId = requestId; error.value = ''; }
  if (['preview', 'start'].includes(operation)) preview.value = null;
  const wantScene = operation === 'status' && state.value.sceneKey != null && scene.value?.key !== state.value.sceneKey;
  const sent = sendWs({ type: 'autotaxi', operation, requestId, icao: icao.value, runway: mode.value === 'runway' ? runway.value : '',
    parking: mode.value === 'stand' ? stand.value : '',
    profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision, ...(wantScene ? { scene: true } : {}) });
  if (sent === false && operation !== 'status' && operation !== 'parkings') { pending.value = ''; pendingId = null; error.value = 'Connection unavailable.'; }
  if (sent === false && operation === 'parkings') standsRequest = null;
}
onMounted(() => {
  cleanup = subscribeWsMessage(message => {
    if (message?.type !== 'autotaxiState' || !connectionOpen) return;
    // A shared panel can outlive a profile switch. Responses from the previous
    // catalogue must not restore its route, readiness or pending controls.
    if (message.requestId != null
      && !message.requestId.startsWith?.(`autotaxi-${requestScope}-${contextRevision}-`)) return;
    const catalogue = controls.aircraftCommandCatalogue;
    if (message.currentProfileKey != null && (message.currentProfileKey !== catalogue.profileKey
      || message.currentProfileRevision !== catalogue.profileRevision)) return;
    if (Array.isArray(message.stands) || Array.isArray(message.standOptions)) {
      if (message.ok === false || !standsRequest || message.requestId !== standsRequest.requestId || airportCode() !== standsRequest.icao) return;
      stands.value = Array.isArray(message.standOptions)
        ? message.standOptions : message.stands.map(label => ({ label, typeLabel: '' }));
      return;
    }
    const matchesPending = pendingId != null && message.requestId === pendingId;
    const replyOperation = matchesPending ? pending.value : null;
    // A completed/cancelled preview cannot restore a route after a later edit.
    if (message.preview && !matchesPending) return;
    if (matchesPending) { pending.value = ''; pendingId = null; }
    // A failed stand lookup (unknown ICAO while typing) is not a session error.
    if (message.ok === false) {
      if (matchesPending && replyOperation === 'preview') routeError.value = message.error || 'Taxi route unavailable.';
      else if (message.requestId == null || matchesPending || pendingId == null && !message.requestId?.startsWith?.('autotaxi-')) error.value = message.error || 'Taxi assistant request failed.';
    }
    else {
      statusClock.value = performance.now(); lastStatusAt.value = statusClock.value;
      // Geometry may change within the same profile (another Generic aircraft,
      // a livery/configuration change or a simulator reconnect). A locally held
      // preview is only valid while the backend retains its original scene.
      if (message.sceneKey == null || message.sceneKey !== state.value.sceneKey) preview.value = null;
      const becameControlling = message.active && !message.handedOver && !controlling.value;
      state.value = message;
      if (message.active && !message.handedOver) open.value = true;
      if (becameControlling) automationOpen.value = true;
      if (message.preview) { preview.value = message.preview; hiddenSceneKey.value = null; }
      if (message.scene) scene.value = message.scene;
      else if (message.sceneKey !== scene.value?.key) scene.value = null;
    }
  });
  closeCleanup = subscribeWsClose(() => {
    const wasControlling = controlling.value || pending.value === 'start';
    connectionOpen = false; contextRevision += 1;
    lastStatusAt.value = null; hiddenSceneKey.value = null;
    syncDesktopActivity(false);
    clearStands();
    preview.value = null; scene.value = null;
    state.value = { ...state.value, canStart: false, canGuide: false, route: null, sceneKey: null, aircraft: null };
    pending.value = ''; pendingId = null;
    error.value = wasControlling
      ? 'Connection lost. Autotaxi will stop when its control heartbeat expires; take control in the cockpit.'
      : 'Connection lost. Reconnect and show the route again to resume taxi guidance.';
  });
  openCleanup = subscribeWsOpen(() => {
    connectionOpen = true; contextRevision += 1;
    lastStatusAt.value = null; hiddenSceneKey.value = null;
    preview.value = null; scene.value = null; pending.value = ''; pendingId = null; error.value = ''; routeError.value = '';
    state.value = { ...state.value, canStart: false, canGuide: false, route: null, sceneKey: null, aircraft: null };
    syncDesktopActivity(needsHeartbeat.value);
    send('status'); loadStands();
  });
  send('status'); loadStands();
  // 4 Hz while a diagram is showing so the aircraft marker moves smoothly; 1 Hz otherwise.
  timer = setInterval(() => {
    statusClock.value = performance.now();
    if (route.value || state.value.active || ++ticks % 4 === 0) send('status');
  }, 250);
});
onBeforeUnmount(() => {
  if (controlling.value || ['start', 'preview'].includes(pending.value)) send('stop');
  syncDesktopActivity(false);
  clearInterval(timer); clearStands(); cleanup?.(); closeCleanup?.(); openCleanup?.();
  if (frameId) cancelAnimationFrame(frameId);
});
</script>

<template>
  <details class="ff-card autotaxi overflow-hidden" data-aircraft-autotaxi-section :open="open" @toggle="open = $event.target.open">
    <summary class="autotaxi__summary flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:content-none">
      <span class="flex flex-wrap items-center gap-2">
        <h3 class="font-semibold text-fg">Taxi assistant</h3>
        <span class="text-xs text-muted-fg">Experimental · MSFS 2024</span>
        <span v-if="state.active || pushbackActive" class="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">{{ pushbackActive ? 'Pushback' : state.status }}</span>
      </span>
      <span class="autotaxi__chevron shrink-0 text-muted-fg" aria-hidden="true">▾</span>
    </summary>
    <div class="space-y-3 border-t border-surface-200 p-4">
    <p class="text-sm text-muted-fg">{{ mode === 'stand' ? 'Choose a stand, then follow the taxi ribbon.' : departure.data?.pushbackPreview.phase === 'complete' ? 'Follow the ribbon to the runway holding point.' : 'Preview your pushback, then follow the ribbon to the runway.' }}</p>
    <div class="taxi-assistant__workspace" :class="{ 'taxi-assistant__workspace--route': route }">
    <div class="space-y-3">
    <details ref="destinationForm" class="rounded-lg border border-border p-3" data-taxi-destination :open="destinationOpen" @toggle="destinationOpen = $event.target.open">
      <summary class="min-h-11 cursor-pointer py-3 text-sm font-semibold text-fg">{{ icao.trim() && destination ? `${icao.trim().toUpperCase()} · ${mode === 'stand' ? destination : 'Runway ' + destination.toUpperCase()}` : 'Destination' }}</summary>
    <div class="space-y-3 pt-2">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label class="block text-sm text-fg">Airport ICAO
        <input v-model="icao" :disabled="isBusy" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="YMML" class="ff-input mt-1 w-full min-h-[48px] uppercase" />
      </label>
      <label v-if="mode === 'runway'" class="block text-sm text-fg">Hold short of runway
        <input v-model="runway" :disabled="isBusy" maxlength="3" autocomplete="off" autocapitalize="characters" placeholder="16" class="ff-input mt-1 w-full min-h-[48px] uppercase" />
      </label>
      <label v-else class="block text-sm text-fg">Taxi to stand
        <input v-model="stand" :disabled="isBusy" maxlength="16" autocomplete="off" autocapitalize="characters" placeholder="D12" list="autotaxi-stands" :aria-describedby="selectedStandType ? 'autotaxi-stand-type' : undefined" class="ff-input mt-1 w-full min-h-[48px] uppercase" />
        <datalist id="autotaxi-stands"><option v-for="option in stands" :key="option.label" :value="option.label" :label="option.typeLabel ? `${option.label} — ${option.typeLabel}` : option.label" /></datalist>
        <span v-if="selectedStandType" id="autotaxi-stand-type" class="mt-1 block text-xs text-muted-fg">{{ selectedStandType }}</span>
      </label>
    </div>
    <fieldset class="flex flex-wrap gap-2" :disabled="isBusy">
      <legend class="sr-only">Destination</legend>
      <label v-for="option in [['runway', 'Depart: hold short'], ['stand', 'Arrive: to stand']]" :key="option[0]"
        class="autotaxi__mode inline-flex min-h-[48px] cursor-pointer items-center rounded-lg border px-4 text-sm font-semibold"
        :class="mode === option[0] ? 'border-primary bg-primary/15 text-fg' : 'border-surface-200 text-muted-fg'">
        <input v-model="mode" type="radio" name="autotaxi-mode" :value="option[0]" class="sr-only" />{{ option[1] }}
      </label>
    </fieldset>
    </div>
    </details>
    <PushbackControls v-if="mode === 'runway'" :icao="icao" :runway="runway" :disabled="isBusy && !pushbackActive"
      :allow-preview="!controlling && pending !== 'start'" :primary="Boolean(showPushback)"
      @active="pushbackActivity" @preview="receiveDeparture" @complete="send('preview')" />
    <div class="flex flex-wrap gap-2">
      <button type="button" data-taxi-show-route class="min-h-[48px] disabled:opacity-50" :class="showPushback ? 'ff-button-secondary' : 'ff-button-primary'" :disabled="!canPlan" @click="send('preview')">{{ pending === 'preview' ? 'Finding route…' : manualRoute || (departure.data?.pushbackPreview.phase === 'complete') ? 'Refresh route' : 'Show route' }}</button>
      <button v-if="preview && !state.active" type="button" class="ff-button-secondary min-h-[48px]" @click="preview = null; departureView = true">{{ departure.data ? 'Back to pushback' : 'Hide route' }}</button>
      <div v-if="state.active || automationBusy" class="flex flex-wrap gap-2">
        <button type="button" data-taxi-stop class="ff-button-secondary min-h-[48px] disabled:opacity-50" :disabled="!controlling && !pending" @click="send('stop')">{{ pending === 'preview' ? 'Cancel' : 'Stop' }}</button>
        <button type="button" data-taxi-release class="ff-button-secondary min-h-[48px] disabled:opacity-50" :disabled="pending === 'release'" @click="send('release')">{{ state.handedOver ? 'Clear' : 'Release controls' }}</button>
      </div>
    </div>
    <p v-if="guidanceUnavailable && !isBusy" class="text-sm text-muted-fg">{{ guidanceUnavailable }}</p>
    </div>
    <figure v-if="route && view" class="space-y-2 text-sm text-fg">
      <fieldset class="grid gap-2 max-w-sm" :class="departure.data ? 'grid-cols-3' : 'grid-cols-2'">
        <legend class="sr-only">Map view</legend>
        <label v-if="departure.data" class="autotaxi__mode inline-flex min-h-[48px] cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-xs font-semibold"
          :class="showPushback ? 'border-primary bg-primary/15 text-fg' : 'border-surface-200 text-muted-fg'">
          <input type="radio" name="autotaxi-view" value="pushback" :checked="!!showPushback" class="sr-only" @change="departureView = true" />Pushback
        </label>
        <label v-for="option in [['3d', 'Route ribbon'], ['2d', '2D map']]" :key="option[0]"
          class="autotaxi__mode inline-flex min-h-[48px] cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-xs font-semibold"
          :class="!showPushback && viewMode === option[0] ? 'border-primary bg-primary/15 text-fg' : 'border-surface-200 text-muted-fg'">
          <input type="radio" name="autotaxi-view" :value="option[0]" :checked="!showPushback && viewMode === option[0]" class="sr-only" @change="departureView = false; viewMode = option[0]" />{{ option[1] }}
        </label>
      </fieldset>
      <div class="taxi-map" :data-taxi-view="showPushback ? 'pushback' : chase ? '3d' : '2d'">
        <TaxiPushbackMap v-if="showPushback" :data="departure.data" :fresh="departure.fresh" />
        <svg v-else :viewBox="`0 0 ${VIEW.w} ${VIEW.h}`" class="w-full" role="img" :aria-label="`Taxi ${chase ? 'view from behind the aircraft' : 'map, ' + (aircraft && headingUp ? 'heading up' : 'north up')}. Blue line is the planned route to ${route.kind === 'stand' ? route.label : 'the red hold-short bar before runway ' + route.runway}.`">
          <defs>
            <radialGradient id="taxi-ground" cx="50%" cy="70%" r="80%">
              <stop offset="0" stop-color="#151b24" /><stop offset="1" stop-color="#090c11" />
            </radialGradient>
            <linearGradient id="taxi-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#070a0f" /><stop offset="1" stop-color="#11161e" />
            </linearGradient>
            <linearGradient id="taxi-ground-3d" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#1a212b" /><stop offset="1" stop-color="#0c1016" />
            </linearGradient>
            <linearGradient id="taxi-fog" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#1a212b" /><stop offset="1" stop-color="#1a212b" stop-opacity="0" />
            </linearGradient>
            <filter id="taxi-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5" /></filter>
          </defs>
          <rect width="100%" height="100%" fill="url(#taxi-ground)" />
          <template v-if="chase">
            <!-- Sky, ground, then the flat scenery in perspective; distance fades into the horizon. -->
            <rect width="100%" :height="chaseCamera.horizonY" fill="url(#taxi-sky)" />
            <rect :y="chaseCamera.horizonY" width="100%" :height="VIEW.h - chaseCamera.horizonY" fill="url(#taxi-ground-3d)" />
            <!-- Edge lines go under the slabs so crossing pavement covers them at junctions -->
            <path :d="chase.edges.taxi" fill="none" stroke="#8593a3" stroke-width="0.8" opacity="0.55" />
            <path :d="chase.edges.runway" fill="none" stroke="#8593a3" stroke-width="0.8" opacity="0.55" />
            <path :d="chase.pavement.taxi" fill="#222a35" />
            <path :d="chase.pavement.runway" fill="#1b2129" />
            <g v-for="rw in chase.runways" :key="rw.id">
              <path :d="rw.slab" fill="#12171e" stroke="#5a6879" stroke-width="1" />
              <path :d="rw.dashes" fill="#7a8796" />
              <text v-for="(l, i) in rw.labels" :key="i" :x="l.x" :y="l.y" fill="#8a97a6" :font-size="l.size" font-weight="600" text-anchor="middle" dy="0.35em">{{ l.text }}</text>
            </g>
            <!-- Painted taxiway centrelines are yellow -->
            <path :d="chase.centrelines.taxi" fill="none" stroke="#c9b24a" stroke-width="0.8" opacity="0.5" />
            <path :d="chase.centrelines.runway" fill="none" stroke="#2f3945" stroke-width="0.7" opacity="0.55" />
            <g v-for="(st, i) in chase.stands" :key="`s${i}`">
              <path :d="st.d" fill="#1a2230" stroke="#33404f" stroke-width="1" />
              <text v-if="st.label" :x="st.label.x" :y="st.label.y" fill="#6b7785" :font-size="st.label.size" text-anchor="middle" dy="0.35em">{{ st.label.text }}</text>
            </g>
            <path v-if="chase.destinationStand" :d="chase.destinationStand" fill="none" stroke="#ff5f5f" stroke-width="2.5" />
            <path :d="chase.route.done" fill="#2a4f8a" opacity="0.5" />
            <path :d="chase.route.glow" fill="#3b8bff" opacity="0.28" filter="url(#taxi-glow)" />
            <path :d="chase.route.ahead" fill="#5aa2ff" />
            <template v-if="chase.hold">
              <path :d="chase.hold.dash" fill="#5aa2ff" opacity="0.7" />
              <path :d="chase.hold.bar" fill="#ff5f5f" />
            </template>
            <path :d="chase.stop" fill="#0b0f14" stroke="#e8eef5" stroke-width="2" />
            <rect :y="chaseCamera.horizonY - 1" width="100%" height="90" fill="url(#taxi-fog)" />
            <!-- Aircraft: shadow and halo on the ground, then the shaded model -->
            <path :d="sprite.halo" fill="#5aa2ff" opacity="0.09" />
            <path :d="sprite.shadow" fill="#000" opacity="0.3" filter="url(#taxi-glow)" />
            <path v-for="(face, i) in sprite.faces" :key="`f${i}`" :d="face.d" :fill="face.fill" stroke="#0b0f14" stroke-width="0.5" stroke-linejoin="round" />
          </template>
          <g v-else class="world" :style="{ transform: view.transform }">
            <!-- Pavement -->
            <g stroke-linecap="round" stroke-linejoin="round">
              <line v-for="(l, i) in (diagramScene?.links || [])" :key="`p${i}`" :x1="l.a.x" :y1="-l.a.z" :x2="l.b.x" :y2="-l.b.z" :stroke="l.runway ? '#1b2129' : '#222a35'" :stroke-width="l.widthM" />
            </g>
            <g v-for="rw in (diagramScene?.runways || [])" :key="rw.id">
              <polygon :points="line(rw.corners)" fill="#12171e" stroke="#2c3642" :stroke-width="px(1)" />
              <line :x1="rw.ends[0].x" :y1="-rw.ends[0].z" :x2="rw.ends[1].x" :y2="-rw.ends[1].z" stroke="#3a4552" :stroke-width="px(1)" stroke-dasharray="30 20" />
              <text v-for="(end, i) in rw.ends" :key="i" :x="end.x" :y="-end.z" fill="#7a8796" :font-size="px(11)" font-weight="600" text-anchor="middle" :transform="`rotate(${view.rotation} ${end.x} ${-end.z})`" dy="0.35em">{{ i ? rw.reciprocal : rw.id }}</text>
            </g>
            <g stroke-linecap="round" stroke-linejoin="round" opacity="0.55">
              <line v-for="(l, i) in (diagramScene?.links || [])" :key="`c${i}`" :x1="l.a.x" :y1="-l.a.z" :x2="l.b.x" :y2="-l.b.z" :stroke="l.runway ? '#2f3945' : '#3d4a59'" :stroke-width="px(0.7)" />
            </g>
            <!-- Stands near the route; the destination is ringed -->
            <g v-for="(st, i) in (diagramScene?.stands || [])" :key="`s${i}`">
              <circle :cx="st.x" :cy="-st.z" :r="st.radiusM" fill="#1a2230" stroke="#33404f" :stroke-width="px(1)" />
              <text :x="st.x" :y="-st.z" fill="#6b7785" :font-size="px(9)" text-anchor="middle" dy="0.35em" :transform="`rotate(${view.rotation} ${st.x} ${-st.z})`">{{ st.label }}</text>
            </g>
            <circle v-if="route.stand" :cx="route.stand.x" :cy="-route.stand.z" :r="route.stand.radiusM" fill="none" stroke="#ff5f5f" :stroke-width="px(2.5)" />
            <!-- Planned route -->
            <g fill="none" stroke-linecap="round" stroke-linejoin="round">
              <polyline v-if="progress.done.length" :points="line(progress.done)" stroke="#2a4f8a" :stroke-width="px(7)" opacity="0.5" />
              <polyline :points="line(progress.ahead)" stroke="#3b8bff" :stroke-width="px(10)" opacity="0.28" filter="url(#taxi-glow)" />
              <polyline :points="line(progress.ahead)" stroke="#5aa2ff" :stroke-width="px(3)" />
              <polyline v-if="route.kind !== 'stand'" :points="holdBar.dash" stroke="#5aa2ff" :stroke-width="px(1.5)" stroke-dasharray="4 4" opacity="0.7" />
              <line v-if="route.kind !== 'stand'" :x1="holdBar.ax" :y1="holdBar.ay" :x2="holdBar.bx" :y2="holdBar.by" stroke="#ff5f5f" :stroke-width="px(3.5)" />
            </g>
            <circle :cx="route.points.at(-1).x" :cy="-route.points.at(-1).z" :r="px(4)" fill="#0b0f14" stroke="#e8eef5" :stroke-width="px(2)" />
            <!-- Aircraft -->
            <g v-if="aircraft" :transform="`translate(${aircraft.x} ${-aircraft.z}) rotate(${aircraft.headingDeg})`">
              <circle r="24" fill="#5aa2ff" opacity="0.12" />
              <path d="M0,-19 L2.2,-14 L2.2,-3 L17.5,6 L17.5,9 L2.2,5 L2.2,13 L7,17 L7,19 L0,17.4 L-7,19 L-7,17 L-2.2,13 L-2.2,5 L-17.5,9 L-17.5,6 L-2.2,-3 L-2.2,-14 Z" fill="#eef3f8" stroke="#0b0f14" :stroke-width="px(0.8)" />
            </g>
          </g>
          <!-- HUD -->
          <g font-family="system-ui, sans-serif" fill="#e8eef5">
            <text v-if="aircraft" x="14" :y="VIEW.h - 16" font-size="26" font-weight="700">{{ aircraft.speedKts.toFixed(1) }}<tspan font-size="12" font-weight="500" fill="#8a97a6"> kt</tspan></text>
            <text v-if="Number.isFinite(remainingM)" :x="VIEW.w - 14" :y="VIEW.h - 16" font-size="16" font-weight="600" text-anchor="end">{{ Math.round(remainingM) }} m<tspan font-size="11" font-weight="500" fill="#8a97a6"> · {{ route.kind === 'stand' ? route.label : 'RWY ' + route.runway }}</tspan></text>
            <text v-if="state.active && state.commanded" x="14" y="24" font-size="11" fill="#8a97a6">thr {{ Math.round(state.commanded.throttle * 100) }}% · brk {{ Math.round(state.commanded.brake * 100) }}% · {{ state.commanded.steering < -0.02 ? '◀' : state.commanded.steering > 0.02 ? '▶' : '▲' }} {{ Math.round(Math.abs(state.commanded.steering) * 100) }}%</text>
            <text v-else-if="state.status" x="14" y="24" font-size="11" fill="#8a97a6">{{ controlling ? state.status : 'Manual taxi · route guidance' }}</text>
          </g>
          <g class="compass" :class="{ 'compass--live': chase }" :role="chase ? null : 'button'" :tabindex="chase ? null : 0" :aria-label="chase ? 'Compass' : headingUp ? 'Switch to north up' : 'Switch to heading up'" @click="toggleHeadingUp" @keydown.enter="toggleHeadingUp">
            <circle :cx="VIEW.w - 24" cy="24" r="16" fill="#0b0f14" stroke="#2c3642" />
            <g :style="{ transform: `translate(${VIEW.w - 24}px, 24px) rotate(${-compassRotation}deg)` }">
              <path d="M0,-11 L4,3 L0,1 L-4,3 Z" fill="#ff5f5f" /><path d="M0,11 L4,-3 L0,-1 L-4,-3 Z" fill="#4a5563" />
              <text y="-13" font-size="8" fill="#8a97a6" text-anchor="middle" font-weight="700">N</text>
            </g>
          </g>
        </svg>
      </div>
      <figcaption>{{ showPushback ? pushbackCaption(departure.data, departure.fresh) : departureRoute ? `Taxi route after pushback to runway ${route.runway}. You control the aircraft.` : preview && !state.active ? `Follow the ribbon to ${preview.kind === 'stand' ? preview.label : 'the holding point before runway ' + preview.runway}. You control the aircraft.` : state.reason }}</figcaption>
      <p v-if="!showPushback && !aircraft" class="text-warning">Live position unavailable. The route is shown for reference until fresh ground data returns.</p>
      <p v-else-if="!showPushback && !futureTaxiRoute && offRoute" class="text-warning">You are away from the planned route. Check your position or choose Refresh route to find a new route.</p>
      <p v-else-if="!showPushback && !futureTaxiRoute && atDestination" class="font-semibold text-fg">{{ route.kind === 'stand' ? 'Stand reached. Check your parking position.' : 'Holding point reached. Stop before the runway and follow your clearance.' }}</p>
      <p v-if="(preview?.runwayTravelM ?? state.runwayTravelM) > 1" class="text-warning">Includes {{ Math.round(preview?.runwayTravelM ?? state.runwayTravelM) }} m along an intervening runway.</p>
      <p v-if="(preview?.joinM ?? state.joinM) >= 1" class="text-warning">The first {{ Math.round(preview?.joinM ?? state.joinM) }} m cross open ground to reach the centreline. Check the map for obstacles.</p>
      <p v-if="state.active && state.probing">Creeping to check which way the steering axis responds.</p>
      <p v-if="state.active && state.steeringReversed" class="text-warning">The steering axis responded reversed; steering commands are mirrored to match.</p>
    </figure>
    </div>
    <p class="text-xs text-muted-fg">Routes use simulator scenery and may cross runways. Follow your ATC clearance and check traffic, obstacles and aircraft clearance.</p>
    <div role="status" aria-live="polite" class="text-sm text-fg">
      <p v-if="!route && state.active">{{ state.reason }}</p>
      <p v-if="route && aircraft && Number.isFinite(state.remainingM)">{{ Math.round(state.remainingM) }} m to stop · {{ state.status }}</p>
      <p v-if="state.active && aircraft && Number.isFinite(state.observedSpeedKts)">Observed speed: {{ state.observedSpeedKts.toFixed(1) }} kt</p>
      <p v-if="state.active && state.commanded">Commanded: thrust {{ Math.round(state.commanded.throttle * 100) }}% · brakes {{ Math.round(state.commanded.brake * 100) }}% · steering {{ state.commanded.steering < 0 ? 'left' : 'right' }} {{ Math.round(Math.abs(state.commanded.steering) * 100) }}%</p>
      <p v-if="state.runwayTravelM > 1" class="text-warning">This route includes {{ Math.round(state.runwayTravelM) }} m along a runway.</p>
    </div>
    <p v-if="visibleError" role="alert" class="text-sm text-danger">{{ visibleError }}</p>
    <details class="rounded-lg border border-border px-3 text-sm" data-taxi-automation :open="automationOpen" @toggle="automationOpen = $event.target.open">
      <summary class="min-h-11 cursor-pointer py-3 font-semibold text-fg">Autotaxi <span class="font-normal text-muted-fg">· Optional, experimental</span></summary>
      <div class="space-y-3 pb-3">
        <p class="text-muted-fg">Let FlightFabric steer, control thrust and brake along a freshly checked route. Stay ready to take over.</p>
        <button type="button" data-taxi-start class="ff-button-secondary min-h-[48px] disabled:opacity-50" :disabled="!canStart" @click="send('start')">{{ pending === 'start' ? 'Starting Autotaxi…' : 'Start Autotaxi' }}</button>
        <p v-if="unavailable && !isBusy" class="text-muted-fg">{{ unavailable }}</p>
        <div v-if="support" class="text-muted-fg" data-autotaxi-support>
          <p class="font-semibold text-fg">{{ support.aircraftLabel }}</p>
          <p>{{ support.qualificationStatus === 'candidate' ? 'Automatic control is experimental for this aircraft. Live acceptance is still pending.' : support.reason || 'Autotaxi is not available for this aircraft.' }}</p>
        </div>
        <details class="text-muted-fg" data-autotaxi-setup>
          <summary class="min-h-11 cursor-pointer py-3 font-semibold text-fg">Autotaxi setup &amp; requirements</summary>
          <div class="space-y-2 pb-3">
            <p>Start near a taxiway, facing the taxi direction, with the required engines running, parking brake released and automatic thrust control off. These requirements apply only to Autotaxi.</p>
            <ul v-if="setupInstructions.length" class="list-disc space-y-1 pl-5" aria-label="Aircraft taxi setup">
              <li v-for="instruction in setupInstructions" :key="instruction">{{ instruction }}</li>
            </ul>
            <p>Keep hardware throttle, brake and steering axes from overriding the taxi commands.</p>
            <p>The desktop app can stay behind MSFS or be minimized. Keep this Aircraft page open. Closing the page or losing its connection stops Autotaxi; reconnecting does not resume taxiing.</p>
            <p>Stop brings the aircraft to rest, sets the parking brake and hands steering and brakes back to you. Release controls ends the session with thrust at idle.</p>
          </div>
        </details>
      </div>
    </details>
    </div>
  </details>
</template>

<style scoped>
/* Preserve 48px targets over the shell's 44px mobile compatibility rule. */
button { min-height: 3rem !important; }
.autotaxi__chevron { transition: transform 0.15s ease; }
details[open] > summary .autotaxi__chevron { transform: rotate(180deg); }
.autotaxi__mode:focus-within { outline: 2px solid rgb(var(--color-primary)); outline-offset: 2px; }
.taxi-assistant__workspace { display: grid; gap: 1rem; }
.taxi-assistant__workspace > * { min-width: 0; }
@media (min-width: 900px) {
  .taxi-assistant__workspace--route { grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr); gap: 1.5rem; }
}
.taxi-map { border-radius: 0.75rem; overflow: hidden; background: #090c11; border: 1px solid rgb(var(--color-surface-200) / 0.6); max-width: 40rem; }
.taxi-map { --taxi-ground: rgb(var(--panel)); --taxi-pavement: rgb(var(--muted)); --taxi-pushback: rgb(var(--warning)); --taxi-route: rgb(var(--selection)); --taxi-aircraft: rgb(var(--foreground)); --taxi-success: rgb(var(--success)); }
@media (prefers-reduced-motion: reduce) { .taxi-map { --taxi-motion-duration: 0ms; } }
.taxi-map svg { display: block; aspect-ratio: 6 / 5; }
/* Status arrives at 4 Hz; ease the world between samples so the marker glides. */
.world, .compass g { transition: transform 0.25s linear; transform-origin: 0 0; }
.compass { cursor: pointer; }
/* In 3D the compass is an indicator, not the north-up toggle. */
.compass--live { cursor: default; }
</style>
