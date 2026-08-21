#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ts = require('typescript');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_FRONTEND_ROOT = path.join(ROOT, 'frontend-dist');
const HOST = '127.0.0.1';
const PROFILE_KEY = 'bundled/msfs/pmdg-737';
const PROFILE_REVISION = 737001;
const TEMPLATE_ID = 'pmdg-737';
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

const PROFILE = Object.freeze({
  id: 'pmdg-737',
  name: 'PMDG Boeing 737-800',
  namespace: 'bundled',
  simulator: 'msfs',
  _profileKey: PROFILE_KEY,
  profileRevision: PROFILE_REVISION,
  aircraftSpecificTemplateId: TEMPLATE_ID,
  verificationStatus: 'fixture',
});

const POWERED_VALUES = Object.freeze({
  'systems.electrical.batteryMode': 'on',
  'systems.electrical.standbyPowerMode': 'auto',
  'systems.electrical.busTransferAuto': true,
  'systems.electrical.transferBus1Powered': true,
  'systems.electrical.transferBus2Powered': true,
  'systems.electrical.batteryDischarge': false,
  'systems.electrical.standbyPowerOff': false,
});

const SCENARIOS = Object.freeze({
  'cold-dark': Object.freeze({
    label: 'Cold & dark',
    description: 'Unpowered flight deck with ground power available.',
    values: Object.freeze({
      'systems.electrical.batteryMode': 'off',
      'systems.electrical.standbyPowerMode': 'off',
      'systems.electrical.busTransferAuto': true,
      'systems.electrical.groundPowerAvailable': true,
      'systems.electrical.groundConnectionAvailable': true,
      'systems.electrical.transferBus1Powered': false,
      'systems.electrical.transferBus2Powered': false,
      'systems.electrical.batteryDischarge': false,
      'systems.electrical.standbyPowerOff': true,
      'systems.irs.leftMode': 'off',
      'systems.irs.rightMode': 'off',
      'systems.apuMode': 'off',
      'systems.apuEgt': 0,
    }),
  }),
  'gpu-available': Object.freeze({
    label: 'GPU available',
    description: 'Protected DC configuration with AC buses still unpowered.',
    values: Object.freeze({
      ...POWERED_VALUES,
      'systems.electrical.groundPowerAvailable': true,
      'systems.electrical.groundConnectionAvailable': true,
      'systems.electrical.transferBus1Powered': false,
      'systems.electrical.transferBus2Powered': false,
      'systems.irs.leftMode': 'off',
      'systems.irs.rightMode': 'off',
    }),
  }),
  'apu-starting': Object.freeze({
    label: 'APU starting',
    description: 'APU start selector, rising EGT, and LOW OIL indication.',
    values: Object.freeze({
      ...POWERED_VALUES,
      'systems.electrical.groundPowerAvailable': false,
      'systems.electrical.groundConnectionAvailable': false,
      'systems.electrical.transferBus1Powered': false,
      'systems.electrical.transferBus2Powered': false,
      'systems.electrical.apuGeneratorOffBus': false,
      'systems.apuMode': 'start',
      'systems.apuEgt': 430,
      'systems.apuLowOilPressure': true,
    }),
  }),
  powered: Object.freeze({
    label: 'AC powered',
    description: 'Both transfer buses powered with IRS selectors still off.',
    values: Object.freeze({
      ...POWERED_VALUES,
      'systems.electrical.groundPowerAvailable': true,
      'systems.electrical.groundConnectionAvailable': true,
      'systems.irs.leftMode': 'off',
      'systems.irs.rightMode': 'off',
    }),
  }),
  'irs-aligning': Object.freeze({
    label: 'IRS aligning',
    description: 'Powered aircraft with both IRS selectors in NAV and ALIGN illuminated.',
    values: Object.freeze({
      ...POWERED_VALUES,
      'systems.electrical.groundPowerAvailable': true,
      'systems.irs.leftMode': 'nav',
      'systems.irs.rightMode': 'nav',
      'systems.irs.leftAlign': true,
      'systems.irs.rightAlign': true,
      'systems.irsAligned': false,
      'flightControls.yawDamper': true,
      'lights.emergencyMode': 'armed',
      'systems.windowHeatCaptainForward': true,
      'systems.windowHeatFirstOfficerForward': true,
      'systems.windowHeatCaptainSide': true,
      'systems.windowHeatFirstOfficerSide': true,
    }),
  }),
  partial: Object.freeze({
    label: 'Partial SDK data',
    description: 'Connected snapshot with deliberately unavailable readbacks.',
    values: Object.freeze({
      ...POWERED_VALUES,
      'systems.electrical.groundPowerAvailable': true,
      'systems.irs.leftMode': 'nav',
      'systems.irs.rightMode': 'nav',
    }),
    unavailable: Object.freeze([
      'systems.apuEgt',
      'systems.irs.rightAlign',
      'systems.windowHeatFirstOfficerSide',
      'radios.nav2StandbyMhz',
    ]),
    unsupportedActions: Object.freeze([
      'systems.apu.start',
      'systems.windowHeatFirstOfficerSide.on',
      'nav2.inner.increment',
      'nav2.inner.decrement',
    ]),
  }),
  stale: Object.freeze({
    label: 'Stale SDK data',
    description: 'Retained values with stale source health.',
    values: Object.freeze({
      ...POWERED_VALUES,
      'systems.irs.leftMode': 'nav',
      'systems.irs.rightMode': 'nav',
    }),
    sourceStatus: 'stale',
  }),
  disconnected: Object.freeze({
    label: 'Simulator disconnected',
    description: 'Disconnected SimConnect and PMDG SDK sources.',
    values: Object.freeze({}),
    sourceStatus: 'disconnected',
    simConnected: false,
  }),
});

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function log(message) {
  process.stdout.write(`[pmdg-737-preview] ${message}\n`);
}

function loadTypeScriptCommonJs(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pmdg-preview-contract-'));
  const compiledPath = path.join(tempDir, `${path.basename(filePath, '.ts')}.cjs`);
  try {
    fs.writeFileSync(compiledPath, output, { encoding: 'utf8', flag: 'wx' });
    const resolvedPath = require.resolve(compiledPath);
    const moduleExports = require(resolvedPath);
    delete require.cache[resolvedPath];
    return moduleExports;
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function loadPmdgContracts(rootDir = ROOT) {
  const integrationRoot = path.join(
    rootDir,
    'backend',
    'aircraft',
    'aircraft-integrations',
    'pmdg-737',
  );
  const { PMDG_737_ACTIONS } = loadTypeScriptCommonJs(path.join(integrationRoot, 'actions.ts'));
  const { PMDG_737_FIELDS } = loadTypeScriptCommonJs(path.join(integrationRoot, 'fields.ts'));
  if (!PMDG_737_ACTIONS || !PMDG_737_FIELDS) {
    throw new Error('Unable to load the PMDG 737 field/action contracts.');
  }
  return { actions: PMDG_737_ACTIONS, fields: PMDG_737_FIELDS };
}

function defaultValueForField(field) {
  const decode = field?.sources?.[0]?.decode;
  if (decode?.type === 'boolean') return false;
  if (decode?.type === 'number') return 0;
  if (decode?.type === 'enum') return Object.values(decode.values || {})[0] ?? null;
  return null;
}

function createBaseValues(fields) {
  const values = Object.fromEntries(
    Object.entries(fields).map(([fieldId, field]) => [fieldId, defaultValueForField(field)]),
  );
  return {
    ...values,
    'aircraft.model': '737-800',
    'mcp.courseCaptainDeg': 270,
    'mcp.speed': 250,
    'mcp.headingDeg': 270,
    'mcp.altitudeFt': 10000,
    'mcp.verticalSpeedFpm': 0,
    'mcp.courseFirstOfficerDeg': 270,
    'radios.nav1ActiveMhz': 110.5,
    'radios.nav1StandbyMhz': 113.9,
    'radios.nav2ActiveMhz': 112.3,
    'radios.nav2StandbyMhz': 115.7,
    'lights.landingRetractableLeftMode': 'retract',
    'lights.landingRetractableRightMode': 'retract',
    'lights.positionMode': 'steady',
    'lights.emergencyMode': 'off',
    'cabin.noSmokingMode': 'auto',
    'cabin.seatBeltsMode': 'off',
    'visibility.wiperLeftMode': 'off',
    'visibility.wiperRightMode': 'off',
    'systems.electrical.batteryMode': 'off',
    'systems.electrical.standbyPowerMode': 'off',
    'systems.electrical.busTransferAuto': true,
    'systems.irs.leftMode': 'off',
    'systems.irs.rightMode': 'off',
    'systems.packLeftMode': 'auto',
    'systems.packRightMode': 'auto',
    'systems.apuMode': 'off',
    'gear.noseSafe': true,
    'gear.leftSafe': true,
    'gear.rightSafe': true,
    'gear.handleMode': 'down',
    'gear.autobrakeMode': 'off',
    'gear.parkingBrake': true,
  };
}

function buildScenarioState(name, contracts) {
  const definition = SCENARIOS[name];
  if (!definition) throw new Error(`Unknown PMDG preview scenario: ${name}`);
  const unavailable = [...(definition.unavailable || [])];
  const values = { ...createBaseValues(contracts.fields), ...definition.values };
  for (const fieldId of unavailable) delete values[fieldId];
  const actionCapabilities = Object.fromEntries(
    Object.keys(contracts.actions).map((actionId) => [actionId, true]),
  );
  for (const actionId of definition.unsupportedActions || []) {
    if (Object.prototype.hasOwnProperty.call(actionCapabilities, actionId)) {
      actionCapabilities[actionId] = false;
    }
  }
  const sourceStatus = definition.sourceStatus || 'connected';
  return {
    name,
    label: definition.label,
    description: definition.description,
    dirty: false,
    simConnected: definition.simConnected !== false,
    available: sourceStatus === 'connected',
    sourceStatus,
    values,
    unavailable,
    actionCapabilities,
    updatedAt: new Date().toISOString(),
  };
}

function roundFrequency(value) {
  return Math.round(value * 100) / 100;
}

function applyRadioAction(state, actionId) {
  const match = /^(nav[12])\.(transfer|inner|outer)(?:\.(increment|decrement))?$/.exec(actionId);
  if (!match) return false;
  const radio = match[1];
  const activeField = `radios.${radio}ActiveMhz`;
  const standbyField = `radios.${radio}StandbyMhz`;
  if (match[2] === 'transfer') {
    const active = state.values[activeField];
    state.values[activeField] = state.values[standbyField];
    state.values[standbyField] = active;
    return true;
  }
  const direction = match[3] === 'decrement' ? -1 : 1;
  const increment = match[2] === 'outer' ? 1 : 0.05;
  const current = Number(state.values[standbyField]);
  if (!Number.isFinite(current)) return false;
  state.values[standbyField] = roundFrequency(Math.max(108, Math.min(117.95, current + direction * increment)));
  return true;
}

function applyFixtureAction(state, actionId, inputValue, actions) {
  const action = actions[actionId];
  if (!action) return { ok: false, error: `Unknown PMDG action: ${actionId}` };

  if (applyRadioAction(state, actionId)) {
    state.dirty = true;
    state.updatedAt = new Date().toISOString();
    return { ok: true };
  }

  if (actionId === 'systems.apu.start') {
    state.values['systems.apuMode'] = 'start';
    state.values['systems.apuEgt'] = 320;
    state.values['systems.apuLowOilPressure'] = true;
    state.values['systems.electrical.apuGeneratorOffBus'] = false;
    state.dirty = true;
    state.updatedAt = new Date().toISOString();
    return { ok: true, apuStart: true };
  }

  const route = action.routes?.find((candidate) => candidate.readback || candidate.readbacks)
    || action.routes?.[0];
  let changed = false;
  for (const readback of route?.readbacks || []) {
    if (Object.prototype.hasOwnProperty.call(readback, 'expectedValue')) {
      state.values[readback.fieldId] = readback.expectedValue;
      changed = true;
    }
  }
  const readback = route?.readback;
  if (readback && Object.prototype.hasOwnProperty.call(readback, 'expectedValue')) {
    state.values[readback.fieldId] = readback.expectedValue;
    changed = true;
  } else if (readback?.expectedInput === true && Number.isFinite(Number(inputValue))) {
    state.values[readback.fieldId] = Number(inputValue);
    changed = true;
  }
  if (!changed) return { ok: false, error: `Fixture has no deterministic readback effect for ${actionId}` };

  state.dirty = true;
  state.updatedAt = new Date().toISOString();
  return { ok: true };
}

function injectPreviewAssets(html) {
  const styleTag = '<link rel="stylesheet" href="/__pmdg-preview/client.css" />';
  const scriptTag = '<script defer src="/__pmdg-preview/client.js"></script>';
  const withStyle = html.includes('</head>')
    ? html.replace('</head>', `  ${styleTag}\n</head>`)
    : `${styleTag}\n${html}`;
  return withStyle.includes('</body>')
    ? withStyle.replace('</body>', `  ${scriptTag}\n</body>`)
    : `${withStyle}\n${scriptTag}`;
}

function parsePort(value, fallback) {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseArgs(argv) {
  const options = {
    buildFrontend: true,
    openBrowser: true,
    scenario: 'cold-dark',
    httpPort: 0,
    wsPort: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value after ${arg}`);
      return argv[index];
    };
    if (arg === '--no-build') options.buildFrontend = false;
    else if (arg === '--no-open') options.openBrowser = false;
    else if (arg === '--scenario') options.scenario = nextValue();
    else if (arg.startsWith('--scenario=')) options.scenario = arg.slice('--scenario='.length);
    else if (arg === '--http-port') options.httpPort = parsePort(nextValue(), 0);
    else if (arg.startsWith('--http-port=')) options.httpPort = parsePort(arg.slice('--http-port='.length), 0);
    else if (arg === '--ws-port') options.wsPort = parsePort(nextValue(), 0);
    else if (arg.startsWith('--ws-port=')) options.wsPort = parsePort(arg.slice('--ws-port='.length), 0);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!SCENARIOS[options.scenario]) throw new Error(`Unknown scenario: ${options.scenario}`);
  return options;
}

function printHelp() {
  const scenarioText = Object.entries(SCENARIOS)
    .map(([id, scenario]) => `  ${id.padEnd(16)} ${scenario.description}`)
    .join('\n');
  process.stdout.write(`PMDG 737 page preview\n\nUsage:\n  npm run preview:pmdg-737 -- [options]\n\nOptions:\n  --scenario <id>   Initial fixture scenario\n  --no-build        Reuse the current frontend-dist bundle\n  --no-open         Print the URL without opening a browser\n  --http-port <n>   HTTP port (0 chooses a free port)\n  --ws-port <n>     WebSocket port (0 chooses a free port)\n  --help            Show this help\n\nScenarios:\n${scenarioText}\n`);
}

function resolveNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCliPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCliPath) {
    throw new Error('Could not locate npm-cli.js. Start the preview with npm run preview:pmdg-737.');
  }
  return npmCliPath;
}

function buildFrontend(rootDir = ROOT) {
  const npmCliPath = resolveNpmCliPath();
  const result = spawnSync(process.execPath, [npmCliPath, 'run', 'frontend:build'], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`Could not launch the frontend build: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Frontend build exited with status ${result.status}; preview was not started.`);
  }
}

function openUrl(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    log(`Could not open a browser automatically: ${error.message}`);
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function resolveSafeStaticPath(rootDir, requestPath) {
  const resolvedRoot = path.resolve(rootDir);
  const relativeRequestPath = String(requestPath || '').replace(/^[/\\]+/, '');
  const candidatePath = path.resolve(resolvedRoot, relativeRequestPath);
  const rootForComparison = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const candidateForComparison = process.platform === 'win32'
    ? candidatePath.toLowerCase()
    : candidatePath;
  const relative = path.relative(rootForComparison, candidateForComparison);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidatePath;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeWsServer(wss) {
  return new Promise((resolve) => {
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
    wss.close(() => resolve());
  });
}

async function createPreviewRuntime({
  rootDir = ROOT,
  frontendRoot = DEFAULT_FRONTEND_ROOT,
  buildFrontend: shouldBuild = false,
  openBrowser = false,
  scenario = 'cold-dark',
  httpPort = 0,
  wsPort = 0,
} = {}) {
  if (shouldBuild) buildFrontend(rootDir);
  const indexPath = path.join(frontendRoot, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Frontend bundle missing at ${indexPath}. Run without --no-build.`);
  }

  const contracts = loadPmdgContracts(rootDir);
  let fixtureState = buildScenarioState(scenario, contracts);
  let closed = false;
  let apuReadyTimer = null;
  const actionTimers = new Set();

  const appSettingsApi = require(path.join(rootDir, 'shared', 'app-settings-shared.js'));
  const appSettings = appSettingsApi.normalizeAppSettings({}, {
    defaults: appSettingsApi.APP_SETTINGS_DEFAULTS,
  });

  function publicState() {
    return {
      scenario: fixtureState.name,
      label: fixtureState.label,
      description: fixtureState.description,
      dirty: fixtureState.dirty,
      sourceStatus: fixtureState.sourceStatus,
      scenarios: Object.entries(SCENARIOS).map(([id, item]) => ({
        id,
        label: item.label,
        description: item.description,
      })),
    };
  }

  function sendJson(ws, payload) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  function stateMessage() {
    return {
      type: 'aircraftSpecificState',
      profileKey: PROFILE_KEY,
      profileRevision: PROFILE_REVISION,
      templateId: TEMPLATE_ID,
      available: fixtureState.available,
      sourceStatus: {
        overall: fixtureState.sourceStatus,
        sources: { sdk: fixtureState.sourceStatus },
      },
      values: { ...fixtureState.values },
      unavailable: [...fixtureState.unavailable],
      actionCapabilities: { ...fixtureState.actionCapabilities },
      updatedAt: fixtureState.updatedAt,
    };
  }

  function broadcast(payload) {
    const serialized = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(serialized);
    }
  }

  function sendInitialState(ws) {
    sendJson(ws, {
      type: 'simState',
      simconnectConnected: fixtureState.simConnected,
      inMenu: false,
    });
    sendJson(ws, {
      type: 'aircraftProfile',
      profile: PROFILE,
      controlCapabilities: { aircraftSpecific: fixtureState.actionCapabilities },
    });
    sendJson(ws, stateMessage());
    sendJson(ws, { type: 'ias', value: 0 });
    sendJson(ws, { type: 'gs', value: 0 });
    sendJson(ws, { type: 'phase', phase: 'PARKED' });
  }

  function broadcastState({ includeProfile = false } = {}) {
    broadcast({
      type: 'simState',
      simconnectConnected: fixtureState.simConnected,
      inMenu: false,
    });
    if (includeProfile) {
      broadcast({
        type: 'aircraftProfile',
        profile: PROFILE,
        controlCapabilities: { aircraftSpecific: fixtureState.actionCapabilities },
      });
    }
    broadcast(stateMessage());
  }

  function setScenario(nextScenario) {
    if (!SCENARIOS[nextScenario]) throw new Error(`Unknown PMDG preview scenario: ${nextScenario}`);
    if (apuReadyTimer) clearTimeout(apuReadyTimer);
    apuReadyTimer = null;
    fixtureState = buildScenarioState(nextScenario, contracts);
    broadcastState({ includeProfile: true });
    return publicState();
  }

  function scheduleApuReady() {
    if (apuReadyTimer) clearTimeout(apuReadyTimer);
    apuReadyTimer = setTimeout(() => {
      apuReadyTimer = null;
      if (closed || fixtureState.values['systems.apuMode'] !== 'start') return;
      fixtureState.values['systems.apuMode'] = 'on';
      fixtureState.values['systems.apuEgt'] = 610;
      fixtureState.values['systems.apuLowOilPressure'] = false;
      fixtureState.values['systems.electrical.apuGeneratorOffBus'] = true;
      fixtureState.dirty = true;
      fixtureState.updatedAt = new Date().toISOString();
      broadcastState();
    }, 1600);
  }

  function sendControlResult(ws, message, result) {
    sendJson(ws, {
      type: 'aircraftControlResult',
      requestId: message.requestId,
      request: message,
      ok: result.ok,
      profileKey: PROFILE_KEY,
      profileRevision: PROFILE_REVISION,
      resolvedBy: 'profile',
      backendSource: 'PMDG 737 fixture',
      action: { type: 'fixture', name: message.actionId },
      ...(result.ok ? {} : { code: 'fixture_rejected', error: result.error }),
    });
  }

  function handleAircraftControl(ws, message) {
    if (message.profileKey !== PROFILE_KEY || message.profileRevision !== PROFILE_REVISION) {
      sendControlResult(ws, message, { ok: false, error: 'Fixture profile token mismatch.' });
      return;
    }
    if (fixtureState.sourceStatus !== 'connected' || fixtureState.simConnected !== true) {
      sendControlResult(ws, message, { ok: false, error: 'Fixture source is not connected.' });
      return;
    }
    if (fixtureState.actionCapabilities[message.actionId] !== true) {
      sendControlResult(ws, message, { ok: false, error: 'Action is unavailable in this fixture scenario.' });
      return;
    }
    const timer = setTimeout(() => {
      actionTimers.delete(timer);
      if (closed) return;
      const result = applyFixtureAction(
        fixtureState,
        message.actionId,
        message.value,
        contracts.actions,
      );
      if (result.ok) {
        broadcastState();
        if (result.apuStart) scheduleApuReady();
      }
      sendControlResult(ws, message, result);
    }, 250);
    actionTimers.add(timer);
  }

  function sendAppSettings(ws) {
    sendJson(ws, {
      type: 'appSettings',
      settings: appSettings,
      settingsFile: 'PMDG 737 preview fixture',
      storage: {},
      backendVersion: 'fixture',
    });
  }

  function handleWsMessage(ws, message) {
    switch (message.type) {
      case 'requestState':
        sendInitialState(ws);
        break;
      case 'requestAppSettings':
        sendAppSettings(ws);
        break;
      case 'listProfiles':
        sendJson(ws, { type: 'profileList', profiles: [PROFILE] });
        break;
      case 'executeAircraftControl':
        handleAircraftControl(ws, message);
        break;
      case 'saveAppSettings':
        sendJson(ws, {
          type: 'appSettingsSaved',
          ok: false,
          error: 'Settings are read-only in the PMDG preview fixture.',
          settings: appSettings,
          restartRequired: false,
          restartReasons: [],
        });
        break;
      default:
        break;
    }
  }

  const wss = new WebSocketServer({ host: HOST, port: wsPort });
  await new Promise((resolve, reject) => {
    if (wss.address()) {
      resolve();
      return;
    }
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('connection', (ws) => {
    sendJson(ws, { type: 'authorizationScope', scope: 'full-control' });
    ws.on('message', (buffer) => {
      try {
        handleWsMessage(ws, JSON.parse(buffer.toString('utf8')));
      } catch (error) {
        sendJson(ws, { type: 'fixtureError', error: error.message });
      }
    });
  });

  const resolvedWsPort = wss.address().port;
  const previewClientPath = path.join(__dirname, 'pmdg-737-preview-client.js');
  const previewCssPath = path.join(__dirname, 'pmdg-737-preview.css');
  let resolvedHttpPort = null;
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${HOST}:${resolvedHttpPort || 80}`);
    response.setHeader('Cache-Control', 'no-store');

    if (requestUrl.pathname === '/api/bootstrap') {
      const body = JSON.stringify({
        wsAuthToken: 'pmdg-737-preview-full-control',
        aircraftControlToken: 'pmdg-737-preview-aircraft-control',
        remoteAccessEnabled: false,
        networkInfo: { ips: [HOST], httpPort: resolvedHttpPort, wsPort: resolvedWsPort },
      });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(body);
      return;
    }

    if (requestUrl.pathname === '/__pmdg-preview/state' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(publicState()));
      return;
    }

    if (requestUrl.pathname === '/__pmdg-preview/scenario' && request.method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const nextState = setScenario(String(body.scenario || ''));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(nextState));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (requestUrl.pathname === '/__pmdg-preview/client.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      response.end(fs.readFileSync(previewClientPath));
      return;
    }
    if (requestUrl.pathname === '/__pmdg-preview/client.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      response.end(fs.readFileSync(previewCssPath));
      return;
    }

    let relativePath = decodeURIComponent(requestUrl.pathname || '/');
    if (relativePath === '/' || relativePath === '/remote' || relativePath === '/remote.html') {
      relativePath = '/index.html';
    }
    const candidatePath = resolveSafeStaticPath(frontendRoot, relativePath);
    if (!candidatePath) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }
    let filePath = candidatePath;
    try {
      if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
      let body = fs.readFileSync(filePath);
      if (path.resolve(filePath) === path.resolve(indexPath)) {
        body = Buffer.from(injectPreviewAssets(body.toString('utf8')));
      }
      response.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': body.length,
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });

  const httpAddress = await listen(server, httpPort);
  resolvedHttpPort = httpAddress.port;
  const url = `http://${HOST}:${resolvedHttpPort}/?tab=autopilot&port=${resolvedWsPort}&previewPanel=open`;
  if (openBrowser) openUrl(url);

  async function close() {
    if (closed) return;
    closed = true;
    if (apuReadyTimer) clearTimeout(apuReadyTimer);
    for (const timer of actionTimers) clearTimeout(timer);
    actionTimers.clear();
    await Promise.all([closeHttpServer(server), closeWsServer(wss)]);
  }

  return {
    url,
    wsUrl: `ws://${HOST}:${resolvedWsPort}`,
    httpPort: resolvedHttpPort,
    wsPort: resolvedWsPort,
    close,
    getState: publicState,
    setScenario,
    contracts,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  log('DEVELOPMENT FIXTURE ONLY - no simulator or PMDG commands are sent.');
  const runtime = await createPreviewRuntime({
    rootDir: ROOT,
    frontendRoot: DEFAULT_FRONTEND_ROOT,
    buildFrontend: options.buildFrontend,
    openBrowser: options.openBrowser,
    scenario: options.scenario,
    httpPort: options.httpPort,
    wsPort: options.wsPort,
  });
  log(`Preview: ${runtime.url}`);
  log(`Scenario: ${runtime.getState().label}`);
  log('Use the FIXTURE DATA panel to change states. Press Ctrl+C to stop.');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('Stopping preview...');
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[pmdg-737-preview] ERROR: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = {
  PROFILE,
  PROFILE_KEY,
  PROFILE_REVISION,
  SCENARIOS,
  applyFixtureAction,
  buildScenarioState,
  createPreviewRuntime,
  injectPreviewAssets,
  loadPmdgContracts,
  parseArgs,
  resolveNpmCliPath,
};
