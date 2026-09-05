export function parseNavRadioFrequency(text) {
  const value = String(text ?? '').trim().replace(',', '.');
  if (!/^\d{3}(?:\.\d{1,2})?$/.test(value)) return null;
  const mhz = Number(value);
  const channel = Math.round(mhz * 20);
  return mhz >= 108 && mhz <= 117.95 && Math.abs(mhz * 20 - channel) < 1e-7
    ? channel / 20 : null;
}

export function copyNavRadioReadback(radios) {
  return Object.fromEntries(['nav1', 'nav2'].map((id) => {
    const radio = radios?.[id];
    const installed = typeof radio?.installed === 'boolean' ? radio.installed : null;
    const frequency = (raw) => installed === true && typeof raw === 'number'
      ? parseNavRadioFrequency(raw) : null;
    return [id, { installed, activeMhz: frequency(radio?.activeMhz), standbyMhz: frequency(radio?.standbyMhz) }];
  }));
}
