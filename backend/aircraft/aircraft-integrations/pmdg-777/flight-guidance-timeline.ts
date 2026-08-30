'use strict';

type AnyRecord = Record<string, any>;
type Primitive = boolean | number | string;

type Observation = {
  value: Primitive;
  reference?: string;
  unit?: string;
  modeLabel?: string;
};

type PendingTransition = {
  current: Observation;
  previous: Observation;
  firstObservedElapsedMs: number;
  settleMs: number;
};

type CoverageInterval = {
  startElapsedMs: number;
  endElapsedMs: number;
  startTimestampMs: number | null;
  endTimestampMs: number | null;
};

type FlightGuidanceProjectionEvent = {
  type: 'flight_guidance_event';
  eventType: string;
  flightElapsedMs: number;
  confirmedAtElapsedMs: number;
  fieldId: string;
  previous: Primitive;
  current: Primitive;
  label: string;
  summary: string;
  confidence: 'profile-confirmed';
  source: 'sdk';
  integrationId: 'pmdg-777';
  aircraftProfileId: string | null;
  mode?: string;
  referenceGroup?: string;
  previousReference?: string;
  currentReference?: string;
  target?: string;
  unit?: string;
  context?: AnyRecord;
};

type FlightGuidanceProjection = {
  applicable: boolean;
  active: boolean;
  integrationId: 'pmdg-777';
  summary: {
    integrationId: 'pmdg-777';
    aircraftProfileId: string | null;
  };
  events: FlightGuidanceProjectionEvent[];
  eventCount: number;
  truncatedCount: number;
  coverageTruncatedCount: number;
  coverage: CoverageInterval[];
};

type ProjectorOptions = {
  modeSettleMs?: number;
  targetSettleMs?: number;
  maxEvents?: number;
  maxCoverageIntervals?: number;
};

const PMDG_777_INTEGRATION_ID = 'pmdg-777';
const PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION_ID = 'pmdg-777.flight-guidance';
const PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION_VERSION = 1;
const DEFAULT_MODE_SETTLE_MS = 500;
// The aircraft-specific recorder coalesces numeric fields to approximately 1 Hz.
// A longer replay settle window collapses a normal rotary burst to its final value.
const DEFAULT_TARGET_SETTLE_MS = 1500;
const DEFAULT_MAX_EVENTS = 2000;
const DEFAULT_MAX_COVERAGE_INTERVALS = 2048;
const FLIGHT_GUIDANCE_DEDUPE_WINDOW_MS = 2500;
const LATERAL_MODE_LABELS = new Set(['LNAV', 'HDG HOLD', 'TRK HOLD', 'LOC', 'APP']);
const VERTICAL_MODE_LABELS = new Set(['VNAV', 'FLCH', 'V/S', 'FPA', 'ALT HOLD', 'APP']);
const AUTOMATION_MODE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  HDG: 'HDG HOLD',
  LVL_CHG: 'FLCH',
  VS: 'V/S',
  ALT: 'ALT HOLD',
});
const PMDG_777_PROFILE_KEYS = new Set([
  'pmdg-777',
  'pmdg-777-200er',
  'pmdg-777-200lr',
  'pmdg-777f',
]);

const FIELD = Object.freeze({
  apEngaged: 'flightGuidance.apEngaged',
  athrArmed: 'flightGuidance.autothrottleArmed',
  lnav: 'flightGuidance.lnav',
  vnav: 'flightGuidance.vnav',
  flch: 'flightGuidance.flch',
  headingHold: 'flightGuidance.headingHold',
  verticalSpeed: 'flightGuidance.verticalSpeed',
  altitudeHold: 'flightGuidance.altitudeHold',
  localizer: 'flightGuidance.localizer',
  approach: 'flightGuidance.approach',
  speedKts: 'flightGuidance.speedKts',
  mach: 'flightGuidance.mach',
  headingDeg: 'flightGuidance.headingDeg',
  altitudeFt: 'flightGuidance.altitudeFt',
  vsFpm: 'flightGuidance.vsFpm',
  fpaDeg: 'flightGuidance.fpaDeg',
  headingMode: 'flightGuidance.headingMode',
  verticalMode: 'flightGuidance.verticalMode',
});

const ALLOWED_FIELDS: Set<string> = new Set(Object.values(FIELD));
const BOOLEAN_MODE_FIELDS = Object.freeze([
  { fieldId: FIELD.lnav, label: 'LNAV' },
  { fieldId: FIELD.vnav, label: 'VNAV' },
  { fieldId: FIELD.flch, label: 'FLCH' },
  { fieldId: FIELD.headingHold, label: 'HDG/TRK HOLD' },
  { fieldId: FIELD.verticalSpeed, label: 'V/S/FPA' },
  { fieldId: FIELD.altitudeHold, label: 'ALT HOLD' },
  { fieldId: FIELD.localizer, label: 'LOC' },
  { fieldId: FIELD.approach, label: 'APP' },
]);

const SIGNAL_KEYS = Object.freeze([
  'ap',
  'athr-arm',
  ...BOOLEAN_MODE_FIELDS.map(({ fieldId }) => `mode:${fieldId}`),
  'reference:heading',
  'reference:vertical',
  'target:speed',
  'target:heading',
  'target:altitude',
  'target:vertical',
]);

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function pmdgFlightGuidanceEventMatchesAutomation(
  automationEvent: AnyRecord,
  guidanceEvent: AnyRecord,
): boolean {
  const automationEventType = nonEmptyText(automationEvent?.eventType) || '';
  if (
    automationEventType === 'ap_engaged'
    || automationEventType === 'ap_disengaged'
    || automationEventType === 'athr_armed'
    || automationEventType === 'athr_disarmed'
  ) {
    return guidanceEvent?.eventType === automationEventType;
  }

  const selectedMode = String(guidanceEvent?.mode || '').trim().toUpperCase();
  if (automationEventType === 'approach_armed') {
    return guidanceEvent?.eventType === 'guidance_mode_selected' && selectedMode === 'APP';
  }
  if (automationEventType === 'loc_captured') {
    return guidanceEvent?.eventType === 'guidance_mode_selected' && selectedMode === 'LOC';
  }

  const currentRaw = String(automationEvent?.current || '').trim().toUpperCase();
  const current = AUTOMATION_MODE_ALIASES[currentRaw] || currentRaw;
  if (automationEventType === 'lateral_mode_changed') {
    return (
      guidanceEvent?.eventType === 'guidance_mode_selected'
      && LATERAL_MODE_LABELS.has(selectedMode)
      && (!current || selectedMode === current)
    ) || (
      guidanceEvent?.eventType === 'guidance_reference_changed'
      && guidanceEvent?.referenceGroup === 'heading'
      && (!currentRaw || String(guidanceEvent?.currentReference || '').toUpperCase() === currentRaw)
    );
  }
  if (automationEventType === 'vertical_mode_changed') {
    return (
      guidanceEvent?.eventType === 'guidance_mode_selected'
      && VERTICAL_MODE_LABELS.has(selectedMode)
      && (!current || selectedMode === current)
    ) || (
      guidanceEvent?.eventType === 'guidance_reference_changed'
      && guidanceEvent?.referenceGroup === 'vertical'
      && (!currentRaw || String(guidanceEvent?.currentReference || '').toUpperCase() === currentRaw)
    );
  }
  return false;
}

function observationKey(observation: Observation): string {
  return JSON.stringify({
    value: observation.value,
    reference: observation.reference || null,
    unit: observation.unit || null,
  });
}

function sameObservation(left: Observation, right: Observation): boolean {
  return observationKey(left) === observationKey(right);
}

function normalizeHeading(value: number): number {
  const normalized = ((Math.round(value) % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatTargetValue(observation: Observation): string {
  const value = Number(observation.value);
  if (!Number.isFinite(value)) return String(observation.value);
  if (observation.reference === 'MACH') return `M${value.toFixed(2)}`;
  if (observation.reference === 'FPA') return `${value.toFixed(1)} deg`;
  if (observation.unit === 'deg') return `${formatInteger(value)} deg`;
  return `${formatInteger(value)} ${observation.unit || ''}`.trim();
}

function isPmdg777ProfileKey(value: unknown): boolean {
  const profileLeaf = (nonEmptyText(value) || '')
    .toLowerCase()
    .split(/[\\/]/)
    .pop() || '';
  return PMDG_777_PROFILE_KEYS.has(profileLeaf);
}

function isPmdg777Config(row: AnyRecord): boolean {
  const integrationId = nonEmptyText(row.integrationId)?.toLowerCase();
  const templateId = nonEmptyText(row.templateId)?.toLowerCase();
  if (integrationId === PMDG_777_INTEGRATION_ID || templateId === PMDG_777_INTEGRATION_ID) {
    return true;
  }

  return isPmdg777ProfileKey(row.profileKey);
}

function sanitizeFieldTypes(row: AnyRecord): Set<string> {
  const fieldTypes = isRecord(row.fieldTypes) ? row.fieldTypes : {};
  const fieldCatalog = Array.isArray(row.fieldCatalog) ? row.fieldCatalog : [];
  const fields = new Set<string>();
  for (const fieldId of Object.keys(fieldTypes)) {
    if (ALLOWED_FIELDS.has(fieldId)) fields.add(fieldId);
  }
  for (const item of fieldCatalog) {
    const fieldId = nonEmptyText(item?.id);
    if (fieldId && ALLOWED_FIELDS.has(fieldId)) fields.add(fieldId);
  }
  // Legacy schema-v1 configs may not have persisted a catalog. Values remain
  // allowlisted below, so retain compatibility without accepting arbitrary data.
  if (fields.size === 0 && row.schemaVersion === 1) {
    for (const fieldId of ALLOWED_FIELDS) fields.add(fieldId);
  }
  return fields;
}

function sanitizeValues(value: unknown, allowedFields: Set<string>): Record<string, Primitive> {
  if (!isRecord(value)) return {};
  const output: Record<string, Primitive> = {};
  for (const fieldId of allowedFields) {
    const fieldValue = value[fieldId];
    if (
      typeof fieldValue === 'boolean'
      || typeof fieldValue === 'string'
      || (typeof fieldValue === 'number' && Number.isFinite(fieldValue))
    ) {
      output[fieldId] = fieldValue;
    }
  }
  return output;
}

function sanitizeUnavailable(value: unknown, allowedFields: Set<string>): Set<string> {
  const output = new Set<string>();
  if (!Array.isArray(value)) return output;
  for (const fieldId of value) {
    if (typeof fieldId === 'string' && allowedFields.has(fieldId)) output.add(fieldId);
  }
  return output;
}

function applySourceStatusDelta(previous: AnyRecord, delta: unknown): AnyRecord {
  if (!isRecord(delta)) return previous;
  const next: AnyRecord = {
    overall: previous.overall,
    sources: isRecord(previous.sources) ? { ...previous.sources } : {},
  };
  const overall = nonEmptyText(delta.overall);
  if (overall) next.overall = overall.toLowerCase();
  if (isRecord(delta.sourcesSet)) {
    for (const [sourceId, status] of Object.entries(delta.sourcesSet)) {
      const normalized = nonEmptyText(status)?.toLowerCase();
      if (normalized) next.sources[sourceId] = normalized;
    }
  }
  if (Array.isArray(delta.sourcesRemoved)) {
    for (const sourceId of delta.sourcesRemoved) {
      if (typeof sourceId === 'string') delete next.sources[sourceId];
    }
  }
  return next;
}

function sanitizeSourceStatus(value: unknown): AnyRecord {
  if (!isRecord(value)) return { overall: 'awaiting-values', sources: {} };
  const sources: AnyRecord = {};
  if (isRecord(value.sources)) {
    for (const [sourceId, status] of Object.entries(value.sources)) {
      const normalized = nonEmptyText(status)?.toLowerCase();
      if (normalized) sources[sourceId] = normalized;
    }
  }
  return {
    overall: nonEmptyText(value.overall)?.toLowerCase() || 'awaiting-values',
    sources,
  };
}

function createPmdg777FlightGuidanceProjector(options: ProjectorOptions = {}) {
  const modeSettleMs = Number.isFinite(options.modeSettleMs)
    ? Math.max(0, Number(options.modeSettleMs))
    : DEFAULT_MODE_SETTLE_MS;
  const targetSettleMs = Number.isFinite(options.targetSettleMs)
    ? Math.max(0, Number(options.targetSettleMs))
    : DEFAULT_TARGET_SETTLE_MS;
  const maxEvents = Number.isSafeInteger(options.maxEvents)
    ? Math.max(0, Number(options.maxEvents))
    : DEFAULT_MAX_EVENTS;
  const maxCoverageIntervals = Number.isSafeInteger(options.maxCoverageIntervals)
    ? Math.max(0, Number(options.maxCoverageIntervals))
    : DEFAULT_MAX_COVERAGE_INTERVALS;

  let flightStartMs: number | null = null;
  let lastElapsedMs = 0;
  let activeConfigId: number | null = null;
  let activeProfileId: string | null = null;
  let activePmdgConfig = false;
  let applicable = false;
  let coverageStartElapsedMs: number | null = null;
  let allowedFields = new Set<string>();
  let values: Record<string, Primitive> = {};
  let unavailable = new Set<string>();
  let sourceStatus: AnyRecord = { overall: 'awaiting-values', sources: {} };
  let needsBaseline = true;
  let truncatedCount = 0;
  let coverageTruncatedCount = 0;
  let coverageSuppressedConnection = false;
  const confirmed = new Map<string, Observation>();
  const pending = new Map<string, PendingTransition>();
  const events: FlightGuidanceProjectionEvent[] = [];
  const coverage: CoverageInterval[] = [];

  function rowElapsedMs(row: AnyRecord): number {
    const explicit = finiteNumber(row.flightElapsedMs);
    if (explicit !== null && explicit >= 0) return Math.max(lastElapsedMs, explicit);
    const timeMs = finiteNumber(row.timeMs);
    if (timeMs !== null && flightStartMs !== null) return Math.max(lastElapsedMs, timeMs - flightStartMs);
    return lastElapsedMs;
  }

  function timestampForElapsed(elapsedMs: number): number | null {
    return flightStartMs === null ? null : flightStartMs + elapsedMs;
  }

  function closeCoverage(endElapsedMs: number): void {
    if (coverageStartElapsedMs === null) return;
    const normalizedEnd = Math.max(coverageStartElapsedMs, endElapsedMs);
    coverage.push({
      startElapsedMs: coverageStartElapsedMs,
      endElapsedMs: normalizedEnd,
      startTimestampMs: timestampForElapsed(coverageStartElapsedMs),
      endTimestampMs: timestampForElapsed(normalizedEnd),
    });
    coverageStartElapsedMs = null;
  }

  function sourceIsFresh(): boolean {
    return activePmdgConfig
      && sourceStatus.overall === 'connected'
      && sourceStatus.sources?.sdk === 'connected';
  }

  function syncCoverage(elapsedMs: number): void {
    if (sourceIsFresh()) {
      if (coverageStartElapsedMs !== null || coverageSuppressedConnection) return;
      if (coverage.length >= maxCoverageIntervals) {
        coverageSuppressedConnection = true;
        coverageTruncatedCount += 1;
        confirmed.clear();
        pending.clear();
        needsBaseline = true;
      } else {
        coverageStartElapsedMs = elapsedMs;
      }
    } else {
      closeCoverage(elapsedMs);
      coverageSuppressedConnection = false;
    }
  }

  function resetLogicalState(): void {
    values = {};
    unavailable = new Set<string>();
    sourceStatus = { overall: 'awaiting-values', sources: {} };
    confirmed.clear();
    pending.clear();
    needsBaseline = true;
    coverageSuppressedConnection = false;
  }

  function sdkSourceConnected(): boolean {
    return sourceIsFresh()
      && coverageStartElapsedMs !== null
      && !coverageSuppressedConnection;
  }

  function knownValue(fieldId: string): Primitive | null {
    if (!allowedFields.has(fieldId) || unavailable.has(fieldId)) return null;
    const value = values[fieldId];
    if (typeof value === 'boolean' || typeof value === 'string') return value;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function exactEnum(fieldId: string, allowed: readonly string[]): string | null {
    const value = knownValue(fieldId);
    return typeof value === 'string' && allowed.includes(value) ? value : null;
  }

  function booleanObservation(fieldId: string, modeLabel?: string): Observation | null {
    const value = knownValue(fieldId);
    return typeof value === 'boolean' ? { value, ...(modeLabel ? { modeLabel } : {}) } : null;
  }

  function numberObservation(fieldId: string, unit: string, reference?: string): Observation | null {
    const value = knownValue(fieldId);
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalizedValue = fieldId === FIELD.headingDeg ? normalizeHeading(value) : value;
    return {
      value: normalizedValue,
      unit,
      ...(reference ? { reference } : {}),
    };
  }

  function observe(signalKey: string): Observation | null {
    if (!sdkSourceConnected()) return null;
    if (signalKey === 'ap') return booleanObservation(FIELD.apEngaged);
    if (signalKey === 'athr-arm') return booleanObservation(FIELD.athrArmed);

    if (signalKey.startsWith('mode:')) {
      const fieldId = signalKey.slice('mode:'.length);
      const definition = BOOLEAN_MODE_FIELDS.find((item) => item.fieldId === fieldId);
      if (!definition) return null;
      let modeLabel = definition.label;
      if (fieldId === FIELD.headingHold) {
        const headingMode = exactEnum(FIELD.headingMode, ['HDG', 'TRK']);
        modeLabel = headingMode ? `${headingMode} HOLD` : definition.label;
      } else if (fieldId === FIELD.verticalSpeed) {
        const verticalMode = exactEnum(FIELD.verticalMode, ['VS', 'FPA']);
        modeLabel = verticalMode === 'FPA'
          ? 'FPA'
          : verticalMode === 'VS'
            ? 'V/S'
            : definition.label;
      }
      return booleanObservation(fieldId, modeLabel);
    }

    if (signalKey === 'reference:heading') {
      const value = exactEnum(FIELD.headingMode, ['HDG', 'TRK']);
      return value ? { value } : null;
    }
    if (signalKey === 'reference:vertical') {
      const value = exactEnum(FIELD.verticalMode, ['VS', 'FPA']);
      return value ? { value } : null;
    }

    if (signalKey === 'target:speed') {
      const speed = numberObservation(FIELD.speedKts, 'kt', 'KTS');
      if (speed) return speed;
      return numberObservation(FIELD.mach, 'mach', 'MACH');
    }
    if (signalKey === 'target:heading') return numberObservation(FIELD.headingDeg, 'deg', 'HDG');
    if (signalKey === 'target:altitude') return numberObservation(FIELD.altitudeFt, 'ft', 'ALT');
    if (signalKey === 'target:vertical') {
      const reference = exactEnum(FIELD.verticalMode, ['VS', 'FPA']);
      if (reference === 'FPA') return numberObservation(FIELD.fpaDeg, 'deg', 'FPA');
      if (reference === 'VS') return numberObservation(FIELD.vsFpm, 'fpm', 'VS');
      return null;
    }
    return null;
  }

  function fieldIdForSignal(signalKey: string, observation: Observation): string {
    if (signalKey === 'ap') return FIELD.apEngaged;
    if (signalKey === 'athr-arm') return FIELD.athrArmed;
    if (signalKey.startsWith('mode:')) return signalKey.slice('mode:'.length);
    if (signalKey === 'reference:heading') return FIELD.headingMode;
    if (signalKey === 'reference:vertical') return FIELD.verticalMode;
    if (signalKey === 'target:heading') return FIELD.headingDeg;
    if (signalKey === 'target:altitude') return FIELD.altitudeFt;
    if (signalKey === 'target:speed') return observation.reference === 'MACH' ? FIELD.mach : FIELD.speedKts;
    if (signalKey === 'target:vertical') return observation.reference === 'FPA' ? FIELD.fpaDeg : FIELD.vsFpm;
    return signalKey;
  }

  function emitTransition(
    signalKey: string,
    transition: PendingTransition,
    confirmedAtElapsedMs: number,
  ): void {
    const previous = transition.previous;
    const current = transition.current;
    const base: Omit<FlightGuidanceProjectionEvent, 'eventType' | 'label' | 'summary'> = {
      type: 'flight_guidance_event',
      flightElapsedMs: transition.firstObservedElapsedMs,
      confirmedAtElapsedMs,
      fieldId: fieldIdForSignal(signalKey, current),
      previous: previous.value,
      current: current.value,
      confidence: 'profile-confirmed',
      source: 'sdk',
      integrationId: PMDG_777_INTEGRATION_ID,
      aircraftProfileId: activeProfileId,
    };

    let event: FlightGuidanceProjectionEvent;
    if (signalKey === 'ap') {
      event = {
        ...base,
        eventType: current.value === true ? 'ap_engaged' : 'ap_disengaged',
        label: current.value === true ? 'AP engaged' : 'AP disengaged',
        summary: '',
      };
    } else if (signalKey === 'athr-arm') {
      event = {
        ...base,
        eventType: current.value === true ? 'athr_armed' : 'athr_disarmed',
        label: current.value === true ? 'A/T armed' : 'A/T disarmed',
        summary: '',
      };
    } else if (signalKey.startsWith('mode:')) {
      const mode = current.modeLabel || 'Guidance mode';
      event = {
        ...base,
        eventType: current.value === true ? 'guidance_mode_selected' : 'guidance_mode_deselected',
        mode,
        label: `${mode} ${current.value === true ? 'selected' : 'deselected'}`,
        summary: '',
      };
    } else if (signalKey.startsWith('reference:')) {
      const heading = signalKey === 'reference:heading';
      event = {
        ...base,
        eventType: 'guidance_reference_changed',
        referenceGroup: heading ? 'heading' : 'vertical',
        previousReference: String(previous.value),
        currentReference: String(current.value),
        label: `${heading ? 'Heading' : 'Vertical'} reference changed`,
        summary: `${previous.value} -> ${current.value}`,
      };
    } else {
      const target = signalKey.slice('target:'.length);
      const targetLabel = target === 'vertical' ? 'vertical target' : target;
      event = {
        ...base,
        eventType: 'mcp_target_changed',
        target,
        unit: current.unit,
        previousReference: previous.reference,
        currentReference: current.reference,
        label: `MCP ${targetLabel} changed`,
        summary: `${formatTargetValue(previous)} -> ${formatTargetValue(current)}`,
      };
    }

    event.context = {
      field_id: event.fieldId,
      previous: event.previous,
      current: event.current,
      confidence: event.confidence,
      source: event.source,
      aircraft_profile_id: event.aircraftProfileId,
      integration_id: event.integrationId,
      ...(event.mode ? { mode: event.mode } : {}),
      ...(event.referenceGroup ? { reference_group: event.referenceGroup } : {}),
      ...(event.previousReference ? { previous_reference: event.previousReference } : {}),
      ...(event.currentReference ? { current_reference: event.currentReference } : {}),
      ...(event.target ? { target: event.target } : {}),
      ...(event.unit ? { unit: event.unit } : {}),
    };

    if (events.length < maxEvents) events.push(event);
    else truncatedCount += 1;
  }

  function advancePending(elapsedMs: number): void {
    if (!sdkSourceConnected()) return;
    for (const [signalKey, transition] of pending) {
      if (elapsedMs - transition.firstObservedElapsedMs < transition.settleMs) continue;
      const current = observe(signalKey);
      if (!current || !sameObservation(current, transition.current)) continue;
      emitTransition(signalKey, transition, elapsedMs);
      confirmed.set(signalKey, current);
      pending.delete(signalKey);
    }
  }

  function evaluate(elapsedMs: number): void {
    if (!sdkSourceConnected()) {
      confirmed.clear();
      pending.clear();
      needsBaseline = true;
      return;
    }

    for (const signalKey of SIGNAL_KEYS) {
      const observation = observe(signalKey);
      if (!observation) {
        confirmed.delete(signalKey);
        pending.delete(signalKey);
        continue;
      }

      const previous = confirmed.get(signalKey);
      if (needsBaseline || !previous) {
        confirmed.set(signalKey, observation);
        pending.delete(signalKey);
        continue;
      }

      if (sameObservation(previous, observation)) {
        pending.delete(signalKey);
        continue;
      }

      // IAS/Mach and V/S/FPA targets are discriminated unions. A reference
      // change establishes a fresh target baseline instead of comparing unlike units.
      if (
        signalKey.startsWith('target:')
        && previous.reference
        && observation.reference
        && previous.reference !== observation.reference
      ) {
        confirmed.set(signalKey, observation);
        pending.delete(signalKey);
        continue;
      }

      const existing = pending.get(signalKey);
      if (existing && sameObservation(existing.current, observation)) {
        existing.current = observation;
        continue;
      }

      pending.set(signalKey, {
        previous,
        current: observation,
        firstObservedElapsedMs: elapsedMs,
        settleMs: signalKey.startsWith('target:') ? targetSettleMs : modeSettleMs,
      });
    }
    needsBaseline = false;
  }

  function applyConfig(row: AnyRecord, elapsedMs: number): void {
    if (activePmdgConfig) closeCoverage(elapsedMs);
    resetLogicalState();
    allowedFields = sanitizeFieldTypes(row);
    activeConfigId = Number.isSafeInteger(row.configId) ? Number(row.configId) : null;
    activeProfileId = nonEmptyText(row.profileKey);
    activePmdgConfig = isPmdg777Config(row) && allowedFields.size > 0;
    if (activePmdgConfig) applicable = true;
  }

  function applyCheckpoint(row: AnyRecord): void {
    values = sanitizeValues(row.values, allowedFields);
    unavailable = sanitizeUnavailable(row.unavailable, allowedFields);
    sourceStatus = sanitizeSourceStatus(row.sourceStatus);
  }

  function applyDelta(row: AnyRecord): void {
    const setValues = sanitizeValues(row.valuesSet, allowedFields);
    for (const [fieldId, value] of Object.entries(setValues)) values[fieldId] = value;
    if (Array.isArray(row.valuesRemoved)) {
      for (const fieldId of row.valuesRemoved) {
        if (typeof fieldId === 'string' && allowedFields.has(fieldId)) delete values[fieldId];
      }
    }
    if (Array.isArray(row.unavailableAdded)) {
      for (const fieldId of row.unavailableAdded) {
        if (typeof fieldId === 'string' && allowedFields.has(fieldId)) unavailable.add(fieldId);
      }
    }
    if (Array.isArray(row.unavailableRemoved)) {
      for (const fieldId of row.unavailableRemoved) {
        if (typeof fieldId === 'string' && allowedFields.has(fieldId)) unavailable.delete(fieldId);
      }
    }
    sourceStatus = applySourceStatusDelta(sourceStatus, row.sourceStatusChanged);
  }

  function consume(row: AnyRecord): void {
    if (!isRecord(row)) return;
    if (row.type === 'aircraft_specific_manifest') {
      flightStartMs = finiteNumber(row.timeMs)
        ?? (nonEmptyText(row.flightStartIso) ? Date.parse(String(row.flightStartIso)) : null);
      if (flightStartMs !== null && !Number.isFinite(flightStartMs)) flightStartMs = null;
      lastElapsedMs = 0;
      return;
    }

    const elapsedMs = rowElapsedMs(row);
    advancePending(elapsedMs);
    lastElapsedMs = elapsedMs;

    if (row.type === 'aircraft_specific_config') {
      applyConfig(row, elapsedMs);
      return;
    }
    if (!activePmdgConfig) return;
    if (
      activeConfigId !== null
      && Number.isSafeInteger(row.configId)
      && Number(row.configId) !== activeConfigId
    ) return;

    if (row.type === 'aircraft_specific_checkpoint') applyCheckpoint(row);
    else if (row.type === 'aircraft_specific_delta') applyDelta(row);
    else return;
    syncCoverage(elapsedMs);
    evaluate(elapsedMs);
  }

  function finish(): FlightGuidanceProjection {
    advancePending(lastElapsedMs);
    closeCoverage(lastElapsedMs);
    return {
      applicable,
      active: coverage.length > 0,
      integrationId: PMDG_777_INTEGRATION_ID,
      summary: {
        integrationId: PMDG_777_INTEGRATION_ID,
        aircraftProfileId: activeProfileId,
      },
      events: events.slice(),
      eventCount: events.length,
      truncatedCount,
      coverageTruncatedCount,
      coverage: coverage.slice(),
    };
  }

  return { consume, finish };
}

const PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION = Object.freeze({
  id: PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION_ID,
  version: PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION_VERSION,
  eventType: 'flight_guidance_event',
  lane: 'flight-guidance',
  createProjector: createPmdg777FlightGuidanceProjector,
  matchesTimeline: (timeline: AnyRecord) => (
    isPmdg777ProfileKey(timeline?.aircraftProfileId)
    || isPmdg777ProfileKey(timeline?.aircraft_profile_id)
  ),
  automationDedupe: Object.freeze({
    windowMs: FLIGHT_GUIDANCE_DEDUPE_WINDOW_MS,
    matches: pmdgFlightGuidanceEventMatchesAutomation,
  }),
});

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_COVERAGE_INTERVALS,
  DEFAULT_MODE_SETTLE_MS,
  DEFAULT_TARGET_SETTLE_MS,
  FLIGHT_GUIDANCE_DEDUPE_WINDOW_MS,
  PMDG_777_INTEGRATION_ID,
  PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION,
  PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION_ID,
  PMDG_777_FLIGHT_GUIDANCE_TIMELINE_PROJECTION_VERSION,
  createPmdg777FlightGuidanceProjector,
  isPmdg777ProfileKey,
  pmdgFlightGuidanceEventMatchesAutomation,
};

export {};
