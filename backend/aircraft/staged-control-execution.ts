import type { ControlCondition, ControlObservation, ControlStage, StagedControlRecipe } from './staged-control-contract.js';

type Observation = { values: Record<string, unknown>; times: Record<string, number> };
export type StagedControlState = { available: boolean; targets: Record<string, Observation> };
export type ControlReadSources = {
  raw: (id: string) => { value: unknown; updatedAt: unknown };
  decoded: (id: string) => { observed: unknown; fresh: boolean; updatedAtMs: number };
};

/** Sample the recipe's own fields; whole-snapshot timestamps never stand in for field freshness. */
export function captureStagedControlState(recipe: StagedControlRecipe, sources: ControlReadSources,
  now = Date.now()): StagedControlState | null {
  const read = (spec: ControlObservation) => {
    const sample = recipe.sampling === 'raw' ? sources.raw(spec.fieldId) : sources.decoded(spec.fieldId);
    const time = recipe.sampling === 'raw'
      ? typeof sample?.['updatedAt'] === 'string' ? Date.parse(sample['updatedAt']) : NaN
      : sample?.['updatedAtMs'];
    const fresh = (recipe.sampling === 'raw' || sample?.['fresh'] === true)
      && Number.isFinite(time) && time <= now && now - time <= recipe.freshnessMs;
    let value = recipe.sampling === 'raw' ? sample?.['value'] : sample?.['observed'];
    let valid = fresh;
    if (spec.type === 'boolean') valid &&= typeof value === 'boolean';
    else if (spec.type === 'boolean01') {
      valid &&= [true, false, 0, 1].includes(value);
      value = value === true || value === 1;
    } else if (spec.type === 'enum') valid &&= spec.values.includes(value);
    else valid &&= typeof value === 'number' && Number.isFinite(value);
    return valid ? { value, time } : spec.optional ? { value: null, time: fresh ? time : 0 } : null;
  };
  let available = true;
  for (const spec of recipe.prerequisites) {
    const value = read(spec);
    if (!value) return null;
    available &&= value.value === spec.equals;
  }
  const targets: StagedControlState['targets'] = {};
  for (const target of recipe.targets) {
    const values: Record<string, unknown> = {}, times: Record<string, number> = {};
    for (const [property, spec] of Object.entries(target.observations)) {
      const value = read(spec);
      if (!value) return null;
      values[property] = value.value; times[property] = value.time;
    }
    for (const [property, spec] of Object.entries(target.observations)) if (spec.rounding && values[property] != null) {
      const scale = values[spec.rounding.property] === spec.rounding.equals ? spec.rounding.scale : spec.rounding.otherwise;
      values[property] = Math.round(Number(values[property]) * scale) / scale;
    }
    targets[target.id] = { values, times };
  }
  return { available, targets };
}

/**
 * A bounded observed-control transaction. Stages describe absolute writes,
 * feedback-confirmed transitions and single increments; linking is inferred
 * only from each selected target's own newer observation, never from an ACK.
 */
export async function executeStagedControl({ recipe, value, capture, isCurrent, write,
  findException = () => null, now = Date.now,
  sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}: {
  recipe: StagedControlRecipe; value?: number; capture: () => StagedControlState | null;
  isCurrent: () => boolean; write: (targetId: string, writeKey: string) => Promise<any>;
  findException?: (ids: number[], since: number) => unknown; now?: () => number; sleep?: (ms: number) => Promise<unknown>;
}) {
  const targets = recipe.targets.map(t => t.id), startedAt = now(), ids: number[] = [];
  const pending: Record<string, { property: string; time: number }> = {};
  const invalidated: Record<string, Record<string, number>> = Object.fromEntries(targets.map(id => [id, {}]));
  const frozen: { conditions: ControlCondition[]; message: string }[] = [];
  let executionStarted = false, phase = recipe.stages[0].phase;
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  const satisfies = (id: string, state: Observation, conditions: ControlCondition[], requireRefresh = true) => conditions.every(c => {
    const observed = state.values[c.property];
    const expected = c.input ? value : c.equals;
    const matches = c.input && c.scale !== undefined
      ? typeof observed === 'number' && Math.round(observed * c.scale) === Math.round(Number(expected) * c.scale)
      : observed === expected;
    return matches && (!requireRefresh || invalidated[id][c.property] == null || state.times[c.property] > invalidated[id][c.property]);
  });
  const matches = (id: string, state: Observation) => satisfies(id, state, recipe.final);
  const advanced = (id: string, state: Observation) => !pending[id] || state.times[pending[id].property] > pending[id].time;
  const current = () => {
    if (!isCurrent()) fail('stale_context', recipe.errors.staleContext);
    if (findException(ids, startedAt)) fail('transport_rejected', recipe.errors.transportRejected);
    const state = capture();
    if (!state?.available || targets.some(id => !state.targets[id])) fail('unavailable', recipe.errors.unavailable);
    for (const guard of frozen) if (targets.some(id => !satisfies(id, state.targets[id], guard.conditions, false))) {
      fail('changed', guard.message);
    }
    return state;
  };
  const deadline = () => recipe.timing.totalTimeoutMs === undefined ? Infinity : startedAt + recipe.timing.totalTimeoutMs;
  const invalidate = (id: string, state: Observation, property?: string) => {
    if (property) invalidated[id][property] = state.times[property];
  };
  const dispatch = async (id: string, property: string, writeKey: string, track: boolean, invalidation?: string) => {
    const before = current().targets[id];
    if (now() >= deadline()) fail('readback_timeout', recipe.errors.timeLimit);
    if (track) pending[id] = { property, time: before.times[property] };
    invalidate(id, before, invalidation); executionStarted = true;
    const ack = await write(id, writeKey);
    for (const sendId of [...(Array.isArray(ack?.sendIds) ? ack.sendIds : []), ack?.sendId]) {
      if (Number.isSafeInteger(sendId) && sendId >= 0 && !ids.includes(sendId)) ids.push(sendId);
    }
    if (ack?.ok !== true) fail('write_rejected', recipe.errors.writeRejected);
  };
  const wait = async (predicate: (state: StagedControlState) => boolean) => {
    const until = Math.min(now() + recipe.timing.readbackTimeoutMs, deadline());
    while (true) {
      const state = current();
      if (predicate(state)) return state;
      if (now() >= until) fail('readback_timeout', recipe.errors.timeout.replace('{phase}', phase));
      await sleep(Math.min(recipe.timing.pollMs, until - now()));
    }
  };
  const clearPending = () => { for (const id of targets) delete pending[id]; };
  const ensure = async (stage: Exclude<ControlStage, { kind: 'step' }>, changed = false) => {
    const baselines: Record<string, Observation> = {};
    const start = current(), affected = stage.kind === 'ensure' && stage.confirmation === 'affected';
    const satisfied = (id: string, s: Observation) => satisfies(id, s, stage.conditions);
    let frontier = Math.max(...targets.map(id => start.targets[id].times[stage.property]));
    // Absolute writes may dispatch together; conditional transitions wait for a
    // shared observation frontier before deciding whether a peer needs a write.
    if (!affected) for (const id of targets) if (!satisfied(id, start.targets[id])) invalidate(id, start.targets[id], stage.invalidate);
    for (const id of targets) {
      if (changed) await wait(state => state.targets[id].times[stage.property] >= frontier);
      const before = current().targets[id];
      if (satisfied(id, before)) {
        if (affected && !satisfied(id, start.targets[id])) {
          pending[id] = { property: stage.property, time: start.targets[id].times[stage.property] };
          invalidate(id, start.targets[id], stage.invalidate);
        }
        continue;
      }
      baselines[id] = before;
      if (!affected) invalidate(id, before, stage.invalidate);
      await dispatch(id, stage.property, stage.write, affected, affected ? stage.invalidate : undefined);
      if (changed) {
        const confirmed = await wait(state => state.targets[id].times[stage.property] > before.times[stage.property]
          && state.targets[id].values[stage.property] !== before.values[stage.property]);
        frontier = confirmed.targets[id].times[stage.property];
      }
    }
    await wait(state => targets.every(id => {
      const before = baselines[id], after = state.targets[id];
      return affected ? satisfied(id, after) && advanced(id, after)
        : !before ? satisfied(id, after) : after.times[stage.property] > before.times[stage.property]
          && (changed ? after.values[stage.property] !== before.values[stage.property] : satisfied(id, after));
    }));
    if (affected) clearPending();
  };
  const step = async (stage: Extract<ControlStage, { kind: 'step' }>) => {
    const number = (s: Observation) => s.values[stage.property] == null ? null : Math.round(Number(s.values[stage.property]) * stage.scale);
    const desired = Math.round(value * stage.scale), min = Math.round(stage.min * stage.scale), max = Math.round(stage.max * stage.scale);
    await wait(state => targets.every(id => {
      const s = state.targets[id], observed = number(s);
      return observed != null && observed >= min && observed <= max
        && (invalidated[id][stage.property] == null || s.times[stage.property] > invalidated[id][stage.property]);
    }));
    const initial = current();
    if (targets.some(id => !matches(id, initial.targets[id]))) {
      const frontier = Math.max(...targets.map(id => initial.targets[id].times[stage.property]));
      await wait(state => targets.every(id => state.targets[id].times[stage.property] >= frontier));
    }
    for (let count = 0; count < stage.maxSteps; count++) {
      const start = current();
      if (targets.every(id => matches(id, start.targets[id]))) break;
      let frontier = 0;
      for (const id of targets) if (number(start.targets[id]) !== desired) {
        pending[id] = { property: stage.property, time: start.targets[id].times[stage.property] };
      }
      const expected: Record<string, number> = {};
      const confirms = (id: string, state: StagedControlState) => {
        const s = state.targets[id], observed = number(s), before = number(start.targets[id]);
        if (advanced(id, s) && observed !== before && observed !== expected[id]) fail('changed', recipe.errors.unexpectedStep);
        return advanced(id, s) && observed === expected[id];
      };
      for (const id of targets) {
        await wait(state => state.targets[id].times[stage.property] >= frontier);
        const before = current().targets[id], observed = number(before);
        if (observed == null || observed < min || observed > max) fail('unavailable', recipe.errors.outOfRange);
        const initialValue = number(start.targets[id]);
        if (initialValue == null) fail('unavailable', recipe.errors.missingValue);
        expected[id] = initialValue === desired ? initialValue : initialValue + (initialValue < desired ? 1 : -1);
        if (observed === expected[id]) {
          if (observed !== initialValue) pending[id] = { property: stage.property, time: start.targets[id].times[stage.property] };
          continue;
        }
        if (observed !== initialValue) fail('changed', recipe.errors.valueChanged);
        await dispatch(id, stage.property, observed < desired ? stage.increase : stage.decrease, true);
        const confirmed = await wait(state => confirms(id, state));
        frontier = confirmed.targets[id].times[stage.property];
      }
      await wait(state => targets.every(id => confirms(id, state)));
      clearPending();
    }
  };
  try {
    if (recipe.input) {
      const input = recipe.input, scaled = input.validation === 'scaled-integer'
        ? value * input.scale : (value - input.min) / input.step;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < input.min || value > input.max
        || Math.abs(scaled - Math.round(scaled)) > 1e-7) fail('invalid_value', recipe.errors.invalidInput);
    }
    current();
    for (const stage of recipe.stages) {
      phase = stage.phase;
      if (stage.kind === 'step') await step(stage);
      else {
        if (stage.kind === 'ensure') await ensure(stage);
        else {
          for (let transition = 0; transition < stage.maxTransitions
            && targets.some(id => !satisfies(id, current().targets[id], stage.conditions)); transition++) await ensure(stage, true);
          await wait(state => targets.every(id => satisfies(id, state.targets[id], stage.completion)));
        }
        if (stage.freeze) frozen.push(stage.freeze);
      }
    }
    const final = current();
    if (!targets.every(id => matches(id, final.targets[id]))) fail('changed', recipe.errors.finalChanged);
    return { ok: true, code: 'executed', ...(!executionStarted ? { noOp: true, idempotent: true } : {}), confirmedTargets: targets };
  } catch (error) {
    const observed = isCurrent() ? capture() : null;
    const confirmedTargets = observed?.available ? targets.filter(id => observed.targets[id]
      && advanced(id, observed.targets[id]) && matches(id, observed.targets[id])) : [];
    return { ok: false, code: error.code || 'failed', executionStarted, error: error.message || recipe.errors.failed, confirmedTargets };
  }
}
