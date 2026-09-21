// Owns support-prompt persistence and timing. The rules live in
// milestones.js; this file only decides *when* to evaluate them: a few
// seconds after a final landing score, once the logbook has refreshed.
import { watch } from 'vue';
import { readStorageJson, withBrowserLock, writeStorageJson } from '../app/browser-environment.js';
import { isRemoteViewPath } from '../app/remote-view.js';

export const SUPPORT_STORAGE_KEY = 'ff_support_v1';
export const SUPPORT_LANDING_SETTLE_MS = 4000;
// The card fades on its own so ignoring it is a valid answer. Showing has
// already counted as the ask, so a faded card never comes back for that
// milestone.
export const SUPPORT_PROMPT_LINGER_MS = 90 * 1000;
export const SUPPORT_THANKS_LINGER_MS = 60 * 1000;
const LANDING_ARMED_MS = 60 * 1000;
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

function modalIsOpen(documentRef) {
  const dialogs = Array.from(documentRef?.querySelectorAll?.(MODAL_SELECTOR) || []);
  return dialogs.some((element) => (
    typeof element.getClientRects !== 'function' || element.getClientRects().length > 0
  ));
}

export function initSupportRuntime({
  supportStore = null,
  logbookStore = null,
  promptsStore = null,
  subscribeLandingReceivedSignal = null,
  storage = null,
  windowRef = window,
  documentRef = typeof document === 'undefined' ? null : document,
  now = () => Date.now(),
  landingSettleMs = SUPPORT_LANDING_SETTLE_MS,
  promptLingerMs = SUPPORT_PROMPT_LINGER_MS,
  thanksLingerMs = SUPPORT_THANKS_LINGER_MS,
} = {}) {
  if (!supportStore) {
    throw new Error('Support store is required before the support runtime');
  }
  const cleanupFns = [];
  const remoteView = isRemoteViewPath(windowRef?.location?.pathname);

  const savedRecord = readStorageJson(SUPPORT_STORAGE_KEY, { storage, fallback: null });
  supportStore.hydrate(savedRecord, now());
  // Loading an existing snapshot must not write it back: another renderer
  // may already have saved a newer preference or ask after our read.
  let persistenceAvailable = savedRecord != null
    || writeStorageJson(SUPPORT_STORAGE_KEY, supportStore.serialize(), { storage });
  let readingSavedRecord = false;

  function refreshSavedRecord() {
    // A failed save may hold a newer local opt-out than the stored record.
    // Keep that choice for this session and remain silent.
    if (!persistenceAvailable) return;
    const saved = readStorageJson(SUPPORT_STORAGE_KEY, { storage, fallback: null });
    if (!saved || JSON.stringify(saved) === JSON.stringify(supportStore.serialize())) return;
    readingSavedRecord = true;
    try {
      supportStore.hydrate(saved, now());
    } finally {
      readingSavedRecord = false;
    }
  }

  // Persist synchronously: an ask, a snooze or an opt-out must survive an
  // immediate window close.
  cleanupFns.push(watch(
    () => supportStore.record,
    () => {
      if (readingSavedRecord) return;
      persistenceAvailable = writeStorageJson(SUPPORT_STORAGE_KEY, supportStore.serialize(), { storage });
    },
    { deep: true, flush: 'sync' },
  ));

  // A storage event can arrive after a click in a second window. Refresh
  // before the action edits one field, so its saved record retains the other
  // window's preferences and ask history. The prompt action calls its local
  // setter directly, so it needs the same check as the About setters.
  cleanupFns.push(supportStore.$onAction(({ name }) => {
    if (['setMuted', 'setSupported', 'markSupportedFromPrompt', 'considerMilestone'].includes(name)) {
      refreshSavedRecord();
    }
  }));

  // An opt-out in another window applies to this window too. Read current
  // storage rather than the event payload, which can already be out of date.
  const onStorage = (event) => {
    if (event.key === SUPPORT_STORAGE_KEY) refreshSavedRecord();
  };
  windowRef.addEventListener?.('storage', onStorage);
  cleanupFns.push(() => windowRef.removeEventListener?.('storage', onStorage));

  let armedUntil = 0;
  let evaluateAfter = Infinity;
  let settleTimer = null;
  let lingerTimer = null;
  let goalTimer = null;
  let disposed = false;

  function refreshGoalPeriod() {
    if (goalTimer != null) windowRef.clearTimeout?.(goalTimer);
    goalTimer = null;
    supportStore.refreshGoalClock(now());
    if (!supportStore.goal) return;
    const date = new Date(now());
    const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
    // Long timeouts overflow after about 24 days in browsers.
    const delay = Math.min(nextMonth - now(), 24 * 24 * 60 * 60 * 1000);
    goalTimer = windowRef.setTimeout?.(refreshGoalPeriod, Math.max(1, delay)) ?? null;
  }

  cleanupFns.push(watch(() => supportStore.goal, refreshGoalPeriod, { immediate: true, flush: 'sync' }));
  documentRef?.addEventListener?.('visibilitychange', refreshGoalPeriod);
  cleanupFns.push(() => documentRef?.removeEventListener?.('visibilitychange', refreshGoalPeriod));

  function clearLinger() {
    if (lingerTimer != null) windowRef.clearTimeout?.(lingerTimer);
    lingerTimer = null;
  }

  function startLinger(ms) {
    clearLinger();
    if (!ms) return;
    lingerTimer = windowRef.setTimeout?.(() => {
      lingerTimer = null;
      supportStore.dismissPrompt();
    }, ms) ?? null;
  }

  function evaluate() {
    return withBrowserLock(SUPPORT_STORAGE_KEY, evaluateMilestone, { windowRef });
  }

  function evaluateMilestone() {
    if (disposed || remoteView || !logbookStore) return false;
    if (!armedUntil || now() < evaluateAfter || now() > armedUntil) return false;
    if (documentRef?.visibilityState === 'hidden') return false;
    // An update day already showed a card. Leave the milestone for another
    // session so dismissing release highlights cannot expose a support ask.
    if (promptsStore?.wasShown?.('whats-new')) return false;
    // Never behind something the user is in the middle of.
    if (modalIsOpen(documentRef)) return false;
    const current = promptsStore?.current || null;
    // An existing prompt keeps the slot; a later landing can try again.
    if (current) return false;
    refreshSavedRecord();
    if (!persistenceAvailable) return false;
    const opened = supportStore.considerMilestone({
      total: logbookStore.stats?.total,
      airports: logbookStore.stats?.airports,
      now: now(),
    });
    if (opened) {
      armedUntil = 0;
      if (!persistenceAvailable) {
        supportStore.dismissPrompt();
        return false;
      }
    }
    return opened;
  }

  function onLandingReceived(detail) {
    if (remoteView || detail?.final !== true || detail?.source === 'history') return;
    armedUntil = now() + LANDING_ARMED_MS;
    evaluateAfter = now() + landingSettleMs;
    if (settleTimer != null) windowRef.clearTimeout?.(settleTimer);
    settleTimer = windowRef.setTimeout?.(() => {
      settleTimer = null;
      evaluate();
    }, landingSettleMs) ?? null;
  }

  if (!remoteView && typeof subscribeLandingReceivedSignal === 'function') {
    cleanupFns.push(subscribeLandingReceivedSignal(onLandingReceived));
  }

  if (!remoteView && logbookStore) {
    cleanupFns.push(watch(
      () => logbookStore.stats?.total,
      () => {
        if (now() <= armedUntil) evaluate();
      },
    ));
  }

  // Each stage of the card gets its own quiet fade-out.
  cleanupFns.push(watch(
    () => supportStore.prompt?.stage || null,
    (stage) => {
      if (stage === 'ask') startLinger(promptLingerMs);
      else if (stage === 'thanks') startLinger(thanksLingerMs);
      else clearLinger();
    },
    { flush: 'sync' },
  ));

  return () => {
    disposed = true;
    clearLinger();
    if (goalTimer != null) windowRef.clearTimeout?.(goalTimer);
    if (settleTimer != null) windowRef.clearTimeout?.(settleTimer);
    supportStore.dismissPrompt();
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      try {
        cleanup();
      } catch {}
    }
  };
}
