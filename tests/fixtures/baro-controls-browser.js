import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import BaroControls from '../../frontend/src/vue/components/BaroControls.vue';
import VoiceControlPanel from '../../frontend/src/vue/components/VoiceControlPanel.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import '../../frontend/index.css';

const pinia = createPinia(); setActivePinia(pinia);
const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const profiles = await (await fetch('/baro-controls-capabilities')).json();
const id = new URL(location.href).searchParams.get('profile') || 'fbw-a32nx';
const capabilities = profiles[id], fenix = id.startsWith('fenix');
const templateId = fenix ? 'fenix-a32x' : id;
const catalogue = capabilities.aircraftCommands;
controls.applyControlCapabilities(capabilities); controls.setAvailability({ enabled: true });
specific.applyProfile({ _profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision, aircraftSpecificTemplateId: templateId });
const sent = [];
controls.bindCommandAction((command) => { sent.push(command); controls.setCommandPending(command); return true; });
window.baroTest = { controls, specific, sent,
  async scenario(patch = {}) {
    const values = { 'baro.healthy': true, 'flightGuidance.baroUnitCaptain': false, 'flightGuidance.baroUnitFirstOfficer': false,
      ...Object.fromEntries(['captain', 'firstOfficer'].flatMap((side) => Object.entries({ mode: 1, valueMode: 1, value: 1013, active: true, std: false })
        .map(([p, v]) => [`baro.${side}.${p}`, v]))), ...patch };
    if (fenix) for (const side of ['captain', 'firstOfficer']) {
      const unit = `flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`;
      values[unit] = values[unit] ? 'inhg' : 'hpa';
      values[`baro.${side}.qnh`] = values[`baro.${side}.mode`] == null ? null : values[`baro.${side}.mode`] !== 0;
      values[`baro.${side}.hpa`] = values[`baro.${side}.value`]; values[`baro.${side}.inhg`] = 29.92;
    }
    const updatedAt = new Date().toISOString();
    specific.ingestState({ profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision,
      templateId, available: true, sourceStatus: { overall: 'connected' }, updatedAt,
      values, valueUpdatedAt: Object.fromEntries(Object.keys(values).map(key => [key, updatedAt])), unavailable: [] });
    await nextTick();
  }, async settle() { await nextTick(); },
};
createApp(new URL(location.href).searchParams.has('guide') ? VoiceControlPanel : BaroControls).use(pinia).mount('#app');
await window.baroTest.scenario();
