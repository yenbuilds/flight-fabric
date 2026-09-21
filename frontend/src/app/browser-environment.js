export function getBrowserStorage(storage = null) {
  if (storage) return storage;
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    return globalThis.localStorage;
  }
  return null;
}

export function readStorageValue(key, {
  storage = null,
  fallback = null,
} = {}) {
  try {
    const storageRef = getBrowserStorage(storage);
    const value = storageRef?.getItem?.(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function readStorageJson(key, {
  storage = null,
  fallback = null,
} = {}) {
  const raw = readStorageValue(key, { storage, fallback: null });
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeStorageValue(key, value, {
  storage = null,
} = {}) {
  try {
    const storageRef = getBrowserStorage(storage);
    if (typeof storageRef?.setItem !== 'function') return false;
    storageRef.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export function writeStorageJson(key, value, {
  storage = null,
} = {}) {
  try {
    const storageRef = getBrowserStorage(storage);
    if (typeof storageRef?.setItem !== 'function') return false;
    storageRef.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStorageValue(key, {
  storage = null,
} = {}) {
  try {
    const storageRef = getBrowserStorage(storage);
    if (typeof storageRef?.removeItem !== 'function') return false;
    storageRef.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// Coordinate a read/change/write decision across renderer processes. Without
// Web Locks, retain the synchronous storage checks used by older browsers.
// An unavailable or failed lock is a reason to skip an optional prompt.
export function withBrowserLock(name, callback, { windowRef = null } = {}) {
  const locks = (windowRef || globalThis.window)?.navigator?.locks;
  if (typeof locks?.request !== 'function') return callback();
  try {
    return Promise.resolve(locks.request(name, { ifAvailable: true }, (lock) => (
      lock ? callback() : false
    ))).catch(() => false);
  } catch {
    return false;
  }
}

export function matchesMedia(query, {
  windowRef = null,
} = {}) {
  const targetWindow = windowRef
    || (typeof globalThis !== 'undefined' ? globalThis.window : null);
  return targetWindow?.matchMedia?.(query).matches === true;
}
