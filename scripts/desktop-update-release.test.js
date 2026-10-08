'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyManifest, verifyInstaller } = require('../electron/update-manifest');
const { privateKeyPath } = require('./desktop-update-release');
const { buildInstallerFileName, buildPortableFileName, publishedInstallerAssetName } = require('./release-names');

test('release CLI creates encrypted disposable keys, signs exact bytes, verifies and withdraws', async (t) => {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'ff-update-signing-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Disposable synthetic signing identity, never used by any app/release.
  const env = { ...process.env, FF_UPDATE_SIGNING_PASSPHRASE: crypto.randomBytes(32).toString('hex') };
  const invoke = args => execFileSync(process.execPath, [path.join(__dirname, 'desktop-update-release.js'), ...args], { env, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  const privateFile = path.join(directory, 'key.pem'), publicFile = path.join(directory, 'trust.json');
  const installer = path.join(directory, buildInstallerFileName('0.13.0')), manifest = path.join(directory, 'feed.json');
  fs.writeFileSync(installer, 'Deliberately inert installer fixture; never execute.');
  invoke(['keygen', '--private-key', privateFile, '--public-config', publicFile]);
  assert.match(fs.readFileSync(privateFile, 'utf8'), /ENCRYPTED PRIVATE KEY/);
  const trust = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
  assert(!JSON.stringify(trust).includes(env.FF_UPDATE_SIGNING_PASSPHRASE));
  invoke(['sign', '--private-key', privateFile, '--version', '0.13.0', '--installer', installer, '--sequence', '1', '--out', manifest]);
  const verified = verifyManifest(fs.readFileSync(manifest, 'utf8'), trust.keys);
  await verifyInstaller(installer, verified.payload.release);
  assert.match(invoke(['verify', '--manifest', manifest, '--public-config', publicFile]), /Verified update sequence 1/);
  assert.throws(() => invoke(['keygen', '--private-key', privateFile, '--public-config', publicFile]), 'existing identities must never be overwritten');
  // Realistic release selection mistakes: nearby portable output or an older installer.
  for (const [index, name] of [buildPortableFileName('0.13.0'), buildInstallerFileName('0.12.1'), publishedInstallerAssetName('0.12.1')].entries()) {
    const wrongInstaller = path.join(directory, name);
    const wrongManifest = path.join(directory, 'wrong-' + index + '.json');
    fs.copyFileSync(installer, wrongInstaller);
    assert.throws(() => invoke(['sign', '--private-key', privateFile, '--version', '0.13.0', '--installer', wrongInstaller, '--sequence', '2', '--out', wrongManifest]));
    assert.equal(fs.existsSync(wrongManifest), false, 'wrong artifact must not produce a promotable feed');
  }
  const publishedInstaller = path.join(directory, publishedInstallerAssetName('0.13.0'));
  fs.copyFileSync(installer, publishedInstaller);
  const publishedManifest = path.join(directory, 'published-name.json');
  invoke(['sign', '--private-key', privateFile, '--version', '0.13.0', '--installer', publishedInstaller, '--sequence', '2', '--out', publishedManifest]);
  await verifyInstaller(publishedInstaller, verifyManifest(fs.readFileSync(publishedManifest, 'utf8'), trust.keys).payload.release);
  const withdrawn = path.join(directory, 'withdrawn.json');
  invoke(['withdraw', '--private-key', privateFile, '--sequence', '2', '--out', withdrawn]);
  assert.equal(verifyManifest(fs.readFileSync(withdrawn, 'utf8'), trust.keys, { ledger: verified.ledger }).payload.release, null);
  assert.throws(() => privateKeyPath(path.join(__dirname, '../.tmp/forbidden-release-key.pem')), /outside/);
});
