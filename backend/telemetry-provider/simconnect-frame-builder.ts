'use strict';

type AnyRecord = Record<string, any>;

const {
  sanitizePrecipRateMm,
  sanitizePrecipState,
  sanitizeSeaLevelPressureMb,
  sanitizeVisibilityM,
} = require('../utils/weather-telemetry') as {
  sanitizePrecipRateMm: (value: unknown) => number | null;
  sanitizePrecipState: (value: unknown) => number | null;
  sanitizeSeaLevelPressureMb: (value: unknown) => number | null;
  sanitizeVisibilityM: (value: unknown) => number | null;
};

const RAD_TO_DEG = 180 / Math.PI;
const NAV_CDI_FULL_SCALE = 127;
const NAV_GSI_FULL_SCALE = 119;
const NAV_NEEDLE_FULL_SCALE_DOTS = 2.5;

function finiteNumberOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonNegativeFiniteNumberOrNull(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  return numeric != null && numeric >= 0 ? numeric : null;
}

function preferNonNegativeFiniteNumber(primary: unknown, fallback: unknown): number | null {
  return nonNegativeFiniteNumberOrNull(primary) ?? nonNegativeFiniteNumberOrNull(fallback);
}

function integerOrNull(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  return numeric == null ? null : Math.round(numeric);
}

function radiansToDegreesOrNull(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  return numeric == null ? null : numeric * RAD_TO_DEG;
}

function negateFiniteNumberOrNull(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  return numeric == null ? null : -numeric;
}

function percentOver100ToPercent(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null) return null;
  return numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
}

function navNeedleToDotsOrNull(value: unknown, fullScale: number): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric == null || Math.abs(numeric) > fullScale) return null;
  return numeric / fullScale * NAV_NEEDLE_FULL_SCALE_DOTS;
}

function formatDate(year: unknown, month: unknown, day: unknown): string | null {
  const y = integerOrNull(year);
  const m = integerOrNull(month);
  const d = integerOrNull(day);
  if (y == null || m == null || d == null) return null;
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y
    || date.getUTCMonth() !== m - 1
    || date.getUTCDate() !== d
  ) {
    return null;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatDateTime(
  year: unknown,
  month: unknown,
  day: unknown,
  seconds: unknown,
  suffix: string,
): string | null {
  const date = formatDate(year, month, day);
  const hms = secToHmsString(seconds);
  return date && hms ? `${date}T${hms}${suffix}` : null;
}

function secToHmsString(seconds: unknown): string | null {
  const totalSeconds = finiteNumberOrNull(seconds);
  if (totalSeconds == null || totalSeconds < 0 || totalSeconds >= 86400) return null;
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function buildSimConnectFdmData(d: AnyRecord, boolOrNull: (value: unknown) => boolean | null) {
  return {
    // Aerodynamics
    tasKts: d.tas ?? null,
    aoaDeg: d.aoa ?? null,
    sideslipDeg: d.sideslip ?? null,
    mach: d.mach ?? null,

    // Control surfaces (position is -1 to +1, convert to percent)
    aileronPct: d.aileronPos != null ? d.aileronPos * 100 : null,
    elevatorPct: d.elevatorPos != null ? d.elevatorPos * 100 : null,
    rudderPct: d.rudderPos != null ? d.rudderPos * 100 : null,

    // Trim
    elevTrimPct: d.elevTrimRad != null ? (d.elevTrimRad * 180 / Math.PI) : null,
    aileronTrimPct: d.aileronTrimPct != null ? d.aileronTrimPct * 100 : null,
    rudderTrimPct: d.rudderTrimPct != null ? d.rudderTrimPct * 100 : null,

    // Environment
    oatC: d.oat ?? null,
    tatC: d.tat ?? null,
    pressureMb: d.pressureMb ?? null,
    pressureAltFt: d.pressureAlt ?? null,

    // Altitude/reference diagnostics. `altIndicatedFt` is the pilot-adjustable
    // cockpit indication retained by frame.alt_msl for compatibility.
    altIndicatedFt: d.altMsl ?? null,
    altCalibratedFt: d.altCalibrated ?? null,
    altPlaneFt: d.altPlane ?? null,
    aircraftAglFt: d.aircraftAgl ?? null,
    aircraftAboveObstaclesFt: d.aircraftAboveObstacles ?? null,
    planeAglFt: d.planeAgl ?? null,
    planeAglMinusCgFt: d.planeAglMinusCg ?? null,
    kohlsmanSettingMb: d.kohlsmanSettingMb ?? null,
    kohlsmanTunedMb: d.kohlsmanTunedMb ?? null,
    kohlsmanStd: boolOrNull(d.kohlsmanStd),

    // Pressurization
    cabinAltFt: d.cabinAltFt ?? null,
    cabinAltRateFpm: d.cabinAltRateFps != null ? d.cabinAltRateFps * 60 : null,
    cabinDeltaPPsi: d.cabinDeltaPPsf != null ? d.cabinDeltaPPsf / 144 : null,
    cabinAltTargetFt: d.cabinAltTargetFt ?? null,
    cabinDumpSwitch: boolOrNull(d.cabinDumpSwitch),

    // Weather
    seaLevelPressureMb: sanitizeSeaLevelPressureMb(d.seaLevelPressureMb),
    visibilityM: sanitizeVisibilityM(d.visibilityM),
    precipRateMm: sanitizePrecipRateMm(d.precipRateMm),
    precipState: sanitizePrecipState(d.precipState),
    inCloud: boolOrNull(d.inCloud),
    surfaceCondition: d.surfaceCondition ?? null,
    densityAltFt: d.densityAlt ?? null,

    // Weight & Balance
    grossWeightLbs: d.totalWeight ?? null,
    cgPct: d.cgPct != null ? d.cgPct * 100 : null,
    fuelTotalGal: preferNonNegativeFiniteNumber(d.fuelTotalGalEx1, d.fuelTotalGal),
    fuelTotalPct: percentOver100ToPercent(d.fuelTotalPct),
    fuelTotalWeightLbs: preferNonNegativeFiniteNumber(d.fuelTotalWeightLbsEx1, d.fuelTotalWeightLbs),
    fuelWeightPerGal: d.fuelWeightPerGal ?? null,

    // Turbine N1
    eng1N1: d.eng1N1 ?? null,
    eng2N1: d.eng2N1 ?? null,
    eng3N1: d.eng3N1 ?? null,
    eng4N1: d.eng4N1 ?? null,

    // Turbine N2
    eng1N2: d.eng1N2 ?? null,
    eng2N2: d.eng2N2 ?? null,
    eng3N2: d.eng3N2 ?? null,
    eng4N2: d.eng4N2 ?? null,

    // EGT (Rankine to Celsius)
    eng1EgtC: d.eng1Egt != null ? (d.eng1Egt - 491.67) * 5 / 9 : null,
    eng2EgtC: d.eng2Egt != null ? (d.eng2Egt - 491.67) * 5 / 9 : null,
    eng3EgtC: d.eng3Egt != null ? (d.eng3Egt - 491.67) * 5 / 9 : null,
    eng4EgtC: d.eng4Egt != null ? (d.eng4Egt - 491.67) * 5 / 9 : null,

    // Fuel flow
    eng1FfPph: d.eng1Ff ?? null,
    eng2FfPph: d.eng2Ff ?? null,
    eng3FfPph: d.eng3Ff ?? null,
    eng4FfPph: d.eng4Ff ?? null,

    // Thrust reversers
    eng1RevPct: d.eng1Rev ?? null,
    eng2RevPct: d.eng2Rev ?? null,
    eng3RevPct: d.eng3Rev ?? null,
    eng4RevPct: d.eng4Rev ?? null,

    // Piston engine data
    eng1MP: d.eng1MP ?? null,
    eng2MP: d.eng2MP ?? null,
    eng1RPM: d.eng1RPM ?? null,
    eng2RPM: d.eng2RPM ?? null,

    // Turboprop specific
    eng1IttC: d.eng1Itt != null ? (d.eng1Itt - 491.67) * 5 / 9 : null,
    eng2IttC: d.eng2Itt != null ? (d.eng2Itt - 491.67) * 5 / 9 : null,
    prop1Rpm: d.prop1Rpm ?? null,
    prop2Rpm: d.prop2Rpm ?? null,
    prop1BetaDeg: d.prop1Beta != null ? d.prop1Beta * 180 / Math.PI : null,
    prop2BetaDeg: d.prop2Beta != null ? d.prop2Beta * 180 / Math.PI : null,

    // ILS deviations. MSFS NAV CDI/GSI needles are bounded raw deflections;
    // values outside that range are invalid/stale and must not enter CSV as dots.
    nav1GsiRaw: finiteNumberOrNull(d.gsNeedle),
    nav1CdiRaw: finiteNumberOrNull(d.locNeedle),
    nav1HasGlideSlope: boolOrNull(d.navHasGlideSlope),
    nav1HasLocalizer: boolOrNull(d.navHasLocalizer),
    nav1Signal: finiteNumberOrNull(d.navSignal),
    nav1ActiveMhz: finiteNumberOrNull(d.nav1ActiveMhz),
    nav1StandbyMhz: finiteNumberOrNull(d.nav1StandbyMhz),
    nav2ActiveMhz: finiteNumberOrNull(d.nav2ActiveMhz),
    nav2StandbyMhz: finiteNumberOrNull(d.nav2StandbyMhz),
    gsDeviationDots: navNeedleToDotsOrNull(d.gsNeedle, NAV_GSI_FULL_SCALE),
    locDeviationDots: navNeedleToDotsOrNull(d.locNeedle, NAV_CDI_FULL_SCALE),

    // Navigation
    trackTrueDeg: d.trackTrue ?? null,

    // Engine combustion state
    eng1Running: d.eng1Combustion ?? null,
    eng2Running: d.eng2Combustion ?? null,
    eng3Running: d.eng3Combustion ?? null,
    eng4Running: d.eng4Combustion ?? null,
    anyEngineRunning: (d.eng1Combustion != null || d.eng2Combustion != null || d.eng3Combustion != null || d.eng4Combustion != null)
      ? Boolean(d.eng1Combustion || d.eng2Combustion || d.eng3Combustion || d.eng4Combustion)
      : null,

    // G-forces
    gForce: d.gforce ?? null,
    gForceLateral: d.accelLateral != null ? d.accelLateral / 32.174 : null,
    gForceLongitudinal: d.accelLongitudinal != null ? d.accelLongitudinal / 32.174 : null,

    // Angular rates
    pitchRateRadS: d.rotVelBodyX ?? null,
    rollRateRadS: d.rotVelBodyY ?? null,
    yawRateRadS: d.rotVelBodyZ ?? null,

    // Flight control inputs
    yokeXPct: d.yokeX != null ? d.yokeX * 100 : null,
    yokeYPct: d.yokeY != null ? d.yokeY * 100 : null,
    rudderPedalPct: d.rudderPedal != null ? d.rudderPedal * 100 : null,

    // Autopilot state
    apMaster: d.apMaster ?? null,
    apAltHold: d.apAltHold ?? null,
    apHdgHold: d.apHdgHold ?? null,
    apNavHold: d.apNavHold ?? null,
    apApprHold: d.apApprHold ?? null,
    apVsHold: d.apVsHold ?? null,
    apFlcHold: d.apFlcHold ?? null,
    apSpeedHold: d.apSpeedHold ?? null,
    apFdActive: d.apFdActive ?? null,
    athrActive: d.athrActive ?? null,
    apAltTargetFt: d.apAltTargetFt ?? null,
    apHdgTargetDeg: d.apHdgTargetDeg ?? null,
    apVsTargetFpm: d.apVsTargetFpm ?? null,
    apSpeedTargetKts: d.apSpeedTargetKts ?? null,
    apMachTarget: d.apMachTarget ?? null,
    athrArmed: d.athrArmed ?? null,
  };
}

function buildSimConnectTouchdownData(d: AnyRecord) {
  const normalVelocityFps = finiteNumberOrNull(d.touchdownNormalVelocityFps);
  return {
    source: 'msfs_last_touchdown',
    bankDeg: negateFiniteNumberOrNull(d.touchdownBankDeg),
    headingMagDeg: finiteNumberOrNull(d.touchdownHeadingMagDeg),
    headingTrueDeg: finiteNumberOrNull(d.touchdownHeadingTrueDeg),
    latDeg: radiansToDegreesOrNull(d.touchdownLatRad),
    lonDeg: radiansToDegreesOrNull(d.touchdownLonRad),
    normalVelocityFps,
    normalVelocityFpm: normalVelocityFps == null ? null : normalVelocityFps * 60,
    pitchDeg: negateFiniteNumberOrNull(d.touchdownPitchDeg),
  };
}

function buildSimConnectSimTime(d: AnyRecord, secToHms: (seconds: unknown) => string | null) {
  const zuluDate = formatDate(d.zuluYear, d.zuluMonthOfYear, d.zuluDayOfMonth);
  const localDate = formatDate(d.localYear, d.localMonthOfYear, d.localDayOfMonth);
  const zuluIso = formatDateTime(d.zuluYear, d.zuluMonthOfYear, d.zuluDayOfMonth, d.zuluTimeSec, 'Z');
  const localIso = formatDateTime(d.localYear, d.localMonthOfYear, d.localDayOfMonth, d.localTimeSec, '');

  return {
    zuluSec: d.zuluTimeSec ?? null,
    localSec: d.localTimeSec ?? null,
    zuluHms: secToHms(d.zuluTimeSec),
    localHms: secToHms(d.localTimeSec),
    zuluDate,
    localDate,
    zuluIso,
    localIso,
    zuluYear: integerOrNull(d.zuluYear),
    zuluMonth: integerOrNull(d.zuluMonthOfYear),
    zuluDay: integerOrNull(d.zuluDayOfMonth),
    zuluDayOfYear: integerOrNull(d.zuluDayOfYear),
    zuluDayOfWeek: integerOrNull(d.zuluDayOfWeek),
    localYear: integerOrNull(d.localYear),
    localMonth: integerOrNull(d.localMonthOfYear),
    localDay: integerOrNull(d.localDayOfMonth),
    localDayOfYear: integerOrNull(d.localDayOfYear),
    localDayOfWeek: integerOrNull(d.localDayOfWeek),
    timezoneOffsetSec: d.timeZoneOffsetSec ?? null,
    absoluteSec: d.absoluteTimeSec ?? null,
    timeOfDay: d.timeOfDay ?? null,
    zuluSunriseSec: d.zuluSunriseTimeSec ?? null,
    zuluSunsetSec: d.zuluSunsetTimeSec ?? null,
    source: (d.zuluTimeSec != null || d.localTimeSec != null) ? 'simconnect' : null,
    valid: zuluIso != null,
  };
}

function buildSimConnectAssists(d: AnyRecord, boolOrNull: (value: unknown) => boolean | null) {
  const unlimitedFuel = boolOrNull(d.unlimitedFuel);
  const landingAssist = boolOrNull(d.assistLanding);
  const takeoffAssist = boolOrNull(d.assistTakeoff);
  const aiControls = boolOrNull(d.aiControls);
  const aiAutotrim = boolOrNull(d.aiAutotrim);
  const aiDelegated = boolOrNull(d.aiDelegated);
  const aiAntistall = integerOrNull(d.aiAntistall);
  const aiAntistallActive = aiAntistall != null ? (aiAntistall === 0 || aiAntistall === 1) : null;
  const slewActive = boolOrNull(d.slewActive);
  // AI ANTISTALL STATE is an AI-pilot system state, not a user realism toggle.
  // Keep the raw/active state for telemetry, but don't let it alone mark the
  // flight as assisted or non-realistic.
  const assistFlags = [
    unlimitedFuel,
    landingAssist,
    takeoffAssist,
    aiControls,
    aiAutotrim,
    aiDelegated,
    slewActive,
  ];
  const assistProbeAvailable = assistFlags.some((value) => value !== null);
  return {
    unlimitedFuel,
    realismPercent: d.realismPercent ?? null,
    landingAssist,
    takeoffAssist,
    aiControls,
    aiAutotrim,
    aiDelegated,
    aiAntistall,
    aiAntistallActive,
    taxiRibbons: null,
    slewActive,
    anyAssistActive: assistProbeAvailable ? assistFlags.some((value) => value === true) : null,
    fullRealism: assistProbeAvailable ? !assistFlags.some((value) => value === true) : null,
  };
}

function buildSimConnectWarnings(d: AnyRecord, boolOrNull: (value: unknown) => boolean | null) {
  return {
    overspeed: boolOrNull(d.overspeedWarning),
    stall: boolOrNull(d.stallWarning),
  };
}

module.exports = {
  buildSimConnectAssists,
  buildSimConnectFdmData,
  buildSimConnectSimTime,
  buildSimConnectTouchdownData,
  buildSimConnectWarnings,
};

export {};
