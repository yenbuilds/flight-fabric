const DIGITS = Object.freeze({
  zero: 0, oh: 0, o: 0,
  one: 1, wun: 1,
  two: 2, too: 2,
  three: 3, tree: 3,
  four: 4, fower: 4,
  five: 5, fife: 5,
  six: 6, seven: 7, eight: 8,
  nine: 9, niner: 9,
});
const SMALL = Object.freeze({
  ...DIGITS,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});

const UNIT_SUFFIXES = Object.freeze({
  degrees: Object.freeze([['degree'], ['degrees']]),
  feet: Object.freeze([['foot'], ['feet']]),
  'feet-per-minute': Object.freeze([
    ['foot', 'per', 'minute'],
    ['feet', 'per', 'minute'],
    ['fpm'],
  ]),
  knots: Object.freeze([['knot'], ['knots']]),
  mach: Object.freeze([]),
  megahertz: Object.freeze([['megahertz'], ['mhz']]),
  percent: Object.freeze([['percent'], ['per', 'cent']]),
});

function digitValue(token) {
  if (Object.prototype.hasOwnProperty.call(DIGITS, token)) return DIGITS[token];
  return /^\d$/.test(token) ? Number(token) : null;
}

// Kept shared with the command interpreter so bounded recognition repairs can
// validate only the numeric words while preserving an explicitly spoken unit.
export function stripMatchingUnitSuffix(tokens, units) {
  const suffixes = UNIT_SUFFIXES[units] || [];
  for (const suffix of suffixes) {
    if (tokens.length < suffix.length) continue;
    const offset = tokens.length - suffix.length;
    if (suffix.every((token, index) => tokens[offset + index] === token)) {
      return tokens.slice(0, offset);
    }
  }
  return tokens;
}

export function normalizeVoiceText(value) {
  return String(value ?? '')
    .toLowerCase()
    // Keep recognizer possessives as one token so a bounded numeric-slot
    // correction can distinguish "one's" -> "ones" from an arbitrary "s".
    .replace(/([a-z0-9])['’]s\b/g, '$1s')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSubThousand(tokens) {
  if (tokens.length === 0) return null;
  if (tokens.every((token) => digitValue(token) !== null)) {
    return Number(tokens.map((token) => digitValue(token)).join(''));
  }
  // Controllers and pilots commonly group three-digit values as a leading
  // digit followed by a two-digit cardinal: "one twenty", "two fifty", or
  // "one twenty five". Treat those as 120, 250, and 125 respectively instead
  // of adding the tokens and silently producing 21, 52, and 26.
  if (
    (tokens.length === 2 || tokens.length === 3)
    && digitValue(tokens[0]) !== null
    && digitValue(tokens[0]) > 0
    && (
      (Object.prototype.hasOwnProperty.call(SMALL, tokens[1]) && SMALL[tokens[1]] >= 10)
      || /^\d{2}$/.test(tokens[1])
    )
    && (tokens.length === 2 || digitValue(tokens[2]) !== null)
  ) {
    const middle = Object.prototype.hasOwnProperty.call(SMALL, tokens[1])
      ? SMALL[tokens[1]]
      : Number(tokens[1]);
    return digitValue(tokens[0]) * 100
      + middle
      + (tokens.length === 3 ? digitValue(tokens[2]) : 0);
  }
  let current = 0;
  let consumed = false;
  for (const token of tokens) {
    if (token === 'and') continue;
    if (/^\d+$/.test(token)) {
      current += Number(token);
      consumed = true;
    } else if (Object.prototype.hasOwnProperty.call(SMALL, token)) {
      current += SMALL[token];
      consumed = true;
    } else if (token === 'hundred') {
      current = (current || 1) * 100;
      consumed = true;
    } else return null;
  }
  return consumed ? current : null;
}

function parsePlainInteger(tokens) {
  const thousandIndex = tokens.indexOf('thousand');
  if (thousandIndex < 0) return parseSubThousand(tokens);
  if (tokens.indexOf('thousand', thousandIndex + 1) >= 0) return null;
  const major = thousandIndex === 0 ? 1 : parseSubThousand(tokens.slice(0, thousandIndex));
  const minorTokens = tokens.slice(thousandIndex + 1);
  const minor = minorTokens.length === 0 ? 0 : parseSubThousand(minorTokens);
  return major == null || minor == null ? null : major * 1000 + minor;
}

function parseDecimalDigits(tokens) {
  if (tokens.length === 0) return null;
  let digits = '';
  for (const token of tokens) {
    if (/^\d+$/.test(token)) digits += token;
    else if (Object.prototype.hasOwnProperty.call(DIGITS, token)) digits += String(DIGITS[token]);
    else return null;
  }
  return digits ? Number(`0.${digits}`) : null;
}

export function parseAviationNumber(value, { minimumDigitSequenceLength = 0, units = '' } = {}) {
  const normalized = normalizeVoiceText(value);
  if (!normalized) return null;
  let tokens = stripMatchingUnitSuffix(normalized.split(' '), units);
  if (tokens.length === 0) return null;
  let sign = 1;
  if (['minus', 'negative'].includes(tokens[0])) {
    sign = -1;
    tokens = tokens.slice(1);
  } else if (tokens[0] === 'plus') tokens = tokens.slice(1);

  let flightLevel = false;
  if (tokens[0] === 'flight' && tokens[1] === 'level') {
    flightLevel = true;
    tokens = tokens.slice(2);
  }
  if (tokens.length === 0) return null;

  // A short digit-by-digit heading is particularly likely to be a clipped
  // utterance ("two seven" when "two seven zero" was intended). Callers can
  // require the normal three-digit aviation form without rejecting cardinal
  // forms such as "twenty seven" or numeric input such as "27".
  if (
    Number.isSafeInteger(minimumDigitSequenceLength)
    && minimumDigitSequenceLength > 0
    && tokens.length < minimumDigitSequenceLength
    && tokens.every((token) => digitValue(token) !== null)
  ) return null;

  const joined = tokens.join(' ');
  if (/^\d+(\.\d+)?$/.test(joined)) {
    const numeric = Number(joined) * sign;
    return flightLevel ? numeric * 100 : numeric;
  }

  const pointIndex = tokens.findIndex((token) => token === 'point' || token === 'decimal');
  let numeric;
  if (pointIndex >= 0) {
    const integerTokens = tokens.slice(0, pointIndex);
    const integerPart = integerTokens.length === 0 ? 0 : parsePlainInteger(integerTokens);
    const decimalPart = parseDecimalDigits(tokens.slice(pointIndex + 1));
    if (integerPart == null || decimalPart == null) return null;
    numeric = integerPart + decimalPart;
  } else {
    numeric = parsePlainInteger(tokens);
  }
  if (numeric == null || !Number.isFinite(numeric)) return null;
  if (flightLevel && units !== 'mach') numeric *= 100;
  return numeric * sign;
}
