'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isLegacyRunwayExcursionGrade,
  resolveLandingRateHeadline,
} = require('./landing-replay-analysis.js');

const a32nxGrade = (vsFpm: number): string => (
  vsFpm > -120 ? 'PERFECT'
    : vsFpm > -250 ? 'GOOD'
      : vsFpm > -400 ? 'FIRM'
        : vsFpm > -650 ? 'HARD'
          : 'VERY HARD'
);

test('legacy landing-rate headline ignores simulator diagnostics and reconstructs with recorded-profile rules', () => {
  assert.deepEqual(resolveLandingRateHeadline({
    vs_fpm: -243.3,
    grade: 'PERFECT',
    td_sim_trusted: true,
    td_sim_fresh: true,
    td_sim_landing_vs_fpm: -349.2,
  }, a32nxGrade), {
    vsFpm: -243.3,
    grade: 'GOOD',
  });
});

test('context-backed landing-rate headline is immutable until an explicit rescore', () => {
  const row = {
    vs_fpm: -243.3,
    grade: 'PERFECT',
    landing_rate_context: {
      schemaVersion: 1,
      criteriaSource: 'recorded',
      policy: { id: 'landing-rate-v1', version: 1 },
      profile: { id: 'fbw-a32nx' },
      thresholds: {
        perfectMinFpm: -250,
        goodMinFpm: -450,
        firmMinFpm: -700,
        hardMinFpm: -1000,
      },
    },
    td_sim_landing_vs_fpm: -349.2,
  };
  assert.deepEqual(resolveLandingRateHeadline(row, a32nxGrade), {
    vsFpm: -243.3,
    grade: 'PERFECT',
  });
  assert.deepEqual(resolveLandingRateHeadline({
    ...row,
  }, a32nxGrade, null, { rescoreWithCurrentRules: true }), {
    vsFpm: -243.3,
    grade: 'GOOD',
  });
});

test('context-backed landing-rate headline reconstructs a missing label from saved thresholds', () => {
  const row = {
    vs_fpm: -243.3,
    grade: null,
    landing_rate_context: {
      schemaVersion: 1,
      criteriaSource: 'recorded',
      policy: { id: 'landing-rate-v1', version: 1 },
      profile: { id: 'fbw-a32nx' },
      thresholds: {
        perfectMinFpm: -120,
        goodMinFpm: -250,
        firmMinFpm: -400,
        hardMinFpm: -650,
      },
    },
  };
  assert.deepEqual(resolveLandingRateHeadline(row, () => 'PERFECT'), {
    vsFpm: -243.3,
    grade: 'GOOD',
  });
});

test('context-backed landing-rate headline preserves the saved label and matches live threshold boundaries', () => {
  const row = {
    vs_fpm: -250,
    grade: 'GOOD',
    landing_rate_context: {
      schemaVersion: 1,
      criteriaSource: 'recorded',
      policy: { id: 'landing-rate-v1', version: 1 },
      profile: { id: 'generic' },
      thresholds: {
        perfectMinFpm: -250,
        goodMinFpm: -450,
        firmMinFpm: -700,
        hardMinFpm: -1000,
      },
    },
  };
  assert.deepEqual(resolveLandingRateHeadline(row, () => 'PERFECT'), {
    vsFpm: -250,
    grade: 'GOOD',
  });
  assert.deepEqual(resolveLandingRateHeadline({ ...row, grade: null }, () => 'PERFECT'), {
    vsFpm: -250,
    grade: 'GOOD',
  });
});

test('landing-rate headline preserves its persisted grade when the recorded profile is unavailable', () => {
  assert.deepEqual(resolveLandingRateHeadline({
    vs_fpm: -650,
    grade: 'VERY HARD',
    aircraft_profile_id: 'retired-profile',
    td_sim_landing_vs_fpm: -900,
  }, () => null), {
    vsFpm: -650,
    grade: 'VERY HARD',
  });
});

test('landing-rate headline never pairs persisted V/S with a grade from a different fallback V/S', () => {
  assert.deepEqual(resolveLandingRateHeadline({
    vs_fpm: -650,
    grade: null,
    aircraft_profile_id: 'retired-profile',
  }, () => null, {
    vs_fpm: -80,
    grade: 'PERFECT',
  }), {
    vsFpm: -650,
    grade: null,
  });

  assert.deepEqual(resolveLandingRateHeadline({
    vs_fpm: -650,
    grade: 'RUNWAY EXCURSION',
    aircraft_profile_id: 'retired-profile',
  }, () => null, {
    vs_fpm: -80,
    grade: 'PERFECT',
  }), {
    vsFpm: -650,
    grade: null,
  });
});

test('landing-rate headline uses conventional replay fallback when the LANDING row lacks V/S', () => {
  assert.deepEqual(resolveLandingRateHeadline({
    grade: 'PERFECT',
    td_sim_trusted: true,
    td_sim_fresh: true,
    td_sim_landing_vs_fpm: -349.2,
  }, a32nxGrade, {
    vs_fpm: -243.3,
    grade: 'PERFECT',
  }), {
    vsFpm: -243.3,
    grade: 'GOOD',
  });

  assert.deepEqual(resolveLandingRateHeadline({
    grade: 'PERFECT',
    td_sim_landing_vs_fpm: -349.2,
  }, a32nxGrade, {
    vs_fpm: -243.3,
    grade: 'PERFECT',
  }, { rescoreWithCurrentRules: true }), {
    vsFpm: -243.3,
    grade: 'GOOD',
  });
});

test('persisted rate grade is fallback-only when no conventional V/S exists', () => {
  assert.deepEqual(resolveLandingRateHeadline({
    grade: 'FIRM',
    td_sim_trusted: true,
    td_sim_fresh: true,
    td_sim_landing_vs_fpm: -349.2,
  }, a32nxGrade), {
    vsFpm: null,
    grade: 'FIRM',
  });
});

test('legacy runway-excursion sentinel remains a separate fact, never a rate grade', () => {
  assert.equal(isLegacyRunwayExcursionGrade(' runway excursion '), true);
  assert.deepEqual(resolveLandingRateHeadline({
    grade: 'RUNWAY EXCURSION',
    td_sim_landing_vs_fpm: -349.2,
  }, a32nxGrade), {
    vsFpm: null,
    grade: null,
  });
});

export {};
