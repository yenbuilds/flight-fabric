/**
 * context.ts
 *
 * React context that holds a single TelemetryClient instance for the component
 * tree. Wrap your app (or the subtree that needs telemetry) with TelemetryProvider
 * from react/index.ts; then any component can call useTelemetryClient() to
 * retrieve the client without prop-drilling.
 */

import { createContext, useContext } from 'react';
import type { TelemetryClient } from '../client';

export const TelemetryContext = createContext<TelemetryClient | null>(null);

export function useTelemetryClient(): TelemetryClient {
  const client = useContext(TelemetryContext);
  if (!client) {
    throw new Error(
      'useTelemetryClient must be used within a TelemetryProvider'
    );
  }
  return client;
}
