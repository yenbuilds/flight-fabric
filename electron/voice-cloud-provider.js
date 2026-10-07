'use strict';

const openai = require('./voice-cloud-openai');
const gemini = require('./voice-cloud-gemini');

// Reviewed API/model combinations. Adapters propose intents; they cannot dispatch.
const providers = Object.freeze({
  openai: Object.freeze({ id: 'openai', label: 'OpenAI', interpretAudio: openai.interpretAudio,
    models: Object.freeze([Object.freeze({ id: openai.MODEL, label: 'GPT Realtime 2.1 Mini' })]) }),
  gemini: Object.freeze({ id: 'gemini', label: 'Google Gemini', interpretAudio: gemini.interpretAudio,
    models: Object.freeze([Object.freeze({ id: gemini.MODEL, label: 'Gemini 3.8 Flash' })]) }),
});
function getProvider(id) {
  if (typeof id !== 'string' || !Object.hasOwn(providers, id)) throw new Error('Choose a supported cloud voice provider.');
  return providers[id];
}
function resolveSelection(value = { providerId: 'openai' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['providerId', 'modelId'].includes(key))) throw new Error('Invalid cloud voice selection.');
  const provider = getProvider(value.providerId);
  const modelId = value.modelId === undefined ? provider.models[0].id : value.modelId;
  if (!provider.models.some(model => model.id === modelId)) throw new Error('Choose a supported cloud voice model.');
  return Object.freeze({ providerId: provider.id, modelId });
}
function listProviders() {
  return Object.values(providers).map(({ id, label, models }) => ({ id, label, models: models.map(model => ({ ...model })) }));
}
module.exports = { getProvider, listProviders, resolveSelection };
