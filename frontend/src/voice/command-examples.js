// Turns a catalogue's speech patterns into quotable "Try saying" phrases. The
// voice panel and the first-command card share this so they never disagree
// about the wording of a command.

function sampleSpeechValue(command = {}) {
  if (command.input?.units === 'squawk') return '0042';
  const commandId = String(command.id || '').toLowerCase();
  if (commandId.includes('heading')) return '270';
  if (commandId.includes('altitude')) return '10,000';
  if (commandId.includes('verticalspeed')) return '1,000';
  if (commandId.includes('speed')) return '250';
  if (commandId.includes('mach')) return '0.78';
  if (command.input?.kind === 'boolean') return 'on';
  if (command.input?.kind === 'enum') return String(command.input.values?.[0] || 'on');
  if (command.input?.kind === 'number') return String(command.input.min ?? 1);
  return '';
}

function speechExample(command = {}) {
  const pattern = command?.speech?.patterns?.find((candidate) => typeof candidate === 'string');
  if (!pattern) return '';
  const phrase = pattern.replace('{value}', sampleSpeechValue(command)).trim();
  return phrase ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}` : '';
}

function isNumberTarget(command, units, idFragment) {
  return command?.input?.kind === 'number'
    && command.input.units === units
    && String(command.id || '').toLowerCase().includes(idFragment);
}

function prioritizeAltitudeTarget(commands = []) {
  const altitudeIndex = commands.findIndex((command) => isNumberTarget(command, 'feet', 'altitude'));
  if (altitudeIndex <= 0) return commands;
  return [commands[altitudeIndex], ...commands.filter((_, index) => index !== altitudeIndex)];
}

export function voiceCommandExamples(commands = [], { limit = 3 } = {}) {
  return prioritizeAltitudeTarget(Array.isArray(commands) ? commands : [])
    .map(speechExample)
    .filter(Boolean)
    .slice(0, limit);
}

// The one phrase to quote to somebody who has never used voice: a heading
// target moves a knob they can see on the flight deck and is harmless on the
// ground, then an altitude target, then whatever the catalogue offers first.
export function firstVoiceCommandExample(commands = []) {
  const spoken = (Array.isArray(commands) ? commands : []).filter((command) => speechExample(command));
  const byId = (id) => spoken.find((command) => command.id === id);
  const chosen = byId('flightGuidance.heading.set')
    || spoken.find((command) => isNumberTarget(command, 'degrees', 'heading'))
    || byId('flightGuidance.altitude.set')
    || spoken.find((command) => isNumberTarget(command, 'feet', 'altitude'))
    || spoken[0]
    || null;
  if (!chosen) return null;
  return { commandId: chosen.id, phrase: speechExample(chosen) };
}
