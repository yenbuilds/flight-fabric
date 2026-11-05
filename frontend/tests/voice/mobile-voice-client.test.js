import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileVoiceClient } from '../../src/voice/mobile-voice-client.js';

const ID = 'a'.repeat(32), NEXT = 'b'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const sockets = [], captures = [], states = [];
  const document = new EventTarget(); document.hidden = false;
  const globalRef = Object.assign(new EventTarget(), { document, isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia() {} } }, location: { host: '192.168.1.50:8101' },
    WebSocket: class {
      constructor() { sockets.push(this); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
      send(value) { this.sent.push(value); }
      message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
      close() { this.readyState = 3; this.onclose?.(); }
    },
  });
  const client = createMobileVoiceClient({ globalRef, canStart: () => true, releaseTailMs: 0,
    onState: state => states.push(state), createCapture: callbacks => {
      const capture = { callbacks, stopped: false, cancelled: false,
        start: () => options.start?.() || Promise.resolve(),
        stop: async () => { await options.stop?.(); capture.stopped = true; },
        cancel: async () => { capture.cancelled = true; },
      }; captures.push(capture); return capture;
    },
  });
  t.after(() => client.dispose());
  async function listen(id = ID) {
    const started = client.begin(); await tick();
    const socket = sockets.at(-1); socket.message({ kind: 'ready', id });
    assert.equal(await started, true);
    return socket;
  }
  const chunk = (capture = captures.at(-1)) => capture.callbacks.onChunk({ sampleRate: 48000, sequence: 0, samples: new Float32Array(2048).fill(0.1) });
  return { client, globalRef, captures, sockets, states, listen, chunk };
}

test('phone sends bounded PCM, flushes before finishing and displays the PC result', async t => {
  const h = fixture(t), socket = await h.listen(); h.chunk();
  assert.equal(await h.client.finish(), true);
  assert.equal(h.captures[0].stopped, true);
  assert.equal(socket.sent[1].byteLength, 44 + 2048 * 4);
  assert.equal(new DataView(socket.sent[1]).getUint32(32, true), 0);
  assert.deepEqual(JSON.parse(socket.sent[2]), { kind: 'finish', chunks: 1 });
  socket.message({ kind: 'status', status: 'sent', message: 'Heading set to 270', transcript: 'set heading two seven zero', command: 'Selected heading: 270', done: true });
  assert.equal(h.states.at(-1).status, 'sent'); assert.equal(h.captures[0].cancelled, true);
  assert.equal(socket.readyState, 3);
});

test('release during permission acquisition settles immediately and cannot open a late socket', async t => {
  const permission = deferred(); const h = fixture(t, { start: () => permission.promise });
  const started = h.client.begin();
  assert.equal(await h.client.finish(), false); assert.equal(await started, false);
  permission.resolve(); await tick();
  assert.equal(h.captures[0].cancelled, true); assert.equal(h.sockets.length, 0);
});

test('PC refusal before ready releases phone capture, explains recovery and permits another hold', async t => {
  const h = fixture(t);
  const started = h.client.begin(); await tick();
  const socket = h.sockets[0];
  const message = 'Phone microphone requires Offline mode. Select Offline in Voice settings on your PC, then try again.';
  socket.message({ kind: 'error', message });
  assert.equal(await started, false);
  assert.equal(h.captures[0].cancelled, true);
  assert.equal(socket.readyState, 3);
  assert.equal(socket.sent.some(value => value instanceof ArrayBuffer), false);
  assert.deepEqual(h.states.at(-1), { status: 'error', message });
  await h.listen(NEXT);
  assert.equal(h.states.at(-1).status, 'listening');
});

test('cancellation during flush cannot finish or disturb a replacement recording', async t => {
  const flush = deferred(); const h = fixture(t, { stop: () => flush.promise });
  const old = await h.listen(); h.chunk(); const finishing = h.client.finish();
  await new Promise(resolve => setTimeout(resolve, 5));
  h.client.cancel(); const next = await h.listen(NEXT); flush.resolve();
  assert.equal(await finishing, false);
  h.chunk(h.captures[0]); old.message({ kind: 'status', status: 'sent', done: true });
  assert.equal(h.states.at(-1).status, 'listening'); assert.equal(next.readyState, 1);
  assert.equal(old.sent.some(value => typeof value === 'string' && JSON.parse(value).kind === 'finish'), false);
});

for (const reason of ['background', 'pagehide', 'disconnect', 'backpressure', 'terminal-before-finish', 'capture-error']) {
  test(`phone ${reason} stops capture without submitting a command and allows retry`, async t => {
    const h = fixture(t), socket = await h.listen();
    if (reason === 'background') { h.globalRef.document.hidden = true; h.globalRef.document.dispatchEvent(new Event('visibilitychange')); }
    if (reason === 'pagehide') h.globalRef.dispatchEvent(new Event('pagehide'));
    if (reason === 'disconnect') socket.close();
    if (reason === 'backpressure') { socket.bufferedAmount = 131073; h.chunk(); }
    if (reason === 'terminal-before-finish') socket.message({ kind: 'status', status: 'sent', done: true });
    if (reason === 'capture-error') h.captures[0].callbacks.onError(new Error('Microphone interrupted'));
    assert.equal(h.captures[0].cancelled, true);
    assert.equal(socket.sent.some(value => typeof value === 'string' && JSON.parse(value).kind === 'finish'), false);
    h.globalRef.document.hidden = false;
    await h.listen(NEXT); assert.equal(h.states.at(-1).status, 'listening');
  });
}

test('phone refuses insecure origins and read-only access before opening a microphone', async t => {
  const h = fixture(t); h.globalRef.isSecureContext = false;
  assert.equal(await h.client.begin(), false); assert.equal(h.captures.length, 0);
  let called = false;
  const denied = createMobileVoiceClient({ canStart: () => false, createCapture: () => { called = true; } });
  assert.equal(await denied.begin(), false); assert.equal(called, false); denied.dispose();
});
