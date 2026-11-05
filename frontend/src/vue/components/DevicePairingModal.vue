<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDevicePairingStore } from '../stores/device-pairing.js';
import SetupIllustration from './SetupIllustration.vue';

const pairing = useDevicePairingStore();
const dialog = ref(null), heading = ref(null);
let cleanup = null, disposed = false, focusRevision = 0;
onMounted(() => { cleanup = pairing.connect(); });
onBeforeUnmount(() => { disposed = true; focusRevision++; cleanup?.(); dialog.value?.close(); });
watch([() => pairing.open, dialog], async ([open, element]) => {
  const owner = ++focusRevision;
  if (!element) return;
  if (open) {
    if (!element.open) element.showModal();
    await nextTick();
    if (!disposed && owner === focusRevision && pairing.open) heading.value?.focus({ preventScroll: true });
  } else if (element.open) {
    element.close();
    // The Review requests trigger disappears after the final approval.
    // Preserve native focus restoration unless its target has gone away.
    if (document.activeElement === document.body || element.contains(document.activeElement)) {
      document.getElementById('vue-main-root')?.focus({ preventScroll: true });
    }
  }
}, { flush: 'post' });
// Approving one of several devices removes its button. Retain focus in the modal.
watch(() => pairing.displayed.map(request => request.id).join(','), async () => {
  const active = document.activeElement;
  const ownedFocus = dialog.value?.contains(active);
  await nextTick();
  if (!disposed && pairing.open && ownedFocus && !active.isConnected) heading.value?.focus({ preventScroll: true });
});
</script>

<template>
  <dialog ref="dialog" class="device-pairing-dialog" aria-labelledby="device-pairing-approval-title"
    aria-describedby="device-pairing-approval-description" data-device-pairing-modal
    @cancel.prevent="pairing.dismiss()" @keydown.stop>
    <header class="device-pairing-heading">
      <SetupIllustration kind="phone" />
      <div>
        <h2 id="device-pairing-approval-title" ref="heading" tabindex="-1">Allow aircraft controls?</h2>
        <p id="device-pairing-approval-description">A phone or tablet wants to control your aircraft. Approve only the code shown on your device.</p>
      </div>
    </header>
    <div v-for="request in pairing.displayed" :key="request.id" class="device-pairing-request">
      <p class="device-pairing-code" :aria-label="`Pairing code ${request.confirmationCode.split('').join(' ')}`">{{ request.confirmationCode }}</p>
      <p v-if="pairing.waiting(request)" class="device-pairing-note">Expires in {{ Math.max(0, Math.ceil((request.expiresAt - pairing.now) / 1000)) }}s</p>
      <p v-else class="device-pairing-note">This request expired or is no longer waiting. Request a new code on your device.</p>
      <button type="button" class="ff-button-primary" data-phone-approve
        :aria-disabled="!pairing.canApprove(request)" :aria-busy="pairing.approvingId === request.id" @click="pairing.approve(request)">
        {{ pairing.approvingId === request.id ? 'Approving…' : 'Approve controls' }}
      </button>
    </div>
    <p v-if="pairing.error" class="device-pairing-error" role="alert">{{ pairing.error }}</p>
    <footer>
      <p class="device-pairing-note">Closing leaves the request unapproved. You can review it again in Connect phone.</p>
      <button type="button" class="ff-button-secondary" data-pairing-close @click="pairing.dismiss()">Close</button>
    </footer>
  </dialog>
</template>

<style scoped>
.device-pairing-dialog { width: min(32rem, calc(100vw - 2rem)); max-height: calc(var(--ff-visual-viewport-height, 100dvh) - 2rem); margin: auto; padding: 1.5rem; overflow: auto; border: 1px solid rgb(var(--border)); border-radius: .5rem; color: rgb(var(--foreground)); background: rgb(var(--panel)); box-shadow: 0 1.5rem 4rem rgb(0 0 0 / .4); font-size: .875rem; line-height: 1.6; }
.device-pairing-dialog::backdrop { background: rgb(0 0 0 / .7); }
.device-pairing-heading { display: flex; align-items: flex-start; gap: 1rem; }
.device-pairing-heading :deep(svg) { width: 4.5rem; flex: none; color: rgb(var(--muted-foreground)); pointer-events: none; }
.device-pairing-heading h2 { font-size: 1.25rem; font-weight: 650; }
.device-pairing-heading p { margin-top: .5rem; color: rgb(var(--muted-foreground)); }
.device-pairing-request { margin-block: 1.25rem; padding-block: 1rem; border-block: 1px solid rgb(var(--border)); }
.device-pairing-code { font: 600 2rem var(--ff-font-mono); letter-spacing: .2em; color: rgb(var(--primary)); }
.device-pairing-note { margin-block: .65rem; font-size: .8125rem; color: rgb(var(--muted-foreground)); }
.device-pairing-error { color: rgb(var(--danger)); }
.device-pairing-dialog footer { display: flex; align-items: center; gap: 1rem; }
.device-pairing-dialog footer p { flex: 1; }
.device-pairing-dialog button { min-height: 2.75rem; }
.device-pairing-dialog [aria-disabled="true"] { opacity: .6; cursor: not-allowed; }
.device-pairing-dialog :focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 3px; }
@media (max-width: 600px) {
  .device-pairing-dialog { padding: 1rem; }
  .device-pairing-heading { flex-direction: column; gap: .5rem; }
  .device-pairing-dialog footer { flex-direction: column; align-items: stretch; gap: .5rem; }
}
</style>
