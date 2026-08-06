#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, listRepoSourceFiles, normalizeRepoRelative, readRepoSource } = require('./backend-source-paths');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const { getRepoScratchPath } = require('./repo-scratch');

function readTopLevelGitIgnoredDirs() {
  const gitignorePath = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return [];

  return fs.readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && !line.includes('*'))
    .map((line) => line.replace(/\/+$/, ''))
    .filter((line) => line && !line.includes('/'));
}

const IGNORE_DIRS = new Set([
  ...readTopLevelGitIgnoredDirs(),
  '.git',
  '.tmp',
  'node_modules',
  'dist',
  'backend-build',
  'frontend-dist',
  'reference',
  'legal',
]);

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

function rel(filePath) {
  return normalizeRepoRelative(path.relative(ROOT, filePath));
}

function read(relativePath) {
  return readRepoSource(relativePath, 'utf8');
}

function walk(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), predicate, out);
      }
      continue;
    }
    const filePath = path.join(dir, entry.name);
    if (!predicate || predicate(filePath)) out.push(filePath);
  }
  return out;
}

function sourceFilesUnder(relativeDir) {
  return listRepoSourceFiles(relativeDir, {
    extensions: ['.js', '.ts'],
  });
}

function stripCommentsPreserveLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function withTempAppData(fn) {
  const tmpRoot = getRepoScratchPath('contract-drift-appdata');
  const tempAppData = path.join(tmpRoot, 'AppData', 'Roaming');
  fs.mkdirSync(tempAppData, { recursive: true });

  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = tempAppData;

  try {
    return fn();
  } finally {
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
  }
}

function getMsgConstants() {
  const source = read('backend/core/message-types.js');
  const constants = new Map();
  const regex = /^\s*([A-Z0-9_]+):\s*['"]([^'"]+)['"]/gm;
  let match;
  while ((match = regex.exec(source)) !== null) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

const MSG = getMsgConstants();
const MSG_VALUES = new Set(MSG.values());

function getDocumentedEventNames() {
  const source = read('backend/core/event-bus.js');
  const docs = new Set();
  const regex = /^\/\/\s{2,}([a-zA-Z][\w:.*{}-]+)\s+-/gm;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    if (!name.includes('*') && !name.includes('{')) docs.add(name);
  }
  return docs;
}

test('MSG values are unique', () => {
  const seen = new Map();
  const duplicates = [];
  for (const [key, value] of MSG.entries()) {
    if (seen.has(value)) duplicates.push(`${value}: ${seen.get(value)}, ${key}`);
    seen.set(value, key);
  }
  assert(duplicates.length === 0, `duplicate wire values: ${duplicates.join('; ')}`);
});

test('backend outgoing WebSocket literals are registered in MSG', () => {
  const files = sourceFilesUnder('backend')
    .filter((filePath) => !rel(filePath).includes('/test/'))
    .filter((filePath) => !rel(filePath).endsWith('.test.js'))
    .filter((filePath) => !rel(filePath).endsWith('.test.ts'))
    .filter((filePath) => rel(filePath) !== 'backend/core/message-types.js');

  const patterns = [
    /\bbroadcast\s*\(\s*\{\s*type:\s*['"]([^'"]+)['"]/g,
    /\bws\.send\s*\(\s*JSON\.stringify\s*\(\s*\{\s*type:\s*['"]([^'"]+)['"]/g,
    /\bsendJsonSafe\s*\([^,]+,\s*\{\s*type:\s*['"]([^'"]+)['"]/g,
  ];

  const missing = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const source = stripCommentsPreserveLines(original);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const value = match[1];
        if (!MSG_VALUES.has(value)) {
          missing.push(`${value} at ${rel(filePath)}:${lineNumber(source, match.index)}`);
        }
      }
    }
  }

  assert(missing.length === 0, `unregistered outgoing types: ${missing.join('; ')}`);
});

test('all MSG references point to defined constants', () => {
  const files = walk(ROOT, (filePath) => filePath.endsWith('.js') || filePath.endsWith('.ts'));
  const missing = [];
  for (const filePath of files) {
    if (filePath.endsWith('.js') && fs.existsSync(filePath.slice(0, -3) + '.ts')) continue;
    const source = stripCommentsPreserveLines(fs.readFileSync(filePath, 'utf8'));
    const regex = /\bMSG\.([A-Z0-9_]+)/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      if (!MSG.has(match[1])) {
        missing.push(`${match[1]} at ${rel(filePath)}:${lineNumber(source, match.index)}`);
      }
    }
  }
  assert(missing.length === 0, `undefined MSG constants: ${missing.join('; ')}`);
});

test('imported config paths exist on backend/core/config.js', () => {
  const configPath = resolveBackendRuntimeFile('core', 'config.js');
  delete require.cache[configPath];
  const config = withTempAppData(() => require(configPath));
  const files = sourceFilesUnder('backend').filter((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    return /const\s+config\s*=\s*require\(['"][^'"]*(?:\.\/config|core\/config)['"]\)/.test(source);
  });

  const missing = [];
  const patterns = [/\bconfig\.(\w+)\.(\w+)/g, /\bconfig\.(\w+)\?\.(\w+)/g];
  for (const filePath of files) {
    const source = stripCommentsPreserveLines(fs.readFileSync(filePath, 'utf8'));
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const section = match[1];
        const key = match[2];
        if (!Object.prototype.hasOwnProperty.call(config, section)) {
          missing.push(`config.${section}.${key} at ${rel(filePath)}:${lineNumber(source, match.index)} (missing section)`);
        } else if (
          config[section] &&
          typeof config[section] === 'object' &&
          !Object.prototype.hasOwnProperty.call(config[section], key)
        ) {
          missing.push(`config.${section}.${key} at ${rel(filePath)}:${lineNumber(source, match.index)} (missing key)`);
        }
      }
    }
  }
  assert(missing.length === 0, `undefined config paths: ${missing.join('; ')}`);
});

test('client-message context builder matches handler contract', () => {
  const contextSource = read('backend/core/client-message-context.js');
  const handlerSource = read('backend/core/client-message-handler.js');

  const provided = new Set();
  for (const match of contextSource.matchAll(/^\s*(\w+):\s*state\./gm)) {
    provided.add(match[1]);
  }

  const destructure = handlerSource.match(/async\s+function\s+handleClientMessage[\s\S]*?const\s*\{([\s\S]*?)\}\s*=\s*context;/);
  assert(destructure, 'could not find handler context destructuring');
  const required = new Set(
    destructure[1]
      .split(',')
      .map((part) => part.trim().split(/\s|=/)[0])
      .filter(Boolean)
  );

  const missing = [...required].filter((key) => !provided.has(key));
  const extra = [...provided].filter((key) => !required.has(key));
  assert(missing.length === 0, `context builder missing: ${missing.join(', ')}`);
  assert(extra.length === 0, `context builder has unused keys: ${extra.join(', ')}`);
});

test('literal event-bus events are documented', () => {
  const documented = getDocumentedEventNames();
  const files = sourceFilesUnder('backend').filter((filePath) => rel(filePath) !== 'backend/core/event-bus.js');
  const missing = [];
  const used = new Set();

  for (const filePath of files) {
    const source = stripCommentsPreserveLines(fs.readFileSync(filePath, 'utf8'));
    const regex = /\beventBus\.(?:emit|on)\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      used.add(match[1]);
      if (!documented.has(match[1])) {
        missing.push(`${match[1]} at ${rel(filePath)}:${lineNumber(source, match.index)}`);
      }
    }
  }

  assert(missing.length === 0, `undocumented event names: ${missing.join('; ')}`);
});

test('Electron preload invoke channels have ipcMain handlers', () => {
  const preload = stripCommentsPreserveLines(read('electron/preload.js'));
  const main = stripCommentsPreserveLines(read('electron/main.js'));
  const handlers = new Set([
    ...main.matchAll(/\b(?:ipcMain\.handle|registerTrustedIpcHandler)\s*\(\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]));
  const missing = [];

  for (const match of preload.matchAll(/\bipcRenderer\.invoke\s*\(\s*['"]([^'"]+)['"]/g)) {
    const channel = match[1];
    if (!handlers.has(channel)) missing.push(channel);
  }

  assert(missing.length === 0, `preload invokes without handlers: ${missing.join(', ')}`);
});

test('Electron package includes local CommonJS require targets', () => {
  const electronPkg = JSON.parse(read('electron/package.json'));
  const packagedFiles = new Set(electronPkg.build?.files || []);
  const entryFiles = ['main.js', 'preload.js'].filter((fileName) => packagedFiles.has(fileName));
  const missing = [];

  for (const entryFile of entryFiles) {
    const source = stripCommentsPreserveLines(read(`electron/${entryFile}`));
    for (const match of source.matchAll(/\brequire\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
      const request = match[1];
      const requestExt = path.extname(request);
      const packagedFile = requestExt ? request.slice(2) : `${request.slice(2)}.js`;

      if (!packagedFiles.has(packagedFile)) {
        missing.push(`${entryFile} requires ${request}, but electron/package.json build.files does not include ${packagedFile}`);
      }
    }
  }

  assert(missing.length === 0, missing.join('; '));
});

test('frontend only uses wsPort + 1 as the explicit last-resort HTTP fallback', () => {
  const files = sourceFilesUnder('frontend').filter((filePath) => !rel(filePath).includes('/vendor/'));
  const offenders = [];
  const allowed = new Set(['frontend/src/ws/connection.js']);
  for (const filePath of files) {
    const source = stripCommentsPreserveLines(fs.readFileSync(filePath, 'utf8'));
    const regex = /\b(?:resolvedWsPort|wsPort)\s*\+\s*1\b/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      const relative = rel(filePath);
      const line = source.split('\n')[lineNumber(source, match.index) - 1] || '';
      if (
        allowed.has(relative) &&
        (
          /resolvedHttpPort\s*=\s*resolvedWsPort\s*\+\s*1/.test(line) ||
          /pushPort\s*\(\s*resolvedWsPort\s*\+\s*1\s*\)/.test(line) ||
          /pushCandidate\s*\(\s*resolvedWsPort\s*\+\s*1\s*\)/.test(line)
        )
      ) {
        continue;
      }
      offenders.push(`${relative}:${lineNumber(source, match.index)}`);
    }
  }
  assert(offenders.length === 0, `HTTP port offset assumptions: ${offenders.join('; ')}`);
});

test('frontend backend HTTP resolver is callable during startup', () => {
  const connectionSource = read('frontend/src/ws/connection.js');
  const appEntrySource = read('frontend/src/app/bootstrap.js');
  const appRuntimeSource = read('frontend/src/app/runtime.js');
  const resolverIndex = connectionSource.indexOf('async function resolveBackendHttpPort()');
  const wsUrlIndex = connectionSource.indexOf('function getWsUrl()');
  const initializeMatch = /await\s+resolveWsPort\s*\(\s*\)\s*;\s*await\s+resolveBackendHttpPort\s*\(\s*\)/s.exec(connectionSource);
  const initializeIndex = initializeMatch ? initializeMatch.index : -1;
  const bootstrapIndex = appEntrySource.indexOf('initAppRuntime({');
  const startupIndex = appRuntimeSource.indexOf('connection.initialize()');

  assert(resolverIndex >= 0, 'resolveBackendHttpPort function is missing');
  assert(wsUrlIndex >= 0, 'getWsUrl function is missing');
  assert(initializeIndex >= 0, 'connection.initialize does not resolve HTTP port after WS port');
  assert(bootstrapIndex >= 0, 'dashboard bootstrap does not initialize the app runtime');
  assert(startupIndex >= 0, 'startup does not call connection.initialize()');
  assert(resolverIndex < wsUrlIndex, 'resolveBackendHttpPort must not be nested inside getWsUrl');
  assert(resolverIndex < initializeIndex, 'resolveBackendHttpPort must be declared before initialize uses it');
});

test('frontend servers prefer bundled frontend-dist with source asset fallback', () => {
  const backendHttpServer = read('backend/core/http-server.ts');
  const electronMain = read('electron/main.js');

  assert(backendHttpServer.includes("resolveRepoAssetPath('frontend-dist')"), 'backend HTTP server should look for frontend-dist');
  assert(backendHttpServer.includes('resolveFrontendAssetCandidates'), 'backend HTTP server should resolve frontend asset fallbacks');
  assert(electronMain.includes("path.join(appRoot, 'frontend-dist')"), 'Electron frontend server should look for frontend-dist in dev');
  assert(electronMain.includes('getFrontendAssetCandidates'), 'Electron frontend server should resolve frontend asset fallbacks');
});

test('frontend build and Electron launch paths use the bundled frontend output', () => {
  const rootPkg = JSON.parse(read('package.json'));
  const frontendPkg = JSON.parse(read('frontend/package.json'));
  const electronPkg = JSON.parse(read('electron/package.json'));
  const frontendBuild = read('frontend/build.js');
  const electronBuild = read('electron/build-electron.js');

  assert(rootPkg.devDependencies?.tailwindcss, 'root package should install Tailwind for browser frontend builds');
  assert(frontendPkg.scripts?.build === 'node build.js', 'frontend build should run the build wrapper');
  assert(frontendBuild.includes('flight-phases.js'), 'frontend build wrapper should copy flight-phases.js');
  assert(frontendBuild.includes("'vendor'"), 'frontend build wrapper should copy vendor assets');
  assert(frontendBuild.includes("'themes'"), 'frontend build wrapper should copy bundled themes');
  assert(frontendBuild.includes('buildTailwindCss()'), 'frontend build wrapper should compile Tailwind CSS');
  assert(frontendBuild.includes("'-o', TAILWIND_OUTPUT"), 'frontend build wrapper should write Tailwind to frontend-dist');
  assert(electronPkg.scripts?.start?.includes('frontend:build'), 'electron start should build the frontend first');
  assert(electronPkg.scripts?.dev?.includes('frontend:build'), 'electron dev should build the frontend first');
  assert(electronBuild.includes("runNpm(['--prefix', 'frontend', 'run', 'build']"), 'electron package build should run the bundled frontend build');
  assert(!electronBuild.includes('execSync'), 'electron package build should avoid shell-string execSync');
});

test('ws-broadcaster mirrors typed messages to event-bus as telemetry:{type}', () => {
  // The template literal `telemetry:${obj.type}` in ws-broadcaster is invisible to the
  // literal-string event-bus scan above.  This test preserves the contract that
  // (a) the emit exists and (b) uses the 'telemetry:' prefix that backend
  // event-bus consumers depend on.
  const source = stripCommentsPreserveLines(read('backend/core/ws-broadcaster.js'));
  assert(
    /eventBus\.emit\s*\(\s*`telemetry:\$\{/.test(source),
    'ws-broadcaster must emit telemetry:${obj.type} on the event-bus for each typed broadcast'
  );
});

function getObjectLiteralKeysFromSource(source, pattern, description) {
  const match = pattern.exec(source);
  assert(match, `could not find ${description}`);

  const keys = new Set();
  const regex = /^\s*(\w+)\s*(?::|,)/gm;
  let keyMatch;
  while ((keyMatch = regex.exec(match[1])) !== null) {
    keys.add(keyMatch[1]);
  }
  return keys;
}

function getBalancedBlockBody(source, openBraceIndex, description) {
  assert(openBraceIndex >= 0 && source[openBraceIndex] === '{', `could not find opening brace for ${description}`);
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  throw new Error(`could not find closing brace for ${description}`);
}

function getSwitchCaseStrings(source, switchExpressionPattern, description) {
  const pattern = new RegExp(`switch\\s*\\(\\s*${switchExpressionPattern}\\s*\\)\\s*\\{`);
  const match = pattern.exec(source);
  assert(match, `could not find switch for ${description}`);
  const openBraceIndex = source.indexOf('{', match.index);
  const body = getBalancedBlockBody(source, openBraceIndex, description);
  return new Set([...body.matchAll(/\bcase\s+['"]([^'"]+)['"]\s*:/g)].map((m) => m[1]));
}

function getSetStringValues(source, setName) {
  const pattern = new RegExp(`${setName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`);
  const match = pattern.exec(source);
  assert(match, `could not find ${setName} string set`);
  return new Set([...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
}

function getFrozenArrayStringValues(source, arrayName) {
  const pattern = new RegExp(
    `${arrayName}\\s*=\\s*Object\\.freeze\\(\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const\\s*\\)`,
  );
  const match = pattern.exec(source);
  assert(match, `could not find ${arrayName} string array`);
  return new Set([...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
}

function getBackendAcceptedClientMessageTypes() {
  const accepted = new Set();
  const handlerSource = stripCommentsPreserveLines(read('backend/core/client-message-handler.ts'));
  const handlerStart = handlerSource.indexOf('async function handleClientMessage');
  assert(handlerStart >= 0, 'could not find handleClientMessage command dispatcher');
  const handlerBody = handlerSource.slice(handlerStart);
  for (const match of handlerBody.matchAll(/\bcase\s+['"]([^'"]+)['"]\s*:/g)) {
    accepted.add(match[1]);
  }
  for (const match of handlerBody.matchAll(/\bcase\s+MSG\.([A-Z0-9_]+)\s*:/g)) {
    const value = MSG.get(match[1]);
    if (value) accepted.add(value);
  }

  const coreSource = stripCommentsPreserveLines(read('backend/core/simbridge-core.ts'));
  for (const match of coreSource.matchAll(/\bmsg\.type\s*===\s*['"]([^'"]+)['"]/g)) {
    accepted.add(match[1]);
  }

  return accepted;
}

test('aircraft profile broadcasts use the effective adapter-owned template', () => {
  const coreSource = stripCommentsPreserveLines(read('backend/core/simbridge-core.ts'));
  const templateAssignments = coreSource.match(
    /aircraftSpecificTemplateId:\s*getActiveAircraftSpecificTemplateId\(profile\)/g,
  ) || [];

  assert(
    templateAssignments.length === 2,
    'reconnect and auto-detect profile broadcasts must both use the effective template resolver',
  );
  assert(
    coreSource.includes('profileLoader.getAircraftSpecificConfig()'),
    'the effective template resolver must read the loader aircraft-specific configuration',
  );
  assert(
    !/aircraftSpecificTemplateId:\s*profile\?\.integration\?\.presentation/.test(coreSource),
    'profile broadcasts must not bypass adapter-owned presentation data',
  );
});

test('aircraft-specific JSONL follows the canonical projector and CSV recording lifecycle', () => {
  const coreSource = stripCommentsPreserveLines(read('backend/core/simbridge-core.ts'));
  const sharedOptionsIndex = coreSource.indexOf('const sharedRecorderOptions = {');
  const startupReservationIndex = coreSource.indexOf('recordingBundleLifecycle.beginRecordingBundleStartup({');
  const csvStartIndex = coreSource.indexOf('writer = flightCsvWriter.startFlight(sharedRecorderOptions);');
  const automationSidecarStartIndex = coreSource.indexOf('automationJsonlRecorder.startFlight(sharedRecorderOptions);');
  const aircraftSidecarStartIndex = coreSource.indexOf('aircraftSpecificJsonlRecorder.startFlight(sharedRecorderOptions);');
  const startupValidationIndex = coreSource.indexOf('const startupMemberStats = [');
  const startupCommitIndex = coreSource.indexOf('recordingBundleLifecycle.commitRecordingBundleStartup(recordingSessionId);');

  assert(
    coreSource.includes("require('../flight-recording/aircraft-specific-jsonl-recorder')"),
    'simbridge-core must load the aircraft-specific JSONL companion recorder',
  );
  assert(
    coreSource.includes('onStateBuilt: (state, context) =>'),
    'aircraft-specific recording must observe the canonical decoded projector state',
  );
  assert(
    coreSource.includes('aircraftSpecificJsonlRecorder.recordAircraftSpecificState({'),
    'each projector observation must feed the aircraft-specific recorder',
  );
  assert(
    coreSource.includes('valueType: field?.decode?.type,')
      && !coreSource.includes('sourceFingerprint: field?.sourceFingerprint,')
      && !coreSource.includes('logicalContract: field?.decode,'),
    'aircraft-specific recording config should retain logical field types without source or decoder fingerprints',
  );
  assert(
    sharedOptionsIndex >= 0
      && startupReservationIndex > sharedOptionsIndex
      && csvStartIndex > startupReservationIndex
      && automationSidecarStartIndex > csvStartIndex
      && aircraftSidecarStartIndex > automationSidecarStartIndex
      && startupValidationIndex > aircraftSidecarStartIndex
      && startupCommitIndex > startupValidationIndex,
    'startup must reserve one immutable bundle path before all three writers, validate every member, then atomically commit ownership',
  );
  assert(
    coreSource.includes('recordingBundleGuard.flushActiveBundle().then((flushed) => {')
      && !coreSource.includes('renameActiveRecordingBundle')
      && !coreSource.includes('aircraftSpecificJsonlRecorder.updateRoute(')
      && !coreSource.includes('automationJsonlRecorder.updateRoute('),
    'active bundle basenames must remain immutable; landing route data is flushed in-row without multi-file renames',
  );
  assert(
    coreSource.includes('aircraftSpecificJsonlRecorder.endFlight(aircraftSpecificEndContext)')
      && coreSource.includes('flightElapsedMs: computeElapsedMs(nowEpochMs, endingRecordingStartEpochMs)')
      && coreSource.includes('flightElapsedMs: computeElapsedMs(context.nowEpochMs, flightRecordingStartEpochMs)')
      && coreSource.includes('flightRecordingStartEpochMs = recordingStartEpochMs;')
      && coreSource.includes('flightElapsedMs: computeElapsedMs(nowEpochMs, flightRecordingStartEpochMs)'),
    'normal flight end must include recording-clock-aligned aircraft-specific sidecar finalization',
  );
  assert(
    coreSource.includes('const csvFinalizePromise = csvWasRecording')
      && coreSource.includes('? flightCsvWriter.endFlight().catch((e) => {'),
    'normal flight end must fully await the authoritative CSV instead of timing it out',
  );
  assert(
    coreSource.includes('let activeFlightFinalizationPromise: Promise<unknown> | null = null;')
      && coreSource.includes("return 'Previous flight recording is still finalizing';")
      && coreSource.includes('aircraftSpecificJsonlRecorder.isFinalizing?.() === true'),
    'a new recording must not replace companions while the prior route/finalization is still pending',
  );
  const startFlightIndex = coreSource.indexOf('function startFlight(nowEpochMs, timestampIso');
  const preflightBlockerIndex = coreSource.indexOf(
    'const finalizationBlocker = getRecordingFinalizationBlocker();',
    startFlightIndex,
  );
  const lifecycleMutationIndex = coreSource.indexOf(
    "clearManualAutoStartSuppression('flight_started');",
    startFlightIndex,
  );
  assert(
    startFlightIndex >= 0
      && preflightBlockerIndex > startFlightIndex
      && preflightBlockerIndex < lifecycleMutationIndex,
    'prior-flight finalization must be checked before a new lifecycle becomes active',
  );
  const synchronousRecorderGateIndex = coreSource.indexOf(
    'if (aircraftSpecificWasRecording) aircraftSpecificRecordingFinalizing = true;',
  );
  const aircraftFinalizeIndex = coreSource.indexOf(
    'aircraftSpecificJsonlRecorder.endFlight(aircraftSpecificEndContext)',
  );
  assert(
    synchronousRecorderGateIndex >= 0 && synchronousRecorderGateIndex < aircraftFinalizeIndex,
    'aircraft-specific observer writes must stop synchronously before an ending flight can see a replacement profile',
  );
  assert(
    coreSource.includes('const SHUTDOWN_RECORDING_FINALIZATION_TIMEOUT_MS = 12000;')
      && coreSource.includes('() => finalizeRecordingForShutdown({')
      && coreSource.includes('SHUTDOWN_RECORDING_FINALIZATION_TIMEOUT_MS,')
      && coreSource.includes("'recording finalization'"),
    'shutdown must apply one outer recording-finalization deadline that covers every bundle member close',
  );
  assert(
    /finalizeOpenRecordersForShutdown[\s\S]*?aircraftSpecificJsonlRecorder\.endFlight\(\{/.test(coreSource),
    'shutdown must finalize an open aircraft-specific sidecar',
  );
});

test('simbridge-core VRE evaluation helper keeps the live VRE input contract in sync', () => {
  const coreSource = stripCommentsPreserveLines(read('backend/core/simbridge-core.ts'));
  assert(
    /const\s+vreFrame\s*=\s*buildVreEvaluationFrame\s*\(/.test(coreSource),
    'simbridge-core must build live VRE input through buildVreEvaluationFrame'
  );

  const source = stripCommentsPreserveLines(read('backend/core/simbridge-core-utils.ts'));
  const keys = getObjectLiteralKeysFromSource(
    source,
    /export function buildVreEvaluationFrame[\s\S]*?return\s+\{([\s\S]*?)\n\s*\};/,
    'buildVreEvaluationFrame return object'
  );

  const required = [
    'vs',
    'ra',
    'gForce',
    'pitchRate',
    'rollRate',
    'yawRate',
    'gs',
    'gearDown',
    'flapsNotch',
    'spoilerState',
    'wow',
  ];

  const missing = required.filter((key) => !keys.has(key));
  assert(missing.length === 0, `vreFrame missing required keys: ${missing.join(', ')}`);
});

test('VRE CSV sample writes retain the independent 10 Hz admission gate', () => {
  const coreSource = stripCommentsPreserveLines(read('backend/core/simbridge-core.ts'));
  const utilsSource = stripCommentsPreserveLines(read('backend/core/simbridge-core-utils.ts'));

  assert(
    /MAX_VRE_CSV_SAMPLE_RATE_HZ\s*=\s*10\b/.test(utilsSource),
    'VRE CSV sample hard ceiling must remain 10 Hz',
  );
  assert(
    /const\s+vreCsvSampleDue\s*=\s*vreResult\.shouldSample\s*&&\s*isVreCsvSampleDue\s*\(/.test(coreSource),
    'simbridge-core must apply the independent VRE CSV admission gate',
  );
  assert(
    /if\s*\(\s*!vreCsvSampleDue\s*\)\s*return\s*;/.test(coreSource),
    'simbridge-core must reject VRE samples that arrive before the hard interval',
  );
  assert(
    /lastVreCsvWriteAttemptTs\s*=\s*now\s*;[\s\S]{0,200}?flightCsvWriter\.writeSample\s*\(/.test(coreSource),
    'simbridge-core must timestamp each admitted writer attempt before calling the writer',
  );
});

test('VRE replay harness only uses evaluator-recognized input keys', () => {
  const source = stripCommentsPreserveLines(read('tests/backend/real-flight-replay.test.js'));
  const keys = getObjectLiteralKeysFromSource(
    source,
    /const\s+frame\s*=\s*\{([\s\S]*?)\n\s*\};/,
    'real-flight replay VRE frame object'
  );

  const allowed = new Set([
    'vs',
    'ra',
    'gForce',
    'pitchRate',
    'rollRate',
    'yawRate',
    'gearDown',
    'gearDownLocked',
    'flapsNotch',
    'spoilerState',
    'wow',
    'onGround',
    'pitch',
    'bank',
    'gs',
    'groundSpeed',
    'phase',
  ]);

  const unknown = [...keys].filter((key) => !allowed.has(key));
  assert(unknown.length === 0, `replay harness has non-VRE keys: ${unknown.join(', ')}`);
  assert(keys.has('vs'), 'replay harness must provide vs');
  assert(keys.has('ra'), 'replay harness must provide ra');
  assert(keys.has('wow'), 'replay harness must provide wow');
});

test('simbridge-core only uses VRE result fields returned by the evaluator', () => {
  const evaluatorSource = stripCommentsPreserveLines(read('backend/events/vre-evaluator.js'));
  const resultKeys = getObjectLiteralKeysFromSource(
    evaluatorSource,
    /return\s*\{([\s\S]*?)\n\s*\};/,
    'VRE evaluator result object'
  );

  const coreSource = stripCommentsPreserveLines(read('backend/core/simbridge-core.js'));
  const used = new Set();
  for (const match of coreSource.matchAll(/\bvreResult\.(\w+)/g)) {
    used.add(match[1]);
  }

  const missing = [...used].filter((key) => !resultKeys.has(key));
  assert(missing.length === 0, `simbridge-core reads missing vreResult keys: ${missing.join(', ')}`);
});

test('timeline generator altitude markers are defined in timeline-events MARKER_TYPE', () => {
  const timelineEventsSource = stripCommentsPreserveLines(read('backend/events/timeline-events.js'));
  const markerBlock = /const\s+MARKER_TYPE\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(timelineEventsSource);
  assert(markerBlock, 'could not find MARKER_TYPE in timeline-events.js');

  const markerValues = new Set();
  for (const match of markerBlock[1].matchAll(/:\s*'([^']+)'/g)) {
    markerValues.add(match[1]);
  }

  const generatorSource = stripCommentsPreserveLines(read('backend/events/timeline-generator.js'));
  const altitudeBlock = /const\s+ALTITUDE_MARKERS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(generatorSource);
  assert(altitudeBlock, 'could not find ALTITUDE_MARKERS in timeline-generator.js');

  const referenced = new Set();
  for (const match of altitudeBlock[1].matchAll(/MARKER_TYPE\.(\w+)/g)) {
    const key = match[1];
    const valueMatch = new RegExp(`${key}\\s*:\\s*'([^']+)'`).exec(markerBlock[1]);
    assert(valueMatch, `timeline-events MARKER_TYPE missing ${key}`);
    referenced.add(valueMatch[1]);
  }

  const missing = [...referenced].filter((value) => !markerValues.has(value));
  assert(missing.length === 0, `timeline generator references unknown marker types: ${missing.join(', ')}`);
});

test('timeline UI labels cover generator event types and shared marker types', () => {
  const timelineUiSource = stripCommentsPreserveLines(read('frontend/src/timeline/constants.js'));

  const typeLabelsBlock = /TYPE_LABELS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(timelineUiSource);
  assert(typeLabelsBlock, 'could not find TYPE_LABELS in frontend/src/timeline/constants.js');
  const labeledTypes = new Set();
  for (const match of typeLabelsBlock[1].matchAll(/^\s*([a-z0-9_]+)\s*:/gm)) {
    labeledTypes.add(match[1]);
  }

  const generatorSource = stripCommentsPreserveLines(read('backend/events/timeline-generator.js'));
  const emittedTypes = new Set();
  for (const match of generatorSource.matchAll(/\btype:\s*'([a-z_]+)'/g)) {
    emittedTypes.add(match[1]);
  }
  const missingTypes = [...emittedTypes].filter((value) => !labeledTypes.has(value));
  assert(missingTypes.length === 0, `timeline UI missing labels for event types: ${missingTypes.join(', ')}`);

  const markerLabelsBlock = /MARKER_LABELS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(timelineUiSource);
  assert(markerLabelsBlock, 'could not find MARKER_LABELS in frontend/src/timeline/constants.js');
  const labeledMarkers = new Set();
  for (const match of markerLabelsBlock[1].matchAll(/^\s*([a-z0-9_]+)\s*:/gm)) {
    labeledMarkers.add(match[1]);
  }

  const timelineEventsSource = stripCommentsPreserveLines(read('backend/events/timeline-events.js'));
  const markerBlock = /const\s+MARKER_TYPE\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(timelineEventsSource);
  assert(markerBlock, 'could not find MARKER_TYPE in timeline-events.js');
  const markerValues = new Set();
  for (const match of markerBlock[1].matchAll(/:\s*'([^']+)'/g)) {
    markerValues.add(match[1]);
  }

  const missingMarkers = [...markerValues].filter((value) => !labeledMarkers.has(value));
  assert(missingMarkers.length === 0, `timeline UI missing marker labels for: ${missingMarkers.join(', ')}`);
});

test('frontend WebSocket message handlers only switch on registered MSG values', () => {
  const appSource = stripCommentsPreserveLines(read('frontend/src/app/message-handlers.js'));
  const profileStoreSource = stripCommentsPreserveLines(read('frontend/src/vue/stores/profiles.js'));

  const handled = new Map([
    ['frontend/src/app/message-handlers.js', getSwitchCaseStrings(appSource, 'message\\.type', 'app message handler')],
    ['frontend/src/vue/stores/profiles.js', getSwitchCaseStrings(profileStoreSource, 'msg\\.type', 'profile store message handler')],
  ]);

  const unknown = [];
  for (const [filePath, cases] of handled.entries()) {
    for (const value of cases) {
      if (!MSG_VALUES.has(value)) unknown.push(`${value} at ${filePath}`);
    }
  }

  assert(unknown.length === 0, `frontend handlers use unknown WebSocket message types: ${unknown.join('; ')}`);
});

test('frontend live telemetry message allowlist is registered and handled', () => {
  const defaultsSource = stripCommentsPreserveLines(read('frontend/src/telemetry/display-defaults.js'));
  const handlerSource = stripCommentsPreserveLines(read('frontend/src/app/message-handlers.js'));
  const liveTypes = getSetStringValues(defaultsSource, 'LIVE_TELEMETRY_MESSAGE_TYPES');
  const handledTypes = getSwitchCaseStrings(handlerSource, 'message\\.type', 'app message handler');
  const hasGenericLiveTelemetryHandler = handlerSource.includes('LIVE_TELEMETRY_MESSAGE_TYPES.has(message.type)');

  const unknown = [...liveTypes].filter((value) => !MSG_VALUES.has(value));
  const unhandled = hasGenericLiveTelemetryHandler ? [] : [...liveTypes].filter((value) => !handledTypes.has(value));

  assert(unknown.length === 0, `LIVE_TELEMETRY_MESSAGE_TYPES has unknown MSG values: ${unknown.join(', ')}`);
  assert(unhandled.length === 0, `LIVE_TELEMETRY_MESSAGE_TYPES values are not handled by app message handler: ${unhandled.join(', ')}`);
});

test('frontend outbound WebSocket command literals are handled by the backend', () => {
  const accepted = getBackendAcceptedClientMessageTypes();
  const files = sourceFilesUnder('frontend')
    .filter((filePath) => !rel(filePath).includes('/node_modules/'))
    .filter((filePath) => !rel(filePath).includes('/vendor/'));
  const missing = [];

  for (const filePath of files) {
    const source = stripCommentsPreserveLines(fs.readFileSync(filePath, 'utf8'));
    const relative = rel(filePath);
    const patterns = [
      /\b(?:sendWs|sendWsMessage|send|connection\.send)\s*\(\s*\{\s*type:\s*['"]([^'"]+)['"]/g,
      /\bws\.send\s*\(\s*JSON\.stringify\s*\(\s*\{\s*type:\s*['"]([^'"]+)['"]/g,
    ];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const value = match[1];
        if (!accepted.has(value)) {
          missing.push(`${value} at ${relative}:${lineNumber(source, match.index)}`);
        }
      }
    }
  }

  assert(missing.length === 0, `frontend sends WebSocket command types without backend handlers: ${missing.join('; ')}`);
});

test('every inbound WebSocket command belongs to exactly one authorization tier', () => {
  const accepted = getBackendAcceptedClientMessageTypes();
  const authorizationSource = stripCommentsPreserveLines(
    read('backend/core/client-message-authorization.ts'),
  );
  const tiers = new Map([
    [
      'trusted-LAN safe read',
      getFrozenArrayStringValues(authorizationSource, 'TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES'),
    ],
    [
      'aircraft control',
      getFrozenArrayStringValues(authorizationSource, 'AIRCRAFT_CONTROL_MESSAGE_TYPES'),
    ],
    [
      'privileged client',
      getFrozenArrayStringValues(authorizationSource, 'PRIVILEGED_CLIENT_MESSAGE_TYPES'),
    ],
  ]);
  const classified = new Map();
  const overlaps = [];

  for (const [tier, values] of tiers) {
    for (const value of values) {
      if (classified.has(value)) {
        overlaps.push(`${value} (${classified.get(value)} and ${tier})`);
      } else {
        classified.set(value, tier);
      }
    }
  }

  const missing = [...accepted].filter((value) => !classified.has(value));
  const stale = [...classified.keys()].filter((value) => !accepted.has(value));

  assert(overlaps.length === 0, `authorization tiers overlap: ${overlaps.join('; ')}`);
  assert(
    missing.length === 0,
    `backend command handlers missing authorization classification: ${missing.join(', ')}`,
  );
  assert(
    stale.length === 0,
    `authorization policy contains commands without backend handlers: ${stale.join(', ')}`,
  );
});

console.log(`\nContract drift tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
