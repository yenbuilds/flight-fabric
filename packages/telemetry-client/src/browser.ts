/**
 * browser.ts
 *
 * Browser bundle entry point for script-tag (non-module) usage.
 * Exports everything needed for a standalone browser integration — consumers
 * that use a module bundler should import from the main package entry instead.
 *
 * At runtime this is compiled by tsup into a self-contained IIFE that attaches
 * to window.FlightFabric, making TelemetryClient and the MSG/PHASE/ENVELOPE_STATUS
 * constants available as globals without a bundler.
 */
import { TelemetryClient, type TelemetryClientOptions } from './client';
import type { TelemetryState, TelemetryMessage } from '@flight-fabric/telemetry-types';
import { MSG, PHASE, ENVELOPE_STATUS, createInitialState } from '@flight-fabric/telemetry-types';

export {
  TelemetryClient,
  MSG,
  PHASE,
  ENVELOPE_STATUS,
  createInitialState,
  type TelemetryClientOptions,
  type TelemetryState,
  type TelemetryMessage,
};

// Attach to window for browser usage
if (typeof window !== 'undefined') {
  (window as any).FlightFabric = {
    TelemetryClient,
    MSG,
    PHASE,
    ENVELOPE_STATUS,
    createInitialState,
  };
}
