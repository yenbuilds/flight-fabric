import { BARO_INPUTS, baroSides, type BaroTarget, type BaroOperation } from '../aircraft/aircraft-integrations/fbw-a32nx/baro.js';
import { fenixBaroCounter, fenixBaroUnits, fenixBaroUnitField } from '../aircraft/aircraft-integrations/fenix-a32x/baro.js';

type Side = 'captain' | 'firstOfficer';
type Reading = { qnh: boolean; units: string; pressure: number | null; times: Record<string, number> };
export type FenixBaroState = { healthy: boolean; sides: Partial<Record<Side, Reading>> };

export function captureFenixBaroState(target: BaroTarget, operation: BaroOperation,
  sample: (id: string) => { observed: unknown; fresh: boolean; updatedAtMs: number }, now = Date.now()): FenixBaroState | null {
  const read = (id: string) => {
    const s = sample(id);
    return s?.fresh && Number.isFinite(s.updatedAtMs) && s.updatedAtMs <= now && now - s.updatedAtMs <= 2000 ? s : null;
  };
  const power = read('baro.healthy');
  if (typeof power?.observed !== 'boolean') return null;
  const state: FenixBaroState = { healthy: power.observed, sides: {} };
  for (const side of baroSides(target)) {
    const qnh = read(`baro.${side}.qnh`), units = read(fenixBaroUnitField(side));
    const pressure = read(`baro.${side}.${operation === 'qnhInHg' ? 'inhg' : 'hpa'}`);
    if (typeof qnh?.observed !== 'boolean' || !['hpa', 'inhg'].includes(units?.observed as string)) return null;
    // A blank pressure display in STD must not prevent leaving STD. Pressure is
    // required only after the powered QNH indication confirms the mode change.
    state.sides[side] = { qnh: qnh.observed, units: units.observed as string,
      pressure: typeof pressure?.observed === 'number' && Number.isFinite(pressure.observed) ? pressure.observed : null,
      times: { qnh: qnh.updatedAtMs, units: units.updatedAtMs, pressure: pressure?.updatedAtMs ?? 0 } };
  }
  return state;
}

/** Native one-detent inputs, each confirmed before another input; never retry a lost detent. */
export async function executeFenixBaroTransaction({ target, operation, value, capture, isCurrent, executeCode,
  findException = () => null, now = Date.now, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}: {
  target: BaroTarget; operation: BaroOperation; value?: number;
  capture: () => FenixBaroState | null; isCurrent: () => boolean; executeCode: (code: string) => Promise<any>;
  findException?: (ids: number[], since: number) => unknown; now?: () => number; sleep?: (ms: number) => Promise<unknown>;
}) {
  const sides = baroSides(target), inHg = operation === 'qnhInHg', unit = inHg ? 'inHg' : 'hPa', scale = inHg ? 100 : 1;
  const desired = Math.round(value * scale), startedAt = now(), ids: number[] = [];
  let executionStarted = false, unitsSet = false, qnhSet = false, phase = 'mode';
  const pending: Partial<Record<Side, { property: keyof Reading['times']; time: number }>> = {};
  const pressureBaselines: Partial<Record<Side, number>> = {};
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  const pressure = (s: Reading) => s.pressure == null ? null : Math.round(s.pressure * scale);
  const pressureRefreshed = (side: Side, s: Reading) => pressureBaselines[side] == null || s.times.pressure > pressureBaselines[side];
  const matches = (side: Side, s: Reading) => operation === 'std' ? s.qnh === false
    : s.qnh && s.units === (inHg ? 'inhg' : 'hpa') && pressure(s) === desired && pressureRefreshed(side, s);
  const current = () => {
    if (!isCurrent()) fail('stale_baro_context', 'Aircraft or simulator connection changed. No further barometer writes were sent.');
    if (findException(ids, startedAt)) fail('baro_write_rejected', 'The simulator rejected the barometer control.');
    const state = capture();
    if (!state?.healthy || sides.some(side => !state.sides[side])) fail('baro_unavailable', 'Fresh barometer data and a powered FCU are required.');
    if (unitsSet && sides.some(side => state.sides[side].units !== (inHg ? 'inhg' : 'hpa')))
      fail('baro_changed', 'Barometer units changed during the request.');
    if (qnhSet && sides.some(side => !state.sides[side].qnh)) fail('baro_changed', 'Barometer mode changed during the request.');
    return state;
  };
  const dispatch = async (side: Side, property: string, code: string) => {
    const before = current().sides[side];
    if (now() - startedAt >= 25000) fail('baro_readback_timeout', 'Barometer adjustment reached its time limit. No automatic retry was sent.');
    pending[side] = { property, time: before.times[property] }; executionStarted = true;
    if (operation !== 'std' && property !== 'pressure') pressureBaselines[side] = before.times.pressure;
    const ack = await executeCode(code);
    for (const id of [...(Array.isArray(ack?.sendIds) ? ack.sendIds : []), ack?.sendId]) {
      if (Number.isSafeInteger(id) && id >= 0 && !ids.includes(id)) ids.push(id);
    }
    if (ack?.ok !== true) fail('baro_write_rejected', 'The sidecar did not accept the barometer input.');
  };
  const wait = async (predicate: (state: FenixBaroState) => boolean) => {
    const deadline = Math.min(now() + 2500, startedAt + 25000);
    while (true) {
      const state = current();
      if (predicate(state)) return state;
      if (now() >= deadline) fail('baro_readback_timeout', `Barometer ${phase} was not confirmed. No automatic retry was sent.`);
      await sleep(Math.min(50, deadline - now()));
    }
  };
  const advanced = (side: Side, s: Reading) => !pending[side] || s.times[pending[side].property] > pending[side].time;
  const stage = async (property: string, satisfied: (s: Reading) => boolean, code: (side: Side) => string) => {
    const start = current();
    for (const side of sides) {
      if (!satisfied(current().sides[side])) await dispatch(side, property, code(side));
      else if (!satisfied(start.sides[side])) {
        pending[side] = { property, time: start.sides[side].times[property] };
        if (operation !== 'std') pressureBaselines[side] = start.sides[side].times.pressure;
      }
    }
    await wait(state => sides.every(side => satisfied(state.sides[side]) && advanced(side, state.sides[side])));
    for (const side of sides) delete pending[side];
  };
  try {
    if (operation !== 'std') {
      const input = BARO_INPUTS[operation];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < input.min || value > input.max
        || Math.abs(value * scale - desired) > 1e-7) fail('invalid_baro_value', 'Enter a valid pressure in the selected units.');
    }
    current();
    if (operation === 'std') await stage('qnh', s => !s.qnh, side => fenixBaroCounter(side, true, 1));
    else {
      phase = 'units';
      await stage('units', s => s.units === (inHg ? 'inhg' : 'hpa'), side => fenixBaroUnits(side, inHg));
      unitsSet = true; phase = 'QNH mode';
      await stage('qnh', s => s.qnh, side => fenixBaroCounter(side, true, -1));
      qnhSet = true; phase = 'pressure';
      const limits = BARO_INPUTS[operation];
      // Mode and numeric display updates can arrive in separate polls. Wait
      // through STD's blank/zero display before attempting the first detent.
      await wait(state => sides.every(side => {
        const number = pressure(state.sides[side]);
        return number != null && number >= Math.round(limits.min * scale) && number <= Math.round(limits.max * scale)
          && pressureRefreshed(side, state.sides[side]);
      }));
      const initialPressure = current();
      if (sides.some(side => !matches(side, initialPressure.sides[side]))) {
        const sampleTime = Math.max(...sides.map(side => initialPressure.sides[side].times.pressure));
        await wait(state => sides.every(side => state.sides[side].times.pressure >= sampleTime));
      }
      for (let step = 0; step < 403; step++) {
        const start = current();
        if (sides.every(side => matches(side, start.sides[side]))) break;
        let pressureObservationTime = 0;
        for (const side of sides) if (pressure(start.sides[side]) !== desired) {
          pending[side] = { property: 'pressure', time: start.sides[side].times.pressure };
        }
        const expected: Partial<Record<Side, number>> = {};
        const confirmsStep = (side: Side, state: FenixBaroState) => {
          const s = state.sides[side], observed = pressure(s), before = pressure(start.sides[side]);
          if (advanced(side, s) && observed !== before && observed !== expected[side])
            fail('baro_changed', 'Pressure moved by an unexpected amount. Check altimeter linking or knob acceleration.');
          return advanced(side, s) && observed === expected[side];
        };
        for (const side of sides) {
          // Each display is polled independently. A peer sample older than the
          // confirmed detent cannot establish whether native linking moved it.
          await wait(state => state.sides[side].times.pressure >= pressureObservationTime);
          const before = current().sides[side], number = pressure(before);
          if (number == null || number < Math.round(limits.min * scale) || number > Math.round(limits.max * scale))
            fail('baro_unavailable', 'The selected pressure readback is unavailable or outside the supported range.');
          const initial = pressure(start.sides[side]);
          if (initial == null) fail('baro_unavailable', 'Fresh pressure data is required.');
          expected[side] = initial === desired ? initial : initial + (initial < desired ? 1 : -1);
          // Native altimeter linking may already have moved this side by the
          // intended detent. Re-sample before sending a redundant linked input.
          if (number === expected[side]) {
            if (number !== initial) pending[side] = { property: 'pressure', time: start.sides[side].times.pressure };
            continue;
          }
          if (number !== initial) fail('baro_changed', 'Pressure changed during the request.');
          await dispatch(side, 'pressure', fenixBaroCounter(side, false, number < desired ? 1 : -1));
          // An ACK does not mean the aircraft has processed the detent. Wait
          // for its readback before re-sampling a potentially linked other side.
          const confirmed = await wait(state => confirmsStep(side, state));
          pressureObservationTime = confirmed.sides[side].times.pressure;
        }
        await wait(state => sides.every(side => confirmsStep(side, state)));
        for (const side of sides) delete pending[side];
      }
    }
    const final = current();
    if (!sides.every(side => matches(side, final.sides[side]))) fail('baro_changed', 'Barometer changed before final confirmation.');
    return { ok: true, code: 'executed', ...(!executionStarted ? { noOp: true, idempotent: true } : {}),
      baro: { target, mode: operation === 'std' ? 'std' : 'qnh', ...(operation === 'std' ? {} : { unit, value }), confirmedSides: sides } };
  } catch (error) {
    const observed = isCurrent() ? capture() : null;
    const confirmedSides = observed?.healthy ? sides.filter(side => observed.sides[side] && advanced(side, observed.sides[side]) && matches(side, observed.sides[side])) : [];
    return { ok: false, code: error.code || 'baro_write_failed', executionStarted, error: error.message || 'Barometer control failed.',
      baro: { target, mode: operation === 'std' ? 'std' : 'qnh', ...(operation === 'std' ? {} : { unit, value }), confirmedSides } };
  }
}
