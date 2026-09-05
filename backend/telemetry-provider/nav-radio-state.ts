import { normalizeNavFrequencyMhz } from '../utils/radio-frequency';

export const NAV_RADIO_FIELDS = new Set([
  'nav1Available', 'nav1ActiveMhz', 'nav1StandbyMhz',
  'nav2Available', 'nav2ActiveMhz', 'nav2StandbyMhz',
]);

export type NavRadioSample = { value: unknown; updatedAt: string | null };

export function captureNavRadios(
  samples: Record<string, NavRadioSample>, status: unknown, nowMs = Date.now(),
) {
  const sampleValue = (name: string) => {
    const sample = samples[name];
    const time = typeof sample?.updatedAt === 'string' ? Date.parse(sample.updatedAt) : NaN;
    return ['running', 'connected'].includes(String(status)) && Number.isFinite(time)
      && nowMs >= time && nowMs - time <= 2000 ? sample.value : null;
  };
  return Object.fromEntries(['nav1', 'nav2'].map((id) => {
    const availability = sampleValue(`${id}Available`);
    const installed = typeof availability === 'boolean' ? availability : null;
    return [id, {
      installed,
      activeMhz: installed === true ? normalizeNavFrequencyMhz(sampleValue(`${id}ActiveMhz`)) : null,
      standbyMhz: installed === true ? normalizeNavFrequencyMhz(sampleValue(`${id}StandbyMhz`)) : null,
    }];
  }));
}
