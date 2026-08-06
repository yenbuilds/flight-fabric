const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadNodeSqlite,
} = require('./sqlite-runtime.js');
const {
  assertHistoryIndexIntegrity,
  openHistoryIndexStore,
} = require('./history-index-store.js');
const {
  landingToIndexInput,
} = require('./logbook-landing-index.js');

function withTempStore(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-store-'));
  const dbPath = path.join(tmpRoot, 'history.sqlite');
  try {
    const opened = openHistoryIndexStore({ dbPath });
    assert.equal(opened.success, true, opened.error);
    try {
      fn(opened.store, tmpRoot);
    } finally {
      opened.store.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function skipIfNoSqlite(t) {
  const probe = loadNodeSqlite();
  if (!probe.available) {
    t.skip(`node:sqlite unavailable in this runtime: ${probe.error}`);
    return true;
  }
  return false;
}

function sourcePath(tmpRoot, name) {
  return path.join(tmpRoot, name);
}

test('history index integrity check fails closed on a non-ok SQLite result', () => {
  const db = {
    prepare(sql) {
      assert.equal(sql, 'PRAGMA quick_check(1)');
      return { all: () => [{ quick_check: 'database disk image is malformed' }] };
    },
  };
  assert.throws(() => assertHistoryIndexIntegrity(db), /SQLITE_CORRUPT.*malformed/);
});

test('logbook landing index scopes repeated display ids to their CSV source', () => {
  const landing = {
    id: 'repeated-landing-id',
    timestampMs: 1000,
    timestamp: '2026-07-09T00:00:01.000Z',
  };
  const first = landingToIndexInput(landing, {
    filePath: 'C:/Flight Logs/first.csv',
    mtimeMs: 10,
    sizeBytes: 100,
  });
  const second = landingToIndexInput(landing, {
    filePath: 'C:/Flight Logs/second.csv',
    mtimeMs: 20,
    sizeBytes: 200,
  });
  assert.notEqual(first.landingId, second.landingId);
  assert.equal(first.payload.id, 'repeated-landing-id');
  assert.equal(second.payload.id, 'repeated-landing-id');
});

test('history index store replaces one source transactionally', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const filePath = sourcePath(tmpRoot, 'flight-a.csv');
    const first = store.replaceSourceIndex({
      source: { filePath, mtimeMs: 100, sizeBytes: 1000 },
      flights: [{
        flightId: 'flight-a',
        startedAtMs: 1000,
        endedAtMs: 2000,
        aircraft: '737-800',
        departureIcao: 'EGLL',
        arrivalIcao: 'LFPG',
        routeLabel: 'EGLL -> LFPG',
        displayRouteLabel: 'EGLL -> LFPG',
        sampleCount: 1200,
      }],
      landings: [{
        landingId: 'landing-a',
        flightId: 'flight-a',
        timestampMs: 2000,
        timestamp: '2026-07-09T00:00:02.000Z',
        aircraft: '737-800',
        icao: 'LFPG',
        runway: '27R',
        vsFpm: -210,
        grade: 'Good',
        outcomeGrade: 'Good',
        gateStable: true,
        stabilityGateFailures: [],
        payload: { id: 'landing-a', grade: 'Good' },
      }],
    });

    assert.equal(first.flightsIndexed, 1);
    assert.equal(first.landingsIndexed, 1);
    assert.deepEqual(store.getCounts(), { sources: 1, flights: 1, landings: 1 });

    const source = store.getSourceByPath(filePath);
    assert.equal(source.csvBasename, 'flight-a.csv');
    assert.equal(source.mtimeMs, 100);

    const flights = store.queryFlights({ limit: 10 });
    assert.equal(flights.totalMatching, 1);
    assert.equal(flights.flights[0].flightId, 'flight-a');
    assert.equal(flights.flights[0].arrivalIcao, 'LFPG');

    const landings = store.queryLandings({ limit: 10 });
    assert.equal(landings.totalMatching, 1);
    assert.equal(landings.landings[0].landingId, 'landing-a');
    assert.equal(landings.landings[0].gateStable, true);
    assert.deepEqual(landings.landings[0].payload, { id: 'landing-a', grade: 'Good' });
    const latestLanding = store.queryLatestLandingForSource(landings.landings[0].sourceId);
    assert.equal(latestLanding.landingId, 'landing-a');
    assert.deepEqual(latestLanding.payload, { id: 'landing-a', grade: 'Good' });

    store.replaceSourceIndex({
      source: { filePath, mtimeMs: 101, sizeBytes: 1001 },
      flights: [{
        flightId: 'flight-a2',
        startedAtMs: 3000,
        aircraft: 'A320',
        departureIcao: 'LFPG',
        arrivalIcao: 'EGLL',
      }],
      landings: [],
    });

    assert.deepEqual(store.getCounts(), { sources: 1, flights: 1, landings: 0 });
    assert.equal(store.queryFlights({ limit: 10 }).flights[0].flightId, 'flight-a2');
  });
});

test('history index reads retire saved spoiler penalties without rewriting the source', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    store.replaceSourceIndex({
      source: { filePath: sourcePath(tmpRoot, 'legacy-spoiler.csv'), mtimeMs: 100, sizeBytes: 1000 },
      landings: [{
        landingId: 'legacy-spoiler-landing',
        timestampMs: 2000,
        timestamp: '2026-07-30T01:51:46.468Z',
        gateStable: false,
        stabilityScore: 75,
        stabilityGateFailures: ['spoilers_moved_after_gate', 'glidepath_proxy_unstable_after_gate'],
        payload: {
          id: 'legacy-spoiler-landing',
          gateStable: false,
          stabilityScore: 75,
          stabilityGateFailures: ['spoilers_moved_after_gate', 'glidepath_proxy_unstable_after_gate'],
          stabilityBreakdown: {
            config_ok: 0,
            gear_ok: 100,
            flaps_ok: 100,
            spoilers_ok: 0,
            speed_ok: 85,
            speed_trend_ok: 86,
            vs_ok: 96,
            glidepath_ok: 51,
            thrust_ok: 81,
            pitch_ok: 100,
            bank_ok: 100,
            lateral_offset_ok: 100,
          },
        },
      }],
    });

    const landing = store.queryLandings({ limit: 10 }).landings[0];
    assert.equal(landing.stabilityScore, 89);
    assert.equal(landing.gateStable, false);
    assert.deepEqual(landing.stabilityGateFailures, ['glidepath_proxy_unstable_after_gate']);
    assert.equal(landing.payload.stabilityScore, 89);
    assert.equal(landing.payload.stabilityBreakdown.config_ok, 100);
    assert.equal(landing.payload.stabilityBreakdown.spoilers_ok, 100);
  });
});

test('history index store queries flight pages with filters and sort', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    store.replaceSourceIndex({
      source: { filePath: sourcePath(tmpRoot, 'old.csv'), mtimeMs: 10, sizeBytes: 100 },
      flights: [{
        flightId: 'old',
        startedAtMs: 1000,
        aircraft: '737-800',
        departureIcao: 'EGLL',
        arrivalIcao: 'LFPG',
        routeLabel: 'EGLL -> LFPG',
      }],
    });
    store.replaceSourceIndex({
      source: { filePath: sourcePath(tmpRoot, 'new.csv'), mtimeMs: 20, sizeBytes: 200 },
      flights: [{
        flightId: 'new',
        startedAtMs: 2000,
        aircraft: 'A320',
        departureIcao: 'KSEA',
        arrivalIcao: 'KSFO',
        routeLabel: 'KSEA -> KSFO',
      }],
    });

    assert.deepEqual(
      store.queryFlights({ limit: 2 }).flights.map((flight) => flight.flightId),
      ['new', 'old'],
    );
    assert.deepEqual(
      store.queryFlights({ limit: 2, sort: 'oldest' }).flights.map((flight) => flight.flightId),
      ['old', 'new'],
    );
    assert.deepEqual(
      store.queryFlights({ limit: 1, offset: 1 }).flights.map((flight) => flight.flightId),
      ['old'],
    );
    assert.deepEqual(
      store.queryFlights({ routeFilter: 'KSFO' }).flights.map((flight) => flight.flightId),
      ['new'],
    );
    assert.deepEqual(
      store.queryFlights({ aircraftFilter: '737' }).flights.map((flight) => flight.flightId),
      ['old'],
    );
  });
});

test('history index query controls cannot inject SQL through filters or sort values', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    store.replaceSourceIndex({
      source: { filePath: sourcePath(tmpRoot, 'injection.csv'), mtimeMs: 10, sizeBytes: 100 },
      flights: [{
        flightId: 'safe-flight',
        startedAtMs: 1000,
        aircraft: '737-800',
        departureIcao: 'EGLL',
        arrivalIcao: 'LFPG',
      }],
    });

    const injection = "%' OR 1=1 --";
    assert.equal(store.queryFlights({ routeFilter: injection }).totalMatching, 0);
    assert.equal(store.queryFlights({ aircraftFilter: injection }).totalMatching, 0);
    assert.deepEqual(
      store.queryFlights({ sort: 'recent; DELETE FROM history_flights; --' }).flights
        .map((flight) => flight.flightId),
      ['safe-flight'],
    );
    assert.deepEqual(store.getCounts(), { sources: 1, flights: 1, landings: 0 });
  });
});

test('history index store allows duplicate display flight ids across CSV sources', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    store.replaceSourceIndex({
      source: { filePath: sourcePath(tmpRoot, 'first.csv'), mtimeMs: 10, sizeBytes: 100 },
      flights: [{
        flightId: 'duplicate-id',
        startedAtMs: 1000,
        aircraft: '737-800',
        routeLabel: 'EGLL -> LFPG',
      }],
    });
    store.replaceSourceIndex({
      source: { filePath: sourcePath(tmpRoot, 'second.csv'), mtimeMs: 20, sizeBytes: 200 },
      flights: [{
        flightId: 'duplicate-id',
        startedAtMs: 2000,
        aircraft: 'A320',
        routeLabel: 'KSEA -> KSFO',
      }],
    });

    const page = store.queryFlights({ limit: 10 });
    assert.equal(page.totalMatching, 2);
    assert.deepEqual(
      page.flights.map((flight) => `${flight.flightId}:${flight.aircraft}`),
      ['duplicate-id:A320', 'duplicate-id:737-800'],
    );
  });
});

test('history index store prunes only the missing flight lane and preserves landing rows', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const keepPath = sourcePath(tmpRoot, 'keep.csv');
    const deletePath = sourcePath(tmpRoot, 'delete.csv');
    store.replaceSourceIndex({
      source: { filePath: keepPath, mtimeMs: 10, sizeBytes: 100 },
      flights: [{ flightId: 'keep', startedAtMs: 1000 }],
      landings: [{
        landingId: 'keep-landing',
        flightId: 'keep',
        timestampMs: 1000,
        timestamp: '2026-07-09T00:00:01.000Z',
      }],
    });
    store.replaceSourceIndex({
      source: { filePath: deletePath, mtimeMs: 20, sizeBytes: 200 },
      flights: [{ flightId: 'delete', startedAtMs: 2000 }],
      landings: [{
        landingId: 'delete-landing',
        flightId: 'delete',
        timestampMs: 2000,
        timestamp: '2026-07-09T00:00:02.000Z',
      }],
    });

    assert.deepEqual(store.getCounts(), { sources: 2, flights: 2, landings: 2 });
    assert.equal(store.pruneMissingSources([keepPath]), 1);
    assert.deepEqual(store.getCounts(), { sources: 2, flights: 1, landings: 2 });
    assert.equal(store.queryFlights({ limit: 10 }).flights[0].flightId, 'keep');
    assert.deepEqual(
      store.queryLandings({ limit: 10 }).landings.map((landing) => landing.landingId),
      ['delete-landing', 'keep-landing'],
    );
    assert.equal(store.getFlightsSourceByPath(deletePath), null);
    assert.equal(store.getLandingsSourceByPath(deletePath).mtimeMs, 20);
  });
});

test('history index store keeps flight and landing refresh lanes independent', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const filePath = sourcePath(tmpRoot, 'shared.csv');

    store.replaceSourcesLandingsIndex([{
      source: { filePath, mtimeMs: 100, sizeBytes: 1000 },
      landings: [{
        landingId: 'landing-v1',
        timestampMs: 2000,
        timestamp: '2026-07-09T00:00:02.000Z',
        aircraft: '737-800',
        icao: 'LFPG',
        runway: '27R',
        vsFpm: -210,
        grade: 'Good',
        payload: { id: 'landing-v1', marker: 'landing-payload' },
      }],
    }]);

    assert.equal(store.getFlightsSourceByPath(filePath), null);
    assert.equal(store.getLandingsSourceByPath(filePath).mtimeMs, 100);

    store.replaceSourcesFlightsIndex([{
      source: { filePath, mtimeMs: 100, sizeBytes: 1000 },
      flights: [{
        flightId: 'flight-v1',
        startedAtMs: 1000,
        endedAtMs: 2000,
        aircraft: '737-800',
        departureIcao: 'EGLL',
        arrivalIcao: 'LFPG',
      }],
    }]);

    assert.deepEqual(store.getCounts(), { sources: 1, flights: 1, landings: 1 });
    assert.equal(store.queryFlights({ limit: 10 }).flights[0].flightId, 'flight-v1');
    assert.equal(store.queryLogbookEntries({ limit: 10 }).entries[0].id, 'landing-v1');

    store.replaceSourcesFlightsIndex([{
      source: { filePath, mtimeMs: 101, sizeBytes: 1001 },
      flights: [{
        flightId: 'flight-v2',
        startedAtMs: 3000,
        endedAtMs: 4000,
        aircraft: 'A320',
        departureIcao: 'KSEA',
        arrivalIcao: 'KSFO',
      }],
    }]);

    assert.deepEqual(store.getCounts(), { sources: 1, flights: 1, landings: 1 });
    assert.equal(store.getFlightsSourceByPath(filePath).mtimeMs, 101);
    assert.equal(store.getLandingsSourceByPath(filePath).mtimeMs, 100);
    assert.equal(store.queryFlights({ limit: 10 }).flights[0].flightId, 'flight-v2');
    assert.equal(store.queryLogbookEntries({ limit: 10 }).entries[0].id, 'landing-v1');

    store.replaceSourcesLandingsIndex([{
      source: { filePath, mtimeMs: 102, sizeBytes: 1002 },
      landings: [{
        landingId: 'landing-v2',
        timestampMs: 5000,
        timestamp: '2026-07-09T00:00:05.000Z',
        aircraft: 'A320',
        icao: 'KSFO',
        runway: '28L',
        vsFpm: -180,
        grade: 'Perfect',
        payload: { id: 'landing-v2', marker: 'updated-landing-payload' },
      }],
    }]);

    assert.deepEqual(store.getCounts(), { sources: 1, flights: 1, landings: 1 });
    assert.equal(store.getFlightsSourceByPath(filePath).mtimeMs, 101);
    assert.equal(store.getLandingsSourceByPath(filePath).mtimeMs, 102);
    assert.equal(store.queryFlights({ limit: 10 }).flights[0].flightId, 'flight-v2');
    assert.equal(store.queryLogbookEntries({ limit: 10 }).entries[0].id, 'landing-v2');
  });
});

test('history index store prunes missing landing sources without deleting flights', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const keepPath = sourcePath(tmpRoot, 'keep.csv');
    const landingOnlyPath = sourcePath(tmpRoot, 'landing-only-delete.csv');
    const flightOnlyPath = sourcePath(tmpRoot, 'flight-only-keep.csv');

    store.replaceSourcesFlightsIndex([{
      source: { filePath: keepPath, mtimeMs: 10, sizeBytes: 100 },
      flights: [{ flightId: 'keep-flight', startedAtMs: 1000 }],
    }, {
      source: { filePath: flightOnlyPath, mtimeMs: 11, sizeBytes: 110 },
      flights: [{ flightId: 'flight-only', startedAtMs: 1100 }],
    }]);
    store.replaceSourcesLandingsIndex([{
      source: { filePath: keepPath, mtimeMs: 10, sizeBytes: 100 },
      landings: [{ landingId: 'keep-landing', timestampMs: 1000, timestamp: '2026-07-09T00:00:01.000Z' }],
    }, {
      source: { filePath: landingOnlyPath, mtimeMs: 20, sizeBytes: 200 },
      landings: [{ landingId: 'delete-landing', timestampMs: 2000, timestamp: '2026-07-09T00:00:02.000Z' }],
    }]);

    assert.deepEqual(store.getCounts(), { sources: 3, flights: 2, landings: 2 });
    assert.equal(store.pruneMissingLandingSources([keepPath, flightOnlyPath]), 1);
    assert.deepEqual(store.getCounts(), { sources: 3, flights: 2, landings: 1 });
    assert.deepEqual(
      store.queryFlights({ limit: 10 }).flights.map((flight) => flight.flightId).sort(),
      ['flight-only', 'keep-flight'],
    );
    assert.equal(store.queryLogbookEntries({ limit: 10 }).entries[0].landingId, 'keep-landing');
  });
});

test('history index store refreshes and prunes the landing catalog atomically', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const oldPath = sourcePath(tmpRoot, 'old.csv');
    const currentPath = sourcePath(tmpRoot, 'current.csv');
    store.replaceSourcesLandingsIndex([{
      source: { filePath: oldPath, mtimeMs: 10, sizeBytes: 100 },
      landings: [{
        landingId: 'old-landing',
        timestampMs: 1000,
        timestamp: '2026-07-09T00:00:01.000Z',
        payload: { id: 'old-landing' },
      }],
    }]);

    const refresh = store.refreshSourcesLandingsIndex([{
      source: { filePath: currentPath, mtimeMs: 20, sizeBytes: 200 },
      landings: [{
        landingId: 'current-landing',
        timestampMs: 2000,
        timestamp: '2026-07-09T00:00:02.000Z',
        payload: { id: 'current-landing' },
      }],
    }], [currentPath]);

    assert.equal(refresh.pruned, 1);
    const snapshot = store.queryLogbookSnapshot({ limit: 10 });
    assert.equal(snapshot.stats.total, 1);
    assert.equal(snapshot.page.totalMatching, 1);
    assert.deepEqual(snapshot.page.entries.map((entry) => entry.id), ['current-landing']);
  });
});

test('history index landing catalog rollback preserves the previous snapshot on batch failure', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const previousPath = sourcePath(tmpRoot, 'previous.csv');
    store.replaceSourcesLandingsIndex([{
      source: { filePath: previousPath, mtimeMs: 10, sizeBytes: 100 },
      landings: [{
        landingId: 'previous-landing',
        timestampMs: 1000,
        timestamp: '2026-07-09T00:00:01.000Z',
        payload: { id: 'previous-landing' },
      }],
    }]);

    const firstPath = sourcePath(tmpRoot, 'first-new.csv');
    const secondPath = sourcePath(tmpRoot, 'second-new.csv');
    assert.throws(() => store.refreshSourcesLandingsIndex([{
      source: { filePath: firstPath, mtimeMs: 20, sizeBytes: 200 },
      landings: [{ landingId: 'duplicate-key', timestampMs: 2000, timestamp: '2026-07-09T00:00:02.000Z' }],
    }, {
      source: { filePath: secondPath, mtimeMs: 30, sizeBytes: 300 },
      landings: [{ landingId: 'duplicate-key', timestampMs: 3000, timestamp: '2026-07-09T00:00:03.000Z' }],
    }], [firstPath, secondPath]), /UNIQUE constraint failed/);

    const snapshot = store.queryLogbookSnapshot({ limit: 10 });
    assert.equal(snapshot.stats.total, 1);
    assert.deepEqual(snapshot.page.entries.map((entry) => entry.id), ['previous-landing']);
    assert.equal(store.getLandingsSourceByPath(previousPath).mtimeMs, 10);
  });
});

test('history index store computes logbook stats from indexed columns without loading all payloads', (t) => {
  if (skipIfNoSqlite(t)) return;

  withTempStore((store, tmpRoot) => {
    const filePath = sourcePath(tmpRoot, 'stats.csv');
    store.replaceSourcesLandingsIndex([{
      source: { filePath, mtimeMs: 10, sizeBytes: 100 },
      landings: [{
        landingId: 'stats-1',
        timestampMs: 1000,
        timestamp: '2026-07-09T00:00:01.000Z',
        aircraft: '737-800',
        icao: 'LFPG',
        runway: '27R',
        vsFpm: -300,
        grade: 'Good',
        outcomeGrade: 'Good',
        gateStable: true,
        stabilityScore: 80,
        touchdownDistanceGrade: 'Good',
        payload: { id: 'stats-1', heavy: 'payload-one' },
      }, {
        landingId: 'stats-2',
        timestampMs: 2000,
        timestamp: '2026-07-09T00:00:02.000Z',
        aircraft: '737-800',
        icao: 'LFPG',
        runway: '27R',
        vsFpm: -240,
        grade: 'Good',
        outcomeGrade: 'Long Landing',
        gateStable: false,
        stabilityScore: 70,
        touchdownDistanceGrade: 'Long Landing',
        payload: { id: 'stats-2', heavy: 'payload-two' },
      }, {
        landingId: 'stats-3',
        timestampMs: 3000,
        timestamp: '2026-07-09T00:00:03.000Z',
        aircraft: '737-800',
        icao: 'LFPG',
        runway: '27R',
        vsFpm: -180,
        grade: 'Perfect',
        outcomeGrade: 'Perfect',
        gateStable: true,
        stabilityScore: 90,
        touchdownDistanceGrade: 'Good',
        payload: { id: 'stats-3', heavy: 'payload-three' },
      }, {
        landingId: 'stats-4',
        timestampMs: 4000,
        timestamp: '2026-07-09T00:00:04.000Z',
        aircraft: 'A320',
        icao: 'KSFO',
        runway: '28L',
        vsFpm: -420,
        grade: 'Hard',
        outcomeGrade: 'Hard',
        gateStable: null,
        stabilityScore: null,
        touchdownDistanceGrade: 'Good',
        payload: { id: 'stats-4', heavy: 'payload-four' },
      }],
    }]);

    const page = store.queryLogbookEntries({ limit: 2 });
    assert.equal(page.entries.length, 2);
    assert.equal(page.totalMatching, 4);
    assert.equal(Object.prototype.hasOwnProperty.call(page, 'allEntries'), false);

    const stats = store.queryLogbookStats();
    assert.equal(stats.total, 4);
    assert.deepEqual(stats.grades, { Good: 2, Hard: 1, Perfect: 1 });
    assert.deepEqual(stats.outcomeGrades, { Good: 1, Hard: 1, 'Long Landing': 1, Perfect: 1 });
    assert.equal(stats.longLandingCount, 1);
    assert.equal(stats.avgVsFpm, -285);
    assert.equal(stats.bestVsFpm, -180);
    assert.equal(stats.airports, 2);
    assert.equal(stats.aircraft, 2);
    assert.equal(stats.trends.aircraft[0].key, '737-800');
    assert.equal(stats.trends.aircraft[0].count, 3);
    assert.equal(stats.trends.aircraft[0].avgVsFpm, -240);
    assert.equal(stats.trends.aircraft[0].avgStabilityScore, 80);
    assert.equal(stats.trends.aircraft[0].stableRatePct, 67);
    assert.equal(stats.trends.aircraft[0].trendVs, 'improving');
    assert.equal(stats.trends.runways[0].key, 'LFPG:27R');
  });
});

test('history index store quarantines a corrupt database and rebuilds once', (t) => {
  if (skipIfNoSqlite(t)) return;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-corrupt-'));
  try {
    const dbPath = path.join(tmpRoot, 'history.sqlite');
    fs.writeFileSync(dbPath, 'not a sqlite database');

    const opened = openHistoryIndexStore({ dbPath });
    assert.equal(opened.success, true, opened.error);
    assert.equal(opened.recovered, true);
    assert.equal(Array.isArray(opened.quarantined), true);
    assert.equal(opened.quarantined.length, 1);
    assert.equal(fs.existsSync(opened.quarantined[0]), true);

    try {
      assert.deepEqual(opened.store.getCounts(), { sources: 0, flights: 0, landings: 0 });
      opened.store.replaceSourceIndex({
        source: { filePath: sourcePath(tmpRoot, 'rebuilt.csv'), mtimeMs: 10, sizeBytes: 100 },
        flights: [{ flightId: 'rebuilt', startedAtMs: 1000 }],
      });
      assert.equal(opened.store.queryFlights({ limit: 10 }).flights[0].flightId, 'rebuilt');
    } finally {
      opened.store.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('history index preserves a committed landing across an unclean process exit', (t) => {
  if (skipIfNoSqlite(t)) return;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-index-unclean-exit-'));
  const dbPath = path.join(tmpRoot, 'history.sqlite');
  const sourceFilePath = path.join(tmpRoot, 'committed.csv');
  try {
    const childScript = `
      const { openHistoryIndexStore } = require(process.argv[1]);
      const opened = openHistoryIndexStore({ dbPath: process.argv[2] });
      if (!opened.success) throw new Error(opened.error);
      opened.store.replaceSourcesLandingsIndex([{
        source: { filePath: process.argv[3], mtimeMs: 10, sizeBytes: 100 },
        landings: [{
          landingId: 'committed-before-exit',
          timestampMs: 1000,
          timestamp: '2026-07-09T00:00:01.000Z',
          payload: { id: 'committed-before-exit' },
        }],
      }]);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, [
      '-e',
      childScript,
      require.resolve('./history-index-store.js'),
      dbPath,
      sourceFilePath,
    ], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.stdout);

    const reopened = openHistoryIndexStore({ dbPath });
    assert.equal(reopened.success, true, reopened.error);
    try {
      const snapshot = reopened.store.queryLogbookSnapshot({ limit: 10 });
      assert.equal(snapshot.stats.total, 1);
      assert.deepEqual(snapshot.page.entries.map((entry) => entry.id), ['committed-before-exit']);
    } finally {
      reopened.store.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
