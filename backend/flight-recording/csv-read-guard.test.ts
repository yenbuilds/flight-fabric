const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  flushActiveCsvBeforeDirectoryRead,
  flushActiveCsvBeforeRead,
  getActiveCsvPath,
  getFinalizingCsvPath,
  isActiveCsvPath,
  isFinalizingCsvPath,
} = require('./csv-read-guard.js');

function buildWriter(filePath, overrides = {}) {
  return {
    isRecording() {
      return true;
    },
    getStats() {
      return { filePath };
    },
    async flush() {
      return true;
    },
    ...overrides,
  };
}

test('csv-read-guard identifies active CSV paths using platform path semantics', () => {
  const activePath = path.join('C:\\Flight Fabric', 'Flight Logs', 'active.csv');
  const writer = buildWriter(activePath);
  const requestedPath = process.platform === 'win32' ? activePath.toUpperCase() : activePath;

  assert.equal(getActiveCsvPath(writer), path.resolve(activePath));
  assert.equal(isActiveCsvPath(writer, requestedPath), true);
  assert.equal(isActiveCsvPath(writer, path.join(path.dirname(activePath), 'other.csv')), false);
});

test('flushActiveCsvBeforeRead flushes only when the requested CSV is active', async () => {
  const activePath = path.join('C:\\Flight Fabric', 'Flight Logs', 'active.csv');
  let flushCount = 0;
  const writer = buildWriter(activePath, {
    async flush() {
      flushCount += 1;
      return true;
    },
  });

  assert.equal(await flushActiveCsvBeforeRead(writer, path.join(path.dirname(activePath), 'other.csv')), true);
  assert.equal(flushCount, 0);

  assert.equal(await flushActiveCsvBeforeRead(writer, activePath), true);
  assert.equal(flushCount, 1);
});

test('flushActiveCsvBeforeRead fails closed if active writer cannot flush', async () => {
  const activePath = path.join('C:\\Flight Fabric', 'Flight Logs', 'active.csv');
  const writer = buildWriter(activePath, {
    async flush() {
      return false;
    },
  });

  assert.equal(await flushActiveCsvBeforeRead(writer, activePath), false);
});

test('flushActiveCsvBeforeDirectoryRead returns active path and readiness', async () => {
  const activePath = path.join('C:\\Flight Fabric', 'Flight Logs', 'active.csv');
  let flushCount = 0;
  const writer = buildWriter(activePath, {
    async flush() {
      flushCount += 1;
      return true;
    },
  });

  const ready = await flushActiveCsvBeforeDirectoryRead(writer);
  assert.equal(ready.ready, true);
  assert.equal(ready.activeCsvPath, path.resolve(activePath));
  assert.equal(flushCount, 1);

  const inactive = await flushActiveCsvBeforeDirectoryRead(buildWriter(activePath, {
    isRecording() {
      return false;
    },
  }));
  assert.equal(inactive.ready, true);
  assert.equal(inactive.activeCsvPath, null);
});

test('csv-read-guard fails closed while a requested CSV is finalizing', async () => {
  const finalizingPath = path.join('C:\\Flight Fabric', 'Flight Logs', 'finalizing.csv');
  const writer = buildWriter(finalizingPath, {
    isRecording() {
      return false;
    },
    isFinalizing() {
      return true;
    },
    getFinalizingStats() {
      return { filePath: finalizingPath };
    },
  });

  assert.equal(getFinalizingCsvPath(writer), path.resolve(finalizingPath));
  assert.equal(isFinalizingCsvPath(writer, finalizingPath), true);
  assert.equal(await flushActiveCsvBeforeRead(writer, finalizingPath), false);
  const directory = await flushActiveCsvBeforeDirectoryRead(writer);
  assert.equal(directory.ready, false);
  assert.equal(directory.activeCsvPath, path.resolve(finalizingPath));
});

export {};
