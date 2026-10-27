'use strict';

// Run with electron scripts/benchmark-kokoro.js. Silent by default; --play
// exercises Windows playback too. No simulator, microphone or network access.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { KOKORO_MODEL } = require('../voice-model-manifest');
const { app, utilityProcess } = require('electron');
const { createVoiceReadback } = require('../voice-readback');
const { createWindowsLocalTts } = require('../windows-local-tts');

async function main() {
  const allVoices = process.argv.includes('--voices');
  const threads = process.argv.includes('--threads=1') ? 1 : process.argv.includes('--threads=2') ? 2 : os.availableParallelism() >= 8 ? 2 : 1;
  const warm = process.argv.includes('--warm');
  const directory = path.resolve(__dirname, (allVoices ? '../../.tmp/kokoro-voices-benchmark' : '../../.tmp/kokoro-benchmark') + (threads === 2 ? '-threads2' : '') + (warm ? '-warm' : ''));
  fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'electron-user-data'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const reports = [];
  const metrics = [];
  let completion = null;
  let index = 0;
  const children = [];
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const output = createWindowsLocalTts();
  const readback = createVoiceReadback({
    spawnWorker: (modelDir, definition) => {
      const child = utilityProcess.fork(path.join(__dirname, '..', definition.workerFile), [modelDir, String(threads)],
        { stdio: 'ignore', serviceName: 'FlightFabric offline speech benchmark' });
      child.on('message', message => { if (message?.type === 'ready') markReady(); });
      children.push(child); return child;
    },
    debugLog: (label, data) => { metrics.push({ label, ...data }); console.log(label, data); },
    player: {
      getInfo: () => ({ available: true, local: true }),
      cancel: () => output.cancel(),
      speak: () => { completion?.reject(new Error('Unexpected Windows fallback')); return false; },
      playAudio: wav => {
        fs.writeFileSync(path.join(directory, `readback-${index}.wav`), wav);
        if (process.argv.includes('--play')) output.playAudio(wav);
        completion?.resolve({ bytes: wav.length, audioSeconds: (wav.length - 44) / 48000,
          sha256: createHash('sha256').update(wav).digest('hex') });
        return true;
      },
    },
  });
  try {
    readback.select('kokoro');
    if (warm) {
      readback.setActive(true);
      let deadline;
      await Promise.race([ready, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Warmup timed out')), 35000); })])
        .finally(() => clearTimeout(deadline));
    }
    const samples = allVoices ? KOKORO_MODEL.voices.map(voice => ({ voiceId: voice.id, text: 'Heading two seven zero set.' }))
      : ['Heading two seven zero set.', 'Heading two seven zero set.',
        'Altitude ten thousand set.', 'Com one active one two one decimal five zero zero confirmed.']
        .map(text => ({ voiceId: KOKORO_MODEL.defaultVoice, text }));
    for (const { voiceId, text } of samples) {
      index++;
      readback.selectVoice('kokoro', voiceId);
      const started = performance.now();
      let timeout;
      const result = await new Promise((resolve, reject) => {
        completion = { resolve, reject };
        timeout = setTimeout(() => reject(new Error('Benchmark timed out')), 35000);
        readback.speak(text);
      }).finally(() => clearTimeout(timeout));
      reports.push({ voiceId, text, ...result, requestToPlaybackMs: performance.now() - started });
      if (process.argv.includes('--play')) {
        await new Promise(resolve => setTimeout(resolve, result.audioSeconds * 1000 + 1500));
        if (output.getInfo().lastError) throw new Error(output.getInfo().lastError);
      }
    }
    if (allVoices && (children.length !== 1 || new Set(reports.map(report => report.sha256)).size !== samples.length)) {
      throw new Error('Voice selection did not reuse one model and produce distinct audio for every voice');
    }
    if (process.argv.includes('--cancel-check')) {
      let latePlayback = false;
      completion = { resolve: () => { latePlayback = true; }, reject: () => { latePlayback = true; } };
      const child = children.at(-1);
      let timeout;
      const exited = new Promise((resolve, reject) => {
        child.once('exit', resolve);
        timeout = setTimeout(() => reject(new Error('Cancelled synthesis process did not exit')), 5000);
      });
      readback.speak('Selected heading zero nine zero, altitude twelve thousand, speed two five zero.');
      await new Promise(resolve => setTimeout(resolve, 100));
      readback.cancel();
      await exited.finally(() => clearTimeout(timeout));
      if (latePlayback || child.pid !== undefined) throw new Error('Cancelled synthesis was not retired');
      console.log('Native cancellation passed: process exited without late playback or fallback.');
    }
    const report = { cpu: os.cpus()[0].model, ramGiB: os.totalmem() / 1024 ** 3,
      electron: process.versions.electron, threads, provider: 'cpu',
      simulatorMeasured: false, warm, reports, metrics };
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { readback.dispose(); }
}

void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
