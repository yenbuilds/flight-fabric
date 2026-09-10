export function parseComRadioFrequency(text, spacingMode = 1) {
  const raw = String(text ?? '').trim();
  if (!/^\d{3}(?:\.\d{1,3})?$/.test(raw) || (spacingMode !== 0 && spacingMode !== 1)) return null;
  const value = Number(raw);
  const khz = Math.round(value * 1000);
  if (khz < 118000 || khz > 136990 || Math.abs(value * 1000 - khz) > 1e-7) return null;
  return (spacingMode === 0 ? khz % 25 === 0 : [0, 5, 10, 15].includes(khz % 25)) ? khz / 1000 : null;
}

export function comRadioResultText(result) {
  const radio = result?.radio;
  if (result?.ok !== true || result?.code !== 'executed' || ![1, 2].includes(radio?.index)
    || !['active', 'standby'].includes(radio?.bank)
    || typeof radio?.frequencyMhz !== 'number'
    || parseComRadioFrequency(radio?.frequencyMhz) == null) return '';
  return `COM ${radio.index} ${radio.bank} ${radio.frequencyMhz.toFixed(3)} MHz confirmed`;
}
