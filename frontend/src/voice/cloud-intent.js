import '../../../shared/voice-intent.js';

export const { createContext, validateIntent, sameContext, feedback } = globalThis.FlightFabricVoiceIntent;

export function cloudSelectionKey(selection = {}) {
  return JSON.stringify([selection?.providerId || 'openai', selection?.modelId || '', selection?.revision ?? 0]);
}
