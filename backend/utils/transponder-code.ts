/** Logical code is decimal digits; SimConnect transports those digits in BCO16. */
export function encodeSquawkBco16(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 7777) return null;
  const digits = String(value).padStart(4, '0');
  return /^[0-7]{4}$/.test(digits) ? Number.parseInt(digits, 16) : null;
}

export function decodeSquawkBco16(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0x7777) return undefined;
  const digits = value.toString(16).padStart(4, '0');
  return /^[0-7]{4}$/.test(digits) ? Number(digits) : undefined;
}
