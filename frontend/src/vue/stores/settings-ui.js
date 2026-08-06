import { defineStore } from 'pinia';

let legalErrorTimer = null;
let storageCopyTimer = null;

function normalizeStorageLocationEntry(entry) {
  const root = entry && typeof entry === 'object' ? entry : {};
  const id = typeof root.id === 'string' && root.id.trim() ? root.id.trim() : '';
  const pathValue = typeof root.path === 'string' ? root.path.trim() : '';
  return {
    id: id || pathValue || 'unknown',
    label: typeof root.label === 'string' && root.label.trim() ? root.label.trim() : 'Storage Location',
    path: pathValue,
    description: typeof root.description === 'string' ? root.description.trim() : '',
  };
}

function normalizeMsfsInstallEntry(entry) {
  const root = entry && typeof entry === 'object' ? entry : {};
  const installId = typeof root.id === 'string' ? root.id : '';
  const found = root.found === true;
  const communityFolder = typeof root.communityFolder === 'string' ? root.communityFolder.trim() : '';
  const community2024Folder = typeof root.community2024Folder === 'string' ? root.community2024Folder.trim() : '';
  const pathCandidates = found
    ? [
      ['localCache', 'Local Cache'],
      ['packagesFolder', 'Packages'],
      ['community2024Folder', 'Community2024 (native MSFS 2024)'],
      ['communityFolder', installId.startsWith('msfs2024-') ? 'Community (legacy compatibility)' : 'Community'],
      ['officialFolder', 'Official'],
    ]
    : [
      ['localCache', 'Checked Path'],
    ];

  return {
    key: String(installId || [root.label || 'install', root.localCache || '', found ? 'found' : 'missing'].join(':')),
    installId,
    label: typeof root.label === 'string' && root.label ? root.label : 'Unknown install',
    found,
    badgeClass: found ? 'text-emerald-400' : 'text-gray-600',
    badgeText: found ? 'Found' : 'Not found',
    paths: pathCandidates
      .map(([key, label]) => ({
        key,
        label,
        value: typeof root[key] === 'string' ? root[key] : '',
      }))
      .filter((item) => item.value),
    communityFolder,
    community2024Folder,
  };
}

export const useSettingsUiStore = defineStore('settingsUi', {
  state: () => ({
    aboutVersion: '--',
    legalError: '',
    msfsDetectError: '',
    msfsDetectActionBound: false,
    msfsDetectHasRun: false,
    msfsDetecting: false,
    msfsInstallRows: [],
    msfsInstallsModalOpen: false,
    copyStorageLocationActionBound: false,
    openStorageLocationActionBound: false,
    openLegalFileActionBound: false,
    revealLegalFolderActionBound: false,
    storageCopiedId: '',
    storageError: '',
    storageLocationActionBound: false,
    storageLocations: [],
    _onRestartAction: null,
    restartActionBound: false,
    restartActionAvailable: false,
    restartActionBusy: false,
    restartActionTitle: '',
  }),

  getters: {
    isElectron: (state) => (
      state.openLegalFileActionBound
      || state.revealLegalFolderActionBound
      || state.msfsDetectActionBound
      || state.storageLocationActionBound
      || state.openStorageLocationActionBound
      || state.copyStorageLocationActionBound
      || state.restartActionAvailable
    ),
    canDetectMsfsInstalls: (state) => state.msfsDetectActionBound,
    msfsDetectButtonLabel: (state) => (state.msfsDetecting ? 'Scanning...' : 'Detect'),
    msfsDetectEmptyMessage: (state) => (
      state.msfsDetecting
        ? 'Scanning local install metadata...'
        : state.msfsDetectHasRun
          ? 'No results returned.'
          : 'Press Detect to scan for installations.'
    ),
    restartActionDisabled: (state) => state.restartActionBusy || !state.restartActionAvailable,
    restartActionLabel: (state) => (state.restartActionBusy ? 'Restarting...' : 'Restart App'),
    storageLocationRows: (state) => state.storageLocations.map((entry) => ({
      ...entry,
      copyLabel: state.storageCopiedId === entry.id ? 'Copied' : 'Copy Path',
    })),
  },

  actions: {
    bindDesktopActions({
      detectMsfsInstalls = null,
      getStorageLocations = null,
      openStorageLocation = null,
      openLegalFile = null,
      revealLegalFolder = null,
      copyStorageLocationPath = null,
    } = {}) {
      this._onDetectMsfsInstalls = typeof detectMsfsInstalls === 'function' ? detectMsfsInstalls : null;
      this._onGetStorageLocations = typeof getStorageLocations === 'function' ? getStorageLocations : null;
      this._onOpenStorageLocation = typeof openStorageLocation === 'function' ? openStorageLocation : null;
      this._onOpenLegalFile = typeof openLegalFile === 'function' ? openLegalFile : null;
      this._onRevealLegalFolder = typeof revealLegalFolder === 'function' ? revealLegalFolder : null;
      this._onCopyStorageLocationPath = typeof copyStorageLocationPath === 'function' ? copyStorageLocationPath : null;
      this.msfsDetectActionBound = this._onDetectMsfsInstalls !== null;
      this.storageLocationActionBound = this._onGetStorageLocations !== null;
      this.openStorageLocationActionBound = this._onOpenStorageLocation !== null;
      this.copyStorageLocationActionBound = this._onCopyStorageLocationPath !== null;
      this.openLegalFileActionBound = this._onOpenLegalFile !== null;
      this.revealLegalFolderActionBound = this._onRevealLegalFolder !== null;
    },

    bindRestartAction(action = null) {
      this._onRestartAction = typeof action === 'function' ? action : null;
      this.restartActionBound = this._onRestartAction !== null;
    },

    async requestRestart() {
      if (typeof this._onRestartAction !== 'function') return false;
      const result = await this._onRestartAction();
      return result !== false;
    },

    clearLegalError() {
      this.legalError = '';
      clearTimeout(legalErrorTimer);
      legalErrorTimer = null;
    },

    clearStorageError() {
      this.storageError = '';
    },

    async requestOpenLegalFile(filename) {
      if (!this.isElectron || typeof this._onOpenLegalFile !== 'function') return false;
      this.clearLegalError();
      const result = await this._onOpenLegalFile(filename);
      if (result?.success) return true;
      this.setLegalError(`Could not open ${filename}: ${(result && result.error) || 'unknown error'}`);
      return false;
    },

    async requestRevealLegalFolder() {
      if (!this.isElectron || typeof this._onRevealLegalFolder !== 'function') return false;
      this.clearLegalError();
      const result = await this._onRevealLegalFolder();
      if (result?.success) return true;
      this.setLegalError(`Could not open legal folder: ${(result && result.error) || 'unknown error'}`);
      return false;
    },

    async requestStorageLocations() {
      if (typeof this._onGetStorageLocations !== 'function') return false;
      this.clearStorageError();
      const result = await this._onGetStorageLocations();
      if (Array.isArray(result?.locations)) {
        this.setStorageLocations(result.locations);
        return true;
      }
      if (Array.isArray(result)) {
        this.setStorageLocations(result);
        return true;
      }
      this.setStorageError(`Could not load storage locations: ${(result && result.error) || 'unknown error'}`);
      return false;
    },

    async requestOpenStorageLocation(location) {
      const row = normalizeStorageLocationEntry(location);
      if (!row.path || typeof this._onOpenStorageLocation !== 'function') return false;
      this.clearStorageError();
      const result = await this._onOpenStorageLocation(row.path);
      if (result?.success || result === true) return true;
      this.setStorageError(`Could not open ${row.label}: ${(result && result.error) || 'unknown error'}`);
      return false;
    },

    async requestCopyStorageLocationPath(location) {
      const row = normalizeStorageLocationEntry(location);
      if (!row.path || typeof this._onCopyStorageLocationPath !== 'function') return false;
      this.clearStorageError();
      const result = await this._onCopyStorageLocationPath(row.path);
      if (result === false) {
        this.setStorageError(`Could not copy ${row.label}: clipboard unavailable`);
        return false;
      }
      this.storageCopiedId = row.id;
      clearTimeout(storageCopyTimer);
      storageCopyTimer = setTimeout(() => {
        this.storageCopiedId = '';
        storageCopyTimer = null;
      }, 1600);
      return true;
    },

    setAboutVersion(version) {
      this.aboutVersion = version || '--';
    },

    setLegalError(message) {
      this.legalError = message || '';
      clearTimeout(legalErrorTimer);
      if (!this.legalError) {
        legalErrorTimer = null;
        return;
      }
      legalErrorTimer = setTimeout(() => {
        this.legalError = '';
        legalErrorTimer = null;
      }, 5000);
    },

    setStorageError(message) {
      this.storageError = message || '';
    },

    setStorageLocations(locations) {
      this.storageLocations = Array.isArray(locations)
        ? locations.map((entry) => normalizeStorageLocationEntry(entry)).filter((entry) => entry.path)
        : [];
      this.storageError = '';
    },

    setRestartActionState(payload = {}) {
      if (Object.prototype.hasOwnProperty.call(payload, 'available')) {
        this.restartActionAvailable = payload.available === true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'busy')) {
        this.restartActionBusy = payload.busy === true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
        this.restartActionTitle = payload.title || '';
      }
    },

    openMsfsInstallsModal() {
      if (!this.canDetectMsfsInstalls) return false;
      this.msfsInstallsModalOpen = true;
      return true;
    },

    closeMsfsInstallsModal() {
      this.msfsInstallsModalOpen = false;
    },

    setMsfsDetecting(isDetecting) {
      this.msfsDetecting = isDetecting === true;
      if (this.msfsDetecting) {
        this.msfsDetectError = '';
      }
    },

    async requestMsfsInstallDetection() {
      if (!this.canDetectMsfsInstalls || this.msfsDetecting || typeof this._onDetectMsfsInstalls !== 'function') {
        return false;
      }

      this.setMsfsDetecting(true);
      try {
        const installs = await this._onDetectMsfsInstalls();
        this.setMsfsInstallResults(installs);
        return true;
      } catch (error) {
        this.setMsfsDetectError(`Detection failed: ${error?.message || 'unknown error'}`);
        return false;
      }
    },

    setMsfsInstallResults(installs) {
      this.msfsInstallRows = Array.isArray(installs)
        ? installs.map((entry) => normalizeMsfsInstallEntry(entry))
        : [];
      this.msfsDetectError = '';
      this.msfsDetectHasRun = true;
      this.msfsDetecting = false;
    },

    setMsfsDetectError(message) {
      this.msfsDetectError = message || 'Detection failed.';
      this.msfsDetectHasRun = true;
      this.msfsDetecting = false;
      this.msfsInstallRows = [];
    },

    resetMsfsDetectState() {
      this.msfsDetectError = '';
      this.msfsDetectHasRun = false;
      this.msfsDetecting = false;
      this.msfsInstallRows = [];
    },
  },
});
