'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_READBACK_CHARS = 240;
const READBACK_ENV_KEY = 'FLIGHT_FABRIC_LOCAL_READBACK';

function normalizeReadbackText(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > MAX_READBACK_CHARS
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('Invalid local readback text');
  }
  const text = value.replace(/\s+/gu, ' ').trim();
  if (!text) throw new TypeError('Invalid local readback text');
  return text;
}

const MAX_STDERR_CHARS = 400;

function createWindowsLocalTts({
  debugLog = () => {},
  fileExists = fs.existsSync,
  now = Date.now,
  onErrorChange = () => {},
  platform = process.platform,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
} = {}) {
  const executable = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const available = platform === 'win32' && fileExists(executable);
  let activeChild = null;
  // The packaged app writes no debug log, so the last failure is kept here
  // for the renderer to show; a later successful readback clears it.
  let lastError = '';

  function getInfo() {
    return Object.freeze({
      available,
      engine: available ? 'windows-sapi' : '',
      lastError,
      local: true,
    });
  }

  function setLastError(message) {
    const next = String(message || '').replace(/\s+/gu, ' ').trim().slice(0, MAX_STDERR_CHARS);
    if (next === lastError) return;
    lastError = next;
    if (next) debugLog('Local Windows readback failed:', next);
    try { onErrorChange(next); } catch {}
  }

  /**
   * PowerShell prints the thrown SAPI error to stderr, hard-wrapped at the
   * console width, followed by "At line:" / "+ ..." script context. Keep the
   * message lines and drop the context.
   */
  function errorMessage(stderr) {
    const lines = [];
    for (const raw of stderr.split(/\r?\n/u)) {
      const line = raw.trim();
      if (/^(At line:|\+ )/u.test(line)) break;
      if (line) lines.push(line);
    }
    return lines.join(' ');
  }

  function cancel() {
    const child = activeChild;
    activeChild = null;
    if (!child || child.exitCode !== null || child.killed === true) return false;
    try {
      return child.kill() === true;
    } catch (error) {
      debugLog('Local readback cancellation failed:', error?.message || error);
      return false;
    }
  }

  function speak(value) {
    const text = normalizeReadbackText(value);
    if (!available) return false;
    cancel();

    // The utterance is passed as encoded data to a fixed PowerShell program.
    // Renderer text is never interpreted as script.
    const utterance = Buffer.from(text, 'utf8').toString('base64');
    const script = [
      "$ErrorActionPreference='Stop'",
      `$encoded=[Environment]::GetEnvironmentVariable('${READBACK_ENV_KEY}','Process')`,
      '$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))',
      '$voice=New-Object -ComObject SAPI.SpVoice',
      'try{[void]$voice.Speak($text)}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($voice)}',
    ].join(';');

    try {
      const child = spawnProcess(executable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        env: { ...process.env, [READBACK_ENV_KEY]: utterance },
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      activeChild = child;
      const startedAt = now();
      let stderr = '';
      child.stderr?.on?.('data', (chunk) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += String(chunk);
      });
      let failedToStart = false;
      child.once?.('error', (error) => {
        if (activeChild === child) activeChild = null;
        failedToStart = true;
        setLastError(`PowerShell could not start: ${error?.message || error}`);
      });
      // 'close' rather than 'exit': stderr can still be delivering the SAPI
      // error text when 'exit' fires.
      child.once?.('close', (code) => {
        if (activeChild === child) activeChild = null;
        // A readback replaced or cancelled on purpose is not a failure, and a
        // spawn failure was already reported through 'error'.
        if (child.killed === true || failedToStart) return;
        if (code === 0) {
          debugLog(`Local Windows readback finished in ${now() - startedAt} ms`);
          setLastError('');
          return;
        }
        const detail = errorMessage(stderr);
        setLastError(`Readback exited with code ${code}${detail ? `: ${detail}` : ''}`);
      });
      return true;
    } catch (error) {
      activeChild = null;
      setLastError(`PowerShell could not start: ${error?.message || error}`);
      return false;
    }
  }

  return Object.freeze({ cancel, getInfo, speak });
}

module.exports = {
  MAX_READBACK_CHARS,
  READBACK_ENV_KEY,
  createWindowsLocalTts,
  normalizeReadbackText,
};
