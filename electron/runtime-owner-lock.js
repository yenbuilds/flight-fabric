'use strict';

const net = require('net');
const crypto = require('crypto');
const os = require('os');

// An OS-owned local listener is a crash-safe mutex. Windows uses a per-user
// named pipe, avoiding collisions with unrelated TCP/ephemeral ports. Electron
// holds it for its full lifetime; the standalone wrapper holds it while its
// backend lives.
const DEFAULT_RUNTIME_OWNER_LOCK_PORT = 47831;
const RUNTIME_OWNER_LOCK_HOST = '127.0.0.1';

function getDefaultRuntimeOwnerPipePath() {
  // The home-directory lookup follows mutable HOME/USERPROFILE state on
  // Windows. Electron and a standalone launcher can therefore represent the
  // same signed-in user with different home paths. The OS account name comes
  // from the account API and stays stable across those launch environments.
  // A same-name collision is fail-safe: it can only over-serialize launches.
  const identity = os.userInfo().username.toLowerCase();
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\flight-fabric-runtime-owner-v1-${suffix}`;
}

function normalizeLockPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : DEFAULT_RUNTIME_OWNER_LOCK_PORT;
}

function acquireRuntimeOwnerLock(options = {}) {
  const owner = String(options.owner || 'unknown');
  const usePipe = process.platform === 'win32' && options.port === undefined && !options.host;
  const path = usePipe ? (options.path || getDefaultRuntimeOwnerPipePath()) : null;
  const host = path ? null : (options.host || RUNTIME_OWNER_LOCK_HOST);
  const port = path ? null : normalizeLockPort(options.port);

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    let settled = false;
    let released = false;

    server.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
        resolve({ acquired: false, host, port, path, owner, error });
        return;
      }
      reject(error);
    });

    const onListening = () => {
      if (settled) return;
      settled = true;
      resolve({
        acquired: true,
        host,
        port,
        path,
        owner,
        async release() {
          if (released) return true;
          released = true;
          if (!server.listening) return true;
          return new Promise((releaseResolve) => {
            server.close(() => releaseResolve(true));
          });
        },
      });
    };

    if (path) server.listen(path, onListening);
    else server.listen({ host, port, exclusive: true }, onListening);
  });
}

module.exports = {
  DEFAULT_RUNTIME_OWNER_LOCK_PORT,
  RUNTIME_OWNER_LOCK_HOST,
  acquireRuntimeOwnerLock,
  getDefaultRuntimeOwnerPipePath,
  normalizeLockPort,
};
