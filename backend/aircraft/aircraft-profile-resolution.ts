'use strict';

type AnyRecord = Record<string, any>;

type ResolutionResult = {
  resolved: {
    filePath: string;
    profileKey: string;
  } & AnyRecord;
  finalized: AnyRecord;
};

export function resolveLoadedProfile(params: {
  locatorValue: unknown;
  visited?: Set<string>;
  ensureBundledProfilesAvailable: () => void;
  resolveProfilePath: (locatorValue: unknown) => AnyRecord | null;
  readProfileFile: (filePath: string) => AnyRecord | null;
  isProfileDefinition: (profile: unknown) => boolean;
  buildCanonicalProfile: (resolved: AnyRecord, rawProfile: AnyRecord) => AnyRecord;
  resolveInheritance: (profile: AnyRecord, visited: Set<string>) => AnyRecord;
  finalizeLoadedProfile: (profile: AnyRecord) => AnyRecord;
  log: (message: string, meta?: AnyRecord) => void;
}): ResolutionResult | null {
  const {
    locatorValue,
    visited = new Set<string>(),
    ensureBundledProfilesAvailable,
    resolveProfilePath,
    readProfileFile,
    isProfileDefinition,
    buildCanonicalProfile,
    resolveInheritance,
    finalizeLoadedProfile,
    log,
  } = params;

  if (!locatorValue) return null;

  ensureBundledProfilesAvailable();

  const resolved = resolveProfilePath(locatorValue);
  if (!resolved) {
    log(`Profile not found: ${locatorValue}`);
    return null;
  }

  const rawProfile = readProfileFile(resolved.filePath);
  if (!rawProfile || !isProfileDefinition(rawProfile)) {
    log(`Skipping invalid profile JSON: ${resolved.filePath}`);
    return null;
  }

  const canonicalProfile = buildCanonicalProfile(resolved, rawProfile);
  const nextVisited = new Set(visited);
  nextVisited.add(resolved.profileKey);
  const resolvedProfile = resolveInheritance(canonicalProfile, nextVisited);
  const finalized = finalizeLoadedProfile({
    ...resolvedProfile,
    _loaded: true,
    _source: resolved.filePath,
    _qualifiedId: resolved.profileKey,
  });

  return {
    resolved: resolved as ResolutionResult['resolved'],
    finalized,
  };
}

module.exports = {
  resolveLoadedProfile,
};

export {};
