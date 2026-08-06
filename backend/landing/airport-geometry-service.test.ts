'use strict';

const { createHarness } = require('../../tests/support/mini-test-harness') as {
  createHarness: () => {
    test: (name: string, fn: () => void) => void;
    assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
    assertTrue: (value: unknown, message?: string) => void;
    summary: (label: string) => void;
  };
};

const { test, assertEqual, assertTrue, summary } = createHarness();

function withMockRunwayDatabase(mockDatabase: Record<string, any>, fn: () => void): void {
  const runwayDatabasePath = require.resolve('./runway-database');
  const previousRunwayDatabase = require.cache[runwayDatabasePath];

  require.cache[runwayDatabasePath] = {
    id: runwayDatabasePath,
    filename: runwayDatabasePath,
    loaded: true,
    exports: mockDatabase,
  } as NodeJS.Module;

  try {
    fn();
  } finally {
    delete require.cache[runwayDatabasePath];
    if (previousRunwayDatabase) require.cache[runwayDatabasePath] = previousRunwayDatabase;
  }
}

const airportGeometry = require('./airport-geometry-service') as {
  findNearbyAirport: (lat: number, lon: number, radiusNm?: number, context?: Record<string, any>) => Record<string, any> | null;
  findRunwayByPosition: (
    lat: number,
    lon: number,
    maxDistanceNm?: number,
    aircraftTrueHeadingDeg?: number | null,
    context?: Record<string, any>,
  ) => Record<string, any> | null;
  getActiveAirportGeometryProvider: (context?: Record<string, any>) => Record<string, any>;
  getAirport: (icao: string, context?: Record<string, any>) => Record<string, any> | null;
  getAirportGeometryProviderChain: (context?: Record<string, any>) => Array<Record<string, any>>;
  getDatabaseStats: (context?: Record<string, any>) => Record<string, any>;
  getRunway: (icao: string, runway: string, context?: Record<string, any>) => Record<string, any> | null;
  registerAirportGeometryProvider: (provider: Record<string, any>) => void;
  resetAirportGeometryProviders: () => void;
};

test('X-Plane/default provider remains the OurAirports adapter', () => {
  const provider = airportGeometry.getActiveAirportGeometryProvider({ simulator: 'xplane' });

  assertEqual(provider.id, 'ourairports', 'X-Plane should remain on the existing provider until an X-Plane airport source exists');
  assertEqual(provider.simulator, 'generic', 'OurAirports provider is simulator-neutral');
  assertEqual(provider.isAvailable(), true, 'OurAirports provider should be considered available when loaded');
});

test('MSFS context can prefer a registered Facilities provider', () => {
  airportGeometry.resetAirportGeometryProviders();
  try {
    airportGeometry.registerAirportGeometryProvider({
      id: 'msfs-facilities',
      simulator: 'msfs',
      isAvailable: () => true,
      getRunway: () => ({
        icao: 'YSCB',
        runway: '35',
        headingTrueDeg: 359.7,
      }),
      findRunwayByPosition: () => null,
    });

    const provider = airportGeometry.getActiveAirportGeometryProvider({ simulator: 'msfs' });
    const chain = airportGeometry.getAirportGeometryProviderChain({ simulator: 'msfs' });
    const runway = airportGeometry.getRunway('YSCB', '35', { simulator: 'msfs' });

    assertEqual(provider.id, 'msfs-facilities', 'MSFS should prefer Facilities when it is registered and available');
    assertEqual(chain.map((entry) => entry.id).join(','), 'msfs-facilities,ourairports', 'OurAirports should remain the MSFS fallback');
    assertEqual(runway?.source, 'msfs-facilities', 'runway result should preserve preferred provider source');
    assertEqual(runway?.heading_true_deg, 359.7, 'runway result should backfill legacy heading field from Facilities shape');
    assertEqual(runway?.runway_geometry_provider_chain, 'msfs-facilities:hit', 'Facilities hit should be visible in runway diagnostics');
    assertEqual(runway?.runway_geometry_fallback_reason, null, 'Facilities hit should not report a fallback reason');
  } finally {
    airportGeometry.resetAirportGeometryProviders();
  }
});

test('Rust SimVars data source is treated as live MSFS for Facilities geometry', () => {
  airportGeometry.resetAirportGeometryProviders();
  try {
    airportGeometry.registerAirportGeometryProvider({
      id: 'msfs-facilities',
      simulator: 'msfs',
      isAvailable: () => true,
      getRunway: () => ({
        icao: 'KSEA',
        runway: '34L',
        headingTrueDeg: 344.8,
      }),
      findRunwayByPosition: () => null,
    });

    const provider = airportGeometry.getActiveAirportGeometryProvider({ dataSource: 'rust-simvars' });
    const chain = airportGeometry.getAirportGeometryProviderChain({ dataSource: 'rust-simvars' });
    const runway = airportGeometry.getRunway('KSEA', '34L', { dataSource: 'rust-simvars' });

    assertEqual(provider.id, 'msfs-facilities', 'Rust SimVars should select the live MSFS Facilities provider');
    assertEqual(chain.map((entry) => entry.id).join(','), 'msfs-facilities,ourairports', 'Rust SimVars should keep OurAirports as fallback');
    assertEqual(runway?.source, 'msfs-facilities', 'runway lookup should use Facilities for Rust SimVars');
  } finally {
    airportGeometry.resetAirportGeometryProviders();
  }
});

test('MSFS provider falls back to OurAirports when Facilities has no match', () => {
  airportGeometry.resetAirportGeometryProviders();
  try {
    airportGeometry.registerAirportGeometryProvider({
      id: 'msfs-facilities',
      simulator: 'msfs',
      isAvailable: () => true,
      getAirport: () => null,
      getDatabaseStats: () => ({ airportCount: 0, runwayCount: 0, loadError: 'Facilities cache empty' }),
      getRunway: () => null,
      findRunwayByPosition: () => null,
      findNearbyAirport: () => null,
    });

    withMockRunwayDatabase({
      getAirport: () => ({ name: 'Canberra Airport', source: 'ourairports-fixture' }),
      getDatabaseStats: () => ({ airportCount: 1, runwayCount: 2, loadError: null }),
      getRunway: () => ({
        icao: 'YSCB',
        runway: '35',
        heading_true_deg: 360,
      }),
      findRunwayByPosition: () => ({
        icao: 'YSCB',
        runway: '35',
        heading_true_deg: 360,
      }),
      findNearbyAirport: () => ({ icao: 'YSCB', name: 'Canberra Airport' }),
    }, () => {
      const context = { simulator: 'msfs' };
      const airport = airportGeometry.getAirport('YSCB', context);
      const byId = airportGeometry.getRunway('YSCB', '35', context);
      const byPosition = airportGeometry.findRunwayByPosition(-35.31, 149.19, 2, 360, context);
      const nearby = airportGeometry.findNearbyAirport(-35.31, 149.19, 5, context);
      const stats = airportGeometry.getDatabaseStats(context);

      assertEqual(airport?.name, 'Canberra Airport', 'airport lookup should fall back');
      assertEqual(byId?.source, 'ourairports', 'runway lookup should fall back');
      assertEqual(byId?.runway_geometry_provider_chain, 'msfs-facilities:miss,ourairports:hit', 'runway lookup should record provider chain');
      assertEqual(byId?.runway_geometry_fallback_reason, 'msfs-facilities:miss', 'runway lookup should record fallback reason');
      assertEqual(byPosition?.source, 'ourairports', 'position lookup should fall back');
      assertEqual(byPosition?.runway_geometry_provider_chain, 'msfs-facilities:miss,ourairports:hit', 'position lookup should record provider chain');
      assertEqual(byPosition?.runway_geometry_fallback_reason, 'msfs-facilities:miss', 'position lookup should record fallback reason');
      assertEqual(nearby?.icao, 'YSCB', 'nearby airport lookup should fall back');
      assertEqual(stats.airportCount, 1, 'stats should fall back to the populated provider');
    });
  } finally {
    airportGeometry.resetAirportGeometryProviders();
  }
});

test('MSFS fallback result warms Facilities provider by airport ICAO', () => {
  airportGeometry.resetAirportGeometryProviders();
  let prefetchedIcao: string | null = null;
  try {
    airportGeometry.registerAirportGeometryProvider({
      id: 'msfs-facilities',
      simulator: 'msfs',
      isAvailable: () => true,
      prefetchAirport: (icao: string) => {
        prefetchedIcao = icao;
      },
      getRunway: () => null,
      findRunwayByPosition: () => null,
    });

    withMockRunwayDatabase({
      getRunway: () => ({
        icao: 'YSCB',
        runway: '35',
        heading_true_deg: 360,
      }),
      findRunwayByPosition: () => ({
        icao: 'YSCB',
        runway: '35',
        heading_true_deg: 360,
      }),
    }, () => {
      const runway = airportGeometry.getRunway('YSCB', '35', { simulator: 'msfs' });

      assertEqual(runway?.source, 'ourairports', 'cold Facilities cache should still fall back');
      assertEqual(prefetchedIcao, 'YSCB', 'fallback runway should warm the preferred provider cache');
    });
  } finally {
    airportGeometry.resetAirportGeometryProviders();
  }
});

test('MSFS runway fallback records when Facilities provider is not registered', () => {
  airportGeometry.resetAirportGeometryProviders();
  try {
    withMockRunwayDatabase({
      getRunway: () => ({
        icao: 'YSCB',
        runway: '35',
        heading_true_deg: 360,
      }),
      findRunwayByPosition: () => ({
        icao: 'YSCB',
        runway: '35',
        heading_true_deg: 360,
      }),
    }, () => {
      const runway = airportGeometry.getRunway('YSCB', '35', { simulator: 'msfs' });

      assertEqual(runway?.source, 'ourairports', 'unregistered Facilities should fall back');
      assertEqual(runway?.runway_geometry_provider_chain, 'msfs-facilities:unavailable,ourairports:hit', 'fallback should record unavailable Facilities');
      assertEqual(runway?.runway_geometry_fallback_reason, 'msfs-facilities:unavailable:not_registered', 'fallback should record missing provider reason');
    });
  } finally {
    airportGeometry.resetAirportGeometryProviders();
  }
});

test('unavailable MSFS provider is skipped before fallback', () => {
  airportGeometry.resetAirportGeometryProviders();
  try {
    airportGeometry.registerAirportGeometryProvider({
      id: 'msfs-facilities',
      simulator: 'msfs',
      isAvailable: () => false,
      getRunway: () => ({ source: 'should-not-be-used' }),
      findRunwayByPosition: () => ({ source: 'should-not-be-used' }),
    });

    const provider = airportGeometry.getActiveAirportGeometryProvider({ simulator: 'msfs' });
    const chain = airportGeometry.getAirportGeometryProviderChain({ simulator: 'msfs' });

    assertEqual(provider.id, 'ourairports', 'unavailable Facilities provider should not become active');
    assertEqual(chain.map((entry) => entry.id).join(','), 'ourairports', 'unavailable Facilities provider should be omitted from the chain');
  } finally {
    airportGeometry.resetAirportGeometryProviders();
  }
});

test('runway geometry calls delegate to runway-database and annotate source', () => {
  withMockRunwayDatabase({
    getRunway: () => ({
      icao: 'YSCB',
      runway: '35',
      threshold: { lat: -35.314, lon: 149.194 },
      heading_true_deg: 360,
      lengthFt: 8803,
    }),
    findRunwayByPosition: () => ({
      icao: 'YSCB',
      runway: '35',
      threshold: { lat: -35.314, lon: 149.194 },
      heading: 360,
      lengthFt: 8803,
      distanceFromThreshold: 0.25,
    }),
  }, () => {
    const byId = airportGeometry.getRunway('YSCB', '35');
    const byPosition = airportGeometry.findRunwayByPosition(-35.31, 149.19, 2, 360);

    assertEqual(byId?.source, 'ourairports', 'getRunway should expose provider source');
    assertEqual(byId?.headingTrueDeg, 360, 'getRunway should expose normalized heading alias');
    assertEqual(byPosition?.source, 'ourairports', 'position lookup should expose provider source');
    assertEqual(byPosition?.heading_true_deg, 360, 'position lookup should backfill legacy true-heading field');
  });
});

test('airport lookup and stats stay available through the service', () => {
  withMockRunwayDatabase({
    getAirport: () => ({ name: 'Canberra Airport', elevation_ft: 1886 }),
    getDatabaseStats: () => ({ airportCount: 1, runwayCount: 2, loadError: null }),
    findNearbyAirport: () => ({ icao: 'YSCB', name: 'Canberra Airport', distanceNm: 1 }),
  }, () => {
    const airport = airportGeometry.getAirport('YSCB');
    const stats = airportGeometry.getDatabaseStats();
    const nearby = airportGeometry.findNearbyAirport(-35.31, 149.19, 5);

    assertEqual(airport?.name, 'Canberra Airport', 'airport lookup should delegate');
    assertEqual(stats.airportCount, 1, 'stats should delegate');
    assertEqual(nearby?.icao, 'YSCB', 'nearby airport lookup should delegate');
  });
});

test('missing runway-database functions fail closed', () => {
  withMockRunwayDatabase({}, () => {
    assertEqual(airportGeometry.getAirport('YSCB'), null, 'missing getAirport should return null');
    assertEqual(airportGeometry.getRunway('YSCB', '35'), null, 'missing getRunway should return null');
    assertEqual(airportGeometry.findRunwayByPosition(-35.31, 149.19), null, 'missing position lookup should return null');
    assertTrue(
      airportGeometry.getDatabaseStats().airportCount === 0,
      'missing stats should return unavailable stats',
    );
  });
});

summary('airport-geometry-service tests');

export {};
