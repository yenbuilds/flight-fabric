const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKEND_RUNTIME_ROOT = path.join(ROOT, 'dist', 'backend');

function resolveBackendPath(...segments) {
  return path.join(BACKEND_RUNTIME_ROOT, ...segments);
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function clearHandlerModules() {
  [
    resolveBackendPath('core', 'client-message-handler.js'),
    resolveBackendPath('core', 'user-settings.js'),
    resolveBackendPath('core', 'destination-target-store.js'),
    resolveBackendPath('core', 'config.js'),
    resolveBackendPath('utils', 'storage-paths.js'),
    resolveBackendPath('utils', 'flight-logs-dir.js'),
    resolveBackendPath('flight-recording', 'flight-csv-store.js'),
    resolveBackendPath('flight-recording', 'csv-read-guard.js'),
    resolveBackendPath('events', 'timeline-generator.js'),
    resolveBackendPath('history-index', 'history-index-store.js'),
    resolveBackendPath('history-index', 'source-identity.js'),
    resolveBackendPath('history-index', 'sqlite-runtime.js'),
    resolveBackendPath('history-index', 'sqlite-schema.js'),
    resolveBackendPath('history-index', 'timeline-flight-index.js'),
    resolveBackendPath('landing', 'flight-logbook.js'),
    resolveBackendPath('landing', 'landing.js'),
    resolveBackendPath('utils', 'csv.js'),
    resolveBackendPath('aircraft', 'aircraft-profile-loader.js'),
    resolveBackendPath('aircraft', 'aircraft-control-service.js'),
  ].forEach(clearModule);
}

async function withTempAppData(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-control-handler-'));
  const previous = {
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OneDrive: process.env.OneDrive,
    ONEDRIVE: process.env.ONEDRIVE,
    OneDriveConsumer: process.env.OneDriveConsumer,
    OneDriveCommercial: process.env.OneDriveCommercial,
    FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS,
  };

  process.env.APPDATA = path.join(tmpRoot, 'AppData', 'Roaming');
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  process.env.XDG_CONFIG_HOME = path.join(tmpRoot, '.config');
  process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = '1';
  delete process.env.OneDrive;
  delete process.env.ONEDRIVE;
  delete process.env.OneDriveConsumer;
  delete process.env.OneDriveCommercial;
  clearHandlerModules();

  try {
    await fn();
  } finally {
    if (previous.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous.APPDATA;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    if (previous.OneDrive === undefined) delete process.env.OneDrive; else process.env.OneDrive = previous.OneDrive;
    if (previous.ONEDRIVE === undefined) delete process.env.ONEDRIVE; else process.env.ONEDRIVE = previous.ONEDRIVE;
    if (previous.OneDriveConsumer === undefined) delete process.env.OneDriveConsumer; else process.env.OneDriveConsumer = previous.OneDriveConsumer;
    if (previous.OneDriveCommercial === undefined) delete process.env.OneDriveCommercial; else process.env.OneDriveCommercial = previous.OneDriveCommercial;
    if (previous.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS === undefined) delete process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS; else process.env.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS = previous.FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS;
    clearHandlerModules();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function buildWs(options: { privileged?: boolean; aircraftControl?: boolean } = {}) {
  const messages = [];
  return {
    messages,
    __ffPrivilegedClient: options.privileged === true,
    __ffAircraftControlClient: options.aircraftControl === true,
    send(payload) {
      messages.push(JSON.parse(payload));
    },
  };
}

function buildContext(provider, overrides = {}) {
  return {
    provider,
    broadcast() {},
    Debug: { log() {} },
    ...overrides,
  };
}

async function waitForHandlerHistoryIndex(handleClientMessage, context, timeoutMs = 5000) {
  const startedAt = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - startedAt) / 1_000_000 < timeoutMs) {
    const pollWs = buildWs({ privileged: true });
    await handleClientMessage(pollWs, { type: 'requestHistoryIndexStatus' }, context);
    const status = pollWs.messages[0]?.status;
    if (status && status.busy !== true) {
      assert.notEqual(status.phase, 'error', status.error || 'history index failed');
      assert.equal(status.failures, 0, JSON.stringify(status));
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('history index did not complete');
}

function buildFlightCsvWriter(filePath, overrides = {}) {
  return {
    isRecording() {
      return true;
    },
    getStats() {
      return {
        filePath,
        flightId: 'active-flight',
        rowCount: 1,
      };
    },
    async flush() {
      return true;
    },
    ...overrides,
  };
}

function writeTimelineListCsv(filePath, options: Record<string, any> = {}) {
  const sampleCount = options.sampleCount || 6;
  const startMs = Date.parse(options.startIso || '2026-05-25T00:00:00.000Z');
  const aircraft = options.aircraft || 'Handler Timeline Test';
  const rows = [
    'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase,aircraft,flight_id,fuel_total_gal',
  ];

  for (let index = 0; index < sampleCount; index += 1) {
    const ts = startMs + index * 1000;
    rows.push([
      'SAMPLE',
      new Date(ts).toISOString(),
      ts,
      (47.45 + index * 0.01).toFixed(5),
      (-122.31 + index * 0.01).toFixed(5),
      140 + index,
      -500 + index,
      1500 - index * 100,
      0,
      index < sampleCount - 1 ? 'APPROACH' : 'TAXI_IN',
      aircraft,
      options.flightId || path.basename(filePath, path.extname(filePath)),
      1000 - index * 5,
    ].join(','));
  }

  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
  const mtime = new Date(startMs + sampleCount * 1000);
  fs.utimesSync(filePath, mtime, mtime);
}

function createCanonicalCsvPath(logsDir: string, bundleName: string): string {
  const bundleDir = path.join(logsDir, bundleName);
  fs.mkdirSync(bundleDir, { recursive: true });
  return path.join(bundleDir, 'telemetry.csv');
}

function buildStableSimState() {
  return {
    type: 'simState',
    simconnectConnected: true,
    inMenu: false,
    lifecycleState: 'running',
  };
}

function buildProfileToken(profileLoader) {
  const profile = profileLoader.getActiveProfile();
  return {
    profileKey: profile?._profileKey || profile?._qualifiedId || profile?.id || 'generic',
    profileRevision: profileLoader.getActiveProfileRevision(),
  };
}

function setActiveBroadGenericControlProfile(profileLoader) {
  const profile = profileLoader.setActiveProfile('bundled/msfs/fbw-a32nx');
  assert.equal(profile?.integration?.controls?.standardSurfaceFallback, true);
  return profile;
}

function setActiveAircraftSpecificControlProfile(profileLoader) {
  const profile = profileLoader.setActiveProfile('bundled/msfs/fbw-a32nx');
  assert.equal(profile?.integration?.aircraftSpecific?.adapter, 'fbw-a32nx');
  return profile;
}

test('executeAircraftControl WebSocket message returns normalized success envelope', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    setActiveBroadGenericControlProfile(profileLoader);

    const calls = [];
    const provider = {
      async executeAircraftControlAction(action, context) {
        calls.push({ action, context });
        return { ok: true, backendSource: 'mock-provider' };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'req-1',
        ...buildProfileToken(profileLoader),
        control: 'gear',
        operation: 'down',
      },
      buildContext(provider, { lastSimState: buildStableSimState() })
    );

    assert.equal(calls.length, 1);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'aircraftControlResult');
    assert.equal(ws.messages[0].requestId, 'req-1');
    assert.equal(ws.messages[0].ok, true);
    assert.equal(ws.messages[0].resolvedBy, 'generic');
    assert.equal(ws.messages[0].backendSource, 'mock-provider');
    assert.equal(ws.messages[0].request.control, 'gear');
    assert.equal(ws.messages[0].action.name, 'GEAR_DOWN');
  });
});

test('executeAircraftControl WebSocket message blocks broad generic cockpit writes for a matched profile without opt-in', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    const profile = profileLoader.setActiveProfile('bundled/msfs/asobo-787');
    assert.equal(profile?.integration?.controls?.genericFallback, false);

    let called = false;
    const provider = {
      async executeAircraftControlAction() {
        called = true;
        return { ok: true };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'fail-closed-1',
        ...buildProfileToken(profileLoader),
        control: 'autopilot',
        target: 'heading',
        operation: 'set',
        value: 240,
      },
      buildContext(provider, { lastSimState: buildStableSimState() })
    );

    assert.equal(called, false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'aircraftControlResult');
    assert.equal(ws.messages[0].requestId, 'fail-closed-1');
    assert.equal(ws.messages[0].ok, false);
    assert.equal(ws.messages[0].code, 'unmapped_control');
  });
});

test('executeAircraftControl WebSocket message reports invalid payload without provider call', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    setActiveBroadGenericControlProfile(profileLoader);

    let called = false;
    const provider = {
      async executeAircraftControlAction() {
        called = true;
        return { ok: true };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'bad-1',
        ...buildProfileToken(profileLoader),
        control: 'aircraft-specific',
        operation: 'execute',
        actionId: 'systems.apuStart.start',
        value: {},
      },
      buildContext(provider, { lastSimState: buildStableSimState() })
    );

    assert.equal(called, false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'aircraftControlResult');
    assert.equal(ws.messages[0].requestId, 'bad-1');
    assert.equal(ws.messages[0].ok, false);
    assert.equal(ws.messages[0].code, 'invalid_request');
  });
});

test('executeAircraftControl WebSocket message resolves an aircraft-specific action ID through the guarded profile path', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    setActiveAircraftSpecificControlProfile(profileLoader);

    const calls = [];
    const provider = {
      getAircraftControlCapabilities() {
        return {
          simulator: 'msfs',
          actionTypes: ['aircraft-integration'],
          integrationTransports: ['lvar'],
        };
      },
      async executeAircraftControlAction(action, context) {
        calls.push({ action, context });
        return { ok: true, backendSource: 'mock-provider' };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'specific-1',
        ...buildProfileToken(profileLoader),
        control: 'aircraft-specific',
        operation: 'execute',
        actionId: 'systems.apuStart.start',
      },
      buildContext(provider, { lastSimState: buildStableSimState() }),
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].action, {
      type: 'aircraft-integration',
      name: 'fbw-a32nx',
      verification: 'untested',
    });
    assert.equal(ws.messages[0].ok, true);
    assert.equal(ws.messages[0].resolvedBy, 'profile');
    assert.equal(ws.messages[0].request.actionId, 'systems.apuStart.start');
  });
});

test('executeAircraftControl WebSocket message rejects stale profile tokens before provider call', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    setActiveBroadGenericControlProfile(profileLoader);

    let called = false;
    const provider = {
      async executeAircraftControlAction() {
        called = true;
        return { ok: true };
      },
    };
    const ws = buildWs({ privileged: true });
    const token = buildProfileToken(profileLoader);

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'stale-profile-1',
        ...token,
        profileRevision: token.profileRevision + 1,
        control: 'gear',
        operation: 'down',
      },
      buildContext(provider, { lastSimState: buildStableSimState() })
    );

    assert.equal(called, false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'aircraftControlResult');
    assert.equal(ws.messages[0].requestId, 'stale-profile-1');
    assert.equal(ws.messages[0].ok, false);
    assert.equal(ws.messages[0].code, 'stale_profile');
  });
});

test('executeAircraftControl WebSocket message rejects disconnected simulator state before provider call', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    setActiveBroadGenericControlProfile(profileLoader);

    let called = false;
    const provider = {
      async executeAircraftControlAction() {
        called = true;
        return { ok: true };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'sim-down-1',
        ...buildProfileToken(profileLoader),
        control: 'gear',
        operation: 'down',
      },
      buildContext(provider, {
        lastSimState: {
          type: 'simState',
          simconnectConnected: false,
          inMenu: false,
        },
      })
    );

    assert.equal(called, false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'aircraftControlResult');
    assert.equal(ws.messages[0].requestId, 'sim-down-1');
    assert.equal(ws.messages[0].ok, false);
    assert.equal(ws.messages[0].code, 'sim_disconnected');
  });
});

test('requestState replays reconnect snapshot messages', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const { PHASES } = require(resolveBackendPath('lifecycle', 'phases.js'));
    const ws = buildWs();
    const flightCsvWriter = buildFlightCsvWriter('active-flight.csv');

    await handleClientMessage(
      ws,
      { type: 'requestState' },
      buildContext(null, {
        lastSimState: { type: 'simState', inMenu: false },
        getPhase() {
          return PHASES.APPROACH;
        },
        flightCsvWriter,
      })
    );

    assert.deepEqual(
      ws.messages.map((message) => message.type),
      ['simState', 'phase', 'flightRecording', 'appSettings'],
    );
    assert.equal(ws.messages[2].status, 'recording');
    assert.equal(ws.messages[2].fileName, 'active-flight.csv');
  });
});

test('requestState replays latest live telemetry snapshot without duplicate lifecycle messages', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const { PHASES } = require(resolveBackendPath('lifecycle', 'phases.js'));
    const ws = buildWs();
    const flightCsvWriter = buildFlightCsvWriter('active-flight.csv');

    await handleClientMessage(
      ws,
      { type: 'requestState' },
      buildContext(null, {
        lastSimState: { type: 'simState', simconnectConnected: true, inMenu: false },
        replayMessages: [
          { type: 'simState', simconnectConnected: true, inMenu: false },
          { type: 'aircraftProfile', profile: { id: 'bundled/msfs/inibuilds-tristar', name: 'iniBuilds L-1011 TriStar' } },
          { type: 'phase', value: PHASES.CRUISE },
          { type: 'flightRecording', status: 'recording', fileName: 'stale.csv' },
          { type: 'altitude', msl: 17000, ra: 5200 },
        ],
        getPhase() {
          return PHASES.APPROACH;
        },
        flightCsvWriter,
      })
    );

    assert.deepEqual(
      ws.messages.map((message) => message.type),
      ['simState', 'aircraftProfile', 'altitude', 'phase', 'flightRecording', 'appSettings'],
    );
    assert.equal(ws.messages[1].profile.name, 'iniBuilds L-1011 TriStar');
    assert.equal(ws.messages[2].msl, 17000);
    assert.equal(ws.messages[3].value, PHASES.APPROACH);
    assert.equal(ws.messages[4].fileName, 'active-flight.csv');
  });
});

test('requestState clears stale recording indicators when no flight is recording', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const { PHASES } = require(resolveBackendPath('lifecycle', 'phases.js'));
    const ws = buildWs();
    const flightCsvWriter = buildFlightCsvWriter('', {
      isRecording() {
        return false;
      },
    });

    await handleClientMessage(
      ws,
      { type: 'requestState' },
      buildContext(null, {
        lastSimState: { type: 'simState', simconnectConnected: true, inMenu: false },
        getPhase() {
          return PHASES.PARKED;
        },
        flightCsvWriter,
      })
    );

    const recordingMessage = ws.messages.find((message) => message.type === 'flightRecording');
    assert.equal(recordingMessage?.status, 'stopped');
  });
});

test('endFlightManual waits for CSV finalization before reporting success', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });
    const csvPath = path.join(os.tmpdir(), 'manual-finalized-flight.csv');
    let endCall = null;
    let resolveFinalize;
    const broadcasts = [];
    const finalizePromise = new Promise((resolve) => {
      resolveFinalize = resolve;
    });

    const pending = handleClientMessage(
      ws,
      { type: 'endFlightManual' },
      buildContext(null, {
        flightActive: true,
        timeNow: () => 123456,
        flightCsvWriter: buildFlightCsvWriter(csvPath),
        broadcast(message) {
          broadcasts.push(message);
        },
        endFlight(nowEpochMs, reason) {
          endCall = { nowEpochMs, reason };
          return finalizePromise;
        },
      })
    );

    await Promise.resolve();
    assert.deepEqual(endCall, { nowEpochMs: 123456, reason: 'user_manual' });
    assert.equal(ws.messages.length, 0, 'success should wait until CSV finalization resolves');
    assert.deepEqual(broadcasts, [
      { type: 'flightRecording', status: 'finalizing' },
    ]);

    resolveFinalize({ filePath: csvPath, rowCount: 12345 });
    await pending;

    assert.equal(ws.messages.length, 1);
    assert.deepEqual(broadcasts, [
      { type: 'flightRecording', status: 'finalizing' },
      { type: 'flightRecording', status: 'stopped' },
    ]);
    assert.equal(ws.messages[0].type, 'endFlightResult');
    assert.equal(ws.messages[0].success, true);
    assert.equal(ws.messages[0].fileName, path.basename(csvPath));
    assert.equal(ws.messages[0].rowCount, 12345);
  });
});

test('startRecording delegates to manual flight start lifecycle action', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });
    const starts = [];

    await handleClientMessage(
      ws,
      { type: 'startRecording' },
      buildContext(null, {
        startFlightManual() {
          starts.push('start');
          return {
            success: true,
            reason: 'user_manual',
            flightId: 'manual-flight-id',
            fileName: 'manual-flight-id.csv',
          };
        },
      })
    );

    assert.deepEqual(starts, ['start']);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'startFlightResult');
    assert.equal(ws.messages[0].success, true);
    assert.equal(ws.messages[0].reason, 'user_manual');
    assert.equal(ws.messages[0].flightId, 'manual-flight-id');
    assert.equal(ws.messages[0].fileName, 'manual-flight-id.csv');
  });
});

test('startRecording rejects disconnected simulator state before lifecycle action', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });
    let called = false;

    await handleClientMessage(
      ws,
      { type: 'startRecording' },
      buildContext(null, {
        lastSimState: { type: 'simState', simconnectConnected: false, inMenu: false },
        startFlightManual() {
          called = true;
          return { success: true };
        },
      })
    );

    assert.equal(called, false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'startFlightResult');
    assert.equal(ws.messages[0].success, false);
    assert.equal(ws.messages[0].reason, 'user_manual');
    assert.equal(ws.messages[0].error, 'Simulator telemetry is not connected');
  });
});

test('startRecording requires a privileged client session', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs();
    let called = false;

    await handleClientMessage(
      ws,
      { type: 'startRecording' },
      buildContext(null, {
        startFlightManual() {
          called = true;
          return { success: true };
        },
      })
    );

    assert.equal(called, false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'startFlightResult');
    assert.equal(ws.messages[0].success, false);
    assert.match(ws.messages[0].error, /Privileged session required/);
  });
});

test('endFlightManual skips finalizing indicator when no CSV recording is active', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });
    const broadcasts = [];
    let endCall = null;

    await handleClientMessage(
      ws,
      { type: 'endFlightManual' },
      buildContext(null, {
        flightActive: true,
        timeNow: () => 654321,
        flightCsvWriter: {
          isRecording() {
            return false;
          },
        },
        broadcast(message) {
          broadcasts.push(message);
        },
        endFlight(nowEpochMs, reason) {
          endCall = { nowEpochMs, reason };
          return Promise.resolve(null);
        },
      })
    );

    assert.deepEqual(endCall, { nowEpochMs: 654321, reason: 'user_manual' });
    assert.deepEqual(broadcasts, [
      { type: 'flightRecording', status: 'stopped' },
    ]);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'endFlightResult');
    assert.equal(ws.messages[0].success, true);
    assert.equal(ws.messages[0].fileName, undefined);
    assert.equal(ws.messages[0].rowCount, undefined);
  });
});

test('endFlightManual broadcasts recording error when CSV finalization fails', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });
    const broadcasts = [];

    await handleClientMessage(
      ws,
      { type: 'endFlightManual' },
      buildContext(null, {
        flightActive: true,
        flightCsvWriter: buildFlightCsvWriter(path.join(os.tmpdir(), 'manual-failed-flight.csv')),
        broadcast(message) {
          broadcasts.push(message);
        },
        async endFlight() {
          throw new Error('writer failed');
        },
      })
    );

    assert.deepEqual(broadcasts, [
      { type: 'flightRecording', status: 'finalizing' },
      { type: 'flightRecording', status: 'error', error: 'Failed to end flight' },
    ]);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'endFlightResult');
    assert.equal(ws.messages[0].success, false);
    assert.equal(ws.messages[0].error, 'Failed to end flight');
  });
});

test('requestAppSettings redacts local paths from unprivileged websocket snapshots', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs();

    await handleClientMessage(
      ws,
      { type: 'requestAppSettings' },
      buildContext(null)
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettings');
    assert.equal(ws.messages[0].settingsFile, 'Stored locally in your Flight Fabric settings directory');
    assert.match(ws.messages[0].storage.settingsFile, /Stored locally/i);
    assert.doesNotMatch(ws.messages[0].storage.flightLogsDir, /AppData|Users|FlightLogs/);
  });
});

test('requestAppSettings exposes resolved storage paths to privileged websocket snapshots', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const storagePaths = require(resolveBackendPath('utils', 'storage-paths.js'));
    const flightLogsDir = require(resolveBackendPath('utils', 'flight-logs-dir.js'));
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      { type: 'requestAppSettings' },
      buildContext(null)
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettings');
    assert.equal(ws.messages[0].settingsFile, storagePaths.getSettingsFilePath());
    assert.equal(ws.messages[0].storage.appDataDir, storagePaths.getAppDataRoot());
    assert.equal(ws.messages[0].storage.settingsFile, storagePaths.getSettingsFilePath());
    assert.equal('aircraftProfilesDir' in ws.messages[0].storage, false);
    assert.match(ws.messages[0].storage.bundledAircraftProfilesDir, /backend[\\/]aircraft[\\/]profiles[\\/]bundled$/);
    assert.equal(ws.messages[0].storage.cabinAnnouncementAudioDir, storagePaths.getCabinAnnouncementAudioDir());
    assert.equal(ws.messages[0].storage.themesDir, storagePaths.getThemesDir());
    assert.equal(ws.messages[0].storage.logbookFile, storagePaths.getLogbookFilePath());
    assert.equal(ws.messages[0].storage.destinationTargetFile, storagePaths.getDestinationTargetFilePath());
    assert.equal(ws.messages[0].storage.originTargetFile, storagePaths.getOriginTargetFilePath());
    assert.equal(ws.messages[0].storage.flightLogsDir, flightLogsDir.resolveFlightLogsDir());
  });
});

test('executeAircraftCommand WebSocket message uses the same guarded provider path', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    setActiveBroadGenericControlProfile(profileLoader);

    const calls = [];
    const provider = {
      async executeAircraftControlAction(action, context) {
        calls.push({ action, context });
        return {
          ok: true,
          backendSource: 'mock-provider',
          type: 'forged-result',
          requestId: 'forged-request',
        };
      },
    };
    const ws = buildWs({ aircraftControl: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftCommand',
        requestId: 'command-1',
        ...buildProfileToken(profileLoader),
        commandId: 'surfaces.gear.set',
        input: { value: 'down' },
      },
      buildContext(provider, { lastSimState: buildStableSimState() }),
    );

    assert.equal(calls.length, 1);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'aircraftCommandResult');
    assert.equal(ws.messages[0].requestId, 'command-1');
    assert.equal(ws.messages[0].ok, true);
    assert.equal(ws.messages[0].commandId, 'surfaces.gear.set');
    assert.equal(ws.messages[0].controlRequest.control, 'gear');
    assert.equal(ws.messages[0].action.name, 'GEAR_DOWN');
  });
});

test('executeAircraftCommand WebSocket message rechecks live simulator state between preset writes', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    profileLoader.setActiveProfile('bundled/msfs/generic');

    let currentSimState = buildStableSimState();
    const calls = [];
    const provider = {
      aircraftControlCapabilities: { actionTypes: ['key-event'] },
      async executeAircraftControlAction(action) {
        calls.push(action.name);
        if (calls.length === 1) {
          currentSimState = {
            ...currentSimState,
            simconnectConnected: false,
          };
        }
        return { ok: true, backendSource: 'mock-provider' };
      },
    };
    const ws = buildWs({ aircraftControl: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftCommand',
        requestId: 'live-state-preset',
        ...buildProfileToken(profileLoader),
        commandId: 'configuration.lights.takeoff',
        input: {},
      },
      buildContext(provider, {
        lastSimState: buildStableSimState(),
        getSimState: () => currentSimState,
      }),
    );

    assert.deepEqual(calls, ['LANDING_LIGHTS_SET']);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].ok, false);
    assert.equal(ws.messages[0].code, 'sim_disconnected');
    assert.equal(ws.messages[0].completedStepCount, 1);
    assert.equal(ws.messages[0].failedStepIndex, 1);
  });
});

test('aircraft control WebSocket messages serialize a preset against concurrent direct writes', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    profileLoader.setActiveProfile('bundled/msfs/generic');

    let markFirstStarted = () => {};
    let releaseFirst = () => {};
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls = [];
    const provider = {
      aircraftControlCapabilities: { actionTypes: ['key-event'] },
      async executeAircraftControlAction(action) {
        calls.push(`${action.name}=${String(action.value)}`);
        if (calls.length === 1) {
          markFirstStarted();
          await firstGate;
        }
        return { ok: true, backendSource: 'mock-provider' };
      },
    };
    const simState = buildStableSimState();
    const context = buildContext(provider, {
      lastSimState: simState,
      getSimState: () => simState,
    });
    const commandWs = buildWs({ aircraftControl: true });
    const controlWs = buildWs({ aircraftControl: true });
    const token = buildProfileToken(profileLoader);

    const commandPromise = handleClientMessage(
      commandWs,
      {
        type: 'executeAircraftCommand',
        requestId: 'serialized-preset',
        ...token,
        commandId: 'configuration.lights.takeoff',
        input: {},
      },
      context,
    );
    await firstStarted;

    const controlPromise = handleClientMessage(
      controlWs,
      {
        type: 'executeAircraftControl',
        requestId: 'serialized-direct',
        ...token,
        control: 'lights',
        target: 'landing',
        operation: 'set',
        value: false,
      },
      context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['LANDING_LIGHTS_SET=true']);

    releaseFirst();
    await Promise.all([commandPromise, controlPromise]);

    assert.deepEqual(calls, [
      'LANDING_LIGHTS_SET=true',
      'TAXI_LIGHTS_SET=true',
      'STROBES_SET=true',
      'LANDING_LIGHTS_SET=false',
    ]);
    assert.equal(commandWs.messages[0].ok, true);
    assert.equal(commandWs.messages[0].completedStepCount, 3);
    assert.equal(controlWs.messages[0].ok, true);
  });
});

test('requestAppSettings exposes effective cabin environment overrides to the frontend', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs();

    await handleClientMessage(
      ws,
      { type: 'requestAppSettings' },
      buildContext(null, {
        getCabinAnnouncementsConfig() {
          return {
            enabled: true,
            style: 'environment-pack',
            startupGraceMs: 2_500,
          };
        },
      })
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettings');
    assert.deepEqual(ws.messages[0].settings.cabinAnnouncements, {
      enabled: true,
      style: 'environment-pack',
      startupGraceMs: 2_500,
    });
  });
});

test('saveAppSettings ignores retired user debug settings', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'saveAppSettings',
        settings: {
          advanced: {
            debugMode: true,
          },
        },
      },
      buildContext(null)
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettingsSaved');
    assert.equal(ws.messages[0].ok, true);
    assert.equal(Object.hasOwn(ws.messages[0].settings, 'advanced'), false);
    assert.equal(ws.messages[0].restartRequired, false);
    assert.deepEqual(ws.messages[0].restartReasons, []);
  });
});

test('saveAppSettings reports recording auto-start changes as restart-required', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'saveAppSettings',
        settings: {
          recording: {
            autoStart: false,
          },
        },
      },
      buildContext(null)
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettingsSaved');
    assert.equal(ws.messages[0].ok, true);
    assert.equal(ws.messages[0].settings.recording.autoStart, false);
    assert.equal(ws.messages[0].restartRequired, true);
    assert.deepEqual(ws.messages[0].restartReasons, ['Automatic recording']);
  });
});

test('saveAppSettings ignores retired poll-rate changes', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'saveAppSettings',
        settings: {
          performance: {
            pollRateMs: 50,
          },
        },
      },
      buildContext(null)
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettingsSaved');
    assert.equal(ws.messages[0].ok, true);
    assert.equal(Object.hasOwn(ws.messages[0].settings, 'performance'), false);
    assert.equal(ws.messages[0].restartRequired, false);
    assert.deepEqual(ws.messages[0].restartReasons, []);
  });
});

test('saveAppSettings applies cabin announcement changes live without requiring restart', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });
    const appliedSettings = [];

    await handleClientMessage(
      ws,
      {
        type: 'saveAppSettings',
        settings: {
          cabinAnnouncements: {
            enabled: true,
            style: 'concise',
            startupGraceMs: 7_500,
          },
        },
      },
      buildContext(null, {
        reconfigureCabinAnnouncements(settings) {
          appliedSettings.push(settings);
        },
      })
    );

    assert.equal(appliedSettings.length, 1);
    assert.deepEqual(appliedSettings[0].cabinAnnouncements, {
      enabled: true,
      style: 'concise',
      startupGraceMs: 7_500,
    });
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettingsSaved');
    assert.equal(ws.messages[0].ok, true);
    assert.equal(ws.messages[0].restartRequired, false);
    assert.deepEqual(ws.messages[0].restartReasons, []);
  });
});

test('saveAppSettings requests restart when live cabin announcement reconfiguration fails', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'saveAppSettings',
        settings: {
          cabinAnnouncements: {
            enabled: true,
            style: 'standard',
            startupGraceMs: 5_000,
          },
        },
      },
      buildContext(null, {
        reconfigureCabinAnnouncements() {
          throw new Error('fixture reconfiguration failure');
        },
      })
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'appSettingsSaved');
    assert.equal(ws.messages[0].ok, true, 'settings were persisted before live apply failed');
    assert.equal(ws.messages[0].restartRequired, true);
    assert.deepEqual(ws.messages[0].restartReasons, ['Cabin announcements']);
  });
});

test('requestTimelineList flushes the active CSV before listing flights', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    let flushed = false;
    const activeCsvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_active');
    const flightCsvWriter = buildFlightCsvWriter(activeCsvPath, {
      async flush() {
        flushed = true;
        return true;
      },
    });
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      { type: 'requestTimelineList' },
      buildContext(null, { flightCsvWriter })
    );

    assert.equal(flushed, true);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'timelineList');
    assert.equal(Object.prototype.hasOwnProperty.call(ws.messages[0], 'index'), false);
  });
});

test('requestTimelineList can opt into SQLite indexed paging', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    writeTimelineListCsv(createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_alpha'), {
      aircraft: 'Handler Alpha',
      flightId: 'alpha',
      startIso: '2026-05-25T00:00:00.000Z',
    });
    writeTimelineListCsv(createCanonicalCsvPath(logsDir, '2026-05-26T00-00-00_bravo'), {
      aircraft: 'Handler Bravo',
      flightId: 'bravo',
      startIso: '2026-05-26T00:00:00.000Z',
    });

    const ws = buildWs({ privileged: true });
    const context = buildContext(null);

    await handleClientMessage(
      ws,
      { type: 'requestTimelineList', useHistoryIndex: true, limit: 1, requestId: 42 },
      context
    );

    assert.equal(ws.messages[0].index.status.busy, true);
    await waitForHandlerHistoryIndex(handleClientMessage, context);
    ws.messages.length = 0;
    await handleClientMessage(
      ws,
      { type: 'requestTimelineList', useHistoryIndex: true, limit: 1, requestId: 42 },
      context
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'timelineList');
    assert.equal(ws.messages[0].requestId, 42);
    assert.equal(ws.messages[0].index.used, true, ws.messages[0].index.error || 'expected SQLite index to be used');
    assert.equal(ws.messages[0].index.totalMatching, 2);
    assert.equal(ws.messages[0].index.limit, 1);
    assert.equal(ws.messages[0].flights.length, 1);
    assert.equal(ws.messages[0].flights[0].flightId, '2026-05-26T00-00-00');
    assert.equal(ws.messages[0].flights[0].aircraft, 'Handler Bravo');
  });
});

test('requestTimelineList indexed opt-in keeps completed flights visible without flushing the active CSV', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    let flushed = false;
    const activeCsvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_active');
    writeTimelineListCsv(createCanonicalCsvPath(logsDir, '2026-05-24T00-00-00_completed'), {
      aircraft: 'Completed Flight',
      flightId: 'completed',
      startIso: '2026-05-24T00:00:00.000Z',
    });
    const flightCsvWriter = buildFlightCsvWriter(activeCsvPath, {
      async flush() {
        flushed = true;
        return false;
      },
    });
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      { type: 'requestTimelineList', useHistoryIndex: true, requestId: 43 },
      buildContext(null, { flightCsvWriter })
    );

    assert.equal(flushed, false, 'indexed Recent Flights must not wait on the live recording');
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'timelineList');
    assert.equal(ws.messages[0].requestId, 43);
    assert.equal(ws.messages[0].flights.length, 1);
    assert.equal(ws.messages[0].flights[0].aircraft, 'Completed Flight');
    assert.equal(ws.messages[0].index.used, false);
    assert.equal(ws.messages[0].index.fallback, 'completed_bundle_snapshot');
    assert.equal(ws.messages[0].index.stale, true);
    assert.equal(ws.messages[0].index.staleReason, 'Active flight CSV is not ready yet');
  });
});

test('requestTimelineList uses the runtime-owned flight store when one is provided', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const ws = buildWs({ privileged: true });
    let indexedCalls = 0;
    const flightCsvStore = {
      async listFlightsIndexed() {
        indexedCalls += 1;
        return {
          success: true,
          flights: [{ flightId: 'runtime-store' }],
          storage: { flightCount: 1 },
          index: { used: true, status: { phase: 'complete' } },
        };
      },
    };

    await handleClientMessage(
      ws,
      { type: 'requestTimelineList', useHistoryIndex: true },
      buildContext(null, { flightCsvStore }),
    );

    assert.equal(indexedCalls, 1);
    assert.equal(ws.messages[0].flights[0].flightId, 'runtime-store');
    assert.equal(ws.messages[0].index.used, true);
  });
});

test('requestTimelineList fails closed when active CSV flush fails', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    let flushed = false;
    const activeCsvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_active');
    const flightCsvWriter = buildFlightCsvWriter(activeCsvPath, {
      async flush() {
        flushed = true;
        return false;
      },
    });
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      { type: 'requestTimelineList' },
      buildContext(null, { flightCsvWriter })
    );

    assert.equal(flushed, true);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'timelineListError');
    assert.equal(ws.messages[0].error, 'Active flight CSV is not ready yet');
  });
});

test('requestTimeline flushes the active CSV before generating a timeline', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_active');
    fs.writeFileSync(
      activeCsvPath,
      [
        'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase',
        'SAMPLE,2026-05-25T00:00:00.000Z,1779638400000,47.45,-122.31,140,-500,1000,0,APPROACH',
        'SAMPLE,2026-05-25T00:00:01.000Z,1779638401000,47.46,-122.30,135,-450,900,0,APPROACH',
      ].join('\n') + '\n'
    );

    let flushed = false;
    const flightCsvWriter = buildFlightCsvWriter(activeCsvPath, {
      async flush() {
        flushed = true;
        return true;
      },
    });
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      { type: 'requestTimeline', filePath: activeCsvPath },
      buildContext(null, { flightCsvWriter })
    );

    assert.equal(flushed, true);
    assert.equal(ws.messages.length, 1);
    assert.match(ws.messages[0].type, /^timeline(Error)?$/);
  });
});

test('requestTimeline propagates and echoes the read-only full-analysis preview contract', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const calls: Array<Record<string, any>> = [];
    const flightCsvStore = {
      async generateTimelineFromFile(filePath, options) {
        calls.push({ filePath, options });
        return {
          success: true,
          timeline: {
            filePath: 'C:/Flight Logs/canonical/telemetry.csv',
            analysisRescore: { mode: 'current-preview', scope: 'full-landing-analysis' },
            events: [],
          },
        };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'requestTimeline',
        filePath: 'historic.csv',
        scoringMode: 'current-preview',
        requestId: 'landing-preview-1',
      },
      buildContext(null, { flightCsvStore }),
    );

    assert.deepEqual(calls, [{
      filePath: 'historic.csv',
      options: { requestId: 'landing-preview-1', scoringMode: 'current-preview' },
    }]);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'timeline');
    assert.equal(ws.messages[0].requestId, 'landing-preview-1');
    assert.equal(ws.messages[0].scoringMode, 'current-preview');
    assert.equal(ws.messages[0].timeline.filePath, 'C:/Flight Logs/canonical/telemetry.csv');
    assert.equal(ws.messages[0].timeline.analysisRescore.mode, 'current-preview');
  });
});

test('requestTimeline preview errors echo correlation fields and reject non-exact modes', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    let receivedOptions: Record<string, any> | null = null;
    const flightCsvStore = {
      async generateTimelineForFlightId(_flightId, options) {
        receivedOptions = options;
        return { success: false, error: 'Preview unavailable' };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'requestTimeline',
        flightId: 'historic-flight',
        scoringMode: 'CURRENT-PREVIEW',
        requestId: 42,
      },
      buildContext(null, { flightCsvStore }),
    );

    assert.deepEqual(receivedOptions, { requestId: 42, scoringMode: 'recorded' });
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'timelineError');
    assert.equal(ws.messages[0].requestId, 42);
    assert.equal(ws.messages[0].scoringMode, 'recorded');
    assert.equal(ws.messages[0].error, 'Preview unavailable');
  });
});

test('full flight-analysis rescore apply and revert use the guarded flight store contract', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const calls: Array<Record<string, any>> = [];
    const previewFingerprint = 'a'.repeat(64);
    const sourceFingerprint = 'b'.repeat(64);
    const contractFingerprint = 'c'.repeat(64);
    const snapshotFingerprint = 'd'.repeat(64);
    const flightCsvStore = {
      async applyFlightAnalysisRescore(request) {
        calls.push({ action: 'apply', request });
        return { success: true, revision: 1, appliedAt: '2026-08-09T00:00:00.000Z', snapshotFingerprint };
      },
      revertFlightAnalysisRescore(request) {
        calls.push({ action: 'revert', request });
        return { success: true, reverted: true, revision: 1, snapshotFingerprint };
      },
    };
    const ws = buildWs({ privileged: true });

    await handleClientMessage(ws, {
      type: 'applyFlightAnalysisRescore',
      filePath: 'historic.csv',
      flightId: 'historic-flight',
      requestId: 'apply-1',
      baseRevision: 0,
      previewFingerprint,
      sourceFingerprint,
      analysisContractFingerprint: contractFingerprint,
    }, buildContext(null, { flightCsvStore }));
    await handleClientMessage(ws, {
      type: 'revertFlightAnalysisRescore',
      filePath: 'historic.csv',
      flightId: 'historic-flight',
      requestId: 'revert-1',
      expectedRevision: 1,
      expectedSnapshotFingerprint: snapshotFingerprint,
    }, buildContext(null, { flightCsvStore }));

    assert.deepEqual(calls, [
      {
        action: 'apply',
        request: {
          filePath: 'historic.csv',
          flightId: 'historic-flight',
          expectedRevision: 0,
          expectedSourceFingerprint: sourceFingerprint,
          expectedPreviewFingerprint: previewFingerprint,
          expectedAnalysisContractFingerprint: contractFingerprint,
        },
      },
      {
        action: 'revert',
        request: {
          filePath: 'historic.csv',
          flightId: 'historic-flight',
          expectedRevision: 1,
          expectedSnapshotFingerprint: snapshotFingerprint,
        },
      },
    ]);
    assert.deepEqual(ws.messages, [
      {
        type: 'flightAnalysisRescoreResult',
        requestId: 'apply-1',
        action: 'apply',
        success: true,
        revision: 1,
        appliedAt: '2026-08-09T00:00:00.000Z',
        snapshotFingerprint,
      },
      {
        type: 'flightAnalysisRescoreResult',
        requestId: 'revert-1',
        action: 'revert',
        success: true,
        revision: 1,
        snapshotFingerprint,
        reverted: true,
      },
    ]);
  });
});

test('full flight-analysis rescore requires a privileged session and always replies', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    let called = false;
    const ws = buildWs();
    await handleClientMessage(ws, {
      type: 'applyFlightAnalysisRescore',
      filePath: 'private.csv',
      requestId: 'denied-1',
    }, buildContext(null, {
      flightCsvStore: {
        async applyFlightAnalysisRescore() {
          called = true;
          return { success: true };
        },
      },
    }));

    assert.equal(called, false);
    assert.deepEqual(ws.messages, [{
      type: 'flightAnalysisRescoreResult',
      requestId: 'denied-1',
      action: 'apply',
      success: false,
      error: 'Privileged session required for this action.',
    }]);
  });
});

test('requestTimeline refuses to read active CSV if the writer flush fails', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_active');
    fs.writeFileSync(
      activeCsvPath,
      [
        'record_type,timestamp_utc,ts,lat_deg,lon_deg,ias_kts,vs_fpm,ra_ft,on_ground,phase',
        'SAMPLE,2026-05-25T00:00:00.000Z,1779638400000,47.45,-122.31,140,-500,1000,0,APPROACH',
      ].join('\n') + '\n'
    );

    const flightCsvWriter = buildFlightCsvWriter(activeCsvPath, {
      async flush() {
        return false;
      },
    });
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      { type: 'requestTimeline', filePath: activeCsvPath },
      buildContext(null, { flightCsvWriter })
    );

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'timelineError');
    assert.equal(ws.messages[0].error, 'Active flight CSV is not ready yet');
  });
});

test('deleteFlightCsv refuses to delete the active recording path', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_active');
    fs.writeFileSync(activeCsvPath, 'record_type,timestamp_utc\nSAMPLE,2026-05-25T00:00:00.000Z\n');

    const flightCsvWriter = buildFlightCsvWriter(activeCsvPath);
    const ws = buildWs({ privileged: true });

    const requestedPath = process.platform === 'win32' ? activeCsvPath.toUpperCase() : activeCsvPath;

    await handleClientMessage(
      ws,
      { type: 'deleteFlightCsv', filePath: requestedPath, requestId: 'del-active' },
      buildContext(null, { flightCsvWriter })
    );

    assert.equal(fs.existsSync(activeCsvPath), true);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'deleteFlightCsvResult');
    assert.equal(ws.messages[0].requestId, 'del-active');
    assert.equal(ws.messages[0].success, false);
    assert.equal(ws.messages[0].error, 'Cannot delete an active or finalizing recording');
  });
});

test('deleteFlightCsv confirms deletion without rebuilding the full timeline list', async () => {
  await withTempAppData(async () => {
    const flightLogsDirPath = resolveBackendPath('utils', 'flight-logs-dir.js');
    const logsDir = path.join(process.env.USERPROFILE, 'Documents', 'Flight Fabric', 'Flight Logs');
    (require.cache as any)[flightLogsDirPath] = {
      id: flightLogsDirPath,
      filename: flightLogsDirPath,
      loaded: true,
      exports: {
        resolveFlightLogsDir(options: { createIfMissing?: boolean } = {}) {
          if (options.createIfMissing) fs.mkdirSync(logsDir, { recursive: true });
          return logsDir;
        },
        getFlightLogsStorageInfo() {
          const exists = fs.existsSync(logsDir);
          const files = exists ? fs.readdirSync(logsDir).filter((name) => name.toLowerCase().endsWith('.csv')) : [];
          return {
            dir: logsDir,
            exists,
            fileCount: files.length,
            totalBytes: files.reduce((sum, name) => sum + fs.statSync(path.join(logsDir, name)).size, 0),
          };
        },
      },
    };

    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-01-00_delete-me');
    fs.writeFileSync(
      csvPath,
      [
        'record_type,flight_id,flight_start_iso,recording_session_id,timestamp_utc,ts,lat_deg,lon_deg',
        'SAMPLE,delete-flight,2026-05-25T00:00:00.000Z,delete-session,2026-05-25T00:00:00.000Z,1779638400000,47.45,-122.31',
        'SAMPLE,delete-flight,2026-05-25T00:00:00.000Z,delete-session,2026-05-25T00:00:01.000Z,1779638401000,47.46,-122.30',
        'SAMPLE,delete-flight,2026-05-25T00:00:00.000Z,delete-session,2026-05-25T00:00:02.000Z,1779638402000,47.47,-122.29',
        'SAMPLE,delete-flight,2026-05-25T00:00:00.000Z,delete-session,2026-05-25T00:00:03.000Z,1779638403000,47.48,-122.28',
        'SAMPLE,delete-flight,2026-05-25T00:00:00.000Z,delete-session,2026-05-25T00:00:04.000Z,1779638404000,47.49,-122.27',
      ].join('\n') + '\n'
    );
    const csvStat = fs.statSync(csvPath);

    timelineGenerator.listCSVFlights = () => {
      throw new Error('listCSVFlights should not run after a successful delete');
    };

    const broadcasts = [];
    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'deleteFlightCsv',
        filePath: csvPath,
        requestId: 'del-fast',
        mtimeMs: csvStat.mtimeMs,
        sizeBytes: csvStat.size,
      },
      buildContext(null, {
        broadcast(message) {
          broadcasts.push(message);
        },
      })
    );

    assert.equal(fs.existsSync(csvPath), false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'deleteFlightCsvResult');
    assert.equal(ws.messages[0].requestId, 'del-fast');
    assert.equal(ws.messages[0].success, true);
    assert.equal(ws.messages[0].storage.fileCount, 0);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'deleteFlightCsvResult');
    assert.equal(broadcasts[0].success, true);
  });
});

test('deleteFlightCsv refuses when listed file metadata is stale', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const timelineGenerator = require(resolveBackendPath('events', 'timeline-generator.js'));
    const logsDir = timelineGenerator.getFlightLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const csvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-02-00_changed');
    fs.writeFileSync(csvPath, 'record_type,timestamp_utc\n');
    const listedStat = fs.statSync(csvPath);
    fs.writeFileSync(csvPath, 'record_type,timestamp_utc\nSAMPLE,2026-05-25T00:00:00.000Z\n');

    const ws = buildWs({ privileged: true });

    await handleClientMessage(
      ws,
      {
        type: 'deleteFlightCsv',
        filePath: csvPath,
        requestId: 'del-stale',
        mtimeMs: listedStat.mtimeMs,
        sizeBytes: listedStat.size,
      },
      buildContext(null)
    );

    assert.equal(fs.existsSync(csvPath), true);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'deleteFlightCsvResult');
    assert.equal(ws.messages[0].requestId, 'del-stale');
    assert.equal(ws.messages[0].success, false);
    assert.equal(ws.messages[0].error, 'Flight log changed on disk. Refresh the list and try again.');
  });
});

test('privileged websocket actions are denied without the session token', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    let called = false;
    const provider = {
      async executeAircraftControlAction() {
        called = true;
        return { ok: true };
      },
    };
    const ws = buildWs();

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'auth-1',
        control: 'autopilot',
        target: 'heading',
        operation: 'set',
        value: 240,
      },
      buildContext(provider)
    );

    assert.equal(called, false);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'aircraftControlResult');
    assert.equal(ws.messages[0].requestId, 'auth-1');
    assert.equal(ws.messages[0].ok, false);
    assert.equal(ws.messages[0].code, 'auth_required');
    assert.match(ws.messages[0].error, /trusted-LAN aircraft control permission/);
  });
});

test('trusted-LAN aircraft-control scope permits controls but not other privileged actions', async () => {
  await withTempAppData(async () => {
    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const profileLoader = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    setActiveBroadGenericControlProfile(profileLoader);

    let called = false;
    const provider = {
      async executeAircraftControlAction() {
        called = true;
        return { ok: true };
      },
    };
    const ws = buildWs({ aircraftControl: true });

    await handleClientMessage(
      ws,
      {
        type: 'executeAircraftControl',
        requestId: 'lan-control-1',
        ...buildProfileToken(profileLoader),
        control: 'gear',
        operation: 'down',
      },
      buildContext(provider, { lastSimState: buildStableSimState() })
    );

    assert.equal(called, true);
    assert.equal(ws.messages[0].type, 'aircraftControlResult');
    assert.equal(ws.messages[0].ok, true);

    await handleClientMessage(
      ws,
      { type: 'saveAppSettings', settings: { network: { remoteAccess: true } } },
      buildContext(provider)
    );

    assert.equal(ws.messages[1].type, 'appSettingsSaved');
    assert.equal(ws.messages[1].ok, false);
    assert.match(ws.messages[1].error, /Privileged session required/);
  });
});

test('Trusted-LAN client-message authorization is deny-by-default across all three tiers', () => {
  const {
    AIRCRAFT_CONTROL_MESSAGE_TYPES,
    PRIVILEGED_CLIENT_MESSAGE_TYPES,
    TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES,
    isClientMessageAuthorized,
  } = require(resolveBackendPath('core', 'client-message-authorization.js'));

  assert.deepEqual([...TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES], [
    'requestState',
    'requestAppSettings',
    'getRecordingState',
    'getFlightStatus',
    'requestAirportLookup',
    'requestDestinationTarget',
    'requestOriginTarget',
  ]);

  const unpaired = buildWs();
  const aircraftControl = buildWs({ aircraftControl: true });
  const privileged = buildWs({ privileged: true });

  for (const messageType of TRUSTED_LAN_SAFE_READ_MESSAGE_TYPES) {
    assert.equal(isClientMessageAuthorized(unpaired, messageType), true, `${messageType}: unpaired`);
    assert.equal(isClientMessageAuthorized(aircraftControl, messageType), true, `${messageType}: paired`);
    assert.equal(isClientMessageAuthorized(privileged, messageType), true, `${messageType}: privileged`);
  }

  const protectedTypes = [
    'saveAppSettings',
    'fuelUnit',
    'showBranding',
    'flightPlan',
    'startRecording',
    'stopRecording',
    'endFlightManual',
    'requestTimeline',
    'applyFlightAnalysisRescore',
    'revertFlightAnalysisRescore',
    'requestTimelineList',
    'deleteFlightCsv',
    'setDestinationTarget',
    'clearDestinationTarget',
    'setOriginTarget',
    'clearOriginTarget',
    'exportProfile',
    'listProfiles',
    'requestLogbook',
    'requestHistoryIndexStatus',
    'checkHistoryIndex',
    'rebuildHistoryIndex',
    'lvarDebugWatch',
    'testShake',
    'futureCommandNotYetClassified',
  ];
  assert.deepEqual(
    [...AIRCRAFT_CONTROL_MESSAGE_TYPES],
    ['executeAircraftCommand', 'executeAircraftControl'],
  );
  assert.deepEqual(
    [...PRIVILEGED_CLIENT_MESSAGE_TYPES],
    protectedTypes.filter((messageType) => messageType !== 'futureCommandNotYetClassified'),
  );
  for (const messageType of protectedTypes) {
    assert.equal(isClientMessageAuthorized(unpaired, messageType), false, `${messageType}: unpaired`);
    assert.equal(isClientMessageAuthorized(aircraftControl, messageType), false, `${messageType}: paired`);
    assert.equal(
      isClientMessageAuthorized(privileged, messageType),
      messageType !== 'futureCommandNotYetClassified',
      `${messageType}: privileged`,
    );
  }

  assert.equal(isClientMessageAuthorized(unpaired, 'executeAircraftControl'), false);
  assert.equal(isClientMessageAuthorized(aircraftControl, 'executeAircraftControl'), true);
  assert.equal(isClientMessageAuthorized(privileged, 'executeAircraftControl'), true);
  assert.equal(isClientMessageAuthorized(unpaired, 'executeAircraftCommand'), false);
  assert.equal(isClientMessageAuthorized(aircraftControl, 'executeAircraftCommand'), true);
  assert.equal(isClientMessageAuthorized(privileged, 'executeAircraftCommand'), true);
  for (const retiredType of ['importProfile', 'copyProfileToLocal', 'deleteUserProfile']) {
    assert.equal(isClientMessageAuthorized(privileged, retiredType), false, `${retiredType}: retired`);
  }
  assert.equal(isClientMessageAuthorized(privileged, null), false);
});

test('unpaired and aircraft-control clients cannot read private data or mutate relayed state', async () => {
  await withTempAppData(async () => {
    const profileLoader: any = require(resolveBackendPath('aircraft', 'aircraft-profile-loader.js'));
    const originalListProfiles = profileLoader.listProfiles;
    const originalExportProfile = profileLoader.exportProfile;
    let profileReadCalls = 0;
    profileLoader.listProfiles = () => {
      profileReadCalls += 1;
      return [{ id: 'should-not-be-read' }];
    };
    profileLoader.exportProfile = () => {
      profileReadCalls += 1;
      return { ok: true, profile: { id: 'should-not-be-read' }, filename: 'private.json' };
    };

    try {
      const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));

      for (const ws of [buildWs(), buildWs({ aircraftControl: true })]) {
        let historyReadCalls = 0;
        const broadcasts = [];
        const context = buildContext(null, {
          broadcast(message) {
            broadcasts.push(message);
          },
          flightCsvStore: {
            async getLogbook() {
              historyReadCalls += 1;
              return { success: true, entries: [{ flightId: 'private' }], stats: {} };
            },
            getHistoryIndexStatus() {
              historyReadCalls += 1;
              return { phase: 'ready' };
            },
          },
        });

        for (const message of [
          { type: 'requestLogbook' },
          { type: 'requestHistoryIndexStatus' },
          { type: 'listProfiles' },
          { type: 'exportProfile', id: 'local/msfs/private' },
          { type: 'fuelUnit', unit: 'kg' },
          { type: 'showBranding', show: false },
          { type: 'flightPlan', username: 'private-user', origin: 'YSSY', destination: 'YMML' },
          { type: 'stopRecording' },
        ]) {
          await handleClientMessage(ws, message, context);
        }

        assert.equal(historyReadCalls, 0);
        assert.deepEqual(broadcasts, []);
        assert.equal(ws.messages.some((message) => message.type === 'logbook'), false);
        assert.equal(ws.messages.some((message) => message.type === 'profileList'), false);
        assert.equal(ws.messages.some((message) => message.type === 'profileExported'), false);
        assert.equal(
          ws.messages.some((message) => ['fuelUnit', 'showBranding', 'flightPlan', 'recordingState'].includes(message.type)),
          false,
        );
      }

      assert.equal(profileReadCalls, 0);
    } finally {
      profileLoader.listProfiles = originalListProfiles;
      profileLoader.exportProfile = originalExportProfile;
    }
  });
});

test('simbridge special client-message handlers remain behind the shared authorization gate', () => {
  const source = fs.readFileSync(path.join(ROOT, 'backend', 'core', 'simbridge-core.ts'), 'utf8');
  const dispatchStart = source.indexOf('onClientMessage: async (ws, msg) => {');
  const authorizationGate = source.indexOf(
    'if (!isClientMessageAuthorized(ws, msg?.type)) {',
    dispatchStart,
  );

  assert.ok(dispatchStart >= 0);
  assert.ok(authorizationGate > dispatchStart);
  for (const specialType of ['lvarDebugWatch', 'testShake']) {
    const specialHandler = source.indexOf(`if (msg.type === '${specialType}')`, dispatchStart);
    assert.ok(
      specialHandler > authorizationGate,
      `${specialType} must dispatch only after the shared authorization gate`,
    );
  }
});

test('requestLogbook flushes active CSV and bypasses cached active file data', async () => {
  await withTempAppData(async () => {
    const flightLogsDirPath = resolveBackendPath('utils', 'flight-logs-dir.js');
    const logsDir = path.join(process.env.USERPROFILE, 'Documents', 'Flight Fabric', 'Flight Logs');
    (require.cache as any)[flightLogsDirPath] = {
      id: flightLogsDirPath,
      filename: flightLogsDirPath,
      loaded: true,
      exports: {
        resolveFlightLogsDir(options: { createIfMissing?: boolean } = {}) {
          if (options.createIfMissing) fs.mkdirSync(logsDir, { recursive: true });
          return logsDir;
        },
        getFlightLogsStorageInfo() {
          const exists = fs.existsSync(logsDir);
          const files = exists ? fs.readdirSync(logsDir).filter((name) => name.toLowerCase().endsWith('.csv')) : [];
          return {
            dir: logsDir,
            exists,
            fileCount: files.length,
            totalBytes: files.reduce((sum, name) => sum + fs.statSync(path.join(logsDir, name)).size, 0),
          };
        },
      },
    };

    const { handleClientMessage } = require(resolveBackendPath('core', 'client-message-handler.js'));
    const { getLandingsFromCSVs } = require(resolveBackendPath('landing', 'flight-logbook.js'));
    fs.mkdirSync(logsDir, { recursive: true });
    const activeCsvPath = createCanonicalCsvPath(logsDir, '2026-05-25T00-00-00_active');
    const header = 'record_type,timestamp_utc,ts,vs_fpm,ias_kts,g_force,icao,runway,aircraft';
    fs.writeFileSync(
      activeCsvPath,
      [
        header,
        'SAMPLE,2026-05-25T00:00:00.000Z,1779638400000,-500,140,1.2,YSSY,34L,Cache Test',
      ].join('\n') + '\n'
    );
    const fixedMtime = new Date('2026-05-25T00:00:10.000Z');
    fs.utimesSync(activeCsvPath, fixedMtime, fixedMtime);

    const cachedEntries = await getLandingsFromCSVs();
    assert.equal(cachedEntries.length, 0);

    fs.writeFileSync(
      activeCsvPath,
      [
        header,
        'SAMPLE,2026-05-25T00:00:00.000Z,1779638400000,-500,140,1.2,YSSY,34L,Cache Test',
        'LANDING,2026-05-25T00:01:00.000Z,1779638460000,-420,132,1.35,YSSY,34L,Cache Test',
      ].join('\n') + '\n'
    );
    fs.utimesSync(activeCsvPath, fixedMtime, fixedMtime);

    let flushed = false;
    const flightCsvWriter = buildFlightCsvWriter(activeCsvPath, {
      async flush() {
        flushed = true;
        return true;
      },
    });
    const ws = buildWs({ privileged: true });
    const context = buildContext(null, { flightCsvWriter });

    await handleClientMessage(
      ws,
      { type: 'requestLogbook' },
      context
    );

    assert.equal(ws.messages[0].index.status.busy, true);
    await waitForHandlerHistoryIndex(handleClientMessage, context);
    ws.messages.length = 0;
    await handleClientMessage(
      ws,
      { type: 'requestLogbook' },
      context
    );

    assert.equal(flushed, true);
    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'logbook');
    assert.equal(ws.messages[0].entries.length, 1);
    assert.equal(ws.messages[0].entries[0].icao, 'YSSY');
    assert.equal(ws.messages[0].stats.total, 1);
  });
});

export {};
