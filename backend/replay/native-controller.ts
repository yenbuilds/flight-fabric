// Shared bounded native replay protocol for the app and development driver.
// Stop supersedes an outstanding command. Old acknowledgements must not clear
// Stop's timeout, and a failed/closed pipe must never accept another write.
function createReplayController({ input, session, notice = console.error, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  let requestId = 0;
  let closed = false;
  const close = reason => {
    if (closed) return;
    closed = true;
    if (pending) clearTimer(pending.timer);
    pending = null;
    if (reason) notice(reason);
    if (!input.destroyed && !input.writableEnded) input.end();
  };
  input.on('error', () => close('Replay controller pipe failed. Reload recovery remains required.'));
  return {
    close,
    isPending: () => pending !== null,
    acknowledge(message) {
      if (!pending || !message || message.session !== session || message.requestId !== pending.id || typeof message.ok !== 'boolean') return false;
      clearTimer(pending.timer);
      pending = null;
      return true;
    },
    send(command) {
      if (closed) { notice('Replay controller is closed; no command was sent.'); return false; }
      if (pending) {
        if (command.type !== 'stop') { notice('Wait for the previous command acknowledgement.'); return false; }
        if (pending.type === 'stop') return true;
        clearTimer(pending.timer);
      }
      const id = ++requestId;
      pending = { id, type: command.type, timer: setTimer(() => {
        close('Replay command timed out. Reload the matching parked flight; recovery remains required.');
      }, 5000) };
      try {
        input.write(`${JSON.stringify({ ...command, session, requestId: id })}\n`, error => {
          if (error) close('Replay controller pipe failed. Reload recovery remains required.');
        });
      } catch { close('Replay controller pipe failed. Reload recovery remains required.'); return false; }
      return !closed;
    },
  };
}

function createReplayOutputReader(onMessage, onError) {
  let remainder = '';
  let failed = false;
  return chunk => {
    if (failed) return;
    const lines = (remainder + chunk).split('\n');
    remainder = lines.pop();
    for (const line of lines) {
      try {
        if (line.length > 16384) throw new Error('Native output line exceeds its bound');
        onMessage(JSON.parse(line));
      } catch {
        failed = true; onError('Invalid native output; entering recovery.'); return;
      }
    }
    if (remainder.length > 16384) { failed = true; onError('Invalid native output; entering recovery.'); }
  };
}


module.exports = { createReplayController, createReplayOutputReader };
export {};
