// MobiFlight's Command ClientData area is a fixed 1024-byte C string buffer.
// Leave one byte for the NUL terminator used by the WASM module before the
// command is converted to std::string.
export const MOBIFLIGHT_MESSAGE_SIZE = 1024;
export const MOBIFLIGHT_EXECUTION_PREFIX = 'MF.SimVars.Set.';
export const MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH = MOBIFLIGHT_MESSAGE_SIZE
  - MOBIFLIGHT_EXECUTION_PREFIX.length
  - 1;

export function isSafeMobiFlightCalculatorCode(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MOBIFLIGHT_MAX_CALCULATOR_CODE_LENGTH
    && /^[\x20-\x7e]+$/.test(value);
}
