const fs = require('node:fs') as typeof import('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { getAppVersion } from '../../core/app-version';
import { captureSession } from './capture';
import { loadRuntimeReport, listSupportProfiles } from './runtime-report';
import { guidedPlan, boundedText, storedFileIdentity, WorkbenchBuild, WorkbenchError } from './sessions';
import { createSessionWorker } from './storage-worker';

export function runtimeBuild(): WorkbenchBuild {
  const hash = crypto.createHash('sha256');
  const root = path.resolve(__dirname, '../..');
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['node_modules', 'types', 'rust-simconnect-sidecar'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(js|json)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
        hash.update(path.relative(root, file).replace(/\\/g, '/'));
        hash.update(fs.readFileSync(file));
      }
    }
  }
  visit(root);
  return { appVersion: getAppVersion() || 'unknown', runtimeFingerprint: hash.digest('hex'), instanceId: crypto.randomUUID() };
}

export function createWorkbenchService({ root, wsPort, build = runtimeBuild(),
  reportLoader = loadRuntimeReport, profileList = listSupportProfiles, captureRunner = captureSession,
  getLoadedAircraft = () => {
    const loader = require('../aircraft-profile-loader');
    return { profileKey: loader.getActiveProfileId(), title: loader.getLastDetectedTitle(), revision: loader.getActiveProfileRevision() };
  },
}: {
  root: string; wsPort: number; build?: WorkbenchBuild;
  reportLoader?: typeof loadRuntimeReport; profileList?: typeof listSupportProfiles;
  captureRunner?: typeof captureSession; getLoadedAircraft?: () => any;
}) {
  const store = createSessionWorker(root);
  const reports = new Map<string, ReturnType<typeof loadRuntimeReport>>();
  let active: { sessionId: string; caseId: string; startedAt: string; seconds: number; controller: AbortController;
    markers: { label: string; recordedAt: string }[] } | null = null;
  let lastJob: { sessionId: string; error: string | null } | null = null;
  let job: Promise<void> | null = null;
  let closed = false;
  function report(key: string) {
    if (!reports.has(key)) reports.set(key, reportLoader(key));
    return reports.get(key)!;
  }
  function compatibility(session) {
    let current: ReturnType<typeof loadRuntimeReport>;
    try { current = report(session.report.contract.profileKey); }
    catch { return { matches: false, build, contractHash: null, reason: 'This aircraft inventory is no longer available in the running app.' }; }
    return { matches: current.contractHash === session.report.contractHash
      && session.build.runtimeFingerprint === build.runtimeFingerprint && session.build.appVersion === build.appVersion,
    build, contractHash: current.contractHash };
  }
  function status(id: string) {
    return { active: active?.sessionId === id ? {
      caseId: active.caseId, startedAt: active.startedAt, seconds: active.seconds, markerCount: active.markers.length,
    } : null, busy: !!active, error: lastJob?.sessionId === id ? lastJob.error : null };
  }
  async function read(id: string) {
    const session = await store.call('read', id);
    return { session, compatibility: compatibility(session), captureStatus: status(id) };
  }
  async function handle(method: string, parts: string[], query: URLSearchParams, input: any = {}) {
    if (closed) throw new WorkbenchError('Workbench is closing.', 503);
    if (method === 'GET' && parts.join('/') === 'catalogue') {
      return { profiles: profileList(), build, loadedAircraft: getLoadedAircraft() };
    }
    if (method === 'GET' && parts.join('/') === 'report') {
      const value = report(boundedText(query.get('profile'), 'Aircraft profile'));
      return { report: value, plan: guidedPlan(value), build };
    }
    if (method === 'POST' && parts.join('/') === 'storage/delete') {
      const file = storedFileIdentity(input.name);
      if (active?.sessionId === file.sessionId) throw new WorkbenchError('Stop the capture before deleting its saved files.', 409);
      return store.call('remove', input.name, input.version);
    }
    if (parts[0] !== 'sessions') throw new WorkbenchError('Workbench endpoint not found.', 404);
    if (parts.length === 1) {
      if (method === 'GET') return store.call('list');
      if (method === 'POST') {
        if (active) throw new WorkbenchError('Stop the capture before creating another session.', 409);
        return read((await store.call('create', report(boundedText(input.profileKey, 'Aircraft profile')), build, input)).id);
      }
    }
    const id = parts[1];
    if (parts.length === 2 && method === 'GET') return read(id);
    if (parts.length === 3 && parts[2] === 'capture' && method === 'GET') return { captureStatus: status(id) };
    if (parts.length === 3 && parts[2] === 'results' && method === 'POST') {
      const session = await store.call('read', id);
      if (!compatibility(session).matches) throw new WorkbenchError('The running app has changed. Start a new session for this build.', 409);
      if (active) throw new WorkbenchError('Stop the capture before saving a result.', 409);
      await store.call('recordAttempt', id, input);
      return read(id);
    }
    if (parts.length === 3 && parts[2] === 'capture' && method === 'POST') {
      if (active) throw new WorkbenchError('Another capture is already running.', 409);
      const session = await store.call('read', id);
      if (session.revision !== input.revision) throw new WorkbenchError('Session changed. Reload before starting capture.', 409);
      if (!compatibility(session).matches) throw new WorkbenchError('The running app has changed. Start a new session for this build.', 409);
      const testCase = session.plan.cases.find(item => item.id === input.caseId);
      if (!testCase) throw new WorkbenchError('Unknown test case.');
      const fields = testCase.observationFields.filter(fieldId => session.report.contract.fields.some(field => field.id === fieldId));
      if (!fields.length) throw new WorkbenchError('This test has no published capture readings. Record a manual observation.');
      if (fields.length > 64) throw new WorkbenchError('This test exceeds the capture field limit. Use a narrower test.');
      const loaded = getLoadedAircraft();
      if (loaded.profileKey !== session.report.contract.profileKey) throw new WorkbenchError('Load the session aircraft in the simulator before capturing.');
      const seconds = input.seconds ?? 20;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new WorkbenchError('Capture duration must be 1–120 seconds.');
      const condition = boundedText(input.condition, 'Starting state');
      await store.call('captureCapacity');
      if (closed) throw new WorkbenchError('Workbench is closing.', 503);
      active = { sessionId: id, caseId: testCase.id, startedAt: new Date().toISOString(), seconds, controller: new AbortController(), markers: [] };
      lastJob = { sessionId: id, error: null };
      const controller = active.controller;
      const markers = active.markers;
      job = Promise.resolve().then(() => captureRunner({ report: session.report, fieldIds: fields,
        ...session.environment, condition, durationMs: seconds * 1000,
        url: `ws://127.0.0.1:${wsPort}`, signal: controller.signal,
      })).then(async capture => { await store.call('addCapture', id, testCase.id, { ...capture, markers }, build); })
        .catch(error => { lastJob = { sessionId: id, error: `Capture could not be saved: ${error.message}` }; })
        .finally(() => { active = null; job = null; });
      return { captureStatus: status(id) };
    }
    if (parts.length === 4 && parts[2] === 'capture' && parts[3] === 'marker' && method === 'POST') {
      if (active?.sessionId !== id) throw new WorkbenchError('There is no active capture for this session.', 409);
      if (active.markers.length >= 100) throw new WorkbenchError('This capture has reached the 100-marker limit.');
      active.markers.push({ label: boundedText(input.label, 'Step description'), recordedAt: new Date().toISOString() });
      return { captureStatus: status(id) };
    }
    if (parts.length === 4 && parts[2] === 'capture' && parts[3] === 'stop' && method === 'POST') {
      if (active?.sessionId === id) { active.controller.abort(); await job; }
      return read(id);
    }
    throw new WorkbenchError('Workbench endpoint not found.', 404);
  }
  // Async storage must not let two capture starts or a delete/start pair pass
  // their state checks concurrently. Keep requests ordered without blocking I/O.
  let requests: Promise<unknown> = Promise.resolve();
  let pendingRequests = 0;
  function enqueue(...args: Parameters<typeof handle>) {
    if (closed) return Promise.reject(new WorkbenchError('Workbench is closing.', 503));
    if (pendingRequests >= 32) return Promise.reject(new WorkbenchError('Workbench is busy. Try again shortly.', 429));
    pendingRequests++;
    const next = requests.then(() => handle(...args));
    requests = next.then(() => {}, () => {}).finally(() => { pendingRequests--; });
    return next;
  }
  async function close() {
    closed = true;
    active?.controller.abort();
    await requests;
    await job;
    await store.close();
  }
  return { handle: enqueue, close };
}
