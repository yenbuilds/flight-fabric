'use strict';

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  createAircraftTimelineProjectionRegistry,
} = require('./aircraft-timeline-projection-registry') as {
  createAircraftTimelineProjectionRegistry: (_definitions?: readonly Record<string, any>[]) => Record<string, any>;
};

function definition(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'test.flight-guidance',
    version: 2,
    eventType: 'test_guidance_event',
    lane: 'test-guidance',
    createProjector: () => {
      const rows: Record<string, any>[] = [];
      return {
        consume: (row: Record<string, any>) => rows.push(row),
        finish: () => ({
          applicable: rows.some((row) => row.type === 'applicable'),
          active: true,
          events: rows.filter((row) => row.type === 'test_guidance_event'),
        }),
      };
    },
    matchesTimeline: (timeline: Record<string, any>) => timeline?.aircraftProfileId === 'test-profile',
    automationDedupe: {
      windowMs: 1000,
      matches: (automationEvent: Record<string, any>, projectedEvent: Record<string, any>) => (
        automationEvent?.eventType === 'generic_mode'
        && projectedEvent?.eventType === 'exact_mode'
      ),
    },
    ...overrides,
  };
}

test('registry validates identities and rejects duplicate projection contracts', () => {
  assert.throws(
    () => createAircraftTimelineProjectionRegistry([definition({ id: '../unsafe' })]),
    /safe ID/,
  );
  assert.throws(
    () => createAircraftTimelineProjectionRegistry([definition(), definition()]),
    /duplicated/,
  );
});

test('registry sessions stream rows and retain only applicable projection results', () => {
  const registry = createAircraftTimelineProjectionRegistry([definition()]);
  const ignoredSession = registry.createSession();
  ignoredSession.consume({ type: 'other' });
  assert.deepEqual(ignoredSession.finish(), []);

  const session = registry.createSession();
  session.consume({ type: 'applicable' });
  session.consume({ type: 'test_guidance_event', eventType: 'exact_mode', flightElapsedMs: 500 });
  const results = session.finish();
  assert.equal(results.length, 1);
  assert.equal(results[0].projectionId, 'test.flight-guidance');
  assert.equal(results[0].projection.events.length, 1);
});

test('registry refresh and merge logic is contract-driven and aircraft-agnostic', () => {
  const registry = createAircraftTimelineProjectionRegistry([definition()]);
  const savedTimeline = {
    aircraftProfileId: 'test-profile',
    events: [
      { type: 'landing', timestampMs: 3000, landingGrade: 'EXCELLENT' },
      { type: 'automation_event', eventType: 'generic_mode', elapsedMs: 500, timestampMs: 500 },
      { type: 'automation_event', eventType: 'unrelated', elapsedMs: 600, timestampMs: 600 },
    ],
  };
  assert.equal(registry.timelineNeedsProjectionRefresh(savedTimeline), true);

  const recordedTimeline = {
    events: [{
      type: 'test_guidance_event',
      eventType: 'exact_mode',
      aircraftProjectionId: 'test.flight-guidance',
      aircraftProjectionVersion: 2,
      elapsedMs: 500,
      timestampMs: 500,
    }],
    aircraftTimelineProjections: {
      'test.flight-guidance': { version: 2, eventCount: 1 },
    },
  };
  const merged = registry.mergeRecordedProjections(savedTimeline, recordedTimeline, { maxEvents: 3 });
  assert.equal(merged.events.some((event: Record<string, any>) => event.eventType === 'generic_mode'), false);
  assert.equal(merged.events.some((event: Record<string, any>) => event.eventType === 'unrelated'), true);
  assert.equal(merged.events.some((event: Record<string, any>) => event.eventType === 'exact_mode'), true);
  assert.equal(merged.events.find((event: Record<string, any>) => event.type === 'landing').landingGrade, 'EXCELLENT');
  assert.equal(merged.events.length, 3);
  assert.equal(registry.timelineNeedsProjectionRefresh(merged), false);
});

export {};
