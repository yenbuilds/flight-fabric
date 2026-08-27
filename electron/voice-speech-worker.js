'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { ZIPFORMER_MODEL } = require('./voice-model-manifest');

const MAX_SESSION_SAMPLES = ZIPFORMER_MODEL.sampleRate * 10;
const MAX_TRANSCRIPT_CHARACTERS = 4096;
const FINAL_SILENCE_SECONDS = 0.5;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function modelFile(name) {
  const root = path.resolve(workerData.modelDir);
  const candidate = path.resolve(root, name);
  if (path.dirname(candidate) !== root) throw new Error('Voice model path escaped its directory');
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error('Voice model file is unavailable');
  }
  return candidate;
}

function hotwordsFile() {
  if (typeof workerData.hotwordsPath !== 'string' || !path.isAbsolute(workerData.hotwordsPath)) {
    throw new Error('Voice hotwords path is invalid');
  }
  const candidate = path.resolve(workerData.hotwordsPath);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 128 * 1024) {
    throw new Error('Voice hotwords file is unavailable');
  }
  return candidate;
}

function recognizerConfig() {
  const components = ZIPFORMER_MODEL.components;
  return {
    featConfig: { sampleRate: ZIPFORMER_MODEL.sampleRate, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: modelFile(components.encoder),
        decoder: modelFile(components.decoder),
        joiner: modelFile(components.joiner),
      },
      tokens: modelFile(components.tokens),
      modelingUnit: 'bpe',
      bpeVocab: modelFile(components.bpeVocab),
      numThreads: 2,
      debug: false,
      provider: 'cpu',
    },
    decodingMethod: 'modified_beam_search',
    maxActivePaths: 8,
    hotwordsFile: hotwordsFile(),
    hotwordsScore: 1.5,
    // Push-to-talk release is the only execution boundary. Automatic endpoint
    // finalization can otherwise execute a command while the key is still held.
    enableEndpoint: false,
  };
}

function transcriptFromResult(result) {
  let parsed = result;
  if (typeof result === 'string') {
    try { parsed = JSON.parse(result); } catch { parsed = { text: result }; }
  }
  return typeof parsed?.text === 'string'
    ? parsed.text.trim().slice(0, MAX_TRANSCRIPT_CHARACTERS)
    : '';
}

function post(type, fields = {}) {
  parentPort.postMessage({ type, ...fields });
}

function fail(code, message, sessionId = null, fatal = false) {
  post('error', { code, message, fatal, ...(sessionId ? { sessionId } : {}) });
}

let recognizer = null;
let active = null;

function validateSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function drain(session) {
  let steps = 0;
  while (recognizer.isReady(session.stream)) {
    recognizer.decode(session.stream);
    steps += 1;
    if (steps > 10_000) throw new Error('Recognizer did not drain ready frames');
  }
}

function currentTranscript(session) {
  return transcriptFromResult(recognizer.getResult(session.stream));
}

function finalize(session, reason) {
  // Give the transducer an explicit release tail so the final spoken word is
  // decoded before end-of-input. This is silence, not guessed speech.
  const finalSampleRate = session.sampleRate || ZIPFORMER_MODEL.sampleRate;
  session.stream.acceptWaveform({
    samples: new Float32Array(Math.round(finalSampleRate * FINAL_SILENCE_SECONDS)),
    sampleRate: finalSampleRate,
  });
  session.stream.inputFinished();
  drain(session);
  const text = currentTranscript(session);
  active = null;
  post('final', { sessionId: session.sessionId, text, reason });
}

function requireActive(sessionId) {
  return validateSessionId(sessionId) && active?.sessionId === sessionId ? active : null;
}

function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  try {
    if (message.type === 'start') {
      if (!validateSessionId(message.sessionId) || active) throw new Error('Invalid voice session start');
      // A PTT utterance must have a fresh feature-extractor and decoder state.
      // reset() does not reliably isolate consecutive utterances for this
      // streaming Zipformer model, especially at the previous token boundary.
      const stream = recognizer.createStream();
      active = {
        sessionId: message.sessionId,
        stream,
        nextSequence: 0,
        totalSamples: 0,
        sampleRate: null,
        lastText: '',
      };
      post('started', { sessionId: message.sessionId });
      return;
    }

    if (message.type === 'audio') {
      const session = requireActive(message.sessionId);
      if (!session) return;
      if (!(message.samples instanceof Float32Array)
          || message.samples.length === 0
          || message.samples.length > message.sampleRate
          || !Number.isSafeInteger(message.sequence)
          || message.sequence !== session.nextSequence
          || !Number.isSafeInteger(message.sampleRate)
          || message.sampleRate < 8000
          || message.sampleRate > 192000
          || (session.sampleRate !== null && session.sampleRate !== message.sampleRate)) {
        throw new Error('Invalid voice audio chunk');
      }
      for (const sample of message.samples) {
        if (!Number.isFinite(sample) || sample < -1 || sample > 1) throw new Error('Invalid voice sample');
      }
      const projectedAtModelRate = session.totalSamples
        + Math.ceil(message.samples.length * ZIPFORMER_MODEL.sampleRate / message.sampleRate);
      if (projectedAtModelRate > MAX_SESSION_SAMPLES) throw new Error('Voice session audio exceeded ten seconds');
      session.stream.acceptWaveform({ samples: message.samples, sampleRate: message.sampleRate });
      session.sampleRate = message.sampleRate;
      session.totalSamples = projectedAtModelRate;
      session.nextSequence += 1;
      drain(session);
      post('chunk-accepted', {
        sessionId: session.sessionId,
        sequence: message.sequence,
        samples: message.samples.length,
      });
      const text = currentTranscript(session);
      if (text !== session.lastText) {
        session.lastText = text;
        post('partial', { sessionId: session.sessionId, text });
      }
      return;
    }

    if (message.type === 'finish') {
      const session = requireActive(message.sessionId);
      if (session) finalize(session, 'requested');
      return;
    }

    if (message.type === 'cancel') {
      const session = requireActive(message.sessionId);
      if (!session) return;
      active = null;
      post('cancelled', { sessionId: session.sessionId, reason: 'user' });
      return;
    }

    if (message.type === 'shutdown') {
      active = null;
      recognizer = null;
      post('shutdown-complete');
      parentPort.close();
    }
  } catch (error) {
    const sessionId = validateSessionId(message.sessionId) ? message.sessionId : null;
    if (active && (!sessionId || active.sessionId === sessionId)) {
      active = null;
    }
    fail('RECOGNITION_FAILED', 'Local voice recognition failed.', sessionId, false);
  }
}

async function initialize() {
  try {
    const addon = require('sherpa-onnx-node');
    recognizer = new addon.OnlineRecognizer(recognizerConfig());
    parentPort.on('message', handleMessage);
    post('ready', { modelId: ZIPFORMER_MODEL.id, sampleRate: ZIPFORMER_MODEL.sampleRate });
  } catch {
    fail('ENGINE_INITIALIZATION_FAILED', 'Bundled voice recognition could not be initialized.', null, true);
  }
}

void initialize();
