#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadConnectionModule() {
  const modulePath = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', 'ws', 'connection.js')).href;
  return import(modulePath);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acknowledgeScope(connection, scope) {
  connection.getWs().onmessage({
    data: JSON.stringify({ type: 'authorizationScope', scope }),
  });
}

async function testPortMismatchBootstrapFallback() {
  const { createConnection } = await loadConnectionModule();
  let openedUrl = '';

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    close() {}
    send() {}
  }

  const fetchCalls = [];
  const windowRef = {
    location: {
      search: '',
      hostname: 'localhost',
      protocol: 'http:',
      port: '8000',
    },
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url === 'http://localhost:8000/api/bootstrap') {
        return { ok: false, json: async () => ({}) };
      }
      if (url === 'http://localhost:8100/api/bootstrap') {
        return {
          ok: true,
          json: async () => ({
            wsAuthToken: 'fixture-token',
            aircraftControlToken: 'fixture-aircraft-token',
          }),
        };
      }
      throw new Error(`Unexpected bootstrap URL: ${url}`);
    },
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
  });

  await connection.initialize();
  await wait(10);

  assert.deepEqual(fetchCalls, [
    'http://localhost:8000/api/bootstrap',
    'http://localhost:8100/api/bootstrap',
  ]);
  assert.equal(openedUrl, 'ws://localhost:8099?token=fixture-token&aircraftControlToken=fixture-aircraft-token');
  assert.equal(connection.getBackendHttpBase(), 'http://localhost:8100');
  assert.equal(connection.getAuthorizationScope(), 'read-only', 'credentials alone must not grant UI capability');
  acknowledgeScope(connection, 'full-control');
  assert.equal(connection.getAuthorizationScope(), 'full-control');
}

async function testDirectBackendBootstrap() {
  const { createConnection } = await loadConnectionModule();
  let openedUrl = '';

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    close() {}
    send() {}
  }

  const fetchCalls = [];
  const windowRef = {
    location: {
      search: '',
      hostname: '192.168.50.49',
      protocol: 'http:',
      port: '8100',
    },
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url === 'http://192.168.50.49:8100/api/bootstrap') {
        return { ok: true, json: async () => ({ wsAuthToken: '' }) };
      }
      throw new Error(`Unexpected bootstrap URL: ${url}`);
    },
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
  });

  await connection.initialize();
  await wait(10);

  assert.deepEqual(fetchCalls, ['http://192.168.50.49:8100/api/bootstrap']);
  assert.equal(openedUrl, 'ws://192.168.50.49:8099');
  assert.equal(connection.getBackendHttpBase(), 'http://192.168.50.49:8100');
  acknowledgeScope(connection, 'read-only');
  assert.equal(connection.getAuthorizationScope(), 'read-only');
}

async function testPairedLanUrlKeepsAircraftScopeSeparate() {
  const { createConnection } = await loadConnectionModule();
  let openedUrl = '';

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    close() {}
    send() {}
  }

  const windowRef = {
    location: {
      search: '?aircraftControlToken=paired-lan-token',
      hostname: '192.168.50.49',
      protocol: 'http:',
      port: '8100',
    },
    fetch: async (url) => {
      if (url === 'http://192.168.50.49:8100/api/bootstrap') {
        return { ok: true, json: async () => ({ wsAuthToken: '', aircraftControlToken: '' }) };
      }
      throw new Error(`Unexpected bootstrap URL: ${url}`);
    },
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
  });

  await connection.initialize();
  await wait(10);

  assert.equal(openedUrl, 'ws://192.168.50.49:8099?aircraftControlToken=paired-lan-token');
  assert.equal(openedUrl.includes('?token='), false, 'aircraft pairing must not become the privileged websocket token');
  assert.equal(connection.getAuthorizationScope(), 'read-only', 'an unacknowledged pairing claim must remain read-only');
  acknowledgeScope(connection, 'aircraft-control');
  assert.equal(connection.getAuthorizationScope(), 'aircraft-control');
}

async function testPairedLanUrlUsesExplicitCustomWsPort() {
  const { createConnection } = await loadConnectionModule();
  let openedUrl = '';

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    close() {}
    send() {}
  }

  const windowRef = {
    location: {
      search: '?wsPort=9199&port=8888&ws=7777&aircraftControlToken=paired-lan-token',
      hostname: '192.168.50.49',
      protocol: 'http:',
      port: '9200',
    },
    fetch: async (url) => {
      if (url === 'http://192.168.50.49:9200/api/bootstrap') {
        return { ok: true, json: async () => ({ wsAuthToken: '', aircraftControlToken: '' }) };
      }
      throw new Error(`Unexpected bootstrap URL: ${url}`);
    },
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
  });

  await connection.initialize();
  await wait(10);

  assert.equal(openedUrl, 'ws://192.168.50.49:9199?aircraftControlToken=paired-lan-token');
}

async function testElectronLoopbackBootstrapFallback() {
  const { createConnection } = await loadConnectionModule();
  let openedUrl = '';

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    close() {}
    send() {}
  }

  const fetchCalls = [];
  const windowRef = {
    location: {
      search: '',
      hostname: '127.0.0.1',
      protocol: 'http:',
      port: '8000',
    },
    electronAPI: {
      getBackendWsPort: async () => 8099,
      getBackendHttpPort: async () => 8100,
    },
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url === 'http://127.0.0.1:8100/api/bootstrap') {
        throw new Error('loopback spelling refused');
      }
      if (url === 'http://127.0.0.1:8000/api/bootstrap') {
        return { ok: false, json: async () => ({}) };
      }
      if (url === 'http://localhost:8100/api/bootstrap') {
        return { ok: true, json: async () => ({ wsAuthToken: 'electron-token' }) };
      }
      throw new Error(`Unexpected bootstrap URL: ${url}`);
    },
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
  });

  await connection.initialize();
  await wait(10);

  assert.deepEqual(fetchCalls, [
    'http://127.0.0.1:8100/api/bootstrap',
    'http://127.0.0.1:8000/api/bootstrap',
    'http://localhost:8100/api/bootstrap',
  ]);
  assert.equal(openedUrl, 'ws://127.0.0.1:8099?token=electron-token');
  assert.equal(connection.getBackendHttpBase(), 'http://localhost:8100');
  acknowledgeScope(connection, 'full-control');
  assert.equal(connection.getAuthorizationScope(), 'full-control');

  connection.getWs().onerror({ type: 'error' });
  assert.equal(connection.getAuthorizationScope(), 'read-only', 'socket errors must revoke the acknowledged UI scope immediately');

  acknowledgeScope(connection, 'full-control');
  connection.reconnect();
  assert.equal(connection.getAuthorizationScope(), 'read-only', 'manual reconnect must revoke the previous socket scope before async bootstrap');
  assert.equal(connection.getWs(), null, 'manual reconnect must detach the previous socket during async bootstrap');
  await wait(10);
}

async function testElectronPrefersIpcBootstrap() {
  const { createConnection } = await loadConnectionModule();
  let openedUrl = '';

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    close() {}
    send() {}
  }

  const fetchCalls = [];
  const ipcCalls = [];
  const windowRef = {
    location: {
      search: '',
      hostname: '127.0.0.1',
      protocol: 'http:',
      port: '8000',
    },
    electronAPI: {
      getBackendWsPort: async () => 8099,
      getBackendHttpPort: async () => 8100,
      getBackendBootstrap: async () => {
        ipcCalls.push('backend-bootstrap');
        return {
          ok: true,
          status: 200,
          port: 8100,
          body: {
            ok: true,
            wsAuthToken: 'ipc-token',
            aircraftControlToken: 'ipc-aircraft-token',
          },
        };
      },
    },
    fetch: async (url) => {
      fetchCalls.push(url);
      throw new Error(`renderer fetch blocked: ${url}`);
    },
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
  });

  await connection.initialize();
  await wait(10);

  assert.deepEqual(fetchCalls, [], 'Electron should not request session secrets through browser fetch');
  assert.deepEqual(ipcCalls, ['backend-bootstrap']);
  assert.equal(openedUrl, 'ws://127.0.0.1:8099?token=ipc-token&aircraftControlToken=ipc-aircraft-token');
  assert.equal(connection.getBackendHttpBase(), 'http://127.0.0.1:8100');
  acknowledgeScope(connection, 'full-control');
  assert.equal(connection.getAuthorizationScope(), 'full-control');
}

async function testElectronRetriesBootstrapBeforeOpeningReadOnlySocket() {
  const { createConnection } = await loadConnectionModule();
  const openedUrls = [];
  let bootstrapCalls = 0;

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrls.push(url);
      this.readyState = FakeWebSocket.OPEN;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    close() {}
    send() {}
  }

  const windowRef = {
    location: {
      search: '',
      hostname: '127.0.0.1',
      protocol: 'http:',
      port: '8000',
    },
    electronAPI: {
      getBackendWsPort: async () => 8099,
      getBackendHttpPort: async () => 8100,
      getBackendBootstrap: async () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) {
          return { ok: false, status: 0, port: 8100, body: { ok: false } };
        }
        return {
          ok: true,
          status: 200,
          port: 8100,
          body: { ok: true, wsAuthToken: 'startup-token' },
        };
      },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ wsAuthToken: '' }),
    }),
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
    reconnectDelay: 1,
  });

  await connection.initialize();
  assert.deepEqual(openedUrls, [], 'Electron must not silently open a read-only socket when startup bootstrap is early');

  await wait(20);
  assert.ok(bootstrapCalls >= 2, 'Electron should retry the privileged bootstrap automatically');
  assert.deepEqual(openedUrls, ['ws://127.0.0.1:8099?token=startup-token']);
}

async function testOverlappingElectronBootstrapCannotOverwriteCurrentConnectionState() {
  const { createConnection } = await loadConnectionModule();
  const openedUrls = [];
  const bootstrapResolvers = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      openedUrls.push(url);
      this.readyState = FakeWebSocket.OPEN;
    }

    close() {}
    send() {}
  }

  const windowRef = {
    location: {
      search: '',
      hostname: '127.0.0.1',
      protocol: 'http:',
      port: '8000',
    },
    electronAPI: {
      getBackendWsPort: async () => 8099,
      getBackendHttpPort: async () => 8100,
      getBackendBootstrap: () => new Promise((resolve) => bootstrapResolvers.push(resolve)),
    },
    fetch: async () => {
      throw new Error('Electron bootstrap should resolve through IPC');
    },
  };

  const connection = createConnection({
    windowRef,
    WebSocketRef: FakeWebSocket,
    defaultWsPort: 8099,
    defaultHttpPort: 8100,
  });

  const firstConnect = connection.initialize();
  await wait(0);
  assert.equal(bootstrapResolvers.length, 1);

  connection.reconnect();
  await wait(0);
  assert.equal(bootstrapResolvers.length, 2);

  bootstrapResolvers[1]({
    ok: true,
    status: 200,
    port: 9300,
    body: {
      ok: true,
      wsAuthToken: 'current-token',
      networkInfo: { wsPort: 9299 },
    },
  });
  await wait(5);
  assert.deepEqual(openedUrls, ['ws://127.0.0.1:9299?token=current-token']);
  assert.equal(connection.getBackendHttpBase(), 'http://127.0.0.1:9300');

  bootstrapResolvers[0]({
    ok: true,
    status: 200,
    port: 9200,
    body: {
      ok: true,
      wsAuthToken: 'stale-token',
      networkInfo: { wsPort: 9199 },
    },
  });
  await firstConnect;
  await wait(5);

  assert.deepEqual(openedUrls, ['ws://127.0.0.1:9299?token=current-token'], 'stale bootstrap must not open another socket');
  assert.equal(connection.getWsUrl(), 'ws://127.0.0.1:9299', 'stale bootstrap must not overwrite the active WS port');
  assert.equal(connection.getBackendHttpBase(), 'http://127.0.0.1:9300', 'stale bootstrap must not overwrite the active HTTP port');
}

async function run() {
  await testPortMismatchBootstrapFallback();
  await testDirectBackendBootstrap();
  await testPairedLanUrlKeepsAircraftScopeSeparate();
  await testPairedLanUrlUsesExplicitCustomWsPort();
  await testElectronLoopbackBootstrapFallback();
  await testElectronPrefersIpcBootstrap();
  await testElectronRetriesBootstrapBeforeOpeningReadOnlySocket();
  await testOverlappingElectronBootstrapCannotOverwriteCurrentConnectionState();
  console.log('✅ ws connection bootstrap tests passed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
