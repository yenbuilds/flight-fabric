import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import SystemTabShell from '../../frontend/src/vue/components/SystemTabShell.vue';
import { setAppService } from '../../frontend/app-shared.js';
import { useProfilesStore } from '../../frontend/src/vue/stores/profiles.js';
import { useStatusStore } from '../../frontend/src/vue/stores/status.js';
import { useSystemHostStore } from '../../frontend/src/vue/stores/system-host.js';

const pinia = createPinia(); setActivePinia(pinia);
const profiles = useProfilesStore(), status = useStatusStore();
profiles.setAuthorizationScope('full-control'); status.setWebsocket('ready');
const calls = [], sent = [];
let finishStart;
window.electronAPI = {
  stopBackend: async () => { calls.push('stop'); profiles.resetAuthorizationScope(); status.setWebsocket('disconnected'); return { status: 'stopped' }; },
  restartBackend: async () => { calls.push('restart'); throw new Error('Backend could not start'); },
  startBackend: () => { calls.push('start'); return new Promise(resolve => { finishStart = resolve; }); },
};
const host = useSystemHostStore();
host.refresh = async () => true;
host.bindBackendStatusEvents = () => () => {};
setAppService('sendWs', message => { sent.push(message); return true; });
const app = createApp(SystemTabShell); app.use(pinia); app.mount('#app');
window.recoveryTest = { host, profiles, status, calls, sent, nextTick, finishStart: () => finishStart({ status: 'running' }) };
