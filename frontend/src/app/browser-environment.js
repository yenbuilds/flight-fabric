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
  const storageRef = getBrowserStorage(storage);
  try {
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
  const storageRef = getBrowserStorage(storage);
  try {
    storageRef?.setItem?.(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export function writeStorageJson(key, value, {
  storage = null,
} = {}) {
  const storageRef = getBrowserStorage(storage);
  try {
    storageRef?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStorageValue(key, {
  storage = null,
} = {}) {
  const storageRef = getBrowserStorage(storage);
  try {
    storageRef?.removeItem?.(key);
    return true;
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
