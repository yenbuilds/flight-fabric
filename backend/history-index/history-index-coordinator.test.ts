'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHistoryIndexCoordinator } = require('./history-index-coordinator.js');

async function waitForCompletion(coordinator, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = coordinator.getStatus();
    if (!status.busy) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('history coordinator did not finish');
}

function createMemoryStore() {
  const sources = new Map();
  const calls = [];
  let clearCount = 0;
  return {
    calls,
    get clearCount() { return clearCount; },
    close() {},
    clearDerivedHistoryIndex() {
      clearCount += 1;
      sources.clear();
    },
    getCounts() {
      return {
        sources: sources.size,
        flights: calls.reduce((total, call) => total + call.flights.length, 0),
        landings: calls.reduce((total, call) => total + call.landings.length, 0),
      };
    },
    getFlightsSourceByPath(filePath) { return sources.get(filePath) || null; },
    getLandingsSourceByPath(filePath) { return sources.get(filePath) || null; },
    pruneMissingSources() { return 0; },
    pruneMissingLandingSources() { return 0; },
    replaceSourceIndex(input) {
      calls.push(input);
      sources.set(input.source.filePath, {
        ...input.source,
        csvPath: input.source.filePath,
      });
    },
  };
}

test('history coordinator checkpoints newest-first and prefers summaries over deep scans', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-indexer-'));
  try {
    const olderPath = path.join(root, 'older.csv');
    const newerPath = path.join(root, 'newer.csv');
    fs.writeFileSync(olderPath, 'old');
    fs.writeFileSync(newerPath, 'new');
    const olderStat = fs.statSync(olderPath);
    const initialNewerStat = fs.statSync(newerPath);
    fs.utimesSync(newerPath, new Date(initialNewerStat.atimeMs), new Date(initialNewerStat.mtimeMs + 1000));
    const newerStat = fs.statSync(newerPath);
    const store = createMemoryStore();
    const deepScanned = [];
    const written = [];
    const coordinator = createHistoryIndexCoordinator({
      openHistoryIndexStore: () => ({ success: true, store }),
      getFlightLogsDir: () => root,
      acquireBundleReadLease: () => ({ acquired: true, release() {} }),
      readHistorySummary(source) {
        return source.filePath === newerPath
          ? { flight: { filePath: newerPath, flightId: 'newer', timestamp: new Date(20).toISOString() }, landings: [] }
          : null;
      },
      writeHistorySummary(source) { written.push(source.filePath); return true; },
      buildListedCsvFlightFromPath(filePath) {
        deepScanned.push(filePath);
        return { filePath, flightId: 'older', timestamp: new Date(10).toISOString() };
      },
      async getLandingsFromCsvFile() {
        return [{ id: 'landing', timestamp: new Date(11).toISOString(), timestampMs: 11, vsFpm: -200 }];
      },
    });

    const started = coordinator.start([
      { filePath: olderPath, mtimeMs: olderStat.mtimeMs, sizeBytes: olderStat.size },
      { filePath: newerPath, mtimeMs: newerStat.mtimeMs, sizeBytes: newerStat.size },
    ]);
    assert.equal(started.busy, true, 'start must return before source analysis completes');
    const complete = await waitForCompletion(coordinator);
    assert.equal(complete.phase, 'complete');
    assert.equal(complete.summaryHits, 1);
    assert.equal(complete.deepScans, 1);
    assert.equal(complete.indexedFiles, 2);
    assert.deepEqual(store.calls.map((call) => path.basename(call.source.filePath)), ['newer.csv', 'older.csv']);
    assert.deepEqual(deepScanned, [olderPath]);
    assert.deepEqual(written, [olderPath]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history coordinator rebuild clears only the derived store and reuses summaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-rebuild-'));
  try {
    const csvPath = path.join(root, 'flight.csv');
    fs.writeFileSync(csvPath, 'flight');
    const stat = fs.statSync(csvPath);
    const store = createMemoryStore();
    const coordinator = createHistoryIndexCoordinator({
      openHistoryIndexStore: () => ({ success: true, store }),
      getFlightLogsDir: () => root,
      acquireBundleReadLease: () => ({ acquired: true, release() {} }),
      readHistorySummary: () => ({
        flight: { filePath: csvPath, flightId: 'flight', timestamp: new Date(1).toISOString() },
        landings: [],
      }),
      writeHistorySummary: () => true,
      buildListedCsvFlightFromPath() { throw new Error('deep scan should not run'); },
      async getLandingsFromCsvFile() { throw new Error('deep scan should not run'); },
    });

    coordinator.start([{ filePath: csvPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }], { rebuild: true });
    const complete = await waitForCompletion(coordinator);
    assert.equal(complete.phase, 'complete');
    assert.equal(complete.summaryHits, 1);
    assert.equal(complete.deepScans, 0);
    assert.equal(store.clearCount, 1);
    assert.equal(fs.existsSync(csvPath), true, 'rebuild must never remove the authoritative CSV');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history coordinator persists the authoritative catalog identity when a migrated summary embeds an old fingerprint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-migrated-summary-'));
  try {
    const csvPath = path.join(root, 'telemetry.csv');
    fs.writeFileSync(csvPath, 'flight');
    const stat = fs.statSync(csvPath);
    const source = {
      filePath: csvPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      bundleCatalogRevision: 200,
      bundleSizeBytes: 999,
    };
    const store = createMemoryStore();
    const options = {
      openHistoryIndexStore: () => ({ success: true, store }),
      getFlightLogsDir: () => root,
      acquireBundleReadLease: () => ({ acquired: true, release() {} }),
      readHistorySummary: () => ({
        flight: {
          filePath: csvPath,
          flightId: 'migrated-flight',
          timestamp: new Date(1).toISOString(),
          recordingBundleCatalogRevision: 100,
          recordingBundleSizeBytes: 999,
        },
        landings: [],
      }),
      writeHistorySummary: () => true,
      buildListedCsvFlightFromPath() { throw new Error('valid summary should avoid a deep scan'); },
      async getLandingsFromCsvFile() { throw new Error('valid summary should avoid a deep scan'); },
    };

    const firstCoordinator = createHistoryIndexCoordinator(options);
    firstCoordinator.start([source]);
    const first = await waitForCompletion(firstCoordinator);
    assert.equal(first.indexedFiles, 1);
    assert.equal(store.calls[0].source.mtimeMs, source.bundleCatalogRevision);

    // Model an app restart: coordinator memory is new, while SQLite state is
    // retained. The unchanged source must be recognized without re-indexing.
    const restartedCoordinator = createHistoryIndexCoordinator(options);
    restartedCoordinator.start([source]);
    const restarted = await waitForCompletion(restartedCoordinator);
    assert.equal(restarted.indexedFiles, 0);
    assert.equal(store.calls.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history coordinator cancellation stops between bundles without committing an in-flight scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-history-cancel-'));
  try {
    const firstPath = path.join(root, 'first.csv');
    const secondPath = path.join(root, 'second.csv');
    fs.writeFileSync(firstPath, 'first');
    fs.writeFileSync(secondPath, 'second');
    const firstStat = fs.statSync(firstPath);
    const secondStat = fs.statSync(secondPath);
    let releaseScan;
    let signalScanStarted;
    const scanStarted = new Promise((resolve) => { signalScanStarted = resolve; });
    const scanGate = new Promise((resolve) => { releaseScan = resolve; });
    const scanned = [];
    const store = createMemoryStore();
    const coordinator = createHistoryIndexCoordinator({
      openHistoryIndexStore: () => ({ success: true, store }),
      getFlightLogsDir: () => root,
      acquireBundleReadLease: () => ({ acquired: true, release() {} }),
      readHistorySummary: () => null,
      writeHistorySummary: () => true,
      buildListedCsvFlightFromPath(filePath) {
        scanned.push(filePath);
        return { filePath, flightId: path.basename(filePath), timestamp: new Date(1).toISOString() };
      },
      async getLandingsFromCsvFile() {
        signalScanStarted();
        await scanGate;
        return [];
      },
    });

    coordinator.start([
      { filePath: firstPath, mtimeMs: firstStat.mtimeMs, sizeBytes: firstStat.size },
      { filePath: secondPath, mtimeMs: secondStat.mtimeMs, sizeBytes: secondStat.size },
    ]);
    await scanStarted;
    const cancelling = coordinator.cancel();
    releaseScan();
    const cancelled = await cancelling;

    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.busy, false);
    assert.equal(store.calls.length, 0);
    assert.equal(scanned.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export {};
