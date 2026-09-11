'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveBackendRuntimeFile: runtime } = require('../../scripts/backend-runtime-paths');
const { buildReport, buildValidationPlan, diffReports, renderReport, profileKey } = require('../../scripts/aircraft-support/inventory');
const { createCapture, captureSession, validateEndpoint } = require('../../scripts/aircraft-support/capture');
const { main, parseArgs, loadReport } = require('../../scripts/aircraft-support');

function fixture() {
  const profile = { _profileKey: 'bundled/msfs/pmdg-737', name: 'PMDG 737' };
  const integration = { id: 'pmdg-737', trustedProfileKeys: [profile._profileKey],
    fields: { 'lights.beacon': { id: 'lights.beacon', sources: [{ route: { type: 'sdk', path: 'lights.beacon', adapter: 'clientdata-manifest' },
      decode: { type: 'boolean', trueValues: [true], falseValues: [false] } }] } },
    actions: { 'lights.beacon.on': { id: 'lights.beacon.on', verification: 'untested', guard: { retry: 'never', cooldownMs: 1000, groupId: 'beacon' },
      routes: [{ id: 'beacon.sdk', transport: 'sdk', command: '#69756', value: 1,
        readback: { fieldId: 'lights.beacon', expectedValue: true, timeoutMs: 2500 } }] } } };
  const catalogue = { inventory: [{ id: 'lights.beacon.set', supported: true, input: { kind: 'boolean' },
    actionIds: ['lights.beacon.on'], speech: { patterns: ['beacon {value}'] } }] };
  return { profile, integration, catalogue, sourceProfiles: [{ key: profile._profileKey, document: { id: 'pmdg-737' } }] };
}

test('report keeps implementation support separate from declared verification and unrun live cases', () => {
  const input = fixture(), report = buildReport(input), plan = buildValidationPlan(report);
  assert.deepEqual(report.counts.declaredVerification, { untested: 1, partial: 0, verified: 0 });
  assert.equal(plan.cases[0].result, 'not-run');
  assert.deepEqual(plan.cases[0].observationFields, ['lights.beacon']);
  assert.equal(plan.cases[0].expectedReadbacks[0].expectedValue, true);
  assert.equal(plan.cases[0].cockpitObservation, null);
  assert.match(renderReport(report), /No live aircraft verification/);
  assert.equal(buildReport({ ...input, generatedAt: 'different time' }).contractHash, report.contractHash);
  input.integration.actions['lights.beacon.on'].routes[0] = { id: 'beacon.request', transport: 'sdk', confirmation: 'transport-acknowledged' };
  assert.equal(buildValidationPlan(buildReport(input)).cases[0].confirmation, 'transport-acknowledged');
});

test('decoder changes identify affected writes even when the action itself did not change', () => {
  const input = fixture(), before = buildReport(structuredClone(input));
  input.integration.fields['lights.beacon'].sources[0].decode.trueValues = [1];
  const diff = diffReports(before, buildReport(input));
  assert.deepEqual(diff.changes.fields.changed, ['lights.beacon']);
  assert.deepEqual(diff.changes.actions.changed, []);
  assert.deepEqual(diff.actionsToRecheck, ['lights.beacon.on']);
});

test('route parameters, removals, nested conditions and inherited profile edits appear in comparisons', () => {
  const input = fixture();
  input.integration.actions['lights.beacon.on'].routes[0].pulses = [{ when: [{ fieldId: 'lights.beacon', expectedValue: false }] }];
  const before = buildReport(structuredClone(input));
  input.integration.actions['lights.beacon.on'].routes[0].value = 0;
  input.sourceProfiles[0].document.extends = 'bundled/msfs/boeing-base';
  const changed = diffReports(before, buildReport(input));
  assert.deepEqual(changed.changes.actions.changed, ['lights.beacon.on']);
  assert.equal(changed.profileDefinitionsChanged, true);
  delete input.integration.fields['lights.beacon'];
  assert.deepEqual(diffReports(before, buildReport(input)).changes.fields.removed, ['lights.beacon']);
  const edited = structuredClone(before); edited.contract.actions[0].verification = 'verified';
  assert.throws(() => diffReports(before, edited), /hash mismatch/);
  input.profile._profileKey = 'bundled/msfs/pmdg-777';
  assert.throws(() => diffReports(before, buildReport(input)), /same exact profile/);
});

test('changed command inputs and speech bindings identify their existing actions for recheck', () => {
  const input = fixture(), before = buildReport(structuredClone(input));
  input.catalogue.inventory[0].speech.patterns = ['set beacon {value}'];
  input.catalogue.inventory[0].input = { kind: 'boolean' };
  const diff = diffReports(before, buildReport(input));
  assert.deepEqual(diff.changes.actions.changed, []);
  assert.deepEqual(diff.changes.commands.changed, ['lights.beacon.set']);
  assert.deepEqual(diff.actionsToRecheck, ['lights.beacon.on']);
});

function captureFixture() {
  let time = 100000;
  const report = buildReport(fixture());
  const options = { report, fieldIds: ['lights.beacon'], aircraftVersion: 'fixture', simulatorVersion: 'fixture',
    condition: 'Synthetic test, not a simulator validation', now: () => time };
  const capture = createCapture(options);
  const sample = (value, extra = {}) => ({ type: 'aircraftSpecificState', profileKey: report.contract.profileKey,
    profileRevision: 7, available: true, sourceStatus: { overall: 'connected' }, values: { 'lights.beacon': value },
    valueUpdatedAt: { 'lights.beacon': new Date(time).toISOString() }, updatedAt: new Date(time).toISOString(), ...extra });
  capture.accept({ type: 'simState', simconnectConnected: true, inMenu: false });
  return { capture, options, sample, advance: (ms = 100) => { time += ms; } };
}

test('captures false values, independent transitions and only selected fields', () => {
  const { capture, sample, advance } = captureFixture();
  capture.accept(sample(false, { unrelatedSecret: 'do not retain this', requestId: 'not-observation-data' }));
  advance(); capture.accept(sample(true));
  const result = capture.finish();
  assert.equal(result.complete, true);
  assert.equal(result.summary['lights.beacon'].transitions, 1);
  assert.equal(result.summary['lights.beacon'].firstFreshValue, false);
  assert.doesNotMatch(JSON.stringify(result), /unrelatedSecret|do not retain this|not-observation-data/);
  assert.ok(result.referenceContractHash);
  assert.equal(result.contractHash, undefined, 'local report hash must not claim the running app matches');
});

test('fresh publication cannot refresh an old field or hide an unavailable final observation', () => {
  const { capture, sample, advance } = captureFixture();
  capture.accept(sample(false)); advance(); capture.accept(sample(true)); advance(4000);
  capture.accept(sample(false, { valueUpdatedAt: { 'lights.beacon': new Date(100000).toISOString() } }));
  assert.equal(capture.finish().complete, false);
  assert.equal(capture.finish().summary['lights.beacon'].unavailableSamples, 1);
  advance(); capture.accept(sample(false, { unavailable: ['lights.beacon'] }));
  assert.equal(capture.finish().samples.at(-1).values['lights.beacon'].quality, 'missing');
});

test('a changed value with the same source timestamp is not an observed transition', () => {
  const { capture, sample, advance } = captureFixture();
  const first = sample(false); capture.accept(first); advance();
  capture.accept(sample(true, { valueUpdatedAt: first.valueUpdatedAt }));
  assert.equal(capture.finish().summary['lights.beacon'].transitions, 0);
  assert.equal(capture.finish().complete, false);
});

test('replayed snapshots alone cannot establish two distinct fresh observations', () => {
  const { capture, sample, advance } = captureFixture();
  const snapshot = sample(false);
  capture.accept(snapshot); advance(); capture.accept(snapshot);
  let result = capture.finish();
  assert.equal(result.summary['lights.beacon'].freshSamples, 2);
  assert.equal(result.summary['lights.beacon'].distinctFreshSamples, 1);
  assert.equal(result.complete, false);
  advance(); capture.accept(sample(false));
  result = capture.finish();
  assert.equal(result.summary['lights.beacon'].distinctFreshSamples, 2);
  assert.equal(result.complete, true, 'a later source observation need not change the value');
});

test('older or contradictory source samples cannot create false transitions or a fresh final result', () => {
  const { capture, sample, advance } = captureFixture();
  capture.accept(sample(false)); advance(); capture.accept(sample(true)); advance();
  capture.accept(sample(false, { valueUpdatedAt: { 'lights.beacon': new Date(100050).toISOString() } }));
  assert.equal(capture.finish().complete, false);
  advance(); capture.accept(sample(true));
  assert.equal(capture.finish().summary['lights.beacon'].transitions, 1,
    'recovery after an out-of-order sample must not add a second transition');
  advance();
  capture.accept(sample(false, { valueUpdatedAt: { 'lights.beacon': new Date(100300).toISOString() } }));
  assert.equal(capture.finish().complete, false, 'conflicting values at the same source time are not fresh evidence');
  assert.equal(capture.finish().summary['lights.beacon'].unavailableSamples, 2);
});

test('connection-time profile and data-source revisions reject older cached readings', () => {
  for (const identity of [
    { type: 'aircraftProfile', profile: { _profileKey: 'bundled/msfs/pmdg-737', profileRevision: 8 } },
    { type: 'dataSources', profileKey: 'bundled/msfs/pmdg-737', profileRevision: 8 },
  ]) {
    const { capture, sample } = captureFixture();
    capture.accept(identity); capture.accept(sample(false));
    assert.equal(capture.stoppedReason, 'profile-revision-changed');
    assert.equal(capture.sampleCount, 0);
    assert.equal(capture.finish().profileRevision, 8);
    assert.equal(capture.finish().complete, false);
  }
  const { capture, sample } = captureFixture();
  capture.accept(sample(false));
  capture.accept({ type: 'aircraftProfile', profile: { _profileKey: 'bundled/msfs/pmdg-737' } });
  assert.equal(capture.stoppedReason, 'missing-profile-revision');
});

test('explicit paused or disconnected aircraft data ends collection before recovery', () => {
  for (const overall of ['paused', 'disconnected']) {
    const { capture, sample, advance } = captureFixture();
    capture.accept(sample(false)); advance();
    capture.accept(sample(false, { available: false, sourceStatus: { overall } }));
    advance(); capture.accept(sample(true));
    const result = capture.finish();
    assert.equal(result.endReason, 'simulator-unavailable');
    assert.equal(result.complete, false);
    assert.equal(result.samples.length, 2);
    assert.equal(result.summary['lights.beacon'].lastQuality, 'stale-or-unavailable');
  }
});

test('collection finishing does not revive a field that aged out after its last receipt', () => {
  const { capture, sample, advance } = captureFixture();
  capture.accept(sample(false)); advance(); capture.accept(sample(true)); advance(2400);
  capture.accept(sample(true, { valueUpdatedAt: { 'lights.beacon': new Date(100100).toISOString() } }));
  advance(200);
  assert.equal(capture.finish().complete, false);
  assert.equal(capture.finish().summary['lights.beacon'].lastQuality, 'stale-or-unavailable');
});

test('aborted capture stops its connection and returns partial evidence promptly', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await captureSession({ ...captureFixture().options, durationMs: 1000,
    url: 'ws://127.0.0.1:1', signal: controller.signal });
  assert.equal(result.endReason, 'interrupted'); assert.equal(result.complete, false);
});

test('aircraft identity, revision, simulator loss and backward clock terminate a capture', () => {
  for (const [message, reason] of [
    [{ type: 'aircraftChanged' }, 'aircraft-changed'],
    [{ type: 'aircraftSpecificState', profileKey: 'bundled/msfs/pmdg-777' }, 'profile-mismatch'],
    [{ type: 'aircraftSpecificState', profileKey: 'bundled/msfs/pmdg-737', profileRevision: 8 }, 'profile-revision-changed'],
    [{ type: 'simState', simconnectConnected: false }, 'simulator-unavailable'],
    [{ type: 'simState', simconnectConnected: true, inMenu: true }, 'simulator-unavailable'],
  ]) {
    const { capture, sample } = captureFixture(); capture.accept(sample(false)); capture.accept(message);
    capture.accept(sample(true));
    assert.equal(capture.finish().endReason, reason); assert.equal(capture.sampleCount, 1);
    assert.equal(capture.finish().complete, false);
  }
  const { capture } = captureFixture(); capture.accept({}, 1);
  assert.equal(capture.stoppedReason, 'clock-regressed');
});

test('invalid identifiers, endpoints, flags and unsupported fields fail explicitly', () => {
  assert.equal(profileKey('pmdg-737'), 'bundled/msfs/pmdg-737');
  for (const value of ['../../secrets', 'local/msfs/pmdg-737', '*']) assert.throws(() => profileKey(value));
  for (const value of ['ws://example.com', 'ws://localhost/?token=secret', 'ws://user:pass@localhost', 'file:///tmp/data', 'ws://localhost/controls']) {
    assert.throws(() => validateEndpoint(value));
  }
  assert.equal(validateEndpoint('ws://127.0.0.1:8099'), 'ws://127.0.0.1:8099/');
  assert.throws(() => parseArgs(['capture', '--execute', 'true']), /Invalid/);
  assert.throws(() => parseArgs(['report', '--profile', 'pmdg-737', '--profile', 'pmdg-777']), /duplicate/);
  assert.throws(() => createCapture({ ...captureFixture().options, fieldIds: ['made.up'] }), /logical field/);
});

test('capture interoperates with the backend WebSocket authorization and aircraft-state producer', async () => {
  const { createWsServer } = require(runtime('core/ws-bootstrap.js'));
  const { buildAircraftSpecificState } = require(runtime('aircraft/aircraft-specific-state.js'));
  const incoming = [], timers = [];
  let scope;
  const server = createWsServer({ wsPort: 0, remoteAccessEnable: false,
    wsAuthToken: 'fixture-control-token', Debug: { log() {} }, tlog() {},
    onClientConnected(socket) {
      scope = { privileged: socket.__ffPrivilegedClient, aircraftControl: socket.__ffAircraftControlClient };
      socket.send(JSON.stringify({ type: 'aircraftProfile', profile: {
        _profileKey: 'bundled/msfs/pmdg-737', profileRevision: 7,
      } }));
      socket.send(JSON.stringify({ type: 'simState', simconnectConnected: true, inMenu: false }));
    },
    onClientMessage(socket, message) {
      incoming.push(message);
      for (let index = 0; index < 5; index++) timers.push(setTimeout(() => {
        const timestamp = new Date().toISOString();
        const state = buildAircraftSpecificState({
          config: { profileKey: 'bundled/msfs/pmdg-737', profileRevision: 7, templateId: 'pmdg-737',
            fields: [{ id: 'lights.beacon', source: { type: 'sdk', adapterId: 'clientdata-manifest', path: 'lights.beacon' },
              decode: { type: 'boolean', trueValues: [true], falseValues: [false] } }] },
          frame: { simconnect: { connected: true }, sdk: { adapterId: 'clientdata-manifest', status: 'running',
            snapshotSequence: index + 1, updatedAt: timestamp, normalized: { lights: { beacon: index > 1 } } } },
          simState: { simconnectConnected: true, inMenu: false }, nowEpochMs: Date.parse(timestamp),
        });
        socket.send(JSON.stringify(state));
      }, index * 150));
    },
  });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const options = captureFixture().options; delete options.now;
    const result = await captureSession({ ...options, url: `ws://127.0.0.1:${server.address().port}`, durationMs: 1000 });
    assert.deepEqual(incoming, [{ type: 'requestState' }]);
    assert.deepEqual(scope, { privileged: false, aircraftControl: false });
    assert.equal(result.complete, true); assert.equal(result.samples.length, 5);
    assert.equal(result.summary['lights.beacon'].transitions, 1);
  } finally {
    timers.forEach(clearTimeout);
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('report loading leaves caller settings and backend module state untouched', () => {
  const callerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aircraft-report-caller-'));
  try {
    const result = execFileSync(process.execPath, ['-e', `
      const { loadReport } = require('./scripts/aircraft-support');
      const report = loadReport('pmdg-737');
      const importedSettings = Object.keys(require.cache).some(file => /[\\\\/]core[\\\\/]user-settings\\.js$/.test(file));
      process.stdout.write(JSON.stringify({ profileKey: report.contract.profileKey, importedSettings }));
    `], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8',
      env: { ...process.env, HOME: callerHome, USERPROFILE: callerHome, APPDATA: callerHome,
        LOCALAPPDATA: callerHome, XDG_CONFIG_HOME: callerHome, OneDrive: callerHome,
        ONEDRIVE: callerHome, OneDriveConsumer: callerHome, OneDriveCommercial: callerHome,
        FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1' } });
    assert.deepEqual(JSON.parse(result), { profileKey: 'bundled/msfs/pmdg-737', importedSettings: false });
    assert.deepEqual(fs.readdirSync(callerHome), [], 'report must not create or migrate caller app data');
  } finally {
    // Leave unexpected files available for diagnosis if this isolation check fails.
    if (fs.readdirSync(callerHome).length === 0) fs.rmdirSync(callerHome);
  }
});

test('CLI refuses to overwrite existing evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aircraft-support-'));
  const before = path.join(dir, 'report.json'), out = path.join(dir, 'diff.json');
  try {
    fs.writeFileSync(before, JSON.stringify(buildReport(fixture()))); fs.writeFileSync(out, 'retain evidence');
    await assert.rejects(main(['diff', '--before', before, '--after', before, '--out', out]), /EEXIST/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'retain evidence');
  } finally {
    fs.unlinkSync(before); fs.unlinkSync(out); fs.rmdirSync(dir);
  }
});

test('real bundled families expose distinct inventories and source inheritance', () => {
  for (const key of ['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900', 'pmdg-777', 'fenix-a320', 'fbw-a32nx']) {
    const report = loadReport(key);
    assert.equal(report.contract.profileKey, `bundled/msfs/${key}`);
    assert.ok(report.counts.fields > 0, key); assert.ok(report.counts.actions > 0, key);
    assert.ok(report.counts.advertisedCommands > 0, key);
    assert.equal(diffReports(report, report).contractChanged, false);
    assert.ok(buildValidationPlan(report).cases.every(item => item.result === 'not-run'));
  }
  const pmdg = loadReport('pmdg-737');
  assert.equal(pmdg.counts.fields, 130); assert.equal(pmdg.counts.actions, 186);
  assert.ok(pmdg.sources.some(item => item.profileKey === 'bundled/msfs/boeing-base'));
  const generic = loadReport('generic'); assert.equal(generic.contract.integrationId, null);
  assert.equal(generic.counts.actions, 0);
  const xplane = loadReport('bundled/xplane/zibo-737-800');
  assert.equal(xplane.counts.advertisedCommands, 0);
  const fbw = loadReport('fbw-a32nx');
  for (const id of ['approach.minimums.baro', 'approach.minimums.radio']) {
    assert.equal(fbw.contract.commands.find(command => command.id === id)?.supported, true,
      'all-supported report must include the provider SimBridge transport');
  }
});
