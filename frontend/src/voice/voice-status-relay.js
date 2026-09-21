import { watch } from 'vue';
import { describeJoystickBinding } from './joystick-binding.js';

// Voice control runs only in the desktop app. Views that cannot run it, such
// as the MSFS toolbar panel, still need to know whether push-to-talk is
// listening and what happened to the last phrase, so the desktop app relays
// a bounded status summary to the backend, which stores and re-broadcasts it.

const MAX_TEXT = 400;
const MAX_COMMAND = 240;

export function voiceStatusSnapshot(voiceStore, aircraftControlsStore = null) {
  const runtime = voiceStore?.runtime || {};
  return {
    type: 'voiceStatus',
    status: String(voiceStore?.status || 'unknown'),
    statusText: String(voiceStore?.statusText || '').slice(0, MAX_TEXT),
    transcript: String(voiceStore?.transcript || '').slice(0, MAX_TEXT),
    lastCommand: String(voiceStore?.lastCommand || '').slice(0, MAX_COMMAND),
    shortcut: String(runtime.shortcut || ''),
    joystick: describeJoystickBinding(runtime.joystick),
    enabled: runtime.enabled === true,
    available: voiceStore?.bridgeAvailable === true && runtime.available === true,
    profileKey: String(aircraftControlsStore?.aircraftCommandCatalogue?.profileKey || ''),
  };
}

/**
 * Publish the voice status whenever it changes, and again on demand after a
 * reconnect. `send` returns false when the socket is not open; the next
 * change or resync retries. Only the desktop voice bridge relays: browser
 * sessions have no voice runtime and no privilege to relay one.
 */
export function createVoiceStatusRelay({
  voiceStore,
  aircraftControlsStore = null,
  send,
  watchRef = watch,
} = {}) {
  if (!voiceStore || typeof send !== 'function') {
    throw new TypeError('createVoiceStatusRelay requires voiceStore and send');
  }
  let lastKey = '';

  function publish({ force = false } = {}) {
    if (voiceStore.bridgeAvailable !== true) return false;
    const snapshot = voiceStatusSnapshot(voiceStore, aircraftControlsStore);
    const key = JSON.stringify(snapshot);
    if (!force && key === lastKey) return false;
    let sent = false;
    try {
      sent = send(snapshot) !== false;
    } catch {
      sent = false;
    }
    if (sent) lastKey = key;
    return sent;
  }

  const stop = watchRef(
    () => JSON.stringify(voiceStatusSnapshot(voiceStore, aircraftControlsStore)),
    () => { publish(); },
  );

  return {
    publish,
    resync: () => publish({ force: true }),
    // WebSocket open precedes the server's authorization acknowledgement.
    // Retry even an unchanged status once this connection is authorized.
    handleServerMessage: (message) => (
      message?.type === 'authorizationScope' && message.scope === 'full-control'
        ? publish({ force: true })
        : false
    ),
    stop: () => { if (typeof stop === 'function') stop(); },
  };
}
