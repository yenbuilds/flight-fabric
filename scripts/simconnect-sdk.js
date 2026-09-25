'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SDK_FEED_URL = 'https://sdk.flightsimulator.com/msfs2024/files/sdk.json';
const SIMCONNECT_DLL_RELATIVE = path.join('telemetry-provider', 'simconnect', 'SimConnect.dll');
const SDK_RUNTIME_MANIFEST = path.join(__dirname, 'simconnect-runtime.json');

function getSdkRoot() {
  return process.env.FF_MSFS2024_SDK_ROOT || 'C:\\MSFS 2024 SDK';
}

function getSdkDllPath(sdkRoot = getSdkRoot()) {
  return path.join(sdkRoot, 'SimConnect SDK', 'lib', 'SimConnect.dll');
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Invalid MSFS 2024 SDK version: ${JSON.stringify(value)}`);
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid MSFS 2024 SDK version numbers');
  return parts;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function latestRetailSdk(feed) {
  if (!Array.isArray(feed?.game_versions)) {
    throw new Error('MSFS 2024 SDK feed is missing game_versions');
  }
  const releases = [];
  for (const entry of feed.game_versions) {
    let docs;
    try { docs = new URL(entry.online_doc); } catch { continue; }
    // The first feed entry can be a flighting/preview SDK. Only retail is a
    // release source; simulator version and release_notes are not SDK versions.
    if (docs.origin !== 'https://docs.flightsimulator.com'
      || !docs.pathname.startsWith('/msfs2024/retail/')) continue;
    const download = entry.downloads_menu?.['SDK Installer (Core)'];
    const match = typeof download?.value === 'string'
      && /^installers\/(\d+\.\d+\.\d+)\/MSFS2024_SDK_Core_Installer_\1\.zip$/.exec(download.value);
    if (download?.type !== 'DownloadURL' || !match) {
      throw new Error('MSFS 2024 retail SDK feed has an unrecognized Core installer entry');
    }
    parseVersion(match[1]);
    releases.push({ version: match[1], downloadUrl: new URL(download.value, SDK_FEED_URL).href });
  }
  if (!releases.length) throw new Error('MSFS 2024 SDK feed has no recognized retail release');
  return releases.sort((a, b) => compareVersions(b.version, a.version))[0];
}

async function fetchLatestRetailSdk({ fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  try {
    const response = await fetchImpl(SDK_FEED_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return latestRetailSdk(await response.json());
  } catch (err) {
    throw new Error(
      `Cannot verify the latest retail MSFS 2024 SDK from ${SDK_FEED_URL}: ${err.message}. `
      + 'Packaging requires a successful current check; retry when the feed is available.',
      { cause: err },
    );
  }
}

function hashDll(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Missing SimConnect.dll: ${filePath || '(no build source selected)'}`);
  }
  const stat = fs.lstatSync(filePath);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0
    || normalize(path.resolve(filePath)) !== normalize(fs.realpathSync(filePath))) {
    throw new Error(`SimConnect.dll must be a nonempty regular, unredirected file: ${filePath}`);
  }
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertSimConnectDllMatches(filePath, sdk) {
  const actual = hashDll(filePath);
  if (actual !== sdk.sha256) {
    throw new Error(
      `SimConnect.dll differs from MSFS 2024 retail SDK ${sdk.version}: ${filePath}. `
      + `Expected SHA-256 ${sdk.sha256}, got ${actual}. `
      + `Refresh the build source from ${sdk.dllPath}, then rebuild; owned source/runtime copies take precedence over fallbacks.`,
    );
  }
  return actual;
}

async function verifyLatestSimConnectRuntime({
  dllPath,
  sdkRoot = getSdkRoot(),
  manifestPath = SDK_RUNTIME_MANIFEST,
  fetchImpl,
} = {}) {
  const latest = await fetchLatestRetailSdk({ fetchImpl });
  // A reviewed archive extraction provides the same version/content evidence
  // as an installed SDK, without installing SDK tools on every build machine.
  if (manifestPath && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sha256Pattern = /^[a-f0-9]{64}$/;
    const isSha256 = value => typeof value === 'string' && sha256Pattern.test(value);
    if (manifest?.schemaVersion !== 1 || typeof manifest.sdkVersion !== 'string'
      || !isSha256(manifest.dllSha256)
      || !isSha256(manifest.source?.archiveSha256)
      || !isSha256(manifest.source?.installerSha256)) {
      throw new Error(`Invalid SimConnect SDK provenance manifest: ${manifestPath}`);
    }
    parseVersion(manifest.sdkVersion);
    if (manifest.sdkVersion !== latest.version || manifest.source?.url !== latest.downloadUrl) {
      throw new Error(
        `Recorded SimConnect SDK ${manifest.sdkVersion} does not match latest retail SDK ${latest.version}. `
        + `Verify ${latest.downloadUrl}, then refresh the DLL and ${manifestPath}.`,
      );
    }
    const sdk = { ...latest, dllPath: latest.downloadUrl, sha256: manifest.dllSha256 };
    assertSimConnectDllMatches(dllPath, sdk);
    return sdk;
  }
  const versionPath = path.join(sdkRoot, 'version.txt');
  if (!fs.existsSync(versionPath)) {
    throw new Error(
      `Missing MSFS 2024 SDK version.txt: ${versionPath}. `
      + `Install retail SDK ${latest.version} (${latest.downloadUrl}); `
      + 'set FF_MSFS2024_SDK_ROOT for a custom installation directory.',
    );
  }
  // Retail 1.7.3 version.txt contains a second numeric line. The SDK version
  // is the first line, consistent with the installer's ProductVersion.
  const installedVersion = fs.readFileSync(versionPath, 'utf8')
    .replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].trim();
  parseVersion(installedVersion);
  if (installedVersion !== latest.version) {
    throw new Error(
      `Installed MSFS 2024 SDK ${installedVersion} does not match latest retail SDK ${latest.version}. `
      + `Install ${latest.downloadUrl} and refresh the build's SimConnect.dll from that SDK. `
      + 'Preview SDKs are not accepted for retail packaging.',
    );
  }
  const sdkDll = getSdkDllPath(sdkRoot);
  const sdk = { ...latest, dllPath: sdkDll, sha256: hashDll(sdkDll) };
  assertSimConnectDllMatches(dllPath, sdk);
  return sdk;
}

module.exports = {
  SDK_FEED_URL,
  SIMCONNECT_DLL_RELATIVE,
  getSdkRoot,
  getSdkDllPath,
  latestRetailSdk,
  fetchLatestRetailSdk,
  assertSimConnectDllMatches,
  verifyLatestSimConnectRuntime,
};
