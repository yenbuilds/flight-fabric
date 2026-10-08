'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const manifest = require('../vc-runtime.json');
const { verifyRuntimeInstaller } = require('../windows-runtime');

const destination = path.resolve(__dirname, '..', 'resources', 'vc-runtime');

function verifyMicrosoftSignature(file) {
  if (process.platform !== 'win32') throw new Error('Windows runtime packaging requires Windows signature verification.');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'check-vc-runtime-signature.ps1'), '-InstallerPath', file, '-ExpectedVersion', manifest.version,
  ], { windowsHide: true, timeout: 60000, stdio: 'pipe' });
}

async function provisionRuntime({ directory = destination, fetchImpl = globalThis.fetch, verifySignature = verifyMicrosoftSignature } = {}) {
  await fs.promises.mkdir(directory, { recursive: true });
  if ((await fs.promises.lstat(directory)).isSymbolicLink()
      || path.resolve(await fs.promises.realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    throw new Error('Runtime cache must be a regular directory without links.');
  }
  const file = path.join(directory, manifest.fileName);
  if (!fs.existsSync(file)) {
    const staged = path.join(directory, `${manifest.fileName}.${process.pid}.download`);
    try {
      const response = await fetchImpl(manifest.url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error(`Microsoft runtime download failed: HTTP ${response.status}`);
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > manifest.bytes ? new Error('Runtime download exceeds its pinned size.') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(staged, { flags: 'wx' }));
      await verifyRuntimeInstaller(staged);
      await verifySignature(staged);
      // Exclusive copy: a concurrent build cannot replace a verified cache entry.
      await fs.promises.copyFile(staged, file, fs.constants.COPYFILE_EXCL);
    } finally {
      await fs.promises.rm(staged, { force: true });
    }
  }
  // Cached input is never trusted merely because it exists.
  await verifyRuntimeInstaller(file);
  await verifySignature(file);
  await fs.promises.writeFile(path.join(directory, 'vc-runtime.nsh'),
    `; Generated from vc-runtime.json by provision-vc-runtime.js.\n`
    + `!define FF_VC_MIN_VERSION "${manifest.minimumVersion}"\n`
    + `!define FF_VC_SHA256 "${manifest.sha256}"\n`);
  return file;
}

if (require.main === module) provisionRuntime().then(() => {
  console.log(`[vc-runtime] Verified Microsoft x64 runtime ${manifest.version}.`);
}).catch(error => { console.error(`[vc-runtime] ${error.message}`); process.exitCode = 1; });

module.exports = { provisionRuntime, verifyMicrosoftSignature };
