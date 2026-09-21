import { randomUUID } from 'node:crypto';
import type { CduAdapter } from './types.js';
import { lineKeys } from './types.js';
import type { CduRequest, CduState } from '../../../packages/telemetry-types/src/cdu.js';

export interface CduContext {
  profileKey: string; profileRevision: number; integrationId: string; connected: boolean;
  /** Provider-owned identity across simulator connections and control transports. */
  generation?: unknown;
}

/** One provider-owned session, shared by viewers; adapters own their bounded transports. */
export function createCduSession({ context, createAdapter, now = Date.now,
  onError = (error: unknown) => console.error('[CDU]', error) }: {
  context: () => CduContext | null;
  createAdapter: (id: string) => CduAdapter | null;
  now?: () => number;
  onError?: (error: unknown) => void;
}) {
  let active: { token: string; context: CduContext; adapter: CduAdapter; touchedAt: number } | null = null;
  let pending = false, lastKeyAt = -Infinity;
  let cleanup: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const same = (a: CduContext, b: CduContext | null) => b?.connected === true && a.profileKey === b.profileKey
    && a.profileRevision === b.profileRevision && a.integrationId === b.integrationId && a.generation === b.generation;
  function reset() {
    const previous = active;
    active = null;
    if (timer) clearInterval(timer);
    timer = null;
    // Report a failed dispose and carry on: the chain must always settle, or
    // one failed sidecar stop would make every later request reject at
    // `await cleanup` and leave later adapters undisposed.
    if (previous) cleanup = cleanup.then(() => previous.adapter.dispose()).catch(onError);
  }
  async function dispose() { disposed = true; reset(); await cleanup; }
  return {
    async request(message: CduRequest, canWrite: () => boolean = () => false): Promise<Omit<CduState, 'type' | 'requestId' | 'ok'>> {
      const current = context();
      // Invalidate before rejecting an unavailable context. A reconnect can
      // otherwise reuse the old token before the cleanup timer observes it.
      if (active && !same(active.context, current)) reset();
      if (disposed || !current?.connected || !Number.isSafeInteger(message.profileRevision) || message.profileRevision < 0
        || message.profileKey !== current.profileKey || message.profileRevision !== current.profileRevision) throw new Error('Aircraft changed or simulator disconnected. Reopen the CDU.');
      if (!['left', 'right'].includes(message.side)) throw new Error('Invalid CDU side.');
      if (!['requestCduState', 'sendCduKey'].includes(message.type)) throw new Error('Invalid CDU request.');
      const base = { profileKey: current.profileKey, profileRevision: current.profileRevision, integrationId: current.integrationId, side: message.side };
      if (current.integrationId === 'fenix-a32x') {
        if (message.type === 'sendCduKey') throw new Error('Use the Fenix web MCDU for key input.');
        return { ...base, mode: 'external', label: 'Fenix web MCDU', externalPort: 8083,
          setup: 'Start Fenix with the aircraft loaded. Open its web EFB and select MCDU. On a phone or tablet, use the same network as the simulator PC. Fenix manages this connection directly.' };
      }
      await cleanup;
      if (disposed || !same(current, context())) throw new Error('Aircraft connection changed.');
      if (!active) {
        if (message.type === 'sendCduKey') throw new Error('Reopen the CDU before sending keys.');
        const adapter = createAdapter(current.integrationId);
        if (!adapter) throw new Error('This aircraft does not have a remote CDU integration.');
        active = { token: randomUUID(), context: current, adapter, touchedAt: now() };
        timer = setInterval(() => { if (active && (!same(active.context, context()) || now() - active.touchedAt > 15000)) reset(); }, 1000);
        timer.unref?.();
      }
      const session = active;
      session.touchedAt = now();
      const isCurrent = () => active === session && same(session.context, context());
      const adapter = session.adapter;
      if (message.type === 'sendCduKey') {
        if (message.sessionId !== session.token || !canWrite()) throw new Error('CDU control connection changed. Refresh the screen before entering keys.');
        const allowed = [...lineKeys, ...adapter.functionKeys.map(key => key.id), ...adapter.entryKeys.map(key => key.id)];
        if (typeof message.key !== 'string' || !allowed.includes(message.key)) throw new Error('Invalid CDU key.');
        if (pending || now() - lastKeyAt < 50) throw new Error('A CDU key is still pending.');
        pending = true; lastKeyAt = now();
        try { await adapter.press(message.side, message.key, () => isCurrent() && canWrite()); }
        finally { pending = false; }
      }
      const screen = await adapter.read(message.side);
      if (!isCurrent()) throw new Error('Aircraft connection changed.');
      return { ...base, mode: 'integrated', sessionId: session.token, label: adapter.label, setup: adapter.setup,
        functionKeys: adapter.functionKeys, entryKeys: adapter.entryKeys, screen };
    },
    dispose,
    stop: dispose,
  };
}
