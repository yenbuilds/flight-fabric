'use strict';

const { MSG } = require('../core/message-types') as {
  MSG: Readonly<Record<string, string>>;
};
const {
  defaultAircraftSpecificBindingResolverRegistry,
} = require('./aircraft-specific-binding-resolvers.js') as {
  defaultAircraftSpecificBindingResolverRegistry: AircraftSpecificBindingResolverRegistry;
};

type AnyRecord = Record<string, any>;
type AircraftSpecificSourceStatus =
  | 'connected'
  | 'stale'
  | 'disconnected'
  | 'disabled'
  | 'paused'
  | 'error'
  | 'unsupported'
  | 'awaiting-values';

type AircraftSpecificFieldConfig = {
  decode: AnyRecord;
  id: string;
  runtimeKey?: string;
  source?: AnyRecord;
};

type AircraftSpecificConfig = {
  fields: AircraftSpecificFieldConfig[];
  integrationId?: string | null;
  profileKey: string;
  profileRevision: number;
  templateId: string | null;
};

type AircraftSpecificStateBuildContext = {
  config: AircraftSpecificConfig;
  nowEpochMs: number;
  timestampIso: string;
};

type ProjectorInput = {
  frame?: AnyRecord | null;
  simState?: AnyRecord | null;
  nowEpochMs?: number;
  timestampIso?: string;
};

type AircraftSpecificBindingResolverRegistry = {
  resolve: (binding: unknown, context: AnyRecord) => {
    rawValue?: unknown;
    sourceId: string;
    status: AircraftSpecificSourceStatus;
  };
};

const DEFAULT_STALE_AFTER_MS = 2000;
const SAFE_ACTION_ID_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

function valuesMatch(rawValue: unknown, configuredValues: unknown[]): boolean {
  return configuredValues.some((configuredValue) => Object.is(rawValue, configuredValue));
}

function decodeAircraftSpecificValue(rawValue: unknown, decoder: AnyRecord | null | undefined): string | number | boolean | undefined {
  if (rawValue == null || !decoder || typeof decoder !== 'object') return undefined;

  if (decoder.type === 'boolean') {
    if (Array.isArray(decoder.trueValues) && valuesMatch(rawValue, decoder.trueValues)) return true;
    if (Array.isArray(decoder.falseValues) && valuesMatch(rawValue, decoder.falseValues)) return false;
    return undefined;
  }

  if (decoder.type === 'enum') {
    if (!decoder.values || typeof decoder.values !== 'object') return undefined;
    const enumKey = String(rawValue);
    if (!Object.prototype.hasOwnProperty.call(decoder.values, enumKey)) return undefined;
    const decodedValue = decoder.values[enumKey];
    return decodedValue != null && ['string', 'number', 'boolean'].includes(typeof decodedValue)
      ? decodedValue
      : undefined;
  }

  if (decoder.type === 'number') {
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return undefined;
    if (
      Array.isArray(decoder.unavailableValues)
      && decoder.unavailableValues.some((value: unknown) => (
        typeof value === 'number'
        && Number.isFinite(value)
        && Object.is(rawValue, value)
      ))
    ) {
      return undefined;
    }
    const scale = typeof decoder.scale === 'number' && Number.isFinite(decoder.scale) ? decoder.scale : 1;
    const offset = typeof decoder.offset === 'number' && Number.isFinite(decoder.offset) ? decoder.offset : 0;
    let decodedValue = (rawValue * scale) + offset;
    if (Number.isInteger(decoder.precision) && decoder.precision >= 0 && decoder.precision <= 6) {
      const factor = 10 ** decoder.precision;
      decodedValue = Math.round(decodedValue * factor) / factor;
    }
    return Number.isFinite(decodedValue) ? decodedValue : undefined;
  }

  return undefined;
}

function selectOverallSourceStatus(
  sources: Record<string, AircraftSpecificSourceStatus>,
  hasValues: boolean,
): AircraftSpecificSourceStatus {
  if (hasValues || Object.values(sources).includes('connected')) return 'connected';
  const precedence: AircraftSpecificSourceStatus[] = [
    'error',
    'stale',
    'paused',
    'disconnected',
    'disabled',
    'unsupported',
    'awaiting-values',
  ];
  return precedence.find((status) => Object.values(sources).includes(status)) || 'awaiting-values';
}

function sanitizeActionCapabilities(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const capabilities: Record<string, boolean> = {};
  for (const [actionId, supported] of Object.entries(value as AnyRecord)) {
    if (actionId.length <= 96 && SAFE_ACTION_ID_RE.test(actionId) && typeof supported === 'boolean') {
      capabilities[actionId] = supported;
    }
  }
  return capabilities;
}

const MOBIFLIGHT_DEPENDENCY_STATES = new Set([
  'connected',
  'connecting',
  'disabled',
  'disconnected',
  'error',
  'missing',
  'unavailable',
]);

function sanitizeAircraftSpecificDependencies(value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const rawDependency = (value as AnyRecord).mobiflightEventModule;
  if (!rawDependency || typeof rawDependency !== 'object' || Array.isArray(rawDependency)) return {};
  const required = rawDependency.required === true;
  const fallbackActive = rawDependency.fallbackActive === true;
  if (!required && !fallbackActive) return {};
  const rawStatus = typeof rawDependency.status === 'string'
    ? rawDependency.status.trim().toLowerCase()
    : '';
  return {
    mobiflightEventModule: {
      required,
      fallbackActive,
      connected: rawDependency.connected === true,
      status: MOBIFLIGHT_DEPENDENCY_STATES.has(rawStatus) ? rawStatus : 'unavailable',
      scope: rawDependency.scope === 'some-controls' ? 'some-controls' : 'all-controls',
    },
  };
}

function buildAircraftSpecificState(params: {
  config: AircraftSpecificConfig;
  frame?: AnyRecord | null;
  simState?: AnyRecord | null;
  nowEpochMs?: number;
  actionCapabilities?: unknown;
  dependencies?: unknown;
  resolverRegistry?: AircraftSpecificBindingResolverRegistry;
  staleAfterMs?: number;
  timestampIso?: string;
}) {
  const nowEpochMs = Number.isFinite(params.nowEpochMs) ? Number(params.nowEpochMs) : Date.now();
  const timestampIso = typeof params.timestampIso === 'string' && params.timestampIso
    ? params.timestampIso
    : new Date(nowEpochMs).toISOString();
  const staleAfterMs = Number.isFinite(params.staleAfterMs)
    ? Math.max(0, Number(params.staleAfterMs))
    : DEFAULT_STALE_AFTER_MS;
  const resolverRegistry = params.resolverRegistry || defaultAircraftSpecificBindingResolverRegistry;
  const values: Record<string, string | number | boolean> = {};
  const unavailable: string[] = [];
  const sources: Record<string, AircraftSpecificSourceStatus> = {};

  for (const field of params.config.fields) {
    const binding = field.source || (field.runtimeKey
      ? { type: 'lvar', key: field.runtimeKey }
      : null);
    const resolved = resolverRegistry.resolve(binding, {
      config: params.config,
      frame: params.frame,
      simState: params.simState,
      nowEpochMs,
      staleAfterMs,
    });
    const previousStatus = sources[resolved.sourceId];
    sources[resolved.sourceId] = previousStatus
      ? selectOverallSourceStatus({ previous: previousStatus, next: resolved.status }, false)
      : resolved.status;
    if (resolved.status !== 'connected') {
      unavailable.push(field.id);
      continue;
    }
    const decodedValue = decodeAircraftSpecificValue(resolved.rawValue, field.decode);
    if (decodedValue === undefined) {
      unavailable.push(field.id);
    } else {
      values[field.id] = decodedValue;
    }
  }

  const available = Object.keys(values).length > 0;
  const overallSourceStatus = selectOverallSourceStatus(sources, available);

  return {
    type: MSG.AIRCRAFT_SPECIFIC_STATE,
    profileKey: params.config.profileKey,
    profileRevision: params.config.profileRevision,
    templateId: params.config.templateId,
    available,
    sourceStatus: {
      overall: overallSourceStatus,
      sources,
    },
    values,
    unavailable,
    actionCapabilities: sanitizeActionCapabilities(params.actionCapabilities),
    dependencies: sanitizeAircraftSpecificDependencies(params.dependencies),
    updatedAt: timestampIso,
  };
}

function createAircraftSpecificStateProjector(params: {
  broadcast: (message: AnyRecord) => void;
  getCapabilities?: () => Readonly<{ actions?: unknown; dependencies?: unknown }>;
  onStateBuilt?: (state: AnyRecord, context: AircraftSpecificStateBuildContext) => void;
  onStateObserverError?: (error: unknown) => void;
  profileLoader: AnyRecord;
  resolverRegistry?: AircraftSpecificBindingResolverRegistry;
  staleAfterMs?: number;
}) {
  let cachedConfig: AircraftSpecificConfig | null = null;
  let cachedRevision: number | null = null;
  let lastSignature: string | null = null;
  let lastObservedConfig: AircraftSpecificConfig | null = null;

  function reset(): void {
    cachedConfig = null;
    cachedRevision = null;
    lastSignature = null;
    lastObservedConfig = null;
  }

  function notifyObserver(
    state: AnyRecord,
    config: AircraftSpecificConfig,
    nowEpochMs: number,
    timestampIso: string,
  ): void {
    if (!params.onStateBuilt) return;
    try {
      params.onStateBuilt(state, { config, nowEpochMs, timestampIso });
    } catch (error) {
      try {
        params.onStateObserverError?.(error);
      } catch {}
    }
  }

  function update(input: ProjectorInput = {}): AnyRecord | null {
    const activeRevision = Number(params.profileLoader.getActiveProfileRevision?.() || 0);
    if (!cachedConfig || cachedRevision !== activeRevision) {
      cachedConfig = params.profileLoader.getAircraftSpecificConfig?.() || null;
      cachedRevision = activeRevision;
      lastSignature = null;
    }

    const nowEpochMs = Number.isFinite(input.nowEpochMs) ? Number(input.nowEpochMs) : Date.now();
    const timestampIso = typeof input.timestampIso === 'string' && input.timestampIso
      ? input.timestampIso
      : new Date(nowEpochMs).toISOString();

    if (!cachedConfig?.templateId || cachedConfig.fields.length === 0) {
      // A supported -> unsupported/profile-without-fields transition must clear
      // the recorder's last logical values. Do not notify on a generic flight
      // that never had a supported config, preserving lazy sidecar creation.
      if (lastObservedConfig) {
        notifyObserver({
          type: MSG.AIRCRAFT_SPECIFIC_STATE,
          profileKey: lastObservedConfig.profileKey,
          profileRevision: lastObservedConfig.profileRevision,
          templateId: lastObservedConfig.templateId,
          available: false,
          sourceStatus: { overall: 'unsupported', sources: {} },
          values: {},
          unavailable: lastObservedConfig.fields.map((field) => field.id).sort(),
          actionCapabilities: {},
          dependencies: {},
          updatedAt: timestampIso,
        }, lastObservedConfig, nowEpochMs, timestampIso);
        lastObservedConfig = null;
      }
      lastSignature = null;
      return null;
    }

    const capabilities = params.getCapabilities?.() || {};
    const message = buildAircraftSpecificState({
      config: cachedConfig,
      frame: input.frame,
      simState: input.simState,
      nowEpochMs,
      timestampIso,
      staleAfterMs: params.staleAfterMs,
      resolverRegistry: params.resolverRegistry,
      actionCapabilities: capabilities.actions,
      dependencies: capabilities.dependencies,
    });

    // Observers consume the canonical decoded state. Run them before WebSocket
    // deduplication so recorders see every simulator tick without resolving or
    // decoding aircraft-specific bindings a second time.
    notifyObserver(message, cachedConfig, nowEpochMs, timestampIso);
    lastObservedConfig = cachedConfig;

    const { updatedAt: _updatedAt, ...signaturePayload } = message;
    const signature = JSON.stringify(signaturePayload);
    if (signature === lastSignature) return null;

    lastSignature = signature;
    params.broadcast(message);
    return message;
  }

  return { reset, update };
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  buildAircraftSpecificState,
  createAircraftSpecificStateProjector,
  decodeAircraftSpecificValue,
  selectOverallSourceStatus,
};

export {};
