'use strict';

const launcherActions = Object.freeze({
  showRemoteAccess: () => window.showRemoteAccess(),
  startAll: () => window.startAll(),
  stopAll: () => window.stopAll(),
  startBackend: () => window.startBackend(),
  stopBackend: () => window.stopBackend(),
  startHttpServer: () => window.startHttpServer(),
  stopHttpServer: () => window.stopHttpServer(),
  openDashboardSettings: () => window.openDashboardSettings(),
  revealSettingsFile: () => window.revealSettingsFile(),
  resetSettings: () => window.resetSettings(),
  closeRemoteModal: () => window.closeRemoteModal(),
  copyRemoteUrl: () => window.copyRemoteUrl(),
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;

  const dismissTarget = event.target.closest('[data-launcher-dismiss-self]');
  if (dismissTarget && event.target === dismissTarget) {
    window.closeRemoteModal();
    return;
  }

  const actionTarget = event.target.closest('[data-launcher-action]');
  if (!actionTarget) return;
  const action = launcherActions[actionTarget.dataset.launcherAction];
  if (action) action();
});
