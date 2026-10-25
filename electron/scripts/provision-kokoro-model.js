'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { KOKORO_MODEL } = require('../voice-model-manifest');
const { sha256File, verifyKokoroModel } = require('../voice-model-integrity');
const { safeRemoveRootChildDirectorySync } = require('../safe-directory-removal');

async function provisionKokoroModel({
  modelsRoot = path.resolve(__dirname, '../resources/models'),
  archivePath = process.env.FF_KOKORO_ARCHIVE,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const root = path.resolve(modelsRoot);
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Invalid model destination');
  const destination = path.join(root, KOKORO_MODEL.id);
  try {
    await verifyKokoroModel(destination);
    log('[kokoro] Verified offline voice pack');
    return destination;
  } catch {}
  const staging = fs.mkdtempSync(path.join(root, '.kokoro-'));
  try {
    const archive = path.join(staging, 'model.tar.bz2');
    if (archivePath) fs.copyFileSync(path.resolve(archivePath), archive);
    else {
      log(`[kokoro] Downloading ${Math.round(KOKORO_MODEL.archiveBytes / 1000000)} MB offline voice pack`);
      const response = await fetchImpl(KOKORO_MODEL.archiveUrl, { signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw new Error(`Kokoro download failed: HTTP ${response.status}`);
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > KOKORO_MODEL.archiveBytes ? new Error('Kokoro archive too large') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(archive, { flags: 'wx' }));
    }
    if (fs.statSync(archive).size !== KOKORO_MODEL.archiveBytes
        || await sha256File(archive) !== KOKORO_MODEL.archiveSha256) throw new Error('Kokoro archive failed verification');
    // Only this exact verified upstream archive is extracted. Verify every
    // extracted file and reject links before promoting it into resources.
    execFileSync('tar', ['-xjf', archive, '-C', staging], { windowsHide: true, timeout: 120000 });
    const extracted = path.join(staging, KOKORO_MODEL.id);
    await verifyKokoroModel(extracted);
    if (fs.existsSync(destination)) safeRemoveRootChildDirectorySync({
      rootDir: root, childName: KOKORO_MODEL.id, allowedChildNames: [KOKORO_MODEL.id], operation: 'Replace Kokoro model',
    });
    fs.renameSync(extracted, destination);
    log('[kokoro] Installed and verified offline voice pack');
    return destination;
  } finally {
    safeRemoveRootChildDirectorySync({ rootDir: root, childName: path.basename(staging),
      allowedChildNames: [path.basename(staging)], operation: 'Kokoro staging cleanup' });
  }
}

if (require.main === module) void provisionKokoroModel().catch(error => {
  console.error(`[kokoro] ${error.message}. For offline builds set FF_KOKORO_ARCHIVE to the verified archive.`);
  process.exitCode = 1;
});
module.exports = { provisionKokoroModel };
