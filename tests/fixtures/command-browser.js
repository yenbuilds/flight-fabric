import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import AircraftCommandBrowser from '../../frontend/src/vue/components/AircraftCommandBrowser.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import '../../frontend/index.css';

const profiles = await (await fetch('/command-capabilities')).json();
const pinia = createPinia(); setActivePinia(pinia);
const controls = useAircraftControlsStore(), sent = [];
controls.bindCommandAction(command => { sent.push(command); controls.setCommandPending(command); return true; });
window.commandTest = { controls, sent, async settle() { await nextTick(); },
  async profile(id) { controls.applyControlCapabilities(profiles[id]); controls.resetPendingCommands();
    controls.setAvailability({ enabled: true }); await nextTick(); } };
await window.commandTest.profile('pmdg-737');
createApp(AircraftCommandBrowser).use(pinia).mount('#app');
