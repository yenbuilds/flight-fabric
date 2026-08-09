/**
 * client.ts
 *
 * TelemetryClient — the core WebSocket client for the Flight Fabric backend.
 * Opens a connection, parses incoming messages, applies them to a TelemetryState
 * snapshot, and notifies registered subscribers on every update.
 *
 * Also handles:
 *   - Auto-reconnect with configurable backoff
 *   - Sending client-originated messages back to the backend
 *   - Requesting full state replay on connect (requestState)
 */

import type {
  TelemetryMessage,
  TelemetryState,
  TelemetryCommand,
} from '@flight-fabric/telemetry-types';
import { createInitialState, MSG } from '@flight-fabric/telemetry-types';

export type TelemetryListener = (state: TelemetryState) => void;
export type MessageListener = (message: TelemetryMessage) => void;

export interface TelemetryClientOptions {
  /** WebSocket URL (default: ws://localhost:8099) */
  url?: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 2000) */
  reconnectDelay?: number;
  /** Debug logging (default: false) */
  debug?: boolean;
}

/**
 * WebSocket client for Flight Fabric telemetry.
 * Manages connection, reconnection, state updates, and message dispatch.
 */
export class TelemetryClient {
  private ws: WebSocket | null = null;
  private state: TelemetryState;
  private listeners: Set<TelemetryListener> = new Set();
  private messageListeners: Set<MessageListener> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private options: Required<TelemetryClientOptions>;
  private isDestroyed = false;

  constructor(options: TelemetryClientOptions = {}) {
    this.options = {
      url: options.url ?? 'ws://localhost:8099',
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelay: options.reconnectDelay ?? 2000,
      debug: options.debug ?? false,
    };
    this.state = createInitialState();
  }

  /**
   * Connect to the telemetry WebSocket.
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log('Already connected');
      return;
    }

    this.log(`Connecting to ${this.options.url}`);

    try {
      this.ws = new WebSocket(this.options.url);

      this.ws.onopen = () => {
        this.log('Connected');
        this.updateState({ connected: true });
      };

      this.ws.onclose = () => {
        this.log('Disconnected');
        this.updateState({ connected: false });
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        this.log('WebSocket error', error);
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    } catch (error) {
      this.log('Connection error', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the WebSocket.
   */
  disconnect(): void {
    this.cancelReconnect();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.updateState({ connected: false });
  }

  /**
   * Destroy the client and clean up resources.
   */
  destroy(): void {
    this.isDestroyed = true;
    this.disconnect();
    this.listeners.clear();
    this.messageListeners.clear();
  }

  /**
   * Send a client message to the backend.
   */
  send(message: TelemetryCommand): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.log('Cannot send: not connected');
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Subscribe to state changes.
   */
  subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    // Immediately notify with current state
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to raw messages (for debugging or custom handling).
   */
  subscribeToMessages(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /**
   * Get current state snapshot.
   */
  getState(): TelemetryState {
    return this.state;
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.state.connected;
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as TelemetryMessage;
      this.updateStateFromMessage(message);

      // Notify raw message listeners
      for (const listener of this.messageListeners) {
        try {
          listener(message);
        } catch (e) {
          this.log('Message listener error', e);
        }
      }
    } catch (e) {
      this.log('Failed to parse message', e);
    }
  }

  private updateStateFromMessage(msg: TelemetryMessage): void {
    const updates: Partial<TelemetryState> = {
      lastMessageAt: Date.now(),
    };

    switch (msg.type) {
      case MSG.IAS:
        updates.ias = msg.value;
        break;

      case MSG.VS:
        updates.vs = msg.value;
        break;

      case MSG.ALTITUDE:
        updates.altitude = { msl: msg.msl, ra: msg.ra };
        break;

      case MSG.IAS_TREND:
        updates.iasTrend = msg.value;
        break;

      case MSG.CROSSWIND:
        updates.crosswind = msg.value;
        break;

      case MSG.PHASE:
        updates.phase = msg.value;
        break;

      case MSG.ENVELOPE_STATUS:
        updates.envelopeStatus = msg.value;
        break;

      case MSG.STABILITY_SCORE:
        updates.stabilityScore = msg.score;
        updates.stabilityBreakdown = msg.breakdown;
        break;

      case MSG.ULTIMATE_STABILITY_SCORE:
        updates.ultimateStabilityScore = msg.score;
        updates.ultimateStabilityVerdict = msg.verdict ?? null;
        updates.ultimateStabilityBreakdown = msg.breakdown;
        updates.ultimateStabilitySamples = msg.samples;
        break;

      case MSG.LIGHTS:
        updates.lights = msg.data;
        break;

      case MSG.GEAR:
        updates.gear = msg.data;
        break;

      case MSG.FLAPS:
        updates.flaps = msg.value;
        break;

      case MSG.SPOILERS:
        updates.spoilers = msg.value;
        break;

      case MSG.ENGINES:
        updates.engines = msg.data;
        break;

      case MSG.ATTITUDE:
        updates.attitude = { pitch: msg.pitchDeg, bank: msg.bankDeg };
        break;

      case MSG.SURFACE:
        updates.surface = msg.value;
        break;

      case MSG.POSITION:
        updates.position = {
          ...this.state.position,
          lat: msg.lat,
          lon: msg.lon,
          hdgTrue: msg.hdg,
        };
        break;

      case MSG.HEADING:
        updates.position = {
          ...this.state.position,
          ...updates.position,
          hdgTrue: msg['true'],
          hdgMag: msg.mag,
        };
        break;

      case MSG.RUNWAY_CONTEXT:
        updates.runwayContext = {
          icao: msg.icao,
          runway: msg.runway,
          approachType: msg.approachType,
        };
        break;

      case MSG.SAFETY_DATA:
        updates.safetyData = {
          icao: msg.icao,
          accidents: msg.accidents,
          reports: msg.reports,
          summary: msg.summary,
        };
        break;

      case MSG.FLIGHT_TIME:
        updates.flightTime = {
          startedAt: msg.startedAt,
          elapsedMs: msg.elapsedMs,
          elapsedSec: msg.elapsedSec,
          elapsedHms: msg.elapsedHms,
        };
        break;

      case MSG.AIRCRAFT_PROFILE:
        updates.aircraftProfile = msg.profile;
        break;

      case MSG.LANDING:
        updates.lastLanding = msg;
        break;

      // Ignore messages that don't update state
      case MSG.CALLOUT:
      case MSG.DEBUG:
        // These are events, not state updates
        break;

      default:
        // Unknown message type - ignore
        break;
    }

    this.updateState(updates);
  }

  private updateState(updates: Partial<TelemetryState>): void {
    this.state = { ...this.state, ...updates };
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e) {
        this.log('Listener error', e);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || !this.options.autoReconnect) {
      return;
    }

    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.log('Attempting reconnect...');
      this.connect();
    }, this.options.reconnectDelay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[TelemetryClient]', ...args);
    }
  }
}
