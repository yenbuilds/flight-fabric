import { TaxiControlWriteError } from './axes.js';

type Bridge = { _started?: boolean; getSnapshot?: () => { status?: string } };
type RecoveryDependencies = {
  bridge: () => Bridge | null;
  ensure: () => Promise<Bridge | null>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
};

/** Reconnect the transport only. The caller may send STOP after this succeeds,
 * never replay the motion demand whose acknowledgement was lost. */
export async function recoverTaxiControlBridge(error: unknown, valid: () => boolean, deps: RecoveryDependencies): Promise<boolean> {
  const detail = error instanceof TaxiControlWriteError ? error.transportError : '';
  if (!(detail === 'not_connected' || detail === 'sidecar_unavailable' || detail.startsWith('LVAR sidecar stopped:'))) return false;
  if (!valid()) return false;
  // A live sidecar reconnects SimConnect on its own every five seconds. A dead
  // process needs the provider's serialized start/subscription lifecycle.
  let bridge = deps.bridge();
  if (!bridge || bridge._started === false) bridge = await deps.ensure();
  if (!bridge || !valid()) return false;
  const deadline = deps.now() + 6500;
  while (valid() && deps.bridge() === bridge) {
    if (bridge._started === false) return false;
    if (['connected', 'running', 'subscribed', 'subscriptions_updated'].includes(bridge.getSnapshot?.().status || '')) return true;
    if (deps.now() >= deadline) return false;
    await deps.wait(100);
  }
  return false;
}
