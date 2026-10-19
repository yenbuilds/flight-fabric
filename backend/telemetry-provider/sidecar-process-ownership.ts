'use strict';

const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

type SidecarRole = 'lvar' | 'sdk-clientdata' | 'simvars';

type ProcessMetadata = {
  pid: number;
  parentPid: number | null;
  startToken: string | null;
  startedAtMs: number | null;
  commandLine: string | null;
  userSid: string | null;
};

type BackendOwnerIdentity = {
  pid: number;
  token: string;
  startToken: string | null;
  startedAtMs: number;
  userSid: string | null;
};

type SidecarPidRecord = {
  version: number;
  pid: number;
  ownerPid: number | null;
  ownerToken: string | null;
  ownerStartToken: string | null;
  ownerStartedAtMs: number | null;
};

let backendOwnerIdentity: BackendOwnerIdentity | null = null;
let currentWindowsUserSid: string | null | undefined;

function normalizePid(value: unknown): number | null {
  const pid = Math.trunc(Number(value));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeWindowsSid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sid = value.trim().toUpperCase();
  return /^S-\d+(?:-\d+)+$/.test(sid) ? sid : null;
}

function readCurrentWindowsUserSid(): string | null {
  if (process.platform !== 'win32') return null;
  if (currentWindowsUserSid !== undefined) return currentWindowsUserSid;
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    currentWindowsUserSid = result.status === 0
      ? normalizeWindowsSid(result.stdout)
      : null;
  } catch {
    currentWindowsUserSid = null;
  }
  return currentWindowsUserSid;
}

function readProcessMetadata(pidValue: unknown): ProcessMetadata | null {
  const pid = normalizePid(pidValue);
  if (!pid) return null;

  if (process.platform === 'win32') {
    const script = [
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      'if ($p) {',
      '  $startToken=$null',
      '  $startedAtMs=$null',
      '  $userSid=$null',
      '  if ($p.CreationDate) {',
      "    $startToken=$p.CreationDate.ToUniversalTime().ToString('o')",
      '    $startedAtMs=[DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()',
      '  }',
      '  try { $sidResult=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop; if ([int]$sidResult.ReturnValue -eq 0 -and $sidResult.Sid) { $userSid=[string]$sidResult.Sid } } catch {}',
      '  [pscustomobject]@{ pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId; startToken=$startToken; startedAtMs=$startedAtMs; commandLine=$p.CommandLine; userSid=$userSid } | ConvertTo-Json -Compress',
      '}',
    ].join('; ');
    try {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      if (result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) return null;
      const parsed = JSON.parse(result.stdout.trim());
      return {
        pid,
        parentPid: normalizePid(parsed?.parentPid),
        startToken: typeof parsed?.startToken === 'string' && parsed.startToken ? parsed.startToken : null,
        startedAtMs: normalizeFiniteNumber(parsed?.startedAtMs),
        commandLine: typeof parsed?.commandLine === 'string' && parsed.commandLine.trim()
          ? parsed.commandLine.trim()
          : null,
        userSid: normalizeWindowsSid(parsed?.userSid),
      };
    } catch {
      return null;
    }
  }

  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) return null;
    const fieldsAfterCommand = stat.slice(closingParen + 2).trim().split(/\s+/);
    const parentPid = normalizePid(fieldsAfterCommand[1]);
    const startTicks = fieldsAfterCommand[19];
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .replace(/\0/g, ' ')
      .trim();
    return {
      pid,
      parentPid,
      startToken: startTicks ? `proc:${startTicks}` : null,
      startedAtMs: null,
      commandLine: commandLine || null,
      userSid: null,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pidValue: unknown): boolean {
  const pid = normalizePid(pidValue);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only signal-0 result that proves absence. Permission and
    // unexpected query failures mean ownership is unknown, so protect the
    // recorded process instead of treating it as an orphan.
    return !(error && typeof error === 'object'
      && (error as NodeJS.ErrnoException).code === 'ESRCH');
  }
}

function getBackendOwnerIdentity(): BackendOwnerIdentity {
  if (backendOwnerIdentity) return backendOwnerIdentity;
  const metadata = readProcessMetadata(process.pid);
  backendOwnerIdentity = Object.freeze({
    pid: process.pid,
    token: crypto.randomUUID(),
    startToken: metadata?.startToken || null,
    startedAtMs: metadata?.startedAtMs ?? Math.round(Date.now() - (process.uptime() * 1000)),
    userSid: readCurrentWindowsUserSid(),
  });
  return backendOwnerIdentity;
}

function isProcessOwnedByCurrentWindowsUser(
  candidate: ProcessMetadata | null,
  identity: Pick<BackendOwnerIdentity, 'userSid'> = getBackendOwnerIdentity(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const currentSid = normalizeWindowsSid(identity?.userSid);
  const candidateSid = normalizeWindowsSid(candidate?.userSid);
  if (platform !== 'win32' && currentSid == null && candidateSid == null) return true;
  // Query failures and malformed identities are deliberately protected. An
  // elevated backend must never treat an unreadable or cross-session process
  // as one of its own stale children.
  return currentSid != null && candidateSid != null && currentSid === candidateSid;
}

function isSameProcessInstance(
  initial: ProcessMetadata | null,
  confirmed: ProcessMetadata | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!initial || !confirmed || initial.pid !== confirmed.pid) return false;
  if (initial.startToken || confirmed.startToken) {
    return initial.startToken != null
      && confirmed.startToken != null
      && initial.startToken === confirmed.startToken;
  }
  // CreationDate is available for a readable Windows process. Without it the
  // PID may already have been recycled, so Windows cleanup must fail closed.
  return platform !== 'win32';
}

function getSidecarOwnerArgs(identity: BackendOwnerIdentity = getBackendOwnerIdentity()): string[] {
  return [
    `--ff-owner-pid=${identity.pid}`,
    `--ff-owner-token=${identity.token}`,
  ];
}

function buildOwnedPidFilePath(
  basePath: string,
  identity: BackendOwnerIdentity = getBackendOwnerIdentity(),
): string {
  const parsed = path.parse(basePath);
  return path.join(parsed.dir, `${parsed.name}-${identity.pid}-${identity.token}${parsed.ext || '.pid'}`);
}

function listOwnedPidFilePaths(
  ownedPath: string,
  identity: BackendOwnerIdentity = getBackendOwnerIdentity(),
): string[] {
  const parsed = path.parse(ownedPath);
  const ownerSuffix = `-${identity.pid}-${identity.token}`;
  const baseName = parsed.name.endsWith(ownerSuffix)
    ? parsed.name.slice(0, -ownerSuffix.length)
    : parsed.name;
  const extension = parsed.ext || '.pid';
  const legacyName = `${baseName}${extension}`;
  const ownedPrefix = `${baseName}-`;
  const results = new Set<string>([ownedPath]);
  try {
    for (const entry of fs.readdirSync(parsed.dir)) {
      if (entry === legacyName || (entry.startsWith(ownedPrefix) && entry.endsWith(extension))) {
        results.add(path.join(parsed.dir, entry));
      }
    }
  } catch {}
  return Array.from(results);
}

function writeSidecarPidRecord(
  pidFilePath: string,
  childPidValue: unknown,
  identity: BackendOwnerIdentity = getBackendOwnerIdentity(),
): void {
  const childPid = normalizePid(childPidValue);
  if (!childPid) return;
  const record = {
    version: 1,
    pid: childPid,
    ownerPid: identity.pid,
    ownerToken: identity.token,
    ownerStartToken: identity.startToken,
    ownerStartedAtMs: identity.startedAtMs,
  };
  fs.writeFileSync(pidFilePath, JSON.stringify(record), 'utf8');
}

function readSidecarPidRecord(pidFilePath: string): SidecarPidRecord | null {
  let raw = '';
  try {
    raw = fs.readFileSync(pidFilePath, 'utf8').trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const pid = normalizePid(raw);
    return pid
      ? {
          version: 0,
          pid,
          ownerPid: null,
          ownerToken: null,
          ownerStartToken: null,
          ownerStartedAtMs: null,
        }
      : null;
  }

  try {
    const parsed = JSON.parse(raw);
    const pid = normalizePid(parsed?.pid);
    const ownerPid = normalizePid(parsed?.ownerPid);
    const ownerToken = typeof parsed?.ownerToken === 'string' && parsed.ownerToken.trim()
      ? parsed.ownerToken.trim()
      : null;
    if (!pid || !ownerPid || !ownerToken) return null;
    return {
      version: Number(parsed?.version) || 1,
      pid,
      ownerPid,
      ownerToken,
      ownerStartToken: typeof parsed?.ownerStartToken === 'string' && parsed.ownerStartToken
        ? parsed.ownerStartToken
        : null,
      ownerStartedAtMs: normalizeFiniteNumber(parsed?.ownerStartedAtMs),
    };
  } catch {
    return null;
  }
}

function clearSidecarPidFile(pidFilePath: string, expectedPid?: number): void {
  try {
    if (!fs.existsSync(pidFilePath)) return;
    if (typeof expectedPid === 'number') {
      const record = readSidecarPidRecord(pidFilePath);
      if (!record || record.pid !== expectedPid) return;
    }
    fs.unlinkSync(pidFilePath);
  } catch {}
}

function commandLineMatchesOwnerRecord(commandLine: string | null | undefined, record: SidecarPidRecord): boolean {
  if (record.version < 1 || !record.ownerPid || !record.ownerToken) return false;
  const command = String(commandLine || '');
  const hasExactArgument = (argument: string): boolean => {
    const escaped = argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command);
  };
  return hasExactArgument(`--ff-owner-pid=${record.ownerPid}`)
    && hasExactArgument(`--ff-owner-token=${record.ownerToken}`);
}

function isRecordedOwnerDemonstrablyGone(
  record: SidecarPidRecord,
  metadataReader: (pid: number) => ProcessMetadata | null = readProcessMetadata,
): boolean {
  if (record.version < 1 || !record.ownerPid || !record.ownerToken) return false;
  const owner = metadataReader(record.ownerPid);
  if (!owner) {
    return !isProcessAlive(record.ownerPid);
  }

  if (record.ownerStartToken && owner.startToken) {
    return record.ownerStartToken !== owner.startToken;
  }
  if (record.ownerStartedAtMs != null && owner.startedAtMs != null) {
    return Math.abs(record.ownerStartedAtMs - owner.startedAtMs) > 2000;
  }

  // The PID still resolves, but its creation identity cannot be compared.
  // Protect the child because the recorded owner cannot be disproved alive.
  return false;
}

function isLegacySidecarDemonstrablyOrphaned(
  child: ProcessMetadata | null,
  metadataReader: (pid: number) => ProcessMetadata | null = readProcessMetadata,
): boolean {
  if (!child || !child.parentPid) return false;
  const parent = metadataReader(child.parentPid);
  if (!parent) return !isProcessAlive(child.parentPid);

  if (parent.startedAtMs != null && child.startedAtMs != null) {
    return parent.startedAtMs > child.startedAtMs;
  }

  // Exact platform tokens are process-relative (for example Linux boot ticks),
  // so lexical comparison is unsafe. A resolvable parent remains protected.
  return false;
}

function buildParentSafeWindowsCleanupScript(cleanupToken: string, role: SidecarRole): string | null {
  if (!cleanupToken || typeof cleanupToken !== 'string') return null;
  const safePath = cleanupToken.replace(/'/g, "''");
  const roleClause = role === 'simvars'
    ? "$_.CommandLine -match '(?i)(^|\\s)--simvars-bridge(\\s|$)' -and $_.CommandLine -notmatch '(?i)(^|\\s)--sdk-clientdata-bridge(\\s|$)'"
    : role === 'sdk-clientdata'
      ? "$_.CommandLine -match '(?i)(^|\\s)--sdk-clientdata-bridge(\\s|$)' -and $_.CommandLine -notmatch '(?i)(^|\\s)--simvars-bridge(\\s|$)'"
      : "$_.CommandLine -notmatch '(?i)(^|\\s)--simvars-bridge(\\s|$)' -and $_.CommandLine -notmatch '(?i)(^|\\s)--sdk-clientdata-bridge(\\s|$)'";

  return [
    `$target=[regex]::Escape('${safePath}')`,
    '$currentSid=$null',
    'try { $currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}',
    '$all=@(Get-CimInstance Win32_Process)',
    '$byPid=@{}',
    'foreach ($item in $all) { $byPid[[int]$item.ProcessId]=$item }',
    `$procs=$all | Where-Object { $_.CommandLine -and $_.CommandLine -match $target -and ${roleClause} -and $_.ProcessId -ne $PID }`,
    "foreach ($p in $procs) { $candidateSid=$null; try { $sidResult=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop; if ([int]$sidResult.ReturnValue -eq 0 -and $sidResult.Sid) { $candidateSid=[string]$sidResult.Sid } } catch {}; if (-not $currentSid -or -not $candidateSid -or -not [string]::Equals($currentSid, $candidateSid, [System.StringComparison]::OrdinalIgnoreCase)) { continue }; $actualParent=$byPid[[int]$p.ParentProcessId]; $actualParentCouldOwn=[bool]$actualParent; if ($actualParent -and $actualParent.CreationDate -and $p.CreationDate -and $actualParent.CreationDate -gt $p.CreationDate) { $actualParentCouldOwn=$false }; $declaredOwnerCouldOwn=$false; $hasOwnerMetadata=$false; if ($p.CommandLine -match '(?i)(^|\\s)--ff-owner-pid=(\\d+)(\\s|$)') { $hasOwnerMetadata=$true; $declaredOwner=$byPid[[int]$Matches[2]]; $declaredOwnerCouldOwn=[bool]$declaredOwner; if ($declaredOwner -and $declaredOwner.CreationDate -and $p.CreationDate -and $declaredOwner.CreationDate -gt $p.CreationDate) { $declaredOwnerCouldOwn=$false } }; if ($p.CommandLine -match '(?i)(^|\\s)--ff-owner-token=([^\\s]+)(\\s|$)') { $hasOwnerMetadata=$true }; $ownershipDisproved=if ($hasOwnerMetadata) { -not $declaredOwnerCouldOwn -and -not $actualParentCouldOwn } else { -not $actualParentCouldOwn }; if ($ownershipDisproved) { $confirmed=Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$p.ProcessId) -ErrorAction SilentlyContinue; if (-not $confirmed -or -not $p.CreationDate -or -not $confirmed.CreationDate -or $p.CreationDate -ne $confirmed.CreationDate -or -not [string]::Equals([string]$p.CommandLine, [string]$confirmed.CommandLine, [System.StringComparison]::Ordinal)) { continue }; $confirmedSid=$null; try { $confirmedSidResult=Invoke-CimMethod -InputObject $confirmed -MethodName GetOwnerSid -ErrorAction Stop; if ([int]$confirmedSidResult.ReturnValue -eq 0 -and $confirmedSidResult.Sid) { $confirmedSid=[string]$confirmedSidResult.Sid } } catch {}; if (-not $confirmedSid -or -not [string]::Equals($currentSid, $confirmedSid, [System.StringComparison]::OrdinalIgnoreCase)) { continue }; try { Stop-Process -Id $confirmed.ProcessId -Force -ErrorAction Stop } catch {} } }",
  ].join('; ');
}

module.exports = {
  buildOwnedPidFilePath,
  buildParentSafeWindowsCleanupScript,
  clearSidecarPidFile,
  commandLineMatchesOwnerRecord,
  getBackendOwnerIdentity,
  getSidecarOwnerArgs,
  isLegacySidecarDemonstrablyOrphaned,
  isProcessAlive,
  isProcessOwnedByCurrentWindowsUser,
  isSameProcessInstance,
  isRecordedOwnerDemonstrablyGone,
  listOwnedPidFilePaths,
  readProcessMetadata,
  readSidecarPidRecord,
  writeSidecarPidRecord,
};

export {};
