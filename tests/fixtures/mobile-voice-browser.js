import { createApp, h, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import '../../frontend/index.css';
import '../../frontend/ui-polish.css';
import MobileVoiceControl from '../../frontend/src/vue/components/MobileVoiceControl.vue';
import MobileVoiceSetup from '../../frontend/src/vue/components/MobileVoiceSetup.vue';
import { useProfilesStore } from '../../frontend/src/vue/stores/profiles.js';
import { useStatusStore } from '../../frontend/src/vue/stores/status.js';
import { useSystemHostStore } from '../../frontend/src/vue/stores/system-host.js';
import { useVoiceControlStore } from '../../frontend/src/vue/stores/voice-control.js';
const fixture = await fetch('/mobile-voice-fixture').then(response => response.json());
const pinia = createPinia(); setActivePinia(pinia);
const profiles = useProfilesStore(); profiles.authorizationScope = 'aircraft-control';
useStatusStore().websocket = 'ready';
const setup = new URLSearchParams(location.search).get('setup');
if (setup === 'desktop') window.electronAPI = { getBackendBootstrap: async () => ({ body: { wsAuthToken: fixture.token } }) };
useSystemHostStore().backendHttpPort = fixture.httpPort;
useVoiceControlStore().applyRuntimeInfo({ enabled: true, available: true });
const mounted = ref(true);
createApp({ render: () => h('div', { class: 'mx-auto p-4', style: 'max-width: 42rem' }, [
  h('h1', { class: 'mb-4 text-xl font-semibold' }, 'Voice commands'),
  mounted.value && h(MobileVoiceSetup, { phone: setup !== 'desktop' }),
  !setup && h(MobileVoiceControl),
]),
}).use(pinia).mount('#app');
window.phoneVoiceTest = { profiles, mount: value => { mounted.value = value; } };
