'use strict';
const { resolveBackendRuntimeFile: runtime } = require('../backend-runtime-paths');
const { loadRuntimeReport } = require(runtime('aircraft/support/runtime-report.js'));
if (require.main === module) {
  console.log = console.error;
  console.info = console.error;
  try { process.stdout.write(JSON.stringify(loadRuntimeReport(process.argv[2]))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { loadRuntimeReport };
