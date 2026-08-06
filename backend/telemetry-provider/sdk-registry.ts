'use strict';

const {
  createClientdataManifestAdapter,
} = require('./sdk-adapters/clientdata-manifest.js') as {
  createClientdataManifestAdapter: () => SdkAdapter;
};

type AnyRecord = Record<string, any>;
type LaunchProvider = 'rust';

type SdkLaunchSpec = {
  provider: LaunchProvider;
  source: string;
  command: string;
  args: string[];
  cleanupToken: string;
};

type SdkLaunchResolution = {
  launchSpec: SdkLaunchSpec | null;
  error: string | null;
};

type SdkProfileConfig = {
  adapter: string;
  target: AnyRecord;
  raw: AnyRecord;
  preferred: string | null;
};

type SdkAdapter = {
  id: string;
  displayName: string;
  sourceType?: string;
  categories: string[];
  noDataHint?: string;
  pidFileName?: string;
  matches: (profileSdk: SdkProfileConfig | null | undefined) => boolean;
  normalizeTarget?: (target: AnyRecord | null | undefined) => AnyRecord;
  describeTarget?: (target: AnyRecord | null | undefined) => string | null;
  buildConnectMessage?: (target: AnyRecord | null | undefined) => AnyRecord | null;
  buildSidecarEnv?: () => NodeJS.ProcessEnv;
  resolveLaunchSpec?: () => SdkLaunchResolution;
  normalizeSnapshot?: (rawSnapshot: AnyRecord | null | undefined) => AnyRecord;
};

type ResolvedSdkProfile = {
  adapter: SdkAdapter;
  profileSdk: SdkProfileConfig;
};

const SDK_SOURCE_TYPE = 'sdk';

const registeredAdapters: SdkAdapter[] = [
  createClientdataManifestAdapter(),
];

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSdkPreferredSource(preferred: unknown): string | null {
  const normalized = trimString(preferred).toLowerCase();
  return normalized || null;
}

function normalizeSdkProfileConfig(dataSource: unknown): SdkProfileConfig | null {
  if (!isObject(dataSource)) return null;
  const sdkRaw = isObject(dataSource.sdk) ? { ...dataSource.sdk } : null;
  if (!sdkRaw) return null;

  const preferred = normalizeSdkPreferredSource(dataSource.preferred);
  let adapterId = trimString(sdkRaw.adapter).toLowerCase();

  const target = isObject(sdkRaw.target) ? { ...sdkRaw.target } : {};
  const legacyChannel = trimString(sdkRaw.channel);
  if (legacyChannel && target.channel == null) {
    target.channel = legacyChannel;
  }
  const connector = trimString(sdkRaw.connector);
  if (connector && target.connector == null) {
    target.connector = connector;
  }
  if (!adapterId && connector) {
    adapterId = 'clientdata-manifest';
  }

  return {
    adapter: adapterId,
    target,
    raw: sdkRaw,
    preferred,
  };
}

function getSdkAdapterById(adapterId: unknown): SdkAdapter | null {
  const normalizedId = trimString(adapterId).toLowerCase();
  if (!normalizedId) return null;
  return registeredAdapters.find((adapter) => adapter.id === normalizedId) || null;
}

function resolveProfileSdkConfig(dataSource: unknown): ResolvedSdkProfile | null {
  const profileSdk = normalizeSdkProfileConfig(dataSource);
  if (!profileSdk || !profileSdk.adapter) return null;

  const adapter = registeredAdapters.find((candidate) => candidate.matches(profileSdk)) || null;
  if (!adapter) return null;

  const normalizedTarget = typeof adapter.normalizeTarget === 'function'
    ? adapter.normalizeTarget(profileSdk.target)
    : profileSdk.target;

  return {
    adapter,
    profileSdk: {
      ...profileSdk,
      target: isObject(normalizedTarget) ? { ...normalizedTarget } : {},
    },
  };
}

function isSdkSourceType(value: unknown): boolean {
  const type = trimString(value).toLowerCase();
  return type === SDK_SOURCE_TYPE;
}

const sdkRegistryApi = {
  SDK_SOURCE_TYPE,
  getSdkAdapterById,
  isSdkSourceType,
  normalizeSdkPreferredSource,
  normalizeSdkProfileConfig,
  resolveProfileSdkConfig,
};

module.exports = sdkRegistryApi;

export {};
