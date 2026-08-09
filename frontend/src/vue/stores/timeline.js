import { defineStore } from 'pinia';
import {
  getFlightBundleSizeBytes,
  getFlightRouteLabel,
  sortAndFilterFlights,
} from '../../timeline/flight-list.js';
import {
  matchesMedia,
  readStorageJson,
  readStorageValue,
  writeStorageJson,
  writeStorageValue,
} from '../../app/browser-environment.js';
import { formatBytes, getFiniteFuelBurnGal } from '../../utils/formatting.js';
import { DEFAULT_ALTITUDE_PROFILE_STATE } from '../../timeline/altitude-profile.js';

const MAP_FILTER_KEYS = ['violations', 'landing', 'automation', 'markers', 'phases', 'scores'];
const MAP_FILTER_DEFAULTS = Object.freeze({
  violations: true,
  landing: false,
  automation: false,
  markers: false,
  phases: false,
  scores: false,
});
const MAP_FILTER_STORAGE_KEY = 'flightFabric.timelineMapFilters.v1';
const PFD_COLLAPSED_KEY = 'ff-pfd-overlay-collapsed';
const DEFAULT_INSPECTOR_EMPTY_MESSAGE = 'No timeline loaded';
const DEFAULT_MAP_EMPTY_MESSAGE = 'No positional event data yet';
const DEFAULT_STORAGE_PATH_COPY_LABEL = 'Copy Path';
const STORAGE_PATH_COPY_RESET_MS = 1500;
const TIMELINE_LOADING_MIN_VISIBLE_MS = 180;
const TIMELINE_LIST_RESPONSE_TIMEOUT_MS = 30_000;
const TIMELINE_LIST_TIMEOUT_MESSAGE = 'Saved flights did not respond. Select Refresh Page to try again.';
const FLIGHT_RENDER_INITIAL_LIMIT = 150;
const FLIGHT_RENDER_INCREMENT = 150;
const TIMELINE_LIST_INDEX_PAGE_SIZE = 300;
const INSPECTOR_RENDER_INITIAL_LIMIT = 250;
const INSPECTOR_RENDER_INCREMENT = 250;
const DEFAULT_SCRUBBER_STATE = Object.freeze({
  scrubberVisible: false,
  scrubberDisabled: true,
  scrubberMin: '0',
  scrubberMax: '0',
  scrubberStep: '100',
  scrubberValue: '0',
  scrubberCurrentLabel: '0:00',
  scrubberStartLabel: '0:00',
  scrubberEndLabel: '0:00',
});
const DEFAULT_PFD_STATE = Object.freeze({
  pfdScale: '1',
  pfdOverlayOpacity: '0.4',
  pfdHeadingDisplay: '---',
  pfdSpeedDisplay: '---',
  pfdAltitudeDisplay: '---',
  pfdPitchDisplay: '---',
  pfdRollDisplay: '---',
  pfdAdiTransform: 'rotate(0deg) translateY(0px)',
  pfdRollPointerTransform: 'translateX(-50%) rotate(0deg)',
});
const ALTITUDE_PROFILE_STORE_DEFAULTS = Object.freeze({
  altitudeProfileVisible: DEFAULT_ALTITUDE_PROFILE_STATE.visible,
  altitudeProfileEmptyVisible: DEFAULT_ALTITUDE_PROFILE_STATE.emptyVisible,
  altitudeProfilePathD: DEFAULT_ALTITUDE_PROFILE_STATE.pathD,
  altitudeProfileFillD: DEFAULT_ALTITUDE_PROFILE_STATE.fillD,
  altitudeProfileCursorVisible: DEFAULT_ALTITUDE_PROFILE_STATE.cursorVisible,
  altitudeProfileCursorX: DEFAULT_ALTITUDE_PROFILE_STATE.cursorX,
  altitudeProfileCursorY: DEFAULT_ALTITUDE_PROFILE_STATE.cursorY,
  altitudeProfileCurrentText: DEFAULT_ALTITUDE_PROFILE_STATE.currentText,
  altitudeProfileRangeText: DEFAULT_ALTITUDE_PROFILE_STATE.rangeText,
  altitudeProfileMinText: DEFAULT_ALTITUDE_PROFILE_STATE.minText,
  altitudeProfileMaxText: DEFAULT_ALTITUDE_PROFILE_STATE.maxText,
});

function loadMapFilters() {
  const next = { ...MAP_FILTER_DEFAULTS };
  const stored = readStorageJson(MAP_FILTER_STORAGE_KEY);
  if (stored && typeof stored === 'object') {
    for (const key of MAP_FILTER_KEYS) {
      if (typeof stored[key] === 'boolean') next[key] = stored[key];
    }
  }

  return next;
}

function saveMapFilters(mapFilters) {
  writeStorageJson(MAP_FILTER_STORAGE_KEY, mapFilters);
}

function loadPfdCollapsed() {
  const stored = readStorageValue(PFD_COLLAPSED_KEY, { fallback: null });
  if (stored === '1') return true;
  if (stored === null && matchesMedia('(max-width: 640px)')) {
    return true;
  }

  return false;
}

function savePfdCollapsed(value) {
  writeStorageValue(PFD_COLLAPSED_KEY, value ? '1' : '0');
}

function buildDeleteFlightPrompt(flight) {
  const routeLabel = getFlightRouteLabel(flight);
  const bundleSizeBytes = getFlightBundleSizeBytes(flight);
  const sizeLabel = bundleSizeBytes !== null ? ` (${formatBytes(bundleSizeBytes)})` : '';
  const label = routeLabel || flight?.flightId || 'this flight log';
  return `Delete the recording for ${label}${sizeLabel}?\n\nThis permanently removes its CSV, sidecars, and completion metadata from disk and cannot be undone.`;
}

function normalizeFlightPathKey(value) {
  return typeof value === 'string'
    ? value.replace(/\\/g, '/')
    : '';
}

function isWindowsStylePath(value) {
  return typeof value === 'string' && (/^[a-zA-Z]:[\\/]/.test(value) || value.includes('\\'));
}

function flightPathMatches(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left === right) return true;
  const normalizedLeft = normalizeFlightPathKey(left);
  const normalizedRight = normalizeFlightPathKey(right);
  if (normalizedLeft === normalizedRight) return true;
  if (!isWindowsStylePath(left) && !isWindowsStylePath(right)) return false;
  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function isStoragePayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function getTimelineLoadingNowMs() {
  if (typeof globalThis?.performance?.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

function createTimelineListRequestPayload({
  requestId = null,
  offset = 0,
  routeFilter = '',
  aircraftFilter = '',
  sort = 'recent',
} = {}) {
  const payload = {
    type: 'requestTimelineList',
    useHistoryIndex: true,
    limit: TIMELINE_LIST_INDEX_PAGE_SIZE,
    offset: Math.max(0, Math.floor(Number(offset) || 0)),
  };
  if (Number.isSafeInteger(requestId) && requestId > 0) payload.requestId = requestId;
  const route = String(routeFilter || '').trim();
  const aircraft = String(aircraftFilter || '').trim();
  const sortValue = String(sort || 'recent');
  if (route) payload.routeFilter = route;
  if (aircraft) payload.aircraftFilter = aircraft;
  if (sortValue && sortValue !== 'recent') payload.sort = sortValue;
  return payload;
}

function flightIdentityKey(flight) {
  if (!flight || typeof flight !== 'object') return '';
  return flight.filePath || flight.flightId || '';
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function comparisonDisplayValue(value) {
  if (value == null || value === '') return '--';
  if (typeof value === 'string') return value.trim() || '--';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return comparisonDisplayValue(value.display ?? value.label ?? value.value);
  }
  return '--';
}

function normalizeAnalysisRescoreStatus(value) {
  if (!value || typeof value !== 'object') {
    return { applied: false, revision: null, appliedAt: null, snapshotFingerprint: null };
  }
  return {
    applied: value.applied === true,
    revision: nonNegativeInteger(value.revision),
    appliedAt: nonEmptyString(value.appliedAt),
    snapshotFingerprint: nonEmptyString(value.snapshotFingerprint),
  };
}

function normalizeAnalysisRescoreMetric(metric, index) {
  if (!metric || typeof metric !== 'object') return null;
  const recorded = comparisonDisplayValue(metric.recorded ?? metric.original);
  const current = comparisonDisplayValue(metric.current ?? metric.rescored);
  return {
    key: nonEmptyString(metric.key) || `metric-${index}`,
    label: nonEmptyString(metric.label) || nonEmptyString(metric.key) || `Result ${index + 1}`,
    recorded,
    current,
    changed: metric.changed === true || recorded !== current,
  };
}

function normalizeAnalysisRescorePreview(value) {
  if (!value || typeof value !== 'object') return null;
  const sourceGroups = Array.isArray(value.landings)
    ? value.landings
    : (Array.isArray(value.groups) ? value.groups : []);
  const groups = sourceGroups.map((group, groupIndex) => {
    if (!group || typeof group !== 'object') return null;
    const metrics = (Array.isArray(group.metrics) ? group.metrics : [])
      .map(normalizeAnalysisRescoreMetric)
      .filter(Boolean)
      .sort((left, right) => Number(right.changed) - Number(left.changed));
    return {
      key: nonEmptyString(group.landingKey) || nonEmptyString(group.key) || `landing-${groupIndex}`,
      label: nonEmptyString(group.label) || `Landing ${groupIndex + 1}`,
      available: group.available !== false,
      reason: nonEmptyString(group.reason),
      metrics,
    };
  }).filter(Boolean);
  const calculatedChanges = groups.reduce(
    (total, group) => total + group.metrics.filter((metric) => metric.changed).length,
    0,
  );
  const reportedChanges = nonNegativeInteger(value.changedMetricCount);
  const landingCount = nonNegativeInteger(value.landingCount);
  const complete = value.complete !== false && groups.every((group) => group.available);
  return {
    available: value.available === true && complete,
    previewFingerprint: nonEmptyString(value.previewFingerprint),
    baseRevision: nonNegativeInteger(value.baseRevision),
    sourceFingerprint: nonEmptyString(value.sourceFingerprint),
    analysisContractFingerprint: nonEmptyString(value.analysisContractFingerprint),
    changedMetricCount: reportedChanges ?? calculatedChanges,
    landingCount: landingCount ?? groups.length,
    saveRequired: value.saveRequired !== false,
    groups,
    reason: nonEmptyString(value.reason),
  };
}

function mergeFlightRows(existingRows, nextRows) {
  const rows = Array.isArray(existingRows) ? existingRows.slice() : [];
  const seen = new Set(rows.map(flightIdentityKey).filter(Boolean));
  for (const flight of Array.isArray(nextRows) ? nextRows : []) {
    const key = flightIdentityKey(flight);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    rows.push(flight);
  }
  return rows;
}

function isPagedFlightListIndex(index) {
  return Boolean(index && typeof index === 'object' && (index.used === true || index.paged === true));
}

export const useTimelineStore = defineStore('timeline', {
  state: () => ({
    flights: [],
    storage: null,
    routeFilter: '',
    aircraftFilter: '',
    sort: 'recent',
    flightRenderLimit: FLIGHT_RENDER_INITIAL_LIMIT,
    flightListIndex: null,
    historyIndexStatus: null,
    timelineListRequestId: 0,
    listStatus: 'idle',
    listErrorMessage: '',
    listLastUpdatedAt: 0,
    timelineLoadStatus: 'idle',
    timelineLoadingFlightKey: '',
    timelineLoadingFlightLabel: '',
    timelineLoadingStartedAtMs: 0,
    timelineLoadingRequestId: 0,
    timelineRequestId: 0,
    loadedTimelineFilePath: '',
    loadedTimelineFlightId: '',
    loadedTimelineFlightLabel: '',
    summaryVisible: false,
    eventCountText: '--',
    violationCountText: '--',
    durationText: '--',
    distanceText: '--',
    fuelBurnText: '--',
    fuelBurnClass: 'font-semibold text-gray-500',
    scoreImpactText: '--',
    scoreImpactClass: 'font-semibold text-gray-400',
    inspectorFlightIdText: 'Select a saved flight to view timeline',
    inspectorRouteText: '',
    inspectorRouteVisible: false,
    inspectorEmptyVisible: true,
    inspectorEmptyMessage: DEFAULT_INSPECTOR_EMPTY_MESSAGE,
    inspectorAllRows: [],
    inspectorRows: [],
    inspectorRowLimit: INSPECTOR_RENDER_INITIAL_LIMIT,
    inspectorTotalRowCount: 0,
    inspectorSelectedRowKey: '',
    detailVisible: false,
    detailType: '--',
    detailTitle: '--',
    detailMetricSections: [],
    detailApproachProfileHtml: '',
    detailTopdownProfileHtml: '',
    detailLandingActionVisible: false,
    detailLandingActionBound: false,
    selectedLandingEvent: null,
    analysisRescore: normalizeAnalysisRescoreStatus(null),
    analysisRescorePreviewStatus: 'idle',
    analysisRescorePreviewRequestId: 0,
    analysisRescorePreview: null,
    analysisRescorePreviewError: '',
    analysisRescoreStatus: 'idle',
    analysisRescoreRequestId: 0,
    analysisRescorePendingRefreshRequestId: null,
    analysisRescoreLastAction: '',
    analysisRescoreMessage: '',
    analysisRescoreError: '',
    pendingFlightLandingRequest: null,
    timelineMobileViewerOpen: false,
    mapEmptyVisible: true,
    mapEmptyMessage: DEFAULT_MAP_EMPTY_MESSAGE,
    ...DEFAULT_SCRUBBER_STATE,
    ...ALTITUDE_PROFILE_STORE_DEFAULTS,
    scrubActionBound: false,
    ...DEFAULT_PFD_STATE,
    mapFilters: loadMapFilters(),
    mapFilterMenuOpen: false,
    pfdCollapsed: loadPfdCollapsed(),
    requestListActionBound: false,
    requestTimelineActionBound: false,
    deleteFlightActionBound: false,
    deleteConfirmationBound: false,
    storageFolderActionBound: false,
    storagePathCopyActionBound: false,
    storagePathCopyLabel: DEFAULT_STORAGE_PATH_COPY_LABEL,
  }),

  getters: {
    matchingFlights(state) {
      return sortAndFilterFlights(state.flights, {
        route: state.routeFilter,
        aircraft: state.aircraftFilter,
        sort: state.sort,
      }, {
        getFiniteFuelBurnGal,
      });
    },

    visibleFlights(state) {
      return this.matchingFlights.slice(0, Math.max(0, state.flightRenderLimit));
    },

    hasMoreVisibleFlights(state) {
      const loadedMore = this.matchingFlights.length > Math.max(0, state.flightRenderLimit);
      const indexTotal = isPagedFlightListIndex(state.flightListIndex) ? Number(state.flightListIndex.totalMatching) : null;
      return loadedMore || (Number.isFinite(indexTotal) && indexTotal > state.flights.length);
    },

    visibleFlightCount() {
      return this.visibleFlights.length;
    },

    flightsMeta() {
      const indexedTotal = isPagedFlightListIndex(this.flightListIndex) ? Number(this.flightListIndex.totalMatching) : null;
      const total = Number.isFinite(indexedTotal) ? indexedTotal : this.flights.length;
      const loaded = this.flights.length;
      const matched = this.matchingFlights.length;
      const rendered = this.visibleFlightCount;
      const parts = [
        Number.isFinite(indexedTotal)
          ? `Showing ${loaded} of ${total} saved flight${total === 1 ? '' : 's'}`
          : matched === total
          ? `Showing all ${total} saved flight${total === 1 ? '' : 's'}`
          : `Showing ${matched} of ${total} saved flights`,
      ];
      if (rendered < matched) parts.push(`${rendered} rendered`);
      if (this.routeFilter.trim()) parts.push(`route: ${this.routeFilter.trim()}`);
      if (this.aircraftFilter.trim()) parts.push(`aircraft: ${this.aircraftFilter.trim()}`);
      return parts.join(' - ');
    },

    storagePath: (state) => (state.storage && state.storage.dir ? state.storage.dir : '--'),

    storageSummary() {
      if (!this.storage || !this.storage.dir) return '--';
      if (this.storage.exists === false) {
        return 'Folder does not exist yet - it will be created on the first recording.';
      }
      const count = this.storage.fileCount || 0;
      return `${count} CSV file${count === 1 ? '' : 's'} - ${formatBytes(this.storage.totalBytes || 0)} on disk`;
    },

    showStorage: (state) => Boolean(state.storage && state.storage.dir),

    emptyStateMessage() {
      if (this.listStatus === 'not-connected') return 'Not connected to backend';
      if (this.listStatus === 'restricted') return 'Saved flight history is available in the desktop app.';
      if (this.flights.length === 0 && this.listStatus === 'loading') return 'Loading saved timelines...';
      if (this.flights.length === 0 && this.listStatus === 'error') {
        return this.listErrorMessage || 'Could not load saved timelines';
      }
      if (this.flights.length === 0 && this.historyIndexStatus?.busy === true) {
        return 'Indexing saved flights. Recent flights will appear first.';
      }
      if (this.flights.length === 0) return 'No saved timelines found';
      if (this.matchingFlights.length === 0) return 'No flights match the current filters';
      return '';
    },

    inspectorEventListVisible: (state) => state.inspectorRows.length > 0,

    hasMoreInspectorRows(state) {
      return state.inspectorTotalRowCount > Math.max(0, state.inspectorRowLimit);
    },

    inspectorRowsMeta(state) {
      const total = Number(state.inspectorTotalRowCount) || 0;
      const shown = Math.min(total, Math.max(0, Number(state.inspectorRows.length) || 0));
      return total > shown ? `Showing ${shown} of ${total} events` : '';
    },

    timelineLoading: (state) => state.timelineLoadStatus === 'loading',

    analysisRescoreBusy: (state) => Boolean(
      state.analysisRescorePreviewStatus === 'loading'
      || ['applying', 'reverting', 'refreshing'].includes(state.analysisRescoreStatus)
    ),

    canRequestAnalysisRescorePreview: (state) => Boolean(
      state.requestTimelineActionBound
      && (state.loadedTimelineFilePath || state.loadedTimelineFlightId)
      && state.analysisRescorePreviewStatus !== 'loading'
      && !['applying', 'reverting', 'refreshing'].includes(state.analysisRescoreStatus)
    ),

    canApplyFlightAnalysisRescore: (state) => Boolean(
      state.requestTimelineActionBound
      && state.analysisRescorePreviewStatus === 'ready'
      && state.analysisRescorePreview?.available === true
      && state.analysisRescorePreview?.previewFingerprint
      && state.analysisRescorePreview?.sourceFingerprint
      && state.analysisRescorePreview?.analysisContractFingerprint
      && Number.isSafeInteger(state.analysisRescorePreview?.baseRevision)
      && state.analysisRescorePreview?.saveRequired !== false
      && !['applying', 'reverting', 'refreshing'].includes(state.analysisRescoreStatus)
    ),

    canRevertFlightAnalysisRescore: (state) => Boolean(
      state.requestTimelineActionBound
      && state.analysisRescore?.applied === true
      && Number.isSafeInteger(state.analysisRescore?.revision)
      && state.analysisRescore?.snapshotFingerprint
      && !['applying', 'reverting', 'refreshing'].includes(state.analysisRescoreStatus)
    ),
  },

  actions: {
    ingestMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'historyIndexStatus') {
        if (message.status && typeof message.status === 'object') {
          this.historyIndexStatus = { ...message.status };
        }
        return;
      }
      if (message.type === 'timelineList' && Array.isArray(message.flights)) {
        if (Number.isSafeInteger(message.requestId) && message.requestId !== this.timelineListRequestId) return;
        this.clearListResponseWatchdog();
        const index = message.index && typeof message.index === 'object' ? message.index : null;
        const shouldAppend = isPagedFlightListIndex(index) && Number(index.offset) > 0;
        if (shouldAppend) {
          this.flights = mergeFlightRows(this.flights, message.flights);
        } else {
          this.flights = message.flights.slice();
          this.resetFlightRenderLimit();
        }
        this.flightListIndex = index;
        if (index?.status && typeof index.status === 'object') {
          this.historyIndexStatus = { ...index.status };
        }
        if (Object.prototype.hasOwnProperty.call(message, 'storage')) {
          this.storage = message.storage || null;
        }
        this.listStatus = 'loaded';
        this.listErrorMessage = '';
        this.listLastUpdatedAt = Date.now();
        return;
      }
      if (message.type === 'timelineListError') {
        if (Number.isSafeInteger(message.requestId) && message.requestId !== this.timelineListRequestId) return;
        this.clearListResponseWatchdog();
        if (message.retryable === true) {
          this.listStatus = 'loading';
          this.listErrorMessage = '';
          return;
        }
        this.listStatus = 'error';
        this.listErrorMessage = typeof message.error === 'string' && message.error.trim()
          ? message.error.trim()
          : 'Could not load saved timelines';
        return;
      }
      if (message.type === 'deleteFlightCsvResult' && message.success === true && typeof message.filePath === 'string') {
        this.applyDeletedFlight(message.filePath, message.storage);
      }
    },

    applyDeletedFlight(filePath, storage = null) {
      if (typeof filePath !== 'string' || !filePath) return false;

      let removedFlight = null;
      const remainingFlights = [];
      for (const flight of this.flights) {
        if (!removedFlight && flightPathMatches(flight?.filePath, filePath)) {
          removedFlight = flight;
          continue;
        }
        remainingFlights.push(flight);
      }

      if (removedFlight) {
        this.flights = remainingFlights;
        if (this.flightRenderLimit > FLIGHT_RENDER_INITIAL_LIMIT && this.visibleFlightCount >= this.matchingFlights.length) {
          this.flightRenderLimit = Math.max(FLIGHT_RENDER_INITIAL_LIMIT, this.matchingFlights.length);
        }
      }

      if (isStoragePayload(storage)) {
        this.storage = storage;
      } else if (removedFlight && isStoragePayload(this.storage)) {
        const fileCount = Number(this.storage.fileCount);
        const totalBytes = Number(this.storage.totalBytes);
        const removedBytes = getFlightBundleSizeBytes(removedFlight) ?? 0;
        this.storage = {
          ...this.storage,
          fileCount: Number.isFinite(fileCount) ? Math.max(0, fileCount - 1) : this.storage.fileCount,
          totalBytes: Number.isFinite(totalBytes) ? Math.max(0, totalBytes - removedBytes) : this.storage.totalBytes,
        };
      }

      if (flightPathMatches(this.timelineLoadingFlightKey, filePath)) {
        this.clearTimelineLoading();
      }

      return removedFlight !== null;
    },

    bindRequestActions({
      onRequestList = null,
      onRequestTimeline = null,
      onDeleteFlight = null,
    } = {}) {
      this._onRequestList = typeof onRequestList === 'function' ? onRequestList : null;
      this._onRequestTimeline = typeof onRequestTimeline === 'function' ? onRequestTimeline : null;
      this._onDeleteFlight = typeof onDeleteFlight === 'function' ? onDeleteFlight : null;
      this.requestListActionBound = this._onRequestList !== null;
      this.requestTimelineActionBound = this._onRequestTimeline !== null;
      this.deleteFlightActionBound = this._onDeleteFlight !== null;
    },

    bindPanelActions({
      confirmDeleteFlight = null,
      notifyDeleteUnavailable = null,
      openStorageFolder = null,
      copyStoragePath = null,
    } = {}) {
      this._onConfirmDeleteFlight = typeof confirmDeleteFlight === 'function' ? confirmDeleteFlight : null;
      this._onNotifyDeleteUnavailable = typeof notifyDeleteUnavailable === 'function' ? notifyDeleteUnavailable : null;
      this._onOpenStorageFolder = typeof openStorageFolder === 'function' ? openStorageFolder : null;
      this._onCopyStoragePath = typeof copyStoragePath === 'function' ? copyStoragePath : null;
      this.deleteConfirmationBound = this._onConfirmDeleteFlight !== null;
      this.storageFolderActionBound = this._onOpenStorageFolder !== null;
      this.storagePathCopyActionBound = this._onCopyStoragePath !== null;
    },

    requestList({ offset = 0 } = {}) {
      this.clearListResponseWatchdog();
      if (typeof this._onRequestList !== 'function') {
        this.listStatus = 'not-connected';
        this.listErrorMessage = '';
        return false;
      }
      if (this._flightListRefreshTimer && typeof globalThis?.clearTimeout === 'function') {
        globalThis.clearTimeout(this._flightListRefreshTimer);
        this._flightListRefreshTimer = null;
      }
      this.timelineListRequestId += 1;
      const payload = createTimelineListRequestPayload({
        requestId: this.timelineListRequestId,
        offset,
        routeFilter: this.routeFilter,
        aircraftFilter: this.aircraftFilter,
        sort: this.sort,
      });
      if (this._onRequestList(payload) === false) {
        if (this.listStatus !== 'restricted') {
          this.listStatus = 'not-connected';
          this.listErrorMessage = '';
        }
        return false;
      }
      this.listStatus = 'loading';
      this.listErrorMessage = '';
      this.armListResponseWatchdog();
      return true;
    },

    failList(message = '') {
      this.clearListResponseWatchdog();
      this.listStatus = 'error';
      this.listErrorMessage = typeof message === 'string' && message.trim()
        ? message.trim()
        : 'Could not load saved timelines';
    },

    armListResponseWatchdog() {
      this.clearListResponseWatchdog();
      if (typeof globalThis?.setTimeout !== 'function') return false;
      const requestId = this.timelineListRequestId;
      let scheduling = true;
      let firedSynchronously = false;
      let timer = null;
      timer = globalThis.setTimeout(() => {
        // Browser timers are asynchronous. Some non-browser test hosts use an
        // immediate timer shim; treating that as a real 30-second timeout would
        // fail the request during the requestList() call itself.
        if (scheduling) {
          firedSynchronously = true;
          return;
        }
        if (this._timelineListResponseTimer === timer) {
          this._timelineListResponseTimer = null;
        }
        if (requestId !== this.timelineListRequestId || this.listStatus !== 'loading') return;
        this.failList(TIMELINE_LIST_TIMEOUT_MESSAGE);
      }, TIMELINE_LIST_RESPONSE_TIMEOUT_MS);
      scheduling = false;
      if (firedSynchronously) {
        globalThis?.clearTimeout?.(timer);
        return false;
      }
      this._timelineListResponseTimer = timer;
      timer?.unref?.();
      return true;
    },

    clearListResponseWatchdog() {
      if (this._timelineListResponseTimer == null) return;
      globalThis?.clearTimeout?.(this._timelineListResponseTimer);
      this._timelineListResponseTimer = null;
    },

    markListDisconnected() {
      this.clearListResponseWatchdog();
      this.listStatus = 'not-connected';
      this.listErrorMessage = '';
    },

    markListRestricted() {
      this.clearListResponseWatchdog();
      this.flights = [];
      this.storage = null;
      this.flightListIndex = null;
      this.listStatus = 'restricted';
      this.listErrorMessage = '';
    },

    requestTimeline(filePathOrFlightId, legacyFlightId, options = {}) {
      const payload = this.buildTimelineRequestPayload(filePathOrFlightId, legacyFlightId);
      this.assignTimelineRequestId(payload);
      const openViewer = options.openViewer !== false;

      this.beginTimelineLoading({
        flightKey: options.flightKey || payload.filePath || payload.flightId || '',
        flightLabel: options.flightLabel || payload.flightId || 'selected flight',
      });

      if (typeof this._onRequestTimeline !== 'function') {
        this.clearTimelineLoading();
        return false;
      }

      if (openViewer) {
        this.openTimelineMobileViewer();
      }

      let sent = false;
      try {
        sent = this._onRequestTimeline(payload) !== false;
      } catch (error) {
        this.clearTimelineLoading();
        throw error;
      }

      if (!sent) {
        this.closeTimelineMobileViewer();
        this.clearTimelineLoading();
      }
      return sent;
    },

    beginTimelineLoading({ flightKey = '', flightLabel = '' } = {}) {
      if (this._timelineLoadingFinishTimer && typeof globalThis?.clearTimeout === 'function') {
        globalThis.clearTimeout(this._timelineLoadingFinishTimer);
      }
      this._timelineLoadingFinishTimer = null;
      this.timelineLoadingRequestId += 1;
      this.timelineLoadStatus = 'loading';
      this.timelineLoadingStartedAtMs = getTimelineLoadingNowMs();
      this.timelineLoadingFlightKey = flightKey || '';
      this.timelineLoadingFlightLabel = flightLabel || 'selected flight';
      this.setLoadedTimelineIdentity(null);
      this.clearSummary();
      this.clearDetail();
      this.resetScrubberState();
      this.resetAltitudeProfileState();
      this.setInspectorState({
        flightIdText: `Opening ${this.timelineLoadingFlightLabel}`,
        routeText: this.timelineLoadingFlightLabel,
        routeVisible: Boolean(this.timelineLoadingFlightLabel),
        rows: [],
        emptyVisible: true,
        emptyMessage: 'Loading timeline replay...',
      });
      this.setMapEmptyState({
        visible: true,
        message: 'Loading timeline replay...',
      });
    },

    finishTimelineLoading() {
      if (this.timelineLoadStatus !== 'loading') {
        this.clearTimelineLoading();
        return;
      }

      const elapsedMs = getTimelineLoadingNowMs() - Number(this.timelineLoadingStartedAtMs || 0);
      const remainingMs = TIMELINE_LOADING_MIN_VISIBLE_MS - elapsedMs;
      if (remainingMs > 0 && typeof globalThis?.setTimeout === 'function') {
        const requestId = this.timelineLoadingRequestId;
        if (this._timelineLoadingFinishTimer && typeof globalThis?.clearTimeout === 'function') {
          globalThis.clearTimeout(this._timelineLoadingFinishTimer);
        }
        this._timelineLoadingFinishTimer = globalThis.setTimeout(() => {
          this._timelineLoadingFinishTimer = null;
          if (this.timelineLoadingRequestId === requestId) {
            this.clearTimelineLoading();
          }
        }, remainingMs);
        return;
      }

      this.clearTimelineLoading();
    },

    clearTimelineLoading() {
      if (this._timelineLoadingFinishTimer && typeof globalThis?.clearTimeout === 'function') {
        globalThis.clearTimeout(this._timelineLoadingFinishTimer);
      }
      this._timelineLoadingFinishTimer = null;
      this.timelineLoadStatus = 'idle';
      this.timelineLoadingFlightKey = '';
      this.timelineLoadingFlightLabel = '';
      this.timelineLoadingStartedAtMs = 0;
    },

    setLoadedTimelineIdentity(timeline = null) {
      if (!timeline || typeof timeline !== 'object') {
        this.loadedTimelineFilePath = '';
        this.loadedTimelineFlightId = '';
        this.loadedTimelineFlightLabel = '';
        this.analysisRescore = normalizeAnalysisRescoreStatus(null);
        this.clearAnalysisRescorePreview();
        this.clearAnalysisRescoreActionState();
        return;
      }

      const nextFilePath = typeof timeline.filePath === 'string' ? timeline.filePath : '';
      const nextFlightId = typeof timeline.flightId === 'string' ? timeline.flightId : '';
      const hadIdentity = Boolean(this.loadedTimelineFilePath || this.loadedTimelineFlightId);
      const sameIdentity = Boolean(
        (nextFilePath && this.loadedTimelineFilePath
          && flightPathMatches(nextFilePath, this.loadedTimelineFilePath))
        || (nextFlightId && this.loadedTimelineFlightId && nextFlightId === this.loadedTimelineFlightId)
      );
      if (hadIdentity && !sameIdentity) {
        this.clearAnalysisRescorePreview();
        this.clearAnalysisRescoreActionState();
      }
      this.loadedTimelineFilePath = nextFilePath;
      this.loadedTimelineFlightId = nextFlightId;
      this.loadedTimelineFlightLabel = getFlightRouteLabel(timeline) || this.loadedTimelineFlightId || 'current timeline';
      this.analysisRescore = normalizeAnalysisRescoreStatus(timeline.analysisRescore);
    },

    refreshTimelinePage() {
      const listRequested = this.requestList();
      if (!this.loadedTimelineFilePath && !this.loadedTimelineFlightId) return listRequested;

      const timelineRequested = this.requestTimeline(
        this.loadedTimelineFilePath || this.loadedTimelineFlightId,
        this.loadedTimelineFlightId,
        {
          flightKey: this.loadedTimelineFilePath || this.loadedTimelineFlightId,
          flightLabel: this.loadedTimelineFlightLabel || this.loadedTimelineFlightId || 'current timeline',
          openViewer: false,
        },
      );
      return listRequested || timelineRequested;
    },

    deleteFlight(filePath, expectedIdentity = {}) {
      if (typeof this._onDeleteFlight !== 'function') {
        return false;
      }
      return this._onDeleteFlight({
        type: 'deleteFlightCsv',
        filePath,
        mtimeMs: expectedIdentity.mtimeMs,
        sizeBytes: expectedIdentity.sizeBytes,
      }) !== false;
    },

    async requestDeleteFlight(flight) {
      if (!flight?.filePath || typeof this._onConfirmDeleteFlight !== 'function') {
        return false;
      }

      const confirmed = await this._onConfirmDeleteFlight(buildDeleteFlightPrompt(flight), flight);
      if (!confirmed) return false;

      if (this.deleteFlight(flight.filePath, {
        mtimeMs: Number.isFinite(flight.csvMtimeMs) ? flight.csvMtimeMs : flight.mtimeMs,
        sizeBytes: Number.isFinite(flight.csvSizeBytes) ? flight.csvSizeBytes : flight.sizeBytes,
      })) {
        return true;
      }

      this._onNotifyDeleteUnavailable?.('Not connected to backend - cannot delete.');
      return false;
    },

    async requestOpenStorageFolder() {
      const dir = this.storagePath;
      if (!dir || dir === '--' || typeof this._onOpenStorageFolder !== 'function') {
        return false;
      }
      return await this._onOpenStorageFolder(dir) !== false;
    },

    async requestCopyStoragePath() {
      const dir = this.storagePath;
      if (!dir || dir === '--' || typeof this._onCopyStoragePath !== 'function') {
        return false;
      }

      const result = await this._onCopyStoragePath(dir);
      const copied = result === true || result?.copied === true;
      if (copied) {
        this.storagePathCopyLabel = 'Copied!';
        if (this._storagePathCopyResetHandle && typeof globalThis?.clearTimeout === 'function') {
          globalThis.clearTimeout(this._storagePathCopyResetHandle);
        }
        if (typeof globalThis?.setTimeout === 'function') {
          this._storagePathCopyResetHandle = globalThis.setTimeout(() => {
            this.storagePathCopyLabel = DEFAULT_STORAGE_PATH_COPY_LABEL;
            this._storagePathCopyResetHandle = null;
          }, STORAGE_PATH_COPY_RESET_MS);
        } else {
          this.storagePathCopyLabel = DEFAULT_STORAGE_PATH_COPY_LABEL;
        }
      }

      return result != null && result !== false;
    },

    setRouteFilter(value) {
      this.routeFilter = String(value || '');
      this.resetFlightRenderLimit();
      this.scheduleIndexedFlightListRefresh();
    },

    setAircraftFilter(value) {
      this.aircraftFilter = String(value || '');
      this.resetFlightRenderLimit();
      this.scheduleIndexedFlightListRefresh();
    },

    setSort(value) {
      this.sort = String(value || 'recent');
      this.resetFlightRenderLimit();
      this.scheduleIndexedFlightListRefresh();
    },

    resetFlightRenderLimit() {
      this.flightRenderLimit = FLIGHT_RENDER_INITIAL_LIMIT;
    },

    showMoreFlights() {
      this.flightRenderLimit += FLIGHT_RENDER_INCREMENT;
      const indexTotal = isPagedFlightListIndex(this.flightListIndex) ? Number(this.flightListIndex.totalMatching) : null;
      const needsAnotherPage = Number.isFinite(indexTotal)
        && indexTotal > this.flights.length
        && this.visibleFlightCount >= this.matchingFlights.length;
      if (needsAnotherPage) {
        this.requestList({ offset: this.flights.length });
      }
    },

    scheduleIndexedFlightListRefresh() {
      if (!isPagedFlightListIndex(this.flightListIndex) || typeof this._onRequestList !== 'function') {
        return false;
      }
      if (this._flightListRefreshTimer && typeof globalThis?.clearTimeout === 'function') {
        globalThis.clearTimeout(this._flightListRefreshTimer);
      }
      if (typeof globalThis?.setTimeout !== 'function') {
        return this.requestList();
      }
      this._flightListRefreshTimer = globalThis.setTimeout(() => {
        this._flightListRefreshTimer = null;
        this.requestList();
      }, 160);
      return true;
    },

    setSummary(summary = {}) {
      this.summaryVisible = summary.visible === true;
      this.eventCountText = summary.eventCountText || '--';
      this.violationCountText = summary.violationCountText || '--';
      this.durationText = summary.durationText || '--';
      this.distanceText = summary.distanceText || '--';
      this.fuelBurnText = summary.fuelBurnText || '--';
      this.fuelBurnClass = summary.fuelBurnClass || 'font-semibold text-gray-500';
      this.scoreImpactText = summary.scoreImpactText || '--';
      this.scoreImpactClass = summary.scoreImpactClass || 'font-semibold text-gray-400';
    },

    clearSummary() {
      this.summaryVisible = false;
      this.eventCountText = '--';
      this.violationCountText = '--';
      this.durationText = '--';
      this.distanceText = '--';
      this.fuelBurnText = '--';
      this.fuelBurnClass = 'font-semibold text-gray-500';
      this.scoreImpactText = '--';
      this.scoreImpactClass = 'font-semibold text-gray-400';
    },

    bindInspectorActions({ onSelectRow = null } = {}) {
      this._onInspectorRowSelect = typeof onSelectRow === 'function' ? onSelectRow : null;
    },

    bindDetailActions({
      onOpenSelectedLanding = null,
      onOpenFlightLanding = null,
      onFlightLandingLoadStart = null,
      onFlightLandingLoadError = null,
    } = {}) {
      this._onOpenSelectedLanding = typeof onOpenSelectedLanding === 'function' ? onOpenSelectedLanding : null;
      this._onOpenFlightLanding = typeof onOpenFlightLanding === 'function' ? onOpenFlightLanding : null;
      this._onFlightLandingLoadStart = typeof onFlightLandingLoadStart === 'function' ? onFlightLandingLoadStart : null;
      this._onFlightLandingLoadError = typeof onFlightLandingLoadError === 'function' ? onFlightLandingLoadError : null;
      this.detailLandingActionBound = this._onOpenSelectedLanding !== null;
    },

    setInspectorState(state = {}) {
      const allRows = Array.isArray(state.rows) ? state.rows.slice() : [];
      this.inspectorFlightIdText = state.flightIdText || 'Select a saved flight to view timeline';
      this.inspectorRouteText = state.routeText || '';
      this.inspectorRouteVisible = state.routeVisible === true;
      this.inspectorAllRows = allRows;
      this.inspectorTotalRowCount = allRows.length;
      this.inspectorRowLimit = INSPECTOR_RENDER_INITIAL_LIMIT;
      this.inspectorRows = allRows.slice(0, this.inspectorRowLimit);
      this.inspectorSelectedRowKey = state.selectedRowKey || '';
      this.inspectorEmptyVisible = state.emptyVisible !== false && this.inspectorAllRows.length === 0;
      this.inspectorEmptyMessage = state.emptyMessage || DEFAULT_INSPECTOR_EMPTY_MESSAGE;
    },

    clearInspector() {
      this.inspectorFlightIdText = 'Select a saved flight to view timeline';
      this.inspectorRouteText = '';
      this.inspectorRouteVisible = false;
      this.inspectorAllRows = [];
      this.inspectorRows = [];
      this.inspectorRowLimit = INSPECTOR_RENDER_INITIAL_LIMIT;
      this.inspectorTotalRowCount = 0;
      this.inspectorSelectedRowKey = '';
      this.inspectorEmptyVisible = true;
      this.inspectorEmptyMessage = DEFAULT_INSPECTOR_EMPTY_MESSAGE;
    },

    setSelectedEventRowKey(rowKey) {
      this.inspectorSelectedRowKey = rowKey || '';
    },

    selectEventRow(rowKey) {
      const key = rowKey || '';
      this.ensureInspectorRowVisible(key);
      const row = this.inspectorAllRows.find((item) => item?.rowKey === key) || null;
      if (!row) return false;
      this.inspectorSelectedRowKey = key;
      this._onInspectorRowSelect?.(row);
      return true;
    },

    refreshInspectorRows() {
      const limit = Math.max(0, Number(this.inspectorRowLimit) || 0);
      this.inspectorRows = this.inspectorAllRows.slice(0, limit);
      this.inspectorTotalRowCount = this.inspectorAllRows.length;
    },

    showMoreInspectorRows() {
      this.inspectorRowLimit += INSPECTOR_RENDER_INCREMENT;
      this.refreshInspectorRows();
    },

    ensureInspectorRowVisible(rowKey) {
      const key = rowKey || '';
      if (!key) return false;
      const index = this.inspectorAllRows.findIndex((item) => item?.rowKey === key);
      if (index < 0) return false;
      if (index < this.inspectorRows.length) return true;
      const nextLimit = Math.ceil((index + 1) / INSPECTOR_RENDER_INCREMENT) * INSPECTOR_RENDER_INCREMENT;
      this.inspectorRowLimit = Math.max(this.inspectorRowLimit, nextLimit);
      this.refreshInspectorRows();
      return true;
    },

    setDetail(detail = {}) {
      this.detailVisible = detail.visible === true;
      this.detailType = detail.type || '--';
      this.detailTitle = detail.title || '--';
      this.detailMetricSections = Array.isArray(detail.metricSections) ? detail.metricSections.slice() : [];
      this.detailApproachProfileHtml = detail.approachProfileHtml || '';
      this.detailTopdownProfileHtml = detail.topdownProfileHtml || '';
      this.detailLandingActionVisible = detail.landingActionVisible === true;
      this.selectedLandingEvent = detail.selectedLandingEvent || null;
    },

    clearDetail() {
      this.detailVisible = false;
      this.detailType = '--';
      this.detailTitle = '--';
      this.detailMetricSections = [];
      this.detailApproachProfileHtml = '';
      this.detailTopdownProfileHtml = '';
      this.detailLandingActionVisible = false;
      this.selectedLandingEvent = null;
    },

    openTimelineMobileViewer() {
      this.timelineMobileViewerOpen = true;
      return true;
    },

    closeTimelineMobileViewer() {
      this.timelineMobileViewerOpen = false;
    },

    openSelectedLanding() {
      if (!this.selectedLandingEvent || typeof this._onOpenSelectedLanding !== 'function') return false;
      return this._onOpenSelectedLanding(this.selectedLandingEvent) !== false;
    },

    clearAnalysisRescorePreview() {
      this.analysisRescorePreviewStatus = 'idle';
      this.analysisRescorePreview = null;
      this.analysisRescorePreviewError = '';
    },

    requestAnalysisRescorePreview() {
      if (!this.canRequestAnalysisRescorePreview || typeof this._onRequestTimeline !== 'function') {
        return false;
      }
      const payload = this.buildTimelineRequestPayload(
        this.loadedTimelineFilePath || this.loadedTimelineFlightId,
        this.loadedTimelineFlightId,
      );
      this.analysisRescorePreviewRequestId += 1;
      payload.requestId = this.analysisRescorePreviewRequestId;
      payload.scoringMode = 'current-preview';
      this.analysisRescorePreviewStatus = 'loading';
      this.analysisRescorePreview = null;
      this.analysisRescorePreviewError = '';
      this.analysisRescoreStatus = 'idle';
      this.analysisRescoreLastAction = '';
      this.analysisRescoreMessage = '';
      this.analysisRescoreError = '';
      try {
        if (this._onRequestTimeline(payload) === false) {
          this.failAnalysisRescorePreview('Could not request the current-rules analysis preview');
          return false;
        }
      } catch (error) {
        this.failAnalysisRescorePreview(error?.message || 'Could not request the current-rules analysis preview');
        throw error;
      }
      return true;
    },

    applyAnalysisRescorePreviewMessage(message) {
      if (this.analysisRescorePreviewStatus !== 'loading') return false;
      if (!Number.isSafeInteger(message?.requestId)
          || message.requestId !== this.analysisRescorePreviewRequestId) return false;
      const preview = normalizeAnalysisRescorePreview(message?.timeline?.analysisRescorePreview);
      if (!preview) {
        this.failAnalysisRescorePreview('The flight analysis was not available in the current-rules preview');
        return false;
      }
      this.analysisRescorePreview = preview;
      this.analysisRescorePreviewStatus = 'ready';
      this.analysisRescorePreviewError = '';
      return true;
    },

    failAnalysisRescorePreview(message = '') {
      this.analysisRescorePreviewStatus = 'error';
      this.analysisRescorePreview = null;
      this.analysisRescorePreviewError = String(message || '').trim()
        || 'Could not preview the current flight-analysis rules';
    },

    applyAnalysisRescorePreviewError(message) {
      if (this.analysisRescorePreviewStatus !== 'loading') return false;
      if (!Number.isSafeInteger(message?.requestId)
          || message.requestId !== this.analysisRescorePreviewRequestId) return false;
      this.failAnalysisRescorePreview(message?.error);
      return true;
    },

    clearAnalysisRescoreActionState() {
      this.analysisRescoreStatus = 'idle';
      this.analysisRescorePendingRefreshRequestId = null;
      this.analysisRescoreLastAction = '';
      this.analysisRescoreMessage = '';
      this.analysisRescoreError = '';
    },

    requestFlightAnalysisRescore(action = 'apply') {
      const normalizedAction = action === 'revert' ? 'revert' : 'apply';
      const allowed = normalizedAction === 'apply'
        ? this.canApplyFlightAnalysisRescore
        : this.canRevertFlightAnalysisRescore;
      if (!allowed || typeof this._onRequestTimeline !== 'function') return false;

      const payload = this.buildTimelineRequestPayload(
        this.loadedTimelineFilePath || this.loadedTimelineFlightId,
        this.loadedTimelineFlightId,
      );
      payload.type = normalizedAction === 'apply'
        ? 'applyFlightAnalysisRescore'
        : 'revertFlightAnalysisRescore';
      this.analysisRescoreRequestId += 1;
      payload.requestId = this.analysisRescoreRequestId;
      if (normalizedAction === 'apply') {
        payload.previewFingerprint = this.analysisRescorePreview.previewFingerprint;
        payload.baseRevision = this.analysisRescorePreview.baseRevision;
        payload.sourceFingerprint = this.analysisRescorePreview.sourceFingerprint;
        payload.analysisContractFingerprint = this.analysisRescorePreview.analysisContractFingerprint;
      } else {
        payload.expectedRevision = this.analysisRescore.revision;
        payload.expectedSnapshotFingerprint = this.analysisRescore.snapshotFingerprint;
      }
      this.analysisRescoreStatus = normalizedAction === 'apply' ? 'applying' : 'reverting';
      this.analysisRescoreLastAction = normalizedAction;
      this.analysisRescoreMessage = '';
      this.analysisRescoreError = '';
      try {
        if (this._onRequestTimeline(payload) === false) {
          this.failFlightAnalysisRescore('Could not update the saved flight analysis');
          return false;
        }
      } catch (error) {
        this.failFlightAnalysisRescore(error?.message || 'Could not update the saved flight analysis');
        throw error;
      }
      return true;
    },

    applyCurrentFlightAnalysisRescore() {
      return this.requestFlightAnalysisRescore('apply');
    },

    revertFlightAnalysisRescore() {
      return this.requestFlightAnalysisRescore('revert');
    },

    applyFlightAnalysisRescoreResult(message) {
      if (!['applying', 'reverting'].includes(this.analysisRescoreStatus)) return false;
      if (!Number.isSafeInteger(message?.requestId)
          || message.requestId !== this.analysisRescoreRequestId) return false;
      const expectedAction = this.analysisRescoreStatus === 'reverting' ? 'revert' : 'apply';
      if (message?.action && message.action !== expectedAction) return false;
      if (message?.success !== true) {
        this.failFlightAnalysisRescore(message?.error);
        return false;
      }
      const revision = nonNegativeInteger(message.revision);
      if (expectedAction === 'revert') {
        this.analysisRescore = {
          applied: false,
          revision,
          appliedAt: null,
          snapshotFingerprint: null,
        };
        this.analysisRescoreMessage = 'Recorded flight analysis restored. Refreshing Timeline and Logbook...';
      } else {
        this.analysisRescore = {
          applied: true,
          revision,
          appliedAt: nonEmptyString(message.appliedAt),
          snapshotFingerprint: nonEmptyString(message.snapshotFingerprint),
        };
        this.analysisRescoreMessage = 'Current flight analysis saved. Refreshing Timeline and Logbook...';
      }
      this.clearAnalysisRescorePreview();
      this.analysisRescoreStatus = 'refreshing';
      this.analysisRescoreLastAction = expectedAction;
      this.analysisRescoreError = '';
      return true;
    },

    requestFlightAnalysisRescoreRefresh() {
      if (this.analysisRescoreStatus !== 'refreshing'
          || typeof this._onRequestTimeline !== 'function') return false;
      const timelinePayload = this.buildTimelineRequestPayload(
        this.loadedTimelineFilePath || this.loadedTimelineFlightId,
        this.loadedTimelineFlightId,
      );
      if (!timelinePayload.filePath && !timelinePayload.flightId) {
        this.failFlightAnalysisRescore('The analysis was updated, but the flight could not be refreshed. Select Refresh Page.');
        return false;
      }
      this.assignTimelineRequestId(timelinePayload);
      this.analysisRescorePendingRefreshRequestId = timelinePayload.requestId;
      let timelineRequested = false;
      try {
        timelineRequested = this._onRequestTimeline(timelinePayload) !== false;
        this.requestList();
        this._onRequestTimeline({ type: 'requestLogbook', limit: 500 });
      } catch (error) {
        this.failFlightAnalysisRescore(
          `The analysis was updated, but history refresh failed: ${error?.message || 'unknown error'}`,
        );
        throw error;
      }
      if (!timelineRequested) {
        this.failFlightAnalysisRescore('The analysis was updated, but the flight could not be refreshed. Select Refresh Page.');
        return false;
      }
      return true;
    },

    isFlightAnalysisRescoreRefreshMessage(message) {
      return this.analysisRescoreStatus === 'refreshing'
        && Number.isSafeInteger(message?.requestId)
        && message.requestId === this.analysisRescorePendingRefreshRequestId;
    },

    finishFlightAnalysisRescoreRefresh(message) {
      if (!this.isFlightAnalysisRescoreRefreshMessage(message)) return false;
      this.analysisRescorePendingRefreshRequestId = null;
      if (this.analysisRescoreLastAction === 'revert') {
        this.analysisRescoreStatus = 'reverted';
        this.analysisRescoreMessage = 'All recorded flight-analysis scoring has been restored.';
      } else {
        this.analysisRescoreStatus = 'applied';
        this.analysisRescoreMessage = 'All current flight-analysis scoring has been saved.';
      }
      this.analysisRescoreError = '';
      return true;
    },

    failFlightAnalysisRescoreRefresh(message) {
      if (!this.isFlightAnalysisRescoreRefreshMessage(message)) return false;
      this.analysisRescorePendingRefreshRequestId = null;
      this.failFlightAnalysisRescore(
        'The analysis was updated, but the refreshed Timeline could not be loaded. Select Refresh Page.',
      );
      return true;
    },

    failFlightAnalysisRescore(message = '') {
      this.analysisRescoreStatus = 'error';
      this.analysisRescoreMessage = '';
      this.analysisRescoreError = String(message || '').trim()
        || 'Could not update the saved flight analysis';
    },

    openFlightLanding(flight) {
      if (typeof this._onOpenFlightLanding === 'function') {
        return this._onOpenFlightLanding(flight) !== false;
      }
      return this.requestFlightLanding(flight);
    },

    buildTimelineRequestPayload(filePathOrFlightId, legacyFlightId) {
      const requestedFlightId = typeof filePathOrFlightId === 'string' && filePathOrFlightId
        ? filePathOrFlightId
        : legacyFlightId;
      const looksLikeCsvPath = typeof filePathOrFlightId === 'string'
        && (/[\\/]/.test(filePathOrFlightId) || /\.csv$/i.test(filePathOrFlightId));
      return looksLikeCsvPath
        ? { type: 'requestTimeline', filePath: filePathOrFlightId, flightId: legacyFlightId }
        : { type: 'requestTimeline', flightId: requestedFlightId };
    },

    assignTimelineRequestId(payload) {
      this.timelineRequestId += 1;
      payload.requestId = this.timelineRequestId;
      // A newer normal Timeline request supersedes any landing-card handoff
      // that was waiting on an older replay response.
      this.pendingFlightLandingRequest = null;
      return payload.requestId;
    },

    isCurrentTimelineRequestMessage(message) {
      return Number.isSafeInteger(message?.requestId)
        && message.requestId === this.timelineRequestId;
    },

    requestFlightLanding(flight) {
      const landingEvent = flight?.latestLandingEvent;
      if (!landingEvent || typeof landingEvent !== 'object' || typeof this._onOpenSelectedLanding !== 'function') {
        return false;
      }
      if (typeof this._onRequestTimeline !== 'function') {
        this._onFlightLandingLoadError?.('Timeline backend is not connected');
        return false;
      }
      const payload = this.buildTimelineRequestPayload(flight?.filePath, flight?.flightId);
      this.assignTimelineRequestId(payload);
      const flightKey = flightIdentityKey(flight);
      const flightLabel = getFlightRouteLabel(flight) || flight?.flightId || 'selected flight';
      this.pendingFlightLandingRequest = {
        flightKey,
        flightLabel,
        fallbackEvent: {
          ...landingEvent,
          type: 'landing',
        },
      };
      this._onFlightLandingLoadStart?.(flight);
      this.beginTimelineLoading({
        flightKey,
        flightLabel,
      });
      this.closeTimelineMobileViewer();
      if (this._onRequestTimeline(payload) === false) {
        this.pendingFlightLandingRequest = null;
        this.clearTimelineLoading();
        this._onFlightLandingLoadError?.('Could not request landing timeline');
        return false;
      }
      return true;
    },

    openPendingFlightLandingFromTimeline(timeline) {
      const pending = this.pendingFlightLandingRequest;
      if (!pending || typeof this._onOpenSelectedLanding !== 'function') return false;
      const fallback = pending.fallbackEvent && typeof pending.fallbackEvent === 'object'
        ? pending.fallbackEvent
        : null;
      const events = Array.isArray(timeline?.events) ? timeline.events : [];
      const fallbackId = fallback?.id != null ? String(fallback.id) : '';
      const fallbackTimestamp = Number(fallback?.timestampMs ?? fallback?.timestamp_ms);
      const landingEvents = events.filter((event) => event?.type === 'landing');
      const matchedById = fallbackId
        ? landingEvents.find((event) => event?.id != null && String(event.id) === fallbackId)
        : null;
      const matchedByTimestamp = !matchedById && Number.isFinite(fallbackTimestamp)
        ? landingEvents.find((event) => {
          const eventTimestamp = Number(event?.timestampMs ?? event?.timestamp_ms);
          return Number.isFinite(eventTimestamp) && Math.abs(eventTimestamp - fallbackTimestamp) <= 1000;
        })
        : null;
      const landingEvent = matchedById || matchedByTimestamp || landingEvents.at(-1) || fallback;
      this.pendingFlightLandingRequest = null;
      if (!landingEvent) {
        this._onFlightLandingLoadError?.('No scored landing was found in this timeline');
        return false;
      }
      return this._onOpenSelectedLanding({
        ...landingEvent,
        type: 'landing',
      }) !== false;
    },

    failPendingFlightLanding(error) {
      if (!this.pendingFlightLandingRequest) return false;
      this.pendingFlightLandingRequest = null;
      this._onFlightLandingLoadError?.(error || 'Could not load landing details');
      return true;
    },

    setMapEmptyState(state = {}) {
      if (Object.prototype.hasOwnProperty.call(state, 'visible')) {
        this.mapEmptyVisible = state.visible === true;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'message')) {
        this.mapEmptyMessage = state.message || DEFAULT_MAP_EMPTY_MESSAGE;
      }
    },

    resetMapEmptyState() {
      this.mapEmptyVisible = true;
      this.mapEmptyMessage = DEFAULT_MAP_EMPTY_MESSAGE;
    },

    bindReplayActions({ onScrubOffset = null } = {}) {
      this._onReplayScrubOffset = typeof onScrubOffset === 'function' ? onScrubOffset : null;
      this.scrubActionBound = this._onReplayScrubOffset !== null;
    },

    requestScrubOffset(offsetMs, options = {}) {
      if (typeof this._onReplayScrubOffset !== 'function') return false;
      const numericOffset = Number(offsetMs);
      const result = this._onReplayScrubOffset(numericOffset, options);
      return result != null && result !== false;
    },

    setScrubberState(state = {}) {
      if (Object.prototype.hasOwnProperty.call(state, 'visible')) {
        this.scrubberVisible = state.visible === true;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'disabled')) {
        this.scrubberDisabled = state.disabled === true;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'min')) {
        this.scrubberMin = String(state.min ?? DEFAULT_SCRUBBER_STATE.scrubberMin);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'max')) {
        this.scrubberMax = String(state.max ?? DEFAULT_SCRUBBER_STATE.scrubberMax);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'step')) {
        this.scrubberStep = String(state.step ?? DEFAULT_SCRUBBER_STATE.scrubberStep);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'value')) {
        this.scrubberValue = String(state.value ?? DEFAULT_SCRUBBER_STATE.scrubberValue);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'currentLabel')) {
        this.scrubberCurrentLabel = state.currentLabel || DEFAULT_SCRUBBER_STATE.scrubberCurrentLabel;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'startLabel')) {
        this.scrubberStartLabel = state.startLabel || DEFAULT_SCRUBBER_STATE.scrubberStartLabel;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'endLabel')) {
        this.scrubberEndLabel = state.endLabel || DEFAULT_SCRUBBER_STATE.scrubberEndLabel;
      }
    },

    resetScrubberState() {
      Object.assign(this, DEFAULT_SCRUBBER_STATE);
    },

    setAltitudeProfileState(state = {}) {
      if (Object.prototype.hasOwnProperty.call(state, 'visible')) {
        this.altitudeProfileVisible = state.visible === true;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'emptyVisible')) {
        this.altitudeProfileEmptyVisible = state.emptyVisible === true;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'pathD')) {
        this.altitudeProfilePathD = state.pathD || ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfilePathD;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'fillD')) {
        this.altitudeProfileFillD = state.fillD || ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfileFillD;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'cursorVisible')) {
        this.altitudeProfileCursorVisible = state.cursorVisible === true;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'cursorX')) {
        this.altitudeProfileCursorX = String(state.cursorX ?? ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfileCursorX);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'cursorY')) {
        this.altitudeProfileCursorY = String(state.cursorY ?? ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfileCursorY);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'currentText')) {
        this.altitudeProfileCurrentText = state.currentText || ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfileCurrentText;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'rangeText')) {
        this.altitudeProfileRangeText = state.rangeText || ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfileRangeText;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'minText')) {
        this.altitudeProfileMinText = state.minText || ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfileMinText;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'maxText')) {
        this.altitudeProfileMaxText = state.maxText || ALTITUDE_PROFILE_STORE_DEFAULTS.altitudeProfileMaxText;
      }
    },

    resetAltitudeProfileState() {
      Object.assign(this, ALTITUDE_PROFILE_STORE_DEFAULTS);
    },

    setPfdState(state = {}) {
      if (Object.prototype.hasOwnProperty.call(state, 'scale')) {
        this.pfdScale = String(state.scale || DEFAULT_PFD_STATE.pfdScale);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'overlayOpacity')) {
        this.pfdOverlayOpacity = state.overlayOpacity || DEFAULT_PFD_STATE.pfdOverlayOpacity;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'headingDisplay')) {
        this.pfdHeadingDisplay = state.headingDisplay || DEFAULT_PFD_STATE.pfdHeadingDisplay;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'speedDisplay')) {
        this.pfdSpeedDisplay = state.speedDisplay || DEFAULT_PFD_STATE.pfdSpeedDisplay;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'altitudeDisplay')) {
        this.pfdAltitudeDisplay = state.altitudeDisplay || DEFAULT_PFD_STATE.pfdAltitudeDisplay;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'pitchDisplay')) {
        this.pfdPitchDisplay = state.pitchDisplay || DEFAULT_PFD_STATE.pfdPitchDisplay;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'rollDisplay')) {
        this.pfdRollDisplay = state.rollDisplay || DEFAULT_PFD_STATE.pfdRollDisplay;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'adiTransform')) {
        this.pfdAdiTransform = state.adiTransform || DEFAULT_PFD_STATE.pfdAdiTransform;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'rollPointerTransform')) {
        this.pfdRollPointerTransform = state.rollPointerTransform || DEFAULT_PFD_STATE.pfdRollPointerTransform;
      }
    },

    resetPfdState() {
      Object.assign(this, DEFAULT_PFD_STATE);
    },

    setMapFilter(key, value) {
      if (!MAP_FILTER_KEYS.includes(key)) return;
      this.mapFilters = {
        ...this.mapFilters,
        [key]: value === true,
      };
      saveMapFilters(this.mapFilters);
    },

    toggleMapFilterMenu(force) {
      this.mapFilterMenuOpen = typeof force === 'boolean'
        ? force
        : !this.mapFilterMenuOpen;
    },

    closeMapFilterMenu() {
      this.mapFilterMenuOpen = false;
    },

    setPfdCollapsed(value) {
      const next = value === true;
      if (this.pfdCollapsed === next) return;
      this.pfdCollapsed = next;
      savePfdCollapsed(next);
    },

    togglePfdCollapsed() {
      this.setPfdCollapsed(!this.pfdCollapsed);
    },
  },
});
