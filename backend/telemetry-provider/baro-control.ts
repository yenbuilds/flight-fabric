import { BARO_INPUTS, BARO_HPA_PER_INHG, baroField, baroLetter, baroSides, type BaroTarget, type BaroOperation } from '../aircraft/aircraft-integrations/fbw-a32nx/baro.js';

type Side = 'captain' | 'firstOfficer';
type Reading = { mode: number; valueMode: number; value: number; unitInHg: boolean; updatedAt: Record<string, number> };
export type BaroState = { healthy: boolean; sides: Partial<Record<Side, Reading>> };

/** Read only independently timestamped samples belonging to the current profile. */
export function captureBaroState(target: BaroTarget, sample: (id: string) => { value: unknown; updatedAt: unknown }, now = Date.now()): BaroState | null {
  const read = (id: string) => {
    const entry = sample(id);
    const time = typeof entry?.updatedAt === 'string' ? Date.parse(entry.updatedAt) : NaN;
    return Number.isFinite(time) && time <= now && now - time <= 2000 ? { value: entry.value, time } : null;
  };
  const healthy = read('baro.healthy');
  if (!healthy || ![true, false, 0, 1].includes(healthy.value as any)) return null;
  const state: BaroState = { healthy: healthy.value === true || healthy.value === 1, sides: {} };
  for (const side of baroSides(target)) {
    const entries = Object.fromEntries(['mode', 'valueMode', 'value', 'unitInHg'].map((p) => [p, read(baroField(side, p))]));
    if (Object.values(entries).some((entry) => !entry)
      || ![0, 1, 2].includes(entries.mode.value as number) || ![0, 1, 2].includes(entries.valueMode.value as number)
      || ![true, false, 0, 1].includes(entries.unitInHg.value as any)
      || typeof entries.value.value !== 'number' || !Number.isFinite(entries.value.value)) return null;
    const unitInHg = entries.unitInHg.value === 1 || entries.unitInHg.value === true;
    state.sides[side] = { mode: Number(entries.mode.value), valueMode: Number(entries.valueMode.value), unitInHg,
      value: Math.round(Number(entries.value.value) * (unitInHg ? 100 : 1)) / (unitInHg ? 100 : 1),
      updatedAt: Object.fromEntries(Object.entries(entries).map(([p, entry]) => [p, entry.time])) };
  }
  return state;
}

export async function executeBaroTransaction({ target, operation, value, capture, isCurrent, sendEvent, setNamedVar,
  findException = () => null, now = Date.now, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  target: BaroTarget; operation: BaroOperation; value?: number;
  capture: () => BaroState | null; isCurrent: () => boolean;
  sendEvent: (name: string, value: number) => Promise<any>;
  setNamedVar: (input: { name: string; unit: string; value: number }) => Promise<any>;
  findException?: (ids: number[], since: number) => unknown; now?: () => number; sleep?: (ms: number) => Promise<unknown>;
}) {
  const sides = baroSides(target);
  const inHg = operation === 'qnhInHg';
  const unit = inHg ? 'inHg' : 'hPa';
  let executionStarted = false, unitsSet = false, qnhSelected = false;
  let phase = 'preflight';
  const ids: number[] = [], startedAt = now();
  const pressureBaselines: Partial<Record<Side, number>> = {};
  const fail = (code: string, text: string): never => { throw Object.assign(new Error(text), { code }); };
  const matches = (s: Reading, side: Side) => operation === 'std' ? s.mode === 0 && s.valueMode === 0
    : s.mode === 1 && s.valueMode === (inHg ? 2 : 1) && s.unitInHg === inHg && s.value === value
      && (pressureBaselines[side] == null || s.updatedAt.value > pressureBaselines[side]);
  const current = () => {
    if (!isCurrent()) fail('stale_baro_context', 'Aircraft or simulator connection changed. No further barometer writes were sent.');
    if (findException(ids, startedAt)) fail('baro_write_rejected', 'SimConnect rejected the barometer control.');
    const state = capture();
    if (!state?.healthy || sides.some((side) => !state.sides[side])) fail('baro_unavailable', 'Fresh barometer data and a healthy FCU are required.');
    if (unitsSet && sides.some((side) => state.sides[side].unitInHg !== inHg)) fail('baro_changed', 'Barometer units changed during the request.');
    if (qnhSelected && sides.some((side) => state.sides[side].mode !== 1)) fail('baro_changed', 'Barometer mode changed during the request.');
    return state;
  };
  const dispatch = async (write: () => Promise<any>) => {
    current(); executionStarted = true;
    const ack = await write();
    for (const id of [...(Array.isArray(ack?.sendIds) ? ack.sendIds : []), ack?.sendId]) {
      if (Number.isSafeInteger(id) && id >= 0 && !ids.includes(id)) ids.push(id);
    }
    if (ack?.ok !== true) fail('baro_write_rejected', 'The sidecar did not accept the barometer write.');
  };
  const wait = async (predicate: (state: BaroState) => boolean) => {
    const deadline = now() + 2500;
    while (true) {
      const state = current();
      if (predicate(state)) return state;
      if (now() >= deadline) fail('baro_readback_timeout', `Barometer ${phase} was not confirmed. No automatic retry was sent.`);
      await sleep(Math.min(50, deadline - now()));
    }
  };
  // Absolute writes can be sent to both sides together. Conditional pushes
  // must wait for mode feedback because native EFIS sync can mirror the input.
  const stage = async (satisfied: (s: Reading, side: Side) => boolean, property: string,
    write: (side: Side) => Promise<any>, changed = false) => {
    const baselines: Partial<Record<Side, Reading>> = {};
    const start = current();
    let modeObservationTime = Math.max(...sides.map((side) => start.sides[side].updatedAt[property]));
    // A mode/unit transition invalidates its previous numeric display. Record
    // every side needing a change up front so a mirrored mode or pressure
    // update still needs its own newer numeric observation.
    if (operation !== 'std') for (const side of sides) {
      if (!satisfied(start.sides[side], side)) pressureBaselines[side] = start.sides[side].updatedAt.value;
    }
    for (const side of sides) {
      if (changed) await wait((state) => state.sides[side].updatedAt[property] >= modeObservationTime);
      const before = current().sides[side];
      if (satisfied(before, side)) continue;
      baselines[side] = before;
      if (operation !== 'std') pressureBaselines[side] = before.updatedAt.value;
      await dispatch(() => write(side));
      if (changed) {
        const confirmed = await wait((state) => state.sides[side].updatedAt[property] > before.updatedAt[property]
          && state.sides[side][property] !== before[property]);
        // The next side may still carry an older observation of the same
        // linked change. Read it at least as recently as the confirmed side
        // before deciding whether another conditional push is necessary.
        modeObservationTime = confirmed.sides[side].updatedAt[property];
      }
    }
    return wait((state) => sides.every((side) => {
      const before = baselines[side], after = state.sides[side];
      return (!before ? satisfied(after, side) : after.updatedAt[property] > before.updatedAt[property]
        && (changed ? after[property] !== before[property] : satisfied(after, side)));
    }));
  };
  try {
    if (operation !== 'std') {
      const input = BARO_INPUTS[operation];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < input.min || value > input.max
        || Math.abs((value - input.min) / input.step - Math.round((value - input.min) / input.step)) > 1e-7) {
        fail('invalid_baro_value', 'Enter a valid pressure in the selected units.');
      }
    }
    current();
    if (operation === 'std') {
      phase = 'STD mode';
      await stage(matches, 'mode', (side) => sendEvent(`A32NX.FCU_EFIS_${baroLetter(side)}_BARO_PULL`, 0));
    } else {
      phase = 'units';
      await stage((s) => s.unitInHg === inHg, 'unitInHg', (side) => setNamedVar({
        name: `L:A32NX_FCU_EFIS_${baroLetter(side)}_BARO_IS_INHG`, unit: 'Number', value: inHg ? 1 : 0 }));
      unitsSet = true;
      phase = 'QNH mode';
      // PUSH leaves STD for the remembered QNH/QFE mode; a further confirmed
      // QFE -> QNH push is a distinct transition. A missing transition is never retried.
      for (let transition = 0; transition < 2 && sides.some((side) => current().sides[side].mode !== 1); transition++) {
        await stage((s) => s.mode === 1, 'mode', (side) => sendEvent(`A32NX.FCU_EFIS_${baroLetter(side)}_BARO_PUSH`, 0), true);
      }
      await wait((state) => sides.every((side) => state.sides[side].mode === 1 && state.sides[side].valueMode === (inHg ? 2 : 1)));
      qnhSelected = true;
      phase = 'pressure';
      await stage(matches, 'value', (side) => sendEvent(`A32NX.FCU_EFIS_${baroLetter(side)}_BARO_SET`,
        Math.round(value * 16 * (inHg ? BARO_HPA_PER_INHG : 1))));
    }
    const final = current();
    if (!sides.every((side) => matches(final.sides[side], side))) fail('baro_changed', 'Barometer changed before final confirmation.');
    return { ok: true, code: 'executed', ...(!executionStarted ? { noOp: true, idempotent: true } : {}),
      baro: { target, mode: operation === 'std' ? 'std' : 'qnh', ...(operation === 'std' ? {} : { unit, value }), confirmedSides: sides } };
  } catch (error) {
    const observed = isCurrent() ? capture() : null;
    const confirmedSides = observed?.healthy ? sides.filter((side) => observed.sides[side] && matches(observed.sides[side], side)) : [];
    return { ok: false, code: error.code || 'baro_write_failed', executionStarted,
      error: error.message || 'Barometer control failed.',
      baro: { target, mode: operation === 'std' ? 'std' : 'qnh', ...(operation === 'std' ? {} : { unit, value }), confirmedSides } };
  }
}
