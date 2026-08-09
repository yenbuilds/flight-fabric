#!/usr/bin/env node
// test-package-drift.js
// Cross-package consistency guard: packages/telemetry-types vs the backend runtime.
//
// Two categories of checks:
//
//  1. MSG ENUM PARITY — enums.ts MSG keys must exactly match message-types.js MSG keys.
//     When a new MSG type is added or renamed in one file, this test fails until
//     both files are updated together.
//
//  2. INTERFACE FIELD PARITY — key messages.ts interfaces must have the same
//     non-type fields as the backend broadcaster functions that produce them.
//     When a field is added or renamed in a broadcaster, this test fails until
//     the corresponding interface is updated in messages.ts.
//
//  3. PROTOCOL STATUS GUARDS — status/enum fields on well-known messages are
//     checked bidirectionally against their source-of-truth in the backend.
//
// When to update this file:
//   - Never, in the happy path. All checks are self-maintaining:
//     change the source → test fails → update the documentation → test passes.
//   - Only if a NEW broadcaster function or interface pair is added and no test
//     exists for it yet (add a new test block following the existing patterns).

'use strict';

const { ROOT, readRepoSource } = require('./backend-source-paths');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const broadcastersRuntime = require(resolveBackendRuntimeFile('events', 'broadcasters.js'));

let passed = 0;
let failed = 0;

function fail(message) {
  failed++;
  console.error(`  FAIL ${message}`);
}

function pass(message) {
  passed++;
  console.log(`  PASS ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function test(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(`${name}: ${err.message}`);
  }
}

function read(relativePath) {
  return readRepoSource(relativePath, 'utf8');
}

function getRuntimePayloadFields(payload) {
  assert(payload && typeof payload === 'object', 'expected runtime payload object');
  return new Set(Object.keys(payload).filter((field) => field !== 'type'));
}

// Strip block and line comments while preserving line numbers.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─── MSG constant extractors ───────────────────────────────────────────────

/** Extract MSG key→wireString entries from backend/core/message-types.js (CommonJS). */
function getBackendMsgMap() {
  const src = read('backend/core/message-types.js');
  const msgStart = src.indexOf('const MSG = Object.freeze({');
  assert(msgStart !== -1, 'MSG constant not found in message-types.js');
  const fromMsg = src.slice(msgStart);
  const openIdx = fromMsg.indexOf('{');
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < fromMsg.length; i++) {
    if (fromMsg[i] === '{') depth++;
    else if (fromMsg[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  assert(closeIdx !== -1, 'could not find closing brace of MSG in message-types.js');
  const body = stripComments(fromMsg.slice(openIdx + 1, closeIdx));
  const map = new Map();
  const re = /^\s+([A-Z][A-Z0-9_]*):\s*['"](\S+?)['"]/gm;
  let m;
  while ((m = re.exec(body)) !== null) map.set(m[1], m[2]);
  return map;
}

/** Extract MSG key names from backend/core/message-types.js (CommonJS). */
function getBackendMsgKeys() {
  return new Set(getBackendMsgMap().keys());
}

/** Extract MSG key→wireString entries from packages/telemetry-types/src/enums.ts. */
function getEnumsTsMsgMap() {
  const src = read('packages/telemetry-types/src/enums.ts');
  const msgStart = src.indexOf('export const MSG = {');
  assert(msgStart !== -1, 'MSG constant not found in enums.ts');
  const fromMsg = src.slice(msgStart);
  const openIdx = fromMsg.indexOf('{');
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < fromMsg.length; i++) {
    if (fromMsg[i] === '{') depth++;
    else if (fromMsg[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  assert(closeIdx !== -1, 'could not find closing brace of MSG in enums.ts');
  const body = stripComments(fromMsg.slice(openIdx + 1, closeIdx));
  const map = new Map();
  const re = /^\s+([A-Z][A-Z0-9_]*):\s*['"](\S+?)['"]/gm;
  let m;
  while ((m = re.exec(body)) !== null) map.set(m[1], m[2]);
  return map;
}

/** Extract MSG key names from packages/telemetry-types/src/enums.ts. */
function getEnumsTsMsgKeys() {
  return new Set(getEnumsTsMsgMap().keys());
}

// ─── TypeScript interface field extractor ─────────────────────────────────

/**
 * Extract non-type field names from a TypeScript interface in messages.ts.
 * Handles optional (?:), readonly, and quoted ('true') property names.
 * Excludes the `type` field (inherited from BaseMessage).
 */
function getInterfaceFields(tsSource, interfaceName) {
  // Match "export interface FooMessage " or "export interface FooMessage<" or "{"
  const start = tsSource.search(new RegExp(`export interface ${interfaceName}[\\s{<]`));
  assert(start !== -1, `interface ${interfaceName} not found in messages.ts`);
  const fromStart = tsSource.slice(start);
  const openIdx = fromStart.indexOf('{');
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < fromStart.length; i++) {
    if (fromStart[i] === '{') depth++;
    else if (fromStart[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  assert(closeIdx !== -1, `could not find closing brace of interface ${interfaceName}`);
  const body = stripComments(fromStart.slice(openIdx + 1, closeIdx));
  const fields = new Set();
  // Match unquoted (fieldName?) and quoted ('fieldName'?) property declarations.
  // Skip index signatures like [key: string].
  const re = /^\s+(?:readonly\s+)?(?:'(\w+)'|"(\w+)"|(\w+))\??:/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && name !== 'type') fields.add(name);
  }
  return fields;
}

// ─── Broadcaster object field extractor ────────────────────────────────────

/**
 * Scan `src` for all broadcast({ ... }) calls and return the field set from the
 * first call whose body contains `msgTypeRef` (e.g., 'MSG.AUTOPILOT').
 * Handles both multi-line and single-line broadcast objects, and shorthand
 * properties (field without colon).
 * Excludes the `type` field.
 */
function getBroadcastFieldsByType(src, msgTypeRef) {
  const stripped = stripComments(src);
  let searchFrom = 0;
  while (true) {
    // Find next broadcast({ occurrence
    const idx = stripped.indexOf('broadcast({', searchFrom);
    if (idx === -1) break;
    const fromBc = stripped.slice(idx);
    const openIdx = fromBc.indexOf('{');
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < fromBc.length; i++) {
      if (fromBc[i] === '{') depth++;
      else if (fromBc[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) break;
    const body = fromBc.slice(openIdx + 1, closeIdx);
    if (body.includes(msgTypeRef)) {
      const fields = new Set();
      const isMultiLine = body.includes('\n');
      const re = isMultiLine ? /^\s+(\w+)\s*[,:]/gm : /\b(\w+)\s*:/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        if (m[1] !== 'type') fields.add(m[1]);
      }
      return fields;
    }
    searchFrom = idx + 11;
  }
  return null;
}

// ─── Cached sources ────────────────────────────────────────────────────────

const MESSAGES_TS       = read('packages/telemetry-types/src/messages.ts');
const TELEMETRY_CLIENT_TS = read('packages/telemetry-client/src/client.ts');
const BROADCASTERS_JS   = read('backend/events/broadcasters.js');
const SIMBRIDGE_CORE_JS = read('backend/core/simbridge-core.js');
const ROOT_PACKAGE_JSON = JSON.parse(read('package.json'));
const ROOT_VERSION = ROOT_PACKAGE_JSON.version;
const ELECTRON_LAUNCHER_HTML = read('electron/launcher/index.html');
const UPDATE_MANIFEST_JSON = readJson('update-manifest.json');
const APP_VERSION_TARGETS = [
  {
    label: 'backend',
    manifest: 'backend/package.json',
    lockfile: 'backend/package-lock.json',
  },
  {
    label: 'frontend',
    manifest: 'frontend/package.json',
    lockfile: 'frontend/package-lock.json',
  },
  {
    label: 'electron',
    manifest: 'electron/package.json',
    lockfile: 'electron/package-lock.json',
  },
];

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function compareAppVersions(left, right) {
  const parse = (value, label) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
    assert(match, `${label} is not a supported app version: ${JSON.stringify(value)}`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left, 'left version');
  const rightParts = parse(right, 'right version');
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function getFrontendHtmlEntrypoints() {
  return [
    'frontend/index.html',
    'frontend/widgets-compact/widget.html',
    'frontend/widgets-compact/widget-autopilot.html',
    'frontend/widgets-compact/widget-bottom.html',
    'frontend/widgets-compact/widget-environment.html',
    'frontend/widgets-compact/widget-history.html',
    'frontend/widgets-compact/widget-top.html',
  ];
}

// ─── Version source guards ─────────────────────────────────────────────────

console.log('\n--- Version source guards ---');

test('app-version helper resolves to the root package version', () => {
  const { getAppVersion } = require(resolveBackendRuntimeFile('core', 'app-version.js'));
  assert(ROOT_VERSION, 'root package.json version missing');
  assert(
    getAppVersion() === ROOT_VERSION,
    `getAppVersion() returned ${JSON.stringify(getAppVersion())}; expected ${JSON.stringify(ROOT_VERSION)}`,
  );
});

test('app-owned manifests match the root package version', () => {
  assert(ROOT_VERSION, 'root package.json version missing');
  const mismatches = [];

  for (const target of APP_VERSION_TARGETS) {
    const manifest = readJson(target.manifest);
    if (manifest.version !== ROOT_VERSION) {
      mismatches.push(`${target.manifest}=${JSON.stringify(manifest.version)}`);
    }
  }

  assert(
    mismatches.length === 0,
    `App manifests do not match root package.json version ${JSON.stringify(ROOT_VERSION)}: ${mismatches.join(', ')}`,
  );
});

test('app-owned lockfiles match the root package version', () => {
  assert(ROOT_VERSION, 'root package.json version missing');
  const mismatches = [];

  for (const target of APP_VERSION_TARGETS) {
    const lockfile = readJson(target.lockfile);
    if (lockfile.version !== ROOT_VERSION) {
      mismatches.push(`${target.lockfile} version=${JSON.stringify(lockfile.version)}`);
    }
    const rootPkgVersion = lockfile.packages && lockfile.packages[''] ? lockfile.packages[''].version : null;
    if (rootPkgVersion !== ROOT_VERSION) {
      mismatches.push(`${target.lockfile} packages[""].version=${JSON.stringify(rootPkgVersion)}`);
    }
  }

  assert(
    mismatches.length === 0,
    `App lockfiles do not match root package.json version ${JSON.stringify(ROOT_VERSION)}: ${mismatches.join(', ')}`,
  );
});

test('app-owned dependency locks retain the security patch floors', () => {
  const patchFloors = [
    ['package-lock.json', 'node_modules/brace-expansion', '5.0.8'],
    ['package-lock.json', 'node_modules/fast-uri', '3.1.5'],
    ['package-lock.json', 'node_modules/minimatch', '10.2.6'],
    ['package-lock.json', 'node_modules/postcss', '8.5.18'],
    ['backend/package-lock.json', 'node_modules/fast-uri', '3.1.5'],
    ['frontend/package-lock.json', 'node_modules/postcss', '8.5.18'],
    ['electron/package-lock.json', 'node_modules/@electron/asar', '4.2.1'],
    ['electron/package-lock.json', 'node_modules/@electron/rebuild', '4.0.4'],
    ['electron/package-lock.json', 'node_modules/electron-builder', '26.15.0'],
    ['electron/package-lock.json', 'node_modules/minimatch', '10.2.6'],
    ['electron/package-lock.json', 'node_modules/minimatch/node_modules/brace-expansion', '5.0.8'],
    ['electron/package-lock.json', 'node_modules/postcss', '8.5.18'],
  ];

  for (const [lockfilePath, packagePath, minimumVersion] of patchFloors) {
    const lockfile = readJson(lockfilePath);
    const lockedVersion = lockfile.packages?.[packagePath]?.version;
    assert(
      lockedVersion,
      `${lockfilePath} is missing ${packagePath}`,
    );
    assert(
      compareAppVersions(lockedVersion, minimumVersion) >= 0,
      `${lockfilePath} locks ${packagePath} at ${lockedVersion}; expected at least ${minimumVersion}`,
    );
  }
});

test('recovery launcher display matches the root package version', () => {
  const match = ELECTRON_LAUNCHER_HTML.match(/<span id="version">v([^<]+)<\/span>/);
  assert(match, 'electron launcher version marker missing');
  assert(
    match[1] === ROOT_VERSION,
    `electron launcher displays ${JSON.stringify(match[1])}; expected ${JSON.stringify(ROOT_VERSION)}`,
  );
});

test('published update manifest is self-consistent and not newer than the root candidate', () => {
  const publishedVersion = UPDATE_MANIFEST_JSON.version;
  const expectedDownloadUrl = (
    `https://github.com/yenbuilds/flight-fabric/releases/tag/v${publishedVersion}`
  );
  assert(
    compareAppVersions(publishedVersion, ROOT_VERSION) <= 0,
    `update-manifest.json version ${JSON.stringify(publishedVersion)} is newer than root candidate ${JSON.stringify(ROOT_VERSION)}`,
  );
  assert(
    UPDATE_MANIFEST_JSON.downloadUrl === expectedDownloadUrl,
    `update-manifest.json downloadUrl is ${JSON.stringify(UPDATE_MANIFEST_JSON.downloadUrl)}; expected ${JSON.stringify(expectedDownloadUrl)}`,
  );
});

test('root Node requirement satisfies the locked Electron installer requirement', () => {
  const electronLock = readJson('electron/package-lock.json');
  const electronEngine = electronLock.packages?.['node_modules/electron']?.engines?.node;
  const rootEngine = ROOT_PACKAGE_JSON.engines?.node;
  const parseMinimum = (value) => {
    const match = String(value || '').match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    assert(match, `unsupported minimum Node engine range: ${JSON.stringify(value)}`);
    return match.slice(1, 4).map((part) => Number(part || 0));
  };
  const compareVersions = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
  };

  assert(electronEngine, 'locked Electron package is missing its Node engine requirement');
  assert(
    compareVersions(parseMinimum(rootEngine), parseMinimum(electronEngine)) >= 0,
    `root Node requirement ${JSON.stringify(rootEngine)} is below Electron's ${JSON.stringify(electronEngine)}`,
  );
});

console.log('\n--- Packaged frontend guards ---');

test('frontend HTML entrypoints do not depend on Google Fonts CDN', () => {
  const offenders = [];
  for (const relativePath of getFrontendHtmlEntrypoints()) {
    const src = read(relativePath);
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(src)) {
      offenders.push(relativePath);
    }
  }

  assert(
    offenders.length === 0,
    `Google Fonts CDN references remain in: ${offenders.join(', ')}`,
  );
});

test('simbridge-core does not use backend/package.json as the app update version source', () => {
  assert(
    !SIMBRIDGE_CORE_JS.includes("require('../package.json').version"),
    'simbridge-core.js must not read backend/package.json for update checks',
  );
});

test('update checker only starts in desktop launch modes', () => {
  assert(
    SIMBRIDGE_CORE_JS.includes('const updateChecksAllowed = config.env.isPackaged') &&
      SIMBRIDGE_CORE_JS.includes('|| config.env.isElectronBackend') &&
      SIMBRIDGE_CORE_JS.includes('|| config.env.isLocalBatchLaunch') &&
      SIMBRIDGE_CORE_JS.includes('if (APP_VERSION && updateChecksAllowed) {'),
    'simbridge-core.js must gate update checker startup on packaged, Electron, or local batch desktop mode',
  );
});

// ─── 1. MSG enum parity ────────────────────────────────────────────────────

console.log('\n--- MSG enum parity ---');

test('enums.ts MSG and message-types.js MSG have exactly the same keys (bidirectional)', () => {
  const backendKeys = getBackendMsgKeys();
  const tsKeys      = getEnumsTsMsgKeys();
  const missingFromTs = [...backendKeys].filter(k => !tsKeys.has(k)).sort();
  const extraInTs     = [...tsKeys].filter(k => !backendKeys.has(k)).sort();
  assert(
    missingFromTs.length === 0,
    `Keys in message-types.js missing from enums.ts — add them to packages/telemetry-types/src/enums.ts: ${missingFromTs.join(', ')}`,
  );
  assert(
    extraInTs.length === 0,
    `Keys in enums.ts not in message-types.js — remove or add matching backend entry: ${extraInTs.join(', ')}`,
  );
});

test('enums.ts MSG and message-types.js MSG wire string values are identical for all shared keys', () => {
  const backendMap = getBackendMsgMap();
  const tsMap      = getEnumsTsMsgMap();
  const mismatches = [];
  for (const [key, jsVal] of backendMap) {
    const tsVal = tsMap.get(key);
    if (tsVal !== undefined && tsVal !== jsVal) {
      mismatches.push(`${key}: message-types.js='${jsVal}' vs enums.ts='${tsVal}'`);
    }
  }
  assert(
    mismatches.length === 0,
    `Wire string values differ — a coordinated update to both files is required:\n  ${mismatches.join('\n  ')}`,
  );
});

// ─── 2. Interface ↔ broadcaster field parity ───────────────────────────────

console.log('\n--- Interface field parity ---');

test('AutopilotMessage fields match sendAutopilot broadcast object (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'AutopilotMessage');
  const bcFields = getRuntimePayloadFields(
    broadcastersRuntime.buildAutopilotBroadcastPayload(
      {
        apMaster: true,
        apFdActive: true,
        athrArmed: true,
        athrActive: true,
        apHdgHold: true,
        apNavHold: true,
        apLnavHold: true,
        apLocHold: true,
        apAltHold: true,
        apVsHold: true,
        apVnavHold: true,
        apLvlChgHold: true,
        apExpedHold: true,
        apApprHold: true,
        apSpeedHold: true,
        apHdgTargetDeg: 180,
        apAltTargetFt: 3000,
        apVsTargetFpm: -700,
        apSpeedTargetKts: 150,
        apMachTarget: 0.64,
      },
      { apReliable: true, athrReliable: true, reason: 'test' },
    ),
  );
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in AutopilotMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `AutopilotMessage fields not in broadcast: ${extra.join(', ')}`);
});

test('AttitudeMessage fields match sendAttitude broadcast object (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'AttitudeMessage');
  const bcFields = getRuntimePayloadFields(
    broadcastersRuntime.buildAttitudeBroadcastPayload({
      valid: true,
      pitchDeg: 3.5,
      bankDeg: -1.2,
      pitchRad: 0.061,
      bankRad: -0.021,
      pitchSource: 'primary',
      bankSource: 'primary',
      pitchRaw: 3.48,
      bankRaw: -1.18,
      pitchDegPrimary: 3.5,
      bankDegPrimary: -1.2,
      pitchModePrimary: 'sdk',
      bankModePrimary: 'sdk',
    }),
  );
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in AttitudeMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `AttitudeMessage fields not in broadcast: ${extra.join(', ')}`);
});

test('AltitudeMessage fields match MSG.ALTITUDE broadcast in sendBasicStreams (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'AltitudeMessage');
  const bcFields = getRuntimePayloadFields(
    broadcastersRuntime.buildAltitudeBroadcastPayload({
      vsFeetPerMin: -320,
      iasKnots: 144,
      gsKnots: 151,
      alt_msl_ft: 3112.8,
      raFeet: 284.2,
      pressureAltFt: 3021.6,
      xwind: 8,
      lights: null,
      hdgMag: 180,
      hdgTrue: 190,
    }),
  );
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in AltitudeMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `AltitudeMessage fields not in broadcast: ${extra.join(', ')}`);
});

test('EnvironmentMessage fields match sendEnvironment broadcast object (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'EnvironmentMessage');
  const bcFields = getRuntimePayloadFields(
    broadcastersRuntime.buildEnvironmentBroadcastPayload({
      cabinAltFt: 6500,
      cabinAltRateFpm: 250,
      cabinAltTargetFt: 8000,
      oatC: -12,
    }),
  );
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in EnvironmentMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `EnvironmentMessage fields not in broadcast: ${extra.join(', ')}`);
});

test('PositionMessage fields match sendPosition broadcast object (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'PositionMessage');
  const bcFields = getRuntimePayloadFields(
    broadcastersRuntime.buildPositionBroadcastPayload({ lat: 47.45, lon: -122.31, hdg: 165 }),
  );
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in PositionMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `PositionMessage fields not in broadcast: ${extra.join(', ')}`);
});

test('ControlsMessage fields match sendControls broadcast object (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'ControlsMessage');
  const bcFields = getRuntimePayloadFields(
    broadcastersRuntime.buildControlsBroadcastPayload({ yokeX: 12, yokeY: -4, rudderPedalPct: 6 }),
  );
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in ControlsMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `ControlsMessage fields not in broadcast: ${extra.join(', ')}`);
});

test('UltimateStabilityScoreMessage fields match MSG.ULTIMATE_STABILITY_SCORE broadcast (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'UltimateStabilityScoreMessage');
  const bcFields    = getBroadcastFieldsByType(SIMBRIDGE_CORE_JS, 'MSG.ULTIMATE_STABILITY_SCORE');
  assert(bcFields !== null, 'could not find MSG.ULTIMATE_STABILITY_SCORE broadcast in simbridge-core.js');
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in UltimateStabilityScoreMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `UltimateStabilityScoreMessage fields not in broadcast: ${extra.join(', ')}`);
});

test('TelemetryClient stores the ultimate stability verdict from its message', () => {
  const caseMatch = /case MSG\.ULTIMATE_STABILITY_SCORE:([\s\S]*?)\n\s*case MSG\./.exec(TELEMETRY_CLIENT_TS);
  assert(caseMatch, 'ULTIMATE_STABILITY_SCORE reducer case not found in telemetry-client');
  assert(
    /updates\.ultimateStabilityVerdict\s*=\s*msg\.verdict(?:\s*\?\?\s*null)?\s*;/.test(caseMatch[1]),
    'ULTIMATE_STABILITY_SCORE must copy msg.verdict into ultimateStabilityVerdict',
  );
});

test('VreSamplingMessage fields match MSG.VRE_SAMPLING broadcast (bidirectional)', () => {
  const ifaceFields = getInterfaceFields(MESSAGES_TS, 'VreSamplingMessage');
  const bcFields    = getBroadcastFieldsByType(SIMBRIDGE_CORE_JS, 'MSG.VRE_SAMPLING');
  assert(bcFields !== null, 'could not find MSG.VRE_SAMPLING broadcast in simbridge-core.js');
  const missing = [...bcFields].filter(f => !ifaceFields.has(f));
  const extra   = [...ifaceFields].filter(f => !bcFields.has(f));
  assert(missing.length === 0, `broadcast fields not in VreSamplingMessage: ${missing.join(', ')}`);
  assert(extra.length   === 0, `VreSamplingMessage fields not in broadcast: ${extra.join(', ')}`);
});

// ─── 3. Protocol status guards ─────────────────────────────────────────────

console.log('\n--- Protocol status guards ---');

test('FlightRecordingMessage.status union matches all status literals in simbridge-core.js', () => {
  // Extract all status values from FLIGHT_RECORDING broadcasts in simbridge-core.js
  const statuses = new Set();
  const contextRe = /(?:broadcast|ws\.send)\s*\(\s*(?:JSON\.stringify\s*\()?\s*\{[\s\S]{0,800}?type:\s*MSG\.FLIGHT_RECORDING[\s\S]{0,800}?\}\s*\)?\s*\)/g;
  let m;
  while ((m = contextRe.exec(SIMBRIDGE_CORE_JS)) !== null) {
    const statusMatch = /status:\s*['"]([^'"]+)['"]/.exec(m[0]);
    if (statusMatch) statuses.add(statusMatch[1]);
  }
  assert(statuses.size > 0, 'could not extract FLIGHT_RECORDING status values from simbridge-core.js');

  // Extract the status union from FlightRecordingMessage in messages.ts
  const ifaceStart = MESSAGES_TS.indexOf('interface FlightRecordingMessage');
  assert(ifaceStart !== -1, 'FlightRecordingMessage not found in messages.ts');
  const ifaceBlock = MESSAGES_TS.slice(ifaceStart, MESSAGES_TS.indexOf('}', ifaceStart) + 1);
  const unionMatch = /status:\s*([^;]+)/.exec(ifaceBlock);
  assert(unionMatch, 'status field not found in FlightRecordingMessage');
  const documented = new Set(
    [...unionMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]),
  );

  const missing = [...statuses].filter(s => !documented.has(s)).sort();
  const extra   = [...documented].filter(s => !statuses.has(s)).sort();
  assert(
    missing.length === 0,
    `status values in source not in FlightRecordingMessage.status union — update messages.ts: ${missing.join(', ')}`,
  );
  assert(
    extra.length === 0,
    `FlightRecordingMessage.status union has values not used in source — clean up messages.ts: ${extra.join(', ')}`,
  );
});

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\nPackage drift tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
