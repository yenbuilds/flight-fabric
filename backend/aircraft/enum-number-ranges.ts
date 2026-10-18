/** Validate optional, disjoint numeric intervals used by an enum decoder. */
export function hasValidEnumNumberRanges(decoder: Record<string, any>): boolean {
  if (!Object.hasOwn(decoder, 'numberRanges')) return true;
  const ranges = decoder.numberRanges;
  if (decoder.type !== 'enum' || !Array.isArray(ranges) || ranges.length < 1 || ranges.length > 16) return false;
  if (!decoder.values || typeof decoder.values !== 'object' || Array.isArray(decoder.values)) return false;
  const exactNumbers = Object.keys(decoder.values).filter(key => key.trim() !== '' && Number.isFinite(Number(key))).map(Number);
  return ranges.every((range, index) => range && typeof range === 'object'
    && Object.keys(range).every(key => ['min', 'max', 'value'].includes(key))
    && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max
    && ['string', 'number', 'boolean'].includes(typeof range.value)
    && (typeof range.value !== 'number' || Number.isFinite(range.value))
    && !exactNumbers.some(value => value >= range.min && value <= range.max)
    && !ranges.slice(0, index).some(previous => previous && range.min <= previous.max && range.max >= previous.min));
}
