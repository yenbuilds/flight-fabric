// Compact display history for reconnecting toolbar clients. Never retain the
// landing analysis arrays or reuse these snapshots as live alert events.
type AnyRecord = Record<string, any>;
export const TOOLBAR_HISTORY_MAX_CAUTIONS = 6;

function record(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function sanitizeToolbarLanding(value: unknown): AnyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const landing = record(value);
  const distance = record(landing.touchdownDistance);
  const stability = record(landing.ultimateStability);
  return {
    final: landing.final === true,
    grade: text(landing.grade, 24), vs: number(landing.vs), gforce: number(landing.gforce), crosswind: number(landing.crosswind),
    icao: text(landing.icao, 8), runway: text(landing.runway, 16), approachType: text(landing.approachType, 40),
    runwayExcursion: landing.runwayExcursion === true, shortLanding: landing.shortLanding === true,
    touchdownDistance: {
      distanceFt: number(distance.distanceFt), bounceCount: number(distance.bounceCount),
      lateralOffsetFt: number(distance.lateralOffsetFt), lateralOffsetSide: text(distance.lateralOffsetSide, 16),
      zone: text(distance.zone, 48), shortLanding: distance.shortLanding === true,
    },
    ultimateStability: { score: number(stability.score), verdict: text(stability.verdict, 32) || 'no_verdict' },
  };
}

export function sanitizeToolbarCaution(value: unknown): AnyRecord | null {
  const caution = record(value);
  const label = text(caution.label, 160);
  return label ? { label, severity: caution.severity === 'critical' ? 'critical' : 'warning', at: number(caution.at) ?? 0 } : null;
}

export function sanitizeToolbarFlightHistory(value: unknown): AnyRecord {
  const history = record(value);
  const sourceAircraft = record(history.aircraft);
  const profileKey = text(sourceAircraft.profileKey, 240);
  const title = text(sourceAircraft.title, 240);
  return {
    type: 'toolbarFlightHistory',
    aircraft: profileKey || title ? { profileKey, title } : null,
    flightId: text(history.flightId, 128),
    landing: sanitizeToolbarLanding(history.landing),
    cautions: Array.isArray(history.cautions)
      ? history.cautions.slice(0, TOOLBAR_HISTORY_MAX_CAUTIONS).map(sanitizeToolbarCaution).filter(Boolean) : [],
  };
}
