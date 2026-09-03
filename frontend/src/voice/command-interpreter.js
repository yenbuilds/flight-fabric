import {
  normalizeVoiceText,
  parseAviationNumber,
  stripMatchingUnitSuffix,
} from './aviation-number-parser.js';

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
function buildNumericSlotAliases(aliases) {
  for (const [heard, replacement] of Object.entries(aliases)) {
    // A correction must never override a word that is already a valid number.
    // For example, accepting `eighty: 'eight'` would silently turn 80 into 8.
    if (parseAviationNumber(heard) !== null) {
      throw new Error(`Unsafe numeric voice alias: ${heard}`);
    }
    const replacementValue = parseAviationNumber(replacement);
    if (!Number.isInteger(replacementValue) || replacementValue < 0 || replacementValue > 9) {
      throw new Error(`Invalid numeric voice alias replacement: ${replacement}`);
    }
  }
  return Object.freeze({ ...aliases });
}

const NUMERIC_SLOT_ALIASES = buildNumericSlotAliases({
  // Observed Zipformer outputs for clearly spoken digits. These are accepted
  // only inside a complete numeric command slot and only as part of a
  // three-or-more digit sequence.
  ones: 'one',
  nearer: 'zero',
  to: 'two',
  zer: 'zero',
});
const TRAILING_ZERO_ALIASES = new Set(['nearer', 'zer']);
const GROUPED_TENS_TOKENS = new Set([
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
]);

function isThreeDigitSequence(valueText) {
  const tokens = valueText.split(' ');
  if (/^\d{3}$/.test(valueText)) return true;
  if (tokens.length === 3
      && tokens.every((token) => DIGIT_SEQUENCE_TOKENS.has(token) || /^\d$/.test(token))) {
    return true;
  }
  // The recognizer can group the last two digits into a cardinal, for example
  // "one fifty" or "one twenty five". Recognize only the same bounded
  // three-digit form already supported by parseAviationNumber. Explicit
  // cardinals such as "one hundred fifty" and explicit units remain literal.
  if (tokens.length < 2 || tokens.length > 3) return false;
  const leadingDigit = parseAviationNumber(tokens[0]);
  const groupedTail = parseAviationNumber(tokens.slice(1).join(' '));
  const groupedValue = parseAviationNumber(valueText);
  return Number.isInteger(leadingDigit)
    && leadingDigit >= 1
    && leadingDigit <= 9
    && Number.isInteger(groupedTail)
    && groupedTail >= 10
    && groupedTail <= 99
    && groupedValue === leadingDigit * 100 + groupedTail;
}

function parseValue(text, input, { allowFlightLevelShorthand = false } = {}) {
  const valueText = normalizeVoiceText(text);
  if (!input || input.kind === 'none') return valueText ? null : {};
  if (!valueText) return null;
  if (input.kind === 'boolean') {
    if (TRUE_WORDS.has(valueText)) return { value: true };
    if (FALSE_WORDS.has(valueText)) return { value: false };
    return null;
  }
  if (input.kind === 'enum') {
    const allowed = Array.isArray(input.values) ? input.values.map(String) : [];
    // A literal catalogue value always wins. Aliases are fallback spellings,
    // not permission to reinterpret an already-valid value.
    if (allowed.includes(valueText)) return { value: valueText };
    const normalized = ENUM_ALIASES[valueText];
    return allowed.includes(normalized) ? { value: normalized } : null;
  }
  if (input.kind === 'number') {
    const parsedValue = parseAviationNumber(valueText, {
      // Voice headings spoken digit-by-digit should use the normal three
      // digits. This prevents a clipped trailing zero from turning 270 into 27.
      minimumDigitSequenceLength: input.units === 'degrees' ? 3 : 0,
      units: input.units,
    });
    // In aviation phraseology a three-digit altitude target is a flight level:
    // "altitude one two zero" or "altitude 120" means 12,000 feet. Explicit
    // cardinal targets such as "one hundred" keep their literal values.
    const value = Number.isFinite(parsedValue)
      && allowFlightLevelShorthand
      && isThreeDigitSequence(valueText)
      ? parsedValue * 100
      : parsedValue;
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
  const allowFlightLevelShorthand = input?.kind === 'number'
    && input.units === 'feet'
    && /(?:^| )(?:altitude|flight level)(?: |$)/.test(prefix);
  return parseValue(valueText, input, { allowFlightLevelShorthand });
}

function literalTokenMatches(actual, expected) {
  return actual === expected || LITERAL_ALIASES[expected]?.has(actual) === true;
}

function correctedNumericSlot(tokens, input) {
  if (input?.kind !== 'number') return null;
  const numericTokens = stripMatchingUnitSuffix(tokens, input.units);
  if (numericTokens.length < 3) return null;
  const unitSuffix = tokens.slice(numericTokens.length);
  const groupedTensWithTrailingZeroRepair = numericTokens.length === 3
    && (DIGIT_SEQUENCE_TOKENS.has(numericTokens[0]) || /^\d$/.test(numericTokens[0]))
    && GROUPED_TENS_TOKENS.has(numericTokens[1])
    && TRAILING_ZERO_ALIASES.has(numericTokens[2]);
  let changed = false;
  const corrected = numericTokens.map((token, index) => {
    if (Object.prototype.hasOwnProperty.call(NUMERIC_SLOT_ALIASES, token)) {
      // Clipped or badly decoded zero words are bounded trailing-zero repairs,
      // never general number words. Requiring them at the end avoids inventing
      // digits in free speech.
      if (TRAILING_ZERO_ALIASES.has(token) && index !== numericTokens.length - 1) return null;
      changed = true;
      return NUMERIC_SLOT_ALIASES[token];
    }
    // Preserve a real tens word. The aviation parser already understands
    // "two eighty zero" as 280, so only the clipped trailing zero needs repair.
    if (groupedTensWithTrailingZeroRepair && index === 1) return token;
    if (DIGIT_SEQUENCE_TOKENS.has(token) || /^\d$/.test(token)) return token;
    return null;
  });
  return changed && corrected.every((token) => token !== null)
    ? [...corrected, ...unitSuffix]
    : null;
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

function formatChoices(values) {
  const quoted = values.map((value) => `“${value}”`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted.at(-1)}`;
}

// Explain an incomplete literal command without choosing the missing words.
// This intentionally ignores value slots: numbers, modes, and other command
// values must be repeated by the pilot, never inferred by retry guidance.
export function incompleteVoiceCommandPrompt(rawTranscript, catalogue) {
  const transcript = normalizeVoiceText(rawTranscript);
  if (!transcript) return '';
  const completions = new Set();
  for (const command of commandList(catalogue)) {
    for (const patternValue of Array.isArray(command?.speech?.patterns) ? command.speech.patterns : []) {
      const parts = normalizedPatternParts(String(patternValue || ''));
      if (!parts?.normalizedPattern || parts.markerIndex >= 0) continue;
      if (!parts.normalizedPattern.startsWith(`${transcript} `)) continue;
      const completion = parts.normalizedPattern.slice(transcript.length + 1);
      if (completion && completion.split(' ').length <= 3) completions.add(completion);
    }
  }
  if (completions.size === 0 || completions.size > 4) return '';
  return `Please finish with ${formatChoices([...completions])}.`;
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
