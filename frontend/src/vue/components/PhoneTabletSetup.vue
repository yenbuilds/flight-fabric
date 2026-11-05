<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { useDevicePairingStore } from '../stores/device-pairing.js';
import { useAppSettingsStore } from '../stores/app-settings.js';
import { useProfilesStore } from '../stores/profiles.js';
import { useSettingsEditorStore } from '../stores/settings-editor.js';
import { useSettingsFormStore } from '../stores/settings-form.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useStatusStore } from '../stores/status.js';
import { useSystemHostStore } from '../stores/system-host.js';
import { useTabsStore } from '../stores/tabs.js';
import RemoteBrowserQr from './RemoteBrowserQr.vue';
import SetupIllustration from './SetupIllustration.vue';

const appSettings = useAppSettingsStore();
const profiles = useProfilesStore();
const settings = useSettingsEditorStore();
const form = useSettingsFormStore();
const settingsUi = useSettingsUiStore();
const status = useStatusStore();
const host = useSystemHostStore();
const tabs = useTabsStore();
const pairing = useDevicePairingStore();
const canManage = computed(() => profiles.authorizationScope === 'full-control');
const active = computed(() => canManage.value && tabs.activeTabId === 'settings' && status.websocket === 'ready');
const savedNetwork = computed(() => appSettings.settings?.network || {});
const networkChanged = computed(() => settings.remoteAccess !== (savedNetwork.value.remoteAccess === true)
  || settings.remoteAircraftControl !== (savedNetwork.value.remoteAircraftControl !== false));
const copied = ref(false);
const copyError = ref('');
let copyTimer = null, revision = 0;
const needsRestart = computed(() => host.remoteAccessEnabled !== null && (
  (savedNetwork.value.remoteAccess === true) !== host.remoteAccessEnabled
  || (host.remoteAccessEnabled === true && pairing.loaded
    && (savedNetwork.value.remoteAircraftControl !== false) !== pairing.enabled)
));
const shareReady = computed(() => canManage.value && status.websocket === 'ready'
  && host.remoteAccessEnabled === true && !networkChanged.value && !needsRestart.value
  && !form.saveBusy && Boolean(host.remoteBrowserUrl));

function retire() {
  revision++;
  clearTimeout(copyTimer); copyTimer = null;
  copied.value = false;
  copyError.value = '';
}
async function copyAddress() {
  if (!shareReady.value || !host.remotePhoneEntryUrl) return;
  const owner = revision;
  const address = host.remotePhoneEntryUrl;
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(address);
    if (owner !== revision || !active.value || address !== host.remotePhoneEntryUrl) return;
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1800);
  } catch {
    if (owner === revision && active.value) copyError.value = 'Copy unavailable. Type the address into your phone’s browser.';
  }
}
function restart() {
  if (canManage.value && !settingsUi.restartActionDisabled) return settingsUi.requestRestart();
}
watch(active, retire, { immediate: true, flush: 'sync' });
onUnmounted(retire);
</script>

<template>
  <section id="settings-phone-tablet-access" data-settings-section tabindex="-1"
    class="settings-panel settings-panel--wide phone-setup" aria-labelledby="phone-setup-title">
    <div class="setup-test-heading">
      <SetupIllustration kind="phone" />
      <div>
        <h3 id="phone-setup-title" class="settings-panel-title">Connect a phone or tablet</h3>
        <p class="phone-setup-copy">Same trusted private network. Keep FlightFabric running.</p>
      </div>
    </div>

    <div class="phone-setup-options" role="group" aria-label="Phone connection settings">
      <label class="phone-setup-choice">
        <input form="settings-form" id="setting-remote-access" v-model="settings.remoteAccess" type="checkbox" />
        <span>Use FlightFabric on phones and tablets</span>
      </label>
      <label class="phone-setup-choice">
        <input form="settings-form" id="setting-remote-aircraft-control" v-model="settings.remoteAircraftControl" type="checkbox"
          :disabled="!settings.remoteAccess" :aria-describedby="!settings.remoteAccess ? 'phone-control-access-reason' : undefined" />
        <span>Allow aircraft controls on paired devices</span>
      </label>
      <p v-if="!settings.remoteAccess" id="phone-control-access-reason" class="phone-setup-copy">Enable phone and tablet access above to use paired controls.</p>
      <p class="phone-setup-copy">Paired devices can’t access your settings or recordings.</p>
      <div v-if="networkChanged || needsRestart" class="phone-setup-next" data-phone-restart-step>
        <p class="phone-setup-copy">{{ networkChanged ? 'Save and restart to apply your choices. Other unsaved Settings changes will also be saved.' : 'Your choices are saved. Restart FlightFabric to apply them, then return here.' }}</p>
        <button v-if="settingsUi.restartActionAvailable" type="button" class="ff-button-primary"
          data-phone-restart :disabled="settingsUi.restartActionDisabled" @click="restart">
          {{ settingsUi.restartActionLabel }}
        </button>
        <template v-else>
          <button v-if="networkChanged" type="button" class="ff-button-primary" data-phone-save
            :disabled="form.saveButtonDisabled" @click="canManage && form.requestSave()">{{ form.saveButtonLabel }}</button>
          <p class="phone-setup-copy">Restart FlightFabric on your PC after saving, then return here.</p>
        </template>
      </div>
      <p v-if="form.statusTone === 'error'" class="phone-setup-copy text-danger" role="alert">{{ form.statusMessage }}</p>
    </div>

    <template v-if="shareReady">
      <div class="phone-setup-scan">
        <RemoteBrowserQr id="phone-setup-qr" :value="host.remotePhoneEntryUrl" label="Scan to connect your phone to FlightFabric" />
        <div class="phone-setup-scan-copy">
          <h4>Scan with your phone’s camera</h4>
          <p class="phone-setup-copy">No app needed.</p>
        </div>
      </div>
      <div class="phone-setup-manual">
        <p class="phone-setup-copy">Or enter this address:</p>
        <div class="phone-setup-address-row">
          <p id="phone-setup-address" class="phone-setup-address">{{ host.remotePhoneEntryUrl }}</p>
          <button type="button" class="ff-button-secondary" data-phone-copy @click="copyAddress">{{ copied ? 'Address copied' : 'Copy address' }}</button>
        </div>
        <p v-if="copyError" class="phone-setup-copy" role="status">{{ copyError }}</p>
        <p v-if="pairing.enabled" class="phone-setup-copy">To use controls, choose Request aircraft controls on the phone. Approve its matching code in the desktop prompt.</p>
      </div>
      <div v-if="pairing.pendingCount" class="phone-setup-requests">
        <p class="phone-setup-copy">{{ pairing.pendingCount }} device request{{ pairing.pendingCount === 1 ? '' : 's' }} waiting for approval.</p>
        <button type="button" class="ff-button-secondary" data-pairing-review @click="pairing.review()">Review requests</button>
      </div>
    </template>
    <p v-else-if="status.websocket !== 'ready' || host.remoteAccessEnabled === null" class="phone-setup-copy" role="status">Waiting for FlightFabric to connect. Your setup will continue here.</p>
    <p v-else-if="host.remoteAccessEnabled === true && !networkChanged && !needsRestart" class="phone-setup-copy" role="status">No home-network address is available. Connect your PC to your home network.</p>
  </section>
</template>

<style scoped>
.phone-setup-copy { margin: .65rem 0; color: rgb(var(--muted-foreground)); font-size: .8125rem; line-height: 1.6; max-width: 42rem; }
.phone-setup-copy.text-danger { color: rgb(var(--danger)); }
.phone-setup-copy.text-warning { color: rgb(var(--warning)); }
.phone-setup-copy.text-success { color: rgb(var(--success)); }
.phone-setup h4 { font-size: 1rem; font-weight: 600; color: rgb(var(--foreground)); }
.phone-setup-options { margin-block: .75rem; }
.phone-setup-choice { display: flex; align-items: center; gap: .75rem; min-height: 2.75rem; font-size: .875rem; cursor: pointer; }
.phone-setup-choice input { flex: none; width: 1.15rem; height: 1.15rem; accent-color: rgb(var(--primary)); }
.phone-setup-scan { display: flex; align-items: flex-start; gap: 1.5rem; padding-block: 1.25rem; }
.phone-setup-scan :deep(#phone-setup-qr) { width: 12rem; height: 12rem; box-shadow: none; }
.phone-setup-scan-copy { min-width: 0; max-width: 42rem; }
.phone-setup-address-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
.phone-setup-address-row > p { min-width: 0; max-width: 100%; }
.phone-setup-address { overflow-wrap: anywhere; font-size: 1rem; margin-block: .75rem; color: rgb(var(--foreground)); }
.phone-setup-requests { padding: 1rem; margin-block: 1rem; border: 1px solid rgb(var(--primary) / .4); border-radius: .25rem; }
.phone-setup :is(button, input, a):focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 3px; }
@media (max-width: 600px) {
  .phone-setup-scan { flex-direction: column; align-items: flex-start; gap: .75rem; }
}
</style>
