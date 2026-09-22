'use strict';

/**
 * Assist snapshot helpers shared by the landing and takeoff runners.
 *
 * The `assist_*` CSV columns are one contract for LANDING and TAKEOFF rows, so
 * both event payloads flatten the frame's assist snapshot through this single
 * list. Add a column here and both rows carry it.
 */

type AnyRecord = Record<string, any>;

function cloneAssistSnapshot(assists: unknown): AnyRecord | null {
  if (!assists || typeof assists !== 'object') return null;
  return { ...(assists as AnyRecord) };
}

function buildAssistCsvFields(assists: AnyRecord | null): AnyRecord {
  return {
    assist_unlimited_fuel: assists?.unlimitedFuel ?? null,
    assist_landing_enabled: assists?.landingAssist ?? null,
    assist_takeoff_enabled: assists?.takeoffAssist ?? null,
    assist_ai_controls: assists?.aiControls ?? null,
    assist_ai_autotrim: assists?.aiAutotrim ?? null,
    assist_ai_delegated: assists?.aiDelegated ?? null,
    assist_ai_antistall_state: assists?.aiAntistall ?? null,
    assist_ai_antistall_active: assists?.aiAntistallActive ?? null,
    assist_realism_pct: assists?.realismPercent ?? null,
    assist_full_realism: assists?.fullRealism ?? null,
    assist_slew_active: assists?.slewActive ?? null,
    assist_any_active: assists?.anyAssistActive ?? null,
  };
}

module.exports = { buildAssistCsvFields, cloneAssistSnapshot };

export {};
