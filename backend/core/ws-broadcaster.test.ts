const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const {
  createBroadcast,
  MAX_WS_BUFFERED_BYTES,
} = require('./ws-broadcaster') as typeof import('./ws-broadcaster');

function createHarness(clientOverrides: Record<string, unknown> = {}) {
  const sent: string[] = [];
  let terminated = 0;
  const logs: Array<{ scope: string; message: string; extra?: Record<string, unknown> }> = [];
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const client = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(message: string) {
      sent.push(message);
    },
    terminate() {
      terminated += 1;
    },
    ...clientOverrides,
  };
  const broadcast = createBroadcast({
    wss: { clients: new Set([client]) },
    eventBus: {
      emit(name, payload) {
        events.push({ name, payload });
      },
    },
    Debug: {
      log(scope, message, extra) {
        logs.push({ scope, message, extra });
      },
    },
  });
  return {
    broadcast,
    events,
    getTerminated: () => terminated,
    logs,
    sent,
  };
}

test('slow websocket clients are terminated before their outbound queue can grow unbounded', () => {
  const harness = createHarness({ bufferedAmount: MAX_WS_BUFFERED_BYTES });

  harness.broadcast({ type: 'ias', value: 145 });

  assert.equal(harness.sent.length, 0);
  assert.equal(harness.getTerminated(), 1);
  assert.equal(harness.logs.length, 1);
  assert.match(harness.logs[0].message, /outbound buffer limit/i);
  assert.deepEqual(harness.events.map((entry) => entry.name), ['telemetry:ias']);
});
