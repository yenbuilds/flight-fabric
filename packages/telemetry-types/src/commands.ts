/**
 * Client-originated payloads that can be sent to the backend via WebSocket.
 */

export interface BaseCommand {
  type: string;
  [key: string]: unknown;
}

export type TelemetryCommand = BaseCommand;
