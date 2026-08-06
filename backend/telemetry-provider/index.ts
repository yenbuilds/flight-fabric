'use strict';

type ProviderType = 'simconnect' | 'xplane' | 'mock' | 'unknown';

type SecondaryDataSource = {
  type: string;
  name: string;
  connected: boolean;
  status?: string;
  error?: string | null;
  librarySpec?: string | null;
  description?: string;
  categories?: string[];
  adapterId?: string;
  preview?: any[];
  mode?: string;
  subscriptionCount?: number;
  liveValueCount?: number;
  profileSubscriptionCount?: number;
  debugWatch?: any;
};

type PrimaryDataSource = {
  type: ProviderType | string;
  name: string;
  connected: boolean;
  status?: string;
  error?: string | null;
  librarySpec?: string | null;
  description?: string;
  categories?: string[];
  mode?: string;
  subscriptionCount?: number;
  liveValueCount?: number;
};

type ProviderLike = {
  isConnected?: () => boolean;
  getPrimaryDataSource?: () => PrimaryDataSource | null | undefined;
  getSecondaryDataSources?: () => SecondaryDataSource[] | null | undefined;
};

type ProviderFactoryOptions = {
  isMock?: boolean;
  isXPlane?: boolean;
  simulatorProtocol?: string | null;
};

type DataSourceInfo = {
  primary: PrimaryDataSource;
  secondary: SecondaryDataSource[];
  sources: Array<PrimaryDataSource | SecondaryDataSource>;
};

let activeProvider: ProviderLike | null = null;
let activeProviderType: ProviderType | null = null;

function shouldUseXPlaneProvider({ isXPlane, simulatorProtocol }: ProviderFactoryOptions = {}): boolean {
  if (isXPlane) return true;
  return String(simulatorProtocol || '').trim().toUpperCase() === 'XPLANE_WEB';
}

function createProvider(options: ProviderFactoryOptions = {}): ProviderLike {
  let provider: ProviderLike;
  const useXPlaneProvider = shouldUseXPlaneProvider(options);

  if (options.isMock) {
    const { MockProvider } = require('./mock-provider.js') as {
      MockProvider: new () => ProviderLike;
    };
    provider = new MockProvider();
    activeProviderType = 'mock';
  } else if (useXPlaneProvider) {
    console.log('[Provider] Using X-Plane Web API provider');
    const { XPlaneTelemetryProvider } = require('./xplane-telemetry-provider.js') as {
      XPlaneTelemetryProvider: new () => ProviderLike;
    };
    provider = new XPlaneTelemetryProvider();
    activeProviderType = 'xplane';
  } else {
    console.log('[Provider] Using SimConnect-only provider (V1 default)');
    const { SimConnectTelemetryProvider } = require('./simconnect-telemetry-provider.js') as {
      SimConnectTelemetryProvider: new () => ProviderLike;
    };
    provider = new SimConnectTelemetryProvider();
    activeProviderType = 'simconnect';
  }

  activeProvider = provider;
  return provider;
}

function getDataSourceInfo(): DataSourceInfo {
  const provider = activeProvider;
  const type: ProviderType = activeProviderType || 'unknown';

  const primaryNames: Record<ProviderType, string> = {
    simconnect: 'SimConnect',
    xplane: 'X-Plane Web API',
    mock: 'Mock Data',
    unknown: 'Unknown',
  };

  const providerPrimary = typeof provider?.getPrimaryDataSource === 'function'
    ? provider.getPrimaryDataSource() || null
    : null;

  const primary = providerPrimary || {
    type,
    name: primaryNames[type] || type,
    connected: provider?.isConnected?.() ?? false,
  };

  const secondary = typeof provider?.getSecondaryDataSources === 'function'
    ? provider.getSecondaryDataSources() || []
    : [];

  return { primary, secondary, sources: [primary, ...secondary] };
}

const telemetryProviderApi = {
  createProvider,
  getDataSourceInfo,
};

module.exports = telemetryProviderApi;

export {};
