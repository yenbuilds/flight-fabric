const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createHistorySourceId,
  createHistorySourceIdentity,
  normalizeHistorySourcePath,
  sourceIdentityMatches,
} = require('./source-identity.js');

test('history source identity is stable for the same resolved path', () => {
  const filePath = path.join(process.cwd(), 'Flight Logs', '..', 'Flight Logs', 'flight.csv');
  const resolved = path.resolve(filePath);
  assert.equal(createHistorySourceId(filePath), createHistorySourceId(resolved));
  assert.equal(createHistorySourceIdentity({ filePath, mtimeMs: 12.5, sizeBytes: 99 }).sourceId, createHistorySourceId(resolved));
});

test('history source identity preserves freshness fields', () => {
  const filePath = path.join(process.cwd(), 'flight.csv');
  const identity = createHistorySourceIdentity({ filePath, mtimeMs: 1234.5, sizeBytes: 4096.9 });
  assert.equal(identity.csvPath, path.resolve(filePath));
  assert.equal(identity.csvBasename, 'flight.csv');
  assert.equal(identity.mtimeMs, 1234.5);
  assert.equal(identity.sizeBytes, 4096);
  assert.equal(identity.normalizedPath, normalizeHistorySourcePath(filePath));
});

test('history source identity matching requires path, mtime, and size', () => {
  const filePath = path.join(process.cwd(), 'flight.csv');
  const identity = createHistorySourceIdentity({ filePath, mtimeMs: 1234, sizeBytes: 4096 });
  assert.equal(sourceIdentityMatches(identity, {
    csvPath: filePath,
    mtimeMs: 1234,
    sizeBytes: 4096,
  }), true);
  assert.equal(sourceIdentityMatches(identity, {
    csvPath: filePath,
    mtimeMs: 1235,
    sizeBytes: 4096,
  }), false);
  assert.equal(sourceIdentityMatches(identity, {
    csvPath: filePath,
    mtimeMs: 1234,
    sizeBytes: 4097,
  }), false);
  assert.equal(sourceIdentityMatches(identity, {
    csvPath: path.join(process.cwd(), 'other.csv'),
    mtimeMs: 1234,
    sizeBytes: 4096,
  }), false);
});
