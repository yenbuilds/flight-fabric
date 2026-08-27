'use strict';

const { isExactLauncherUrl } = require('./ipc-sender-policy');

const TRUSTED_RENDERER_PERMISSION = 'clipboard-sanitized-write';
const TRUSTED_AUDIO_PERMISSION = 'media';

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
  isAudioCaptureAuthorized,
  launcherHtmlPath,
  mediaType,
  mediaTypes,
  phase,
}) {
  if (permission !== TRUSTED_RENDERER_PERMISSION && permission !== TRUSTED_AUDIO_PERMISSION) return false;
  if (!mainWebContents || webContents !== mainWebContents) return false;
  if (typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed()) return false;
  if (isMainFrame !== true) return false;

  const activeUrl = getMainFrameUrl(mainWebContents);
  const effectiveRequestingUrl = typeof requestingUrl === 'string' && requestingUrl
    ? requestingUrl
    : activeUrl;
  if (!activeUrl || effectiveRequestingUrl !== activeUrl) return false;

  const frontendTrusted = typeof isFrontendAppUrl === 'function' && isFrontendAppUrl(activeUrl);
  if (permission === TRUSTED_RENDERER_PERMISSION) {
    return frontendTrusted || isExactLauncherUrl(activeUrl, launcherHtmlPath);
  }

  // Microphone access is limited to the actual desktop frontend. The launcher
  // and emergency pages never need media permission. The desktop frontend
  // must also own a bounded recognition session before it can open the mic.
  if (!frontendTrusted) return false;
  let captureAuthorized = false;
  try {
    captureAuthorized = typeof isAudioCaptureAuthorized === 'function'
      && isAudioCaptureAuthorized(webContents) === true;
  } catch {}
  if (!captureAuthorized) return false;
  if (phase === 'request') {
    return Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio';
  }
  if (phase === 'check') return mediaType === 'audio';
  return false;
}

function installSessionPermissionPolicy({
  electronSession,
  getMainWebContents,
  isAudioCaptureAuthorized,
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
  if (typeof isAudioCaptureAuthorized !== 'function') {
    throw new TypeError('isAudioCaptureAuthorized must be a function');
  }

  const decide = ({ webContents, permission, requestingUrl, isMainFrame, mediaType, mediaTypes, phase }) => {
    const granted = isTrustedRendererPermission({
      webContents,
      permission,
      requestingUrl,
      isMainFrame,
      mainWebContents: getMainWebContents(),
      isAudioCaptureAuthorized,
      isFrontendAppUrl,
      launcherHtmlPath,
      mediaType,
      mediaTypes,
      phase,
    });
    if (typeof onDecision === 'function') {
      onDecision({ granted, permission, requestingUrl, isMainFrame, mediaType, mediaTypes, phase });
    }
    return granted;
  };

  electronSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const granted = decide({
      webContents,
      permission,
      requestingUrl: details.requestingUrl,
      isMainFrame: details.isMainFrame,
      mediaTypes: details.mediaTypes,
      phase: 'request',
    });
    callback(granted);
  });

  electronSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details = {}) => decide({
    webContents,
    permission,
    requestingUrl: details.requestingUrl,
    isMainFrame: details.isMainFrame,
    mediaType: details.mediaType,
    phase: 'check',
  }));
}

module.exports = {
  TRUSTED_RENDERER_PERMISSION,
  TRUSTED_AUDIO_PERMISSION,
  installSessionPermissionPolicy,
  isTrustedRendererPermission,
};
