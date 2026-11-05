import { watch } from 'vue';

// Desktop renderer adapter: remote capture substitutes only the PCM source.
// The existing controller owns recognition, interpretation and command results.
export function createMobileVoiceHost({ controller, voiceStore, getHttpBase, globalRef = globalThis, watchRef = watch }) {
  let socket = null, active = null, disposed = false, connecting = false, retry = null, generation = 0;
  let pendingConnection = null, socketDeadline = null;
  const busy = new Set(['starting', 'listening', 'finishing', 'sending']);
  function send(message) {
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 131072) return false;
    socket.send(JSON.stringify(message)); return true;
  }
  function cancel() {
    const old = active; active = null;
    if (!old) return;
    old.rejectStart?.(new Error('Phone recording cancelled.'));
    void controller.cancelRemote(old.id);
  }
  const unwatch = watchRef(() => [voiceStore.status, voiceStore.statusText, voiceStore.transcript, voiceStore.lastCommand], () => {
    const session = active;
    if (!session || !session.started) return;
    const done = !busy.has(voiceStore.status);
    send({ kind: 'status', id: session.id, status: voiceStore.status, message: voiceStore.statusText,
      transcript: voiceStore.transcript, command: voiceStore.lastCommand, done });
    if (done && active === session) active = null;
  // Store actions update status and its text separately. Publish the completed
  // action, so a terminal status cannot close the phone before its text arrives.
  }, { flush: 'post' });
  async function handleMessage(event) {
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      const id = new TextDecoder().decode(bytes.subarray(0, 32));
      const session = active;
      if (!session || session.id !== id || event.data.byteLength < 48) return;
      const view = new DataView(event.data);
      const count = view.getUint32(40, true);
      if (count * 4 !== event.data.byteLength - 44) return cancel();
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getFloat32(44 + i * 4, true);
      session.callbacks?.onChunk({ sequence: view.getUint32(32, true), sampleRate: view.getUint32(36, true), samples });
      return;
    }
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.kind === 'start') {
      if (active) { send({ kind: 'error', id: msg.id, message: 'Voice control is busy. Try again after the current command.' }); return; }
      const session = { id: msg.id, started: false, finished: false, callbacks: null };
      active = session;
      const accepted = await controller.beginRemote(msg.id, callbacks => {
        session.callbacks = callbacks;
        return {
          start: () => new Promise((resolve, reject) => {
            session.rejectStart = reject;
            session.resolveStart = () => resolve({ deviceLabel: 'Phone microphone' });
            session.started = true;
            if (!send({ kind: 'ready', id: session.id })) reject(new Error('Phone connection was lost.'));
          }),
          stop: async () => { if (!session.finished) throw new Error('Phone audio did not finish. Please try again.'); },
          cancel: async () => { session.rejectStart?.(new Error('Phone recording cancelled.')); },
        };
      });
      if (!accepted && active === session) {
        send({ kind: 'error', id: session.id, message: voiceStore.runtime?.mode === 'cloud'
          ? 'Phone microphone requires Offline mode. Select Offline in Voice settings on your PC, then try again.'
          : busy.has(voiceStore.status)
            ? 'Voice control is busy. Finish the current recording or command, then try again.'
            : voiceStore.statusText || 'Enable voice control on the PC, then try again.' });
        active = null;
      }
      return;
    }
    const session = active;
    if (!session || msg.id !== session.id) return;
    if (msg.kind === 'capturing') session.resolveStart?.();
    else if (msg.kind === 'finish') { session.finished = true; void controller.finishRemote(session.id); }
    else if (msg.kind === 'cancel') cancel();
  }
  async function connect() {
    clearTimeout(retry); retry = null;
    if (disposed || connecting || socket) return;
    connecting = true;
    const owner = ++generation;
    const request = new AbortController(); pendingConnection = request;
    const cancelled = new Promise((_, reject) => request.signal.addEventListener('abort',
      () => reject(new Error('PC voice connection timed out.')), { once: true }));
    const timeout = setTimeout(() => request.abort(), 10000);
    try {
      const base = getHttpBase();
      const response = await Promise.race([globalRef.fetch(`${base}/api/mobile-voice`, { cache: 'no-store', signal: request.signal }), cancelled]);
      const info = await Promise.race([response.json(), cancelled]);
      if (disposed || owner !== generation || request.signal.aborted) return;
      if (response.ok === false || !info || typeof info.enabled !== 'boolean') {
        throw new Error('PC voice connection is not ready.');
      }
      if (!info.enabled) {
        // Startup may still be restoring the saved HTTPS listener.
        if (info.preparing) retry = setTimeout(() => void connect(), 3000);
        return;
      }
      const result = await Promise.race([globalRef.electronAPI.getBackendBootstrap(), cancelled]);
      const bootstrap = result?.body || result;
      if (disposed || owner !== generation) return;
      // Electron resolves transport failures as { ok: false, body: ... }.
      // Missing authority is a retryable startup failure, not an access opt-out.
      if (result?.ok === false || typeof bootstrap?.wsAuthToken !== 'string' || !bootstrap.wsAuthToken) {
        throw new Error('PC voice connection is not ready.');
      }
      const url = new URL(`${base}/mobile-voice/host`); url.protocol = 'ws:';
      url.searchParams.set('token', bootstrap.wsAuthToken);
      const current = new globalRef.WebSocket(url.href);
      socket = current; current.binaryType = 'arraybuffer';
      socketDeadline = setTimeout(() => { if (socket === current && current.readyState !== 1) current.close(); }, 8000);
      current.onopen = () => { if (socket === current) { clearTimeout(socketDeadline); socketDeadline = null; } };
      current.onmessage = event => { if (socket === current) void handleMessage(event); };
      current.onerror = () => {};
      current.onclose = () => {
        if (socket !== current) return;
        clearTimeout(socketDeadline); socketDeadline = null;
        socket = null; cancel();
        if (!disposed) retry = setTimeout(() => void connect(), 3000);
      };
    } catch {
      if (!disposed && owner === generation) retry = setTimeout(() => void connect(), 3000);
    } finally {
      clearTimeout(timeout);
      if (pendingConnection === request) { pendingConnection = null; connecting = false; }
    }
  }
  function changed() {
    generation++; pendingConnection?.abort(); pendingConnection = null; connecting = false;
    void connect();
  }
  globalRef.addEventListener?.('flightfabric:mobile-voice-changed', changed);
  return { connect, dispose() {
    disposed = true; generation++; pendingConnection?.abort(); clearTimeout(retry); clearTimeout(socketDeadline); cancel(); unwatch();
    globalRef.removeEventListener?.('flightfabric:mobile-voice-changed', changed);
    const old = socket; socket = null; old?.close();
  } };
}
