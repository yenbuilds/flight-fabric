/**
 * Client-originated payloads that can be sent to the backend via WebSocket.
 */

export interface BaseCommand {
  type: string;
  [key: string]: unknown;
}

export type TelemetryCommand = BaseCommand;

export interface AutotaxiCommand extends BaseCommand {
  type: 'autotaxi';
  operation: 'start' | 'preview' | 'status' | 'stop' | 'release';
  requestId?: string;
  /** Required for start; a currently loaded bundled PMDG 737 profile. */
  profileKey?: string;
  profileRevision?: number;
  icao?: string;
  runway?: string;
}
