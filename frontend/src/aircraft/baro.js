export const BARO_SIDE_LABELS = { captain: 'Captain', firstOfficer: 'First officer', both: 'Both altimeters' };
export const baroSides = (target) => target === 'both' ? ['captain', 'firstOfficer'] : [target];

export function parseBaroPressure(text, unit) {
  const raw = String(text ?? '').trim();
  if (unit === 'hPa') return /^\d{3,4}$/.test(raw) && Number(raw) >= 948 && Number(raw) <= 1084 ? Number(raw) : null;
  if (unit === 'inHg') return /^\d{2}(?:\.\d{1,2})?$/.test(raw) && Number(raw) >= 27.99 && Number(raw) <= 32.01 ? Number(raw) : null;
  return null;
}

export function baroResultText(result, spokenValue) {
  const b = result?.baro;
  if (!Object.hasOwn(BARO_SIDE_LABELS, b?.target || '') || !['qnh', 'std'].includes(b.mode)
    || !Array.isArray(b.confirmedSides) || new Set(b.confirmedSides).size !== b.confirmedSides.length
    || b.confirmedSides.some((side) => !baroSides(b.target).includes(side))
    || (b.mode === 'qnh' && (typeof b.value !== 'number' || parseBaroPressure(b.value, b.unit) == null))) {
    return { confirmed: false, text: 'Altimeter response unconfirmed. Check both aircraft altimeters.' };
  }
  const pressure = b.mode === 'std' ? 'standard pressure' : `QNH ${spokenValue ?? (b.unit === 'inHg' ? b.value.toFixed(2) : b.value)} ${b.unit}`;
  if (result.ok === true && result.code === 'executed' && b.confirmedSides.length === baroSides(b.target).length) {
    return { confirmed: true, text: `${BARO_SIDE_LABELS[b.target]} ${pressure} confirmed.` };
  }
  const remaining = baroSides(b.target).filter((side) => !b.confirmedSides.includes(side));
  const matched = b.confirmedSides.map((side) => BARO_SIDE_LABELS[side]).join(' and ');
  return { confirmed: false, text: `${matched ? `${matched} ${pressure} observed. ` : ''}${remaining.length
    ? `${remaining.map((side) => BARO_SIDE_LABELS[side]).join(' and ')} unconfirmed. Check the aircraft altimeters.`
    : 'Request failed. Check the aircraft altimeters.'}` };
}
