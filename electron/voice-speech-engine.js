'use strict';

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ZIPFORMER_MODEL } = require('./voice-model-manifest');
const { verifyVoiceHotwords, verifyZipformerModel } = require('./voice-model-integrity');

const SESSION_TIMEOUT_MS = 10_000;
const FINALIZATION_TIMEOUT_MS = 6_000;
const INITIALIZATION_TIMEOUT_MS = 30_000;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function resolveVoiceModelDir({ appDir, isPackaged, resourcesPath }) {
  const root = isPackaged ? path.resolve(resourcesPath) : path.resolve(appDir, 'resources');
  return path.join(root, 'models', ZIPFORMER_MODEL.id);
}

function resolveVoiceHotwordsPath({ appDir, isPackaged, resourcesPath }) {
  return isPackaged
    ? path.join(path.resolve(resourcesPath), 'voice', 'hotwords.txt')
    : path.join(path.resolve(appDir), 'resources', 'voice', 'hotwords.txt');
}

function createVoiceSpeechEngine({
  appDir = __dirname,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  modelDir = resolveVoiceModelDir({ appDir, isPackaged, resourcesPath }),
  hotwordsPath = resolveVoiceHotwordsPath({ appDir, isPackaged, resourcesPath }),
  workerPath = path.join(__dirname, 'voice-speech-worker.js'),
  WorkerClass = Worker,
  verifyHotwords = verifyVoiceHotwords,
  verifyModel = verifyZipformerModel,
  initializationTimeoutMs = INITIALIZATION_TIMEOUT_MS,
} = {}) {
  const events = new EventEmitter();
  let state = 'new';
  let worker = null;
  let active = null;
  let initializePromise = null;
  let initializationTimer = null;
  let initializeResolve = null;
  let initializeReject = null;

  function info() {
    return Object.freeze({
      activeSessionId: active?.sessionId || null,
      modelId: ZIPFORMER_MODEL.id,
      ready: state === 'ready',
      sampleRate: ZIPFORMER_MODEL.sampleRate,
      state,
      timeoutMs: SESSION_TIMEOUT_MS,
    });
  }

  function emit(payload) {
    events.emit('event', Object.freeze({ ...payload }));
  }

  function clearActive(sessionId) {
    if (!active || active.sessionId !== sessionId) return;
    clearTimeout(active.sessionTimer);
    clearTimeout(active.finalizationTimer);
    active = null;
  }

  function failInitialization(error) {
    if (initializationTimer) clearTimeout(initializationTimer);
    initializationTimer = null;
    state = 'failed';
    initializeReject?.(error);
    initializeResolve = null;
    initializeReject = null;
    initializePromise = null;
  }

  function onWorkerMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'ready') {
      if (initializationTimer) clearTimeout(initializationTimer);
      initializationTimer = null;
      state = 'ready';
      initializeResolve?.(info());
      initializeResolve = null;
      initializeReject = null;
      emit({ type: 'ready', ...info() });
      return;
    }
    if (message.type === 'chunk-accepted') {
      if (active?.sessionId === message.sessionId) {
        const sampleCount = active.outstanding.get(message.sequence);
        if (sampleCount === message.samples) {
          active.outstanding.delete(message.sequence);
          active.pendingSamples = Math.max(0, active.pendingSamples - sampleCount);
        }
      }
      return;
    }
    if (message.type === 'final' || message.type === 'cancelled') {
      clearActive(message.sessionId);
    }
    if (message.type === 'error') {
      if (message.sessionId) clearActive(message.sessionId);
      if (message.fatal === true) {
        const error = new Error(message.message || 'Voice engine failed');
        const failedWorker = worker;
        worker = null;
        if (state === 'starting') failInitialization(error);
        else state = 'failed';
        void Promise.resolve(failedWorker?.terminate?.()).catch(() => {});
      }
    }
    if (['started', 'partial', 'final', 'cancelled', 'error'].includes(message.type)) emit(message);
  }

  async function initialize() {
    if (state === 'ready') return info();
    if (state === 'starting' && initializePromise) return initializePromise;
    if (state === 'stopping') throw new Error('Voice recognition is shutting down');
    state = 'starting';
    try {
      await Promise.all([verifyModel(modelDir), verifyHotwords(hotwordsPath)]);
      const spawnedWorker = new WorkerClass(path.resolve(workerPath), {
        workerData: { hotwordsPath, modelDir },
      });
      worker = spawnedWorker;
      spawnedWorker.on('message', (message) => {
        if (worker === spawnedWorker) onWorkerMessage(message);
      });
      spawnedWorker.on('error', (error) => {
        if (worker !== spawnedWorker) return;
        worker = null;
        if (state === 'starting') failInitialization(error);
        else {
          state = 'failed';
          if (active) clearActive(active.sessionId);
          emit({ type: 'error', code: 'WORKER_FAILED', fatal: true, message: 'Local voice worker stopped.' });
        }
      });
      spawnedWorker.on('exit', (code) => {
        if (worker !== spawnedWorker) return;
        if (state !== 'stopping' && state !== 'stopped' && code !== 0) {
          worker = null;
          const error = new Error('Local voice worker exited during initialization.');
          if (state === 'starting') failInitialization(error);
          else state = 'failed';
          if (active) clearActive(active.sessionId);
          emit({ type: 'error', code: 'WORKER_EXITED', fatal: true, message: 'Local voice worker exited.' });
        }
      });
      initializePromise = new Promise((resolve, reject) => {
        initializeResolve = resolve;
        initializeReject = reject;
      });
      initializationTimer = setTimeout(() => {
        failInitialization(new Error('Voice recognition initialization timed out'));
        const timedOutWorker = worker;
        worker = null;
        void Promise.resolve(timedOutWorker?.terminate?.()).catch(() => {});
      }, initializationTimeoutMs);
      return initializePromise;
    } catch (error) {
      failInitialization(error);
      throw error;
    }
  }

  function start() {
    if (state !== 'ready' || !worker) throw new Error('Voice recognition is not ready');
    if (active) throw new Error('A voice session is already active');
    const sessionId = randomUUID();
    active = {
      sessionId,
      nextSequence: 0,
      sampleRate: null,
      totalSamples: 0,
      pendingSamples: 0,
      outstanding: new Map(),
      finishing: false,
      sessionTimer: setTimeout(() => finish(sessionId), SESSION_TIMEOUT_MS + 1000),
      finalizationTimer: null,
    };
    worker.postMessage({ type: 'start', sessionId });
    return Object.freeze({ sessionId, sampleRate: ZIPFORMER_MODEL.sampleRate, timeoutMs: SESSION_TIMEOUT_MS });
  }

  function pushAudio({ sessionId, sequence, sampleRate, samples }) {
    const session = active;
    if (!session || session.sessionId !== sessionId || session.finishing) throw new Error('No matching voice session is active');
    if (!Number.isSafeInteger(sequence) || sequence !== session.nextSequence) throw new Error('Voice audio chunks must be ordered');
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid voice sample rate');
    if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > sampleRate) throw new Error('Invalid voice samples');
    if (session.sampleRate !== null && session.sampleRate !== sampleRate) throw new Error('Voice sample rate changed');
    if (session.pendingSamples + samples.length > sampleRate * 4) throw new Error('Voice worker queue is full');
    if (session.totalSamples + samples.length > sampleRate * 10) throw new Error('Voice session exceeded ten seconds');
    for (const sample of samples) {
      if (!Number.isFinite(sample) || sample < -1 || sample > 1) throw new Error('Voice samples must be normalized');
    }
    const copy = new Float32Array(samples);
    session.sampleRate = sampleRate;
    session.nextSequence += 1;
    session.totalSamples += copy.length;
    session.pendingSamples += copy.length;
    session.outstanding.set(sequence, copy.length);
    worker.postMessage({ type: 'audio', sessionId, sequence, sampleRate, samples: copy }, [copy.buffer]);
    return Object.freeze({ accepted: true, sequence });
  }

  function finish(sessionId) {
    if (!SESSION_ID_RE.test(sessionId || '') || active?.sessionId !== sessionId || active.finishing) return false;
    active.finishing = true;
    clearTimeout(active.sessionTimer);
    active.finalizationTimer = setTimeout(() => {
      if (active?.sessionId !== sessionId) return;
      clearActive(sessionId);
      state = 'failed';
      emit({ type: 'error', sessionId, code: 'FINALIZATION_TIMEOUT', fatal: true, message: 'Voice recognition did not finish in time.' });
      void worker?.terminate();
    }, FINALIZATION_TIMEOUT_MS);
    worker.postMessage({ type: 'finish', sessionId });
    return true;
  }

  function cancel(sessionId) {
    if (!SESSION_ID_RE.test(sessionId || '') || active?.sessionId !== sessionId) return false;
    clearActive(sessionId);
    worker?.postMessage({ type: 'cancel', sessionId });
    emit({ type: 'cancelled', sessionId, reason: 'user' });
    return true;
  }

  async function shutdown() {
    if (!worker) {
      state = 'stopped';
      return;
    }
    state = 'stopping';
    if (active) clearActive(active.sessionId);
    const currentWorker = worker;
    worker = null;
    try { currentWorker.postMessage({ type: 'shutdown' }); } catch {}
    await Promise.race([
      currentWorker.terminate(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    state = 'stopped';
  }

  return Object.freeze({
    cancel,
    finish,
    getInfo: info,
    initialize,
    onEvent(callback) {
      events.on('event', callback);
      return () => events.off('event', callback);
    },
    pushAudio,
    shutdown,
    start,
  });
}

module.exports = { createVoiceSpeechEngine, resolveVoiceHotwordsPath, resolveVoiceModelDir };
