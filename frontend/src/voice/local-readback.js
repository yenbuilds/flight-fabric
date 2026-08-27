const MAX_READBACK_CHARS = 240;
const DIGIT_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four',
  'five', 'six', 'seven', 'eight', 'nine',
]);

function boundedText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, MAX_READBACK_CHARS);
}

function spokenDigits(value, width = 0) {
  const numeric = Math.round(Math.abs(Number(value)));
  if (!Number.isSafeInteger(numeric)) return '';
  return String(numeric).padStart(width, '0')
    .split('')
    .map((digit) => DIGIT_WORDS[Number(digit)])
    .join(' ');
}

function spokenAltitude(value) {
  const feet = Math.round(Math.abs(Number(value)) / 100) * 100;
  if (!Number.isSafeInteger(feet)) return '';
  if (feet === 0) return 'zero';
  if (feet < 1000) return `${spokenDigits(feet / 100)} hundred`;

  const thousands = Math.floor(feet / 1000);
  const hundreds = Math.floor((feet % 1000) / 100);
  return [
    `${spokenDigits(thousands)} thousand`,
    ...(hundreds > 0 ? [`${spokenDigits(hundreds)} hundred`] : []),
  ].join(' ');
}

export function formatAviationReadback(match = {}) {
  const commandId = String(match.commandId || '');
  const label = boundedText(match.label) || 'Command';
  const hasValue = Object.prototype.hasOwnProperty.call(match.input || {}, 'value');
  const value = match.input?.value;

  if (commandId === 'flightGuidance.heading.set') {
    return `Heading ${spokenDigits(value, 3)} set.`;
  }
  if (commandId === 'flightGuidance.course.setBoth') {
    return `Both courses ${spokenDigits(value, 3)} set.`;
  }
  if (commandId === 'flightGuidance.altitude.set') {
    return `Altitude ${spokenAltitude(value)} set.`;
  }
  if (commandId === 'flightGuidance.speed.set') {
    return `Speed ${spokenDigits(value)} set.`;
  }
  if (commandId === 'flightGuidance.mach.set') {
    const decimals = Number(value).toFixed(2).split('.')[1];
    return `Mach decimal ${spokenDigits(decimals, 2)} set.`;
  }
  if (commandId === 'flightGuidance.verticalSpeed.set') {
    const numericValue = Number(value);
    if (numericValue === 0) return 'Vertical speed zero set.';
    return `Vertical speed ${numericValue > 0 ? 'climb' : 'descend'} ${spokenAltitude(numericValue)} set.`;
  }
  if (commandId === 'radios.nav.setBothActive') {
    const [whole, decimals] = Number(value).toFixed(2).split('.');
    return `Nav radios ${spokenDigits(whole)} decimal ${spokenDigits(decimals, 2)} set.`;
  }
  if (commandId === 'surfaces.parkingBrake.set') {
    return `Parking brake ${value === true ? 'set' : 'released'}.`;
  }
  if (commandId === 'surfaces.spoilersArmed.set') {
    return `Ground spoilers ${value === true ? 'armed' : 'disarmed'}.`;
  }
  if (commandId === 'surfaces.flaps.adjust') {
    return `Flaps ${value === 'increase' ? 'increased' : 'decreased'} one detent.`;
  }
  if (commandId === 'surfaces.flaps.set') {
    return `Flaps ${String(value)} set.`;
  }
  if (commandId === 'configuration.lighting.cockpit') {
    return `Cockpit lighting ${String(value)} percent set.`;
  }
  if (commandId === 'configuration.lights.takeoff') {
    return 'Takeoff lights set.';
  }
  if (typeof value === 'boolean') return `${label} ${value ? 'on' : 'off'}.`;
  if (hasValue) return `${label} ${String(value)}.`;
  if (commandId.endsWith('.engage')) return `${label} engaged.`;
  return `${label} command complete.`;
}

export function createLocalReadback({ globalRef = globalThis } = {}) {
  const api = globalRef?.electronAPI?.voice;
  let available = typeof api?.speakReadback === 'function';

  function cancel() {
    if (typeof api?.cancelReadback !== 'function') return false;
    try {
      Promise.resolve(api.cancelReadback()).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async function prepare() {
    if (typeof api?.getReadbackInfo !== 'function') return available;
    try {
      const info = await api.getReadbackInfo();
      available = info?.available === true && info?.local === true;
    } catch {
      available = false;
    }
    return available;
  }

  function speak(value) {
    const text = boundedText(value);
    if (!text || !available || typeof api?.speakReadback !== 'function') return false;
    try {
      Promise.resolve(api.speakReadback(text)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ cancel, prepare, speak });
}
