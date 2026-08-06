const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

type EnvSnapshot = Record<string, string | undefined>;

const ENV_KEYS = [
  'APPDATA',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'DEBUG_ENABLE',
  'ELECTRON_PACKAGED',
  'FLIGHT_ENV_MODE',
];

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function clearCoreModuleCache(): void {
  for (const modulePath of [
    './debug',
    './config',
    './user-settings',
    './time-source',
    '../utils/storage-paths',
  ]) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {}
  }
}

test('packaged debug logging redacts cyclic objects without throwing', () => {
  const envSnapshot = snapshotEnv();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-debug-test-'));
  const originalLog = console.log;

  try {
    process.env.APPDATA = path.join(tempRoot, 'AppData', 'Roaming');
    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    process.env.XDG_CONFIG_HOME = path.join(tempRoot, '.config');
    process.env.DEBUG_ENABLE = '1';
    process.env.ELECTRON_PACKAGED = '1';
    process.env.FLIGHT_ENV_MODE = 'packaged';
    clearCoreModuleCache();

    console.log = () => {};
    const Debug = require('./debug') as typeof import('./debug');
    const entries: Array<Record<string, any>> = [];
    Debug.init((payload: Record<string, any>) => {
      entries.push(payload);
    });

    const cyclic: Record<string, unknown> = {
      filePath: path.join(tempRoot, 'Flight Fabric', 'flight.csv'),
    };
    cyclic.self = cyclic;

    assert.doesNotThrow(() => {
      Debug.log('debug-test', `path ${path.join(tempRoot, 'flight.csv')}`, cyclic);
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].entry.data.filePath.includes(tempRoot), false);
    assert.equal(entries[0].entry.data.self, '[Circular]');
  } finally {
    console.log = originalLog;
    restoreEnv(envSnapshot);
    clearCoreModuleCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
