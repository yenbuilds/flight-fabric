import { BARO_SIDE_LABELS, baroSides, parseBaroPressure } from '../aircraft/baro.js';
import { spokenBaroPressure } from './local-readback.js';

const supported = (family) => ['fbw-a32nx', 'fenix-a32x'].includes(family);
const modeText = (mode) => mode === 'std' ? 'standard pressure' : mode === 'qnh' ? 'Q N H' : 'Q F E';

function readSide(family, side, setting, read) {
  const valueMode = family === 'fbw-a32nx' ? read(`baro.${side}.valueMode`) : null;
  let mode;
  if (family === 'fbw-a32nx') {
    const raw = read(`baro.${side}.mode`);
    if (raw === 0 && valueMode === 0) mode = 'std';
    else if ([1, 2].includes(raw) && [1, 2].includes(valueMode)) mode = raw === 1 ? 'qnh' : 'qfe';
  } else {
    const qnh = read(`baro.${side}.qnh`);
    if (typeof qnh === 'boolean') mode = qnh ? 'qnh' : 'std';
  }
  if (!mode) return null;
  if (mode === 'std' || !setting) return { mode, text: modeText(mode) };
  const unitValue = read(`flightGuidance.baroUnit${side === 'captain' ? 'Captain' : 'FirstOfficer'}`);
  const unit = family === 'fbw-a32nx'
    ? (unitValue === false && valueMode === 1 ? 'hPa' : unitValue === true && valueMode === 2 ? 'inHg' : null)
    : (unitValue === 'hpa' ? 'hPa' : unitValue === 'inhg' ? 'inHg' : null);
  if (!unit) return null;
  const value = read(family === 'fbw-a32nx' ? `baro.${side}.value` : `baro.${side}.${unit === 'hPa' ? 'hpa' : 'inhg'}`);
  if (typeof value !== 'number' || parseBaroPressure(value, unit) == null) return null;
  return { mode, text: `${modeText(mode)} ${spokenBaroPressure(value, unit)} ${unit === 'hPa' ? 'hectopascals' : 'inches of mercury'}` };
}

function answerBaro(family, target, setting, read) {
  if (!supported(family) || read('baro.healthy') !== true) return null;
  const sides = baroSides(target), readings = sides.map(side => readSide(family, side, setting, read));
  const complete = readings.every(Boolean);
  const same = complete && readings.every(r => r.text === readings[0].text);
  const text = same ? `${BARO_SIDE_LABELS[target]} ${readings[0].text}.`
    : readings.map((r, i) => `${BARO_SIDE_LABELS[sides[i]]} ${r ? r.text : 'altimeter data unavailable'}.`).join(' ');
  return { ok: complete, text: `${!setting && complete ? (readings.every(r => r.mode === 'std') ? 'Yes. ' : 'No. ') : ''}${text}` };
}

export function createBaroStateQueries(familyForProfile, freshValue) {
  return ['captain', 'firstOfficer', 'both'].flatMap(target => {
    const name = target === 'firstOfficer' ? 'first officer' : target;
    const names = target === 'both' ? ['both altimeters', 'both'] : [name, `the ${name}`, `${name}'s`, `the ${name}'s`];
    return [true, false].map(setting => ({
      id: `baro.${target}.${setting ? 'setting' : 'std'}`,
      phrases: setting ? (target === 'both'
        ? ['what are both altimeter settings', 'what are both altimeters set to', 'what is both qnh', 'what is qnh', "what's qnh", 'what are the altimeter settings']
        : names.flatMap(n => ['what is', "what's"].flatMap(prefix => [`${prefix} ${n} qnh`, `${prefix} ${n} altimeter`, `${prefix} ${n} altimeter setting`])))
        : names.flatMap(n => ['std', 'standard', 'standard pressure'].flatMap(mode => [
          `${target === 'both' ? 'are' : 'is'} ${n} on ${mode}`,
          ...(target === 'both' ? [] : [`is ${n} altimeter on ${mode}`]),
        ])),
      resolveFields: profile => supported(familyForProfile(profile)) ? ['baro.healthy'] : null,
      answer: (_values, state, now) => answerBaro(familyForProfile(state.activeProfileKey), target, setting,
        id => freshValue(state, id, now)),
    }));
  });
}
