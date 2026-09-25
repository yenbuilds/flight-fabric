<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  family: { type: String, required: true },
  profileKey: { type: String, default: '' },
  sdkConnected: { type: Boolean, default: false },
});
const result = ref(null), checking = ref(false), opening = ref(false), choosing = ref(false);
const feedback = ref(''), loadError = ref(''), expanded = ref(false);
const selectedId = ref(''), includeCdu = ref(false), editRequested = ref(false);
const copied = ref(false), copying = ref(false), copyFeedback = ref('');
const checkButton = ref(null), panel = ref(null);
let generation = 0, copyGeneration = 0, checkOnReturn = false, allowAutoExpand = true;
const desktop = () => window.electronAPI?.pmdgSdk;
const canInspect = computed(() => typeof desktop()?.getStatus === 'function');
const busy = computed(() => checking.value || opening.value || choosing.value);
const local = computed(() => canInspect.value && result.value?.supported !== false);
const files = computed(() => result.value?.files || []);
const selected = computed(() => files.value.find(file => file.id === selectedId.value));
const filename = computed(() => selected.value?.filename || (props.family === 'pmdg-737' ? '737_Options.ini' : '777_Options.ini'));
const labels = { enabled: 'Enabled', disabled: 'Disabled', missing: 'Not set', unknown: 'Unable to verify' };
const state = computed(() => {
  if (props.sdkConnected) return 'connected';
  if (checking.value && !result.value) return 'checking';
  if (loadError.value && !result.value) return 'error';
  if (!local.value) return 'remote';
  if (files.value.length > 1 && !selected.value) return 'choose';
  if (!selected.value) return 'not-found';
  if (selected.value.settings.data === 'enabled') return 'configured';
  return ['disabled', 'missing'].includes(selected.value.settings.data) ? 'setup' : 'unknown';
});
const summary = computed(() => ({
  connected: 'Connected', checking: 'Checking setup…', error: 'Could not check', remote: 'Setup help',
  choose: 'Choose your simulator', 'not-found': 'File not found', configured: 'Enabled · waiting for aircraft',
  setup: 'Setup needed', unknown: 'Check settings',
}[state.value]));
const cduNeedsSetup = computed(() => selected.value && ['cduLeft', 'cduRight'].some(key => selected.value.settings[key] !== 'enabled'));
const showSteps = computed(() => editRequested.value || (includeCdu.value && cduNeedsSetup.value) || ['setup', 'unknown', 'remote'].includes(state.value));
const snippet = computed(() => [
  ...(selected.value?.settings.section === 'present' ? [] : ['[SDK]']),
  'EnableDataBroadcast=1',
  ...(includeCdu.value ? ['EnableCDUBroadcast.0=1', 'EnableCDUBroadcast.1=1'] : []),
].join('\r\n') + '\r\n\r\n');

async function check({ initial = false } = {}) {
  if (!canInspect.value || busy.value) return;
  const current = ++generation;
  checking.value = true;
  loadError.value = '';
  feedback.value = '';
  try {
    const next = await desktop().getStatus(props.family, props.profileKey?.split('/').at(-1) || '');
    if (current !== generation) return;
    const previousFocus = document.activeElement;
    const focusedInPanel = panel.value?.contains(previousFocus);
    result.value = next;
    if (!next.files.some(file => file.id === selectedId.value)) selectedId.value = next.files.length === 1 ? next.files[0].id : '';
    if (!initial && selected.value?.settings.data === 'enabled' && (!includeCdu.value || !cduNeedsSetup.value)) editRequested.value = false;
    if (initial && allowAutoExpand && !props.sdkConnected && ['setup', 'unknown', 'not-found', 'choose'].includes(state.value)) expanded.value = true;
    if (!initial) feedback.value = selected.value?.settings.data === 'enabled' ? 'Data broadcast is enabled.'
      : ['disabled', 'missing'].includes(selected.value?.settings.data) ? 'Data broadcast still needs to be enabled.' : 'Settings checked.';
    await nextTick();
    if (current === generation && focusedInPanel && !previousFocus.isConnected && document.activeElement === document.body) checkButton.value?.focus({ preventScroll: true });
  } catch {
    if (current !== generation) return;
    loadError.value = result.value ? 'Could not refresh. The previous results are still shown.' : 'Could not check the options file. Try again or use the manual steps.';
    if (initial && allowAutoExpand && !props.sdkConnected) expanded.value = true;
  } finally { if (current === generation) checking.value = false; }
}
async function reveal() {
  if (!selected.value?.canReveal || busy.value) return;
  const current = generation;
  opening.value = true;
  feedback.value = '';
  try {
    const response = await desktop().revealFile(props.family, selected.value.id);
    if (current !== generation) return;
    checkOnReturn = response.success;
    feedback.value = response.success ? 'Folder requested in Explorer. Settings will be checked when you return.' : response.error;
  } catch {
    if (current === generation) feedback.value = 'Could not open the folder. Check again or use the file location below.';
  } finally { if (current === generation) opening.value = false; }
}
async function chooseFile() {
  if (busy.value || typeof desktop()?.chooseFile !== 'function') return;
  const current = ++generation;
  choosing.value = true;
  feedback.value = '';
  loadError.value = '';
  checkOnReturn = false;
  try {
    const response = await desktop().chooseFile(props.family, props.profileKey?.split('/').at(-1) || '');
    if (current !== generation || response.canceled) return;
    if (!response.success) { feedback.value = response.error || 'Could not verify that file. Try again.'; return; }
    const file = response.file;
    result.value = { supported: true, files: [...files.value.filter(item => item.path !== file.path
      && !(item.id.startsWith('selected:') && item.profileId === file.profileId)), file] };
    selectedId.value = file.id;
    loadError.value = '';
    feedback.value = 'File checked. This selection is remembered until you close FlightFabric.';
  } catch {
    if (current === generation) feedback.value = 'Could not select a file. Try again or use the manual locations below.';
  } finally { if (current === generation) choosing.value = false; }
}
function recheckOnReturn() {
  if (!checkOnReturn || busy.value || document.visibilityState !== 'visible') return;
  checkOnReturn = false;
  check();
}
async function copySettings() {
  if (copying.value) return;
  const current = ++copyGeneration, text = snippet.value;
  copying.value = true;
  copied.value = false;
  copyFeedback.value = '';
  try {
    await navigator.clipboard.writeText(text);
    if (current === copyGeneration) { copied.value = true; copyFeedback.value = 'Settings copied.'; }
  } catch {
    if (current === copyGeneration) copyFeedback.value = 'Copy is unavailable here. Select and copy the settings below.';
  } finally { if (current === copyGeneration) copying.value = false; }
}
function showInstructions() {
  includeCdu.value = Boolean(cduNeedsSetup.value && selected.value?.settings.data === 'enabled');
  editRequested.value = true;
}
watch([selectedId, snippet], () => { copyGeneration++; copied.value = copying.value = false; copyFeedback.value = ''; });
watch(() => [props.family, props.profileKey], () => {
  generation++;
  copyGeneration++;
  result.value = null;
  checking.value = opening.value = choosing.value = copying.value = expanded.value = editRequested.value = includeCdu.value = false;
  selectedId.value = feedback.value = loadError.value = '';
  checkOnReturn = false;
  allowAutoExpand = true;
  check({ initial: true });
}, { immediate: true });
onMounted(() => {
  window.addEventListener('focus', recheckOnReturn);
  document.addEventListener('visibilitychange', recheckOnReturn);
});
onBeforeUnmount(() => {
  generation++;
  copyGeneration++;
  window.removeEventListener('focus', recheckOnReturn);
  document.removeEventListener('visibilitychange', recheckOnReturn);
});
</script>

<template>
  <details ref="panel" class="pmdg-sdk-setup ff-card mb-4" :open="expanded" @toggle="expanded = $event.target.open" data-pmdg-sdk-setup>
    <summary class="pmdg-sdk-summary ff-touch-target" @click="allowAutoExpand = false">
      <strong>PMDG connection</strong><span :class="{ 'text-success': sdkConnected, 'text-warning': state === 'setup', 'text-muted-fg': !sdkConnected && state !== 'setup' }">{{ summary }}</span>
    </summary>
    <div class="pmdg-sdk-content">
      <p v-if="state === 'connected'">Live aircraft data is connected. No change is needed for aircraft controls.</p>
      <p v-else-if="state === 'configured'">Data broadcast is enabled. Restart MSFS if you just changed it, then load the aircraft.</p>
      <p v-else-if="state === 'setup'">Enable aircraft data once so FlightFabric can read this PMDG aircraft and use its controls.</p>
      <p v-else-if="state === 'unknown'">We couldn’t confirm this file’s settings. Check its <code>[SDK]</code> section using the steps below.</p>
      <p v-else-if="state === 'checking'" class="text-muted-fg">Looking for this aircraft’s options file…</p>
      <p v-if="!local" class="text-muted-fg">On the simulator PC, open FlightFabric’s Windows desktop app and go to Aircraft → PMDG connection to find the file automatically.</p>
      <p v-else-if="result && !files.length && sdkConnected" class="text-muted-fg">The options file wasn’t found in the known folders. Use the manual locations below if you want to change its settings.</p>
      <p v-else-if="result && !files.length" class="text-muted-fg">No options file found for this aircraft. Load it once, close MSFS, then check again. Use “Find the file manually” below for other locations.</p>
      <label v-if="files.length > 1" class="pmdg-sdk-choice">
        <span>Choose the file for the simulator you use</span>
        <select v-model="selectedId" class="ff-touch-target" :disabled="busy" @change="feedback = ''" data-pmdg-file-choice>
          <option disabled value="">Choose a file…</option>
          <option v-for="file in files" :key="file.id" :value="file.id">{{ file.label }} · {{ file.filename }}</option>
        </select>
      </label>
      <div v-if="selected" class="pmdg-sdk-file rounded-lg border border-border bg-panel p-3" :aria-busy="checking">
        <div class="pmdg-sdk-file-heading">
          <div><strong>{{ filename }}</strong><p class="text-muted-fg">{{ selected.label }}</p></div>
          <button v-if="selected.canReveal" type="button" class="ff-button-primary ff-touch-target" :aria-disabled="busy" @click="reveal" data-pmdg-open>{{ opening ? 'Opening…' : 'Open folder' }}</button>
        </div>
        <p>Data broadcast: <strong>{{ labels[selected.settings.data] || labels.unknown }}</strong></p>
        <p v-if="!selected.canReveal" class="text-muted-fg">This location couldn’t be verified automatically. Use “Choose options file” to locate it, or follow the manual steps below.</p>
        <details class="text-muted-fg">
          <summary class="ff-touch-target">File location</summary>
          <code class="pmdg-sdk-path">{{ selected.path }}</code>
        </details>
      </div>
      <div v-if="local" class="pmdg-sdk-actions">
        <button ref="checkButton" type="button" class="ff-button-secondary ff-touch-target" :aria-disabled="busy" @click="check()" data-pmdg-check>{{ checking ? 'Checking…' : 'Check again' }}</button>
        <button v-if="typeof desktop()?.chooseFile === 'function'" type="button" class="ff-button-secondary ff-touch-target" :aria-disabled="busy" @click="chooseFile" data-pmdg-choose>{{ choosing ? 'Choosing…' : 'Choose options file…' }}</button>
        <span class="text-muted-fg" role="status">{{ loadError || feedback }}</span>
      </div>
      <button v-if="!showSteps && state !== 'checking' && (selected || !files.length)" type="button" class="ff-button-secondary ff-touch-target pmdg-sdk-show-steps" @click="showInstructions">{{ cduNeedsSetup && selected?.settings.data === 'enabled' ? 'Set up CDU screens' : 'Show setup steps' }}</button>
      <ol v-if="showSteps" class="pmdg-sdk-steps">
        <li><strong>Close MSFS, then open the file in Notepad.</strong><p class="text-muted-fg">Use <code>{{ filename }}</code><template v-if="!selected && family === 'pmdg-737'"> (older versions: <code>737NG3_Options.ini</code>)</template>. Closing MSFS prevents it from overwriting your changes.</p></li>
        <li>
          <strong>{{ selected?.settings.section === 'missing' ? 'Add this section at the end of the file.' : 'Update the SDK settings.' }}</strong>
          <p v-if="selected?.settings.section === 'present'" class="text-muted-fg">In the existing <code>[SDK]</code> section, replace or add these entries once. Keep any other settings.</p>
          <p v-else-if="selected?.settings.section !== 'missing'" class="text-muted-fg">Update the existing <code>[SDK]</code> section, or add it if absent. Keep only one section and one of each entry.</p>
          <label class="pmdg-sdk-cdu ff-touch-target"><input v-model="includeCdu" type="checkbox" /> Include remote CDU screens <span class="text-muted-fg">(optional)</span></label>
          <p v-if="includeCdu && selected" class="text-muted-fg">CDU screens — Captain: {{ labels[selected.settings.cduLeft] || labels.unknown }}; First officer: {{ labels[selected.settings.cduRight] || labels.unknown }}</p>
          <div class="pmdg-sdk-code rounded-lg border border-border bg-panel">
            <button type="button" class="ff-button-secondary ff-touch-target" :aria-disabled="copying" @click="copySettings" data-pmdg-copy>{{ copied ? 'Copied' : copying ? 'Copying…' : 'Copy settings' }}</button>
            <pre tabindex="0" aria-label="PMDG settings to copy"><code>{{ snippet.trimEnd() }}</code></pre>
          </div>
          <p v-if="copyFeedback" class="text-muted-fg" role="status">{{ copyFeedback }}</p>
        </li>
        <li><strong>Save, then restart MSFS and load the aircraft.</strong><p class="text-muted-fg">Keep the <code>.ini</code> extension and a blank line at the end. FlightFabric will show “Connected” when live data arrives.</p></li>
      </ol>
      <details class="pmdg-sdk-manual text-muted-fg">
        <summary class="ff-touch-target">Find the file manually</summary>
        <p>For Steam, start at <code>%APPDATA%\Microsoft Flight Simulator 2024</code> or <code>%APPDATA%\Microsoft Flight Simulator</code>. For Microsoft Store, use <code>%LOCALAPPDATA%\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalState</code> (2024) or <code>%LOCALAPPDATA%\Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalState</code> (2020).</p>
        <p>In MSFS 2024, look under <code>WASM\MSFS2024\pmdg-aircraft-…\work</code> (or <code>WASM\MSFS2020</code> for a 2020 aircraft). In MSFS 2020, use <code>packages\pmdg-aircraft-…\work</code>.</p>
        <p>If Microsoft Store moved the data to another drive, the folder may be under <code>WpSystem</code> on that drive. Choose the options INI inside this aircraft’s <code>work</code> folder. FlightFabric only reads its settings.</p>
      </details>
    </div>
  </details>
</template>

<style scoped>
.pmdg-sdk-setup { min-width: 0; font-size: .875rem; }
.pmdg-sdk-setup .ff-touch-target { min-height: max(44px, var(--ff-touch-target)); }
.pmdg-sdk-summary { cursor: pointer; padding: .75rem 1rem; }
.pmdg-sdk-summary span { display: inline-block; margin-left: .75rem; }
.pmdg-sdk-content { display: grid; gap: .75rem; padding: 0 1rem .75rem; overflow-wrap: anywhere; }
.pmdg-sdk-file { display: grid; gap: .375rem; }
.pmdg-sdk-file-heading, .pmdg-sdk-actions { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.pmdg-sdk-file-heading > div { min-width: 0; }
.pmdg-sdk-actions { justify-content: start; }
.pmdg-sdk-actions [role="status"] { flex: 1 1 15rem; }
.pmdg-sdk-file button, .pmdg-sdk-actions button, .pmdg-sdk-code button, .pmdg-sdk-show-steps { padding: .5rem .875rem; }
.pmdg-sdk-setup button[aria-disabled="true"] { opacity: .6; cursor: wait; }
.pmdg-sdk-actions button { min-width: 7rem; }
.pmdg-sdk-show-steps { justify-self: start; }
.pmdg-sdk-path { display: block; padding-bottom: .5rem; }
.pmdg-sdk-steps { display: grid; gap: 1rem; list-style: decimal; padding-left: 1.25rem; }
.pmdg-sdk-steps li > p { margin-top: .25rem; }
.pmdg-sdk-cdu { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; cursor: pointer; margin-top: .25rem; }
.pmdg-sdk-cdu input { width: 1rem; height: 1rem; accent-color: rgb(var(--primary)); }
.pmdg-sdk-code { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: .5rem; padding: .5rem; margin-top: .5rem; }
.pmdg-sdk-code button { grid-column: 2; grid-row: 1; }
.pmdg-sdk-code pre { grid-column: 1; grid-row: 1; white-space: pre-wrap; overflow-wrap: anywhere; padding: .5rem; user-select: text; }
.pmdg-sdk-choice { display: grid; gap: .375rem; min-width: 0; }
.pmdg-sdk-choice select { width: 100%; min-width: 0; padding: .5rem; color: rgb(var(--foreground)); background: rgb(var(--panel)); border: 1px solid rgb(var(--border)); border-radius: .5rem; }
.pmdg-sdk-manual p { margin: .5rem 0; }
summary { cursor: pointer; }
:is(summary, pre, select, input):focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 2px; border-radius: .375rem; }
@media (max-width: 480px) {
  .pmdg-sdk-summary span { margin-left: .5rem; }
  .pmdg-sdk-code { grid-template-columns: minmax(0, 1fr); }
  .pmdg-sdk-code button { grid-column: 1; grid-row: 2; justify-self: start; }
}
</style>
