// ws-broadcaster.ts
// Minimal broadcast fan-out for connected WebSocket clients.
//
// Link to broadcast pipeline:
// - backend/events/broadcasters shapes domain payloads and calls broadcast(...).
// - This module handles transport fan-out to connected WS clients.
// - For typed messages, it also mirrors payloads to event-bus as telemetry:{type}
//   so non-WS consumers can subscribe via event-bus.

const WebSocket = require('ws');

type BroadcastPayload = Record<string, unknown> & {
  type?: string | null;
};

type WsClientLike = {
  bufferedAmount?: number;
  readyState: number;
  send: (message: string) => void;
  terminate: () => void;
};

type WsServerLike = {
  clients: Iterable<WsClientLike>;
};

type EventBusLike = {
  emit: (eventName: string, payload: BroadcastPayload) => void;
};

type DebugLike = {
  log: (scope: string, message: string, extra?: Record<string, unknown>) => void;
};

// A paused or hung browser must not be allowed to turn the backend into an
// unbounded outbound queue. One MiB is ample for the live telemetry stream and
// keeps a stalled client from exhausting Flight Fabric's memory.
export const MAX_WS_BUFFERED_BYTES = 1024 * 1024;

export function createBroadcast({
  wss,
  eventBus,
  Debug,
}: {
  wss: WsServerLike;
  eventBus: EventBusLike;
  Debug: DebugLike;
}): (obj: BroadcastPayload) => void {
  return function broadcast(obj: BroadcastPayload): void {
    let msg: string;
    try {
      msg = JSON.stringify(obj);
    } catch (error) {
      const err = error as { message?: string };
      // Non-serializable payload (circular reference, BigInt, throwing toJSON, etc.).
      // Log and bail so callers' silent try/catch doesn't silently discard without a trace.
      try {
        Debug.log('ws', 'broadcast serialization failed - message dropped', {
          type: obj && obj.type,
          error: err?.message || String(err),
        });
      } catch {}
      return;
    }

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const bufferedAmount = Number(client.bufferedAmount || 0);
      const nextBufferedAmount = bufferedAmount + Buffer.byteLength(msg, 'utf8');
      if (Number.isFinite(bufferedAmount) && nextBufferedAmount > MAX_WS_BUFFERED_BYTES) {
        try {
          Debug.log('ws', 'Slow websocket client exceeded outbound buffer limit - terminating', {
            bufferedBytes: bufferedAmount,
            limitBytes: MAX_WS_BUFFERED_BYTES,
            type: obj?.type || null,
          });
        } catch {}
        try {
          client.terminate();
        } catch {}
        continue;
      }
      try {
        client.send(msg);
      } catch (error) {
        const err = error as { message?: string };
        // Per-client send can throw even when readyState is OPEN (socket edge cases).
        // Isolate individual client failures from the backend process.
        try {
          Debug.log('ws', 'Client send failed', { error: err?.message || String(err) });
        } catch {}
        try {
          client.terminate();
        } catch {}
      }
    }

    // Also emit to event bus for decoupled consumers (logging, analytics, etc.)
    // Event name format: 'telemetry:{type}' for telemetry messages
    if (obj && obj.type) {
      eventBus.emit(`telemetry:${obj.type}`, obj);
    }
  };
}
