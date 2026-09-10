import { normalizeComFrequencyMhz } from '../utils/radio-frequency.js';

export const COM_RADIO_DEFINITIONS = ([1, 2] as const).flatMap((index) => [
  { name: `com${index}Installed`, simvar: `COM AVAILABLE:${index}`, unit: 'bool', isolated: true },
  { name: `com${index}Status`, simvar: `COM STATUS:${index}`, unit: 'number', isolated: true },
  { name: `com${index}SpacingMode`, simvar: `COM SPACING MODE:${index}`, unit: 'number', isolated: true },
  { name: `com${index}ActiveMhz`, simvar: `COM ACTIVE FREQUENCY:${index}`, unit: 'MHz', isolated: true },
  { name: `com${index}StandbyMhz`, simvar: `COM STANDBY FREQUENCY:${index}`, unit: 'MHz', isolated: true },
]);
export const COM_RADIO_FIELDS = new Set(COM_RADIO_DEFINITIONS.map((field) => field.name));
type Sample = { value: unknown; updatedAt: string | null };
export type ComRadioState = {
  installed: boolean | null; status: number | null; spacingMode: number | null;
  activeMhz: number | null; standbyMhz: number | null;
  updatedAt: Record<string, number>;
};

export function captureComRadio(samples: Record<string, Sample>, status: unknown, index: 1 | 2, nowMs = Date.now()): ComRadioState {
  const updatedAt: Record<string, number> = {};
  const value = (property: string) => {
    const sample = samples[`com${index}${property[0].toUpperCase()}${property.slice(1)}`];
    const time = typeof sample?.updatedAt === 'string' ? Date.parse(sample.updatedAt) : NaN;
    if (!['running', 'connected'].includes(String(status)) || !Number.isFinite(time)
      || time > nowMs || nowMs - time > 2000) return null;
    updatedAt[property] = time;
    return sample.value;
  };
  const installed = value('installed');
  const radioStatus = value('status');
  const spacing = value('spacingMode');
  return {
    installed: typeof installed === 'boolean' ? installed : null,
    status: typeof radioStatus === 'number' && [-1, 0, 1, 2, 3].includes(radioStatus) ? radioStatus : null,
    spacingMode: spacing === 0 || spacing === 1 ? spacing : null,
    activeMhz: normalizeComFrequencyMhz(value('activeMhz')),
    standbyMhz: normalizeComFrequencyMhz(value('standbyMhz')),
    updatedAt,
  };
}

/** Bounded transaction under the provider's per-radio lock. Never retries a write. */
export async function executeComRadioTransaction({ index, operation, value, capture, isCurrent, sendEvent,
  findException = () => null, now = Date.now, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  index: 1 | 2; operation: 'setStandby' | 'swap' | 'switchTo'; value?: number;
  capture: () => ComRadioState; isCurrent: () => boolean;
  sendEvent: (name: string, value: number) => Promise<any>;
  findException?: (ids: number[], since: number) => unknown;
  now?: () => number; sleep?: (ms: number) => Promise<unknown>;
}) {
  let executionStarted = false;
  let tuned = false;
  let expectedSpacing: number | null = null;
  const sendIds: number[] = [];
  const startedAt = now();
  const fail = (code: string, error: string): never => { throw Object.assign(new Error(error), { code }); };
  const current = () => {
    if (!isCurrent()) fail('stale_radio_context', 'Aircraft or simulator connection changed. No further radio writes were sent.');
    if (findException(sendIds, startedAt)) fail('radio_write_rejected', 'SimConnect rejected the radio control.');
    const state = capture();
    if (state.installed !== true || state.status !== 0 || state.spacingMode == null
      || state.activeMhz == null || state.standbyMhz == null) {
      fail('radio_unavailable', 'Fresh frequency, spacing and powered radio readbacks are required.');
    }
    if (expectedSpacing !== null && state.spacingMode !== expectedSpacing) {
      fail('radio_changed', 'Radio channel spacing changed during the request. No further writes were sent.');
    }
    return state;
  };
  const dispatch = async (name: string, payload: number) => {
    current();
    executionStarted = true;
    const ack = await sendEvent(name, payload);
    for (const id of [...(Array.isArray(ack?.sendIds) ? ack.sendIds : []), ack?.sendId]) {
      if (Number.isSafeInteger(id) && id >= 0 && !sendIds.includes(id)) sendIds.push(id);
    }
    if (ack?.ok !== true) fail('radio_write_rejected', typeof ack?.error === 'string' ? ack.error : 'Radio write was not accepted.');
  };
  const confirm = async (predicate: (state: ComRadioState) => boolean) => {
    const deadline = now() + 2500;
    do {
      const state = current();
      if (predicate(state)) return state;
      if (now() >= deadline) fail('radio_readback_timeout', 'The radio did not confirm the requested channel. No automatic retry was sent.');
      await sleep(Math.min(50, deadline - now()));
    } while (true);
  };
  try {
    const before = current();
    expectedSpacing = before.spacingMode;
    const target = normalizeComFrequencyMhz(operation === 'swap' ? before.standbyMhz : value, before.spacingMode);
    if (target == null) fail('invalid_radio_channel', `Choose a valid ${before.spacingMode === 0 ? '25' : '8.33'} kHz COM channel; the requested frequency was not rounded.`);
    const bank = operation === 'setStandby' ? 'standby' : 'active';
    const result = (state: ComRadioState) => ({ ok: true, code: 'executed',
      ...(executionStarted ? {} : { noOp: true, idempotent: true }),
      confirmedValue: bank === 'active' ? state.activeMhz : state.standbyMhz,
      radio: { index, bank, frequencyMhz: bank === 'active' ? state.activeMhz : state.standbyMhz },
    });
    if ((bank === 'active' ? before.activeMhz : before.standbyMhz) === target) return result(before);

    if (operation !== 'swap' && before.standbyMhz !== target) {
      await dispatch(index === 1 ? 'COM_STBY_RADIO_SET_HZ' : 'COM2_STBY_RADIO_SET_HZ', Math.round(target * 1000000));
      const standby = await confirm((state) => state.standbyMhz === target
        && state.updatedAt.standbyMhz > before.updatedAt.standbyMhz);
      tuned = true;
      if (operation === 'setStandby') return result(standby);
    } else if (operation === 'setStandby') return result(before);

    const swapBefore = current();
    if (swapBefore.spacingMode !== before.spacingMode || swapBefore.standbyMhz !== target
      || swapBefore.activeMhz !== before.activeMhz) {
      fail('radio_changed', 'Radio frequencies or channel spacing changed before swap. No swap was sent.');
    }
    await dispatch(`COM${index}_RADIO_SWAP`, 0);
    const swapped = await confirm((state) => state.activeMhz === target && state.standbyMhz === before.activeMhz
      && state.updatedAt.activeMhz > swapBefore.updatedAt.activeMhz
      && state.updatedAt.standbyMhz > swapBefore.updatedAt.standbyMhz);
    return result(swapped);
  } catch (error) {
    return { ok: false, code: error.code || 'radio_write_failed', executionStarted,
      error: `${tuned ? 'Standby tuning was confirmed; active switching failed. ' : ''}${error.message || 'Radio control failed.'}` };
  }
}
