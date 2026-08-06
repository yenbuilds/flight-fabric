'use strict';

const { isSdkSourceType } = require('./sdk-registry') as {
  isSdkSourceType: (value: unknown) => boolean;
};
const {
  getLvarAutomationPresence,
  hasSdkAutomationData,
} = require('./automation-source-presence') as {
  getLvarAutomationPresence: (
    lvarValues: AnyRecord,
    options?: { autopilotKeys?: readonly string[] },
  ) => {
    hasAutomationData: boolean;
    hasModeSelectorData: boolean;
    hasAutopilotData: boolean;
    hasAutothrottleData: boolean;
  };
  hasSdkAutomationData: (sdkNormalized: AnyRecord, sdkValues: AnyRecord) => boolean;
};
const {
  hasMeaningfulSourceValue,
  isRecord,
} = require('./source-values') as {
  hasMeaningfulSourceValue: (value: unknown) => boolean;
  isRecord: (value: unknown) => value is AnyRecord;
};
const { decodeLights } = require('../utils/helpers') as {
  decodeLights: (value: number) => AnyRecord;
};

type AnyRecord = Record<string, any>;

type SourceOverlayContext = {
  lvarSidecarSource: AnyRecord | null;
  lvarSidecarConnected: boolean;
  lvarHasData: boolean;
  lvarHasAutomationData: boolean;
  lvarHasModeSelectorData: boolean;
  lvarHasAutopilotData: boolean;
  lvarHasAutothrottleData: boolean;
  sdkSource: AnyRecord | null;
  sdkConnected: boolean;
  sdkNormalized: AnyRecord;
  sdkValues: AnyRecord;
  sdkHasData: boolean;
  sdkHasAutomationData: boolean;
  lvarValues: AnyRecord;
};

function readNestedValue(root: unknown, pathSegments: string[]): unknown {
  let current = root;
  for (const segment of pathSegments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function coerceSdkBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['true', 'on', 'set', 'engaged'].includes(normalized)) return true;
    if (['false', 'off', 'released', 'disengaged'].includes(normalized)) return false;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric !== 0 : null;
  }
  return null;
}

function combineKnownBooleans(...values: unknown[]): boolean | null {
  let sawFalse = false;
  for (const value of values) {
    const normalized = coerceSdkBoolean(value);
    if (normalized === true) return true;
    if (normalized === false) sawFalse = true;
  }
  return sawFalse ? false : null;
}

function coerceLeverPositionBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'on', 'set', 'engaged'].includes(normalized)) return true;
    if (['false', 'off', 'released', 'disengaged'].includes(normalized)) return false;
    if (normalized) {
      const numeric = Number(normalized);
      if (Number.isFinite(numeric)) return numeric > 1 ? numeric >= 50 : numeric >= 0.5;
    }
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value > 1 ? value >= 50 : value >= 0.5;
}

function coerceSdkNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function normalizeSdkSpoilerState(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!normalized) return null;
  if (normalized === 'DOWN' || normalized === 'STOWED') return 'STOWED';
  if (normalized === 'DEPLOYED' || normalized === 'EXTENDED') return 'EXTENDED';
  if (normalized === 'ARMED') return 'ARMED';
  return normalized;
}

function getFrameSdkPayload(frame: AnyRecord | null | undefined): {
  normalized: AnyRecord;
  raw: AnyRecord;
} {
  const normalized = isRecord(frame?.sdk?.normalized) ? frame.sdk.normalized : {};
  const raw = isRecord(frame?.sdk?.raw)
    ? frame.sdk.raw
    : (isRecord(frame?.sdk?.values) ? frame.sdk.values : {});
  return { normalized, raw };
}

function createSourceOverlayContext({
  frame,
  dataSourceInfo,
  profile,
}: {
  frame: AnyRecord | null | undefined;
  dataSourceInfo: AnyRecord | null | undefined;
  profile?: AnyRecord | null | undefined;
}): SourceOverlayContext {
  const secondarySources = Array.isArray(dataSourceInfo?.secondary) ? dataSourceInfo.secondary : [];
  const lvarSidecarSource = secondarySources.find(src => src?.type === 'lvar-sidecar') || null;
  const lvarValues = isRecord(frame?.lvars?.values) ? frame.lvars.values : {};
  const lvarHasData = hasMeaningfulSourceValue(lvarValues);
  const lvarAutomationPresence = getLvarAutomationPresence(lvarValues, {
    autopilotKeys: getProfileAutopilotRuntimeKeys(profile),
  });
  const lvarSidecarConnected = lvarSidecarSource?.connected === true || Object.keys(lvarValues).length > 0;
  const sdkSource = secondarySources.find(src => isSdkSourceType(src?.type)) || null;
  const frameSdkPayload = getFrameSdkPayload(frame);
  const frameSdkHasData = (
    hasMeaningfulSourceValue(frameSdkPayload.raw) ||
    hasMeaningfulSourceValue(frameSdkPayload.normalized)
  );
  const sdkConnected = sdkSource?.connected === true || frameSdkHasData;
  const sdkPayload = sdkConnected ? frameSdkPayload : { normalized: {}, raw: {} };
  const sdkNormalized = sdkPayload.normalized;
  const sdkValues = sdkPayload.raw;
  const sdkHasData = sdkConnected && frameSdkHasData;
  const sdkHasAutomationData = sdkConnected && hasSdkAutomationData(sdkNormalized, sdkValues);

  return {
    lvarSidecarSource,
    lvarSidecarConnected,
    lvarHasData,
    lvarHasAutomationData: lvarAutomationPresence.hasAutomationData,
    lvarHasModeSelectorData: lvarAutomationPresence.hasModeSelectorData,
    lvarHasAutopilotData: lvarAutomationPresence.hasAutopilotData,
    lvarHasAutothrottleData: lvarAutomationPresence.hasAutothrottleData,
    sdkSource,
    sdkConnected,
    sdkNormalized,
    sdkValues,
    sdkHasData,
    sdkHasAutomationData,
    lvarValues,
  };
}

function getProfileAutopilotRuntimeKeys(profile: AnyRecord | null | undefined): readonly string[] {
  if (!profile) return ['autopilot'];

  const lvars = profile?.dataSource?.lvars;
  const keys: string[] = [];

  if (lvars?.autopilot) keys.push('autopilot');

  const mcp = lvars?.mcp;
  if (mcp && typeof mcp === 'object') {
    if (mcp.cmdA) keys.push('ap_channel_a');
    if (mcp.cmdB) keys.push('ap_channel_b');
  }

  return keys;
}

function sdkBoolFrom(context: SourceOverlayContext, normalizedPath: string[], rawKey: string): boolean | null {
  const normalizedValue = coerceSdkBoolean(readNestedValue(context.sdkNormalized, normalizedPath));
  return normalizedValue != null ? normalizedValue : coerceSdkBoolean(context.sdkValues[rawKey]);
}

function sdkAnyBoolFrom(
  context: SourceOverlayContext,
  normalizedPaths: string[][],
  rawKeys: string[],
): boolean | null {
  const normalizedValue = combineKnownBooleans(
    ...normalizedPaths.map((path) => readNestedValue(context.sdkNormalized, path)),
  );
  if (normalizedValue != null) return normalizedValue;
  return combineKnownBooleans(...rawKeys.map((key) => context.sdkValues[key]));
}

function sdkBoolPresenceFrom(
  context: SourceOverlayContext,
  normalizedPath: string[],
  rawKey: string,
): { present: boolean; value: boolean | null } {
  const normalizedValue = coerceSdkBoolean(readNestedValue(context.sdkNormalized, normalizedPath));
  if (normalizedValue != null) return { present: true, value: normalizedValue };

  const rawValue = coerceSdkBoolean(context.sdkValues[rawKey]);
  if (rawValue != null) return { present: true, value: rawValue };

  return { present: false, value: null };
}

function sdkNumFrom(context: SourceOverlayContext, normalizedPath: string[], rawKey: string): number | null {
  const normalizedValue = coerceSdkNumber(readNestedValue(context.sdkNormalized, normalizedPath));
  return normalizedValue != null ? normalizedValue : coerceSdkNumber(context.sdkValues[rawKey]);
}

const LIGHT_LVAR_KEY_MAP = Object.freeze({
  beacon: 'light_beacon',
  nav: 'light_nav',
  strobe: 'light_strobe',
  landing: 'light_landing',
  landing_left: 'light_landing_left',
  landing_right: 'light_landing_right',
  taxi: 'light_taxi',
  turnoff: 'light_turnoff',
  turnoff_left: 'light_turnoff_left',
  turnoff_right: 'light_turnoff_right',
  logo: 'light_logo',
  wing: 'light_wing',
  recognition: 'light_recognition',
  cabin: 'light_cabin',
});

function normalizeLightSwitchValue(raw: unknown): boolean | null {
  return coerceSdkBoolean(raw);
}

function buildLightsFromLvarValues({
  baseLights,
  lightMappings,
  lvarValues,
}: {
  baseLights?: AnyRecord | null;
  lightMappings?: AnyRecord | null;
  lvarValues?: AnyRecord | null;
}): AnyRecord | null {
  if (!isRecord(lightMappings)) return null;
  if (!isRecord(lvarValues)) return null;

  const optionalProfileKeys = new Set(
    (Array.isArray(lightMappings._optional)
      ? lightMappings._optional
      : String(lightMappings._optional || '').split(','))
      .filter((key: unknown): key is string => typeof key === 'string')
      .map((key: string) => key.trim())
      .filter(Boolean)
  );
  const configuredEntries = Object.entries(LIGHT_LVAR_KEY_MAP)
    .filter(([profileKey]) => typeof lightMappings[profileKey] === 'string' && String(lightMappings[profileKey]).trim());
  const configuredKeys = configuredEntries.map(([, canonicalKey]) => canonicalKey);

  if (configuredKeys.length === 0) return null;

  const readLightValue = (canonicalKey: string): boolean | null | undefined => {
    if (!Object.prototype.hasOwnProperty.call(lvarValues, canonicalKey)) return undefined;
    return normalizeLightSwitchValue(lvarValues[canonicalKey]);
  };

  // Treat a profile that declares profile-driven lights as unavailable until every
  // configured mapping is producing a clean bool/number value from the source bridge.
  for (const [profileKey, canonicalKey] of configuredEntries) {
    if (optionalProfileKeys.has(profileKey)) continue;
    if (readLightValue(canonicalKey) == null) return null;
  }

  const readAny = (canonicalKeys: string[]): boolean | null => {
    let seen = false;
    let on = false;

    for (const canonicalKey of canonicalKeys) {
      const value = readLightValue(canonicalKey);
      if (value == null) continue;
      seen = true;
      on = on || value;
    }

    return seen ? on : null;
  };

  const landing = readAny(['light_landing', 'light_landing_left', 'light_landing_right']);
  const turnoff = readAny(['light_turnoff', 'light_turnoff_left', 'light_turnoff_right']);
  const recog = readAny(['light_recognition']);

  return {
    nav: readAny(['light_nav']) ?? (baseLights?.nav ?? false),
    beacon: readAny(['light_beacon']) ?? (baseLights?.beacon ?? false),
    landing: landing ?? (baseLights?.landing ?? false),
    taxi: readAny(['light_taxi']) ?? (baseLights?.taxi ?? false),
    strobe: readAny(['light_strobe']) ?? (baseLights?.strobe ?? false),
    panel: baseLights?.panel ?? null,
    recog: recog ?? (baseLights?.recog ?? false),
    turnoff: turnoff ?? (baseLights?.turnoff ?? false),
    wing: readAny(['light_wing']) ?? (baseLights?.wing ?? false),
    logo: readAny(['light_logo']) ?? (baseLights?.logo ?? false),
    cabin: readAny(['light_cabin']) ?? (baseLights?.cabin ?? false),
    raw: null,
    available: true,
  };
}

function resolveSpoilersForBroadcast({
  baseSpoilers,
  profile,
  frame,
  sourceContext,
}: {
  baseSpoilers: AnyRecord | null | undefined;
  profile: AnyRecord | null | undefined;
  frame: AnyRecord | null | undefined;
  sourceContext: SourceOverlayContext;
}): AnyRecord | null | undefined {
  let spoilersObj = baseSpoilers;
  const spoilersLvarConfig = profile?.dataSource?.lvars?.spoilers;
  const hasSpoilersLvarConfig = !!(spoilersLvarConfig?.armed || spoilersLvarConfig?.handlePosition);
  let appliedSpoilersLvar = false;
  let appliedSpoilersSdk = false;

  if (hasSpoilersLvarConfig && sourceContext.lvarSidecarConnected) {
    const lvarVals = isRecord(frame?.lvars?.values) ? frame.lvars.values : {};
    const armedVal = lvarVals.spoilers_armed;
    const handleVal = lvarVals.spoilers_handle;
    const isArmed = armedVal != null ? coerceSdkBoolean(armedVal) : null;
    const rawHandle = coerceSdkNumber(handleVal);
    const handleFraction = rawHandle != null ? Math.max(0, Math.min(1, rawHandle > 1 ? rawHandle / 100 : rawHandle)) : null;
    const pct = handleFraction != null ? handleFraction * 100 : 0;

    if (isArmed != null || handleFraction != null) {
      const lvarState = pct > 5 ? 'EXTENDED' : (isArmed === true ? 'ARMED' : 'STOWED');
      spoilersObj = {
        ...spoilersObj,
        percent: pct,
        fraction: pct / 100,
        state: lvarState,
        _source: 'lvar',
      };
      appliedSpoilersLvar = true;
    }
  }

  if (sourceContext.sdkConnected) {
    const sbRaw = sdkNumFrom(sourceContext, ['spoilers', 'handlePercent'], 'speedbrake');
    const sbStateStr = normalizeSdkSpoilerState(
      readNestedValue(sourceContext.sdkNormalized, ['spoilers', 'state'])
        ?? sourceContext.sdkValues.speedbrake_state
    );
    if (sbRaw != null && sbStateStr != null) {
      let sdkState;
      let sdkPct;
      if (sbStateStr === 'ARMED') {
        sdkState = 'ARMED';
        sdkPct = 0;
      } else if (sbStateStr === 'EXTENDED') {
        sdkState = 'EXTENDED';
        sdkPct = Math.min(100, Math.max(0, sbRaw));
      } else {
        sdkState = 'STOWED';
        sdkPct = 0;
      }
      spoilersObj = {
        ...spoilersObj,
        percent: sdkPct,
        fraction: sdkPct / 100,
        state: sdkState,
        _source: 'sdk',
      };
      appliedSpoilersSdk = true;
    }
  }

  const hasTrustedSpoilersSource = appliedSpoilersLvar || appliedSpoilersSdk;
  if (hasSpoilersLvarConfig && !hasTrustedSpoilersSource) {
    spoilersObj = { ...spoilersObj, percent: null, fraction: null, state: null, available: false };
  } else if (profile?.spoilers?.simVarReliable === false && !hasTrustedSpoilersSource) {
    spoilersObj = { ...spoilersObj, percent: null, fraction: null, state: null, available: false };
  }

  return spoilersObj;
}

function resolveLightsForBroadcast({
  baseLights,
  profile,
  sourceContext,
}: {
  baseLights: AnyRecord | null | undefined;
  profile: AnyRecord | null | undefined;
  sourceContext: SourceOverlayContext;
}): AnyRecord | null | undefined {
  const lightsProfile = profile?.lights;
  const lightLvarConfig = profile?.dataSource?.lvars?.lights || null;
  const standardLightStates = coerceSdkNumber(sourceContext.lvarValues.standard_light_states);

  // The gauge/calculator API is an independent path from the Rust primary
  // SimConnect data definition. Prefer its standard mask when present, then
  // layer aircraft-specific SDK/LVAR values over it below.
  if (standardLightStates != null) {
    baseLights = {
      ...baseLights,
      ...decodeLights(Math.trunc(standardLightStates)),
      available: true,
    };
  }

  if (sourceContext.sdkHasData) {
    const nav = sdkBoolPresenceFrom(sourceContext, ['lights', 'nav'], 'nav');
    const beacon = sdkBoolPresenceFrom(sourceContext, ['lights', 'beacon'], 'beacon');
    const landingLeft = sdkBoolPresenceFrom(sourceContext, ['lights', 'landing', 'left'], 'landing_l');
    const landingRight = sdkBoolPresenceFrom(sourceContext, ['lights', 'landing', 'right'], 'landing_r');
    const landingNose = sdkBoolPresenceFrom(sourceContext, ['lights', 'landing', 'nose'], 'landing_nose');
    const taxi = sdkBoolPresenceFrom(sourceContext, ['lights', 'taxi'], 'taxi');
    const strobe = sdkBoolPresenceFrom(sourceContext, ['lights', 'strobe'], 'strobe');
    const turnoffLeft = sdkBoolPresenceFrom(sourceContext, ['lights', 'turnoff', 'left'], 'turnoff_l');
    const turnoffRight = sdkBoolPresenceFrom(sourceContext, ['lights', 'turnoff', 'right'], 'turnoff_r');
    const wing = sdkBoolPresenceFrom(sourceContext, ['lights', 'wing'], 'wing');
    const logo = sdkBoolPresenceFrom(sourceContext, ['lights', 'logo'], 'logo');
    const fields = [
      nav,
      beacon,
      landingLeft,
      landingRight,
      landingNose,
      taxi,
      strobe,
      turnoffLeft,
      turnoffRight,
      wing,
      logo,
    ];
    const hasSdkLightData = fields.some(field => field.present);

    if (hasSdkLightData) {
      const single = (field: { value: boolean | null }, baseKey: string): boolean =>
        field.value ?? (baseLights?.[baseKey] ?? false);
      const group = (groupFields: Array<{ present: boolean; value: boolean | null }>, baseKey: string): boolean =>
        groupFields.some(field => field.present)
          ? groupFields.some(field => field.value === true)
          : (baseLights?.[baseKey] ?? false);

      return {
        nav: single(nav, 'nav'),
        beacon: single(beacon, 'beacon'),
        landing: group([landingLeft, landingRight, landingNose], 'landing'),
        taxi: single(taxi, 'taxi'),
        strobe: single(strobe, 'strobe'),
        panel: baseLights?.panel ?? null,
        recog: baseLights?.recog ?? null,
        turnoff: group([turnoffLeft, turnoffRight], 'turnoff'),
        wing: single(wing, 'wing'),
        logo: single(logo, 'logo'),
        cabin: baseLights?.cabin ?? null,
        raw: null,
        available: true,
      };
    }
  }
  if (lightLvarConfig && sourceContext.lvarSidecarConnected) {
    const lvarLights = buildLightsFromLvarValues({
      baseLights,
      lightMappings: lightLvarConfig,
      lvarValues: sourceContext.lvarValues,
    });
    if (lvarLights) return lvarLights;
  }

  if (lightsProfile?.source === 'lvar') {
    if (!sourceContext.lvarSidecarConnected) {
      return { ...baseLights, available: false };
    }
    const lvarLights = buildLightsFromLvarValues({
      baseLights,
      lightMappings: lightLvarConfig,
      lvarValues: sourceContext.lvarValues,
    });
    return lvarLights || { ...baseLights, available: false };
  }
  if (lightsProfile?.simVarReliable === false) {
    return { ...baseLights, available: false };
  }
  return baseLights;
}

function resolveAutopilotSourceOverlay({
  baseFdm,
  profile,
  sourceContext,
}: {
  baseFdm: AnyRecord;
  profile: AnyRecord | null | undefined;
  sourceContext: SourceOverlayContext;
}): AnyRecord {
  const lvarBool = (key: string): boolean | null => {
    if (!sourceContext.lvarSidecarConnected) return null;
    const raw = sourceContext.lvarValues[key];
    if (raw == null) return null;
    return coerceSdkBoolean(raw);
  };
  const lvarNum = (key: string): number | null => {
    if (!sourceContext.lvarSidecarConnected) return null;
    const raw = sourceContext.lvarValues[key];
    return coerceSdkNumber(raw);
  };
  const profileMcpLvars = profile?.dataSource?.lvars?.mcp;
  const profileSpdLvar = profileMcpLvars?.speed;
  const profileSpeedRuntimeKey = typeof profileSpdLvar === 'string' && /^[A-Za-z0-9_.:-]+$/.test(profileSpdLvar.trim())
    ? profileSpdLvar.trim()
    : null;

  const apLvar = combineKnownBooleans(
    ...getProfileAutopilotRuntimeKeys(profile).map((key) => lvarBool(key)),
  );
  const athrLvar = lvarBool('autothrottle');
  const lnavLvar = lvarBool('mode_lnav');
  const vnavLvar = lvarBool('mode_vnav');
  const locLvar = lvarBool('mode_loc');
  const appLvar = lvarBool('mode_app');
  const spdModeLvar = lvarBool('mode_speed');
  const hdgModeLvar = lvarBool('mode_heading');
  const altModeLvar = lvarBool('mode_altitude_hold');

  const vsModeEnumValues = profile?.dataSource?.lvars?.mcp?.vsModeEnumVs;
  let vsModeLvar;
  if (vsModeEnumValues && Array.isArray(vsModeEnumValues)) {
    const vsModeRaw = lvarNum('mode_vertical_speed');
    vsModeLvar = vsModeRaw != null ? vsModeEnumValues.includes(vsModeRaw) : null;
  } else {
    vsModeLvar = lvarBool('mode_vertical_speed');
  }

  const lvlChgLvar = lvarBool('mode_flc');
  const expedLvar = lvarBool('mode_expedite');
  const hdgWindowLvar = lvarNum('selected_heading');
  const spdWindowLvar = lvarNum('selected_speed')
    ?? (profileSpeedRuntimeKey && profileSpeedRuntimeKey !== 'selected_speed' ? lvarNum(profileSpeedRuntimeKey) : null);
  const altWindowLvar = lvarNum('selected_altitude');
  const vsWindowLvar = lvarNum('selected_vertical_speed');

  const preferredSource = profile?.dataSource?.preferred;
  const simconnectWindowsReliable = !preferredSource || preferredSource === 'simconnect';
  const autopilotSimVarReliable = profile?.integration?.telemetry?.autopilot?.simVarReliable !== false;
  const simconnectEngagementReliable = simconnectWindowsReliable && autopilotSimVarReliable;
  const simconnectMachReliable = simconnectWindowsReliable && !profileSpdLvar;
  const simconnectFallback = (overlayValue: unknown, baseValue: unknown): unknown =>
    overlayValue != null ? overlayValue : (simconnectWindowsReliable ? baseValue : null);
  const simconnectModeFallback = (overlayValue: unknown, baseValue: unknown): unknown =>
    overlayValue != null ? overlayValue : (simconnectEngagementReliable ? baseValue : null);
  const baseLvlChgHold = baseFdm.apLvlChgHold ?? baseFdm.apFlcHold;

  const lvarOverlay = {
    ...baseFdm,
    apMaster: apLvar != null ? apLvar : (simconnectEngagementReliable ? baseFdm.apMaster : null),
    apFdActive: simconnectModeFallback(null, baseFdm.apFdActive),
    athrActive: athrLvar != null ? athrLvar : (simconnectEngagementReliable ? baseFdm.athrActive : null),
    athrArmed: simconnectEngagementReliable ? baseFdm.athrArmed : null,
    apHdgHold: simconnectModeFallback(hdgModeLvar, baseFdm.apHdgHold),
    apNavHold: simconnectModeFallback(null, baseFdm.apNavHold),
    apAltHold: simconnectModeFallback(altModeLvar, baseFdm.apAltHold),
    apVsHold: simconnectModeFallback(vsModeLvar, baseFdm.apVsHold),
    apLnavHold: simconnectModeFallback(lnavLvar, baseFdm.apLnavHold),
    apVnavHold: simconnectModeFallback(vnavLvar, baseFdm.apVnavHold),
    apLocHold: simconnectModeFallback(locLvar, baseFdm.apLocHold),
    apFlcHold: simconnectModeFallback(lvlChgLvar, baseFdm.apFlcHold),
    apLvlChgHold: simconnectModeFallback(lvlChgLvar, baseLvlChgHold),
    apExpedHold: simconnectModeFallback(expedLvar, baseFdm.apExpedHold),
    apApprHold: simconnectModeFallback(appLvar, baseFdm.apApprHold),
    apSpeedHold: simconnectModeFallback(spdModeLvar, baseFdm.apSpeedHold),
    apHdgTargetDeg: simconnectFallback(hdgWindowLvar, baseFdm.apHdgTargetDeg),
    apSpeedTargetKts: (spdWindowLvar != null && spdWindowLvar >= 10) ? spdWindowLvar : (simconnectWindowsReliable ? baseFdm.apSpeedTargetKts : null),
    apMachTarget: (spdWindowLvar != null && spdWindowLvar > 0 && spdWindowLvar < 10) ? spdWindowLvar : (simconnectMachReliable ? baseFdm.apMachTarget : null),
    apAltTargetFt: simconnectFallback(altWindowLvar, baseFdm.apAltTargetFt),
    apVsTargetFpm: simconnectFallback(vsWindowLvar, baseFdm.apVsTargetFpm),
  };

  if (!sourceContext.sdkHasAutomationData) {
    return lvarOverlay;
  }

  const apSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'engaged'], 'ap');
  const fdActiveSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'flightDirector', 'active'], 'fd');
  const fdPairSdk = sdkAnyBoolFrom(sourceContext, [
    ['automation', 'ap', 'flightDirector', 'left'],
    ['automation', 'ap', 'flightDirector', 'right'],
  ], ['fd_l', 'fd_r']);
  const fdSdk = fdActiveSdk != null ? fdActiveSdk : fdPairSdk;
  const atSdk = sdkBoolFrom(sourceContext, ['automation', 'athr', 'active'], 'at');
  const atArmedDirectSdk = sdkBoolFrom(sourceContext, ['automation', 'athr', 'armed'], 'at_armed');
  const atArmedPairSdk = sdkAnyBoolFrom(sourceContext, [], ['at_arm_l', 'at_arm_r']);
  const atArmedSdk = atArmedDirectSdk != null ? atArmedDirectSdk : atArmedPairSdk;
  const lnavSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'lnav'], 'mcp_lnav');
  const vnavSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'vnav'], 'mcp_vnav');
  const flchSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'flch'], 'mcp_flch');
  const hdgSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'hdg'], 'mcp_hdg_hold');
  const vsSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'vs'], 'mcp_vs_fpa');
  const altSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'alt'], 'mcp_alt_hold');
  const locSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'loc'], 'mcp_loc');
  const appSdk = sdkBoolFrom(sourceContext, ['automation', 'ap', 'modes', 'app'], 'mcp_app');
  const spdKtsSdk = sdkNumFrom(sourceContext, ['automation', 'ap', 'selected', 'speedKts'], 'mcp_speed_kts');
  const machSdk = sdkNumFrom(sourceContext, ['automation', 'ap', 'selected', 'mach'], 'mcp_mach');
  const hdgWinSdk = sdkNumFrom(sourceContext, ['automation', 'ap', 'selected', 'headingDeg'], 'mcp_heading');
  const altWinSdk = sdkNumFrom(sourceContext, ['automation', 'ap', 'selected', 'altitudeFt'], 'mcp_altitude');
  const vsWinSdk = sdkNumFrom(sourceContext, ['automation', 'ap', 'selected', 'vsFpm'], 'mcp_vs');

  return {
    ...lvarOverlay,
    apMaster: apSdk != null ? apSdk : lvarOverlay.apMaster,
    apFdActive: fdSdk != null ? fdSdk : lvarOverlay.apFdActive,
    athrActive: atSdk != null ? atSdk : lvarOverlay.athrActive,
    athrArmed: atArmedSdk != null ? atArmedSdk : lvarOverlay.athrArmed,
    apLnavHold: lnavSdk != null ? lnavSdk : lvarOverlay.apLnavHold,
    apVnavHold: vnavSdk != null ? vnavSdk : lvarOverlay.apVnavHold,
    apLvlChgHold: flchSdk != null ? flchSdk : lvarOverlay.apLvlChgHold,
    apHdgHold: hdgSdk != null ? hdgSdk : lvarOverlay.apHdgHold,
    apVsHold: vsSdk != null ? vsSdk : lvarOverlay.apVsHold,
    apAltHold: altSdk != null ? altSdk : lvarOverlay.apAltHold,
    apLocHold: locSdk != null ? locSdk : lvarOverlay.apLocHold,
    apApprHold: appSdk != null ? appSdk : lvarOverlay.apApprHold,
    apHdgTargetDeg: hdgWinSdk != null ? hdgWinSdk : lvarOverlay.apHdgTargetDeg,
    apSpeedTargetKts: spdKtsSdk != null ? spdKtsSdk : lvarOverlay.apSpeedTargetKts,
    apMachTarget: machSdk != null ? machSdk : lvarOverlay.apMachTarget,
    apAltTargetFt: altWinSdk != null ? altWinSdk : lvarOverlay.apAltTargetFt,
    apVsTargetFpm: vsWinSdk != null ? vsWinSdk : lvarOverlay.apVsTargetFpm,
  };
}

function overlayParkingBrakeSources({
  gear,
  profile,
  sourceContext,
}: {
  gear: AnyRecord;
  profile: AnyRecord | null | undefined;
  sourceContext: SourceOverlayContext;
}): AnyRecord {
  const nextGear = { ...gear };

  if (profile?.dataSource?.lvars?.parkingBrake && sourceContext.lvarSidecarConnected) {
    const lvarPb = sourceContext.lvarValues.parking_brake;
    const parkingBrake = coerceLeverPositionBoolean(lvarPb);
    if (parkingBrake != null) nextGear.parkingBrake = parkingBrake;
  }

  const sdkParkingBrake = sdkBoolFrom(sourceContext, ['brakes', 'parking'], 'parking_brake');
  if (sourceContext.sdkConnected && sdkParkingBrake != null) {
    nextGear.parkingBrake = sdkParkingBrake;
  }

  return nextGear;
}

const sourceOverlaysApi = {
  buildLightsFromLvarValues,
  coerceLeverPositionBoolean,
  coerceSdkBoolean,
  coerceSdkNumber,
  createSourceOverlayContext,
  getFrameSdkPayload,
  overlayParkingBrakeSources,
  readNestedValue,
  resolveAutopilotSourceOverlay,
  resolveLightsForBroadcast,
  resolveSpoilersForBroadcast,
};

module.exports = sourceOverlaysApi;

export {};
