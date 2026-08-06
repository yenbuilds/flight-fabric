import { defineAsyncComponent } from 'vue';

const trustedAircraftSpecificTemplates = Object.freeze({
  'asobo-787': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftBoeing787_10AircraftPanel.vue')),
  'fbw-a32nx': defineAsyncComponent(() => import('../components/aircraft-specific/templates/FbwA32nxAircraftPanel.vue')),
  'ifly-737-max-8': defineAsyncComponent(() => import('../components/aircraft-specific/templates/Ifly737Max8AircraftPanel.vue')),
  'inibuilds-a310': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftIniBuildsA310AircraftPanel.vue')),
  'inibuilds-a330': defineAsyncComponent(() => import('../components/aircraft-specific/templates/IniBuildsA330AircraftPanel.vue')),
  'inibuilds-tristar': defineAsyncComponent(() => import('../components/aircraft-specific/templates/IniBuildsTriStarAircraftPanel.vue')),
  'microsoft-737-max-8': defineAsyncComponent(() => import('../components/aircraft-specific/templates/Microsoft737Max8AircraftPanel.vue')),
  'microsoft-atr-72-600': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftAtr72_600AircraftPanel.vue')),
  'microsoft-inibuilds-a32x': defineAsyncComponent(() => import('../components/aircraft-specific/templates/MicrosoftIniBuildsA32xAircraftPanel.vue')),
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

export function hasAircraftSpecificTemplate(templateId) {
  return Boolean(resolveAircraftSpecificTemplate(templateId));
}
