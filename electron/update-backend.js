'use strict';

const { randomBytes } = require('node:crypto');
const { updateError } = require('./update-manifest');

// Require both the owned backend's clean-core acknowledgement and process exit.
// A forced kill, EOF, log line from another request, or zero exit alone is not enough.
function prepareBackendForUpdate(proc, { signal, timeoutMs = 20000 } = {}) {
  if (!proc?.stdin || proc.stdin.destroyed || proc.stdin.writableEnded) {
    return Promise.reject(updateError('blocked', 'Start FlightFabric’s connection service before requesting an update.'));
  }
  const id = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    let buffer = '';
    let acknowledged = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout.removeListener('data', onData);
      proc.removeListener('close', onClose);
      proc.stdin.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(updateError('cancelled', 'Update preparation cancelled.'));
    const onError = () => finish(updateError('blocked', 'FlightFabric could not request a clean shutdown. The update was not started.'));
    const onClose = (code) => finish(acknowledged && code === 0 ? null : updateError('blocked', 'FlightFabric could not confirm a clean shutdown. The update was not started.'));
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('[FF_UPDATE_SHUTDOWN]')) continue;
        let result;
        try { result = JSON.parse(line.slice('[FF_UPDATE_SHUTDOWN]'.length)); } catch { continue; }
        if (result.id !== id) continue;
        if (result.ok === true) acknowledged = true;
        else finish(updateError('blocked', typeof result.message === 'string' && result.message.length <= 300
          ? result.message : 'FlightFabric could not finish saving and stopping. The update was not started.'));
      }
    };
    const timer = setTimeout(() => finish(updateError('blocked', 'FlightFabric took too long to stop safely. The update was not started.')), timeoutMs);
    proc.stdout.on('data', onData);
    proc.once('close', onClose);
    proc.stdin.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    proc.stdin.write(`${JSON.stringify({ type: 'prepare-update', id })}\n`, (error) => { if (error) onError(); });
  });
}

module.exports = { prepareBackendForUpdate };
