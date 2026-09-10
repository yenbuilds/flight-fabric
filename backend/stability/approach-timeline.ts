const { VIOLATION_RULE } = require('../../shared/violation-rules.js') as typeof import('../../shared/violation-rules.js');
type Event = Record<string, any>;
const LEGACY_APPROACH_RULES = new Set([VIOLATION_RULE.HIGH_SINK_RATE, 'below_glidepath', 'GLIDESLOPE', 'LOCALIZER', 'BANK_ANGLE']);

/** Recorded assessment episodes are authoritative, including an empty list.
 * Do not recalculate them with today's thresholds during ordinary replay. */
export function applyRecordedApproachAssessments(events: Event[], flightStartMs: number): Event[] {
  let result = [...events];
  const landings = events.filter(event => event.type === 'landing');
  for (const landing of landings) {
    const scoringContext = landing.ultimateStability?.scoringContext;
    const assessment = scoringContext?.assessment;
    if (assessment?.version !== 4 || assessment.timeReference !== 'epoch' || !Array.isArray(assessment.episodes)) continue;
    const window = assessment.window;
    if (!Number.isFinite(window?.collectionStartMs) || !Number.isFinite(window?.endMs)) continue;
    const removedStarts = new Set<string>();
    for (const event of result) {
      if (event.type === 'violation_start' && LEGACY_APPROACH_RULES.has(event.ruleId)
          && event.timestampMs >= window.collectionStartMs && event.timestampMs <= window.endMs) {
        removedStarts.add(`${event.ruleId}:${event.timestampMs}`);
      }
    }
    result = result.filter(event => {
      if (event.context?.assessment_version === 4 && event.timestampMs >= window.startMs && event.timestampMs <= window.endMs) return false;
      if (!LEGACY_APPROACH_RULES.has(event.ruleId)) return true;
      if (event.type === 'violation_start') return !removedStarts.has(`${event.ruleId}:${event.timestampMs}`);
      if (event.type === 'violation_end') return !removedStarts.has(`${event.ruleId}:${event.timestamp_start}`);
      return true;
    });
    for (const episode of assessment.episodes) {
      if (!Number.isFinite(episode.startMs) || !Number.isFinite(episode.endMs)
          || episode.startMs < window.startMs || episode.endMs > window.endMs || episode.endMs < episode.startMs) continue;
      const context = {
        assessment_version: 4,
        policy_id: scoringContext.policy?.id,
        altitude_source: scoringContext.reference?.altitudeSource,
        gate_height_ft: window.gateHeightFt,
        start_height_ft: episode.startHeightFt,
        end_height_ft: episode.endHeightFt,
        value: episode.peakValue,
        peak_value: episode.peakValue,
        target_value: episode.targetValue,
        peak_glideslope_dots: episode.peakGlideslopeDots,
        peak_sink_rate_fpm: episode.peakSinkRateFpm,
        reasons: episode.reasons,
        duration_ms: episode.durationMs,
        threshold_exceedance_duration_ms: episode.exceedanceMs,
        end_reason: episode.endReason,
      };
      result.push({ type: 'violation_start', timestampMs: episode.startMs,
        elapsedMs: episode.startMs - flightStartMs, ruleId: episode.ruleId,
        severity: episode.severity, lat: episode.lat, lon: episode.lon, context });
      result.push({ type: 'violation_end', timestampMs: episode.endMs,
        elapsedMs: episode.endMs - flightStartMs, ruleId: episode.ruleId,
        timestamp_start: episode.startMs, duration_ms: episode.durationMs,
        severity: episode.severity, lat: episode.endLat, lon: episode.endLon, context });
    }
  }
  return result;
}
