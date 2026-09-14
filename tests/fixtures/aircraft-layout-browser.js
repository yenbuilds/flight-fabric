import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import AircraftTabShell from '../../frontend/src/vue/components/AircraftTabShell.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import '../../frontend/index.css';

const fixtures = await (await fetch('/aircraft-layout-fixtures')).json();
const pinia = createPinia();
setActivePinia(pinia);
const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
useTabsStore().setActiveTab('autopilot');
const sent = [];
controls.bindCommandAction(command => { sent.push(command); return true; });
let active;
function publish() {
  if (!active) return;
  const updatedAt = new Date().toISOString();
  specific.ingestState({ profileKey: active.capabilities.aircraftCommands.profileKey, profileRevision: 1,
    templateId: active.templateId, available: true, sourceStatus: { overall: 'connected', sdk: 'connected', lvar: 'connected', simvar: 'connected' },
    actionCapabilities: active.capabilities.aircraftSpecific, values: active.values, updatedAt,
    valueUpdatedAt: Object.fromEntries(Object.keys(active.values).map(id => [id, updatedAt])), unavailable: [] });
}
window.layoutTest = {
  controls, specific, sent,
  async scenario(id) {
    active = fixtures[id];
    controls.applyControlCapabilities(active.capabilities);
    controls.setAvailability({ enabled: true });
    specific.applyProfile({ _profileKey: active.capabilities.aircraftCommands.profileKey,
      profileRevision: 1, aircraftSpecificTemplateId: active.templateId });
    publish();
    await nextTick();
  },
  async settle() { await nextTick(); },
};
await window.layoutTest.scenario('pmdg-737');
createApp(AircraftTabShell).use(pinia).mount('#app');
setInterval(publish, 500);
