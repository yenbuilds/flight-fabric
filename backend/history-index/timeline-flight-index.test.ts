const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BACKEND_RUNTIME_ROOT = path.resolve(__dirname, '..');
const {
  loadNodeSqlite,
} = require('./sqlite-runtime.js');
const {
  openHistoryIndexStore,
} = require('./history-index-store.js');
const {
  normalizeTimelineFlightForIndex,
  queryIndexedTimelineFlights,
  queryTimelineFlightsPage,
  refreshTimelineFlightsIndex,
} = require('./timeline-flight-index.js');

function skipIfNoSqlite(t) {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return true;
  }
  return false;
}

function withTempStore(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-timeline-flight-index-'));
  const opened = openHistoryIndexStore({ dbPath: path.join(tmpRoot, 'history.sqlite') });
  try {
    assert.equal(opened.success, true, opened.error);
    fn(opened.store, tmpRoot);
  } finally {
    if (opened.success) opened.store.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function clearBackendModule(relativePath) {
  const modulePath = path.join(BACKEND_RUNTIME_ROOT, relativePath);
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function clearTimelineModules() {
  [
    path.join('events', 'timeline-generator.js'),
    path.join('events', 'timeline-events.js'),
    path.join('utils', 'flight-logs-dir.js'),
    path.join('utils', 'storage-paths.js'),
  ].forEach(clearBackendModule);
}

async function withTempFlightLogs(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-timeline-flight-index-parity-'));
  const previous = {
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OneDrive: process.env.OneDrive,
    ONEDRIVE: process.env.ONEDRIVE,
    OneDriveConsumer: process.env.OneDriveConsumer,
    OneDriveCommercial: process.env.OneDriveCommercial,
    FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS,
  };

  process.env.APPDATA = path.join(tmpRoot, 'AppData', 'Roaming');
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  process.env.XDG_CONFIG_HOME = path.join(tmpRoot, '.config');
  process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = '1';
  delete process.env.OneDrive;
  delete process.env.ONEDRIVE;
  delete process.env.OneDriveConsumer;
  delete process.env.OneDriveCommercial;
  clearTimelineModules();

  try {
    await fn(tmpRoot);
  } finally {
    if (previous.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous.APPDATA;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    if (previous.OneDrive === undefined) delete process.env.OneDrive; else process.env.OneDrive = previous.OneDrive;
    if (previous.ONEDRIVE === undefined) delete process.env.ONEDRIVE; else process.env.ONEDRIVE = previous.ONEDRIVE;
    if (previous.OneDriveConsumer === undefined) delete process.env.OneDriveConsumer; else process.env.OneDriveConsumer = previous.OneDriveConsumer;
    if (previous.OneDriveCommercial === undefined) delete process.env.OneDriveCommercial; else process.env.OneDriveCommercial = previous.OneDriveCommercial;
    if (previous.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS === undefined) delete process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS; else process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = previous.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS;
    clearTimelineModules();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function writeTimelineListCsv(filePath, options: Record<string, any> = {}) {
  const sampleCount = options.sampleCount || 6;
  const startMs = Date.parse(options.startIso || '2026-07-09T00:00:00.000Z');
  const aircraft = options.aircraft || 'Parity Test 737';
  const lat = Number.isFinite(options.lat) ? options.lat : 47.45;
  const lon = Number.isFinite(options.lon) ? options.lon : -122.31;
  const rows = [
    'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase,aircraft,flight_id,fuel_total_gal',
  ];

  for (let index = 0; index < sampleCount; index += 1) {
    const ts = startMs + index * 1000;
    rows.push([
      'SAMPLE',
      new Date(ts).toISOString(),
      ts,
      (lat + index * 0.01).toFixed(5),
      (lon + index * 0.01).toFixed(5),
      140 + index,
      -500 + index,
      1500 - index * 100,
      0,
      index < sampleCount - 1 ? 'APPROACH' : 'TAXI_IN',
      aircraft,
      options.flightId || path.basename(filePath, path.extname(filePath)),
      1000 - index * 5,
    ].join(','));
  }

  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
  const mtime = new Date(startMs + sampleCount * 1000);
  fs.utimesSync(filePath, mtime, mtime);
}

function canonicalTimelineCsv(logsDir: string, bundleName: string): string {
  const bundleDir = path.join(logsDir, bundleName);
  fs.mkdirSync(bundleDir, { recursive: true });
  return path.join(bundleDir, 'telemetry.csv');
}

function flight(tmpRoot, name, overrides: Record<string, any> = {}) {
  const timestamp = overrides.timestamp || '2026-07-09T00:00:00.000Z';
  return {
    filePath: path.join(tmpRoot, `${name}.csv`),
    flightId: name,
    timestamp,
    mtimeMs: new Date(timestamp).getTime(),
    sizeBytes: 4096,
    route: 'EGLL -> LFPG',
    displayRouteLabel: 'EGLL -> LFPG',
    departureAirport: { icao: 'EGLL', name: 'Heathrow' },
    arrivalAirport: { icao: 'LFPG', name: 'Charles de Gaulle' },
    durationFormatted: '1h 20m',
    aircraft: '737-800',
    sampleCount: 1200,
    eventCount: 1200,
    fuelBurnGal: 950,
    fuelBurnSource: 'csv',
    ...overrides,
  };
}

test('timeline flight index normalizes existing list rows for SQLite', (t) => {
  if (skipIfNoSqlite(t)) return;

  const row = flight(process.cwd(), 'flight-a');
  const normalized = normalizeTimelineFlightForIndex(row);
  assert.equal(normalized.source.filePath, row.filePath);
  assert.equal(normalized.source.mtimeMs, row.mtimeMs);
  assert.equal(normalized.source.sizeBytes, row.sizeBytes);
  assert.equal(normalized.flights[0].flightId, 'flight-a');
  assert.equal(normalized.flights[0].departureIcao, 'EGLL');
  assert.equal(normalized.flights[0].arrivalIcao, 'LFPG');
  assert.equal(normalized.flights[0].payload.displayRouteLabel, 'EGLL -> LFPG');
});

test('timeline flight index keeps bundle catalog identity separate from CSV delete identity', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const row: Record<string, any> = flight(tmpRoot, 'bundle-identity', {
      mtimeMs: 1_720_000_000_000,
      sizeBytes: 12_000,
      csvMtimeMs: 1_719_999_999_500,
      csvSizeBytes: 10_000,
      recordingBundleCatalogRevision: 123_456_789,
      recordingBundleSizeBytes: 12_000,
    });
    const normalized = normalizeTimelineFlightForIndex(row);
    assert.equal(normalized.source.mtimeMs, row.recordingBundleCatalogRevision);
    assert.equal(normalized.source.sizeBytes, row.recordingBundleSizeBytes);
    assert.equal(normalized.flights[0].payload.csvMtimeMs, row.csvMtimeMs);
    assert.equal(normalized.flights[0].payload.csvSizeBytes, row.csvSizeBytes);

    refreshTimelineFlightsIndex(store, [row]);
    const indexed = queryIndexedTimelineFlights(store, { limit: 10 }).flights[0];
    assert.equal(indexed.sizeBytes, row.sizeBytes);
    assert.equal(indexed.mtimeMs, row.csvMtimeMs);
    assert.equal(indexed.csvSizeBytes, row.csvSizeBytes);
    assert.equal(indexed.csvMtimeMs, row.csvMtimeMs);
    assert.equal(indexed.timestamp, row.timestamp);
  });
});

test('timeline flight index normalizes zero fuel burn as unknown', (t) => {
  if (skipIfNoSqlite(t)) return;

  const row = flight(process.cwd(), 'zero-fuel', {
    fuelBurnGal: 0,
    fuelBurnSource: 'fuel_total_gal',
  });
  const normalized = normalizeTimelineFlightForIndex(row);
  assert.equal(normalized.flights[0].fuelBurnGal, null);
  assert.equal(normalized.flights[0].fuelBurnSource, null);
});

test('timeline flight index hides previously indexed zero fuel burn rows', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const row = flight(tmpRoot, 'cached-zero-fuel', {
      fuelBurnGal: 0,
      fuelBurnSource: 'fuel_total_gal',
    });
    store.replaceSourceIndex({
      source: {
        filePath: row.filePath,
        mtimeMs: row.mtimeMs,
        sizeBytes: row.sizeBytes,
      },
      flights: [row],
      landings: [],
    });

    const page = queryIndexedTimelineFlights(store, { limit: 10 });
    assert.equal(page.flights.length, 1);
    assert.equal(page.flights[0].fuelBurnGal, null);
    assert.equal(page.flights[0].fuelBurnSource, null);
  });
});

test('timeline flight index refreshes and queries preserved list payloads', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const rows = [
      flight(tmpRoot, 'older', {
        timestamp: '2026-07-08T00:00:00.000Z',
        aircraft: '737-800',
        fuelBurnGal: 800,
      }),
      flight(tmpRoot, 'newer', {
        timestamp: '2026-07-09T00:00:00.000Z',
        route: 'KSEA -> KSFO',
        displayRouteLabel: 'KSEA -> KSFO',
        departureAirport: { icao: 'KSEA', name: 'Seattle Tacoma' },
        arrivalAirport: { icao: 'KSFO', name: 'San Francisco' },
        aircraft: 'A320',
        fuelBurnGal: 600,
      }),
    ];

    const refresh = refreshTimelineFlightsIndex(store, rows);
    assert.deepEqual(refresh, { indexed: 2, skipped: 0, sourcesPruned: 0, flightsPruned: 0, totalInput: 2 });

    const recent = queryIndexedTimelineFlights(store, { limit: 10 });
    assert.deepEqual(recent.flights.map((item) => item.flightId), ['newer', 'older']);
    assert.equal(recent.flights[0].filePath, rows[1].filePath);
    assert.deepEqual(recent.flights[0].departureAirport, rows[1].departureAirport);
    assert.equal(recent.flights[0].displayRouteLabel, 'KSEA -> KSFO');
    assert.equal(recent.flights[0].timestamp, rows[1].timestamp);

    const filtered = queryIndexedTimelineFlights(store, { routeFilter: 'LFPG', aircraftFilter: '737' });
    assert.deepEqual(filtered.flights.map((item) => item.flightId), ['older']);

    const fuel = queryIndexedTimelineFlights(store, { sort: 'fuel_burn_desc' });
    assert.deepEqual(fuel.flights.map((item) => item.flightId), ['older', 'newer']);
  });
});

test('timeline flight index annotates flights with latest indexed landing payloads', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const row = flight(tmpRoot, 'landed', {
      timestamp: '2026-07-09T00:00:00.000Z',
    });
    store.replaceSourceIndex({
      source: {
        filePath: row.filePath,
        mtimeMs: row.mtimeMs,
        sizeBytes: row.sizeBytes,
      },
      flights: [row],
      landings: [{
        landingId: 'landing-ready',
        flightId: row.flightId,
        timestampMs: row.mtimeMs + 1000,
        timestamp: '2026-07-09T00:00:01.000Z',
        aircraft: row.aircraft,
        icao: 'LFPG',
        runway: '27R',
        vsFpm: -210,
        grade: 'Good',
        payload: {
          id: 'landing-ready',
          grade: 'GOOD',
          vsFpm: -349,
          touchdownDistanceFt: 129,
          touchdownDistanceGrade: 'Outstanding',
          touchdownDistanceScore: 98,
          touchdownDistanceZone: 'Ideal TDZ',
          bounceCount: 1,
          bounceGrade: 'Single Bounce',
          bounceScore: 72,
          stabilityScore: 38,
          gateStable: false,
          stabilityGateFailures: ['speed_unstable_after_gate'],
        },
      }],
    });

    const page = queryIndexedTimelineFlights(store, { limit: 10 });
    assert.equal(page.flights.length, 1);
    assert.equal(page.flights[0].latestLandingEvent.id, 'landing-ready');
    assert.equal(page.flights[0].latestLandingEvent.type, 'landing');
    assert.equal(page.flights[0].latestLandingEvent.vs_fpm, -349);
    assert.equal(page.flights[0].latestLandingEvent.grade, 'GOOD');
    assert.equal(page.flights[0].latestLandingEvent.touchdownDistance.distanceFt, 129);
    assert.equal(page.flights[0].latestLandingEvent.touchdownDistance.zone, 'Ideal TDZ');
    assert.equal(page.flights[0].latestLandingEvent.touchdownDistance.bounceCount, 1);
    assert.equal(page.flights[0].latestLandingEvent.touchdownDistance.bounceScore, 72);
    assert.equal(page.flights[0].latestLandingEvent.ultimateStability.score, 38);
    assert.equal(page.flights[0].latestLandingEvent.ultimateStability.gateStable, false);
  });
});

test('timeline flight index first-run refresh handles a large list with bounded pages', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const rows = Array.from({ length: 1500 }, (_, index) => flight(tmpRoot, `flight-${index}`, {
      timestamp: new Date(Date.parse('2026-07-09T00:00:00.000Z') + index * 60000).toISOString(),
      aircraft: index % 2 === 0 ? 'Bulk Alpha' : 'Bulk Bravo',
      route: index % 5 === 0 ? 'KSEA -> KSFO' : 'EGLL -> LFPG',
      displayRouteLabel: index % 5 === 0 ? 'KSEA -> KSFO' : 'EGLL -> LFPG',
      departureAirport: { icao: index % 5 === 0 ? 'KSEA' : 'EGLL' },
      arrivalAirport: { icao: index % 5 === 0 ? 'KSFO' : 'LFPG' },
      fuelBurnGal: 1000 - index,
    }));

    const firstRefresh = refreshTimelineFlightsIndex(store, rows);
    assert.deepEqual(firstRefresh, { indexed: 1500, skipped: 0, sourcesPruned: 0, flightsPruned: 0, totalInput: 1500 });

    const firstPage = queryIndexedTimelineFlights(store, { limit: 150 });
    assert.equal(firstPage.flights.length, 150);
    assert.equal(firstPage.totalMatching, 1500);
    assert.equal(firstPage.flights[0].flightId, 'flight-1499');

    const secondPage = queryIndexedTimelineFlights(store, { limit: 150, offset: 150 });
    assert.equal(secondPage.flights.length, 150);
    assert.equal(secondPage.flights[0].flightId, 'flight-1349');

    const filtered = queryIndexedTimelineFlights(store, { routeFilter: 'KSFO', aircraftFilter: 'Alpha', limit: 50 });
    assert.equal(filtered.flights.length, 50);
    assert.equal(filtered.totalMatching, 150);

    const secondRefresh = refreshTimelineFlightsIndex(store, rows);
    assert.deepEqual(secondRefresh, { indexed: 0, skipped: 1500, sourcesPruned: 0, flightsPruned: 0, totalInput: 1500 });
  });
});

test('timeline flight index pages raw flight rows for non-SQLite fallback', () => {
  const tmpRoot = process.cwd();
  const rows = [
    flight(tmpRoot, 'older-alpha', {
      timestamp: '2026-07-07T00:00:00.000Z',
      aircraft: 'Fallback Alpha',
      fuelBurnGal: 900,
    }),
    flight(tmpRoot, 'newer-bravo', {
      timestamp: '2026-07-09T00:00:00.000Z',
      aircraft: 'Fallback Bravo',
      route: 'KSEA -> KSFO',
      displayRouteLabel: 'KSEA -> KSFO',
      departureAirport: { icao: 'KSEA', name: 'Seattle Tacoma' },
      arrivalAirport: { icao: 'KSFO', name: 'San Francisco' },
      fuelBurnGal: 500,
    }),
    flight(tmpRoot, 'middle-alpha', {
      timestamp: '2026-07-08T00:00:00.000Z',
      aircraft: 'Fallback Alpha',
      route: 'YSSY -> YMML',
      displayRouteLabel: 'YSSY -> YMML',
      departureAirport: { icao: 'YSSY', name: 'Sydney' },
      arrivalAirport: { icao: 'YMML', name: 'Melbourne' },
      fuelBurnGal: 700,
    }),
  ];

  const filtered = queryTimelineFlightsPage(rows, { aircraftFilter: 'alpha', limit: 1 });
  assert.equal(filtered.totalMatching, 2);
  assert.equal(filtered.limit, 1);
  assert.equal(filtered.offset, 0);
  assert.deepEqual(filtered.flights.map((item) => item.flightId), ['middle-alpha']);

  const route = queryTimelineFlightsPage(rows, { routeFilter: 'KSFO', limit: 10 });
  assert.deepEqual(route.flights.map((item) => item.flightId), ['newer-bravo']);

  const fuel = queryTimelineFlightsPage(rows, { sort: 'fuel_burn_desc', limit: 10 });
  assert.deepEqual(fuel.flights.map((item) => item.flightId), ['older-alpha', 'middle-alpha', 'newer-bravo']);
});

test('timeline flight index skips unchanged source rows while keeping them prune-safe', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const keep = flight(tmpRoot, 'keep', {
      timestamp: '2026-07-09T00:00:00.000Z',
      sizeBytes: 4096,
    });
    const change = flight(tmpRoot, 'change', {
      timestamp: '2026-07-08T00:00:00.000Z',
      sizeBytes: 2048,
    });

    const firstRefresh = refreshTimelineFlightsIndex(store, [keep, change]);
    assert.deepEqual(firstRefresh, { indexed: 2, skipped: 0, sourcesPruned: 0, flightsPruned: 0, totalInput: 2 });
    const firstKeepIndexedAt = store.getSourceByPath(keep.filePath).indexedAtMs;

    const secondRefresh = refreshTimelineFlightsIndex(store, [
      keep,
      {
        ...change,
        timestamp: '2026-07-10T00:00:00.000Z',
        mtimeMs: Date.parse('2026-07-10T00:00:00.000Z'),
        route: 'KSEA -> KSFO',
        displayRouteLabel: 'KSEA -> KSFO',
      },
    ]);

    assert.deepEqual(secondRefresh, { indexed: 1, skipped: 1, sourcesPruned: 0, flightsPruned: 0, totalInput: 2 });
    assert.equal(store.getSourceByPath(keep.filePath).indexedAtMs, firstKeepIndexedAt);
    assert.deepEqual(
      queryIndexedTimelineFlights(store, { sort: 'route' }).flights.map((item) => item.displayRouteLabel),
      ['EGLL -> LFPG', 'KSEA -> KSFO'],
    );
    assert.deepEqual(store.getCounts(), { sources: 2, flights: 2, landings: 0 });
  });
});

test('timeline flight index prunes flights missing from the current list', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const keep = flight(tmpRoot, 'keep');
    const remove = flight(tmpRoot, 'remove');
    refreshTimelineFlightsIndex(store, [keep, remove]);
    assert.deepEqual(store.getCounts(), { sources: 2, flights: 2, landings: 0 });

    const refresh = refreshTimelineFlightsIndex(store, [keep]);
    assert.equal(refresh.sourcesPruned, 1);
    assert.equal(refresh.flightsPruned, 1);
    assert.deepEqual(store.getCounts(), { sources: 1, flights: 1, landings: 0 });
    assert.deepEqual(queryIndexedTimelineFlights(store, {}).flights.map((item) => item.flightId), ['keep']);
  });
});

test('timeline flight index preserves current listCSVFlights output shape', async (t) => {
  if (skipIfNoSqlite(t)) return;

  await withTempFlightLogs(async () => {
    const timelineGenerator = require(path.join(BACKEND_RUNTIME_ROOT, 'events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    writeTimelineListCsv(canonicalTimelineCsv(logsDir, '2026-07-09T00-00-00_alpha'), {
      aircraft: 'Parity Test A',
      flightId: 'alpha',
      startIso: '2026-07-09T00:00:00.000Z',
    });
    writeTimelineListCsv(canonicalTimelineCsv(logsDir, '2026-07-10T00-00-00_bravo'), {
      aircraft: 'Parity Test B',
      flightId: 'bravo',
      startIso: '2026-07-10T00:00:00.000Z',
    });

    const currentRows = timelineGenerator.listCSVFlights();
    assert.equal(currentRows.length, 2);

    withTempStore((store) => {
      refreshTimelineFlightsIndex(store, currentRows);
      const indexedRows = queryIndexedTimelineFlights(store, { limit: 10 }).flights;
      assert.equal(indexedRows.length, currentRows.length);

      for (let index = 0; index < currentRows.length; index += 1) {
        const current = currentRows[index];
        const indexed = indexedRows[index];
        assert.equal(indexed.filePath, current.filePath);
        assert.equal(indexed.flightId, current.flightId);
        assert.equal(indexed.aircraft, current.aircraft);
        assert.equal(indexed.displayRouteLabel, current.displayRouteLabel);
        assert.equal(indexed.durationFormatted, current.durationFormatted);
        assert.equal(indexed.sampleCount, current.sampleCount);
        assert.equal(indexed.eventCount, current.eventCount);
        assert.equal(indexed.sizeBytes, current.sizeBytes);
        assert.equal(indexed.mtimeMs, current.mtimeMs);
        assert.equal(new Date(indexed.timestamp).getTime(), current.timestamp.getTime());
        assert.deepEqual(indexed.departureAirport, current.departureAirport);
        assert.deepEqual(indexed.arrivalAirport, current.arrivalAirport);
        assert.deepEqual(indexed.departureNearbyAirport, current.departureNearbyAirport);
        assert.deepEqual(indexed.arrivalNearbyAirport, current.arrivalNearbyAirport);
      }
    });
  });
});
