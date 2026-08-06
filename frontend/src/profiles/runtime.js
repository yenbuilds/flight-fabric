// ES module - strict mode is implicit in modules.

export function initProfilesRuntime({
  profilesStore = null,
  getAuthorizationScope = null,
  sendMessage = null,
  showToast = null,
  subscribeWsMessageSignal = null,
  subscribeWsCloseSignal = null,
  subscribeWsConnectingSignal = null,
  subscribeWsErrorSignal = null,
  subscribeWsOpenSignal = null,
} = {}) {
  if (!profilesStore) {
    throw new Error('Profiles store is required before profiles runtime');
  }

  const cleanupFns = [];
  let profilesRequestedForConnection = false;
  profilesStore.bindRuntime({ sendMessage, showToast });

  function resetProfileAuthorization() {
    profilesRequestedForConnection = false;
    profilesStore.setAuthorizationScope('read-only');
  }

  function applyProfileAuthorization(scope) {
    const acknowledgedScope = profilesStore.setAuthorizationScope(scope);
    if (acknowledgedScope !== 'full-control') {
      profilesRequestedForConnection = false;
      return acknowledgedScope;
    }
    if (!profilesRequestedForConnection && profilesStore.requestAll(false)) {
      profilesRequestedForConnection = true;
    }
    return acknowledgedScope;
  }

  function reconcileProfileAuthorization() {
    if (typeof getAuthorizationScope !== 'function') return profilesStore.authorizationScope;
    try {
      return applyProfileAuthorization(getAuthorizationScope());
    } catch {
      return profilesStore.authorizationScope;
    }
  }

  // Components can mount after the one-time authorization message (for
  // example after a renderer remount). Recover only the scope already
  // acknowledged by the active connection; credentials alone never reach
  // this getter as an authorized scope.
  reconcileProfileAuthorization();

  if (typeof subscribeWsMessageSignal === 'function') {
    cleanupFns.push(subscribeWsMessageSignal((message) => {
      if (message?.type === 'authorizationScope') {
        applyProfileAuthorization(message.scope);
        return;
      }
      // Reconcile before processing other server messages so a delayed mount
      // cannot leave the local selector stuck in its fail-closed initial state.
      reconcileProfileAuthorization();
      profilesStore.handleMessage(message);
    }));
  }

  if (typeof subscribeWsCloseSignal === 'function') {
    cleanupFns.push(subscribeWsCloseSignal(resetProfileAuthorization));
  }

  if (typeof subscribeWsConnectingSignal === 'function') {
    cleanupFns.push(subscribeWsConnectingSignal(resetProfileAuthorization));
  }

  if (typeof subscribeWsErrorSignal === 'function') {
    cleanupFns.push(subscribeWsErrorSignal(resetProfileAuthorization));
  }

  if (typeof subscribeWsOpenSignal === 'function') {
    cleanupFns.push(subscribeWsOpenSignal(resetProfileAuthorization));
  }

  return function cleanupProfilesRuntime() {
    for (const cleanup of cleanupFns.splice(0).reverse()) {
      try {
        cleanup?.();
      } catch {}
    }
    resetProfileAuthorization();
    profilesStore.bindRuntime({});
  };
}
