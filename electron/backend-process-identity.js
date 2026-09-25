'use strict';

const path = require('node:path');

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

function normalizeAbsoluteWindowsLaunchPath(value) {
  if (typeof value !== 'string' || /["\x00-\x1f]/.test(value)) return '';
  const windowsPath = value.replace(/\//g, '\\');
  // Do not resolve relative paths, device namespaces or parent traversal using
  // this process's working directory. The launchers supply absolute paths.
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(windowsPath)
    || /^\\\\[?.]\\/.test(windowsPath)
    || windowsPath.split('\\').some((part) => part === '.' || part === '..')) return '';
  return path.win32.normalize(windowsPath).toLowerCase();
}

function parseCanonicalWindowsLaunchArguments(commandLine) {
  // Accept the simple quoting emitted for our executable/script paths. Reject
  // embedded/escaped quotes rather than guessing how Windows would parse them.
  // Unsupported manual launches can be stopped manually instead of risking an
  // unrelated process when recovering an occupied port.
  if (/[\x00-\x08\x0a-\x1f]/.test(commandLine)) return null;
  const tokens = [];
  const argument = /(?:"([^"\r\n]*)"|([^"\s]+))(?:[ \t]+|$)/gy;
  while (argument.lastIndex < commandLine.length) {
    const match = argument.exec(commandLine);
    if (!match) return null;
    if (match[1] !== undefined && /\\$/.test(match[1])) return null;
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

function classifyFlightFabricBackendIdentity(value, { backendScript, executablePath } = {}) {
  const identity = normalizeWindowsProcessIdentity(value);
  const expectedScript = normalizeAbsoluteWindowsLaunchPath(backendScript);
  if (!identity || !expectedScript) return 'unverified';
  const args = parseCanonicalWindowsLaunchArguments(identity.commandLine);
  if (!args || args.length < 2
    || normalizeAbsoluteWindowsLaunchPath(args[1]) !== expectedScript) return 'unverified';

  const runtimePath = normalizeAbsoluteWindowsLaunchPath(args[0]);
  const expectedRuntime = normalizeAbsoluteWindowsLaunchPath(executablePath);
  const isNode = /^(?:node|node\.exe)$/i.test(args[0])
    || (runtimePath && path.win32.basename(runtimePath) === 'node.exe');
  if (!isNode && !(runtimePath && expectedRuntime && runtimePath === expectedRuntime)) return 'unverified';

  const ownerArgs = args.slice(2).filter((arg) => arg.toLowerCase().startsWith('--ff-launch-owner'));
  if (ownerArgs.length === 1 && ownerArgs[0] === '--ff-launch-owner=electron') return 'electron';
  if (ownerArgs.length > 0 && !(ownerArgs.length === 1 && ownerArgs[0] === '--ff-launch-owner=batch')) {
    return 'unverified';
  }
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
