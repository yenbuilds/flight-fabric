/**
 * Client-originated payloads that can be sent to the backend via WebSocket.
 */

export interface BaseCommand {
  type: string;
  [key: string]: unknown;
}

export type TelemetryCommand = BaseCommand;

export interface PushbackCommand extends BaseCommand {
  type: 'pushback';
  operation: 'status' | 'start' | 'stop';
  requestId: string;
  profileKey?: string;
  profileRevision?: number;
  icao?: string;
  runway?: string;
  previewId?: string;
}

export interface TaxiGuidanceCommand extends BaseCommand {
  type: 'requestTaxiGuidance';
  operation: 'status' | 'preview' | 'parkings';
  requestId: string;
  profileKey?: string;
  profileRevision?: number;
  icao?: string;
  runway?: string;
  parking?: string;
  scene?: boolean;
  pushback?: boolean;
}

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
