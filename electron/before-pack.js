'use strict';

const { provisionRuntime } = require('./scripts/provision-vc-runtime');
const { KOKORO_MODEL } = require('./voice-model-manifest');
const { verifyKokoroModel } = require('./voice-model-integrity');
const path = require('node:path');

module.exports = async context => {
  if (context.electronPlatformName === 'win32') await provisionRuntime();
  await verifyKokoroModel(path.join(__dirname, 'resources/models', KOKORO_MODEL.id));
  const resource = context.packager.config.extraResources.find(entry => entry.to === `models/${KOKORO_MODEL.id}`);
  if (!resource) throw new Error('Kokoro voice pack is missing from packaging configuration');
  resource.filter = KOKORO_MODEL.files.map(entry => entry.name);
};
