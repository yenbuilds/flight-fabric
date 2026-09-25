'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyFlightFabricBackendIdentity,
  hasSameWindowsOwner,
  isSameWindowsProcessIdentity,
} = require('./backend-process-identity');

const trustedLaunch = {
  backendScript: 'C:\\FlightFabric App\\resources\\backend\\core\\simbridge.js',
  executablePath: 'C:\\FlightFabric App\\FlightFabric.exe',
};
const identity = {
  pid: 4242,
  creationToken: '638880000000000000',
  ownerSid: 'S-1-5-21-1000',
};
const entry = `"${trustedLaunch.backendScript}"`;
const classify = (commandLine, expected = trustedLaunch) => (
  classifyFlightFabricBackendIdentity({ ...identity, commandLine }, expected)
);

test('recognizes the exact installed Electron backend with quoted paths', () => {
  assert.equal(classify(`"${trustedLaunch.executablePath}" ${entry} --ws-port 8765 --ff-launch-owner=electron`), 'electron');
  assert.equal(classify('"c:/flightfabric app/flightfabric.exe" "c:/flightfabric app/resources/backend/core/simbridge.js" "--ff-launch-owner=electron"'), 'electron');
});

test('recognizes Node launches of the same backend, including a direct legacy launch', () => {
  for (const runtime of ['node', 'node.exe', '"C:\\Program Files\\nodejs\\node.exe"']) {
    assert.equal(classify(`${runtime} ${entry} --ff-launch-owner=batch`), 'stoppable');
    assert.equal(classify(`${runtime} ${entry}`), 'stoppable');
  }
});

test('never treats another script or a path mentioned in an argument as the backend', () => {
  for (const commandLine of [
    'node C:\\unrelated\\core\\simbridge.js',
    `node unrelated.js --log=${entry}`,
    `node -e ${entry}`,
    `node --require ${entry} unrelated.js`,
    `node ${entry}.backup`,
    'node core\\simbridge.js',
    'node C:\\FlightFabric App\\resources\\backend\\core\\simbridge.js',
    `notepad.exe ${entry}`,
    `"C:\\Another App\\FlightFabric.exe" ${entry} --ff-launch-owner=electron`,
  ]) assert.equal(classify(commandLine), 'unverified', commandLine);
});

test('missing trusted configuration and ambiguous Windows quoting fail closed', () => {
  assert.equal(classify(`node ${entry}`, {}), 'unverified');
  for (const commandLine of [
    `node "${trustedLaunch.backendScript}`,
    `node ${entry}suffix`,
    `node ${entry} "unfinished`,
    `node ${entry} "escaped\\" quote"`,
    `node ${entry}\n--ff-launch-owner=electron`,
    'node "C:\\FlightFabric App\\resources\\backend\\..\\backend\\core\\simbridge.js"',
    'node "\\FlightFabric App\\resources\\backend\\core\\simbridge.js"',
  ]) assert.equal(classify(commandLine), 'unverified', commandLine);
});

test('launch ownership must be an exact single recognized argument', () => {
  for (const ownerArgs of [
    '--ff-launch-owner=electron-backup',
    '--ff-launch-owner=batch-backup',
    '--ff-launch-owner=unknown',
    '--ff-launch-owner electron',
    '--FF-LAUNCH-OWNER=electron',
    '--ff-launch-owner=electron --ff-launch-owner=batch',
    '--ff-launch-owner=electron --ff-launch-owner=electron',
  ]) assert.equal(classify(`node ${entry} ${ownerArgs}`), 'unverified', ownerArgs);
});

test('process identity and Windows owner must still match immediately before cleanup', () => {
  const initial = { ...identity, commandLine: `node ${entry} --ff-launch-owner=batch` };
  assert.equal(hasSameWindowsOwner(initial, identity.ownerSid), true);
  assert.equal(hasSameWindowsOwner(initial, 'S-1-5-21-2000'), false);
  assert.equal(isSameWindowsProcessIdentity(initial, { ...initial }), true);
  for (const changed of [
    null,
    { ...initial, pid: initial.pid + 1 },
    { ...initial, creationToken: '638880000000000001' },
    { ...initial, ownerSid: 'S-1-5-21-2000' },
    { ...initial, commandLine: 'node unrelated.js' },
  ]) assert.equal(isSameWindowsProcessIdentity(initial, changed), false);
});
