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

export function sanitizeToolbarTakeoff(value: unknown): AnyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const takeoff = record(value);
  const runwayUse = record(takeoff.runwayUse);
  const roll = record(takeoff.roll);
  const liftoff = record(takeoff.liftoff);
  const screen = record(takeoff.screenHeight);
  const rotation = record(takeoff.rotation);
  const lateral = record(takeoff.lateral);
  return {
    final: takeoff.final === true,
    grade: text(takeoff.grade, 24), score: number(takeoff.score), zone: text(takeoff.zone, 48),
    icao: text(takeoff.icao, 8), runway: text(takeoff.runway, 16),
    runwayExcursion: takeoff.runwayExcursion === true, hopCount: number(takeoff.hopCount) ?? 0,
    crosswind: number(takeoff.crosswind),
    assessment: text(takeoff.assessment, 16), finalizeReason: text(takeoff.finalizeReason, 32),
    flags: Array.isArray(takeoff.flags) ? takeoff.flags.slice(0, 16).map((flag: AnyRecord) => ({
      code: text(flag?.code, 64), label: text(flag?.label, 160), severity: text(flag?.severity, 16),
    })) : [],
    runwayUse: {
      remainingFt: number(runwayUse.remainingFt), liftoffDistanceFt: number(runwayUse.liftoffDistanceFt),
      usedPct: number(runwayUse.usedPct), runwayLengthFt: number(runwayUse.runwayLengthFt),
      beyondRunwayEnd: runwayUse.beyondRunwayEnd === true,
      verified: typeof runwayUse.verified === 'boolean' ? runwayUse.verified : null,
    },
    roll: { distanceFt: number(roll.distanceFt), durationS: number(roll.durationS), startSource: text(roll.startSource, 32) },
    liftoff: { iasKts: number(liftoff.iasKts), pitchDeg: number(liftoff.pitchDeg) },
    screenHeight: { heightFt: number(screen.heightFt), reached: screen.reached === true, remainingFt: number(screen.remainingFt) },
    rotation: { rateDegS: number(rotation.rateDegS) },
    lateral: {
      liftoffOffsetFt: number(lateral.liftoffOffsetFt), liftoffOffsetSide: text(lateral.liftoffOffsetSide, 16),
      verified: lateral.verified === true,
    },
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
    takeoff: sanitizeToolbarTakeoff(history.takeoff),
    cautions: Array.isArray(history.cautions)
      ? history.cautions.slice(0, TOOLBAR_HISTORY_MAX_CAUTIONS).map(sanitizeToolbarCaution).filter(Boolean) : [],
  };
}
