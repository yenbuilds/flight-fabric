import { defineStore } from 'pinia';
import { getFlightFabricAppSettings } from '../../settings/shared-runtime.js';

const { APP_SETTINGS_DEFAULTS } = getFlightFabricAppSettings();

export const useSettingsEditorStore = defineStore('settingsEditor', {
  state: () => ({
    aircraftProfile: 'auto',
    simconnectProtocol: 'KittyHawk',
    wsPort: '8099',
    httpPort: '8100',
    remoteAccess: false,
    remoteAircraftControl: APP_SETTINGS_DEFAULTS.remoteAircraftControl,
    updateChecks: APP_SETTINGS_DEFAULTS.updateChecks,
    onlineMapTiles: APP_SETTINGS_DEFAULTS.onlineMapTiles,
    recordingAutoStart: true,
    cabinAnnouncementsEnabled: APP_SETTINGS_DEFAULTS.cabinAnnouncementsEnabled,
    cabinAnnouncementsStyle: 'standard',
    cabinAnnouncementsStartupGraceMs: '5000',
    stabilityCriteria: { ...APP_SETTINGS_DEFAULTS.stabilityCriteria },
  }),

  actions: {
    applySettings(settings) {
      const {
        normalizeAppSettings,
      } = getFlightFabricAppSettings();
      const next = normalizeAppSettings(settings, {
        defaults: APP_SETTINGS_DEFAULTS,
      });

      this.aircraftProfile = next.aircraft.profile;
      // X-Plane is temporarily unavailable in the user-facing selector. Coerce
      // stale saved values so saving an unrelated setting cannot preserve or
      // reactivate the unavailable protocol.
      this.simconnectProtocol = next.simulator.protocol === 'XPLANE_WEB'
        ? 'KittyHawk'
        : next.simulator.protocol;
      this.wsPort = String(next.network.wsPort);
      this.httpPort = String(next.network.httpPort);
      this.remoteAccess = next.network.remoteAccess;
      this.remoteAircraftControl = next.network.remoteAircraftControl;
      this.updateChecks = next.network.updateChecks;
      this.onlineMapTiles = next.network.onlineMapTiles;
      this.recordingAutoStart = next.recording.autoStart;
      this.cabinAnnouncementsEnabled = next.cabinAnnouncements.enabled;
      this.cabinAnnouncementsStyle = next.cabinAnnouncements.style;
      this.cabinAnnouncementsStartupGraceMs = String(next.cabinAnnouncements.startupGraceMs);
      this.stabilityCriteria = { ...next.debrief.stabilityCriteria };
    },

    sanitizeAircraftProfile() {
      const { sanitizeNonEmptyString } = getFlightFabricAppSettings();
      this.aircraftProfile = sanitizeNonEmptyString(this.aircraftProfile, 'auto');
    },

    sanitizeCabinAnnouncementStyleValue() {
      const { sanitizeCabinAnnouncementStyle } = getFlightFabricAppSettings();
      this.cabinAnnouncementsStyle = sanitizeCabinAnnouncementStyle(this.cabinAnnouncementsStyle);
    },

    sanitizeStartupGraceValue() {
      const { sanitizeClampedInt } = getFlightFabricAppSettings();
      this.cabinAnnouncementsStartupGraceMs = String(sanitizeClampedInt(this.cabinAnnouncementsStartupGraceMs, 5000, 0, 60000));
    },

    serializeSettings() {
      const {
        normalizeAppSettings,
      } = getFlightFabricAppSettings();

      const normalized = normalizeAppSettings({
        aircraft: {
          profile: this.aircraftProfile,
        },
        simulator: {
          protocol: this.simconnectProtocol,
        },
        network: {
          wsPort: this.wsPort,
          httpPort: this.httpPort,
          remoteAccess: this.remoteAccess === true,
          remoteAircraftControl: this.remoteAccess === true && this.remoteAircraftControl === true,
          updateChecks: this.updateChecks === true,
          onlineMapTiles: this.onlineMapTiles === true,
        },
        recording: {
          autoStart: this.recordingAutoStart === true,
        },
        cabinAnnouncements: {
          enabled: this.cabinAnnouncementsEnabled === true,
          style: this.cabinAnnouncementsStyle,
          startupGraceMs: this.cabinAnnouncementsStartupGraceMs,
        },
        debrief: {
          stabilityCriteria: this.stabilityCriteria,
        },
      }, {
        defaults: APP_SETTINGS_DEFAULTS,
      });

      return normalized;
    },
  },
});
