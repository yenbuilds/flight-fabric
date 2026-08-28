import { normalizeVoiceText, parseAviationNumber } from './aviation-number-parser.js';

const TRUE_WORDS = new Set(['on', 'engage', 'engaged', 'arm', 'armed', 'set']);
const FALSE_WORDS = new Set(['off', 'disengage', 'disengaged', 'disarm', 'disarmed', 'release', 'released']);
const ENUM_ALIASES = Object.freeze({
  one: '1', two: '2', five: '5', ten: '10', fifteen: '15', twenty: '20',
  'twenty five': '25', thirty: '30', forty: '40',
  clb: 'climb',
  'flex mct': 'flex',
  'take off': 'takeoff',
  'f p a': 'fpa',
  'h d g': 'hdg',
  'r t o': 'rto',
  'are t o': 'rto',
  'our ta': 'rto',
  't r k': 'trk',
  'v s': 'vs',
});
const LEADING_FILLERS = new Set(['o', 'oh', 'uh', 'um']);
const LITERAL_ALIASES = Object.freeze({
  mach: new Set(['mack', 'mak', 'mock']),
  set: new Set(['said', 'seth']),
});
const DIGIT_SEQUENCE_TOKENS = new Set([
  'zero', 'oh', 'o', 'one', 'wun', 'two', 'too', 'three', 'tree',
  'four', 'fower', 'five', 'fife', 'six', 'seven', 'eight', 'nine', 'niner',
]);
const NUMERIC_SLOT_ALIASES = Object.freeze({
  // Observed Zipformer outputs for a clearly spoken "one zero". These are
  // accepted only inside a complete numeric command slot and only as part of
  // a three-or-more digit sequence.
  ones: 'one',
  nearer: 'zero',
});

function parseValue(text, input) {
  const valueText = normalizeVoiceText(text);
  if (!input || input.kind === 'none') return valueText ? null : {};
  if (!valueText) return null;
  if (input.kind === 'boolean') {
    if (TRUE_WORDS.has(valueText)) return { value: true };
    if (FALSE_WORDS.has(valueText)) return { value: false };
    return null;
  }
  if (input.kind === 'enum') {
    const normalized = ENUM_ALIASES[valueText] || valueText;
    const allowed = Array.isArray(input.values) ? input.values.map(String) : [];
    return allowed.includes(normalized) ? { value: normalized } : null;
  }
  if (input.kind === 'number') {
    const value = parseAviationNumber(valueText, {
      // Voice headings spoken digit-by-digit should use the normal three
      // digits. This prevents a clipped trailing zero from turning 270 into 27.
      minimumDigitSequenceLength: input.units === 'degrees' ? 3 : 0,
      units: input.units,
    });
    if (!Number.isFinite(value) || value < input.min || value > input.max) return null;
    const quotient = (value - input.min) / input.step;
    if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-7) return null;
    return { value };
  }
  return null;
}

function normalizedPatternParts(pattern) {
  const normalizedPattern = normalizeVoiceText(pattern.replace('{value}', ' flightfabricvalue '));
  const marker = 'flightfabricvalue';
  const markerIndex = normalizedPattern.indexOf(marker);
  if (markerIndex >= 0 && normalizedPattern.indexOf(marker, markerIndex + marker.length) >= 0) return null;
  return {
    markerIndex,
    normalizedPattern,
    prefix: markerIndex < 0 ? normalizedPattern : normalizedPattern.slice(0, markerIndex).trim(),
    suffix: markerIndex < 0 ? '' : normalizedPattern.slice(markerIndex + marker.length).trim(),
  };
}

function matchPattern(transcript, pattern, input) {
  const parts = normalizedPatternParts(pattern);
  if (!parts) return null;
  const { markerIndex, normalizedPattern, prefix, suffix } = parts;
  if (markerIndex < 0) return transcript === normalizedPattern ? parseValue('', input) : null;
  if (prefix && transcript !== prefix && !transcript.startsWith(`${prefix} `)) return null;
  if (suffix && transcript !== suffix && !transcript.endsWith(` ${suffix}`)) return null;
  const start = prefix ? prefix.length + 1 : 0;
  const end = suffix ? transcript.length - suffix.length - 1 : transcript.length;
  if (end < start) return null;
  const capturedValue = transcript.slice(start, end);
  // Flight levels are hundreds of feet. Keep that unit conversion in the
  // deterministic number parser even when the pattern, rather than the slot,
  // owns the spoken "flight level" prefix.
  const valueText = input?.kind === 'number'
    && input.units === 'feet'
    && (prefix === 'flight level' || prefix === 'set flight level')
    ? `flight level ${capturedValue}`
    : capturedValue;
  return parseValue(valueText, input);
}

function literalTokenMatches(actual, expected) {
  return actual === expected || LITERAL_ALIASES[expected]?.has(actual) === true;
}

function correctedNumericSlot(tokens, input) {
  if (input?.kind !== 'number' || tokens.length < 3) return null;
  let changed = false;
  const corrected = tokens.map((token, index) => {
    if (Object.prototype.hasOwnProperty.call(NUMERIC_SLOT_ALIASES, token)) {
      // "nearer" is a bounded trailing-zero repair, never a general number
      // word. Requiring it at the end avoids inventing digits in free speech.
      if (token === 'nearer' && index !== tokens.length - 1) return null;
      changed = true;
      return NUMERIC_SLOT_ALIASES[token];
    }
    if (DIGIT_SEQUENCE_TOKENS.has(token) || /^\d$/.test(token)) return token;
    return null;
  });
  return changed && corrected.every((token) => token !== null) ? corrected : null;
}

function correctedTranscriptForPattern(transcript, pattern, input) {
  const parts = normalizedPatternParts(pattern);
  if (!parts?.normalizedPattern) return null;
  const spoken = transcript.split(' ');
  const offset = spoken.length > 1 && LEADING_FILLERS.has(spoken[0]) ? 1 : 0;

  if (parts.markerIndex < 0) {
    const expected = parts.normalizedPattern.split(' ');
    if (spoken.length - offset !== expected.length) return null;
    if (!expected.every((token, index) => literalTokenMatches(spoken[offset + index], token))) return null;
    const corrected = expected.join(' ');
    return corrected === transcript ? null : corrected;
  }

  const prefix = parts.prefix ? parts.prefix.split(' ') : [];
  const suffix = parts.suffix ? parts.suffix.split(' ') : [];
  if (spoken.length - offset < prefix.length + suffix.length + 1) return null;
  if (!prefix.every((token, index) => literalTokenMatches(spoken[offset + index], token))) return null;
  const suffixOffset = spoken.length - suffix.length;
  if (!suffix.every((token, index) => literalTokenMatches(spoken[suffixOffset + index], token))) return null;

  let valueOffset = offset + prefix.length;
  // Permit the harmless connective only after a complete command prefix.
  if (prefix.length > 0 && spoken[valueOffset] === 'to') valueOffset += 1;
  if (valueOffset >= suffixOffset) return null;
  const spokenValue = spoken.slice(valueOffset, suffixOffset);
  const correctedValue = correctedNumericSlot(spokenValue, input) || spokenValue;
  const corrected = [...prefix, ...correctedValue, ...suffix].join(' ');
  return corrected === transcript ? null : corrected;
}

function commandList(catalogue) {
  if (Array.isArray(catalogue?.commands)) return catalogue.commands;
  if (catalogue?.commands && typeof catalogue.commands === 'object') return Object.values(catalogue.commands);
  return [];
}

export function collectVoiceHints(catalogue) {
  const hints = new Set();
  for (const command of commandList(catalogue)) {
    for (const hint of Array.isArray(command?.speech?.hints) ? command.speech.hints : []) {
      const normalized = String(hint || '').trim().toUpperCase();
      if (normalized) hints.add(normalized.slice(0, 80));
    }
  }
  return Object.freeze([...hints]);
}

export function interpretAircraftVoiceCommand(rawTranscript, catalogue) {
  const transcript = normalizeVoiceText(rawTranscript);
  if (!transcript) return Object.freeze({ ok: false, reason: 'empty', transcript });
  function collectMatches({ corrected = false } = {}) {
    const matches = [];
    const invalidCorrections = new Set();
    const seen = new Set();
    for (const command of commandList(catalogue)) {
      if (!command?.id || !Array.isArray(command?.speech?.patterns)) continue;
      for (const patternValue of command.speech.patterns) {
        const pattern = String(patternValue || '');
        const interpretedTranscript = corrected
          ? correctedTranscriptForPattern(transcript, pattern, command.input)
          : transcript;
        if (!interpretedTranscript) continue;
        const input = matchPattern(interpretedTranscript, pattern, command.input);
        if (input === null) {
          if (corrected && interpretedTranscript !== transcript) {
            invalidCorrections.add(interpretedTranscript);
          }
          continue;
        }
        const key = `${command.id}:${JSON.stringify(input)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(Object.freeze({
          commandId: command.id,
          input,
          label: command.label || command.id,
          ...(interpretedTranscript !== transcript ? { interpretedTranscript } : {}),
        }));
      }
    }
    return { invalidCorrections, matches };
  }

  // Never let a correction compete with a valid literal command. Only fall
  // back to the bounded aliases when the exact catalogue produces no match.
  const exact = collectMatches();
  const corrected = exact.matches.length === 0 ? collectMatches({ corrected: true }) : null;
  const matches = exact.matches.length > 0 ? exact.matches : corrected.matches;
  if (matches.length === 0) {
    if (corrected.invalidCorrections.size === 1) {
      return Object.freeze({
        ok: false,
        reason: 'invalid-value',
        transcript,
        interpretedTranscript: [...corrected.invalidCorrections][0],
      });
    }
    return Object.freeze({ ok: false, reason: 'unmatched', transcript });
  }
  if (matches.length > 1) return Object.freeze({ ok: false, reason: 'ambiguous', transcript, matches });
  return Object.freeze({ ok: true, transcript, ...matches[0] });
}
