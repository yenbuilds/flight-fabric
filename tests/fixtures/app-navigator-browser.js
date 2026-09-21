import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import AppNavigator from '../../frontend/src/vue/components/AppNavigator.vue';
import { useShellStore } from '../../frontend/src/vue/stores/shell.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';

const pinia = createPinia();
setActivePinia(pinia);
const shell = useShellStore();
const tabs = useTabsStore();
createApp({ render: () => h(AppNavigator) }).use(pinia).mount('#navigator-app');
document.getElementById('open-search').onclick = () => shell.openNavigator();
document.getElementById('open-help').onclick = () => shell.openNavigator('help');
document.getElementById('more-help').onclick = () => shell.openNavigator('help');
let releaseGuard = () => {};
window.navigatorTest = {
  shell, tabs,
  settle: async () => { await nextTick(); await nextTick(); },
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
