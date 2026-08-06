const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildOwnedPidFilePath,
  buildParentSafeWindowsCleanupScript,
  commandLineMatchesOwnerRecord,
  getBackendOwnerIdentity,
  getSidecarOwnerArgs,
  isLegacySidecarDemonstrablyOrphaned,
  isProcessOwnedByCurrentWindowsUser,
  isRecordedOwnerDemonstrablyGone,
  isSameProcessInstance,
  listOwnedPidFilePaths,
  readSidecarPidRecord,
  writeSidecarPidRecord,
} = require('./sidecar-process-ownership.js');

function processMetadata(
  pid: number,
  {
    parentPid = 1,
    startToken = `start-${pid}`,
    startedAtMs = pid * 10,
    userSid = 'S-1-5-21-1000',
  } = {},
) {
  return { pid, parentPid, startToken, startedAtMs, commandLine: `process ${pid}`, userSid };
}

function withProcessKill(
  implementation: (pid: number, signal?: string | number) => boolean,
  run: () => void,
): void {
  const originalKill = process.kill;
  (process as any).kill = implementation;
  try {
    run();
  } finally {
    (process as any).kill = originalKill;
  }
}

test('sidecar ownership metadata uses a per-backend token in PID paths, records, and child args', () => {
  const identity = getBackendOwnerIdentity();
  if (process.platform === 'win32') {
    assert.match(identity.userSid || '', /^S-\d+(?:-\d+)+$/i);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-owner-record-test-'));
  try {
    const ownedPath = buildOwnedPidFilePath(path.join(tempDir, 'flight-fabric-role.pid'), identity);
    writeSidecarPidRecord(ownedPath, 731001, identity);
    const record = readSidecarPidRecord(ownedPath);

    assert.match(path.basename(ownedPath), new RegExp(`^flight-fabric-role-${identity.pid}-${identity.token}\\.pid$`));
    assert.deepEqual(getSidecarOwnerArgs(identity), [
      `--ff-owner-pid=${identity.pid}`,
      `--ff-owner-token=${identity.token}`,
    ]);
    assert.equal(record.pid, 731001);
    assert.equal(record.ownerPid, identity.pid);
    assert.equal(record.ownerToken, identity.token);
    assert.equal(record.ownerStartedAtMs, identity.startedAtMs);

    const foreignPath = path.join(tempDir, 'flight-fabric-role-999-foreign.pid');
    fs.writeFileSync(foreignPath, '{}', 'utf8');
    assert.equal(listOwnedPidFilePaths(ownedPath, identity).includes(foreignPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sidecar ownership metadata keeps null and non-numeric start times untrusted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-owner-parse-test-'));
  const pidFilePath = path.join(tempDir, 'sidecar.pid');
  const baseRecord = {
    version: 1,
    pid: 731005,
    ownerPid: 731006,
    ownerToken: 'owner-parse-token',
  };
  try {
    for (const ownerStartedAtMs of [null, '1000', undefined]) {
      fs.writeFileSync(pidFilePath, JSON.stringify({ ...baseRecord, ownerStartedAtMs }), 'utf8');
      assert.equal(readSidecarPidRecord(pidFilePath)?.ownerStartedAtMs, null);
    }
    fs.writeFileSync(pidFilePath, JSON.stringify({ ...baseRecord, ownerStartedAtMs: 1000 }), 'utf8');
    assert.equal(readSidecarPidRecord(pidFilePath)?.ownerStartedAtMs, 1000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sidecar ownership command-line matching requires exact owner arguments', () => {
  const record = {
    version: 1,
    pid: 731007,
    ownerPid: 731008,
    ownerToken: 'owner-exact-token',
    ownerStartToken: 'owner-start',
    ownerStartedAtMs: 1000,
  };
  const exactArgs = '--ff-owner-pid=731008 --ff-owner-token=owner-exact-token';

  assert.equal(commandLineMatchesOwnerRecord(`"C:\\ff\\sidecar.exe" ${exactArgs}`, record), true);
  assert.equal(commandLineMatchesOwnerRecord(`${exactArgs}0`, record), false);
  assert.equal(commandLineMatchesOwnerRecord(
    '--ff-owner-pid=7310080 --ff-owner-token=owner-exact-token',
    record,
  ), false);
  assert.equal(commandLineMatchesOwnerRecord(`prefix${exactArgs}`, record), false);
});

test('recorded ownership protects a live matching owner and detects PID reuse by start identity', () => {
  const record = {
    version: 1,
    pid: 731010,
    ownerPid: 731011,
    ownerToken: 'owner-a',
    ownerStartToken: 'original-start',
    ownerStartedAtMs: 1000,
  };

  assert.equal(isRecordedOwnerDemonstrablyGone(
    record,
    () => processMetadata(731011, { startToken: 'original-start', startedAtMs: 1000 }),
  ), false);
  assert.equal(isRecordedOwnerDemonstrablyGone(
    record,
    () => processMetadata(731011, { startToken: 'reused-start', startedAtMs: 9000 }),
  ), true);
});

test('recorded ownership kills only after a missing owner is demonstrably gone', () => {
  const record = {
    version: 1,
    pid: 731020,
    ownerPid: 731021,
    ownerToken: 'owner-b',
    ownerStartToken: 'owner-b-start',
    ownerStartedAtMs: 1000,
  };

  withProcessKill(() => true, () => {
    assert.equal(isRecordedOwnerDemonstrablyGone(record, () => null), false);
  });
  for (const code of ['EPERM', 'EACCES', 'UNKNOWN']) {
    withProcessKill(() => {
      const error = new Error(`owner query failed: ${code}`) as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }, () => {
      assert.equal(
        isRecordedOwnerDemonstrablyGone(record, () => null),
        false,
        `${code} must not be treated as proof that the owner exited`,
      );
    });
  }
  withProcessKill(() => {
    const error = new Error('missing') as NodeJS.ErrnoException;
    error.code = 'ESRCH';
    throw error;
  }, () => {
    assert.equal(isRecordedOwnerDemonstrablyGone(record, () => null), true);
  });
});

test('legacy PID ownership protects a live parent and only accepts a verified orphan', () => {
  const child = processMetadata(731030, { parentPid: 731031, startToken: 'child', startedAtMs: 2000 });
  assert.equal(isLegacySidecarDemonstrablyOrphaned(
    child,
    () => processMetadata(731031, { parentPid: 1, startToken: 'parent', startedAtMs: 1000 }),
  ), false);

  withProcessKill(() => true, () => {
    assert.equal(isLegacySidecarDemonstrablyOrphaned(child, () => null), false);
  });
  withProcessKill(() => {
    const error = new Error('missing') as NodeJS.ErrnoException;
    error.code = 'ESRCH';
    throw error;
  }, () => {
    assert.equal(isLegacySidecarDemonstrablyOrphaned(child, () => null), true);
  });
});

test('Windows process cleanup requires an exact, readable current-user SID match', () => {
  const identity = { userSid: 'S-1-5-21-1000' };
  assert.equal(isProcessOwnedByCurrentWindowsUser(
    processMetadata(731040, { userSid: 's-1-5-21-1000' }),
    identity,
    'win32',
  ), true);
  assert.equal(isProcessOwnedByCurrentWindowsUser(
    processMetadata(731041, { userSid: 'S-1-5-21-2000' }),
    identity,
    'win32',
  ), false);
  assert.equal(isProcessOwnedByCurrentWindowsUser(
    processMetadata(731042, { userSid: null }),
    identity,
    'win32',
  ), false);
  assert.equal(isProcessOwnedByCurrentWindowsUser(
    processMetadata(731043),
    { userSid: null },
    'win32',
  ), false);
});

test('process cleanup revalidation rejects PID reuse and missing Windows creation identity', () => {
  const initial = processMetadata(731050, { startToken: 'original-start' });
  assert.equal(isSameProcessInstance(
    initial,
    processMetadata(731050, { startToken: 'original-start' }),
    'win32',
  ), true);
  assert.equal(isSameProcessInstance(
    initial,
    processMetadata(731050, { startToken: 'reused-start' }),
    'win32',
  ), false);
  assert.equal(isSameProcessInstance(
    processMetadata(731050, { startToken: null }),
    processMetadata(731050, { startToken: null }),
    'win32',
  ), false);
});

test('Windows cleanup scripts are role-strict and require disproved parent ownership', () => {
  const binary = 'C:\\ff\\ff-rust-simconnect-sidecar.exe';
  const sdkScript = buildParentSafeWindowsCleanupScript(binary, 'sdk-clientdata');
  const lvarScript = buildParentSafeWindowsCleanupScript(binary, 'lvar');
  const simvarScript = buildParentSafeWindowsCleanupScript(binary, 'simvars');

  assert.match(sdkScript, /-match '\(\?i\)\(\^\|\\s\)--sdk-clientdata-bridge/);
  assert.match(sdkScript, /-notmatch '\(\?i\)\(\^\|\\s\)--simvars-bridge/);
  assert.match(lvarScript, /-notmatch '\(\?i\)\(\^\|\\s\)--sdk-clientdata-bridge/);
  assert.match(lvarScript, /-notmatch '\(\?i\)\(\^\|\\s\)--simvars-bridge/);
  assert.match(simvarScript, /-match '\(\?i\)\(\^\|\\s\)--simvars-bridge/);
  for (const script of [sdkScript, lvarScript, simvarScript]) {
    assert.match(script, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
    assert.match(script, /GetOwnerSid/);
    assert.match(script, /StringComparison\]::OrdinalIgnoreCase/);
    assert.match(script, /\{ continue \}/);
    assert.match(script, /\$confirmed=Get-CimInstance Win32_Process/);
    assert.match(script, /\$p\.CreationDate -ne \$confirmed\.CreationDate/);
    assert.match(script, /\$p\.CommandLine, \[string\]\$confirmed\.CommandLine/);
    assert.match(script, /\$confirmedSid/);
    assert.match(script, /Stop-Process -Id \$confirmed\.ProcessId/);
    assert.match(script, /\$actualParentCouldOwn/);
    assert.match(script, /\$declaredOwnerCouldOwn/);
    assert.match(script, /\$ownershipDisproved/);
  }
});

export {};
