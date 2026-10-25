'use strict';

const path = require('node:path');
const { KOKORO_MODEL } = require('./voice-model-manifest');
const { createWindowsLocalTts, normalizeReadbackText } = require('./windows-local-tts');

// Engine IDs are persisted, labels are presentation only. Additional engines
// belong here and implement this owner's bounded generate/cancel lifecycle.
const READBACK_ENGINES = Object.freeze([
  Object.freeze({ id: 'kokoro', label: 'Kokoro (offline neural)', modelId: KOKORO_MODEL.id,
    workerFile: 'voice-tts-worker.js', voices: KOKORO_MODEL.voices, defaultVoice: KOKORO_MODEL.defaultVoice }),
  Object.freeze({ id: 'windows-sapi', label: 'Windows TTS' }),
]);
function validateReadbackEngine(value) {
  if (!READBACK_ENGINES.some(engine => engine.id === value)) throw new TypeError('Unsupported spoken voice engine');
  return value;
}
function validateReadbackVoice(engineId, voiceId) {
  const definition = READBACK_ENGINES.find(engine => engine.id === engineId);
  if (!definition?.voices?.some(voice => voice.id === voiceId)) throw new TypeError('Unsupported spoken voice');
  return voiceId;
}

function createVoiceReadback({
  appDir = __dirname, isPackaged = false, resourcesPath = process.resourcesPath,
  modelDir = null,
  debugLog = () => {}, onErrorChange = () => {},
  player = null,
  spawnWorker = (directory, definition) => require('electron').utilityProcess.fork(
    path.join(__dirname, definition.workerFile), [directory],
    { stdio: 'ignore', serviceName: 'FlightFabric offline speech' }),
  setTimer = setTimeout, clearTimer = clearTimeout,
  requestTimeoutMs = 30000, idleTimeoutMs = 120000,
} = {}) {
  let selectedEngine = 'kokoro';
  let active = false;
  const selectedVoices = Object.fromEntries(READBACK_ENGINES.filter(engine => engine.defaultVoice)
    .map(engine => [engine.id, engine.defaultVoice]));
  let fallbackReason = '';
  let worker = null;
  let pending = null;
  let sequence = 0;
  let disposed = false;
  let idleTimer = null;
  const cache = new Map();
  let cacheBytes = 0;
  const output = player || createWindowsLocalTts({ debugLog, onErrorChange });

  function notify() { try { onErrorChange(); } catch {} }
  function getInfo() {
    const info = output.getInfo();
    const definition = READBACK_ENGINES.find(engine => engine.id === selectedEngine);
    return { ...info, selectedEngine, engines: READBACK_ENGINES.map(({ id, label }) => ({ id, label })),
      selectedVoice: selectedVoices[selectedEngine] || '',
      preparing: Boolean(worker && !worker.retired && !worker.ready),
      voices: (definition.voices || [])
        .filter(voice => voice.listed !== false || voice.id === selectedVoices[selectedEngine])
        .map(({ id, label }) => ({ id, label })),
      engine: fallbackReason ? 'windows-sapi' : selectedEngine,
      fallbackReason, lastError: info.lastError || '', local: true };
  }
  function retire() {
    clearTimer(idleTimer); idleTimer = null;
    if (!worker || worker.retired) return;
    const wasPreparing = !worker.ready;
    worker.retired = true;
    clearTimer(worker.startupTimer);
    // Keep the slot until exit; never overlap two native inference processes.
    try { worker.child.kill(); } catch {}
    if (wasPreparing && !disposed) notify();
  }
  function clearPending() {
    if (pending) clearTimer(pending.timer);
    pending = null;
  }
  function fallback(reason) {
    const request = pending;
    clearPending();
    retire();
    fallbackReason = reason;
    if (request && !disposed && selectedEngine !== 'windows-sapi') output.speak(request.text);
    notify();
  }
  function cancel() {
    const hadPending = Boolean(pending);
    clearPending();
    if (hadPending) retire();
    return output.cancel() || hadPending;
  }
  function release() {
    active = false;
    cancel(); retire(); cache.clear(); cacheBytes = 0;
  }
  function setActive(value) {
    if (typeof value !== 'boolean') throw new TypeError('Invalid speech activity');
    if (disposed) return;
    if (!value) { release(); return; }
    active = true;
    clearTimer(idleTimer); idleTimer = null;
    dispatch();
  }
  function select(value) {
    validateReadbackEngine(value);
    if (value === selectedEngine) return;
    const wasActive = active;
    release(); selectedEngine = value; fallbackReason = ''; active = wasActive; notify(); dispatch();
  }
  function selectVoice(engineId, voiceId) {
    validateReadbackVoice(engineId, voiceId);
    if (selectedVoices[engineId] === voiceId) return;
    selectedVoices[engineId] = voiceId;
    if (selectedEngine === engineId) { cancel(); fallbackReason = ''; dispatch(); }
    notify();
  }
  function scheduleIdle() {
    clearTimer(idleTimer);
    if (active) { idleTimer = null; return; }
    idleTimer = setTimer(() => { idleTimer = null; retire(); }, idleTimeoutMs);
    idleTimer?.unref?.();
  }
  function dispatch() {
    if ((!pending && !active) || disposed || worker?.retired || fallbackReason || selectedEngine === 'windows-sapi') return;
    if (!worker) {
      try {
        const definition = READBACK_ENGINES.find(engine => engine.id === selectedEngine);
        const directory = modelDir || path.join(isPackaged ? resourcesPath : path.join(appDir, 'resources'), 'models', definition.modelId);
        const child = spawnWorker(directory, definition);
        const owner = { child, ready: false, retired: false, requestId: null, startupTimer: null };
        worker = owner;
        owner.startupTimer = setTimer(() => {
          if (worker === owner && !owner.retired && !owner.ready) fallback('Kokoro took too long to load. Using Windows TTS.');
        }, requestTimeoutMs);
        owner.startupTimer?.unref?.();
        child.once('spawn', () => { if (owner.retired) { try { child.kill(); } catch {} } });
        child.on('message', message => {
          if (worker !== owner || owner.retired || disposed) return;
          if (message?.type === 'ready') {
            owner.ready = true;
            clearTimer(owner.startupTimer);
            debugLog('Kokoro ready', message.metrics);
            notify();
            dispatch();
          } else if (message?.type === 'error') {
            debugLog('Kokoro worker failed', message.detail);
            if (message.id === undefined || message.id === pending?.id) {
              fallback('Kokoro could not generate speech. Using Windows TTS; select Kokoro again to retry.');
            }
          } else if (message?.type === 'audio' && message.id === pending?.id) {
            let wav;
            try { wav = Buffer.from(message.wav); } catch {}
            if (!wav || wav.length < 44 || wav.length > 1440044 || wav.toString('ascii', 0, 4) !== 'RIFF') {
              fallback('Kokoro returned invalid audio. Using Windows TTS.'); return;
            }
            const cacheKey = pending.cacheKey;
            clearPending(); owner.requestId = null;
            while (cache.size >= 32 || cacheBytes + wav.length > 8 * 1024 * 1024) {
              const key = cache.keys().next().value;
              if (key === undefined) break;
              cacheBytes -= cache.get(key).length; cache.delete(key);
            }
            cache.set(cacheKey, wav); cacheBytes += wav.length;
            debugLog('Kokoro generated', message.metrics);
            output.playAudio(wav);
            scheduleIdle();
          }
        });
        child.on('error', () => {
          if (worker === owner && !owner.retired) fallback('Kokoro stopped. Using Windows TTS.');
        });
        child.once('exit', () => {
          if (worker !== owner) return;
          clearTimer(owner.startupTimer);
          worker = null;
          if (!owner.retired && (pending || active)) fallback('Kokoro stopped. Using Windows TTS.');
          else dispatch();
        });
        notify();
      } catch {
        fallback('Kokoro could not start. Using Windows TTS.');
      }
      return;
    }
    if (pending && worker.ready && worker.requestId !== pending.id) {
      worker.requestId = pending.id;
      try { worker.child.postMessage({ type: 'generate', id: pending.id, text: pending.text, voiceId: pending.voiceId }); }
      catch { fallback('Kokoro could not start speech. Using Windows TTS.'); }
    }
  }
  function speak(value) {
    const text = normalizeReadbackText(value);
    if (disposed || !output.getInfo().available) return false;
    cancel(); clearTimer(idleTimer); idleTimer = null;
    if (selectedEngine === 'windows-sapi' || fallbackReason) return output.speak(text);
    const voiceId = selectedVoices[selectedEngine];
    const cacheKey = `${selectedEngine}:${voiceId}:${text}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey); cache.set(cacheKey, cached);
      scheduleIdle(); return output.playAudio(cached);
    }
    const request = { id: ++sequence, text, voiceId, cacheKey, timer: null };
    pending = request;
    request.timer = setTimer(() => {
      if (pending === request) fallback('Kokoro took too long. Using Windows TTS.');
    }, requestTimeoutMs);
    request.timer?.unref?.();
    dispatch();
    return true;
  }
  function retryOrSelect(value) {
    validateReadbackEngine(value);
    if (value === selectedEngine && fallbackReason) {
      const wasActive = active; release(); fallbackReason = ''; active = wasActive; notify(); dispatch();
    }
    else select(value);
  }
  function dispose() { disposed = true; release(); }
  return Object.freeze({ cancel, dispose, getInfo, release, select: retryOrSelect, selectVoice, setActive, speak });
}

module.exports = { createVoiceReadback, READBACK_ENGINES, validateReadbackEngine, validateReadbackVoice };
