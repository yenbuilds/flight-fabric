'use strict';

type BroadcastFn = (payload: Record<string, unknown>) => void;
type AnyRecord = Record<string, unknown>;

type BasicStreamsPayload = {
  vsFeetPerMin: number;
  iasKnots: number;
  gsKnots: number;
  alt_msl_ft: number;
  raFeet: number;
  altIndicatedFt: number | null;
  altCalibratedFt: number | null;
  altPlaneFt: number | null;
  aircraftAglFt: number | null;
  aircraftAboveObstaclesFt: number | null;
  planeAglFt: number | null;
  planeAglMinusCgFt: number | null;
  pressureAltFt: number | null;
  kohlsmanSettingMb: number | null;
  kohlsmanTunedMb: number | null;
  kohlsmanStd: boolean | null;
  xwind: number | null;
  lights: unknown;
  hdgMag: number;
  hdgTrue: number;
};

type AttitudePayload = {
  valid?: boolean;
  pitchDeg?: number | null;
  bankDeg?: number | null;
  pitchRad?: number;
  bankRad?: number;
  pitchSource?: string | null;
  bankSource?: string | null;
  pitchRaw?: number;
  bankRaw?: number;
  pitchDegPrimary?: number;
  bankDegPrimary?: number;
  pitchModePrimary?: string | null;
  bankModePrimary?: string | null;
};

type SurfacePayload = {
  raw: number | null;
  name: string | null;
  class: string;
  runwayLike: boolean;
  onGround: boolean;
  valid: boolean;
};

type FuelPayload = {
  totalGal: number | null;
  totalPct?: number | null;
  totalWeightLbs?: number | null;
};

type PositionPayload = {
  lat: number | null;
  lon: number | null;
  hdg: number | null;
};

type EnvironmentPayload = {
  cabinAltFt: number | null;
  cabinAltRateFpm: number | null;
  cabinAltTargetFt: number | null;
  oatC: number | null;
};

type LvarConfig = {
  autopilot?: string;
  autothrottle?: string;
  mcp?: AnyRecord;
};

type ProfileDataSource = {
  lvars?: LvarConfig | null;
  preferred?: string | null;
};

type ProfileLike = {
  id?: string | null;
  dataSource?: ProfileDataSource | null;
  integration?: {
    telemetry?: {
      autopilot?: {
        simVarReliable?: boolean;
      } | null;
    } | null;
  } | null;
};

type LvarSourceLike = {
  status?: string | null;
  error?: unknown;
};

type ReliabilityResult = {
  apReliable: boolean;
  athrReliable: boolean;
  reason: string;
};

type ReliabilityContext = {
  profile?: ProfileLike | null;
  lvarSidecarConnected?: boolean;
  lvarHasModeSelectorData?: boolean;
  lvarHasAutopilotData?: boolean;
  lvarHasAutothrottleData?: boolean;
  lvarSource?: LvarSourceLike | null;
  sdkConnected?: boolean;
  sdkHasData?: boolean;
  sdkHasAutomationData?: boolean;
  sdkSource?: unknown;
  reliability?: ReliabilityResult;
};

type AutopilotPayload = {
  apMaster?: boolean | null;
  apFdActive?: boolean | null;
  athrArmed?: boolean | null;
  athrActive?: boolean | null;
  apHdgHold?: boolean | null;
  apNavHold?: boolean | null;
  apLnavHold?: boolean | null;
  apLocHold?: boolean | null;
  apAltHold?: boolean | null;
  apVsHold?: boolean | null;
  apVnavHold?: boolean | null;
  apLvlChgHold?: boolean | null;
  apExpedHold?: boolean | null;
  apApprHold?: boolean | null;
  apSpeedHold?: boolean | null;
  apHdgTargetDeg?: number | null;
  apAltTargetFt?: number | null;
  apVsTargetFpm?: number | null;
  apSpeedTargetKts?: number | null;
  apMachTarget?: number | null;
};

const SELECTED_VS_TARGET_LIMIT_FPM = 9900;

type ControlsPayload = {
  yokeX: number | null;
  yokeY: number | null;
  rudderPedalPct: number | null;
};

type MessageTypesModule = {
  MSG: {
    LIGHTS: string;
    VS: string;
    IAS: string;
    GS: string;
    ALTITUDE: string;
    CROSSWIND: string;
    HEADING: string;
    ATTITUDE: string;
    GEAR: string;
    FLAPS: string;
    SPOILERS: string;
    SURFACE: string;
    FUEL: string;
    POSITION: string;
    ENVIRONMENT: string;
    AUTOPILOT: string;
    CONTROLS: string;
  };
};

type TimeSourceModule = {
  now: () => number;
};

const { MSG } = require('../core/message-types') as MessageTypesModule;
const timeSource = require('../core/time-source') as TimeSourceModule;

function roundedOrNull(value: unknown, decimals = 0): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buildAltitudeBroadcastPayload(payload: BasicStreamsPayload): AnyRecord {
  return {
    type: MSG.ALTITUDE,
    msl: Math.round(payload.alt_msl_ft),
    indicated: roundedOrNull(payload.altIndicatedFt ?? payload.alt_msl_ft),
    calibrated: roundedOrNull(payload.altCalibratedFt),
    plane: roundedOrNull(payload.altPlaneFt),
    ra: Math.round(payload.raFeet),
    aircraftAgl: roundedOrNull(payload.aircraftAglFt),
    aircraftAboveObstacles: roundedOrNull(payload.aircraftAboveObstaclesFt),
    planeAgl: roundedOrNull(payload.planeAglFt),
    planeAglMinusCg: roundedOrNull(payload.planeAglMinusCgFt),
    pressureAlt: roundedOrNull(payload.pressureAltFt),
    kohlsmanSettingMb: roundedOrNull(payload.kohlsmanSettingMb, 2),
    kohlsmanTunedMb: roundedOrNull(payload.kohlsmanTunedMb, 2),
    kohlsmanStd: typeof payload.kohlsmanStd === 'boolean' ? payload.kohlsmanStd : null,
  };
}

function buildAttitudeBroadcastPayload(attitude: AttitudePayload | null | undefined): AnyRecord | null {
  if (!attitude) return null;

  const pitchDeg = attitude.pitchDeg === null || typeof attitude.pitchDeg === 'undefined'
    ? null
    : Number(attitude.pitchDeg);
  const bankDeg = attitude.bankDeg === null || typeof attitude.bankDeg === 'undefined'
    ? null
    : Number(attitude.bankDeg);
  const valid = attitude.valid === true && Number.isFinite(pitchDeg) && Number.isFinite(bankDeg);

  return {
    type: MSG.ATTITUDE,
    valid,
    pitchDeg: valid ? pitchDeg : null,
    bankDeg: valid ? bankDeg : null,
    pitchRad: valid && Number.isFinite(attitude.pitchRad) ? attitude.pitchRad : undefined,
    bankRad: valid && Number.isFinite(attitude.bankRad) ? attitude.bankRad : undefined,
    pitchSource: attitude.pitchSource || undefined,
    bankSource: attitude.bankSource || undefined,
    pitchRaw: Number.isFinite(attitude.pitchRaw) ? attitude.pitchRaw : undefined,
    bankRaw: Number.isFinite(attitude.bankRaw) ? attitude.bankRaw : undefined,
    pitchDegPrimary: Number.isFinite(attitude.pitchDegPrimary) ? attitude.pitchDegPrimary : undefined,
    bankDegPrimary: Number.isFinite(attitude.bankDegPrimary) ? attitude.bankDegPrimary : undefined,
    pitchModePrimary: attitude.pitchModePrimary || undefined,
    bankModePrimary: attitude.bankModePrimary || undefined,
  };
}

function buildSurfaceBroadcastPayload(surface: SurfacePayload | null | undefined): AnyRecord | null {
  if (!surface) return null;
  return { type: MSG.SURFACE, value: surface };
}

function buildFuelBroadcastPayload(fuel: FuelPayload | null | undefined): AnyRecord | null {
  const totalGal = fuel?.totalGal;
  const totalPct = fuel?.totalPct;
  const totalWeightLbs = fuel?.totalWeightLbs;
  const hasGallons = typeof totalGal === 'number' && Number.isFinite(totalGal);
  const hasWeight = typeof totalWeightLbs === 'number' && Number.isFinite(totalWeightLbs);
  if (!hasGallons && !hasWeight) return null;
  return {
    type: MSG.FUEL,
    totalGal: hasGallons ? Math.round(totalGal) : null,
    totalWeightLbs: hasWeight ? Math.round(totalWeightLbs) : null,
    totalPct: typeof totalPct === 'number' && Number.isFinite(totalPct)
      ? Math.max(0, Math.min(100, Math.round(totalPct)))
      : null,
  };
}

function buildPositionBroadcastPayload(position: PositionPayload | null | undefined): AnyRecord | null {
  const lat = position?.lat;
  const lon = position?.lon;
  const hdg = position?.hdg;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    type: MSG.POSITION,
    lat,
    lon,
    hdg: Number.isFinite(hdg) ? hdg : null,
  };
}

function buildEnvironmentBroadcastPayload(env: EnvironmentPayload | null | undefined): AnyRecord | null {
  const cabinAltFt = env?.cabinAltFt;
  const cabinAltRateFpm = env?.cabinAltRateFpm;
  const cabinAltTargetFt = env?.cabinAltTargetFt;
  const oatC = env?.oatC;
  const hasCabinAlt = typeof cabinAltFt === 'number' && Number.isFinite(cabinAltFt);
  const hasCabinAltRate = typeof cabinAltRateFpm === 'number' && Number.isFinite(cabinAltRateFpm);
  const hasCabinAltTarget = typeof cabinAltTargetFt === 'number' && Number.isFinite(cabinAltTargetFt);
  const hasOat = typeof oatC === 'number' && Number.isFinite(oatC);
  if (!hasCabinAlt && !hasCabinAltRate && !hasCabinAltTarget && !hasOat) return null;
  return {
    type: MSG.ENVIRONMENT,
    cabinAltFt: hasCabinAlt ? Math.round(cabinAltFt) : null,
    cabinAltRateFpm: hasCabinAltRate ? Math.round(cabinAltRateFpm) : null,
    cabinAltTargetFt: hasCabinAltTarget ? Math.round(cabinAltTargetFt) : null,
    oatC: hasOat ? Math.round(oatC) : null,
  };
}

function buildAutopilotBroadcastPayload(
  ap: AutopilotPayload | null | undefined,
  reliability: ReliabilityResult,
): AnyRecord | null {
  if (!ap) return null;
  const apReliable = reliability.apReliable !== false;
  const athrReliable = reliability.athrReliable !== false;
  return {
    type: MSG.AUTOPILOT,
    master: apReliable ? ap.apMaster ?? null : null,
    fdActive: apReliable ? ap.apFdActive ?? null : null,
    athrArmed: athrReliable ? ap.athrArmed ?? null : null,
    athrActive: athrReliable ? ap.athrActive ?? null : null,
    hdgHold: apReliable ? ap.apHdgHold ?? null : null,
    navHold: apReliable ? ap.apNavHold ?? null : null,
    lnavHold: apReliable ? ap.apLnavHold ?? null : null,
    locHold: apReliable ? ap.apLocHold ?? null : null,
    altHold: apReliable ? ap.apAltHold ?? null : null,
    vsHold: apReliable ? ap.apVsHold ?? null : null,
    vnavHold: apReliable ? ap.apVnavHold ?? null : null,
    lvlChgHold: apReliable ? ap.apLvlChgHold ?? null : null,
    expedHold: apReliable ? ap.apExpedHold ?? null : null,
    apprHold: apReliable ? ap.apApprHold ?? null : null,
    spdHold: apReliable ? ap.apSpeedHold ?? null : null,
    hdgTarget: ap.apHdgTargetDeg != null ? Math.round(ap.apHdgTargetDeg) : null,
    altTarget: ap.apAltTargetFt != null ? Math.round(ap.apAltTargetFt) : null,
    vsTarget: normalizeSelectedVerticalSpeedTarget(ap.apVsTargetFpm),
    spdTarget: ap.apSpeedTargetKts != null ? Math.round(ap.apSpeedTargetKts) : null,
    machTarget: ap.apMachTarget ?? null,
    apReliable: reliability.apReliable,
    athrReliable: reliability.athrReliable,
    reliabilityReason: reliability.reason,
  };
}

function normalizeSelectedVerticalSpeedTarget(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.abs(rounded) <= SELECTED_VS_TARGET_LIMIT_FPM ? rounded : null;
}

function buildControlsBroadcastPayload(controls: ControlsPayload): AnyRecord {
  return {
    type: MSG.CONTROLS,
    yokeX: controls.yokeX != null && Number.isFinite(controls.yokeX) ? controls.yokeX : null,
    yokeY: controls.yokeY != null && Number.isFinite(controls.yokeY) ? controls.yokeY : null,
    rudderPedalPct: controls.rudderPedalPct != null && Number.isFinite(controls.rudderPedalPct) ? controls.rudderPedalPct : null,
  };
}

function sendBasicStreams(broadcast: BroadcastFn, payload: BasicStreamsPayload): void {
  const {
    vsFeetPerMin,
    iasKnots,
    gsKnots,
    xwind,
    lights,
    hdgMag,
    hdgTrue,
  } = payload;

  try { broadcast({ type: MSG.LIGHTS, data: lights }); } catch {}
  try { broadcast({ type: MSG.VS, value: Math.round(vsFeetPerMin) }); } catch {}
  try { broadcast({ type: MSG.IAS, value: Math.round(iasKnots) }); } catch {}
  try { broadcast({ type: MSG.GS, value: Math.round(gsKnots || 0) }); } catch {}
  try { broadcast(buildAltitudeBroadcastPayload(payload)); } catch {}
  try { broadcast({ type: MSG.CROSSWIND, value: xwind }); } catch {}
  try { broadcast({ type: MSG.HEADING, mag: hdgMag, true: hdgTrue }); } catch {}
}

function sendAttitude(broadcast: BroadcastFn, attitude: AttitudePayload | null | undefined): void {
  if (!attitude || typeof broadcast !== 'function') return;
  const message = buildAttitudeBroadcastPayload(attitude);
  if (!message) return;
  try { broadcast(message); } catch {}
}

function sendGear(broadcast: BroadcastFn, gearDecoded: unknown): void {
  try { broadcast({ type: MSG.GEAR, data: gearDecoded }); } catch {}
}

function sendFlapsSpoilers(broadcast: BroadcastFn, flapsObj: unknown, spoilersObj: unknown): void {
  try { broadcast({ type: MSG.FLAPS, value: flapsObj }); } catch {}
  try { broadcast({ type: MSG.SPOILERS, value: spoilersObj }); } catch {}
}

function sendSurface(broadcast: BroadcastFn, surface: SurfacePayload | null | undefined): void {
  if (!surface || typeof broadcast !== 'function') return;
  const message = buildSurfaceBroadcastPayload(surface);
  if (!message) return;
  try { broadcast(message); } catch {}
}

function sendFuel(broadcast: BroadcastFn, fuel: FuelPayload | null | undefined): void {
  if (typeof broadcast !== 'function') return;
  const message = buildFuelBroadcastPayload(fuel);
  if (!message) return;
  try { broadcast(message); } catch {}
}

function sendPosition(broadcast: BroadcastFn, position: PositionPayload | null | undefined): void {
  if (typeof broadcast !== 'function') return;
  const message = buildPositionBroadcastPayload(position);
  if (!message) return;
  try { broadcast(message); } catch {}
}

function sendEnvironment(broadcast: BroadcastFn, env: EnvironmentPayload | null | undefined): void {
  if (typeof broadcast !== 'function') return;
  const message = buildEnvironmentBroadcastPayload(env);
  if (!message) return;
  try { broadcast(message); } catch {}
}

const _apReliabilityWarnedAt = new Map<string, number>();
const AP_RELIABILITY_WARN_INTERVAL_MS = 60_000;

function isAutopilotSimVarReliable(profile: ProfileLike | null): boolean {
  return profile?.integration?.telemetry?.autopilot?.simVarReliable !== false;
}

function assessAutopilotReliability(context: ReliabilityContext | null | undefined): ReliabilityResult {
  const profile = context?.profile || null;
  const lvarSidecarConnected = Boolean(context?.lvarSidecarConnected);
  const lvarHasModeSelectorData = Boolean(context?.lvarHasModeSelectorData);
  const lvarHasAutopilotData = Boolean(context?.lvarHasAutopilotData);
  const lvarHasAutothrottleData = Boolean(context?.lvarHasAutothrottleData);
  const lvarSource = context?.lvarSource || null;
  const sdkConnected = Boolean(context?.sdkConnected);
  const sdkHasData = Boolean(context?.sdkHasAutomationData ?? context?.sdkHasData);

  const lvars = profile?.dataSource?.lvars;
  const profileId = profile?.id || 'generic';

  const profileNeedsApLvar = Boolean(lvars?.autopilot);
  const profileNeedsAtLvar = Boolean(lvars?.autothrottle);
  const profileHasModeSelectorLvars = Boolean(lvars?.mcp && typeof lvars.mcp === 'object');

  const preferredSource = profile?.dataSource?.preferred;
  const requiresExternalSource = Boolean(preferredSource && preferredSource !== 'simconnect');
  const autopilotSimVarReliable = isAutopilotSimVarReliable(profile);

  if (sdkConnected && sdkHasData) {
    return { apReliable: true, athrReliable: true, reason: 'sdk-connected' };
  }

  if (!profile || !requiresExternalSource) {
    return {
      apReliable: autopilotSimVarReliable,
      athrReliable: true,
      reason: autopilotSimVarReliable ? 'simconnect-only' : `simconnect-ap-unreliable:${profileId}`,
    };
  }

  const sidecarCanProvideAp = lvarSidecarConnected && (
    profileNeedsApLvar
      ? lvarHasAutopilotData
      : (profileHasModeSelectorLvars ? lvarHasModeSelectorData : !requiresExternalSource)
  );
  const sidecarCanProvideAt = lvarSidecarConnected && (
    profileNeedsAtLvar ? lvarHasAutothrottleData : !requiresExternalSource
  );

  if (sidecarCanProvideAp && sidecarCanProvideAt) {
    return { apReliable: true, athrReliable: true, reason: 'lvar-sidecar-connected' };
  }

  const apReliable = sidecarCanProvideAp;
  const athrReliable = sidecarCanProvideAt;
  const sidecarStatus = lvarSource?.status || 'absent';
  const sidecarError = lvarSource?.error || null;
  const reason = `lvar-sidecar-${sidecarStatus}:${profileId}`;

  const now = timeSource.now();
  const lastWarn = _apReliabilityWarnedAt.get(reason) || 0;
  if (now - lastWarn >= AP_RELIABILITY_WARN_INTERVAL_MS) {
    _apReliabilityWarnedAt.set(reason, now);
    const missing: string[] = [];
    if (profileNeedsApLvar) missing.push(`AP (LVAR: ${String(lvars?.autopilot)})`);
    if (!profileNeedsApLvar && profileHasModeSelectorLvars && !lvarHasModeSelectorData) {
      missing.push('AP mode/selector panel data');
    }
    if (profileNeedsAtLvar) missing.push(`A/T (LVAR: ${String(lvars?.autothrottle)})`);
    if (requiresExternalSource && !profileNeedsApLvar && !profileNeedsAtLvar) {
      missing.push(`AP/A/T (requires ${preferredSource})`);
    }

    const sidecarDetail = lvarSource
      ? `sidecar status="${sidecarStatus}"` + (sidecarError ? ` error="${String(sidecarError).slice(0, 200)}"` : '')
      : 'sidecar not registered (autoEnable disabled or no usable sidecar provider found)';

    console.warn(
      `[AP/AT] Reliability: UNRELIABLE for profile "${profileId}" - ${sidecarDetail}. `
      + `Hiding ${missing.join(', ')} from strip. `
      + `Common causes: aircraft-specific data bridge not loaded, variant uses a different variable namespace `
      + `than the active profile expects, configured sidecar provider crashed or never started, `
      + `or an SDK connector requires a simulator-side data broadcast setting. `
      + `Look earlier in this log for [LVAR-bridge] and [SDK-bridge] status transitions.`,
    );
  }

  return { apReliable, athrReliable, reason };
}

function sendAutopilot(
  broadcast: BroadcastFn,
  ap: AutopilotPayload | null | undefined,
  reliabilityContext: ReliabilityContext | null | undefined,
): void {
  if (typeof broadcast !== 'function' || !ap) return;

  const reliability = reliabilityContext?.reliability && typeof reliabilityContext.reliability === 'object'
    ? reliabilityContext.reliability
    : assessAutopilotReliability(reliabilityContext);
  const message = buildAutopilotBroadcastPayload(ap, reliability);
  if (!message) return;
  try { broadcast(message); } catch {}
}

function sendControls(
  broadcast: BroadcastFn,
  { yokeX, yokeY, rudderPedalPct }: ControlsPayload,
): void {
  if (typeof broadcast !== 'function') return;
  try { broadcast(buildControlsBroadcastPayload({ yokeX, yokeY, rudderPedalPct })); } catch {}
}

module.exports = {
  buildAltitudeBroadcastPayload,
  buildAttitudeBroadcastPayload,
  buildAutopilotBroadcastPayload,
  buildControlsBroadcastPayload,
  buildEnvironmentBroadcastPayload,
  buildFuelBroadcastPayload,
  buildPositionBroadcastPayload,
  buildSurfaceBroadcastPayload,
  sendBasicStreams,
  sendAttitude,
  sendGear,
  sendFlapsSpoilers,
  sendSurface,
  sendFuel,
  sendPosition,
  sendEnvironment,
  assessAutopilotReliability,
  sendAutopilot,
  sendControls,
};

export {};
