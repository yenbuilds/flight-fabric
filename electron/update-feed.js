'use strict';

const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_MANIFEST_BYTES, verifyManifest, updateError } = require('./update-manifest');

const FEED_URL = 'https://raw.githubusercontent.com/yenbuilds/ff-releases/main/desktop/windows-x64.json';

function fetchManifest(url = FEED_URL, { signal, timeoutMs = 15000 } = {}) {
  if (url !== FEED_URL) return Promise.reject(updateError('configuration', 'Invalid update feed configuration.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = https.get(url, { signal, headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'FlightFabric-Updater' } }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        req.destroy();
        return finish(updateError('network', 'Update information is unavailable. Try again later.'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_MANIFEST_BYTES) {
          req.destroy();
          finish(updateError('trust', 'Update information is too large.'));
        } else chunks.push(chunk);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      res.on('aborted', () => finish(updateError('network', 'The update check was interrupted.')));
      res.on('error', () => finish(updateError('network', 'The update check failed. Try again.')));
    });
    req.on('error', () => finish(updateError(signal?.aborted ? 'cancelled' : 'network', signal?.aborted ? 'Update check cancelled.' : 'Could not check for updates. Check your connection and try again.')));
    timer = setTimeout(() => {
      req.destroy();
      finish(updateError('network', 'The update check timed out. Try again.'));
    }, timeoutMs);
  });
}

function createSignedFeed({ trust, ledgerPath, fetch = fetchManifest, now = Date.now }) {
  let latest = null;
  return {
    get latest() { return latest; },
    async read(signal) {
      let ledger = null;
      try {
        const text = await fs.readFile(ledgerPath, 'utf8');
        if (text.length > 1024) throw new Error('Invalid ledger');
        ledger = JSON.parse(text);
        if (!Number.isSafeInteger(ledger.sequence) || ledger.sequence < 1 || !/^[a-f0-9]{64}$/.test(ledger.digest)) throw new Error('Invalid ledger');
      } catch (error) {
        if (error.code !== 'ENOENT') throw updateError('storage', 'Update history could not be read. Use the manual download or contact support.');
      }
      const result = verifyManifest(await fetch(trust.feedUrl, { signal }), trust.keys, { now: now(), ledger });
      if (signal?.aborted) throw updateError('cancelled', 'Update check cancelled.');
      await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
      const temporary = `${ledgerPath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(result.ledger), { mode: 0o600 });
      await fs.rename(temporary, ledgerPath);
      latest = result.payload;
      return latest;
    },
  };
}

module.exports = { FEED_URL, fetchManifest, createSignedFeed };
