/** Both observation and delivery must be recent; reconnect replays cannot refresh old data. */
export function freshAircraftValue(state, fieldId, now = Date.now()) {
  if (state?.sourceStatus !== 'connected' || state?.unavailable?.includes(fieldId)) return null;
  const sampled = Date.parse(state.valueUpdatedAt?.[fieldId]);
  const published = Date.parse(state.updatedAt);
  const elapsed = now - state.receivedAt;
  const age = now - sampled;
  if (!Number.isFinite(age) || !Number.isFinite(state.receivedAt) || elapsed < 0 || elapsed > 2000
      || !Number.isFinite(published) || now - published > 2000 || now - published < -1000
      || sampled > published + 1000 || age < -1000 || age > 2000) return null;
  return state.values?.[fieldId] ?? null;
}
