'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createViteTestServer } = require('./vite-test-server');

test('Vite fixtures use distinct loopback ports when the default port is unavailable', async () => {
  const defaultListener = http.createServer();
  const servers = [];
  try {
    await new Promise((resolve, reject) => {
      defaultListener.once('error', error => {
        if (['EADDRINUSE', 'EACCES'].includes(error.code)) resolve();
        else reject(error);
      });
      defaultListener.listen(5173, '127.0.0.1', resolve);
    });
    for (const label of ['first', 'second']) {
      const server = await createViteTestServer({
        configFile: false,
        root: path.resolve(__dirname, '../..'),
        logLevel: 'error',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: '127.0.0.1', port: 0, watch: null },
        plugins: [{ name: 'port-fixture', configureServer(vite) {
          vite.middlewares.use('/fixture', (_request, response) => response.end(label));
        } }],
      });
      servers.push(server);
      await server.listen();
      const address = server.httpServer.address();
      assert.equal(address.address, '127.0.0.1');
      assert.notEqual(address.port, 5173);
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture`);
      assert.equal(await response.text(), label, 'fixture middleware remains functional');
    }
    assert.notEqual(servers[0].httpServer.address().port, servers[1].httpServer.address().port);
  } finally {
    for (const server of servers) {
      await server.close();
      assert.equal(server.httpServer.listening, false);
    }
    if (defaultListener.listening) await new Promise(resolve => defaultListener.close(resolve));
  }
});
