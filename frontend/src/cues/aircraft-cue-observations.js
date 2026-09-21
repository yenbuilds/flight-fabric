import { freshAircraftValue } from '../voice/state-queries.js';

const fields = {
  'pmdg-737': { flaps: 'queries.flapsHandle', autobrake: 'gear.autobrakeMode', spoilers: 'flightControls.speedbrakeArmed' },
  'pmdg-777': { flaps: 'controls.flapsLabel', autobrake: 'controls.autobrakeMode', spoilers: 'controls.speedbrakeState' },
  'fenix-a32x': { flaps: 'controls.flapsHandle' },
  'fbw-a32nx': { flaps: 'controls.flapsHandle', autobrake: 'systems.autobrakeMode', spoilers: 'controls.spoilersArmed' },
  'fbw-a380x': { spoilers: 'controls.spoilersArmed' },
};

// Only exact integrations supply observed configuration. Unknown, stale and
// conflicting readings never count as a completed action or a selected detent.
export function observedCueConfiguration(configurationId, snapshot, now) {
  if (snapshot?.available !== true) return {};
  if (['pmdg-737', 'pmdg-777'].includes(configurationId)
    && (snapshot.sourceStatuses?.sdk || snapshot.sourceStatus) !== 'connected') return {};
  const read = id => id ? freshAircraftValue(snapshot, id, now) : null;
  const mapping = fields[configurationId] || {};
  const flaps = read(mapping.flaps);
  let autobrake = read(mapping.autobrake);
  let spoilers = read(mapping.spoilers);
  if (configurationId === 'pmdg-777') {
    spoilers = spoilers === 'armed' ? true : spoilers === 'stowed' ? false : null;
  }
  if (configurationId === 'fenix-a32x' && read('baro.healthy') === true) {
    const lamps = ['low', 'medium', 'max'].map(mode => read(`controls.autobrake.${mode}`));
    autobrake = lamps.every(value => typeof value === 'boolean') && lamps.filter(Boolean).length <= 1
      ? ['low', 'medium', 'max'].find((_, i) => lamps[i]) || 'off' : null;
    const position = read('controls.speedbrakePosition');
    spoilers = position === 0 ? true : position === 1 ? false : null;
  }
  return {
    flaps: typeof flaps === 'string' ? flaps.toLowerCase() : null,
    autobrake: typeof autobrake === 'string' ? autobrake : null,
    spoilers: typeof spoilers === 'boolean' ? spoilers : null,
  };
}
