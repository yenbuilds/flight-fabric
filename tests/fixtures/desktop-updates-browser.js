import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import DesktopUpdates from '../../frontend/src/vue/components/DesktopUpdates.vue';
import SystemBanners from '../../frontend/src/vue/components/SystemBanners.vue';
import { useDesktopUpdatesStore } from '../../frontend/src/vue/stores/desktop-updates.js';
import { useStatusStore } from '../../frontend/src/vue/stores/status.js';
import { useSettingsUiStore } from '../../frontend/src/vue/stores/settings-ui.js';
const pinia = createPinia(); setActivePinia(pinia);
const updates = useDesktopUpdatesStore(), status = useStatusStore(), settings = useSettingsUiStore();
const calls = [];
let listener, settleInitial, settleDownload, accept = false;
let state = { supported: true, phase: 'available', version: '0.12.2', notes: '<script>untrusted release note</script>', message: '' };
const emit = patch => { state = { ...state, ...patch }; listener?.(state); };
window.confirm = () => accept;
const cleanup = updates.connect({
  getState: () => new Promise(resolve => { settleInitial = resolve; }),
  onState: fn => { listener = fn; return () => { listener = null; }; },
  check: async () => { calls.push('check'); return state; },
  download: async () => { calls.push('download'); emit({ phase: 'downloading', progress: 25 });
    const reply = { ...state }; return new Promise(resolve => { settleDownload = () => resolve(reply); }); },
  cancel: async () => { calls.push('cancel'); emit({ phase: 'error', message: 'Update cancelled. You can try again.' }); return state; },
  install: async () => { calls.push('install'); emit({ phase: 'preparing' }); return state; },
});
emit({});
settleInitial({ supported: false, phase: 'unavailable' });
createApp({ render: () => [h(SystemBanners), h('main', [h(DesktopUpdates)])] }).use(pinia).mount('#app');
window.updateTest = { updates, status, settings, calls, emit, nextTick, cleanup, settleDownload: () => settleDownload(), accept: value => { accept = value; } };
