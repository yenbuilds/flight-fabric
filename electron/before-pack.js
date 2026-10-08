'use strict';

const { provisionRuntime } = require('./scripts/provision-vc-runtime');

module.exports = async context => {
  if (context.electronPlatformName === 'win32') await provisionRuntime();
};
