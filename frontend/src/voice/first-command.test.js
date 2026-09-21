import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  VOICE_FIRST_COMMAND_MAX_SESSIONS,
  VOICE_FIRST_COMMAND_STORAGE_KEY,
  createFirstCommandRecord,
  firstCommandBlockReason,
  initVoiceFirstCommandRuntime,
  normalizeFirstCommandRecord,
} from './first-command.js';
import { firstVoiceCommandExample, voiceCommandExamples } from './command-examples.js';
import { useAircraftControlsStore } from '../vue/stores/aircraft-controls.js';
import { usePromptsStore } from '../vue/stores/prompts.js';
import { useVoiceControlStore } from '../vue/stores/voice-control.js';
import { useVoiceFirstCommandStore } from '../vue/stores/voice-first-command.js';

const HEADING = {
  id: 'flightGuidance.heading.set', label: 'Selected heading',
  input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
  speech: { patterns: ['set heading {value}'] },
};
const ALTITUDE = {
  id: 'flightGuidance.altitude.set', label: 'Selected altitude',
  input: { kind: 'number', min: 0, max: 50000, step: 100, units: 'feet' },
  speech: { patterns: ['set altitude {value}'] },
};
const SPEED = {
  id: 'flightGuidance.speed.set', label: 'Selected speed',
  input: { kind: 'number', min: 100, max: 399, step: 1, units: 'knots' },
  speech: { patterns: ['set speed {value}'] },
};
const SILENT = { id: 'lights.strobe.on', label: 'Strobes on', input: { kind: 'boolean' } };

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

function createWindow(pathname = '/') {
  return {
    location: { pathname },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
  };
}

function seedCatalogue(controls, commands, { enabled = true } = {}) {
  controls.applyControlCapabilities({
    aircraftCommands: {
      configurationId: 'test', profileKey: 'bundled/msfs/test', profileRevision: 1, commands,
    },
  });
  controls.setAvailability({ enabled, reason: enabled ? 'Ready.' : 'Simulator is in a menu.' });
}

test('command examples quote a heading target first for the first command, altitude first for the panel', () => {
  assert.deepEqual(firstVoiceCommandExample([SPEED, ALTITUDE, HEADING]), { commandId: HEADING.id, phrase: 'Set heading 270' });
  assert.deepEqual(firstVoiceCommandExample([SPEED, ALTITUDE]), { commandId: ALTITUDE.id, phrase: 'Set altitude 10,000' });
  const ALTITUDE_HUNDRED = {
    id: 'flightGuidance.altitudeHundred.set', label: 'Selected altitude (100-foot mode)',
    input: { kind: 'number', min: 0, max: 49000, step: 100, units: 'feet' },
    speech: { patterns: ['set altitude {value} in hundreds'] },
  };
  assert.deepEqual(firstVoiceCommandExample([ALTITUDE_HUNDRED, ALTITUDE]), { commandId: ALTITUDE.id, phrase: 'Set altitude 10,000' }, 'the plain target wins over a mode variant listed first');
  assert.deepEqual(firstVoiceCommandExample([ALTITUDE_HUNDRED]), { commandId: ALTITUDE_HUNDRED.id, phrase: 'Set altitude 10,000 in hundreds' }, 'a mode variant is still better than nothing');
  assert.deepEqual(firstVoiceCommandExample([SILENT, SPEED]), { commandId: SPEED.id, phrase: 'Set speed 250' });
  assert.equal(firstVoiceCommandExample([SILENT]), null, 'a catalogue without speech patterns offers nothing to say');
  assert.deepEqual(voiceCommandExamples([SPEED, HEADING, ALTITUDE]), ['Set altitude 10,000', 'Set speed 250', 'Set heading 270']);
});

test('first-command record normalises defensively and blocks for the right reasons', () => {
  assert.deepEqual(normalizeFirstCommandRecord(null), createFirstCommandRecord());
  assert.deepEqual(normalizeFirstCommandRecord({ completed: 'yes', muted: 1, sessionsShown: '2.7' }), {
    version: 1, completed: false, muted: false, sessionsShown: 2,
  });
  assert.equal(firstCommandBlockReason(createFirstCommandRecord()), null);
  assert.equal(firstCommandBlockReason({ ...createFirstCommandRecord(), completed: true }), 'completed');
  assert.equal(firstCommandBlockReason({ ...createFirstCommandRecord(), muted: true }), 'muted');
  assert.equal(firstCommandBlockReason({ ...createFirstCommandRecord(), sessionsShown: VOICE_FIRST_COMMAND_MAX_SESSIONS }), 'exhausted');
});

test('the card opens for a voice-capable aircraft on the desktop, withdraws when it cannot dispatch, and retires on the first sent command', async () => {
  setActivePinia(createPinia());
  const firstCommand = useVoiceFirstCommandStore();
  const voice = useVoiceControlStore();
  const controls = useAircraftControlsStore();
  const prompts = usePromptsStore();
  const status = reactive({ aircraftProfile: { profileName: 'PMDG 737-800' } });
  const storage = createStorage();
  const cleanup = initVoiceFirstCommandRuntime({
    firstCommandStore: firstCommand, voiceStore: voice, aircraftControlsStore: controls,
    statusStore: status, storage, windowRef: createWindow('/'), settleMs: 0,
  });
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'nothing shows before the desktop bridge and an aircraft are known');
  assert.ok(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY), 'the record is written on first sight');

  seedCatalogue(controls, [SPEED, HEADING]);
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'a browser without the voice bridge never asks');

  voice.setBridgeAvailable(true);
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'try');
  assert.equal(firstCommand.prompt.example, 'Set heading 270');
  assert.equal(firstCommand.prompt.aircraftName, 'PMDG 737-800');
  assert.equal(prompts.current, 'voice-first-command', 'the card holds the shared prompt slot');
  assert.equal(JSON.parse(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).sessionsShown, 1, 'showing spends one session');

  controls.setAvailability({ enabled: false, reason: 'Simulator is in a menu.' });
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'the card withdraws while nothing can dispatch');
  assert.equal(prompts.current, null);

  controls.setAvailability({ enabled: true, reason: 'Ready.' });
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'try', 'and comes back when dispatch is possible again');
  assert.equal(JSON.parse(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).sessionsShown, 1, 'without spending another session');

  voice.setState('sent', 'Sent selected heading.');
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'done', 'a sent command moves the open card to its done stage');
  assert.equal(JSON.parse(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).completed, true);

  controls.setAvailability({ enabled: false, reason: 'Simulator is in a menu.' });
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'done', 'the done stage is never withdrawn by sim state');

  firstCommand.dismiss();
  assert.equal(prompts.current, null);
  cleanup();

  // A later session with the completed record never asks again.
  setActivePinia(createPinia());
  const laterCard = useVoiceFirstCommandStore();
  const laterVoice = useVoiceControlStore();
  const laterControls = useAircraftControlsStore();
  laterVoice.setBridgeAvailable(true);
  seedCatalogue(laterControls, [HEADING]);
  const cleanupLater = initVoiceFirstCommandRuntime({
    firstCommandStore: laterCard, voiceStore: laterVoice, aircraftControlsStore: laterControls,
    statusStore: status, storage, windowRef: createWindow('/'), settleMs: 0,
  });
  await nextTick();
  assert.equal(laterCard.prompt, null, 'one sent command retires the card for good');
  assert.equal(laterCard.blockReason, 'completed');
  cleanupLater();
});

test('not now hides the card for the session, do not show again for good, and the phone never sees it', async () => {
  setActivePinia(createPinia());
  const firstCommand = useVoiceFirstCommandStore();
  const voice = useVoiceControlStore();
  const controls = useAircraftControlsStore();
  const storage = createStorage();
  voice.setBridgeAvailable(true);
  seedCatalogue(controls, [ALTITUDE]);
  const cleanup = initVoiceFirstCommandRuntime({
    firstCommandStore: firstCommand, voiceStore: voice, aircraftControlsStore: controls,
    storage, windowRef: createWindow('/'), settleMs: 0,
  });
  await nextTick();
  assert.equal(firstCommand.prompt?.example, 'Set altitude 10,000');
  assert.equal(firstCommand.prompt.aircraftName, '', 'no status store means no aircraft name, not a crash');

  firstCommand.dismiss();
  await nextTick();
  assert.equal(firstCommand.prompt, null);
  seedCatalogue(controls, [HEADING]);
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'a new aircraft in the same session does not bring a dismissed card back');
  assert.equal(JSON.parse(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).muted, false, 'not now is not a mute');
  cleanup();

  // Next session: shows again until the session budget is spent.
  for (let session = 2; session <= VOICE_FIRST_COMMAND_MAX_SESSIONS + 1; session += 1) {
    setActivePinia(createPinia());
    const card = useVoiceFirstCommandStore();
    const sessionVoice = useVoiceControlStore();
    const sessionControls = useAircraftControlsStore();
    sessionVoice.setBridgeAvailable(true);
    seedCatalogue(sessionControls, [HEADING]);
    const cleanupSession = initVoiceFirstCommandRuntime({
      firstCommandStore: card, voiceStore: sessionVoice, aircraftControlsStore: sessionControls,
      storage, windowRef: createWindow('/'), settleMs: 0,
    });
    await nextTick();
    if (session <= VOICE_FIRST_COMMAND_MAX_SESSIONS) {
      assert.equal(card.prompt?.stage, 'try', `session ${session} still asks`);
      card.dismiss();
    } else {
      assert.equal(card.prompt, null, 'the budget is spent after three sessions of not now');
      assert.equal(card.blockReason, 'exhausted');
    }
    cleanupSession();
  }

  // Mute persists.
  setActivePinia(createPinia());
  const muteStorage = createStorage();
  const muteCard = useVoiceFirstCommandStore();
  const muteVoice = useVoiceControlStore();
  const muteControls = useAircraftControlsStore();
  muteVoice.setBridgeAvailable(true);
  seedCatalogue(muteControls, [HEADING]);
  const cleanupMute = initVoiceFirstCommandRuntime({
    firstCommandStore: muteCard, voiceStore: muteVoice, aircraftControlsStore: muteControls,
    storage: muteStorage, windowRef: createWindow('/'), settleMs: 0,
  });
  await nextTick();
  muteCard.mute();
  assert.equal(JSON.parse(muteStorage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).muted, true, 'mute is persisted the moment it is chosen');
  cleanupMute();

  // Remote view: record kept honest, card never requested.
  setActivePinia(createPinia());
  const phoneCard = useVoiceFirstCommandStore();
  const phoneVoice = useVoiceControlStore();
  const phoneControls = useAircraftControlsStore();
  const phonePrompts = usePromptsStore();
  phoneVoice.setBridgeAvailable(true);
  seedCatalogue(phoneControls, [HEADING]);
  const phoneStorage = createStorage();
  const cleanupPhone = initVoiceFirstCommandRuntime({
    firstCommandStore: phoneCard, voiceStore: phoneVoice, aircraftControlsStore: phoneControls,
    storage: phoneStorage, windowRef: createWindow('/remote'), settleMs: 0,
  });
  await nextTick();
  assert.equal(phoneCard.prompt, null);
  assert.equal(phonePrompts.current, null);
  cleanupPhone();
});

test('the card steps aside for any other prompt card and comes back when that card is gone', async () => {
  setActivePinia(createPinia());
  const firstCommand = useVoiceFirstCommandStore();
  const voice = useVoiceControlStore();
  const controls = useAircraftControlsStore();
  const prompts = usePromptsStore();
  const storage = createStorage();
  voice.setBridgeAvailable(true);
  seedCatalogue(controls, [HEADING]);
  prompts.request('whats-new');
  const cleanup = initVoiceFirstCommandRuntime({
    firstCommandStore: firstCommand, voiceStore: voice, aircraftControlsStore: controls, promptsStore: prompts,
    storage, windowRef: createWindow('/'), settleMs: 0,
  });
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'a card already waiting keeps the first-command card away');
  assert.equal(JSON.parse(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).sessionsShown, 0, 'and no session is spent');

  prompts.release('whats-new');
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'try', 'the card opens once the slot is free');
  assert.equal(prompts.current, 'voice-first-command');

  prompts.request('support');
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'a later card takes the slot; this one withdraws rather than queueing it');
  assert.equal(prompts.current, 'support', 'the other card shows immediately');

  prompts.release('support');
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'try', 'and the card returns afterwards');
  assert.equal(JSON.parse(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).sessionsShown, 1, 'still one session');

  // A capability replay that keeps the profile key but drops the spoken
  // commands must still be noticed.
  controls.applyControlCapabilities({
    aircraftCommands: { configurationId: 'test', profileKey: 'bundled/msfs/test', profileRevision: 1, commands: [SILENT] },
  });
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'no spoken command, no card, even under the same profile key');
  seedCatalogue(controls, [HEADING]);
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'try');
  cleanup();
});

test('catalogue flicker waits out the settle delay, but another card is never made to wait', async () => {
  setActivePinia(createPinia());
  const firstCommand = useVoiceFirstCommandStore();
  const voice = useVoiceControlStore();
  const controls = useAircraftControlsStore();
  const prompts = usePromptsStore();
  const timers = new Map();
  let timerId = 0;
  const windowRef = {
    location: { pathname: '/' },
    setTimeout: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const fireTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
  voice.setBridgeAvailable(true);
  seedCatalogue(controls, [HEADING]);
  const cleanup = initVoiceFirstCommandRuntime({
    firstCommandStore: firstCommand, voiceStore: voice, aircraftControlsStore: controls, promptsStore: prompts,
    storage: createStorage(), windowRef, settleMs: 1500,
  });
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'nothing opens before the catalogue settles');
  assert.ok([...timers.values()].some((timer) => timer.ms === 1500), 'a settle timer is armed');
  fireTimers();
  assert.equal(firstCommand.prompt?.stage, 'try');

  // A replay that briefly empties the catalogue and refills it before the
  // timer fires never withdraws the card.
  controls.applyControlCapabilities({ aircraftCommands: { configurationId: 'test', profileKey: 'bundled/msfs/test', profileRevision: 1, commands: [] } });
  await nextTick();
  seedCatalogue(controls, [HEADING]);
  await nextTick();
  assert.equal(firstCommand.prompt?.stage, 'try', 'still open while the replay settles');
  fireTimers();
  assert.equal(firstCommand.prompt?.stage, 'try', 'and still open once it has');

  prompts.request('support');
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'another card takes the slot at once, not after the settle delay');
  assert.equal(prompts.current, 'support');
  cleanup();
});

test('a sent command that arrives before the card ever showed retires it silently', async () => {
  setActivePinia(createPinia());
  const firstCommand = useVoiceFirstCommandStore();
  const voice = useVoiceControlStore();
  const controls = useAircraftControlsStore();
  const storage = createStorage();
  const cleanup = initVoiceFirstCommandRuntime({
    firstCommandStore: firstCommand, voiceStore: voice, aircraftControlsStore: controls,
    storage, windowRef: createWindow('/'), settleMs: 0,
  });
  voice.setState('sent', 'Sent selected altitude.');
  await nextTick();
  assert.equal(firstCommand.prompt, null);
  assert.equal(JSON.parse(storage.getItem(VOICE_FIRST_COMMAND_STORAGE_KEY)).completed, true);
  voice.setBridgeAvailable(true);
  seedCatalogue(controls, [HEADING]);
  await nextTick();
  assert.equal(firstCommand.prompt, null, 'somebody who already uses voice is never asked to try it');
  cleanup();
});
