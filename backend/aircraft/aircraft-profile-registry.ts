'use strict';

// Aircraft profile registry: loads, validates, indexes, and watches aircraft
// profile JSON files so the rest of the app can resolve profiles by key/name.

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');
const Ajv = require('ajv') as any;
const addFormats = require('ajv-formats') as (ajv: any) => void;
const Debug = require('../core/debug.js') as {
  log: (scope: string, message: string, meta?: Record<string, unknown>) => void;
};
const eventBus = require('../core/event-bus.js') as {
  emit: (event: string, payload: Record<string, any>) => void;
  on: (event: string, handler: (payload: Record<string, any>) => void) => () => void;
};
const { MSG } = require('../core/message-types.js') as {
  MSG: Record<string, string>;
};
const {
  buildProfileKey,
  normalizeSimulator,
} = require('./aircraft-profile-identity.js') as {
  buildProfileKey: (input: { namespace: unknown; simulator: unknown; id: unknown }) => string;
  normalizeSimulator: (value: unknown) => string;
};
const {
  normalizeProfileDocument,
} = require('./aircraft-profile-model.js') as {
  normalizeProfileDocument: (profile: Record<string, any>, options?: Record<string, any>) => Record<string, any>;
};

type GenericRecord = Record<string, any>;

const PROFILES_DIR = path.join(__dirname, 'profiles');
const BUNDLED_PROFILES_DIR = path.join(PROFILES_DIR, 'bundled');
const SCHEMA_PATH = path.join(PROFILES_DIR, 'aircraft-profile.schema.json');

let schema: GenericRecord | null = null;
let ajv: any = null;
let validate: any = null;
let profiles = new Map<string, GenericRecord>();
let initialized = false;

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as GenericRecord).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as GenericRecord)[key])}`).join(',')}}`;
}

function computeProfileContentHash(profile: GenericRecord): string {
  return crypto.createHash('sha256').update(stableStringify(profile)).digest('hex');
}

function loadSchema(): boolean {
  try {
    schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validate = ajv.compile(schema);
    return true;
  } catch (error) {
    const err = error as { message?: string };
    Debug.log('profile-registry', 'Failed to load schema', { error: err.message });
    return false;
  }
}

function validateProfile(profile: GenericRecord): GenericRecord {
  if (!validate) {
    return { valid: false, errors: [{ path: '/', message: 'Schema not loaded' }], warnings: [], warningObjects: [] };
  }

  const valid = validate(profile);
  const errors = valid
    ? null
    : (validate.errors || []).map((error: any) => ({
        path: error.instancePath || '/',
        message: error.message,
        keyword: error.keyword,
        params: error.params,
      }));

  const warnings: string[] = [];
  const warningObjects: Array<{ message: string }> = [];
  const addWarning = (message: string): void => {
    warnings.push(message);
    warningObjects.push({ message });
  };

  if (!profile.meta) {
    addWarning('Missing meta section - add developer and status fields');
  } else if (!profile.meta.status) {
    addWarning('Missing meta.status - set to production, partial, experimental, or deprecated');
  }

  if (!profile.integration?.matching) {
    addWarning('Missing integration.matching section - profile cannot be auto-detected');
  } else {
    const matching = profile.integration.matching;
    const aircraftCfg = matching.aircraftCfg;
    const hasAircraftCfgRules =
      aircraftCfg &&
      ['equals', 'containsAll', 'containsAny', 'regex'].some((key: string) =>
        aircraftCfg[key] &&
        typeof aircraftCfg[key] === 'object' &&
        Object.keys(aircraftCfg[key]).some((fieldName: string) => !fieldName.startsWith('_')));
    const hasMsfsRules =
      (Array.isArray(matching.titleContains) && matching.titleContains.length > 0) ||
      typeof matching.titleRegex === 'string' ||
      hasAircraftCfgRules;
    const hasXplaneRules =
      matching.xplane &&
      ((Array.isArray(matching.xplane.acfPaths) && matching.xplane.acfPaths.length > 0) ||
        (Array.isArray(matching.xplane.acfFileNames) && matching.xplane.acfFileNames.length > 0) ||
        (Array.isArray(matching.xplane.aliases) && matching.xplane.aliases.length > 0));
    if (profile.id !== 'generic' && !hasMsfsRules && !hasXplaneRules) {
      addWarning('No auto-detection rules - add titleContains/titleRegex/aircraftCfg for MSFS or matching.xplane.* for X-Plane');
    }
  }

  return { valid, errors, warnings, warningObjects };
}

function listProfileFiles(rootDir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(rootDir)) return files;

  function walk(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      files.push(absolutePath);
    }
  }

  walk(rootDir);
  return files;
}

function inferDefaultSimulatorFromPath(filePath: string): string {
  const relativePath = path.relative(BUNDLED_PROFILES_DIR, filePath);
  const firstSegment = relativePath.split(path.sep)[0];
  return normalizeSimulator(firstSegment) || 'msfs';
}

function loadAllProfiles(): Map<string, GenericRecord> {
  const results = new Map<string, GenericRecord>();
  for (const filePath of listProfileFiles(BUNDLED_PROFILES_DIR)) {
    try {
      const rawProfile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const normalized = normalizeProfileDocument(rawProfile, {
        defaultNamespace: 'bundled',
        defaultSimulator: inferDefaultSimulatorFromPath(filePath),
      });
      if (!normalized.id) continue;
      if (normalized.abstract) continue;

      const profileKey = buildProfileKey({
        namespace: normalized.namespace,
        simulator: normalized.simulator,
        id: normalized.id,
      });
      if (!profileKey) continue;

      const validation = validateProfile(normalized);
      results.set(profileKey, {
        profile: normalized,
        filePath,
        validation,
        contentHash: computeProfileContentHash(normalized),
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      const err = error as { message?: string };
      Debug.log('profile-registry', `Failed to load ${filePath}`, { error: err.message });
    }
  }
  return results;
}

function generateManifest(): GenericRecord {
  const entries: GenericRecord[] = [];

  for (const [profileKey, data] of profiles) {
    const { profile, validation, contentHash } = data;
    entries.push({
      profileKey,
      id: profile.id,
      name: profile.name,
      namespace: profile.namespace,
      simulator: profile.simulator,
      extends: profile.extends || null,
      contentHash,
      matching: profile.integration?.matching || null,
      meta: {
        developer: profile.meta?.developer || null,
        status: profile.meta?.status || 'unknown',
        platforms: profile.meta?.platforms || [],
      },
      provenance: {
        sourceCount: profile.provenance?.sources?.length || 0,
        verificationStatus: profile.provenance?.verification?.status || 'unverified',
        lastVerified: profile.provenance?.verification?.lastVerified || null,
      },
      quality: {
        schemaValid: validation.valid,
        warningCount: validation.warnings?.length || 0,
      },
      sections: {
        hasFlaps: !!profile.aircraft?.flaps,
        hasGear: !!profile.aircraft?.gear,
        hasStability: !!profile.aircraft?.stability,
        hasLights: !!profile.integration?.presentation?.lights,
        hasPerformance: !!profile.aircraft?.performance,
        hasEngines: !!profile.aircraft?.engines,
        hasThrottle: !!profile.aircraft?.throttle,
      },
    });
  }

  entries.sort((left, right) => {
    if (left.namespace !== right.namespace) {
      const order: Record<string, number> = { bundled: 0, community: 1, local: 2 };
      return (order[left.namespace] || 3) - (order[right.namespace] || 3);
    }
    if (left.simulator !== right.simulator) {
      return left.simulator.localeCompare(right.simulator);
    }
    const priorityLeft = left.matching?.priority || 0;
    const priorityRight = right.matching?.priority || 0;
    if (priorityLeft !== priorityRight) return priorityRight - priorityLeft;
    return left.name.localeCompare(right.name);
  });

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    schemaVersion: schema?.$id || 'unknown',
    profileCount: entries.length,
    profiles: entries,
  };
}

function emitProfileEvent(eventType: string, data: GenericRecord): void {
  eventBus.emit(`profile:${eventType}`, data);
  if (eventType === 'activated') {
    eventBus.emit('telemetry:profile', {
      type: MSG.AIRCRAFT_PROFILE,
      ...data,
    });
  }
}

function onProfileChange(callback: (eventType: string, data: GenericRecord) => void): () => void {
  const events = ['profile:loaded', 'profile:activated', 'profile:validation-error'];
  const unsubscribes = events.map((event) => eventBus.on(event, (data) => callback(event.replace('profile:', ''), data)));
  return () => {
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Ignore.
      }
    }
  };
}

function validateProfilesWithAjvStrict(): GenericRecord {
  try {
    const strictSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const strictAjv = new Ajv({ allErrors: true, strict: true });
    addFormats(strictAjv);
    const strictValidate = strictAjv.compile(strictSchema);
    const failures: GenericRecord[] = [];

    for (const filePath of listProfileFiles(BUNDLED_PROFILES_DIR)) {
      const rawProfile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const normalized = normalizeProfileDocument(rawProfile, {
        defaultNamespace: 'bundled',
        defaultSimulator: inferDefaultSimulatorFromPath(filePath),
      });
      if (normalized.abstract) continue;
      const ok = strictValidate(normalized);
      if (!ok) {
        failures.push({
          id:
            buildProfileKey({ namespace: normalized.namespace, simulator: normalized.simulator, id: normalized.id }) ||
            normalized.id,
          errors: (strictValidate.errors || []).map((error: any) => ({
            path: error.instancePath || '/',
            message: error.message,
            keyword: error.keyword,
            params: error.params,
          })),
        });
      }
    }

    return { success: failures.length === 0, failures };
  } catch (error) {
    const err = error as { message?: string };
    return { success: false, error: err.message };
  }
}

function initialize(): GenericRecord {
  if (initialized) {
    return { success: true, profileCount: profiles.size, errors: [] };
  }

  if (!loadSchema()) {
    return { success: false, profileCount: 0, errors: ['Failed to load schema'] };
  }

  profiles = loadAllProfiles();
  initialized = true;

  const errors: GenericRecord[] = [];
  for (const [profileKey, data] of profiles) {
    if (!data.validation.valid) {
      errors.push({ id: profileKey, errors: data.validation.errors });
    }
  }

  emitProfileEvent('loaded', {
    profileCount: profiles.size,
    validCount: profiles.size - errors.length,
    invalidCount: errors.length,
  });

  return { success: true, profileCount: profiles.size, errors };
}

function getProfile(id: string): GenericRecord | null {
  return profiles.get(id)?.profile || null;
}

function getProfileIds(): string[] {
  return [...profiles.keys()];
}

function getValidation(id: string): GenericRecord | null {
  return profiles.get(id)?.validation || null;
}

function getManifest(): GenericRecord {
  if (!initialized) initialize();
  return generateManifest();
}

function getStats(): GenericRecord {
  if (!initialized) initialize();

  let validCount = 0;
  const byStatus: Record<string, number> = {};
  const byNamespace: Record<string, number> = {};
  const bySimulator: Record<string, number> = {};

  for (const [, data] of profiles) {
    if (data.validation.valid) validCount += 1;
    const status = data.profile.meta?.status || 'unknown';
    const namespace = data.profile.namespace || 'bundled';
    const simulator = data.profile.simulator || 'msfs';
    byStatus[status] = (byStatus[status] || 0) + 1;
    byNamespace[namespace] = (byNamespace[namespace] || 0) + 1;
    bySimulator[simulator] = (bySimulator[simulator] || 0) + 1;
  }

  return {
    total: profiles.size,
    valid: validCount,
    invalid: profiles.size - validCount,
    byStatus,
    byNamespace,
    bySimulator,
  };
}

function validateExternal(profile: GenericRecord): GenericRecord {
  if (!initialized) initialize();
  const normalized = normalizeProfileDocument(profile, {
    defaultNamespace: profile?.namespace || 'local',
    defaultSimulator: profile?.simulator || 'msfs',
  });
  const validation = validateProfile(normalized);
  return {
    normalized,
    validation,
    summary: {
      valid: validation.valid,
      errorCount: validation.errors?.length || 0,
      warningCount: validation.warnings?.length || 0,
    },
  };
}

function printReport(): void {
  initialize();
  const stats = getStats();
  console.log('\n=== Aircraft Profile Registry Report ===\n');
  console.log(`Total profiles: ${stats.total}`);
  console.log(`Schema valid: ${stats.valid} / ${stats.total}`);
  console.log('\nBy status:', stats.byStatus);
  console.log('By namespace:', stats.byNamespace);
  console.log('By simulator:', stats.bySimulator);
  console.log('\n--- Profile Details ---\n');

  for (const [profileKey, data] of profiles) {
    const { profile, validation } = data;
    const icon = validation.valid ? 'PASS' : 'FAIL';
    console.log(`${icon} ${profileKey}`);
    console.log(`   Name: ${profile.name}`);
    console.log(`   Status: ${profile.meta?.status || 'unknown'}`);
    console.log(`   Extends: ${profile.extends || 'none'}`);
    if (!validation.valid) {
      console.log(`   Errors: ${validation.errors.map((error: GenericRecord) => error.message).join(', ')}`);
    }
    if (validation.warnings.length > 0) {
      console.log(`   Warnings: ${validation.warnings.length}`);
    }
    console.log('');
  }

  if (process.argv.includes('--manifest')) {
    console.log('\n--- Registry Manifest ---\n');
    console.log(JSON.stringify(getManifest(), null, 2));
  }
}

if (require.main === module) {
  printReport();
}

const aircraftProfileRegistryApi = {
  _reset: (): void => {
    profiles.clear();
    initialized = false;
  },
  emitProfileEvent,
  getManifest,
  getProfile,
  getProfileIds,
  getStats,
  getValidation,
  initialize,
  onProfileChange,
  validateExternal,
  validateProfile,
  validateProfilesWithAjvStrict,
};

module.exports = aircraftProfileRegistryApi;

export {};
