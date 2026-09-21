<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { getWs, sendWs } from '../../../app-shared.js';
import { createCduController, cduKeyboardKey, fenixMcduUrl } from '../../aircraft/cdu-controller.js';
import { CDU_SKINS, normalizeCduSkin, persistCduSkin, readCduSkin } from '../../aircraft/cdu-skins.js';
import { subscribeWsMessage, subscribeWsClose, subscribeTelemetryReset } from '../../app/runtime-signals.js';
import { containDialogFocus } from '../../ui/dialog-focus.js';
import { matchesMedia } from '../../app/browser-environment.js';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);
const specific = useAircraftSpecificStore(), controls = useAircraftControlsStore();
const mounted = ref(false), panel = ref(null), keyboard = ref(false), help = ref(false);
// The keyboard toggle only listens for physical key events; a phone's soft
// keyboard never appears without a text field. Touch-only devices keep the
// toggle (an iPad with a Bluetooth keyboard still needs it) but the status
// line and the help say a physical keyboard is required.
const TOUCH_ONLY_QUERY = '(hover: none) and (pointer: coarse)';
const touchOnly = ref(false);
const screenElement = ref(null), screenFontSize = ref(16);
watch(screenElement, (element, _previous, onCleanup) => {
  if (!element) return;
  // Fit all 24 columns and 14 rows when the phone viewport changes height.
  const resize = () => { screenFontSize.value = Math.min(22, (element.clientWidth - 8) / 14.4, (element.clientHeight - 8) / 14 * .9); };
  const observer = new ResizeObserver(resize);
  observer.observe(element); resize();
  onCleanup(() => observer.disconnect());
});
const model = ref({ state: {}, error: '', pending: false, side: 'left' });
const skin = ref(readCduSkin());
function selectSkin(event) { skin.value = normalizeCduSkin(event.target.value); persistCduSkin(skin.value); }
const state = computed(() => model.value.state);
const functionColumns = computed(() => (state.value.functionKeys?.length || 0) > 15 ? 6 : 5);
const functionRows = computed(() => Math.max(1, Math.ceil((state.value.functionKeys?.length || 0) / functionColumns.value)));
const entryRows = computed(() => Math.max(1, Math.ceil((state.value.entryKeys?.length || 0) / 6)));
const annunciators = computed(() => state.value.screen?.powered ? [...(state.value.screen.annunciators || []), ...(state.value.screen.arrows || [])].join(' · ') : '');
// Keys stay enabled while one is in flight: the controller queues type-ahead, so a quick second tap is not lost.
const enabled = computed(() => controls.availability.enabled && state.value.screen?.powered);
const controller = createCduController({ send: sendWs,
  getProfile: () => ({ profileKey: specific.activeProfileKey, profileRevision: specific.activeProfileRevision }),
  getCanWrite: () => controls.availability.enabled, onChange: value => { model.value = value; } });
const availableKeys = computed(() => [...(state.value.entryKeys || []), ...(state.value.functionKeys || [])].map(key => key.id));
const externalUrl = computed(() => state.value.mode === 'external' ? fenixMcduUrl(getWs()?.url, window.location.href) : '');
const keyLabels = { DOT: '.', SLASH: '/', DIV: '/', SPACE: 'SP', PLUS_MINUS: '+/−', PLUSMINUS: '+/−',
  PREVPAGE: '←', NEXTPAGE: '→', UP: '↑', DOWN: '↓', FPLN: 'F-PLN', RAD: 'RAD NAV', FUEL: 'FUEL PRED', SEC: 'SEC F-PLN', MENU: 'MENU' };
const label = key => keyLabels[key.id] || key.label;
const screenText = computed(() => state.value.screen?.powered ? state.value.screen.rows.map(row => row.map(cell => cell.text).join('')).join('\n') : 'Display unavailable or unpowered');
const reason = computed(() => !controls.availability.enabled ? controls.availability.reason
  : !state.value.screen ? 'Waiting for aircraft display data.' : !state.value.screen.powered ? 'The aircraft display is unpowered.'
  : keyboard.value && touchOnly.value ? 'Keyboard on: needs a physical keyboard. Tap the keys below on a phone.' : '');
let timer, unsubscribe = [];
function refresh() { if (props.open && !document.hidden) controller.read(); }
function switchSide(event) { keyboard.value = false; controller.reset(event.target.value); refresh(); }
function restart() { keyboard.value = false; controller.reset(); if (props.open) refresh(); }
watch(() => [specific.activeProfileKey, specific.activeProfileRevision], restart);
watch(() => props.open, open => {
  clearInterval(timer); controller.reset(); keyboard.value = false; help.value = false;
  if (open) { refresh(); timer = setInterval(refresh, 500); nextTick(() => panel.value?.querySelector('[data-cdu-close]')?.focus()); }
});
watch(help, async open => {
  if (!open) return;
  await nextTick();
  panel.value?.querySelector('#cdu-help')?.scrollIntoView({ block: 'nearest' });
});
useBodyClass(() => props.open, 'ff-dialog-open');
useBodyClass(() => props.open, 'cdu-open');
useDocumentEvent('keydown', event => {
  if (!props.open || event.defaultPrevented) return;
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return; }
  containDialogFocus(event, panel.value);
  // The shared focus trap avoids scrolling the page. Here its last target may
  // be below the keypad viewport, so reveal it after wrapping keyboard focus.
  if (event.key === 'Tab' && event.defaultPrevented) {
    document.activeElement?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!keyboard.value || !panel.value?.contains(event.target) || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return;
  const key = cduKeyboardKey(event, availableKeys.value);
  if (key) { event.preventDefault(); if (enabled.value) controller.press(key); }
});
onMounted(() => {
  mounted.value = true;
  touchOnly.value = matchesMedia(TOUCH_ONLY_QUERY);
  unsubscribe = [subscribeWsMessage(message => { if (props.open) controller.receive(message); }),
    subscribeWsClose(() => { keyboard.value = false; controller.disconnect(); }), subscribeTelemetryReset(restart)];
  if (props.open) { refresh(); timer = setInterval(refresh, 500); }
});
onBeforeUnmount(() => { clearInterval(timer); controller.dispose(); unsubscribe.forEach(stop => stop()); });
</script>

<template>
  <Teleport to="body" :disabled="!mounted">
    <div v-if="open" class="cdu-backdrop" data-cdu-modal data-no-swipe @click.self="emit('close')">
      <section ref="panel" class="cdu-dialog" :class="{ 'cdu-integrated': state.mode !== 'external' }" :data-cdu-skin="skin" role="dialog" aria-modal="true" aria-labelledby="cdu-title">
        <header class="cdu-header flex items-center justify-between gap-3 border-b border-border">
          <h2 id="cdu-title" class="font-semibold text-fg">{{ state.label || 'MCDU / CDU' }}</h2>
          <button v-if="state.mode !== 'external'" type="button" class="ff-icon-button cdu-help-toggle" aria-label="Connection setup and keyboard help" :aria-expanded="help" aria-controls="cdu-help" @click="help = !help">?</button>
          <button type="button" class="ff-icon-button" data-cdu-close aria-label="Close CDU" @click="emit('close')">×</button>
        </header>
        <div class="cdu-content" :style="{ '--cdu-function-columns': functionColumns, '--cdu-function-rows': functionRows, '--cdu-entry-rows': entryRows, '--cdu-function-weight': `${functionRows}fr`, '--cdu-entry-weight': `${entryRows}fr`, '--cdu-keypad-weight': `${functionRows + entryRows}fr` }">
          <template v-if="state.mode === 'external'">
            <p v-if="model.error" role="alert" class="text-sm text-danger mb-3">{{ model.error }}</p>
            <p class="text-sm text-muted-fg">{{ state.setup }}</p>
            <a v-if="externalUrl" :href="externalUrl" target="_blank" rel="noopener noreferrer" class="ff-button-primary inline-flex items-center min-h-[48px] mt-4">Open Fenix web MCDU ↗</a>
            <p class="mt-3 text-xs text-muted-fg">Opens Fenix’s web EFB in your browser. Select its MCDU app.</p>
          </template>
          <template v-else>
            <div class="cdu-toolbar">
              <label class="text-sm text-fg"><span class="sr-only">Unit</span>
                <select :value="model.side" class="ff-input" aria-label="CDU unit" :disabled="model.pending" @change="switchSide">
                  <option value="left">Captain</option><option value="right">First officer</option>
                </select>
              </label>
              <label class="text-sm text-fg"><span class="sr-only">Skin</span>
                <select :value="skin" class="ff-input" aria-label="CDU skin" data-cdu-skin-select @change="selectSkin">
                  <option v-for="option in CDU_SKINS" :key="option.id" :value="option.id" :title="option.description">{{ option.label }}</option>
                </select>
              </label>
              <button type="button" class="ff-button-secondary" :aria-pressed="keyboard" :disabled="!enabled && !keyboard" :title="touchOnly ? 'Needs a physical keyboard' : undefined" @click="keyboard = !keyboard">Keyboard {{ keyboard ? 'on' : 'off' }}</button>
            </div>
            <p v-if="model.error" class="cdu-status text-danger" role="alert">{{ model.error }}</p>
            <p v-else class="cdu-status text-muted-fg" role="status">{{ model.pending ? 'Sending key…' : reason || 'Connected' }}</p>
            <div class="cdu-display-area">
              <div v-for="edge in ['L', 'R']" :key="edge" class="cdu-line-keys" :class="{ 'cdu-line-keys-right': edge === 'R' }">
                <button v-for="number in 6" :key="number" type="button" class="cdu-key cdu-line-key" :aria-label="`${edge === 'L' ? 'Left' : 'Right'} line select ${number}`"
                  :style="{ gridRow: number + 1 }" :disabled="!enabled" @click="controller.press(`${edge}${number}`)">{{ edge }}{{ number }}</button>
              </div>
              <div ref="screenElement" class="cdu-screen" role="img" :style="{ '--cdu-font-size': `${screenFontSize}px` }" :aria-label="screenText" :data-powered="state.screen?.powered === true">
                <div v-for="(row, index) in (state.screen?.powered ? state.screen.rows : Array.from({ length: 14 }, () => []))" :key="index" class="cdu-screen-row" aria-hidden="true">
                  <span v-for="(cell, column) in row" :key="column" class="cdu-cell" :data-color="cell.color" :class="{ small: cell.small, reverse: cell.reverse, dim: cell.dim }">{{ cell.text }}</span>
                </div>
              </div>
            </div>
            <div class="cdu-annunciators" aria-label="CDU annunciators and scroll directions">{{ annunciators }}</div>
            <div v-show="!help" class="cdu-keypad">
              <div v-if="state.functionKeys" class="cdu-function-keys">
                <button v-for="key in state.functionKeys" :key="key.id" type="button" class="cdu-key" :data-key="key.id" :disabled="!enabled" @click="controller.press(key.id)">{{ label(key) }}</button>
              </div>
              <div v-if="state.entryKeys" class="cdu-entry-keys">
                <button v-for="key in state.entryKeys" :key="key.id" type="button" class="cdu-key" :data-key="key.id" :disabled="!enabled" @click="controller.press(key.id)">{{ label(key) }}</button>
              </div>
            </div>
            <div v-if="help" id="cdu-help" class="cdu-help text-sm text-muted-fg">
              <h3 class="font-semibold text-fg">Connection setup</h3>
              <p>{{ state.setup || 'Waiting for aircraft connection details.' }}</p>
              <h3 class="font-semibold text-fg">Keyboard</h3>
              <p v-if="touchOnly">Close help to use the on-screen keys. Taps made while a key is still being sent queue up in order. Keyboard on only works with a physical keyboard, such as one connected to a tablet. The phone's own keyboard is not used here.</p>
              <p v-else>Turn Keyboard on to enter letters, numbers, punctuation and arrow keys from a physical keyboard. Backspace clears one character. Escape closes this panel. Keys typed while one is still being sent queue up in order.</p>
              <p>Check entries on the aircraft display.</p>
            </div>
          </template>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
:global(body.cdu-open) { overflow: hidden; }
.cdu-backdrop { position: fixed; inset: 0; z-index: 260; display: flex; justify-content: center; align-items: center; background: rgb(var(--background) / .85); padding: 1rem; }

/* Every skin is a set of these variables; the layout rules below never change per skin.
   Display colours keep the aircraft's semantics, so each skin restyles the hues but keeps them distinct. */
.cdu-dialog {
  --cdu-bezel: linear-gradient(180deg, #2c3038 0%, #1c1f25 100%);
  --cdu-bezel-border: rgb(255 255 255 / .1);
  --cdu-bezel-border-width: 1px;
  --cdu-bezel-shadow: 0 24px 60px rgb(0 0 0 / .55), inset 0 1px 0 rgb(255 255 255 / .06);
  --cdu-radius: 1.1rem;
  --cdu-fg: #e5e7eb;
  --cdu-muted: #9ca3af;
  --cdu-danger: #f87171;
  --cdu-screen-bg: radial-gradient(120% 90% at 50% 40%, #0d1a13 0%, #060a08 100%);
  --cdu-screen-solid: #070b09;
  --cdu-screen-border: 3px solid #101318;
  --cdu-screen-radius: .6rem;
  --cdu-screen-shadow: inset 0 0 0 1px rgb(255 255 255 / .04), inset 0 6px 18px rgb(0 0 0 / .7), 0 0 0 1px rgb(0 0 0 / .6);
  --cdu-screen-font: var(--ff-font-mono);
  --cdu-screen-weight: 500;
  --cdu-screen-scale: 1;
  --cdu-glow: 0 0 5px;
  --cdu-glow-strength: 55%;
  --cdu-scanlines: none;
  --cdu-key-bg: linear-gradient(180deg, #3b4049 0%, #2b2f36 100%);
  --cdu-key-fg: #eef1f5;
  --cdu-key-border: #111317;
  --cdu-key-border-width: 1px;
  --cdu-key-radius: .45rem;
  --cdu-key-shadow: 0 2px 0 #0b0c0f, inset 0 1px 0 rgb(255 255 255 / .1);
  --cdu-key-active-shadow: 0 0 0 #0b0c0f, inset 0 2px 4px rgb(0 0 0 / .5);
  --cdu-key-font: var(--ff-font-ui);
  --cdu-key-weight: 600;
  --cdu-key-transform: none;
  --cdu-key-spacing: 0;
  --cdu-key-hover: #7dd3fc;
  --cdu-exec: #86efac;
  --cdu-annunciator: #fbbf24;
  --cdu-ink-white: #f3f4f6;
  --cdu-ink-cyan: #67e8f9;
  --cdu-ink-green: #86efac;
  --cdu-ink-magenta: #f0abfc;
  --cdu-ink-amber: #fbbf24;
  --cdu-ink-yellow: #fef08a;
  --cdu-ink-red: #f87171;
  width: 100%; max-width: 36rem; max-height: 94dvh; display: flex; flex-direction: column; overflow: hidden;
  border: var(--cdu-bezel-border-width) solid var(--cdu-bezel-border); border-radius: var(--cdu-radius);
  background: var(--cdu-bezel); box-shadow: var(--cdu-bezel-shadow); color: var(--cdu-fg);
}
.cdu-integrated { height: min(60rem, 94dvh); container: cdu / size; }
.cdu-header { flex: none; padding: .25rem .75rem; min-height: 52px; border-color: var(--cdu-bezel-border); color: var(--cdu-fg); }
.cdu-header h2 { font-size: 1rem; color: var(--cdu-fg); font-family: var(--cdu-key-font); text-transform: var(--cdu-key-transform); letter-spacing: var(--cdu-key-spacing); }
.cdu-header .ff-icon-button { color: var(--cdu-key-fg); background: var(--cdu-key-bg); border: var(--cdu-key-border-width) solid var(--cdu-key-border); box-shadow: var(--cdu-key-shadow); }
.cdu-header .ff-icon-button:hover { border-color: var(--cdu-key-hover); }
.cdu-help-toggle { margin-left: auto; }
.cdu-content { overflow-y: auto; padding: 1rem; min-height: 0; color: var(--cdu-fg); }
.cdu-content .text-muted-fg { color: var(--cdu-muted); }
.cdu-integrated .cdu-content { --cdu-phone-display-min: 272px; --cdu-phone-keypad-min: 160px; --cdu-phone-key-min: 40px; flex: 1; display: grid; grid-template-rows: auto auto minmax(var(--cdu-phone-display-min), 7fr) auto minmax(var(--cdu-phone-keypad-min), var(--cdu-keypad-weight)); gap: 4px; overflow: auto; padding: .5rem .75rem .75rem; }
.cdu-toolbar { display: flex; align-items: center; gap: .5rem; }
.cdu-toolbar label { flex: 1 1 0; min-width: 0; }
.cdu-toolbar select { width: 100%; }
.cdu-toolbar :is(select, button) { min-height: 40px !important; height: 40px; padding: .25rem .6rem; font-size: .8rem; background: var(--cdu-key-bg); color: var(--cdu-key-fg); border: var(--cdu-key-border-width) solid var(--cdu-key-border); border-radius: var(--cdu-key-radius); font-family: var(--cdu-key-font); white-space: nowrap; }
.cdu-toolbar button[aria-pressed='true'] { border-color: var(--cdu-exec); box-shadow: inset 0 -3px 0 var(--cdu-exec); }
.cdu-status { margin: 0; font-size: .75rem; line-height: 1.25; color: var(--cdu-muted); }
.cdu-status.text-danger { color: var(--cdu-danger); }
.cdu-display-area { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; gap: .4rem; align-items: stretch; min-height: 0; }
.cdu-line-keys { grid-column: 1; grid-row: 1; display: grid; grid-template-rows: 1.5fr repeat(6, minmax(0, 2fr)) .5fr; gap: 2px; min-height: 0; }
.cdu-line-keys-right { grid-column: 3; }
.cdu-line-key { font-size: .6rem; font-weight: 500; opacity: .9; }
.cdu-screen { position: relative; overflow: hidden; grid-column: 2; grid-row: 1; padding: .2rem; background: var(--cdu-screen-bg); border: var(--cdu-screen-border); border-radius: var(--cdu-screen-radius); box-shadow: var(--cdu-screen-shadow); display: grid; grid-template-rows: repeat(14, minmax(0, 1fr)); min-height: 0; }
.cdu-screen::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: var(--cdu-scanlines); }
.cdu-screen[data-powered='false'] { opacity: .8; }
.cdu-screen-row { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); align-items: center; white-space: pre; font-family: var(--cdu-screen-font); font-weight: var(--cdu-screen-weight); font-size: calc(var(--cdu-font-size) * var(--cdu-screen-scale)); line-height: 1; }
.cdu-cell { --cdu-ink: var(--cdu-ink-white); text-align: center; color: var(--cdu-ink); text-shadow: var(--cdu-glow) color-mix(in srgb, var(--cdu-ink) var(--cdu-glow-strength), transparent); }
.cdu-cell[data-color='white'] { --cdu-ink: var(--cdu-ink-white); }
.cdu-cell[data-color='cyan'] { --cdu-ink: var(--cdu-ink-cyan); }
.cdu-cell[data-color='green'] { --cdu-ink: var(--cdu-ink-green); }
.cdu-cell[data-color='magenta'] { --cdu-ink: var(--cdu-ink-magenta); }
.cdu-cell[data-color='amber'] { --cdu-ink: var(--cdu-ink-amber); }
.cdu-cell[data-color='yellow'] { --cdu-ink: var(--cdu-ink-yellow); }
.cdu-cell[data-color='red'] { --cdu-ink: var(--cdu-ink-red); }
.cdu-cell.small { font-size: max(10px, calc(var(--cdu-font-size) * var(--cdu-screen-scale) * .78)); }
.cdu-cell.reverse { background: var(--cdu-ink); color: var(--cdu-screen-solid); text-shadow: none; }
.cdu-cell.dim { opacity: .65; }
.cdu-annunciators { text-align: right; color: var(--cdu-annunciator); font-size: .7rem; line-height: 1; font-family: var(--cdu-key-font); letter-spacing: var(--cdu-key-spacing); }
.cdu-key { min-width: 0; min-height: 24px !important; padding: .1rem; border: var(--cdu-key-border-width) solid var(--cdu-key-border); border-radius: var(--cdu-key-radius); background: var(--cdu-key-bg); color: var(--cdu-key-fg); box-shadow: var(--cdu-key-shadow); font-family: var(--cdu-key-font); font-size: .7rem; line-height: 1.1; font-weight: var(--cdu-key-weight); text-transform: var(--cdu-key-transform); letter-spacing: var(--cdu-key-spacing); touch-action: manipulation; transition: transform 80ms ease, box-shadow 80ms ease, border-color 120ms ease; }
.cdu-key:hover:enabled { border-color: var(--cdu-key-hover); }
.cdu-key:active:enabled { transform: translateY(1px); box-shadow: var(--cdu-key-active-shadow); }
.cdu-key:disabled { opacity: .45; }
.cdu-key:focus-visible { outline: 2px solid var(--cdu-key-hover); outline-offset: 2px; }
.cdu-key[data-key='EXEC'] { border-bottom: 3px solid var(--cdu-exec); }
.cdu-keypad { display: grid; grid-template-rows: minmax(auto, var(--cdu-function-weight)) minmax(auto, var(--cdu-entry-weight)); gap: 6px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.cdu-function-keys { display: grid; grid-template-columns: repeat(var(--cdu-function-columns), minmax(0, 1fr)); grid-template-rows: repeat(var(--cdu-function-rows), minmax(var(--cdu-phone-key-min), 1fr)); gap: 3px; }
.cdu-entry-keys { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); grid-template-rows: repeat(var(--cdu-entry-rows), minmax(var(--cdu-phone-key-min), 1fr)); gap: 3px; }
.cdu-keypad .cdu-key { min-height: var(--cdu-phone-key-min) !important; }
.cdu-function-keys .cdu-key { overflow-wrap: anywhere; }
.cdu-help { min-height: 0; overflow-y: auto; padding: .5rem; border: 1px solid var(--cdu-bezel-border); border-radius: var(--cdu-key-radius); color: var(--cdu-muted); }
.cdu-help h3 { color: var(--cdu-fg); }
.cdu-help h3, .cdu-help p { margin: 0 0 .5rem; }

/* Retro CRT: beige terminal plastic, amber tube, scanlines and a faint flicker. */
.cdu-dialog[data-cdu-skin='crt'] {
  --cdu-bezel: linear-gradient(180deg, #ddd6c4 0%, #bcb39c 100%); --cdu-bezel-border: #8b826d; --cdu-bezel-border-width: 2px;
  --cdu-bezel-shadow: 0 24px 50px rgb(0 0 0 / .5), inset 0 1px 0 #fff; --cdu-radius: .5rem; --cdu-fg: #2b2620; --cdu-muted: #5c544a; --cdu-danger: #9f1239;
  --cdu-screen-bg: radial-gradient(110% 100% at 50% 45%, #2b1b06 0%, #120a02 100%); --cdu-screen-solid: #140b02;
  --cdu-screen-border: 8px solid #3a332a; --cdu-screen-radius: 1rem; --cdu-screen-shadow: inset 0 0 40px rgb(0 0 0 / .85), inset 0 0 0 2px #1a1510;
  --cdu-screen-font: "Lucida Console", "Courier New", Courier, monospace; --cdu-screen-weight: 700; --cdu-glow: 0 0 7px; --cdu-glow-strength: 80%;
  --cdu-scanlines: repeating-linear-gradient(0deg, rgb(0 0 0 / .28) 0 1px, transparent 1px 3px);
  --cdu-key-bg: linear-gradient(180deg, #f4eee0 0%, #d8cfb8 100%); --cdu-key-fg: #2b2620; --cdu-key-border: #8b826d; --cdu-key-radius: .2rem;
  --cdu-key-shadow: 0 3px 0 #8b826d, inset 0 1px 0 #fff; --cdu-key-active-shadow: 0 0 0 #8b826d, inset 0 2px 3px rgb(0 0 0 / .25);
  --cdu-key-font: "Lucida Console", "Courier New", monospace; --cdu-key-weight: 700; --cdu-key-transform: uppercase;
  --cdu-key-hover: #b45309; --cdu-exec: #b45309; --cdu-annunciator: #92400e;
  --cdu-ink-white: #ffb000; --cdu-ink-cyan: #5ee0ff; --cdu-ink-green: #7dff7d; --cdu-ink-magenta: #ff7bd5; --cdu-ink-amber: #ff8c1a; --cdu-ink-yellow: #fff275; --cdu-ink-red: #ff5a5a;
}
.cdu-dialog[data-cdu-skin='crt'] .cdu-screen::after { animation: cdu-crt-flicker 4s steps(2, end) infinite; }
@keyframes cdu-crt-flicker { 0%, 96%, 100% { opacity: 1; } 97% { opacity: .82; } 98% { opacity: .94; } }

/* Deep space: starfield bezel, indigo glow, pill keys. */
.cdu-dialog[data-cdu-skin='orbit'] {
  --cdu-bezel:
    radial-gradient(circle at 12% 18%, rgb(255 255 255 / .95) 0 1.4px, transparent 2px), radial-gradient(circle at 78% 9%, rgb(255 255 255 / .85) 0 1.2px, transparent 1.8px),
    radial-gradient(circle at 34% 62%, rgb(255 255 255 / .7) 0 1px, transparent 1.6px), radial-gradient(circle at 90% 48%, rgb(255 255 255 / .95) 0 1.5px, transparent 2.1px),
    radial-gradient(circle at 58% 84%, rgb(255 255 255 / .7) 0 .8px, transparent 1.4px), radial-gradient(circle at 6% 88%, rgb(255 255 255 / .8) 0 1px, transparent 1.6px),
    radial-gradient(circle at 46% 30%, rgb(196 181 253 / .9) 0 .8px, transparent 1.4px), radial-gradient(circle at 70% 70%, rgb(165 243 252 / .9) 0 1px, transparent 1.6px),
    radial-gradient(80% 60% at 80% 100%, rgb(99 102 241 / .35) 0%, transparent 70%), linear-gradient(180deg, #141a3a 0%, #060916 100%);
  --cdu-bezel-border: rgb(129 140 248 / .35); --cdu-bezel-shadow: 0 24px 60px rgb(0 0 0 / .7), 0 0 40px rgb(99 102 241 / .2); --cdu-radius: 1.5rem;
  --cdu-fg: #e0e7ff; --cdu-muted: #a5b4fc; --cdu-danger: #fb7185;
  --cdu-screen-bg: radial-gradient(120% 100% at 50% 30%, #0b1030 0%, #03040c 100%); --cdu-screen-solid: #04050f;
  --cdu-screen-border: 2px solid rgb(99 102 241 / .55); --cdu-screen-radius: 1rem; --cdu-screen-shadow: 0 0 24px rgb(99 102 241 / .35), inset 0 0 30px rgb(0 0 0 / .7);
  --cdu-screen-font: "Cascadia Mono", Consolas, Menlo, monospace; --cdu-glow: 0 0 8px; --cdu-glow-strength: 70%;
  --cdu-key-bg: linear-gradient(180deg, rgb(49 46 129 / .9) 0%, rgb(30 27 75 / .95) 100%); --cdu-key-fg: #e0e7ff; --cdu-key-border: rgb(129 140 248 / .4); --cdu-key-radius: 9999px;
  --cdu-key-shadow: 0 0 10px rgb(99 102 241 / .25), inset 0 1px 0 rgb(255 255 255 / .12); --cdu-key-active-shadow: 0 0 4px rgb(99 102 241 / .2), inset 0 2px 6px rgb(0 0 0 / .5);
  --cdu-key-font: Bahnschrift, "Avenir Next", Futura, "Segoe UI", sans-serif; --cdu-key-transform: uppercase; --cdu-key-spacing: .04em;
  --cdu-key-hover: #c7d2fe; --cdu-exec: #5eead4; --cdu-annunciator: #c4b5fd;
  --cdu-ink-white: #eef2ff; --cdu-ink-cyan: #67e8f9; --cdu-ink-green: #6ee7b7; --cdu-ink-magenta: #e879f9; --cdu-ink-amber: #fbbf24; --cdu-ink-yellow: #fde68a; --cdu-ink-red: #fb7185;
}

/* Neon grid: cyberpunk magenta and cyan over a wireframe bezel, hard corners. */
.cdu-dialog[data-cdu-skin='neon'] {
  --cdu-bezel: linear-gradient(rgb(255 43 214 / .07) 1px, transparent 1px) 0 0 / 100% 18px, linear-gradient(90deg, rgb(0 229 255 / .07) 1px, transparent 1px) 0 0 / 18px 100%, linear-gradient(180deg, #1a0b2e 0%, #0a0514 100%);
  --cdu-bezel-border: #ff2bd6; --cdu-bezel-shadow: 0 0 24px rgb(255 43 214 / .35), 0 24px 60px rgb(0 0 0 / .7); --cdu-radius: .25rem;
  --cdu-fg: #f5d0fe; --cdu-muted: #c084fc; --cdu-danger: #ff3864;
  --cdu-screen-bg: linear-gradient(180deg, #120821 0%, #05030a 100%); --cdu-screen-solid: #06030b;
  --cdu-screen-border: 2px solid #00e5ff; --cdu-screen-radius: .25rem; --cdu-screen-shadow: 0 0 18px rgb(0 229 255 / .45), inset 0 0 22px rgb(255 43 214 / .15);
  --cdu-screen-font: "Cascadia Code", Consolas, Menlo, monospace; --cdu-glow: 0 0 9px; --cdu-glow-strength: 85%;
  --cdu-scanlines: repeating-linear-gradient(0deg, rgb(0 229 255 / .05) 0 2px, transparent 2px 4px);
  --cdu-key-bg: linear-gradient(135deg, #2a0f4d 0%, #12071f 100%); --cdu-key-fg: #00e5ff; --cdu-key-border: #ff2bd6; --cdu-key-radius: 0;
  --cdu-key-shadow: 0 0 8px rgb(255 43 214 / .35), inset 0 0 0 1px rgb(0 229 255 / .25); --cdu-key-active-shadow: 0 0 14px rgb(0 229 255 / .6), inset 0 0 0 1px #00e5ff;
  --cdu-key-font: "Bahnschrift SemiCondensed", "Avenir Next Condensed", Impact, sans-serif; --cdu-key-transform: uppercase; --cdu-key-spacing: .08em;
  --cdu-key-hover: #fff; --cdu-exec: #39ff14; --cdu-annunciator: #ff2bd6;
  --cdu-ink-white: #f8f0ff; --cdu-ink-cyan: #00e5ff; --cdu-ink-green: #39ff14; --cdu-ink-magenta: #ff2bd6; --cdu-ink-amber: #ffb020; --cdu-ink-yellow: #f9f871; --cdu-ink-red: #ff3864;
}

/* Cartoon: sky-blue bezel, chunky black outlines, hard offset shadows, comic lettering. */
.cdu-dialog[data-cdu-skin='toon'] {
  --cdu-bezel: linear-gradient(180deg, #62d4ff 0%, #35b6f2 100%); --cdu-bezel-border: #1b1b2f; --cdu-bezel-border-width: 3px;
  --cdu-bezel-shadow: 8px 8px 0 #1b1b2f; --cdu-radius: 1.5rem; --cdu-fg: #1b1b2f; --cdu-muted: #223a55; --cdu-danger: #b91c1c;
  --cdu-screen-bg: #1b1b2f; --cdu-screen-solid: #1b1b2f; --cdu-screen-border: 4px solid #1b1b2f; --cdu-screen-radius: 1rem; --cdu-screen-shadow: inset 0 0 0 3px #fff;
  --cdu-screen-font: "Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive; --cdu-screen-weight: 700; --cdu-screen-scale: .86; --cdu-glow: 0 0 0; --cdu-glow-strength: 0%;
  --cdu-key-bg: #ffe66d; --cdu-key-fg: #1b1b2f; --cdu-key-border: #1b1b2f; --cdu-key-border-width: 2px; --cdu-key-radius: .75rem;
  --cdu-key-shadow: 3px 3px 0 #1b1b2f; --cdu-key-active-shadow: 1px 1px 0 #1b1b2f;
  --cdu-key-font: "Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive; --cdu-key-weight: 700;
  --cdu-key-hover: #ff6b6b; --cdu-exec: #06d6a0; --cdu-annunciator: #1b1b2f;
  --cdu-ink-white: #fff; --cdu-ink-cyan: #4cc9f0; --cdu-ink-green: #06d6a0; --cdu-ink-magenta: #f78fdc; --cdu-ink-amber: #ffb703; --cdu-ink-yellow: #ffe66d; --cdu-ink-red: #ff6b6b;
}

/* Pastel cloud: soft pinks and lavenders, white-framed plum display, bubbly keys. */
.cdu-dialog[data-cdu-skin='pastel'] {
  --cdu-bezel: linear-gradient(160deg, #ffe4f1 0%, #e9defc 50%, #d6f0ff 100%); --cdu-bezel-border: rgb(244 114 182 / .35);
  --cdu-bezel-shadow: 0 20px 40px rgb(216 180 254 / .5); --cdu-radius: 2rem; --cdu-fg: #6b4c7a; --cdu-muted: #9b7fae; --cdu-danger: #be123c;
  --cdu-screen-bg: radial-gradient(120% 100% at 50% 20%, #4a3560 0%, #2b1d3a 100%); --cdu-screen-solid: #2f2040;
  --cdu-screen-border: 3px solid #f9a8d4; --cdu-screen-radius: 1.5rem; --cdu-screen-shadow: 0 0 0 4px #fff, 0 0 0 6px #e9d5ff, inset 0 0 24px rgb(0 0 0 / .35);
  --cdu-screen-font: "Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", cursive; --cdu-screen-weight: 600; --cdu-screen-scale: .86; --cdu-glow: 0 0 6px; --cdu-glow-strength: 50%;
  --cdu-key-bg: linear-gradient(180deg, #fff 0%, #fce7f3 100%); --cdu-key-fg: #7c3aed; --cdu-key-border: #f9a8d4; --cdu-key-radius: 9999px;
  --cdu-key-shadow: 0 3px 0 #f9a8d4; --cdu-key-active-shadow: 0 0 0 #f9a8d4, inset 0 2px 4px rgb(124 58 237 / .2);
  --cdu-key-font: "Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", cursive; --cdu-key-weight: 700;
  --cdu-key-hover: #a78bfa; --cdu-exec: #34d399; --cdu-annunciator: #db2777;
  --cdu-ink-white: #fff7fb; --cdu-ink-cyan: #a5f3fc; --cdu-ink-green: #bbf7d0; --cdu-ink-magenta: #f5b0ea; --cdu-ink-amber: #fcd34d; --cdu-ink-yellow: #fef3c7; --cdu-ink-red: #fda4af;
}

/* Blackout: black on black, red edges, heavy condensed capitals, no rounding. */
.cdu-dialog[data-cdu-skin='blackout'] {
  --cdu-bezel: linear-gradient(180deg, #0b0b0d 0%, #000 100%); --cdu-bezel-border: #2a2a2e; --cdu-bezel-shadow: 0 0 0 1px #dc2626, 0 30px 60px #000; --cdu-radius: 0;
  --cdu-fg: #e5e5e5; --cdu-muted: #737373; --cdu-danger: #ef4444;
  --cdu-screen-bg: #000; --cdu-screen-solid: #000; --cdu-screen-border: 1px solid #dc2626; --cdu-screen-radius: 0; --cdu-screen-shadow: inset 0 0 30px rgb(220 38 38 / .15);
  --cdu-screen-font: Consolas, "Cascadia Mono", Menlo, monospace; --cdu-screen-weight: 700; --cdu-glow: 0 0 4px; --cdu-glow-strength: 40%;
  --cdu-key-bg: linear-gradient(180deg, #1c1c20 0%, #0a0a0c 100%); --cdu-key-fg: #f5f5f5; --cdu-key-border: #3f3f46; --cdu-key-radius: 0;
  --cdu-key-shadow: inset 0 1px 0 rgb(255 255 255 / .06), 0 2px 0 #000; --cdu-key-active-shadow: inset 0 2px 6px #000;
  --cdu-key-font: Impact, "Segoe UI Black", "Arial Black", "Avenir Next Condensed", sans-serif; --cdu-key-weight: 400; --cdu-key-transform: uppercase; --cdu-key-spacing: .06em;
  --cdu-key-hover: #dc2626; --cdu-exec: #dc2626; --cdu-annunciator: #dc2626;
  --cdu-ink-white: #fafafa; --cdu-ink-cyan: #38bdf8; --cdu-ink-green: #4ade80; --cdu-ink-magenta: #e879f9; --cdu-ink-amber: #f59e0b; --cdu-ink-yellow: #facc15; --cdu-ink-red: #ef4444;
}

/* Brass & leather: steampunk brass buttons and a brass-framed display on a leather bezel. */
.cdu-dialog[data-cdu-skin='brass'] {
  --cdu-bezel: radial-gradient(120% 80% at 50% 0%, #4a2c1a 0%, #24130a 100%); --cdu-bezel-border: #b8863b; --cdu-bezel-border-width: 2px;
  --cdu-bezel-shadow: 0 0 0 3px #7a5a2a, 0 0 0 5px #b8863b, 0 24px 50px rgb(0 0 0 / .7); --cdu-radius: .75rem; --cdu-fg: #f3d9a4; --cdu-muted: #c9a76b; --cdu-danger: #f87171;
  --cdu-screen-bg: radial-gradient(120% 100% at 50% 40%, #1e2a1c 0%, #0b120a 100%); --cdu-screen-solid: #0c130b;
  --cdu-screen-border: 4px solid #b8863b; --cdu-screen-radius: .5rem; --cdu-screen-shadow: inset 0 0 0 2px #5c3d17, inset 0 0 30px rgb(0 0 0 / .8);
  --cdu-screen-font: "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif; --cdu-screen-weight: 600; --cdu-screen-scale: .92; --cdu-glow: 0 0 5px; --cdu-glow-strength: 50%;
  --cdu-key-bg: linear-gradient(180deg, #e2b96a 0%, #a8752c 100%); --cdu-key-fg: #2a1708; --cdu-key-border: #6b4413; --cdu-key-radius: 9999px;
  --cdu-key-shadow: 0 3px 0 #5a3a12, inset 0 1px 0 rgb(255 255 255 / .4); --cdu-key-active-shadow: 0 0 0 #5a3a12, inset 0 2px 4px rgb(0 0 0 / .4);
  --cdu-key-font: Georgia, "Times New Roman", serif; --cdu-key-weight: 700; --cdu-key-transform: uppercase; --cdu-key-spacing: .05em;
  --cdu-key-hover: #fde68a; --cdu-exec: #166534; --cdu-annunciator: #e2b96a;
  --cdu-ink-white: #f5e6c8; --cdu-ink-cyan: #8fd3d6; --cdu-ink-green: #a3d977; --cdu-ink-magenta: #e6a3c8; --cdu-ink-amber: #f0b35a; --cdu-ink-yellow: #f5e07a; --cdu-ink-red: #e06666;
}

@media (prefers-reduced-motion: reduce) {
  .cdu-dialog .cdu-screen::after { animation: none; }
  .cdu-key { transition: none; }
}
@media (max-width: 600px), (max-height: 500px) {
  .cdu-backdrop { padding: 0; }
  .cdu-dialog { max-width: none; max-height: var(--ff-visual-viewport-height, 100dvh); height: var(--ff-visual-viewport-height, 100dvh); border: 0; border-radius: 0; box-shadow: none; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .cdu-header { min-height: 44px; padding: 0 .5rem; }
  .cdu-integrated .cdu-content { gap: 2px; padding: 4px 6px 6px; }
  .cdu-toolbar :is(select, button) { height: 36px; min-height: 36px !important; padding: .25rem .4rem; }
  .cdu-display-area { gap: 3px; }
  .cdu-function-keys .cdu-key { padding: 0; font-size: .65rem; line-height: 1; }
}
/* Use the actual panel height, including browser chrome and safe-area space.
   Very short, narrow screens cannot fit a readable display plus a keypad
   viewport: let the whole content scroll, keeping Close and Help in reach. */
@container cdu (max-width: 699px) and (max-height: 540px) {
  .cdu-integrated .cdu-content { overflow-y: auto; grid-template-rows: auto auto var(--cdu-phone-display-min) auto auto; }
  .cdu-keypad { overflow: visible; }
  .cdu-help { min-height: 160px; overflow: visible; }
}
/* Proportional decorative fonts crowd the 24-column display on narrow phones.
   Keep the skin's colours and key lettering, with a fixed-pitch display. */
@container cdu (max-width: 400px) {
  .cdu-screen { --cdu-screen-font: Consolas, "Cascadia Mono", Menlo, monospace; --cdu-screen-scale: 1; }
}
@media (min-width: 700px) and (max-height: 500px) {
  .cdu-integrated .cdu-content { --cdu-phone-key-min: 32px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); grid-template-rows: auto auto minmax(240px, 1fr) auto; column-gap: .75rem; }
  .cdu-toolbar { grid-column: 1 / -1; }
  .cdu-status { grid-column: 1; grid-row: 2; }
  .cdu-display-area { grid-column: 1; grid-row: 3; }
  .cdu-annunciators { grid-column: 1; grid-row: 4; }
  .cdu-keypad, .cdu-help { grid-column: 2; grid-row: 2 / 5; }
}
</style>
