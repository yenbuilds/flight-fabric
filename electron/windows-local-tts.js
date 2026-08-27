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

function createWindowsLocalTts({
  debugLog = () => {},
  fileExists = fs.existsSync,
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

  function getInfo() {
    return Object.freeze({
      available,
      engine: available ? 'windows-sapi' : '',
      local: true,
    });
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
        stdio: 'ignore',
        windowsHide: true,
      });
      activeChild = child;
      child.once?.('error', (error) => {
        if (activeChild === child) activeChild = null;
        debugLog('Local Windows readback failed:', error?.message || error);
      });
      child.once?.('exit', (code) => {
        if (activeChild === child) activeChild = null;
        if (code !== 0) debugLog('Local Windows readback exited with code:', code);
      });
      return true;
    } catch (error) {
      activeChild = null;
      debugLog('Local Windows readback failed:', error?.message || error);
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
