#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_DIST = path.join(ROOT, 'frontend-dist');
const ELECTRON_APP_DIR = path.join(ROOT, 'scripts', 'browser-smoke-app');
const ELECTRON_MODULE_PATH = path.join(ROOT, 'electron', 'node_modules', 'electron');
const ELECTRON_SMOKE_TIMEOUT_MS = 30000;
const ELECTRON_PARENT_TIMEOUT_MS = ELECTRON_SMOKE_TIMEOUT_MS + 15000;
const headerOnly = process.env.FF_BROWSER_SMOKE_HEADER_ONLY === '1';
const sharedSettings = require(path.join(ROOT, 'shared', 'app-settings-shared.js'));

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

const FIXTURE_AIRPORTS = Object.freeze({
  KPHL: { icao: 'KPHL', name: 'Philadelphia Intl', lat: 39.8744, lon: -75.2424 },
  KBOS: { icao: 'KBOS', name: 'Boston Logan Intl', lat: 42.3656, lon: -71.0096 },
  KJFK: { icao: 'KJFK', name: 'John F Kennedy Intl', lat: 40.6413, lon: -73.7781 },
});

const FIXTURE_POSITION = Object.freeze({
  lat: FIXTURE_AIRPORTS.KPHL.lat,
  lon: FIXTURE_AIRPORTS.KPHL.lon,
  hdg: 54,
});

function log(message) {
  console.log(`[browser-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSettingsPatch(current, patch) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    const currentValue = merged[key];
    if (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && currentValue !== null
      && typeof currentValue === 'object'
      && !Array.isArray(currentValue)
    ) {
      merged[key] = mergeSettingsPatch(currentValue, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function ensureBuiltFrontend() {
  if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
    return;
  }

  log('frontend-dist is missing; building the frontend bundle first');
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['run', 'frontend:build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail('frontend build failed before browser smoke could start');
  }
}

function resolveElectronBinary() {
  if (!fs.existsSync(ELECTRON_MODULE_PATH)) {
    fail('Electron dependency is missing; run npm install in the electron folder first');
  }
  if (!fs.existsSync(path.join(ELECTRON_APP_DIR, 'package.json'))) {
    fail(`Electron smoke app is missing at ${ELECTRON_APP_DIR}`);
  }
  return require(ELECTRON_MODULE_PATH);
}

function buildElectronNodePath() {
  const electronNodeModules = path.join(ROOT, 'electron', 'node_modules');
  const existingNodePath = process.env.NODE_PATH;
  if (!existingNodePath) return electronNodeModules;
  return `${electronNodeModules}${path.delimiter}${existingNodePath}`;
}

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createStaticFrontendServer(rootDir, { bootstrapPayload = null } = {}) {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/bootstrap' && bootstrapPayload) {
      const body = Buffer.from(JSON.stringify(bootstrapPayload));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }

    let relativePath = decodeURIComponent(requestUrl.pathname || '/');
    if (relativePath === '/' || relativePath === '/remote' || relativePath === '/remote.html') {
      relativePath = '/index.html';
    }

    const candidatePath = path.resolve(rootDir, `.${relativePath}`);
    const resolvedRoot = path.resolve(rootDir);
    if (!candidatePath.startsWith(`${resolvedRoot}${path.sep}`) && candidatePath !== resolvedRoot) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }

    let filePath = candidatePath;
    try {
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    try {
      const body = fs.readFileSync(filePath);
      response.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Failed to read asset: ${error.message}`);
    }
  });
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function buildFixtureSettings() {
  return sharedSettings.normalizeAppSettings({
    aircraft: { profile: 'auto' },
    cabinAnnouncements: {
      enabled: true,
      style: 'standard',
      startupGraceMs: 5000,
    },
  }, {
    defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
  });
}

function buildFixtureControlCapabilities(configurationId, profileKey, profileRevision = null) {
  return {
    aircraftCommands: {
      configurationId,
      profileKey,
      profileRevision,
      commands: [
        {
          id: 'configuration.lighting.cockpit',
          label: 'Cockpit lighting',
          group: 'presets',
          kind: 'preset',
          description: 'Set panel and display dimmers to one brightness.',
          input: { kind: 'number', min: 0, max: 100, step: 1, units: 'percent' },
          speech: {
            patterns: ['set cockpit lighting {value}'],
            hints: ['COCKPIT LIGHTING'],
          },
        },
        {
          id: 'configuration.lights.takeoff',
          label: 'Takeoff lights',
          group: 'presets',
          kind: 'preset',
          description: 'Runway turnoffs ON · Taxi ON · Strobe ON',
          input: { kind: 'none' },
          speech: {
            patterns: ['set lights for takeoff'],
            hints: ['TAKEOFF LIGHTS'],
          },
        },
        {
          id: 'configuration.lights.cruise',
          label: 'Cruise lighting',
          group: 'presets',
          kind: 'preset',
          description: 'Logo ON · Cabin signs AUTO',
          input: { kind: 'none' },
          speech: {
            patterns: ['set lights for cruise'],
            hints: ['CRUISE LIGHTS'],
          },
        },
      ],
    },
  };
}

function buildFixtureFlights() {
  return [
    {
      flightId: 'fixture-flight-001',
      filePath: 'fixture-flight-001.csv',
      route: 'KPHL -> KBOS',
      aircraft: 'Fenix A320',
      timestamp: '2026-05-24T10:15:00.000Z',
      durationMs: 5400000,
      durationFormatted: '1h 30m',
      fuelBurnGal: 812.4,
      eventCount: 42,
      sizeBytes: 24576,
    },
  ];
}

function buildFixtureTimeline() {
  const startedAtMs = Date.parse('2026-05-24T10:15:00.000Z');
  return {
    flightId: 'fixture-flight-001',
    route: 'KPHL -> KBOS',
    durationMs: 5400000,
    durationFormatted: '1h 30m',
    fuelBurnGal: 812.4,
    eventCount: 4,
    worstMoment: { index: 2 },
    track: [
      {
        lat: 39.8744,
        lon: -75.2424,
        timestampMs: startedAtMs,
        hdgTrueDeg: 42,
        iasKts: 0,
        altFt: 36,
      },
      {
        lat: 40.3501,
        lon: -74.5002,
        timestampMs: startedAtMs + 1800000,
        hdgTrueDeg: 43,
        iasKts: 289,
        altFt: 28000,
      },
      {
        lat: 41.3308,
        lon: -72.8363,
        timestampMs: startedAtMs + 4200000,
        hdgTrueDeg: 47,
        iasKts: 232,
        altFt: 9800,
      },
      {
        lat: 42.3656,
        lon: -71.0096,
        timestampMs: startedAtMs + 5400000,
        hdgTrueDeg: 44,
        iasKts: 134,
        altFt: 18,
      },
    ],
    events: [
      {
        id: 'evt-phase-1',
        type: 'phase_start',
        timestampMs: startedAtMs,
        newPhase: 'TAKEOFF',
        previousPhase: 'PARKED',
      },
      {
        id: 'evt-score-1',
        type: 'score_change',
        timestampMs: startedAtMs + 2100000,
        reason: 'Smooth climb',
        scoreDelta: 4,
      },
      {
        id: 'evt-violation-1',
        type: 'violation_start',
        timestampMs: startedAtMs + 4680000,
        ruleId: 'FAST_APPROACH',
        severity: 'warning',
        context: {
          note: 'Approach speed remained above target.',
          ias_kts: 179,
          target_ias_kts: 160,
          lat: 42.1405,
          lon: -71.454,
          heading: 46,
        },
      },
      {
        id: 'evt-landing-1',
        type: 'landing',
        timestampMs: startedAtMs + 5400000,
        lat: 42.3656,
        lon: -71.0096,
        ias_kts: 134,
        vs_fpm: -182,
        grade: 'PERFECT',
        pitch_deg: 2.1,
        hdg_true_deg: 44,
        wind_dir_deg: 240,
        wind_speed_kts: 14,
        xwind_kts: -8,
        runway: {
          airport_icao: 'KBOS',
          runway_id: '27',
          length_ft: 10083,
        },
        touchdownDistance: {
          distanceFt: 600,
          grade: 'Outstanding',
          zone: 'within zone',
          score: 96,
          lateralOffsetFt: 12,
          lateralOffsetSide: 'left',
          lateralOffsetGrade: 'Good',
          bounceCount: 1,
          bounceGrade: 'Single Bounce',
        },
        ultimateStability: {
          verdict: 'marginal',
          score: 84,
          samples: 24,
          gateStable: false,
          gateFailures: ['speed_proxy_unstable_after_gate'],
        },
      },
    ],
  };
}

function createFixtureState() {
  return {
    appSettings: buildFixtureSettings(),
    flights: buildFixtureFlights(),
    timeline: buildFixtureTimeline(),
    liveMapPosition: { ...FIXTURE_POSITION },
    destinationTarget: null,
    originTarget: null,
    storage: {
      appDataDir: 'C:/Fixture/AppData/Roaming/Flight Fabric',
      settingsFile: 'C:/Fixture/AppData/Roaming/Flight Fabric/Settings/settings.json',
      bundledAircraftProfilesDir: 'C:/Fixture/App/resources/backend/aircraft/profiles/bundled',
      cabinAnnouncementAudioDir: 'C:/Fixture/AppData/Roaming/Flight Fabric/Audio/Cabin',
      themesDir: 'C:/Fixture/AppData/Roaming/Flight Fabric/Themes',
      flightLogsDir: 'C:/Fixture/AppData/Roaming/Flight Fabric/FlightLogs',
      flightLogsExists: true,
      flightLogsFileCount: 3,
      flightLogsTotalBytes: 8192,
      logbookFile: 'C:/Fixture/AppData/Roaming/Flight Fabric/FlightLogs/logbook.json',
      originTargetFile: 'C:/Fixture/AppData/Roaming/Flight Fabric/Targets/origin.json',
      destinationTargetFile: 'C:/Fixture/AppData/Roaming/Flight Fabric/Targets/destination.json',
    },
    messages: [],
    savedSettings: null,
    profiles: [
      {
        id: 'asobo-a320neo',
        name: 'Asobo A320neo',
        namespace: 'bundled',
        simulator: 'msfs',
        qualifiedId: 'bundled/msfs/asobo-a320neo',
      },
      {
        id: 'pmdg-777',
        name: 'PMDG 777',
        namespace: 'bundled',
        simulator: 'msfs',
        qualifiedId: 'bundled/msfs/pmdg-777',
      },
      {
        id: 'fenix-a320',
        name: 'Fenix A320',
        namespace: 'bundled',
        simulator: 'msfs',
        qualifiedId: 'bundled/msfs/fenix-a320',
      },
      {
        id: 'fbw-a32nx',
        name: 'FlyByWire A32NX',
        namespace: 'bundled',
        simulator: 'msfs',
        qualifiedId: 'bundled/msfs/fbw-a32nx',
      },
      {
        id: 'fbw-a380x',
        name: 'FlyByWire A380X',
        namespace: 'bundled',
        simulator: 'msfs',
        qualifiedId: 'bundled/msfs/fbw-a380x',
      },
    ],
    airportLookupRequests: [],
  };
}

function createFixtureBackend() {
  const state = createFixtureState();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });

  function sendJson(ws, payload) {
    ws.send(JSON.stringify(payload));
  }

  function broadcastJson(payload) {
    const body = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(body);
      }
    }
  }

  const liveMapPulse = setInterval(() => {
    broadcastJson({
      type: 'position',
      lat: state.liveMapPosition.lat,
      lon: state.liveMapPosition.lon,
      hdg: state.liveMapPosition.hdg,
    });
    broadcastJson({
      type: 'heading',
      true: state.liveMapPosition.hdg,
      mag: state.liveMapPosition.hdg,
    });
  }, 450);

  function disconnectAllClients() {
    for (const client of wss.clients) {
      try {
        client.close(1012, 'Fixture reconnect test');
      } catch {}
    }
  }

  function sendAppSettings(ws) {
    sendJson(ws, {
      type: 'appSettings',
      settings: state.appSettings,
      settingsFile: state.storage.settingsFile,
      storage: state.storage,
      backendVersion: '0.1.3',
    });
  }

  function handleMessage(ws, message) {
    state.messages.push(message);

    switch (message.type) {
      case 'requestState':
        sendJson(ws, {
          type: 'simState',
          simconnectConnected: true,
          inMenu: false,
        });
        sendJson(ws, {
          type: 'aircraftProfile',
          profile: {
            id: 'generic',
            name: 'Generic Aircraft',
            namespace: 'bundled',
            simulator: 'msfs',
            _profileKey: 'bundled/msfs/generic',
          },
          controlCapabilities: buildFixtureControlCapabilities(
            'generic',
            'bundled/msfs/generic',
          ),
        });
        sendAppSettings(ws);
        sendJson(ws, {
          type: 'position',
          lat: state.liveMapPosition.lat,
          lon: state.liveMapPosition.lon,
          hdg: state.liveMapPosition.hdg,
        });
        sendJson(ws, {
          type: 'heading',
          true: state.liveMapPosition.hdg,
          mag: state.liveMapPosition.hdg,
        });
        break;

      case 'requestAppSettings':
        sendAppSettings(ws);
        break;

      case 'saveAppSettings':
        state.savedSettings = message.settings;
        state.appSettings = sharedSettings.normalizeAppSettings(mergeSettingsPatch(
          state.appSettings,
          sharedSettings.sanitizeAppSettingsPatch(message.settings, {
            defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
          }),
        ), {
          defaults: sharedSettings.APP_SETTINGS_DEFAULTS,
        });
        sendJson(ws, {
          type: 'appSettingsSaved',
          ok: true,
          settings: state.appSettings,
          settingsFile: state.storage.settingsFile,
          storage: state.storage,
          restartRequired: false,
          restartReasons: [],
        });
        const selectedAircraft = {
          auto: { id: 'generic', name: 'Generic Aircraft', profileKey: 'bundled/msfs/generic' },
          'bundled/msfs/pmdg-777': { id: 'pmdg-777', name: 'PMDG 777', profileKey: 'bundled/msfs/pmdg-777', templateId: 'pmdg-777' },
          'bundled/msfs/fenix-a320': { id: 'fenix-a320', name: 'Fenix A320', profileKey: 'bundled/msfs/fenix-a320', templateId: 'fenix-a32x' },
          'bundled/msfs/fbw-a32nx': { id: 'fbw-a32nx', name: 'FlyByWire A32NX', profileKey: 'bundled/msfs/fbw-a32nx', templateId: 'fbw-a32nx' },
          'bundled/msfs/fbw-a380x': { id: 'fbw-a380x', name: 'FlyByWire A380X', profileKey: 'bundled/msfs/fbw-a380x', templateId: 'fbw-a380x' },
        }[state.appSettings.aircraft?.profile];
        if (selectedAircraft) {
          sendJson(ws, {
            type: 'aircraftProfile',
            profile: {
              id: selectedAircraft.id,
              name: selectedAircraft.name,
              namespace: 'bundled',
              simulator: 'msfs',
              _profileKey: selectedAircraft.profileKey,
              profileRevision: 1,
              aircraftSpecificTemplateId: selectedAircraft.templateId,
            },
            controlCapabilities: buildFixtureControlCapabilities(
              selectedAircraft.id,
              selectedAircraft.profileKey,
              1,
            ),
          });
        }
        break;

      case 'requestLogbook':
        sendJson(ws, {
          type: 'logbook',
          entries: [],
          stats: {
            total: 0,
            grades: {},
            avgVsFpm: null,
            bestVsFpm: null,
            airports: 0,
            aircraft: 0,
          },
        });
        break;

      case 'requestTimelineList':
        sendJson(ws, {
          type: 'timelineList',
          flights: state.flights,
          storage: {
            dir: state.storage.flightLogsDir,
            exists: state.storage.flightLogsExists,
            fileCount: state.storage.flightLogsFileCount,
            totalBytes: state.storage.flightLogsTotalBytes,
          },
        });
        break;

      case 'requestDestinationTarget':
        sendJson(ws, {
          type: 'destinationTarget',
          target: state.destinationTarget,
        });
        break;

      case 'requestOriginTarget':
        sendJson(ws, {
          type: 'originTarget',
          target: state.originTarget,
        });
        break;

      case 'requestTimeline': {
        sendJson(ws, {
          type: 'timeline',
          requestId: message.requestId ?? null,
          scoringMode: message.scoringMode === 'current-preview' ? 'current-preview' : 'recorded',
          timeline: state.timeline,
        });
        break;
      }

      case 'requestAirportLookup': {
        const icao = String(message.icao || '').trim().toUpperCase();
        state.airportLookupRequests.push({
          icao,
          requestId: message.requestId || null,
        });
        const airport = FIXTURE_AIRPORTS[icao];
        if (!airport) {
          sendJson(ws, {
            type: 'airportLookupResult',
            success: false,
            requestId: message.requestId || null,
            icao,
            error: `Unknown fixture airport: ${icao || '--'}`,
          });
          break;
        }
        sendJson(ws, {
          type: 'airportLookupResult',
          success: true,
          requestId: message.requestId || null,
          icao: airport.icao,
          name: airport.name,
          lat: airport.lat,
          lon: airport.lon,
        });
        break;
      }

      case 'setDestinationTarget':
        state.destinationTarget = message.target || null;
        break;

      case 'clearDestinationTarget':
        state.destinationTarget = null;
        sendJson(ws, {
          type: 'destinationTarget',
          target: null,
        });
        break;

      case 'setOriginTarget':
        state.originTarget = message.target || null;
        break;

      case 'clearOriginTarget':
        state.originTarget = null;
        sendJson(ws, {
          type: 'originTarget',
          target: null,
        });
        break;

      case 'listProfiles':
        sendJson(ws, {
          type: 'profileList',
          profiles: state.profiles,
        });
        break;

      case 'showBranding':
      case 'fuelUnit':
        break;

      default:
        log(`ignoring unhandled fixture message: ${message.type}`);
        break;
    }
  }

  wss.on('connection', (ws) => {
    sendJson(ws, {
      type: 'authorizationScope',
      scope: 'full-control',
    });
    ws.on('message', (buffer) => {
      try {
        const parsed = JSON.parse(buffer.toString('utf8'));
        handleMessage(ws, parsed);
      } catch (error) {
        log(`failed to parse fixture message: ${error.message}`);
      }
    });
  });

  return {
    state,
    wss,
    disconnectAllClients,
    stop() {
      clearInterval(liveMapPulse);
    },
  };
}

function closeWebSocketServer(wss) {
  return new Promise((resolve, reject) => {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {}
    }
    wss.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function removeDirectoryBestEffort(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (error) {
    log(`warning: failed to remove temporary directory ${dir}: ${error.message}`);
  }
}

async function spawnElectronRunner({ electronBinary, url, userDataDir, onDisconnectRequested = () => {} }) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      FF_BROWSER_SMOKE_URL: url,
      FF_BROWSER_SMOKE_TIMEOUT: String(ELECTRON_SMOKE_TIMEOUT_MS),
      FF_BROWSER_SMOKE_USER_DATA: userDataDir,
      NODE_PATH: buildElectronNodePath(),
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const child = spawn(electronBinary, [ELECTRON_APP_DIR], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutId = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    timeoutId = setTimeout(() => {
      const error = new Error(
        `Electron smoke runner timed out after ${ELECTRON_PARENT_TIMEOUT_MS}ms`,
      );
      error.stdout = stdout;
      error.stderr = stderr;
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      finish(error);
    }, ELECTRON_PARENT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
      if (text.includes('[smoke-control] disconnect-now')) {
        onDisconnectRequested();
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      finish(new Error(`Electron smoke runner exited with code=${code} signal=${signal || 'none'}`));
    });
  });
}

async function main() {
  ensureBuiltFrontend();
  const electronBinary = resolveElectronBinary();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-browser-smoke-'));

  const fixtureBackend = createFixtureBackend();
  await new Promise((resolve) => {
    if (fixtureBackend.wss.address()) {
      resolve();
      return;
    }
    fixtureBackend.wss.once('listening', resolve);
  });
  const wsAddress = fixtureBackend.wss.address();
  const browserBootstrap = {
    wsAuthToken: 'browser-smoke-full-control',
    aircraftControlToken: 'browser-smoke-aircraft-control',
    remoteAccessEnabled: true,
    networkInfo: {
      ips: ['192.168.50.49'],
      httpPort: null,
      wsPort: wsAddress.port,
    },
  };
  const frontendServer = createStaticFrontendServer(FRONTEND_DIST, {
    bootstrapPayload: browserBootstrap,
  });
  const frontendAddress = await listen(frontendServer, { host: '127.0.0.1', port: 0 });
  browserBootstrap.networkInfo.httpPort = frontendAddress.port;
  const appUrl = `http://127.0.0.1:${frontendAddress.port}/?port=${wsAddress.port}`;

  log(`serving browser smoke frontend from ${appUrl}`);

  try {
    await spawnElectronRunner({
      electronBinary,
      url: appUrl,
      userDataDir,
      onDisconnectRequested: () => fixtureBackend.disconnectAllClients(),
    });

    if (headerOnly) {
      return;
    }

    assert.ok(
      fixtureBackend.state.messages.some((message) => message.type === 'requestState'),
      'browser smoke should request initial state from the backend fixture',
    );
    assert.ok(
      fixtureBackend.state.messages.some((message) => message.type === 'listProfiles'),
      'browser smoke should request bundled profile choices after full-control acknowledgement',
    );
    assert.ok(
      fixtureBackend.state.messages.filter((message) => message.type === 'listProfiles').length >= 2,
      'browser smoke should refresh bundled profile choices after reconnect authorization',
    );
    assert.ok(
      fixtureBackend.state.messages.some((message) => (
        message.type === 'saveAppSettings'
        && message.settings?.aircraft?.profile === 'bundled/msfs/pmdg-777'
      )),
      'browser smoke should persist the selected bundled profile through the privileged settings path',
    );
    assert.ok(
      fixtureBackend.state.messages.filter((message) => message.type === 'requestState').length >= 2,
      'reconnect smoke should re-request initial state after the socket reconnects',
    );
    assert.equal(
      fixtureBackend.state.appSettings?.network?.updateChecks,
      true,
      'settings smoke flow should keep update checks enabled by default',
    );
    assert.equal(
      fixtureBackend.state.appSettings?.network?.onlineMapTiles,
      true,
      'settings smoke flow should keep online map tiles enabled by default',
    );
    assert.equal(
      fixtureBackend.state.appSettings?.aircraft?.profile,
      'bundled/msfs/pmdg-777',
      'later settings saves should preserve the selected bundled profile',
    );
    assert.equal(
      fixtureBackend.state.destinationTarget,
      null,
      'live-map smoke should clear the destination target again after setting it',
    );
    assert.equal(
      fixtureBackend.state.originTarget?.icao,
      'KPHL',
      'live-map smoke should persist the origin target to the backend fixture',
    );
    assert.deepEqual(
      fixtureBackend.state.airportLookupRequests.map((request) => request.icao),
      ['KBOS', 'KPHL'],
      'live-map smoke should perform airport lookups for both destination and origin',
    );
    assert.ok(
      fixtureBackend.state.messages.some((message) => message.type === 'requestTimeline'),
      'timeline smoke should request a concrete timeline payload',
    );
    assert.ok(
      fixtureBackend.state.messages.filter((message) => message.type === 'requestOriginTarget').length >= 2,
      'reconnect smoke should resync the shared origin target after reconnect',
    );
    assert.ok(
      fixtureBackend.state.messages.filter((message) => message.type === 'requestDestinationTarget').length >= 2,
      'reconnect smoke should resync the shared destination target after reconnect',
    );

    log('browser smoke test passed');
  } finally {
    fixtureBackend.stop?.();
    await closeServer(frontendServer).catch(() => {});
    await closeWebSocketServer(fixtureBackend.wss).catch(() => {});
    removeDirectoryBestEffort(userDataDir);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
