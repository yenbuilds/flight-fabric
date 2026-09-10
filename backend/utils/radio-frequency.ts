// NAV channels use 50 kHz spacing. Keep MHz at the UI boundary and BCD16
// only at the documented NAV*_STBY_SET / NAV*_RADIO_SET event boundary.
export function normalizeNavFrequencyMhz(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const channel = Math.round(value * 20);
  return value >= 108 && value <= 117.95 && Math.abs(value * 20 - channel) < 1e-7
    ? channel / 20 : null;
}

// These are displayed channel designators, not 8.33 kHz carrier frequencies.
// The .020/.045/.070/.095 designators are not channels. Never round to a channel.
export function normalizeComFrequencyMhz(value: unknown, spacingMode: unknown = 1): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || (spacingMode !== 0 && spacingMode !== 1)) return null;
  const khz = Math.round(value * 1000);
  if (khz < 118000 || khz > 136990 || Math.abs(value * 1000 - khz) > 1e-7) return null;
  return (spacingMode === 0 ? khz % 25 === 0 : [0, 5, 10, 15].includes(khz % 25)) ? khz / 1000 : null;
}

export function encodeFrequencyBcd16Mhz(value: unknown): number | null {
  const frequencyMhz = Number(value);
  const hundredths = Math.round(frequencyMhz * 100);
  if (!Number.isFinite(frequencyMhz) || Math.abs(frequencyMhz * 100 - hundredths) > 1e-7
    || hundredths < 10_000 || hundredths > 19_999) return null;
  return Number.parseInt(String(hundredths % 10_000).padStart(4, '0'), 16);
}
