'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireRuntimeOwnerLock } = require('../electron/runtime-owner-lock');

const OWNER_ENV = 'FF_CHECKOUT_BUILD_OWNER';

function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * One owner protects dependency installation and generated build output in a
 * checkout. The OS listener, not the metadata file, provides crash-safe exclusion.
 * Sequential subprocesses of the owning build inherit its bounded lifetime.
 * This is tooling coordination, not an authorization/security boundary.
 */
async function withBuildOwnership({ root, label }, operation) {
  const realRoot = fs.realpathSync(root);
  const rootKey = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const suffix = crypto.createHash('sha256').update(rootKey).digest('hex');
  const metadataPath = path.join(realRoot, '.tmp', 'build-owner.json');
  const inherited = (() => {
    try { return JSON.parse(process.env[OWNER_ENV] || 'null'); } catch { return null; }
  })();
  const lock = await acquireRuntimeOwnerLock({ owner: label,
    ...(process.platform === 'win32'
      ? { path: `\\\\.\\pipe\\flightfabric-build-${suffix.slice(0, 32)}` }
      // A hash collision only refuses a build; it never admits two owners.
      : { port: 20000 + (parseInt(suffix.slice(0, 8), 16) % 20000) }),
  });
  if (!lock.acquired) {
    const owner = readOwner(metadataPath);
    if (inherited?.root === rootKey && inherited.pid !== process.pid
      && inherited.nonce === owner?.nonce && inherited.pid === owner?.pid
      && processExists(inherited.pid)) {
      return operation();
    }
    const detail = owner?.label && processExists(owner.pid) ? ` (${owner.label}, PID ${owner.pid})` : '';
    const error = new Error(`Another FlightFabric build is using this checkout${detail}. `
      + 'Wait for it to finish, then retry, or build in a separate checkout. '
      + 'This command has not changed dependencies or build output.');
    error.code = 'FF_BUILD_BUSY';
    throw error;
  }

  const owner = { root: rootKey, label, pid: process.pid, nonce: crypto.randomUUID() };
  const previous = process.env[OWNER_ENV];
  const cleanup = () => {
    if (readOwner(metadataPath)?.nonce === owner.nonce) fs.unlinkSync(metadataPath);
  };
  const onExit = () => { try { cleanup(); } catch { /* The OS still releases the listener. */ } };
  process.once('exit', onExit);
  try {
    const directory = path.dirname(metadataPath);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) {
      throw new Error('Build ownership metadata directory must not be a link or junction.');
    }
    // Replaced only while holding the OS lock, so a crashed owner's record is
    // harmless. Never steal a live lock or ask the user to delete a lock file.
    fs.writeFileSync(metadataPath, JSON.stringify(owner), { mode: 0o600 });
    process.env[OWNER_ENV] = JSON.stringify(owner);
    return await operation();
  } finally {
    process.removeListener('exit', onExit);
    if (previous === undefined) delete process.env[OWNER_ENV];
    else process.env[OWNER_ENV] = previous;
    try { cleanup(); } finally { await lock.release(); }
  }
}

module.exports = { withBuildOwnership };
