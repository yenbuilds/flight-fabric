import { defineStore } from 'pinia';

function resolveProfileKey(profile = {}) {
  if (typeof profile._profileKey === 'string' && profile._profileKey) return profile._profileKey;
  if (typeof profile._qualifiedId === 'string' && profile._qualifiedId) return profile._qualifiedId;
  if (profile.namespace && profile.simulator && profile.id) {
    return `${profile.namespace}/${profile.simulator}/${profile.id}`;
  }
  return null;
}

function resolveProfileRevision(profile = {}) {
  return Number.isInteger(profile.profileRevision) ? profile.profileRevision : null;
}

function resolveTemplateId(profile = {}) {
  return typeof profile.aircraftSpecificTemplateId === 'string' && profile.aircraftSpecificTemplateId
    ? profile.aircraftSpecificTemplateId
    : null;
}

const SAFE_ACTION_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const SAFE_SOURCE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SOURCE_STATUSES = new Set([
  'connected',
  'stale',
  'disconnected',
  'disabled',
  'paused',
  'error',
  'unsupported',
  'awaiting-values',
]);
const MOBIFLIGHT_DEPENDENCY_STATUSES = new Set([
  'connected',
  'connecting',
  'disabled',
  'disconnected',
  'error',
  'missing',
  'unavailable',
]);

function isSafeActionId(value) {
  return typeof value === 'string' && value.length <= 96 && SAFE_ACTION_ID_RE.test(value);
}

function copySourceStatuses(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([sourceId, status]) => (
      SAFE_SOURCE_ID_RE.test(sourceId) && SOURCE_STATUSES.has(status)
    )),
  );
}

function copyActionCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([actionId, supported]) => (
      isSafeActionId(actionId) && typeof supported === 'boolean'
    )),
  );
}

function copyDependencies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const rawDependency = value.mobiflightEventModule;
  if (!rawDependency || typeof rawDependency !== 'object' || Array.isArray(rawDependency)) return {};
  const required = rawDependency.required === true;
  const fallbackActive = rawDependency.fallbackActive === true;
  if (!required && !fallbackActive) return {};
  const status = typeof rawDependency.status === 'string'
    && MOBIFLIGHT_DEPENDENCY_STATUSES.has(rawDependency.status)
    ? rawDependency.status
    : 'unavailable';
  return {
    mobiflightEventModule: {
      required,
      fallbackActive,
      connected: rawDependency.connected === true,
      status,
      scope: rawDependency.scope === 'some-controls' ? 'some-controls' : 'all-controls',
    },
  };
}

export const useAircraftSpecificStore = defineStore('aircraftSpecific', {
  state: () => ({
    activeProfileKey: null,
    activeProfileRevision: null,
    templateId: null,
    available: false,
    sourceStatus: 'awaiting-values',
    sourceStatuses: {},
    values: {},
    unavailable: [],
    actionCapabilities: {},
    dependencies: {},
    updatedAt: null,
    _requestAction: null,
  }),

  getters: {
    hasTemplate: (state) => typeof state.templateId === 'string' && state.templateId.length > 0,
    controlsSetupRequired: (state) => {
      const dependency = state.dependencies.mobiflightEventModule;
      if (dependency?.required !== true || dependency.connected === true) return false;
      return ['disabled', 'error', 'missing', 'unavailable'].includes(dependency.status);
    },
    statusLabel: (state) => {
      const labels = {
        connected: state.available
          ? (state.unavailable.length > 0 ? 'Some aircraft data unavailable' : 'Live aircraft data')
          : 'Waiting for supported values',
        stale: 'Aircraft data is stale',
        disconnected: 'Simulator disconnected',
        disabled: 'Aircraft data source is disabled',
        paused: 'Aircraft data paused in menus',
        error: 'Aircraft data source error',
        unsupported: 'Aircraft data provider is not supported',
        'awaiting-values': 'Waiting for aircraft data',
      };
      return labels[state.sourceStatus] || labels['awaiting-values'];
    },
  },

  actions: {
    clearSnapshot(sourceStatus = 'awaiting-values') {
      this.available = false;
      this.sourceStatus = sourceStatus;
      this.sourceStatuses = {};
      this.values = {};
      this.unavailable = [];
      this.actionCapabilities = {};
      if (sourceStatus === 'disconnected' && this.dependencies.mobiflightEventModule) {
        this.dependencies = {
          mobiflightEventModule: {
            ...this.dependencies.mobiflightEventModule,
            connected: false,
            fallbackActive: false,
            status: 'disconnected',
          },
        };
      }
      this.updatedAt = null;
    },

    applyProfile(profile = {}) {
      this.activeProfileKey = resolveProfileKey(profile);
      this.activeProfileRevision = resolveProfileRevision(profile);
      this.templateId = resolveTemplateId(profile);
      this.dependencies = {};
      this.clearSnapshot();
    },

    prepareForAircraftChange() {
      this.activeProfileKey = null;
      this.activeProfileRevision = null;
      this.templateId = null;
      this.dependencies = {};
      this.clearSnapshot();
    },

    applyActionCapabilities(capabilities = {}) {
      this.actionCapabilities = copyActionCapabilities(capabilities);
    },

    applyDependencies(dependencies = {}) {
      this.dependencies = copyDependencies(dependencies);
    },

    bindRuntimeActions({ requestAction } = {}) {
      this._requestAction = typeof requestAction === 'function' ? requestAction : null;
    },

    isActionSupported(actionId) {
      return typeof actionId === 'string'
        && isSafeActionId(actionId)
        && this.actionCapabilities[actionId] === true;
    },

    requestAction(actionId, options = {}) {
      if (!this.isActionSupported(actionId) || typeof this._requestAction !== 'function') return false;
      return this._requestAction(actionId, options);
    },

    ingestState(message = {}) {
      if (!this.hasTemplate) return false;
      if (message.profileKey !== this.activeProfileKey) return false;
      if (message.profileRevision !== this.activeProfileRevision) return false;
      if (message.templateId !== this.templateId) return false;

      this.available = message.available === true;
      const overallStatus = SOURCE_STATUSES.has(message.sourceStatus?.overall)
        ? message.sourceStatus.overall
        : (SOURCE_STATUSES.has(message.sourceStatus?.lvar) ? message.sourceStatus.lvar : 'awaiting-values');
      this.sourceStatus = overallStatus;
      this.sourceStatuses = copySourceStatuses(
        message.sourceStatus?.sources
          || (typeof message.sourceStatus?.lvar === 'string' ? { lvar: message.sourceStatus.lvar } : {}),
      );
      this.values = message.values && typeof message.values === 'object'
        ? { ...message.values }
        : {};
      this.unavailable = Array.isArray(message.unavailable)
        ? message.unavailable.filter((id) => typeof id === 'string')
        : [];
      this.applyActionCapabilities(message.actionCapabilities);
      if (Object.prototype.hasOwnProperty.call(message, 'dependencies')) {
        this.applyDependencies(message.dependencies);
      }
      this.updatedAt = typeof message.updatedAt === 'string' ? message.updatedAt : null;
      return true;
    },

    applySimState(message = {}) {
      if (message.simconnectConnected !== true) {
        this.clearSnapshot('disconnected');
      } else if (message.inMenu === true) {
        this.clearSnapshot('paused');
      }
    },
  },
});
