'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const nodeTest: typeof import('node:test') = require('node:test');
const { test } = nodeTest;

type InsightRow = {
  record_type: 'SAMPLE';
  timestamp_ms: number;
  phase: string;
  on_ground: boolean;
  ra_ft: number;
  lat_deg: number;
  lon_deg: number;
  gs_kts: number;
  sim_paused?: boolean;
};

type ApproachSummary = {
  duration_ms: number;
  attempt_count: number;
  established_distance_nm: number | null;
};

const { computePostFlightInsights } = require('./post-flight-insights-summary.js') as {
  computePostFlightInsights: (
    rows: InsightRow[],
    options?: { goAroundCount?: number; lastHoldingEndTs?: number | null },
  ) => { approach: ApproachSummary | null } | null;
};

function sample(
  timestampMs: number,
  onGround: boolean,
  raFt: number,
  lonDeg: number,
  phase = onGround ? 'LANDING' : 'APPROACH',
): InsightRow {
  return {
    record_type: 'SAMPLE',
    timestamp_ms: timestampMs,
    phase,
    on_ground: onGround,
    ra_ft: raFt,
    lat_deg: 40.5,
    lon_deg: lonDeg,
    gs_kts: onGround ? 120 : 145,
  };
}

function approachFor(rows: InsightRow[], goAroundCount = 0): ApproachSummary {
  const approach = computePostFlightInsights(rows, { goAroundCount })?.approach;
  assert.ok(approach, 'Expected a final-approach summary');
  return approach;
}

const normalLandingRows = [
  sample(0, false, 2500, -3.0),
  sample(10000, false, 1500, -3.05),
  sample(20000, false, 500, -3.1),
  sample(30000, false, 20, -3.15),
  sample(31000, true, 0, -3.155),
  sample(40000, true, 0, -3.17, 'TAXI-IN'),
];

test('normal landing final approach still ends at touchdown', () => {
  const approach = approachFor(normalLandingRows, 1);

  assert.equal(approach.duration_ms, 31000);
  assert.equal(approach.attempt_count, 2);
  assert.ok(
    approach.established_distance_nm !== null && approach.established_distance_nm > 7,
    'Expected established distance to span the full approach',
  );
});

test('brief post-touchdown WOW dropout does not replace the real final approach', () => {
  const normalApproach = approachFor(normalLandingRows);
  const approach = approachFor([
    ...normalLandingRows.slice(0, -1),
    sample(32200, true, 0, -3.158),
    sample(32300, false, 0, -3.1585, 'LANDING'),
    sample(32500, false, 0, -3.1595, 'LANDING'),
    sample(32735, true, 0, -3.161),
    sample(40000, true, 0, -3.17, 'TAXI-IN'),
  ]);

  assert.equal(approach.duration_ms, 31000);
  assert.equal(approach.established_distance_nm, normalApproach.established_distance_nm);
});

test('post-landing pause gap does not expose an earlier WOW dropout as the final approach', () => {
  const parkedAfterPause = sample(100000, true, 0, -3.17, 'TAXI-IN');
  parkedAfterPause.sim_paused = true;
  const approach = approachFor([
    ...normalLandingRows.slice(0, -1),
    sample(32200, true, 0, -3.158),
    sample(32300, false, 0, -3.1585, 'LANDING'),
    sample(32500, false, 0, -3.1595, 'LANDING'),
    sample(32735, true, 0, -3.161),
    parkedAfterPause,
  ]);

  assert.equal(approach.duration_ms, 31000);
});

test('sustained touch-and-go departure remains separate from the final approach', () => {
  const approach = approachFor([
    sample(0, false, 500, -3.0),
    sample(5000, true, 0, -3.02),
    sample(6000, true, 0, -3.025),
    sample(7000, false, 100, -3.03, 'CLIMB'),
    sample(20000, false, 3500, -3.08, 'CLIMB'),
    sample(30000, false, 2500, -3.12),
    sample(40000, false, 800, -3.16),
    sample(50000, true, 0, -3.2),
    sample(60000, true, 0, -3.22, 'TAXI-IN'),
  ]);

  assert.equal(approach.duration_ms, 20000);
});

test('recording that ends airborne does not reuse an earlier touchdown', () => {
  const approach = approachFor([
    sample(0, false, 500, -3.0),
    sample(5000, true, 0, -3.02),
    sample(6000, false, 100, -3.03),
    sample(10000, false, 500, -3.05),
  ]);

  assert.equal(approach.duration_ms, 4000);
});
