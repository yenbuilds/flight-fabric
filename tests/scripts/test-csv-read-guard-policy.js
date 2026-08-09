#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
}

function caseBody(source, messageType) {
  const marker = `case '${messageType}': {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${messageType} handler not found`);
  const nextCase = source.indexOf("\n    case '", start + marker.length);
  return nextCase === -1 ? source.slice(start) : source.slice(start, nextCase);
}

function sectionBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} section not found`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} section boundary not found`);
  return source.slice(start, end);
}

function assertBefore(body, before, after, label) {
  const beforeIndex = body.indexOf(before);
  const afterIndex = body.indexOf(after);
  assert.notEqual(beforeIndex, -1, `${label}: missing ${before}`);
  assert.notEqual(afterIndex, -1, `${label}: missing ${after}`);
  assert(
    beforeIndex < afterIndex,
    `${label}: expected ${before} before ${after}`,
  );
}

const clientHandler = read('backend/core/client-message-handler.ts');
const flightCsvStore = read('backend/flight-recording/flight-csv-store.ts');

assert(
  clientHandler.includes("require('../flight-recording/flight-csv-store')"),
  'client-message-handler must use the guarded flight CSV store',
);

assert(
  flightCsvStore.includes("require('./csv-read-guard')"),
  'flight-csv-store must use the shared CSV read guard',
);

assert(
  !clientHandler.includes("require('../flight-recording/csv-read-guard')"),
  'client-message-handler should not bypass flight-csv-store by importing csv-read-guard directly',
);

for (const forbidden of [
  'function resolveCsvPath',
  'function compareCsvPath',
  'function getActiveCsvPath',
  'function isActiveCsvPath',
  'function flushActiveCsvBeforeRead',
  'function flushActiveCsvBeforeList',
  "require('../events/timeline-generator')",
  "require('../events/timeline-events')",
  'getLandingsFromCSVs',
  'computeStatsFromEntries',
  'generateFromCSV',
  'listCSVFlights',
  'flushActiveCsvBeforeDirectoryRead',
]) {
  assert(
    !clientHandler.includes(forbidden),
    `client-message-handler should not bypass the guarded CSV store with: ${forbidden}`,
  );
}

const timeline = caseBody(clientHandler, 'requestTimeline');
assert(
  timeline.includes('flightCsvStore.generateTimelineFromFile') &&
  timeline.includes('flightCsvStore.generateTimelineForFlightId'),
  'requestTimeline must use flightCsvStore for both filePath and flightId reads',
);

const timelineList = caseBody(clientHandler, 'requestTimelineList');
assert(
  timelineList.includes('flightCsvStore.listFlights'),
  'requestTimelineList must use flightCsvStore.listFlights',
);

const logbook = caseBody(clientHandler, 'requestLogbook');
assert(
  logbook.includes('flightCsvStore.getLogbook'),
  'requestLogbook must use flightCsvStore.getLogbook',
);

const deleteFlightCsv = caseBody(clientHandler, 'deleteFlightCsv');
assert(
  deleteFlightCsv.includes('flightCsvStore.deleteFlightCsv'),
  'deleteFlightCsv must use flightCsvStore.deleteFlightCsv',
);

const storeTimelineFile = sectionBody(
  flightCsvStore,
  'async function generateTimelineFromFile',
  'async function generateTimelineForFlightId',
);
assertBefore(
  storeTimelineFile,
  'flushActiveCsvBeforeRead',
  'timelineGenerator.generateFromCSV',
  'flight-csv-store timeline reads',
);

const storeList = sectionBody(
  flightCsvStore,
  'async function listFlights',
  'function deleteFlightCsv',
);
assertBefore(
  storeList,
  'flushActiveCsvBeforeDirectoryRead',
  'timelineGenerator.listCSVFlights',
  'flight-csv-store timeline list',
);

const storeLogbook = sectionBody(
  flightCsvStore,
  'async function getLogbook',
  'function getHistoryIndexStatus',
);
assertBefore(
  storeLogbook,
  'flushActiveCsvBeforeDirectoryRead',
  'getLandingsFromCSVs',
  'flight-csv-store logbook',
);

assert(
  storeLogbook.includes('bypassCachePaths'),
  'flight-csv-store logbook reads must bypass active-file cache after flushing',
);

console.log('CSV read/store policy: 1 passed, 0 failed');
