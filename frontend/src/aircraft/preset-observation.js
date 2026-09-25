import { freshAircraftValue } from './fresh-aircraft-value.js';

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
  // Capabilities may outlive a telemetry disconnect or profile transition.
  // Every aircraft-specific phase/APU preset needs the same current context.
  if (catalogue?.configurationId && catalogue.configurationId !== 'generic'
    && (lightPreset || command?.id === 'configuration.apu.start')) {
    if (snapshot?.activeProfileKey !== catalogue.profileKey || snapshot?.activeProfileRevision !== catalogue.profileRevision)
      return 'Waiting for live aircraft data.';
    if (snapshot?.sourceStatus !== 'connected') return ['pmdg-737', 'pmdg-777'].includes(templateId)
      ? 'Waiting for live PMDG SDK data.' : 'Waiting for live aircraft data.';
  }
  if (templateId === 'tfdi-md-11' && lightPreset) {
    if (snapshot?.sourceStatus !== 'connected' || snapshot.activeProfileKey !== catalogue?.profileKey
      || snapshot.activeProfileRevision !== catalogue?.profileRevision) return 'Waiting for live aircraft data.';
    const power = freshAircraftValue(snapshot, 'systems.busVoltage', now);
    if (typeof power !== 'number' || !Number.isFinite(power) || power < 90 || power > 130) return 'Fresh aircraft electrical power required.';
    const selectors = ['lights.landingLeftPosition', 'lights.landingRightPosition', 'lights.nosePosition'];
    const switches = ['lights.turnoffLeft', 'lights.turnoffRight', 'lights.strobe', 'lights.nav'];
    return selectors.some(id => ![0, 1, 2].includes(freshAircraftValue(snapshot, id, now)))
      || switches.some(id => typeof freshAircraftValue(snapshot, id, now) !== 'boolean')
      ? 'Waiting for live exterior light readings.' : '';
  }
  if (['inibuilds-a350', 'inibuilds-a380'].includes(templateId) && lightPreset) {
    if (snapshot?.sourceStatus !== 'connected' || snapshot.activeProfileKey !== catalogue?.profileKey
      || snapshot.activeProfileRevision !== catalogue?.profileRevision) return 'Waiting for live aircraft data.';
    return ['lights.landing', 'lights.noseMode', 'lights.strobeMode', templateId === 'inibuilds-a380' ? 'lights.nav' : 'lights.navMode']
      .some(id => freshAircraftValue(snapshot, id, now) === null) ? 'Waiting for live exterior light readings.' : '';
  }
  if (templateId === 'inibuilds-a380' && command.id === 'configuration.apu.start') {
    if (snapshot?.sourceStatus !== 'connected' || snapshot.activeProfileKey !== catalogue?.profileKey
      || snapshot.activeProfileRevision !== catalogue?.profileRevision) return 'Waiting for live aircraft data.';
    return ['systems.apuMaster', 'systems.apuStart', 'systems.apuAvailable', 'systems.apuMasterFault']
      .some(id => freshAircraftValue(snapshot, id, now) === null) ? 'Waiting for live APU readings.' : '';
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

export function presetPendingReason(command, catalogue, isPending) {
  if (catalogue?.configurationId !== 'tfdi-md-11'
    || !String(command?.id || '').startsWith('configuration.lights.')) return '';
  // Lights, signs and minimums share the same aircraft event mailbox.
  return isPending('aircraft-specific-group:md11.cevent')
    || Object.values(catalogue.commands || {}).some(candidate => (
      /^(lights\.|configuration\.lights\.|cabin\.)/.test(candidate.id)
        || /^approach\.(captain|firstOfficer)\.radioMinimums$/.test(candidate.id)
    ) && isPending(candidate.id)) ? 'Waiting for another aircraft control to finish.' : '';
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
