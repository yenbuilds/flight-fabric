'use strict';

const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Own the listener so port 0 really requests an OS-assigned loopback port.
 * Vite 6's server.listen() treats a configured zero as its default port.
 * Middleware mode also avoids a reserve/close/rebind race between fixtures.
 */
async function createViteTestServer(config) {
  const { createServer } = await import(pathToFileURL(path.resolve(
    __dirname, '../../frontend/node_modules/vite/dist/node/index.js',
  )).href);
  const httpServer = http.createServer();
  const vite = await createServer({
    ...config,
    server: {
      ...config.server,
      middlewareMode: { server: httpServer },
      hmr: { server: httpServer },
    },
  });
  httpServer.on('request', vite.middlewares);

  async function close() {
    await vite.close();
    if (!httpServer.listening) return;
    await new Promise((resolve, reject) => {
      httpServer.close(error => error ? reject(error) : resolve());
      httpServer.closeAllConnections();
    });
  }

  return {
    httpServer,
    async listen() {
      try {
        await new Promise((resolve, reject) => {
          const failed = error => { httpServer.off('listening', ready); reject(error); };
          const ready = () => { httpServer.off('error', failed); resolve(); };
          httpServer.once('error', failed);
          httpServer.once('listening', ready);
          httpServer.listen(0, '127.0.0.1');
        });
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}

module.exports = { createViteTestServer };
