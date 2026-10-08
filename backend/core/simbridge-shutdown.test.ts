'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runSimbridgeShutdownSequence } = require('./simbridge-shutdown.js');

test('shutdown cancels history indexing before flight bundle finalization', async () => {
  const events = [];
  let releaseHistoryStop;
  const historyStopGate = new Promise((resolve) => { releaseHistoryStop = resolve; });
  const historyIndexHandle = {
    async stop() {
      events.push('history-stop-started');
      await historyStopGate;
      events.push('history-stop-complete');
    },
  };
  const stopHandle = async (handle) => {
    if (handle && typeof handle.stop === 'function') return handle.stop();
    return null;
  };

  const shutdown = runSimbridgeShutdownSequence({
    historyIndexHandle,
    stopHandle,
    finalizationTask() {
      events.push('flight-finalized');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['history-stop-started']);
  releaseHistoryStop();
  await shutdown;
  assert.deepEqual(events, [
    'history-stop-started',
    'history-stop-complete',
    'flight-finalized',
  ]);
});

export {};


test('update cleanup rejects a stalled or failed task while ordinary shutdown stays best effort', async () => {
  const { runShutdownTask } = require('./simbridge-shutdown.js');
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(runShutdownTask(() => new Promise(() => {}), 5, 'fixture writer', true), /timed out/);
    await assert.rejects(runShutdownTask(() => Promise.reject(new Error('fixture failure')), 100, 'fixture writer', true), /fixture failure/);
    assert.equal(await runShutdownTask(() => Promise.reject(new Error('fixture failure')), 100, 'fixture writer'), null);
    assert.equal(await runShutdownTask(() => 'closed', 100, 'fixture writer', true), 'closed');
  } finally { clearInterval(keepAlive); }
});
