'use strict';

const { isExactLauncherUrl } = require('./ipc-sender-policy');

const TRUSTED_RENDERER_PERMISSION = 'clipboard-sanitized-write';

function getMainFrameUrl(mainWebContents) {
  const frameUrl = mainWebContents?.mainFrame?.url;
  if (typeof frameUrl === 'string' && frameUrl) return frameUrl;
  if (typeof mainWebContents?.getURL === 'function') {
    const webContentsUrl = mainWebContents.getURL();
    if (typeof webContentsUrl === 'string' && webContentsUrl) return webContentsUrl;
  }
  return '';
}

function isTrustedRendererPermission({
  webContents,
  permission,
  requestingUrl,
  isMainFrame,
  mainWebContents,
  isFrontendAppUrl,
  launcherHtmlPath,
}) {
  if (permission !== TRUSTED_RENDERER_PERMISSION) return false;
  if (!mainWebContents || webContents !== mainWebContents) return false;
  if (typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed()) return false;
  if (isMainFrame !== true) return false;

  const activeUrl = getMainFrameUrl(mainWebContents);
  const effectiveRequestingUrl = typeof requestingUrl === 'string' && requestingUrl
    ? requestingUrl
    : activeUrl;
  if (!activeUrl || effectiveRequestingUrl !== activeUrl) return false;

  if (typeof isFrontendAppUrl === 'function' && isFrontendAppUrl(activeUrl)) return true;
  return isExactLauncherUrl(activeUrl, launcherHtmlPath);
}

function installSessionPermissionPolicy({
  electronSession,
  getMainWebContents,
  isFrontendAppUrl,
  launcherHtmlPath,
  onDecision,
}) {
  if (!electronSession
      || typeof electronSession.setPermissionRequestHandler !== 'function'
      || typeof electronSession.setPermissionCheckHandler !== 'function') {
    throw new TypeError('A valid Electron session is required');
  }
  if (typeof getMainWebContents !== 'function') {
    throw new TypeError('getMainWebContents must be a function');
  }

  const decide = ({ webContents, permission, requestingUrl, isMainFrame, phase }) => {
    const granted = isTrustedRendererPermission({
      webContents,
      permission,
      requestingUrl,
      isMainFrame,
      mainWebContents: getMainWebContents(),
      isFrontendAppUrl,
      launcherHtmlPath,
    });
    if (typeof onDecision === 'function') {
      onDecision({ granted, permission, requestingUrl, isMainFrame, phase });
    }
    return granted;
  };

  electronSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const granted = decide({
      webContents,
      permission,
      requestingUrl: details.requestingUrl,
      isMainFrame: details.isMainFrame,
      phase: 'request',
    });
    callback(granted);
  });

  electronSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details = {}) => decide({
    webContents,
    permission,
    requestingUrl: details.requestingUrl,
    isMainFrame: details.isMainFrame,
    phase: 'check',
  }));
}

module.exports = {
  TRUSTED_RENDERER_PERMISSION,
  installSessionPermissionPolicy,
  isTrustedRendererPermission,
};
