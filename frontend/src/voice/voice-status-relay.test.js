import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceStatusRelay, voiceStatusSnapshot } from './voice-status-relay.js';
import { createConnection } from '../ws/connection.js';

function makeVoiceStore(overrides = {}) {
  return {
    bridgeAvailable: true,
    status: 'ready',
    statusText: 'Hold the shortcut and speak.',
    transcript: '',
    lastCommand: '',
    runtime: {
      available: true,
      enabled: true,
      shortcut: 'Ctrl+Shift+Space',
      joystick: { vendorId: '044F', productId: 'B10A', button: 5, name: 'T.16000M', path: '' },
    },
    ...overrides,
  };
}

test('voice status snapshot is bounded and names the joystick binding', () => {
  const snapshot = voiceStatusSnapshot(makeVoiceStore({ transcript: 'x'.repeat(1000) }), {
    aircraftCommandCatalogue: { profileKey: 'bundled/msfs/pmdg-737' },
  });
  assert.equal(snapshot.type, 'voiceStatus');
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.transcript.length, 400);
  assert.equal(snapshot.shortcut, 'Ctrl+Shift+Space');
  assert.equal(snapshot.joystick, 'T.16000M button 5');
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.profileKey, 'bundled/msfs/pmdg-737');
  assert.equal(voiceStatusSnapshot({ bridgeAvailable: false, runtime: {} }).available, false);
});

test('relay publishes on change, dedupes repeats, and resyncs on demand', () => {
  const voiceStore = makeVoiceStore();
  const sent = [];
  let watcher = null;
  const relay = createVoiceStatusRelay({
    voiceStore,
    send: (payload) => { sent.push(payload); return true; },
    watchRef: (source, callback) => { watcher = { source, callback }; return () => { watcher = null; }; },
  });
  assert.equal(relay.publish(), true);
  assert.equal(sent.length, 1);
  assert.equal(relay.publish(), false, 'identical status is not re-sent');
  voiceStore.status = 'listening';
  watcher.callback(watcher.source());
  assert.equal(sent.length, 2);
  assert.equal(sent[1].status, 'listening');
  assert.equal(relay.resync(), true, 'reconnect replays the current status');
  assert.equal(sent.length, 3);
  relay.stop();
  assert.equal(watcher, null);
});

test('relay stays silent without the desktop voice bridge and retries a failed send', () => {
  const browserStore = makeVoiceStore({ bridgeAvailable: false });
  const browserSent = [];
  const browserRelay = createVoiceStatusRelay({ voiceStore: browserStore, send: (payload) => { browserSent.push(payload); return true; }, watchRef: () => () => {} });
  assert.equal(browserRelay.resync(), false);
  assert.equal(browserSent.length, 0);

  const voiceStore = makeVoiceStore();
  let socketOpen = false;
  const sent = [];
  const relay = createVoiceStatusRelay({
    voiceStore,
    send: (payload) => { if (!socketOpen) return false; sent.push(payload); return true; },
    watchRef: () => () => {},
  });
  assert.equal(relay.publish(), false, 'closed socket');
  socketOpen = true;
  assert.equal(relay.publish(), true, 'the unsent status is retried once the socket is open');
  assert.equal(sent.length, 1);
});

test('unchanged disabled voice status is sent after authorization on each connection', async () => {
  const sockets = [], sent = [];
  class WebSocketRef {
    static OPEN = 1;
    constructor() { this.readyState = 1; sockets.push(this); }
    send(value) { sent.push(JSON.parse(value)); }
    close() {}
  }
  let relay;
  const connection = createConnection({
    windowRef: {
      location: { hostname: '127.0.0.1', protocol: 'http:', port: '8101' },
      electronAPI: { getBackendBootstrap: async () => ({ wsAuthToken: 'test-only' }) },
    },
    WebSocketRef,
    params: new URLSearchParams('wsPort=8100&httpPort=8101&token=test-only'),
    onMessage: message => relay.handleServerMessage(message),
  });
  const voiceStore = makeVoiceStore({ status: 'disabled', runtime: { enabled: false, available: true } });
  relay = createVoiceStatusRelay({
    voiceStore, watchRef: () => () => {},
    send: payload => connection.getAuthorizationScope() === 'full-control' ? connection.send(payload) : false,
  });
  for (let index = 0; index < 2; index += 1) {
    await connection.initialize(); sockets[index].onopen();
    assert.equal(sent.length, index, 'opening is not authorization');
    sockets[index].onmessage({ data: JSON.stringify({ type: 'authorizationScope', scope: 'read-only' }) });
    assert.equal(sent.length, index);
    sockets[index].onmessage({ data: JSON.stringify({ type: 'authorizationScope', scope: 'full-control' }) });
    assert.equal(sent.length, index + 1, 'authorized reconnect sends an unchanged snapshot');
    assert.equal(sent[index].status, 'disabled');
  }
  relay.stop();
});
