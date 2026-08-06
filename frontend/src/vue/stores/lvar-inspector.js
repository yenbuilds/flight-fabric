import { defineStore } from 'pinia';

const MAX_WATCH_ENTRIES = 48;

function toFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function formatLvarValue(value) {
  if (value == null) return '--';
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

export function normalizeLvarDebugWatch(rawList) {
  const entries = Array.isArray(rawList)
    ? rawList
    : String(rawList || '').split(/\r?\n|,/);
  const seen = new Set();
  const normalized = [];

  for (const entry of entries) {
    const trimmed = String(entry || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= MAX_WATCH_ENTRIES) break;
  }

  return normalized;
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function getLvarSource(message) {
  return message?.secondary?.find?.((source) => source && source.type === 'lvar-sidecar') || null;
}

export const useLvarInspectorStore = defineStore('lvarInspector', {
  state: () => ({
    sourceState: 'unknown',
    sourceDescription: '',
    sourceConnected: false,
    profilePreview: [],
    debugWatchItems: [],
    debugWatchCount: 0,
    debugWatchSubscriptions: [],
    watchInputText: '',
    lastUpdatedAt: 0,
  }),

  getters: {
    hasSource: (state) => state.sourceState === 'available',
    profileCount: (state) => state.profilePreview.length,
    configuredDebugWatchCount: (state) => state.debugWatchSubscriptions.length,
    effectiveDebugWatchCount: (state) => {
      const numericCount = toFiniteNumber(state.debugWatchCount);
      return numericCount == null ? state.debugWatchSubscriptions.length : numericCount;
    },
    statusLabel: (state) => {
      if (state.sourceState === 'unknown') return 'Waiting for LVAR source...';
      if (state.sourceState !== 'available') return 'LVAR source not enabled.';
      return state.sourceDescription || (state.sourceConnected ? 'Running' : 'Disconnected');
    },
    headerCountLabel() {
      return `${this.profileCount} profile / ${this.effectiveDebugWatchCount} debug`;
    },
    profileCountLabel() {
      return pluralize(this.profileCount, 'var');
    },
    debugCountLabel() {
      return pluralize(this.effectiveDebugWatchCount, 'var');
    },
    debugSummaryLabel() {
      if (this.configuredDebugWatchCount === 0) return 'No debug watch list.';
      if (this.hasSource) {
        return this.sourceConnected
          ? `${this.configuredDebugWatchCount} configured locally - monitoring live values`
          : `${this.configuredDebugWatchCount} configured locally - sidecar not producing values yet`;
      }
      return 'Watch list saved locally. Connect to the LVAR sidecar to monitor values.';
    },
    previewRows(state) {
      return state.profilePreview.map((item) => ({
        key: String(item?.key || '--'),
        valueText: formatLvarValue(item?.value),
      }));
    },
    debugRows(state) {
      return state.debugWatchItems.map((item) => ({
        expression: String(item?.expression || item?.key || '--').replace(/^\((.*)\)$/, '$1'),
        valueText: formatLvarValue(item?.value),
        liveText: item?.live ? 'LIVE' : '--',
        liveClass: item?.live ? 'text-success' : 'text-gray-500',
      }));
    },
  },

  actions: {
    hydrateWatchList(list) {
      const normalized = normalizeLvarDebugWatch(list);
      this.debugWatchSubscriptions = normalized;
      this.watchInputText = normalized.join('\n');
      this.debugWatchCount = normalized.length;
    },

    setWatchInputText(value) {
      this.watchInputText = String(value || '');
    },

    applyWatchInput() {
      const normalized = normalizeLvarDebugWatch(this.watchInputText);
      this.debugWatchSubscriptions = normalized;
      this.watchInputText = normalized.join('\n');
      this.debugWatchCount = normalized.length;
    },

    clearWatchInput() {
      this.debugWatchSubscriptions = [];
      this.watchInputText = '';
      this.debugWatchCount = 0;
    },

    ingestDataSourcesMessage(message) {
      const lvarSource = getLvarSource(message);
      if (!lvarSource) {
        this.sourceState = 'missing';
        this.sourceDescription = '';
        this.sourceConnected = false;
        this.profilePreview = [];
        this.debugWatchItems = [];
        this.debugWatchCount = this.debugWatchSubscriptions.length;
        this.lastUpdatedAt = Date.now();
        return;
      }

      this.sourceState = 'available';
      this.sourceDescription = String(lvarSource.description || '');
      this.sourceConnected = lvarSource.connected === true;
      this.profilePreview = Array.isArray(lvarSource.preview) ? lvarSource.preview.slice() : [];
      this.debugWatchItems = Array.isArray(lvarSource.debugWatch?.items) ? lvarSource.debugWatch.items.slice() : [];
      this.debugWatchCount = Number.isFinite(lvarSource.debugWatch?.count)
        ? lvarSource.debugWatch.count
        : this.debugWatchSubscriptions.length;
      this.lastUpdatedAt = Date.now();
    },

    clearDataSourcesStatus() {
      this.sourceState = 'missing';
      this.sourceDescription = '';
      this.sourceConnected = false;
      this.profilePreview = [];
      this.debugWatchItems = [];
      this.debugWatchCount = this.debugWatchSubscriptions.length;
      this.lastUpdatedAt = Date.now();
    },
  },
});
