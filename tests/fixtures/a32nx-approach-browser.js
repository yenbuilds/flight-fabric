import { createApp, h, nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import Panel from '../../frontend/src/vue/components/aircraft-specific/templates/FbwA32nxAircraftPanel.vue';
import Transponder from '../../frontend/src/vue/components/TransponderControls.vue';
import Minimums from '../../frontend/src/vue/components/MinimumsControls.vue';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import '../../frontend/index.css';

const pinia = createPinia(); setActivePinia(pinia);
const controls = useAircraftControlsStore();
const capabilities = await (await fetch('/a32nx-approach-capabilities')).json();
controls.applyControlCapabilities(capabilities); controls.setAvailability({ enabled: true });
const sent = [], pending = reactive(new Set());
const props = reactive({
  values: { 'controls.flapsHandle': '2', 'systems.autobrakeMode': 'medium',
    'controls.spoilersHandle': 0, 'controls.spoilersArmed': false },
  unavailable: [], sourceStatus: 'connected', profileKey: 'bundled/msfs/fbw-a32nx',
  actionCapabilities: Object.fromEntries(capabilities.aircraftIntegration.actions.map((a) => [typeof a === 'string' ? a : a.id, true])),
  isActionPending: (group) => pending.has(group),
  requestAction: (actionId, groupId) => { sent.push({ actionId, groupId }); pending.add(groupId); return true; },
});
window.approachTest = { props, controls, sent, pending, settle: nextTick };
const specific = useAircraftSpecificStore(), atcSent = [];
const catalogue = controls.aircraftCommandCatalogue;
specific.applyProfile({ _profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision, aircraftSpecificTemplateId: 'fbw-a32nx' });
controls.bindCommandAction((command) => { atcSent.push(command); controls.setCommandPending(command); return true; });
window.atcTest = { specific, sent: atcSent, async scenario(patch = {}, stale = false) {
  const now = new Date().toISOString();
  const values = { 'surveillance.squawk': 42, 'surveillance.powered': true, 'surveillance.transmitting': true, 'surveillance.ident': false, ...patch };
  specific.ingestState({ profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision, templateId: 'fbw-a32nx',
    available: true, sourceStatus: { overall: 'connected' }, updatedAt: now, values, unavailable: [],
    valueUpdatedAt: Object.fromEntries(Object.keys(values).map((id) => [id, stale ? new Date(Date.now() - 60000).toISOString() : now])) });
  await nextTick();
} };
createApp({ render: () => h('div', { class: 'space-y-4' }, [h(Transponder), h(Minimums), h(Panel, props)]) }).use(pinia).mount('#app');
await window.atcTest.scenario();
await nextTick();
