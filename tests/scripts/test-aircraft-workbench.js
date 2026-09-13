'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { WebSocketServer } = require('ws');
const { resolveBackendRuntimeFile: runtime } = require('../../scripts/backend-runtime-paths');
const { buildReport } = require(runtime('aircraft/support/inventory.js'));
const { createSessionStore, guidedPlan } = require(runtime('aircraft/support/sessions.js'));
const { createWorkbenchService } = require(runtime('aircraft/support/service.js'));
const { createSessionWorker } = require(runtime('aircraft/support/storage-worker.js'));
const { handleWorkbenchRequest } = require(runtime('aircraft/support/http.js'));
const { requestSession } = require('../../scripts/aircraft-support/session-client');
const ROOT = path.resolve(__dirname, '../..');
const BUILD = { appVersion: 'test-only', runtimeFingerprint: 'fixture-runtime', instanceId: 'fixture-process' };

function fixture() {
  return buildReport({ profile: { _profileKey: 'bundled/msfs/pmdg-737', name: 'Fixture 737' },
    integration: { id: 'pmdg-737', fields: { 'lights.beacon': { id: 'lights.beacon', sources: [] } }, actions: {
      'lights.beacon.on': { id: 'lights.beacon.on', label: 'Beacon on', verification: 'untested',
        guard: { retry: 'never' }, routes: [{ id: 'beacon', transport: 'sdk', readback: { fieldId: 'lights.beacon', expectedValue: true } }] },
      'systems.apu.start': { id: 'systems.apu.start', verification: 'untested', routes: [{ id: 'apu', transport: 'sdk', confirmation: 'transport-acknowledged' }] },
    } }, catalogue: { inventory: [{ id: 'lights.beacon.set', actionIds: ['lights.beacon.on'], supported: true,
      speech: { patterns: ['beacon {value}'] } }] }, sourceProfiles: [] });
}
function directory() {
  const parent = path.join(ROOT, '.tmp', 'aircraft-workbench-tests');
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, 'run-'));
}
function setup(overrides = {}) {
  return { profileKey: fixture().contract.profileKey, title: 'Synthetic test session', aircraftVariant: 'Fixture 737-800',
    aircraftVersion: 'fixture-aircraft', simulatorVersion: 'fixture-simulator', ...overrides };
}
function result(session, overrides = {}) {
  return { revision: session.revision, caseId: session.plan.cases[0].id, result: 'pass', startingState: 'Powered, beacon off',
    inputUsed: 'beacon on', cockpitObservation: 'Synthetic observation for software test, not live compatibility evidence.', ...overrides };
}

test('sessions persist immutable versions and append observations; conflicts cannot overwrite evidence', () => {
  const root = directory(), store = createSessionStore(root), report = fixture();
  const session = store.create(report, BUILD, setup());
  assert.equal(store.list().sessions[0].counts['not-run'], 2);
  assert.equal(session.report.counts.declaredVerification.untested, 2);
  const first = store.recordAttempt(session.id, result(session));
  assert.equal(createSessionStore(root).read(session.id).attempts.length, 1);
  assert.throws(() => store.recordAttempt(session.id, result(session, { result: 'fail' })), /Session changed/);
  const second = store.recordAttempt(session.id, result(first, { result: 'fail' }));
  assert.deepEqual(second.attempts.map(item => item.result), ['pass', 'fail']);
  assert.equal(store.list().sessions[0].counts.fail, 1);
  assert.equal(second.report.counts.declaredVerification.untested, 2);
  assert.deepEqual(second.environment, session.environment);
  assert.throws(() => store.read('../escape'), /Invalid session ID/);
  assert.throws(() => store.recordAttempt(session.id, result(second, { cockpitObservation: '' })), /Cockpit observation/);
  assert.throws(() => store.recordAttempt(session.id, result(second, { inputUsed: '' })), /Input or voice phrase/);
  assert.throws(() => store.recordAttempt(session.id, result(second, { caseId: 'unknown' })), /Unknown test/);
  assert.throws(() => store.recordAttempt(session.id, result(second, { captureId: 'foreign' })), /Capture does not belong/);
  assert.throws(() => store.create(report, BUILD, setup({ aircraftVersion: '' })), /Aircraft version/);
});

test('guided cases retain input, prerequisites and exact route identity without implying live verification', () => {
  const plan = guidedPlan(fixture());
  assert.equal(plan.cases[0].label, 'Beacon on');
  assert.equal(plan.cases[0].group, 'Lights');
  assert.deepEqual(plan.cases[0].voicePatterns, ['beacon {value}']);
  assert.equal(plan.cases[1].group, 'APU');
  assert.equal(plan.cases[1].confirmation, 'transport-acknowledged');
  assert.equal(plan.cases[1].result, 'not-run');
});

test('failed session replacement preserves previous results and a separate capture recovery file', () => {
  const root = directory(), store = createSessionStore(root), report = fixture();
  const session = store.create(report, BUILD, setup());
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('Simulated file lock'); };
  try {
    assert.throws(() => store.addCapture(session.id, session.plan.cases[0].id,
      { profileKey: report.contract.profileKey, referenceContractHash: report.contractHash, samples: [{ value: false }] }, BUILD), /Capture preserved/);
  } finally { fs.renameSync = rename; }
  assert.equal(store.read(session.id).revision, 1);
  assert.equal(store.read(session.id).captures.length, 0);
  const recovery = fs.readdirSync(root).find(file => file.endsWith('.capture.json'));
  assert.ok(recovery);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, recovery), 'utf8')).capture.samples[0].value, false);
  assert.equal(store.list().sessions.length, 1);
});

test('total storage budget covers sessions, temporary saves and recovery files without deleting evidence', () => {
  const root = directory(), original = createSessionStore(root), report = fixture();
  const session = original.create(report, BUILD, setup());
  const saved = fs.readFileSync(path.join(root, `${session.id}.json`), 'utf8');
  const bytes = Buffer.byteLength(saved);
  const limited = createSessionStore(root, bytes + 1);
  assert.throws(() => limited.create(report, BUILD, setup()), error => error.status === 507);
  assert.throws(() => limited.recordAttempt(session.id, result(session)), error => error.status === 507);
  assert.throws(() => limited.captureCapacity(), error => error.status === 507);
  assert.throws(() => limited.addCapture(session.id, session.plan.cases[0].id,
    { profileKey: report.contract.profileKey, referenceContractHash: report.contractHash, samples: [{ value: false }] }, BUILD), /could not be stored/);
  assert.equal(fs.readFileSync(path.join(root, `${session.id}.json`), 'utf8'), saved);
  assert.equal(fs.readdirSync(root).length, 1, 'quota failures must not create recovery files outside the budget');
  const overLimit = createSessionStore(root, 1);
  const listing = overLimit.list();
  assert.equal(listing.storage.usedBytes, bytes);
  assert.equal(overLimit.read(session.id).id, session.id, 'old evidence stays readable above the new limit');
  assert.equal(overLimit.remove(listing.storage.files[0].name, listing.storage.files[0].version).storage.usedBytes, 0);
});

test('recovery files consume the shared budget and cleanup rejects changed, foreign and linked targets', () => {
  const root = directory(), store = createSessionStore(root), report = fixture();
  const session = store.create(report, BUILD, setup());
  const first = store.list().storage.files[0];
  const revised = store.recordAttempt(session.id, result(session));
  assert.throws(() => store.remove(first.name, first.version), /changed/);
  assert.throws(() => store.remove('../outside.json', first.version), /Invalid storage filename/);
  assert.throws(() => store.remove('settings.json', first.version), /Invalid storage filename/);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('Simulated file lock'); };
  try {
    assert.throws(() => store.addCapture(session.id, session.plan.cases[0].id,
      { profileKey: report.contract.profileKey, referenceContractHash: report.contractHash, samples: [{ value: true }] }, BUILD), /Capture preserved/);
  } finally { fs.renameSync = rename; }
  const listing = store.list();
  const recovery = listing.storage.files.find(file => file.kind === 'recovery');
  assert.ok(recovery);
  assert.equal(listing.storage.usedBytes, listing.storage.files.reduce((bytes, file) => bytes + file.bytes, 0));
  store.remove(recovery.name, recovery.version);
  assert.equal(store.read(session.id).revision, revised.revision, 'deleting a recovery must leave its session intact');
  const stat = fs.lstatSync;
  fs.lstatSync = file => {
    const value = stat(file);
    if (file === path.join(root, first.name)) value.isSymbolicLink = () => true;
    return value;
  };
  try { assert.throws(() => store.remove(first.name, first.version), /link or directory/); }
  finally { fs.lstatSync = stat; }
  assert.equal(store.read(session.id).revision, revised.revision);
});

test('background storage keeps filesystem work off the caller and serializes conflicting saves', async (t) => {
  const root = directory(), worker = createSessionWorker(root);
  t.after(() => worker.close());
  const session = await worker.call('create', fixture(), BUILD, setup());
  const readFile = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (String(file).startsWith(root)) throw new Error('Session I/O ran on the caller thread');
    return readFile(file, ...args);
  };
  try { assert.equal((await worker.call('read', session.id)).id, session.id); }
  finally { fs.readFileSync = readFile; }
  const outcomes = await Promise.allSettled([
    worker.call('recordAttempt', session.id, result(session)),
    worker.call('recordAttempt', session.id, result(session, { result: 'fail' })),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal((await worker.call('read', session.id)).attempts.length, 1);
  await assert.rejects(worker.call('read', '../escape'), /Invalid session ID/);
  assert.equal((await worker.call('list')).sessions.length, 1, 'a rejected request must not break the worker');
});

test('service uses actual read-only capture, persists its identity, and requires explicit test outcomes', async (t) => {
  const report = fixture(), root = directory();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const sent = [];
  wss.on('connection', socket => {
    socket.on('message', bytes => {
      sent.push(JSON.parse(bytes));
      socket.send(JSON.stringify({ type: 'simState', simconnectConnected: true, inMenu: false }));
      socket.send(JSON.stringify({ type: 'aircraftProfile', profile: { _profileKey: report.contract.profileKey, profileRevision: 3 } }));
    });
    let value = false;
    const timer = setInterval(() => {
      const at = new Date().toISOString(); value = !value;
      socket.send(JSON.stringify({ type: 'aircraftSpecificState', profileKey: report.contract.profileKey, profileRevision: 3,
        available: true, sourceStatus: { overall: 'connected' }, updatedAt: at, valueUpdatedAt: { 'lights.beacon': at }, values: { 'lights.beacon': value } }));
    }, 60);
    socket.on('close', () => clearInterval(timer));
  });
  let loadedKey = report.contract.profileKey;
  const options = { root, wsPort: wss.address().port, build: BUILD, reportLoader: () => report,
    profileList: () => [{ profileKey: report.contract.profileKey, name: report.profileName }],
    getLoadedAircraft: () => ({ profileKey: loadedKey }) };
  const service = createWorkbenchService(options);
  t.after(async () => { await service.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); });
  const call = (method, endpoint, input) => service.handle(method, endpoint.split('/'), new URLSearchParams(), input);
  const { session } = await call('POST', 'sessions', setup());
  loadedKey = 'bundled/msfs/pmdg-777';
  const capture = { revision: session.revision, caseId: session.plan.cases[0].id, seconds: 1, condition: 'Synthetic data' };
  await assert.rejects(call('POST', `sessions/${session.id}/capture`, capture), /Load the session aircraft/);
  loadedKey = report.contract.profileKey;
  const starts = await Promise.allSettled([
    call('POST', `sessions/${session.id}/capture`, capture),
    call('POST', `sessions/${session.id}/capture`, capture),
  ]);
  assert.equal(starts.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(starts.find(item => item.status === 'rejected').reason.message, /already running/);
  const savedFile = (await call('GET', 'sessions')).storage.files[0];
  await assert.rejects(call('POST', 'storage/delete', savedFile), /Stop the capture/);
  await assert.rejects(call('POST', 'sessions', setup()), /Stop the capture/);
  await call('POST', `sessions/${session.id}/capture/marker`, { label: 'Synthetic control operated' });
  await assert.rejects(call('POST', `sessions/${session.id}/capture`, capture), /already running/);
  await assert.rejects(call('POST', `sessions/${session.id}/results`, result(session)), /Stop the capture/);
  await new Promise(resolve => setTimeout(resolve, 1300));
  const saved = (await call('GET', `sessions/${session.id}`)).session;
  assert.equal(saved.captures.length, 1);
  assert.equal(saved.captures[0].capture.complete, true);
  assert.equal(saved.captures[0].build.instanceId, BUILD.instanceId);
  assert.equal(saved.captures[0].capture.markers[0].label, 'Synthetic control operated');
  assert.equal(saved.attempts.length, 0);
  assert.deepEqual(sent, [{ type: 'requestState' }]);
  assert.equal(saved.report.counts.declaredVerification.verified, 0);
  await assert.rejects(call('POST', `sessions/${session.id}/capture`, { ...capture, revision: saved.revision, caseId: saved.plan.cases[1].id }), /no published capture/);
  await call('POST', `sessions/${session.id}/capture`, { ...capture, revision: saved.revision, seconds: 20 });
  const stopped = await call('POST', `sessions/${session.id}/capture/stop`, {});
  assert.equal(stopped.session.captures.length, 2);
  assert.equal(stopped.session.captures[1].capture.complete, false);
  assert.equal(stopped.captureStatus.active, null);
  const newBuild = createWorkbenchService({ ...options, build: { ...BUILD, runtimeFingerprint: 'changed' } });
  assert.equal((await newBuild.handle('GET', ['sessions', session.id], new URLSearchParams())).compatibility.matches, false);
  await assert.rejects(newBuild.handle('POST', ['sessions', session.id, 'results'], new URLSearchParams(), result(stopped.session)), /running app has changed/);
  await newBuild.close();
  const removedProfile = createWorkbenchService({ ...options, reportLoader: () => { throw new Error('Profile removed'); } });
  const historical = await removedProfile.handle('GET', ['sessions', session.id], new URLSearchParams());
  assert.equal(historical.compatibility.matches, false);
  assert.equal(historical.session.captures.length, 2, 'historical evidence remains exportable if the profile is removed');
  await removedProfile.close();
});

test('HTTP requires local full-scope credentials and CLI reads and writes the same sessions', async (t) => {
  const service = createWorkbenchService({ root: directory(), wsPort: 1, build: BUILD,
    reportLoader: () => fixture(), profileList: () => [], getLoadedAircraft: () => ({}) });
  const token = 'fixture-full-scope';
  const server = http.createServer((req, res) => {
    if (req.url === '/api/bootstrap') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ wsAuthToken: token })); return; }
    void handleWorkbenchRequest(req, res, { token, local: req.headers['x-test-remote'] !== 'true', service: () => service });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = `${url}/api/aircraft-support/sessions`;
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal((await fetch(endpoint, { headers: { Authorization: 'Bearer aircraft-only' } })).status, 403);
  assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, 'x-test-remote': 'true' } })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' })).status, 415);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const created = await requestSession({ operation: 'create', input: setup(), url });
  const list = await requestSession({ operation: 'list', url });
  assert.equal(list.sessions[0].id, created.session.id);
  const updated = await requestSession({ operation: 'result', id: created.session.id, input: result(created.session), url });
  assert.equal(updated.session.attempts[0].result, 'pass');
  const exported = await requestSession({ operation: 'show', id: created.session.id, url });
  assert.equal(exported.session.revision, 2);
  assert.equal(JSON.stringify(exported).includes(token), false);
  const files = await requestSession({ operation: 'list', url });
  const removal = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(files.storage.files[0]) };
  assert.equal((await fetch(`${url}/api/aircraft-support/storage/delete`, removal)).status, 403);
  assert.equal((await fetch(`${url}/api/aircraft-support/storage/delete`, {
    ...removal, headers: { ...removal.headers, Authorization: `Bearer ${token}`, 'x-test-remote': 'true' },
  })).status, 403);
  const deleted = await fetch(`${url}/api/aircraft-support/storage/delete`, {
    ...removal, headers: { ...removal.headers, Authorization: `Bearer ${token}` },
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).storage.usedBytes, 0);
  await assert.rejects(requestSession({ operation: 'list', url: 'https://example.com' }), /local Flight Fabric/);
});

test('UI preserves drafts across refresh and uses revision-aware shared session APIs', async () => {
  const { createPinia, setActivePinia } = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/pinia/dist/pinia.mjs')));
  const { useAircraftWorkbenchStore } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/vue/stores/aircraft-workbench.js')));
  setActivePinia(createPinia());
  const service = createWorkbenchService({ root: directory(), wsPort: 1, build: BUILD,
    reportLoader: () => fixture(), profileList: () => [], getLoadedAircraft: () => ({}) });
  const store = useAircraftWorkbenchStore();
  const request = (resource, { body } = {}) => {
    const url = new URL(resource, 'http://localhost');
    return service.handle(body === undefined ? 'GET' : 'POST', url.pathname.slice(1).split('/'), url.searchParams, body);
  };
  store.bindRequest(request);
  await store.createSession(setup());
  store.search = 'beacon'; assert.equal(store.filteredCases.length, 1);
  const draft = store.draftFor(store.selectedCaseId);
  Object.assign(draft, result(store.session));
  assert.equal(store.hasUnsaved, true);
  await store.refreshSession(); assert.equal(store.draftFor(store.selectedCaseId).cockpitObservation, draft.cockpitObservation);
  await store.saveResult(); assert.equal(store.error, ''); assert.equal(store.counts.pass, 1);
  assert.equal(store.hasUnsaved, false);
  assert.ok(store.storage.usedBytes > 0);
  const file = store.storage.files[0];
  store.draftFor(store.selectedCaseId).cockpitObservation = 'Unsaved follow-up';
  assert.equal(await store.deleteFile(file), null);
  assert.match(store.error, /Save your observations/);
  assert.ok(store.session);
  await store.saveResult();
  const updatedFile = store.storage.files[0];
  store.outcomeFilter = 'fail'; assert.equal(store.filteredCases.length, 0);
  store.bindRequest(async () => { throw new Error('Disconnected'); });
  await store.refreshSession(); assert.equal(store.error, 'Disconnected'); assert.equal(store.session.attempts.length, 2);
  store.bindRequest(request);
  assert.equal(await store.deleteFile(updatedFile), true);
  assert.equal(store.session, null);
  assert.equal(store.sessions.length, 0);
  assert.equal(store.storage.usedBytes, 0);
  await service.close();
});

test('app connection attaches workbench credentials only after full authorization and blocks remote endpoints', async () => {
  const { createConnection } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/ws/connection.js')));
  class Socket { static OPEN = 1; constructor() { this.readyState = 1; } close() {} send() {} }
  const calls = [];
  const windowRef = { location: { hostname: '127.0.0.1', protocol: 'http:', port: '8100', search: '', origin: 'http://127.0.0.1:8100' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/api/bootstrap') ? { wsAuthToken: 'fixture-secret' } : { sessions: [] } };
    } };
  const connection = createConnection({ windowRef, WebSocketRef: Socket });
  await connection.initialize();
  await assert.rejects(connection.requestAircraftSupport('sessions'), /simulator PC/);
  connection.getWs().onmessage({ data: JSON.stringify({ type: 'authorizationScope', scope: 'full-control' }) });
  await connection.requestAircraftSupport('sessions');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer fixture-secret');
  assert.equal(calls.at(-1).options.redirect, 'error');
  await assert.rejects(connection.requestAircraftSupport('../other'), /Invalid workbench/);
  const remote = createConnection({ windowRef: { ...windowRef, location: { ...windowRef.location, hostname: '192.168.1.50', origin: 'http://192.168.1.50:8100' } }, WebSocketRef: Socket });
  await remote.initialize();
  remote.getWs().onmessage({ data: JSON.stringify({ type: 'authorizationScope', scope: 'full-control' }) });
  await assert.rejects(remote.requestAircraftSupport('sessions'), /simulator PC/);
});
