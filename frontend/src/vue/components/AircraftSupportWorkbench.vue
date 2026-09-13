<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAircraftWorkbenchStore } from '../stores/aircraft-workbench.js';
import { useAircraftSpecificStore } from '../stores/aircraft-specific.js';
import { useTabsStore } from '../stores/tabs.js';

const workbench = useAircraftWorkbenchStore();
const aircraft = useAircraftSpecificStore();
const tabs = useTabsStore();
const expanded = ref(false), chosenProfile = ref(''), chosenSession = ref(''), showNewSession = ref(false);
const seconds = ref(20), now = ref(Date.now());
const markerLabel = ref('Control operated');
const environment = ref({ title: '', aircraftVariant: '', aircraftVersion: '', simulatorVersion: '' });
const exportPending = ref(null), deletePending = ref(null);
const exportPanel = ref(null), deletePanel = ref(null), exportButton = ref(null), storageButton = ref(null);
const testCase = computed(() => workbench.selectedCase);
const draft = computed(() => testCase.value ? workbench.draftFor(testCase.value.id) : null);
const caseCaptures = computed(() => (workbench.session?.captures || []).filter(item => item.caseId === testCase.value?.id));
const matchingAircraft = computed(() => aircraft.activeProfileKey === workbench.report?.contract.profileKey);
const captureFields = computed(() => (testCase.value?.observationFields || []).filter(id => workbench.report?.contract.fields.some(field => field.id === id)));
const canRecord = computed(() => workbench.session && workbench.compatibility?.matches && !workbench.captureStatus.active);
const elapsed = computed(() => workbench.captureStatus.active ? Math.min(workbench.captureStatus.active.seconds,
  Math.max(0, Math.floor((now.value - Date.parse(workbench.captureStatus.active.startedAt)) / 1000))) : 0);
let timer = null, polling = false;

async function open() {
  expanded.value = true;
  await workbench.initialize();
  if (workbench.session) await workbench.refreshSession();
  chosenProfile.value ||= workbench.loadedAircraft?.profileKey || workbench.profiles[0]?.profileKey || '';
  if (!workbench.report && chosenProfile.value) await workbench.browse(chosenProfile.value);
  if (!timer) timer = setInterval(async () => {
    now.value = Date.now();
    if (polling || !workbench.captureStatus.active) return;
    polling = true;
    try { await workbench.pollCapture(); } finally { polling = false; }
  }, 1000);
}
async function browse() {
  await workbench.browse(chosenProfile.value);
  chosenSession.value = ''; showNewSession.value = false;
}
function prepareSession() {
  environment.value = { title: `${workbench.report.profileName} test`, aircraftVariant: workbench.loadedAircraft?.title || '',
    aircraftVersion: '', simulatorVersion: '' };
  showNewSession.value = true;
}
async function createSession() {
  await workbench.createSession({ profileKey: workbench.report.contract.profileKey, ...environment.value });
  if (!workbench.error) { showNewSession.value = false; chosenSession.value = workbench.session.id; }
}
async function resume() {
  if (!chosenSession.value) return;
  await workbench.openSession(chosenSession.value);
  if (!workbench.error) chosenProfile.value = workbench.report.contract.profileKey;
  showNewSession.value = false;
}
function exportJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function prepareExport() {
  exportPending.value = { value: workbench.session || workbench.report,
    filename: `aircraft-support-${workbench.session?.id || 'report'}.json` };
  await nextTick(); exportPanel.value?.focus();
}
function closeExport(download = false) {
  if (download && exportPending.value) exportJson(exportPending.value.value, exportPending.value.filename);
  exportPending.value = null; exportButton.value?.focus();
}
async function prepareDelete(file) {
  deletePending.value = file;
  await nextTick(); deletePanel.value?.focus();
}
async function deleteSavedFile() {
  if (await workbench.deleteFile(deletePending.value)) {
    deletePending.value = null;
    if (!workbench.session) chosenSession.value = '';
    await nextTick(); storageButton.value?.focus();
  }
}
function bytesLabel(bytes) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function valueLabel(value) { return value == null ? 'Unavailable' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function fresh(id) {
  const age = now.value - Date.parse(aircraft.valueUpdatedAt[id]);
  return matchingAircraft.value && aircraft.available && aircraft.sourceStatus === 'connected'
    && !aircraft.unavailable.includes(id) && Number.isFinite(age) && age >= 0 && age <= 2500;
}
function expected(item) {
  return item.expectedValue !== undefined ? valueLabel(item.expectedValue) : 'Matches the requested target';
}
function dateLabel(date) { return new Date(date).toLocaleString(); }
function protectDraft(event) {
  if (workbench.hasUnsaved) { event.preventDefault(); event.returnValue = ''; }
}
watch(expanded, value => {
  if (value) window.addEventListener('beforeunload', protectDraft);
});
onBeforeUnmount(() => { clearInterval(timer); window.removeEventListener('beforeunload', protectDraft); });
</script>

<template>
  <section class="aircraft-workbench" aria-labelledby="workbench-title" data-aircraft-workbench>
    <div class="wb-heading">
      <div><p class="wb-eyebrow">Aircraft testing</p><h3 id="workbench-title">Aircraft support workbench</h3>
        <p>Check controls, capture readings, and keep a record of what works with your aircraft.</p></div>
      <button v-if="!expanded" type="button" class="wb-primary" @click="open">Open workbench</button>
      <button v-else type="button" :disabled="workbench.captureStatus.active || workbench.hasUnsaved" @click="expanded = false">Collapse</button>
    </div>

    <div v-if="expanded" class="wb-body">
      <p class="wb-message" role="note">Captures only record readings. Operate controls yourself and check the cockpit before marking a test as passed.</p>
      <p class="wb-message wb-caution" role="note"><strong>Use a separate simulator test flight.</strong> Testing gear, brakes, electrical power, or flight controls can disrupt your flight. Operating a control changes the aircraft; stopping capture does not undo those changes.</p>
      <p v-if="workbench.error" class="wb-message wb-error" role="alert">{{ workbench.error }} <button type="button" :disabled="workbench.busy" @click="open">Reconnect</button></p>
      <p v-if="workbench.notice" class="wb-message wb-success" role="status">{{ workbench.notice }}</p>
      <p v-if="workbench.unreadableCount" class="wb-message wb-error">{{ workbench.unreadableCount }} saved session file(s) could not be read. Their files have been preserved.</p>

      <div class="wb-selectors">
        <label>Aircraft inventory<select v-model="chosenProfile" :disabled="workbench.busy || workbench.captureStatus.active || workbench.hasUnsaved" @change="browse">
          <option disabled value="">Select an aircraft</option><option v-for="profile in workbench.profiles" :key="profile.profileKey" :value="profile.profileKey">{{ profile.name }}</option>
        </select></label>
        <label>Saved sessions<select v-model="chosenSession" :disabled="workbench.busy || workbench.captureStatus.active || workbench.hasUnsaved" @change="resume">
          <option value="">Choose a session to resume</option><option v-for="saved in workbench.sessions" :key="saved.id" :value="saved.id">{{ saved.title }} · {{ dateLabel(saved.updatedAt) }}</option>
        </select></label>
      </div>
      <div v-if="workbench.report" class="wb-toolbar">
        <div><strong>{{ workbench.session?.title || workbench.report.profileName }}</strong><p>{{ workbench.report.counts.advertisedCommands }} commands · {{ workbench.report.counts.fields }} readings · {{ workbench.cases.length }} test cases</p></div>
        <button type="button" :disabled="workbench.busy || workbench.captureStatus.active || workbench.hasUnsaved" @click="prepareSession">New test session</button>
        <button ref="exportButton" type="button" :disabled="!!exportPending" @click="prepareExport">{{ workbench.session ? 'Export saved session' : 'Export inventory' }}</button>
      </div>
      <div v-if="exportPending" ref="exportPanel" class="wb-message wb-export" role="region" aria-labelledby="wb-export-title" tabindex="-1" @keydown.esc="closeExport()">
        <strong id="wb-export-title">Review before sharing</strong>
        <p>The JSON file contains aircraft integration details and, for a saved session, your notes, readings, and version information. Remove personal or sensitive information before sharing it with a forum, another person, or an AI service.</p>
        <p>This downloads a file to your PC. Nothing is uploaded automatically. Only saved results at the time you selected Export are included.</p>
        <p v-if="workbench.hasUnsaved">You have unsaved observations. Cancel and save them first if you want them included.</p>
        <div class="wb-actions"><button type="button" class="wb-primary" @click="closeExport(true)">Download JSON</button><button type="button" @click="closeExport()">Cancel export</button></div>
      </div>
      <p v-if="workbench.busy" role="status">Working…</p>

      <details v-if="workbench.storage" class="wb-details wb-storage">
        <summary>Manage saved files · {{ bytesLabel(workbench.storage.usedBytes) }} of {{ bytesLabel(workbench.storage.maxBytes) }}</summary>
        <p>Export sessions you want to keep before deleting them. Deleting a session removes its saved results and attached captures from this PC. Separate recovery files are listed individually. Files are never deleted automatically.</p>
        <p>Captures need 64 MB of free workbench storage for collection and saving. Files already saved above the limit remain available for review, export, and deletion.</p>
        <button ref="storageButton" type="button" :disabled="workbench.busy" @click="workbench.refreshStorage">Refresh saved files</button>
        <p v-if="!workbench.storage.files.length">No saved workbench files.</p>
        <div v-for="file in workbench.storage.files" :key="file.name" class="wb-storage-file">
          <div><strong>{{ file.title || (file.kind === 'recovery' ? 'Recovered capture' : file.kind === 'temporary' ? 'Temporary save file' : 'Unreadable session') }}</strong><p>{{ file.name }} · {{ bytesLabel(file.bytes) }}</p></div>
          <button type="button" :aria-label="`Delete ${file.title || file.name}`" :disabled="workbench.busy || workbench.captureStatus.busy || (file.sessionId === workbench.session?.id && workbench.hasUnsaved)" @click="prepareDelete(file)">Delete file</button>
        </div>
        <div v-if="deletePending" ref="deletePanel" class="wb-message wb-caution" role="region" aria-labelledby="wb-delete-title" tabindex="-1" @keydown.esc="deletePending = null">
          <strong id="wb-delete-title">Permanently delete this saved file?</strong>
          <p>{{ deletePending.title || deletePending.name }} · {{ bytesLabel(deletePending.bytes) }}</p>
          <p>This cannot be undone. Exported copies and other saved files will remain.</p>
          <div class="wb-actions"><button type="button" :disabled="workbench.busy || workbench.captureStatus.busy" @click="deleteSavedFile">Delete selected file</button><button type="button" :disabled="workbench.busy" @click="deletePending = null">Keep file</button></div>
        </div>
      </details>

      <form v-if="showNewSession" class="wb-new-session" @submit.prevent="createSession">
        <h4>Start a test session</h4><p>Record the exact installed versions. Flight Fabric’s app version and runtime fingerprint are recorded automatically.</p>
        <div class="wb-selectors">
          <label>Session name<input v-model="environment.title" required maxlength="120" /></label>
          <label>Exact aircraft variant<input v-model="environment.aircraftVariant" required maxlength="240" placeholder="e.g. PMDG 737-800 passenger" /></label>
          <label>Aircraft version / channel<input v-model="environment.aircraftVersion" required maxlength="240" placeholder="Installed version and Stable / Development" /></label>
          <label>Simulator version / build<input v-model="environment.simulatorVersion" required maxlength="240" placeholder="Full MSFS build number" /></label>
        </div><div class="wb-actions"><button type="submit" class="wb-primary" :disabled="workbench.busy">Create session</button><button type="button" @click="showNewSession = false">Cancel</button></div>
      </form>

      <template v-if="workbench.report">
        <div v-if="workbench.session" class="wb-session-meta">
          <span>{{ workbench.session.environment.aircraftVariant }}</span><span>Aircraft {{ workbench.session.environment.aircraftVersion }}</span>
          <span>Simulator {{ workbench.session.environment.simulatorVersion }}</span><span>Flight Fabric {{ workbench.session.build.appVersion }}</span>
        </div>
        <p v-if="workbench.session && !workbench.compatibility?.matches" class="wb-message wb-error">This session belongs to a different app build or integration. You can review and export it; start a new session to record more tests.</p>
        <div class="wb-status-row"><span :class="['wb-dot', { live: matchingAircraft && aircraft.available }]" />
          <span>{{ matchingAircraft ? aircraft.statusLabel : 'Load this aircraft in the simulator to capture its readings.' }}</span>
          <button v-if="workbench.session" type="button" :disabled="workbench.busy" @click="workbench.refreshSession">Refresh session</button>
        </div>
        <div v-if="workbench.session" class="wb-counts" aria-label="Test progress">
          <span v-for="(count, result) in workbench.counts" :key="result" :class="`wb-outcome-${result}`"><strong>{{ count }}</strong> {{ result === 'not-run' ? 'not run' : result }}</span>
        </div>
        <div class="wb-filters">
          <label>Find a test<input v-model="workbench.search" type="search" placeholder="Search controls or voice phrases" /></label>
          <label>System<select v-model="workbench.group"><option value="">All systems</option><option v-for="item in workbench.groups" :key="item">{{ item }}</option></select></label>
          <label>Result<select v-model="workbench.outcomeFilter"><option value="">All results</option><option value="not-run">Not run</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="blocked">Blocked</option></select></label>
        </div>
        <div v-if="workbench.cases.length" class="wb-workspace">
          <nav class="wb-case-list" aria-label="Aircraft test cases">
            <p>{{ workbench.filteredCases.length }} matching tests</p>
            <button v-for="item in workbench.filteredCases" :key="item.id" type="button" :aria-current="workbench.selectedCaseId === item.id ? 'true' : undefined"
              :disabled="!!workbench.captureStatus.active" @click="workbench.selectedCaseId = item.id">
              <span>{{ item.label }}</span><small>{{ item.group }} · {{ workbench.latestResults[item.id]?.result || 'not run' }}</small>
              <small v-if="workbench.cases.filter(candidate => candidate.actionId === item.actionId).length > 1">{{ item.transport }}</small>
            </button><p v-if="!workbench.filteredCases.length">No tests match these filters.</p>
          </nav>
          <article v-if="testCase" class="wb-test" :aria-label="testCase.label">
            <p class="wb-eyebrow">{{ testCase.group }}</p><h4>{{ testCase.label }}</h4>
            <ol><li v-for="step in testCase.steps" :key="step">{{ step }}</li></ol>
            <p v-if="testCase.voicePatterns.length"><strong>Voice examples:</strong> {{ testCase.voicePatterns.slice(0, 2).join(' · ') }}. Replace placeholders with the setting you are testing.</p>
            <div v-if="testCase.expectedReadbacks.length" class="wb-expectations"><strong>Expected readings</strong>
              <p v-for="(item, index) in testCase.expectedReadbacks" :key="index"><code>{{ item.fieldId }}</code>: {{ expected(item) }}</p>
            </div>
            <p v-else class="wb-message">This action has no automatic state confirmation. Record the visible cockpit response.</p>

            <div v-if="captureFields.length" class="wb-readings" aria-label="Live test readings">
              <div v-for="id in captureFields" :key="id"><code>{{ id }}</code><strong>{{ matchingAircraft ? valueLabel(aircraft.values[id]) : 'Unavailable' }}</strong><span :class="{ 'wb-fresh': fresh(id) }">{{ fresh(id) ? 'Fresh' : 'Unavailable or stale' }}</span></div>
            </div>
            <p v-else>No capture readings are published for this test. You can still record a manual observation.</p>

            <template v-if="workbench.session">
              <form class="wb-result-form" @submit.prevent="workbench.saveResult">
                <label>Starting aircraft state<textarea v-model="draft.startingState" maxlength="240" rows="2" placeholder="Describe power, switch position, and relevant aircraft conditions." :disabled="!canRecord || workbench.busy" /></label>
                <div class="wb-capture-controls">
                  <label>Capture length<select v-model.number="seconds" :disabled="!!workbench.captureStatus.active"><option :value="20">20 seconds</option><option :value="60">60 seconds</option><option :value="120">120 seconds</option></select></label>
                  <button v-if="!workbench.captureStatus.active" type="button" class="wb-primary" :disabled="!canRecord || workbench.busy || workbench.captureStatus.busy || !matchingAircraft || !aircraft.available || !captureFields.length || !draft.startingState.trim()" @click="workbench.startCapture(seconds)">Start capture</button>
                  <button v-else type="button" class="wb-primary" :disabled="workbench.busy" @click="workbench.stopCapture">Stop &amp; save capture</button>
                  <button type="button" @click="tabs.requestTabChange('autopilot')">Open aircraft controls</button>
                </div>
                <p v-if="workbench.captureStatus.active" role="status">Recording {{ elapsed }} / {{ workbench.captureStatus.active.seconds }} seconds. Keep the simulator unpaused. Capture continues if you change tabs.</p>
                <div v-if="workbench.captureStatus.active" class="wb-capture-controls"><label>Step description<input v-model="markerLabel" maxlength="240" /></label><button type="button" :disabled="workbench.busy || !markerLabel.trim()" @click="workbench.markStep(markerLabel)">Mark step</button><span>{{ workbench.captureStatus.active.markerCount }} marked</span></div>
                <p v-if="workbench.captureStatus.error" class="wb-message wb-error" role="alert">{{ workbench.captureStatus.error }}</p>
                <p class="wb-hint">Stop collection before pausing the simulator; ordinary pause may not be detected.</p>
                <label>Input or voice phrase used<input v-model="draft.inputUsed" maxlength="500" placeholder="e.g. beacon on, followed by beacon off" :disabled="!canRecord || workbench.busy" /></label>
                <label>Cockpit observation<textarea v-model="draft.cockpitObservation" maxlength="2000" rows="3" placeholder="What visibly happened? Include any mismatch, no response, or limitation." :disabled="!canRecord || workbench.busy" /></label>
                <div class="wb-selectors">
                  <label>Observed result<select v-model="draft.result" :disabled="!canRecord || workbench.busy"><option value="not-run">Not run</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="blocked">Blocked</option></select></label>
                  <label>Attach capture<select v-model="draft.captureId" :disabled="!canRecord || workbench.busy"><option value="">Manual observation only</option><option v-for="item in caseCaptures" :key="item.id" :value="item.id">{{ dateLabel(item.capture.startedAt) }} · {{ item.capture.complete ? 'collection complete' : 'partial collection' }}</option></select></label>
                </div>
                <div class="wb-actions"><button type="submit" class="wb-primary" :disabled="!canRecord || workbench.busy">Save test result</button><span v-if="workbench.hasUnsaved">Unsaved observations</span></div>
                <p class="wb-hint">Saving a result records your observation. It does not change public compatibility or aircraft verification labels.</p>
              </form>
              <details v-if="caseCaptures.length" class="wb-details"><summary>Saved captures ({{ caseCaptures.length }})</summary>
                <div v-for="item in caseCaptures" :key="item.id" class="wb-capture-summary"><strong>{{ dateLabel(item.capture.startedAt) }}</strong><p>{{ item.capture.complete ? 'Collection complete' : 'Partial collection' }} · {{ item.capture.endReason }}</p>
                  <p v-for="(reading, id) in item.capture.summary" :key="id"><code>{{ id }}</code>: {{ valueLabel(reading.firstFreshValue) }} → {{ valueLabel(reading.lastFreshValue) }} · {{ reading.transitions }} changes · {{ reading.lastQuality }}</p>
                  <p v-for="(marker, index) in item.capture.markers || []" :key="index">{{ dateLabel(marker.recordedAt) }} · {{ marker.label }}</p>
                </div>
              </details>
              <details v-if="workbench.session.attempts.some(item => item.caseId === testCase.id)" class="wb-details"><summary>Previous test attempts</summary>
                <div v-for="attempt in workbench.session.attempts.filter(item => item.caseId === testCase.id).slice().reverse()" :key="attempt.id"><strong>{{ attempt.result }} · {{ dateLabel(attempt.recordedAt) }}</strong><p>{{ attempt.cockpitObservation }}</p></div>
              </details>
            </template>
            <p v-else class="wb-message">Create a test session to capture readings and save your results.</p>
            <details class="wb-details"><summary>Test setup and integration details</summary><p>Check these prerequisites before testing. A route listed here does not prove it was selected during a manual test.</p><pre>{{ JSON.stringify({ action: testCase.actionId, route: testCase.routeId, input: testCase.input, preconditions: testCase.preconditions, guard: testCase.guard }, null, 2) }}</pre></details>
          </article>
        </div>
        <p v-else class="wb-message">This profile has no aircraft-specific action tests. Its implemented commands and readings are available in the inventory below.</p>
        <details class="wb-details"><summary>Full implementation inventory</summary><p>Implementation availability assumes all supported connections. These are not live test results.</p>
          <h4>Commands</h4><div v-for="command in workbench.report.contract.commands" :key="command.id" class="wb-inventory-row"><code>{{ command.id }}</code><span>{{ command.supported ? 'Implemented' : 'Unavailable' }}</span><p>{{ command.speech?.patterns?.join(' · ') }}</p></div>
          <h4>Readings</h4><p v-for="field in workbench.report.contract.fields" :key="field.id"><code>{{ field.id }}</code></p>
        </details>
        <p class="wb-hint">Sessions are saved in Flight Fabric’s app data under Aircraft Support. JSON exports include test notes, readings, and integration details for you or an AI assistant to review. Export includes saved results; save observations first.</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.aircraft-workbench { border: 1px solid #334155; border-radius: 14px; background: #111b29; color: #dbe4ef; overflow: hidden; font-size: 13px; line-height: 1.55; }
.wb-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 22px; }
.wb-heading h3 { font-size: 19px; font-weight: 650; margin: 2px 0 5px; color: #f1f5f9; }
.wb-heading p, .wb-toolbar p { margin: 0; color: #a5b4c8; }
.wb-eyebrow { color: #67d7e7 !important; text-transform: uppercase; letter-spacing: .12em; font-size: 10px; font-weight: 650; }
.wb-body { border-top: 1px solid #334155; padding: 20px; display: grid; gap: 18px; }
.aircraft-workbench button { min-height: 40px; border: 1px solid #475569; border-radius: 7px; padding: 8px 12px; font: inherit; color: #e2e8f0; background: #1e293b; cursor: pointer; }
.aircraft-workbench button:hover:not(:disabled) { background: #304258; }
.aircraft-workbench button.wb-primary { background: #155e75; border-color: #22a3b9; color: #ecfeff; }
.aircraft-workbench button:disabled { opacity: .45; cursor: not-allowed; }
.aircraft-workbench :is(button, input, select, textarea, summary):focus-visible { outline: 2px solid #67e8f9; outline-offset: 3px; }
.aircraft-workbench label { display: flex; flex-direction: column; gap: 6px; color: #bbc9dc; font-size: 12px; min-width: 0; }
.aircraft-workbench :is(input, select, textarea) { box-sizing: border-box; width: 100%; min-height: 40px; background: #0c1523; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 9px 10px; font: inherit; }
.aircraft-workbench textarea { resize: vertical; }
.aircraft-workbench input::placeholder, .aircraft-workbench textarea::placeholder { color: #8292a8; }
.wb-selectors { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.wb-toolbar, .wb-actions, .wb-capture-controls, .wb-status-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.wb-toolbar > div { flex: 1; min-width: 220px; }.wb-toolbar strong { font-size: 15px; }
.wb-new-session { display: grid; gap: 15px; border: 1px solid #226e85; background: #102434; padding: 18px; border-radius: 9px; }
.aircraft-workbench h4 { font-size: 16px; font-weight: 650; color: #f1f5f9; margin: 0; }
.wb-message { padding: 12px 14px; border: 1px solid #364b60; border-radius: 7px; background: #19293a; margin: 0; }
.wb-error { border-color: #98533f; background: #362620; color: #ffd0b8; }.wb-success { border-color: #347468; color: #a7f3d0; }
.wb-caution { border-color: #9a753b; background: #30281a; color: #fde3ac; }
.wb-storage-file { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid #334155; padding: 10px 0; }
.wb-storage-file > div { flex: 1; min-width: 0; overflow-wrap: anywhere; }.wb-storage-file p { margin: 4px 0 0; color: #a5b4c8; font-size: 11px; }
.wb-session-meta { display: flex; flex-wrap: wrap; gap: 8px; }.wb-session-meta span { background: #1e293b; padding: 4px 9px; border-radius: 5px; color: #b6c6da; font-size: 11px; }
.wb-dot { height: 7px; width: 7px; border-radius: 100%; background: #8c98aa; }.wb-dot.live { background: #34d399; }
.wb-counts { display: flex; flex-wrap: wrap; gap: 8px; }.wb-counts span { padding: 8px 15px; background: #1e293b; border-radius: 6px; }.wb-counts strong { font-size: 19px; margin-right: 5px; }
.wb-outcome-pass, .wb-fresh { color: #86efac; }.wb-outcome-fail { color: #fda4af; }.wb-outcome-blocked { color: #fcd34d; }
.wb-filters { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 12px; }
.wb-workspace { display: grid; grid-template-columns: minmax(190px, .8fr) minmax(0, 2fr); border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
.wb-case-list { padding: 12px; border-right: 1px solid #334155; background: #0e1826; max-height: 850px; overflow-y: auto; }
.wb-case-list > p { color: #92a3ba; font-size: 11px; padding: 0 4px; }.wb-case-list button { display: flex; flex-direction: column; align-items: start; text-align: left; width: 100%; margin-top: 7px; background: transparent; border-color: transparent; }
.wb-case-list button[aria-current=true] { border-color: #2986a0; background: #153446; }.wb-case-list small { color: #9ab0c8; font-size: 11px; }
.wb-test { padding: 22px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }.wb-test > p { margin: 0; }.wb-test ol { padding-left: 19px; display: grid; gap: 8px; }
.wb-expectations { padding: 12px; background: #172737; border-radius: 7px; }.wb-expectations p { margin: 6px 0 0; }
.aircraft-workbench code { font-size: 11px; overflow-wrap: anywhere; color: #a5dbea; }.wb-readings { display: grid; gap: 6px; }.wb-readings > div { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; border-bottom: 1px solid #2b3b50; padding: 7px 0; }.wb-readings code { flex: 1; }.wb-readings span { font-size: 10px; }
.wb-result-form { display: grid; gap: 15px; }.wb-capture-controls label { min-width: 110px; }.wb-hint { font-size: 11px; color: #9eafc4; margin: 0; }.wb-actions span { font-size: 11px; color: #fcd34d; }
.wb-details { border-top: 1px solid #334155; padding-top: 13px; min-width: 0; }.wb-details summary { cursor: pointer; color: #a6c8e0; padding: 5px 0; }.wb-details pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; background: #0c1523; padding: 12px; max-height: 300px; overflow: auto; }.wb-details > div { margin-top: 12px; }.wb-inventory-row { border-bottom: 1px solid #2b3b50; padding: 7px; }.wb-inventory-row span { margin-left: 12px; color: #91a7bd; }
@media (max-width: 760px) { .wb-heading { align-items: start; flex-direction: column; }.wb-body { padding: 14px; }.wb-selectors, .wb-filters, .wb-workspace { grid-template-columns: minmax(0, 1fr); }.wb-case-list { max-height: 220px; border-right: 0; border-bottom: 1px solid #334155; }.wb-test { padding: 15px; }.aircraft-workbench :is(input, select, textarea) { font-size: 16px; }.aircraft-workbench button { min-height: 44px; }.wb-toolbar > div { min-width: 0; width: 100%; flex-basis: 100%; } }
</style>
