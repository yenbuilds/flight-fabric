import { defineStore } from 'pinia';

const SOURCE_META = Object.freeze({
  simconnect: { name: 'SimConnect', color: 'simconnect' },
  lvar: { name: 'LVAR', color: 'lvar' },
  derived: { name: 'Derived', color: 'derived' },
});

const MAX_DEBUG_VARIABLES = 1000;
const MAX_DEBUG_VALUE_PREVIEW_CHARS = 500;
const MAX_DEBUG_FLATTEN_DEPTH = 12;
const DEBUG_PREVIEW_MARKER = '__flightFabricDebugPreview';

function createDefaultConnectionState() {
  return {
    modalOpen: false,
    toggleVisible: false,
    connectionKnown: false,
    simConnected: false,
    filterText: '',
    showNull: false,
    showStale: true,
    paused: false,
    pollRates: [],
    pollRateHz: null,
    frameCount: 0,
    phase: '--',
    testShakeVs: '-400',
    testShakeStatus: '',
    testShakeRequestNonce: 0,
    lastFrameTime: 0,
    renderTick: 0,
    collapsedSources: {
      simconnect: false,
      lvar: false,
      derived: false,
    },
    variables: {},
  };
}

function flattenObject(obj, prefix = '') {
  const result = Object.create(null);
  let fieldCount = 0;

  function visit(value, currentPrefix, depth) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return;

    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (depth === 0 && key === 'type') continue;
      if (fieldCount >= MAX_DEBUG_VARIABLES) return;

      const childValue = value[key];
      const fullKey = currentPrefix ? `${currentPrefix}.${key}` : key;
      const nestedObject = childValue
        && typeof childValue === 'object'
        && !Array.isArray(childValue)
        && !(childValue instanceof Date);

      if (nestedObject && depth < MAX_DEBUG_FLATTEN_DEPTH) {
        visit(childValue, fullKey, depth + 1);
        continue;
      }

      result[fullKey] = childValue;
      fieldCount += 1;
    }
  }

  visit(obj, prefix, 0);
  return result;
}

function inferSource(key) {
  if (/^L:/i.test(key) || /\.lvar/i.test(key) || /lvar/i.test(key)) return 'lvar';
  if (key.includes('display') || key.includes('Trend') || key.includes('Score') || key === 'phase' || key === 'crosswind') {
    return 'derived';
  }
  if (key.startsWith('assist')) return 'simconnect';
  return 'simconnect';
}

function formatValue(value) {
  if (value && typeof value === 'object' && value[DEBUG_PREVIEW_MARKER] === true) {
    return { text: value.text, cls: '' };
  }
  if (value === null || value === undefined) return { text: 'null', cls: 'null' };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', cls: value ? 'bool-true' : 'bool-false' };
  if (typeof value === 'number') return { text: Number.isInteger(value) ? String(value) : value.toFixed(4), cls: '' };
  if (typeof value === 'string') return { text: `"${value}"`, cls: '' };
  if (typeof value === 'object') return { text: JSON.stringify(value).slice(0, 40), cls: '' };
  return { text: String(value), cls: '' };
}

function snapshotDebugValue(value) {
  if (typeof value === 'string' && value.length > MAX_DEBUG_VALUE_PREVIEW_CHARS) {
    return `${value.slice(0, MAX_DEBUG_VALUE_PREVIEW_CHARS)}...`;
  }
  if (!value || typeof value !== 'object') return value;

  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = '[unserializable array]';
  }

  if (text.length > MAX_DEBUG_VALUE_PREVIEW_CHARS) {
    text = `${text.slice(0, MAX_DEBUG_VALUE_PREVIEW_CHARS)}...`;
  }

  return {
    [DEBUG_PREVIEW_MARKER]: true,
    text,
  };
}

function debugValuesEqual(left, right) {
  const leftIsPreview = left && typeof left === 'object' && left[DEBUG_PREVIEW_MARKER] === true;
  const rightIsPreview = right && typeof right === 'object' && right[DEBUG_PREVIEW_MARKER] === true;
  if (leftIsPreview || rightIsPreview) {
    return leftIsPreview && rightIsPreview && left.text === right.text;
  }
  return left === right;
}

function trimDebugVariables(variables) {
  const entries = Object.entries(variables);
  if (entries.length <= MAX_DEBUG_VARIABLES) return variables;

  entries.sort(([, left], [, right]) => (right?.lastSeen || 0) - (left?.lastSeen || 0));
  return Object.fromEntries(entries.slice(0, MAX_DEBUG_VARIABLES));
}

function formatAge(ms) {
  if (ms < 100) return { text: 'now', cls: 'fresh' };
  if (ms < 1000) return { text: `${ms}ms`, cls: 'fresh' };
  if (ms < 5000) return { text: `${(ms / 1000).toFixed(1)}s`, cls: '' };
  return { text: `${(ms / 1000).toFixed(0)}s`, cls: '' };
}

export const useDebugStore = defineStore('debug', {
  state: () => createDefaultConnectionState(),

  getters: {
    modalClass: (state) => [
      'fixed inset-0 z-[200] bg-black overflow-hidden',
      state.modalOpen ? '' : 'hidden',
    ].filter(Boolean).join(' '),

    statusDotClass: (state) => {
      if (!state.connectionKnown) return 'w-2 h-2 rounded-full bg-red-500';
      return state.simConnected
        ? 'w-2 h-2 rounded-full bg-green-500'
        : 'w-2 h-2 rounded-full bg-yellow-500';
    },

    statusText: (state) => {
      if (!state.connectionKnown) return 'Disconnected';
      return state.simConnected ? 'SimConnect Active' : 'WS Only (No Sim)';
    },

    pollRateLabel: (state) => (
      Number.isFinite(state.pollRateHz) ? state.pollRateHz.toFixed(1) : '--'
    ),

    totalVarCount: (state) => Object.keys(state.variables || {}).length,

    activeVarCount(state) {
      void state.renderTick;
      const now = Date.now();
      return Object.values(state.variables || {}).reduce((count, variable) => (
        count + (now - (variable?.lastSeen || 0) < 5000 ? 1 : 0)
      ), 0);
    },

    sourceSections(state) {
      void state.renderTick;
      const now = Date.now();
      const filter = String(state.filterText || '').toLowerCase();
      const grouped = {
        simconnect: [],
        lvar: [],
        derived: [],
      };

      for (const [key, variable] of Object.entries(state.variables || {})) {
        const source = SOURCE_META[variable?.source] ? variable.source : 'simconnect';
        grouped[source].push({ key, ...variable });
      }

      return Object.entries(SOURCE_META).reduce((sections, [sourceKey, meta]) => {
        const vars = grouped[sourceKey] || [];
        if (vars.length === 0) return sections;

        const rows = vars
          .filter((variable) => {
            if (filter && !variable.key.toLowerCase().includes(filter)) return false;
            if (!state.showNull && (variable.value === null || variable.value === undefined)) return false;
            if (!state.showStale && now - variable.lastSeen > 5000) return false;
            return true;
          })
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((variable) => {
            const fmt = formatValue(variable.value);
            const age = formatAge(now - variable.lastSeen);
            return {
              key: variable.key,
              valueText: fmt.text,
              valueClass: fmt.cls,
              ageText: age.text,
              ageClass: age.cls,
              stale: now - variable.lastSeen > 5000,
              changed: variable.changed === true,
            };
          });

        sections.push({
          key: sourceKey,
          name: meta.name,
          color: meta.color,
          totalCount: vars.length,
          filteredCount: rows.length,
          active: vars.some((variable) => now - variable.lastSeen < 2000),
          collapsed: state.collapsedSources[sourceKey] === true,
          rows,
        });
        return sections;
      }, []);
    },

    emptyStateLabel() {
      if (this.totalVarCount === 0) return 'Waiting for data...';
      return 'No variables match filter';
    },
  },

  actions: {
    setToggleVisible(visible) {
      this.toggleVisible = visible === true;
    },

    setModalOpen(open) {
      const nextOpen = open === true;
      if (this.modalOpen !== nextOpen) this.resetRateSampling();
      this.modalOpen = nextOpen;
    },

    toggleModal() {
      const nextOpen = !this.modalOpen;
      this.setModalOpen(nextOpen);
      return nextOpen;
    },

    setConnectionStatus(connected) {
      this.connectionKnown = true;
      this.simConnected = connected === true;
    },

    setConnectionUnknown() {
      this.connectionKnown = false;
      this.simConnected = false;
    },

    setFilterText(value) {
      this.filterText = String(value || '');
      this.renderTick += 1;
    },

    setShowNull(value) {
      this.showNull = value === true;
      this.renderTick += 1;
    },

    setShowStale(value) {
      this.showStale = value === true;
      this.renderTick += 1;
    },

    setPaused(value) {
      const nextPaused = value === true;
      if (this.paused !== nextPaused) this.resetRateSampling();
      this.paused = nextPaused;
      this.renderTick += 1;
    },

    resetRateSampling() {
      this.pollRates = [];
      this.pollRateHz = null;
      this.lastFrameTime = 0;
    },

    clearCapturedData() {
      this.variables = {};
      this.frameCount = 0;
      this.phase = '--';
      this.resetRateSampling();
      this.renderTick += 1;
    },

    ingestMetadata(message) {
      const phaseValue = message?.type === 'phase' ? message.value : message?.phase;
      if (typeof phaseValue === 'string' && phaseValue.trim()) {
        this.phase = phaseValue;
      }
    },

    setTestShakeVs(value) {
      this.testShakeVs = String(value || '-400');
    },

    requestTestShake() {
      this.testShakeRequestNonce += 1;
    },

    setTestShakeStatus(value) {
      this.testShakeStatus = String(value || '');
      this.renderTick += 1;
    },

    clearTestShakeStatus() {
      this.testShakeStatus = '';
      this.renderTick += 1;
    },

    toggleSourceCollapsed(sourceKey) {
      if (!Object.prototype.hasOwnProperty.call(this.collapsedSources, sourceKey)) return;
      this.collapsedSources[sourceKey] = !this.collapsedSources[sourceKey];
      this.renderTick += 1;
    },

    clearChangedFlags() {
      for (const variable of Object.values(this.variables || {})) {
        if (variable) variable.changed = false;
      }
      this.renderTick += 1;
    },

    ingestFrame(message, now = Date.now()) {
      if (this.paused) return false;

      this.frameCount += 1;
      if (this.lastFrameTime) {
        const delta = now - this.lastFrameTime;
        if (delta > 0) {
          const pollRates = this.pollRates.slice();
          pollRates.push(1000 / delta);
          if (pollRates.length > 20) pollRates.shift();
          this.pollRates = pollRates;
          this.pollRateHz = pollRates.length > 0
            ? pollRates.reduce((sum, value) => sum + value, 0) / pollRates.length
            : null;
        }
      }
      this.lastFrameTime = now;

      this.ingestMetadata(message);
      const flat = flattenObject(message);

      // Normal websocket telemetry arrives as separate packets that reuse generic
      // field names (for example, { type: 'ias', value: 140 } and
      // { type: 'gs', value: 135 }). Qualify those fields by message type so one
      // packet cannot overwrite another. Synthetic combined debug frames already
      // carry meaningful field names and intentionally keep their legacy shape.
      const messageType = typeof message?.type === 'string' ? message.type.trim() : '';
      const keyPrefix = messageType && messageType !== 'debug-frame' ? `${messageType}.` : '';

      const nextVariables = { ...this.variables };
      for (const [rawKey, value] of Object.entries(flat)) {
        if (rawKey === 'type') continue;
        const key = `${keyPrefix}${rawKey}`;
        const existing = nextVariables[key];
        const source = inferSource(key);
        const storedValue = snapshotDebugValue(value);
        const changed = !existing || !debugValuesEqual(existing.value, storedValue);
        nextVariables[key] = {
          value: storedValue,
          source,
          lastSeen: now,
          lastChanged: changed ? now : (existing?.lastChanged || now),
          changed,
        };
      }

      this.variables = trimDebugVariables(nextVariables);
      this.renderTick += 1;
      return true;
    },
  },
});
