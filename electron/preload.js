/**
 * Electron Preload Script
 * 
 * Exposes a safe API to the renderer process via contextBridge.
 * This provides IPC communication without exposing Node.js APIs.
 */

const { contextBridge, ipcRenderer } = require('electron');

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
  pickExportFolder: () => ipcRenderer.invoke('pick-export-folder'),
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
  
  // App info
  isPackaged: process.env.ELECTRON_IS_PACKAGED === 'true',
  platform: process.platform,
  version: process.env.npm_package_version || 'dev',
});

// Log preload completion
console.log('[preload] API exposed to renderer');
