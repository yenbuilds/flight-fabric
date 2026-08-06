'use strict';

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

type ResolverContext = {
  config?: AnyRecord | null;
  frame?: AnyRecord | null;
  nowEpochMs: number;
  simState?: AnyRecord | null;
  staleAfterMs: number;
};

type CompileContext = {
  fieldId: string;
  registerLvar?: (key: string, rawValue: unknown, sourcePath: string) => string | null;
  sourcePath: string;
};

type BindingResolution = {
  rawValue?: unknown;
  sourceId: string;
  status: AircraftSpecificSourceStatus;
};

type BindingResolver = {
  compile?: (source: AnyRecord, context: CompileContext) => AnyRecord | null;
  resolve: (binding: AnyRecord, context: ResolverContext) => BindingResolution;
  type: string;
};

const SAFE_SOURCE_TYPE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SOURCE_STATUSES = new Set<AircraftSpecificSourceStatus>([
  'connected',
  'stale',
  'disconnected',
  'disabled',
  'paused',
  'error',
  'unsupported',
  'awaiting-values',
]);
const SIMVAR_FRAME_PATHS: Readonly<Record<string, string>> = Object.freeze({
  'AIRSPEED MACH': 'fdm.mach',
  'AMBIENT TEMPERATURE': 'fdm.oatC',
  'AUTOPILOT AIRSPEED HOLD': 'fdm.apSpeedHold',
  'AUTOPILOT AIRSPEED HOLD VAR': 'fdm.apSpeedTargetKts',
  'AUTOPILOT ALTITUDE LOCK': 'fdm.apAltHold',
  'AUTOPILOT ALTITUDE LOCK VAR': 'fdm.apAltTargetFt',
  'AUTOPILOT APPROACH HOLD': 'fdm.apApprHold',
  'AUTOPILOT FLIGHT DIRECTOR ACTIVE': 'fdm.apFdActive',
  'AUTOPILOT FLIGHT LEVEL CHANGE': 'fdm.apFlcHold',
  'AUTOPILOT HEADING LOCK': 'fdm.apHdgHold',
  'AUTOPILOT HEADING LOCK DIR': 'fdm.apHdgTargetDeg',
  'AUTOPILOT MASTER': 'fdm.apMaster',
  'AUTOPILOT NAV1 LOCK': 'fdm.apNavHold',
  'AUTOPILOT THROTTLE ARM': 'fdm.athrArmed',
  'AUTOPILOT VERTICAL HOLD': 'fdm.apVsHold',
  'AUTOPILOT VERTICAL HOLD VAR': 'fdm.apVsTargetFpm',
  'AUTOTHROTTLE ACTIVE': 'fdm.athrActive',
  'BRAKE PARKING POSITION': 'brake',
  'ENG COMBUSTION:1': 'fdm.eng1Running',
  'ENG COMBUSTION:2': 'fdm.eng2Running',
  'ENG COMBUSTION:3': 'fdm.eng3Running',
  'ENG COMBUSTION:4': 'fdm.eng4Running',
  'FLAPS HANDLE INDEX': 'flapsIndex',
  'FLAPS HANDLE PERCENT': 'flaps',
  'FUEL SELECTED QUANTITY PERCENT:99': 'fdm.fuelTotalPct',
  'FUEL TOTAL QUANTITY WEIGHT EX1': 'fdm.fuelTotalWeightLbs',
  'GEAR CENTER POSITION': 'gearNose',
  'GEAR HANDLE POSITION': 'gearHandle',
  'GEAR LEFT POSITION': 'gearLeft',
  'GEAR RIGHT POSITION': 'gearRight',
  'LIGHT BEACON': 'lights.beacon',
  'LIGHT LANDING': 'lights.landing',
  'LIGHT LOGO': 'lights.logo',
  'LIGHT NAV': 'lights.nav',
  'LIGHT STROBE': 'lights.strobe',
  'LIGHT TAXI': 'lights.taxi',
  'LIGHT TAXI:2': 'lights.turnoff',
  'LIGHT WING': 'lights.wing',
  'NAV ACTIVE FREQUENCY:1': 'fdm.nav1ActiveMhz',
  'NAV ACTIVE FREQUENCY:2': 'fdm.nav2ActiveMhz',
  'NAV STANDBY FREQUENCY:1': 'fdm.nav1StandbyMhz',
  'NAV STANDBY FREQUENCY:2': 'fdm.nav2StandbyMhz',
  'PRESSURIZATION CABIN ALTITUDE': 'fdm.cabinAltFt',
  'PRESSURIZATION CABIN ALTITUDE RATE': 'fdm.cabinAltRateFpm',
  'PRESSURIZATION PRESSURE DIFFERENTIAL': 'fdm.cabinDeltaPPsi',
  'SPOILERS HANDLE POSITION': 'spoilers.percent',
  'TOTAL WEIGHT': 'fdm.grossWeightLbs',
  'TRAILING EDGE FLAPS LEFT ANGLE': 'flapsAngleDeg',
  'TURB ENG N1:1': 'fdm.eng1N1',
  'TURB ENG N1:2': 'fdm.eng2N1',
  'TURB ENG N1:3': 'fdm.eng3N1',
  'TURB ENG N1:4': 'fdm.eng4N1',
});

function normalizeSourceType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SAFE_SOURCE_TYPE_RE.test(normalized) ? normalized : null;
}

function resolveSharedSimulatorStatus(
  frame: AnyRecord | null | undefined,
  simState: AnyRecord | null | undefined,
): AircraftSpecificSourceStatus | null {
  if (frame?.simconnect?.connected !== true || simState?.simconnectConnected === false) {
    return 'disconnected';
  }
  if (simState?.inMenu === true) return 'paused';
  return null;
}

function resolveFreshnessStatus(
  updatedAt: unknown,
  nowEpochMs: number,
  staleAfterMs: number,
): AircraftSpecificSourceStatus | null {
  const updatedAtMs = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return 'awaiting-values';
  return (nowEpochMs - updatedAtMs) > staleAfterMs ? 'stale' : null;
}

function readOwnPath(root: unknown, pathValue: unknown): unknown {
  if (!root || typeof root !== 'object' || typeof pathValue !== 'string') return undefined;
  const path = pathValue.trim();
  if (!path) return undefined;

  const segments = path.split('.');
  if (
    segments.length === 0
    || segments.some((segment) => (
      !SAFE_PATH_SEGMENT_RE.test(segment) || RESERVED_PATH_SEGMENTS.has(segment)
    ))
  ) {
    return undefined;
  }

  const rootRecord = root as AnyRecord;
  if (Object.prototype.hasOwnProperty.call(rootRecord, path)) return rootRecord[path];

  let current: unknown = rootRecord;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as AnyRecord;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

const lvarBindingResolver: BindingResolver = Object.freeze({
  type: 'lvar',
  compile(source: AnyRecord, context: CompileContext): AnyRecord | null {
    if (typeof context.registerLvar !== 'function') return null;
    const generatedKey = `aircraft_specific_${context.fieldId
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .toLowerCase()}`;
    const runtimeKey = context.registerLvar(generatedKey, source.name, context.sourcePath);
    return runtimeKey ? { type: 'lvar', key: runtimeKey } : null;
  },
  resolve(binding: AnyRecord, context: ResolverContext): BindingResolution {
    const sourceId = 'lvar';
    const sharedStatus = resolveSharedSimulatorStatus(context.frame, context.simState);
    if (sharedStatus) return { sourceId, status: sharedStatus };

    const lvars = context.frame?.lvars;
    if (!lvars || lvars.enabled !== true) return { sourceId, status: 'disabled' };
    if (lvars.profileId && lvars.profileId !== context.config?.profileKey) {
      return { sourceId, status: 'awaiting-values' };
    }
    if (lvars.error || lvars.status === 'error') return { sourceId, status: 'error' };
    if (lvars.status === 'disabled') return { sourceId, status: 'disabled' };
    if (lvars.status === 'disconnected' || lvars.status === 'stopped') {
      return { sourceId, status: 'disconnected' };
    }

    const freshnessStatus = resolveFreshnessStatus(
      lvars.updatedAt,
      context.nowEpochMs,
      context.staleAfterMs,
    );
    if (freshnessStatus) return { sourceId, status: freshnessStatus };
    if (!lvars.values || typeof lvars.values !== 'object') {
      return { sourceId, status: 'awaiting-values' };
    }

    const key = typeof binding.key === 'string' ? binding.key : '';
    return {
      sourceId,
      status: 'connected',
      rawValue: key ? lvars.values[key] : undefined,
    };
  },
});

const simvarBindingResolver: BindingResolver = Object.freeze({
  type: 'simvar',
  compile(source: AnyRecord): AnyRecord | null {
    const name = typeof source.name === 'string'
      ? source.name.trim().replace(/\s+/g, ' ').toUpperCase()
      : '';
    const path = SIMVAR_FRAME_PATHS[name];
    if (!path) return null;
    return {
      type: 'simvar',
      name,
      path,
      unit: typeof source.unit === 'string' ? source.unit.trim() : '',
    };
  },
  resolve(binding: AnyRecord, context: ResolverContext): BindingResolution {
    const sourceId = 'simvar';
    const sharedStatus = resolveSharedSimulatorStatus(context.frame, context.simState);
    if (sharedStatus) return { sourceId, status: sharedStatus };

    const path = typeof binding.path === 'string' ? binding.path : '';
    const rawValue = readOwnPath(context.frame, path);
    return {
      sourceId,
      status: rawValue === undefined ? 'awaiting-values' : 'connected',
      rawValue,
    };
  },
});

const sdkBindingResolver: BindingResolver = Object.freeze({
  type: 'sdk',
  compile(source: AnyRecord): AnyRecord | null {
    const path = typeof source.path === 'string' ? source.path.trim() : '';
    if (!path) return null;
    const adapterId = typeof source.adapter === 'string' ? source.adapter.trim().toLowerCase() : '';
    return {
      type: 'sdk',
      path,
      ...(adapterId ? { adapterId } : {}),
    };
  },
  resolve(binding: AnyRecord, context: ResolverContext): BindingResolution {
    const sourceId = 'sdk';
    const sharedStatus = resolveSharedSimulatorStatus(context.frame, context.simState);
    if (sharedStatus) return { sourceId, status: sharedStatus };

    const sdk = context.frame?.sdk;
    if (!sdk || typeof sdk !== 'object') return { sourceId, status: 'disabled' };
    if (binding.adapterId && sdk.adapterId !== binding.adapterId) {
      return { sourceId, status: 'awaiting-values' };
    }
    if (sdk.error || sdk.status === 'error') return { sourceId, status: 'error' };
    if (sdk.status === 'disabled') return { sourceId, status: 'disabled' };
    if (sdk.status === 'disconnected' || sdk.status === 'stopped') {
      return { sourceId, status: 'disconnected' };
    }
    if (sdk.status !== 'running' && sdk.status !== 'connected') {
      return { sourceId, status: 'awaiting-values' };
    }

    const snapshotSequence = Number(sdk.snapshotSequence);
    const hasCurrentGenerationSnapshot = Number.isSafeInteger(snapshotSequence)
      && snapshotSequence > 0;
    // ClientData SDK sources are requested with CHANGED semantics. Once the current
    // bridge generation has delivered a snapshot, an unchanged cockpit can be
    // silent indefinitely without becoming stale. The bridge clears the
    // sequence and normalized values on disconnect, target change, or process
    // replacement, so that generation marker is the appropriate freshness
    // boundary. Preserve timestamp freshness as a compatibility fallback for
    // SDK sources that do not expose a sequence yet.
    if (!hasCurrentGenerationSnapshot) {
      const freshnessStatus = resolveFreshnessStatus(
        sdk.updatedAt,
        context.nowEpochMs,
        context.staleAfterMs,
      );
      if (freshnessStatus) return { sourceId, status: freshnessStatus };
    }
    if (!sdk.normalized || typeof sdk.normalized !== 'object') {
      return { sourceId, status: 'awaiting-values' };
    }

    return {
      sourceId,
      status: 'connected',
      rawValue: readOwnPath(sdk.normalized, binding.path),
    };
  },
});

const BUILT_IN_RESOLVERS = Object.freeze([
  lvarBindingResolver,
  simvarBindingResolver,
  sdkBindingResolver,
]);

function createAircraftSpecificBindingResolverRegistry(additionalResolvers: BindingResolver[] = []) {
  const resolvers = new Map<string, BindingResolver>();

  function register(resolver: BindingResolver): void {
    const type = normalizeSourceType(resolver?.type);
    if (!type || typeof resolver?.resolve !== 'function') {
      throw new TypeError('Aircraft-specific binding resolvers require a safe type and resolve function.');
    }
    resolvers.set(type, { ...resolver, type });
  }

  for (const resolver of BUILT_IN_RESOLVERS) register(resolver);
  for (const resolver of additionalResolvers) register(resolver);

  function compile(source: unknown, context: CompileContext): AnyRecord | null {
    if (!source || typeof source !== 'object') return null;
    const sourceRecord = source as AnyRecord;
    const type = normalizeSourceType(sourceRecord.type);
    if (!type) return null;
    const resolver = resolvers.get(type);
    if (!resolver) return null;
    if (typeof resolver.compile !== 'function') return { ...sourceRecord, type };
    try {
      return resolver.compile({ ...sourceRecord, type }, context);
    } catch {
      return null;
    }
  }

  function resolve(binding: unknown, context: ResolverContext): BindingResolution {
    if (!binding || typeof binding !== 'object') {
      return { sourceId: 'unknown', status: 'error' };
    }
    const bindingRecord = binding as AnyRecord;
    const type = normalizeSourceType(bindingRecord.type);
    if (!type) return { sourceId: 'unknown', status: 'error' };
    const resolver = resolvers.get(type);
    if (!resolver) return { sourceId: type, status: 'unsupported' };

    try {
      const result = resolver.resolve(bindingRecord, context);
      const status = SOURCE_STATUSES.has(result?.status) ? result.status : 'error';
      const sourceId = normalizeSourceType(result?.sourceId) || type;
      return {
        sourceId,
        status,
        rawValue: result?.rawValue,
      };
    } catch {
      return { sourceId: type, status: 'error' };
    }
  }

  return {
    compile,
    has: (type: unknown) => {
      const normalized = normalizeSourceType(type);
      return normalized ? resolvers.has(normalized) : false;
    },
    register,
    resolve,
  };
}

const defaultAircraftSpecificBindingResolverRegistry = createAircraftSpecificBindingResolverRegistry();

module.exports = {
  createAircraftSpecificBindingResolverRegistry,
  defaultAircraftSpecificBindingResolverRegistry,
  readOwnPath,
};

export {};
