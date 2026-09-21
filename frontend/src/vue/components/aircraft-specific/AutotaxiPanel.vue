<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { sendWs } from '../../../../app-shared.js';
import { subscribeWsMessage, subscribeWsClose, subscribeWsOpen } from '../../../app/runtime-signals.js';
import { useAircraftControlsStore } from '../../stores/aircraft-controls.js';
import { aircraftSprite, createChaseCamera, projectTaxiScene, readTaxiView, smoothRoute, writeTaxiView } from '../../../aircraft/autotaxi-chase-view.js';

const controls = useAircraftControlsStore();
const icao = ref('');
const runway = ref('');
// Destination: hold short of a runway before departure, or a named stand after landing.
const mode = ref('runway');
const stand = ref('');
const stands = ref([]);
const selectedStandType = computed(() => stands.value.find(option => option.label.toUpperCase() === stand.value.trim().toUpperCase())?.typeLabel);
const state = ref({ status: 'idle', active: false, canStart: false, reason: 'Waiting for autotaxi status.' });
const error = ref('');
const pending = ref('');
const preview = ref(null);
const scene = ref(null);
const headingUp = ref(true);
// Collapsed by default; an active session always shows its controls and map.
const open = ref(false);
// After a stop the session sets the parking brake and hands the axes back; it
// then only holds the map and reason until Release or a new plan clears it.
const controlling = computed(() => state.value.active && !state.value.handedOver);
const isBusy = computed(() => controlling.value || state.value.status === 'planning' || ['start', 'preview'].includes(pending.value));
const unavailable = computed(() => !controls.availability.enabled ? controls.availability.reason : state.value.unavailableReason);
const support = computed(() => state.value.support || null);
const setupInstructions = computed(() => support.value?.setupInstructions || []);
const destination = computed(() => (mode.value === 'stand' ? stand.value : runway.value).trim());
const canPlan = computed(() => !isBusy.value && !pending.value && state.value.canStart && controls.availability.enabled && icao.value.trim() && destination.value);
watch([icao, runway, stand, mode], () => { preview.value = null; });
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
const route = computed(() => state.value.route || preview.value);
const aircraft = computed(() => state.value.aircraft || null);
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
  return projectTaxiScene(chaseCamera, { scene: scene.value, route: route.value, aircraft: shown.value, done, ahead });
});
// The compass follows the continuous 2D heading in both views, so switching never spins it a full turn.
const compassRotation = computed(() => (chase.value ? heading.value : view.value.rotation));
function toggleHeadingUp() { if (!chase.value) headingUp.value = !headingUp.value; }
// Split the route at the aircraft's projection so the travelled part dims.
function splitRoute(points, a) {
  if (!a) return { done: [], ahead: points };
  let best = { d: Infinity, i: 0, p: points[0] };
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    const l2 = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((a.x - p.x) * (q.x - p.x) + (a.z - p.z) * (q.z - p.z)) / l2)) : 0;
    const point = { x: p.x + t * (q.x - p.x), z: p.z + t * (q.z - p.z) };
    const d = Math.hypot(a.x - point.x, a.z - point.z);
    if (d < best.d) best = { d, i, p: point };
  }
  if (best.d > 25) return { done: [], ahead: points };
  return { done: [...points.slice(0, best.i + 1), best.p], ahead: [best.p, ...points.slice(best.i + 1)] };
}
const progress = computed(() => (route.value ? splitRoute(route.value.points, aircraft.value) : null));
const holdBar = computed(() => {
  const r = route.value;
  if (!r) return null;
  const from = r.points.at(-1), to = r.holdShort;
  const len = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  const nx = -(to.z - from.z) / len * 14, nz = (to.x - from.x) / len * 14;
  return { ax: to.x + nx, ay: -(to.z + nz), bx: to.x - nx, by: -(to.z - nz), dash: line([from, to]) };
});
const px = n => (view.value ? n / view.value.scale : n);
const remainingM = computed(() => Number.isFinite(state.value.remainingM) ? state.value.remainingM : route.value?.lengthM);

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
const needsHeartbeat = computed(() => controlling.value || ['start', 'preview'].includes(pending.value));
watch(needsHeartbeat, active => syncDesktopActivity(active && connectionOpen), { flush: 'sync' });
watch([() => controls.aircraftCommandCatalogue.profileKey, () => controls.aircraftCommandCatalogue.profileRevision], () => {
  contextRevision += 1;
  state.value = { status: 'idle', active: false, canStart: false, reason: 'Checking this aircraft for Autotaxi.' };
  preview.value = null; scene.value = null; error.value = ''; pending.value = ''; pendingId = null;
  clearStands();
  send('status'); loadStands();
}, { flush: 'sync' });
function send(operation) {
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
    if (matchesPending) { pending.value = ''; pendingId = null; }
    // A failed stand lookup (unknown ICAO while typing) is not a session error.
    if (message.ok === false) { if (message.requestId == null || matchesPending || pendingId == null && !message.requestId?.startsWith?.('autotaxi-')) error.value = message.error || 'Autotaxi request failed.'; }
    else {
      // Geometry may change within the same profile (another Generic aircraft,
      // a livery/configuration change or a simulator reconnect). A locally held
      // preview is only valid while the backend retains its original scene.
      if (message.sceneKey == null || message.sceneKey !== state.value.sceneKey) preview.value = null;
      state.value = message;
      if (message.active && !message.handedOver) open.value = true;
      if (message.preview) preview.value = message.preview;
      if (message.scene) scene.value = message.scene;
      else if (message.sceneKey !== scene.value?.key) scene.value = null;
    }
  });
  closeCleanup = subscribeWsClose(() => {
    connectionOpen = false; contextRevision += 1;
    syncDesktopActivity(false);
    clearStands();
    preview.value = null; scene.value = null;
    state.value = { ...state.value, canStart: false, route: null, sceneKey: null, aircraft: null };
    pending.value = ''; pendingId = null;
    error.value = 'Connection lost. Autotaxi will stop when its control heartbeat expires; take control in the cockpit.';
  });
  openCleanup = subscribeWsOpen(() => {
    connectionOpen = true; contextRevision += 1;
    preview.value = null; scene.value = null; pending.value = ''; pendingId = null; error.value = '';
    state.value = { ...state.value, canStart: false, route: null, sceneKey: null, aircraft: null };
    syncDesktopActivity(needsHeartbeat.value);
    send('status'); loadStands();
  });
  send('status');
  // 4 Hz while a diagram is showing so the aircraft marker moves smoothly; 1 Hz otherwise.
  timer = setInterval(() => { if (route.value || state.value.active || ++ticks % 4 === 0) send('status'); }, 250);
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
        <h3 class="font-semibold text-fg">Autotaxi</h3>
        <span class="text-xs text-muted-fg">Experimental · MSFS 2024</span>
        <span v-if="state.active" class="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">{{ state.status }}</span>
      </span>
      <span class="autotaxi__chevron shrink-0 text-muted-fg" aria-hidden="true">▾</span>
    </summary>
    <div class="space-y-3 border-t border-surface-200 p-4">
    <p class="text-sm text-muted-fg">Choose a runway holding point or a stand. Routes can cross runways; traffic and ATC clearances are not checked.</p>
    <div v-if="support" class="rounded-lg border border-border bg-panel p-3 text-sm" data-autotaxi-support>
      <p class="font-semibold text-fg">{{ support.aircraftLabel }}</p>
      <p class="mt-1 text-muted-fg">{{ support.qualificationStatus === 'candidate' ? 'Aircraft integration is ready for simulator validation. Live acceptance is still pending.' : support.reason || 'Autotaxi is not available for this aircraft.' }}</p>
    </div>
    <details class="rounded-lg border border-border px-3 text-sm text-muted-fg" data-autotaxi-setup>
      <summary class="min-h-11 cursor-pointer py-3 font-semibold text-fg">Aircraft setup &amp; requirements</summary>
      <div class="space-y-2 pb-3">
        <p>Start on the ground, near a taxiway and facing the taxi direction, with the required engines running, parking brake released and automatic thrust control off.</p>
        <ul v-if="setupInstructions.length" class="list-disc space-y-1 pl-5" aria-label="Aircraft taxi setup">
          <li v-for="instruction in setupInstructions" :key="instruction">{{ instruction }}</li>
        </ul>
        <p>Keep hardware throttle, brake and steering axes from overriding the taxi commands.</p>
        <p>The desktop app can stay behind MSFS or be minimized. Keep this aircraft page open. Closing the page or losing its connection stops Autotaxi; reconnecting does not resume taxiing.</p>
      </div>
    </details>
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
    <div class="flex flex-wrap gap-2">
      <button type="button" class="ff-button-secondary min-h-[48px] disabled:opacity-50" :disabled="!canPlan" @click="send('preview')">{{ pending === 'preview' ? 'Checking route…' : 'Check route' }}</button>
      <button type="button" class="ff-button-primary min-h-[48px] disabled:opacity-50" :disabled="!canPlan" @click="send('start')">{{ pending === 'start' ? 'Planning taxi…' : 'Start taxi' }}</button>
      <button type="button" class="ff-button-secondary min-h-[48px] disabled:opacity-50" :disabled="!controlling && !pending" @click="send('stop')">Stop</button>
      <button type="button" class="ff-button-secondary min-h-[48px] disabled:opacity-50" :disabled="!(state.active || isBusy) || pending === 'release'" @click="send('release')">{{ state.handedOver ? 'Clear' : 'Release controls' }}</button>
    </div>
    <p v-if="unavailable && !isBusy" class="text-sm text-muted-fg">{{ unavailable }}</p>
    <figure v-if="route && view" class="space-y-2 text-sm text-fg">
      <fieldset class="flex flex-wrap gap-2">
        <legend class="sr-only">Map view</legend>
        <label v-for="option in [['2d', '2D map'], ['3d', '3D view']]" :key="option[0]"
          class="autotaxi__mode inline-flex min-h-[48px] cursor-pointer items-center rounded-lg border px-4 text-sm font-semibold"
          :class="viewMode === option[0] ? 'border-primary bg-primary/15 text-fg' : 'border-surface-200 text-muted-fg'">
          <input v-model="viewMode" type="radio" name="autotaxi-view" :value="option[0]" class="sr-only" />{{ option[1] }}
        </label>
      </fieldset>
      <div class="taxi-map" :data-taxi-view="chase ? '3d' : '2d'">
        <svg :viewBox="`0 0 ${VIEW.w} ${VIEW.h}`" class="w-full" role="img" :aria-label="`Taxi ${chase ? 'view from behind the aircraft' : 'map, ' + (aircraft && headingUp ? 'heading up' : 'north up')}. Blue line is the planned route to ${route.kind === 'stand' ? route.label : 'the red hold-short bar before runway ' + route.runway}.`">
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
              <line v-for="(l, i) in (scene?.links || [])" :key="`p${i}`" :x1="l.a.x" :y1="-l.a.z" :x2="l.b.x" :y2="-l.b.z" :stroke="l.runway ? '#1b2129' : '#222a35'" :stroke-width="l.widthM" />
            </g>
            <g v-for="rw in (scene?.runways || [])" :key="rw.id">
              <polygon :points="line(rw.corners)" fill="#12171e" stroke="#2c3642" :stroke-width="px(1)" />
              <line :x1="rw.ends[0].x" :y1="-rw.ends[0].z" :x2="rw.ends[1].x" :y2="-rw.ends[1].z" stroke="#3a4552" :stroke-width="px(1)" stroke-dasharray="30 20" />
              <text v-for="(end, i) in rw.ends" :key="i" :x="end.x" :y="-end.z" fill="#7a8796" :font-size="px(11)" font-weight="600" text-anchor="middle" :transform="`rotate(${view.rotation} ${end.x} ${-end.z})`" dy="0.35em">{{ i ? rw.reciprocal : rw.id }}</text>
            </g>
            <g stroke-linecap="round" stroke-linejoin="round" opacity="0.55">
              <line v-for="(l, i) in (scene?.links || [])" :key="`c${i}`" :x1="l.a.x" :y1="-l.a.z" :x2="l.b.x" :y2="-l.b.z" :stroke="l.runway ? '#2f3945' : '#3d4a59'" :stroke-width="px(0.7)" />
            </g>
            <!-- Stands near the route; the destination is ringed -->
            <g v-for="(st, i) in (scene?.stands || [])" :key="`s${i}`">
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
            <text v-if="Number.isFinite(remainingM)" :x="VIEW.w - 14" :y="VIEW.h - 16" font-size="16" font-weight="600" text-anchor="end">{{ Math.round(remainingM) }} m<tspan font-size="11" font-weight="500" fill="#8a97a6"> to stop · {{ route.kind === 'stand' ? route.label : 'RWY ' + route.runway }}</tspan></text>
            <text v-if="state.active && state.commanded" x="14" y="24" font-size="11" fill="#8a97a6">thr {{ Math.round(state.commanded.throttle * 100) }}% · brk {{ Math.round(state.commanded.brake * 100) }}% · {{ state.commanded.steering < -0.02 ? '◀' : state.commanded.steering > 0.02 ? '▶' : '▲' }} {{ Math.round(Math.abs(state.commanded.steering) * 100) }}%</text>
            <text v-else-if="state.status" x="14" y="24" font-size="11" fill="#8a97a6">{{ state.active ? state.status : 'route check' }}</text>
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
      <figcaption>{{ preview && !state.active ? `${Math.round(preview.lengthM)} m to ${preview.kind === 'stand' ? preview.label : 'stop before runway ' + preview.runway}. No controls sent; Start taxi checks the route again.` : state.reason }}</figcaption>
      <p v-if="(preview?.runwayTravelM ?? state.runwayTravelM) > 1" class="text-warning">Includes {{ Math.round(preview?.runwayTravelM ?? state.runwayTravelM) }} m along an intervening runway.</p>
      <p v-if="(preview?.joinM ?? state.joinM) >= 1" class="text-warning">The first {{ Math.round(preview?.joinM ?? state.joinM) }} m cross open ground to reach the centreline. Check the map for obstacles.</p>
      <p v-if="state.active && state.probing">Creeping to check which way the steering axis responds.</p>
      <p v-if="state.active && state.steeringReversed" class="text-warning">The steering axis responded reversed; steering commands are mirrored to match.</p>
    </figure>
    <div role="status" aria-live="polite" class="text-sm text-fg">
      <p v-if="!route">{{ state.reason }}</p>
      <p v-if="Number.isFinite(state.remainingM)">{{ Math.round(state.remainingM) }} m to stop · {{ state.status }}</p>
      <p v-if="state.active && Number.isFinite(state.observedSpeedKts)">Observed speed: {{ state.observedSpeedKts.toFixed(1) }} kt</p>
      <p v-if="state.active && state.commanded">Commanded: thrust {{ Math.round(state.commanded.throttle * 100) }}% · brakes {{ Math.round(state.commanded.brake * 100) }}% · steering {{ state.commanded.steering < 0 ? 'left' : 'right' }} {{ Math.round(Math.abs(state.commanded.steering) * 100) }}%</p>
      <p v-if="state.runwayTravelM > 1" class="text-warning">This route includes {{ Math.round(state.runwayTravelM) }} m along a runway.</p>
    </div>
    <p v-if="error || state.error" role="alert" class="text-sm text-danger">{{ error || state.error }}</p>
    <p class="text-xs text-muted-fg">Keep this Aircraft page open while taxiing. Stop brings the aircraft to rest, sets the parking brake and hands steering and brakes back to you. Release controls ends the session at any time with thrust at idle.</p>
    </div>
  </details>
</template>

<style scoped>
/* Preserve 48px targets over the shell's 44px mobile compatibility rule. */
button { min-height: 3rem !important; }
/* Experimental marker: a quiet hazard stripe along the top edge. */
.autotaxi__summary { position: relative; }
.autotaxi__summary::before {
  content: ''; position: absolute; inset: 0 0 auto 0; height: 5px; opacity: 0.55;
  background: repeating-linear-gradient(-45deg, rgb(var(--color-warning)) 0 10px, transparent 10px 20px);
}
.autotaxi__chevron { transition: transform 0.15s ease; }
details[open] .autotaxi__chevron { transform: rotate(180deg); }
.taxi-map { border-radius: 0.75rem; overflow: hidden; background: #090c11; border: 1px solid rgb(var(--color-surface-200) / 0.6); max-width: 30rem; }
.taxi-map svg { display: block; aspect-ratio: 6 / 5; }
/* Status arrives at 4 Hz; ease the world between samples so the marker glides. */
.world, .compass g { transition: transform 0.25s linear; transform-origin: 0 0; }
.compass { cursor: pointer; }
/* In 3D the compass is an indicator, not the north-up toggle. */
.compass--live { cursor: default; }
</style>
