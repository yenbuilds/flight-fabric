'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const ts = require('typescript');

// Execute the actual package sources with deterministic browser sockets/timers.
// This keeps lifecycle regressions in npm test without relying on stale dist files.
function createHarness() {
  const sockets = [];
  const timers = new Map();
  let timerId = 0;
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; sockets.push(this); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    close() { this.readyState = 3; }
    remoteClose() { this.close(); this.onclose?.(); }
  }
  const context = vm.createContext({
    WebSocket: FakeWebSocket,
    console,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  function load(relativePath, dependencies = {}) {
    const filename = path.resolve(__dirname, '../..', relativePath);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exports = {};
    const localRequire = createRequire(filename);
    vm.runInContext(`(function(require, exports) { ${output}\n})`, context, { filename })(
      name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name), exports,
    );
    return exports;
  }
  const types = {
    ...load('packages/telemetry-types/src/state.ts'),
    ...load('packages/telemetry-types/src/enums.ts'),
  };
  const { TelemetryClient } = load('packages/telemetry-client/src/client.ts', { '@flight-fabric/telemetry-types': types });
  const client = new TelemetryClient({ reconnectDelay: 1 });
  return { client, sockets, timers, runTimers() {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  } };
}

test('explicit disconnect ignores a queued close event and stays disconnected until connect', () => {
  const { client, sockets, timers, runTimers } = createHarness();
  client.connect();
  sockets[0].open();
  const delayedClose = sockets[0].onclose;
  client.disconnect();
  delayedClose();
  runTimers();
  assert.equal(client.isConnected(), false);
  assert.equal(timers.size, 0);
  assert.equal(sockets.length, 1);
  client.connect();
  sockets[1].open();
  assert.equal(client.isConnected(), true);
  client.destroy();
});

test('unexpected disconnect retries once and an explicit disconnect cancels a pending retry', () => {
  const { client, sockets, timers, runTimers } = createHarness();
  client.connect();
  sockets[0].open();
  sockets[0].remoteClose();
  assert.equal(timers.size, 1);
  runTimers();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].remoteClose();
  client.disconnect();
  runTimers();
  assert.equal(sockets.length, 2);
  client.destroy();
});

test('repeated connect calls share a pending socket and ignore old socket events', () => {
  const { client, sockets, timers } = createHarness();
  client.connect();
  client.connect();
  assert.equal(sockets.length, 1);
  const oldClose = sockets[0].onclose;
  const oldMessage = sockets[0].onmessage;
  client.disconnect();
  client.connect();
  sockets[1].open();
  oldClose();
  oldMessage({ data: JSON.stringify({ type: 'ias', value: 999 }) });
  assert.equal(client.isConnected(), true);
  assert.equal(client.getState().ias, null);
  assert.equal(timers.size, 0);
  client.destroy();
});

test('destroy prevents new connections and stale open events from reviving the client', () => {
  const { client, sockets, runTimers } = createHarness();
  client.connect();
  const delayedOpen = sockets[0].onopen;
  client.destroy();
  delayedOpen();
  client.connect();
  runTimers();
  assert.equal(client.isConnected(), false);
  assert.equal(sockets.length, 1);
});

test('disconnect from a connection-status subscriber also suppresses retry', () => {
  const { client, sockets, timers } = createHarness();
  client.connect();
  sockets[0].open();
  let stopped = false;
  client.subscribe(state => {
    if (!state.connected && !stopped) { stopped = true; client.disconnect(); }
  });
  sockets[0].remoteClose();
  assert.equal(timers.size, 0);
  client.destroy();
});
