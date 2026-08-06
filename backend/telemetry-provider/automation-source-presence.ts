'use strict';

const {
  hasMeaningfulSourceValue,
  isRecord,
} = require('./source-values') as {
  hasMeaningfulSourceValue: (value: unknown) => boolean;
  isRecord: (value: unknown) => value is AnyRecord;
};

type AnyRecord = Record<string, any>;

type LvarAutomationPresence = {
  hasAutomationData: boolean;
  hasModeSelectorData: boolean;
  hasAutopilotData: boolean;
  hasAutothrottleData: boolean;
};

type LvarAutomationPresenceOptions = {
  autopilotKeys?: readonly string[];
};

// These are normalized automation-presence heuristics, not aircraft/profile semantics.
// Profile loaders own aircraft-specific mappings and must feed neutral keys into this helper.
const SDK_RAW_AUTOMATION_PRESENCE_KEYS = Object.freeze([
  'ap',
  'fd',
  'fd_l',
  'fd_r',
  'at',
  'at_armed',
  'at_arm_l',
  'at_arm_r',
  'mcp_lnav',
  'mcp_vnav',
  'mcp_flch',
  'mcp_hdg_hold',
  'mcp_vs_fpa',
  'mcp_alt_hold',
  'mcp_loc',
  'mcp_app',
  'mcp_speed_kts',
  'mcp_mach',
  'mcp_heading',
  'mcp_altitude',
  'mcp_vs',
]);

const CANONICAL_LVAR_MODE_SELECTOR_KEYS = Object.freeze([
  'mode_speed',
  'mode_lnav',
  'mode_vnav',
  'mode_loc',
  'mode_app',
  'mode_heading',
  'mode_altitude_hold',
  'mode_vertical_speed',
  'mode_flc',
  'mode_expedite',
  'selected_heading',
  'selected_speed',
  'selected_altitude',
  'selected_vertical_speed',
]);

const DEFAULT_LVAR_AUTOPILOT_KEYS = Object.freeze([
  'autopilot',
]);

function normalizeRuntimeKeys(keys: readonly string[] | null | undefined): readonly string[] {
  if (keys == null) return DEFAULT_LVAR_AUTOPILOT_KEYS;
  if (!Array.isArray(keys) || keys.length === 0) return [];

  const normalized = keys
    .map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter(Boolean);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : [];
}

function hasSdkAutomationData(sdkNormalized: AnyRecord, sdkValues: AnyRecord): boolean {
  const automation = isRecord(sdkNormalized.automation) ? sdkNormalized.automation : null;
  if (automation && hasMeaningfulSourceValue(automation)) return true;
  return SDK_RAW_AUTOMATION_PRESENCE_KEYS.some((key) => hasMeaningfulSourceValue(sdkValues[key]));
}

function getLvarAutomationPresence(
  lvarValues: AnyRecord,
  options: LvarAutomationPresenceOptions = {},
): LvarAutomationPresence {
  const autopilotKeys = normalizeRuntimeKeys(options.autopilotKeys);
  const hasModeSelectorData = CANONICAL_LVAR_MODE_SELECTOR_KEYS.some((key) => hasMeaningfulSourceValue(lvarValues[key]));
  const hasAutopilotData = autopilotKeys.some((key) => hasMeaningfulSourceValue(lvarValues[key]));
  const hasAutothrottleData = hasMeaningfulSourceValue(lvarValues.autothrottle);

  return {
    hasAutomationData: hasAutopilotData || hasAutothrottleData || hasModeSelectorData,
    hasModeSelectorData,
    hasAutopilotData,
    hasAutothrottleData,
  };
}

module.exports = {
  getLvarAutomationPresence,
  hasSdkAutomationData,
};

export {};
