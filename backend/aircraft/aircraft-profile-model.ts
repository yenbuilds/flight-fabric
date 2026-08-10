'use strict';

// Aircraft profile document normalization: fills defaults, canonicalizes ids,
// and keeps profile JSON shape consistent before validation and registry use.

const {
  buildProfileKey,
  normalizeNamespace,
  normalizeProfileId,
  normalizeSimulator,
  parseProfileLocator,
} = require('./aircraft-profile-identity.js') as {
  buildProfileKey: (input: { namespace: unknown; simulator: unknown; id: unknown }) => string;
  normalizeNamespace: (value: unknown) => string;
  normalizeProfileId: (value: unknown) => string;
  normalizeSimulator: (value: unknown) => string;
  parseProfileLocator: (
    value: unknown,
    options?: { defaultNamespace?: unknown; defaultSimulator?: unknown }
  ) => { profileKey: string | null } | null;
};
const controlCompatibilityRules = require('./aircraft-control-compatibility-rules.json') as unknown[];

type GenericRecord = Record<string, any>;
type ControlCompatibilityRule = {
  controls?: GenericRecord;
  enforce?: boolean;
  match?: GenericRecord;
};
type NormalizeProfileOptions = {
  defaultNamespace?: unknown;
  defaultSimulator?: unknown;
};

const PROFILE_SCHEMA_VERSION = 2;
const CURRENT_PROVENANCE_SOURCE_TYPES = new Set([
  'official-sdk',
  'official-docs',
  'forum',
  'wiki',
  'community',
  'manual-testing',
]);

function cloneObject(value: unknown): GenericRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as GenericRecord) };
}

function cloneArray<T>(value: T[] | unknown): T[] {
  return Array.isArray(value) ? value.slice() : [];
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function isObject(value: unknown): value is GenericRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeSection(preferred: unknown, fallback: unknown): GenericRecord | undefined {
  if (!isObject(preferred) && !isObject(fallback)) return undefined;
  return {
    ...(isObject(fallback) ? fallback : {}),
    ...(isObject(preferred) ? preferred : {}),
  };
}

function mergeNestedSection(preferredRoot: unknown, preferredKey: string, fallbackValue: unknown): GenericRecord | undefined {
  const preferred = isObject(preferredRoot) ? preferredRoot[preferredKey] : undefined;
  return mergeSection(preferred, fallbackValue);
}

function inferSimulator(rawProfile: GenericRecord, defaultSimulator: unknown): string {
  const explicit = normalizeSimulator(rawProfile && rawProfile.simulator);
  if (explicit) return explicit;

  const metaPlatforms = Array.isArray(rawProfile && rawProfile.meta && rawProfile.meta.platforms)
    ? rawProfile.meta.platforms
    : [];
  if (metaPlatforms.some((item: unknown) => String(item || '').toLowerCase().includes('xplane'))) {
    return 'xplane';
  }

  if (
    isObject(rawProfile && rawProfile.matching && rawProfile.matching.xplane) ||
    isObject(rawProfile && rawProfile.integration && rawProfile.integration.matching && rawProfile.integration.matching.xplane) ||
    isObject(rawProfile && rawProfile.dataSource && rawProfile.dataSource.xplane)
  ) {
    return 'xplane';
  }

  return normalizeSimulator(defaultSimulator) || 'msfs';
}

function normalizeExtends(rawExtends: unknown, options: { namespace: string; simulator: string }): string | null {
  if (typeof rawExtends !== 'string' || !rawExtends.trim()) return null;
  const parsed = parseProfileLocator(rawExtends, {
    defaultNamespace: options.namespace,
    defaultSimulator: options.simulator,
  });
  if (parsed && parsed.profileKey) return parsed.profileKey;
  return rawExtends.trim();
}

function convertLegacyLandingGrade(landingGrade: GenericRecord | null | undefined): GenericRecord | undefined {
  const thresholds = landingGrade && landingGrade.thresholds;
  if (!isObject(thresholds)) return undefined;

  const butter = thresholds.butter && thresholds.butter.maxFpm;
  const excellent = thresholds.excellent && thresholds.excellent.maxFpm;
  const acceptable = thresholds.acceptable && thresholds.acceptable.maxFpm;
  const hard = thresholds.hard && thresholds.hard.maxFpm;

  const grades: GenericRecord = {};
  if (typeof butter === 'number') grades.perfectMinFpm = -Math.abs(butter);
  if (typeof excellent === 'number') grades.goodMinFpm = -Math.abs(excellent);
  if (typeof acceptable === 'number') grades.firmMinFpm = -Math.abs(acceptable);
  if (typeof hard === 'number') grades.hardMinFpm = -Math.abs(hard);

  if (Object.keys(grades).length === 0) return undefined;

  if (typeof landingGrade?._comment === 'string' && !grades._comment) {
    grades._comment = landingGrade._comment;
  }

  return { grades };
}

function normalizeAircraft(rawProfile: GenericRecord): GenericRecord {
  const aircraft = cloneObject(rawProfile && rawProfile.aircraft);

  if (firstDefined(aircraft.category, rawProfile && rawProfile.aircraftCategory) !== undefined) {
    aircraft.category = firstDefined(aircraft.category, rawProfile && rawProfile.aircraftCategory);
  }

  const sections = [
    'flaps',
    'slats',
    'gear',
    'stability',
    'automation',
    'landing',
    'phaseThresholds',
    'throttle',
    'engines',
    'performance',
  ];

  for (const section of sections) {
    if (aircraft[section] === undefined && rawProfile && rawProfile[section] !== undefined) {
      aircraft[section] = rawProfile[section];
    }
  }

  if (aircraft.landing === undefined && rawProfile && rawProfile.landingGrade) {
    aircraft.landing = convertLegacyLandingGrade(rawProfile.landingGrade);
  } else if (isObject(aircraft.landing) && rawProfile && rawProfile.landingGrade) {
    aircraft.landing = {
      ...convertLegacyLandingGrade(rawProfile.landingGrade),
      ...aircraft.landing,
    };
  }

  delete aircraft.callouts;
  if (isObject(aircraft.throttle)) {
    aircraft.throttle = cloneObject(aircraft.throttle);
    delete aircraft.throttle.detents;
  }

  return aircraft;
}

function normalizePresentation(rawProfile: GenericRecord): GenericRecord {
  const presentation = cloneObject(rawProfile && rawProfile.integration && rawProfile.integration.presentation);

  if (firstDefined(presentation.visualSupport, rawProfile && rawProfile.visualSupport) !== undefined) {
    presentation.visualSupport = firstDefined(presentation.visualSupport, rawProfile && rawProfile.visualSupport);
  }

  const legacyLights = rawProfile && rawProfile.lights;
  if (legacyLights && (legacyLights.available !== undefined || legacyLights.labels !== undefined)) {
    presentation.lights = mergeSection(presentation.lights, {
      available: legacyLights.available,
      labels: legacyLights.labels,
    });
  }

  return presentation;
}

function normalizeTelemetry(rawProfile: GenericRecord): GenericRecord {
  const telemetry = cloneObject(rawProfile && rawProfile.integration && rawProfile.integration.telemetry);
  const dataSource = cloneObject(rawProfile && rawProfile.dataSource);
  const legacyLights = cloneObject(rawProfile && rawProfile.lights);
  const legacySpoilers = cloneObject(rawProfile && rawProfile.spoilers);

  if (firstDefined(telemetry.preferred, dataSource.preferred) !== undefined) {
    telemetry.preferred = firstDefined(telemetry.preferred, dataSource.preferred);
  }
  if (firstDefined(telemetry.lvars, dataSource.lvars) !== undefined) {
    telemetry.lvars = firstDefined(telemetry.lvars, dataSource.lvars);
  }
  if (firstDefined(telemetry.sdk, dataSource.sdk) !== undefined) {
    telemetry.sdk = firstDefined(telemetry.sdk, dataSource.sdk);
  }

  const xplane = cloneObject(dataSource.xplane);
  if (Object.keys(xplane).length > 0) {
    for (const [key, value] of Object.entries(xplane)) {
      if (telemetry[key] === undefined) {
        telemetry[key] = value;
      }
    }
  }

  if (Object.keys(legacySpoilers).length > 0) {
    telemetry.spoilers = mergeSection(telemetry.spoilers, legacySpoilers);
  }

  const telemetryLights = mergeNestedSection(telemetry, 'lights', {
    source: legacyLights.source,
    simVarReliable: legacyLights.simVarReliable,
    simvarMapping: legacyLights.simvarMapping,
  });
  if (telemetryLights) {
    telemetry.lights = telemetryLights;
  }

  return telemetry;
}

function normalizeString(value: unknown): string {
  return String(value || '').toLowerCase();
}

function matchesAnyPrefix(value: string, prefixes: unknown): boolean {
  return Array.isArray(prefixes) && prefixes.some((prefix) => {
    const normalizedPrefix = normalizeString(prefix);
    return !!normalizedPrefix && value.startsWith(normalizedPrefix);
  });
}

function includesAny(value: string, needles: unknown): boolean {
  return Array.isArray(needles) && needles.some((needle) => {
    const normalizedNeedle = normalizeString(needle);
    return !!normalizedNeedle && value.includes(normalizedNeedle);
  });
}

function equalsAny(value: string, options: unknown): boolean {
  return Array.isArray(options) && options.some((option) => {
    const normalizedOption = normalizeString(option);
    return !!normalizedOption && value === normalizedOption;
  });
}

function matchesControlCompatibilityRule(
  rawProfile: GenericRecord,
  controls: GenericRecord | undefined,
  rule: ControlCompatibilityRule
): boolean {
  const match = rule && isObject(rule.match) ? rule.match : {};
  const profileId = normalizeString(rawProfile?.id);
  const profileKey = normalizeString(rawProfile?._profileKey || rawProfile?._qualifiedId);
  const developer = normalizeString(rawProfile?.meta?.developer);
  const controlBackend = normalizeString(controls?.backend);
  const telemetryPreferred = normalizeString(rawProfile?.integration?.telemetry?.preferred || rawProfile?.dataSource?.preferred);

  return (
    matchesAnyPrefix(profileKey, match.profileKeyPrefixes) ||
    includesAny(profileKey, match.profileKeyIncludes) ||
    equalsAny(profileId, match.idEquals) ||
    matchesAnyPrefix(profileId, match.idPrefixes) ||
    includesAny(developer, match.developerIncludes) ||
    equalsAny(controlBackend, match.controlBackends) ||
    includesAny(telemetryPreferred, match.telemetryPreferredIncludes)
  );
}

function mergeCompatibilityDefaults(target: unknown, defaults: unknown): unknown {
  if (!isObject(defaults)) return target === undefined ? defaults : target;
  if (!isObject(target)) return cloneObject(defaults);

  const merged: GenericRecord = target;
  for (const [key, value] of Object.entries(defaults)) {
    if (merged[key] === undefined) {
      merged[key] = isObject(value) ? cloneObject(value) : value;
      continue;
    }
    if (isObject(merged[key]) && isObject(value)) {
      merged[key] = mergeCompatibilityDefaults(merged[key], value);
    }
  }
  return merged;
}

function applyControlCompatibilityDefaults(
  controls: GenericRecord | undefined,
  defaults: GenericRecord,
  enforce = false,
): GenericRecord {
  const normalizedControls: GenericRecord = controls || {};
  for (const [key, value] of Object.entries(defaults)) {
    if (enforce || normalizedControls[key] === undefined) {
      normalizedControls[key] = isObject(value) ? cloneObject(value) : value;
    } else if (isObject(normalizedControls[key]) && isObject(value)) {
      normalizedControls[key] = mergeCompatibilityDefaults(normalizedControls[key], value);
    }
  }
  return normalizedControls;
}

function normalizeControls(rawProfile: GenericRecord): GenericRecord | undefined {
  let controls = mergeSection(rawProfile && rawProfile.integration && rawProfile.integration.controls, rawProfile && rawProfile.control);

  for (const rawRule of controlCompatibilityRules) {
    const rule = rawRule as ControlCompatibilityRule;
    if (!isObject(rule) || !isObject(rule.controls)) continue;
    if (!matchesControlCompatibilityRule(rawProfile, controls, rule)) continue;
    controls = applyControlCompatibilityDefaults(controls, rule.controls, rule.enforce === true);
  }

  return controls;
}

function normalizeIntegration(rawProfile: GenericRecord): GenericRecord {
  const integration = cloneObject(rawProfile && rawProfile.integration);
  integration.matching = mergeSection(integration.matching, rawProfile && rawProfile.matching);
  integration.telemetry = normalizeTelemetry(rawProfile);
  integration.controls = normalizeControls(rawProfile);
  integration.signalReliability = mergeSection(
    integration.signalReliability,
    rawProfile && rawProfile.signalReliability
  );
  integration.presentation = normalizePresentation(rawProfile);
  return integration;
}

function normalizeMeta(rawProfile: GenericRecord, simulator: string): GenericRecord {
  const meta = cloneObject(rawProfile && rawProfile.meta);
  if (!Array.isArray(meta.platforms) || meta.platforms.length === 0) {
    meta.platforms = simulator === 'xplane' ? ['xplane12'] : ['msfs2020', 'msfs2024'];
  } else {
    meta.platforms = cloneArray(meta.platforms);
  }
  return meta;
}

function normalizeProvenance(rawProfile: GenericRecord): GenericRecord {
  const provenance = cloneObject(rawProfile && rawProfile.provenance);
  const verification = cloneObject(provenance.verification);

  if (Array.isArray(provenance.sources)) {
    provenance.sources = provenance.sources
      .map((rawSource: unknown) => cloneObject(rawSource))
      .filter((source: GenericRecord) => (
        typeof source.type !== 'string' || CURRENT_PROVENANCE_SOURCE_TYPES.has(source.type)
      ));
  }

  if (Array.isArray(rawProfile && rawProfile.knownIssues) && rawProfile.knownIssues.length > 0) {
    verification.knownIssues = cloneArray(rawProfile.knownIssues);
  }

  if (Object.keys(verification).length > 0) {
    provenance.verification = verification;
  }

  return provenance;
}

function copyTopLevelMetadata(rawProfile: GenericRecord, normalized: GenericRecord): GenericRecord {
  const passthroughKeys = Object.keys(rawProfile || {}).filter(
    (key) => key.startsWith('_comment') || key === '_instructions'
  );
  for (const key of passthroughKeys) {
    if (normalized[key] === undefined) {
      normalized[key] = rawProfile[key];
    }
  }
  if (typeof rawProfile._comment === 'string' && normalized._comment === undefined) {
    normalized._comment = rawProfile._comment;
  }
  return normalized;
}

function normalizeProfileDocument(rawProfile: GenericRecord, options: NormalizeProfileOptions = {}): GenericRecord {
  const defaultNamespace = normalizeNamespace(options.defaultNamespace) || 'bundled';
  const simulator = inferSimulator(rawProfile, options.defaultSimulator);
  const namespace = normalizeNamespace(rawProfile && rawProfile.namespace) || defaultNamespace;
  const id = normalizeProfileId(rawProfile && rawProfile.id);

  const normalized: GenericRecord = {
    $schema: typeof rawProfile?.$schema === 'string' ? rawProfile.$schema : './aircraft-profile.schema.json',
    version: PROFILE_SCHEMA_VERSION,
    id,
    name: typeof rawProfile?.name === 'string' && rawProfile.name.trim() ? rawProfile.name.trim() : id,
    simulator,
    namespace,
    author: rawProfile && Object.prototype.hasOwnProperty.call(rawProfile, 'author') ? rawProfile.author : null,
    authorAccount: rawProfile && Object.prototype.hasOwnProperty.call(rawProfile, 'authorAccount')
      ? rawProfile.authorAccount
      : null,
    createdAt: rawProfile && Object.prototype.hasOwnProperty.call(rawProfile, 'createdAt') ? rawProfile.createdAt : null,
    updatedAt: rawProfile && Object.prototype.hasOwnProperty.call(rawProfile, 'updatedAt') ? rawProfile.updatedAt : null,
    visibility: typeof rawProfile?.visibility === 'string' ? rawProfile.visibility : 'private',
    extends: normalizeExtends(rawProfile && rawProfile.extends, { namespace, simulator }),
    abstract: rawProfile?.abstract === true,
    aircraft: normalizeAircraft(rawProfile),
    integration: normalizeIntegration(rawProfile),
    meta: normalizeMeta(rawProfile, simulator),
    provenance: normalizeProvenance(rawProfile),
  };

  return copyTopLevelMetadata(rawProfile, normalized);
}

function buildLegacyLights(profile: GenericRecord): GenericRecord {
  const presentationLights = cloneObject(profile?.integration?.presentation?.lights);
  const telemetryLights = cloneObject(profile?.integration?.telemetry?.lights);
  return {
    ...presentationLights,
    ...telemetryLights,
  };
}

function buildLegacyDataSource(profile: GenericRecord): GenericRecord {
  const telemetry = cloneObject(profile?.integration?.telemetry);
  const dataSource: GenericRecord = {};

  for (const key of ['preferred', 'lvars', 'sdk']) {
    if (telemetry[key] !== undefined) {
      dataSource[key] = telemetry[key];
    }
  }

  const xplaneKeys = ['identityDatarefs', 'datarefs', 'commands', 'allowGenericFallback'];
  const xplane: GenericRecord = {};
  for (const key of xplaneKeys) {
    if (telemetry[key] !== undefined) {
      xplane[key] = telemetry[key];
    }
  }
  if (Object.keys(xplane).length > 0) {
    dataSource.xplane = xplane;
  }

  return dataSource;
}

function defineLegacyGetter(target: GenericRecord, property: string, getter: () => unknown): void {
  if (Object.prototype.hasOwnProperty.call(target, property)) return;
  Object.defineProperty(target, property, {
    enumerable: false,
    configurable: true,
    get: getter,
  });
}

function attachLegacyCompatibilityAliases(profile: GenericRecord): GenericRecord {
  if (!profile || typeof profile !== 'object') return profile;

  const aircraftAliases: Record<string, () => unknown> = {
    aircraftCategory: () => profile.aircraft && profile.aircraft.category,
    flaps: () => profile.aircraft && profile.aircraft.flaps,
    slats: () => profile.aircraft && profile.aircraft.slats,
    gear: () => profile.aircraft && profile.aircraft.gear,
    stability: () => profile.aircraft && profile.aircraft.stability,
    automation: () => profile.aircraft && profile.aircraft.automation,
    landing: () => profile.aircraft && profile.aircraft.landing,
    phaseThresholds: () => profile.aircraft && profile.aircraft.phaseThresholds,
    throttle: () => profile.aircraft && profile.aircraft.throttle,
    engines: () => profile.aircraft && profile.aircraft.engines,
    performance: () => profile.aircraft && profile.aircraft.performance,
  };

  for (const [property, getter] of Object.entries(aircraftAliases)) {
    defineLegacyGetter(profile, property, getter);
  }

  defineLegacyGetter(profile, 'matching', () => profile.integration && profile.integration.matching);
  defineLegacyGetter(profile, 'dataSource', () => buildLegacyDataSource(profile));
  defineLegacyGetter(profile, 'spoilers', () => profile.integration && profile.integration.telemetry && profile.integration.telemetry.spoilers);
  defineLegacyGetter(profile, 'control', () => profile.integration && profile.integration.controls);
  defineLegacyGetter(profile, 'signalReliability', () => profile.integration && profile.integration.signalReliability);
  defineLegacyGetter(profile, 'visualSupport', () => profile.integration && profile.integration.presentation && profile.integration.presentation.visualSupport);
  defineLegacyGetter(profile, 'lights', () => buildLegacyLights(profile));

  return profile;
}

function finalizeLoadedProfile(profile: GenericRecord): GenericRecord {
  const profileKey = buildProfileKey({
    namespace: profile.namespace,
    simulator: profile.simulator,
    id: profile.id,
  });
  const finalized = {
    ...profile,
    _profileKey: profileKey,
  };
  attachLegacyCompatibilityAliases(finalized);
  return finalized;
}

const aircraftProfileModelApi = {
  PROFILE_SCHEMA_VERSION,
  attachLegacyCompatibilityAliases,
  buildLegacyDataSource,
  buildLegacyLights,
  finalizeLoadedProfile,
  normalizeProfileDocument,
};

module.exports = aircraftProfileModelApi;

export {};
