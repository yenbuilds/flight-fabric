'use strict';

const { decodeLights } = require('../utils/helpers');

const LIGHT_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  NAV_LIGHTS_SET: 'nav',
  BEACON_LIGHTS_SET: 'beacon',
  STROBES_SET: 'strobe',
  LANDING_LIGHTS_SET: 'landing',
  TAXI_LIGHTS_SET: 'taxi',
});

export function captureLightMaskSample({
  source, raw, snapshot, sequence, profileMatches = true, nowMs, fieldKey, notBeforeMs = 0,
}: Record<string, any>): Record<string, any> {
  const mask = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 0xffffffff
    ? raw : null;
  const updatedAt = fieldKey && snapshot.valueUpdatedAt
    ? snapshot.valueUpdatedAt[fieldKey] : snapshot.updatedAt;
  const updatedAtMs = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  const validSequence = Number.isSafeInteger(sequence) && Number(sequence) > 0 ? Number(sequence) : null;
  return {
    source,
    mask,
    sequence: validSequence,
    updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : null,
    fresh: mask != null && profileMatches && validSequence != null
      && ['running', 'connected'].includes(snapshot.status)
      && Number.isFinite(updatedAtMs) && updatedAtMs >= notBeforeMs
      && nowMs - updatedAtMs >= 0 && nowMs - updatedAtMs <= 2000,
  };
}

export function captureGenericLightReadback({
  eventName, profileKey, nativeMask, nativeSnapshot, nativeSequence, gaugeSnapshot, nowMs, notBeforeMs = 0,
}: Record<string, any>): Record<string, any> | null {
  const light = LIGHT_EVENTS[eventName];
  if (!light) return null;
  const sample = (source: string, raw: unknown, snapshot: Record<string, any>, sequence: unknown, profileMatches: boolean, fieldKey?: string) => {
    const captured = captureLightMaskSample({ source, raw, snapshot, sequence, profileMatches, nowMs, fieldKey, notBeforeMs });
    return {
      ...captured,
      observed: captured.mask == null ? null : decodeLights(captured.mask)[light],
    };
  };
  return {
    light,
    native: sample('simvar:lightStates', nativeMask, nativeSnapshot, nativeSequence, true),
    gauge: sample('lvar:standard_light_states', gaugeSnapshot.values?.standard_light_states,
      gaugeSnapshot, gaugeSnapshot.snapshotSequence, gaugeSnapshot.profileId === profileKey, 'standard_light_states'),
  };
}

export function describeGenericLightReadback(
  before: Record<string, any> | null,
  after: Record<string, any> | null,
  requestedValue: number,
  dispatchedAtMs: number,
): Record<string, any> {
  if (!before || !after) return { status: 'not_observed', before, after };
  // Match samples only within the same source. A gauge/native disagreement is
  // useful diagnostic evidence, not a transition caused by the command.
  const source = after.gauge.fresh ? 'gauge' : 'native';
  const baseline = before[source];
  const current = after[source];
  const newer = current.fresh && current.sequence > (baseline.sequence ?? 0)
    && Date.parse(current.updatedAt) >= dispatchedAtMs;
  const expected = requestedValue === 1;
  const status = !current.fresh ? 'unavailable'
    : !newer ? 'no_new_sample'
      : current.observed !== expected ? 'mismatch'
        : !baseline.fresh ? 'matched_without_baseline'
          : baseline.observed === expected ? 'already_matched'
            : 'changed_to_requested';
  return { status, source: current.source, before, after };
}
