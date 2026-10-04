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
  assert.equal(connection.isAuthorizationAcknowledged(), false, 'a socket and credentials do not acknowledge access');
  acknowledgeScope(connection, 'read-only');
  assert.equal(connection.isAuthorizationAcknowledged(), true, 'a genuine viewer acknowledgement is distinct from the initial read-only fallback');
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
  assert.equal(connection.isAuthorizationAcknowledged(), false, 'socket errors invalidate the previous acknowledgement');

  acknowledgeScope(connection, 'full-control');
  connection.reconnect();
  assert.equal(connection.getAuthorizationScope(), 'read-only', 'manual reconnect must revoke the previous socket scope before async bootstrap');
  assert.equal(connection.isAuthorizationAcknowledged(), false, 'a replacement connection waits for a new acknowledgement');
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

async function testElectronRecoversRejectedCredentials() {
  const { createConnection } = await loadConnectionModule();
  for (const rejectedScope of ['read-only', 'aircraft-control']) {
    const sockets = [];
    const messages = [];
    let bootstrapCalls = 0;
    let closes = 0;
    let opens = 0;

    class FakeWebSocket {
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        sockets.push(this);
      }
      close() { this.readyState = 3; }
      send() {}
    }

    const connection = createConnection({
      windowRef: {
        location: { search: '', hostname: '127.0.0.1', protocol: 'http:', port: '8000' },
        electronAPI: {
          getBackendBootstrap: async () => ({ wsAuthToken: ++bootstrapCalls === 1 ? 'old-session' : 'new-session' }),
        },
      },
      WebSocketRef: FakeWebSocket,
      reconnectDelay: 5,
      onOpen: () => { opens += 1; },
      onClose: () => { closes += 1; },
      onMessage: message => messages.push(message),
    });

    await connection.initialize();
    const oldSocket = connection.getWs();
    oldSocket.onopen();
    // Keep queued callbacks to verify the retired socket cannot revoke or
    // overwrite the replacement connection after asynchronous recovery.
    const staleMessage = oldSocket.onmessage;
    const staleOpen = oldSocket.onopen;
    const staleClose = oldSocket.onclose;
    const staleError = oldSocket.onerror;
    acknowledgeScope(connection, rejectedScope);
    assert.equal(connection.getWs(), null, 'the desktop must close a socket whose credentials were rejected');
    assert.equal(connection.isAuthorizationAcknowledged(), false, 'recovery waits for a fresh grant');
    assert.equal(connection.getAuthorizationScope(), 'read-only');
    assert.equal(closes, 1, 'retiring the socket must clear pending requests and page authorization');

    await wait(20);
    assert.equal(bootstrapCalls, 2, 'a rejected desktop credential must trigger fresh bootstrap automatically');
    assert.equal(sockets.length, 2);
    assert.equal(connection.getWs().url, 'ws://127.0.0.1:8099?token=new-session');
    connection.getWs().onopen();
    assert.equal(connection.getAuthorizationScope(), 'read-only', 'fresh credentials alone still cannot grant access');
    acknowledgeScope(connection, 'full-control');
    assert.equal(connection.getAuthorizationScope(), 'full-control');

    staleMessage({ data: JSON.stringify({ type: 'authorizationScope', scope: rejectedScope }) });
    staleOpen();
    staleClose({});
    staleError({});
    assert.equal(connection.getWs(), sockets[1], 'queued callbacks from the retired socket cannot close its replacement');
    assert.equal(connection.getAuthorizationScope(), 'full-control');
    assert.equal(connection.isAuthorizationAcknowledged(), true);
    assert.equal(opens, 2, 'a queued open event from the retired socket must not reset page state');
    assert.deepEqual(messages, [{ type: 'authorizationScope', scope: 'full-control' }]);
    await wait(15);
    assert.equal(bootstrapCalls, 2, 'successful recovery and stale callbacks must not start another reconnect');
  }
}

async function testManualReconnectCancelsPendingDesktopRetry() {
  const { createConnection } = await loadConnectionModule();
  const sockets = [];
  let bootstrapCalls = 0;
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = FakeWebSocket.OPEN; sockets.push(this); }
    close() { this.readyState = 3; }
    send() {}
  }
  const connection = createConnection({
    windowRef: {
      location: { search: '', hostname: '127.0.0.1', protocol: 'http:', port: '8000' },
      electronAPI: { getBackendBootstrap: async () => ({ wsAuthToken: `session-${++bootstrapCalls}` }) },
    },
    WebSocketRef: FakeWebSocket,
    reconnectDelay: 30,
  });
  await connection.initialize();
  acknowledgeScope(connection, 'read-only');
  // The user can reconnect while the automatic retry is waiting. Its timer
  // must not retire the newly authorized socket after the manual recovery.
  connection.reconnect();
  await wait(0);
  assert.equal(sockets.length, 2);
  const replacement = connection.getWs();
  replacement.onopen();
  acknowledgeScope(connection, 'full-control');
  await wait(50);
  assert.equal(bootstrapCalls, 2, 'manual recovery must cancel the pending automatic retry');
  assert.equal(connection.getWs(), replacement);
  assert.equal(connection.getAuthorizationScope(), 'full-control');
  assert.equal(connection.isAuthorizationAcknowledged(), true);
}

async function testBrowserKeepsAcknowledgedLimitedAccess() {
  const { createConnection } = await loadConnectionModule();
  for (const scope of ['read-only', 'aircraft-control']) {
    let bootstrapCalls = 0;
    class FakeWebSocket {
      static OPEN = 1;
      constructor() { this.readyState = FakeWebSocket.OPEN; }
      close() { throw new Error('An acknowledged browser scope must not trigger desktop recovery'); }
      send() {}
    }
    const messages = [];
    const connection = createConnection({
      windowRef: {
        location: { search: '', hostname: '192.168.50.49', protocol: 'http:', port: '8100' },
        fetch: async () => {
          bootstrapCalls += 1;
          return { ok: true, json: async () => ({ wsAuthToken: '' }) };
        },
      },
      WebSocketRef: FakeWebSocket,
      reconnectDelay: 5,
      onMessage: message => messages.push(message),
    });
    await connection.initialize();
    acknowledgeScope(connection, scope);
    await wait(15);
    assert.equal(connection.getAuthorizationScope(), scope);
    assert.equal(connection.isAuthorizationAcknowledged(), true);
    assert.equal(bootstrapCalls, 1, 'phone/browser viewers and paired controls must remain connected at their granted scope');
    assert.deepEqual(messages, [{ type: 'authorizationScope', scope }]);
  }
}

async function testDesktopRecoversAgainstBackendWithRotatedToken() {
  const { createConnection } = await loadConnectionModule();
  const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
  const { createWsServer } = require(resolveBackendRuntimeFile('core/ws-bootstrap.js'));
  const WebSocket = require('ws');
  class DesktopWebSocket extends WebSocket {
    constructor(url) { super(url, { origin: 'http://127.0.0.1:8000' }); }
  }
  const serverScopes = [];
  let bootstrapCalls = 0;
  const wss = createWsServer({
    wsPort: 0,
    wsAuthToken: 'current-backend-session',
    Debug: { log() {} },
    tlog() {},
    onClientConnected: socket => serverScopes.push(socket.__ffPrivilegedClient ? 'full-control' : 'read-only'),
    onClientMessage() {},
  });
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  let connection;
  try {
    let resolveAuthorized;
    const authorized = new Promise(resolve => { resolveAuthorized = resolve; });
    connection = createConnection({
      windowRef: {
        location: { search: '', hostname: '127.0.0.1', protocol: 'http:', port: '8000' },
        electronAPI: {
          getBackendBootstrap: async () => ({
            // Model a backend restart between the first bootstrap response
            // and the websocket handshake. The next IPC fetch is current.
            wsAuthToken: ++bootstrapCalls === 1 ? 'previous-backend-session' : 'current-backend-session',
            networkInfo: { wsPort: wss.address().port },
          }),
        },
      },
      WebSocketRef: DesktopWebSocket,
      reconnectDelay: 5,
      onMessage: message => { if (message.scope === 'full-control') resolveAuthorized(); },
    });
    await connection.initialize();
    let deadline;
    try {
      await Promise.race([authorized, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Desktop remained a viewer after the backend token changed')), 2000);
      })]);
    } finally { clearTimeout(deadline); }
    assert.deepEqual(serverScopes, ['read-only', 'full-control'], 'the real backend accepts stale local credentials as a viewer, then grants access after fresh bootstrap');
    assert.equal(bootstrapCalls, 2);
    assert.equal(connection.getAuthorizationScope(), 'full-control');
    assert.equal(connection.isAuthorizationAcknowledged(), true);
  } finally {
    const socket = connection?.getWs();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.terminate();
    }
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
  }
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
  await testElectronRecoversRejectedCredentials();
  await testManualReconnectCancelsPendingDesktopRetry();
  await testBrowserKeepsAcknowledgedLimitedAccess();
  await testDesktopRecoversAgainstBackendWithRotatedToken();
  console.log('✅ ws connection bootstrap tests passed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
