<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { normalizeAircraftSearchText as normalizeSearchText, useAircraftControlsStore } from '../stores/aircraft-controls.js';

const props = defineProps({
  target: { type: Object, default: null },
  contentKey: { type: String, default: '' },
});
const emit = defineEmits(['expanded-change', 'mode-change', 'open-command']);
const controls = useAircraftControlsStore();

const searchRoot = ref(null);
const searchInput = ref(null);
const searchLauncher = ref(null);
const query = ref('');
const matches = ref([]);
const currentIndex = ref(-1);
const expanded = ref(false);
const mode = ref('commands');
const resultsHeight = ref('45dvh');
let focusRevision = 0, matchRevision = 0;
const commandMatches = computed(() => query.value.trim() ? controls.findAircraftCommands(query.value) : []);
const catalogueReady = computed(() => Boolean(controls.aircraftCommandCatalogue.profileKey));
const commandCount = computed(() => Object.keys(controls.aircraftCommandCatalogue.commands).length);

function fitResults() {
  if (!expanded.value || typeof window === 'undefined') return;
  const list = searchRoot.value?.querySelector?.('.aircraft-find__results');
  const main = searchRoot.value?.closest?.('#vue-main-root');
  if (!list || !main?.getBoundingClientRect) return;
  const viewport = window.visualViewport;
  const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const bottom = Math.min(main.getBoundingClientRect().bottom, viewportBottom);
  resultsHeight.value = `${Math.max(44, Math.floor(bottom - list.getBoundingClientRect().top - 16))}px`;
}

// Subscribe only while search is open. The real main-region boundary also
// accounts for the app header/navigation when a phone keyboard reduces space.
watch(expanded, (open, _previous, onCleanup) => {
  if (!open || typeof window === 'undefined') return;
  const main = searchRoot.value?.closest?.('#vue-main-root');
  window.addEventListener?.('resize', fitResults);
  window.visualViewport?.addEventListener?.('resize', fitResults);
  window.visualViewport?.addEventListener?.('scroll', fitResults);
  main?.addEventListener?.('scroll', fitResults, { passive: true });
  const observer = typeof ResizeObserver === 'function' && main?.getBoundingClientRect
    ? new ResizeObserver(fitResults) : null;
  if (observer) { observer.observe(main); observer.observe(searchRoot.value); }
  fitResults();
  onCleanup(() => {
    observer?.disconnect();
    window.removeEventListener?.('resize', fitResults);
    window.visualViewport?.removeEventListener?.('resize', fitResults);
    window.visualViewport?.removeEventListener?.('scroll', fitResults);
    main?.removeEventListener?.('scroll', fitResults);
  });
}, { flush: 'post' });

const RESULT_TARGET_SELECTOR = [
  '[data-aircraft-control-group]',
  '[data-aircraft-control-section]',
  '[data-aircraft-field]',
  '[data-aircraft-engine]',
  '[data-fenix-section]',
  '[data-ifly-mcp-field]',
  '[data-ifly-afds-indicator]',
  '[data-ifly-light]',
  '[data-ifly-engine]',
  '[data-tristar-engine]',
  '[data-tristar-section]',
  '.controls-command-card',
  '.controls-selector-card',
  '.controls-nav-button',
  '.rounded-lg.border',
  '.rounded-md.border',
  '.rounded-xl.border',
  '.rounded.border',
  'article',
  'section',
  'button',
  'label',
].join(',');

const resultText = computed(() => {
  if (mode.value === 'commands') {
    if (!catalogueReady.value) return 'Waiting for the aircraft command catalogue';
    if (!commandCount.value) return 'No commands are advertised for this aircraft';
    if (!query.value.trim()) return 'Find a control, preset or voice phrase';
    return commandMatches.value.length ? `${commandMatches.value.length} matching commands`
      : 'No matching commands for this aircraft';
  }
  if (!query.value.trim()) return 'Find any control or value';
  if (matches.value.length === 0) return 'No matches';
  return `${currentIndex.value + 1} of ${matches.value.length}`;
});

const resultDetail = computed(() => {
  if (mode.value === 'commands') return '';
  if (!query.value.trim() || matches.value.length > 0) return '';
  return 'Try a switch name, abbreviation, or system.';
});

function selectMode(value) {
  if (!['commands', 'page'].includes(value) || value === mode.value) return;
  const previousFocus = typeof document === 'undefined' ? null : document.activeElement;
  const ownedFocus = searchRoot.value?.contains(previousFocus);
  const revision = ++focusRevision;
  mode.value = value;
  emit('mode-change', value);
  nextTick(() => {
    // The navigation link changes with the search destination. Do not strand keyboard
    // users on the document, or override focus already moved by another action.
    if (ownedFocus && revision === focusRevision && expanded.value && aircraftPageIsActive() && !modalDialogIsOpen()
      && (document.activeElement === previousFocus || document.activeElement === document.body)) {
      searchInput.value?.focus?.({ preventScroll: true });
    }
  });
}

function openCommand(command, event) {
  // Snapshot the catalogue at activation; the workspace rechecks ownership
  // before opening anything after Vue has rendered the destination.
  if (command && controls.getAircraftCommand(command.id) !== command) return;
  emit('open-command', { commandId: command?.id || '',
    catalogue: controls.aircraftCommandCatalogue, returnTarget: event?.currentTarget || searchInput.value });
}

function clearMatchMarkers() {
  for (const element of matches.value) {
    element.removeAttribute?.('data-aircraft-find-match');
    element.removeAttribute?.('data-aircraft-find-current');
  }
  matches.value = [];
  currentIndex.value = -1;
}

function isVisible(element) {
  return element.getClientRects?.().length > 0;
}

function isSearchable(element) {
  if (isVisible(element)) return true;
  const closedDetails = element.closest?.('details:not([open])');
  return Boolean(
    closedDetails
    && props.target?.contains?.(closedDetails)
    && isVisible(closedDetails),
  );
}

function revealMatch(element) {
  let details = element?.matches?.('details') ? element : element?.closest?.('details');
  while (details) {
    details.open = true;
    details = details.parentElement?.closest?.('details') || null;
  }
}

function searchableElementText(element) {
  const metadata = Array.from(element.attributes || [])
    .filter((attribute) => (
      attribute.name === 'aria-label'
      || attribute.name === 'title'
      || attribute.name.startsWith('data-aircraft-')
      || attribute.name.startsWith('data-fenix-')
      || attribute.name.startsWith('data-ifly-')
      || attribute.name.startsWith('data-tristar-')
    ))
    .map((attribute) => attribute.value)
    .join(' ');
  return `${element.innerText || element.textContent || ''} ${metadata}`;
}

function collectMatches() {
  const root = props.target;
  const needle = normalizeSearchText(query.value);
  if (!root || !needle) return [];

  const candidates = Array.from(root.querySelectorAll(RESULT_TARGET_SELECTOR))
    .filter((element) => (
      isSearchable(element)
      && !element.closest?.('.aircraft-page-tools, .aircraft-find, [data-aircraft-section-ribbon], [data-aircraft-orientation]')
      && normalizeSearchText(searchableElementText(element)).includes(needle)
    ));

  const visibleTextMatches = new Set(candidates.filter((element) => (
    normalizeSearchText(element.innerText || element.textContent || '').includes(needle)
  )));

  // Action IDs make controls searchable by system name, but a metadata-only
  // child such as a generic "SET" button is a poor destination when its card
  // already contains the query in visible cockpit text. Keep the useful card
  // in that case, while retaining metadata-only matches that have no clearer
  // ancestor.
  const contextualCandidates = candidates.filter((candidate) => (
    visibleTextMatches.has(candidate)
    || !candidates.some((ancestor) => (
      ancestor !== candidate
      && ancestor.contains(candidate)
      && visibleTextMatches.has(ancestor)
    ))
  ));

  // Prefer the smallest useful card/control. Parent sections contain the same
  // text as their children and would otherwise create noisy duplicate results.
  return contextualCandidates.filter((candidate) => !contextualCandidates.some((other) => (
    other !== candidate && candidate.contains(other)
  )));
}

function markCurrentMatch({ scroll = false, behavior = 'smooth' } = {}) {
  for (const element of matches.value) {
    element.removeAttribute('data-aircraft-find-current');
  }
  const current = matches.value[currentIndex.value];
  if (!current) return;
  revealMatch(current);
  current.setAttribute('data-aircraft-find-current', 'true');
  if (scroll) {
    current.scrollIntoView?.({ behavior, block: 'center', inline: 'nearest' });
  }
}

function refreshMatches({ scroll = false } = {}) {
  clearMatchMarkers();
  if (!expanded.value || mode.value !== 'page' || !aircraftPageIsActive() || !query.value.trim()) return;

  matches.value = collectMatches();
  for (const element of matches.value) {
    element.setAttribute('data-aircraft-find-match', 'true');
  }
  currentIndex.value = matches.value.length > 0 ? 0 : -1;
  markCurrentMatch({ scroll, behavior: 'auto' });
}

function moveMatch(direction) {
  if (matches.value.length === 0) {
    refreshMatches({ scroll: true });
    return;
  }
  currentIndex.value = (
    currentIndex.value + direction + matches.value.length
  ) % matches.value.length;
  markCurrentMatch({ scroll: true });
}

function clearSearch({ focus = false } = {}) {
  const revision = ++focusRevision;
  ++matchRevision;
  query.value = '';
  clearMatchMarkers();
  if (focus) nextTick(() => {
    if (revision === focusRevision && expanded.value && aircraftPageIsActive() && !modalDialogIsOpen()) searchInput.value?.focus?.({ preventScroll: true });
  });
}

function expandSearch({ select = false } = {}) {
  const revision = ++focusRevision;
  expanded.value = true;
  emit('expanded-change', true);
  nextTick(() => {
    if (revision !== focusRevision || !expanded.value || !aircraftPageIsActive() || modalDialogIsOpen()) return;
    searchInput.value?.focus?.({ preventScroll: true });
    if (select) searchInput.value?.select?.();
  });
}

function collapseSearch({ focusLauncher = true } = {}) {
  clearSearch();
  const revision = ++focusRevision;
  expanded.value = false;
  mode.value = 'commands';
  emit('expanded-change', false);
  if (focusLauncher) nextTick(() => {
    if (revision === focusRevision && !expanded.value && aircraftPageIsActive() && !modalDialogIsOpen()) searchLauncher.value?.focus?.({ preventScroll: true });
  });
}

function searchOwnsFocus() {
  return Boolean(
    typeof document !== 'undefined'
    && searchRoot.value?.contains?.(document.activeElement),
  );
}

function handleSearchKeydown(event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    if (mode.value === 'page' && !event.repeat) moveMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (query.value.trim()) clearSearch({ focus: true });
    else collapseSearch();
  }
}

function handlePanelKeydown(event) {
  if (event.key === 'Escape') handleSearchKeydown(event);
}

function aircraftPageIsActive() {
  const tab = props.target?.closest?.('.tab-section');
  return tab?.classList?.contains('active') === true;
}

function modalDialogIsOpen() {
  if (typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
    .some((dialog) => isVisible(dialog));
}

function handleDocumentKeydown(event) {
  if (
    event.defaultPrevented
    || !aircraftPageIsActive()
    || modalDialogIsOpen()
    || event.altKey
    || !(event.ctrlKey || event.metaKey)
    || String(event.key).toLowerCase() !== 'f'
  ) return;

  event.preventDefault();
  expandSearch({ select: true });
}

useDocumentEvent('keydown', handleDocumentKeydown);
watch([query, mode], () => {
  const revision = ++matchRevision;
  clearMatchMarkers();
  nextTick(() => {
    if (revision !== matchRevision) return;
    refreshMatches({ scroll: Boolean(query.value.trim()) });
    fitResults();
  });
});

watch([() => props.contentKey, () => `${controls.aircraftCommandCatalogue.profileKey}:${controls.aircraftCommandCatalogue.profileRevision}`], () => {
  collapseSearch({ focusLauncher: searchOwnsFocus() });
});

watch(() => controls.aircraftCommandCatalogue, async catalogue => {
  const previousFocus = typeof document === 'undefined' ? null : document.activeElement;
  const id = previousFocus?.closest?.('[data-aircraft-search-result]')?.dataset.aircraftSearchResult;
  if (!id || !searchRoot.value?.contains(previousFocus) || catalogue.commands[id]) return;
  const revision = ++focusRevision;
  await nextTick();
  if (revision === focusRevision && expanded.value && aircraftPageIsActive() && !modalDialogIsOpen()
    && (document.activeElement === previousFocus || document.activeElement === document.body)) {
    searchInput.value?.focus?.({ preventScroll: true });
  }
});

onBeforeUnmount(() => { ++focusRevision; ++matchRevision; clearMatchMarkers(); });
defineExpose({ open: () => expandSearch(), close: collapseSearch,
  restoreFocus: target => {
    if (!expanded.value || !aircraftPageIsActive() || modalDialogIsOpen()) return false;
    const destination = target?.isConnected && searchRoot.value?.contains(target) && target.getClientRects().length
      ? target : searchInput.value;
    destination?.focus?.({ preventScroll: true });
    return Boolean(destination);
  },
});
</script>

<template>
  <div
    ref="searchRoot"
    class="aircraft-find"
    :style="{ '--aircraft-search-results-height': resultsHeight }"
    :class="{
      'aircraft-find--expanded': expanded,
    }"
    role="search"
    aria-label="Find on Aircraft page"
    data-no-swipe
  >
    <button
      v-show="!expanded"
      ref="searchLauncher"
      type="button"
      class="aircraft-find__launcher"
      aria-label="Find controls"
      title="Find controls (Ctrl+F)"
      aria-controls="aircraft-find-panel"
      :aria-expanded="expanded"
      @click="expandSearch()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m21 21-4.35-4.35m2.35-5.4A7.75 7.75 0 1 1 3.5 11.25a7.75 7.75 0 0 1 15.5 0Z" />
      </svg>
      <span>Find controls</span>
      <kbd class="aircraft-find__shortcut" aria-hidden="true">Ctrl F</kbd>
    </button>

    <div
      id="aircraft-find-panel"
      v-show="expanded"
      class="aircraft-find__panel"
      @keydown="handlePanelKeydown"
    >
      <div class="aircraft-find__row" :class="{ 'aircraft-find__row--commands': mode === 'commands' }">
        <div class="aircraft-find__field">
          <label class="sr-only" for="aircraft-find-input">Find a control, preset or value</label>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m21 21-4.35-4.35m2.35-5.4A7.75 7.75 0 1 1 3.5 11.25a7.75 7.75 0 0 1 15.5 0Z" />
          </svg>
          <input
            id="aircraft-find-input"
            ref="searchInput"
            v-model="query"
            type="search"
            inputmode="search"
            enterkeyhint="search"
            autocomplete="off"
            spellcheck="false"
            :placeholder="mode === 'commands' ? 'Find controls, presets or voice phrases...' : 'Find a switch, light, or value...'"
            aria-describedby="aircraft-find-status"
            @keydown="handleSearchKeydown"
          >
          <button
            v-if="query"
            type="button"
            class="aircraft-find__clear"
            aria-label="Clear Aircraft search"
            title="Clear search"
            @click="clearSearch({ focus: true })"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
          </button>
        </div>

        <div v-show="mode === 'page'" class="aircraft-find__navigation" aria-label="Search result navigation">
          <button
            type="button"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            :disabled="matches.length === 0"
            @click="moveMatch(-1)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next match (Enter)"
            :disabled="matches.length === 0"
            @click="moveMatch(1)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </div>

        <button
          type="button"
          class="aircraft-find__collapse"
          aria-label="Close Aircraft search"
          title="Close search"
          @click="collapseSearch"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
        </button>
      </div>

      <div class="aircraft-find__summary">
        <div
          id="aircraft-find-status"
          class="aircraft-find__status"
          :class="{ 'aircraft-find__status--empty': query && (mode === 'commands' ? !commandMatches.length : !matches.length) }"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span>{{ resultText }}</span>
          <span v-if="resultDetail" class="aircraft-find__detail">{{ resultDetail }}</span>
          <span v-else-if="mode === 'page' && query && matches.length" class="aircraft-find__detail">Enter for next</span>
        </div>
        <button v-if="mode === 'commands'" type="button" class="aircraft-find__link aircraft-find__switch" data-aircraft-search-mode="page" @click="selectMode('page')">Find cockpit values</button>
        <button v-else type="button" class="aircraft-find__link aircraft-find__switch" data-aircraft-search-mode="commands" @click="selectMode('commands')">Back to controls and presets</button>
      </div>
      <template v-if="mode === 'commands'">
        <button v-if="!query.trim()" type="button" class="aircraft-find__link" @click="openCommand(null, $event)">Open Control library</button>
        <ul v-else-if="commandMatches.length" class="aircraft-find__results" aria-label="Matching commands and presets">
          <li v-for="command in commandMatches" :key="command.id" :data-aircraft-search-result="command.id">
            <div class="aircraft-find__result-copy">
              <div class="aircraft-find__result-heading"><h3>{{ command.label }}</h3><span>{{ command.kind === 'preset' ? 'Preset' : 'Control' }}</span></div>
              <p v-if="command.description">{{ command.description }}</p>
              <p v-if="controls.commandVoiceExample(command)" class="aircraft-find__voice">Say “{{ controls.commandVoiceExample(command) }}”</p>
              <p v-if="controls.commandUnavailableReason(command.id)" class="aircraft-find__reason">{{ controls.commandUnavailableReason(command.id) }}</p>
            </div>
            <button type="button" class="aircraft-find__link" :aria-label="`${command.kind === 'preset' ? 'Show preset' : 'Open in Control library'}: ${command.label}`" @click="openCommand(command, $event)">{{ command.kind === 'preset' ? 'Show preset' : 'Open in Control library' }}</button>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style>
.aircraft-find {
  position: relative;
  z-index: 35;
  display: flex;
  width: max-content;
  max-width: 100%;
  min-height: 2.75rem;
  align-items: flex-start;
  justify-content: flex-end;
  overflow: visible;
  pointer-events: none;
}

.aircraft-find--expanded {
  width: min(38rem, calc(100vw - 2rem));
}

.aircraft-find__panel {
  display: grid;
  width: 100%;
  gap: 0.45rem;
  padding: 0.6rem;
  border: 1px solid rgb(var(--border) / 0.82);
  border-radius: var(--ff-radius-card, 0.5rem);
  background: rgb(var(--panel));
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.28), inset 0 1px 0 rgb(255 255 255 / 0.04);
  backdrop-filter: blur(16px);
  pointer-events: auto;
}

.aircraft-find__summary { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .75rem; }
.aircraft-find__summary .aircraft-find__status { flex: 1 1 auto; }
.aircraft-find__link { min-height: 2.75rem; padding: .5rem .7rem; border-radius: 4px; font-size: .8125rem; text-align: left; color: rgb(var(--foreground)); }
.aircraft-find__link { color: rgb(var(--primary)); text-decoration: underline; text-underline-offset: .2rem; }
.aircraft-find__switch { max-width: 100%; padding-inline: .15rem; color: rgb(var(--muted-foreground)); }
.aircraft-find__link:hover { background: rgb(var(--primary) / .08); }
.aircraft-find__link:focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 2px; }
.aircraft-find__results { margin: 0; padding: 0 .25rem; list-style: none; max-height: min(24rem, 45dvh, var(--aircraft-search-results-height, 45dvh)); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.aircraft-find__results li { display: flex; align-items: center; gap: 1rem; padding: .75rem .25rem; border-top: 1px solid rgb(var(--border) / .6); }
.aircraft-find__result-copy { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.aircraft-find__result-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: .5rem; }
.aircraft-find__result-heading h3 { color: rgb(var(--foreground)); font-size: .875rem; font-weight: 600; }
.aircraft-find__result-heading span { color: rgb(var(--muted-foreground)); font-size: .6875rem; }
.aircraft-find__results p { margin: .25rem 0 0; color: rgb(var(--muted-foreground)); font-size: .75rem; line-height: 1.5; }
.aircraft-find__results .aircraft-find__voice { color: rgb(var(--foreground)); }
.aircraft-find__results .aircraft-find__reason { color: rgb(var(--warning)); }
.aircraft-find__results .aircraft-find__link { flex: 0 0 auto; max-width: 12rem; }

.aircraft-find__launcher {
  display: inline-flex;
  width: auto;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  padding: 0.4rem 0.65rem;
  border: 1px solid rgb(var(--border) / 0.65);
  border-radius: 6px;
  background: rgb(var(--panel) / 0.7);
  color: rgb(var(--foreground));
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.01em;
  pointer-events: auto;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, transform 100ms ease;
}

.aircraft-find__launcher > span {
  display: inline;
  white-space: nowrap;
}

.aircraft-find__launcher > .aircraft-find__shortcut {
  display: inline-flex;
}

.aircraft-find__launcher > svg {
  width: 1.1rem;
  height: 1.1rem;
  flex: 0 0 auto;
  fill: none;
  stroke: rgb(var(--selection));
  stroke-linecap: round;
  stroke-width: 1.8;
}

.aircraft-find__row {
  display: flex;
  gap: 0.5rem;
}

.aircraft-find__field {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 2.75rem;
  align-items: center;
  gap: 0.55rem;
  padding: 0 0.65rem;
  border: 1px solid rgb(var(--border) / 0.9);
  border-radius: 0.55rem;
  background: rgb(var(--panel-subtle) / 0.94);
  transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
}

.aircraft-find__field:focus-within {
  border-color: rgb(var(--primary) / 0.78);
  background: rgb(var(--card) / 0.98);
  box-shadow: 0 0 0 3px rgb(var(--primary) / 0.12);
}

.aircraft-find__field > svg {
  width: 1.05rem;
  height: 1.05rem;
  flex: 0 0 auto;
  fill: none;
  stroke: rgb(var(--primary));
  stroke-width: 1.8;
  stroke-linecap: round;
}

.aircraft-find__field input {
  align-self: stretch;
  width: 100%;
  min-width: 0;
  min-height: 2.75rem;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: rgb(var(--foreground));
  font-size: 0.875rem;
  line-height: 1.25;
}

.aircraft-find__field input::placeholder {
  color: rgb(var(--muted-foreground)) !important;
}

.aircraft-find__field input::-webkit-search-cancel-button {
  display: none;
}

.aircraft-find__shortcut {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  min-height: 1.5rem;
  padding: 0 0.42rem;
  border: 1px solid rgb(var(--border));
  border-radius: 0.35rem;
  background: rgb(var(--surface) / 0.7);
  color: rgb(var(--muted-foreground));
  font-family: var(--ff-font-mono);
  font-size: 0.6rem;
}

.aircraft-find__clear,
.aircraft-find__collapse,
.aircraft-find__navigation button {
  display: inline-grid;
  min-width: 2.75rem;
  min-height: 2.75rem;
  place-items: center;
  border: 1px solid rgb(var(--border) / 0.9);
  border-radius: 0.55rem;
  background: rgb(var(--panel-subtle) / 0.94);
  color: rgb(var(--muted-foreground));
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, transform 100ms ease;
}

.aircraft-find__clear {
  min-width: 2.75rem;
  min-height: 2.75rem;
  flex: 0 0 2.75rem;
  border: 0;
  background: transparent;
}

.aircraft-find__collapse {
  flex: 0 0 2.75rem;
}

.aircraft-find__clear:hover,
.aircraft-find__collapse:hover,
.aircraft-find__launcher:hover,
.aircraft-find__navigation button:hover:not(:disabled) {
  border-color: rgb(var(--primary) / 0.62);
  background: rgb(var(--primary) / 0.08);
  color: rgb(var(--primary));
}

.aircraft-find__navigation button:active:not(:disabled) {
  transform: scale(0.96);
}

.aircraft-find__launcher:active {
  transform: scale(0.98);
}

.aircraft-find__navigation button:focus-visible,
.aircraft-find__collapse:focus-visible,
.aircraft-find__launcher:focus-visible,
.aircraft-find__clear:focus-visible {
  outline: 2px solid rgb(var(--primary));
  outline-offset: 2px;
}

.aircraft-find__navigation button:disabled {
  cursor: default;
  opacity: 0.38;
}

.aircraft-find__clear svg,
.aircraft-find__collapse svg,
.aircraft-find__navigation svg {
  width: 1.1rem;
  height: 1.1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.aircraft-find__navigation {
  display: grid;
  grid-template-columns: repeat(2, 2.75rem);
  gap: 0.4rem;
}

.aircraft-find__status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 1rem;
  padding: 0 0.15rem;
  color: rgb(var(--muted-foreground));
  font-family: var(--ff-font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.03em;
}

.aircraft-find__status--empty {
  color: rgb(var(--warning));
}

.aircraft-find__detail {
  text-align: right;
  opacity: 0.75;
}

[data-aircraft-find-match="true"] {
  outline: 1px solid rgb(var(--primary) / 0.48) !important;
  outline-offset: 2px;
  background-image: linear-gradient(rgb(var(--primary) / 0.045), rgb(var(--primary) / 0.045));
  scroll-margin-top: 10rem;
}

[data-aircraft-find-current="true"] {
  outline: 2px solid rgb(var(--primary) / 0.95) !important;
  outline-offset: 3px;
  box-shadow: 0 0 0 5px rgb(var(--primary) / 0.1), 0 12px 30px rgb(0 0 0 / 0.22) !important;
}

@media (max-width: 640px) {
  .aircraft-find__results li { align-items: stretch; flex-direction: column; gap: .25rem; }
  .aircraft-find__results .aircraft-find__link { align-self: flex-start; max-width: 100%; }
  .aircraft-find {
    width: max-content;
    margin-inline: 0;
  }

  .aircraft-find--expanded {
    width: 100%;
  }

  .aircraft-find__panel {
    width: 100%;
    padding: 0.5rem;
    box-shadow: none;
    backdrop-filter: none;
  }

  .aircraft-find__shortcut {
    display: none;
  }

  .aircraft-find__field input {
    font-size: 1rem;
  }

  .aircraft-find__launcher > .aircraft-find__shortcut {
    display: none;
  }

  .aircraft-find__status {
    align-items: flex-start;
    font-size: 0.62rem;
  }

  .aircraft-find__detail {
    max-width: 64%;
  }

  [data-aircraft-find-match="true"] {
    scroll-margin-top: 6rem;
  }
}

@media (max-width: 480px) {
  .aircraft-find__row.aircraft-find__row--commands { display: flex; }
  .aircraft-find__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .aircraft-find__field {
    grid-column: 1 / -1;
  }

  .aircraft-find__navigation {
    grid-column: 1;
    grid-row: 2;
    justify-self: start;
  }

  .aircraft-find__collapse {
    grid-column: 2;
    grid-row: 2;
  }
}

@media (prefers-reduced-motion: reduce) {
  .aircraft-find *,
  [data-aircraft-find-match="true"] {
    scroll-behavior: auto !important;
    transition: none !important;
  }
}
</style>
