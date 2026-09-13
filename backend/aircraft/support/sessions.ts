const fs = require('node:fs') as typeof import('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { assertReport, buildValidationPlan } from './inventory';

export const MAX_SESSION_BYTES = 32 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 256 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type WorkbenchBuild = { appVersion: string; runtimeFingerprint: string; instanceId: string };
export type TestOutcome = 'not-run' | 'pass' | 'fail' | 'blocked';
type JsonRecord = Record<string, any>;

export function storedFileIdentity(name: string) {
  if (typeof name !== 'string') throw new WorkbenchError('Invalid storage filename.');
  const parts = name.split('.');
  if (!UUID.test(parts[0])) throw new WorkbenchError('Invalid storage filename.');
  const kind = parts.length === 2 && parts[1] === 'json' ? 'session'
    : parts.length === 4 && UUID.test(parts[1]) && parts[2] === 'capture' && parts[3] === 'json' ? 'recovery'
      : parts.length === 3 && UUID.test(parts[1]) && parts[2] === 'tmp' ? 'temporary' : null;
  if (!kind) throw new WorkbenchError('Invalid storage filename.');
  return { sessionId: parts[0], kind };
}

export class WorkbenchError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function boundedText(value: unknown, name: string, max = 240, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new WorkbenchError(`${name} must be ${required ? '1' : '0'}–${max} characters.`);
  }
  return value.trim();
}

export function readableName(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ')
    .replace(/\b(apu|irs|atc|efis|mcp|fcu|nav|com)\b/gi, word => word.toUpperCase())
    .replace(/^./, letter => letter.toUpperCase());
}

export function guidedPlan(report: any) {
  const plan = buildValidationPlan(report);
  return { ...plan, cases: plan.cases.map(item => {
    const action = report.contract.actions.find(action => action.id === item.actionId);
    const commands = report.contract.commands.filter(command => item.commandIds.includes(command.id));
    const prefix = item.actionId.split('.');
    const groupId = prefix[0] === 'systems' ? prefix[1] : prefix[0];
    return { ...item, label: action?.label || readableName(item.actionId), group: readableName(groupId),
      voicePatterns: [...new Set(commands.flatMap(command => command.speech?.patterns || []))],
      steps: [
        'Use a separate simulator test flight. Operating controls changes the aircraft; stopping capture does not undo those changes.',
        'Prepare the aircraft for this control and record its starting state below.',
        'Start a capture if readings are available, then operate the control through Flight Fabric. Record the input or voice phrase used.',
        'Check the actual cockpit response and compare it with the live readings. Repeat with an already-set target where appropriate.',
        'Stop capture and record what happened. A completed capture does not establish a passing test.',
      ],
    };
  }) };
}

// Production callers use storage-worker.ts so file I/O and JSON processing run
// outside the simulator backend's event loop. One worker serializes all writes.
export function createSessionStore(root: string, maxStorageBytes = MAX_STORAGE_BYTES) {
  const directory = path.resolve(root);
  const summaries = new Map<string, { version: string; value: JsonRecord }>();
  function ensureRoot() {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new WorkbenchError('Session folder must not be a link.');
  }
  function filename(id: string) {
    if (!UUID.test(id)) throw new WorkbenchError('Invalid session ID.');
    return path.join(directory, `${id}.json`);
  }
  function fileVersion(stat: import('node:fs').Stats) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }
  function storage() {
    ensureRoot();
    let usedBytes = 0;
    const files = [];
    for (const name of fs.readdirSync(directory)) {
      const stat = fs.lstatSync(path.join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      usedBytes += stat.size;
      try { files.push({ name, bytes: stat.size, version: fileVersion(stat), ...storedFileIdentity(name) }); }
      catch { /* Unknown files count toward the budget but cannot be deleted here. */ }
    }
    return { usedBytes, maxBytes: maxStorageBytes, files };
  }
  function requireSpace(bytes: number) {
    if (storage().usedBytes + bytes > maxStorageBytes) {
      throw new WorkbenchError('Not enough free Aircraft Support storage. Export files you want to keep, then use Manage saved files to free space.', 507);
    }
  }
  function captureCapacity() {
    // Leave room for the largest capture and an atomic session replacement.
    requireSpace(MAX_SESSION_BYTES * 2);
  }
  function read(id: string): JsonRecord {
    ensureRoot();
    const file = filename(id);
    if (!fs.existsSync(file)) throw new WorkbenchError('Session not found.', 404);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_BYTES) throw new WorkbenchError('Invalid session file.');
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (session.kind !== 'aircraft-support-session' || session.schemaVersion !== 1 || session.id !== id
      || !Number.isSafeInteger(session.revision) || !Array.isArray(session.attempts) || !Array.isArray(session.captures)) {
      throw new WorkbenchError('Invalid session data.');
    }
    assertReport(session.report);
    return session;
  }
  function save(session: JsonRecord, create = false) {
    ensureRoot();
    const body = JSON.stringify(session, null, 2) + '\n';
    if (Buffer.byteLength(body) > MAX_SESSION_BYTES) throw new WorkbenchError('This session is full. Start a new session.');
    // Include the temporary replacement file in the total storage budget.
    requireSpace(Buffer.byteLength(body));
    const file = filename(session.id);
    if (create) fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
    else {
      const temporary = path.join(directory, `${session.id}.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    return session;
  }
  function summary(session: JsonRecord) {
    const latest = new Map(session.attempts.map(item => [item.caseId, item.result]));
    const counts = { pass: 0, fail: 0, blocked: 0, 'not-run': 0 };
    for (const item of session.plan.cases) counts[String(latest.get(item.id) || 'not-run')]++;
    return { id: session.id, revision: session.revision, title: session.title, profileKey: session.report.contract.profileKey,
      profileName: session.report.profileName, environment: session.environment, createdAt: session.createdAt,
      updatedAt: session.updatedAt, counts, captureCount: session.captures.length };
  }
  function list() {
    const usage = storage();
    const sessions = [], unreadable = [];
    const present = new Set(usage.files.map(file => file.name));
    for (const name of summaries.keys()) if (!present.has(name)) summaries.delete(name);
    for (const file of usage.files.filter(file => file.kind === 'session')) {
      try {
        const cached = summaries.get(file.name);
        const value = cached?.version === file.version ? cached.value : summary(read(file.sessionId));
        summaries.set(file.name, { version: file.version, value });
        sessions.push(value);
        file.title = value.title;
      } catch { unreadable.push(file.name); }
    }
    return { sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), unreadableCount: unreadable.length, storage: usage };
  }
  function remove(name: string, version: string) {
    storedFileIdentity(name);
    ensureRoot();
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) throw new WorkbenchError('Saved file not found. Refresh the list.', 404);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkbenchError('Saved file must not be a link or directory.');
    if (fileVersion(stat) !== version) throw new WorkbenchError('Saved file changed. Refresh the list before deleting it.', 409);
    fs.unlinkSync(file);
    summaries.delete(name);
    return list();
  }
  function create(report: any, build: WorkbenchBuild, input: JsonRecord) {
    assertReport(report);
    ensureRoot();
    if (fs.readdirSync(directory).filter(file => file.endsWith('.json')).length >= 500) {
      throw new WorkbenchError('Session limit reached. Archive older session files before starting another.');
    }
    const at = new Date().toISOString();
    return save({ schemaVersion: 1, kind: 'aircraft-support-session', id: crypto.randomUUID(), revision: 1,
      title: boundedText(input.title || `${report.profileName} test`, 'Session name', 120), createdAt: at, updatedAt: at,
      environment: {
        aircraftVersion: boundedText(input.aircraftVersion, 'Aircraft version'),
        simulatorVersion: boundedText(input.simulatorVersion, 'Simulator version'),
        aircraftVariant: boundedText(input.aircraftVariant, 'Aircraft variant'),
        versionSource: 'operator-supplied',
      }, build, report, plan: guidedPlan(report), attempts: [], captures: [],
      verification: 'Tester observations only; no automatic compatibility promotion.',
    }, true);
  }
  function recordAttempt(id: string, input: JsonRecord) {
    const session = read(id);
    if (input.revision !== session.revision) throw new WorkbenchError('Session changed. Reload it before saving your result.', 409);
    if (!session.plan.cases.some(item => item.id === input.caseId)) throw new WorkbenchError('Unknown test case.');
    if (!['not-run', 'pass', 'fail', 'blocked'].includes(input.result)) throw new WorkbenchError('Choose a valid result.');
    const observed = boundedText(input.cockpitObservation ?? '', 'Cockpit observation', 2000, input.result !== 'not-run');
    const startingState = boundedText(input.startingState ?? '', 'Starting state', 1000, input.result === 'pass' || input.result === 'fail');
    const inputUsed = boundedText(input.inputUsed ?? '', 'Input or voice phrase', 500, input.result === 'pass' || input.result === 'fail');
    const captureId = input.captureId || null;
    if (captureId && !session.captures.some(item => item.id === captureId && item.caseId === input.caseId)) {
      throw new WorkbenchError('Capture does not belong to this test case.');
    }
    if (session.attempts.length >= 5000) throw new WorkbenchError('This session is full. Start a new session.');
    session.attempts.push({ id: crypto.randomUUID(), caseId: input.caseId, result: input.result,
      startingState, inputUsed, cockpitObservation: observed, captureId, recordedAt: new Date().toISOString(),
      evidenceSource: 'operator-observation' });
    session.revision++;
    session.updatedAt = new Date().toISOString();
    return save(session);
  }
  function addCapture(id: string, caseId: string, capture: any, build: WorkbenchBuild) {
    const session = read(id);
    if (!session.plan.cases.some(item => item.id === caseId) || capture.profileKey !== session.report.contract.profileKey
      || capture.referenceContractHash !== session.report.contractHash) throw new WorkbenchError('Capture identity does not match this session.');
    const entry = { id: crypto.randomUUID(), caseId, build, capture };
    session.captures.push(entry);
    session.revision++;
    session.updatedAt = new Date().toISOString();
    try { return save(session); }
    catch (error) {
      // Preserve a completed observation if the session size limit or an atomic
      // replacement failure prevents attachment. Never overwrite another capture.
      const recoveryFile = `${id}.${entry.id}.capture.json`;
      try {
        const body = JSON.stringify(entry, null, 2) + '\n';
        if (Buffer.byteLength(body) > MAX_SESSION_BYTES) throw new WorkbenchError('Capture exceeds the file size limit.');
        requireSpace(Buffer.byteLength(body));
        fs.writeFileSync(path.join(directory, recoveryFile), body, { flag: 'wx', mode: 0o600 });
      } catch { throw new WorkbenchError('Capture could not be stored. Free space in Manage saved files and check disk space and folder permissions.', 507); }
      throw new WorkbenchError(`Capture preserved as ${recoveryFile} in Aircraft Support, but could not be attached: ${error.message}`, 500);
    }
  }
  return { list, read, create, recordAttempt, addCapture, summary, remove, captureCapacity };
}
