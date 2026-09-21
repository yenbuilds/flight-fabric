/** Longest run of keys typed ahead of the aircraft; extra presses are refused, not silently dropped. */
export const CDU_KEY_QUEUE_LIMIT = 8;
/** Gap after a key's reply before the next queued key goes out; the backend refuses keys inside 50 ms. */
export const CDU_KEY_SPACING_MS = 60;

/**
 * Correlated requests. Keys typed while one is in flight wait in a short queue
 * so thumb-speed entry on a phone is not lost; a failed or timed-out key drops
 * the queue, and nothing is ever retried or replayed on reconnect.
 */
export function createCduController({ send, getProfile, getCanWrite, onChange,
  now = Date.now, setTimeoutRef = setTimeout, clearTimeoutRef = clearTimeout }) {
  const instance = globalThis.crypto?.randomUUID?.() || `${now()}-${Math.random()}`;
  let sequence = 0, generation = 0, latestApplied = 0;
  let side = 'left', state = {}, error = '', keyPending = null, readPending = null;
  let lastResponseAt = 0, nextKeyAt = 0;
  let keyError = false;
  const requests = new Map();
  const queue = []; let flushTimer = null;
  const publish = () => onChange({ state, error, pending: Boolean(keyPending) || queue.length > 0, side, queued: queue.length });
  function dropQueue() {
    queue.length = 0;
    if (flushTimer !== null) { clearTimeoutRef(flushTimer); flushTimer = null; }
  }
  function reset(nextSide = side) {
    generation++; side = nextSide; state = {}; error = ''; keyError = false; lastResponseAt = 0; nextKeyAt = 0;
    for (const request of requests.values()) clearTimeoutRef(request.timer);
    requests.clear(); keyPending = null; readPending = null; dropQueue(); publish();
  }
  // Send the next typed-ahead key once the aircraft has answered the previous
  // one. A key that failed or timed out leaves the display uncertain, so the
  // rest of the run is discarded rather than typed blind.
  function flushQueue() {
    flushTimer = null;
    if (keyPending || !queue.length) return;
    const entry = queue[0], profile = getProfile();
    if (entry.sessionId !== state.sessionId || entry.profile.profileKey !== profile?.profileKey
      || entry.profile.profileRevision !== profile?.profileRevision) {
      cancelQueue('CDU connection changed. Queued keys cancelled; check the aircraft before continuing.');
    } else {
      queue.shift();
      if (!request(entry.key, true)) dropQueue();
    }
    publish();
  }
  function scheduleQueue() {
    if (queue.length && !keyPending && flushTimer === null) {
      flushTimer = setTimeoutRef(flushQueue, Math.max(0, nextKeyAt - now()));
    }
  }
  function cancelQueue(message) {
    if (!queue.length) return;
    dropQueue(); error = message; keyError = true;
  }
  function fail(pending, message, invalidateScreen = !pending.key) {
    const newest = pending.number > latestApplied;
    if (newest) {
      latestApplied = pending.number;
      if (invalidateScreen) {
        state = { ...state, screen: null };
        cancelQueue('CDU display unavailable. Queued keys cancelled; check the aircraft before continuing.');
      }
    }
    // Old poll failures cannot replace a newer screen. Uncertain key delivery
    // remains visible until the user starts another entry or resets the panel.
    if (pending.key || (newest && !keyError)) {
      error = message; keyError = Boolean(pending.key);
    }
  }
  function request(key, fromQueue = false) {
    if (key && (!getCanWrite() || !state.screen?.powered || !state.sessionId || now() - lastResponseAt > 2500)) {
      dropQueue();
      error = 'Key not sent. Wait for the display and control connection to be ready.'; keyError = true; publish(); return false;
    }
    // Keep typed-ahead keys in order: a new press joins the back of the queue
    // whenever one is in flight or the spacing gap is still running.
    const profile = getProfile();
    if (!profile?.profileKey || !Number.isSafeInteger(profile.profileRevision)) return false;
    if (key && !fromQueue && (keyPending || flushTimer !== null || queue.length || now() < nextKeyAt)) {
      if (queue.length >= CDU_KEY_QUEUE_LIMIT) {
        error = 'Key not sent. Wait for the display to catch up, then check your entry.'; keyError = true; publish(); return false;
      }
      // Preserve a warning for the current burst, including refused characters.
      if (!keyPending && !queue.length) { error = ''; keyError = false; }
      queue.push({ key, sessionId: state.sessionId, profile: { ...profile } });
      scheduleQueue();
      publish(); return true;
    }
    if (!key && readPending) return false;
    const number = ++sequence, requestId = `cdu-${instance}-${number}`;
    const token = generation;
    const pending = { number, token, key, profile: { ...profile }, side, timer: null };
    requests.set(requestId, pending);
    if (key) {
      keyPending = requestId;
      if (!fromQueue) { error = ''; keyError = false; }
    } else readPending = requestId;
    pending.timer = setTimeoutRef(() => {
      if (!requests.delete(requestId)) return;
      if (key) { keyPending = null; dropQueue(); } else readPending = null;
      fail(pending, key ? 'Key delivery timed out. Check the aircraft before trying again.' : 'CDU connection timed out.', true);
      publish();
    }, 3000);
    publish();
    if (send({ type: key ? 'sendCduKey' : 'requestCduState', requestId, ...profile, side,
      ...(key ? { key, sessionId: state.sessionId } : {}) }) === false) {
      reset(); error = 'FlightFabric connection unavailable.'; publish(); return false;
    }
    return true;
  }
  return {
    reset,
    read() {
      if (lastResponseAt && now() - lastResponseAt > 2500) {
        state = { ...state, screen: null };
        cancelQueue('CDU display expired. Queued keys cancelled; check the aircraft before continuing.');
        publish();
      }
      return request();
    },
    press: key => request(key),
    receive(message) {
      if (message?.type !== 'cduState') return;
      const pending = requests.get(message.requestId);
      if (!pending) return;
      requests.delete(message.requestId); clearTimeoutRef(pending.timer);
      if (message.requestId === keyPending) keyPending = null;
      if (message.requestId === readPending) readPending = null;
      const profile = getProfile();
      if (pending.token !== generation || pending.side !== side || profile?.profileKey !== pending.profile.profileKey
        || profile?.profileRevision !== pending.profile.profileRevision) {
        // The aircraft or unit changed under a key: whatever was typed ahead was meant for the old one.
        if (pending.key) dropQueue();
        publish(); return;
      }
      if (message.ok === false) {
        if (pending.key) dropQueue();
        fail(pending, message.error || 'CDU request failed.');
      } else if (message.profileKey === profile.profileKey && message.profileRevision === profile.profileRevision && message.side === side) {
        if (pending.key) nextKeyAt = now() + CDU_KEY_SPACING_MS;
        if (pending.number > latestApplied) {
          if (state.sessionId !== message.sessionId || !message.screen?.powered) {
            cancelQueue('CDU connection or display changed. Queued keys cancelled; check the aircraft before continuing.');
          }
          state = message; latestApplied = pending.number; lastResponseAt = now();
          if (!keyError) error = '';
        }
      } else if (pending.key) {
        dropQueue(); // answered for another aircraft or unit; the typed-ahead keys were for the old one
      }
      // An answered key that still applies lets the next typed-ahead key go after the spacing gap.
      scheduleQueue();
      publish();
    },
    disconnect() { reset(); error = 'FlightFabric disconnected. Keys are disabled.'; publish(); },
    dispose: reset,
  };
}

export function fenixMcduUrl(socketUrl, pageUrl) {
  try {
    const url = new URL(socketUrl || pageUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '';
    url.protocol = 'http:'; url.port = '8083'; url.pathname = '/'; url.search = ''; url.hash = '';
    url.username = ''; url.password = '';
    return url.href;
  } catch { return ''; }
}

export function cduKeyboardKey(event, available) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return null;
  const aliases = { Backspace: ['CLR'], Delete: ['DEL', 'CLR'], ' ': ['SPACE', 'SP'], '/': ['SLASH', 'DIV'],
    '.': ['DOT'], '-': ['PLUS_MINUS', 'PLUSMINUS'], '+': ['PLUS_MINUS', 'PLUSMINUS'],
    ArrowLeft: ['PREV_PAGE', 'PREVPAGE'], ArrowRight: ['NEXT_PAGE', 'NEXTPAGE'], ArrowUp: ['UP'], ArrowDown: ['DOWN'] };
  const candidates = aliases[event.key] || (/^[a-z0-9]$/i.test(event.key) ? [event.key.toUpperCase()] : []);
  return candidates.find(key => available.includes(key)) || null;
}
