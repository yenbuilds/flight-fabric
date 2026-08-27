'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { safeRemoveRootChildDirectorySync } = require('../safe-directory-removal');
const { ZIPFORMER_MODEL } = require('../voice-model-manifest');
const { safeModelFilePath, verifyZipformerModel } = require('../voice-model-integrity');

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const electronDir = path.resolve(__dirname, '..');
const defaultDestination = path.join(electronDir, 'resources', 'models', ZIPFORMER_MODEL.id);
const defaultBundledBpeVocab = path.join(electronDir, 'resources', 'voice', 'bpe.vocab');

async function validModel(directory, model) {
  try {
    await verifyZipformerModel(directory, { manifest: model });
    return true;
  } catch {
    return false;
  }
}

async function validModelFile(directory, expected, model) {
  try {
    await verifyZipformerModel(directory, {
      manifest: { id: model.id, files: [expected] },
    });
    return true;
  } catch {
    return false;
  }
}

function upstreamUrlFor(expected, model) {
  if (expected.source !== 'upstream') {
    throw new Error(`Voice model file has no upstream source: ${expected.name}`);
  }
  const baseUrl = new URL(model.upstream.resolveUrl);
  if (baseUrl.protocol !== 'https:' || !baseUrl.pathname.includes(`/${model.upstream.revision}/`)) {
    throw new Error('Voice model upstream URL must use HTTPS and an immutable revision');
  }
  return new URL(encodeURIComponent(expected.name), baseUrl).href;
}

async function downloadModelFile({ expected, filename, fetchImpl, model, log }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('This Node.js runtime does not provide fetch; Node.js 22.12 or newer is required');
  }
  const url = upstreamUrlFor(expected, model);
  log(`[voice-model] Downloading ${expected.name} (${(expected.bytes / (1024 * 1024)).toFixed(1)} MiB)`);
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'Flight-Fabric-source-build/1.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${expected.name}: HTTP ${response.status}`);
  }

  let receivedBytes = 0;
  const sizeGuard = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > expected.bytes) {
        callback(new Error(`Download exceeded the pinned size for ${expected.name}`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    sizeGuard,
    fs.createWriteStream(filename, { flags: 'wx' }),
  );
  if (receivedBytes !== expected.bytes) {
    throw new Error(`Download has the wrong size for ${expected.name}`);
  }
}

function ensureDirectoryTarget(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    return;
  }
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Voice model destination is not a regular directory: ${directory}`);
  }
}

function removeObsoleteFiles(destination, model) {
  for (const name of model.obsoleteFiles || []) {
    const filename = safeModelFilePath(destination, name);
    if (!fs.existsSync(filename)) continue;
    const info = fs.lstatSync(filename);
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-file voice model entry: ${name}`);
    }
    fs.unlinkSync(filename);
  }
}

function installStagedFiles(stagingDirectory, destination, model) {
  ensureDirectoryTarget(destination);
  for (const expected of model.files) {
    const target = safeModelFilePath(destination, expected.name);
    if (fs.existsSync(target)) {
      const info = fs.lstatSync(target);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`Refusing to replace directory in voice model: ${expected.name}`);
      }
      fs.unlinkSync(target);
    }
    fs.copyFileSync(safeModelFilePath(stagingDirectory, expected.name), target, fs.constants.COPYFILE_EXCL);
  }
}

async function provisionVoiceModel({
  bundledBpeVocab = defaultBundledBpeVocab,
  configuredSource = String(process.env.FF_VOICE_MODEL_DIR || '').trim(),
  destination = defaultDestination,
  fetchImpl = globalThis.fetch,
  log = console.log,
  model = ZIPFORMER_MODEL,
} = {}) {
  const resolvedDestination = path.resolve(destination);
  ensureDirectoryTarget(resolvedDestination);
  removeObsoleteFiles(resolvedDestination, model);
  if (await validModel(resolvedDestination, model)) {
    log(`[voice-model] Verified ${model.id}`);
    return { downloaded: false, modelDir: resolvedDestination, verified: true };
  }

  const modelsRoot = path.dirname(resolvedDestination);
  const stagingDirectory = fs.mkdtempSync(path.join(modelsRoot, `.${model.id}-`));
  const resolvedSource = configuredSource ? path.resolve(configuredSource) : '';
  let downloaded = false;

  try {
    for (const expected of model.files) {
      const stagedFile = safeModelFilePath(stagingDirectory, expected.name);
      if (expected.source === 'bundled') {
        fs.copyFileSync(path.resolve(bundledBpeVocab), stagedFile, fs.constants.COPYFILE_EXCL);
        continue;
      }
      if (expected.source !== 'upstream') {
        throw new Error(`Unsupported voice model source for ${expected.name}`);
      }
      if (await validModelFile(resolvedDestination, expected, model)) {
        fs.copyFileSync(safeModelFilePath(resolvedDestination, expected.name), stagedFile, fs.constants.COPYFILE_EXCL);
        continue;
      }
      if (resolvedSource) {
        fs.copyFileSync(safeModelFilePath(resolvedSource, expected.name), stagedFile, fs.constants.COPYFILE_EXCL);
        continue;
      }
      await downloadModelFile({ expected, filename: stagedFile, fetchImpl, model, log });
      downloaded = true;
    }

    await verifyZipformerModel(stagingDirectory, { manifest: model });
    installStagedFiles(stagingDirectory, resolvedDestination, model);
    await verifyZipformerModel(resolvedDestination, { manifest: model });
    log(`[voice-model] Provisioned and verified ${model.id}`);
    return { downloaded, modelDir: resolvedDestination, verified: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offlineHint = resolvedSource
      ? `Check that FF_VOICE_MODEL_DIR points to the extracted ${model.id} directory.`
      : `For an offline build, set FF_VOICE_MODEL_DIR to the extracted ${model.id} directory.`;
    const punctuation = /[.!?]$/u.test(message) ? '' : '.';
    throw new Error(`${message}${punctuation} ${offlineHint}`, { cause: error });
  } finally {
    const stagingName = path.basename(stagingDirectory);
    safeRemoveRootChildDirectorySync({
      allowedChildNames: [stagingName],
      childName: stagingName,
      operation: 'Voice model staging cleanup',
      rootDir: modelsRoot,
    });
  }
}

async function main() {
  await provisionVoiceModel();
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[voice-model] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  downloadModelFile,
  provisionVoiceModel,
  upstreamUrlFor,
};
