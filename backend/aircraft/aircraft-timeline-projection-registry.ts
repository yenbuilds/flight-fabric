'use strict';

type AnyRecord = Record<string, any>;

type AircraftTimelineProjector = {
  consume: (_row: AnyRecord) => void;
  finish: () => AnyRecord;
};

type AircraftTimelineProjectionDefinition = {
  id: string;
  version: number;
  eventType: string;
  lane: string;
  createProjector: () => AircraftTimelineProjector;
  matchesTimeline: (_timeline: AnyRecord) => boolean;
  automationDedupe?: {
    windowMs: number;
    matches: (_automationEvent: AnyRecord, _projectedEvent: AnyRecord) => boolean;
  };
};

type AircraftTimelineProjectionReference = {
  projectionId: string;
  projection: AnyRecord;
};

const SAFE_PROJECTION_ID_RE = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const SAFE_EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,126}$/;
const SAFE_LANE_RE = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_DEDUPE_WINDOW_MS = 60_000;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeDefinition(
  definition: AircraftTimelineProjectionDefinition,
): Readonly<AircraftTimelineProjectionDefinition> {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('Aircraft Timeline projection definitions must be objects.');
  }
  if (!SAFE_PROJECTION_ID_RE.test(String(definition.id || ''))) {
    throw new TypeError('Aircraft Timeline projection definitions require a safe ID.');
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new TypeError(`Aircraft Timeline projection "${definition.id}" requires a positive contract version.`);
  }
  if (!SAFE_EVENT_TYPE_RE.test(String(definition.eventType || ''))) {
    throw new TypeError(`Aircraft Timeline projection "${definition.id}" requires a safe event type.`);
  }
  if (!SAFE_LANE_RE.test(String(definition.lane || ''))) {
    throw new TypeError(`Aircraft Timeline projection "${definition.id}" requires a safe lane ID.`);
  }
  if (typeof definition.createProjector !== 'function' || typeof definition.matchesTimeline !== 'function') {
    throw new TypeError(`Aircraft Timeline projection "${definition.id}" requires projector and Timeline match functions.`);
  }

  let automationDedupe: AircraftTimelineProjectionDefinition['automationDedupe'];
  if (definition.automationDedupe !== undefined) {
    const windowMs = definition.automationDedupe?.windowMs;
    if (
      !Number.isFinite(windowMs)
      || Number(windowMs) < 0
      || Number(windowMs) > MAX_DEDUPE_WINDOW_MS
      || typeof definition.automationDedupe?.matches !== 'function'
    ) {
      throw new TypeError(`Aircraft Timeline projection "${definition.id}" has an invalid automation dedupe policy.`);
    }
    automationDedupe = Object.freeze({
      windowMs: Number(windowMs),
      matches: definition.automationDedupe.matches,
    });
  }

  return Object.freeze({
    id: definition.id,
    version: definition.version,
    eventType: definition.eventType,
    lane: definition.lane,
    createProjector: definition.createProjector,
    matchesTimeline: definition.matchesTimeline,
    ...(automationDedupe ? { automationDedupe } : {}),
  });
}

function timelineEventElapsedMs(event: AnyRecord): number | null {
  const elapsedMs = finiteNumber(event?.elapsedMs) ?? finiteNumber(event?.flightElapsedMs);
  return elapsedMs !== null && elapsedMs >= 0 ? elapsedMs : null;
}

function timelineEventTimestampMs(event: AnyRecord): number | null {
  return finiteNumber(event?.timestampMs) ?? finiteNumber(event?.timeMs);
}

function eventsAreNearby(
  left: AnyRecord,
  right: AnyRecord,
  windowMs: number,
): boolean {
  const leftElapsed = timelineEventElapsedMs(left);
  const rightElapsed = timelineEventElapsedMs(right);
  if (leftElapsed !== null && rightElapsed !== null) {
    return Math.abs(leftElapsed - rightElapsed) <= windowMs;
  }
  const leftTimestamp = timelineEventTimestampMs(left);
  const rightTimestamp = timelineEventTimestampMs(right);
  return leftTimestamp !== null
    && rightTimestamp !== null
    && Math.abs(leftTimestamp - rightTimestamp) <= windowMs;
}

function createAircraftTimelineProjectionRegistry(
  inputDefinitions: readonly AircraftTimelineProjectionDefinition[] = [],
) {
  const definitions = inputDefinitions.map(normalizeDefinition);
  const definitionsById = new Map<string, Readonly<AircraftTimelineProjectionDefinition>>();
  for (const definition of definitions) {
    if (definitionsById.has(definition.id)) {
      throw new TypeError(`Aircraft Timeline projection ID "${definition.id}" is duplicated.`);
    }
    definitionsById.set(definition.id, definition);
  }

  function getDefinition(projectionId: unknown): Readonly<AircraftTimelineProjectionDefinition> | null {
    return typeof projectionId === 'string' ? definitionsById.get(projectionId) || null : null;
  }

  function createSession() {
    const projectors = definitions.map((definition) => {
      const projector = definition.createProjector();
      if (!projector || typeof projector.consume !== 'function' || typeof projector.finish !== 'function') {
        throw new TypeError(`Aircraft Timeline projection "${definition.id}" created an invalid projector.`);
      }
      return { definition, projector };
    });

    return {
      consume(row: AnyRecord): void {
        for (const { projector } of projectors) projector.consume(row);
      },
      finish(): AircraftTimelineProjectionReference[] {
        const output: AircraftTimelineProjectionReference[] = [];
        for (const { definition, projector } of projectors) {
          const projection = projector.finish();
          if (!isRecord(projection) || !Array.isArray(projection.events)) {
            throw new TypeError(`Aircraft Timeline projection "${definition.id}" returned an invalid result.`);
          }
          if (projection.applicable === true) {
            output.push({ projectionId: definition.id, projection });
          }
        }
        return output;
      },
    };
  }

  function automationEventIsDuplicated(
    automationEvent: AnyRecord,
    projections: readonly AircraftTimelineProjectionReference[],
  ): boolean {
    for (const reference of projections) {
      const definition = getDefinition(reference?.projectionId);
      const policy = definition?.automationDedupe;
      if (!definition || !policy || !Array.isArray(reference?.projection?.events)) continue;
      for (const projectedEvent of reference.projection.events) {
        if (
          eventsAreNearby(automationEvent, projectedEvent, policy.windowMs)
          && policy.matches(automationEvent, projectedEvent)
        ) return true;
      }
    }
    return false;
  }

  function timelineNeedsProjectionRefresh(timeline: AnyRecord): boolean {
    const contracts = isRecord(timeline?.aircraftTimelineProjections)
      ? timeline.aircraftTimelineProjections
      : {};
    return definitions.some((definition) => {
      if (!definition.matchesTimeline(timeline)) return false;
      return Number(contracts?.[definition.id]?.version) !== definition.version;
    });
  }

  function mergeRecordedProjections(
    savedTimeline: AnyRecord,
    recordedTimeline: AnyRecord,
    options: { maxEvents?: number } = {},
  ): AnyRecord {
    const recordedContracts = isRecord(recordedTimeline?.aircraftTimelineProjections)
      ? recordedTimeline.aircraftTimelineProjections
      : {};
    const activeDefinitions = definitions.filter((definition) => (
      Number(recordedContracts?.[definition.id]?.version) === definition.version
    ));
    if (activeDefinitions.length === 0) return savedTimeline;

    const activeIds = new Set(activeDefinitions.map((definition) => definition.id));
    const legacyEventTypes = new Set(activeDefinitions.map((definition) => definition.eventType));
    const recordedEvents = Array.isArray(recordedTimeline?.events) ? recordedTimeline.events : [];
    const recordedProjectionEvents = recordedEvents.filter((event: AnyRecord) => (
      activeIds.has(String(event?.aircraftProjectionId || ''))
    ));

    const maxEvents = Number.isSafeInteger(options.maxEvents)
      ? Math.max(0, Number(options.maxEvents))
      : Number.POSITIVE_INFINITY;
    const savedEvents = Array.isArray(savedTimeline?.events) ? savedTimeline.events : [];
    let events = savedEvents.filter((event: AnyRecord) => {
      const projectionId = String(event?.aircraftProjectionId || '');
      if (activeIds.has(projectionId)) return false;
      if (!projectionId && legacyEventTypes.has(String(event?.type || ''))) return false;
      return true;
    });
    let suppressedSavedAutomation = 0;
    const addedByProjectionId = new Map<string, number>();
    const omittedByProjectionId = new Map<string, number>();
    for (const projectedEvent of recordedProjectionEvents) {
      const projectionId = String(projectedEvent?.aircraftProjectionId || '');
      const definition = definitionsById.get(projectionId);
      if (!definition || !activeIds.has(projectionId)) continue;
      const policy = definition.automationDedupe;
      let duplicateCount = 0;
      const withoutDuplicates = policy
        ? events.filter((event: AnyRecord) => {
            const duplicate = event?.type === 'automation_event'
              && eventsAreNearby(event, projectedEvent, policy.windowMs)
              && policy.matches(event, projectedEvent);
            if (duplicate) duplicateCount += 1;
            return !duplicate;
          })
        : events;
      if (withoutDuplicates.length < maxEvents) {
        events = [...withoutDuplicates, projectedEvent];
        suppressedSavedAutomation += duplicateCount;
        addedByProjectionId.set(projectionId, (addedByProjectionId.get(projectionId) || 0) + 1);
      } else {
        omittedByProjectionId.set(projectionId, (omittedByProjectionId.get(projectionId) || 0) + 1);
      }
    }
    events.sort((left, right) => Number(left?.timestampMs || 0) - Number(right?.timestampMs || 0));
    const mergedContracts = {
      ...(isRecord(savedTimeline?.aircraftTimelineProjections)
        ? savedTimeline.aircraftTimelineProjections
        : {}),
    };
    for (const definition of activeDefinitions) {
      const recordedContract = isRecord(recordedContracts[definition.id])
        ? recordedContracts[definition.id]
        : {};
      const omittedCount = omittedByProjectionId.get(definition.id) || 0;
      mergedContracts[definition.id] = {
        ...recordedContract,
        eventCount: addedByProjectionId.get(definition.id) || 0,
        ...(omittedCount > 0
          ? { truncatedCount: Math.max(0, finiteNumber(recordedContract.truncatedCount) ?? 0) + omittedCount }
          : {}),
      };
    }

    const recordedAutomationSummary = isRecord(recordedTimeline?.automationSummary)
      ? recordedTimeline.automationSummary
      : null;
    return {
      ...savedTimeline,
      events,
      eventCount: events.length,
      aircraftTimelineProjections: mergedContracts,
      ...(recordedAutomationSummary
        ? {
            automationSummary: {
              ...recordedAutomationSummary,
              eventCount: events.filter((event) => event?.type === 'automation_event').length,
              suppressedByAircraftProjection: suppressedSavedAutomation,
            },
          }
        : suppressedSavedAutomation > 0
          ? {
              automationSummary: {
                ...(isRecord(savedTimeline?.automationSummary) ? savedTimeline.automationSummary : {}),
                eventCount: events.filter((event) => event?.type === 'automation_event').length,
                suppressedByAircraftProjection: suppressedSavedAutomation,
              },
            }
          : {}),
    };
  }

  return Object.freeze({
    automationEventIsDuplicated,
    createSession,
    getDefinition,
    mergeRecordedProjections,
    timelineNeedsProjectionRefresh,
  });
}

module.exports = {
  createAircraftTimelineProjectionRegistry,
};

export {};
