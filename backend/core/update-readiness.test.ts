import test from 'node:test';
import assert from 'node:assert/strict';
import { getUpdateBlocker } from './update-readiness';

const idle = { connected: false, observedAt: 10000, now: 10100, recording: false, finalizing: false, replay: false, requests: 0, shuttingDown: false };

test('only a fresh disconnected and idle backend permits update preparation', () => {
  assert.equal(getUpdateBlocker(idle), '');
  for (const change of [
    { connected: true }, { connected: undefined }, { observedAt: 0 }, { observedAt: 1000 },
    { now: 9000 }, { recording: true }, { finalizing: true }, { replay: true },
    { requests: 1 }, { shuttingDown: true },
  ]) assert.notEqual(getUpdateBlocker({ ...idle, ...change }), '');
});
