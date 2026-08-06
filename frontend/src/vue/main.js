import { createApp } from 'vue';
import { createPinia } from 'pinia';
import AppShell from './components/AppShell.vue';
import { useAppSettingsStore } from './stores/app-settings.js';
import { useAircraftControlsStore } from './stores/aircraft-controls.js';
import { useAircraftSpecificStore } from './stores/aircraft-specific.js';
import { useDataSourcesUiStore } from './stores/data-sources-ui.js';
import { useDebugStore } from './stores/debug.js';
import { useFlightStore } from './stores/flight.js';
import { useFeedbackStore } from './stores/feedback.js';
import { useLandingStore } from './stores/landing.js';
import { useLiveMapStore } from './stores/live-map.js';
import { useLogbookStore } from './stores/logbook.js';
import { useLvarInspectorStore } from './stores/lvar-inspector.js';
import { usePreferencesStore } from './stores/preferences.js';
import { useProfilesStore } from './stores/profiles.js';
import { useSettingsEditorStore } from './stores/settings-editor.js';
import { useSettingsFormStore } from './stores/settings-form.js';
import { useSettingsUiStore } from './stores/settings-ui.js';
import { useSimbriefStore } from './stores/simbrief.js';
import { useStatusStore } from './stores/status.js';
import { useSystemHostStore } from './stores/system-host.js';
import { useTabsStore } from './stores/tabs.js';
import { useThemeStore } from './stores/theme.js';
import { useTimelineStore } from './stores/timeline.js';
import { createThemeRuntime } from '../theme/runtime.js';
import {
  subscribeAppSettings,
  subscribeAppSettingsSaved,
  subscribeTelemetryReset,
  subscribeWsClose,
  subscribeWsConnecting,
  subscribeWsError,
  subscribeWsOpen,
} from '../app/runtime-signals.js';

const pinia = createPinia();
const mountedApps = {};

function mountVueIsland(key, rootId, component, props) {
  const mountEl = document.getElementById(rootId);
  if (!mountEl) return null;
  const app = createApp(component, props);
  app.use(pinia);
  app.mount(mountEl);
  mountedApps[key] = app;
  return app;
}

[
  ['appShell', 'vue-app-root', AppShell],
].forEach(([key, rootId, component, props]) => {
  mountVueIsland(key, rootId, component, props);
});

const appSettings = useAppSettingsStore(pinia);
const aircraftControls = useAircraftControlsStore(pinia);
const aircraftSpecific = useAircraftSpecificStore(pinia);
const dataSourcesUi = useDataSourcesUiStore(pinia);
const debug = useDebugStore(pinia);
const feedback = useFeedbackStore(pinia);
const flight = useFlightStore(pinia);
const landing = useLandingStore(pinia);
const liveMap = useLiveMapStore(pinia);
const logbook = useLogbookStore(pinia);
const lvarInspector = useLvarInspectorStore(pinia);
const preferences = usePreferencesStore(pinia);
const profiles = useProfilesStore(pinia);
const settingsEditor = useSettingsEditorStore(pinia);
const settingsForm = useSettingsFormStore(pinia);
const status = useStatusStore(pinia);
const settingsUi = useSettingsUiStore(pinia);
const simbrief = useSimbriefStore(pinia);
const systemHost = useSystemHostStore(pinia);
const tabs = useTabsStore(pinia);
const theme = useThemeStore(pinia);
const timeline = useTimelineStore(pinia);
const themeRuntime = createThemeRuntime({ documentRef: document });
const footerVersionEl = document.getElementById('app-version');

if (footerVersionEl?.textContent) {
  settingsUi.setAboutVersion(footerVersionEl.textContent);
}

theme.bindRuntime({
  applyThemeAttributes: (name) => themeRuntime.applyThemeAttributes(name),
});
theme.initialize();

subscribeWsConnecting(() => {
  status.setWebsocket('connecting');
});
subscribeWsError(() => {
  status.setWebsocket('error');
});
subscribeWsOpen(() => {
  status.setWebsocket('ready');
});
subscribeWsClose(() => {
  status.setWebsocket('disconnected');
  aircraftSpecific.clearSnapshot('disconnected');
});
subscribeTelemetryReset((detail) => {
  status.resetTelemetry(detail?.reason);
  aircraftSpecific.clearSnapshot(detail?.reason === 'simconnectDisconnected' ? 'disconnected' : 'awaiting-values');
});
subscribeAppSettings((detail = {}) => {
  appSettings.apply(detail);
  if (detail.backendVersion) {
    settingsUi.setAboutVersion(detail.backendVersion);
  }
});
subscribeAppSettingsSaved((detail = {}) => {
  if (detail.settings) {
    appSettings.apply(detail);
  }
});

export const vueRuntimeContext = {
  app: mountedApps.appShell || null,
  apps: mountedApps,
  pinia,
  stores: {
    appSettings,
    aircraftControls,
    aircraftSpecific,
    dataSourcesUi,
    debug,
    feedback,
    flight,
    landing,
    liveMap,
    logbook,
    lvarInspector,
    preferences,
    profiles,
    settingsEditor,
    settingsForm,
    settingsUi,
    simbrief,
    status,
    systemHost,
    tabs,
    theme,
    timeline,
  },
};
