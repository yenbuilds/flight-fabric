import { defineStore } from 'pinia';
import { useStatusStore } from './status.js';
import { useSettingsUiStore } from './settings-ui.js';

const BUSY = new Set(['checking', 'downloading', 'verifying', 'preparing', 'installing']);

export const useDesktopUpdatesStore = defineStore('desktopUpdates', {
  state: () => ({ available: false, supported: false, phase: 'unavailable', version: '', notes: '',
    progress: null, message: '', localError: '', _api: null, _stateRevision: 0 }),
  getters: {
    busy: (state) => BUSY.has(state.phase),
    installBlocker() {
      const settings = useSettingsUiStore();
      const status = useStatusStore();
      if (settings.restartActionSaveRequired || settings.restartActionSaving || settings.restartActionBusy || settings.restartActionBlocked) {
        return 'Save or discard pending Settings changes before updating.';
      }
      if (status.recording?.status === 'recording' || status.recording?.status === 'finalizing') {
        return 'Finish recording and wait for the flight log to finish saving.';
      }
      return '';
    },
    actionLabel: (state) => state.phase === 'ready' ? 'Restart and update'
      : state.phase === 'downloading' ? `Downloading ${Math.round(state.progress || 0)}%`
        : state.phase === 'verifying' ? 'Verifying…'
          : state.phase === 'preparing' ? 'Preparing…'
            : state.phase === 'installing' ? 'Installing…'
              : state.phase === 'checking' ? 'Checking…' : 'Download update',
  },
  actions: {
    applyState(value) {
      if (!value || typeof value.phase !== 'string') return;
      this._stateRevision += 1;
      for (const key of ['supported', 'phase', 'version', 'notes', 'progress', 'message']) {
        if (Object.hasOwn(value, key)) this[key] = value[key];
      }
      const status = useStatusStore();
      status.desktopUpdateManaged = this.supported;
      if (!this.supported) return;
      if (['current', 'idle'].includes(this.phase) && !this.version) {
        status.systemBanners.update.visible = false;
        return;
      }
      if (this.version) {
        const visible = status.systemBanners.update.visible;
        const sameVersion = status.systemBanners.update.latestVersion === this.version;
        let dismissed = false;
        try { dismissed = localStorage.getItem('ff-update-dismissed') === this.version; } catch {}
        status.showUpdateBanner({ desktop: true, latestVersion: this.version,
          message: this.phase === 'error' || (this.message && this.phase === 'ready')
            ? 'See Settings > About for update details.' : this.actionLabel });
        if (dismissed || (sameVersion && !visible)) status.systemBanners.update.visible = false;
      }
    },
    connect(api = globalThis.window?.electronAPI?.updates) {
      if (!api) return () => {};
      this._api = api;
      this.available = true;
      let active = true;
      let events = 0;
      const unsubscribe = api.onState((state) => { events += 1; if (active) this.applyState(state); });
      Promise.resolve(api.getState()).then((state) => {
        if (active && events === 0) this.applyState(state);
      }).catch(() => { if (active) this.localError = 'Update status could not be read. Try again.'; });
      return () => { active = false; unsubscribe?.(); this._api = null; };
    },
    async request(action) {
      if (!['check', 'download', 'cancel', 'install'].includes(action)) return;
      if (!this._api || !this.supported || (this.busy && action !== 'cancel')) return;
      this.localError = '';
      if (action === 'install') {
        if (this.installBlocker) { this.localError = this.installBlocker; return; }
        if (!window.confirm(`Restart FlightFabric and install version ${this.version}?`)) return;
      }
      const api = this._api;
      const revision = this._stateRevision;
      try {
        const state = await api[action]();
        // Events may have advanced the operation while this IPC reply was in flight.
        if (this._api === api && this._stateRevision === revision) this.applyState(state);
      }
      catch { if (this._api === api) this.localError = 'The update action could not complete. Try again or use the website download.'; }
    },
    primaryAction() { return this.request(this.phase === 'ready' ? 'install' : 'download'); },
  },
});
