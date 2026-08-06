'use strict';

const {
  buildSidecarEnv,
  resolveLaunchSpec,
} = require('./rust-clientdata-launch.js') as {
  buildSidecarEnv: () => NodeJS.ProcessEnv;
  resolveLaunchSpec: () => SdkLaunchResolution;
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
};

type SdkAdapter = {
  id: string;
  displayName: string;
  sourceType?: string;
  categories: string[];
  noDataHint?: string;
  pidFileName?: string;
  matches: (profileSdk: SdkProfileConfig | null | undefined) => boolean;
  normalizeTarget: (target: AnyRecord | null | undefined) => AnyRecord;
  describeTarget: (target: AnyRecord | null | undefined) => string | null;
  buildConnectMessage: (target: AnyRecord | null | undefined) => AnyRecord | null;
  buildSidecarEnv: () => NodeJS.ProcessEnv;
  resolveLaunchSpec: () => SdkLaunchResolution;
  normalizeSnapshot: (rawSnapshot: AnyRecord | null | undefined) => AnyRecord;
};

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeManifestTarget(target: AnyRecord | null | undefined): AnyRecord {
  const connector = trimString(target?.connector) || trimString(target?.id);
  const channel = trimString(target?.channel) || connector;
  if (!channel && !connector) return {};
  return connector ? { channel, connector } : { channel };
}

function normalizeSnapshot(): AnyRecord {
  return {};
}

function createClientdataManifestAdapter(): SdkAdapter {
  return {
    id: 'clientdata-manifest',
    displayName: 'Declarative ClientData SDK Connector',
    sourceType: 'sdk',
    categories: ['sdk'],
    noDataHint: 'No SDK connector data yet (check connector setup and simulator data broadcast settings).',
    pidFileName: 'flight-fabric-sdk-clientdata-manifest.pid',
    matches(profileSdk) {
      const adapterId = trimString(profileSdk?.adapter).toLowerCase();
      return adapterId === 'clientdata-manifest' || adapterId === 'sdk-clientdata';
    },
    normalizeTarget: normalizeManifestTarget,
    describeTarget(target) {
      const normalizedTarget = normalizeManifestTarget(target);
      return normalizedTarget.connector || normalizedTarget.channel || null;
    },
    buildConnectMessage(target) {
      const normalizedTarget = normalizeManifestTarget(target);
      if (!normalizedTarget.channel) return null;
      return {
        type: 'connect',
        aircraft: normalizedTarget.channel,
      };
    },
    buildSidecarEnv,
    resolveLaunchSpec,
    normalizeSnapshot,
  };
}

module.exports = { createClientdataManifestAdapter };

export {};
