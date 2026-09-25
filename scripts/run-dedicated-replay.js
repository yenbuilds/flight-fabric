#!/usr/bin/env node
'use strict';

// Development acceptance driver. Product entry points remain gated until
// exact PMDG/Fenix motion, animation and camera behavior pass native testing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { resolveCargo } = require('./rust-toolchain');
const ROOT = path.resolve(__dirname, '..');

// Recording titles, paths and native diagnostics are data, not terminal control
// sequences. Preserve the originals in JSON; escape them only for display.
function terminalText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,
    character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function createReplayLogWriter(stream, onFailure, { maxBytes = 8 * 1024 * 1024, maxBufferedBytes = 64 * 1024 } = {}) {
  let written = 0;
  let failed = false;
  const fail = reason => {
    if (failed) return false;
    failed = true;
    onFailure(reason);
    if (!stream.destroyed && !stream.writableEnded) stream.end();
    return false;
  };
  stream.on('error', () => fail('Replay log could not be written; entering recovery.'));
  return data => {
    if (failed) return false;
    const bytes = Buffer.byteLength(data);
    if (written + bytes > maxBytes) return fail('Replay log reached its size limit; entering recovery.');
    if (stream.writableLength + bytes > maxBufferedBytes) return fail('Replay log writer is stalled; entering recovery.');
    written += bytes;
    try { stream.write(data, error => { if (error) fail('Replay log could not be written; entering recovery.'); }); }
    catch { return fail('Replay log could not be written; entering recovery.'); }
    return !failed;
  };
}

function parseArgs(args) {
  const options = { file: null, landing: 0, live: false, recover: false, recordedAt1x: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--recover') options.recover = true;
    else if (arg === '--recorded-at-1x') options.recordedAt1x = true;
    else if (arg === '--landing') {
      const number = Number(args[++i]);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('--landing requires a positive landing number');
      options.landing = number - 1;
    } else if (arg.startsWith('--') || options.file) throw new Error(`Unknown argument: ${arg}`);
    else options.file = path.resolve(arg);
  }
  if (options.recover && (options.file || options.live)) throw new Error('--recover is a separate operation');
  if (!options.recover && !options.file) throw new Error('Supply a recording telemetry.csv, or --recover');
  if (options.live && !options.recordedAt1x) throw new Error('The source simulation rate was not recorded. Confirm a known 1x flight with --recorded-at-1x');
  return options;
}

function parseControl(line, durationMs) {
  const words = line.trim().split(/\s+/);
  const type = words[0];
  if (['start', 'play', 'pause', 'stop'].includes(type) && words.length === 1) return { type };
  if (type === 'restart' && words.length === 1) return { type: 'seek', positionMs: 0 };
  if (type === 'seek' && words.length === 2 && words[1] !== '') {
    const positionMs = Number(words[1]) * 1000;
    if (Number.isFinite(positionMs) && positionMs >= 0 && positionMs <= durationMs) return { type, positionMs };
  }
  throw new Error('Commands: start, play, pause, seek <seconds>, restart, status, stop');
}

// Stop supersedes an outstanding command. Old acknowledgements must not clear
// Stop's timeout, and a failed/closed pipe must never accept another write.
function createReplayController({ input, session, notice = console.error, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  let requestId = 0;
  let closed = false;
  const close = reason => {
    if (closed) return;
    closed = true;
    if (pending) clearTimer(pending.timer);
    pending = null;
    if (reason) notice(reason);
    if (!input.destroyed && !input.writableEnded) input.end();
  };
  input.on('error', () => close('Replay controller pipe failed. Reload recovery remains required.'));
  return {
    close,
    acknowledge(message) {
      if (!pending || !message || message.session !== session || message.requestId !== pending.id || typeof message.ok !== 'boolean') return false;
      clearTimer(pending.timer);
      pending = null;
      return true;
    },
    send(command) {
      if (closed) { notice('Replay controller is closed; no command was sent.'); return false; }
      if (pending) {
        if (command.type !== 'stop') { notice('Wait for the previous command acknowledgement.'); return false; }
        if (pending.type === 'stop') return true;
        clearTimer(pending.timer);
      }
      const id = ++requestId;
      pending = { id, type: command.type, timer: setTimer(() => {
        close('Replay command timed out. Reload the matching parked flight; recovery remains required.');
      }, 5000) };
      try {
        input.write(`${JSON.stringify({ ...command, session, requestId: id })}\n`, error => {
          if (error) close('Replay controller pipe failed. Reload recovery remains required.');
        });
      } catch { close('Replay controller pipe failed. Reload recovery remains required.'); return false; }
      return !closed;
    },
  };
}

function createReplayOutputReader(onMessage, onError) {
  let remainder = '';
  let failed = false;
  return chunk => {
    if (failed) return;
    const lines = (remainder + chunk).split('\n');
    remainder = lines.pop();
    for (const line of lines) {
      try {
        if (line.length > 16384) throw new Error('Native output line exceeds its bound');
        onMessage(JSON.parse(line));
      } catch {
        failed = true; onError('Invalid native output; entering recovery.'); return;
      }
    }
    if (remainder.length > 16384) { failed = true; onError('Invalid native output; entering recovery.'); }
  };
}

function nativeBuildSpec(root, env = process.env) {
  const target = path.join(root, '.tmp', 'dedicated-replay', 'native-target');
  const triple = 'x86_64-pc-windows-msvc';
  return {
    command: resolveCargo({ env, platform: 'win32' }),
    args: ['build', '--release', '--locked', '--manifest-path', path.join(root, 'backend', 'telemetry-provider', 'rust-simconnect-sidecar', 'Cargo.toml'),
      '--target-dir', target, '--target', triple],
    binary: path.join(target, triple, 'release', 'ff-rust-simconnect-sidecar.exe'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const session = crypto.randomUUID();
  const scratch = path.join(ROOT, '.tmp', 'dedicated-replay');
  fs.mkdirSync(scratch, { recursive: true });
  let clip = null;
  let clipPath = null;
  if (!options.recover) {
    const { createFlightCsvStore } = require('../dist/backend/flight-recording/flight-csv-store');
    const store = createFlightCsvStore();
    let result;
    try { result = await store.prepareInSimReplayClip(options.file, options.landing); }
    finally { await store.stop(); }
    if (!result.success || !result.clip) throw new Error(result.error || 'Replay clip unavailable');
    clip = result.clip;
    clipPath = path.join(scratch, `${session}.json`);
    fs.writeFileSync(clipPath, JSON.stringify(clip), { flag: 'wx' });
    console.log(`Prepared ${terminalText(clip.title)} (${terminalText(clip.profileId)}): ${clip.samples.length} samples, ${(clip.durationMs / 1000).toFixed(1)} seconds; touchdown at ${(clip.touchdownMs / 1000).toFixed(1)} seconds.`);
    for (const limitation of clip.limitations) console.log(`- ${limitation}`);
    console.log(`Clip: ${terminalText(clipPath)}`);
    if (!options.live) { console.log('Preparation only: no simulator connection or writes. Add --live --recorded-at-1x for the interactive MSFS 2024 proof.'); return; }
  }
  if (process.platform !== 'win32') throw new Error('The native replay proof requires Windows and MSFS 2024');
  if (!process.stdin.isTTY) throw new Error('Live replay requires an interactive terminal with an accessible Stop command');
  // A released pre-replay sidecar cannot honor the new lease. Reject any
  // existing native bridge as well as relying on the current binary's lease.
  const running = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'ff-rust-simconnect-sidecar.exe'\" -ErrorAction Stop).Count"],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (running.status !== 0 || !/^0\s*$/.test(running.stdout || '')) {
    throw new Error('Close FlightFabric and any existing replay controller first. An existing or unreadable native bridge prevents exclusive replay.');
  }
  const buildSpec = nativeBuildSpec(ROOT);
  const logPath = path.join(scratch, 'build.log');
  const log = fs.openSync(logPath, 'w');
  let build;
  try { build = spawnSync(buildSpec.command, buildSpec.args, { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true }); }
  finally { fs.closeSync(log); }
  if (build.status !== 0) throw new Error(`Native build failed: ${logPath}`);
  const config = require('../dist/backend/core/config');
  const nativeEnv = { ...process.env };
  if (config.lvarSidecar?.dllPath?.trim()) nativeEnv.FF_SIMCONNECT_DLL_PATH = config.lvarSidecar.dllPath.trim();
  const args = ['--dedicated-replay', `--replay-session=${session}`,
    ...(options.recover ? ['--replay-recover'] : [`--replay-clip=${clipPath}`])];
  const child = spawn(buildSpec.binary, args, { windowsHide: true, detached: true, env: nativeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const logStream = fs.createWriteStream(path.join(scratch, `${session}.log`), { flags: 'wx' });
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let lastStatus = null;
  const controller = createReplayController({ input: child.stdin, session });
  const writeLog = createReplayLogWriter(logStream, reason => controller.close(reason));
  console.log('Close FlightFabric throughout this proof. Load the exact recorded aircraft, parked with engines off, in MSFS 2024 at 1x.');
  console.log('start | play | pause | seek <seconds> | restart | status | stop');
  console.log('Stop requires a flight reload into the same parked aircraft. The controller never releases an airborne replay frame.');
  terminal.on('line', line => {
    if (line.trim() === 'status') { console.log(lastStatus ? terminalText(JSON.stringify(lastStatus)) : 'Waiting for native status'); return; }
    try { controller.send(parseControl(line, clip?.durationMs || 0)); } catch (error) { console.log(terminalText(error.message)); }
  });
  terminal.on('SIGINT', () => controller.send({ type: 'stop' }));
  terminal.on('close', () => controller.close());
  child.stderr.on('data', data => { if (writeLog(data)) process.stderr.write(terminalText(data.toString('utf8')) + '\n'); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', createReplayOutputReader(message => {
      writeLog(`${JSON.stringify(message)}\n`);
      if (message.session !== session) throw new Error('Unexpected replay session');
      if (message.type === 'replayAck') {
        if (controller.acknowledge(message)) console.log(terminalText(message.ok ? message.state : message.error));
      } else if (message.type === 'replayStatus') {
        if (message.state !== lastStatus?.state || message.detail !== lastStatus?.detail) {
          console.log(`${terminalText(message.state)}: ${terminalText(message.detail)}`);
        }
        lastStatus = message;
      }
  }, reason => controller.close(reason)));
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Replay worker exited (${code}); if it had started, use --recover and reload before reopening FlightFabric.`)));
  }).finally(() => {
    controller.close(); terminal.close(); logStream.end();
  });
}

module.exports = { parseArgs, parseControl, createReplayController, createReplayOutputReader, nativeBuildSpec, createReplayLogWriter, terminalText };
if (require.main === module) main().catch(error => { console.error(terminalText(error.message)); process.exitCode = 1; });
