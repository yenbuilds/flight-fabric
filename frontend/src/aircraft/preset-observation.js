import { freshAircraftValue } from '../voice/state-queries.js';

const PAIRED_PRESET_FIELDS = Object.freeze({
  'flightGuidance.course.setBoth': {
    fields: ['mcp.courseCaptainDeg', 'mcp.courseFirstOfficerDeg'],
    reason: 'Waiting for live course-window readings.',
  },
  'radios.nav.setBothActive': {
    fields: ['radios.nav1ActiveMhz', 'radios.nav2ActiveMhz'],
    reason: 'Waiting for live NAV frequency readings.',
  },
});

// Shared by the preset controls and the suggestion page. Keep these source
// requirements together so a reminder cannot bypass the preset's live gates.
export function presetSourceUnavailableReason(command, snapshot, catalogue, now = Date.now()) {
  const templateId = snapshot?.templateId || catalogue?.configurationId;
  const lightPreset = String(command?.id || '').startsWith('configuration.lights.');
  if (templateId === 'inibuilds-a350' && lightPreset) {
    if (snapshot?.sourceStatus !== 'connected' || snapshot.activeProfileKey !== catalogue?.profileKey
      || snapshot.activeProfileRevision !== catalogue?.profileRevision) return 'Waiting for live aircraft data.';
    return ['lights.landing', 'lights.noseMode', 'lights.strobeMode', 'lights.navMode']
      .some(id => freshAircraftValue(snapshot, id, now) === null) ? 'Waiting for live exterior light readings.' : '';
  }
  const paired = PAIRED_PRESET_FIELDS[command.id];
  if (templateId === 'pmdg-737' && paired) {
    // The paired setters previously lived beside their readouts and required
    // both live values before enabling. Keep that gate with the preset.
    if (snapshot?.sourceStatus !== 'connected' || snapshot.activeProfileKey !== catalogue?.profileKey
      || snapshot.activeProfileRevision !== catalogue?.profileRevision) return 'Waiting for live aircraft data.';
    return paired.fields.some(id => snapshot.unavailable?.includes(id)
      || !Object.prototype.hasOwnProperty.call(snapshot.values || {}, id)) ? paired.reason : '';
  }
  if (!['pmdg-737', 'pmdg-777'].includes(templateId)
    || !(lightPreset || command.id === 'configuration.apu.start')) return '';
  const sdkStatus = snapshot?.sourceStatuses?.sdk || snapshot?.sourceStatus;
  return snapshot?.sourceStatus !== 'connected' || sdkStatus !== 'connected' ? 'Waiting for live PMDG SDK data.' : '';
}

// The backend catalogue owns which aircraft fields mean starting/available.
// Elapsed startup time and switch master ON never supply an observed outcome.
export function presetObservation(command, snapshot, nowMs = Date.now()) {
  if (snapshot?.available !== true) return null;
  const matches = command?.observations?.filter((observation) => (
    Object.is(freshAircraftValue(snapshot, observation.fieldId, nowMs), observation.expectedValue)
  )) || [];
  if (!matches.length) return null;
  // Keep the highest-priority status visible while honoring every fresh guard.
  return { ...matches[0], inhibitsRequest: matches.some((observation) => observation.inhibitsRequest === true) };
}
