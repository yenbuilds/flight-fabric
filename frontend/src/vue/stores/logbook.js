import { defineStore } from 'pinia';

const EMPTY_STATS = {
  total: 0,
  grades: {},
  outcomeGrades: {},
  longLandingCount: 0,
  avgVsFpm: null,
  bestVsFpm: null,
  airports: 0,
  aircraft: 0,
  trends: {
    aircraft: [],
    airports: [],
    runways: [],
  },
};

const EMPTY_HISTORY_INDEX_STATUS = Object.freeze({
  phase: 'idle',
  busy: false,
  mode: 'incremental',
  generation: 0,
  totalFiles: 0,
  completedFiles: 0,
  pendingFiles: 0,
  totalBytes: 0,
  completedBytes: 0,
  percent: 100,
  indexedFiles: 0,
  summaryHits: 0,
  deepScans: 0,
  failures: 0,
  currentFile: '',
  lastFailedFile: '',
  error: '',
  counts: null,
});

function normalizeHistoryIndexStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const numeric = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
  };
  const phase = ['idle', 'checking', 'indexing', 'complete', 'error'].includes(status.phase)
    ? status.phase
    : 'idle';
  return {
    ...EMPTY_HISTORY_INDEX_STATUS,
    phase,
    busy: phase === 'checking' || phase === 'indexing',
    mode: status.mode === 'rebuild' ? 'rebuild' : 'incremental',
    generation: numeric(status.generation),
    totalFiles: numeric(status.totalFiles),
    completedFiles: numeric(status.completedFiles),
    pendingFiles: numeric(status.pendingFiles),
    totalBytes: numeric(status.totalBytes),
    completedBytes: numeric(status.completedBytes),
    percent: Math.min(100, numeric(status.percent, 0)),
    indexedFiles: numeric(status.indexedFiles),
    summaryHits: numeric(status.summaryHits),
    deepScans: numeric(status.deepScans),
    failures: numeric(status.failures),
    currentFile: typeof status.currentFile === 'string' ? status.currentFile : '',
    lastFailedFile: typeof status.lastFailedFile === 'string' ? status.lastFailedFile : '',
    error: typeof status.error === 'string' ? status.error : '',
    counts: status.counts && typeof status.counts === 'object' ? { ...status.counts } : null,
  };
}

export const useLogbookStore = defineStore('logbook', {
  state: () => ({
    entries: [],
    stats: { ...EMPTY_STATS },
    historyIndexStatus: { ...EMPTY_HISTORY_INDEX_STATUS },
    historyIndexActionError: '',
    lastUpdatedAt: 0,
    _onRequest: null,
    requestActionBound: false,
  }),

  getters: {
    historyIndexBusy: (state) => state.historyIndexStatus.busy === true,
    historyIndexProgressLabel: (state) => {
      const index = state.historyIndexStatus;
      if (index.phase === 'checking') return 'Checking saved flights';
      if (index.phase !== 'indexing') return '';
      return index.totalFiles > 0
        ? `Indexing ${Math.min(index.completedFiles, index.totalFiles)} of ${index.totalFiles} flights`
        : 'Indexing saved flights';
    },
  },

  actions: {
    ingestMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'historyIndexStatus') {
        const normalized = normalizeHistoryIndexStatus(message.status);
        if (normalized) this.historyIndexStatus = normalized;
        this.historyIndexActionError = message.success === false && typeof message.error === 'string'
          ? message.error
          : '';
        return;
      }
      if (message.type !== 'logbook') return;
      this.entries = Array.isArray(message.entries) ? message.entries.slice() : [];
      this.stats = message.stats && typeof message.stats === 'object'
        ? { ...EMPTY_STATS, ...message.stats }
        : { ...EMPTY_STATS };
      this.stats.trends = {
        aircraft: Array.isArray(this.stats?.trends?.aircraft) ? this.stats.trends.aircraft.slice() : [],
        airports: Array.isArray(this.stats?.trends?.airports) ? this.stats.trends.airports.slice() : [],
        runways: Array.isArray(this.stats?.trends?.runways) ? this.stats.trends.runways.slice() : [],
      };
      const normalizedIndex = normalizeHistoryIndexStatus(message.index?.status);
      if (normalizedIndex) this.historyIndexStatus = normalizedIndex;
      this.lastUpdatedAt = Date.now();
    },

    bindRequestAction(action = null) {
      this._onRequest = typeof action === 'function' ? action : null;
      this.requestActionBound = this._onRequest !== null;
    },

    request() {
      if (typeof this._onRequest !== 'function') return false;
      return this._onRequest() !== false;
    },
  },
});
