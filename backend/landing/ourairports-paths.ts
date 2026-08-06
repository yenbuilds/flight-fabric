'use strict';

const path = require('path') as typeof import('path');

const PRIMARY_DATA_DIR = path.join(__dirname, '..', 'data-sync', 'data', 'ourairports');

function resolveOurAirportsFile(fileName: string): string {
  return path.join(PRIMARY_DATA_DIR, fileName);
}

module.exports = {
  resolveOurAirportsFile,
};

export {};
