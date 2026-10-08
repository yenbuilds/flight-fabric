'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DOMAIN, keyId, verifyManifest, verifyInstaller, versionGreater } = require('./update-manifest');
const { createSignedFeed } = require('./update-feed');
const { publishedInstallerUrl } = require('../scripts/release-names');

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  const keys = [{ id: keyId(der), publicKey: der.toString('base64') }];
  const now = Date.now();
  const data = Buffer.from('Deliberately synthetic installer bytes for integrity tests; never executable.');
  const payload = { schema: 1, channel: 'public', platform: 'win32-x64', sequence: 1,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(),
    release: { version: '0.13.0', kind: 'nsis', url: publishedInstallerUrl('0.13.0'), notes: 'Update test',
      size: data.length, sha512: crypto.createHash('sha512').update(data).digest('base64') } };
  const sign = (value = payload) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return JSON.stringify({ keyId: keys[0].id, payload: bytes.toString('base64'),
      signature: crypto.sign(null, Buffer.concat([DOMAIN, bytes]), pair.privateKey).toString('base64') });
  };
  return { keys, now, data, payload, sign };
}

test('authenticates release bytes without Windows code signing', () => {
  const f = fixture();
  assert.deepEqual(verifyManifest(f.sign(), f.keys).payload, f.payload);
  const changed = JSON.parse(f.sign());
  changed.payload = Buffer.from(JSON.stringify({ ...f.payload, sequence: 999 })).toString('base64');
  assert.throws(() => verifyManifest(JSON.stringify(changed), f.keys), /signature/);
  assert.throws(() => verifyManifest(f.sign(), fixture().keys), /trusted/);
});

test('rejects expired, future, wrong-platform, oversized and unexpected-origin metadata', () => {
  const f = fixture();
  for (const edit of [
    { expiresAt: new Date(f.now - 1).toISOString() },
    { issuedAt: new Date(f.now + 600000).toISOString() },
    { platform: 'win32-arm64' },
    { release: { ...f.payload.release, version: '0.13.0-beta.1' } },
    { release: { ...f.payload.release, url: 'https://example.org/update.exe' } },
    { release: { ...f.payload.release, size: 3 * 1024 ** 3 } },
  ]) assert.throws(() => verifyManifest(f.sign({ ...f.payload, ...edit }), f.keys));
  assert.throws(() => verifyManifest(' '.repeat(65537), f.keys), /large/);
});

test('sequence rollback and conflicting reuse fail; signed withdrawal works', () => {
  const f = fixture();
  const accepted = verifyManifest(f.sign(), f.keys);
  assert.throws(() => verifyManifest(f.sign(), f.keys, { ledger: { ...accepted.ledger, sequence: 2 } }), /Outdated/);
  assert.throws(() => verifyManifest(f.sign({ ...f.payload, release: null }), f.keys, { ledger: accepted.ledger }), /conflicting/);
  assert.equal(verifyManifest(f.sign({ ...f.payload, sequence: 2, release: null }), f.keys, { ledger: accepted.ledger }).payload.release, null);
  assert.equal(versionGreater('0.13.0', '0.12.9'), true);
  assert.equal(versionGreater('0.13.0-beta.1', '0.12.9'), false);
  assert.equal(versionGreater('0.12.9', '0.13.0'), false);
});

test('streaming verification rejects truncated and modified cached files', async (t) => {
  const f = fixture();
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../.tmp/update-integrity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic.bin');
  await fs.writeFile(file, f.data);
  await verifyInstaller(file, f.payload.release);
  await fs.writeFile(file, Buffer.alloc(f.data.length, 1));
  await assert.rejects(verifyInstaller(file, f.payload.release), /verified/);
  await fs.writeFile(file, f.data.subarray(1));
  await assert.rejects(verifyInstaller(file, f.payload.release), /incomplete/);
});

test('accepted sequence persists across new feed instances and corrupt local history fails closed', async (t) => {
  const f = fixture();
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../.tmp/update-feed-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, 'ledger.json');
  const trust = { keys: f.keys };
  await createSignedFeed({ trust, ledgerPath, fetch: async () => f.sign({ ...f.payload, sequence: 2 }) }).read();
  await assert.rejects(createSignedFeed({ trust, ledgerPath, fetch: async () => f.sign() }).read(), /Outdated/);
  await fs.writeFile(ledgerPath, '{}');
  await assert.rejects(createSignedFeed({ trust, ledgerPath, fetch: async () => f.sign() }).read(), /history/);
});

module.exports = { fixture };

test('signed offer, offline retry, withdrawal and forward fix work through the coordinator and persisted ledger', async (t) => {
  const { createUpdateService } = require('./update-service');
  const { updateError } = require('./update-manifest');
  const f = fixture();
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../.tmp/update-release-scenario-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, 'accepted.json');
  const receiptPath = path.join(directory, 'pending.json');
  const trust = { enabled: true, keys: f.keys };
  let offered = f.sign();
  let offline = false;
  const fetch = async () => {
    if (offline) throw updateError('network', 'Could not check for updates.');
    return offered;
  };
  const events = [];
  const calls = [];
  const options = {
    supported: true, trust, cachePath: directory, receiptPath,
    feed: createSignedFeed({ trust, ledgerPath, fetch }),
    createEngine: ({ release }) => ({
      download: async () => {
        const file = path.join(directory, release.version + '.inert');
        await fs.writeFile(file, f.data); calls.push('download:' + release.version); return file;
      },
      install: () => { calls.push('install:' + release.version); }, dispose() {},
    }),
    prepare: async () => { calls.push('prepare'); }, recover: async () => true,
    handoff: async install => { await install(); }, onState: state => events.push(state),
  };
  const service = createUpdateService({ ...options, currentVersion: '0.12.1' });
  t.after(() => service.dispose());
  await service.download();
  assert.equal(service.snapshot().phase, 'ready');
  offline = true;
  await service.install();
  assert.equal(service.snapshot().phase, 'ready');
  assert.match(service.snapshot().message, /check for updates/);
  assert.deepEqual(calls, ['download:0.13.0'], 'offline eligibility check never stops the running app');
  offline = false;
  offered = f.sign({ ...f.payload, sequence: 2, release: null });
  await service.install();
  assert.equal(service.snapshot().phase, 'current');
  assert.equal(service.snapshot().version, '');
  assert.equal(calls.includes('prepare'), false, 'withdrawal invalidates an already downloaded update');
  // A restarted client must retain the signed withdrawal, even if an old offer reappears.
  offered = f.sign();
  await assert.rejects(createSignedFeed({ trust, ledgerPath, fetch }).read(), /Outdated/);
  const correctedRelease = { ...f.payload.release, version: '0.13.1', url: publishedInstallerUrl('0.13.1'), notes: 'Forward fix fixture' };
  offered = f.sign({ ...f.payload, sequence: 3, release: correctedRelease });
  await service.download();
  assert.equal(service.snapshot().phase, 'ready');
  await service.install();
  assert.deepEqual(calls, ['download:0.13.0', 'download:0.13.1', 'prepare', 'install:0.13.1']);
  assert.equal(JSON.parse(await fs.readFile(ledgerPath, 'utf8')).sequence, 3);
  assert.equal(JSON.parse(await fs.readFile(receiptPath, 'utf8')).version, '0.13.1');
  const restarted = createUpdateService({ ...options, currentVersion: '0.13.1', feed: createSignedFeed({ trust, ledgerPath, fetch }) });
  t.after(() => restarted.dispose());
  await restarted.completeStartup(false);
  assert.equal(restarted.snapshot().phase, 'error');
  assert.equal(JSON.parse(await fs.readFile(receiptPath, 'utf8')).version, '0.13.1', 'failed startup keeps its repair receipt');
  await restarted.completeStartup(true);
  assert.match(restarted.snapshot().message, /Updated to version 0.13.1/);
  await assert.rejects(fs.stat(receiptPath), { code: 'ENOENT' });
  await restarted.check();
  assert.equal(restarted.snapshot().phase, 'current');
  assert.equal(calls.filter(call => call.startsWith('install:')).length, 1, 'healthy restart never starts another installation');
});
