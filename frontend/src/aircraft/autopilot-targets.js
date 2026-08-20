const DEFINITIONS = Object.freeze({
  spd: Object.freeze({
    mode: 'spd',
    label: 'Selected speed',
    shortLabel: 'SPD',
    units: 'KTS',
    min: 0,
    max: 999,
    step: 1,
    fineStep: 1,
    coarseStep: 10,
    defaultValue: 250,
    inputMode: 'numeric',
  }),
  hdg: Object.freeze({
    mode: 'hdg',
    label: 'Selected heading',
    shortLabel: 'HDG',
    units: 'DEG',
    min: 0,
    max: 359,
    step: 1,
    fineStep: 1,
    coarseStep: 10,
    defaultValue: 0,
    inputMode: 'numeric',
    wraps: true,
  }),
  alt: Object.freeze({
    mode: 'alt',
    label: 'Selected altitude',
    shortLabel: 'ALT',
    units: 'FT',
    min: 0,
    max: 60000,
    step: 100,
    fineStep: 100,
    coarseStep: 1000,
    defaultValue: 10000,
    inputMode: 'numeric',
  }),
  vs: Object.freeze({
    mode: 'vs',
    label: 'Selected vertical speed',
    shortLabel: 'V/S',
    units: 'FPM',
    min: -9900,
    max: 9900,
    step: 100,
    fineStep: 100,
    coarseStep: 500,
    defaultValue: 0,
    inputMode: 'decimal',
  }),
});

export function getAutopilotTargetDefinition(mode) {
  return DEFINITIONS[typeof mode === 'string' ? mode.trim() : ''] || null;
}

export function validateAutopilotTargetValue(mode, rawValue) {
  const definition = getAutopilotTargetDefinition(mode);
  if (!definition) return { ok: false, value: null, error: 'Unknown autopilot target.' };

  if (rawValue == null || typeof rawValue === 'boolean' || (typeof rawValue === 'string' && !rawValue.trim())) {
    return { ok: false, value: null, error: `Enter a ${definition.label.toLowerCase()}.` };
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return { ok: false, value: null, error: `Enter a valid ${definition.label.toLowerCase()}.` };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, value: null, error: `${definition.shortLabel} must be a whole number.` };
  }
  if (value < definition.min || value > definition.max) {
    return {
      ok: false,
      value: null,
      error: `${definition.shortLabel} must be between ${definition.min.toLocaleString()} and ${definition.max.toLocaleString()} ${definition.units}.`,
    };
  }
  if (Math.abs(value - definition.min) % definition.step !== 0) {
    return {
      ok: false,
      value: null,
      error: `${definition.shortLabel} must use ${definition.step.toLocaleString()} ${definition.units} increments.`,
    };
  }
  return { ok: true, value, error: '' };
}

export function parseAutopilotTargetDisplay(mode, displayValue) {
  const definition = getAutopilotTargetDefinition(mode);
  if (!definition) return null;
  const normalized = String(displayValue ?? '')
    .replace(/,/g, '')
    .replace(/^\+/, '')
    .trim();
  const result = validateAutopilotTargetValue(mode, normalized);
  return result.ok ? result.value : null;
}

export function adjustAutopilotTargetValue(mode, rawValue, delta) {
  const definition = getAutopilotTargetDefinition(mode);
  if (!definition) return null;
  const current = validateAutopilotTargetValue(mode, rawValue);
  const base = current.ok ? current.value : definition.defaultValue;
  const numericDelta = Number(delta);
  if (!Number.isFinite(numericDelta)) return base;

  const candidate = base + numericDelta;
  if (definition.wraps) {
    const range = definition.max - definition.min + 1;
    return ((candidate - definition.min) % range + range) % range + definition.min;
  }
  return Math.max(definition.min, Math.min(definition.max, candidate));
}

export function formatAutopilotTargetValue(mode, rawValue) {
  const result = validateAutopilotTargetValue(mode, rawValue);
  if (!result.ok) return '---';
  if (mode === 'hdg') return String(result.value).padStart(3, '0');
  if (mode === 'alt') return result.value.toLocaleString();
  if (mode === 'vs') return `${result.value >= 0 ? '+' : ''}${result.value.toLocaleString()}`;
  return String(result.value);
}

export function resolveAutopilotTargetStatus({
  mode,
  busy = false,
  feedbackMatches = false,
  feedbackStatus = 'idle',
  feedbackMessage = '',
  submittedValue = null,
  liveReadbackValue = null,
  liveDisplayValue = '---',
} = {}) {
  const units = getAutopilotTargetDefinition(mode)?.units || '';

  if (busy && feedbackMatches) {
    return { tone: 'sending', text: 'Sending target to the aircraft…' };
  }
  // A correlated rejection is authoritative even when the requested value
  // already matched the live readback before the command was submitted.
  if (feedbackMatches && feedbackStatus === 'failed') {
    return { tone: 'failed', text: feedbackMessage || 'The aircraft rejected the target.' };
  }
  if (submittedValue != null && liveReadbackValue === submittedValue) {
    return {
      tone: 'confirmed',
      text: `Confirmed by live readback: ${formatAutopilotTargetValue(mode, submittedValue)} ${units}`,
    };
  }
  if (feedbackMatches && feedbackStatus === 'sent' && submittedValue != null) {
    return { tone: 'waiting', text: 'Command sent; waiting for updated aircraft readback.' };
  }
  if (submittedValue != null) {
    return { tone: 'waiting', text: 'Target prepared; waiting for command status.' };
  }
  if (liveReadbackValue == null) {
    return {
      tone: 'live',
      text: `Displayed target ${liveDisplayValue} ${units}; exact readback is unavailable.`,
    };
  }
  return { tone: 'live', text: `Live target ${liveDisplayValue} ${units}` };
}

export const AUTOPILOT_TARGET_MODES = Object.freeze(Object.keys(DEFINITIONS));
