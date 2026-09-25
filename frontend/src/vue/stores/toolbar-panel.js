import { defineStore } from 'pinia';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';

const SETUP_DISMISSED_KEY = 'ff_toolbar_setup_dismissed_v1';
const SETUP_TASKS = Object.freeze({
  repair_required: { title: 'Repair your toolbar', action: 'Review repair', detail: 'Restore the FlightFabric panel in MSFS 2024.' },
  configuration_update_required: { title: 'Reconnect your toolbar', action: 'Update toolbar ports', detail: 'Your toolbar needs the new FlightFabric connection settings.' },
  update_available: { title: 'Update your toolbar', action: 'Review update', detail: 'A newer MSFS 2024 toolbar package is ready to install.' },
  not_installed: { title: 'Add FlightFabric to MSFS', action: 'Set up toolbar', detail: 'See your plan, voice reference and last landing inside MSFS 2024.' },
});

// Presentation of the desktop installer's status model. The main process
// owns every path and decision; this store only renders what it reports and
// forwards a detected install id back.
const STATUS_PRESENTATION = Object.freeze({
  not_installed: { label: 'Not installed', tone: 'muted', action: 'Install' },
  installed: { label: 'Installed', tone: 'good', action: 'Reinstall' },
  update_available: { label: 'Update available', tone: 'warn', action: 'Update' },
  configuration_update_required: { label: 'Ports changed', tone: 'warn', action: 'Update ports' },
  repair_required: { label: 'Needs repair', tone: 'danger', action: 'Repair' },
  foreign_package: { label: 'Folder in use by another add-on', tone: 'danger', action: '' },
});

function normalizeInstallRow(entry) {
  const root = entry && typeof entry === 'object' ? entry : {};
  const installId = typeof root.installId === 'string' ? root.installId : '';
  const found = root.found === true;
  const status = typeof root.status === 'string' && STATUS_PRESENTATION[root.status] ? root.status : 'not_installed';
  const presentation = found ? STATUS_PRESENTATION[status] : { label: 'Not found on this PC', tone: 'muted', action: '' };
  const installedVersion = typeof root.installedVersion === 'string' && root.installedVersion ? root.installedVersion : '';
  const problems = Array.isArray(root.problems) ? root.problems.filter((item) => typeof item === 'string' && item).slice(0, 6) : [];
  const strayCopies = Array.isArray(root.strayCopies) ? root.strayCopies.length : 0;
  let detail = '';
  if (found && status === 'installed') detail = installedVersion ? `Version ${installedVersion}` : '';
  if (found && status === 'update_available') {
    detail = strayCopies > 0
      ? 'An older copy was found in another Community folder and will be cleaned up.'
      : (installedVersion ? `Installed ${installedVersion}; this FlightFabric ships a newer package.` : '');
  }
  if (found && status === 'configuration_update_required') detail = 'The FlightFabric network ports changed since the package was installed.';
  if (found && status === 'repair_required') detail = problems[0] || 'The installed package is incomplete.';
  if (found && status === 'foreign_package') detail = 'A package with the same folder name belongs to something else. FlightFabric will not touch it.';
  return {
    key: installId || root.label || 'install',
    installId,
    label: typeof root.label === 'string' && root.label ? root.label : 'MSFS 2024',
    found,
    status,
    statusLabel: presentation.label,
    tone: presentation.tone,
    actionLabel: presentation.action,
    canInstall: found && root.canInstall !== false && Boolean(presentation.action) && Boolean(installId),
    canRemove: found && status !== 'not_installed' && status !== 'foreign_package' && Boolean(installId),
    communityFolder: typeof root.communityFolder === 'string' ? root.communityFolder : '',
    installedVersion,
    detail,
    problems,
  };
}

export const useToolbarPanelStore = defineStore('toolbarPanel', {
  state: () => ({
    actionBound: false,
    loading: false,
    hasLoaded: false,
    busyInstallId: '',
    busyAction: '',
    error: '',
    sourceError: '',
    packageVersion: '',
    ports: null,
    installs: [],
    result: null,
    setupDismissed: readStorageValue(SETUP_DISMISSED_KEY, { fallback: '' }) === 'yes',
    _actions: null,
  }),

  getters: {
    available: (state) => state.actionBound,
    rows: (state) => state.installs.map((entry) => normalizeInstallRow(entry)),
    hasFoundInstall: (state) => state.installs.some((entry) => entry && entry.found === true),
    busy: (state) => state.loading || Boolean(state.busyInstallId),
    setupTask() {
      if (!this.available || !this.hasLoaded || !this.hasFoundInstall) return null;
      if (this.error || this.sourceError) return {
        kind: 'error', title: 'Check your toolbar', action: 'Review setup',
        detail: 'FlightFabric could not confirm the toolbar setup. Open it to review the details.',
      };
      for (const [kind, task] of Object.entries(SETUP_TASKS)) {
        if (kind === 'not_installed' && this.setupDismissed) continue;
        if (this.rows.some(row => row.canInstall && row.status === kind)) return { kind, ...task };
      }
      return null;
    },
    restartNotice: (state) => (
      state.result && state.result.restartRequired === true
        ? 'Restart Microsoft Flight Simulator 2024 to pick up the change.'
        : ''
    ),
  },

  actions: {
    dismissSetup() {
      this.setupDismissed = true;
      writeStorageValue(SETUP_DISMISSED_KEY, 'yes');
    },

    bindDesktopActions(actions = null) {
      const getStatus = typeof actions?.getStatus === 'function' ? actions.getStatus : null;
      const install = typeof actions?.install === 'function' ? actions.install : null;
      const uninstall = typeof actions?.uninstall === 'function' ? actions.uninstall : null;
      this._actions = getStatus && install && uninstall ? { getStatus, install, uninstall } : null;
      this.actionBound = this._actions !== null;
    },

    applyStatus(payload) {
      const root = payload && typeof payload === 'object' ? payload : {};
      this.installs = Array.isArray(root.installs) ? root.installs : [];
      this.packageVersion = typeof root.packageVersion === 'string' ? root.packageVersion : '';
      this.ports = root.ports && typeof root.ports === 'object' ? { ...root.ports } : null;
      this.sourceError = root.ok === false && typeof root.error === 'string' ? root.error : '';
      this.hasLoaded = true;
    },

    async refresh({ preserveError = false } = {}) {
      if (!this._actions || this.loading) return false;
      this.loading = true;
      if (!preserveError) this.error = '';
      try {
        this.applyStatus(await this._actions.getStatus());
        return true;
      } catch (err) {
        this.error = `Could not read the toolbar package status: ${err?.message || 'unknown error'}`;
        this.hasLoaded = true;
        return false;
      } finally {
        this.loading = false;
      }
    },

    async runAction(action, installId) {
      if (!this._actions || this.busyInstallId || typeof installId !== 'string' || !installId) return false;
      this.busyInstallId = installId;
      this.busyAction = action;
      this.error = '';
      this.result = null;
      try {
        const response = await this._actions[action](installId);
        if (!response || response.ok !== true) {
          this.error = response?.error || `The toolbar package ${action} failed.`;
          return false;
        }
        this.result = {
          installId,
          action,
          restartRequired: response.restartRequired === true,
          message: action === 'uninstall'
            ? (response.removed === true ? 'Toolbar package removed.' : 'No toolbar package was installed.')
            : 'Toolbar package installed. Open the FlightFabric button in the MSFS toolbar after the restart.',
        };
        if (action === 'uninstall') this.dismissSetup();
        return true;
      } catch (err) {
        this.error = `The toolbar package ${action} failed: ${err?.message || 'unknown error'}`;
        return false;
      } finally {
        this.busyInstallId = '';
        this.busyAction = '';
        await this.refresh({ preserveError: true });
      }
    },

    install(installId) {
      return this.runAction('install', installId);
    },

    uninstall(installId) {
      return this.runAction('uninstall', installId);
    },
  },
});
