# @flight-fabric/telemetry-client

WebSocket client and React hooks for Flight Fabric telemetry.

## Installation

```bash
npm install @flight-fabric/telemetry-client
```

## Basic usage with JavaScript

```typescript
import { TelemetryClient } from '@flight-fabric/telemetry-client';

const client = new TelemetryClient({
  url: 'ws://192.168.1.100:8099',
  debug: true,
});

// Listen for state updates
client.subscribe((state) => {
  console.log('IAS:', state.ias, 'knots');
  console.log('Phase:', state.phase);
});

// Connect
client.connect();

// Request the latest state
client.send({ type: 'requestState' });

// Clean up
client.destroy();
```

## React usage

```tsx
import { TelemetryProvider, useTelemetry, usePhase } from '@flight-fabric/telemetry-client/react';

function App() {
  return (
    <TelemetryProvider url="ws://192.168.1.100:8099">
      <FlightDisplay />
    </TelemetryProvider>
  );
}

function FlightDisplay() {
  const { ias, vs, altitude } = useTelemetry();
  const phase = usePhase();

  return (
    <div>
      <p>IAS: {ias ?? '--'} kt</p>
      <p>V/S: {vs ?? '--'} fpm</p>
      <p>ALT: {altitude.msl ?? '--'} ft</p>
      <p>Phase: {phase ?? 'UNKNOWN'}</p>
    </div>
  );
}
```

## Available hooks

### Core hooks

- `useTelemetry()`: complete telemetry state
- `useTelemetrySelector(selector)`: a selected part of the state
- `usePhase()`: current flight phase
- `useIsPhase(...phases)`: whether the flight is in one of the given phases

### Domain hooks

- `useApproach()`: approach altitude, IAS, and stability
- `useAircraftSystems()`: lights, gear, flaps, spoilers, and engines
- `usePositionAttitude()`: position, heading, pitch, and bank
- `useLastLanding()`: most recent landing event
- `useFlightTime()`: flight duration
- `useConnectionStatus()`: WebSocket connection state

### Event hooks

- `useMessageSubscription(type, handler)`: listen for a message type

## API reference

### TelemetryClient

```typescript
class TelemetryClient {
  constructor(options?: TelemetryClientOptions);
  connect(): void;
  disconnect(): void;
  destroy(): void;
  send(message: TelemetryCommand): void;
  subscribe(listener: (state: TelemetryState) => void): () => void;
  subscribeToMessages(listener: (msg: TelemetryMessage) => void): () => void;
  getState(): TelemetryState;
  isConnected(): boolean;
}
```

### TelemetryClientOptions

```typescript
interface TelemetryClientOptions {
  url?: string;           // Default: 'ws://localhost:8099'
  autoReconnect?: boolean; // Default: true
  reconnectDelay?: number; // Default: 2000ms
  debug?: boolean;         // Default: false
}
```

## Related Packages

- `@flight-fabric/telemetry-types`: TypeScript definitions
