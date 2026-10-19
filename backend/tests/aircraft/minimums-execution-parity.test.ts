import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Exercise the real provider and executor without connecting to a running
// SimBridge. Restore the shared module export immediately after module loading;
// only constructors captured by this test process use the owned socket below.
let socketFactory: ((args: unknown[]) => EventEmitter) | null = null;
const wsPath = require.resolve('ws');
const actualWebSocket = require(wsPath);
const wsModule = require.cache[wsPath]!;
let SimConnectTelemetryProvider;
try {
  wsModule.exports = new Proxy(actualWebSocket, {
    construct(_target, args) {
      assert.ok(socketFactory, 'unexpected WebSocket acquisition outside a minimums fixture');
      return socketFactory(args);
    },
  });
  ({ SimConnectTelemetryProvider } = require('../../telemetry-provider/simconnect-telemetry-provider'));
} finally { wsModule.exports = actualWebSocket; }
const loader = require('../../aircraft/aircraft-profile-loader');

function harness({ storedTarget = '', storedValue = 0, holdFirstKey = false } = {}) {
  loader.setActiveProfile('fbw-a32nx');
  const config = loader.getAircraftSpecificConfig();
  const provider = new SimConnectTelemetryProvider();
  provider._connected = true;
  provider._simRunning = true;
  const socket: any = new EventEmitter();
  socket.readyState = 1;
  const acquisitions: unknown[][] = [], keys: string[] = [];
  let terminations = 0, onFirstKey = () => {}, release = () => {};
  let firstKeyEntered;
  const firstKey = new Promise<void>(resolve => { firstKeyEntered = resolve; });
  const page = { title: '{green}APPR{end} ILS27',
    lines: Array.from({ length: 12 }, () => ['', '']), scratchpad: '' };
  page.lines[2][1] = 'BARO'; page.lines[3][1] = storedTarget === 'baro' ? String(storedValue) : '[   ]';
  page.lines[4][1] = 'RADIO'; page.lines[5][1] = storedTarget === 'radio' ? String(storedValue) : '[ ]';
  const publish = () => socket.emit('message', `update:${JSON.stringify({ left: page, right: page })}`);
  const applyKey = (key: string) => {
    if (/^\d$/.test(key)) page.scratchpad += key;
    else {
      assert.ok(key === 'R2' || key === 'R3', 'minimums must not navigate or clear pilot input');
      page.lines[key === 'R2' ? 3 : 5][1] = page.scratchpad;
      page.lines[key === 'R2' ? 5 : 3][1] = '[ ]';
      page.scratchpad = '';
    }
    publish();
  };
  socket.send = (message: string) => {
    if (message === 'requestUpdate') { publish(); return; }
    keys.push(message); socket.emit('message', message);
    assert.match(message, /^event:left:/);
    const key = message.split(':')[2];
    if (keys.length === 1) {
      firstKeyEntered(); onFirstKey();
      if (holdFirstKey) { release = () => applyKey(key); return; }
    }
    applyKey(key);
  };
  socket.terminate = () => { terminations++; socket.readyState = 3; };
  socketFactory = (args) => { acquisitions.push(args); return socket; };
  return {
    provider, config, acquisitions, keys, page, firstKey,
    terminations: () => terminations,
    release: () => release(),
    onFirstKey: (callback) => { onFirstKey = callback; },
    run: (target = 'baro', value: unknown = 420, revision = config.profileRevision) =>
      provider._executeAircraftIntegrationAction({}, { name: 'fbw-a32nx' }, 'minimums-fixture', {
        profileKey: config.profileKey, profileRevision: revision,
        request: { actionId: `approach.minimums.${target}`, value },
      }),
  };
}

const metadata = (target: string) => ({ backendSource: 'minimums-fixture', integrationId: 'fbw-a32nx',
  actionId: `approach.minimums.${target}`, routeId: `fbwA32nx.approach.minimums.${target}`, transportMode: 'simbridge-mcdu' });
const expectedAcquisition = [['ws://127.0.0.1:8380/interfaces/v1/mcdu', { handshakeTimeout: 1500, maxPayload: 65536 }]];

for (const [target, value] of [['baro', 420], ['radio', 200]] as const) {
  test(`A32NX provider preserves ${target} minimums writes, metadata and no-op cleanup`, async () => {
    for (const matching of [false, true]) {
      const h = harness({ storedTarget: matching ? target : '', storedValue: value });
      assert.deepEqual(await h.run(target, value), {
        ok: true, ...(matching ? { noOp: true } : {}), confirmedValue: value,
        executionStarted: !matching, ...metadata(target),
      });
      assert.deepEqual(h.keys, matching ? [] : [
        ...String(value).split('').map(digit => `event:left:${digit}`), `event:left:${target === 'baro' ? 'R2' : 'R3'}`,
      ]);
      assert.deepEqual(h.acquisitions, expectedAcquisition);
      assert.equal(h.terminations(), 1);
      assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
      assert.equal((await h.run(target, value)).code, 'action_cooldown');
      assert.equal(h.acquisitions.length, 1);
    }
  });
}

test('A32NX provider shares one minimums lock between BARO and RADIO until readback completes', async () => {
  const h = harness({ holdFirstKey: true });
  const pending = h.run();
  await h.firstKey;
  try {
    assert.deepEqual(await h.run('radio', 200), { ok: false, code: 'action_in_progress',
      error: 'A minimums command is already pending.', backendSource: 'minimums-fixture' });
    assert.equal(h.acquisitions.length, 1);
  } finally { h.release(); }
  assert.equal((await pending).ok, true);
  assert.equal(h.terminations(), 1);
  assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
  assert.equal((await h.run('radio', 200)).code, 'action_cooldown');
});

test('A32NX provider rejects stale revisions and invalid minimums before acquiring a socket or lock', async () => {
  for (const scenario of ['stale', 'fractional', 'range']) {
    const h = harness();
    const result = scenario === 'stale'
      ? await h.run('baro', 420, h.config.profileRevision - 1)
      : await h.run('radio', scenario === 'fractional' ? 200.5 : 5001);
    assert.equal(result.code, scenario === 'stale' ? 'untrusted_aircraft_integration' : 'invalid_value');
    assert.deepEqual(h.acquisitions, []);
    assert.deepEqual(h.keys, []);
    assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
    assert.equal(h.provider._aircraftIntegrationActionLastAttemptAt.size, 0);
  }
});

test('A32NX provider retires minimums input on profile or simulator loss and releases its resources', async () => {
  for (const reason of ['profile', 'simulator']) {
    const h = harness();
    h.onFirstKey(() => {
      if (reason === 'profile') loader.setActiveProfile('pmdg-737');
      else h.provider._connected = false;
    });
    const result = await h.run();
    assert.deepEqual(result, { ok: false, code: 'minimums_unconfirmed',
      error: 'Aircraft changed or simulator disconnected. Minimums were not confirmed.', executionStarted: true,
      ...metadata('baro') });
    assert.deepEqual(h.keys, ['event:left:4']);
    assert.equal(h.page.scratchpad, '4');
    assert.equal(h.terminations(), 1);
    assert.equal(h.provider._aircraftIntegrationActionsInFlight.size, 0);
  }
});
