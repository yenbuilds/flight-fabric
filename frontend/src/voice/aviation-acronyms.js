// Full letter names only: never expand a clipped acronym (AP is not APU),
// and never rewrite single words such as "you" or "eight" in numeric slots.
const LETTER_NAMES = Object.freeze({
  a: 'a|ay|aye', c: 'c|see', d: 'd|dee',
  f: 'f|ef|eff', g: 'g|gee', h: 'h|aitch|haitch',
  l: 'l|el|ell', m: 'm|em', n: 'n|en', o: 'o|oh',
  p: 'p|pee|pea', q: 'q|cue|queue', r: 'r|ar|are',
  s: 's|ess', t: 't|tee', u: 'u|you|ewe', v: 'v|vee', k: 'k|kay',
});
const ACRONYM_PATTERNS = Object.freeze([
  'apu', 'qnh', 'vhf', 'fpa', 'hdg', 'trk', 'rto', 'flch', 'pfds', 'pfd',
  'lnav', 'vnav', 'std', 'hpa', 'com', 'nav', 'ls', 'vs', 'nd', 'ap',
].map(acronym => ({
  acronym,
  pattern: new RegExp(`\\b${[...acronym].map(letter => `(?:${LETTER_NAMES[letter]})`).join('(?:\\. *| +)')}\\b\\.?`, 'g'),
})));

/** Accept already-normalized recognizer text, preserving every spoken letter. */
export function normalizeAviationAcronyms(text) {
  let normalized = text.replace(/\b(?:p|pee|pea)\.? +(?:f|ef|eff)\.? +(?:ds|dees|d's|dee's)\b/g, 'pfds');
  for (const { acronym, pattern } of ACRONYM_PATTERNS) normalized = normalized.replace(pattern, acronym);
  return normalized
    .replace(/\b(?:l|el|ell)\.? +nav\b/g, 'lnav')
    .replace(/\b(?:v|vee)\.? +nav\b/g, 'vnav');
}
