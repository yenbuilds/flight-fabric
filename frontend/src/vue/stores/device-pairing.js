import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { sendWs } from '../../../app-shared.js';
import { subscribeWsMessage } from '../../app/runtime-signals.js';
import { useProfilesStore } from './profiles.js';
import { useStatusStore } from './status.js';
import { useSystemHostStore } from './system-host.js';
import { useFeedbackStore } from './feedback.js';

// One connection-owned approval queue, shared by the app modal and Settings.
export const useDevicePairingStore = defineStore('devicePairing', () => {
  const profiles = useProfilesStore(), status = useStatusStore(), host = useSystemHostStore();
  const feedback = useFeedbackStore();
  const eligible = computed(() => profiles.authorizationScope === 'full-control'
    && status.websocket === 'ready' && host.remoteAccessEnabled === true);
  const enabled = ref(false), loaded = ref(false), open = ref(false), now = ref(Date.now());
  const requests = ref([]), displayed = ref([]), error = ref(''), approvingId = ref('');
  const pendingCount = computed(() => requests.value.filter(request => request.expiresAt > now.value).length);
  const dismissed = new Map();
  let connected = false, pollTimer = null, approvalTimer = null, attempt = null, sequence = 0;

  function finishAttempt() {
    clearTimeout(approvalTimer); approvalTimer = null; attempt = null; approvingId.value = '';
  }
  function retire() {
    clearInterval(pollTimer); pollTimer = null;
    finishAttempt(); dismissed.clear();
    enabled.value = false; loaded.value = false; open.value = false;
    requests.value = []; displayed.value = []; error.value = '';
  }
  function refresh() {
    if (!connected || !eligible.value) return;
    now.value = Date.now();
    for (const [id, expiry] of dismissed) if (expiry <= now.value) dismissed.delete(id);
    sendWs({ type: 'requestDevicePairingRequests' });
  }
  function dismiss() {
    for (const request of displayed.value) dismissed.set(request.id, request.expiresAt);
    open.value = false; displayed.value = []; error.value = '';
    // This retires UI ownership, not an approval already accepted by the server.
    finishAttempt();
  }
  function review() {
    if (!connected || !eligible.value || !enabled.value) return;
    const pending = requests.value.filter(request => request.expiresAt > Date.now());
    if (!pending.length) return;
    displayed.value = pending; error.value = ''; open.value = true;
  }
  function waiting(request) {
    return enabled.value && request.expiresAt > Date.now()
      && requests.value.some(current => current.id === request.id && current.confirmationCode === request.confirmationCode);
  }
  function canApprove(request) {
    return connected && eligible.value && open.value && !attempt
      && displayed.value.includes(request) && waiting(request);
  }
  function approve(request) {
    if (!canApprove(request)) return;
    const owner = { request, approvalId: `${Date.now()}-${++sequence}` };
    attempt = owner; approvingId.value = request.id; error.value = '';
    approvalTimer = setTimeout(() => {
      if (attempt !== owner) return;
      finishAttempt();
      error.value = 'Approval was not confirmed. Check the phone, then try again if needed.';
    }, 10000);
    if (!sendWs({ type: 'approveDevicePairingRequest', requestId: request.id,
      confirmationCode: request.confirmationCode, approvalId: owner.approvalId })) {
      finishAttempt(); error.value = 'Could not reach FlightFabric. Check the connection and try again.';
    }
  }
  function receive(message = {}) {
    if (!connected || !eligible.value) return;
    if (message.type === 'devicePairingRequests') {
      enabled.value = message.enabled === true; loaded.value = true; now.value = Date.now();
      if (!enabled.value) { dismiss(); requests.value = []; return; }
      requests.value = (Array.isArray(message.requests) ? message.requests : []).filter(request =>
        typeof request?.id === 'string' && /^\d{6}$/.test(request.confirmationCode)
        && Number.isFinite(request.expiresAt) && request.expiresAt > now.value).slice(0, 8);
      const unseen = requests.value.filter(request => !dismissed.has(request.id)
        && !displayed.value.some(current => current.id === request.id));
      if (unseen.length) {
        if (!open.value) error.value = '';
        // Append so an arriving request never replaces the code under a click.
        displayed.value = displayed.value.concat(unseen).slice(0, 8); open.value = true;
      }
    } else if (message.type === 'devicePairingApprovalResult' && attempt
      && message.requestId === attempt.request.id && message.approvalId === attempt.approvalId) {
      const request = attempt.request;
      finishAttempt();
      if (message.ok !== true) {
        error.value = 'That code expired or changed. Request a new code on the device.';
        refresh(); return;
      }
      dismissed.set(request.id, request.expiresAt);
      requests.value = requests.value.filter(current => current.id !== request.id);
      displayed.value = displayed.value.filter(current => current.id !== request.id);
      error.value = '';
      if (!displayed.value.length) open.value = false;
      feedback.showToast({ title: 'Controls approved', message: 'Your device can now open Aircraft controls.' });
    }
  }
  function connect() {
    if (connected) return () => {};
    connected = true;
    const unsubscribe = subscribeWsMessage(receive);
    const stop = watch(eligible, active => {
      retire();
      if (active) { refresh(); pollTimer = setInterval(refresh, 2500); }
    }, { immediate: true, flush: 'sync' });
    return () => { connected = false; stop(); unsubscribe(); retire(); };
  }
  return { enabled, loaded, open, now, requests, displayed, error, approvingId, pendingCount,
    connect, dismiss, review, waiting, canApprove, approve };
});
