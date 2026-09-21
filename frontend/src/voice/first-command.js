// The "try one voice command" card: rules for when it may show, and the
// runtime that decides when to evaluate them. The card itself is a prompt
// card like what's-new and the support ask; the store owns its stages.
import { watch } from 'vue';
import { readStorageJson, writeStorageJson } from '../app/browser-environment.js';
import { isRemoteViewPath } from '../app/remote-view.js';
import { firstVoiceCommandExample } from './command-examples.js';

export const VOICE_FIRST_COMMAND_STORAGE_KEY = 'ff_voice_first_command_v1';
// Three sessions of "Not now" is the answer; after that only "Don't show
// again" would have been more explicit.
export const VOICE_FIRST_COMMAND_MAX_SESSIONS = 3;
// Capability replays can drop every voice command for a moment; the card
// waits for the catalogue to settle so it never flickers in and out.
const VOICE_FIRST_COMMAND_SETTLE_MS = 1500;

export function createFirstCommandRecord() {
  return { version: 1, completed: false, muted: false, sessionsShown: 0 };
}

export function normalizeFirstCommandRecord(raw) {
  const record = createFirstCommandRecord();
  if (!raw || typeof raw !== 'object') return record;
  record.completed = raw.completed === true;
  record.muted = raw.muted === true;
  const shown = Number(raw.sessionsShown);
  record.sessionsShown = Number.isFinite(shown) && shown > 0 ? Math.min(Math.floor(shown), 1000) : 0;
  return record;
}

export function firstCommandBlockReason(record) {
  if (!record || typeof record !== 'object') return 'no-record';
  if (record.completed) return 'completed';
  if (record.muted) return 'muted';
  if (record.sessionsShown >= VOICE_FIRST_COMMAND_MAX_SESSIONS) return 'exhausted';
  return null;
}

export const VOICE_FIRST_COMMAND_PROMPT_ID = 'voice-first-command';

export function initVoiceFirstCommandRuntime({
  firstCommandStore = null,
  voiceStore = null,
  aircraftControlsStore = null,
  statusStore = null,
  promptsStore = null,
  storage = null,
  windowRef = window,
  settleMs = VOICE_FIRST_COMMAND_SETTLE_MS,
} = {}) {
  if (!firstCommandStore || !voiceStore || !aircraftControlsStore) {
    throw new Error('The first-command runtime needs the first-command, voice and aircraft-controls stores');
  }
  const cleanupFns = [];
  const remoteView = isRemoteViewPath(windowRef?.location?.pathname);

  firstCommandStore.hydrate(readStorageJson(VOICE_FIRST_COMMAND_STORAGE_KEY, { storage, fallback: null }));
  writeStorageJson(VOICE_FIRST_COMMAND_STORAGE_KEY, firstCommandStore.serialize(), { storage });

  // Persist synchronously: a mute or a completed first command must survive
  // an immediate window close.
  cleanupFns.push(watch(
    () => firstCommandStore.record,
    () => writeStorageJson(VOICE_FIRST_COMMAND_STORAGE_KEY, firstCommandStore.serialize(), { storage }),
    { deep: true, flush: 'sync' },
  ));

  function cleanup() {
    while (cleanupFns.length > 0) {
      try { cleanupFns.pop()(); } catch {}
    }
  }

  // Voice only exists in the desktop app; a phone never asks.
  if (remoteView) return cleanup;

  // A command sent by any route counts, whether or not the card ever showed:
  // somebody who found voice on their own is not a beginner.
  cleanupFns.push(watch(
    () => voiceStore.status,
    (status) => {
      if (status === 'sent') firstCommandStore.markCompleted();
    },
  ));

  function context() {
    const commands = Object.values(aircraftControlsStore.aircraftCommandCatalogue?.commands || {});
    const example = firstVoiceCommandExample(commands);
    const aircraftName = String(statusStore?.aircraftProfile?.profileName || '').trim();
    return { example: example?.phrase || '', aircraftName };
  }

  // Every other card (what's new, a support ask) is
  // one-shot; this one can come back, so it steps aside for any of them.
  function anotherCardWaiting() {
    const queue = Array.isArray(promptsStore?.queue) ? promptsStore.queue : [];
    return queue.some((id) => id !== VOICE_FIRST_COMMAND_PROMPT_ID);
  }

  function evaluate() {
    if (firstCommandStore.prompt?.stage === 'done') return;
    const ready = voiceStore.bridgeAvailable === true
      && aircraftControlsStore.availability?.enabled === true;
    const { example, aircraftName } = context();
    if (!ready || !example || anotherCardWaiting()) {
      firstCommandStore.withdraw();
      return;
    }
    if (firstCommandStore.prompt) {
      firstCommandStore.updateContext({ example, aircraftName });
      return;
    }
    firstCommandStore.open({ example, aircraftName });
  }

  let settleTimer = null;
  function scheduleEvaluate() {
    if (settleTimer != null) windowRef.clearTimeout?.(settleTimer);
    // Another card must not wait out the settle delay behind this one.
    if (!settleMs || anotherCardWaiting()) {
      settleTimer = null;
      evaluate();
      return;
    }
    settleTimer = windowRef.setTimeout?.(() => {
      settleTimer = null;
      evaluate();
    }, settleMs) ?? null;
  }

  // The catalogue object is replaced on every capability replay, including
  // ones that keep the profile key, so it is watched by identity.
  cleanupFns.push(watch(
    () => [
      voiceStore.bridgeAvailable,
      aircraftControlsStore.availability?.enabled,
      aircraftControlsStore.aircraftCommandCatalogue,
      statusStore?.aircraftProfile?.profileName,
      firstCommandStore.eligible,
      promptsStore?.queue,
    ],
    scheduleEvaluate,
    { immediate: true },
  ));

  return () => {
    if (settleTimer != null) windowRef.clearTimeout?.(settleTimer);
    settleTimer = null;
    cleanup();
  };
}
