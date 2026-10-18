import type { SimConnectSequenceActionRoute } from './integration-engine/types.js';

type Sample = { observed: unknown; updatedAtMs: number; fresh: boolean };
export type ConditionalWriteState = Record<string, { ready: boolean; satisfied: boolean; updatedAt: number }>;

/** Read only the explicitly associated fields of a registry-validated recipe. */
export function captureConditionalWriteState(
  route: SimConnectSequenceActionRoute, sample: (id: string) => Sample, now = Date.now(),
): ConditionalWriteState | null {
  const { conditionalWrites, readbacks } = route;
  const state: ConditionalWriteState = {};
  for (const target of conditionalWrites.targets) {
    const fields = [...target.prerequisiteFieldIds, target.readbackFieldId];
    const entries = fields.map(fieldId => {
      const readback = readbacks.find(candidate => candidate.fieldId === fieldId);
      const entry = sample(fieldId);
      if (!entry?.fresh || !('expectedValue' in readback)
        || typeof entry.observed !== typeof readback.expectedValue
        || (typeof entry.observed === 'number' && !Number.isFinite(entry.observed))
        || !Number.isFinite(entry.updatedAtMs) || entry.updatedAtMs > now
        || now - entry.updatedAtMs > conditionalWrites.freshnessMs) return null;
      return { matches: entry.observed === readback.expectedValue, updatedAt: entry.updatedAtMs };
    });
    if (entries.some(entry => !entry)) return null;
    const observation = entries[entries.length - 1];
    state[target.id] = {
      ready: entries.slice(0, -1).every(entry => entry.matches),
      satisfied: observation.matches,
      updatedAt: observation.updatedAt,
    };
  }
  return state;
}

/**
 * Ordered, conditional fixed writes with independent confirmation per target.
 * The recipe owns field/event associations; this operation owns no aircraft facts.
 * Writes are never retried. Linked feedback may satisfy a later target before dispatch.
 */
export async function executeConditionalWrites({ route, capture, isCurrent, sendEvent,
  findException = () => null, now = Date.now, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}: {
  route: SimConnectSequenceActionRoute;
  capture: () => ConditionalWriteState | null;
  isCurrent: () => boolean;
  sendEvent: (name: string, value: number) => Promise<unknown>;
  findException?: (ids: number[], since: number) => unknown;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  const targets = route.conditionalWrites.targets, ids: number[] = [], startedAt = now();
  const baselines = new Map<string, number>();
  let executionStarted = false;
  const fail = (code: string, text: string): never => { throw Object.assign(new Error(text), { code }); };
  const current = () => {
    if (!isCurrent()) fail('stale_context', 'The control context changed. No further writes were sent.');
    if (findException(ids, startedAt)) fail('transport_rejected', 'The transport rejected the control.');
    const state = capture();
    if (!state || targets.some(target => !state[target.id]?.ready)) fail('unavailable', 'Fresh control prerequisites are required.');
    return state;
  };
  const matches = (state: ConditionalWriteState, id: string) => state[id]?.ready && state[id]?.satisfied
    && (!baselines.has(id) || state[id].updatedAt > baselines.get(id));
  try {
    current();
    for (const target of targets) {
      const before = current()[target.id];
      if (before.satisfied) continue;
      baselines.set(target.id, before.updatedAt);
      const operation = route.operations[target.operationIndex];
      // Registry validation restricts this operation to fixed numeric events.
      if (operation.type !== 'event' || typeof operation.value !== 'number') {
        throw new Error('Invalid conditional write operation.');
      }
      executionStarted = true;
      const ack = await sendEvent(operation.name, operation.value) as { ok?: boolean; sendIds?: unknown; sendId?: unknown };
      for (const id of [...(Array.isArray(ack?.sendIds) ? ack.sendIds : []), ack?.sendId]) {
        if (Number.isSafeInteger(id) && id >= 0 && !ids.includes(id)) ids.push(id);
      }
      if (ack?.ok !== true) fail('write_rejected', 'The transport did not accept the write.');
    }
    // Confirmation windows begin after the ordered dispatch, as in the original transaction.
    const dispatchedAt = now();
    const deadlines = new Map(targets.map(target => [target.id, dispatchedAt
      + route.readbacks.find(readback => readback.fieldId === target.readbackFieldId).timeoutMs]));
    while (true) {
      const state = current();
      const pending = targets.filter(target => !matches(state, target.id));
      if (!pending.length) break;
      const remaining = Math.min(...pending.map(target => deadlines.get(target.id) - now()));
      if (remaining <= 0) fail('readback_timeout', 'The setting was not confirmed. No automatic retry was sent.');
      await sleep(Math.min(50, remaining));
    }
    return { ok: true, code: 'executed', executionStarted, noOp: !executionStarted,
      confirmedTargets: targets.map(target => target.id) };
  } catch (error) {
    // Retired contexts and correlated transport failures cannot confirm current settings.
    const state = isCurrent() && !findException(ids, startedAt) ? capture() : null;
    return { ok: false, code: error.code || 'failed', error: error.message, executionStarted,
      confirmedTargets: state ? targets.filter(target => matches(state, target.id)).map(target => target.id) : [] };
  }
}
