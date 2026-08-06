'use strict';

const fs = require('fs') as typeof import('fs');
const { parseCsvLine, splitCsvLines } = require('../utils/csv.js') as {
  parseCsvLine: (line: string, options?: { trimValues?: boolean }) => string[];
  splitCsvLines: (content: string, options?: { trimAndDropEmpty?: boolean }) => string[];
};
const { VIOLATION_RULE } = require('../../shared/violation-rules.js') as {
  VIOLATION_RULE: { CONVECTIVE_EXPOSURE: string };
};
const { detectDutchRollSummary } = require('./dutch-roll-summary.js') as {
  detectDutchRollSummary: (rows: SummaryRow[]) => unknown | null;
};
const { detectHoldingPatternSummary } = require('./holding-pattern-summary.js') as {
  detectHoldingPatternSummary: (rows: SummaryRow[]) => { end_ts?: unknown } | null;
};
const { computePostFlightInsights } = require('./post-flight-insights-summary.js') as {
  computePostFlightInsights: (
    rows: SummaryRow[],
    options?: { goAroundCount?: number; lastHoldingEndTs?: number | null },
  ) => unknown | null;
};

const CONVECTIVE_EXPOSURE_RULE_ID = VIOLATION_RULE.CONVECTIVE_EXPOSURE;
const MAX_SUMMARY_CSV_BYTES = 200 * 1024 * 1024;

type ViolationSummary = {
  rule_id: string;
  label: string;
  severity: string | null;
  duration_ms: number | null;
};

type FlightSummary = {
  departure_time_ms: number | null;
  departure_time_utc: string | null;
  max_alt_ft: number | null;
  max_ias_kts: number | null;
  go_around_count: number;
  overspeed_count: number;
  violations: ViolationSummary[];
  dutch_roll: unknown | null;
  holding: unknown | null;
  insights: unknown | null;
};

type ViolationStart = {
  label: string | null;
  severity: string | null;
  startMs: number | null;
};

type SummaryRow = {
  record_type?: unknown;
  ts?: unknown;
  alt_msl_ft?: unknown;
  ias_kts?: unknown;
  rule_id?: unknown;
  label?: unknown;
  severity?: unknown;
  duration_ms?: unknown;
  timestamp_ms?: unknown;
  phase?: unknown;
  on_ground?: unknown;
  sim_paused?: unknown;
  sim_in_menu?: unknown;
  gs_kts?: unknown;
  ra_ft?: unknown;
  bank_deg?: unknown;
  roll_rate_rad_s?: unknown;
  yaw_rate_rad_s?: unknown;
  sideslip_deg?: unknown;
  hdg_true_deg?: unknown;
  track_true_deg?: unknown;
  lat_deg?: unknown;
  lon_deg?: unknown;
  g_force?: unknown;
  g_force_lateral?: unknown;
  g_force_longitudinal?: unknown;
  fuel_total_gal?: unknown;
  fuel_total_weight_lbs?: unknown;
  fuel_weight_per_gal?: unknown;
  ap_master?: unknown;
  ap_reliable?: unknown;
  in_cloud?: unknown;
  precip_rate_mm?: unknown;
  precip_state?: unknown;
  wind_speed_kts?: unknown;
  gear_down_locked?: unknown;
  flaps_notch?: unknown;
  flaps_pct?: unknown;
};

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function shouldSuppressSummaryViolation(ruleId: string | null): boolean {
  return ruleId === CONVECTIVE_EXPOSURE_RULE_ID;
}

function buildSummary(
  firstSampleTs: number | null,
  maxAltFt: number | null,
  maxIasKts: number | null,
  goAroundCount: number,
  overspeedCount: number,
  violationsFinished: ViolationSummary[],
  dutchRoll: unknown | null,
  holding: unknown | null,
  insights: unknown | null,
): FlightSummary {
  return {
    departure_time_ms: firstSampleTs,
    departure_time_utc: firstSampleTs ? new Date(firstSampleTs).toISOString() : null,
    max_alt_ft: maxAltFt !== null ? Math.round(maxAltFt) : null,
    max_ias_kts: maxIasKts !== null ? Math.round(maxIasKts) : null,
    go_around_count: goAroundCount,
    overspeed_count: overspeedCount,
    violations: violationsFinished,
    dutch_roll: dutchRoll,
    holding,
    insights,
  };
}

function finalizeOpenViolations(
  violationStarts: Map<string, ViolationStart>,
  violationsFinished: ViolationSummary[],
): void {
  for (const [ruleId, violation] of violationStarts) {
    violationsFinished.push({
      rule_id: ruleId,
      label: violation.label || ruleId,
      severity: violation.severity || null,
      duration_ms: null,
    });
  }
}

function readFlightSummary(filePath: string): FlightSummary | null {
  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SUMMARY_CSV_BYTES) return null;
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = splitCsvLines(content, { trimAndDropEmpty: true });
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map((header) => header.trim());
  const col = (name: string): number => headers.indexOf(name);

  const rtIdx = col('record_type');
  if (rtIdx === -1) return null;

  const tsIdx = col('ts');
  const altIdx = col('alt_msl_ft');
  const iasIdx = col('ias_kts');
  const gsIdx = col('gs_kts');
  const phaseIdx = col('phase');
  const onGroundIdx = col('on_ground');
  const simPausedIdx = col('sim_paused');
  const simInMenuIdx = col('sim_in_menu');
  const raIdx = col('ra_ft');
  const bankIdx = col('bank_deg');
  const rollRateIdx = col('roll_rate_rad_s');
  const yawRateIdx = col('yaw_rate_rad_s');
  const sideslipIdx = col('sideslip_deg');
  const headingIdx = col('hdg_true_deg');
  const trackIdx = col('track_true_deg');
  const latIdx = col('lat_deg');
  const lonIdx = col('lon_deg');
  const gForceIdx = col('g_force');
  const gForceLateralIdx = col('g_force_lateral');
  const gForceLongitudinalIdx = col('g_force_longitudinal');
  const fuelTotalIdx = col('fuel_total_gal');
  const fuelTotalWeightIdx = col('fuel_total_weight_lbs');
  const fuelWeightPerGalIdx = col('fuel_weight_per_gal');
  const apMasterIdx = col('ap_master');
  const apReliableIdx = col('ap_reliable');
  const inCloudIdx = col('in_cloud');
  const precipRateIdx = col('precip_rate_mm');
  const precipStateIdx = col('precip_state');
  const windSpeedIdx = col('wind_speed_kts');
  const gearDownLockedIdx = col('gear_down_locked');
  const flapsNotchIdx = col('flaps_notch');
  const flapsPctIdx = col('flaps_pct');
  const ruleIdx = col('rule_id');
  const labelIdx = col('label');
  const severityIdx = col('severity');
  const durationIdx = col('duration_ms');
  const tsMsIdx = col('timestamp_ms');

  let firstSampleTs: number | null = null;
  let maxAltFt: number | null = null;
  let maxIasKts: number | null = null;
  let goAroundCount = 0;
  let overspeedCount = 0;

  const violationStarts = new Map<string, ViolationStart>();
  const violationsFinished: ViolationSummary[] = [];
  const sampleRows: SummaryRow[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      !line.includes('SAMPLE') &&
      !line.includes('FLIGHT_VIOLATION') &&
      !line.includes('GO_AROUND') &&
      !line.includes('OVERSPEED')
    ) {
      continue;
    }

    const values = parseCsvLine(line, { trimValues: true });
    if (values.length <= rtIdx) continue;

    const recordType = values[rtIdx];
    if (!recordType) continue;

    if (recordType === 'SAMPLE') {
      const sampleTs = tsIdx >= 0 ? toFiniteNumber(values[tsIdx]) : null;
      if (firstSampleTs === null && sampleTs !== null && sampleTs > 0) {
        firstSampleTs = sampleTs;
      }

      const alt = altIdx >= 0 ? toFiniteNumber(values[altIdx]) : null;
      if (alt !== null && (maxAltFt === null || alt > maxAltFt)) maxAltFt = alt;

      const ias = iasIdx >= 0 ? toFiniteNumber(values[iasIdx]) : null;
      if (ias !== null && ias > 0 && (maxIasKts === null || ias > maxIasKts)) maxIasKts = ias;
      sampleRows.push({
        record_type: recordType,
        ts: sampleTs,
        timestamp_ms: tsMsIdx >= 0 ? toFiniteNumber(values[tsMsIdx]) : sampleTs,
        alt_msl_ft: alt,
        ias_kts: ias,
        gs_kts: gsIdx >= 0 ? toFiniteNumber(values[gsIdx]) : null,
        phase: phaseIdx >= 0 ? values[phaseIdx] : null,
        on_ground: onGroundIdx >= 0 ? values[onGroundIdx] : null,
        sim_paused: simPausedIdx >= 0 ? values[simPausedIdx] : null,
        sim_in_menu: simInMenuIdx >= 0 ? values[simInMenuIdx] : null,
        ra_ft: raIdx >= 0 ? toFiniteNumber(values[raIdx]) : null,
        bank_deg: bankIdx >= 0 ? toFiniteNumber(values[bankIdx]) : null,
        roll_rate_rad_s: rollRateIdx >= 0 ? toFiniteNumber(values[rollRateIdx]) : null,
        yaw_rate_rad_s: yawRateIdx >= 0 ? toFiniteNumber(values[yawRateIdx]) : null,
        sideslip_deg: sideslipIdx >= 0 ? toFiniteNumber(values[sideslipIdx]) : null,
        hdg_true_deg: headingIdx >= 0 ? toFiniteNumber(values[headingIdx]) : null,
        track_true_deg: trackIdx >= 0 ? toFiniteNumber(values[trackIdx]) : null,
        lat_deg: latIdx >= 0 ? toFiniteNumber(values[latIdx]) : null,
        lon_deg: lonIdx >= 0 ? toFiniteNumber(values[lonIdx]) : null,
        g_force: gForceIdx >= 0 ? toFiniteNumber(values[gForceIdx]) : null,
        g_force_lateral: gForceLateralIdx >= 0 ? toFiniteNumber(values[gForceLateralIdx]) : null,
        g_force_longitudinal: gForceLongitudinalIdx >= 0 ? toFiniteNumber(values[gForceLongitudinalIdx]) : null,
        fuel_total_gal: fuelTotalIdx >= 0 ? toFiniteNumber(values[fuelTotalIdx]) : null,
        fuel_total_weight_lbs: fuelTotalWeightIdx >= 0 ? toFiniteNumber(values[fuelTotalWeightIdx]) : null,
        fuel_weight_per_gal: fuelWeightPerGalIdx >= 0 ? toFiniteNumber(values[fuelWeightPerGalIdx]) : null,
        ap_master: apMasterIdx >= 0 ? values[apMasterIdx] : null,
        ap_reliable: apReliableIdx >= 0 ? values[apReliableIdx] : null,
        in_cloud: inCloudIdx >= 0 ? values[inCloudIdx] : null,
        precip_rate_mm: precipRateIdx >= 0 ? toFiniteNumber(values[precipRateIdx]) : null,
        precip_state: precipStateIdx >= 0 ? toFiniteNumber(values[precipStateIdx]) : null,
        wind_speed_kts: windSpeedIdx >= 0 ? toFiniteNumber(values[windSpeedIdx]) : null,
        gear_down_locked: gearDownLockedIdx >= 0 ? values[gearDownLockedIdx] : null,
        flaps_notch: flapsNotchIdx >= 0 ? values[flapsNotchIdx] : null,
        flaps_pct: flapsPctIdx >= 0 ? toFiniteNumber(values[flapsPctIdx]) : null,
      });
      continue;
    }

    if (recordType === 'FLIGHT_VIOLATION_START') {
      const ruleId = ruleIdx >= 0 ? toNonEmptyString(values[ruleIdx]) : null;
      if (shouldSuppressSummaryViolation(ruleId)) {
        continue;
      }
      if (ruleId) {
        violationStarts.set(ruleId, {
          label: labelIdx >= 0 ? toNonEmptyString(values[labelIdx]) : null,
          severity: severityIdx >= 0 ? toNonEmptyString(values[severityIdx]) : null,
          startMs: tsMsIdx >= 0 ? toFiniteNumber(values[tsMsIdx]) : null,
        });
      }
      continue;
    }

    if (recordType === 'FLIGHT_VIOLATION_END') {
      const ruleId = ruleIdx >= 0 ? toNonEmptyString(values[ruleIdx]) : null;
      if (shouldSuppressSummaryViolation(ruleId)) {
        if (ruleId) violationStarts.delete(ruleId);
        continue;
      }
      if (ruleId) {
        const start = violationStarts.get(ruleId);
        violationsFinished.push({
          rule_id: ruleId,
          label: (labelIdx >= 0 ? toNonEmptyString(values[labelIdx]) : null) || start?.label || ruleId,
          severity: (severityIdx >= 0 ? toNonEmptyString(values[severityIdx]) : null) || start?.severity || null,
          duration_ms: durationIdx >= 0 ? toFiniteNumber(values[durationIdx])?.valueOf() ?? null : null,
        });
        const last = violationsFinished[violationsFinished.length - 1];
        if (last.duration_ms !== null) {
          last.duration_ms = Math.round(last.duration_ms);
        }
        violationStarts.delete(ruleId);
      }
      continue;
    }

    if (recordType === 'GO_AROUND') {
      goAroundCount += 1;
      continue;
    }

    if (recordType === 'OVERSPEED') {
      overspeedCount += 1;
    }
  }

  finalizeOpenViolations(violationStarts, violationsFinished);

  const holding = detectHoldingPatternSummary(sampleRows);

  return buildSummary(
    firstSampleTs,
    maxAltFt,
    maxIasKts,
    goAroundCount,
    overspeedCount,
    violationsFinished,
    detectDutchRollSummary(sampleRows),
    holding,
    computePostFlightInsights(sampleRows, {
      goAroundCount,
      lastHoldingEndTs: toFiniteNumber(holding?.end_ts),
    }),
  );
}

function computeFlightSummaryFromRows(rows: SummaryRow[]): FlightSummary | null {
  if (!rows.length) return null;

  let firstSampleTs: number | null = null;
  let maxAltFt: number | null = null;
  let maxIasKts: number | null = null;
  let goAroundCount = 0;
  let overspeedCount = 0;

  const violationStarts = new Map<string, ViolationStart>();
  const violationsFinished: ViolationSummary[] = [];
  const sampleRows: SummaryRow[] = [];

  for (const row of rows) {
    const recordType = toNonEmptyString(row.record_type);
    if (!recordType) continue;

    if (recordType === 'SAMPLE') {
      const sampleTs = toFiniteNumber(row.ts);
      if (firstSampleTs === null && sampleTs !== null && sampleTs > 0) {
        firstSampleTs = sampleTs;
      }

      const alt = toFiniteNumber(row.alt_msl_ft);
      if (alt !== null && (maxAltFt === null || alt > maxAltFt)) maxAltFt = alt;

      const ias = toFiniteNumber(row.ias_kts);
      if (ias !== null && ias > 0 && (maxIasKts === null || ias > maxIasKts)) maxIasKts = ias;
      sampleRows.push(row);
      continue;
    }

    if (recordType === 'FLIGHT_VIOLATION_START') {
      const ruleId = toNonEmptyString(row.rule_id);
      if (shouldSuppressSummaryViolation(ruleId)) {
        continue;
      }
      if (ruleId) {
        violationStarts.set(ruleId, {
          label: toNonEmptyString(row.label),
          severity: toNonEmptyString(row.severity),
          startMs: toFiniteNumber(row.timestamp_ms),
        });
      }
      continue;
    }

    if (recordType === 'FLIGHT_VIOLATION_END') {
      const ruleId = toNonEmptyString(row.rule_id);
      if (shouldSuppressSummaryViolation(ruleId)) {
        if (ruleId) violationStarts.delete(ruleId);
        continue;
      }
      if (ruleId) {
        const start = violationStarts.get(ruleId);
        const duration = toFiniteNumber(row.duration_ms);
        violationsFinished.push({
          rule_id: ruleId,
          label: toNonEmptyString(row.label) || start?.label || ruleId,
          severity: toNonEmptyString(row.severity) || start?.severity || null,
          duration_ms: duration !== null ? Math.round(duration) : null,
        });
        violationStarts.delete(ruleId);
      }
      continue;
    }

    if (recordType === 'GO_AROUND') {
      goAroundCount += 1;
      continue;
    }

    if (recordType === 'OVERSPEED') {
      overspeedCount += 1;
    }
  }

  finalizeOpenViolations(violationStarts, violationsFinished);

  const holding = detectHoldingPatternSummary(sampleRows);

  return buildSummary(
    firstSampleTs,
    maxAltFt,
    maxIasKts,
    goAroundCount,
    overspeedCount,
    violationsFinished,
    detectDutchRollSummary(sampleRows),
    holding,
    computePostFlightInsights(sampleRows, {
      goAroundCount,
      lastHoldingEndTs: toFiniteNumber(holding?.end_ts),
    }),
  );
}

const flightSummaryApi = { readFlightSummary, computeFlightSummaryFromRows };

module.exports = flightSummaryApi;

export {};
