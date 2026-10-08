'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const manifest = require('./vc-runtime.json');
const execFileAsync = promisify(execFile);
const RUNTIME_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
const REGISTRY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';

function versionAtLeast(value, minimum = manifest.minimumVersion) {
  const parse = text => /^v?\d+\.\d+\.\d+\.\d+$/.test(text || '')
    ? text.replace(/^v/, '').split('.').map(Number) : null;
  const actual = parse(value);
  const required = parse(minimum);
  if (!actual || !required) return false;
  for (let i = 0; i < 4; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

function registryHasRuntime(output) {
  return /^\s*Installed\s+REG_DWORD\s+0x1\s*$/mi.test(output)
    && versionAtLeast(output.match(/^\s*Version\s+REG_SZ\s+(\S+)\s*$/mi)?.[1]);
}

async function checkWindowsRuntime({
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
  execute = execFileAsync,
  exists = fs.existsSync,
} = {}) {
  // FlightFabric's packaged Windows app and its native helpers are x64.
  if (!RUNTIME_DLLS.every(name => exists(path.join(systemRoot, 'System32', name)))) return false;
  const registry = path.join(systemRoot, 'System32', 'reg.exe');
  const results = await Promise.all([64, 32].map(async view => {
    try {
      const { stdout } = await execute(registry, ['query', REGISTRY_KEY, `/reg:${view}`], {
        windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8',
      });
      return registryHasRuntime(stdout);
    } catch { return false; }
  }));
  return results.some(Boolean);
}

async function verifyRuntimeInstaller(file, expected = manifest) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) {
    throw new Error('Microsoft runtime installer has an unexpected file type or size.');
  }
  const hash = crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
  if (hash !== expected.sha256) throw new Error('Microsoft runtime installer checksum does not match.');
}

function runRuntimeInstaller(file, { launch = spawn, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    let child;
    try {
      child = launch(file, ['/install', '/passive', '/norestart'], { windowsHide: true, stdio: 'ignore' });
    } catch { finish('launch-failed'); return; }
    child.once('error', () => finish('launch-failed'));
    child.once('exit', code => finish(code));
    timer = setTimeout(() => {
      // Never kill a Microsoft installation mid-servicing. The app stays closed;
      // the user can finish that installer and reopen FlightFabric afterward.
      child.unref();
      finish('timeout');
    }, timeoutMs);
  });
}

async function ensureWindowsRuntime({
  dialog, resourcesPath, interactive = true,
  check = checkWindowsRuntime, verify = verifyRuntimeInstaller, install = runRuntimeInstaller,
}) {
  if (await check()) return true;
  if (!interactive) return false;
  const { response } = await dialog.showMessageBox({
    type: 'warning', title: 'FlightFabric needs a Microsoft runtime',
    message: 'Install the Microsoft Visual C++ x64 runtime to start FlightFabric.',
    detail: 'This component supports the simulator connection and voice controls. Windows may ask for administrator permission. Your computer will not restart automatically.',
    buttons: ['Install Microsoft runtime', 'Quit FlightFabric'], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return false;
  const installer = path.join(resourcesPath, 'vc-runtime', manifest.fileName);
  let code;
  try {
    await verify(installer);
    code = await install(installer);
  } catch { code = 'invalid-installer'; }
  // Even a successful exit is insufficient without a usable installed runtime.
  if ((code === 0 || code === 1638) && await check()) return true;
  const detail = code === 3010 || code === 1641
    ? 'Windows needs a restart to finish installing the Microsoft runtime. Restart when convenient, then open FlightFabric again.'
    : code === 'timeout'
      ? 'Microsoft runtime setup has not finished. Wait for it to complete, then open FlightFabric again.'
      : 'The required Microsoft runtime is still unavailable. Run FlightFabric Setup again and allow the Microsoft runtime installation, or ask your administrator for help.';
  await dialog.showMessageBox({
    type: 'warning', title: 'FlightFabric setup is incomplete',
    message: 'FlightFabric cannot start yet.', detail,
    buttons: ['Quit FlightFabric'], defaultId: 0, cancelId: 0,
  });
  return false;
}

module.exports = { checkWindowsRuntime, ensureWindowsRuntime, registryHasRuntime, runRuntimeInstaller, verifyRuntimeInstaller, versionAtLeast };
