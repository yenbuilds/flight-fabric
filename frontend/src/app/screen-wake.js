// The phone or tablet on /remote is a second screen for the whole flight, so
// it must not dim and lock a few minutes after the last touch. NoSleep.js
// takes the Screen Wake Lock where the browser has it and plays a silent
// inline video elsewhere (older iOS Safari). Both are refused until the page
// has seen a user gesture, so the first tap takes the lock and the runtime
// keeps it for as long as the page stays visible.
import NoSleep from 'nosleep.js';
import { isRemoteViewPath } from './remote-view.js';

// touchend and click count as activation for media playback on iOS Safari;
// touchstart does not.
const ACTIVATION_EVENTS = ['click', 'touchend', 'keydown'];

function hasNativeWakeLock(navigatorRef) {
  return Boolean(navigatorRef) && 'wakeLock' in navigatorRef;
}

export function initScreenWakeRuntime({
  windowRef = window,
  documentRef = typeof document === 'undefined' ? null : document,
  navigatorRef = typeof navigator === 'undefined' ? null : navigator,
  createNoSleep = () => new NoSleep(),
  log = console,
} = {}) {
  const cleanupFns = [];

  function cleanup() {
    while (cleanupFns.length > 0) {
      try { cleanupFns.pop()(); } catch {}
    }
  }

  // The simulator PC has its own display settings; only the phone page holds
  // the screen.
  if (!documentRef || !isRemoteViewPath(windowRef?.location?.pathname)) return cleanup;

  let noSleep = null;
  try {
    noSleep = createNoSleep();
  } catch (error) {
    log?.warn?.('[screen-wake] Keep-awake unavailable:', error);
    return cleanup;
  }

  let wanted = false;
  let armed = false;
  let disposed = false;

  function addListener(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    cleanupFns.push(() => target.removeEventListener?.(type, handler, options));
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    ACTIVATION_EVENTS.forEach((type) => {
      documentRef.removeEventListener?.(type, onActivation, true);
    });
  }

  function arm() {
    if (armed || disposed) return;
    armed = true;
    ACTIVATION_EVENTS.forEach((type) => {
      documentRef.addEventListener(type, onActivation, true);
    });
  }

  function enable() {
    if (disposed) return Promise.resolve(false);
    wanted = true;
    let request;
    try {
      request = Promise.resolve(noSleep.enable());
    } catch (error) {
      request = Promise.reject(error);
    }
    return request.then(
      () => {
        // A request can finish after the runtime has been torn down. NoSleep's
        // earlier disable could not release a lock that had not arrived yet.
        if (disposed) { try { noSleep.disable(); } catch {} return false; }
        return true;
      },
      (error) => {
        if (disposed) return false;
        // Refused without a gesture (or by policy): wait for the next tap
        // rather than retrying on a timer.
        log?.warn?.('[screen-wake] Keep-awake refused; will retry on the next tap:', error?.message || error);
        arm();
        return false;
      },
    );
  }

  function onActivation() {
    disarm();
    void enable();
  }

  // NoSleep re-requests the native lock itself when the page comes back;
  // the video fallback is paused by the browser in the background and needs
  // a fresh play().
  addListener(documentRef, 'visibilitychange', () => {
    if (documentRef.visibilityState !== 'visible') return;
    if (!wanted || hasNativeWakeLock(navigatorRef)) return;
    void enable();
  });

  cleanupFns.push(() => {
    disposed = true;
    disarm();
    wanted = false;
    try { noSleep.disable(); } catch {}
  });

  arm();

  return cleanup;
}
