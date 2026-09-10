import { baroLetter, baroSides, type BaroTarget } from '../aircraft/aircraft-integrations/fbw-a32nx/baro.js';

type Sample = { observed: unknown; updatedAtMs: number; fresh: boolean };
type Reading = { active: boolean; std: boolean; updatedAt: number };
type State = Partial<Record<'captain' | 'firstOfficer', Reading>>;

export function captureA380BaroState(target: BaroTarget, sample: (id: string) => Sample, now = Date.now()): State | null {
  const state: State = {};
  for (const side of baroSides(target)) {
    const entries = ['active', 'std'].map(property => sample(`baro.${side}.${property}`));
    const times = entries.map(entry => entry?.updatedAtMs);
    if (entries.some(entry => !entry?.fresh || typeof entry?.observed !== 'boolean')
      || times.some(time => !Number.isFinite(time) || time > now || now - time > 2000)) return null;
    state[side] = { active: entries[0].observed as boolean, std: entries[1].observed as boolean, updatedAt: times[1] };
  }
  return state;
}

/** Select and independently confirm STD; never infer it from a numeric pressure. */
export async function executeA380BaroTransaction({ target, capture, isCurrent, sendEvent,
  findException = () => null, now = Date.now, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}: {
  target: BaroTarget; capture: () => State | null; isCurrent: () => boolean;
  sendEvent: (name: string, value: number) => Promise<any>;
  findException?: (ids: number[], since: number) => unknown;
  now?: () => number; sleep?: (ms: number) => Promise<unknown>;
}) {
  const sides = baroSides(target), ids: number[] = [], startedAt = now();
  const baselines: Partial<Record<typeof sides[number], number>> = {};
  let executionStarted = false;
  const fail = (code: string, text: string): never => { throw Object.assign(new Error(text), { code }); };
  const current = () => {
    if (!isCurrent()) fail('stale_baro_context', 'Aircraft or simulator connection changed. No further barometer writes were sent.');
    if (findException(ids, startedAt)) fail('baro_write_rejected', 'SimConnect rejected the barometer control.');
    const state = capture();
    if (!state || sides.some(side => !state[side]?.active)) fail('baro_unavailable', 'Fresh, active EFIS panels are required.');
    return state;
  };
  const matches = (state: State, side: typeof sides[number]) => state[side]?.active && state[side]?.std
    && (baselines[side] === undefined || state[side].updatedAt > baselines[side]);
  try {
    current();
    for (const side of sides) {
      const before = current()[side];
      if (before.std) continue;
      baselines[side] = before.updatedAt;
      executionStarted = true;
      const ack = await sendEvent(`A32NX.FCU_EFIS_${baroLetter(side)}_BARO_PUSH`, 0);
      for (const id of [...(Array.isArray(ack?.sendIds) ? ack.sendIds : []), ack?.sendId]) {
        if (Number.isSafeInteger(id) && id >= 0 && !ids.includes(id)) ids.push(id);
      }
      if (ack?.ok !== true) fail('baro_write_rejected', 'The sidecar did not accept the barometer write.');
    }
    const deadline = now() + 2500;
    while (!sides.every(side => matches(current(), side))) {
      if (now() >= deadline) fail('baro_readback_timeout', 'STD was not confirmed. No automatic retry was sent.');
      await sleep(Math.min(50, deadline - now()));
    }
    return { ok: true, code: 'executed', executionStarted, noOp: !executionStarted,
      baro: { target, mode: 'std', confirmedSides: sides } };
  } catch (error) {
    // A retired profile or failed transport cannot confirm a current setting.
    const state = isCurrent() && !findException(ids, startedAt) ? capture() : null;
    return { ok: false, code: error.code || 'baro_failed', error: error.message, executionStarted,
      baro: { target, mode: 'std', confirmedSides: state ? sides.filter(side => matches(state, side)) : [] } };
  }
}
