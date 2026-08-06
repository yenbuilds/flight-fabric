'use strict';

const { createHarness } = require('../../tests/support/mini-test-harness') as {
  createHarness: () => {
    test: (name: string, fn: () => void) => void;
    assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
    assertTrue: (value: unknown, message?: string) => void;
    summary: (label: string) => void;
  };
};

const { createMsfsFacilitiesGeometryProvider } = require('./msfs-facilities-geometry-provider') as {
  createMsfsFacilitiesGeometryProvider: (bridge: Record<string, any>, options?: Record<string, any>) => Record<string, any>;
};

const { test, assertEqual, assertTrue, summary } = createHarness();

function immediateResponse(message: Record<string, any>): any {
  const fulfilled = (value: any): any => ({
    then(fn: (nextValue: any) => any) {
      return fulfilled(typeof fn === 'function' ? fn(value) : value);
    },
    catch() {
      return fulfilled(value);
    },
    finally(fn: () => void) {
      if (typeof fn === 'function') fn();
      return fulfilled(value);
    },
  });
  return {
    then(fn: (value: Record<string, any>) => void) {
      return fulfilled(fn(message));
    },
  };
}

function facilityAirportMessage(): Record<string, any> {
  return {
    type: 'facilityAirport',
    ok: true,
    icao: 'YSCB',
    airportName: 'Canberra Airport',
    airport: {
      icao: 'YSCB',
      name: 'Canberra Airport',
      elevationFt: 1886,
    },
    runways: [
      {
        icao: 'YSCB',
        runway: '35',
        airportName: 'Canberra Airport',
        source: 'msfs-facilities',
        headingTrueDeg: 359.7,
        lengthFt: 8803,
        physicalLengthFt: 10771,
        widthFt: 148,
        displacedThresholdFt: 1968,
        thresholdMappingValidated: false,
        threshold: { lat: -35.307, lon: 149.194 },
        physicalThreshold: { lat: -35.312, lon: 149.194 },
        surface: 'ASPHALT',
      },
    ],
  };
}

function staggeredParallelAirportMessage(): Record<string, any> {
  return {
    type: 'facilityAirport',
    ok: true,
    icao: 'BPAR',
    airportName: 'Staggered Parallel Field',
    airport: {
      icao: 'BPAR',
      name: 'Staggered Parallel Field',
      elevationFt: 100,
    },
    runways: [
      {
        icao: 'BPAR',
        runway: '36L',
        airportName: 'Staggered Parallel Field',
        source: 'msfs-facilities',
        headingTrueDeg: 360,
        lengthFt: 8000,
        physicalLengthFt: 8000,
        widthFt: 150,
        displacedThresholdFt: 0,
        thresholdMappingValidated: true,
        threshold: { lat: 20, lon: 40 },
        physicalThreshold: { lat: 20, lon: 40 },
        surface: 'ASPHALT',
      },
      {
        icao: 'BPAR',
        runway: '36R',
        airportName: 'Staggered Parallel Field',
        source: 'msfs-facilities',
        headingTrueDeg: 360,
        lengthFt: 8000,
        physicalLengthFt: 8000,
        widthFt: 150,
        displacedThresholdFt: 0,
        thresholdMappingValidated: true,
        threshold: { lat: 19.99, lon: 40.003 },
        physicalThreshold: { lat: 19.99, lon: 40.003 },
        surface: 'ASPHALT',
      },
    ],
  };
}

function createLogCollector(): {
  logger: { log: (message: unknown) => void; warn: (message: unknown) => void };
  info: string[];
  warnings: string[];
} {
  const info: string[] = [];
  const warnings: string[] = [];
  return {
    logger: {
      log: (message: unknown) => info.push(String(message)),
      warn: (message: unknown) => warnings.push(String(message)),
    },
    info,
    warnings,
  };
}

test('provider refreshes airport cache through sidecar request', () => {
  let requestCount = 0;
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: (icao: string) => {
      requestCount += 1;
      assertEqual(icao, 'YSCB', 'provider should normalize requested ICAO');
      return immediateResponse(facilityAirportMessage());
    },
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { requestTimeoutMs: 1000, logger: null });

  provider.prefetchAirport('yscb');

  const runway = provider.getRunway('YSCB', '35');
  assertEqual(requestCount, 1, 'provider should issue one sidecar request');
  assertEqual(runway?.source, 'msfs-facilities', 'cached runway should preserve source');
  assertEqual(runway?.heading_true_deg, 359.7, 'cached runway should expose legacy heading alias');
  assertEqual(runway?.physical_length_ft, 10771, 'cached runway should expose physical length alias');
  assertEqual(runway?.displaced_threshold_ft, 1968, 'cached runway should expose displaced threshold alias');
});

test('provider matches cached runway by position and heading', () => {
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => immediateResponse(facilityAirportMessage()),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

  provider.prefetchAirport('YSCB');

  const match = provider.findRunwayByPosition(-35.302, 149.194, 2, 360);
  assertEqual(match?.icao, 'YSCB', 'cached position lookup should return airport');
  assertEqual(match?.runway, '35', 'cached position lookup should return runway');
  assertTrue(Number.isFinite(match?.alongTrackFt), 'position lookup should include along-track distance');
  assertEqual(provider.findRunwayByPosition(-35.302, 149.194, 2, 90), null, 'heading filter should reject perpendicular runway');
  assertEqual(
    provider.findRunwayByPosition(-35.302, 169.194, 2, 360),
    null,
    'position lookup should reject a far parallel runway outside the cross-track radius',
  );
  assertEqual(
    provider.findRunwayByPosition(-35.302, 149.214, 2, 360),
    null,
    'position lookup should reject a parallel centerline about one nautical mile away',
  );
});

test('provider keeps a short touchdown on the nearest staggered-parallel centerline', () => {
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => immediateResponse(staggeredParallelAirportMessage()),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

  provider.prefetchAirport('BPAR');
  const touchdownLat = 20 - (100 / 364567);
  const match = provider.findRunwayByPosition(touchdownLat, 40, 2, 360);

  assertEqual(match?.icao, 'BPAR', 'expected staggered parallel airport match');
  assertEqual(match?.runway, '36L', 'expected the touchdown centerline rather than the offset parallel runway');
  assertTrue(match?.alongTrackFt < 0, 'expected signed pre-threshold distance on the intended runway');
});

test('failed facility requests do not count as loaded airport coverage', () => {
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => immediateResponse({
      type: 'facilityAirport',
      ok: false,
      icao: 'YBAD',
      error: 'timeout',
    }),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

  provider.prefetchAirport('YBAD');
  const stats = provider.getDatabaseStats();

  assertEqual(stats.airportCount, 0, 'failed cache entries should not count as airport coverage');
  assertEqual(stats.runwayCount, 0, 'failed cache entries should not count as runway coverage');
});

test('empty facility responses do not count as usable airport geometry', () => {
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => immediateResponse({
      type: 'facilityAirport',
      ok: true,
      icao: 'KLAX',
      airportName: 'KLAX',
      runways: [],
    }),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

  provider.prefetchAirport('KLAX');
  const diagnostics = provider.getDiagnosticSnapshot();

  assertEqual(provider.getAirport('KLAX'), null, 'empty Facilities response should not hydrate airport geometry');
  assertEqual(diagnostics.lastOutcome?.ok, false, 'empty Facilities response should be a failed outcome');
  assertEqual(diagnostics.lastOutcome?.error, 'empty_facility_response', 'empty response should preserve explicit reason');
  assertEqual(provider.getDatabaseStats().airportCount, 0, 'empty response should not count as airport coverage');
});

test('empty diagnostic probe response returns failed normalized outcome', () => {
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => immediateResponse({
      type: 'facilityAirport',
      ok: true,
      icao: 'KLAX',
      airportName: 'KLAX',
      runways: [],
    }),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });
  let outcome: Record<string, any> | null = null;

  provider.probeAirport('KLAX').then((result: Record<string, any>) => {
    outcome = result;
  });

  assertEqual(outcome?.ok, false, 'empty diagnostic probe should fail');
  assertEqual(outcome?.error, 'empty_facility_response', 'empty diagnostic probe should return explicit reason');
  assertEqual(outcome?.runwayCount, 0, 'empty diagnostic probe should include zero runway count');
});

test('provider emits basic throttled facility request and cache logs', () => {
  const { logger, info, warnings } = createLogCollector();
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => immediateResponse(facilityAirportMessage()),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, {
    logger,
    now: () => 10_000,
    logThrottleMs: 60_000,
  });

  provider.prefetchAirport('yscb');

  assertEqual(warnings.length, 0, 'successful facility request should not warn');
  assertEqual(info.length, 2, 'successful facility request should log request and cache breadcrumbs');
  assertTrue(info[0].includes('[MSFS Facilities] requesting airport geometry ICAO=YSCB'), 'request log should identify airport');
  assertTrue(info[1].includes('[MSFS Facilities] cached airport geometry ICAO=YSCB runways=1'), 'cache log should summarize runway count');
  assertTrue(info[1].includes('thresholdMapping=unvalidated(1)'), 'cache log should call out unvalidated threshold mapping');
  const diagnostics = provider.getDiagnosticSnapshot();
  assertEqual(diagnostics.requestApi, true, 'diagnostics should report request API availability');
  assertEqual(diagnostics.bridgeStatus, 'running', 'diagnostics should report bridge status');
  assertEqual(diagnostics.cacheAirportCount, 1, 'diagnostics should count cached airports with runways');
  assertEqual(diagnostics.cacheRunwayCount, 1, 'diagnostics should count cached runways');
  assertEqual(diagnostics.lastRequestIcao, 'YSCB', 'diagnostics should record last requested ICAO');
  assertEqual(diagnostics.lastOutcome?.ok, true, 'diagnostics should record successful last outcome');
});

test('diagnostic probe bypasses fresh cache while normal prefetch does not', () => {
  let requestCount = 0;
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => {
      requestCount += 1;
      return immediateResponse(facilityAirportMessage());
    },
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

  provider.prefetchAirport('YSCB');
  provider.prefetchAirport('YSCB');
  assertEqual(requestCount, 1, 'normal prefetch should use the fresh cache');

  provider.probeAirport('YSCB');
  assertEqual(requestCount, 2, 'diagnostic probe should force a new Facilities request');
});

test('diagnostic probe can use a shorter timeout than normal requests', () => {
  let timeoutMs: number | null = null;
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: (_icao: string, options?: Record<string, any>) => {
      timeoutMs = options?.timeoutMs ?? null;
      return immediateResponse(facilityAirportMessage());
    },
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { requestTimeoutMs: 4000, logger: null });

  provider.probeAirport('YSCB', { timeoutMs: 1200 });

  assertEqual(timeoutMs, 1200, 'diagnostic probe should forward its bounded timeout');
});

test('synchronous bridge request failures are contained in diagnostics', () => {
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => {
      throw new Error('sync boom');
    },
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

  provider.prefetchAirport('YBAD');
  const diagnostics = provider.getDiagnosticSnapshot();

  assertEqual(diagnostics.lastOutcome?.ok, false, 'sync failure should be captured as a failed outcome');
  assertEqual(diagnostics.lastOutcome?.error, 'sync boom', 'sync failure should preserve error text');
  assertEqual(diagnostics.pendingIcaos.length, 0, 'sync failure should clear pending state');
});

test('provider warns about facility failure without repeated fallback spam', () => {
  let nowMs = 20_000;
  const { logger, warnings } = createLogCollector();
  const bridge = {
    getSnapshot: () => ({ status: 'running' }),
    requestFacilityAirport: () => immediateResponse({
      type: 'facilityAirport',
      ok: false,
      icao: 'YBAD',
      error: 'timeout',
    }),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, {
    logger,
    now: () => nowMs,
    errorRetryMs: 1000,
    logThrottleMs: 60_000,
  });

  provider.prefetchAirport('YBAD');
  nowMs += 2_000;
  provider.prefetchAirport('YBAD');

  assertEqual(warnings.length, 1, 'same airport failure should be throttled');
  assertTrue(warnings[0].includes('[MSFS Facilities] airport request failed ICAO=YBAD error=timeout'), 'failure log should include error');
  assertTrue(warnings[0].includes('using fallback geometry'), 'failure log should make fallback explicit');
});

test('provider warns when bridge status makes Facilities unavailable', () => {
  const { logger, warnings } = createLogCollector();
  const bridge = {
    getSnapshot: () => ({ status: 'stopped', error: 'sidecar exited' }),
    requestFacilityAirport: () => immediateResponse(facilityAirportMessage()),
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, {
    logger,
    now: () => 30_000,
    logThrottleMs: 60_000,
  });

  assertEqual(provider.isAvailable(), false, 'stopped bridge should be unavailable');
  assertEqual(provider.getRunway('YSCB', '35'), null, 'unavailable provider should not return runway geometry');
  provider.isAvailable();

  assertEqual(warnings.length, 1, 'unavailable bridge warning should be throttled');
  assertTrue(
    warnings[0].includes('[MSFS Facilities] unavailable: Rust bridge status=stopped error=sidecar exited'),
    'unavailable warning should include bridge status and error',
  );
  assertTrue(warnings[0].includes('using fallback geometry'), 'unavailable warning should make fallback explicit');
});

test('provider waits for a connected bridge before requesting live facilities', () => {
  let requestCount = 0;
  const bridge = {
    getSnapshot: () => ({ status: 'disconnected', error: 'sim not ready' }),
    requestFacilityAirport: () => {
      requestCount += 1;
      return immediateResponse(facilityAirportMessage());
    },
  };
  const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

  assertEqual(provider.isAvailable(), false, 'disconnected bridge should not be treated as usable');
  provider.prefetchAirport('YSCB');
  assertEqual(requestCount, 0, 'provider should not issue facility requests while disconnected');
  assertEqual(provider.getRunway('YSCB', '35'), null, 'cold disconnected provider should still fall back through the service');
});

test('provider waits through subscription acknowledgements before requesting live facilities', () => {
  for (const status of ['simvars_updated', 'subscriptions_updated']) {
    let requestCount = 0;
    const bridge = {
      getSnapshot: () => ({ status }),
      requestFacilityAirport: () => {
        requestCount += 1;
        return immediateResponse(facilityAirportMessage());
      },
    };
    const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

    assertEqual(provider.isAvailable(), false, `${status} bridge should wait for a live SimConnect state`);
    provider.prefetchAirport('YSCB');
    assertEqual(requestCount, 0, `${status} bridge should not issue a facility request`);
  }
});

test('provider requests facilities once SimConnect is live', () => {
  for (const status of ['connected', 'running']) {
    let requestCount = 0;
    const bridge = {
      getSnapshot: () => ({ status }),
      requestFacilityAirport: () => {
        requestCount += 1;
        return immediateResponse(facilityAirportMessage());
      },
    };
    const provider = createMsfsFacilitiesGeometryProvider(bridge, { logger: null });

    assertEqual(provider.isAvailable(), true, `${status} bridge should be usable`);
    provider.prefetchAirport('YSCB');
    assertEqual(requestCount, 1, `${status} bridge should issue a facility request`);
  }
});

summary('msfs-facilities-geometry-provider tests');

export {};
