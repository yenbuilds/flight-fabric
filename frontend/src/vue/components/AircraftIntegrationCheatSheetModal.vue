<script setup>
import {
  computed,
  nextTick,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useBodyClass } from '../composables/useBodyClass.js';
import { useDocumentEvent } from '../composables/useDocumentEvent.js';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  initialFilter: { type: String, default: 'all' },
});

const emit = defineEmits(['close']);
const aircraftControls = useAircraftControlsStore();
const aircraftSpecific = useAircraftSpecificStore();
const mounted = ref(false);
const panelRef = ref(null);
const closeButtonRef = ref(null);
const searchQuery = ref('');
const activeFilter = ref('all');

const GROUP_LABELS = Object.freeze({
  flightGuidance: 'Flight guidance',
  mcp: 'Mode control panel',
  afds: 'Autoflight and flight directors',
  radios: 'Radios',
  surfaces: 'Flight controls',
  flightControls: 'Flight controls',
  gear: 'Landing gear and brakes',
  lights: 'Exterior lights',
  lighting: 'Cockpit lighting',
  configuration: 'Presets',
  presets: 'Presets',
  propulsion: 'Engines and thrust',
  engines: 'Engines',
  electrical: 'Electrical',
  fuel: 'Fuel',
  hydraulics: 'Hydraulics',
  pneumatics: 'Pneumatics and air',
  air: 'Air systems',
  doors: 'Doors',
  navigation: 'Navigation',
  efis: 'EFIS',
  displays: 'Displays',
  overhead: 'Overhead panel',
  pedestal: 'Pedestal',
  warnings: 'Warnings',
  misc: 'Other systems',
});

const GROUP_ORDER = Object.freeze([
  'presets',
  'configuration',
  'flightGuidance',
  'mcp',
  'afds',
  'radios',
  'surfaces',
  'flightControls',
  'gear',
  'lights',
  'lighting',
  'propulsion',
  'engines',
  'fuel',
  'electrical',
  'hydraulics',
  'pneumatics',
  'air',
  'navigation',
  'efis',
  'displays',
  'overhead',
  'pedestal',
  'doors',
  'warnings',
  'misc',
]);

const UNIT_LABELS = Object.freeze({
  degrees: 'deg',
  feet: 'ft',
  'feet-per-minute': 'ft/min',
  knots: 'kt',
  mach: 'Mach',
  megahertz: 'MHz',
  percent: '%',
});

const ACRONYMS = Object.freeze({
  afds: 'AFDS',
  apu: 'APU',
  capt: 'CAPT',
  efis: 'EFIS',
  fo: 'FO',
  ias: 'IAS',
  irs: 'IRS',
  mcp: 'MCP',
  mfd: 'MFD',
  nav: 'NAV',
  vor: 'VOR',
});

const FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'voice', label: 'Voice' },
  { id: 'preset', label: 'Presets' },
  { id: 'control', label: 'Controls' },
  { id: 'readback', label: 'Readbacks' },
]);

function requestedInitialFilter() {
  return FILTERS.some((filter) => filter.id === props.initialFilter)
    ? props.initialFilter
    : 'all';
}

function humanize(value) {
  const words = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] || word.toLowerCase());
  if (words.length === 0) return 'Other';
  const label = words.join(' ');
  return `${label[0].toUpperCase()}${label.slice(1)}`;
}

function groupIdFor(id, explicitGroup = '') {
  return explicitGroup || String(id || '').split('.')[0] || 'misc';
}

function settingLabel(id) {
  const segments = String(id || '').split('.');
  return humanize(segments.slice(1).join(' ') || segments[0]);
}

function speechPatterns(item) {
  return [...new Set((Array.isArray(item?.speech?.patterns) ? item.speech.patterns : [])
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => pattern.trim().slice(0, 160).replaceAll('{value}', '<value>'))
    .filter(Boolean))].slice(0, 12);
}

function inputLabel(input, id = '') {
  if (!input || input.kind === 'none' || (!input.kind && !input.type)) return 'One action';
  if (input.kind === 'boolean') {
    if (id === 'surfaces.parkingBrake.set') return 'Set / release';
    if (id === 'surfaces.spoilersArmed.set') return 'Arm / disarm';
    return 'On / off';
  }
  if (input.kind === 'enum') {
    const values = Array.isArray(input.values) ? input.values.slice(0, 24) : [];
    return values.length ? values.join(' · ') : 'Select a value';
  }
  if (input.kind === 'number' || input.type === 'number') {
    const min = Number(input.min);
    const max = Number(input.max);
    const step = Number(input.step);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Numeric value';
    const units = UNIT_LABELS[input.units] || String(input.units || '').replaceAll('-', ' ');
    const range = `${min.toLocaleString()}–${max.toLocaleString()}${units ? ` ${units}` : ''}`;
    return Number.isFinite(step) && step > 0 ? `${range} · step ${step}` : range;
  }
  return 'One action';
}

function liveReadbackStatus(id) {
  if (aircraftControls.aircraftIntegration.id === 'generic') {
    return { label: 'Integrated', tone: 'neutral' };
  }
  if (aircraftSpecific.unavailable.includes(id)) {
    return { label: 'Unavailable now', tone: 'muted' };
  }
  if (Object.prototype.hasOwnProperty.call(aircraftSpecific.values, id)) {
    return { label: 'Live now', tone: 'good' };
  }
  return { label: 'Integrated', tone: 'neutral' };
}

const commandInventory = computed(() => {
  const catalogue = aircraftControls.aircraftCommandCatalogue;
  if (Array.isArray(catalogue.inventory) && catalogue.inventory.length > 0) {
    return catalogue.inventory;
  }
  return Object.values(catalogue.commands || {}).map((command) => ({
    ...command,
    supported: true,
    actionIds: [],
  }));
});

const coveredActionIds = computed(() => new Set(
  commandInventory.value.flatMap((command) => (
    Array.isArray(command.actionIds) ? command.actionIds : []
  )),
));

const rows = computed(() => {
  const commandRows = commandInventory.value.map((command) => {
    const patterns = speechPatterns(command);
    const supported = command.supported === true;
    const kind = command.kind === 'preset' ? 'preset' : 'control';
    return {
      id: command.id,
      label: command.label || settingLabel(command.id),
      description: command.description || '',
      group: groupIdFor(command.id, command.group),
      kind,
      kindLabel: kind === 'preset' ? 'Preset' : 'Control',
      input: inputLabel(command.input, command.id),
      patterns,
      voiceSupported: supported && patterns.length > 0,
      status: supported
        ? { label: 'Supported', tone: 'good' }
        : { label: 'Not available', tone: 'muted' },
    };
  });

  const actionRows = (aircraftControls.aircraftIntegration.actions || [])
    .filter((action) => !coveredActionIds.value.has(action.id))
    .map((action) => ({
      id: action.id,
      label: settingLabel(action.id),
      description: action.verification === 'verified'
        ? 'Verified aircraft-specific control.'
        : (action.verification === 'partial'
          ? 'Aircraft-specific control with partial verification.'
          : 'Aircraft-specific control awaiting in-simulator verification.'),
      group: groupIdFor(action.id),
      kind: 'control',
      kindLabel: 'Control',
      input: inputLabel(action.input, action.id),
      patterns: [],
      voiceSupported: false,
      status: action.supported
        ? { label: 'Supported', tone: 'good' }
        : { label: 'Transport unavailable', tone: 'muted' },
    }));

  const fieldRows = (aircraftControls.aircraftIntegration.fields || []).map((field) => ({
    id: field.id,
    label: settingLabel(field.id),
    description: 'Live aircraft state exposed on this page.',
    group: groupIdFor(field.id),
    kind: 'readback',
    kindLabel: 'Readback',
    input: 'Display only',
    patterns: [],
    voiceSupported: false,
    status: liveReadbackStatus(field.id),
  }));

  return [...commandRows, ...actionRows, ...fieldRows];
});

const summary = computed(() => ({
  total: rows.value.length,
  controls: rows.value.filter((row) => row.kind === 'control').length,
  presets: rows.value.filter((row) => row.kind === 'preset').length,
  readbacks: rows.value.filter((row) => row.kind === 'readback').length,
  voice: rows.value.filter((row) => row.voiceSupported).length,
}));

const aircraftLabel = computed(() => {
  const integration = aircraftControls.aircraftIntegration;
  if (integration.family) {
    return integration.vendor ? `${integration.vendor} ${integration.family}` : integration.family;
  }
  const configurationId = aircraftControls.aircraftCommandCatalogue.configurationId;
  return configurationId === 'generic' ? 'Generic aircraft' : humanize(configurationId || 'Aircraft');
});

const filteredRows = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return rows.value.filter((row) => {
    if (activeFilter.value === 'voice' && !row.voiceSupported) return false;
    if (['preset', 'control', 'readback'].includes(activeFilter.value) && row.kind !== activeFilter.value) {
      return false;
    }
    if (!query) return true;
    return [
      row.label,
      row.id,
      row.description,
      humanize(row.group),
      ...row.patterns,
    ].join(' ').toLowerCase().includes(query);
  });
});

const groups = computed(() => {
  const grouped = new Map();
  for (const row of filteredRows.value) {
    if (!grouped.has(row.group)) grouped.set(row.group, []);
    grouped.get(row.group).push(row);
  }
  return [...grouped.entries()]
    .map(([id, items]) => ({
      id,
      label: GROUP_LABELS[id] || humanize(id),
      items: items.sort((left, right) => (
        (left.kind === 'preset' ? -1 : 0) - (right.kind === 'preset' ? -1 : 0)
        || left.label.localeCompare(right.label)
      )),
    }))
    .sort((left, right) => {
      const leftIndex = GROUP_ORDER.indexOf(left.id);
      const rightIndex = GROUP_ORDER.indexOf(right.id);
      const leftRank = leftIndex < 0 ? GROUP_ORDER.length : leftIndex;
      const rightRank = rightIndex < 0 ? GROUP_ORDER.length : rightIndex;
      return leftRank - rightRank || left.label.localeCompare(right.label);
    });
});

function statusClass(tone) {
  if (tone === 'good') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300';
  if (tone === 'muted') return 'border-white/10 bg-white/[0.03] text-gray-400';
  return 'border-sky-400/20 bg-sky-400/10 text-sky-200';
}

function closeModal() {
  emit('close');
}

function handleKeydown(event) {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(panelRef.value?.querySelectorAll?.(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  ) || []);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    searchQuery.value = '';
    activeFilter.value = requestedInitialFilter();
    nextTick(() => closeButtonRef.value?.focus?.({ preventScroll: true }));
  },
  { immediate: true },
);

useBodyClass(() => props.open, 'ff-dialog-open');
useDocumentEvent('keydown', handleKeydown);
onMounted(() => { mounted.value = true; });
</script>

<template>
  <Teleport to="body" :disabled="!mounted">
    <div
      v-if="open"
      id="aircraft-integration-cheatsheet-modal"
      class="fixed inset-0 z-[260] flex items-center justify-center bg-black/75 p-0 backdrop-blur-sm sm:p-4"
      data-aircraft-integration-cheatsheet-modal
      data-no-swipe
      @click.self="closeModal"
    >
      <section
        ref="panelRef"
        class="flex h-[var(--ff-visual-viewport-height,100dvh)] w-full flex-col overflow-hidden border-white/10 bg-surface-100 shadow-2xl sm:h-auto sm:max-h-[92vh] sm:max-w-7xl sm:rounded-2xl sm:border"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aircraft-integration-cheatsheet-title"
        aria-describedby="aircraft-integration-cheatsheet-description"
      >
        <header class="shrink-0 border-b border-white/10 bg-gradient-to-r from-emerald-500/[0.08] via-transparent to-sky-500/[0.06] px-4 py-4 sm:px-6 sm:py-5">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">Aircraft integration</div>
              <h2 id="aircraft-integration-cheatsheet-title" class="mt-1 truncate text-xl font-semibold text-white sm:text-2xl">
                {{ aircraftLabel }} cheatsheet
              </h2>
              <p id="aircraft-integration-cheatsheet-description" class="mt-1 max-w-3xl text-xs leading-5 text-muted-fg sm:text-sm">
                Every mapped control, preset and readback for the active aircraft. Voice support is derived from the same command catalogue used by speech control.
              </p>
            </div>
            <button
              ref="closeButtonRef"
              type="button"
              class="ff-touch-target shrink-0 rounded-lg p-2 text-gray-300 hover:bg-white/10 hover:text-white"
              aria-label="Close aircraft integration cheatsheet"
              @click="closeModal"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <div class="rounded-lg border border-white/10 bg-black/15 px-3 py-2">
              <div class="text-lg font-semibold text-white">{{ summary.total }}</div>
              <div class="text-[10px] uppercase tracking-wider text-muted-fg">Total</div>
            </div>
            <div class="rounded-lg border border-white/10 bg-black/15 px-3 py-2">
              <div class="text-lg font-semibold text-white">{{ summary.controls }}</div>
              <div class="text-[10px] uppercase tracking-wider text-muted-fg">Controls</div>
            </div>
            <div class="rounded-lg border border-white/10 bg-black/15 px-3 py-2">
              <div class="text-lg font-semibold text-white">{{ summary.presets }}</div>
              <div class="text-[10px] uppercase tracking-wider text-muted-fg">Presets</div>
            </div>
            <div class="rounded-lg border border-white/10 bg-black/15 px-3 py-2">
              <div class="text-lg font-semibold text-white">{{ summary.readbacks }}</div>
              <div class="text-[10px] uppercase tracking-wider text-muted-fg">Readbacks</div>
            </div>
            <div class="col-span-2 rounded-lg border border-accent/20 bg-accent/[0.06] px-3 py-2 sm:col-span-1">
              <div class="text-lg font-semibold text-accent">{{ summary.voice }}</div>
              <div class="text-[10px] uppercase tracking-wider text-accent/80">Voice enabled</div>
            </div>
          </div>
        </header>

        <div class="shrink-0 border-b border-white/10 px-4 py-3 sm:px-6">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <label class="relative block min-w-0 flex-1 lg:max-w-md">
              <span class="sr-only">Search aircraft integration</span>
              <svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke-width="2" />
                <path d="m20 20-3.5-3.5" stroke-width="2" stroke-linecap="round" />
              </svg>
              <input
                v-model="searchQuery"
                type="search"
                class="h-10 w-full rounded-lg border border-white/10 bg-black/20 pl-9 pr-3 text-sm text-white outline-none placeholder:text-gray-600 focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
                placeholder="Find a control, system, or voice phrase…"
              >
            </label>
            <div class="flex gap-1 overflow-x-auto pb-1 lg:pb-0" aria-label="Filter integration settings">
              <button
                v-for="filter in FILTERS"
                :key="filter.id"
                type="button"
                class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition"
                :class="activeFilter === filter.id
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-white/10 bg-white/[0.02] text-gray-400 hover:border-white/20 hover:text-white'"
                :aria-pressed="activeFilter === filter.id"
                @click="activeFilter = filter.id"
              >
                {{ filter.label }}
              </button>
            </div>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div v-if="groups.length" class="space-y-7">
            <section
              v-for="group in groups"
              :key="group.id"
              :aria-labelledby="`integration-group-${group.id}`"
              :data-aircraft-integration-group="group.id"
            >
              <div class="mb-3 flex items-center gap-3">
                <h3 :id="`integration-group-${group.id}`" class="text-sm font-semibold text-white">
                  {{ group.label }}
                </h3>
                <span class="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted-fg">
                  {{ group.items.length }}
                </span>
                <div class="h-px flex-1 bg-white/[0.07]" />
              </div>

              <div class="hidden overflow-hidden rounded-xl border border-white/10 md:block">
                <table class="w-full table-fixed border-collapse text-left">
                  <thead class="bg-white/[0.035] text-[10px] font-semibold uppercase tracking-wider text-muted-fg">
                    <tr>
                      <th class="w-[34%] px-4 py-3">Setting</th>
                      <th class="w-[12%] px-3 py-3">Type</th>
                      <th class="w-[22%] px-3 py-3">Values</th>
                      <th class="w-[19%] px-3 py-3">Voice</th>
                      <th class="w-[13%] px-3 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-white/[0.07] bg-black/10">
                    <tr v-for="row in group.items" :key="`${row.kind}:${row.id}`" class="align-top hover:bg-white/[0.025]">
                      <td class="px-4 py-3">
                        <div class="font-medium text-gray-100">{{ row.label }}</div>
                        <div v-if="row.description" class="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-fg">{{ row.description }}</div>
                        <code class="mt-1.5 block break-all text-[10px] text-gray-500">{{ row.id }}</code>
                      </td>
                      <td class="px-3 py-3">
                        <span class="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-300">
                          {{ row.kindLabel }}
                        </span>
                      </td>
                      <td class="px-3 py-3 text-xs leading-5 text-gray-300">{{ row.input }}</td>
                      <td class="px-3 py-3">
                        <template v-if="row.voiceSupported">
                          <div class="flex items-center gap-1.5 text-xs font-medium text-accent">
                            <span class="h-1.5 w-1.5 rounded-full bg-accent" /> Voice
                          </div>
                          <code class="mt-1.5 block text-[10px] leading-4 text-gray-400">{{ row.patterns[0] }}</code>
                        </template>
                        <span v-else class="text-xs text-gray-500">Not supported</span>
                      </td>
                      <td class="px-3 py-3">
                        <span class="inline-flex rounded-full border px-2 py-1 text-[10px] font-medium" :class="statusClass(row.status.tone)">
                          {{ row.status.label }}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="grid gap-2 md:hidden">
                <article
                  v-for="row in group.items"
                  :key="`${row.kind}:${row.id}:mobile`"
                  class="rounded-xl border border-white/10 bg-black/10 p-3"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="font-medium text-gray-100">{{ row.label }}</div>
                      <code class="mt-1 block break-all text-[10px] text-gray-500">{{ row.id }}</code>
                    </div>
                    <span class="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-gray-400">
                      {{ row.kindLabel }}
                    </span>
                  </div>
                  <p v-if="row.description" class="mt-2 text-xs leading-5 text-muted-fg">{{ row.description }}</p>
                  <div class="mt-3 grid grid-cols-2 gap-3 border-t border-white/[0.07] pt-3 text-xs">
                    <div>
                      <div class="text-[9px] font-semibold uppercase tracking-wider text-gray-500">Values</div>
                      <div class="mt-1 text-gray-300">{{ row.input }}</div>
                    </div>
                    <div>
                      <div class="text-[9px] font-semibold uppercase tracking-wider text-gray-500">Voice</div>
                      <div class="mt-1" :class="row.voiceSupported ? 'text-accent' : 'text-gray-500'">
                        {{ row.voiceSupported ? row.patterns[0] : 'Not supported' }}
                      </div>
                    </div>
                  </div>
                  <div class="mt-3">
                    <span class="inline-flex rounded-full border px-2 py-1 text-[10px] font-medium" :class="statusClass(row.status.tone)">
                      {{ row.status.label }}
                    </span>
                  </div>
                </article>
              </div>
            </section>
          </div>

          <div v-else class="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 px-6 text-center">
            <div class="text-sm font-medium text-gray-300">No matching integration settings</div>
            <div class="mt-1 text-xs text-muted-fg">Try another search or filter.</div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
