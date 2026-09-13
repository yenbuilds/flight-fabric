import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import AircraftSupportWorkbench from '../../frontend/src/vue/components/AircraftSupportWorkbench.vue';
import { useAircraftWorkbenchStore } from '../../frontend/src/vue/stores/aircraft-workbench.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import { useTabsStore } from '../../frontend/src/vue/stores/tabs.js';

const pinia = createPinia();
const workbench = useAircraftWorkbenchStore(pinia), aircraft = useAircraftSpecificStore(pinia), tabs = useTabsStore(pinia);
workbench.bindRequest(async (resource, options = {}) => {
  const response = await fetch(`/api/aircraft-support/${resource}`, { method: options.body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer browser-fixture', 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
});
function update() {
  const at = new Date().toISOString();
  aircraft.activeProfileKey = 'bundled/msfs/pmdg-737'; aircraft.available = true; aircraft.sourceStatus = 'connected';
  aircraft.values = Object.fromEntries((workbench.report?.contract.fields || []).map(field => [field.id, true]));
  aircraft.valueUpdatedAt = Object.fromEntries(Object.keys(aircraft.values).map(id => [id, at]));
}
setInterval(update, 200);
createApp(AircraftSupportWorkbench).use(pinia).mount('#app');
window.workbenchTest = { workbench, aircraft, tabs, settle: nextTick };
