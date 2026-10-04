import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTakeoffTimelineContext, extractRecordedTakeoff } from './takeoff-record';

const liftoffMs = 1_700_000_032_000;
const recording = { bundleName: 'flight-a', recordingSessionId: 'session-a', flightId: 'flight-a' };
const analysis = {
  schemaVersion: 3,
  assessmentContract: { id: 'takeoff-assessment', version: 1 },
  rollDurationBasis: 'simulator',
  screenHeight: { reached: true, elapsedS: 4, timeBasis: 'simulator' },
  rotation: { rateDegS: 2.5, timeBasis: 'capture' },
  flags: [{ code: 'heading_deviation', label: 'Runway-heading deviation during the roll', severity: 'caution' }],
};

function payload(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    event_id: 'departure-1', sample_index: 42,
    timestamp_ms: liftoffMs,
    aircraft: 'PMDG 737-800', aircraft_profile_id: 'pmdg-737', icao: 'YSCB', runway: '35',
    ias_kts: 146, takeoff_roll_distance_ft: 3800, takeoff_roll_duration_s: 30,
    takeoff_runway_use_score: null, takeoff_runway_use_grade: 'Recorded', takeoff_assessment: 'caution',
    lateral_offset_suspect: false, runway_excursion: false, takeoff_analysis: analysis,
    ...overrides,
  };
}

test('live and CSV projections preserve the same recorded assessment and timing metadata', () => {
  const live = extractRecordedTakeoff(payload(), recording);
  const csv = extractRecordedTakeoff(payload({
    timestamp_ms: undefined, ts: String(liftoffMs + 5000), takeoff_liftoff_timestamp_ms: String(liftoffMs),
    ias_kts: '146', takeoff_roll_distance_ft: '3800', takeoff_roll_duration_s: '30',
    sample_index: '42', takeoff_runway_use_score: '', lateral_offset_suspect: 'false', runway_excursion: '0',
    takeoff_analysis: JSON.stringify(analysis),
  }), recording);
  assert.deepEqual(csv, live);
  assert.equal(csv?.timestampMs, liftoffMs, 'the source row timestamp is finalization, not liftoff');
  assert.equal(csv?.timestamp, new Date(liftoffMs).toISOString());
  assert.equal(csv?.rollDurationBasis, 'simulator');
  assert.equal(csv?.screenHeightTimeBasis, 'simulator');
  assert.equal(csv?.rotationTimeBasis, 'capture');
  assert.deepEqual(csv?.analysis, analysis);
});

test('durable event identity survives reindex, bundle rename and different display facts', () => {
  const first = extractRecordedTakeoff(payload(), recording)!;
  const renamed = extractRecordedTakeoff(payload({ aircraft: 'Renamed aircraft', timestamp_ms: liftoffMs + 20 }), {
    ...recording, bundleName: 'renamed-bundle', rowIndex: 999,
  })!;
  assert.equal(renamed.id, first.id);
  assert.equal(first.eventId, 'departure-1');
  assert.equal(first.sampleIndex, 42);
  assert.notEqual(extractRecordedTakeoff(payload({ event_id: 'departure-2' }), recording)?.id, first.id);
  assert.notEqual(extractRecordedTakeoff(payload(), { ...recording, recordingSessionId: 'session-b' })?.id, first.id);
  const malformedUnicode = extractRecordedTakeoff(payload({ event_id: '\ud800' }), recording)!;
  assert(malformedUnicode.id, 'an imported identifier must not throw during identity encoding');
  assert.notEqual(malformedUnicode.id, extractRecordedTakeoff(payload({ event_id: '\ufffd' }), recording)?.id,
    'do not replace malformed Unicode in a way that merges different source identifiers');
});

test('identity falls back to stable source sample, then legacy row, then live liftoff time', () => {
  const sample = extractRecordedTakeoff(payload({ event_id: null }), recording)!;
  assert.match(sample.id, /:sample:42$/);
  const legacy = payload({ event_id: null, sample_index: null });
  assert.match(extractRecordedTakeoff(legacy, { ...recording, rowIndex: 0 })!.id, /:row:0$/);
  assert.notEqual(extractRecordedTakeoff(legacy, { ...recording, rowIndex: 0 })!.id,
    extractRecordedTakeoff(legacy, { ...recording, rowIndex: 1 })!.id);
  assert.match(extractRecordedTakeoff(legacy, recording)!.id, new RegExp(`:time:${liftoffMs}$`));
  assert.equal(extractRecordedTakeoff({}), null, 'do not invent a random identity for unidentifiable input');
});

test('legacy analyses retain their recorded grades and are never stamped with current rules', () => {
  const legacyAnalysis = { schemaVersion: 1, runwayUse: { grade: 'Good', score: 95 }, flags: [] };
  const entry = extractRecordedTakeoff(payload({
    takeoff_analysis: JSON.stringify(legacyAnalysis), takeoff_runway_use_grade: 'Good', takeoff_runway_use_score: '95',
  }))!;
  assert.deepEqual(entry.analysis, legacyAnalysis);
  assert.equal(Object.hasOwn(entry.analysis, 'assessmentContract'), false);
  assert.equal(entry.runwayUseGrade, 'Good');
  assert.equal(entry.runwayUseScore, 95);
  assert.equal(entry.rollDurationBasis, null);
  assert.equal(entry.screenHeightTimeBasis, null);
});

test('malformed imported analysis cannot break projection or invent known measurement values', () => {
  for (const malformed of ['{broken', '[]', 'null', 'false', 'x'.repeat(65 * 1024)]) {
    const entry = extractRecordedTakeoff(payload({ takeoff_analysis: malformed, ias_kts: '  ', takeoff_runway_use_score: '' }))!;
    assert.equal(entry.analysis, null);
    assert.equal(entry.iasKts, null);
    assert.equal(entry.runwayUseScore, null);
    assert.deepEqual(entry.flags, []);
  }
  const invalidTime = extractRecordedTakeoff(payload({ timestamp_ms: 1e100, takeoff_liftoff_timestamp_ms: -1 }))!;
  assert.equal(invalidTime.timestamp, null);
  assert.equal(invalidTime.timestampMs, null);
  assert.equal(extractRecordedTakeoff(payload({ takeoff_liftoff_timestamp_ms: liftoffMs + 9000 }))?.timestampMs, liftoffMs,
    'a liftoff after its finalization row is invalid and cannot move the marker forward');
});

test('unknown timing bases remain unknown and false CSV booleans survive', () => {
  const entry = extractRecordedTakeoff(payload({
    lateral_offset_suspect: '0', takeoff_analysis: { rollDurationBasis: 'other', rotation: { timeBasis: {} } },
  }))!;
  assert.equal(entry.lateralOffsetSuspect, false);
  assert.equal(entry.rollDurationBasis, null);
  assert.equal(entry.rotationTimeBasis, null);
  assert.equal(extractRecordedTakeoff(payload({ lateral_offset_suspect: '' }))?.lateralOffsetSuspect, true);
});

test('provisional TAKEOFF rows are excluded while old recordings without a final flag remain readable', () => {
  for (const takeoff_final of [false, 0, '0', 'false']) {
    assert.equal(extractRecordedTakeoff(payload({ takeoff_final })), null);
  }
  for (const takeoff_final of [undefined, '', true, 1, '1', 'true']) {
    assert(extractRecordedTakeoff(payload({ takeoff_final })));
  }
  assert.equal(extractRecordedTakeoff(payload({ event_id: 123 }))?.eventId, '123');
  assert.equal(extractRecordedTakeoff(payload({ event_id: '00123' }))?.eventId, '00123');
});

test('Timeline and Logbook expose identical recorded identity, findings and assessment metadata', () => {
  const entry = extractRecordedTakeoff(payload(), recording)!;
  const marker = buildTakeoffTimelineContext(entry);
  assert.equal(marker.takeoff_id, entry.id);
  assert.equal(marker.event_id, entry.eventId);
  assert.equal(marker.sample_index, entry.sampleIndex);
  assert.equal(marker.roll_duration_s, entry.rollDurationS);
  assert.equal(marker.roll_duration_basis, entry.rollDurationBasis);
  assert.equal(marker.runway_use_score, null);
  assert.equal(marker.assessment, 'caution');
  assert.deepEqual(marker.flags, entry.flags);
  assert.deepEqual(marker.takeoff_analysis, analysis);
});
