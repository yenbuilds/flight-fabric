import { createPcmCapture } from './pcm-capture.js';

export function createMobileVoiceClient({ globalRef = globalThis, createCapture = createPcmCapture,
  canStart = () => false, onState = () => {}, releaseTailMs = 500 } = {}) {
  let active = null, disposed = false;
  const publish = (status, message, extra = {}) => onState({ status, message, ...extra });
  function retire(session, message, status = 'error') {
    if (active !== session) return;
    active = null;
    clearTimeout(session.deadline); clearTimeout(session.holdTimer);
    clearTimeout(session.tailTimer); session.releaseTail?.();
    session.settleStart?.(false);
    void session.capture?.cancel();
    if (session.socket?.readyState === 1) {
      try { session.socket.send(JSON.stringify({ kind: 'cancel' })); } catch {}
    }
    session.socket?.close();
    publish(status, message);
  }
  function cancel(message = 'Recording cancelled. Hold to talk when you are ready.') {
    if (active) retire(active, message, 'ready');
  }
  function send(session, data) {
    if (active !== session || session.socket?.readyState !== 1 || session.socket.bufferedAmount > 131072) {
      throw new Error('The phone connection is too slow. Please try again.');
    }
    session.socket.send(data);
  }
  function chunk(session, { sampleRate, samples }) {
    if (active !== session || !session.transmitting) return;
    try {
      const buffer = new ArrayBuffer(44 + samples.length * 4), view = new DataView(buffer);
      new Uint8Array(buffer).set(new TextEncoder().encode(session.id));
      view.setUint32(32, session.sequence++, true);
      view.setUint32(36, Math.round(sampleRate), true); view.setUint32(40, samples.length, true);
      for (let i = 0; i < samples.length; i++) view.setFloat32(44 + i * 4, samples[i], true);
      send(session, buffer);
    } catch (error) { retire(session, error.message); }
  }
  async function begin() {
    if (disposed || active || !canStart()) return false;
    if (!globalRef.isSecureContext || !globalRef.navigator?.mediaDevices?.getUserMedia) {
      publish('error', 'Open the secure phone link from FlightFabric Settings to use this microphone.'); return false;
    }
    const session = { sequence: 0, transmitting: false, finished: false, id: '', socket: null, capture: null };
    active = session;
    const ready = new Promise(resolve => { session.settleStart = resolve; });
    session.deadline = setTimeout(() => retire(session, 'Voice recording timed out. Please try again.'), 20000);
    publish('starting', 'Opening this phone’s microphone…', { transcript: '', command: '' });
    session.capture = createCapture({ globalRef, onChunk: data => chunk(session, data),
      onError: () => retire(session, 'Microphone access stopped. Check browser permission, then try again.') });
    // Start permission acquisition directly from the user gesture. Late grants
    // belong to this capture owner and are closed after cancellation.
    void (async () => {
      try {
        await session.capture.start();
        if (active !== session) return;
        const socket = new globalRef.WebSocket(`wss://${globalRef.location.host}/mobile-voice/audio`);
        session.socket = socket;
        socket.onmessage = event => {
          if (active !== session) return;
          let msg;
          try { msg = JSON.parse(event.data); } catch { return retire(session, 'Invalid reply from the PC. Please reconnect.'); }
          if (msg.kind === 'ready' && !session.id && /^[a-f0-9]{32}$/.test(msg.id)) {
            session.id = msg.id;
            try { send(session, JSON.stringify({ kind: 'capturing' })); } catch (error) { return retire(session, error.message); }
            session.transmitting = true;
            session.holdTimer = setTimeout(() => retire(session, 'Keep spoken commands under nine seconds. Please try again.'), 9000);
            publish('listening', 'Listening on this phone. Say the command, then release.');
            session.settleStart(true);
          } else if (msg.kind === 'error') retire(session, msg.message || 'PC voice control is unavailable.');
          else if (msg.kind === 'status') {
            if (msg.done && !session.finished) return retire(session, msg.message || 'Recording stopped before it finished. Please try again.');
            if (session.finished) publish(msg.status, msg.message, { transcript: msg.transcript || '', command: msg.command || '' });
            if (msg.done) {
              active = null; clearTimeout(session.deadline); clearTimeout(session.holdTimer);
              void session.capture.cancel(); socket.close();
            }
          }
        };
        socket.onerror = () => retire(session, 'Could not reach PC voice control. Enable phone microphone access on the PC and pair this device.');
        socket.onclose = () => { if (active === session) retire(session, 'The PC connection closed. Please try again.'); };
      } catch {
        if (active === session) retire(session, 'Could not open the microphone. Allow microphone access in this browser, then hold to talk again.');
      }
    })();
    return ready;
  }
  async function finish() {
    const session = active;
    if (!session) return false;
    if (!session.transmitting) { cancel('Microphone setup stopped. Allow access, then hold to talk again.'); return false; }
    if (session.finishing) return false;
    session.finishing = true;
    clearTimeout(session.holdTimer);
    publish('finishing', 'Finishing the recording…');
    try {
      await new Promise(resolve => { session.releaseTail = resolve; session.tailTimer = setTimeout(resolve, releaseTailMs); });
      if (active !== session) return false;
      await session.capture.stop();
      if (active !== session) return false;
      session.transmitting = false; session.finished = true;
      if (!session.sequence) throw new Error('No audio was captured. Please try again.');
      send(session, JSON.stringify({ kind: 'finish', chunks: session.sequence }));
      publish('finishing', 'Recognizing the command on your PC…');
      return true;
    } catch (error) { if (active === session) retire(session, error.message || 'Recording did not finish. Please try again.'); return false; }
  }
  const hidden = () => { if (globalRef.document?.hidden) cancel('Recording cancelled when the page left the foreground.'); };
  const leaving = () => cancel('Recording cancelled when the page closed.');
  globalRef.document?.addEventListener?.('visibilitychange', hidden);
  globalRef.addEventListener?.('pagehide', leaving);
  return { begin, finish, cancel, dispose() {
    disposed = true; cancel(); globalRef.document?.removeEventListener?.('visibilitychange', hidden);
    globalRef.removeEventListener?.('pagehide', leaving);
  } };
}
