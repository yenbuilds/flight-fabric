import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ComRadios from '../../frontend/src/vue/components/ComRadios.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import '../../frontend/index.css';

const pinia = createPinia();
setActivePinia(pinia);
const controls = useAircraftControlsStore();
const specific = useAircraftSpecificStore();
const capabilities = await (await fetch('/com-radio-capabilities')).json();
const catalogue = capabilities.aircraftCommands;
controls.applyControlCapabilities(capabilities);
controls.setAvailability({ enabled: true });
specific.applyProfile({ _profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision,
  aircraftSpecificTemplateId: 'fbw-a32nx' });
const sent = [];
controls.bindCommandAction((command) => {
  sent.push(command);
  controls.setCommandPending(command);
  return true;
});
window.comTest = {
  controls, specific, sent,
  async scenario(patch = {}) {
    const now = new Date().toISOString();
    const values = {
      ...Object.fromEntries([1, 2].flatMap((index) => Object.entries({ installed: true, status: 0, spacingMode: 1,
        activeMhz: 121.7, standbyMhz: index === 1 ? 123.45 : 118.005 }).map(([key, value]) => [`radios.com${index}.${key}`, value]))),
      ...patch,
    };
    specific.ingestState({ profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision,
      templateId: 'fbw-a32nx', available: true, sourceStatus: { overall: 'connected' },
      updatedAt: now, values,
      valueUpdatedAt: Object.fromEntries(Object.keys(values).map((id) => [id, now])) });
    await nextTick();
  },
  async settle() { await nextTick(); },
};
createApp(ComRadios).use(pinia).mount('#app');
await window.comTest.scenario();
