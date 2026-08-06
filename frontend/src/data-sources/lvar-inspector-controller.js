import { normalizeLvarDebugWatch } from '../vue/stores/lvar-inspector.js';

const LVAR_DEBUG_WATCH_LS_KEY = 'ff-lvar-debug-watch';

function readStoredWatchList(localStorageRef) {
  try {
    const raw = JSON.parse(localStorageRef.getItem(LVAR_DEBUG_WATCH_LS_KEY) || '[]');
    return Array.isArray(raw)
      ? raw.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 48)
      : [];
  } catch {
    return [];
  }
}

export function createLvarInspectorController({
  localStorageRef = localStorage,
  sendWs = () => {},
  lvarInspectorStore = null,
} = {}) {
  if (!lvarInspectorStore) {
    throw new Error('LVAR inspector store is required before LVAR inspector controller');
  }
  let unsubscribe = null;
  let lastWatchKey = '[]';

  function persistLvarDebugWatch(list) {
    try {
      localStorageRef.setItem(LVAR_DEBUG_WATCH_LS_KEY, JSON.stringify(list));
    } catch {}
  }

  function pushLvarDebugWatch(list) {
    const normalized = normalizeLvarDebugWatch(list);
    persistLvarDebugWatch(normalized);
    sendWs({ type: 'lvarDebugWatch', subscriptions: normalized });
  }

  function bind() {
    if (!lvarInspectorStore) return;

    unsubscribe?.();

    lvarInspectorStore.hydrateWatchList(readStoredWatchList(localStorageRef));
    lastWatchKey = JSON.stringify(lvarInspectorStore.debugWatchSubscriptions);

    unsubscribe = lvarInspectorStore.$subscribe((_mutation, state) => {
      const nextWatchKey = JSON.stringify(state.debugWatchSubscriptions);
      if (nextWatchKey !== lastWatchKey) {
        lastWatchKey = nextWatchKey;
        pushLvarDebugWatch(state.debugWatchSubscriptions);
      }
    }, { detached: true });
  }

  function clearDataSourcesStatus() {
    lvarInspectorStore?.clearDataSourcesStatus?.();
  }

  function handleDataSourcesMessage(message) {
    lvarInspectorStore?.ingestDataSourcesMessage?.(message);
  }

  function resync() {
    if (!lvarInspectorStore) return;

    pushLvarDebugWatch(lvarInspectorStore.debugWatchSubscriptions);
  }

  return {
    bind,
    clearDataSourcesStatus,
    handleDataSourcesMessage,
    resync,
  };
}
