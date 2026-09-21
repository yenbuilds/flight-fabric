// Shows the release highlights once after an update. The highlights come from
// whats-new.json, generated at build time from RELEASE_NOTES.md, so the card
// can never drift from the notes; a version mismatch simply shows nothing.
import { watch } from 'vue';
import { readStorageValue, withBrowserLock, writeStorageValue } from './browser-environment.js';
import { isRemoteViewPath } from './remote-view.js';

export const WHATS_NEW_SEEN_STORAGE_KEY = 'ff_whats_new_seen_v1';
export const WHATS_NEW_ASSET = 'whats-new.json';

export function extractSemver(text) {
  const match = String(text || '').match(/\d+\.\d+\.\d+/);
  return match ? match[0] : '';
}

// 'first-run': remember this version silently. 'seen': nothing to do.
// 'show': the app moved to a newer version since the last time it was noted.
// Keep the newest seen version through a rollback so reinstalling it is quiet.
export function resolveWhatsNewDecision({ seenVersion = '', currentVersion = '' } = {}) {
  if (!currentVersion) return 'wait';
  if (!seenVersion) return 'first-run';
  const seen = seenVersion.split('.').map(Number);
  const current = currentVersion.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (current[index] > seen[index]) return 'show';
    if (current[index] < seen[index]) return 'seen';
  }
  return 'seen';
}

export function initWhatsNewRuntime({
  whatsNewStore = null,
  settingsUiStore = null,
  storage = null,
  windowRef = window,
  fetchImpl = null,
} = {}) {
  if (!whatsNewStore || !settingsUiStore) {
    throw new Error('What\'s new runtime requires the what\'s-new and settings UI stores');
  }
  const cleanupFns = [];
  if (isRemoteViewPath(windowRef?.location?.pathname)) return () => {};

  let decided = false;
  let disposed = false;
  let displayedVersion = '';
  let claimId = 0;
  whatsNewStore.setDisplayAllowed(false);

  function wasSeen(version) {
    const seenVersion = extractSemver(readStorageValue(WHATS_NEW_SEEN_STORAGE_KEY, { storage, fallback: '' }));
    return resolveWhatsNewDecision({ seenVersion, currentVersion: version }) === 'seen';
  }

  function rememberSilently(version) {
    return withBrowserLock(WHATS_NEW_SEEN_STORAGE_KEY, () => {
      if (disposed || wasSeen(version)) return false;
      return writeStorageValue(WHATS_NEW_SEEN_STORAGE_KEY, version, { storage });
    }, { windowRef });
  }

  async function loadHighlights() {
    const doFetch = fetchImpl || windowRef.fetch?.bind(windowRef);
    if (typeof doFetch !== 'function') return null;
    try {
      const url = new URL(WHATS_NEW_ASSET, windowRef.location?.href || 'http://localhost/');
      const response = await doFetch(url.href, { cache: 'no-store' });
      if (!response?.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async function decide(currentVersion) {
    if (decided) return;
    decided = true;
    const seenVersion = extractSemver(readStorageValue(WHATS_NEW_SEEN_STORAGE_KEY, { storage, fallback: '' }));
    const decision = resolveWhatsNewDecision({ seenVersion, currentVersion });
    if (decision === 'first-run' || decision === 'seen') {
      if (decision === 'first-run') return rememberSilently(currentVersion);
      return;
    }
    const payload = await loadHighlights();
    if (disposed || wasSeen(currentVersion)) return;
    const queued = payload && extractSemver(payload.version) === currentVersion
      ? whatsNewStore.show(payload)
      : false;
    // Missing or mismatched assets are deliberately skipped. A queued card
    // is counted separately, only when it actually reaches the visible slot.
    if (!queued) return rememberSilently(currentVersion);
  }

  cleanupFns.push(watch(
    () => whatsNewStore.hasPromptSlot,
    (hasSlot) => {
      const claim = ++claimId;
      whatsNewStore.setDisplayAllowed(false);
      if (!hasSlot) return;
      const version = extractSemver(whatsNewStore.version);
      if (displayedVersion === version) {
        whatsNewStore.setDisplayAllowed(true);
        return;
      }
      // Keep the card hidden until this renderer wins the shared claim and
      // saves that it was shown. A losing window releases its queue slot.
      const result = withBrowserLock(WHATS_NEW_SEEN_STORAGE_KEY, () => {
        if (disposed || claim !== claimId || !whatsNewStore.hasPromptSlot) return false;
        if (wasSeen(version) || !writeStorageValue(WHATS_NEW_SEEN_STORAGE_KEY, version, { storage })) return false;
        displayedVersion = version;
        whatsNewStore.setDisplayAllowed(true);
        return true;
      }, { windowRef });
      const finish = (accepted) => {
        if (!accepted && !disposed && claim === claimId) whatsNewStore.dismiss();
      };
      if (result && typeof result.then === 'function') result.then(finish);
      else finish(result);
    },
    { flush: 'sync' },
  ));

  const onStorage = (event) => {
    const version = extractSemver(whatsNewStore.version);
    if (event.key === WHATS_NEW_SEEN_STORAGE_KEY && whatsNewStore.open
      && displayedVersion !== version && wasSeen(version)) {
      whatsNewStore.dismiss();
    }
  };
  windowRef.addEventListener?.('storage', onStorage);
  cleanupFns.push(() => windowRef.removeEventListener?.('storage', onStorage));

  cleanupFns.push(watch(
    () => extractSemver(settingsUiStore.aboutVersion),
    (currentVersion) => {
      if (currentVersion) decide(currentVersion);
    },
    { immediate: true },
  ));

  return () => {
    disposed = true;
    claimId++;
    whatsNewStore.dismiss();
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      try {
        cleanup();
      } catch {}
    }
  };
}
