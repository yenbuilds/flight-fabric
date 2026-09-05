import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import GenericNavRadios from '../../frontend/src/vue/components/GenericNavRadios.vue';
import AircraftTabShell from '../../frontend/src/vue/components/AircraftTabShell.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useFlightStore } from '../../frontend/src/vue/stores/flight.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import '../../frontend/index.css';

const pinia = createPinia();
setActivePinia(pinia);
const controls = useAircraftControlsStore();
const params = new URLSearchParams(location.search);
const genericPage = params.get('page') === 'generic';
// Use the backend's actual bundled-profile catalogue; a fabricated list hides policy gaps.
const capabilities = await (await fetch(`/nav-radio-capabilities?profile=${encodeURIComponent(params.get('profile') || 'generic')}`)).json();
const catalogue = capabilities.aircraftCommands;
controls.applyControlCapabilities(capabilities);
controls.setAvailability({ enabled: true });
const sent = [];
controls.bindCommandAction((command) => {
  sent.push(command);
  controls.setCommandPending(command);
  return true;
});
const receiver = (installed, standbyMhz = 110.30) => ({ installed, activeMhz: 108, standbyMhz });
window.navTest = {
  controls, sent, profileKey: catalogue.profileKey,
  async scenario(nav1 = true, nav2 = true) {
    controls.applyNavRadios({ ...catalogue, radios: { nav1: receiver(nav1), nav2: receiver(nav2, 117.95) } });
    await nextTick();
  },
  async settle() { await nextTick(); },
};
if (genericPage) {
  controls.setAvailability({ enabled: true, reason: 'Ready.' });
  controls.updateAutopilot({ master: true, spdTarget: 220, hdgTarget: 87, altTarget: 12000, vsTarget: -700 });
  const flight = useFlightStore();
  flight.setFlightState('live');
  flight.updateGear({ gearState: 'DOWN', left: 1, right: 1, nose: 1, parkingBrake: true });
  flight.updateLights({ available: true, nav: true, beacon: true, strobe: false, landing: false, taxi: false });
  useTabsStore().activeTabId = 'autopilot';
  // Keep this whole-page fixture live while navigating its much longer surface.
  setInterval(() => controls.applyNavRadios({ ...catalogue, radios: controls.navRadios }), 500);
}
createApp(genericPage ? AircraftTabShell : GenericNavRadios).use(pinia).mount('#app');
await window.navTest.scenario();
