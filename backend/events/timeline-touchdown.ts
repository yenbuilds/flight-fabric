'use strict';

const landingDistance = require('../landing/landing-distance');
const { findRunwayByPosition } = require('../landing/airport-geometry-service');
const { buildStabilityScoringContext } = require('../stability/stability-policy');
const {
  buildTouchdownRunwayAnalysis,
} = require('../analysis/flight-analysis') as {
  buildTouchdownRunwayAnalysis: (input: Record<string, any>) => {
    touchdownDistanceData: Record<string, any>;
    shortLandingDetected: boolean;
    tdzAchieved: boolean;
  };
};

type AnyRecord = Record<string, any>;

function buildReplayLandingEvent(input: {
  row: AnyRecord;
  timestampMs: number;
  elapsedMs: number;
  touchdownNumber: number;
  eventCoordinates: { lat: number | null; lon: number | null };
  approachSamples: AnyRecord[];
  stabilityScorer: AnyRecord;
  stabilityCriteria?: AnyRecord | null;
  stabilityPolicy?: AnyRecord | null;
  stabilityProfile?: AnyRecord | null;
  resolveGlidepathAngleForApproach?: (input?: { airportIcao?: unknown; runwayId?: unknown }) => { angleDeg: number; source: string };
  toFiniteNumber: (value: unknown) => number | null;
  computeGradeFromVs: (vsFpm: unknown) => string | null;
  computeCenterlineDev: (hdgTrueDeg: number | null, runwayHeadingDeg: number | null) => number | null;
  downsampleApproachProfile: (samples: AnyRecord[], maxPoints: number, altitudeSource?: unknown) => AnyRecord[];
  approachProfileMaxPoints: number;
  dangerouslyLowApproachRaFt: number;
  flareExclusionDistanceFt: number;
}) {
  const {
    row,
    timestampMs,
    elapsedMs,
    touchdownNumber,
    eventCoordinates,
    approachSamples,
    stabilityScorer,
    stabilityCriteria,
    stabilityPolicy,
    stabilityProfile,
    resolveGlidepathAngleForApproach,
    toFiniteNumber,
    computeGradeFromVs,
    computeCenterlineDev,
    downsampleApproachProfile,
    approachProfileMaxPoints,
    dangerouslyLowApproachRaFt,
    flareExclusionDistanceFt,
  } = input;

  const runway = findRunwayByPosition(eventCoordinates.lat, eventCoordinates.lon, 2, row.hdg_true_deg);

  let touchdownScore = null;
  let touchdownDistanceFt = null;
  let shortLanding = false;
  let tdzAchieved = false;
  let lateralOffset = null;
  let lateralOffsetScore = null;
  let surfaceResolution = null;

  if (runway) {
    const runwayAnalysis = buildTouchdownRunwayAnalysis({
      runwayData: runway,
      touchdownPoint: { lat: eventCoordinates.lat, lon: eventCoordinates.lon },
      surfaceInputs: { oatC: typeof row.oat_c === 'number' ? row.oat_c : null },
    });
    const touchdownDistanceData = runwayAnalysis.touchdownDistanceData;
    touchdownScore = touchdownDistanceData.touchdown_distance_score != null
      ? {
          score: touchdownDistanceData.touchdown_distance_score,
          grade: touchdownDistanceData.touchdown_distance_grade,
          zone: touchdownDistanceData.touchdown_distance_zone,
        }
      : null;
    touchdownDistanceFt = touchdownDistanceData.touchdown_distance_ft;
    shortLanding = runwayAnalysis.shortLandingDetected;
    tdzAchieved = runwayAnalysis.tdzAchieved;
    lateralOffset = touchdownDistanceData.lateral_offset_ft != null
      ? {
          offsetFt: touchdownDistanceData.lateral_offset_ft,
          side: touchdownDistanceData.lateral_offset_side || 'center',
        }
      : null;
    lateralOffsetScore = touchdownDistanceData.lateral_offset_score != null
      ? {
          score: touchdownDistanceData.lateral_offset_score,
          grade: touchdownDistanceData.lateral_offset_grade,
        }
      : null;
    surfaceResolution = {
      surface: touchdownDistanceData.runway_condition,
      source: touchdownDistanceData.runway_condition_source,
      confident: touchdownDistanceData.runway_condition_confident,
    };
  }

  const glidepathAngle = typeof resolveGlidepathAngleForApproach === 'function'
    ? resolveGlidepathAngleForApproach({
        airportIcao: runway?.icao ?? row.icao ?? row.airport_icao,
        runwayId: runway?.runway ?? row.runway ?? row.runway_id,
      })
    : null;

  const scoreResult = stabilityScorer.getSampleCount() > 0
    ? stabilityScorer.getScore(
        runway && Number.isFinite(runway.elevation_ft) ? runway.elevation_ft : null,
        {
          lateralOffsetFt: lateralOffset && Number.isFinite(lateralOffset.offsetFt) ? lateralOffset.offsetFt : null,
          runwayWidthFt: runway && Number.isFinite(runway.widthFt) && runway.widthFt > 0 ? runway.widthFt : null,
          airportIcao: runway?.icao ?? row.icao ?? row.airport_icao ?? null,
          runwayId: runway?.runway ?? row.runway ?? row.runway_id ?? null,
          criteria: stabilityCriteria || null,
        },
      )
    : null;

  const inferredUltimateStability = scoreResult && scoreResult.breakdown
    && Object.keys(scoreResult.breakdown).length > 0
      ? {
        score: scoreResult.score,
        verdict: scoreResult.verdict,
        samples: scoreResult.samples,
        gateStable: scoreResult.gateStable,
        gateFailures: scoreResult.gateFailures,
        breakdown: scoreResult.breakdown,
        scoringContext: buildStabilityScoringContext({
          scoreResult,
          profile: stabilityProfile || {
            id: typeof row.aircraft_profile_id === 'string' && row.aircraft_profile_id.trim()
              ? row.aircraft_profile_id.trim()
              : 'generic',
          },
          glidepathAngle,
          policy: stabilityPolicy,
          criteriaSource: 'reconstructed',
        }),
      }
    : null;

  // getScore() locks a single altitude datum using runway/gate-aware coverage.
  // Read that source from the scorer profile after scoring, then apply it to the
  // replay samples so chart metadata (including absolute timestamps) is kept.
  // The downsampler retains its generic selector for legacy/mocked scorers.
  const scoredApproachProfile = scoreResult && typeof stabilityScorer.getApproachProfile === 'function'
    ? stabilityScorer.getApproachProfile(approachProfileMaxPoints)
    : null;
  const scoredAltitudeSource = Array.isArray(scoredApproachProfile)
    ? scoredApproachProfile.find(point => typeof point?.profileAltitudeSource === 'string')?.profileAltitudeSource
    : null;
  const renderedApproachProfile = downsampleApproachProfile(
    approachSamples,
    approachProfileMaxPoints,
    scoredAltitudeSource,
  );

  const landingEvent = {
    type: 'landing',
    timestampMs,
    elapsedMs,
    touchdownNumber,
    aircraftProfileId: typeof row.aircraft_profile_id === 'string' && row.aircraft_profile_id.trim()
      ? row.aircraft_profile_id.trim()
      : null,
    lat: eventCoordinates.lat,
    lon: eventCoordinates.lon,
    ias_kts: row.ias_kts,
    vs_fpm: row.vs_fpm,
    pitch_deg: row.pitch_deg,
    hdg_true_deg: row.hdg_true_deg,
    gforce: toFiniteNumber(row.g_force),
    bank_deg: toFiniteNumber(row.bank_deg),
    gs_kts: toFiniteNumber(row.gs_kts),
    wind_speed_kts: toFiniteNumber(row.wind_speed_kts),
    xwind_kts: null,
    grade: computeGradeFromVs(row.vs_fpm),
    centerlineDev: runway ? computeCenterlineDev(row.hdg_true_deg, runway.heading_true_deg ?? runway.heading) : null,
    runway: runway ? {
      airport_icao: runway.icao,
      airport_name: runway.airportName,
      runway_id: runway.runway,
      length_ft: runway.lengthFt,
      width_ft: Number.isFinite(runway.widthFt) && runway.widthFt > 0 ? runway.widthFt : null,
      heading: runway.heading_true_deg ?? runway.heading,
      heading_true_deg: runway.heading_true_deg ?? runway.heading,
      threshold: runway.threshold && Number.isFinite(runway.threshold.lat)
        ? { lat: runway.threshold.lat, lon: runway.threshold.lon }
        : null,
    } : null,
    glidepathAngle: glidepathAngle ? {
      angleDeg: glidepathAngle.angleDeg,
      source: glidepathAngle.source,
    } : null,
    touchdownDistance: touchdownScore ? {
      distanceFt: touchdownDistanceFt,
      score: touchdownScore.score,
      grade: touchdownScore.grade,
      zone: touchdownScore.zone,
      runway_condition: surfaceResolution ? surfaceResolution.surface : null,
      runway_condition_source: surfaceResolution ? surfaceResolution.source : null,
      runway_condition_confident: surfaceResolution ? surfaceResolution.confident : null,
      shortLanding: shortLanding || false,
      tdzAchieved,
      lateralOffsetFt: lateralOffset && Number.isFinite(lateralOffset.offsetFt)
        ? Math.abs(lateralOffset.offsetFt)
        : null,
      lateralOffsetSide: lateralOffset && Number.isFinite(lateralOffset.offsetFt) ? lateralOffset.side : null,
      lateralOffsetGrade: lateralOffsetScore ? lateralOffsetScore.grade : null,
      lateralOffsetScore: lateralOffsetScore ? lateralOffsetScore.score : null,
      runwayLengthFt: runway && Number.isFinite(runway.lengthFt) ? runway.lengthFt : null,
      runwayWidthFt: runway && Number.isFinite(runway.widthFt) && runway.widthFt > 0
        ? runway.widthFt
        : null,
    } : null,
    ultimateStability: inferredUltimateStability,
    runwayReferenceElevFt: runway && Number.isFinite(runway.elevation_ft) ? runway.elevation_ft : null,
    runwayReferenceElevationSource: runway?.source || null,
    runwayReferenceElevationKind: runway?.elevationReference
      || (runway?.source === 'msfs-facilities' ? 'runway' : (runway ? 'airport' : null)),
    // Backward-compatible alias. The value can be a whole-runway MSFS
    // facility elevation or an airport-elevation fallback.
    thresholdElevFt: runway && Number.isFinite(runway.elevation_ft) ? runway.elevation_ft : null,
    approachProfile: renderedApproachProfile,
  };

  const retroactiveViolations: AnyRecord[] = [];
  const runwayTrueHeadingDeg = runway ? runway.heading_true_deg ?? runway.heading : null;
  if (runway && runway.threshold && Number.isFinite(runway.threshold.lat) && Number.isFinite(runwayTrueHeadingDeg)) {
    for (const approachSample of approachSamples) {
      if (!Number.isFinite(approachSample.raFt)
        || approachSample.raFt > dangerouslyLowApproachRaFt
        || !Number.isFinite(approachSample.latDeg)
        || !Number.isFinite(approachSample.lonDeg)) {
        continue;
      }

      const alongTrack = landingDistance.calculateSignedTouchdownDistance(
        runway.threshold,
        { lat: approachSample.latDeg, lon: approachSample.lonDeg },
        runwayTrueHeadingDeg,
      );

      if (alongTrack.distanceFt !== null && alongTrack.distanceFt < -flareExclusionDistanceFt) {
        retroactiveViolations.push({
          type: 'violation_start',
          timestampMs: approachSample.absMs ?? timestampMs,
          elapsedMs: approachSample.tMs ?? elapsedMs,
          ruleId: 'dangerously_low_approach',
          severity: 'warning',
          lat: approachSample.latDeg,
          lon: approachSample.lonDeg,
          context: {
            ra_ft: approachSample.raFt,
            distance_to_threshold_ft: Math.round(Math.abs(alongTrack.distanceFt)),
          },
        });
        break;
      }
    }
  }

  return {
    landingEvent,
    retroactiveViolations,
  };
}

module.exports = {
  buildReplayLandingEvent,
};

export {};
