import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { requestAircraftSupport } from '../../../app-shared.js';

export const useAircraftWorkbenchStore = defineStore('aircraftWorkbench', () => {
  const profiles = ref([]), sessions = ref([]), build = ref(null), loadedAircraft = ref(null);
  const report = ref(null), plan = ref(null), session = ref(null), compatibility = ref(null);
  const selectedCaseId = ref(''), search = ref(''), group = ref(''), outcomeFilter = ref('');
  const captureStatus = ref({ active: null, busy: false, error: null });
  const storage = ref(null);
  const busy = ref(false), error = ref(''), notice = ref(''), unreadableCount = ref(0), drafts = ref({});
  let request = requestAircraftSupport;
  let selection = 0;
  const cases = computed(() => plan.value?.cases || []);
  const groups = computed(() => [...new Set(cases.value.map(item => item.group))].sort());
  const latestResults = computed(() => Object.fromEntries((session.value?.attempts || []).map(item => [item.caseId, item])));
  const filteredCases = computed(() => cases.value.filter(item => (!group.value || item.group === group.value)
    && (!outcomeFilter.value || (latestResults.value[item.id]?.result || 'not-run') === outcomeFilter.value)
    && `${item.label} ${item.actionId} ${item.voicePatterns.join(' ')}`.toLowerCase().includes(search.value.toLowerCase())));
  const selectedCase = computed(() => cases.value.find(item => item.id === selectedCaseId.value) || null);
  const counts = computed(() => {
    const result = { pass: 0, fail: 0, blocked: 0, 'not-run': 0 };
    for (const item of cases.value) result[latestResults.value[item.id]?.result || 'not-run']++;
    return result;
  });
  function baseDraft(caseId) {
    const last = latestResults.value[caseId];
    return { result: last?.result || 'not-run', startingState: last?.startingState || '',
      inputUsed: last?.inputUsed || '', cockpitObservation: last?.cockpitObservation || '', captureId: last?.captureId || '' };
  }
  function draftFor(caseId) {
    const key = `${session.value?.id}/${caseId}`;
    if (!drafts.value[key]) drafts.value[key] = baseDraft(caseId);
    return drafts.value[key];
  }
  const hasUnsaved = computed(() => session.value && Object.entries(drafts.value).some(([key, draft]) =>
    key.startsWith(`${session.value.id}/`) && JSON.stringify(draft) !== JSON.stringify(baseDraft(key.slice(session.value.id.length + 1)))));
  async function run(action) {
    if (busy.value) return null;
    busy.value = true; error.value = ''; notice.value = '';
    try { return await action(); }
    catch (failure) { error.value = failure.message || 'Workbench request failed.'; return null; }
    finally { busy.value = false; }
  }
  function applySession(payload) {
    session.value = payload.session; report.value = payload.session.report; plan.value = payload.session.plan;
    compatibility.value = payload.compatibility; captureStatus.value = payload.captureStatus;
    if (!cases.value.some(item => item.id === selectedCaseId.value)) selectedCaseId.value = cases.value[0]?.id || '';
  }
  function applyList(payload) {
    sessions.value = payload.sessions; unreadableCount.value = payload.unreadableCount;
    storage.value = payload.storage || null;
  }
  async function refreshList() {
    applyList(await request('sessions'));
  }
  async function refreshStorage() { return run(refreshList); }
  async function deleteFile(file) {
    return run(async () => {
      if (file.sessionId === session.value?.id && hasUnsaved.value) throw new Error('Save your observations before deleting this session’s files.');
      applyList(await request('storage/delete', { body: { name: file.name, version: file.version } }));
      if (file.kind === 'session' && file.sessionId === session.value?.id) {
        session.value = null; compatibility.value = null;
        captureStatus.value = { active: null, busy: false, error: null };
        for (const key of Object.keys(drafts.value)) if (key.startsWith(`${file.sessionId}/`)) delete drafts.value[key];
      }
      notice.value = 'Saved file deleted. Copies you exported are unchanged.';
      return true;
    });
  }
  async function initialize() {
    return run(async () => {
      const payload = await request('catalogue');
      profiles.value = payload.profiles; build.value = payload.build; loadedAircraft.value = payload.loadedAircraft;
      await refreshList();
    });
  }
  async function browse(profileKey) {
    const ticket = ++selection;
    return run(async () => {
      const payload = await request(`report?profile=${encodeURIComponent(profileKey)}`);
      if (ticket !== selection) return;
      session.value = null; compatibility.value = null; report.value = payload.report; plan.value = payload.plan;
      build.value = payload.build; selectedCaseId.value = cases.value[0]?.id || '';
      group.value = ''; search.value = ''; outcomeFilter.value = '';
    });
  }
  async function createSession(input) {
    return run(async () => {
      applySession(await request('sessions', { body: input }));
      group.value = ''; search.value = ''; outcomeFilter.value = '';
      notice.value = 'Session created. Results are saved on this PC.'; await refreshList();
    });
  }
  async function openSession(id) {
    return run(async () => { applySession(await request(`sessions/${id}`)); group.value = ''; search.value = ''; outcomeFilter.value = ''; });
  }
  async function refreshSession() {
    if (!session.value || busy.value) return;
    const id = session.value.id;
    try {
      const payload = await request(`sessions/${id}`);
      if (session.value?.id === id && !busy.value) applySession(payload);
    } catch (failure) { error.value = failure.message; }
  }
  async function saveResult() {
    return run(async () => {
      const caseId = selectedCaseId.value, id = session.value.id;
      applySession(await request(`sessions/${id}/results`, { body: { revision: session.value.revision, caseId, ...draftFor(caseId) } }));
      delete drafts.value[`${id}/${caseId}`];
      notice.value = 'Test result saved. Previous attempts are retained.'; await refreshList();
    });
  }
  async function pollCapture() {
    if (!session.value || busy.value) return;
    const id = session.value.id;
    try {
      const payload = await request(`sessions/${id}/capture`);
      if (session.value?.id !== id || busy.value) return;
      captureStatus.value = payload.captureStatus;
      if (!payload.captureStatus.active) {
        await refreshSession();
        await refreshList();
        const capture = session.value?.captures.at(-1)?.capture;
        if (!error.value && !payload.captureStatus.error && capture) notice.value = capture.complete
          ? 'Capture saved. Record the cockpit response and save your test result.'
          : `Partial capture saved (${capture.endReason}). Review the collected readings before recording your result.`;
      }
    } catch (failure) { error.value = failure.message; }
  }
  async function startCapture(seconds) {
    return run(async () => {
      const payload = await request(`sessions/${session.value.id}/capture`, { body: {
        revision: session.value.revision, caseId: selectedCaseId.value, seconds,
        condition: draftFor(selectedCaseId.value).startingState,
      } });
      captureStatus.value = payload.captureStatus;
    });
  }
  async function stopCapture() {
    return run(async () => {
      applySession(await request(`sessions/${session.value.id}/capture/stop`, { body: {} }));
      await refreshList();
      notice.value = 'Capture stopped and saved. Record your cockpit observation below.';
    });
  }
  async function markStep(label) {
    return run(async () => {
      const payload = await request(`sessions/${session.value.id}/capture/marker`, { body: { label } });
      captureStatus.value = payload.captureStatus; notice.value = 'Step marked in this capture.';
    });
  }
  function bindRequest(nextRequest) { request = nextRequest || requestAircraftSupport; }
  return { profiles, sessions, build, loadedAircraft, report, plan, session, compatibility, selectedCaseId,
    search, group, outcomeFilter, captureStatus, busy, error, notice, unreadableCount, storage, cases, groups, filteredCases,
    selectedCase, latestResults, counts, hasUnsaved, drafts, draftFor,
    initialize, browse, createSession, openSession, refreshSession, refreshStorage, deleteFile, pollCapture, saveResult, startCapture, stopCapture, markStep, bindRequest };
});
