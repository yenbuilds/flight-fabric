'use strict';

/**
 * Decide whether a backend port owner is safe to stop after user confirmation.
 *
 * Every candidate must be owned by the current Windows user. Standalone
 * backends are then explicitly marked as replaceable. Electron-owned backends
 * additionally require both launch-mode locks to prove that the current
 * Electron process is the only active owner and that the marked listener is
 * stale. Unknown classifications always fail closed.
 */
function canStopBackendPortOwner(ownership, capabilities = {}) {
  // Port ownership is system-wide. Per-user launch locks do not prove that a
  // matching Flight Fabric command line belongs to this Windows account.
  if (capabilities.sameWindowsOwner !== true) return false;
  if (ownership === 'stoppable') return true;
  if (ownership !== 'electron') return false;

  return capabilities.allowElectronOwnerRecovery === true
    && capabilities.hasSingleInstanceLock === true
    && capabilities.hasRuntimeOwnerLock === true;
}

module.exports = { canStopBackendPortOwner };
