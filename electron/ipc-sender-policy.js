'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isExactLauncherUrl(rawUrl, launcherHtmlPath) {
  if (typeof rawUrl !== 'string' || typeof launcherHtmlPath !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:' || parsed.hostname || parsed.search || parsed.hash) return false;
    return comparablePath(fileURLToPath(parsed)) === comparablePath(launcherHtmlPath);
  } catch {
    return false;
  }
}

function isTrustedIpcSender({
  event,
  mainWebContents,
  isFrontendAppUrl,
  launcherHtmlPath,
}) {
  if (!event || !mainWebContents || event.sender !== mainWebContents) return false;
  if (typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed()) return false;

  const senderFrame = event.senderFrame;
  if (!senderFrame || senderFrame !== mainWebContents.mainFrame) return false;
  if (typeof senderFrame.url !== 'string' || !senderFrame.url) return false;

  if (typeof isFrontendAppUrl === 'function' && isFrontendAppUrl(senderFrame.url)) return true;
  return isExactLauncherUrl(senderFrame.url, launcherHtmlPath);
}

module.exports = {
  isExactLauncherUrl,
  isTrustedIpcSender,
};
