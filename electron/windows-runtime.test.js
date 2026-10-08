'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  checkWindowsRuntime, ensureWindowsRuntime, registryHasRuntime,
  runRuntimeInstaller, verifyRuntimeInstaller, versionAtLeast,
} = require('./windows-runtime');
const { provisionRuntime } = require('./scripts/provision-vc-runtime');

const installed = '    Installed    REG_DWORD    0x1\r\n    Version    REG_SZ    v14.51.36247.0\r\n';

test('detects adequate x64 runtime versions without rejecting newer servicing updates', () => {
  assert.equal(registryHasRuntime(installed), true);
  assert.equal(registryHasRuntime(installed.replace('0x1', '0x0')), false);
  assert.equal(registryHasRuntime(installed.replace('14.51.36247', '14.44.35211')), false);
  assert.equal(versionAtLeast('14.51.36248.0'), true);
  assert.equal(versionAtLeast('14.52.1.0'), true);
  assert.equal(versionAtLeast('15.0.1.0'), true);
  assert.equal(versionAtLeast('14.51'), false);
});

test('requires runtime DLLs as well as machine registration and supports both registry views', async () => {
  let calls = 0;
  const execute = async (_exe, args) => {
    calls++;
    return { stdout: args.includes('/reg:32') ? installed : '' };
  };
  assert.equal(await checkWindowsRuntime({ execute, exists: () => true }), true);
  assert.equal(calls, 2);
  assert.equal(await checkWindowsRuntime({ execute, exists: file => !file.endsWith('vcruntime140.dll') }), false);
  assert.equal(calls, 2, 'missing DLLs must not be masked by the registry');
  assert.equal(await checkWindowsRuntime({ execute: async () => { throw new Error('access denied'); }, exists: () => true }), false);
});

function scenario({ ready = [false], response = 0, result = 0, invalid = false, interactive = true } = {}) {
  const messages = [];
  let installations = 0;
  let checks = 0;
  const options = {
    resourcesPath: 'C:\\Fixture\\resources', interactive,
    dialog: { showMessageBox: async message => { messages.push(message); return { response }; } },
    check: async () => ready[Math.min(checks++, ready.length - 1)],
    verify: async () => { if (invalid) throw new Error('changed package'); },
    install: async () => { installations++; return result; },
  };
  return { options, messages, installations: () => installations };
}

test('healthy startup does not show prompts or run an installer', async () => {
  const s = scenario({ ready: [true] });
  assert.equal(await ensureWindowsRuntime(s.options), true);
  assert.equal(s.installations(), 0);
  assert.deepEqual(s.messages, []);
});

test('declining the prerequisite or running a noninteractive probe never installs anything', async () => {
  for (const options of [{ response: 1 }, { interactive: false }]) {
    const s = scenario(options);
    assert.equal(await ensureWindowsRuntime(s.options), false);
    assert.equal(s.installations(), 0);
  }
});

test('successful vendor setup must be followed by verified runtime availability', async () => {
  const repaired = scenario({ ready: [false, true] });
  assert.equal(await ensureWindowsRuntime(repaired.options), true);
  assert.equal(repaired.installations(), 1);
  const incomplete = scenario();
  assert.equal(await ensureWindowsRuntime(incomplete.options), false);
  assert.match(incomplete.messages.at(-1).detail, /still unavailable/);
  const newerInstalledConcurrently = scenario({ ready: [false, true], result: 1638 });
  assert.equal(await ensureWindowsRuntime(newerInstalledConcurrently.options), true);
});

test('cancelled, failed, changed or reboot-required prerequisites cannot authorize app startup', async () => {
  for (const result of [1602, 1223, 1603, 3010, 1641, 'timeout', 'launch-failed']) {
    const s = scenario({ ready: [false, true], result });
    assert.equal(await ensureWindowsRuntime(s.options), false, String(result));
    if ([3010, 1641].includes(result)) assert.match(s.messages.at(-1).detail, /Restart when convenient/);
  }
  const altered = scenario({ invalid: true });
  assert.equal(await ensureWindowsRuntime(altered.options), false);
  assert.equal(altered.installations(), 0);
});

test('runtime launch uses fixed no-restart arguments and settles native exit/launch failures', async () => {
  for (const outcome of ['exit', 'error']) {
    let child;
    const result = runRuntimeInstaller('C:\\Fixture\\vc_redist.x64.exe', { launch: (file, args) => {
      assert.equal(file, 'C:\\Fixture\\vc_redist.x64.exe');
      assert.deepEqual(args, ['/install', '/passive', '/norestart']);
      child = new EventEmitter();
      return child;
    } });
    if (outcome === 'exit') child.emit('exit', 1602);
    else child.emit('error', new Error('denied'));
    assert.equal(await result, outcome === 'exit' ? 1602 : 'launch-failed');
  }
});

test('a slow Microsoft installer is not forcibly killed during servicing', async () => {
  const child = new EventEmitter();
  let detached = false;
  child.unref = () => { detached = true; };
  child.kill = () => { throw new Error('must not kill vendor setup'); };
  assert.equal(await runRuntimeInstaller('fixture.exe', { launch: () => child, timeoutMs: 1 }), 'timeout');
  assert.equal(detached, true);
  child.emit('exit', 0); // A late completion cannot authorize startup retroactively.
});

test('changed, truncated and non-file runtime packages are rejected before execution', async () => {
  const scratch = path.resolve(__dirname, '..', '.tmp', 'vc-runtime-unit');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'integrity-'));
  const file = path.join(directory, 'inert.txt');
  const bytes = Buffer.from('explicitly inert integrity fixture');
  const expected = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  try {
    await fs.writeFile(file, bytes);
    await verifyRuntimeInstaller(file, expected);
    bytes[0] ^= 1;
    await fs.writeFile(file, bytes);
    await assert.rejects(verifyRuntimeInstaller(file, expected), /checksum/);
    await fs.writeFile(file, 'truncated');
    await assert.rejects(verifyRuntimeInstaller(file, expected), /size/);
    await assert.rejects(verifyRuntimeInstaller(directory, expected), /type or size/);
  } finally {
    await fs.unlink(file);
    await fs.rmdir(directory);
  }
});

test('provisioning refuses unverified download/cache bytes without invoking signature validation', async () => {
  const scratch = path.resolve(__dirname, '..', '.tmp', 'vc-runtime-unit');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'provision-'));
  let signatureChecks = 0;
  try {
    await assert.rejects(provisionRuntime({ directory,
      fetchImpl: async () => new Response('not a Microsoft executable'),
      verifySignature: async () => { signatureChecks++; },
    }), /size/);
    assert.deepEqual(await fs.readdir(directory), []);
    await fs.writeFile(path.join(directory, 'vc_redist.x64.exe'), 'untrusted cached file');
    await assert.rejects(provisionRuntime({ directory,
      fetchImpl: async () => { throw new Error('must not silently replace unexpected cache input'); },
      verifySignature: async () => { signatureChecks++; },
    }), /size/);
    assert.equal(signatureChecks, 0);
  } finally {
    await fs.unlink(path.join(directory, 'vc_redist.x64.exe')).catch(() => {});
    await fs.rmdir(directory);
  }
});
