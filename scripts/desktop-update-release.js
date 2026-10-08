#!/usr/bin/env node
'use strict';

// Release signing is independent of Windows Authenticode. Private keys must be
// stored outside this checkout and must never be uploaded with the installer.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DOMAIN, VERSION, keyId, validatePayload, verifyManifest } = require('../electron/update-manifest');
const { publishedInstallerUrl, buildInstallerFileName, publishedInstallerAssetName } = require('./release-names');
const { FEED_URL } = require('../electron/update-feed');
const ROOT = path.resolve(__dirname, '..');

function argument(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

function privateKeyPath(value) {
  if (!value) throw new Error('Provide --private-key with a protected path outside the repository.');
  const resolved = path.resolve(value);
  const relative = path.relative(ROOT, resolved);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error('The release private key must be outside the repository, including outside .tmp.');
  }
  return resolved;
}

async function hashInstaller(file) {
  const hash = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { size, sha512: hash.digest('base64') };
}

async function main(args) {
  if (args.includes('--help') || args.length === 0) {
    console.log('FlightFabric desktop update release tools\n'
      + 'keygen --private-key <protected external path> --public-config <output JSON>\n'
      + 'sign --private-key <path> --version <x.y.z> --installer <verified NSIS EXE> --sequence <integer> --out <feed JSON> [--notes-file <text>]\n'
      + 'withdraw --private-key <path> --sequence <integer> --out <feed JSON>\n'
      + 'verify --manifest <feed JSON> --public-config <trust JSON>\n'
      + 'Signing requires FF_UPDATE_SIGNING_PASSPHRASE in the environment. Never put it on the command line.\n'
      + 'Installer filenames must match the versioned NSIS build or published asset name.\n'
      + 'Metadata expires after 14 days. Re-sign with a higher sequence to renew. Nothing is published.');
    return;
  }
  const command = args[0];
  if (command === 'verify') {
    const trust = JSON.parse(await fs.readFile(argument(args, '--public-config'), 'utf8'));
    const verified = verifyManifest(await fs.readFile(argument(args, '--manifest'), 'utf8'), trust.keys);
    console.log(`Verified update sequence ${verified.payload.sequence}: ${verified.payload.release?.version || 'withdrawn'}`);
    return;
  }
  const keyFile = privateKeyPath(argument(args, '--private-key'));
  const passphrase = process.env.FF_UPDATE_SIGNING_PASSPHRASE;
  if (!passphrase || passphrase.length < 16) throw new Error('Set a strong FF_UPDATE_SIGNING_PASSPHRASE (at least 16 characters) before signing or creating a key.');
  if (command === 'keygen') {
    const publicFile = argument(args, '--public-config');
    if (!publicFile) throw new Error('Provide --public-config for the public trust configuration.');
    const pair = crypto.generateKeyPairSync('ed25519');
    const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
    const trust = { enabled: true, feedUrl: FEED_URL, keys: [{ id: keyId(publicDer), publicKey: publicDer.toString('base64') }] };
    // Exclusive writes refuse replacement of an existing signing identity.
    await fs.writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(publicFile, `${JSON.stringify(trust, null, 2)}\n`, { flag: 'wx' });
    console.log('Created encrypted release key and public configuration. Back up the private key and passphrase separately.');
    return;
  }
  if (!['sign', 'withdraw'].includes(command)) throw new Error('Unknown command. Use --help.');
  const sequence = Number(argument(args, '--sequence'));
  const output = argument(args, '--out');
  if (!output) throw new Error('Provide --out for the signed public feed.');
  let release = null;
  if (command === 'sign') {
    const version = argument(args, '--version');
    if (!VERSION.test(version)) throw new Error('Provide a plain x.y.z release version.');
    const installer = argument(args, '--installer') || path.join(ROOT, 'dist', 'electron', buildInstallerFileName(version));
    // Catch ordinary selection mistakes; naming does not prove binary identity.
    const installerNames = [buildInstallerFileName(version), publishedInstallerAssetName(version)];
    if (!installerNames.includes(path.basename(installer))) {
      throw new Error('Select the versioned NSIS installer for the requested release.');
    }
    const notesFile = argument(args, '--notes-file');
    release = { version, kind: 'nsis', url: publishedInstallerUrl(version), ...(await hashInstaller(installer)),
      notes: notesFile ? (await fs.readFile(notesFile, 'utf8')).trim() : '' };
  }
  const now = Date.now();
  const payload = validatePayload({ schema: 1, channel: 'public', platform: 'win32-x64', sequence,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 14 * 86400000).toISOString(), release }, now);
  const privateKey = crypto.createPrivateKey({ key: await fs.readFile(keyFile), passphrase });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The release key must be Ed25519.');
  const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = { keyId: keyId(publicDer), payload: bytes.toString('base64'),
    signature: crypto.sign(null, Buffer.concat([DOMAIN, bytes]), privateKey).toString('base64') };
  await fs.writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx' });
  console.log(`Prepared signed update sequence ${sequence}. Verify the uploaded installer before promoting this feed.`);
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  // Do not print crypto/provider errors: they may contain sensitive input.
  console.error('Update release preparation failed. Check arguments, key/passphrase access, output paths, installer name/version and metadata bounds. Use --help for requirements.');
  process.exitCode = 1;
});
module.exports = { main, hashInstaller, privateKeyPath };
