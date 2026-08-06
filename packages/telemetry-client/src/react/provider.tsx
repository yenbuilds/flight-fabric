import { useEffect, useRef, type ReactNode } from 'react';
import { TelemetryClient, type TelemetryClientOptions } from '../client';
import { TelemetryContext } from './context';

export interface TelemetryProviderProps extends TelemetryClientOptions {
  children: ReactNode;
  /** Optional existing client instance (for sharing between components) */
  client?: TelemetryClient;
}

/**
 * Provider component that creates and manages a TelemetryClient.
 * Automatically connects on mount and disconnects on unmount.
 */
export function TelemetryProvider({
  children,
  client: externalClient,
  ...options
}: TelemetryProviderProps) {
  const clientRef = useRef<TelemetryClient | null>(null);

  // Create or use external client — update ref when externalClient changes
  if (!clientRef.current || (externalClient && clientRef.current !== externalClient)) {
    clientRef.current = externalClient ?? new TelemetryClient(options);
  }

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    // Only auto-connect if we created the client
    if (!externalClient) {
      client.connect();
    }

    return () => {
      // Only destroy if we created the client
      if (!externalClient) {
        client.destroy();
        clientRef.current = null;
      }
    };
  }, [externalClient]);

  return (
    <TelemetryContext.Provider value={clientRef.current}>
      {children}
    </TelemetryContext.Provider>
  );
}
