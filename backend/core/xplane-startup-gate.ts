type XPlaneStartupGateOptions = {
  explicitEnable?: boolean;
  cliRequested?: boolean;
  simulatorProtocol?: unknown;
};

type XPlaneStartupSelection = {
  requested: boolean;
  enabled: boolean;
  blocked: boolean;
  isXPlane: boolean;
  simulatorProtocol: 'KittyHawk' | 'XPLANE_WEB';
};

/**
 * Keep X-Plane provider activation behind two independent signals:
 * an existing protocol/CLI request and an explicit developer-only enable flag.
 *
 * To expose X-Plane selection in Settings:
 * 1. Re-enable XPLANE_WEB in frontend/src/vue/components/SettingsFormPanels.vue.
 * 2. Remove the stale-value coercion in frontend/src/vue/stores/settings-editor.js.
 * 3. Remove this two-key gate or deliberately make it enabled by default.
 * 4. Complete provider startup, telemetry, and disconnect validation.
 */
function resolveXPlaneStartupSelection({
  explicitEnable = false,
  cliRequested = false,
  simulatorProtocol = 'KittyHawk',
}: XPlaneStartupGateOptions = {}): XPlaneStartupSelection {
  const protocolRequested = String(simulatorProtocol || '').trim().toUpperCase() === 'XPLANE_WEB';
  const requested = cliRequested === true || protocolRequested;
  const enabled = explicitEnable === true && requested;

  return {
    requested,
    enabled,
    blocked: requested && !enabled,
    isXPlane: enabled,
    simulatorProtocol: enabled ? 'XPLANE_WEB' : 'KittyHawk',
  };
}

module.exports = {
  resolveXPlaneStartupSelection,
};

export {};
