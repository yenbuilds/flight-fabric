'use strict';

// Desktop-only, read-only PMDG options inspection. Renderer inputs are closed IDs;
// selected paths come only from the native picker in the main process. Work folders
// are simulator-owned persistent data, not Community installs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { INSTALL_CANDIDATES } = require('./msfs-detect');

const MAX_BYTES = 64 * 1024;
const MODELS = Object.freeze({
  'pmdg-737': [['736', '737-600', 'pmdg-737-600'], ['737', '737-700', 'pmdg-737-700'], ['738', '737-800', 'pmdg-737'], ['739', '737-900', 'pmdg-737-900']],
  'pmdg-777': [['77w', '777-300ER', 'pmdg-777'], ['77f', '777F', 'pmdg-777f'], ['77l', '777-200LR', 'pmdg-777-200lr'], ['77er', '777-200ER', 'pmdg-777-200er']],
});
const OPTIONS = Object.freeze({
  'pmdg-737': ['737_Options.ini', '737NG3_Options.ini'],
  'pmdg-777': ['777_Options.ini'],
});

function requireFamily(family) {
  if (typeof family !== 'string' || !Object.hasOwn(MODELS, family)) throw new Error('Unknown PMDG aircraft family');
  return family;
}

function matchedProfileId(family, profileId) {
  requireFamily(family);
  if (typeof profileId !== 'string' || profileId.length > 64) throw new Error('Invalid aircraft profile');
  return MODELS[family].some(model => model[2] === profileId) ? profileId : '';
}

function selectedModel(family, profileId, filePath) {
  if (!isLocalPath(filePath)) throw new Error('Choose a local PMDG options file.');
  const filename = path.basename(filePath);
  const work = path.dirname(filePath);
  const packageName = path.basename(path.dirname(work));
  const model = MODELS[family].find(item => samePath(packageName, `pmdg-aircraft-${item[0]}`));
  if (!OPTIONS[family].some(name => samePath(name, filename)) || !samePath(path.basename(work), 'work')
    || !model || (profileId && model[2] !== profileId)) {
    throw new Error('Choose this aircraft’s options INI inside its pmdg-aircraft-…\\work folder.');
  }
  return model;
}

function isLocalPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) return false;
  // Windows device/UNC paths, ADS, relative paths and traversal are never probed.
  if (/^[\\/]{2}/.test(value) || value.split(/[\\/]/).some(part => part === '.' || part === '..')) return false;
  if (process.platform === 'win32') return /^[a-z]:[\\/]/i.test(value) && !value.slice(2).includes(':');
  return path.isAbsolute(value) && !value.includes(':');
}

function candidates(family, env) {
  const result = [];
  for (const install of INSTALL_CANDIDATES) {
    if (!isLocalPath(install.id.endsWith('-store') ? env.LOCALAPPDATA : env.APPDATA)) continue;
    const localCache = install.localCache(env);
    if (!isLocalPath(localCache)) continue;
    const state = install.id.endsWith('-store') ? path.join(path.dirname(localCache), 'LocalState') : localCache;
    const layouts = install.id.startsWith('msfs2024-')
      ? [['native', 'WASM', 'MSFS2024'], ['compatible', 'WASM', 'MSFS2020']]
      : [['native', 'packages']];
    for (const [layout, ...segments] of layouts) {
      for (const [model, label, profileId] of MODELS[family]) {
        for (const filename of OPTIONS[family]) {
          result.push({
            id: `${install.id}:${layout}:${model}:${filename}`,
            label: `${install.label} · PMDG ${label}${layout === 'compatible' ? ' (2020 aircraft)' : ''}`,
            profileId,
            filename,
            path: path.join(state, ...segments, `pmdg-aircraft-${model}`, 'work', filename),
          });
        }
      }
    }
  }
  return result;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function validateFile(filePath) {
  if (!isLocalPath(filePath)) throw new Error('Unsafe options location');
  // Validate every ancestor, including the environment-derived root. Refuse
  // junctions/symlinks instead of following them outside the fixed locations.
  let current = path.parse(filePath).root;
  const parts = filePath.slice(current.length).split(path.sep);
  let stat;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Options location is not a regular file and directory');
    }
  }
  if (stat.nlink !== 1 || stat.size > MAX_BYTES || !samePath(await fs.realpath(filePath), filePath)) {
    throw new Error('Options file cannot be safely inspected');
  }
  return stat;
}

async function resolvePickedFile(original) {
  // Only the native picker may reach this resolver. Inspect redirects one at a
  // time so a network/device target is rejected before probing that target.
  let filePath = original;
  for (let redirects = 0; redirects <= 8; redirects++) {
    if (!isLocalPath(filePath)) throw new Error('Unsafe selected location');
    filePath = path.normalize(filePath);
    let current = path.parse(filePath).root;
    const parts = filePath.slice(current.length).split(path.sep);
    let redirected = false;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        if (i === parts.length - 1) throw new Error('Selected file is a link');
        const target = await fs.readlink(current);
        if (!isLocalPath(target)) throw new Error('Unsafe redirect target');
        filePath = path.join(target, ...parts.slice(i + 1));
        redirected = true;
        break;
      }
      if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('Invalid selected location');
      if (i === parts.length - 1) return { path: filePath, stat };
    }
    if (!redirected) break;
  }
  throw new Error('Too many directory redirects');
}

function parseBroadcastSettings(text) {
  const keys = ['enabledatabroadcast', 'enablecdubroadcast.0', 'enablecdubroadcast.1'];
  const values = Object.fromEntries(keys.map(key => [key, []]));
  let sdk = false;
  let sections = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    if (line.startsWith('[')) {
      const section = /^\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(line);
      if (!section) return { section: 'unknown', data: 'unknown', cduLeft: 'unknown', cduRight: 'unknown' };
      sdk = section[1].trim().toLowerCase() === 'sdk';
      if (sdk) sections++;
      continue;
    }
    if (!sdk) continue;
    const setting = /^([^=]+)=(.*)$/.exec(line);
    if (!setting) continue;
    const key = setting[1].trim().toLowerCase();
    if (Object.hasOwn(values, key)) values[key].push(setting[2].trim());
  }
  const status = key => {
    const found = values[key];
    // Do not guess PMDG's precedence for duplicate keys/sections or its handling
    // of nonstandard values and inline comments.
    if (sections > 1 || found.length > 1) return 'unknown';
    if (!found.length) return 'missing';
    return found[0] === '1' ? 'enabled' : found[0] === '0' ? 'disabled' : 'unknown';
  };
  return { section: sections === 0 ? 'missing' : sections === 1 ? 'present' : 'unknown',
    data: status(keys[0]), cduLeft: status(keys[1]), cduRight: status(keys[2]) };
}

async function inspectFile(candidate) {
  const before = await validateFile(candidate.path);
  const handle = await fs.open(candidate.path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES
      || before.ino !== opened.ino || before.dev !== opened.dev) throw new Error('Options file changed');
    // A fixed buffer also bounds reads if the file grows after stat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await validateFile(candidate.path);
    if (length > MAX_BYTES || after.ino !== opened.ino || after.dev !== opened.dev
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('Options file changed');
    const bytes = buffer.subarray(0, length);
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      if (bytes.length % 2) throw new Error('Invalid options encoding');
      text = bytes.subarray(2).toString('utf16le');
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      if (bytes.length % 2) throw new Error('Invalid options encoding');
      text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
    } else text = bytes.toString('utf8');
    if (text.includes('\0') || text.includes('\uFFFD')) throw new Error('Unrecognized options encoding');
    return parseBroadcastSettings(text);
  } finally {
    await handle.close();
  }
}

function createPmdgSdkSetup({ env = process.env, platform = process.platform, showItemInFolder, chooseOptionsFile } = {}) {
  const inFlight = new Map();
  // A native picker grants access to one canonical file, never an entire folder.
  // One selection per variant bounds this session-only map to the eight models.
  const chosen = new Map();
  let selectionVersion = 0;
  let choosing = false;
  let revealing = false;
  return {
    async getStatus(family, profileId = '') {
      const matchedProfile = matchedProfileId(family, profileId);
      if (platform !== 'win32') return { supported: false, files: [] };
      const key = `${family}:${matchedProfile}:${selectionVersion}`;
      // Coalesce overlapping requests; every subsequent manual check rereads disk.
      if (inFlight.has(key)) return inFlight.get(key);
      const operation = (async () => {
        const files = [];
        const selectedFiles = [...chosen.values()].filter(item => item.family === family);
        const automatic = candidates(family, env).filter(item => !selectedFiles.some(selected => samePath(selected.path, item.path)));
        for (const candidate of [...automatic, ...selectedFiles]) {
          if (matchedProfile && candidate.profileId !== matchedProfile) continue;
          try {
            files.push({ ...candidate, settings: await inspectFile(candidate), canReveal: true });
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            files.push({ ...candidate, settings: { section: 'unknown', data: 'unknown', cduLeft: 'unknown', cduRight: 'unknown' }, canReveal: false });
          }
        }
        return { supported: true, files };
      })();
      inFlight.set(key, operation);
      try { return await operation; } finally { inFlight.delete(key); }
    },
    async chooseFile(family, profileId = '') {
      const matchedProfile = matchedProfileId(family, profileId);
      if (platform !== 'win32' || choosing || revealing || typeof chooseOptionsFile !== 'function') {
        return { success: false, error: 'File selection is unavailable right now. Try again.' };
      }
      choosing = true;
      try {
        // The callback belongs to the main process. No renderer path is accepted.
        const picked = await chooseOptionsFile(family);
        if (picked?.canceled) return { canceled: true };
        if (!Array.isArray(picked?.filePaths) || picked.filePaths.length !== 1) throw new Error('Invalid file selection');
        const original = picked.filePaths[0];
        selectedModel(family, matchedProfile, original);
        const resolved = await resolvePickedFile(original);
        const originalStat = resolved.stat;
        if (originalStat.nlink !== 1) throw new Error('Invalid file selection');
        // User selection can traverse a Windows-managed directory redirect. Pin
        // the resolved LOCAL target; future operations never follow that redirect.
        await validateFile(resolved.path);
        const canonical = await fs.realpath(resolved.path);
        const model = selectedModel(family, matchedProfile, canonical);
        const candidate = { id: `selected:${randomUUID()}`, family, profileId: model[2],
          label: `PMDG ${model[1]} · Selected file`, filename: path.basename(canonical), path: canonical };
        const settings = await inspectFile(candidate);
        const resolvedAfter = await resolvePickedFile(original);
        const after = resolvedAfter.stat;
        const target = await validateFile(canonical);
        if (!samePath(resolvedAfter.path, canonical)
          || originalStat.ino !== target.ino || originalStat.dev !== target.dev
          || after.ino !== target.ino || after.dev !== target.dev
          || after.size !== originalStat.size || after.mtimeMs !== originalStat.mtimeMs) throw new Error('File changed');
        chosen.set(model[2], candidate);
        selectionVersion++;
        return { success: true, file: { ...candidate, settings, canReveal: true } };
      } catch {
        return { success: false, error: 'This file could not be verified. Choose this aircraft’s options INI inside its pmdg-aircraft-…\\work folder on a local drive.' };
      } finally { choosing = false; }
    },
    async revealFile(family, id) {
      requireFamily(family);
      if (platform !== 'win32' || revealing || choosing || typeof id !== 'string' || id.length > 120) {
        return { success: false, error: 'Cannot open this options folder.' };
      }
      const candidate = [...candidates(family, env), ...[...chosen.values()].filter(item => item.family === family)].find(item => item.id === id);
      if (!candidate) return { success: false, error: 'Unknown PMDG options file. Check again.' };
      revealing = true;
      try {
        await validateFile(candidate.path);
        // Reveal the fixed INI in Explorer; never execute it or pass a shell command.
        await showItemInFolder(candidate.path);
        return { success: true };
      } catch {
        return { success: false, error: 'This file is unavailable or its location could not be verified. Check again.' };
      } finally { revealing = false; }
    },
  };
}

module.exports = { createPmdgSdkSetup, parseBroadcastSettings };
