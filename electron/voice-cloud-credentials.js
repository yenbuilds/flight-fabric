'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getProvider } = require('./voice-cloud-provider');

function createVoiceCloudCredentials({ directory, getProtection = () => require('electron').safeStorage }) {
  function filenameFor(providerId) {
    getProvider(providerId);
    // Preserve the original file as OpenAI's slot. Existing installations keep
    // their encrypted key without decrypting/rewriting it during migration.
    return path.join(directory, providerId === 'openai' ? 'voice-cloud-key.bin' : `voice-cloud-key-${providerId}.bin`);
  }
  function protection() {
    const storage = getProtection();
    if (!storage?.isEncryptionAvailable?.() || storage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Protected API key storage is unavailable on this PC.');
    }
    return storage;
  }
  function info(providerId = 'openai') {
    const filename = filenameFor(providerId);
    let storageAvailable = false;
    try { protection(); storageAvailable = true; } catch {}
    return { keyConfigured: fs.existsSync(filename), storageAvailable };
  }
  function read(providerId = 'openai') {
    const filename = filenameFor(providerId);
    try {
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8192) throw new Error();
      const value = protection().decryptString(fs.readFileSync(filename));
      if (!validKey(providerId, value)) throw new Error();
      return value;
    } catch {
      throw new Error('The saved provider key could not be read. Add or replace it in Voice settings.');
    }
  }
  function validKey(providerId, value) {
    return typeof value === 'string' && (providerId === 'openai'
      ? /^sk-[A-Za-z0-9_-]{20,500}$/.test(value) : /^[A-Za-z0-9_-]{20,512}$/.test(value));
  }
  function save(providerId, value) {
    const filename = filenameFor(providerId);
    if (!validKey(providerId, value)) throw new Error('Enter a valid API key for the selected provider.');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const encrypted = protection().encryptString(value);
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error();
      fs.writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filename);
    } catch {
      throw new Error('The API key could not be saved to protected storage.');
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
    return info(providerId);
  }
  function remove(providerId = 'openai') {
    const filename = filenameFor(providerId);
    try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw new Error('The saved API key could not be removed.'); }
    return info(providerId);
  }
  return Object.freeze({ info, read, save, remove });
}

module.exports = { createVoiceCloudCredentials };
