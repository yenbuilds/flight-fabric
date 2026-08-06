'use strict';

// Canonical aircraft profile identity helpers: normalize ids/namespaces and
// convert between profile locators and stable profile keys.

type ProfileNamespace = 'bundled' | 'local';
type ProfileSimulator = 'msfs' | 'xplane';
type LocatorType = 'profile-key' | 'simulator-id' | 'namespace-id' | 'id';

type ParseProfileOptions = {
  defaultNamespace?: unknown;
  defaultSimulator?: unknown;
};

type ParsedProfileLocator = {
  id: string;
  locatorType: LocatorType;
  namespace: ProfileNamespace | null;
  profileKey: string | null;
  simulator: ProfileSimulator | null;
};

const PROFILE_NAMESPACES = Object.freeze(['bundled', 'local'] as const);
const PROFILE_SIMULATORS = Object.freeze(['msfs', 'xplane'] as const);
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function isKnownNamespace(value: unknown): boolean {
  return PROFILE_NAMESPACES.includes(String(value || '').trim().toLowerCase() as ProfileNamespace);
}

function isKnownSimulator(value: unknown): boolean {
  return PROFILE_SIMULATORS.includes(String(value || '').trim().toLowerCase() as ProfileSimulator);
}

function normalizeProfileId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return PROFILE_ID_RE.test(normalized) ? normalized : '';
}

function normalizeNamespace(value: unknown): ProfileNamespace | '' {
  const normalized = String(value || '').trim().toLowerCase();
  return isKnownNamespace(normalized) ? (normalized as ProfileNamespace) : '';
}

function normalizeSimulator(value: unknown): ProfileSimulator | '' {
  const normalized = String(value || '').trim().toLowerCase();
  return isKnownSimulator(normalized) ? (normalized as ProfileSimulator) : '';
}

function buildProfileKey(input: { id: unknown; namespace: unknown; simulator: unknown }): string {
  const normalizedNamespace = normalizeNamespace(input.namespace);
  const normalizedSimulator = normalizeSimulator(input.simulator);
  const normalizedId = normalizeProfileId(input.id);
  if (!normalizedNamespace || !normalizedSimulator || !normalizedId) return '';
  return `${normalizedNamespace}/${normalizedSimulator}/${normalizedId}`;
}

function parseProfileLocator(value: unknown, options: ParseProfileOptions = {}): ParsedProfileLocator | null {
  if (typeof value !== 'string') return null;

  const defaultNamespace = normalizeNamespace(options.defaultNamespace);
  const defaultSimulator = normalizeSimulator(options.defaultSimulator);
  const parts = value.trim().toLowerCase().split('/').filter(Boolean);
  if (parts.length === 0) return null;

  if (parts.length === 3 && isKnownNamespace(parts[0]) && isKnownSimulator(parts[1])) {
    const id = normalizeProfileId(parts[2]);
    if (!id) return null;
    return {
      namespace: parts[0] as ProfileNamespace,
      simulator: parts[1] as ProfileSimulator,
      id,
      profileKey: `${parts[0]}/${parts[1]}/${id}`,
      locatorType: 'profile-key',
    };
  }

  if (parts.length === 2 && isKnownSimulator(parts[0])) {
    const id = normalizeProfileId(parts[1]);
    if (!id) return null;
    return {
      namespace: defaultNamespace || null,
      simulator: parts[0] as ProfileSimulator,
      id,
      profileKey: defaultNamespace ? `${defaultNamespace}/${parts[0]}/${id}` : null,
      locatorType: 'simulator-id',
    };
  }

  if (parts.length === 2 && isKnownNamespace(parts[0])) {
    const id = normalizeProfileId(parts[1]);
    if (!id) return null;
    return {
      namespace: parts[0] as ProfileNamespace,
      simulator: defaultSimulator || null,
      id,
      profileKey: defaultSimulator ? `${parts[0]}/${defaultSimulator}/${id}` : null,
      locatorType: 'namespace-id',
    };
  }

  if (parts.length === 1) {
    const id = normalizeProfileId(parts[0]);
    if (!id) return null;
    return {
      namespace: defaultNamespace || null,
      simulator: defaultSimulator || null,
      id,
      profileKey: defaultNamespace && defaultSimulator ? `${defaultNamespace}/${defaultSimulator}/${id}` : null,
      locatorType: 'id',
    };
  }

  return null;
}

function encodeProfileKeyForFileName(profileKey: unknown): string {
  if (typeof profileKey !== 'string' || !profileKey.trim()) return '';
  return profileKey.trim().toLowerCase().replace(/\//g, '__');
}

const aircraftProfileIdentityApi = {
  PROFILE_ID_RE,
  PROFILE_NAMESPACES,
  PROFILE_SIMULATORS,
  buildProfileKey,
  encodeProfileKeyForFileName,
  isKnownNamespace,
  isKnownSimulator,
  normalizeNamespace,
  normalizeProfileId,
  normalizeSimulator,
  parseProfileLocator,
};

module.exports = aircraftProfileIdentityApi;

export {};
