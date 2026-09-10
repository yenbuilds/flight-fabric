import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import Efis from '../../frontend/src/vue/components/EfisControls.vue';
import Transponder from '../../frontend/src/vue/components/TransponderControls.vue';
import Minimums from '../../frontend/src/vue/components/MinimumsControls.vue';
import AircraftTabShell from '../../frontend/src/vue/components/AircraftTabShell.vue';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import '../../frontend/index.css';

const pinia = createPinia(); setActivePinia(pinia);
useTabsStore().activeTabId = 'autopilot';
const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const catalogues = await (await fetch('/capabilities')).json(), sent = [];
controls.bindCommandAction((command) => { sent.push(command); controls.setCommandPending(command); return true; });
let active;
const test = { controls, specific, sent, tick: nextTick,
  async select(profile) {
    active = catalogues[profile]; sent.length = 0; controls.resetPendingCommands();
    controls.applyControlCapabilities(active); controls.setAvailability({ enabled: true });
    specific.applyProfile({ _profileKey: active.aircraftCommands.profileKey, profileRevision: active.aircraftCommands.profileRevision, aircraftSpecificTemplateId: active.aircraftIntegration.templateId });
    await test.publish();
  },
  async publish(stale = false) {
    const now = new Date().toISOString();
    const values = { 'surveillance.powered': true, 'surveillance.transmitting': true, 'surveillance.squawk': 42,
      'navigation.captain.range': '80', 'navigation.firstOfficer.range': '40', 'navigation.captain.ls': false, 'navigation.firstOfficer.ls': true,
      'flightGuidance.lsCaptain': false, 'flightGuidance.lsFirstOfficer': true,
      'efis.captain.rangeNm': '80', 'efis.firstOfficer.rangeNm': '40', 'efis.captain.minimumsMode': 'baro', 'efis.firstOfficer.minimumsMode': 'radio',
      'efis.captain.baroMinimumsSet': true, 'efis.captain.baroMinimumsFt': 420, 'efis.firstOfficer.radioMinimumsSet': true, 'efis.firstOfficer.radioMinimumsFt': 200 };
    specific.ingestState({ profileKey: active.aircraftCommands.profileKey, profileRevision: active.aircraftCommands.profileRevision,
      templateId: active.aircraftIntegration.templateId, available: true, sourceStatus: { overall: 'connected' }, values, unavailable: [], updatedAt: now,
      valueUpdatedAt: Object.fromEntries(Object.keys(values).map((id) => [id, stale ? new Date(Date.now() - 60000).toISOString() : now])) });
    await nextTick();
  },
};
window.familiesTest = test;
const shell = new URLSearchParams(location.search).has('shell');
createApp({ render: () => shell
  ? h('main', { id: 'vue-main-root', style: 'height: calc(100dvh - 32px); overflow-y: auto;' }, [h(AircraftTabShell)])
  : h('div', { class: 'grid gap-3 lg:grid-cols-2' }, [h(Transponder), h(Minimums), h(Efis)]) }).use(pinia).mount('#app');
await test.select('pmdg-737');
window.familiesReady = true;
