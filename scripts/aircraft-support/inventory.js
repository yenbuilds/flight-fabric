'use strict';
const { resolveBackendRuntimeFile: runtime } = require('../backend-runtime-paths');
module.exports = require(runtime('aircraft/support/inventory.js'));
