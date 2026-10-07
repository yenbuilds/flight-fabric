/* Pure cloud voice contract, shared by desktop transport and browser validation. */
(function (root) {
  'use strict';
  const VERSION = 1;
  const MAX_CONTEXT_CHARS = 60000;
  const INITIAL_COMMANDS = new Set([
    'surfaces.gear.set', 'surfaces.flaps.set',
    'flightGuidance.heading.set', 'flightGuidance.altitude.set', 'flightGuidance.speed.set',
    'lights.landing.set', 'lights.taxi.set', 'lights.nav.set', 'lights.beacon.set',
    'lights.strobe.set', 'lights.runwayTurnoff.set', 'lights.landingNose.set',
    'lights.strobeMode.set', 'lights.navLogoMode.set', 'lights.noseMode.set',
    'lights.turnoffLeft.set', 'lights.turnoffRight.set',
    'lights.landingLeft.set', 'lights.landingRight.set',
  ]);
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, keys) => plain(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  function boundedText(value, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('Invalid cloud voice context.');
    }
    return value;
  }
  function inputContract(input) {
    if (!plain(input)) throw new Error('Invalid command input contract.');
    if (input.kind === 'none' || input.kind === 'boolean') return { kind: input.kind };
    if (input.kind === 'enum' && Array.isArray(input.values) && input.values.length > 0 && input.values.length <= 64) {
      const values = input.values.map(value => boundedText(value, 64));
      if (new Set(values).size !== values.length) throw new Error('Duplicate command values.');
      return { kind: 'enum', values };
    }
    if (input.kind === 'number' && [input.min, input.max, input.step].every(Number.isFinite)
        && input.min <= input.max && input.step > 0) {
      return { kind: 'number', min: input.min, max: input.max, step: input.step, units: boundedText(input.units, 40) };
    }
    throw new Error('Invalid command input contract.');
  }
  // Only public semantic fields cross this boundary. Never copy adapter recipes.
  function createContext(catalogue, queries = []) {
    const commands = (Array.isArray(catalogue?.commands) ? catalogue.commands : Object.values(catalogue?.commands || {}))
      .filter(command => INITIAL_COMMANDS.has(command?.id))
      .map(command => ({
        id: command.id, label: boundedText(command.label, 120),
        description: typeof command.description === 'string' ? command.description.slice(0, 500) : '',
        input: inputContract(command.input),
      })).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(commands.map(command => command.id)).size !== commands.length) throw new Error('Duplicate command IDs.');
    const context = {
      version: VERSION,
      profileKey: boundedText(catalogue?.profileKey || 'voice-test', 200),
      profileRevision: Number.isSafeInteger(catalogue?.profileRevision) ? catalogue.profileRevision : null,
      configurationId: boundedText(catalogue?.configurationId || 'voice-test', 120),
      commands,
      queries: [...new Set(queries)].sort().map(phrase => boundedText(phrase, 160)),
    };
    if (context.queries.length > 64 || JSON.stringify(context).length > MAX_CONTEXT_CHARS) throw new Error('Cloud voice context is too large.');
    return context;
  }
  function validateContext(context) {
    if (!exactKeys(context, ['version', 'profileKey', 'profileRevision', 'configurationId', 'commands', 'queries'])
        || context.version !== VERSION || !Array.isArray(context.commands) || context.commands.length > INITIAL_COMMANDS.size
        || !Array.isArray(context.queries) || context.queries.length > 64
        || (context.profileRevision !== null && (!Number.isSafeInteger(context.profileRevision) || context.profileRevision < 0))) {
      throw new Error('Invalid cloud voice context.');
    }
    const normalized = createContext(context, context.queries);
    if (JSON.stringify(normalized) !== JSON.stringify(context)) throw new Error('Invalid cloud voice context.');
    return normalized;
  }
  function validInput(contract, input) {
    if (contract.kind === 'none') return exactKeys(input, []);
    if (!exactKeys(input, ['value'])) return false;
    const value = input.value;
    if (contract.kind === 'boolean') return typeof value === 'boolean';
    if (contract.kind === 'enum') return typeof value === 'string' && contract.values.includes(value);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < contract.min || value > contract.max) return false;
    const steps = (value - contract.min) / contract.step;
    return Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) < 1e-7;
  }
  function validateIntent(intent, context) {
    if (!plain(intent)) throw new Error('Cloud voice returned an invalid result.');
    if (intent.decision === 'command' && exactKeys(intent, ['decision', 'commandId', 'input'])) {
      const command = context.commands.find(command => command.id === intent.commandId);
      if (command && validInput(command.input, intent.input)) return { ...intent, input: { ...intent.input } };
    } else if (intent.decision === 'query' && exactKeys(intent, ['decision', 'query']) && context.queries.includes(intent.query)) {
      return { ...intent };
    } else if (['clarify', 'no-action'].includes(intent.decision) && exactKeys(intent, ['decision', 'reason'])
        && ['unclear', 'unsupported', 'not-a-request', 'multiple-requests', 'incomplete'].includes(intent.reason)) {
      return { ...intent };
    }
    throw new Error('Cloud voice returned an unsupported command or invalid value.');
  }
  function sameContext(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function feedback(intent) {
    const messages = {
      unclear: 'Please repeat the complete request, including the control and target.',
      unsupported: 'That request is not available in cloud voice for this aircraft.',
      'not-a-request': 'No aircraft command was requested.',
      'multiple-requests': 'Please give one command at a time. Nothing was executed.',
      incomplete: 'The request was incomplete. Please repeat the complete command.',
    };
    return messages[intent.reason] || 'No command was executed.';
  }
  const api = Object.freeze({ createContext, validateContext, validateIntent, sameContext, feedback });
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FlightFabricVoiceIntent = api;
})(globalThis);
