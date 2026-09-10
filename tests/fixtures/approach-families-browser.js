import { createApp, h, nextTick, reactive, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import Fenix from '../../frontend/src/vue/components/aircraft-specific/templates/FenixApproachControls.vue';
import P737 from '../../frontend/src/vue/components/aircraft-specific/templates/Pmdg737AircraftPanel.vue';
import P777 from '../../frontend/src/vue/components/aircraft-specific/templates/Pmdg777AircraftPanel.vue';
import { useAircraftControlsStore } from '../../frontend/src/vue/stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../frontend/src/vue/stores/aircraft-specific.js';
import '../../frontend/index.css';

const pinia = createPinia(); setActivePinia(pinia);
const controls = useAircraftControlsStore(), specific = useAircraftSpecificStore();
const catalogues = await (await fetch('/capabilities')).json(), sent = [], selected = ref('fenix-a320');
const pending = reactive(new Set());
controls.bindCommandAction(command => { sent.push(command); controls.setCommandPending(command); return true; });
const props = reactive({ values: {}, unavailable: [], sourceStatus: 'connected', sourceStatuses: { sdk: 'connected' }, actionCapabilities: {},
  profileKey: '', isActionPending: group => pending.has(group),
  isCommandSupported: id => controls.isAircraftCommandSupported(id), getCommand: id => controls.getAircraftCommand(id),
  requestCommand: (commandId, groupId, input) => { pending.add(groupId); return controls.requestControlCommand({ type: 'canonical', commandId, input }); },
  requestAction: (actionId, groupId) => { sent.push({ actionId, groupId }); pending.add(groupId); return true; },
});
let active;
const test = { controls, specific, props, sent, tick: nextTick,
  clear() { pending.clear(); controls.resetPendingCommands(); },
  async select(profile) {
    active = catalogues[profile]; selected.value = profile; sent.length = 0; test.clear();
    controls.applyControlCapabilities(active); controls.setAvailability({ enabled: true });
    specific.applyProfile({ _profileKey: active.aircraftCommands.profileKey, profileRevision: active.aircraftCommands.profileRevision, aircraftSpecificTemplateId: active.aircraftIntegration.templateId });
    props.profileKey = active.aircraftCommands.profileKey;
    props.actionCapabilities = Object.fromEntries(active.aircraftIntegration.actions.map(a => [typeof a === 'string' ? a : a.id, true]));
    await test.publish();
  },
  async publish(stale = false, patch = {}) {
    const now = new Date().toISOString();
    const values = { 'baro.healthy': true, 'controls.flapsHandle': '2', 'controls.autobrake.low': true, 'controls.autobrake.medium': false, 'controls.autobrake.max': false,
      'controls.speedbrakePosition': 1, 'flightControls.speedbrakePercent': 0, 'flightControls.speedbrakeArmed': false,
      'flightControls.flapHandleIndex': 3, 'gear.autobrakeMode': 'off', 'controls.flapsLabel': '5', 'controls.autobrakeMode': 'off', 'controls.speedbrakePercent': 0, ...patch };
    props.values = values; props.unavailable = stale ? Object.keys(values) : [];
    specific.ingestState({ profileKey: active.aircraftCommands.profileKey, profileRevision: active.aircraftCommands.profileRevision,
      templateId: active.aircraftIntegration.templateId, available: true, sourceStatus: { overall: 'connected' }, values, unavailable: [], updatedAt: now,
      valueUpdatedAt: Object.fromEntries(Object.keys(values).map(id => [id, stale ? new Date(Date.now() - 60000).toISOString() : now])) });
    await nextTick();
  },
};
window.familiesTest = test;
createApp({ render: () => h(selected.value === 'fenix-a320' ? Fenix : selected.value === 'pmdg-737' ? P737 : P777, { ...props, key: selected.value }) }).use(pinia).mount('#app');
await test.select('fenix-a320'); window.familiesReady = true;
