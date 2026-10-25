'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { KOKORO_MODEL, VOICE_HOTWORDS, ZIPFORMER_MODEL } = require('./voice-model-manifest');

function safeModelFilePath(modelDir, filename) {
  if (typeof modelDir !== 'string' || !path.isAbsolute(modelDir)) {
    throw new TypeError('modelDir must be an absolute path');
  }
  if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename) {
    throw new TypeError('Model filenames must be non-empty basenames');
  }
  const root = path.resolve(modelDir);
  const candidate = path.resolve(root, filename);
  if (path.dirname(candidate) !== root) throw new Error('Model file resolved outside its directory');
  return candidate;
}

async function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filename), hash);
  return hash.digest('hex').toUpperCase();
}

async function verifyZipformerModel(modelDir, { manifest = ZIPFORMER_MODEL } = {}) {
  let totalBytes = 0;
  for (const expected of manifest.files) {
    const filename = safeModelFilePath(modelDir, expected.name);
    let linkInfo;
    let fileInfo;
    try {
      [linkInfo, fileInfo] = await Promise.all([fs.promises.lstat(filename), fs.promises.stat(filename)]);
    } catch (error) {
      throw new Error(`Bundled voice model file is missing: ${expected.name}`, { cause: error });
    }
    if (linkInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new Error(`Bundled voice model entry is not a regular file: ${expected.name}`);
    }
    if (fileInfo.size !== expected.bytes) {
      throw new Error(`Bundled voice model file has the wrong size: ${expected.name}`);
    }
    if (await sha256File(filename) !== expected.sha256) {
      throw new Error(`Bundled voice model file failed SHA-256 verification: ${expected.name}`);
    }
    totalBytes += fileInfo.size;
  }
  return Object.freeze({ id: manifest.id, bytes: totalBytes, verified: true });
}

async function verifyVoiceHotwords(filename, { manifest = VOICE_HOTWORDS } = {}) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
    throw new TypeError('Voice hotwords path must be absolute');
  }
  let linkInfo;
  let fileInfo;
  try {
    [linkInfo, fileInfo] = await Promise.all([fs.promises.lstat(filename), fs.promises.stat(filename)]);
  } catch (error) {
    throw new Error('Bundled voice hotwords are missing', { cause: error });
  }
  if (linkInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error('Bundled voice hotwords are not a regular file');
  }
  if (fileInfo.size !== manifest.bytes || await sha256File(filename) !== manifest.sha256) {
    throw new Error('Bundled voice hotwords failed integrity verification');
  }
  return Object.freeze({ bytes: fileInfo.size, verified: true });
}

async function verifyKokoroModel(modelDir, { manifest = KOKORO_MODEL } = {}) {
  const root = path.resolve(modelDir);
  const checkedDirectories = new Set();
  let bytes = 0;
  for (const entry of manifest.files) {
    if (!/^[a-zA-Z0-9_!+.,@ ()/-]+$/.test(entry.name)
        || entry.name.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error('Invalid Kokoro model entry');
    }
    const filename = path.resolve(root, entry.name);
    if (!filename.startsWith(root + path.sep)) throw new Error('Invalid Kokoro model path');
    let directory = path.dirname(filename);
    while (!checkedDirectories.has(directory)) {
      const stat = await fs.promises.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Invalid Kokoro model directory');
      checkedDirectories.add(directory);
      if (directory === root) break;
      directory = path.dirname(directory);
    }
    const stat = await fs.promises.lstat(filename);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== entry.bytes
        || await sha256File(filename) !== entry.sha256) {
      throw new Error(`Kokoro model failed integrity verification: ${entry.name}`);
    }
    bytes += stat.size;
  }
  return { verified: true, bytes, id: manifest.id };
}

module.exports = { safeModelFilePath, sha256File, verifyKokoroModel, verifyVoiceHotwords, verifyZipformerModel };
