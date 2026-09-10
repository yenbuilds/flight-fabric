export function parseSquawk(value) {
  return typeof value === 'string' && /^[0-7]{4}$/.test(value.trim()) ? Number(value.trim()) : null;
}

export function formatSquawk(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 7777) return '----';
  const digits = String(value).padStart(4, '0');
  return parseSquawk(digits) === null ? '----' : digits;
}

export function parseSpokenSquawk(text) {
  const digits = { zero: '0', oh: '0', one: '1', wun: '1', two: '2', three: '3', tree: '3',
    four: '4', fower: '4', five: '5', fife: '5', six: '6', seven: '7' };
  if (/^[0-7]{4}$/.test(text)) return Number(text);
  const tokens = text.split(' ');
  if (tokens.length !== 4) return null;
  return parseSquawk(tokens.map((token) => digits[token] ?? (/^[0-7]$/.test(token) ? token : '?')).join(''));
}
