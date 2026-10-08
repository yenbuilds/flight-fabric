'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { prepareBackendForUpdate } = require('./update-backend');

function fixture() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough();
  let request;
  proc.stdin.on('data', data => { request = JSON.parse(data); });
  return { proc, reply: (value) => proc.stdout.write(`[FF_UPDATE_SHUTDOWN]${JSON.stringify({ id: request.id, ...value })}\n`) };
}

test('requires correct request acknowledgement and zero process close', async () => {
  const f = fixture();
  let done = false;
  const pending = prepareBackendForUpdate(f.proc).then(() => { done = true; });
  f.reply({ ok: true });
  await new Promise(r => setImmediate(r));
  assert.equal(done, false);
  f.proc.emit('close', 0);
  await pending;
  assert.equal(f.proc.stdout.listenerCount('data'), 0);
});

test('zero exit without acknowledgement and forced termination fail closed', async () => {
  for (const code of [0, 1, null]) {
    const f = fixture();
    const pending = prepareBackendForUpdate(f.proc);
    f.reply({ id: 'different-request', ok: true });
    f.proc.emit('close', code);
    await assert.rejects(pending, /clean shutdown/);
  }
});

test('recording blocker keeps process open and settles the caller', async () => {
  const f = fixture();
  const pending = prepareBackendForUpdate(f.proc);
  f.reply({ ok: false, message: 'Finish recording first.' });
  await assert.rejects(pending, /Finish recording/);
  assert.equal(f.proc.listenerCount('close'), 0);
});

test('cancellation removes listeners and ignores late acknowledgement', async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = prepareBackendForUpdate(f.proc, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  f.reply({ ok: true }); f.proc.emit('close', 0);
  assert.equal(f.proc.stdout.listenerCount('data'), 0);
});
