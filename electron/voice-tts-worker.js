'use strict';

// A separate process is intentional: cancellation must stop native inference,
// and a model/runtime failure must not take down the Electron host.
const os = require('node:os');
const path = require('node:path');
const { KOKORO_MODEL } = require('./voice-model-manifest');
const { verifyKokoroModel } = require('./voice-model-integrity');
const { normalizeReadbackText } = require('./windows-local-tts');

function wave(audio) {
  if (audio.sampleRate !== KOKORO_MODEL.sampleRate || !audio.samples?.length
      || audio.samples.length > audio.sampleRate * 30) throw new Error('Invalid generated audio');
  const buffer = Buffer.alloc(44 + audio.samples.length * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(audio.sampleRate, 24); buffer.writeUInt32LE(audio.sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  for (let i = 0; i < audio.samples.length; i++) {
    if (!Number.isFinite(audio.samples[i])) throw new Error('Invalid generated sample');
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio.samples[i])) * 32767), 44 + i * 2);
  }
  return buffer;
}

async function run() {
  const modelDir = process.argv[2];
  // Leave CPU headroom for the simulator. Small machines retain one thread;
  // eight or more logical CPUs can use two, still at below-normal priority.
  const numThreads = ['1', '2'].includes(process.argv[3]) ? Number(process.argv[3])
    : os.availableParallelism() >= 8 ? 2 : 1;
  const post = message => process.parentPort
    ? process.parentPort.postMessage(message) : process.send(message);
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    const start = performance.now();
    await verifyKokoroModel(modelDir);
    const { OfflineTts } = require('sherpa-onnx-node');
    const tts = new OfflineTts({
      model: {
        kokoro: {
          model: path.join(modelDir, 'model.onnx'),
          voices: path.join(modelDir, 'voices.bin'),
          tokens: path.join(modelDir, 'tokens.txt'),
          dataDir: path.join(modelDir, 'espeak-ng-data'),
          lexicon: path.join(modelDir, 'lexicon-us-en.txt'),
          lang: 'en-us',
        },
        numThreads, provider: 'cpu', debug: false,
      },
      maxNumSentences: 1,
    });
    const receive = message => {
      if (message?.type !== 'generate' || !Number.isSafeInteger(message.id)) return;
      try {
        const text = normalizeReadbackText(message.text);
        const voice = KOKORO_MODEL.voices.find(entry => entry.id === (message.voiceId ?? KOKORO_MODEL.defaultVoice));
        if (!voice) throw new TypeError('Unsupported Kokoro voice');
        const began = performance.now();
        const usage = process.cpuUsage();
        // Kokoro's per-request language override selects eSpeak pronunciation,
        // so switching US/UK accents reuses the same loaded native model.
        const audio = tts.generate({ text, enableExternalBuffer: false,
          generationConfig: { sid: voice.speakerId, speed: 1, extra: { lang: voice.language } } });
        post({ type: 'audio', id: message.id, wav: wave(audio),
          metrics: { synthesisMs: performance.now() - began, cpu: process.cpuUsage(usage),
            audioSeconds: audio.samples.length / audio.sampleRate, rss: process.memoryUsage().rss } });
      } catch (error) {
        post({ type: 'error', id: message.id, detail: String(error.message).slice(0, 400) });
      }
    };
    if (process.parentPort) process.parentPort.on('message', event => receive(event.data));
    else { process.on('message', receive); process.on('disconnect', () => process.exit(0)); }
    post({ type: 'ready', metrics: { loadMs: performance.now() - start, rss: process.memoryUsage().rss } });
  } catch (error) {
    post({ type: 'error', detail: String(error.message).slice(0, 400) });
    process.exitCode = 1;
  }
}

if (require.main === module) void run();
