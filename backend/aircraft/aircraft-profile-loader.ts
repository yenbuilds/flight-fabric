// aircraft-profile-loader.js
// Loads, resolves, and manages simulator-aware aircraft configuration profiles.
//
// Canonical identity:
//   namespace/simulator/id
//   - namespace: bundled
//   - simulator: msfs | xplane
//   - id: aircraft/profile slug
//
// Persisted profile model:
//   - aircraft.*     = simulator-agnostic aircraft semantics
//   - integration.* = simulator-specific bindings and presentation

'use strict';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const Debug = require('../core/debug.js') as {
  log: (scope: string, message: string, meta?: Record<string, unknown>) => void;
};
const config = require('../core/config.js') as {
  aircraft?: { profile?: string | null };
  simconnect?: { protocol?: unknown };
};
const eventBus = require('../core/event-bus.js') as {
  emit: (event: string, payload: Record<string, unknown>) => void;
};
const {
  defaultAircraftSpecificBindingResolverRegistry,
} = require('./aircraft-specific-binding-resolvers.js') as {
  defaultAircraftSpecificBindingResolverRegistry: {
    compile: (source: unknown, context: GenericRecord) => GenericRecord | null;
  };
};
const {
  defaultAircraftIntegrationRegistry,
} = require('./aircraft-integrations') as {
  defaultAircraftIntegrationRegistry: {
    resolveIntegration: (
      adapterId: unknown,
      context: { profileKey: unknown },
    ) => GenericRecord | null;
  };
};
const {
  PROFILE_SIMULATORS,
  buildProfileKey,
  normalizeNamespace,
  normalizeProfileId,
  normalizeSimulator,
  parseProfileLocator,
} = require('./aircraft-profile-identity.js') as {
  PROFILE_SIMULATORS: string[];
  buildProfileKey: (input: { namespace: unknown; simulator: unknown; id: unknown }) => string;
  normalizeNamespace: (value: unknown) => string;
  normalizeProfileId: (value: unknown) => string;
  normalizeSimulator: (value: unknown) => string;
  parseProfileLocator: (
    value: unknown,
    options?: { defaultNamespace?: unknown; defaultSimulator?: unknown }
  ) => {
    id: string;
    locatorType: string;
    namespace: string | null;
    profileKey: string | null;
    simulator: string | null;
  } | null;
};
const {
  finalizeLoadedProfile,
  normalizeProfileDocument,
} = require('./aircraft-profile-model.js') as {
  finalizeLoadedProfile: (profile: Record<string, any>) => LoadedProfile;
  normalizeProfileDocument: (
    profile: Record<string, any>,
    options?: { defaultNamespace?: unknown; defaultSimulator?: unknown }
  ) => Record<string, any>;
};
const {
  resolveLoadedProfile,
} = require('./aircraft-profile-resolution.js') as {
  resolveLoadedProfile: (params: Record<string, any>) => { resolved: ResolvedProfilePath; finalized: LoadedProfile } | null;
};
const MAX_PROFILE_JSON_BYTES = 1024 * 1024;

type GenericRecord = Record<string, any>;
type LoadedProfile = GenericRecord & {
  _loaded?: boolean;
  _profileKey?: string;
  _qualifiedId?: string;
  _source?: string;
  abstract?: boolean;
  extends?: string | null;
  id: string;
  integration?: GenericRecord;
  name: string;
  namespace?: string;
  simulator?: string;
};
type ResolvedProfilePath = {
  filePath: string;
  id: string;
  legacy: boolean;
  namespace: string;
  profileKey: string;
  simulator: string;
};
type DetectOptions = {
  aircraftCfg?: AircraftCfgMetadata | null;
  hint?: unknown;
  xplane?: GenericRecord | null;
};
type AircraftCfgMetadata = {
  fields: Record<string, string[]>;
  identity: string | null;
};
type LvarSubscription = {
  dataType?: string;
  expression: string;
  key: string;
  sourcePath: string;
  unit?: string;
};
type AircraftSpecificFieldConfig = {
  decode: GenericRecord;
  id: string;
  source: GenericRecord;
};
type AircraftSpecificConfig = {
  confirmationFields: AircraftSpecificFieldConfig[];
  fields: AircraftSpecificFieldConfig[];
  integrationId: string | null;
  profileKey: string;
  profileRevision: number;
  templateId: string | null;
};
type StabilityScoringCriteriaOverrides = Partial<{
  gateRaFt: number;
  speedMinusKts: number;
  speedPlusKts: number;
  vsMinFpm: number;
  vsMaxClimbFpm: number;
  thrustIdleMinPct: number;
  pitchMinDeg: number;
  pitchMaxDeg: number;
}>;

type ProfileSummary = {
  abstract: boolean;
  bundledProfileKey: string | null;
  id: string;
  localOverrideUpdateStatus: 'changed' | 'legacy' | null;
  name: string;
  namespace: string;
  qualifiedId: string;
  remoteInstall: GenericRecord | null;
  simulator: string;
  source: string;
};
// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const BUILTIN_ROOT_DIR = path.join(__dirname, 'profiles');
const BUILTIN_BUNDLED_DIR = path.join(BUILTIN_ROOT_DIR, 'bundled');
const GENERIC_ID = 'generic';
const AIRCRAFT_CFG_MAX_BYTES = 256 * 1024;
const INTERNAL_PROFILE_KEYS = new Set([
  '_loaded',
  '_source',
  '_qualifiedId',
  '_profileKey',
]);
const AIRCRAFT_CFG_IDENTITY_KEYS = new Set([
  'title',
  'ui_manufacturer',
  'ui_type',
  'ui_variation',
  'manufacturer',
  'type',
  'model',
  'atc_model',
  'icao_type_designator',
  'icao_manufacturer',
  'icao_model',
]);
const GENERIC_MATCH_TOKENS = new Set([
  'airbus',
  'boeing',
  'cessna',
  'citation',
  'embraer',
  'bombardier',
  'aircraft',
  'airplane',
  'airliner',
  'professional',
  'simulations',
  'simulation',
  'studio',
  'studios',
  'design',
  'flight',
  'model',
  'type',
  'neo',
  'max',
  'classic',
  'cargo',
  'freighter',
  'passenger',
  'dreamliner',
  'pax',
  'ssw',
  'bbj',
]);

// Cache for loaded profiles
const profileCache = new Map<string, LoadedProfile>();
const aircraftCfgMetadataCache = new Map<string, AircraftCfgMetadata | null>();
let activeProfile: LoadedProfile | null = null;
let activeProfileId: string | null = null;
let activeProfileRevision = 0;
let lastDetectedTitle: string | null = null;
let bundledProfilesAvailableChecked = false;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getConfiguredSimulator(): string {
  const protocol = String(config?.simconnect?.protocol || '').trim().toUpperCase();
  return protocol === 'XPLANE_WEB' ? 'xplane' : 'msfs';
}

function getSimulatorSearchOrder(preferredSimulator: unknown = getConfiguredSimulator()): string[] {
  const normalizedPreferred = normalizeSimulator(preferredSimulator) || 'msfs';
  return [
    normalizedPreferred,
    ...PROFILE_SIMULATORS.filter((item: string) => item !== normalizedPreferred),
  ];
}

function isManagedProfileFileName(fileName: unknown): boolean {
  return !!(
    typeof fileName === 'string' &&
    fileName.endsWith('.json') &&
    !fileName.startsWith('_') &&
    fileName !== 'aircraft-profile.schema.json' &&
    fileName !== 'reference-data.json'
  );
}

function readProfileFile(filePath: string): GenericRecord | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PROFILE_JSON_BYTES) {
      Debug.log('profile-loader', `Refusing aircraft profile outside size budget: ${filePath}`, {
        bytes: stat.size,
        maxBytes: MAX_PROFILE_JSON_BYTES,
      });
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const err = error as Error;
    Debug.log('profile-loader', `Failed to read profile: ${filePath}`, { error: err.message });
    return null;
  }
}

function isProfileDefinition(profile: unknown): profile is GenericRecord & { id: string } {
  return !!(
    profile &&
    typeof profile === 'object' &&
    typeof (profile as GenericRecord).id === 'string' &&
    normalizeProfileId((profile as GenericRecord).id)
  );
}

function normalizeMatchText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeXplanePathValue(value: unknown): string {
  return normalizeMatchText(value).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function normalizeXplaneNameValue(value: unknown): string {
  return normalizeMatchText(value).toLowerCase();
}

function isFilePathLike(value: unknown): boolean {
  const normalized = normalizeMatchText(value);
  return !!normalized && (normalized.includes('\\') || normalized.includes('/') || /\.cfg$/i.test(normalized));
}

function buildPathIdentityText(value: unknown): string {
  const normalized = normalizeMatchText(value).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized) return '';

  const segments = normalized.split('/').map((segment: string) => segment.trim()).filter(Boolean);
  const lowerSegments = segments.map((segment: string) => segment.toLowerCase());
  const fileName = lowerSegments[lowerSegments.length - 1] || '';
  const contentSegments = fileName === 'aircraft.cfg' ? segments.slice(0, -1) : segments.slice();
  const contentLowerSegments = fileName === 'aircraft.cfg' ? lowerSegments.slice(0, -1) : lowerSegments.slice();

  const airplanesIndex = contentLowerSegments.lastIndexOf('airplanes');
  if (airplanesIndex >= 0 && airplanesIndex < contentSegments.length - 1) {
    return contentSegments.slice(airplanesIndex + 1).join(' ');
  }

  const communityIndex = contentLowerSegments.lastIndexOf('community');
  if (communityIndex >= 0 && communityIndex < contentSegments.length - 1) {
    return contentSegments.slice(communityIndex + 1).join(' ');
  }

  const oneStoreIndex = contentLowerSegments.lastIndexOf('onestore');
  if (oneStoreIndex >= 0 && oneStoreIndex < contentSegments.length - 1) {
    return contentSegments.slice(oneStoreIndex + 1).join(' ');
  }

  const officialIndex = contentLowerSegments.lastIndexOf('official');
  if (officialIndex >= 0 && officialIndex < contentSegments.length - 1) {
    return contentSegments.slice(officialIndex + 1).join(' ');
  }

  return contentSegments.slice(-1).join(' ');
}

function isReadableAircraftCfgPath(value: unknown): value is string {
  const normalized = normalizeMatchText(value);
  if (!normalized || !/aircraft\.cfg$/i.test(normalized)) return false;
  return path.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
}

function normalizeSpecificityToken(value: unknown): string {
  return normalizeMatchText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stripCfgValue(value: string): string {
  const withoutInlineComment = value.replace(/\s+[;#].*$/, '').trim();
  if (
    (withoutInlineComment.startsWith('"') && withoutInlineComment.endsWith('"')) ||
    (withoutInlineComment.startsWith("'") && withoutInlineComment.endsWith("'"))
  ) {
    return withoutInlineComment.slice(1, -1).trim();
  }
  return withoutInlineComment;
}

function normalizeAircraftCfgKey(value: unknown): string {
  return normalizeMatchText(value)
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/_*\._*/g, '.');
}

function normalizeAircraftCfgSection(value: unknown): string {
  const normalized = normalizeAircraftCfgKey(value);
  if (/^fltsim(\.\d+)?$/.test(normalized)) return 'fltsim';
  return normalized;
}

function addAircraftCfgField(fields: Record<string, string[]>, key: string, value: unknown): void {
  const normalizedKey = normalizeAircraftCfgKey(key);
  const normalizedValue = normalizeMatchText(value);
  if (!normalizedKey || !normalizedValue) return;

  const existing = fields[normalizedKey] || [];
  const existingKeys = new Set(existing.map((item: string) => item.toLowerCase()));
  if (!existingKeys.has(normalizedValue.toLowerCase())) {
    existing.push(normalizedValue);
  }
  fields[normalizedKey] = existing;
}

function buildAircraftCfgMetadataFromText(text: string): AircraftCfgMetadata {
  const fields: Record<string, string[]> = {};
  const identityValues: string[] = [];
  const identitySeen = new Set<string>();
  let currentSection = '';

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = normalizeAircraftCfgSection(sectionMatch[1]);
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = normalizeAircraftCfgKey(trimmed.slice(0, separatorIndex));
    const value = stripCfgValue(trimmed.slice(separatorIndex + 1));
    const normalized = normalizeMatchText(value);
    if (!key || !normalized) continue;

    addAircraftCfgField(fields, key, normalized);
    if (currentSection) {
      addAircraftCfgField(fields, `${currentSection}.${key}`, normalized);
    }

    if (!AIRCRAFT_CFG_IDENTITY_KEYS.has(key)) continue;

    const normalizedIdentityKey = normalized.toLowerCase();
    if (identitySeen.has(normalizedIdentityKey)) continue;

    identitySeen.add(normalizedIdentityKey);
    identityValues.push(normalized);
  }

  return {
    fields,
    identity: identityValues.length > 0 ? identityValues.join(' ') : null,
  };
}

function readAircraftCfgMetadata(configPath: unknown): AircraftCfgMetadata | null {
  if (!isReadableAircraftCfgPath(configPath)) return null;
  const normalizedPath = normalizeMatchText(configPath);
  if (aircraftCfgMetadataCache.has(normalizedPath)) {
    return aircraftCfgMetadataCache.get(normalizedPath) || null;
  }

  let metadata: AircraftCfgMetadata | null = null;
  try {
    const stat = fs.statSync(normalizedPath);
    if (stat.isFile() && stat.size > 0 && stat.size <= AIRCRAFT_CFG_MAX_BYTES) {
      metadata = buildAircraftCfgMetadataFromText(fs.readFileSync(normalizedPath, 'utf8'));
    }
  } catch (error) {
    const err = error as Error;
    Debug.log('profile-loader', 'Unable to read aircraft.cfg metadata', {
      path: normalizedPath,
      error: err.message,
    });
  }

  aircraftCfgMetadataCache.set(normalizedPath, metadata);
  return metadata;
}

function toXplaneSlug(value: unknown): string {
  const normalized = normalizeXplanePathValue(value);
  if (!normalized) return '';
  const baseName = normalized.split('/').pop() || normalized;
  return baseName.endsWith('.acf') ? baseName.slice(0, -4) : baseName;
}

function hasXplaneIdentityHint(xplane: unknown): boolean {
  return Boolean(
    xplane &&
    typeof xplane === 'object' &&
    (
      normalizeMatchText((xplane as GenericRecord).acfPath) ||
      normalizeMatchText((xplane as GenericRecord).acfFileName) ||
      normalizeMatchText((xplane as GenericRecord).id)
    )
  );
}

function deepMerge(target: GenericRecord, source: GenericRecord, depth = 0): GenericRecord {
  const MAX_MERGE_DEPTH = 30;
  const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const result: GenericRecord = { ...target };

  for (const key of Object.keys(source || {})) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    if (INTERNAL_PROFILE_KEYS.has(key)) continue;

    if (source[key] === null || source[key] === undefined) {
      continue;
    }

    if (
      depth < MAX_MERGE_DEPTH &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      source[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key]) &&
      target[key] !== null
    ) {
      result[key] = deepMerge(target[key], source[key], depth + 1);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

function stripInternalFields(profile: GenericRecord | null | undefined): GenericRecord {
  const cleaned: GenericRecord = {};
  for (const [key, value] of Object.entries(profile || {})) {
    if (INTERNAL_PROFILE_KEYS.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function getProfileFilePath(namespace: unknown, simulator: unknown, id: string): string {
  if (normalizeNamespace(namespace) !== 'bundled') return '';
  const normalizedSimulator = normalizeSimulator(simulator);
  return normalizedSimulator
    ? path.join(BUILTIN_BUNDLED_DIR, normalizedSimulator, `${id}.json`)
    : path.join(BUILTIN_BUNDLED_DIR, `${id}.json`);
}

function getLegacyProfileFilePath(namespace: unknown, id: string): string | null {
  if (namespace === 'bundled') return path.join(BUILTIN_BUNDLED_DIR, `${id}.json`);
  return null;
}

function getResolutionCandidates(locator: {
  id?: unknown;
  namespace?: string | null;
  simulator?: string | null;
} | null | undefined): ResolvedProfilePath[] {
  const id = normalizeProfileId(locator && locator.id);
  if (!id) return [];

  if (locator?.namespace && locator.namespace !== 'bundled') return [];
  const namespaces = ['bundled'];
  const simulators = locator && locator.simulator
    ? [locator.simulator]
    : getSimulatorSearchOrder(getConfiguredSimulator());

  const candidates: ResolvedProfilePath[] = [];

  for (const simulator of simulators) {
    for (const namespace of namespaces) {
      candidates.push({
        namespace,
        simulator,
        id,
        filePath: getProfileFilePath(namespace, simulator, id),
        profileKey: buildProfileKey({ namespace, simulator, id }),
        legacy: false,
      });
    }
  }

  for (const simulator of simulators) {
    for (const namespace of namespaces) {
      const legacyFilePath = getLegacyProfileFilePath(namespace, id);
      if (!legacyFilePath) continue;
      candidates.push({
        namespace,
        simulator,
        id,
        filePath: legacyFilePath,
        profileKey: buildProfileKey({ namespace, simulator, id }),
        legacy: true,
      });
    }
  }

  return candidates;
}

function resolveProfilePath(locatorValue: unknown): ResolvedProfilePath | null {
  if (!locatorValue || typeof locatorValue !== 'string') return null;

  const parsed = parseProfileLocator(locatorValue, {
    defaultSimulator: getConfiguredSimulator(),
  });
  if (!parsed || !parsed.id) {
    Debug.log('profile-loader', `Profile ID rejected: "${locatorValue}"`);
    return null;
  }

  const candidates = getResolutionCandidates(parsed);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.filePath)) {
      return candidate;
    }
  }

  return null;
}

function resolveParentProfilePath(profile: GenericRecord | null | undefined): ResolvedProfilePath | null {
  return resolveProfilePath(profile && profile.extends);
}

function ensureBundledProfilesAvailable(): void {
  if (bundledProfilesAvailableChecked) return;

  bundledProfilesAvailableChecked = true;
  if (!fs.existsSync(BUILTIN_BUNDLED_DIR)) {
    Debug.log('profile-loader', 'Built-in bundled aircraft profiles directory is missing', {
      sourceDir: BUILTIN_BUNDLED_DIR,
    });
  }
}

function buildCanonicalProfile(resolved: ResolvedProfilePath, rawProfile: GenericRecord): LoadedProfile {
  const normalized = normalizeProfileDocument(rawProfile, {
    defaultNamespace: resolved.namespace,
    defaultSimulator: resolved.simulator,
  });
  return {
    ...normalized,
    namespace: normalizeNamespace(normalized.namespace) || resolved.namespace,
    simulator: normalizeSimulator(normalized.simulator) || resolved.simulator,
  } as LoadedProfile;
}

function resolveInheritance(profile: LoadedProfile, visited = new Set<string>()): LoadedProfile {
  if (!profile.extends) return profile;

  const parentResolved = resolveParentProfilePath(profile);
  if (!parentResolved) {
    Debug.log('profile-loader', `Parent profile not found: ${profile.extends}`);
    return profile;
  }

  const parentKey = parentResolved.profileKey;
  if (visited.has(parentKey)) {
    Debug.log('profile-loader', `Inheritance cycle detected: ${parentKey}`, { visited: [...visited] });
    return profile;
  }

  const parentProfile = loadProfile(parentKey, visited);
  if (!parentProfile) return profile;

  const merged = deepMerge(stripInternalFields(parentProfile), stripInternalFields(profile));
  merged.id = profile.id;
  merged.name = profile.name;
  merged.namespace = profile.namespace;
  merged.simulator = profile.simulator;
  merged.extends = profile.extends;
  return merged as LoadedProfile;
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

function loadProfile(locatorValue: unknown, visited = new Set<string>()): LoadedProfile | null {
  if (!locatorValue) return null;
  const parsedCacheLocator = parseProfileLocator(locatorValue, {
    defaultSimulator: getConfiguredSimulator(),
  });
  if (
    parsedCacheLocator?.locatorType === 'profile-key' &&
    parsedCacheLocator.profileKey &&
    profileCache.has(parsedCacheLocator.profileKey)
  ) {
    return profileCache.get(parsedCacheLocator.profileKey) || null;
  }

  const pipelineResult = resolveLoadedProfile({
    locatorValue,
    visited,
    ensureBundledProfilesAvailable,
    resolveProfilePath,
    readProfileFile,
    isProfileDefinition,
    buildCanonicalProfile,
    resolveInheritance,
    finalizeLoadedProfile,
    log(message: string, meta?: GenericRecord) {
      Debug.log('profile-loader', message, meta);
    },
  });
  if (!pipelineResult) {
    return null;
  }
  const { resolved, finalized } = pipelineResult;

  const cacheKey = resolved.profileKey;
  if (profileCache.has(cacheKey)) {
    return profileCache.get(cacheKey) || null;
  }

  profileCache.set(cacheKey, finalized);

  Debug.log('profile-loader', `Loaded profile: ${finalized.name}`, {
    id: finalized.id,
    namespace: finalized.namespace,
    simulator: finalized.simulator,
    extends: finalized.extends || null,
  });

  return finalized;
}

// -----------------------------------------------------------------------------
// Auto-detection
// -----------------------------------------------------------------------------

function listAircraftCfgRuleValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item: unknown) => normalizeMatchText(item)).filter(Boolean);
}

function getAircraftCfgFieldValues(metadata: AircraftCfgMetadata | null | undefined, fieldName: unknown): string[] {
  const normalizedFieldName = normalizeAircraftCfgKey(fieldName);
  if (!normalizedFieldName || !metadata?.fields) return [];
  return metadata.fields[normalizedFieldName] || [];
}

function aircraftCfgFieldEquals(metadata: AircraftCfgMetadata, fieldName: unknown, expected: unknown): boolean {
  const actualValues = getAircraftCfgFieldValues(metadata, fieldName).map((value: string) => value.toLowerCase());
  const expectedValues = listAircraftCfgRuleValues(expected).map((value: string) => value.toLowerCase());
  if (actualValues.length === 0 || expectedValues.length === 0) return false;
  return expectedValues.some((expectedValue: string) => actualValues.includes(expectedValue));
}

function aircraftCfgFieldContains(metadata: AircraftCfgMetadata, fieldName: unknown, expected: unknown): boolean {
  const actualValues = getAircraftCfgFieldValues(metadata, fieldName).map((value: string) => value.toLowerCase());
  const expectedValues = listAircraftCfgRuleValues(expected).map((value: string) => value.toLowerCase());
  if (actualValues.length === 0 || expectedValues.length === 0) return false;
  return expectedValues.some((expectedValue: string) =>
    actualValues.some((actualValue: string) => actualValue.includes(expectedValue)));
}

function aircraftCfgFieldMatchesRegex(
  metadata: AircraftCfgMetadata,
  fieldName: unknown,
  pattern: unknown,
  profileId: unknown,
): boolean {
  const actualValues = getAircraftCfgFieldValues(metadata, fieldName);
  const patterns = listAircraftCfgRuleValues(pattern);
  if (actualValues.length === 0 || patterns.length === 0) return false;

  for (const item of patterns) {
    try {
      const regex = new RegExp(item, 'i');
      if (actualValues.some((actualValue: string) => regex.test(actualValue))) {
        return true;
      }
    } catch (error) {
      const err = error as Error;
      Debug.log('profile-loader', `Invalid aircraftCfg regex in profile ${profileId}`, { error: err.message });
    }
  }

  return false;
}

function scoreAircraftCfgFieldGroup(
  metadata: AircraftCfgMetadata,
  rules: unknown,
  matcher: (metadata: AircraftCfgMetadata, fieldName: unknown, expected: unknown) => boolean,
  requireAll: boolean,
  pointsPerField: number,
): number {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return 0;

  const entries = Object.entries(rules as GenericRecord)
    .filter(([, expected]: [string, unknown]) => listAircraftCfgRuleValues(expected).length > 0);
  if (entries.length === 0) return 0;

  let matchedFields = 0;
  for (const [fieldName, expected] of entries) {
    if (matcher(metadata, fieldName, expected)) {
      matchedFields += 1;
      continue;
    }
    if (requireAll) return 0;
  }

  if (matchedFields === 0) return 0;
  return matchedFields * pointsPerField;
}

function scoreAircraftCfgMatch(profile: LoadedProfile | null | undefined, metadata: AircraftCfgMetadata | null | undefined): number {
  const rules = profile?.integration?.matching?.aircraftCfg;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !metadata) return 0;

  let score = 0;
  let configuredGroups = 0;

  const equalsScore = scoreAircraftCfgFieldGroup(metadata, rules.equals, aircraftCfgFieldEquals, true, 45);
  if (rules.equals && typeof rules.equals === 'object') {
    configuredGroups += 1;
    if (equalsScore <= 0) return 0;
    score += equalsScore;
  }

  const containsAllScore = scoreAircraftCfgFieldGroup(metadata, rules.containsAll, aircraftCfgFieldContains, true, 35);
  if (rules.containsAll && typeof rules.containsAll === 'object') {
    configuredGroups += 1;
    if (containsAllScore <= 0) return 0;
    score += containsAllScore;
  }

  const containsAnyScore = scoreAircraftCfgFieldGroup(metadata, rules.containsAny, aircraftCfgFieldContains, false, 25);
  if (rules.containsAny && typeof rules.containsAny === 'object') {
    configuredGroups += 1;
    if (containsAnyScore <= 0) return 0;
    score += containsAnyScore;
  }

  const regexScore = scoreAircraftCfgFieldGroup(
    metadata,
    rules.regex,
    (meta: AircraftCfgMetadata, fieldName: unknown, pattern: unknown) =>
      aircraftCfgFieldMatchesRegex(meta, fieldName, pattern, profile?.id),
    true,
    40,
  );
  if (rules.regex && typeof rules.regex === 'object') {
    configuredGroups += 1;
    if (regexScore <= 0) return 0;
    score += regexScore;
  }

  return configuredGroups > 0 ? score : 0;
}

function scoreProfileMatch(
  profile: LoadedProfile | null | undefined,
  title: unknown,
  { aircraftCfg, hint, xplane }: DetectOptions = {},
): number {
  const matching = profile?.integration?.matching;
  if (!matching) return -1;

  const titleLower = normalizeMatchText(title).toLowerCase();
  const hintText = normalizeMatchText(hint);
  const hintLooksPath = isFilePathLike(hintText);
  const hintMatchText = hintLooksPath ? buildPathIdentityText(hintText) : hintText;
  const hintLower = hintMatchText.toLowerCase() || null;
  const hintFullLower = hintText.toLowerCase() || null;
  const hintHasSpecificEvidence = !hintLooksPath || hasProfileSpecificityToken(profile, `${hintText} ${hintMatchText}`);

  const matchesExcludedToken = (value: string, exclusions: unknown): boolean => {
    if (!Array.isArray(exclusions)) return false;
    const normalizedValue = normalizeSpecificityToken(value);
    if (!normalizedValue) return false;
    return exclusions.some((candidate: unknown) => {
      const normalizedCandidate = normalizeSpecificityToken(candidate);
      return !!normalizedCandidate && normalizedValue.includes(normalizedCandidate);
    });
  };

  // Exclusions are profile-wide vetoes. A known conflicting title or package
  // path must never be outweighed by a positive title, path, or aircraft.cfg
  // score from a related aircraft that reuses first-party assets.
  if (matchesExcludedToken(titleLower, matching.titleExcludes)) return -1;
  if (hintLooksPath && matchesExcludedToken(hintFullLower || '', matching.configPathExcludes)) return -1;

  let score = matching.priority || 0;
  let matched = false;

  const aircraftCfgScore = scoreAircraftCfgMatch(profile, aircraftCfg);
  if (aircraftCfgScore > 0) {
    matched = true;
    score += aircraftCfgScore;
  }

  if (Array.isArray(matching.titleContains)) {
    for (const needle of matching.titleContains) {
      const needleLower = String(needle || '').toLowerCase();
      if (!needleLower) continue;
      if (titleLower.includes(needleLower)) {
        matched = true;
        score += 10;
      } else if (hintLower && hintHasSpecificEvidence && hintLower.includes(needleLower)) {
        matched = true;
        score += 10;
      }
    }
  }

  if (matching.titleRegex) {
    try {
      const regex = new RegExp(matching.titleRegex, 'i');
      if (regex.test(normalizeMatchText(title))) {
        matched = true;
        score += 20;
      } else if (hintLower && hintHasSpecificEvidence && regex.test(hintMatchText)) {
        matched = true;
        score += 20;
      }
    } catch (error) {
      const err = error as Error;
      Debug.log('profile-loader', `Invalid regex in profile ${profile?.id}`, { error: err.message });
    }
  }

  if (hintLooksPath && Array.isArray(matching.configPathContains)) {
    for (const needle of matching.configPathContains) {
      const needleLower = String(needle || '').toLowerCase();
      if (!needleLower) continue;
      if (hintFullLower && hintFullLower.includes(needleLower)) {
        matched = true;
        score += 25;
      }
    }
  }

  if (hintLooksPath && matching.configPathRegex) {
    try {
      const regex = new RegExp(matching.configPathRegex, 'i');
      if (regex.test(hintText)) {
        matched = true;
        score += 40;
      }
    } catch (error) {
      const err = error as Error;
      Debug.log('profile-loader', `Invalid configPathRegex in profile ${profile?.id}`, { error: err.message });
    }
  }

  const xplaneMatching = matching.xplane;
  if (xplaneMatching && xplane && typeof xplane === 'object') {
    const acfPath = normalizeXplanePathValue(xplane.acfPath);
    const acfFileName = normalizeXplaneNameValue(xplane.acfFileName) || (acfPath ? acfPath.split('/').pop() : '');
    const identitySlug = normalizeXplaneNameValue(xplane.id);

    const profileAcfPaths = Array.isArray(xplaneMatching.acfPaths)
      ? xplaneMatching.acfPaths.map(normalizeXplanePathValue).filter(Boolean)
      : [];
    const profileAcfFileNames = Array.isArray(xplaneMatching.acfFileNames)
      ? xplaneMatching.acfFileNames.map(normalizeXplaneNameValue).filter(Boolean)
      : [];
    const profileAliases = Array.isArray(xplaneMatching.aliases)
      ? xplaneMatching.aliases.map(toXplaneSlug).filter(Boolean)
      : [];

    if (acfPath && profileAcfPaths.includes(acfPath)) {
      matched = true;
      score += 100;
    }

    if (acfFileName && profileAcfFileNames.includes(acfFileName)) {
      matched = true;
      score += 60;
    }

    if (profileAliases.length > 0) {
      const aliasCandidates = new Set([
        identitySlug,
        toXplaneSlug(acfFileName),
        toXplaneSlug(acfPath),
      ].filter(Boolean));

      if (profileAliases.some((alias: string) => aliasCandidates.has(alias))) {
        matched = true;
        score += 40;
      }
    }
  }

  return matched ? score : -1;
}

function extractSpecificityTokensFromText(value: unknown): string[] {
  return normalizeMatchText(value)
    .split(/[^a-zA-Z0-9]+/)
    .map(normalizeSpecificityToken)
    .filter((token: string) => token.length >= 3 && !GENERIC_MATCH_TOKENS.has(token) && !/\d/.test(token));
}

function getProfileSpecificityTokens(profile: LoadedProfile | null | undefined): string[] {
  const matching = profile?.integration?.matching;
  const tokens = new Set<string>();

  for (const token of extractSpecificityTokensFromText(profile?.id)) {
    tokens.add(token);
  }

  if (Array.isArray(matching?.titleContains)) {
    for (const title of matching.titleContains) {
      for (const token of extractSpecificityTokensFromText(title)) {
        tokens.add(token);
      }
    }
  }

  return [...tokens];
}

function hasProfileSpecificityToken(profile: LoadedProfile | null | undefined, evidence: unknown): boolean {
  const normalizedEvidence = normalizeSpecificityToken(evidence);
  if (!normalizedEvidence) return false;
  return getProfileSpecificityTokens(profile).some((token: string) => normalizedEvidence.includes(token));
}

function findBestProfileMatch(
  profiles: ProfileSummary[],
  title: unknown,
  options: DetectOptions = {},
): { profile: LoadedProfile | null; score: number } {
  let bestProfile: LoadedProfile | null = null;
  let bestScore = -1;

  for (const info of profiles) {
    if (info.abstract) continue;

    const profile = loadProfile(info.qualifiedId);
    if (!profile) continue;

    const score = scoreProfileMatch(profile, title, options);
    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
    }
  }

  return { profile: bestProfile, score: bestScore };
}

function detectProfile(title: unknown, { hint, xplane }: DetectOptions = {}): LoadedProfile | null {
  const normalizedTitle = normalizeMatchText(title);
  const normalizedHint = normalizeMatchText(hint);
  const targetSimulator = hasXplaneIdentityHint(xplane) || getConfiguredSimulator() === 'xplane'
    ? 'xplane'
    : 'msfs';

  if (!normalizedTitle && !normalizedHint && !hasXplaneIdentityHint(xplane)) {
    Debug.log('profile-loader', 'No title provided, using generic');
    return loadProfile(`bundled/${targetSimulator}/${GENERIC_ID}`);
  }

  const profiles = listProfiles().filter((item: ProfileSummary) => item.simulator === targetSimulator);
  const aircraftCfgMetadata = targetSimulator === 'msfs' ? readAircraftCfgMetadata(normalizedHint) : null;
  const { profile: bestProfile, score: bestScore } = findBestProfileMatch(
    profiles,
    normalizedTitle,
    { aircraftCfg: aircraftCfgMetadata, hint: normalizedHint, xplane },
  );

  if (bestProfile) {
    Debug.log('profile-loader', `Auto-detected profile: ${bestProfile.name}`, {
      title: normalizedTitle || null,
      hint: normalizedHint || null,
      xplane: xplane || null,
      simulator: targetSimulator,
      score: bestScore,
    });
    return bestProfile;
  }

  const aircraftCfgIdentity = aircraftCfgMetadata?.identity || null;
  if (aircraftCfgIdentity) {
    const cfgTitle = [normalizedTitle, aircraftCfgIdentity].filter(Boolean).join(' ');
    const cfgEvidence = [normalizedHint, aircraftCfgIdentity].filter(Boolean).join(' ');
    const cfgMatch = findBestProfileMatch(
      profiles,
      cfgTitle,
      { aircraftCfg: aircraftCfgMetadata, hint: normalizedHint, xplane },
    );

    if (cfgMatch.profile && hasProfileSpecificityToken(cfgMatch.profile, cfgEvidence)) {
      Debug.log('profile-loader', `Auto-detected profile from aircraft.cfg metadata: ${cfgMatch.profile.name}`, {
        title: normalizedTitle || null,
        hint: normalizedHint || null,
        aircraftCfgIdentity,
        simulator: targetSimulator,
        score: cfgMatch.score,
      });
      return cfgMatch.profile;
    }

    if (cfgMatch.profile) {
      Debug.log('profile-loader', 'Rejected aircraft.cfg profile match without vendor-specific evidence', {
        title: normalizedTitle || null,
        hint: normalizedHint || null,
        aircraftCfgIdentity,
        rejectedProfileId: cfgMatch.profile.id,
        score: cfgMatch.score,
      });
    }
  }

  const aircraftIdentity = normalizedTitle
    || normalizedHint
    || normalizeMatchText(xplane?.acfPath)
    || normalizeMatchText(xplane?.acfFileName)
    || normalizeMatchText(xplane?.id)
    || 'unknown aircraft';

  Debug.log('profile-loader', `No match for "${aircraftIdentity}", using generic`);
  console.warn(`[Profile] No aircraft profile found for "${aircraftIdentity}" - using generic fallback.`);
  console.warn('[Profile] Stability scoring may be inaccurate.');
  console.warn('[Profile] Want to help? Create a profile: see backend/aircraft/profiles/README.md');

  eventBus.emit('profile:fallback', {
    aircraftTitle: normalizedTitle || null,
    xplaneIdentity: xplane || null,
    fallbackProfile: buildProfileKey({ namespace: 'bundled', simulator: targetSimulator, id: GENERIC_ID }),
    contributionUrl: 'https://github.com/yenbuilds/flight-fabric/issues/new?labels=aircraft-profile&title=Profile+request:+' + encodeURIComponent(aircraftIdentity),
  });

  return loadProfile(`bundled/${targetSimulator}/${GENERIC_ID}`);
}

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

function scanNamespaceSimulatorDir(
  namespace: string,
  simulator: string,
  dir: string,
  profiles: ProfileSummary[],
  seen: Set<string>,
): void {
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of files) {
    if (!entry.isFile() || !isManagedProfileFileName(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const rawProfile = readProfileFile(filePath);
    if (!isProfileDefinition(rawProfile)) continue;

    const normalized = normalizeProfileDocument(rawProfile, {
      defaultNamespace: namespace,
      defaultSimulator: simulator,
    });
    const profileKey = buildProfileKey({
      namespace: normalizeNamespace(normalized.namespace) || namespace,
      simulator: normalizeSimulator(normalized.simulator) || simulator,
      id: normalizeProfileId(normalized.id),
    });
    if (!profileKey || seen.has(profileKey)) continue;

    const normalizedNamespace = normalizeNamespace(normalized.namespace) || namespace;
    const normalizedSimulator = normalizeSimulator(normalized.simulator) || simulator;
    seen.add(profileKey);

    profiles.push({
      id: normalized.id,
      name: normalized.name,
      namespace: normalizedNamespace,
      simulator: normalizedSimulator,
      qualifiedId: profileKey,
      abstract: normalized.abstract === true,
      source: normalizedNamespace,
      remoteInstall: null,
      bundledProfileKey: null,
      localOverrideUpdateStatus: null,
    });
  }
}

function scanNamespaceLegacyRoot(
  namespace: string,
  rootDir: string,
  profiles: ProfileSummary[],
  seen: Set<string>,
): void {
  if (!fs.existsSync(rootDir)) return;

  const files = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of files) {
    if (!entry.isFile() || !isManagedProfileFileName(entry.name)) continue;
    const filePath = path.join(rootDir, entry.name);
    const rawProfile = readProfileFile(filePath);
    if (!isProfileDefinition(rawProfile)) continue;

    const defaultSimulator = normalizeSimulator(rawProfile.simulator) || getConfiguredSimulator();
    const normalized = normalizeProfileDocument(rawProfile, {
      defaultNamespace: namespace,
      defaultSimulator,
    });
    const normalizedNamespace = normalizeNamespace(normalized.namespace) || namespace;
    const normalizedSimulator = normalizeSimulator(normalized.simulator) || defaultSimulator;
    const profileKey = buildProfileKey({
      namespace: normalizedNamespace,
      simulator: normalizedSimulator,
      id: normalizeProfileId(normalized.id),
    });
    if (!profileKey || seen.has(profileKey)) continue;
    seen.add(profileKey);

    profiles.push({
      id: normalized.id,
      name: normalized.name,
      namespace: normalizedNamespace,
      simulator: normalizedSimulator,
      qualifiedId: profileKey,
      abstract: normalized.abstract === true,
      source: normalizedNamespace,
      remoteInstall: null,
      bundledProfileKey: null,
      localOverrideUpdateStatus: null,
    });
  }
}

function scanNamespaceRoot(
  namespace: string,
  rootDir: string,
  profiles: ProfileSummary[],
  seen: Set<string>,
): void {
  if (!fs.existsSync(rootDir)) return;

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && PROFILE_SIMULATORS.includes(entry.name)) {
      scanNamespaceSimulatorDir(namespace, entry.name, path.join(rootDir, entry.name), profiles, seen);
    }
  }
}

function listProfiles(): ProfileSummary[] {
  ensureBundledProfilesAvailable();

  const profiles: ProfileSummary[] = [];
  const seen = new Set<string>();

  scanNamespaceRoot('bundled', BUILTIN_BUNDLED_DIR, profiles, seen);
  scanNamespaceLegacyRoot('bundled', BUILTIN_BUNDLED_DIR, profiles, seen);

  return profiles;
}

// -----------------------------------------------------------------------------
// Active profile management
// -----------------------------------------------------------------------------

function getDefaultGenericProfileKey(): string {
  return buildProfileKey({
    namespace: 'bundled',
    simulator: getConfiguredSimulator(),
    id: GENERIC_ID,
  });
}

function getActiveProfile(): LoadedProfile | null {
  if (activeProfile) {
    return activeProfile;
  }

  const envProfile = config.aircraft?.profile;
  if (envProfile && envProfile !== 'auto') {
    const profile = loadProfile(envProfile);
    if (profile) {
      activeProfile = profile;
      activeProfileId = profile._qualifiedId || null;
      activeProfileRevision += 1;
      Debug.log('profile-loader', `Active profile from env: ${profile.name}`);
      return activeProfile;
    }
  }

  const genericProfileKey = getDefaultGenericProfileKey();
  Debug.log('profile-loader', `Using generic profile (AIRCRAFT_PROFILE=${envProfile || 'unset'})`, {
    profileKey: genericProfileKey,
  });
  activeProfile = loadProfile(genericProfileKey);
  activeProfileId = activeProfile?._qualifiedId || genericProfileKey;
  activeProfileRevision += 1;
  return activeProfile;
}

function getActiveProfileId(): string | null {
  if (!activeProfileId) {
    getActiveProfile();
  }
  return activeProfileId;
}

function getActiveProfileRevision(): number {
  if (!activeProfileId) {
    getActiveProfile();
  }
  return activeProfileRevision;
}

function setActiveProfile(id: unknown): LoadedProfile | null {
  const profile = loadProfile(id);
  if (profile) {
    activeProfile = profile;
    activeProfileId = profile._qualifiedId || null;
    activeProfileRevision += 1;
    Debug.log('profile-loader', `Switched active profile: ${profile.name}`);
    return activeProfile;
  }
  return null;
}

function setActiveProfileFromTitle(title: unknown, { hint, xplane }: DetectOptions = {}): LoadedProfile {
  const profile = detectProfile(title, { hint, xplane }) || loadProfile(getDefaultGenericProfileKey());
  if (!profile) {
    throw new Error('[profile-loader] Failed to resolve a fallback aircraft profile');
  }
  activeProfile = profile;
  activeProfileId = profile._qualifiedId || null;
  activeProfileRevision += 1;
  lastDetectedTitle = typeof title === 'string' ? title : normalizeMatchText(title) || null;
  return activeProfile;
}

function getLastDetectedTitle(): string | null {
  return lastDetectedTitle;
}

function clearCache(): void {
  profileCache.clear();
  aircraftCfgMetadataCache.clear();
  activeProfile = null;
  activeProfileId = null;
  activeProfileRevision += 1;
  lastDetectedTitle = null;
  bundledProfilesAvailableChecked = false;
}

// -----------------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------------

function getFlapsConfig(): GenericRecord | null {
  return getActiveProfile()?.aircraft?.flaps || null;
}

function getStabilityConfig(): GenericRecord | null {
  return getActiveProfile()?.aircraft?.stability || null;
}

function getStabilityScoringCriteria(profile: LoadedProfile | null = getActiveProfile()): StabilityScoringCriteriaOverrides | null {
  const stability = profile?.aircraft?.stability;
  if (!stability || typeof stability !== 'object') return null;

  const criteria: StabilityScoringCriteriaOverrides = {};
  const speedBand = stability.speedBand && typeof stability.speedBand === 'object' ? stability.speedBand : null;
  const vsLimits = stability.vsLimits && typeof stability.vsLimits === 'object' ? stability.vsLimits : null;
  const pitch = stability.pitch && typeof stability.pitch === 'object' ? stability.pitch : null;
  const gates = stability.stabilizedGates && typeof stability.stabilizedGates === 'object' ? stability.stabilizedGates : null;

  const gateRaFt = finiteNumberOrNull(gates?.imcRaFt) ?? finiteNumberOrNull(gates?.vmcRaFt);
  if (gateRaFt !== null && gateRaFt > 0) criteria.gateRaFt = gateRaFt;

  const speedMinusKts = finiteNumberOrNull(speedBand?.belowVrefKts);
  if (speedMinusKts !== null && speedMinusKts >= 0) criteria.speedMinusKts = speedMinusKts;

  const speedPlusKts = finiteNumberOrNull(speedBand?.aboveVrefKts);
  if (speedPlusKts !== null && speedPlusKts >= 0) criteria.speedPlusKts = speedPlusKts;

  const downFpm = finiteNumberOrNull(vsLimits?.downFpm);
  if (downFpm !== null) criteria.vsMinFpm = -Math.abs(downFpm);

  const upFpm = finiteNumberOrNull(vsLimits?.upFpm);
  if (upFpm !== null) criteria.vsMaxClimbFpm = Math.abs(upFpm);

  const thrustMinPct = finiteNumberOrNull(stability.thrustMinPct);
  if (thrustMinPct !== null && thrustMinPct >= 0) criteria.thrustIdleMinPct = thrustMinPct;

  const pitchMinDeg = finiteNumberOrNull(pitch?.minDeg);
  if (pitchMinDeg !== null) criteria.pitchMinDeg = pitchMinDeg;

  const pitchMaxDeg = finiteNumberOrNull(pitch?.maxDeg);
  if (pitchMaxDeg !== null) criteria.pitchMaxDeg = pitchMaxDeg;

  return Object.keys(criteria).length > 0 ? criteria : null;
}

function getThrottleConfig(): GenericRecord | null {
  return getActiveProfile()?.aircraft?.throttle || null;
}

function getSpoilersConfig(): GenericRecord | null {
  return getActiveProfile()?.integration?.telemetry?.spoilers || null;
}

function getLandingConfig(): GenericRecord | null {
  return getActiveProfile()?.aircraft?.landing || null;
}

function getPhaseConfig(): GenericRecord | null {
  return getActiveProfile()?.aircraft?.phaseThresholds || null;
}

function getLandingGrades(): GenericRecord | null {
  return getLandingConfig()?.grades || null;
}

function getLvarConfig(): {
  aircraftSpecific: AircraftSpecificConfig;
  enabled: boolean;
  profileId: string;
  subscriptions: LvarSubscription[];
} {
  const profile = getActiveProfile();
  const profileId = profile?._qualifiedId || getDefaultGenericProfileKey();
  const subscriptions: LvarSubscription[] = [];
  const seenKeys = new Set<string>();
  const keysByExpression = new Map<string, string>();
  const lightKeyMap: Record<string, string> = {
    beacon: 'light_beacon',
    nav: 'light_nav',
    strobe: 'light_strobe',
    landing: 'light_landing',
    landing_left: 'light_landing_left',
    landing_right: 'light_landing_right',
    taxi: 'light_taxi',
    turnoff: 'light_turnoff',
    turnoff_left: 'light_turnoff_left',
    turnoff_right: 'light_turnoff_right',
    logo: 'light_logo',
    wing: 'light_wing',
    recognition: 'light_recognition',
    cabin: 'light_cabin',
  };

  const normalizeExpression = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('(')) {
      const singleDatum = trimmed.match(/^\(\s*([LA]:[^,\)]+)\s*(?:,\s*[^\)]+)?\)$/i);
      if (!singleDatum) return null;
      return `(${singleDatum[1].trim()})`;
    }

    if (/^[LA]:/i.test(trimmed)) {
      return `(${trimmed})`;
    }

    return `(L:${trimmed})`;
  };

  const pushSub = (
    key: string,
    rawValue: unknown,
    sourcePath: string,
    options: { dataType?: unknown; unit?: unknown } = {},
  ): string | null => {
    if (seenKeys.has(key)) return key;
    const expression = normalizeExpression(rawValue);
    if (!expression) return null;
    const existingKey = keysByExpression.get(expression.toLowerCase());
    if (existingKey) return existingKey;
    const unit = typeof options.unit === 'string' ? options.unit.trim() : '';
    const dataType = typeof options.dataType === 'string' ? options.dataType.trim().toLowerCase() : '';
    subscriptions.push({
      key,
      expression,
      sourcePath,
      ...(unit ? { unit } : {}),
      ...(dataType ? { dataType } : {}),
    });
    seenKeys.add(key);
    keysByExpression.set(expression.toLowerCase(), key);
    return key;
  };

  const pushLightSubs = (lightsLvars: unknown, sourcePathPrefix: string): void => {
    if (!lightsLvars || typeof lightsLvars !== 'object') return;
    for (const [lightName, key] of Object.entries(lightKeyMap)) {
      pushSub(key, (lightsLvars as GenericRecord)[lightName], `${sourcePathPrefix}.${lightName}`);
    }
  };

  const dataSourceLvars = profile?.integration?.telemetry?.lvars || null;
  if (dataSourceLvars && typeof dataSourceLvars === 'object') {
    for (const [key, value] of Object.entries(dataSourceLvars)) {
      if (typeof key === 'string' && key.startsWith('_')) continue;
      if (key === 'parkingBrake') continue;
      if (typeof value === 'string') {
        pushSub(key, value, `integration.telemetry.lvars.${key}`);
      }
    }

    const mcp = (dataSourceLvars as GenericRecord).mcp;
    if (mcp && typeof mcp === 'object') {
      pushSub('selected_altitude', mcp.altitude, 'integration.telemetry.lvars.mcp.altitude');
      pushSub('selected_heading', mcp.heading, 'integration.telemetry.lvars.mcp.heading');
      pushSub('selected_speed', mcp.speed, 'integration.telemetry.lvars.mcp.speed');
      pushSub('mode_speed', mcp.speedMode, 'integration.telemetry.lvars.mcp.speedMode');
      pushSub('selected_vertical_speed', mcp.vs, 'integration.telemetry.lvars.mcp.vs');
      pushSub('mode_lnav', mcp.lnav, 'integration.telemetry.lvars.mcp.lnav');
      pushSub('mode_vnav', mcp.vnav, 'integration.telemetry.lvars.mcp.vnav');
      pushSub('mode_loc', mcp.loc, 'integration.telemetry.lvars.mcp.loc');
      pushSub('mode_app', mcp.app, 'integration.telemetry.lvars.mcp.app');
      pushSub('mode_heading', mcp.hdgMode, 'integration.telemetry.lvars.mcp.hdgMode');
      pushSub('mode_altitude_hold', mcp.altMode, 'integration.telemetry.lvars.mcp.altMode');
      pushSub('mode_vertical_speed', mcp.vsMode, 'integration.telemetry.lvars.mcp.vsMode');
      pushSub('mode_flc', mcp.lvlChg, 'integration.telemetry.lvars.mcp.lvlChg');
      pushSub('mode_expedite', mcp.exped, 'integration.telemetry.lvars.mcp.exped');
      pushSub('ap_channel_a', mcp.cmdA, 'integration.telemetry.lvars.mcp.cmdA');
      pushSub('ap_channel_b', mcp.cmdB, 'integration.telemetry.lvars.mcp.cmdB');
    }

    const spoilersLvars = (dataSourceLvars as GenericRecord).spoilers;
    if (spoilersLvars && typeof spoilersLvars === 'object') {
      pushSub('spoilers_armed', spoilersLvars.armed, 'integration.telemetry.lvars.spoilers.armed');
      pushSub('spoilers_handle', spoilersLvars.handlePosition, 'integration.telemetry.lvars.spoilers.handlePosition');
    }

    if (typeof (dataSourceLvars as GenericRecord).parkingBrake === 'string') {
      pushSub('parking_brake', (dataSourceLvars as GenericRecord).parkingBrake, 'integration.telemetry.lvars.parkingBrake');
    }

    pushLightSubs((dataSourceLvars as GenericRecord).lights, 'integration.telemetry.lvars.lights');
  }

  const controlMcp = profile?.integration?.controls?.autopilot?.mcpLvars;
  if (controlMcp && typeof controlMcp === 'object') {
    pushSub('selected_heading', controlMcp.heading, 'integration.controls.autopilot.mcpLvars.heading');
    pushSub('selected_altitude', controlMcp.altitude, 'integration.controls.autopilot.mcpLvars.altitude');
    pushSub('selected_vertical_speed', controlMcp.vs, 'integration.controls.autopilot.mcpLvars.vs');
    pushSub('selected_speed', controlMcp.speed, 'integration.controls.autopilot.mcpLvars.speed');
  }

  const declaredIntegrationId = profile?.integration?.aircraftSpecific?.adapter;
  const aircraftIntegration = defaultAircraftIntegrationRegistry.resolveIntegration(
    declaredIntegrationId,
    { profileKey: profileId },
  );
  type AircraftSpecificFieldCandidate = {
    decode: GenericRecord;
    source: unknown;
    sourcePath: string;
  };
  const integrationFieldCandidates = new Map<string, AircraftSpecificFieldCandidate[]>();
  const effectiveFieldCandidates = new Map<string, AircraftSpecificFieldCandidate[]>();
  const configuredSdk = profile?.integration?.telemetry?.sdk;
  const configuredSdkAdapterId = typeof configuredSdk?.adapter === 'string' && configuredSdk.adapter.trim()
    ? configuredSdk.adapter.trim().toLowerCase()
    : (typeof configuredSdk?.connector === 'string' && configuredSdk.connector.trim()
      ? 'clientdata-manifest'
      : null);

  const isConfiguredIntegrationSource = (source: GenericRecord): boolean => {
    if (source.route?.type !== 'sdk') return true;
    const requiredAdapterId = typeof source.route.adapter === 'string'
      ? source.route.adapter.trim().toLowerCase()
      : '';
    return !!configuredSdkAdapterId && requiredAdapterId === configuredSdkAdapterId;
  };

  if (aircraftIntegration?.fields && typeof aircraftIntegration.fields === 'object') {
    for (const [id, fieldValue] of Object.entries(aircraftIntegration.fields)) {
      if (!fieldValue || typeof fieldValue !== 'object') continue;
      const candidates = Array.isArray((fieldValue as GenericRecord).sources)
        ? (fieldValue as GenericRecord).sources
          .map((sourceValue: unknown, index: number): AircraftSpecificFieldCandidate | null => {
            if (!sourceValue || typeof sourceValue !== 'object') return null;
            const source = sourceValue as GenericRecord;
            if (!source.route || typeof source.route !== 'object') return null;
            if (!isConfiguredIntegrationSource(source)) return null;
            return {
              source: source.route,
              decode: source.decode && typeof source.decode === 'object'
                ? source.decode
                : { type: 'number' },
              sourcePath: `aircraft-integrations.${aircraftIntegration.id}.fields.${id}.sources.${index}.route`,
            };
          })
          .filter((candidate: AircraftSpecificFieldCandidate | null): candidate is AircraftSpecificFieldCandidate => !!candidate)
        : [];
      if (candidates.length > 0) {
        integrationFieldCandidates.set(id, candidates);
        effectiveFieldCandidates.set(id, candidates);
      }
    }
  }

  const aircraftSpecificTelemetry = profile?.integration?.telemetry?.aircraftSpecific;
  const configuredFields = aircraftSpecificTelemetry?.fields;
  if (configuredFields && typeof configuredFields === 'object') {
    for (const [id, fieldValue] of Object.entries(configuredFields)) {
      if (!fieldValue || typeof fieldValue !== 'object') continue;
      const field = fieldValue as GenericRecord;
      effectiveFieldCandidates.set(id, [{
        source: field.source,
        decode: field.decode && typeof field.decode === 'object' ? field.decode : { type: 'number' },
        sourcePath: `integration.telemetry.aircraftSpecific.fields.${id}.source`,
      }]);
    }
  }

  const compileAircraftSpecificFields = (
    candidatesByFieldId: Map<string, AircraftSpecificFieldCandidate[]>,
  ): AircraftSpecificFieldConfig[] => {
    const compiledFields: AircraftSpecificFieldConfig[] = [];
    for (const [id, candidates] of candidatesByFieldId) {
      for (const candidate of candidates) {
        const compiledSource = defaultAircraftSpecificBindingResolverRegistry.compile(candidate.source, {
          fieldId: id,
          registerLvar: pushSub,
          sourcePath: candidate.sourcePath,
        });
        if (!compiledSource) continue;
        compiledFields.push({
          id,
          source: compiledSource,
          decode: candidate.decode,
        });
        break;
      }
    }
    return compiledFields;
  };

  const confirmationFieldIds = new Set<string>();
  if (aircraftIntegration?.actions && typeof aircraftIntegration.actions === 'object') {
    for (const action of Object.values(aircraftIntegration.actions)) {
      if (!action || typeof action !== 'object' || !Array.isArray((action as GenericRecord).routes)) continue;
      for (const route of (action as GenericRecord).routes) {
        const fieldId = route?.readback?.fieldId;
        if (typeof fieldId === 'string' && fieldId) confirmationFieldIds.add(fieldId);
        const preconditionFieldId = route?.precondition?.fieldId;
        if (typeof preconditionFieldId === 'string' && preconditionFieldId) {
          confirmationFieldIds.add(preconditionFieldId);
        }
      }
    }
  }
  const confirmationCandidates = new Map<string, AircraftSpecificFieldCandidate[]>();
  for (const fieldId of confirmationFieldIds) {
    const candidates = integrationFieldCandidates.get(fieldId);
    if (candidates) confirmationCandidates.set(fieldId, candidates);
  }

  const aircraftIntegrationConfirmationFields = compileAircraftSpecificFields(confirmationCandidates);
  const aircraftSpecificFields = compileAircraftSpecificFields(effectiveFieldCandidates);

  const configuredTemplate = profile?.integration?.presentation?.aircraftSpecific?.template;
  const integrationTemplate = aircraftIntegration?.presentation?.templateId;
  const aircraftSpecific: AircraftSpecificConfig = {
    profileKey: profileId,
    profileRevision: getActiveProfileRevision(),
    integrationId: typeof aircraftIntegration?.id === 'string' ? aircraftIntegration.id : null,
    confirmationFields: aircraftIntegrationConfirmationFields,
    templateId: typeof configuredTemplate === 'string' && configuredTemplate.trim()
      ? configuredTemplate.trim()
      : (typeof integrationTemplate === 'string' && integrationTemplate.trim()
        ? integrationTemplate.trim()
        : null),
    fields: aircraftSpecificFields,
  };

  return {
    enabled: subscriptions.length > 0,
    profileId,
    subscriptions,
    aircraftSpecific,
  };
}

function getAircraftSpecificConfig(): AircraftSpecificConfig {
  return getLvarConfig().aircraftSpecific;
}

function isLandingFlaps(notchValue: unknown): boolean {
  const flaps = getFlapsConfig();
  if (!flaps?.landingNotches) return true;
  return flaps.landingNotches.includes(notchValue);
}

function getFlapNotch(value: unknown): GenericRecord | null {
  const flaps = getFlapsConfig();
  if (!flaps?.notches) return null;
  return flaps.notches.find((notch: GenericRecord) => notch.value === value) || null;
}

function getVisualSupport(): string {
  return getActiveProfile()?.integration?.presentation?.visualSupport || 'basic';
}

function hasFullVisualSupport(): boolean {
  return getVisualSupport() === 'full';
}

// -----------------------------------------------------------------------------
// VS0-Based Category Inference
// -----------------------------------------------------------------------------

let cachedVs0Kts: number | null = null;

function setVs0FromSimConnect(vs0Kts: unknown): void {
  if (typeof vs0Kts !== 'number' || Number.isNaN(vs0Kts) || vs0Kts <= 0) {
    cachedVs0Kts = null;
    return;
  }

  cachedVs0Kts = vs0Kts;

  Debug.log('profile-loader', 'VS0 cached for category inference', {
    vs0Kts: cachedVs0Kts.toFixed(1),
    vref: (cachedVs0Kts * 1.3).toFixed(1),
    inferredCategory: inferCategoryFromVs0(cachedVs0Kts),
  });
}

function clearVs0Cache(): void {
  cachedVs0Kts = null;
}

function inferCategoryFromVs0(vs0Kts: unknown): string | null {
  if (typeof vs0Kts !== 'number' || Number.isNaN(vs0Kts) || vs0Kts <= 0) {
    return null;
  }

  const vref = vs0Kts * 1.3;
  if (vref < 91) return 'A';
  if (vref < 121) return 'B';
  if (vref < 141) return 'C';
  if (vref < 166) return 'D';
  return 'E';
}

function getAircraftCategory(): string {
  const category = getActiveProfile()?.aircraft?.category;
  if (category && ['A', 'B', 'C', 'D', 'E'].includes(String(category).toUpperCase())) {
    return String(category).toUpperCase();
  }

  if (cachedVs0Kts !== null) {
    const inferred = inferCategoryFromVs0(cachedVs0Kts);
    if (inferred) {
      return inferred;
    }
  }

  return 'C';
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

function exportProfile(id: unknown, opts: { flatten?: boolean } = {}): GenericRecord {
  if (!id) return { ok: false, errors: ['No profile ID specified'] };

  const resolved = resolveProfilePath(id);
  if (!resolved) {
    return { ok: false, errors: [`Profile not found: ${id}`] };
  }

  let exported: GenericRecord;
  if (opts.flatten === true) {
    const loaded = loadProfile(resolved.profileKey);
    if (!loaded) {
      return { ok: false, errors: ['Failed to load profile'] };
    }
    exported = stripInternalFields(loaded);
    delete exported.extends;
  } else {
    const raw = readProfileFile(resolved.filePath);
    if (!raw) {
      return { ok: false, errors: ['Failed to read profile file'] };
    }
    exported = normalizeProfileDocument(raw, {
      defaultNamespace: resolved.namespace,
      defaultSimulator: resolved.simulator,
    });
  }

  return {
    ok: true,
    profile: exported,
    filename: `${resolved.id}.json`,
  };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

const aircraftProfileLoaderApi = {
  loadProfile,
  detectProfile,
  listProfiles,

  getActiveProfile,
  getActiveProfileId,
  getActiveProfileRevision,
  setActiveProfile,
  setActiveProfileFromTitle,

  getFlapsConfig,
  getSpoilersConfig,
  getStabilityConfig,
  getStabilityScoringCriteria,
  getThrottleConfig,
  getLandingConfig,
  getLandingGrades,
  getPhaseConfig,
  getLvarConfig,
  getAircraftSpecificConfig,
  getAircraftCategory,

  setVs0FromSimConnect,
  clearVs0Cache,
  inferCategoryFromVs0,

  isLandingFlaps,
  getFlapNotch,

  getVisualSupport,
  hasFullVisualSupport,

  clearCache,
  resolveProfilePath,
  getLastDetectedTitle,

  BUILTIN_ROOT_DIR,
  BUILTIN_BUNDLED_DIR,
  GENERIC_ID,
  MAX_PROFILE_JSON_BYTES,

  exportProfile,
};

module.exports = aircraftProfileLoaderApi;

export {};
