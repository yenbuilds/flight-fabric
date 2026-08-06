#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  captureCurrentUserWindowsProcessIdentity,
  forceStopVerifiedWindowsProcessTree,
  hasExactCommandLineArgument,
} = require('./windows-process-cleanup');

const OWNER_SID = 'S-1-5-21-1000';
const INITIAL_IDENTITY = Object.freeze({
  pid: 4242,
  commandLine: 'node core\\simbridge.js --ff-launch-owner=batch --ff-launch-nonce=abc123',
  creationToken: '638900000000000000',
  ownerSid: OWNER_SID,
});

assert.equal(
  hasExactCommandLineArgument(INITIAL_IDENTITY.commandLine, '--ff-launch-owner=batch'),
  true,
);
assert.equal(
  hasExactCommandLineArgument(INITIAL_IDENTITY.commandLine, '--ff-launch-owner=bat'),
  false,
);
assert.equal(
  hasExactCommandLineArgument('node app.js "--ff-lifecycle-smoke=abc123"', '--ff-lifecycle-smoke=abc123'),
  true,
);

assert.equal(
  captureCurrentUserWindowsProcessIdentity(INITIAL_IDENTITY.pid, {
    ownerSid: OWNER_SID,
    readProcessIdentity: () => INITIAL_IDENTITY,
    predicate: (identity) => hasExactCommandLineArgument(
      identity.commandLine,
      '--ff-launch-nonce=abc123',
    ),
  }),
  INITIAL_IDENTITY,
);
assert.equal(
  captureCurrentUserWindowsProcessIdentity(INITIAL_IDENTITY.pid, {
    ownerSid: 'S-1-5-21-2000',
    readProcessIdentity: () => INITIAL_IDENTITY,
  }),
  null,
);
assert.equal(
  captureCurrentUserWindowsProcessIdentity(INITIAL_IDENTITY.pid, {
    ownerSid: OWNER_SID,
    readProcessIdentity: () => INITIAL_IDENTITY,
    predicate: () => false,
  }),
  null,
);

const stoppedPids = [];
assert.equal(
  forceStopVerifiedWindowsProcessTree(INITIAL_IDENTITY, {
    readProcessIdentity: () => ({ ...INITIAL_IDENTITY }),
    stopProcessTree: (pid) => stoppedPids.push(pid),
  }),
  true,
);
assert.deepEqual(stoppedPids, [INITIAL_IDENTITY.pid]);

for (const changedIdentity of [
  { ...INITIAL_IDENTITY, pid: INITIAL_IDENTITY.pid + 1 },
  { ...INITIAL_IDENTITY, creationToken: '638900000000000001' },
  { ...INITIAL_IDENTITY, ownerSid: 'S-1-5-21-2000' },
  { ...INITIAL_IDENTITY, commandLine: 'notepad.exe' },
  null,
]) {
  const calls = [];
  assert.equal(
    forceStopVerifiedWindowsProcessTree(INITIAL_IDENTITY, {
      readProcessIdentity: () => changedIdentity,
      stopProcessTree: (pid) => calls.push(pid),
    }),
    false,
  );
  assert.deepEqual(calls, []);
}

console.log('Windows process cleanup identity tests passed');
