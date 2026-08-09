const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');

const {
  createWsServer,
  isPrivateOrLoopbackRemoteAddress,
} = require('./ws-bootstrap') as typeof import('./ws-bootstrap');
const { createBroadcast } = require('./ws-broadcaster') as typeof import('./ws-broadcaster');
const {
  UNPAIRED_PASSTHROUGH_SERVER_MESSAGE_TYPES,
  UNPAIRED_PROJECTED_SERVER_MESSAGE_TYPES,
  UNPAIRED_SUPPRESSED_SERVER_MESSAGE_TYPES,
  projectSerializedServerMessageForClient,
  projectServerMessageForClient,
} = require('./server-message-projection') as typeof import('./server-message-projection');
const { MSG } = require('./message-types');

async function closeServer(wss: {
  close: (cb?: (error?: Error) => void) => void;
}) {
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('aircraft-control pairing accepts only private or loopback peer addresses', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.50.4', 'fd12::4']) {
    assert.equal(isPrivateOrLoopbackRemoteAddress(address), true, `${address} should be accepted`);
  }
  for (const address of ['', '8.8.8.8', '172.15.1.1', '172.32.1.1', '192.0.2.4', '2001:4860:4860::8888', 'fc00.attacker.example']) {
    assert.equal(isPrivateOrLoopbackRemoteAddress(address), false, `${address || '(empty)'} should be rejected`);
  }
});

test('every server message type has one explicit unpaired-client policy', () => {
  const groups = [
    UNPAIRED_PASSTHROUGH_SERVER_MESSAGE_TYPES,
    UNPAIRED_PROJECTED_SERVER_MESSAGE_TYPES,
    UNPAIRED_SUPPRESSED_SERVER_MESSAGE_TYPES,
  ];
  const classified = groups.flat();
  assert.equal(
    new Set(classified).size,
    classified.length,
    'server message classifications must not overlap',
  );
  assert.deepEqual(
    [...new Set(classified)].sort(),
    [...new Set(Object.values(MSG) as string[])].sort(),
    'new MSG values must fail this test until their unpaired-client policy is reviewed',
  );
});

test('outbound projection keeps privileged payloads intact and sanitizes Trusted-LAN payloads', () => {
  const profileMessage = {
    type: 'aircraftProfile',
    profile: {
      id: 'fixture',
      name: 'Fixture Aircraft',
      aircraftTitle: 'C:\\Users\\pilot\\AppData\\Local\\Packages\\aircraft.cfg',
      aircraftConfigPath: 'C:\\Users\\pilot\\AppData\\Local\\Packages\\aircraft.cfg',
    },
    previousTitle: '/home/pilot/aircraft.cfg',
    previousDisplayName: 'Previous Aircraft',
    previousAircraftConfigPath: '/home/pilot/aircraft.cfg',
  };

  assert.equal(
    projectServerMessageForClient({ __ffPrivilegedClient: true }, profileMessage),
    profileMessage,
  );

  const projectedProfile = projectServerMessageForClient({}, profileMessage);
  assert.equal(projectedProfile?.profile.aircraftConfigPath, undefined);
  assert.equal(projectedProfile?.profile.aircraftTitle, 'Fixture Aircraft');
  assert.equal(projectedProfile?.previousAircraftConfigPath, undefined);
  assert.equal(projectedProfile?.previousTitle, 'Previous Aircraft');

  const projectedSources = projectServerMessageForClient({}, {
    type: 'dataSources',
    primary: {
      type: 'rust-simvars',
      name: 'SimVars',
      connected: false,
      status: 'error',
      error: 'Could not load C:\\private\\SimConnect.dll',
      librarySpec: 'C:\\private\\SimConnect.dll',
      description: 'Error - DLL: C:\\private\\SimConnect.dll',
      liveValueCount: 0,
      preview: [{
        key: 'fixture',
        value: 1,
        live: true,
        sourcePath: 'C:\\private\\profile.json',
      }],
    },
    secondary: [],
  });
  assert.deepEqual(projectedSources, {
    type: 'dataSources',
    primary: {
      type: 'rust-simvars',
      name: 'SimVars',
      connected: false,
      status: 'error',
      liveValueCount: 0,
      preview: [{
        key: 'fixture',
        value: 1,
        live: true,
      }],
    },
    secondary: [],
    sources: [{
      type: 'rust-simvars',
      name: 'SimVars',
      connected: false,
      status: 'error',
      liveValueCount: 0,
      preview: [{
        key: 'fixture',
        value: 1,
        live: true,
      }],
    }],
  });

  assert.deepEqual(
    projectServerMessageForClient({}, {
      type: 'flightPlan',
      username: 'private-dispatch-user',
      origin: 'YSSY',
      destination: 'YMML',
    }),
    {
      type: 'flightPlan',
      origin: 'YSSY',
      destination: 'YMML',
    },
  );
  assert.equal(projectServerMessageForClient({}, { type: 'debug', entry: { data: 'private' } }), null);
  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'deleteFlightCsvResult',
    success: true,
    filePath: 'C:\\private\\flight.csv',
    storage: { dir: 'C:\\private' },
  }), {
    type: 'deleteFlightCsvResult',
    requestId: null,
    success: true,
    error: null,
  });
  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'flightAnalysisRescoreResult',
    requestId: 41,
    action: 'apply',
    success: false,
    landingKey: '42',
    error: 'Privileged session required for this action.',
    leaked: 'C:\\private',
  }), {
    type: 'flightAnalysisRescoreResult',
    requestId: 41,
    action: 'apply',
    success: false,
    error: 'Privileged session required for this action.',
  });
  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'timelineError',
    requestId: 42,
    scoringMode: 'current-preview',
    filePath: 'C:\\private\\flight.csv',
    leaked: 'C:\\private',
    error: 'Privileged session required for this action.',
  }), {
    type: 'timelineError',
    requestId: 42,
    scoringMode: 'current-preview',
    error: 'Privileged session required for this action.',
  });
  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'timelineError',
    requestId: 'C:\\private\\request.csv',
    scoringMode: 'CURRENT-PREVIEW',
    error: 'Privileged session required for this action.',
  }), {
    type: 'timelineError',
    requestId: null,
    scoringMode: 'recorded',
    error: 'Privileged session required for this action.',
  });
  assert.equal(projectSerializedServerMessageForClient({}, 'not-json'), null);
  assert.equal(
    projectServerMessageForClient({}, { type: 'futureUnreviewedMessage', path: 'C:\\private' }),
    null,
  );
  assert.equal(projectServerMessageForClient({}, {
    type: 'logbook',
    entries: [{ aircraft: 'private' }],
  }), null);
});

test('outbound projection scrubs relative simulator identities and lifecycle reasons', () => {
  const msfsPath = 'SimObjects\\Airplanes\\FNX_32X\\aircraft.cfg';
  const xplanePath = 'Aircraft/Laminar Research/B737-800X/B738.acf';

  const projectedProfile = projectServerMessageForClient({}, {
    type: 'aircraftProfile',
    profile: {
      id: 'fnx-a320',
      name: 'Fenix A320',
      aircraftTitle: msfsPath,
      aircraftConfigPath: msfsPath,
    },
    provenance: {
      verificationStatus: 'verified',
      knownIssues: [`Loaded from ${msfsPath}`],
    },
  });
  assert.equal(projectedProfile?.profile.aircraftTitle, 'Fenix A320');
  assert.equal(projectedProfile?.profile.aircraftConfigPath, undefined);
  assert.equal(projectedProfile?.provenance.knownIssues, undefined);

  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'aircraftChanged',
    newTitle: xplanePath,
    displayName: 'Boeing 737-800',
    previousTitle: msfsPath,
    previousDisplayName: 'Fenix A320',
  }), {
    type: 'aircraftChanged',
    newTitle: 'Boeing 737-800',
    previousTitle: 'Fenix A320',
    displayName: 'Boeing 737-800',
    previousDisplayName: 'Fenix A320',
  });

  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'flightStatus',
    active: true,
    flightId: 'flight-1',
    aircraftTitle: msfsPath,
    recording: true,
  }), {
    type: 'flightStatus',
    aircraftTitle: null,
    active: true,
    flightId: 'flight-1',
    recording: true,
  });

  const projectedSummary = projectServerMessageForClient({}, {
    type: 'flightSummary',
    aircraft: xplanePath,
    max_alt_ft: 35000,
    sourcePath: 'C:\\private\\flight.csv',
  });
  assert.equal(projectedSummary?.aircraft, null);
  assert.equal(projectedSummary?.max_alt_ft, 35000);
  assert.equal(projectedSummary?.sourcePath, undefined);

  assert.equal(projectServerMessageForClient({}, {
    type: 'flightRecording',
    status: 'stopped',
    endReason: `aircraft_change:${msfsPath}->${xplanePath}`,
  })?.endReason, 'aircraft_change');
  assert.equal(projectServerMessageForClient({}, {
    type: 'flightTime',
    elapsedHms: '00:00:00',
    endReason: `aircraft_change:${msfsPath}->${xplanePath}`,
  })?.endReason, 'aircraft_change');

  assert.equal(projectServerMessageForClient({}, {
    type: 'flightStatus',
    active: true,
    aircraftTitle: 'Microsoft / Asobo Boeing 787-10',
  })?.aircraftTitle, 'Microsoft / Asobo Boeing 787-10');
  assert.equal(projectServerMessageForClient({}, {
    type: 'flightSummary',
    aircraft: 'Embraer E170/175',
  })?.aircraft, 'Embraer E170/175');
});

test('outbound projection scrubs path values in generic, route, and flight-plan payloads', () => {
  const projectedGeneric = projectServerMessageForClient({}, {
    type: 'simState',
    connected: true,
    fileUri: 'file:///C:/Users/pilot/private.json',
    editorUri: 'vscode://file/C:/Users/pilot/private.json',
    diagnostic: 'failed while reading /var/lib/flight-fabric/private.json',
    safeUrl: 'https://example.test/status',
    safeLabel: 'Microsoft / Asobo Boeing 787-10',
    token: 'private-session-token',
    nested: {
      futureField: '/home/pilot/private.json',
      values: ['safe', 'Aircraft/Laminar Research/B738.acf'],
    },
  });
  assert.deepEqual(projectedGeneric, {
    type: 'simState',
    connected: true,
    safeUrl: 'https://example.test/status',
    safeLabel: 'Microsoft / Asobo Boeing 787-10',
    nested: {
      values: ['safe'],
    },
  });

  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'flightPlan',
    fetchedAt: 1234,
    origin: 'YSSY',
    originName: 'file:///C:/Users/pilot/origin.txt',
    destination: 'YMML',
    destinationName: 'Melbourne',
    aircraftName: 'failed /var/lib/private/aircraft.json',
    route: 'DCT RIVET Q29 LIZZI',
    username: 'private-user',
  }), {
    type: 'flightPlan',
    destinationName: 'Melbourne',
    route: 'DCT RIVET Q29 LIZZI',
    origin: 'YSSY',
    destination: 'YMML',
    fetchedAt: 1234,
  });

  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'destinationTarget',
    target: {
      icao: 'YSSY',
      name: 'vscode://file/C:/Users/pilot/private.json',
      lat: -33.9461,
      lon: 151.1772,
      initialDistanceNm: 42,
      sourcePath: 'C:\\private\\target.json',
    },
  }), {
    type: 'destinationTarget',
    target: {
      icao: 'YSSY',
      name: 'YSSY',
      lat: -33.9461,
      lon: 151.1772,
      initialDistanceNm: 42,
    },
  });
});

test('outbound projection narrows app settings and aircraft-control responses by capability', () => {
  const projectedSettings = projectServerMessageForClient({}, {
    type: 'appSettings',
    settings: {
      aircraft: { profile: 'C:\\Users\\pilot\\private-profile.json' },
      network: { remoteAccess: true, wsPort: 8099 },
    },
    settingsFile: 'C:\\Users\\pilot\\settings.json',
    storage: {
      appDataDir: 'C:\\Users\\pilot\\AppData\\Flight Fabric',
      flightLogsExists: true,
      flightLogsFileCount: 4,
      flightLogsTotalBytes: 1024,
    },
    backendVersion: '0.2.0',
  });
  assert.equal(projectedSettings?.settings.aircraft.profile, 'auto');
  assert.equal(
    projectedSettings?.settingsFile,
    'Stored locally in your Flight Fabric settings directory',
  );
  assert.equal(
    projectedSettings?.storage.appDataDir,
    'Stored locally in your Flight Fabric app-data directory',
  );
  assert.equal(JSON.stringify(projectedSettings).includes('C:\\Users\\pilot'), false);

  const controlResult = {
    type: 'aircraftControlResult',
    requestId: 'request-1',
    ok: false,
    code: 'provider_error',
    error: 'Failed while loading C:\\Users\\pilot\\private.dll',
    request: {
      control: 'autopilot',
      operation: 'set',
      target: 'heading',
      value: 180,
      privateField: 'C:\\private',
    },
    profileKey: 'local/msfs/fnx-a320',
    profileRevision: 4,
    resolvedBy: 'profile',
    action: {
      type: 'lvar',
      name: 'L:FNX_AP_HEADING',
      unit: 'number',
      value: 180,
      privateField: 'C:\\private',
    },
    backendSource: 'rust-sidecar',
    providerDiagnostic: 'C:\\private',
  };
  assert.equal(projectServerMessageForClient({}, controlResult), null);

  const projectedControl = projectServerMessageForClient(
    { __ffAircraftControlClient: true },
    controlResult,
  );
  assert.equal(projectedControl?.error, 'Aircraft control request failed.');
  assert.equal(projectedControl?.request.privateField, undefined);
  assert.equal(projectedControl?.action.privateField, undefined);
  assert.equal(projectedControl?.providerDiagnostic, undefined);
  assert.equal(projectedControl?.profileKey, 'local/msfs/fnx-a320');
  assert.equal(JSON.stringify(projectedControl).includes('C:\\private'), false);

  assert.deepEqual(projectServerMessageForClient({}, {
    type: 'aircraftControlResult',
    requestId: 'request-2',
    ok: false,
    code: 'auth_required',
    error: 'Aircraft controls require a privileged session or trusted-LAN aircraft control permission.',
    leaked: 'C:\\private',
  }), {
    type: 'aircraftControlResult',
    requestId: 'request-2',
    ok: false,
    code: 'auth_required',
    error: 'Aircraft controls require a privileged session or trusted-LAN aircraft control permission.',
  });
});

test('createWsServer installs outbound projection before connection-time state is sent', async (t) => {
  let client: any = null;
  let serverClient: any = null;
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: true,
    wsAuthToken: 'fixture-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected(ws) {
      serverClient = ws;
      ws.send?.(JSON.stringify({
        type: 'aircraftProfile',
        profile: {
          id: 'fixture',
          name: 'Fixture Aircraft',
          aircraftTitle: 'C:\\private\\aircraft.cfg',
          aircraftConfigPath: 'C:\\private\\aircraft.cfg',
        },
      }));
    },
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    try { client?.terminate(); } catch {}
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();
  client = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
    },
  });
  const initialMessages = await new Promise<any[]>((resolve, reject) => {
    const messages: any[] = [];
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for authorization and reconnect payloads')),
      3000,
    );
    client.on('message', (payload: { toString: () => string }) => {
      messages.push(JSON.parse(payload.toString()));
      if (messages.length === 2) {
        clearTimeout(timeout);
        resolve(messages);
      }
    });
  });
  assert.deepEqual(initialMessages[0], {
    type: 'authorizationScope',
    scope: 'read-only',
  });
  const message = initialMessages[1];
  assert.equal(message.profile.aircraftConfigPath, undefined);
  assert.equal(message.profile.aircraftTitle, 'Fixture Aircraft');

  const directPayloadPromise = once(client, 'message');
  serverClient.send(JSON.stringify({
    type: 'flightPlan',
    origin: 'YSSY',
    destination: 'YMML',
    originName: 'file:///C:/Users/pilot/private.txt',
    destinationName: 'Melbourne',
  }));
  const [directPayload] = await directPayloadPromise;
  assert.deepEqual(JSON.parse(directPayload.toString()), {
    type: 'flightPlan',
    destinationName: 'Melbourne',
    origin: 'YSSY',
    destination: 'YMML',
  });

  const broadcastPayloadPromise = once(client, 'message');
  const broadcast = createBroadcast({
    wss: wss as any,
    eventBus: { emit() {} },
    Debug: { log() {} },
  });
  broadcast({
    type: 'simState',
    connected: true,
    futurePathField: 'failed while reading /var/lib/private.json',
    safeUrl: 'https://example.test/status',
  });
  const [broadcastPayload] = await broadcastPayloadPromise;
  assert.deepEqual(JSON.parse(broadcastPayload.toString()), {
    type: 'simState',
    connected: true,
    safeUrl: 'https://example.test/status',
  });
  client.terminate();
});

test('createWsServer reports its bound listener without claiming whole-backend readiness', async (t) => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: false,
    Debug: { log() {} },
    tlog() {},
    onClientConnected() {},
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    console.log = originalLog;
    await closeServer(wss);
  });

  assert.equal(logs.includes('[SIMBRIDGE_READY]'), false);

  await once(wss, 'listening');
  assert.ok(logs.some((line) => line.includes('[ws] Bound to 127.0.0.1:')));
  assert.equal(
    logs.includes('[SIMBRIDGE_READY]'),
    false,
    'only simbridge-core may emit canonical readiness after all required startup work',
  );
});

test('createWsServer delegates fatal listener errors instead of exiting when supervised', async (t) => {
  const occupied = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(occupied, 'listening');
  const address = occupied.address();
  assert.ok(address && typeof address === 'object');
  const fatalErrors: Error[] = [];

  const conflicted = createWsServer({
    wsPort: address.port,
    remoteAccessEnable: false,
    Debug: { log() {} },
    tlog() {},
    onClientConnected() {},
    onClientMessage() {},
    onFatalError(error) {
      fatalErrors.push(error);
    },
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    try { await closeServer(conflicted); } catch {}
    await closeServer(occupied);
  });
  await once(conflicted, 'error');
  assert.equal(fatalErrors.length, 1);
  assert.match(fatalErrors[0].message, /EADDRINUSE|address already in use/i);
});

test('createWsServer rejects untrusted browser origins without a session token', async (t) => {
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: true,
    remoteAircraftControlEnable: true,
    wsAuthToken: 'fixture-token',
    aircraftControlToken: 'fixture-aircraft-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected() {},
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}?aircraftControlToken=fixture-aircraft-token`, {
      headers: { Origin: 'https://evil.example' },
    });
    client.on('open', () => reject(new Error('connection unexpectedly opened')));
    client.on('unexpected-response', (_req, res) => {
      try {
        assert.equal(res.statusCode, 401);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        try { client.close(); } catch {}
      }
    });
    client.on('error', () => {});
  });
});

test('createWsServer rejects a DNS-rebound public hostname even when Origin and Host match', async (t) => {
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: true,
    remoteAircraftControlEnable: true,
    wsAuthToken: 'fixture-token',
    aircraftControlToken: 'fixture-aircraft-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected() {},
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        Host: `fc00.attacker.example:${port}`,
        Origin: 'http://fc00.attacker.example:8100',
      },
    });
    client.on('open', () => reject(new Error('connection unexpectedly opened')));
    client.on('unexpected-response', (_req, res) => {
      try {
        assert.equal(res.statusCode, 401);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        try { client.close(); } catch {}
      }
    });
    client.on('error', () => {});
  });
});

test('createWsServer rejects a loopback origin aimed at a LAN host without a session token', async (t) => {
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: true,
    remoteAircraftControlEnable: true,
    wsAuthToken: 'fixture-token',
    aircraftControlToken: 'fixture-aircraft-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected() {},
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}?aircraftControlToken=fixture-aircraft-token`, {
      headers: {
        Host: `192.168.1.20:${port}`,
        Origin: 'http://localhost:8100',
      },
    });
    client.on('open', () => reject(new Error('connection unexpectedly opened')));
    client.on('unexpected-response', (_req, res) => {
      try {
        assert.equal(res.statusCode, 401);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        try { client.close(); } catch {}
      }
    });
    client.on('error', () => {});
  });
});

test('createWsServer keeps trusted-origin clients read-only when LAN access is disabled', async (t) => {
  let privilegedFlag = null;
  let aircraftControlFlag = null;
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: false,
    remoteAircraftControlEnable: true,
    wsAuthToken: 'fixture-token',
    aircraftControlToken: 'fixture-aircraft-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected(ws) {
      privilegedFlag = ws.__ffPrivilegedClient === true;
      aircraftControlFlag = ws.__ffAircraftControlClient === true;
    },
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();

  const client = new WebSocket(`ws://127.0.0.1:${port}?aircraftControlToken=fixture-aircraft-token`, {
    headers: { Origin: 'http://localhost:8100' },
  });
  await once(client, 'open');
  assert.equal(privilegedFlag, false);
  assert.equal(aircraftControlFlag, false);
  client.close();
});

test('createWsServer keeps opted-in trusted-LAN clients read-only without the pairing token', async (t) => {
  let privilegedFlag = null;
  let aircraftControlFlag = null;
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: true,
    remoteAircraftControlEnable: true,
    wsAuthToken: 'fixture-token',
    aircraftControlToken: 'fixture-aircraft-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected(ws) {
      privilegedFlag = ws.__ffPrivilegedClient === true;
      aircraftControlFlag = ws.__ffAircraftControlClient === true;
    },
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();

  const client = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      Host: `192.168.1.20:${port}`,
      Origin: 'http://192.168.1.20:8100',
    },
  });
  await once(client, 'open');
  assert.equal(privilegedFlag, false);
  assert.equal(aircraftControlFlag, false);
  client.close();
});

test('createWsServer grants only the aircraft-control scope to paired opted-in trusted-LAN clients', async (t) => {
  let privilegedFlag = null;
  let aircraftControlFlag = null;
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: true,
    remoteAircraftControlEnable: true,
    wsAuthToken: 'fixture-token',
    aircraftControlToken: 'fixture-aircraft-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected(ws) {
      privilegedFlag = ws.__ffPrivilegedClient === true;
      aircraftControlFlag = ws.__ffAircraftControlClient === true;
    },
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();

  const client = new WebSocket(`ws://127.0.0.1:${port}?aircraftControlToken=fixture-aircraft-token`, {
    headers: {
      Host: `192.168.1.20:${port}`,
      Origin: 'http://192.168.1.20:8100',
    },
  });
  await once(client, 'open');
  assert.equal(privilegedFlag, false);
  assert.equal(aircraftControlFlag, true);
  client.close();
});

test('createWsServer marks token-authenticated clients as privileged even without an origin header', async (t) => {
  let privilegedFlag = null;
  let aircraftControlFlag = null;
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: false,
    wsAuthToken: 'fixture-token',
    Debug: { log() {} },
    tlog() {},
    onClientConnected(ws) {
      privilegedFlag = ws.__ffPrivilegedClient === true;
      aircraftControlFlag = ws.__ffAircraftControlClient === true;
    },
    onClientMessage() {},
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();

  const client = new WebSocket(`ws://127.0.0.1:${port}?token=fixture-token`);
  await once(client, 'open');
  assert.equal(privilegedFlag, true);
  assert.equal(aircraftControlFlag, false);
  client.close();
});

test('createWsServer logs inbound message metadata without logging the payload', async (t) => {
  const traceCalls: unknown[][] = [];
  let resolveReceived: ((message: Record<string, unknown>) => void) | null = null;
  const received = new Promise<Record<string, unknown>>((resolve) => {
    resolveReceived = resolve;
  });
  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: false,
    wsAuthToken: 'fixture-token',
    Debug: { log() {} },
    tlog(...args: unknown[]) {
      traceCalls.push(args);
    },
    onClientConnected() {},
    onClientMessage(_ws, message) {
      resolveReceived?.(message);
    },
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();
  const client = new WebSocket(`ws://127.0.0.1:${port}?token=fixture-token`);
  await once(client, 'open');

  const payload = {
    type: 'saveAppSettings',
    settings: {
      marker: 'must-not-appear-in-trace-output',
    },
  };
  const rawPayload = JSON.stringify(payload);
  client.send(rawPayload);
  assert.deepEqual(await received, payload);

  const serializedTrace = JSON.stringify(traceCalls);
  assert.match(serializedTrace, /saveAppSettings/);
  assert.doesNotMatch(serializedTrace, /must-not-appear-in-trace-output/);
  const metadata = traceCalls
    .map((args) => args[2])
    .find((value: any) => value?.type === 'saveAppSettings') as any;
  assert.equal(metadata.payloadBytes, Buffer.byteLength(rawPayload, 'utf8'));
  assert.equal(metadata.privileged, true);
  assert.equal(metadata.aircraftControl, false);

  const closed = once(client, 'close');
  client.close();
  await closed;
});

test('createWsServer rejects malformed JSON without logging payload content', async (t) => {
  const debugCalls: unknown[][] = [];
  const traceCalls: unknown[][] = [];
  const consoleErrorCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  let handled = false;
  let resolveRejected: ((metadata: Record<string, unknown>) => void) | null = null;
  const rejected = new Promise<Record<string, unknown>>((resolve) => {
    resolveRejected = resolve;
  });

  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };

  const wss = createWsServer({
    wsPort: 0,
    remoteAccessEnable: false,
    wsAuthToken: 'fixture-token',
    Debug: {
      log(...args: unknown[]) {
        debugCalls.push(args);
        if (args[1] === 'Rejected invalid JSON message') {
          resolveRejected?.(args[2] as Record<string, unknown>);
        }
      },
    },
    tlog(...args: unknown[]) {
      traceCalls.push(args);
    },
    onClientConnected() {},
    onClientMessage() {
      handled = true;
    },
  }) as {
    on: (eventName: string, handler: (...args: unknown[]) => void) => void;
    address: () => { port: number };
    close: (cb?: (error?: Error) => void) => void;
  };

  t.after(async () => {
    console.error = originalConsoleError;
    await closeServer(wss);
  });

  await once(wss, 'listening');
  const { port } = wss.address();
  const client = new WebSocket(`ws://127.0.0.1:${port}?token=fixture-token`);
  await once(client, 'open');

  const rawPayload = 'must-not-appear-in-invalid-json-log';
  client.send(rawPayload);
  const metadata = await rejected;

  assert.equal(handled, false);
  assert.equal(metadata.payloadBytes, Buffer.byteLength(rawPayload, 'utf8'));
  assert.equal(metadata.privileged, true);
  assert.equal(metadata.aircraftControl, false);
  assert.equal(Object.hasOwn(metadata, 'error'), false);
  assert.equal(traceCalls.length, 0, 'malformed payloads must not reach tracing');
  assert.doesNotMatch(
    JSON.stringify({ debugCalls, consoleErrorCalls, traceCalls }),
    /must-not-appear-in-invalid-json-log/,
  );

  const closed = once(client, 'close');
  client.close();
  await closed;
});
