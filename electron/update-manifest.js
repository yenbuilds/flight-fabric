'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');

const DOMAIN = Buffer.from('FlightFabric desktop update v1\0');
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

function updateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function versionGreater(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) return false;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

function decodeBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw updateError('trust', 'Invalid update encoding.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw updateError('trust', 'Invalid update encoding.');
  return bytes;
}

function keyId(publicKeyDer) {
  return crypto.createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
}

function validateKeys(keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 4) throw updateError('configuration', 'In-app updates are not enabled in this build.');
  const seen = new Set();
  return keys.map((entry) => {
    const der = decodeBase64(entry?.publicKey, 128);
    const key = crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ed25519' || entry.id !== keyId(der) || seen.has(entry.id)) {
      throw updateError('configuration', 'Invalid update trust configuration.');
    }
    seen.add(entry.id);
    return { id: entry.id, key };
  });
}

function validatePayload(payload, now = Date.now()) {
  if (!payload || payload.schema !== 1 || payload.channel !== 'public' || payload.platform !== 'win32-x64'
      || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) throw updateError('trust', 'Invalid update metadata.');
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 300000
      || expires <= now || expires <= issued || expires - issued > MAX_VALIDITY_MS) {
    throw updateError('expired', 'Update information has expired or your computer clock is incorrect. Check again later.');
  }
  if (payload.release === null) return payload;
  const release = payload.release;
  if (!release || !VERSION.test(release.version) || release.kind !== 'nsis'
      || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > MAX_INSTALLER_BYTES
      || typeof release.notes !== 'string' || release.notes.length > 2000
      || decodeBase64(release.sha512, 64).length !== 64) throw updateError('trust', 'Invalid update release.');
  let url;
  try { url = new URL(release.url); } catch { throw updateError('trust', 'Invalid update location.'); }
  const prefix = `/yenbuilds/flight-fabric/releases/download/v${release.version}/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
      || url.port || url.search || url.hash || !url.pathname.startsWith(prefix)
      || !/^[A-Za-z0-9._-]+\.exe$/.test(url.pathname.slice(prefix.length))) {
    throw updateError('trust', 'Invalid update location.');
  }
  return payload;
}

function verifyManifest(raw, keys, { now = Date.now(), ledger = null } = {}) {
  if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) throw updateError('trust', 'Update information is too large.');
  const envelope = JSON.parse(raw);
  const trusted = validateKeys(keys).find((entry) => entry.id === envelope.keyId);
  if (!trusted) throw updateError('trust', 'This update was not signed by a trusted release key.');
  const bytes = decodeBase64(envelope.payload, MAX_MANIFEST_BYTES / 2);
  const signature = decodeBase64(envelope.signature, 64);
  if (signature.length !== 64 || !crypto.verify(null, Buffer.concat([DOMAIN, bytes]), trusted.key, signature)) {
    throw updateError('trust', 'The update signature could not be verified.');
  }
  const payload = validatePayload(JSON.parse(bytes.toString('utf8')), now);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (ledger && (payload.sequence < ledger.sequence
      || (payload.sequence === ledger.sequence && digest !== ledger.digest))) {
    throw updateError('trust', 'Outdated or conflicting update information was rejected.');
  }
  return { payload, ledger: { sequence: payload.sequence, digest } };
}

async function verifyInstaller(file, release, signal) {
  try {
    const info = await fs.promises.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== release.size) throw updateError('integrity', 'The downloaded update is incomplete. Download it again.');
    const hash = crypto.createHash('sha512');
    let size = 0;
    await pipeline(fs.createReadStream(file), new Writable({
      write(chunk, _encoding, done) {
        size += chunk.length;
        if (size > release.size) return done(updateError('integrity', 'The update file changed during verification.'));
        hash.update(chunk);
        done();
      },
    }), { signal });
    if (size !== release.size || hash.digest('base64') !== release.sha512) throw updateError('integrity', 'The downloaded update could not be verified. Download it again.');
  } catch (error) {
    if (signal?.aborted || error.code === 'integrity') throw error;
    // Cleanup tools and antivirus can remove or lock a previously verified cache file.
    throw updateError('integrity', 'The downloaded update is missing or cannot be read. Download it again.');
  }
}

module.exports = { DOMAIN, MAX_MANIFEST_BYTES, MAX_INSTALLER_BYTES, VERSION, keyId, validateKeys, validatePayload, verifyManifest, verifyInstaller, versionGreater, updateError };
