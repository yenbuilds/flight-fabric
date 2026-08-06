// Cabin announcement runtime owned by the Vue app shell.
// Pre-recorded cabin PA audio player for Flight Fabric.
//
// Receives `cabinAnnouncement` WebSocket messages from the backend and plays
// the corresponding audio only in the host Electron renderer. Browser views
// receive the same event but ignore it. Audio files resolve from either:
//   1. user app-data overrides served at /user-assets/cabin/{style}/
//   2. bundled fallback files in frontend/audio/cabin/{style}/
//
// ── User override folder ───────────────────────────────────────────────────
//   %APPDATA%/Flight Fabric/Audio/Cabin/{style}/pushback-start.mp3   Windows example
//
// Multiple packs are supported — create additional subfolders (e.g. "concise",
// "informal", or any airline name) and set `style` in settings.json.
// Missing user files fall back to the bundled pack with the same style+slot.
//
// Usage:
//   cabinAnnouncementsApi.init({ getAppSettings });
//   cabinAnnouncementsApi.enqueue({ phase: 'CRUISE', style: 'standard' });
//   cabinAnnouncementsApi.setMuted(true);
//   cabinAnnouncementsApi.stop();

// ES module — strict mode is implicit in modules.
// The public API is also registered into the shared app service registry.
import { getFlightPhases } from '../app/shared-globals.js';


// ─── Phase / event-slot → filename ─────────────────────────────────────────
// Altitude-based virtual slots (ABOVE_10K, BELOW_10K) use the same mechanism
// as phase slots — the backend broadcasts { phase: 'ABOVE_10K', style } when
// the aircraft crosses 10,000 ft, and the key is looked up here.
function resolvePhaseAudioSlot(phase) {
  const phases = getFlightPhases({ required: false, fallback: {} }) || {};
  const phaseToFile = {
    [phases.TAXI]: 'pushback-start',
    [phases.CLIMB]: 'climb',
    [phases.CRUISE]: 'cruise',
    [phases.DESCENT]: 'descent-start',
    [phases.APPROACH]: 'approach',
    [phases.TAXI_IN]: 'shortly-after-landing-rollout',
    ABOVE_10K: 'transition-to-above-10k-feet',
    BELOW_10K: 'transition-to-below-10k-feet',
  };
  return phaseToFile[phase] || '';
}
const SUPPORTED_EXTENSIONS = ['mp3', 'ogg', 'wav'];
const PLAYBACK_LOCK_NAME = 'ff-cabin-pa-owner-v1';

// ─── BroadcastChannel — signal strip overlays when play starts/stops ────────
let _paCh = null;
function _getPaChannel() {
  if (_paCh) return _paCh;
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    _paCh = new BroadcastChannel('cabin-pa');
  } catch {
    _paCh = null;
  }
  return _paCh;
}

function _closePaChannel() {
  if (_paCh && typeof _paCh.close === 'function') {
    try { _paCh.close(); } catch {}
  }
  _paCh = null;
}

function _broadcastPa(type) {
  const paChannel = _getPaChannel();
  if (paChannel) try { paChannel.postMessage({ type }); } catch (e) {}
}

// ─── Queue ───────────────────────────────────────────────────────────────────
let _queue   = [];
let _playing = false;
let _muted   = false;
let _current = null; // active HTMLAudioElement
let _currentPhase = null;
let _settings = { enabled: false, style: 'standard' };
let _initialized = false;
let _starting = false;
let _pausedByMute = false;
let _available = false;
let _lockHeld = false;
let _lockRelease = null;
let _lockAcquirePromise = null;
let _statusStore = null;
let _beforeUnloadCleanup = null;

function _sanitizeStyle(value) {
  const rawStyle = typeof value === 'string' ? value : 'standard';
  return rawStyle.replace(/[^a-zA-Z0-9_-]/g, '') || 'standard';
}

function _normalizeSettings(settings) {
  const next = settings && typeof settings === 'object' ? settings : {};
  return {
    enabled: next.enabled === true,
    style: _sanitizeStyle(next.style),
  };
}

function _isHostElectronRenderer() {
  return typeof window.electronAPI?.getBackendWsPort === 'function';
}

function _syncCabinAnnouncementsStore(partialState = {}) {
  _statusStore?.setCabinAnnouncementsState?.({
    enabled: _settings.enabled,
    available: _available,
    muted: _muted,
    playing: _playing,
    ...partialState,
  });
}

function _buildAudioSources(style, filename) {
  const sources = [];

  if (window.location && window.location.protocol !== 'file:') {
    for (const ext of SUPPORTED_EXTENSIONS) {
      sources.push(`/user-assets/cabin/${style}/${filename}.${ext}`);
    }
  }

  for (const ext of SUPPORTED_EXTENSIONS) {
    sources.push(`audio/cabin/${style}/${filename}.${ext}`);
  }

  return sources;
}

function _supportsPlaybackLock() {
  return !!(window.navigator && window.navigator.locks && typeof window.navigator.locks.request === 'function');
}

function _releasePlaybackLock() {
  if (typeof _lockRelease === 'function') {
    const release = _lockRelease;
    _lockRelease = null;
    _lockHeld = false;
    release();
  }
}

function _acquirePlaybackLock() {
  if (_lockHeld) return Promise.resolve(true);
  if (_lockAcquirePromise) return _lockAcquirePromise;
  if (!_supportsPlaybackLock()) {
    return Promise.resolve(true);
  }

  let resolveAcquire = null;
  const acquirePromise = new Promise((resolve) => {
    resolveAcquire = resolve;
  });
  _lockAcquirePromise = acquirePromise;

  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (_lockAcquirePromise === acquirePromise) {
      _lockAcquirePromise = null;
    }
    resolveAcquire(value);
  };

  try {
    window.navigator.locks.request(
      PLAYBACK_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => {
        if (!lock) {
          finish(false);
          return undefined;
        }

        _lockHeld = true;
        finish(true);

        return new Promise((releaseResolve) => {
          _lockRelease = () => {
            _lockHeld = false;
            _lockRelease = null;
            releaseResolve();
          };
        });
      }
    ).catch(() => {
      finish(false);
    });
  } catch {
    finish(true);
  }

  return acquirePromise;
}

function _finishPlayback(delayMs) {
  _releasePlaybackLock();
  _playing = false;
  _pausedByMute = false;
  _current = null;
  _currentPhase = null;
  _syncCabinAnnouncementsStore({ playing: false });
  _broadcastPa('pa-stop');
  setTimeout(maybePlay, delayMs);
}

function _tryPlaySources(next, sourceIndex) {
  const src = next.sources[sourceIndex];
  if (!src) {
    console.warn(`[cabin-announcements] No audio file found for phase: ${next.phase}`);
    _finishPlayback(200);
    return;
  }

  const audio = new Audio(src);
  _current = audio;

  let settled = false;
  let playbackStarted = false;

  function failCurrent(message) {
    if (settled || _current !== audio) return;
    settled = true;
    try { audio.pause(); audio.src = ''; } catch {}

    if (sourceIndex + 1 < next.sources.length) {
      console.warn(`[cabin-announcements] Could not load: ${src}${message ? ` (${message})` : ''}. Trying fallback.`);
      _tryPlaySources(next, sourceIndex + 1);
      return;
    }

    console.warn(`[cabin-announcements] Could not load: ${src}${message ? ` (${message})` : ''}.`);
    _finishPlayback(200);
  }

  audio.onplaying = () => {
    if (settled || _current !== audio || playbackStarted) return;
    if (_muted) {
      try { audio.pause(); } catch {}
      return;
    }
    playbackStarted = true;
    console.log(`[cabin-announcements] Playing: ${src}`);
    _syncCabinAnnouncementsStore({ playing: true });
    _broadcastPa('pa-play');
  };

  audio.onended = () => {
    if (settled || _current !== audio) return;
    settled = true;
    _finishPlayback(800);
  };

  audio.onerror = () => {
    failCurrent('file missing or codec unsupported');
  };

  audio.play().catch((err) => {
    failCurrent(err && err.message ? err.message : 'play() failed');
  });
}

function _syncCabinAnnouncementsAvailability() {
  if (!_settings.enabled) {
    _syncCabinAnnouncementsStore({ enabled: false, muted: false });
    return;
  }

  _syncCabinAnnouncementsStore();
}

function enqueue(announcement) {
  if (!announcement || !announcement.phase) return false;
  // Cabin PA belongs to the simulator host. Only the Electron renderer gets
  // the preload capability; ordinary host/LAN browsers receive and ignore the
  // WebSocket event without creating audio or joining the playback queue.
  if (!_isHostElectronRenderer()) return false;
  // Silently drop while muted — don't queue stale announcements that would
  // play when the user later unmutes mid-flight.
  if (!_settings.enabled || _muted) return false;
  const filename = resolvePhaseAudioSlot(announcement.phase);
  if (!filename) return false;

  // Sanitize style: only allow alphanumeric, hyphens and underscores.
  // Prevents path traversal if a malformed WS message arrives.
  const style = _settings.style || _sanitizeStyle(announcement.style);
  const phase = announcement.phase;

  if (_currentPhase === phase || _queue.some((item) => item.phase === phase)) {
    return false;
  }

  _queue.push({
    phase,
    sources: _buildAudioSources(style, filename),
  });
  _available = true;
  _syncCabinAnnouncementsAvailability();
  maybePlay();
  return true;
}

async function maybePlay() {
  if (_playing || _starting || _queue.length === 0 || _muted || _pausedByMute) return;

  _starting = true;
  const haveLock = await _acquirePlaybackLock();
  _starting = false;

  if (!haveLock) {
    _queue.shift();
    if (_queue.length > 0) {
      setTimeout(maybePlay, 0);
    }
    return;
  }

  if (_muted || _pausedByMute) {
    _releasePlaybackLock();
    return;
  }

  const next = _queue.shift();
  if (!next) {
    _releasePlaybackLock();
    return;
  }

  _playing = true;
  _currentPhase = next.phase;
  _tryPlaySources(next, 0);
}

function stop() {
  const hadPlayback = _playing;
  _queue = [];
  if (_current) {
    try { _current.pause(); _current.src = ''; } catch {}
    _current = null;
  }
  _releasePlaybackLock();
  _starting = false;
  _playing = false;
  _pausedByMute = false;
  _currentPhase = null;
  _syncCabinAnnouncementsStore({ playing: false });
  if (hadPlayback) {
    _broadcastPa('pa-stop');
  }
}

async function _resumeCurrentPlayback() {
  if (!_current) {
    _pausedByMute = false;
    maybePlay();
    return;
  }

  const haveLock = await _acquirePlaybackLock();
  if (!haveLock) {
    try { _current.pause(); _current.src = ''; } catch {}
    _current = null;
    _currentPhase = null;
    _pausedByMute = false;
    _playing = false;
    setTimeout(maybePlay, 0);
    return;
  }

  if (_muted || !_current) {
    _releasePlaybackLock();
    return;
  }

  _pausedByMute = false;
  _playing = true;
  _current.play().catch((err) => {
    console.warn('[cabin-announcements] resume failed:', err.message);
    _releasePlaybackLock();
    _playing = false;
    _current = null;
    _currentPhase = null;
    _pausedByMute = false;
    _syncCabinAnnouncementsStore({ playing: false });
    _broadcastPa('pa-stop');
    setTimeout(maybePlay, 200);
  });
  _syncCabinAnnouncementsStore({ playing: true });
  _broadcastPa('pa-play');
}

function setMuted(muted) {
  if (!_settings.enabled) {
    _muted = false;
    _syncCabinAnnouncementsAvailability();
    return;
  }

  _muted = !!muted;
  if (_muted) {
    // Pause in place — preserve position and queue so we can resume on unmute.
    if (_current) {
      try { _current.pause(); } catch {}
      _pausedByMute = true;
    }
    _releasePlaybackLock();
    _playing = false;
    _syncCabinAnnouncementsStore({ playing: false });
    _broadcastPa('pa-stop');
  } else {
    // Unmute — resume the paused track if there is one, otherwise drain queue.
    if (_current && _pausedByMute) {
      _resumeCurrentPlayback();
    } else {
      maybePlay();
    }
  }
  _syncCabinAnnouncementsAvailability();
  console.log(`[cabin-announcements] ${_muted ? 'Muted (paused in place)' : 'Unmuted (resuming)'}.`);
}

function isMuted() { return _muted; }

function applySettings(settings) {
  _settings = _normalizeSettings(settings);

  if (!_settings.enabled) {
    _muted = false;
    _available = false;
    stop();
  }

  _syncCabinAnnouncementsAvailability();
  return { ..._settings };
}

// ─── PA store sync ───────────────────────────────────────────────────────────
export function initCabinAnnouncementsRuntime({
  getAppSettings = () => null,
  statusStore = null,
  windowRef = window,
} = {}) {
  _statusStore = statusStore || null;
  if (_initialized) {
    _syncCabinAnnouncementsAvailability();
    return publicAPI;
  }
  _initialized = true;

  const appSettings = typeof getAppSettings === 'function'
    ? getAppSettings()
    : null;
  if (appSettings && appSettings.cabinAnnouncements) {
    applySettings(appSettings.cabinAnnouncements);
  } else {
    _syncCabinAnnouncementsAvailability();
  }

  const handleBeforeUnload = () => {
    cleanupCabinAnnouncementsRuntime();
  };
  windowRef.addEventListener('beforeunload', handleBeforeUnload);
  _beforeUnloadCleanup = () => {
    windowRef.removeEventListener?.('beforeunload', handleBeforeUnload);
  };

  return publicAPI;
}

function cleanupCabinAnnouncementsRuntime() {
  stop();
  _closePaChannel();
  _settings = { enabled: false, style: 'standard' };
  _muted = false;
  _available = false;
  _syncCabinAnnouncementsAvailability();
  if (typeof _beforeUnloadCleanup === 'function') {
    _beforeUnloadCleanup();
  }
  _beforeUnloadCleanup = null;
  _initialized = false;
  _statusStore = null;
}

// ─── Public API ──────────────────────────────────────────────────────────────
export const cabinAnnouncementsApi = Object.freeze({
  init: initCabinAnnouncementsRuntime,
  enqueue,
  stop,
  setMuted,
  isMuted,
  applySettings,
  cleanup: cleanupCabinAnnouncementsRuntime,
});
const publicAPI = cabinAnnouncementsApi;

