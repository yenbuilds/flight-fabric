'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getRepoScratchPath } = require('../../scripts/repo-scratch');

function createProbeDirectory(prefix) {
  if (!/^ff-electron-[a-z-]+-$/.test(prefix)) throw new Error('Invalid Electron probe prefix');
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function finishProbeDirectory(directory, originalError, diagnostics = {}, options = {}) {
  const remove = options.remove || fs.rmSync;
  const report = options.report || ((record) => {
    console.error(JSON.stringify(record, null, 2));
    try {
      const output = getRepoScratchPath('electron-probe-diagnostics');
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, `${path.basename(directory)}.json`), JSON.stringify(record, null, 2));
    } catch (error) {
      console.error(`Could not save Electron probe diagnostics: ${error.message}`);
    }
  });
  let cleanupError = null;
  try {
    const resolved = path.resolve(directory);
    const tempRoot = fs.realpathSync(os.tmpdir());
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (key(path.dirname(resolved)) !== key(tempRoot)
      || !/^ff-electron-[a-z-]+-[A-Za-z0-9]+$/.test(path.basename(resolved))) {
      throw new Error(`Refusing Electron probe cleanup outside its temporary root: ${resolved}`);
    }
    if (fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(fs.realpathSync(resolved)) !== key(resolved)) {
        throw new Error(`Refusing redirected Electron probe directory: ${resolved}`);
      }
      remove(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } catch (error) {
    cleanupError = error;
  }
  if (originalError || cleanupError) {
    report({ directory, ...diagnostics, error: originalError?.stack || null, cleanupError: cleanupError?.stack || null });
    throw originalError || cleanupError;
  }
}

module.exports = { createProbeDirectory, finishProbeDirectory };
