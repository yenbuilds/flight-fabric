import { normalizeVoiceText } from './aviation-number-parser.js';
import { normalizeAviationAcronyms } from './aviation-acronyms.js';
import { formatSquawk } from '../aircraft/transponder.js';
import { createBaroStateQueries } from './baro-state-queries.js';

export const A32NX_QUERY_PROFILE = 'bundled/msfs/fbw-a32nx';

const profileFamilies = Object.freeze(Object.fromEntries([
  ['fbw-a32nx', ['fbw-a32nx']],
  ['pmdg-737', ['pmdg-737', 'pmdg-737-600', 'pmdg-737-700', 'pmdg-737-900']],
  ['pmdg-777', ['pmdg-777', 'pmdg-777-200er', 'pmdg-777-200lr', 'pmdg-777f']],
  ['fenix-a32x', ['fenix-a319', 'fenix-a320', 'fenix-a321']],
  ['inibuilds-a350', ['inibuilds-a350-900', 'inibuilds-a350-1000']],
].flatMap(([family, profiles]) => profiles.map((profile) => [`bundled/msfs/${profile}`, family]))));

export function aircraftQueryFamily(profileKey) { return typeof profileKey === 'string' && Object.hasOwn(profileFamilies, profileKey) ? profileFamilies[profileKey] : null; }

const familyFields = {
  'pmdg-737': { altitude: ['mcp.altitudeFt'], spoilers: ['flightControls.speedbrakeArmed'], flaps: ['queries.flapsHandle'], autobrake: ['gear.autobrakeMode'], squawk: ['surveillance.powered', 'surveillance.squawk'] },
  'pmdg-777': { altitude: ['flightGuidance.altitudeFt'], spoilers: ['controls.speedbrakeState'], flaps: ['controls.flapsLabel'], autobrake: ['controls.autobrakeMode'], squawk: ['surveillance.powered', 'surveillance.squawk'] },
  'fenix-a32x': { altitude: ['flightGuidance.altitudeFt'], flaps: ['controls.flapsHandle'], squawk: ['surveillance.powered', 'surveillance.squawk'],
    spoilers: ['baro.healthy', 'controls.speedbrakePosition'],
    autobrake: ['baro.healthy', 'controls.autobrake.low', 'controls.autobrake.medium', 'controls.autobrake.max'] },
  'inibuilds-a350': { altitude: ['flightGuidance.altitudeFt'] },
};

export function efisFieldId(profileKey, side, control) {
  const family = aircraftQueryFamily(profileKey);
  if (!family || !['captain', 'firstOfficer'].includes(side)) return null;
  if (family.startsWith('pmdg-')) return control === 'ls' ? null : `efis.${side}.${control === 'range' ? 'rangeNm' : control}`;
  if (control === 'minimumsMode') return null;
  if (family === 'fbw-a32nx') return `navigation.${control === 'range' ? 'nd' : 'ls'}${side === 'captain' ? 'Captain' : 'FirstOfficer'}${control === 'range' ? 'Range' : ''}`;
  if (family === 'inibuilds-a350' && control === 'ls') return `flightGuidance.ls${side === 'captain' ? 'Captain' : 'FirstOfficer'}`;
  return `navigation.${side}.${control}`;
}

/** Both observation and delivery must be recent; reconnect replays cannot refresh old data. */
export function freshAircraftValue(state, fieldId, now = Date.now()) {
  if (state?.sourceStatus !== 'connected' || state?.unavailable?.includes(fieldId)) return null;
  const sampled = Date.parse(state.valueUpdatedAt?.[fieldId]);
  const published = Date.parse(state.updatedAt);
  const elapsed = now - state.receivedAt;
  const age = now - sampled;
  if (!Number.isFinite(age) || !Number.isFinite(state.receivedAt) || elapsed < 0 || elapsed > 2000
      || !Number.isFinite(published) || now - published > 2000 || now - published < -1000
      || sampled > published + 1000 || age < -1000 || age > 2000) return null;
  return state.values?.[fieldId] ?? null;
}

const queries = [
  { id: 'altitude', phrases: ['what is selected altitude', "what's selected altitude", 'what is the selected altitude', 'selected altitude'],
    fields: ['baro.healthy', 'flightGuidance.altitudeFt'], answer: (values) => {
      const value = values.at(-1);
      return (values.length === 1 || values[0] === true) && Number.isFinite(value) && value >= 0 && value <= 50000 ? `Selected altitude ${value} feet.` : null;
    } },
  { id: 'spoilers', phrases: ['are spoilers armed', 'are the spoilers armed', 'are ground spoilers armed'],
    fields: ['controls.spoilersArmed'], answer: (values, state) => {
      if (aircraftQueryFamily(state.activeProfileKey) === 'fenix-a32x') {
        const [powered, position] = values;
        return powered === true && typeof position === 'number' && (position === 0 || (position >= 1 && position <= 3))
          ? `Ground spoilers ${position === 0 ? 'armed' : 'disarmed'}.` : null;
      }
      const [value] = values;
      return typeof value === 'boolean' || ['stowed', 'armed', 'extended'].includes(value)
        ? `Ground spoilers ${value === true || value === 'armed' ? 'armed' : 'disarmed'}.` : null;
    } },
  { id: 'flaps', phrases: ['what are the flaps', 'what is the flap setting', 'flap setting'],
    fields: ['controls.flapsHandle'], answer: ([value]) => ['up', 'UP', '1', '2', '3', '5', '10', '15', '20', '25', '30', '40', 'full'].includes(value) ? `Flaps ${value} selected.` : null },
  { id: 'autobrake', phrases: ['what is the autobrake setting', 'what is autobrake', 'autobrake setting'],
    fields: ['systems.autobrakeMode'], answer: (values, state) => {
      if (aircraftQueryFamily(state.activeProfileKey) === 'fenix-a32x') {
        const [powered, ...lamps] = values;
        if (powered !== true || lamps.some(value => typeof value !== 'boolean') || lamps.filter(Boolean).length > 1) return null;
        return `Autobrake ${['low', 'medium', 'max'].find((_, i) => lamps[i]) || 'off'}.`;
      }
      const [value] = values;
      return ['disarmed', 'low', 'medium', 'max', 'rto', 'off', 'disarm', '1', '2', '3'].includes(value) ? `Autobrake ${value === 'rto' ? 'R T O' : value}.` : null;
    } },
  { id: 'squawk', phrases: ['what is the squawk', "what's the squawk", 'what is my squawk', 'squawk code'],
    fields: ['surveillance.powered', 'surveillance.squawk'], answer: ([powered, value]) => powered === true && formatSquawk(value) !== '----'
      ? `Squawk ${formatSquawk(value).split('').join(' ')}.` : null },
  ...[1, 2].flatMap((index) => ['active', 'standby'].map((bank) => ({
    id: `com${index}.${bank}`, phrases: [`what is com ${index} ${bank}`, `what's com ${index} ${bank}`, `com ${index} ${bank}`, `what is com ${index === 1 ? 'one' : 'two'} ${bank}`, `com ${index === 1 ? 'one' : 'two'} ${bank}`],
    fields: [`radios.com${index}.installed`, `radios.com${index}.status`, `radios.com${index}.${bank}Mhz`],
    answer: ([installed, status, value]) => installed === true && status === 0 && typeof value === 'number' && value >= 118 && value <= 136.99
      ? `Com ${index} ${bank} ${value.toFixed(3).replace('.', ' decimal ').replace(/\d+/g, (digits) => digits.split('').join(' '))}.` : null,
  }))),
];

const efisQueries = ['captain', 'firstOfficer'].flatMap((side) => {
  const spoken = side === 'captain' ? 'captain' : 'first officer';
  return [
    ...['range', 'ls', 'minimumsMode'].map((control) => ({
      id: `${side}.${control}`,
      phrases: [`what is ${spoken} ${control === 'minimumsMode' ? 'minimums reference' : control}`, `${spoken} ${control === 'minimumsMode' ? 'minimums reference' : control}`],
      resolveFields: (profile) => { const id = efisFieldId(profile, side, control); return id ? [id] : null; },
      answer: ([value]) => control === 'range' ? (/^\d+$/.test(value) ? `${spoken} range ${value} nautical miles.` : value === 'zoom' ? `${spoken} range in airport zoom.` : null)
        : control === 'ls' ? (typeof value === 'boolean' ? `${spoken} L S ${value ? 'on' : 'off'}.` : null)
          : (['baro', 'radio'].includes(value) ? `${spoken} minimums reference ${value}.` : null),
    })),
    { id: `${side}.minimums`, phrases: [`what are ${spoken} minimums`, `what is ${spoken} minimums`, `${spoken} minimums`],
      resolveFields: (profile) => aircraftQueryFamily(profile) === 'pmdg-777' ? [`efis.${side}.minimumsMode`] : null,
      answer: ([mode], state, now) => {
        if (!['baro', 'radio'].includes(mode)) return null;
        const set = freshAircraftValue(state, `efis.${side}.${mode}MinimumsSet`, now);
        const value = freshAircraftValue(state, `efis.${side}.${mode}MinimumsFt`, now);
        if (set === false) return `${spoken} ${mode} minimums not set.`;
        return set === true && Number.isInteger(value) && value >= -1000 && value <= 60000 ? `${spoken} ${mode} minimums ${value} feet.` : null;
      } },
  ];
});
const allQueries = [...queries, ...createBaroStateQueries(aircraftQueryFamily, freshAircraftValue), ...efisQueries];
function fieldsForQuery(query, profileKey) {
  if (query.resolveFields) return query.resolveFields(profileKey);
  return aircraftQueryFamily(profileKey) === 'fbw-a32nx' ? query.fields : familyFields[aircraftQueryFamily(profileKey)]?.[query.id];
}
export function stateQueryExamples(state) {
  return allQueries.filter((query) => fieldsForQuery(query, state?.activeProfileKey)).map((query) => query.phrases[0]);
}
export function canQueryAircraftState(state) {
  return Boolean(aircraftQueryFamily(state?.activeProfileKey)) && Number.isInteger(state.activeProfileRevision)
    && state?.sourceStatus === 'connected';
}

/** Exact read-only phrases never pass through the action dispatcher. */
export function answerAircraftStateQuery(transcript, state, context, now = Date.now()) {
  const normalize = value => normalizeAviationAcronyms(normalizeVoiceText(value));
  const text = normalize(transcript);
  const query = allQueries.find((entry) => entry.phrases.some((phrase) => normalize(phrase) === text));
  if (!query || !aircraftQueryFamily(context?.profileKey)) return null;
  const fields = fieldsForQuery(query, context.profileKey);
  if (!fields) return { ok: false, id: query.id, text: 'That state query is not available for this aircraft.' };
  const current = canQueryAircraftState(state) && context.profileKey === state.activeProfileKey
    && context.profileRevision === state.activeProfileRevision;
  const values = current ? fields.map((field) => freshAircraftValue(state, field, now)) : [];
  const answer = values.length && values.every((value) => value !== null) ? query.answer(values, state, now) : null;
  if (answer && typeof answer === 'object') return { ok: answer.ok === true, id: query.id, text: answer.text };
  return { ok: Boolean(answer), id: query.id, text: answer || 'Current aircraft data unavailable. Try again when live data returns.' };
}
