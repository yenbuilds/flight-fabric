import { defineStore } from 'pinia';
import { RELEASE_WARNING, formatReleaseVersion } from '../../app/version-labels.js';
import {
  getBrowserStorage,
  writeStorageValue,
} from '../../app/browser-environment.js';

const SAMPLING_BAND_STYLES = Object.freeze({
  BASELINE: {
    pill: 'bg-surface-200 border-surface-300',
    dot: 'bg-gray-400',
    label: 'text-gray-300',
  },
  ELEVATED: {
    pill: 'bg-sky-500/15 border-sky-500/40',
    dot: 'bg-sky-400',
    label: 'text-sky-300',
  },
  HIGH_FIDELITY: {
    pill: 'bg-amber-500/15 border-amber-500/40',
    dot: 'bg-amber-400',
    label: 'text-amber-300',
  },
  ULTRA_FIDELITY: {
    pill: 'bg-fuchsia-500/15 border-fuchsia-500/40',
    dot: 'bg-fuchsia-400',
    label: 'text-fuchsia-300',
  },
});

const ASSIST_CATEGORIES = Object.freeze([
  {
    key: 'piloting',
    label: 'Piloting',
    items: [
      { key: 'landingAssist', name: 'Landing Assist' },
      { key: 'takeoffAssist', name: 'Takeoff Assist' },
      { key: 'aiControls', name: 'AI Flying' },
      { key: 'aiDelegated', name: 'AI Delegated' },
      { key: 'aiAutotrim', name: 'AI Autotrim' },
    ],
  },
  {
    key: 'cheats',
    label: 'Simulator Options',
    items: [
      { key: 'unlimitedFuel', name: 'Unlimited Fuel' },
      { key: 'slewActive', name: 'Slew Mode Active' },
    ],
  },
]);

const PROFILE_BADGE_META = Object.freeze({
  verified: { className: 'text-emerald-500', label: '\u2713' },
  certified: { className: 'text-blue-500', label: '\u2605' },
  unverified: { className: 'text-gray-600', label: '\u25CB' },
});
const SYSTEM_BANNER_HEIGHT_PX = 40;

function toFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toPositiveFiniteNumber(value) {
  const numericValue = toFiniteNumber(value);
  return numericValue != null && numericValue > 0 ? numericValue : null;
}

function formatSamplingBand(band) {
  const normalized = String(band || '').toUpperCase();
  if (normalized === 'HIGH_FIDELITY') return 'HIGH';
  if (normalized === 'ULTRA_FIDELITY') return 'ULTRA';
  if (normalized === 'ELEVATED') return 'ELEVATED';
  if (normalized === 'BASELINE') return 'BASELINE';
  return '--';
}

function formatHz(value) {
  const numericValue = toFiniteNumber(value);
  if (numericValue == null) return '--';
  const roundedValue = Math.round(numericValue * 100) / 100;
  return `${roundedValue} Hz`;
}

function formatMs(value) {
  const numericValue = toFiniteNumber(value);
  return numericValue == null ? '--' : `${Math.round(numericValue)} ms`;
}

function formatSignedFpm(value) {
  const numericValue = toFiniteNumber(value);
  return numericValue == null ? '--' : `${Math.round(numericValue)} fpm`;
}

function formatFeet(value) {
  const numericValue = toFiniteNumber(value);
  return numericValue == null ? '--' : `${Math.round(numericValue)} ft`;
}

function formatSamplingReason(reason) {
  const raw = String(reason || '').trim();
  if (!raw || raw === 'none') return 'none';
  return raw
    .split(',')
    .map((part) => part.trim().replace(/_/g, ' '))
    .filter(Boolean)
    .join(', ');
}

function getDefaultVreSampling() {
  return {
    active: false,
    band: 'BASELINE',
    targetRateHz: null,
    effectiveRateHz: null,
    rateHz: null,
    intervalMs: null,
    shouldSample: false,
    nextSampleInMs: null,
    reason: 'none',
    phase: '--',
    raFt: null,
    vsFpm: null,
    ultraFidelityDisabled: false,
    ultraFidelityTimeRemaining: null,
    ultraFidelitySamplesRemaining: null,
  };
}

function getDefaultRecording() {
  return {
    status: 'stopped',
    outputDir: '',
    filePath: '',
    fileName: '',
    error: '',
  };
}

function getDefaultSurface() {
  return {
    onGround: false,
    name: '--',
    class: 'UNKNOWN',
    runwayLike: false,
  };
}

function getDefaultRunwayContext() {
  return {
    visible: false,
    label: '--',
  };
}

function getDefaultAircraftProfile() {
  return {
    aircraftName: '--',
    aircraftTitle: '',
    profileId: '',
    profileKey: '',
    profileName: '',
    verificationStatus: '',
    badgeStatus: '',
    badgeLabel: '',
    badgeTitle: '',
  };
}

function isPathLikeAircraftTitle(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return Boolean(raw && (raw.includes('\\') || raw.includes('/') || /\.cfg$/i.test(raw)));
}

function resolveAircraftName(profile) {
  if (!profile || typeof profile !== 'object') return '--';
  const aircraftTitle = typeof profile.aircraftTitle === 'string' ? profile.aircraftTitle.trim() : '';
  if (aircraftTitle && !isPathLikeAircraftTitle(aircraftTitle)) {
    return aircraftTitle;
  }
  return profile.name || '--';
}

function getDefaultCabinAnnouncements() {
  return {
    enabled: false,
    available: false,
    muted: false,
    playing: false,
  };
}

function getDefaultSystemBanners() {
  return {
    disk: {
      visible: false,
      message: 'Disk space warning',
      level: '',
      rowsWritten: null,
    },
    update: {
      visible: false,
      currentVersion: '',
      latestVersion: '',
      versionLabel: 'v0.0.0 Alpha',
      message: '',
      downloadUrl: '',
      urgent: false,
    },
    restartRequired: {
      visible: false,
      message: '',
      reasons: [],
    },
  };
}

function resolveStorage(storage) {
  return getBrowserStorage(storage);
}

function persistStorageValue(storage, key, value) {
  writeStorageValue(key, value, { storage });
}

function normalizeRestartReasons(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((reason) => String(reason || '').trim())
    .filter(Boolean))];
}

export const useStatusStore = defineStore('status', {
  state: () => ({
    websocket: 'connecting',
    phase: '--',
    simConnected: false,
    simInMenu: false,
    lifecycleState: '',
    inFlightContext: false,
    connectionInfo: 'ws://localhost:8099',
    flightTime: '00:00:00',
    aircraftProfile: getDefaultAircraftProfile(),
    cabinAnnouncements: getDefaultCabinAnnouncements(),
    systemBanners: getDefaultSystemBanners(),
    primarySource: null,
    secondarySources: [],
    dataSources: [],
    assists: {},
    recording: getDefaultRecording(),
    surface: getDefaultSurface(),
    runwayContext: getDefaultRunwayContext(),
    vreSampling: getDefaultVreSampling(),
    _onStartRecordingManual: null,
    _onEndFlightManual: null,
    startRecordingActionBound: false,
    endFlightActionBound: false,
  }),

  getters: {
    websocketLabel: (state) => {
      if (state.websocket === 'ready' && state.primarySource?.connected) {
        return state.primarySource?.name || 'SimConnect';
      }
      if (state.websocket === 'ready') return 'WS Ready';
      if (state.websocket === 'error') return 'Connection failed';
      if (state.websocket === 'disconnected') return 'Disconnected';
      return 'Connecting...';
    },
    websocketClass: (state) => {
      if (state.websocket === 'ready' && state.primarySource?.connected) return 'bg-success pulse-dot';
      if (state.websocket === 'ready') return 'bg-amber-500';
      if (state.websocket === 'connecting') return 'bg-amber-400';
      return 'bg-danger';
    },
    websocketStyle: (state) => {
      if (state.websocket === 'ready' && state.primarySource?.connected) {
        return { boxShadow: '0 0 6px rgba(16, 185, 129, 0.45)' };
      }
      if (state.websocket === 'ready') return { boxShadow: '0 0 6px rgba(245, 158, 11, 0.45)' };
      if (state.websocket === 'connecting') return { boxShadow: '0 0 6px rgba(251, 191, 36, 0.45)' };
      return { boxShadow: '0 0 6px rgba(239, 68, 68, 0.5)' };
    },
    phaseVisible: (state) => Boolean(state.phase && state.phase !== '--'),
    phaseLabel: (state) => state.phase || '--',
    simLabel: (state) => {
      if (!state.simConnected) return 'SIM: OFFLINE';
      return state.simInMenu ? 'SIM: IN MENU' : 'SIM: IN FLIGHT';
    },
    flightTimeLabel: (state) => state.flightTime || '00:00:00',
    connectionInfoLabel: (state) => state.connectionInfo || 'ws://localhost:8099',
    aircraftNameLabel: (state) => state.aircraftProfile.aircraftName || '--',
    aircraftProfileNameLabel: (state) => state.aircraftProfile.profileName || '',
    aircraftProfileVerificationLabel: (state) => {
      const verificationStatus = String(state.aircraftProfile.verificationStatus || '').toLowerCase();
      if (!verificationStatus) return 'verification unavailable';
      return verificationStatus === 'verified'
        ? 'verified profile'
        : verificationStatus === 'certified'
          ? 'certified profile'
          : verificationStatus === 'partial'
            ? 'partially verified profile'
            : 'unverified profile';
    },
    aircraftProfileNameVisible: (state) => {
      const profileName = String(state.aircraftProfile.profileName || '').trim();
      return Boolean(profileName && profileName !== '--');
    },
    profileBadgeLabel: (state) => state.aircraftProfile.badgeLabel || '',
    profileBadgeTitle: (state) => state.aircraftProfile.badgeTitle || '',
    profileBadgeClass: (state) => [
      'ml-1 text-xs',
      PROFILE_BADGE_META[state.aircraftProfile.badgeStatus]?.className || PROFILE_BADGE_META.unverified.className,
    ].join(' '),
    diskWarningVisible: (state) => state.systemBanners.disk.visible === true,
    diskWarningMessage: (state) => state.systemBanners.disk.message || 'Disk space warning',
    updateBannerVisible: (state) => state.systemBanners.update.visible === true,
    updateVersionLabel: (state) => state.systemBanners.update.versionLabel || 'v0.0.0 Alpha',
    updateMessageVisible: (state) => Boolean(state.systemBanners.update.message),
    updateMessageLabel: (state) => state.systemBanners.update.message || '',
    updateDownloadUrl: (state) => state.systemBanners.update.downloadUrl || '',
    updateBannerToneClass: (state) => (
      state.systemBanners.update.urgent
        ? 'bg-red-600/95 border-red-400/30'
        : 'bg-blue-600/95 border-blue-400/30'
    ),
    updateIconToneClass: (state) => (state.systemBanners.update.urgent ? 'text-red-200' : 'text-blue-200'),
    updateMessageToneClass: (state) => (state.systemBanners.update.urgent ? 'text-red-100' : 'text-blue-100'),
    restartRequiredBannerVisible: (state) => state.systemBanners.restartRequired.visible === true,
    restartRequiredReasons: (state) => normalizeRestartReasons(state.systemBanners.restartRequired.reasons),
    restartRequiredMessage() {
      const message = String(this.systemBanners.restartRequired.message || '').trim();
      if (message) return message;

      if (this.restartRequiredReasons.length > 0) {
        return `App restart required to apply: ${this.restartRequiredReasons.join(', ')}.`;
      }
      return 'App restart required to apply saved settings.';
    },
    systemBannerCount() {
      return Number(this.diskWarningVisible)
        + Number(this.restartRequiredBannerVisible)
        + Number(this.updateBannerVisible);
    },
    systemBannerOffsetVisible() {
      return this.systemBannerCount > 0;
    },
    systemBannerOffsetPx() {
      return this.systemBannerCount > 0 ? `${this.systemBannerCount * SYSTEM_BANNER_HEIGHT_PX}px` : '';
    },
    quickGlanceVisible: (state) => /approach|final|landing/i.test(state.phase || ''),
    activeAssistCategories: (state) => ASSIST_CATEGORIES
      .map((category) => ({
        ...category,
        items: category.items.filter((item) => state.assists?.[item.key] === true),
      }))
      .filter((category) => category.items.length > 0),
    activeAssistCount() {
      return this.activeAssistCategories.reduce((total, category) => total + category.items.length, 0);
    },
    assistsVisible() {
      return this.activeAssistCount > 0;
    },
    recordingVisible: (state) => ['recording', 'finalizing', 'failed', 'error'].includes(state.recording.status),
    recordingActive: (state) => state.recording.status === 'recording' || state.recording.status === 'finalizing',
    recordingStartAvailable: (state) => state.simConnected === true
      && state.simInMenu !== true
      && state.recording.status !== 'recording'
      && state.recording.status !== 'finalizing',
    recordingFailed: (state) => state.recording.status === 'failed' || state.recording.status === 'error',
    recordingFinalizing: (state) => state.recording.status === 'finalizing',
    recordingBadgeLabel() {
      if (this.recordingFinalizing) return 'SAVE';
      return this.recordingFailed ? 'NO REC' : 'REC';
    },
    recordingTitle() {
      if (this.recordingFinalizing) return 'Finalizing Flight Log';
      return this.recordingFailed ? 'Recording Failed' : 'Recording Flight Log';
    },
    recordingDetail: (state) => {
      if (state.recording.status === 'failed' || state.recording.status === 'error') {
        return state.recording.error || 'Unable to save flight log';
      }
      if (state.recording.status === 'finalizing') {
        return state.recording.fileName || 'Saving recorded flight...';
      }
      return state.recording.fileName || state.recording.outputDir || state.recording.filePath || 'Documents/Flight Fabric/Flight Logs';
    },
    recordingPillToneClass() {
      if (this.recordingFinalizing) return 'bg-sky-500/20 border-sky-500/40';
      return this.recordingFailed
        ? 'bg-amber-500/20 border-amber-500/40'
        : 'bg-red-500/15 border-red-500/40';
    },
    recordingDotToneClass() {
      if (this.recordingFinalizing) return 'bg-sky-400';
      return this.recordingFailed ? 'bg-amber-500' : 'bg-red-500';
    },
    recordingLabelToneClass() {
      if (this.recordingFinalizing) return 'text-sky-300';
      return this.recordingFailed ? 'text-amber-400' : 'text-red-400';
    },
    recordingTitleToneClass() {
      if (this.recordingFinalizing) return 'text-sky-300';
      return this.recordingFailed ? 'text-amber-400' : 'text-red-400';
    },
    surfaceVisible: (state) => state.surface.onGround === true,
    surfaceLabel: (state) => state.surface.name || 'UNKNOWN',
    surfaceToneClass: (state) => {
      if (state.surface.runwayLike) return 'bg-emerald-500/20 text-emerald-400';
      if (state.surface.class === 'UNPAVED') return 'bg-amber-500/20 text-amber-400';
      return 'bg-red-500/20 text-red-400';
    },
    runwayContextVisible: (state) => state.runwayContext.visible === true,
    runwayContextLabel: (state) => state.runwayContext.label || '--',
    vreSamplingVisible: (state) => state.vreSampling.active === true,
    vreSamplingBandLabel: (state) => formatSamplingBand(state.vreSampling.band),
    vreSamplingRateLabel: (state) => formatHz(state.vreSampling.rateHz),
    vreSamplingTargetRateLabel: (state) => formatHz(state.vreSampling.targetRateHz),
    vreSamplingIntervalLabel: (state) => formatMs(state.vreSampling.intervalMs),
    vreSamplingReasonLabel: (state) => formatSamplingReason(state.vreSampling.reason),
    vreSamplingDecisionLabel: (state) => (
      state.vreSampling.shouldSample
        ? 'writing this tick'
        : `waiting ${formatMs(state.vreSampling.nextSampleInMs)}`
    ),
    vreSamplingLastLabel() {
      const phaseLabel = this.vreSampling.phase ? String(this.vreSampling.phase) : '--';
      return `${phaseLabel} RA ${formatFeet(this.vreSampling.raFt)} VS ${formatSignedFpm(this.vreSampling.vsFpm)}`;
    },
    vreSamplingSafetyLabel: (state) => (
      state.vreSampling.ultraFidelityDisabled
        ? 'disabled'
        : `${formatMs(state.vreSampling.ultraFidelityTimeRemaining)} / ${state.vreSampling.ultraFidelitySamplesRemaining ?? '--'} samples`
    ),
    vreSamplingStyle: (state) => SAMPLING_BAND_STYLES[state.vreSampling.band] || SAMPLING_BAND_STYLES.BASELINE,
    vreSamplingPillToneClass() {
      return this.vreSamplingStyle.pill;
    },
    vreSamplingDotToneClass() {
      return this.vreSamplingStyle.dot;
    },
    vreSamplingLabelToneClass() {
      return this.vreSamplingStyle.label;
    },
    vreSamplingSummaryLabel() {
      return `VRE ${this.vreSamplingBandLabel} ${this.vreSamplingRateLabel}`;
    },
    vreSamplingRateDetail() {
      const targetRateHz = toFiniteNumber(this.vreSampling.targetRateHz);
      const effectiveRateHz = toFiniteNumber(this.vreSampling.effectiveRateHz);
      if (
        targetRateHz != null
        && effectiveRateHz != null
        && Math.abs(targetRateHz - effectiveRateHz) > 0.001
      ) {
        return `${this.vreSamplingBandLabel} at ${this.vreSamplingRateLabel} (${this.vreSamplingIntervalLabel}; ${this.vreSamplingTargetRateLabel} target)`;
      }
      return `${this.vreSamplingBandLabel} at ${this.vreSamplingRateLabel} (${this.vreSamplingIntervalLabel})`;
    },
    simToneClass: (state) => {
      if (!state.simConnected) return 'bg-surface-200 text-gray-400 border-surface-300';
      if (state.simInMenu) return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35';
    },
    simTopClass() {
      return [
        'px-3 py-1 rounded-sm text-xs font-bold tracking-widest uppercase border',
        this.simToneClass,
      ].join(' ');
    },
    simFooterClass() {
      return [
        'px-2 py-0.5 rounded text-[10px] font-mono uppercase border',
        this.simToneClass,
      ].join(' ');
    },
  },

  actions: {
    setWebsocket(state) {
      this.websocket = state;
      if (state !== 'ready') {
        this.simConnected = false;
        this.simInMenu = false;
        this.lifecycleState = '';
        this.inFlightContext = false;
        this.primarySource = null;
        this.secondarySources = [];
        this.dataSources = [];
      }
    },
    setConnectionInfo(value) {
      this.connectionInfo = value == null ? '' : String(value);
    },
    setCabinAnnouncementsState(partialState = {}) {
      this.cabinAnnouncements = {
        ...this.cabinAnnouncements,
        ...partialState,
      };
    },
    bindHeaderActions({ onStartRecordingManual = null, onEndFlightManual = null } = {}) {
      this._onStartRecordingManual = typeof onStartRecordingManual === 'function' ? onStartRecordingManual : null;
      this._onEndFlightManual = typeof onEndFlightManual === 'function' ? onEndFlightManual : null;
      this.startRecordingActionBound = this._onStartRecordingManual !== null;
      this.endFlightActionBound = this._onEndFlightManual !== null;
    },
    requestStartRecordingManual() {
      if (typeof this._onStartRecordingManual !== 'function') return false;
      if (this.recordingStartAvailable !== true) return false;
      return this._onStartRecordingManual() !== false;
    },
    requestEndFlightManual() {
      if (typeof this._onEndFlightManual !== 'function') return false;
      return this._onEndFlightManual() !== false;
    },
    showDiskWarning(message = {}) {
      this.systemBanners.disk = {
        visible: true,
        message: message.message || 'Disk space warning',
        level: message.level || '',
        rowsWritten: message.rowsWritten ?? null,
      };
    },
    dismissDiskWarning() {
      this.systemBanners.disk.visible = false;
    },
    showUpdateBanner(message = {}) {
      this.systemBanners.update = {
        visible: true,
        currentVersion: message.currentVersion || '',
        latestVersion: message.latestVersion || '',
        versionLabel: formatReleaseVersion(message.latestVersion) || 'v0.0.0 Alpha',
        message: message.message || RELEASE_WARNING,
        downloadUrl: message.downloadUrl || '',
        urgent: message.urgent === true,
      };
    },
    dismissUpdateBanner(storage) {
      const latestVersion = this.systemBanners.update.latestVersion;
      this.systemBanners.update.visible = false;

      const storageRef = resolveStorage(storage);
      if (storageRef && latestVersion) {
        persistStorageValue(storageRef, 'ff-update-dismissed', latestVersion);
      }
    },
    showRestartRequiredBanner(message = {}) {
      const existingReasons = this.systemBanners.restartRequired.visible
        ? this.systemBanners.restartRequired.reasons
        : [];
      const incomingReasons = normalizeRestartReasons(message.restartReasons || message.reasons);

      this.systemBanners.restartRequired = {
        visible: true,
        message: typeof message.message === 'string' ? message.message.trim() : '',
        reasons: normalizeRestartReasons([...existingReasons, ...incomingReasons]),
      };
    },
    dismissRestartRequiredBanner() {
      this.systemBanners.restartRequired.visible = false;
    },
    resetTelemetry(reason) {
      this.phase = '--';
      this.simInMenu = false;
      this.lifecycleState = '';
      this.inFlightContext = false;
      this.flightTime = '00:00:00';
      this.aircraftProfile = getDefaultAircraftProfile();
      this.assists = {};
      this.recording = getDefaultRecording();
      this.surface = getDefaultSurface();
      this.runwayContext = getDefaultRunwayContext();
      this.vreSampling = getDefaultVreSampling();
      if (reason === 'simconnectDisconnected' || reason === 'wsDisconnected') {
        this.simConnected = false;
        this.primarySource = null;
        this.secondarySources = [];
        this.dataSources = [];
      }
    },
    ingestMessage(message) {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'phase') {
        this.phase = message.value || '--';
        return;
      }

      if (message.type === 'simState') {
        this.simConnected = message.simconnectConnected === true;
        this.simInMenu = this.simConnected && message.inMenu === true;
        this.lifecycleState = typeof message.lifecycleState === 'string' ? message.lifecycleState : '';
        this.inFlightContext = message.inFlightContext === true;
        return;
      }

      if (message.type === 'vreSampling') {
        this.updateVreSampling(message);
        return;
      }

      if (message.type === 'assists') {
        this.updateAssists(message.data);
        return;
      }

      if (message.type === 'flightRecording') {
        this.updateRecording(message);
        return;
      }

      if (message.type === 'endFlightResult' && message.success === true) {
        this.updateRecording({ type: 'flightRecording', status: 'stopped' });
        this.updateFlightTime({ type: 'flightTime', elapsedHms: '00:00:00' });
        return;
      }

      if (message.type === 'surface') {
        this.updateSurface(message.value);
        return;
      }

      if (message.type === 'runwayContext') {
        this.updateRunwayContext(message);
        return;
      }

      if (message.type === 'flightTime') {
        this.updateFlightTime(message);
        return;
      }

      if (message.type === 'aircraftProfile') {
        this.updateAircraftProfile(message);
        return;
      }

      if (message.type === 'dataSources') {
        this.primarySource = message.primary || null;
        this.secondarySources = Array.isArray(message.secondary) ? message.secondary : [];
        const fallbackSources = [
          this.primarySource,
          ...this.secondarySources,
        ].filter(Boolean);
        this.dataSources = Array.isArray(message.sources) && message.sources.length > 0
          ? message.sources.filter(Boolean)
          : fallbackSources;
        return;
      }

      if (message.type === 'updateAvailable') {
        this.showUpdateBanner(message);
      }
    },
    updateAssists(data) {
      this.assists = data && typeof data === 'object' ? { ...data } : {};
    },
    updateRecording(message) {
      const status = String(message?.status || '').toLowerCase();
      if (!status || status === 'stopped') {
        this.recording = getDefaultRecording();
        return;
      }
      if (!['recording', 'finalizing', 'failed', 'error'].includes(status)) return;

      this.recording = {
        status,
        outputDir: typeof message.outputDir === 'string' ? message.outputDir : '',
        filePath: typeof message.filePath === 'string' ? message.filePath : '',
        fileName: typeof message.fileName === 'string' ? message.fileName : '',
        error: typeof message.error === 'string' ? message.error : '',
      };
    },
    updateSurface(surface) {
      if (!surface || surface.onGround !== true) {
        this.surface = getDefaultSurface();
        return;
      }

      this.surface = {
        onGround: true,
        name: surface.name || 'UNKNOWN',
        class: surface.class || 'UNKNOWN',
        runwayLike: surface.runwayLike === true,
      };
    },
    updateFlightTime(message) {
      this.flightTime = message?.elapsedHms || '00:00:00';
    },
    updateAircraftProfile(message) {
      const profile = message?.profile && typeof message.profile === 'object' ? message.profile : null;
      const provenance = message?.provenance && typeof message.provenance === 'object' ? message.provenance : null;
      const verificationStatus = provenance?.verificationStatus || '';
      const badgeMeta = PROFILE_BADGE_META[verificationStatus] || PROFILE_BADGE_META.unverified;
      const showVerificationBadge = Boolean(provenance && verificationStatus !== 'partial');

      this.aircraftProfile = {
        aircraftName: resolveAircraftName(profile),
        aircraftTitle: typeof profile?.aircraftTitle === 'string' ? profile.aircraftTitle : '',
        profileId: typeof profile?.id === 'string' ? profile.id : '',
        profileKey: profile?._profileKey || profile?._qualifiedId || '',
        profileName: profile?.name || '',
        verificationStatus,
        badgeStatus: showVerificationBadge ? verificationStatus : '',
        badgeLabel: showVerificationBadge ? badgeMeta.label : '',
        badgeTitle: showVerificationBadge
          ? `Profile: ${verificationStatus || 'unverified'}\nSources: ${provenance.sourceCount ?? 0}\nLast verified: ${provenance.lastVerified || 'never'}`
          : '',
      };
    },
    updateRunwayContext(message) {
      const icao = typeof message?.icao === 'string' ? message.icao.trim() : '';
      if (!icao) {
        this.runwayContext = getDefaultRunwayContext();
        return;
      }

      const runway = typeof message.runway === 'string' ? message.runway.trim() : '';
      this.runwayContext = {
        visible: true,
        label: runway ? `${icao} ${runway}` : icao,
      };
    },
    updateVreSampling(message) {
      if (!message || message.active === false) {
        this.vreSampling = getDefaultVreSampling();
        return;
      }

      const legacyRateHz = toPositiveFiniteNumber(message.rateHz);
      const effectiveRateHz = toPositiveFiniteNumber(message.effectiveRateHz) ?? legacyRateHz;
      const targetRateHz = toPositiveFiniteNumber(message.targetRateHz) ?? legacyRateHz;

      this.vreSampling = {
        active: true,
        band: String(message.band || 'BASELINE').toUpperCase(),
        targetRateHz,
        effectiveRateHz,
        rateHz: effectiveRateHz,
        intervalMs: message.intervalMs,
        shouldSample: message.shouldSample === true,
        nextSampleInMs: message.nextSampleInMs,
        reason: message.reason || 'none',
        phase: message.phase || '--',
        raFt: message.raFt,
        vsFpm: message.vsFpm,
        ultraFidelityDisabled: message.ultraFidelityDisabled === true,
        ultraFidelityTimeRemaining: message.ultraFidelityTimeRemaining,
        ultraFidelitySamplesRemaining: message.ultraFidelitySamplesRemaining,
      };
    },
  },
});
