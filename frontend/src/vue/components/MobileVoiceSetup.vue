<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSystemHostStore } from '../stores/system-host.js';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useProfilesStore } from '../stores/profiles.js';
import { useTabsStore } from '../stores/tabs.js';
import { readStorageValue, writeStorageValue } from '../../app/browser-environment.js';
import SetupIllustration from './SetupIllustration.vue';

const props = defineProps({ phone: Boolean });
const host = useSystemHostStore(), voice = useVoiceControlStore();
const profiles = useProfilesStore(), tabs = useTabsStore();
const info = ref({ enabled: false, port: null, fingerprint: '' });
const busy = ref(false), error = ref(''), fresh = ref(false), guideOpen = ref(false);
const platform = ref(/android/i.test(navigator.userAgent) ? 'android' : 'iphone');
const step = ref(1), stepHeading = ref(null), title = ref(null), startButton = ref(null);
const steps = ['Download', 'Install and trust', 'Connect'];
const secure = window.location?.protocol === 'https:' && window.isSecureContext;
// This remembers the user's completed guide, not browser certificate verification
// or control authorization. Each HTTP origin and PC certificate has its own choice.
const guideKey = 'ff_phone_microphone_guide_v1';
const completedFingerprint = ref(props.phone ? readStorageValue(guideKey, { fallback: '' }) : '');
const remembered = computed(() => Boolean(info.value.fingerprint) && completedFingerprint.value === info.value.fingerprint);
const phoneUrl = computed(() => {
  if (!props.phone || !info.value.enabled || !Number.isInteger(info.value.port) || info.value.port < 1 || info.value.port > 65535) return '';
  const url = new URL(window.location.href);
  url.protocol = 'https:'; url.port = String(info.value.port); url.pathname = '/phone'; url.search = ''; url.hash = '';
  return url.href;
});
let disposed = false, request = null, guideRevision = 0;
watch(() => info.value.fingerprint, (value, previous) => { if (previous && value !== previous) step.value = 1; });
async function focusStep(owner = guideRevision) {
  await nextTick();
  if (disposed || !guideOpen.value || owner !== guideRevision) return;
  const target = stepHeading.value || title.value;
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: 'start', behavior: 'instant' });
}
async function goToStep(next) {
  guideRevision++;
  step.value = next;
  await focusStep();
}
function changePlatform() { guideRevision++; step.value = 1; }
async function refresh(action = '') {
  if (busy.value || disposed || (props.phone && action)) return false;
  busy.value = true; error.value = ''; fresh.value = false;
  const abort = new AbortController(); request = abort;
  const timer = setTimeout(() => abort.abort(), 15000);
  const cancelled = new Promise((_, reject) => abort.signal.addEventListener('abort',
    () => reject(new DOMException('Phone setup cancelled', 'AbortError')), { once: true }));
  try {
    let base = '', headers = {};
    if (!props.phone) {
      const result = await Promise.race([window.electronAPI?.getBackendBootstrap?.(), cancelled]);
      if (disposed || request !== abort || abort.signal.aborted) return false;
      const token = (result?.body || result)?.wsAuthToken;
      if (!token) throw new Error('Reconnect FlightFabric on your PC, then try again.');
      base = `http://127.0.0.1:${host.backendHttpPort || host.networkInfo?.httpPort || 8100}`;
      headers = { 'X-FlightFabric-Token': token };
    }
    const response = await Promise.race([fetch(`${base}/api/mobile-voice`, {
      method: action ? 'POST' : 'GET', signal: abort.signal, cache: 'no-store',
      headers, ...(action ? { body: action } : {}),
    }), cancelled]);
    const next = await Promise.race([response.json(), cancelled]);
    if (disposed || request !== abort || abort.signal.aborted) return false;
    if (!response.ok) throw new Error('Phone microphone access could not be saved or updated. Please try again.');
    if (!next || typeof next.enabled !== 'boolean' || (props.phone && next.enabled
      && (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535
        || typeof next.fingerprint !== 'string' || !next.fingerprint || next.fingerprint.length > 128))) {
      throw new Error('Phone connection details are not ready. Check FlightFabric on your PC and try again.');
    }
    info.value = next; fresh.value = true;
    if (!props.phone && next.error) error.value = 'Phone microphone access could not start. Try enabling it again below.';
    return true;
  } catch (failure) {
    if (!disposed && request === abort) error.value = failure.name === 'AbortError'
      ? 'Phone setup did not respond. Check the connection and try again.' : failure.message;
    return false;
  } finally {
    clearTimeout(timer);
    if (request === abort) { request = null; busy.value = false; }
    if (action) window.dispatchEvent(new Event('flightfabric:mobile-voice-changed'));
  }
}
async function startSetup() {
  if (!props.phone || secure || disposed || busy.value) return;
  const owner = ++guideRevision;
  guideOpen.value = true;
  const loaded = await refresh();
  if (disposed || !guideOpen.value || owner !== guideRevision) return;
  if (loaded) step.value = remembered.value ? 3 : 1;
  await focusStep();
}
async function closeGuide() {
  const owner = ++guideRevision;
  guideOpen.value = false;
  const old = request; request = null; old?.abort(); busy.value = false; fresh.value = false;
  await nextTick();
  if (!disposed && !guideOpen.value && owner === guideRevision) startButton.value?.focus();
}
function connectPhone() {
  if (disposed || !guideOpen.value || busy.value || !fresh.value || !phoneUrl.value || !info.value.fingerprint) return;
  writeStorageValue(guideKey, info.value.fingerprint);
  completedFingerprint.value = info.value.fingerprint;
  window.location.assign(phoneUrl.value);
}
const resume = () => { if (props.phone && guideOpen.value && !document.hidden) void refresh(); };
onMounted(() => {
  if (!props.phone) void refresh();
  else {
    window.addEventListener('flightfabric:phone-microphone-setup', startSetup);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
  }
});
onBeforeUnmount(() => {
  disposed = true; request?.abort();
  window.removeEventListener('flightfabric:phone-microphone-setup', startSetup);
  window.removeEventListener('pageshow', resume);
  document.removeEventListener('visibilitychange', resume);
});
</script>

<template>
  <section v-if="phone || host.isElectron" class="phone-voice-setup" :class="{ 'phone-voice-setup--phone': phone, 'phone-voice-setup--desktop': !phone }" aria-labelledby="phone-microphone-title" data-mobile-voice-setup>
    <header class="voice-guide-intro">
      <SetupIllustration v-if="!phone || guideOpen" :kind="phone ? 'touch' : 'phone-microphone'" />
      <div>
        <component :is="phone ? 'h2' : 'h4'" id="phone-microphone-title" ref="title" tabindex="-1">{{ phone ? 'Phone microphone' : 'Use your phone as a microphone' }}</component>
        <p v-if="!phone">Hold to talk on your phone and give aircraft commands. No microphone needed on your PC.</p>
        <p v-else-if="secure">This page supports both aircraft controls and your microphone.</p>
        <p v-else>Use this phone to speak commands. Your PC does not need a microphone.</p>
      </div>
    </header>
    <div v-if="!phone" class="voice-guide-desktop-controls">
      <p v-if="!voice.runtime.enabled" class="voice-guide-warning">Enable Voice control in Settings before speaking a command.</p>
      <!-- Keep focus during the request; refresh owns the synchronous busy guard. -->
      <button type="button" :class="info.enabled ? 'ff-button-secondary' : 'ff-button-primary'" data-phone-voice-access :aria-disabled="busy" :aria-busy="busy" @click="refresh(info.enabled ? 'disable' : 'enable')">
        {{ busy ? 'Updating phone connection…' : info.enabled ? 'Turn off phone microphone' : 'Enable phone microphone' }}
      </button>
      <template v-if="info.enabled && fresh">
        <div role="status" class="voice-guide-next" data-phone-voice-desktop-next>
          <p class="voice-guide-ready"><strong>Access enabled. Continue on your phone.</strong></p>
          <p>Scan this QR, or use the phone page you already opened. Tap <strong>Enable microphone</strong> to follow the one-time setup.</p>
        </div>
        <div class="voice-guide-fingerprint">
          <p><strong>Certificate fingerprint for this PC</strong></p>
          <p class="voice-guide-note">Check that your phone shows this same fingerprint before trusting the certificate.</p>
          <p class="voice-guide-address voice-guide-hash">{{ info.fingerprint }}</p>
        </div>
        <p class="voice-guide-note">Stays enabled after restarting FlightFabric. You can turn it off here at any time. Your phone keeps its certificate. Phone audio is not saved.</p>
      </template>
      <p v-else-if="!busy && !error" class="voice-guide-note">Enable once, then finish setup on your phone. FlightFabric remembers your choice.</p>
    </div>
    <template v-else-if="secure">
      <p v-if="profiles.authorizationScope !== 'aircraft-control'" class="voice-guide-note">Request aircraft controls above and approve the matching code on your PC before speaking commands.</p>
      <button v-else type="button" class="ff-button-primary" data-phone-voice-open @click="voice.openPanel(tabs)">Voice commands</button>
    </template>
    <template v-else>
      <button v-if="!guideOpen" ref="startButton" type="button" class="ff-button-primary" data-phone-voice-start @click="startSetup">{{ completedFingerprint ? 'Use microphone' : 'Enable microphone' }}</button>
      <template v-else>
        <button type="button" class="ff-button-secondary" data-phone-voice-close @click="closeGuide">Back to controls</button>
        <p v-if="busy" role="status">Checking the phone connection…</p>
        <p v-else-if="!info.enabled && !error" class="voice-guide-note">On your PC, open Connect phone and enable phone microphone access. Then tap Try again here. You can still use this page for normal controls.</p>
      </template>
    </template>
    <p v-if="error" role="alert" class="voice-guide-error">{{ error }}</p>
    <button v-if="error || (phone && guideOpen && !info.enabled && !busy)" type="button" class="ff-button-secondary" data-phone-voice-retry :disabled="busy" @click="phone ? startSetup() : refresh()">Try again</button>
    <div v-if="phone && guideOpen && info.enabled && phoneUrl" class="voice-guide">
      <fieldset class="voice-guide-platform">
        <legend>Your phone</legend>
        <label><input v-model="platform" type="radio" name="phone-voice-platform" value="iphone" @change="changePlatform"> iPhone · Safari</label>
        <label><input v-model="platform" type="radio" name="phone-voice-platform" value="android" @change="changePlatform"> Android · Chrome</label>
      </fieldset>
      <ol class="voice-guide-progress" aria-label="Phone microphone setup progress">
        <li v-for="(label, index) in steps" :key="label" :aria-current="step === index + 1 ? 'step' : undefined" :class="{ 'is-current': step === index + 1 }">
          <span aria-hidden="true">{{ index + 1 }}</span>{{ label }}
        </li>
      </ol>
      <div class="voice-guide-stage" :data-phone-voice-step="step">
        <h5 ref="stepHeading" tabindex="-1">{{ step }}. {{ step === 1 ? 'Download this PC’s certificate' : step === 2 ? (platform === 'iphone' ? 'Install it, then turn on trust' : 'Install the PC certificate') : 'Open your microphone-ready page' }}</h5>
        <template v-if="step === 1">
          <p>A browser needs a trusted connection before it can use your microphone. Set this up once for this PC, then use the same Connect phone QR every time.</p>
          <a href="/mobile-voice/ca.cer" class="ff-button-secondary voice-guide-download" data-phone-voice-download>Download certificate</a>
          <p v-if="platform === 'iphone'">Tap <strong>Allow</strong> when Safari asks to download a configuration profile. Close the “Profile Downloaded” message, then return here.</p>
          <p v-else>Download <strong>FlightFabric-PC.cer</strong> in Chrome. Keep the file in Downloads for the next step.</p>
          <div class="voice-guide-actions">
            <button type="button" class="ff-button-primary" data-phone-voice-next @click="goToStep(2)">I’ve downloaded it →</button>
          </div>
          <button type="button" class="ff-button-ghost voice-guide-returning" data-phone-voice-returning @click="goToStep(3)">Already installed and trusted? Continue</button>
        </template>
        <template v-else-if="step === 2">
          <div class="voice-guide-install">
            <SetupIllustration kind="certificate" />
            <div>
              <p class="voice-guide-eyebrow">On your phone · Settings</p>
              <ol v-if="platform === 'iphone'" class="voice-guide-instructions">
                <li>Open <strong>Settings → General → VPN &amp; Device Management</strong>.</li>
                <li>Open the downloaded <strong>FlightFabric PC</strong> profile. Check the certificate details against the fingerprint below, then tap <strong>Install</strong>. Enter your phone passcode if asked.</li>
              </ol>
              <ol v-else class="voice-guide-instructions">
                <li>In <strong>Settings</strong>, search for <strong>Install a certificate</strong>, then choose <strong>CA certificate</strong>. Menu names vary by phone.</li>
                <li>Select <strong>FlightFabric-PC.cer</strong> from Downloads. Check the certificate details against the fingerprint below, then confirm installation. Enter your phone PIN if asked.</li>
              </ol>
            </div>
          </div>
          <div class="voice-guide-fingerprint">
            <p><strong>Check that this is your PC’s certificate</strong></p>
            <p class="voice-guide-note">Compare the certificate’s SHA-256 fingerprint on your phone with this one before trusting it:</p>
            <p class="voice-guide-address voice-guide-hash">{{ info.fingerprint }}</p>
          </div>
          <div v-if="platform === 'iphone'" class="voice-guide-trust">
            <div class="voice-guide-trust-drawing" aria-hidden="true">
              <SetupIllustration kind="trust" />
              <span>Full trust: ON</span>
            </div>
            <div>
              <h6>Don’t miss this: turn on full trust</h6>
              <p>Installing the profile is only the first part.</p>
              <p>Go to <strong>Settings → General → About → Certificate Trust Settings</strong>.</p>
              <p>Under <strong>Enable full trust for root certificates</strong>, switch on your <strong>FlightFabric PC</strong> certificate and confirm.</p>
            </div>
          </div>
          <p class="voice-guide-note">Trust only the certificate matching your PC. You can remove it in the same phone settings when you stop using this feature.</p>
          <a v-if="platform === 'iphone'" href="https://support.apple.com/102390" target="_blank" rel="noopener noreferrer">Apple’s guide to the full-trust switch ↗</a>
          <a v-else href="https://support.google.com/pixelphone/answer/2844832" target="_blank" rel="noopener noreferrer">Google’s certificate settings guide ↗</a>
          <div class="voice-guide-actions">
            <button type="button" class="ff-button-secondary" data-phone-voice-back @click="goToStep(1)">Back</button>
            <button type="button" class="ff-button-primary" data-phone-voice-next @click="goToStep(3)">I’ve installed and trusted it →</button>
          </div>
        </template>
        <template v-else>
          <p>Open the connection for controls and voice. No need to scan another code.</p>
          <button type="button" class="ff-button-primary" data-phone-voice-connect :disabled="busy || !fresh || !!error" @click="connectPhone">Open microphone</button>
          <p class="voice-guide-note">On the page that opens, request aircraft controls and approve the matching code on your PC. Then tap Voice commands and hold to talk.</p>
          <p class="voice-guide-note">Allow microphone access when asked. Keep the page open while speaking.</p>
          <details class="setup-details voice-guide-help">
            <summary>Connection help</summary>
            <p>If you see a certificate warning, come back here and review the install and trust steps. On iPhone, make sure full trust is switched on.</p>
            <p>If the page times out, check the home network and enable phone microphone access in Connect phone on your PC.</p>
          </details>
          <div class="voice-guide-actions">
            <button type="button" class="ff-button-secondary" data-phone-voice-back @click="goToStep(2)">Review certificate setup</button>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.phone-voice-setup { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid rgb(var(--border)); color: rgb(var(--foreground)); font-size: .875rem; line-height: 1.6; }
.phone-voice-setup--phone { margin: 0 0 1rem; padding: 1rem; border: 1px solid rgb(var(--border)); border-radius: .5rem; background: rgb(var(--panel)); }
.phone-voice-setup--desktop { margin-top: 1.25rem; padding-top: 1.25rem; }
.phone-voice-setup p { margin: .5rem 0; }
.phone-voice-setup :is(h2, h4) { font-size: 1.125rem; font-weight: 650; scroll-margin-top: 6rem; }
.phone-voice-setup :is(h5, h6) { color: rgb(var(--foreground)); font-weight: 650; }
.phone-voice-setup h5 { font-size: 1.125rem; margin-bottom: 1rem; scroll-margin-top: 10rem; }
.phone-voice-setup h6 { font-size: 1rem; }
.phone-voice-setup a { color: rgb(var(--primary)); text-decoration: underline; text-underline-offset: .2em; }
.phone-voice-setup :is(button, summary, select, input, a, h5, h4, h2):focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 4px; }
.phone-voice-setup button { min-height: 2.75rem; white-space: normal; height: auto; text-align: center; }
.phone-voice-setup [data-phone-voice-access][aria-disabled="true"] { opacity: .65; cursor: wait; }
.voice-guide-download { display: inline-flex; align-items: center; min-height: 2.75rem; }
.voice-guide-intro { display: flex; align-items: center; gap: 1rem; }
.voice-guide-intro :deep(svg) { width: 5.5rem; height: 4.5rem; flex: none; color: rgb(var(--muted-foreground)); }
.voice-guide-intro > div { min-width: 0; }
.phone-voice-setup--desktop .voice-guide-intro { align-items: flex-start; }
.phone-voice-setup--desktop .voice-guide-intro :deep(svg) { width: 4.5rem; height: auto; pointer-events: none; }
.voice-guide-desktop-controls { margin-left: 5.5rem; }
.voice-guide-next { margin-top: 1rem; }
.voice-guide-ready { color: rgb(var(--primary)); }
.voice-guide-intro p, .voice-guide-reason, .voice-guide-note { color: rgb(var(--muted-foreground)); }
.phone-voice-setup .voice-guide-reason { margin-block: 1rem; max-width: 48rem; }
.voice-guide-note { font-size: .8125rem; }
.voice-guide-warning { color: rgb(var(--warning)); }
.voice-guide-error { color: rgb(var(--danger)); }
.voice-guide { margin-top: 1.5rem; max-width: 52rem; }
.voice-guide-platform { display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; padding: 0; margin: 0 0 1rem; min-width: 0; }
.voice-guide-platform legend { font-weight: 600; padding: 0; margin-bottom: .25rem; }
.voice-guide-platform label { display: flex; align-items: center; gap: .5rem; min-height: 2.75rem; cursor: pointer; }
.voice-guide-platform input { width: 1.1rem; height: 1.1rem; accent-color: rgb(var(--primary)); }
.voice-guide-progress { display: grid; grid-template-columns: 1fr 1.5fr 1fr; list-style: none; gap: .5rem; padding: 0; margin: 0 0 1.5rem; }
.voice-guide-progress li { display: flex; align-items: center; gap: .5rem; padding-block: .75rem; border-bottom: 2px solid rgb(var(--border)); color: rgb(var(--muted-foreground)); font-size: .8125rem; }
.voice-guide-progress span { display: grid; place-items: center; width: 1.5rem; height: 1.5rem; flex: none; border: 1px solid currentColor; border-radius: 50%; font-size: .75rem; }
.voice-guide-progress .is-current { border-color: rgb(var(--primary)); color: rgb(var(--foreground)); font-weight: 650; }
.voice-guide-progress .is-current span { background: rgb(var(--primary)); border-color: rgb(var(--primary)); color: rgb(var(--background)); }
.voice-guide-stage { max-width: 52rem; }
.voice-guide-eyebrow { color: rgb(var(--muted-foreground)); font-size: .75rem; font-weight: 600; letter-spacing: .04em; }
.voice-guide-address { overflow-wrap: anywhere; }
.voice-guide-install { display: flex; align-items: flex-start; gap: 1rem; }
.voice-guide-install :deep(svg) { width: 4.5rem; height: 4rem; flex: none; color: rgb(var(--muted-foreground)); }
.voice-guide-instructions { padding-left: 1.25rem; list-style: decimal; }
.voice-guide-instructions li { padding-left: .25rem; margin-block: .5rem; }
.voice-guide-fingerprint { margin-block: 1rem; padding-block: .75rem; border-block: 1px solid rgb(var(--border)); }
.voice-guide-hash { font-family: var(--ff-font-mono); font-size: .75rem; user-select: all; }
.voice-guide-trust { display: flex; align-items: center; gap: 1.25rem; padding: 1rem; margin-block: 1rem; background: rgb(var(--warning) / .07); border: 1px solid rgb(var(--warning) / .4); border-radius: .5rem; }
.voice-guide-trust-drawing { width: 6.5rem; flex: none; color: rgb(var(--muted-foreground)); text-align: center; font-size: .6875rem; }
.voice-guide-trust-drawing :deep(svg) { width: 100%; height: 5rem; }
.voice-guide :deep(.setup-illustration-accent), .voice-guide-intro :deep(.setup-illustration-accent) { stroke: rgb(var(--primary)); }
.voice-guide-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-top: 1.25rem; }
.phone-voice-setup .voice-guide-returning { display: block; margin-top: .75rem; text-align: left; font-size: .8125rem; color: rgb(var(--muted-foreground)); }
.voice-guide-help { margin-top: 1rem; }
.phone-voice-setup .setup-details { margin-block: 1rem; }
@media (max-width: 600px) {
  .voice-guide-progress li { flex-direction: column; align-items: flex-start; gap: .5rem; font-size: .75rem; }
  .voice-guide-intro { align-items: flex-start; gap: .75rem; }
  .voice-guide-intro :deep(svg) { width: 3.5rem; height: 3rem; }
  .phone-voice-setup--desktop .voice-guide-intro { flex-direction: column; gap: .5rem; }
  .phone-voice-setup--desktop .voice-guide-intro :deep(svg) { width: 3.5rem; }
  .voice-guide-desktop-controls { margin-left: 0; }
  .voice-guide-install { gap: .5rem; }
  .voice-guide-install :deep(svg) { width: 2.75rem; height: 3rem; }
  .voice-guide-trust { flex-direction: column; align-items: flex-start; gap: .5rem; }
  .voice-guide-trust-drawing { align-self: center; }
  .voice-guide-actions > button { width: 100%; }
}
</style>
