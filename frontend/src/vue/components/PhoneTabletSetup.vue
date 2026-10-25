<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { sendWs } from '../../../app-shared.js';
import { subscribeWsMessage } from '../../app/runtime-signals.js';
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
const canManage = computed(() => profiles.authorizationScope === 'full-control');
const active = computed(() => canManage.value && tabs.activeTabId === 'settings' && status.websocket === 'ready');
const savedNetwork = computed(() => appSettings.settings?.network || {});
const networkChanged = computed(() => settings.remoteAccess !== (savedNetwork.value.remoteAccess === true)
  || settings.remoteAircraftControl !== (savedNetwork.value.remoteAircraftControl !== false));
const pairingRequests = ref([]);
const pairingEnabled = ref(false);
const pairingLoaded = ref(false);
const approvingId = ref('');
const notice = ref('');
const noticeError = ref(false);
const now = ref(Date.now());
const copied = ref(false);
const copyError = ref('');
const section = ref(null);
let pollTimer = null, approvalTimer = null, copyTimer = null, unsubscribe = null, revision = 0;
let approvalFocusTarget = null;
const needsRestart = computed(() => host.remoteAccessEnabled !== null && (
  (savedNetwork.value.remoteAccess === true) !== host.remoteAccessEnabled
  || (host.remoteAccessEnabled === true && pairingLoaded.value
    && (savedNetwork.value.remoteAircraftControl !== false) !== pairingEnabled.value)
));
const shareReady = computed(() => canManage.value && status.websocket === 'ready'
  && host.remoteAccessEnabled === true && !networkChanged.value && !needsRestart.value
  && !form.saveBusy && Boolean(host.remoteBrowserUrl));

function refreshPairing() {
  if (!active.value) return;
  now.value = Date.now();
  sendWs({ type: 'requestDevicePairingRequests' });
}
function retire() {
  revision++;
  clearInterval(pollTimer); clearTimeout(approvalTimer); clearTimeout(copyTimer);
  pollTimer = approvalTimer = copyTimer = null;
  pairingRequests.value = [];
  pairingLoaded.value = false;
  pairingEnabled.value = false;
  approvingId.value = '';
  approvalFocusTarget = null;
  notice.value = '';
  copied.value = false;
  copyError.value = '';
}
function restoreApprovalFocus() {
  const target = approvalFocusTarget;
  approvalFocusTarget = null;
  void nextTick(() => {
    if (active.value && target && (document.activeElement === target || document.activeElement === document.body)) {
      (target.isConnected && !target.disabled ? target : section.value)?.focus({ preventScroll: true });
    }
  });
}
function approve(request) {
  if (!active.value || !shareReady.value || !pairingEnabled.value || approvingId.value
    || !pairingRequests.value.includes(request) || Number(request.expiresAt) <= Date.now()) return;
  notice.value = '';
  approvalFocusTarget = document.activeElement?.closest?.('#phone-pairing-requests') ? document.activeElement : null;
  approvingId.value = request.id;
  if (!sendWs({ type: 'approveDevicePairingRequest', requestId: request.id, confirmationCode: request.confirmationCode })) {
    approvingId.value = '';
    noticeError.value = true;
    notice.value = 'Could not reach FlightFabric. Check the connection and try again.';
    restoreApprovalFocus();
    return;
  }
  approvalTimer = setTimeout(() => {
    approvingId.value = '';
    noticeError.value = true;
    notice.value = 'Approval was not confirmed. Check the phone, then try again if needed.';
    restoreApprovalFocus();
  }, 10000);
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
onMounted(() => {
  unsubscribe = subscribeWsMessage((message = {}) => {
    if (!active.value) return;
    if (message.type === 'devicePairingRequests') {
      const focused = document.activeElement;
      const focusWasInRequests = focused?.closest?.('#phone-pairing-requests');
      pairingEnabled.value = message.enabled === true;
      pairingLoaded.value = true;
      pairingRequests.value = Array.isArray(message.requests) ? message.requests : [];
      if (focusWasInRequests) void nextTick(() => {
        if (active.value && !focused.isConnected && document.activeElement === document.body) section.value?.focus({ preventScroll: true });
      });
    } else if (message.type === 'devicePairingApprovalResult'
      && approvingId.value && message.requestId === approvingId.value) {
      clearTimeout(approvalTimer); approvalTimer = null;
      approvingId.value = '';
      noticeError.value = message.ok !== true;
      notice.value = message.ok === true
        ? 'Controls approved. Your device will open Aircraft controls.'
        : 'That code expired or changed. Request a new code on the device.';
      restoreApprovalFocus();
    }
  });
  refreshPairing();
});
watch(active, enabled => {
  retire();
  if (enabled) {
    refreshPairing();
    pollTimer = setInterval(refreshPairing, 2500);
  }
}, { immediate: true, flush: 'sync' });
onUnmounted(() => { retire(); unsubscribe?.(); });
</script>

<template>
  <section ref="section" id="settings-phone-tablet-access" data-settings-section tabindex="-1"
    class="settings-panel settings-panel--wide phone-setup" aria-labelledby="phone-setup-title">
    <div class="setup-test-heading">
      <SetupIllustration kind="phone" />
      <div>
        <h3 id="phone-setup-title" class="settings-panel-title">Connect a phone or tablet</h3>
        <p class="phone-setup-copy">Use your phone for cockpit controls and flight instruments.</p>
      </div>
    </div>
    <p class="phone-setup-copy">Keep both devices on the same private home network and FlightFabric running on your PC.</p>

    <details class="setup-details phone-setup-options" :open="host.remoteAccessEnabled !== true || networkChanged || needsRestart">
      <summary>{{ host.remoteAccessEnabled === true ? 'Connection settings' : 'Enable phone access' }}</summary>
      <label class="phone-setup-choice">
        <input form="settings-form" id="setting-remote-access" v-model="settings.remoteAccess" type="checkbox" />
        <span>Use FlightFabric on phones and tablets</span>
      </label>
      <label v-show="settings.remoteAccess" class="phone-setup-choice">
        <input form="settings-form" id="setting-remote-aircraft-control" v-model="settings.remoteAircraftControl" type="checkbox" />
        <span>Allow aircraft controls on paired devices</span>
      </label>
      <p class="phone-setup-copy">Use only on a private network you trust. Pairing grants aircraft controls, not access to your settings or recordings.</p>
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
    </details>

    <template v-if="shareReady">
      <div class="phone-setup-scan">
        <RemoteBrowserQr id="phone-setup-qr" :value="host.remoteBrowserUrl"
          :label="host.shareAircraftControlPaired ? 'Scan to connect this device with aircraft controls' : 'Scan to open FlightFabric in view-only mode'" />
        <div>
          <h4>Scan with your phone’s camera</h4>
          <p class="phone-setup-copy">{{ host.shareAircraftControlPaired ? 'Open the link to go straight to Aircraft controls.' : 'Open the link to view your flight.' }}</p>
          <p class="phone-setup-copy">No app to install.</p>
        </div>
      </div>
      <details class="setup-details">
        <summary data-phone-address-toggle>Enter an address instead</summary>
        <p class="phone-setup-copy">Open this address in your phone’s browser:</p>
        <p id="phone-setup-address" class="phone-setup-address">{{ host.remotePhoneEntryUrl }}</p>
        <button type="button" class="ff-button-secondary" data-phone-copy @click="copyAddress">{{ copied ? 'Address copied' : 'Copy address' }}</button>
        <p v-if="copyError" class="phone-setup-copy" role="status">{{ copyError }}</p>
        <p v-if="pairingEnabled" class="phone-setup-copy">On the phone, choose Request aircraft controls. Then approve the matching code here.</p>
      </details>
      <section v-if="pairingRequests.length || notice" id="phone-pairing-requests" class="phone-setup-requests" aria-label="Device approval">
        <h4 v-if="pairingRequests.length">Match the code on your device</h4>
        <p v-if="notice" class="phone-setup-copy" :class="noticeError ? 'text-warning' : 'text-success'" role="status">{{ notice }}</p>
        <div v-for="request in pairingRequests" :key="request.id" class="phone-setup-request">
          <div>
            <span class="phone-setup-code" :aria-label="`Pairing code ${String(request.confirmationCode).split('').join(' ')}`">{{ request.confirmationCode }}</span>
            <span class="phone-setup-copy">{{ Number(request.expiresAt) > now ? `Expires in ${Math.ceil((request.expiresAt - now) / 1000)}s` : 'Code expired' }}</span>
          </div>
          <button type="button" class="ff-button-primary" data-phone-approve
            :disabled="!!approvingId || !pairingEnabled || Number(request.expiresAt) <= now" @click="approve(request)">
            {{ approvingId === request.id ? 'Approving…' : 'Approve controls' }}
          </button>
        </div>
      </section>
      <details class="setup-details">
        <summary>Connection help</summary>
        <p class="phone-setup-copy">Bookmark this page. New flights appear automatically. After restarting FlightFabric, scan again or request a new code if access expires.</p>
        <p class="phone-setup-copy">Page won’t open? Use the same home network and allow FlightFabric through your firewall on private networks.</p>
        <p v-if="host.alternateIpsLabel" class="phone-setup-copy">Other network addresses: {{ host.alternateIpsLabel }}</p>
      </details>
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
.phone-setup-scan { display: flex; align-items: center; gap: 1.5rem; padding-block: 1.25rem; }
.phone-setup-scan :deep(#phone-setup-qr) { width: 12rem; height: 12rem; box-shadow: none; }
.phone-setup-address { overflow-wrap: anywhere; font-size: 1rem; margin-block: .75rem; color: rgb(var(--foreground)); }
.phone-setup-requests { padding: 1rem; margin-block: 1rem; border: 1px solid rgb(var(--primary) / .4); border-radius: .25rem; }
.phone-setup-request { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1rem; }
.phone-setup-code { display: block; font-family: var(--ff-font-mono); font-size: 1.75rem; letter-spacing: .15em; color: rgb(var(--primary)); }
.phone-setup :is(button, input):focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 3px; }
@media (max-width: 600px) {
  .phone-setup-scan { flex-direction: column; align-items: flex-start; gap: .75rem; }
  .phone-setup-request { flex-direction: column; align-items: flex-start; }
  .phone-setup-request button { width: 100%; }
}
</style>
