'use strict';

function isAllowedDownloadResponse(details, size) {
  if ([301, 302, 303, 307, 308].includes(details.statusCode)) return true;
  if (details.statusCode !== 200) return false;
  const headers = Object.fromEntries(Object.entries(details.responseHeaders || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const length = headers['content-length'];
  const encoding = headers['content-encoding'];
  return Array.isArray(length) && length.length === 1 && /^\d+$/.test(length[0]) && Number(length[0]) === size
    && !headers['transfer-encoding'] && (!encoding || (encoding.length === 1 && encoding[0].toLowerCase() === 'identity'));
}

// The custom provider supplies only metadata already authenticated by our
// release key. Windows Authenticode is not the trust root for unsigned builds.
function createUpdateEngine({ release, currentVersion, onProgress, signal }) {
  const { NsisUpdater, Provider } = require('electron-updater');
  const { CancellationToken } = require('builder-util-runtime');
  const { spawn } = require('node:child_process');
  let launch = null;
  const token = new CancellationToken();
  const info = Object.freeze({
    version: release.version,
    releaseDate: new Date().toISOString(),
    files: [Object.freeze({ url: release.url, sha512: release.sha512, size: release.size })],
  });
  class SignedProvider extends Provider {
    constructor(_options, _updater, runtime) { super(runtime); }
    async getLatestVersion() { return info; }
    resolveFiles(value) {
      if (value !== info) throw new Error('Unexpected update metadata');
      return [{ url: new URL(release.url), info: info.files[0] }];
    }
  }
  class AwaitedNsisUpdater extends NsisUpdater {
    async spawnLog(command, args = [], env, stdio = 'ignore') {
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(command, args, { env, stdio, detached: true, windowsHide: true });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
        launch?.resolve();
      } catch (error) {
        // The pinned NSIS adapter falls back to shell.openPath for ENOENT,
        // whose fulfilled error string cannot prove a launch. Fail closed.
        if (error.code === 'ENOENT') throw new Error('Installer file was not found');
        throw error; // Preserve the adapter's EACCES/UNKNOWN elevation fallback.
      }
    }
  }
  const updater = new AwaitedNsisUpdater({ provider: 'custom', updateProvider: SignedProvider });
  updater.logger = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  // Restrict Electron's download redirects as well as the signed origin URL.
  updater.netSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.href === release.url || ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname));
    } catch {}
    callback({ cancel: !allowed });
  });
  // Require an exact bounded payload even when a server omits progress metadata.
  updater.netSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ cancel: !isAllowedDownloadResponse(details, release.size) });
  });
  updater.on('error', () => { launch?.reject(new Error('Installer could not start')); });
  updater.on('download-progress', (progress) => {
    if (progress.transferred > release.size) token.cancel();
    if (!signal.aborted) onProgress(Math.min(100, Math.max(0, progress.transferred / release.size * 100)));
  });
  const cancel = () => token.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  return {
    async download() {
      if (signal.aborted || updater.currentVersion.version !== currentVersion) throw new Error('Update cancelled');
      await updater.checkForUpdates();
      if (signal.aborted) throw new Error('Update cancelled');
      const files = await updater.downloadUpdate(token);
      if (signal.aborted || files.length !== 1) throw new Error('Update cancelled');
      return files[0];
    },
    async install() {
      // BaseUpdater.quitAndInstall schedules quit before asynchronous spawn
      // errors settle. Retain its NSIS arguments/fallbacks, but let main quit
      // only after a confirmed spawn (installation success is still separate).
      if (launch) throw new Error('Installer launch already pending');
      const pending = new Promise((resolve, reject) => { launch = { resolve, reject }; });
      try {
        if (!updater.install(true, true)) launch.reject(new Error('Installer could not start'));
        await pending;
      } catch {
        updater.quitAndInstallCalled = false;
        throw new Error('Installer could not start');
      } finally { launch = null; }
    },
    dispose() {
      signal.removeEventListener('abort', cancel);
      token.cancel();
      updater.netSession.webRequest.onBeforeRequest(null);
      updater.netSession.webRequest.onHeadersReceived(null);
    },
  };
}

module.exports = { createUpdateEngine, isAllowedDownloadResponse };
