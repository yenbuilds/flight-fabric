import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import AppNavigator from '../../frontend/src/vue/components/AppNavigator.vue';
import { useShellStore } from '../../frontend/src/vue/stores/shell.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';
import { useVoiceControlStore } from '../../frontend/src/vue/stores/voice-control.js';

const pinia = createPinia();
setActivePinia(pinia);
const shell = useShellStore();
const tabs = useTabsStore();
const voice = useVoiceControlStore();
voice.setBridgeAvailable(true);
// The focused navigator fixture models the Settings section as a focus target.
const voiceSection = document.createElement('section');
voiceSection.id = 'settings-voice-control';
voiceSection.tabIndex = -1;
voiceSection.textContent = 'Voice control';
document.getElementById('vue-main-root').appendChild(voiceSection);
createApp({ render: () => h(AppNavigator) }).use(pinia).mount('#navigator-app');
document.getElementById('open-search').onclick = () => shell.openNavigator();
document.getElementById('open-help').onclick = () => shell.openNavigator('help');
document.getElementById('more-help').onclick = () => shell.openNavigator('help');
let releaseGuard = () => {};
window.navigatorTest = {
  shell, tabs, voice,
  settle: async () => { await nextTick(); await nextTick(); await nextTick(); },
  guard(enabled) { releaseGuard(); releaseGuard = enabled ? tabs.registerBeforeChangeGuard(() => false) : () => {}; },
  key(target, key, options = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  },
  query(value) {
    const field = document.getElementById('app-navigator-query');
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  },
};
