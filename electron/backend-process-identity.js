'use strict';

function normalizeWindowsSid(value) {
  if (typeof value !== 'string') return '';
  const sid = value.trim().toUpperCase();
  return /^S-\d+(?:-\d+)+$/.test(sid) ? sid : '';
}

function normalizeWindowsProcessIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const pid = Math.trunc(Number(value.pid));
  const commandLine = typeof value.commandLine === 'string' ? value.commandLine.trim() : '';
  const creationToken = typeof value.creationToken === 'string' ? value.creationToken.trim() : '';
  const ownerSid = normalizeWindowsSid(value.ownerSid);
  if (!Number.isFinite(pid) || pid <= 0 || !commandLine || !/^\d+$/.test(creationToken) || !ownerSid) return null;
  return Object.freeze({ pid, commandLine, creationToken, ownerSid });
}

function classifyFlightFabricBackendIdentity(value) {
  const identity = normalizeWindowsProcessIdentity(value);
  if (!identity) return 'unverified';
  const commandLine = identity.commandLine.toLowerCase();
  if (!commandLine.includes('core\\simbridge.js') && !commandLine.includes('core/simbridge.js')) {
    return 'unverified';
  }
  if (commandLine.includes('--ff-launch-owner=electron')) return 'electron';
  return 'stoppable';
}

function hasSameWindowsOwner(value, ownerSid) {
  const identity = normalizeWindowsProcessIdentity(value);
  const normalizedOwnerSid = normalizeWindowsSid(ownerSid);
  return Boolean(identity && normalizedOwnerSid && identity.ownerSid === normalizedOwnerSid);
}

function isSameWindowsProcessIdentity(initialValue, currentValue) {
  const initial = normalizeWindowsProcessIdentity(initialValue);
  const current = normalizeWindowsProcessIdentity(currentValue);
  return Boolean(
    initial
      && current
      && initial.pid === current.pid
      && initial.creationToken === current.creationToken
      && initial.ownerSid === current.ownerSid
      && initial.commandLine === current.commandLine,
  );
}

module.exports = {
  classifyFlightFabricBackendIdentity,
  hasSameWindowsOwner,
  isSameWindowsProcessIdentity,
  normalizeWindowsProcessIdentity,
  normalizeWindowsSid,
};
