/**
 * Electron Preload Script
 * 
 * Exposes a safe API to the renderer process via contextBridge.
 * This provides IPC communication without exposing Node.js APIs.
 */

const { contextBridge, ipcRenderer } = require('electron');

const VOICE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const MAX_VOICE_AUDIO_BYTES = 8192 * Float32Array.BYTES_PER_ELEMENT;
const MAX_READBACK_CHARS = 240;

function requireVoiceSessionId(value) {
  if (typeof value !== 'string' || !VOICE_SESSION_ID_RE.test(value)) {
    throw new TypeError('Invalid voice session identifier');
  }
  return value;
}

function requireReadbackText(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > MAX_READBACK_CHARS
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('Invalid local readback text');
  }
  return value;
}

const MSFS_INSTALL_ID_RE = /^msfs2024-(store|steam)$/;

function requireInstallId(value) {
  if (typeof value !== 'string' || !MSFS_INSTALL_ID_RE.test(value)) {
    throw new TypeError('Invalid MSFS installation identifier');
  }
  return value;
}

function requirePmdgFamily(value) {
  if (value !== 'pmdg-737' && value !== 'pmdg-777') throw new TypeError('Invalid PMDG family');
  return value;
}

function onVoiceEvent(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Voice callback must be a function');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function sendVoiceAudio({ sampleRate, samples, sequence, sessionId } = {}) {
  requireVoiceSessionId(sessionId);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Invalid voice audio sequence');
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new TypeError('Invalid voice audio sample rate');
  }
  if (!(samples instanceof ArrayBuffer)
      || samples.byteLength === 0
      || samples.byteLength > MAX_VOICE_AUDIO_BYTES
      || samples.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new TypeError('Invalid voice audio buffer');
  }
  ipcRenderer.send('voice:speech-audio', { sampleRate, samples, sequence, sessionId });
}

// Expose protected methods to the renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Backend control
  startBackend: () => ipcRenderer.invoke('backend-start'),
  stopBackend: () => ipcRenderer.invoke('backend-stop'),
  restartBackend: () => ipcRenderer.invoke('backend-restart'),
  restartApp: () => ipcRenderer.invoke('app-restart'),
  getBackendStatus: () => ipcRenderer.invoke('backend-status'),
  getBackendLogs: () => ipcRenderer.invoke('backend-logs'),
  getBackendWsPort: () => ipcRenderer.invoke('backend-ws-port'),
  getBackendHttpPort: () => ipcRenderer.invoke('backend-http-port'),
  getBackendBootstrap: () => ipcRenderer.invoke('backend-bootstrap'),
  setAutotaxiBackgroundActive: (active) => {
    if (typeof active !== 'boolean') throw new TypeError('Invalid Autotaxi activity');
    return ipcRenderer.invoke('autotaxi-background-set', active);
  },
  fetchSimbrief: (username) => ipcRenderer.invoke('simbrief-fetch', username),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings-get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings-save', settings),
  resetSettings: () => ipcRenderer.invoke('settings-reset'),
  getStorageLocations: () => ipcRenderer.invoke('storage-locations-get'),
  
  // HTTP server status
  getHttpStatus: () => ipcRenderer.invoke('http-status'),
  getStartupHealth: () => ipcRenderer.invoke('startup-health'),
  
  // Network info (for Remote Access modal)
  getNetworkInfo: () => ipcRenderer.invoke('get-network-info'),
  
  // Navigation
  openOverlay: (options) => ipcRenderer.invoke('open-overlay', options),

  // Event listeners - Backend
  onBackendStatus: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('backend-status', subscription);
    return () => ipcRenderer.removeListener('backend-status', subscription);
  },
  
  onBackendLog: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('backend-log', subscription);
    return () => ipcRenderer.removeListener('backend-log', subscription);
  },
  
  // Flight Recording
  revealInExplorer: (folderPath) => ipcRenderer.invoke('reveal-in-explorer', folderPath),
  setRecordingBadge: (state) => ipcRenderer.invoke('recording-badge-set', {
    status: typeof state?.status === 'string' ? state.status : '',
  }),

  // Legal / About
  // filename must be one of the allowlisted values in main.js (SAFETY-NOTICE.md, LICENSE.md, THIRD_PARTY_NOTICES.md, OURAIRPORTS-DATA-LICENSE.txt)
  openLegalFile: (filename) => ipcRenderer.invoke('open-legal-file', filename),
  revealLegalFolder: () => ipcRenderer.invoke('reveal-legal-folder'),

  // MSFS install detection
  detectMsfsInstalls: () => ipcRenderer.invoke('msfs-detect-installs'),

  pmdgSdk: Object.freeze({
    chooseFile: (family, profileId = '') => {
      if (typeof profileId !== 'string' || profileId.length > 64) throw new TypeError('Invalid aircraft profile');
      return ipcRenderer.invoke('pmdg-sdk-choose', requirePmdgFamily(family), profileId);
    },
    getStatus: (family, profileId = '') => {
      if (typeof profileId !== 'string' || profileId.length > 64) throw new TypeError('Invalid aircraft profile');
      return ipcRenderer.invoke('pmdg-sdk-status', requirePmdgFamily(family), profileId);
    },
    revealFile: (family, id) => {
      if (typeof id !== 'string' || id.length > 120) throw new TypeError('Invalid PMDG file identifier');
      return ipcRenderer.invoke('pmdg-sdk-reveal', requirePmdgFamily(family), id);
    },
  }),

  // MSFS 2024 toolbar package. Only a detected install id crosses the bridge;
  // the main process resolves every path itself.
  toolbarPanel: Object.freeze({
    getStatus: () => ipcRenderer.invoke('toolbar-panel-status'),
    install: (installId) => ipcRenderer.invoke('toolbar-panel-install', requireInstallId(installId)),
    uninstall: (installId) => ipcRenderer.invoke('toolbar-panel-uninstall', requireInstallId(installId)),
  }),

  // Voice audio is accepted only during a bounded, authorized capture session.
  // Explicit cloud mode sends released audio through the trusted desktop runtime.
  voice: Object.freeze({
    cancelReadback: () => ipcRenderer.invoke('voice:readback-cancel'),
    cancelRecognition: (sessionId) => ipcRenderer.invoke(
      'voice:speech-cancel',
      requireVoiceSessionId(sessionId),
    ),
    finishRecognition: (sessionId) => ipcRenderer.invoke(
      'voice:speech-finish',
      requireVoiceSessionId(sessionId),
    ),
    getReadbackInfo: () => ipcRenderer.invoke('voice:get-readback-info'),
    getRuntimeInfo: () => ipcRenderer.invoke('voice:get-runtime-info'),
    setMode: (mode) => ipcRenderer.invoke('voice:set-mode', mode),
    setCloudProvider: (selection) => ipcRenderer.invoke('voice:set-cloud-provider', selection),
    saveCloudKey: (providerId, key) => {
      if (typeof key !== 'string' || key.length > 512) throw new TypeError('Invalid API key.');
      return ipcRenderer.invoke('voice:save-cloud-key', { providerId, key });
    },
    removeCloudKey: (providerId) => ipcRenderer.invoke('voice:remove-cloud-key', providerId),
    startControllerSetup: () => ipcRenderer.invoke('voice:controller-setup-start'),
    cancelControllerSetup: () => ipcRenderer.invoke('voice:controller-setup-cancel'),
    saveControllerButton: () => ipcRenderer.invoke('voice:controller-setup-save'),
    clearControllerButton: () => ipcRenderer.invoke('voice:controller-binding-clear'),
    onPushToTalk: (callback) => onVoiceEvent('voice:push-to-talk', callback),
    onRecognitionEvent: (callback) => onVoiceEvent('voice:speech-event', callback),
    onRuntimeState: (callback) => onVoiceEvent('voice:runtime-state', callback),
    sendAudio: sendVoiceAudio,
    setRecognitionEnabled: (enabled) => ipcRenderer.invoke(
      'voice:set-recognition-enabled',
      enabled === true,
    ),
    setPushToTalkShortcut: (shortcut) => ipcRenderer.invoke(
      'voice:set-push-to-talk-shortcut',
      typeof shortcut === 'string' ? shortcut.slice(0, 64) : '',
    ),
    speakReadback: (text) => ipcRenderer.invoke(
      'voice:readback-speak',
      requireReadbackText(text),
    ),
    startRecognition: (options) => {
      if (options !== undefined && (!options || typeof options !== 'object' || JSON.stringify(options).length > 65000)) {
        throw new TypeError('Invalid voice context.');
      }
      return ipcRenderer.invoke('voice:speech-start', options);
    },
  }),
  
  // App info
  isPackaged: process.env.ELECTRON_IS_PACKAGED === 'true',
  platform: process.platform,
  version: process.env.npm_package_version || 'dev',
});

// Log preload completion
console.log('[preload] API exposed to renderer');
