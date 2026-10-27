import { defineAsyncComponent } from 'vue';

// Waiting-page family labels only. Availability still comes from bundled profiles.
export const FEATURED_AIRCRAFT_LABELS = Object.freeze({
  'pmdg-737': 'PMDG Boeing 737',
  'pmdg-777': 'PMDG Boeing 777',
  'fenix-a320': 'Fenix Airbus A32X',
  'fbw-a32nx': 'FlyByWire A32NX',
  'inibuilds-a350-900': 'iniBuilds Airbus A350',
});
export const FEATURED_AIRCRAFT_PROFILE_IDS = Object.freeze(Object.keys(FEATURED_AIRCRAFT_LABELS));

// These selectable fallback profiles describe categories, not individual aircraft.
export const AIRCRAFT_CATEGORY_PROFILE_IDS = Object.freeze([
  'generic', 'ga-base', 'regional-jet', 'turboprop-base', 'widebody-base',
]);

const trustedAircraftSpecificTemplates = Object.freeze({
  'asobo-787': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftBoeing787_10AircraftPanel.vue')),
  'fenix-a32x': defineAsyncComponent(() => import('../components/aircraft-specific/templates/FenixA32xAircraftPanel.vue')),
  'fbw-a32nx': defineAsyncComponent(() => import('../components/aircraft-specific/templates/FbwA32nxAircraftPanel.vue')),
  'fbw-a380x': defineAsyncComponent(() => import('../components/aircraft-specific/templates/FbwA380xAircraftPanel.vue')),
  'ifly-737-max-8': defineAsyncComponent(() => import('../components/aircraft-specific/templates/Ifly737Max8AircraftPanel.vue')),
  'inibuilds-a310': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftIniBuildsA310AircraftPanel.vue')),
  'inibuilds-a330': defineAsyncComponent(() => import('../components/aircraft-specific/templates/IniBuildsA330AircraftPanel.vue')),
  'inibuilds-a350': defineAsyncComponent(() => import('../components/aircraft-specific/templates/IniBuildsA350AircraftPanel.vue')),
  'inibuilds-a380': defineAsyncComponent(() => import('../components/aircraft-specific/templates/IniBuildsA380AircraftPanel.vue')),
  'inibuilds-tristar': defineAsyncComponent(() => import('../components/aircraft-specific/templates/IniBuildsTriStarAircraftPanel.vue')),
  'microsoft-737-max-8': defineAsyncComponent(() => import('../components/aircraft-specific/templates/Microsoft737Max8AircraftPanel.vue')),
  'microsoft-atr-72-600': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftAtr72_600AircraftPanel.vue')),
  'microsoft-inibuilds-a32x': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftIniBuildsA32xAircraftPanel.vue')),
  'pmdg-737': defineAsyncComponent(() => import('../components/aircraft-specific/templates/Pmdg737AircraftPanel.vue')),
  'pmdg-777': defineAsyncComponent(() => import('../components/aircraft-specific/templates/Pmdg777AircraftPanel.vue')),
  'tfdi-md-11': defineAsyncComponent(() => import('../components/aircraft-specific/templates/TfdiMd11AircraftPanel.vue')),
  'workingtitle-747-8': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftBoeing747_8AircraftPanel.vue')),
});

export function resolveAircraftSpecificTemplate(templateId) {
  if (
    typeof templateId !== 'string'
    || !Object.prototype.hasOwnProperty.call(trustedAircraftSpecificTemplates, templateId)
  ) {
    return null;
  }
  return trustedAircraftSpecificTemplates[templateId];
}
