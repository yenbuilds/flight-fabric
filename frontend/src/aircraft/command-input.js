import { parseComRadioFrequency } from './com-radio.js';
import { parseNavRadioFrequency } from './nav-radio.js';
import { parseSquawk } from './transponder.js';

/** The command browser uses the same typed values as voice, never raw actions. */
export function aircraftCommandInput(input, raw) {
  if (input?.kind === 'none') return {};
  if (input?.kind === 'boolean') return typeof raw === 'boolean' ? { value: raw } : null;
  if (input?.kind === 'enum') return input.values?.includes(raw) ? { value: raw } : null;
  if (input?.kind !== 'number') return null;
  const text = String(raw ?? '').trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const value = input.units === 'squawk' ? parseSquawk(text)
    : input.units === 'com-megahertz' ? parseComRadioFrequency(text)
      : input.units === 'megahertz' ? parseNavRadioFrequency(text) : Number(text);
  if (value === null || !Number.isFinite(value) || value < input.min || value > input.max) return null;
  const steps = (value - input.min) / input.step;
  return Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) < 1e-7 ? { value } : null;
}

export function aircraftCommandValueLabel(value) {
  return String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/-/g, ' ');
}
