'use strict';

const { execFileSync } = require('node:child_process');
const {
  hasSameWindowsOwner,
  isSameWindowsProcessIdentity,
  normalizeWindowsProcessIdentity,
  normalizeWindowsSid,
} = require('../../electron/backend-process-identity');

function normalizePid(value) {
  const pid = Math.trunc(Number(value));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readWindowsProcessIdentity(pidValue) {
  const pid = normalizePid(pidValue);
  if (!pid || process.platform !== 'win32') return null;

  const psScript = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if (-not $p) { exit 3 }',
    '$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid',
    'if (-not $owner -or $owner.ReturnValue -ne 0) { exit 4 }',
    '$identity=[pscustomobject]@{pid=[int]$p.ProcessId;commandLine=[string]$p.CommandLine;creationToken=$p.CreationDate.ToUniversalTime().Ticks.ToString();ownerSid=[string]$owner.Sid}',
    '[Console]::Out.Write(($identity | ConvertTo-Json -Compress))',
  ].join('; ');

  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return normalizeWindowsProcessIdentity(JSON.parse(output));
  } catch {
    return null;
  }
}

function readCurrentWindowsOwnerSid() {
  if (process.platform !== 'win32') return '';
  const psScript = [
    '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()',
    'if (-not $identity -or -not $identity.User) { exit 3 }',
    '[Console]::Out.Write($identity.User.Value)',
  ].join('; ');
  try {
    return normalizeWindowsSid(execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ));
  } catch {
    return '';
  }
}

function hasExactCommandLineArgument(commandLine, expectedArgument) {
  if (typeof commandLine !== 'string' || typeof expectedArgument !== 'string' || !expectedArgument) {
    return false;
  }
  const escaped = expectedArgument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)"?${escaped}"?(?=\\s|$)`).test(commandLine);
}

function captureCurrentUserWindowsProcessIdentity(pid, options = {}) {
  const readProcessIdentity = options.readProcessIdentity || readWindowsProcessIdentity;
  const ownerSid = options.ownerSid === undefined
    ? readCurrentWindowsOwnerSid()
    : normalizeWindowsSid(options.ownerSid);
  const predicate = typeof options.predicate === 'function' ? options.predicate : () => true;
  const identity = readProcessIdentity(pid);
  if (!identity || !ownerSid || !hasSameWindowsOwner(identity, ownerSid)) return null;
  try {
    return predicate(identity) ? identity : null;
  } catch {
    return null;
  }
}

function taskkillWindowsProcessTree(pid) {
  execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    timeout: 5000,
    windowsHide: true,
  });
}

function forceStopVerifiedWindowsProcessTree(initialIdentity, options = {}) {
  const normalizedInitial = normalizeWindowsProcessIdentity(initialIdentity);
  if (!normalizedInitial) return false;
  const readProcessIdentity = options.readProcessIdentity || readWindowsProcessIdentity;
  const stopProcessTree = options.stopProcessTree || taskkillWindowsProcessTree;
  const currentIdentity = readProcessIdentity(normalizedInitial.pid);
  if (!isSameWindowsProcessIdentity(normalizedInitial, currentIdentity)) return false;
  try {
    stopProcessTree(normalizedInitial.pid);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  captureCurrentUserWindowsProcessIdentity,
  forceStopVerifiedWindowsProcessTree,
  hasExactCommandLineArgument,
  readCurrentWindowsOwnerSid,
  readWindowsProcessIdentity,
};
