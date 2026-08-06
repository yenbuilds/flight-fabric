/**
 * Airport Geometry Service
 *
 * Single domain-facing entry point for runway geometry. OurAirports remains
 * the simulator-neutral fallback while live providers can be registered behind
 * this module for simulator-specific geometry.
 */

'use strict';

type AirportGeometrySource =
  | 'msfs-facilities'
  | 'ourairports'
  | 'xplane-airports'
  | 'recorded-snapshot'
  | 'legacy-derived';

type GeometryContext = {
  simulator?: 'msfs' | 'xplane' | 'generic' | string | null;
  dataSource?: string | null;
  offline?: boolean;
};

type AnyRecord = Record<string, any>;

type RunwayGeometry = AnyRecord & {
  source: AirportGeometrySource;
  headingTrueDeg?: number | null;
};

type AirportGeometryProvider = {
  id: AirportGeometrySource;
  simulator: 'msfs' | 'xplane' | 'generic';
  isAvailable: () => boolean;
  getAirport?: (icao: string) => AnyRecord | null;
  getDatabaseStats?: () => AnyRecord;
  getRunway: (icao: string, runway: string) => RunwayGeometry | null;
  findRunwayByPosition: (
    lat: number | null | undefined,
    lon: number | null | undefined,
    maxDistanceNm?: number,
    aircraftTrueHeadingDeg?: number | null,
  ) => RunwayGeometry | null;
  findNearbyAirport?: (
    lat: number,
    lon: number,
    radiusNm?: number,
  ) => AnyRecord | null;
  prefetchAirport?: (icao: string) => void;
  getDiagnosticSnapshot?: () => AnyRecord;
};

type ProviderPlanEntry = {
  id: AirportGeometrySource;
  provider: AirportGeometryProvider | null;
};

function getRunwayDatabase(): AnyRecord {
  // Lazy lookup preserves existing tests that replace runway-database in the
  // require cache before loading landing/timeline modules.
  return require('./runway-database');
}

function normalizeRunwayGeometry(runway: AnyRecord | null | undefined, source: AirportGeometrySource): RunwayGeometry | null {
  if (!runway || typeof runway !== 'object') return null;
  const headingTrueDeg = runway.heading_true_deg ?? runway.headingTrueDeg ?? runway.heading ?? null;
  return {
    ...runway,
    source: runway.source || source,
    headingTrueDeg,
    heading_true_deg: runway.heading_true_deg ?? headingTrueDeg,
  };
}

function createOurAirportsProvider(): AirportGeometryProvider {
  return {
    id: 'ourairports',
    simulator: 'generic',
    isAvailable: () => true,
    getAirport(icao: string): AnyRecord | null {
      const db = getRunwayDatabase();
      return typeof db.getAirport === 'function' ? db.getAirport(icao) : null;
    },
    getDatabaseStats(): AnyRecord {
      const db = getRunwayDatabase();
      return typeof db.getDatabaseStats === 'function'
        ? db.getDatabaseStats()
        : { airportCount: 0, runwayCount: 0, loadError: 'OurAirports provider unavailable' };
    },
    getRunway(icao: string, runway: string): RunwayGeometry | null {
      const db = getRunwayDatabase();
      const result = typeof db.getRunway === 'function' ? db.getRunway(icao, runway) : null;
      return normalizeRunwayGeometry(result, 'ourairports');
    },
    findRunwayByPosition(
      lat: number | null | undefined,
      lon: number | null | undefined,
      maxDistanceNm = 2,
      aircraftTrueHeadingDeg: number | null = null,
    ): RunwayGeometry | null {
      const db = getRunwayDatabase();
      const result = typeof db.findRunwayByPosition === 'function'
        ? db.findRunwayByPosition(lat, lon, maxDistanceNm, aircraftTrueHeadingDeg)
        : null;
      return normalizeRunwayGeometry(result, 'ourairports');
    },
    findNearbyAirport(lat: number, lon: number, radiusNm = 5): AnyRecord | null {
      const db = getRunwayDatabase();
      return typeof db.findNearbyAirport === 'function' ? db.findNearbyAirport(lat, lon, radiusNm) : null;
    },
  };
}

const ourAirportsProvider = createOurAirportsProvider();
const registeredProviders = new Map<AirportGeometrySource, AirportGeometryProvider>();

function normalizeSimulator(value: unknown): 'msfs' | 'xplane' | 'generic' {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (token.includes('xplane') || token.includes('x-plane')) return 'xplane';
  if (
    token.includes('msfs') ||
    token.includes('simconnect') ||
    token.includes('rust-simvars') ||
    token.includes('fs2020') ||
    token.includes('fs2024')
  ) {
    return 'msfs';
  }
  return 'generic';
}

function isProviderUsable(provider: AirportGeometryProvider | null | undefined): provider is AirportGeometryProvider {
  if (!provider || typeof provider !== 'object') return false;
  return typeof provider.isAvailable !== 'function' || provider.isAvailable() === true;
}

function pushProvider(
  providers: AirportGeometryProvider[],
  provider: AirportGeometryProvider | null | undefined,
): void {
  if (!isProviderUsable(provider)) return;
  if (providers.some((existing) => existing.id === provider.id)) return;
  providers.push(provider);
}

function getAirportGeometryProviderChain(context: GeometryContext = {}): AirportGeometryProvider[] {
  const providers: AirportGeometryProvider[] = [];

  for (const entry of getAirportGeometryProviderPlan(context)) {
    pushProvider(providers, entry.provider);
  }

  return providers;
}

function getAirportGeometryProviderPlan(context: GeometryContext = {}): ProviderPlanEntry[] {
  const providers: ProviderPlanEntry[] = [];
  const simulator = normalizeSimulator(context.simulator ?? context.dataSource);

  // Offline timeline/logbook replay should remain deterministic and local.
  if (!context.offline && simulator === 'msfs') {
    providers.push({
      id: 'msfs-facilities',
      provider: registeredProviders.get('msfs-facilities') || null,
    });
  }

  // Use OurAirports for X-Plane until a dedicated airport source is available,
  // while retaining OurAirports as the fallback below.
  providers.push({ id: 'ourairports', provider: ourAirportsProvider });

  return providers;
}

function prefetchEarlierProviders(
  providers: AirportGeometryProvider[],
  resultProviderIndex: number,
  result: AnyRecord | null | undefined,
): void {
  if (!result || typeof result !== 'object') return;
  const icao = typeof result.icao === 'string'
    ? result.icao
    : typeof result.airport_icao === 'string'
      ? result.airport_icao
      : null;
  if (!icao) return;

  for (let i = 0; i < resultProviderIndex; i++) {
    const provider = providers[i];
    if (typeof provider.prefetchAirport !== 'function') continue;
    try {
      provider.prefetchAirport(icao);
    } catch {}
  }
}

function getActiveAirportGeometryProvider(context: GeometryContext = {}): AirportGeometryProvider {
  return getAirportGeometryProviderChain(context)[0] || ourAirportsProvider;
}

function providerUnavailableReason(entry: ProviderPlanEntry): string | null {
  const provider = entry.provider;
  if (!provider) return 'not_registered';
  if (typeof provider.isAvailable !== 'function') return null;
  try {
    return provider.isAvailable() === true ? null : 'unavailable';
  } catch (err) {
    return `availability_error:${err instanceof Error ? err.message : String(err)}`;
  }
}

function safeProviderDiagnostics(provider: AirportGeometryProvider | null): AnyRecord | null {
  if (!provider || typeof provider.getDiagnosticSnapshot !== 'function') return null;
  try {
    const snapshot = provider.getDiagnosticSnapshot();
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch (err) {
    return {
      diagnosticError: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildGeometryLookupDiagnostics(input: {
  method: string;
  context: GeometryContext;
  entries: AnyRecord[];
  resultProviderId?: string | null;
}): AnyRecord {
  const { method, context, entries, resultProviderId = null } = input;
  const providerChain = entries
    .map((entry) => `${entry.provider}:${entry.result}`)
    .join(',');
  const fallbackEntry = entries.find((entry) => (
    entry.provider !== resultProviderId &&
    entry.result !== 'hit'
  ));
  const fallbackReason = fallbackEntry
    ? `${fallbackEntry.provider}:${fallbackEntry.result}${fallbackEntry.reason ? `:${fallbackEntry.reason}` : ''}`
    : null;

  return {
    method,
    simulator: normalizeSimulator(context.simulator ?? context.dataSource),
    dataSource: context.dataSource ?? null,
    providerChain,
    resultProvider: resultProviderId,
    fallbackReason,
    providers: entries,
  };
}

function attachGeometryLookupDiagnostics<T extends AnyRecord>(
  result: T,
  diagnostics: AnyRecord,
): T {
  return {
    ...result,
    runway_geometry_provider_chain: diagnostics.providerChain || null,
    runwayGeometryProviderChain: diagnostics.providerChain || null,
    runway_geometry_fallback_reason: diagnostics.fallbackReason || null,
    runwayGeometryFallbackReason: diagnostics.fallbackReason || null,
    runway_geometry_diagnostics: diagnostics,
    runwayGeometryDiagnostics: diagnostics,
  };
}

function lookupProvider<T extends AnyRecord | null>(
  entry: ProviderPlanEntry,
  method: string,
  lookup: (provider: AirportGeometryProvider) => T,
): { result: T | null; diagnostic: AnyRecord } {
  const reason = providerUnavailableReason(entry);
  const base = {
    provider: entry.id,
    method,
    diagnostic: safeProviderDiagnostics(entry.provider),
  };
  if (reason) {
    return {
      result: null,
      diagnostic: { ...base, result: 'unavailable', reason },
    };
  }
  const provider = entry.provider;
  if (!provider) {
    return {
      result: null,
      diagnostic: { ...base, result: 'unavailable', reason: 'not_registered' },
    };
  }
  try {
    const result = lookup(provider);
    return {
      result: result || null,
      diagnostic: { ...base, result: result ? 'hit' : 'miss' },
    };
  } catch (err) {
    return {
      result: null,
      diagnostic: {
        ...base,
        result: 'error',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function registerAirportGeometryProvider(provider: AirportGeometryProvider): void {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('Airport geometry provider must be an object');
  }
  if (!provider.id) {
    throw new TypeError('Airport geometry provider must declare an id');
  }
  if (provider.id === 'ourairports') {
    throw new TypeError('OurAirports provider is built in and cannot be replaced at runtime');
  }
  registeredProviders.set(provider.id, provider);
}

function resetAirportGeometryProviders(): void {
  registeredProviders.clear();
}

function getAirport(icao: string, context: GeometryContext = {}): AnyRecord | null {
  const plan = getAirportGeometryProviderPlan(context);
  const usableProviders: AirportGeometryProvider[] = [];
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    const reason = providerUnavailableReason(entry);
    if (reason || !entry.provider) continue;
    const provider = entry.provider;
    usableProviders.push(provider);
    if (typeof provider.getAirport !== 'function') continue;
    const airport = provider.getAirport(icao);
    if (airport) {
      prefetchEarlierProviders(usableProviders, usableProviders.length - 1, { ...airport, icao });
      return airport;
    }
  }
  return null;
}

function getDatabaseStats(context: GeometryContext = {}): AnyRecord {
  let firstStats: AnyRecord | null = null;

  for (const provider of getAirportGeometryProviderChain(context)) {
    if (typeof provider.getDatabaseStats !== 'function') continue;
    const stats = provider.getDatabaseStats();
    if (!stats || typeof stats !== 'object') continue;
    if (!firstStats) firstStats = stats;

    const airportCount = Number(stats.airportCount);
    const runwayCount = Number(stats.runwayCount);
    if (airportCount > 0 || runwayCount > 0) return stats;
  }

  return firstStats || { airportCount: 0, runwayCount: 0, loadError: 'Airport geometry provider unavailable' };
}

function getRunway(icao: string, runway: string, context: GeometryContext = {}): RunwayGeometry | null {
  const plan = getAirportGeometryProviderPlan(context);
  const usableProviders: AirportGeometryProvider[] = [];
  const diagnostics: AnyRecord[] = [];
  for (const entry of plan) {
    const { result: rawResult, diagnostic } = lookupProvider(entry, 'getRunway', (provider) => (
      provider.getRunway(icao, runway)
    ));
    diagnostics.push(diagnostic);
    if (entry.provider && diagnostic.result !== 'unavailable') usableProviders.push(entry.provider);
    const result = normalizeRunwayGeometry(rawResult, entry.id);
    if (result) {
      prefetchEarlierProviders(usableProviders, usableProviders.length - 1, result);
      const lookupDiagnostics = buildGeometryLookupDiagnostics({
        method: 'getRunway',
        context,
        entries: diagnostics,
        resultProviderId: result.source || entry.id,
      });
      return attachGeometryLookupDiagnostics(result, lookupDiagnostics);
    }
  }
  return null;
}

function findRunwayByPosition(
  lat: number | null | undefined,
  lon: number | null | undefined,
  maxDistanceNm = 2,
  aircraftTrueHeadingDeg: number | null = null,
  context: GeometryContext = {},
): RunwayGeometry | null {
  const plan = getAirportGeometryProviderPlan(context);
  const usableProviders: AirportGeometryProvider[] = [];
  const diagnostics: AnyRecord[] = [];
  for (const entry of plan) {
    const { result: rawResult, diagnostic } = lookupProvider(entry, 'findRunwayByPosition', (provider) => (
      provider.findRunwayByPosition(lat, lon, maxDistanceNm, aircraftTrueHeadingDeg)
    ));
    diagnostics.push(diagnostic);
    if (entry.provider && diagnostic.result !== 'unavailable') usableProviders.push(entry.provider);
    const result = normalizeRunwayGeometry(
      rawResult,
      entry.id,
    );
    if (result) {
      prefetchEarlierProviders(usableProviders, usableProviders.length - 1, result);
      const lookupDiagnostics = buildGeometryLookupDiagnostics({
        method: 'findRunwayByPosition',
        context,
        entries: diagnostics,
        resultProviderId: result.source || entry.id,
      });
      return attachGeometryLookupDiagnostics(result, lookupDiagnostics);
    }
  }
  return null;
}

function findNearbyAirport(
  lat: number,
  lon: number,
  radiusNm = 5,
  context: GeometryContext = {},
): AnyRecord | null {
  const plan = getAirportGeometryProviderPlan(context);
  const usableProviders: AirportGeometryProvider[] = [];
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    const reason = providerUnavailableReason(entry);
    if (reason || !entry.provider) continue;
    const provider = entry.provider;
    usableProviders.push(provider);
    if (typeof provider.findNearbyAirport !== 'function') continue;
    const airport = provider.findNearbyAirport(lat, lon, radiusNm);
    if (airport) {
      prefetchEarlierProviders(usableProviders, usableProviders.length - 1, airport);
      return airport;
    }
  }
  return null;
}

module.exports = {
  createOurAirportsProvider,
  findNearbyAirport,
  findRunwayByPosition,
  getActiveAirportGeometryProvider,
  getAirportGeometryProviderChain,
  getAirport,
  getDatabaseStats,
  getRunway,
  normalizeRunwayGeometry,
  registerAirportGeometryProvider,
  resetAirportGeometryProviders,
};

export {};
