'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { selectSimConnectDllSource } = require('../../electron/build-electron');
const {
  SDK_FEED_URL,
  SIMCONNECT_DLL_RELATIVE,
  getSdkDllPath,
  latestRetailSdk,
  fetchLatestRetailSdk,
  verifyLatestSimConnectRuntime: verifyRuntime,
  assertSimConnectDllMatches,
} = require('../../scripts/simconnect-sdk');

const verifyLatestSimConnectRuntime = options => verifyRuntime({ manifestPath: null, ...options });

function release(version, channel = 'retail') {
  return {
    version: '99.0.0.0', // A simulator version must never be used as the SDK version.
    online_doc: `https://docs.flightsimulator.com/msfs2024/${channel}/introduction/sdk-release-notes/`,
    downloads_menu: {
      'SDK Installer (Core)': {
        type: 'DownloadURL',
        value: `installers/${version}/MSFS2024_SDK_Core_Installer_${version}.zip`,
      },
    },
    release_notes: ['99.0.0', version],
  };
}

const feed = { game_versions: [release('1.8.0', 'flighting'), release('1.7.3'), release('1.7.3')] };
const fetchImpl = async () => ({ ok: true, json: async () => feed });

function fixture(t, version = '1.7.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-simconnect-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdkRoot = path.join(root, 'SDK');
  const sdkDll = getSdkDllPath(sdkRoot);
  const sourceDir = path.join(root, 'backend');
  const sourceDll = path.join(sourceDir, SIMCONNECT_DLL_RELATIVE);
  const runtimeDir = path.join(root, 'dist-backend');
  const runtimeDll = path.join(runtimeDir, SIMCONNECT_DLL_RELATIVE);
  const packagedDll = path.join(root, 'resources', 'backend', SIMCONNECT_DLL_RELATIVE);
  for (const file of [sdkDll, sourceDll, runtimeDll, packagedDll]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'latest retail DLL bytes');
  }
  fs.writeFileSync(path.join(sdkRoot, 'version.txt'), `\uFEFF${version} \r\n`);
  return { root, sdkRoot, sdkDll, sourceDir, sourceDll, runtimeDir, runtimeDll, packagedDll };
}

test('latest retail uses Core installer version, ignoring preview, simulator and release-note versions', () => {
  assert.deepEqual(latestRetailSdk(feed), {
    version: '1.7.3',
    downloadUrl: 'https://sdk.flightsimulator.com/msfs2024/files/installers/1.7.3/MSFS2024_SDK_Core_Installer_1.7.3.zip',
  });
});

test('release selection compares numeric components regardless of feed order', () => {
  assert.equal(latestRetailSdk({ game_versions: [release('1.9.8'), release('1.10.2'), release('1.10.1')] }).version, '1.10.2');
});

test('missing or preview-only retail data cannot silently pass', () => {
  for (const invalid of [{}, { game_versions: [] }, { game_versions: [release('1.8.0', 'flighting')] }]) {
    assert.throws(() => latestRetailSdk(invalid), /missing game_versions|no recognized retail/);
  }
});

test('changed feed schema and mismatched installer version fail closed', () => {
  for (const value of [
    'installers/1.7.3/MSFS2024_SDK_Core_Installer_1.7.2.zip',
    'https://example.com/installers/1.7.3/MSFS2024_SDK_Core_Installer_1.7.3.zip',
    '../installers/1.7.3/MSFS2024_SDK_Core_Installer_1.7.3.zip',
    null,
  ]) {
    const entry = release('1.7.3');
    entry.downloads_menu['SDK Installer (Core)'].value = value;
    assert.throws(() => latestRetailSdk({ game_versions: [entry] }), /unrecognized Core installer/);
  }
  const entry = release('1.7.3');
  entry.online_doc = 'https://example.com/msfs2024/retail/introduction/sdk-release-notes/';
  assert.throws(() => latestRetailSdk({ game_versions: [entry] }), /no recognized retail/);
});

test('feed request is bounded, current and cannot follow redirects', async () => {
  const result = await fetchLatestRetailSdk({ fetchImpl: async (url, options) => {
    assert.equal(url, SDK_FEED_URL);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    return fetchImpl();
  } });
  assert.equal(result.version, '1.7.3');
});

test('network, HTTP and JSON failures never report a freshness pass', async () => {
  for (const fetchFailure of [
    async () => { throw new Error('network offline'); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
  ]) {
    await assert.rejects(fetchLatestRetailSdk({ fetchImpl: fetchFailure }), /Cannot verify.*Packaging requires a successful current check/);
  }
});

test('current installed SDK, selected DLL and packaged DLL pass by content', async t => {
  const f = fixture(t);
  const sdk = await verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl });
  assert.equal(sdk.version, '1.7.3');
  assert.match(sdk.sha256, /^[a-f0-9]{64}$/);
  assert.equal(assertSimConnectDllMatches(f.packagedDll, sdk), sdk.sha256);
});

test('installed SDK version accepts the official 1.7.3 two-line version.txt format', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sdkRoot, 'version.txt'), '1.7.3\r\n0');
  const sdk = await verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl });
  assert.equal(sdk.version, '1.7.3');
});

for (const version of ['1.5.7', '1.8.0']) {
  test(`SDK ${version} is rejected even when its DLL matches the selected copy`, async t => {
    const f = fixture(t, version);
    await assert.rejects(
      verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl }),
      /does not match latest retail SDK 1\.7\.3/,
    );
  });
}

test('missing and invalid SDK version metadata produce actionable failures', async t => {
  const f = fixture(t);
  const versionFile = path.join(f.sdkRoot, 'version.txt');
  fs.unlinkSync(versionFile);
  await assert.rejects(
    verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl }),
    /Missing MSFS 2024 SDK version.txt.*FF_MSFS2024_SDK_ROOT/,
  );
  fs.writeFileSync(versionFile, 'not a version');
  await assert.rejects(
    verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl }),
    /Invalid MSFS 2024 SDK version/,
  );
});

test('actual build selection catches stale owned source and runtime despite current SDK fallbacks', async t => {
  const f = fixture(t);
  const options = {
    rootDir: f.root, backendSourceDir: f.sourceDir, backendRuntimeDir: f.runtimeDir,
    configuredPath: f.sdkDll, sdkPaths: [f.sdkDll],
  };
  for (const staleFile of [f.sourceDll, f.runtimeDll]) {
    fs.writeFileSync(staleFile, 'old runtime');
    const source = selectSimConnectDllSource(options);
    assert.equal(source.path, staleFile);
    await assert.rejects(
      verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: source.path, fetchImpl }),
      /differs from MSFS 2024 retail SDK 1\.7\.3/,
    );
    fs.unlinkSync(staleFile);
  }
  const source = selectSimConnectDllSource(options);
  assert.equal(source.path, f.sdkDll);
  await verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: source.path, fetchImpl });
});

test('a missing SDK DLL or build source cannot pass', async t => {
  const f = fixture(t);
  await assert.rejects(verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, fetchImpl }), /no build source selected/);
  fs.unlinkSync(f.sdkDll);
  await assert.rejects(
    verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl }),
    /Missing SimConnect.dll/,
  );
});

test('stale, absent and empty packaged DLLs fail instead of trusting their filename', async t => {
  const f = fixture(t);
  const sdk = await verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl });
  // Same-size corruption catches inventory/size-only packaging checks.
  fs.writeFileSync(f.packagedDll, 'x'.repeat(fs.statSync(f.packagedDll).size));
  assert.throws(() => assertSimConnectDllMatches(f.packagedDll, sdk), /differs from MSFS 2024/);
  fs.writeFileSync(f.packagedDll, '');
  assert.throws(() => assertSimConnectDllMatches(f.packagedDll, sdk), /nonempty regular/);
  fs.unlinkSync(f.packagedDll);
  assert.throws(() => assertSimConnectDllMatches(f.packagedDll, sdk), /Missing SimConnect.dll/);
});

test('DLL changes after preflight do not change the accepted hash', async t => {
  const f = fixture(t);
  const sdk = await verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl });
  fs.writeFileSync(f.sdkDll, 'changed after verification');
  fs.copyFileSync(f.sdkDll, f.packagedDll);
  assert.throws(() => assertSimConnectDllMatches(f.packagedDll, sdk), /differs from MSFS 2024/);
});

async function writeProvenance(f, overrides = {}) {
  const sdk = await verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, fetchImpl });
  const manifest = {
    schemaVersion: 1,
    sdkVersion: sdk.version,
    dllSha256: sdk.sha256,
    source: { url: sdk.downloadUrl, archiveSha256: 'a'.repeat(64), installerSha256: 'b'.repeat(64) },
    ...overrides,
  };
  const manifestPath = path.join(f.root, 'simconnect-runtime.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

test('verified archive provenance accepts the latest DLL without an installed SDK', async t => {
  const f = fixture(t);
  const manifestPath = await writeProvenance(f);
  const sdk = await verifyLatestSimConnectRuntime({
    sdkRoot: path.join(f.root, 'not-installed'), dllPath: f.sourceDll, manifestPath, fetchImpl,
  });
  assert.equal(sdk.version, '1.7.3');
  assert.equal(assertSimConnectDllMatches(f.packagedDll, sdk), sdk.sha256);
});

test('archive provenance still rejects a stale or altered selected DLL', async t => {
  const f = fixture(t);
  const manifestPath = await writeProvenance(f);
  fs.writeFileSync(f.sourceDll, 'different DLL');
  await assert.rejects(
    verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, manifestPath, fetchImpl }),
    /differs from MSFS 2024 retail SDK/,
  );
});

test('stale or invalid archive provenance cannot fall back to a current installed SDK', async t => {
  const f = fixture(t);
  for (const overrides of [
    { sdkVersion: '1.5.7' },
    { sdkVersion: '1.8.0' },
    { dllSha256: 'invalid' },
    { schemaVersion: 2 },
    { source: { url: 'https://example.com/SDK.zip', archiveSha256: 'a'.repeat(64), installerSha256: 'b'.repeat(64) } },
    { source: { url: latestRetailSdk(feed).downloadUrl } },
  ]) {
    const manifestPath = await writeProvenance(f, overrides);
    await assert.rejects(
      verifyLatestSimConnectRuntime({ sdkRoot: f.sdkRoot, dllPath: f.sourceDll, manifestPath, fetchImpl }),
      /does not match latest retail SDK|Invalid SimConnect SDK provenance/,
    );
  }
});

test('archive provenance cannot bypass a failed live feed check', async t => {
  const f = fixture(t);
  const manifestPath = await writeProvenance(f);
  await assert.rejects(verifyLatestSimConnectRuntime({
    sdkRoot: f.sdkRoot, dllPath: f.sourceDll, manifestPath,
    fetchImpl: async () => { throw new Error('offline'); },
  }), /Cannot verify the latest retail/);
});
