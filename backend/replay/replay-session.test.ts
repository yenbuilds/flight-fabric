import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createReplaySession } from './replay-session';

function fixture(t: any, overrides: any = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-replay-session-'));
  const worker: any = new EventEmitter();
  worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
  const commands: any[] = [];
  worker.stdin.on('data', chunk => commands.push(JSON.parse(chunk.toString())));
  const calls: string[] = [];
  const messages: any[] = [];
  const service = createReplaySession({ directory, enabled: true,
    prepareClip: async () => ({ success: true, clip: { title: 'FenixA320 CFM SL', profileId: 'fenix-a320', durationMs: 120000, touchdownMs: 90000, samples: [] } }),
    suspend: async () => { calls.push('suspend'); }, resume: async () => { calls.push('resume'); },
    entryBlocker: () => '', publish: message => messages.push(message),
    launch: async () => { calls.push('launch'); return worker; }, ...overrides });
  const request = (operation: string, extra: any = {}, privileged = true) => service.request({ operation, session: service.snapshot().session, ...extra }, privileged);
  const emit = (message: any) => worker.stdout.write(JSON.stringify({ session: service.snapshot().session, ...message }) + '\n');
  t.after(() => { service.stop(); worker.stdin.destroy(); worker.stdout.destroy(); worker.stderr.destroy(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, request, emit, worker, calls, commands, directory, messages };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('replay is limited to desktop/toolbar authorization and never exports local clip paths', () => {
  const { isClientMessageAuthorized } = require('../core/client-message-authorization');
  const { projectServerMessageForClient } = require('../core/server-message-projection');
  assert.equal(isClientMessageAuthorized({}, 'inSimReplay'), false);
  assert.equal(isClientMessageAuthorized({ __ffAircraftControlClient: true }, 'inSimReplay'), false);
  assert.equal(isClientMessageAuthorized({ __ffPrivilegedClient: true }, 'inSimReplay'), true);
  assert.equal(isClientMessageAuthorized({ __ffToolbarPresetClient: true }, 'inSimReplay'), true);
  const message = { type: 'inSimReplayState', enabled: true, session: 'session', title: 'FenixA320 CFM SL', state: 'ready',
    filePath: 'C:\\Users\\Pilot\\private.csv', clip: { samples: [] }, error: 'C:\\Users\\Pilot\\private.csv' };
  assert.equal(projectServerMessageForClient({}, message), null);
  const toolbar = projectServerMessageForClient({ __ffToolbarPresetClient: true }, message);
  assert.equal(toolbar.title, message.title);
  assert.equal(toolbar.enabled, true);
  assert.equal(projectServerMessageForClient({ __ffToolbarPresetClient: true }, { ...message, enabled: undefined }).enabled, false);
  assert.equal(toolbar.filePath, undefined); assert.equal(toolbar.clip, undefined);
  assert.doesNotMatch(JSON.stringify(toolbar), /private\.csv/);
});

test('disabled replay rejects clip preparation and playback without touching files or the provider', async t => {
  const f = fixture(t, { enabled: undefined, prepareClip: async () => { throw new Error('Unexpected recording read'); } });
  assert.equal(f.service.snapshot().enabled, false, 'missing opt-in fails closed');
  await f.request('status');
  for (const privileged of [true, false]) {
    for (const operation of ['prepare', 'connect', 'start', 'play', 'pause', 'seek']) {
      await assert.rejects(f.request(operation, { filePath: 'flight.csv', landingIndex: 0,
        recordedAt1x: true, acceptReload: true, positionMs: 0 }, privileged), /disabled/);
    }
  }
  assert.equal(f.service.isBlocking(), false);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.commands, []);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('disabled replay preserves journal recovery and never permits another clip', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'recovery.json'), JSON.stringify({ title: 'FenixA320 CFM SL' }));
  let recovered = 0;
  const launches: Array<string | null> = [];
  const restarted = createReplaySession({ directory: f.directory, enabled: false,
    prepareClip: async () => { throw new Error('Unexpected recording read'); },
    suspend: async () => {}, resume: async () => { recovered++; }, entryBlocker: () => '', publish: () => {},
    launch: async (_session, clipPath) => { launches.push(clipPath); return f.worker; } });
  t.after(() => restarted.stop());
  const request = (operation: string) => restarted.request({ operation, session: restarted.snapshot().session }, false);
  assert.equal(restarted.isBlocking(), true); assert.equal(restarted.snapshot().enabled, false);
  await request('recover');
  assert.deepEqual(launches, [null], 'only a recovery worker can launch');
  await assert.rejects(request('start'), /disabled/);
  fs.unlinkSync(path.join(f.directory, 'recovery.json'));
  f.worker.stdout.write(JSON.stringify({ session: restarted.snapshot().session, type: 'replayStatus', state: 'done' }) + '\n');
  f.worker.emit('close', 0); await turn();
  assert.equal(recovered, 1); assert.equal(restarted.isBlocking(), false);
  await assert.rejects(request('prepare'), /disabled/);
  assert.deepEqual(f.commands, []);
});

test('preparation stays read-only; identity, confirmation, privilege and generation guard entry', async t => {
  const f = fixture(t);
  await assert.rejects(f.request('prepare', { filePath: 'flight.csv', landingIndex: 0 }, false), /client/);
  await f.request('prepare', { filePath: 'flight.csv', landingIndex: 0 });
  assert.equal(f.service.snapshot().title, 'FenixA320 CFM SL');
  assert.equal(f.service.isBlocking(), false); assert.deepEqual(f.calls, []);
  await assert.rejects(f.request('connect'), /Confirm/);
  await assert.rejects(f.request('connect', { recordedAt1x: true, acceptReload: true }, false), /client/);
  await assert.rejects(f.request('connect', { session: 'old', recordedAt1x: true, acceptReload: true }), /changed/);
  await f.request('connect', { recordedAt1x: true, acceptReload: true });
  assert.equal(f.service.isBlocking(), true); assert.deepEqual(f.calls, ['suspend', 'launch']);
  f.emit({ type: 'replayStatus', state: 'ready', positionMs: 0, detail: 'Load the aircraft' });
  await assert.rejects(f.request('start'), /Load the aircraft/);
  f.emit({ type: 'replayEligibility', readyToStart: true, loadedTitle: 'FenixA320 CFM SL', detail: 'Ready' });
  await f.request('start', {}, false);
  assert.equal(f.commands[0].type, 'start');
  await assert.rejects(f.request('seek', { positionMs: 120001 }), /within/);
  await f.request('stop', {}, false);
  assert.deepEqual(f.commands.map(command => command.type), ['start', 'stop'], 'toolbar Stop supersedes pending Start');
});

test('entry gates close synchronously, failed suspension cannot launch, recordings block handoff', async t => {
  let release: () => void = () => {};
  const f = fixture(t, { suspend: () => new Promise<void>(resolve => { release = resolve; }) });
  await f.request('prepare', { filePath: 'flight.csv', landingIndex: 0 });
  const connecting = f.request('connect', { recordedAt1x: true, acceptReload: true });
  assert.equal(f.service.isBlocking(), true);
  await assert.rejects(f.request('prepare', { filePath: 'other.csv', landingIndex: 0 }), /preparing/);
  release(); await connecting;
  const failed = fixture(t, { suspend: async () => { throw new Error('Bridge still running'); } });
  await failed.request('prepare', { filePath: 'flight.csv', landingIndex: 0 });
  await failed.request('connect', { recordedAt1x: true, acceptReload: true });
  assert.equal(failed.service.snapshot().state, 'recoveryRequired'); assert.deepEqual(failed.calls, []);
  const recording = fixture(t, { entryBlocker: () => 'Stop recording first' });
  await recording.request('prepare', { filePath: 'flight.csv', landingIndex: 0 });
  await assert.rejects(recording.request('connect', { recordedAt1x: true, acceptReload: true }), /Stop recording/);
  assert.equal(recording.service.isBlocking(), false);
});

test('native done plus clean exit and absent journal are required to resume live mode', async t => {
  const f = fixture(t);
  await f.request('prepare', { filePath: 'flight.csv', landingIndex: 0 });
  await f.request('connect', { recordedAt1x: true, acceptReload: true });
  const generation = f.service.generation();
  f.emit({ type: 'replayEligibility', readyToStart: false, loadedTitle: 'FenixA320 CFM SL' });
  assert.equal(f.service.snapshot().loadedTitle, 'FenixA320 CFM SL');
  f.emit({ type: 'replayStatus', state: 'done', positionMs: 100, detail: 'Recovered' });
  assert.equal(f.service.isBlocking(), true, 'done alone does not release live mode');
  f.worker.emit('close', 0); await turn();
  assert.equal(f.service.isBlocking(), false); assert.deepEqual(f.calls, ['suspend', 'launch', 'resume']);
  assert.notEqual(f.service.generation(), generation, 'frames acquired before handoff must be discarded');
  assert.equal(fs.readdirSync(f.directory).length, 0, 'temporary clip removed after worker close');
  await f.request('prepare', { filePath: 'another.csv', landingIndex: 0 });
  assert.equal(f.service.snapshot().loadedTitle, '', 'a new preparation never presents a previous aircraft check as current');
});

test('crash and persisted recovery keep recording/controls blocked across restart', async t => {
  const f = fixture(t);
  await f.request('prepare', { filePath: 'flight.csv', landingIndex: 0 });
  await f.request('connect', { recordedAt1x: true, acceptReload: true });
  fs.writeFileSync(path.join(f.directory, 'recovery.json'), JSON.stringify({ title: 'FenixA320 CFM SL' }));
  f.worker.emit('close', 1); await turn();
  assert.equal(f.service.isBlocking(), true); assert.equal(f.calls.includes('resume'), false);
  f.service.stop();
  let resumed = false;
  const restarted = createReplaySession({ directory: f.directory, prepareClip: async () => null,
    suspend: async () => {}, resume: async () => { resumed = true; }, entryBlocker: () => '', publish: () => {},
    launch: async () => { throw new Error('No simulator'); } });
  t.after(() => restarted.stop());
  assert.equal(restarted.isBlocking(), true); assert.equal(restarted.snapshot().title, 'FenixA320 CFM SL');
  await restarted.request({ operation: 'recover', session: restarted.snapshot().session }, false);
  assert.equal(resumed, false); assert.equal(restarted.isBlocking(), true);
});

test('malformed output closes the command pipe and never resumes a live flight', async t => {
  const f = fixture(t);
  await f.request('prepare', { filePath: 'flight.csv', landingIndex: 0 });
  await f.request('connect', { recordedAt1x: true, acceptReload: true });
  f.worker.stdout.write('not-json\n');
  assert.equal(f.worker.stdin.writableEnded, true);
  assert.equal(f.service.snapshot().state, 'recoveryRequired');
  assert.equal(f.calls.includes('resume'), false);
});
