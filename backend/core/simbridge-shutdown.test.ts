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
