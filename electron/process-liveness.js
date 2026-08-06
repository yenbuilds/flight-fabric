'use strict';

/**
 * Conservatively determine whether a tracked child process may still exist.
 *
 * A successful signal-0 probe proves existence and ESRCH proves absence. Any
 * other probe error is an unknown state, so callers that own process trees must
 * retain ownership and fail closed rather than risk abandoning descendants.
 */
function isManagedProcessAlive(target, probe = process.kill) {
  if (!target || !Number.isFinite(Number(target.pid)) || Number(target.pid) <= 0) return false;
  if (target.exitCode !== null || target.signalCode !== null) return false;

  try {
    probe(Number(target.pid), 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

module.exports = { isManagedProcessAlive };
